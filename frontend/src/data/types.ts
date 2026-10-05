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

/** 架位投影：当前件数不由人工维护，而是按入库关系实时算出，杜绝旧计数残留。 */
export type ShelfView = {
  id: number
  code: string
  capacity: number
  occupied: number
  remaining: number
  status: string
  // 办理入库时按这个版本做乐观锁；并发下后到请求发现版本变化即失败。
  version: number
}

export type StockInInput = {
  artifactId: number
  shelfId: number
  // 打开架位选择时看到的版本：提交时若已被别的入库请求推高，判为占用冲突。
  expectedVersion: number
  operator?: string
}

export type StockInResult = ActionResult & {
  artifactId?: number
  shelfId?: number
}
