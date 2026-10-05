import { ref } from 'vue'

import { SEED_ROWS } from './seed'
import type { ActionResult, EntryRow } from './types'

// 本地持久化：全部业务模块共用同一份文档，一次写入要么整体成功要么整体丢弃，
// 不再按模块分两次写 localStorage，避免器物状态改了、架位计数却没改的残留。
const STORAGE_KEY = 'field-archaeology-digital:entries'
const SCHEMA_VERSION = 2

// 跨模块入库所依赖的模块键与字段，集中在这里，列表页/详情页/库房页都取同一份。
export const ARTIFACT_MODULE = 'artifact'
export const STORAGE_MODULE = 'storage'
export const SHELF_LINK_FIELD = '入库架位'
export const SHELF_LINKED_AT_FIELD = '入库时间'
export const SHELF_COUNT_FIELD = '当前件数'
export const SHELF_CAPACITY_FIELD = '容纳件数'
export const SHELF_CODE_FIELD = '架位编号'

type StoredRows = Record<string, EntryRow[]>

export type Database = {
  schemaVersion: number
  revision: number
  // 每个架位一个版本号：办理入库走乐观锁，版本对不上说明架位刚被别的请求占用。
  shelfVersion: Record<string, number>
  rows: StoredRows
}

// 业务校验不通过时用它中止事务：draft 直接丢弃，不写 localStorage、不动缓存。
export class TransactionRollback extends Error {
  constructor(public readonly result: ActionResult) {
    super(result.message)
    this.name = 'TransactionRollback'
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function freshDatabase(): Database {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    shelfVersion: {},
    rows: clone(SEED_ROWS),
  }
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

// 同一器物只允许存在一条：先按主键 id 去重，再按器物编号兜底去重，保留最早一条，
// 修掉「重新进入又冒出一件重复出土遗物」的脏数据，且不会改写留下的历史记录。
function dedupeRows(rows: unknown, useBusinessKey?: string): EntryRow[] {
  const seenId = new Set<unknown>()
  const seenBusinessKey = new Set<unknown>()
  const result: EntryRow[] = []
  if (!Array.isArray(rows)) {
    return result
  }
  for (const item of rows) {
    const row = item as EntryRow
    if (!row || typeof row !== 'object') {
      continue
    }
    if (seenId.has(row.id)) {
      continue
    }
    seenId.add(row.id)
    if (useBusinessKey) {
      const keyValue = row[useBusinessKey]
      if (keyValue !== undefined && keyValue !== '') {
        if (seenBusinessKey.has(keyValue)) {
          continue
        }
        seenBusinessKey.add(keyValue)
      }
    }
    result.push(row)
  }
  return result
}

function sanitizeRows(raw: StoredRows | undefined): StoredRows {
  // 缺失的业务模块仍用种子数据补齐；已存在的模块绝不拿种子覆盖，避免旧记录复活。
  const next: StoredRows = {}
  for (const [key, seed] of Object.entries(SEED_ROWS)) {
    next[key] = raw && Array.isArray(raw[key]) ? raw[key] : clone(seed)
  }
  if (raw) {
    for (const [key, value] of Object.entries(raw)) {
      if (!(key in next) && Array.isArray(value)) {
        next[key] = value
      }
    }
  }
  for (const [key, rows] of Object.entries(next)) {
    next[key] = dedupeRows(
      rows,
      key === ARTIFACT_MODULE ? '器物编号' : undefined,
    )
  }
  return next
}

// 旧版（v1：直接就是 Record<string, EntryRow[]>）迁移：只规整库房的件数数字，
// 绝不回写器物的状态，已归档/已入库的历史出土遗物保持原样。
function migrateV1(raw: StoredRows): Database {
  const migrated = sanitizeRows(raw)
  if (Array.isArray(migrated[STORAGE_MODULE])) {
    migrated[STORAGE_MODULE] = migrated[STORAGE_MODULE].map((row) => {
      const capacity = asNumber(row[SHELF_CAPACITY_FIELD])
      const count = asNumber(row[SHELF_COUNT_FIELD])
      return {
        ...row,
        // 容量缺失/非法时按 0 处理：在库房管理员补正前该架位不能再收器物，
        // 不凭空假定容量，避免把器物塞进不存在的空位。
        [SHELF_CAPACITY_FIELD]: Number.isNaN(capacity) ? 0 : capacity,
        // 旧的件数残留不信它；当前件数以入库关系投影为准，先归零再由列表投影。
        [SHELF_COUNT_FIELD]: Number.isNaN(count) ? 0 : count,
      }
    })
  }
  return { schemaVersion: SCHEMA_VERSION, revision: 1, shelfVersion: {}, rows: migrated }
}

function migrateV2(raw: Partial<Database> | null | undefined): Database {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: asNumber(raw?.revision) > 0 ? (raw?.revision as number) : 1,
    shelfVersion:
      raw?.shelfVersion && typeof raw.shelfVersion === 'object' ? raw.shelfVersion : {},
    rows: sanitizeRows(raw?.rows),
  }
}

function parseDatabase(value: string): Database {
  const parsed = JSON.parse(value) as unknown
  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as { schemaVersion?: unknown }).schemaVersion === SCHEMA_VERSION
  ) {
    return migrateV2(parsed as Partial<Database>)
  }
  // v1 形态：顶层就是模块数组映射。
  return migrateV1(parsed as StoredRows)
}

