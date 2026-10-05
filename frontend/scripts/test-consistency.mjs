// 入库一致性的功能测试：用内存版 localStorage 跑真实的数据层，验证
// 事务成功/退回、失败不产生重复遗物、重复入库幂等、架位占满/封存拒绝、并发版本冲突、历史件保留、老数据迁移。
import { build as esbuild } from 'esbuild'
import { fileURLToPath, URL } from 'node:url'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const srcDir = fileURLToPath(new URL('../src', import.meta.url))
const outDir = fileURLToPath(new URL('../.test-tmp', import.meta.url))
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// ---- 内存 localStorage ----
const memory = new Map()
const listeners = []
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
  clear: () => memory.clear(),
  key: (i) => [...memory.keys()][i] ?? null,
  get length() {
    return memory.size
  },
}
globalThis.addEventListener = (type, cb) => {
  if (type === 'storage') listeners.push(cb)
}
// 数据层通过 window.localStorage / window.addEventListener 访问浏览器 API，
// 在 Node 里把 window 指回全局，测试才能真正走到持久化与 storage 事件分支。
globalThis.window = globalThis
function fireStorage(key) {
  for (const cb of listeners) cb({ key })
}

// ---- 两个 bundle 模拟两个浏览器标签页：共享 localStorage，各自持有模块缓存，
//      写入后通过 storage 事件让对方缓存失效（与真实多标签页行为一致）。----
const moduleSource = `
import { runAction, storeArtifact, listEntries, shelfOccupancy, getEntry, placementOfArtifact, dataVersion } from '@/api/local-service'
import { resetRows, listRows, listPlacements, transact } from '@/data/local-store'
export const api = { runAction, storeArtifact, listEntries, shelfOccupancy, getEntry, placementOfArtifact, dataVersion }
export const store = { resetRows, listRows, listPlacements, transact }
`
const entryA = `${outDir}/entry-a.ts`
const entryB = `${outDir}/entry-b.ts`
writeFileSync(entryA, moduleSource)
writeFileSync(entryB, moduleSource)

await esbuild({
  entryPoints: [entryA, entryB],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outdir: outDir,
  outExtension: { '.js': '.cjs' },
  logLevel: 'silent',
  alias: { '@': srcDir },
})

