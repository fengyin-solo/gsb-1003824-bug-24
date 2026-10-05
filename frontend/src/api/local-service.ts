import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  dbVersion,
  listPlacements,
  listRows,
  resetRows,
  transact,
} from '@/data/local-store'
import { VersionConflictError } from '@/data/types'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  ShelfOccupancy,
  StoragePlacement,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const SHELF_CODE = '架位编号'
const CAPACITY_FIELD = '容纳件数'
const CURRENT_FIELD = '当前件数'
const ARTIFACT_CODE = '器物编号'
const SHELF_FIELD = '入库架位'
const STORED_STATUS = '已入库'

// 架位满了以后自动翻成「已满」；这两个状态之外的架位不参与自动分配。
const SHELF_OPEN_STATUSES = ['正常使用', '待整理']

function parseCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed)
    }
  }
  return 0
}

function fail(error: unknown): ActionResult {
  if (error instanceof VersionConflictError) {
    return { ok: false, message: error.message }
  }
  return {
    ok: false,
    message: error instanceof Error ? error.message : '操作失败，数据已整体退回',
  }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow | null {
  return listRows(key).find((row) => Number(row.id) === Number(id)) ?? null
}

/** 库房占用的唯一口径：列表页、详情页、入库校验都从这里读，避免各页面各留一份旧计数。 */
export function shelfOccupancy(): ShelfOccupancy[] {
  return listRows('storage').map((row) => {
    const capacity = parseCount(row[CAPACITY_FIELD])
    const current = parseCount(row[CURRENT_FIELD])
    const status = String(row.status)
    return {
      id: Number(row.id),
      code: String(row[SHELF_CODE] ?? ''),
      capacity,
      current,
      status,
      full: current >= capacity,
      sealed: status === '临时封存',
    }
  })
}

export function placementOfArtifact(artifactId: number): StoragePlacement | null {
  return listPlacements().find((row) => Number(row.artifactId) === Number(artifactId)) ?? null
}

export function dataVersion(): number {
  return dbVersion()
}

type ChosenShelf = {
  shelf: EntryRow
  index: number
  code: string
  capacity: number
  current: number
}

function chooseShelf(shelves: EntryRow[], shelfId?: number): ChosenShelf {
  if (shelfId !== undefined && shelfId !== null && !Number.isNaN(Number(shelfId))) {
    const index = shelves.findIndex((row) => Number(row.id) === Number(shelfId))
    if (index < 0) {
      throw new Error('所选架位不存在或已被调整，请刷新后重试，入库已退回')
    }
    const shelf = shelves[index]
    const code = String(shelf[SHELF_CODE] ?? shelf.id)
    if (String(shelf.status) === '临时封存') {
      throw new Error(`架位 ${code} 已临时封存，不能办理入库，请改选其他架位`)
    }
    const capacity = parseCount(shelf[CAPACITY_FIELD])
    const current = parseCount(shelf[CURRENT_FIELD])
    if (current >= capacity) {
      throw new Error(`架位 ${code} 已被占满（${current}/${capacity} 件），请改选其他架位，入库已退回`)
    }
    return { shelf, index, code, capacity, current }
  }

  const candidates = shelves
    .map((shelf, index) => ({
      shelf,
      index,
      code: String(shelf[SHELF_CODE] ?? shelf.id),
      capacity: parseCount(shelf[CAPACITY_FIELD]),
      current: parseCount(shelf[CURRENT_FIELD]),
    }))
    .filter(
      (item) =>
        SHELF_OPEN_STATUSES.includes(String(item.shelf.status)) && item.current < item.capacity,
    )
    .sort((a, b) => a.index - b.index)
  const chosen = candidates[0]
  if (!chosen) {
    throw new Error('库房架位均已占满或被封存，没有可用库位，入库已退回')
  }
  return chosen
}

/**
 * 办理入库：出土遗物状态与库房架位占用在同一事务里改。
 * - 重复点击：已在流水里的器物直接幂等返回，只扣一次库位；
 * - 已归档历史入库件：没有流水，不借新计数规则改写；
 * - 同一架位并发写入：乐观锁拦住后到请求，遗物状态和架位计数一起退回。
 */
export function storeArtifact(
  artifactId: number,
  shelfId?: number,
  expectedVersion?: number,
): ActionResult {
  const artifact = getEntry('artifact', artifactId)
  if (!artifact) {
    return { ok: false, message: `没有找到编号为 ${artifactId} 的出土遗物` }
  }
  const code = String(artifact[ARTIFACT_CODE] ?? artifactId)

  const existing = placementOfArtifact(artifactId)
  if (existing) {
    return {
      ok: true,
      message: `出土遗物 ${code} 已入库在架位 ${existing.shelfCode}，无需重复办理，库位不重复扣减`,
    }
  }
  if (String(artifact.status) === STORED_STATUS) {
    return {
      ok: false,
      message: `出土遗物 ${code} 是已归档的历史入库记录，不参与新入库计数，不能重复办理`,
    }
  }

  try {
    const info = transact((draft) => {
      const artifacts = draft.entries['artifact']
      const artifactIndex = artifacts.findIndex((row) => Number(row.id) === Number(artifactId))
      if (artifactIndex < 0) {
        throw new Error(`没有找到编号为 ${artifactId} 的出土遗物`)
      }
      const targetArtifact = artifacts[artifactIndex]
      if (draft.placements.some((row) => Number(row.artifactId) === Number(artifactId))) {
        throw new Error(`出土遗物 ${code} 已办理入库，请勿重复操作`)
      }

      const chosen = chooseShelf(draft.entries['storage'], shelfId)
      const nextCurrent = chosen.current + 1
      chosen.shelf[CURRENT_FIELD] = nextCurrent
      if (nextCurrent >= chosen.capacity && String(chosen.shelf.status) === '正常使用') {
        chosen.shelf.status = '已满'
      }

      artifacts[artifactIndex] = {
        ...targetArtifact,
        status: STORED_STATUS,
        pending: false,
        abnormal: false,
        [SHELF_FIELD]: chosen.code,
      }
      draft.placements.push({
        artifactId: Number(artifactId),
        artifactCode: code,
        shelfId: Number(chosen.shelf.id),
        shelfCode: chosen.code,
        storedAt: new Date().toISOString(),
      })

      return {
        code,
        shelfCode: chosen.code,
        current: nextCurrent,
        capacity: chosen.capacity,
      }
    }, expectedVersion)

    return {
      ok: true,
      message: `出土遗物 ${info.code} 已办理入库，架位 ${info.shelfCode} 当前 ${info.current}/${info.capacity} 件`,
    }
  } catch (error) {
    return fail(error)
  }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  expectedVersion?: number,
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  // 办理入库跨出土遗物与库房两个模块，走专用事务。
  if (key === 'artifact' && action === '办理入库') {
    return storeArtifact(id, undefined, expectedVersion)
  }

  // 库房侧「存放器物」只允许在未封存、未占满的架位上把状态切回正常使用，
  // 件数唯一入口是出土遗物办理入库，这里绝不手改当前件数，避免两边对不上。
  if (key === 'storage' && action === '存放器物') {
    const shelf = getEntry('storage', id)
    if (!shelf) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const code = String(shelf[SHELF_CODE] ?? id)
    const capacity = parseCount(shelf[CAPACITY_FIELD])
    const current = parseCount(shelf[CURRENT_FIELD])
    if (String(shelf.status) === '临时封存') {
      return { ok: false, message: `架位 ${code} 已临时封存，请先解除封存` }
    }
    if (current >= capacity) {
      return { ok: false, message: `架位 ${code} 已占满（${current}/${capacity} 件），不能继续存放` }
    }
    if (String(shelf.status) === '正常使用') {
      return { ok: false, message: `架位 ${code} 已是「正常使用」，不用重复操作` }
    }
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (String(rows[index].status) === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  try {
    transact((draft) => {
      const nextRows = draft.entries[key]
      const nextIndex = nextRows.findIndex((row) => Number(row.id) === id)
      if (nextIndex < 0 || String(nextRows[nextIndex].status) === target) {
        throw new Error(`${meta.entity}状态已变更，请刷新后重试`)
      }
      nextRows[nextIndex] = {
        ...nextRows[nextIndex],
        status: target,
        pending: target !== lastStatus,
        abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
      }
    })
  } catch (error) {
    return fail(error)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
