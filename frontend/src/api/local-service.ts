import {
  ARTIFACT_MODULE,
  SHELF_CAPACITY_FIELD,
  SHELF_CODE_FIELD,
  SHELF_COUNT_FIELD,
  SHELF_LINK_FIELD,
  SHELF_LINKED_AT_FIELD,
  STORAGE_MODULE,
  TransactionRollback,
  currentShelfVersion,
  listRows,
  resetRows,
  runTransaction,
  saveRows,
} from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  ShelfView,
  StockInInput,
  StockInResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 出土遗物走到入库及之后即视为历史归档记录：任何迁移、计数规则、回退动作都不得改写。
const ARTIFACT_TERMINAL_STATUSES = ['已入库', '借出展示']

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

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.trim()))) {
    return Number(value.trim())
  }
  return Number.NaN
}

// 架位占用唯一事实来源：器物行上的「入库架位」关联，而不是库房页手填的当前件数。
// 借出展示的器物仍占用原架位；已入库但没有关联架位的，是迁移前的历史归档记录：
// 只认状态、不改记录、不往架位上摊。
function shelfOccupancy(artifactRows: EntryRow[], shelfId: number): number {
  return artifactRows.filter((row) => {
    if (!ARTIFACT_TERMINAL_STATUSES.includes(String(row.status))) {
      return false
    }
    const linked = row[SHELF_LINK_FIELD]
    return linked !== undefined && linked !== '' && Number(linked) === shelfId
  }).length
}

export function listShelfViews(): ShelfView[] {
  const artifacts = listRows(ARTIFACT_MODULE)
  return listRows(STORAGE_MODULE).map((row) => {
    const id = Number(row.id)
    const capacity = Number.isNaN(asNumber(row[SHELF_CAPACITY_FIELD]))
      ? 0
      : asNumber(row[SHELF_CAPACITY_FIELD])
    const occupied = shelfOccupancy(artifacts, id)
    const rawStatus = String(row.status)
    // 人工状态（待整理/临时封存）保持不动；正常使用/已满按实际占用自动归位，清掉旧残留。
    const status =
      rawStatus === '正常使用' || rawStatus === '已满'
        ? occupied >= capacity && capacity > 0
          ? '已满'
          : '正常使用'
        : rawStatus
    return {
      id,
      code: String(row[SHELF_CODE_FIELD] ?? id),
      capacity,
      occupied,
      remaining: Math.max(0, capacity - occupied),
      status,
      version: currentShelfVersion(id),
    }
  })
}

// 库房列表读投影：当前件数与满/闲状态都由入库关系实时算出，刷新、重进、跨模块都一致。
function projectedStorageRows(): EntryRow[] {
  const views = new Map(listShelfViews().map((view) => [view.id, view]))
  return listRows(STORAGE_MODULE).map((row) => {
    const view = views.get(Number(row.id))
    if (!view) {
      return row
    }
    return {
      ...row,
      [SHELF_CAPACITY_FIELD]: view.capacity,
      [SHELF_COUNT_FIELD]: view.occupied,
      status: view.status,
    }
  })
}

