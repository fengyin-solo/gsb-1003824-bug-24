/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 入库流水：一件出土遗物至多一条，器物编号是唯一键，重复点击入库只扣一次库位。 */
export type StoragePlacement = {
  artifactId: number
  artifactCode: string
  shelfId: number
  shelfCode: string
  storedAt: string
}

/** 本地持久化的整体结构：清单、入库流水和版本号同存一个 key，一次事务整体写入或整体退回。 */
export type LocalDatabase = {
  entries: Record<string, EntryRow[]>
  placements: StoragePlacement[]
  version: number
  reconciled: boolean
}

/** 库房架位的占用快照，跨模块一律以这份口径读取，列表页/详情页不再各算各的。 */
export type ShelfOccupancy = {
  id: number
  code: string
  capacity: number
  current: number
  status: string
  full: boolean
  sealed: boolean
}

/** 乐观锁版本冲突：同一架位并发写入时，后到请求拿不到版本，整体退回并提示占用。 */
export class VersionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VersionConflictError'
  }
}
