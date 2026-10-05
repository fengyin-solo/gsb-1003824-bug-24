import { SEED_ROWS } from './seed'
import type { EntryRow, LocalDatabase, StoragePlacement } from './types'
import { VersionConflictError } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'

// 老版本示例数据里容量/件数是占位文本，迁移时给一个兜底容量，保证新的计数规则能跑。
const FALLBACK_CAPACITY = 20

const SHELF_CODE = '架位编号'
const CAPACITY_FIELD = '容纳件数'
const CURRENT_FIELD = '当前件数'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function toCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed)
    }
  }
  return null
}

/** 按 id 去重，保留最早出现的一条：清掉历史 bug 可能留下的重复出土遗物残留。 */
function dedupeRows(rows: EntryRow[]): EntryRow[] {
  const seen = new Set<number>()
  const result: EntryRow[] = []
  for (const row of rows) {
    const id = Number(row.id)
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    result.push(row)
  }
  return result
}

/** 入库流水按器物 id 去重：一件遗物至多占一个库位。 */
function dedupePlacements(placements: StoragePlacement[]): StoragePlacement[] {
  const seen = new Set<number>()
  const result: StoragePlacement[] = []
  for (const placement of placements) {
    if (seen.has(placement.artifactId)) {
      continue
    }
    seen.add(placement.artifactId)
    result.push(placement)
  }
  return result
}

/**
 * 迁移与对账：老数据（纯清单结构）和新数据（清单 + 入库流水）都从这里过一遍。
 * 已归档的历史入库遗物没有流水，按历史数据原样保留，绝不借新规则补写计数。
 */
function normalize(raw: unknown, storedVersion: number): LocalDatabase {
  const isDatabase =
    typeof raw === 'object' && raw !== null && Object.prototype.hasOwnProperty.call(raw, 'entries')

  const source = (isDatabase ? (raw as LocalDatabase).entries : (raw ?? {})) as Record<
    string,
    EntryRow[]
  >
  const entries: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(SEED_ROWS)) {
    // 只补持久化里缺失的模块；老版本数据里已有的清单原样迁移，不能把新种子行混进老数据。
    entries[key] = dedupeRows(
      Array.isArray(source[key]) ? clone(source[key]) : clone(SEED_ROWS[key] ?? []),
    )
  }
  // 兼容持久化里出现过、但当前种子没有登记的模块。
  for (const key of Object.keys(source)) {
    if (!(key in entries)) {
      entries[key] = dedupeRows(clone(source[key]))
    }
  }

  let placements: StoragePlacement[] = []
  let reconciled = false
  if (isDatabase) {
    const db = raw as LocalDatabase
    placements = dedupePlacements(Array.isArray(db.placements) ? clone(db.placements) : [])
    reconciled = db.reconciled === true
  }

  if (!reconciled) {
    placements = reconcile(entries, placements)
    reconciled = true
  }

  return { entries, placements, version: storedVersion, reconciled }
}

/**
 * 对账一次：
 * - 架位的容纳件数/当前件数修成数字，非法占位值用流水补算；
 * - 流水里的器物把「入库架位」与「已入库」状态回填到对应遗物（这是我们自己写过的事实，不是历史归档件）；
 * - 流水与计数对完账后才落库，刷新、重新进入都以这份结果为准。
 */
function reconcile(entries: Record<string, EntryRow[]>, placements: StoragePlacement[]): StoragePlacement[] {
  const shelves = entries['storage'] ?? []
  const validPlacements = placements.filter(
    (placement) => shelves.some((shelf) => Number(shelf.id) === Number(placement.shelfId)),
  )

  for (const shelf of shelves) {
    const capacity = toCount(shelf[CAPACITY_FIELD]) ?? FALLBACK_CAPACITY
    const stored = toCount(shelf[CURRENT_FIELD])
    const ledgerCount = validPlacements.filter(
      (placement) => Number(placement.shelfId) === Number(shelf.id),
    ).length
    // 存量计数是合法数字就以它为准（含已归档历史件），只有占位文本等脏数据才用流水补，避免给历史件重复加件。
    const current = stored ?? ledgerCount
    shelf[CAPACITY_FIELD] = capacity
    shelf[CURRENT_FIELD] = current
    if (String(shelf.status) === '正常使用' || String(shelf.status) === '已满') {
      shelf.status = current >= capacity ? '已满' : '正常使用'
    }
  }

  const artifacts = entries['artifact'] ?? []
  // 种子数据里初始就是「已入库」的器物才算已归档历史件；
  // 被旧版 bug 翻成「已入库」却没有流水的，是没办成的断链事务，退回「已编号」让人重新办理。
  const archivedIds = new Set(
    (SEED_ROWS['artifact'] ?? [])
      .filter((row) => String(row.status) === '已入库')
      .map((row) => Number(row.id)),
  )
  for (const artifact of artifacts) {
    if (String(artifact.status) !== '已入库') {
      continue
    }
    const hasPlacement = validPlacements.some(
      (placement) => Number(placement.artifactId) === Number(artifact.id),
    )
    if (!hasPlacement && !archivedIds.has(Number(artifact.id))) {
      artifact.status = '已编号'
      artifact.pending = true
      artifact.abnormal = false
      artifact['入库架位'] = ''
    }
  }

  for (const placement of validPlacements) {
    const artifact = artifacts.find((row) => Number(row.id) === Number(placement.artifactId))
    if (artifact) {
      artifact['入库架位'] = placement.shelfCode
      artifact.status = '已入库'
      artifact.pending = false
    }
  }

  return validPlacements
}