function rowsOf(key: string): EntryRow[] {
  return key === STORAGE_MODULE ? projectedStorageRows() : listRows(key)
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(rowsOf(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow | undefined {
  return rowsOf(key).find((row) => Number(row.id) === id)
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 入库必须走带架位、带事务的专用通道，普通状态机入口不能只改器物状态。
  if (key === ARTIFACT_MODULE && action === '办理入库') {
    return { ok: false, message: '请选择库房架位后再办理入库' }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 已归档的历史出土遗物不允许被新的流转规则回退或改写。
  if (key === ARTIFACT_MODULE && ARTIFACT_TERMINAL_STATUSES.includes(current)) {
    return {
      ok: false,
      message: `器物 ${row['器物编号']} 已入库归档，历史记录不能回退或改写`,
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function reject(message: string): never {
  throw new TransactionRollback({ ok: false, message })
}

// 办理入库：器物状态与架位占用在同一个事务里提交，成功一起落库，失败一起退回。
export function stockInArtifact(input: StockInInput): Promise<StockInResult> {
  const { artifactId, shelfId, expectedVersion } = input
  return runTransaction<StockInResult>((draft) => {
    const artifacts = draft.rows[ARTIFACT_MODULE] ?? []
    const shelves = draft.rows[STORAGE_MODULE] ?? []

    const artifactIndex = artifacts.findIndex((row) => Number(row.id) === artifactId)
    if (artifactIndex < 0) {
      reject(`没有找到编号为 ${artifactId} 的出土遗物`)
    }
    const artifact = artifacts[artifactIndex]
    const artifactCode = String(artifact['器物编号'] ?? artifactId)
    const artifactStatus = String(artifact.status)

    // 幂等：已入库/已归档的器物直接挡回，不产生任何写入，连点多次也只占一个库位。
    if (ARTIFACT_TERMINAL_STATUSES.includes(artifactStatus)) {
      reject(`器物 ${artifactCode} 已办理入库，请勿重复操作，库位不会重复扣减`)
    }
    if (artifactStatus !== '已编号') {
      reject(`器物 ${artifactCode} 当前状态为「${artifactStatus}」，需先完成清洗和编号`)
    }

    const shelfIndex = shelves.findIndex((row) => Number(row.id) === shelfId)
    if (shelfIndex < 0) {
      reject('选定的库房架位不存在，请刷新架位列表后重选')
    }
    const shelf = shelves[shelfIndex]
    const shelfCode = String(shelf[SHELF_CODE_FIELD] ?? shelfId)
    const shelfStatus = String(shelf.status)
    if (shelfStatus === '临时封存' || shelfStatus === '待整理') {
      reject(`架位 ${shelfCode} 当前为「${shelfStatus}」，暂不能接收器物，请另选架位`)
    }

    // 乐观并发控制：提交时架位版本与打开选择时不一致，说明刚被别的入库请求占用。
    const version = draft.shelfVersion[String(shelfId)] ?? 0
    if (version !== expectedVersion) {
      reject(`架位 ${shelfCode} 正被其他入库请求占用，请刷新架位占用后重试`)
    }

    const capacity = asNumber(shelf[SHELF_CAPACITY_FIELD])
    const safeCapacity = Number.isNaN(capacity) ? 0 : capacity
    const occupied = shelfOccupancy(artifacts, shelfId)
    if (safeCapacity <= 0) {
      reject(`架位 ${shelfCode} 容量数据异常，无法办理入库，请联系库房管理员`)
    }
    if (occupied >= safeCapacity) {
      reject(`架位 ${shelfCode} 已无空位（${occupied}/${safeCapacity}），请另选架位`)
    }

    const today = new Date().toISOString().slice(0, 10)
    const nextOccupied = occupied + 1

    // 同一事务内同时改器物与架位，最后由 runTransaction 一次性整体落库。
    draft.rows[ARTIFACT_MODULE] = artifacts.map((row, index) =>
      index === artifactIndex
        ? {
            ...row,
            status: '已入库',
            pending: false,
            [SHELF_LINK_FIELD]: shelfId,
            [SHELF_LINKED_AT_FIELD]: today,
          }
        : row,
    )
    draft.rows[STORAGE_MODULE] = shelves.map((row, index) =>
      index === shelfIndex
        ? {
            ...row,
            [SHELF_COUNT_FIELD]: nextOccupied,
            status: nextOccupied >= safeCapacity ? '已满' : '正常使用',
          }
        : row,
    )
    draft.shelfVersion[String(shelfId)] = version + 1

    return {
      ok: true,
      message: `器物 ${artifactCode} 已入库至架位 ${shelfCode}（${nextOccupied}/${safeCapacity}）`,
      artifactId,
      shelfId,
    }
  }).catch((error: unknown) => {
    if (error instanceof TransactionRollback) {
      return error.result
    }
    return {
      ok: false,
      message: error instanceof Error ? `入库事务已回滚：${error.message}` : '入库失败，数据已退回',
    }
  })
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of rowsOf(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rowsOf(meta.key)
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