const tabA = (await import(pathToFileURL(`${outDir}/entry-a.cjs`).href))
const tabB = (await import(pathToFileURL(`${outDir}/entry-b.cjs`).href))

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name} ${detail}`)
  }
}

const api = tabA.api
const store = tabA.store

function snapshot(tab = tabA) {
  return {
    artifacts: tab.store.listRows('artifact').map((r) => ({ ...r })),
    shelves: tab.store.listRows('storage').map((r) => ({ ...r })),
    placements: tab.store.listPlacements().map((r) => ({ ...r })),
  }
}

function reset() {
  memory.clear()
  // 两个标签页的缓存都通过 storage 事件失效。
  fireStorage('field-archaeology-digital:entries')
  // 由 A 页完成一次播种写入，B 页随后从共享 localStorage 读到同一份种子与版本。
  tabA.store.resetRows('artifact')
  tabA.store.resetRows('storage')
  fireStorage('field-archaeology-digital:entries')
  // 让两个标签页都完成首次读取，版本对齐到同一份种子。
  tabA.api.dataVersion()
  tabB.api.dataVersion()
}

// 1. 首次播种：种子里的已入库历史件（id=4）原样保留，架位件数为初始数字。
{
  memory.clear()
  fireStorage('field-archaeology-digital:entries')
  const archived = api.getEntry('artifact', 4)
  check('历史归档件初始为已入库', String(archived.status) === '已入库')
  check('历史归档件不写入库架位', !archived['入库架位'])
  check('历史归档件不生成流水', api.placementOfArtifact(4) === null)
  const shelves = api.shelfOccupancy()
  const s1 = shelves.find((s) => s.id === 1)
  const s2 = shelves.find((s) => s.id === 2)
  check('架位1初始 0/20', s1.current === 0 && s1.capacity === 20, JSON.stringify(s1))
  check('架位2初始已满 10/10', s2.current === 10 && s2.full, JSON.stringify(s2))
}

// 2. 正常入库：遗物状态、入库架位与架位计数在同一事务里一起变。
{
  reset()
  const before = snapshot()
  const r = api.runAction('artifact', 1, '办理入库')
  check('入库成功', r.ok, r.message)
  const a = api.getEntry('artifact', 1)
  check('遗物状态变为已入库', String(a.status) === '已入库')
  check('遗物写入入库架位', a['入库架位'] === 'STOR-0001', String(a['入库架位']))
  const s1 = api.shelfOccupancy().find((s) => s.id === 1)
  check('架位1件数变为 1', s1.current === 1, String(s1.current))
  check('生成一条流水', store.listPlacements().length === 1)
  check('入库只新增流水不改遗物条数', snapshot().artifacts.length === before.artifacts.length)
}

// 3. 重复点击入库：幂等，只扣一次库位。
{
  reset()
  const r1 = api.runAction('artifact', 1, '办理入库')
  const v1 = api.dataVersion()
  const r2 = api.runAction('artifact', 1, '办理入库')
  const v2 = api.dataVersion()
  check('第一次入库成功', r1.ok)
  check('重复入库幂等返回', r2.ok && r2.message.includes('无需重复办理'), r2.message)
  check('幂等不推进版本', v1 === v2, `${v1} vs ${v2}`)
  const s1 = api.shelfOccupancy().find((s) => s.id === 1)
  check('架位件数仍是 1', s1.current === 1, String(s1.current))
  check('流水仍只有一条', store.listPlacements().length === 1)
  check('遗物没有重复新增', store.listRows('artifact').length === 4)
}

// 4. 历史归档件不能借新规则重复办理、计数不变。
{
  reset()
  const occupiedBefore = api.shelfOccupancy().reduce((sum, s) => sum + s.current, 0)
  const r = api.runAction('artifact', 4, '办理入库')
  const occupiedAfter = api.shelfOccupancy().reduce((sum, s) => sum + s.current, 0)
  check('历史件重复入库被拒', !r.ok && r.message.includes('历史入库记录'), r.message)
  check('历史件不新增占用', occupiedBefore === occupiedAfter, `${occupiedBefore} vs ${occupiedAfter}`)
  check('历史件不生成流水', api.placementOfArtifact(4) === null)
}

// 5. 占满架位不能再入，失败后遗物与架位一起退回、不留重复行。
{
  reset()
  const before = snapshot()
  const r = api.storeArtifact(1, 2)
  check('占满架位入库失败', !r.ok && r.message.includes('占满'), r.message)
  const a = api.getEntry('artifact', 1)
  check('失败后遗物状态退回已采集', String(a.status) === '已采集', String(a.status))
  const s2 = api.shelfOccupancy().find((s) => s.id === 2)
  check('失败后满架位仍是 10 件', s2.current === 10)
  check('失败不产生流水', store.listPlacements().length === 0)
  check('失败不产生重复遗物', JSON.stringify(snapshot()) === JSON.stringify(before))
}

// 6. 封存架位拒绝入库。
{
  reset()
  api.runAction('storage', 1, '临时封存')
  const r = api.storeArtifact(1, 1)
  check('封存架位入库失败', !r.ok && r.message.includes('封存'), r.message)
  check('遗物状态不变', String(api.getEntry('artifact', 1).status) === '已采集')
  check('封存动作不产生流水', store.listPlacements().length === 0)
}

// 7. 架位装满自动翻「已满」，满架位不参与自动分配。
{
  reset()
  store.transact((draft) => {
    draft.entries.storage[0]['容纳件数'] = 2
  })
  api.storeArtifact(1, 1)
  api.storeArtifact(2, 1)
  const s1 = api.shelfOccupancy().find((s) => s.id === 1)
  check('连续入库到上限', s1.current === 2 && s1.full, JSON.stringify(s1))
  const shelfRow = store.listRows('storage')[0]
  check('架位行状态自动翻为已满', String(shelfRow.status) === '已满', String(shelfRow.status))
  const r = api.storeArtifact(3)
  check('满架位后自动分配仍可成功', r.ok, r.message)
  const a3 = api.getEntry('artifact', 3)
  check('自动分配避开已满架位', a3['入库架位'] !== 'STOR-0001', String(a3['入库架位']))
}

// 8. 乐观锁（真实双标签页）：B 页先读到版本 v，A 页抢先占了同一架位并广播 storage 事件，
//    B 页拿着旧版本提交时必须失败、提示占用，遗物状态与架位计数一起退回。
{
  reset()
  // B 页先打开详情页，读到当前版本
  const staleVersion = tabB.api.dataVersion()
  check('双标签页初始版本一致', staleVersion === tabA.api.dataVersion())
  // A 页抢先办理入库，推进持久化版本
  const first = tabA.api.storeArtifact(1, 1)
  check('先到请求成功', first.ok, first.message)
  // storage 事件广播给 B 页（模拟真实浏览器）
  fireStorage('field-archaeology-digital:entries')
  const before = snapshot(tabB)
  // B 页仍用打开时拿到的旧版本提交
  const second = tabB.api.storeArtifact(2, 1, staleVersion)
  check('后到请求版本冲突失败', !second.ok && second.message.includes('占用'), second.message)
  check('冲突后数据整体退回无残留', JSON.stringify(snapshot(tabB)) === JSON.stringify(before))
  check('B 页遗物2状态保持已清洗', String(tabB.api.getEntry('artifact', 2).status) === '已清洗')
  check('冲突后流水仍只有先到一条', tabB.store.listPlacements().length === 1)
  check('架位件数只被先到请求加了一次', tabB.api.shelfOccupancy().find((s) => s.id === 1).current === 1)
}

// 8b. B 页刷新到新版本后再提交，可以正常成功（占用解除后恢复可用）。
{
  // 接上一用例：B 页重新读取版本
  const freshVersion = tabB.api.dataVersion()
  const retry = tabB.api.storeArtifact(2, 1, freshVersion)
  check('刷新版本后重试成功', retry.ok, retry.message)
  check('重试后架位件数为 2', tabB.api.shelfOccupancy().find((s) => s.id === 1).current === 2)
}

// 9. 事务体内抛错不写库（成功或一起退回）。
{
  reset()
  const before = snapshot()
  let threw = false
  try {
    store.transact(() => {
      throw new Error('boom')
    })
  } catch {
    threw = true
  }
  check('mutator 抛错向上传播', threw)
  const a = api.getEntry('artifact', 1)
  check('抛错后数据保持原状', String(a.status) === '已采集', String(a.status))
  check('抛错后无任何写入', JSON.stringify(snapshot()) === JSON.stringify(before))
}

// 10. 老版本持久化结构（纯清单、无流水）迁移：旧 bug 断链入库退回已编号；占位文本件数修成数字。
{
  reset()
  const legacy = {
    artifact: [
      { id: 1, status: '已入库', pending: false, abnormal: false, 器物编号: 'ARTI-0001' },
      { id: 2, status: '已编号', pending: false, abnormal: false, 器物编号: 'ARTI-0002' },
    ],
    storage: [
      { id: 1, status: '正常使用', pending: true, abnormal: false, 架位编号: 'STOR-0001', 容纳件数: '库房管理样例1', 当前件数: '库房管理样例1' },
    ],
  }
  memory.set('field-archaeology-digital:entries', JSON.stringify(legacy))
  fireStorage('field-archaeology-digital:entries')
  const a1 = tabA.api.getEntry('artifact', 1)
  check('旧断链入库退回已编号可重新办理', String(a1.status) === '已编号', String(a1.status))
  // 迁移结果应已整体回写：重开（缓存失效）后读到的就是新结构，不再含老断链状态。
  const persisted = JSON.parse(memory.get('field-archaeology-digital:entries'))
  check('迁移后回写为新结构（含流水字段）', Array.isArray(persisted.placements) && persisted.reconciled === true)
  fireStorage('field-archaeology-digital:entries')
  check('重开后旧断链状态不再复活', String(tabA.api.getEntry('artifact', 1).status) === '已编号')
  const s1 = tabA.api.shelfOccupancy().find((s) => s.id === 1)
  check('占位文本件数迁移成数字', typeof s1.current === 'number' && s1.capacity === 20, JSON.stringify(s1))
  const r = tabA.api.runAction('artifact', 1, '办理入库')
  check('退回后可重新入库成功', r.ok, r.message)
  check('重新入库件数只加一次', tabA.api.shelfOccupancy().find((s) => s.id === 1).current === 1)
}

// 11. 重复 id 的脏行迁移时去重（对应"重新进入又出现一件重复遗物"）。
{
  reset()
  const dup = {
    artifact: [
      { id: 1, status: '已采集', pending: true, abnormal: false, 器物编号: 'ARTI-0001' },
      { id: 1, status: '已采集', pending: true, abnormal: false, 器物编号: 'ARTI-0001' },
      { id: 2, status: '已编号', pending: false, abnormal: false, 器物编号: 'ARTI-0002' },
    ],
    storage: [
      { id: 1, status: '正常使用', pending: true, abnormal: false, 架位编号: 'STOR-0001', 容纳件数: 20, 当前件数: 0 },
    ],
  }
  memory.set('field-archaeology-digital:entries', JSON.stringify(dup))
  fireStorage('field-archaeology-digital:entries')
  const list = tabA.api.listEntries('artifact')
  check('重复 id 迁移后只剩一条', list.total === 2, String(list.total))
}

// 12. 列表口径与库房占用一致：每架位的当前件数 = 指向该架位的流水数 + 历史占位件（种子满架位）。
{
  reset()
  api.runAction('artifact', 3, '办理入库')
  const storedCount = api.listEntries('artifact').items.filter((r) => String(r.status) === '已入库').length
  const occupied = api.shelfOccupancy().reduce((sum, s) => sum + s.current, 0)
  const ledgerCount = store.listPlacements().length
  const historicalOccupancy = 10 + 3 // 种子：2 号架位已满 10 件，3 号架位 3 件（已归档历史件）
  check('列表已入库数含历史件', storedCount >= 2, String(storedCount))
  check('架位总占用 = 历史占位 + 新流水', occupied === historicalOccupancy + ledgerCount, `${occupied} vs ${historicalOccupancy + ledgerCount}`)
  // 新入库件落的架位，其增量必须正好是 1，且与流水逐条对应
  const placedShelf = store.listRows('storage').find((s) => String(s['架位编号']) === 'STOR-0001')
  const ledgerOnShelf = store.listPlacements().filter((p) => p.shelfId === Number(placedShelf.id)).length
  check('入库架位件数与流水逐条对应', Number(placedShelf['当前件数']) === ledgerOnShelf, `${placedShelf['当前件数']} vs ${ledgerOnShelf}`)
}

// 13. 持久化往返：写入后模拟刷新（缓存失效重读），结果不变。
{
  reset()
  api.runAction('artifact', 1, '办理入库')
  const before = snapshot()
  fireStorage('field-archaeology-digital:entries') // 模拟刷新：缓存丢弃
  const after = snapshot()
  check('刷新/重新进入后遗物状态保留', String(api.getEntry('artifact', 1).status) === '已入库')
  check('刷新后流水不重复', after.placements.length === before.placements.length)
  check('刷新后架位件数一致', JSON.stringify(after.shelves.map((s) => s['当前件数'])) === JSON.stringify(before.shelves.map((s) => s['当前件数'])))
  check('刷新后无重复遗物', after.artifacts.length === before.artifacts.length)
}

rmSync(outDir, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