function seedDatabase(): LocalDatabase {
  return normalize({ entries: clone(SEED_ROWS), placements: [], version: 0, reconciled: false }, 0)
}

function readStorage(): LocalDatabase {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedDatabase()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedDatabase()
    writeStorage(seeded)
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> & {
      version?: number
      reconciled?: boolean
    }
    const version = typeof parsed.version === 'number' ? parsed.version : 0
    const normalized = normalize(parsed, version)
    // 老结构（纯清单）或没对过账的数据，在内存修完后立刻整体回写，
    // 避免关掉重开还读到旧的断链/占位文本。
    const isDatabase =
      typeof parsed === 'object' && parsed !== null && Object.prototype.hasOwnProperty.call(parsed, 'entries')
    if (!isDatabase || parsed.reconciled !== true) {
      writeStorage(normalized)
    }
    return normalized
  } catch {
    const seeded = seedDatabase()
    writeStorage(seeded)
    return seeded
  }
}

function writeStorage(db: LocalDatabase): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  }
}

let cache: LocalDatabase | null = null

export function allRows(): Record<string, EntryRow[]> {
  return db().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function listPlacements(): StoragePlacement[] {
  return db().placements
}

export function db(): LocalDatabase {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function dbVersion(): number {
  return db().version
}

/**
 * 统一事务入口：mutator 在克隆数据上改动；任一步抛错都整体退回，缓存和 localStorage 保持原状。
 * 提交时带乐观锁：若本地版本已被别的请求推进（同一架位并发写入），后到请求失败并提示占用。
 */
export function transact<T>(
  mutator: (draft: LocalDatabase) => T,
  expectedVersion?: number,
): T {
  const current = db()
  const draft: LocalDatabase = clone(current)
  draft.reconciled = true
  const result = mutator(draft)

  if (typeof window !== 'undefined' && window.localStorage) {
    let storedVersion = 0
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { version?: number }
        storedVersion = typeof parsed.version === 'number' ? parsed.version : 0
      } catch {
        storedVersion = current.version
      }
    }
    if (typeof expectedVersion === 'number' && expectedVersion !== storedVersion) {
      throw new VersionConflictError('架位刚被其他入库请求占用，请刷新后重试')
    }
    if (storedVersion !== current.version) {
      throw new VersionConflictError('架位刚被其他入库请求占用，请刷新后重试')
    }
  }

  draft.version = current.version + 1
  writeStorage(draft)
  cache = draft
  return result
}

/** 通用清单写入：仍然走同一事务，老调用方不用改。 */
export function saveRows(key: string, rows: EntryRow[]): void {
  transact((draft) => {
    draft.entries[key] = rows
  })
}

/** 重置模块：库房/遗物重置时把它们之间的入库流水一并清掉，避免旧计数残留。 */
export function resetRows(key: string): EntryRow[] {
  return transact((draft) => {
    const rows = clone(SEED_ROWS[key] ?? [])
    draft.entries[key] = rows
    if (key === 'artifact') {
      draft.placements = []
    } else if (key === 'storage') {
      const shelfIds = new Set(rows.map((row) => Number(row.id)))
      draft.placements = draft.placements.filter((placement) => !shelfIds.has(Number(placement.shelfId)))
    }
    return rows
  })
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 跨标签页写入时丢弃本页缓存，下次读取拿到最新版本，乐观锁才能拦住后到的并发请求。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}