let database: Database | null = null

// 响应式心跳：任何成功提交（含跨标签页写入）都 +1，列表页和详情页的 computed 随之刷新，
// 两个页面读的是同一份数据，入库结果不可能再对不上。
export const dataTick = ref(0)

function bumpTick(): void {
  dataTick.value += 1
}

function loadDatabase(): Database {
  if (typeof window === 'undefined' || !window.localStorage) {
    return freshDatabase()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = freshDatabase()
    persistDatabase(seeded)
    return seeded
  }
  try {
    return parseDatabase(raw)
  } catch {
    const fallback = freshDatabase()
    persistDatabase(fallback)
    return fallback
  }
}

function persistDatabase(next: Database): void {
  next.revision += 1
  const serialized = JSON.stringify(next)
  // 先写持久化，再换内存：localStorage 抛错（配额/隐私模式）时整体事务失败，
  // 调用方拿到异常后连内存里的 draft 一起丢弃，实现「一起成功或一起退回」。
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) {
      return
    }
    try {
      database = event.newValue ? parseDatabase(event.newValue) : freshDatabase()
      bumpTick()
    } catch {
      // 别的标签页写进了无法解析的内容，保持当前已加载的数据不动。
    }
  })
}

export function ensureDatabase(): Database {
  if (database === null) {
    database = loadDatabase()
  }
  return database
}

export function allRows(): StoredRows {
  return ensureDatabase().rows
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function findRow(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

export function currentShelfVersion(shelfId: number): number {
  return ensureDatabase().shelfVersion[String(shelfId)] ?? 0
}

// 串行化事务：同一时刻只有一个事务在提交；fn 内返回失败结果用 TransactionRollback，
// fn 抛错或持久化失败时 draft 与缓存都不落库。跨模块的器物+架位更新在同一事务里完成。
let tail: Promise<unknown> = Promise.resolve()

export function runTransaction<T>(
  fn: (draft: Database) => T | PromiseLike<T>,
): Promise<T> {
  const run = tail.then(() => {
    const draft = clone(ensureDatabase())
    return Promise.resolve(fn(draft)).then((result) => {
      persistDatabase(draft)
      database = draft
      bumpTick()
      return result
    })
  })
  // 上一个事务失败不能把后面的整条队列带挂。
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// 普通单模块动作仍走同一持久化入口：整份文档一次写入并推进 revision。
export function saveRows(key: string, rows: EntryRow[]): void {
  const draft = clone(ensureDatabase())
  draft.rows[key] = rows
  persistDatabase(draft)
  database = draft
  bumpTick()
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
