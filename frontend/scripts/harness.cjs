// 事务/并发/迁移行为验证：用 esbuild 把 TS 源码（含 @ 别名）打成 CJS 后在 Node 里跑。
const path = require('path')
const { build } = require('esbuild')

const RESULT = { outputFiles: [] }

async function load() {
  const result = await build({
    entryPoints: [path.join(__dirname, 'harness-entry.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    alias: { '@': path.join(__dirname, '..', 'src') },
  })
  const code = result.outputFiles[0].text
  const module = { exports: {} }
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  fn(module.exports, require, module, __filename, __dirname)
  return module.exports
}

class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
  clear() { this.map.clear() }
}

let currentStorage = new MemoryStorage()
function installWindow() {
  globalThis.window = {
    localStorage: currentStorage,
    addEventListener() {},
  }
}

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${name} ${detail}`)
  }
}

// 每个场景给一份独立 localStorage，模块也重新求值，保证互不污染。
async function scenario(name, seed, fn) {
  console.log(`\n[${name}]`)
  currentStorage = new MemoryStorage()
  if (seed !== undefined) {
    currentStorage.setItem('field-archaeology-digital:entries', JSON.stringify(seed))
  }
  installWindow()
  const api = await load()
  await fn(api)
}

function art(id, status, code = `ARTI-${id}`, extra = {}) {
  return { id, status, pending: status !== '已入库', abnormal: false, 器物编号: code, ...extra }
}
function shelf(id, code, capacity, count, status = '正常使用') {
  return {
    id, status, pending: true, abnormal: false,
    架位编号: code, 容纳件数: capacity, 当前件数: count,
  }
}

;(async () => {
  // ---- 场景 1：正常入库：同事务改器物+架位，投影一致 ----
  await scenario('正常入库事务', undefined, async ({ listEntries, stockInArtifact, listShelfViews }) => {
    const before = listShelfViews().find((s) => s.id === 2)
    check('入库前 STOR-0002 占用 0', before.occupied === 0, JSON.stringify(before))
    const r = await stockInArtifact({ artifactId: 3, shelfId: 2, expectedVersion: 0 })
    check('入库返回 ok', r.ok, r.message)
    const a = listEntries('artifact').items.find((x) => x.id === 3)
    check('器物状态=已入库', a.status === '已入库', a.status)
    check('器物回写架位关联', Number(a['入库架位']) === 2, String(a['入库架位']))
    check('入库时间已记录', typeof a['入库时间'] === 'string' && a['入库时间'].length === 10, String(a['入库时间']))
    const s = listShelfViews().find((x) => x.id === 2)
    check('架位占用=1', s.occupied === 1, JSON.stringify(s))
    check('库房列表当前件数=1',
      Number(listEntries('storage').items.find((x) => x.id === 2)['当前件数']) === 1)
    check('架位版本推进到1', s.version === 1, String(s.version))
  })

  // ---- 场景 2：重复点击入库只扣一次库位 ----
  await scenario('重复点击幂等', undefined, async ({ listShelfViews, stockInArtifact }) => {
    const results = await Promise.all([
      stockInArtifact({ artifactId: 3, shelfId: 2, expectedVersion: 0 }),
      stockInArtifact({ artifactId: 3, shelfId: 2, expectedVersion: 0 }),
      stockInArtifact({ artifactId: 3, shelfId: 2, expectedVersion: 0 }),
    ])
    check('只有一次成功', results.filter((r) => r.ok).length === 1,
      JSON.stringify(results.map((r) => r.message)))
    const s = listShelfViews().find((x) => x.id === 2)
    check('架位只扣一次=1', s.occupied === 1, JSON.stringify(s))
    check('版本只推进一次=1', s.version === 1, String(s.version))
  })

  // ---- 场景 3：同一架位并发写入不同器物，后到者版本冲突失败，且不扣库位 ----
  await scenario('同架位并发冲突', {
    artifact: [
      art(1, '已编号', 'ARTI-A'),
      art(2, '已编号', 'ARTI-B'),
    ],
    storage: [shelf(1, 'STOR-0001', 10, 0)],
  }, async ({ listEntries, listShelfViews, stockInArtifact }) => {
    // 两个请求都在「打开选择」时看到 version=0，随后并发提交。
    const results = await Promise.all([
      stockInArtifact({ artifactId: 1, shelfId: 1, expectedVersion: 0 }),
      stockInArtifact({ artifactId: 2, shelfId: 1, expectedVersion: 0 }),
    ])
    check('第一件成功', results[0].ok, results[0].message)
    check('第二件冲突失败并提示占用',
      !results[1].ok && results[1].message.includes('占用'), results[1].message)
    const s = listShelfViews().find((x) => x.id === 1)
    check('架位只被占用 1 个', s.occupied === 1 && s.version === 1, JSON.stringify(s))
    const b = listEntries('artifact').items.find((x) => x.id === 2)
    check('第二件器物状态原样退回=已编号', b.status === '已编号' && b['入库架位'] === undefined)
    // 后到请求按新版本重试应当成功
    const retry = await stockInArtifact({ artifactId: 2, shelfId: 1, expectedVersion: 1 })
    check('刷新版本后重试成功', retry.ok, retry.message)
    check('架位占用变为 2', listShelfViews().find((x) => x.id === 1).occupied === 2)
  })

  // ---- 场景 4：满架位/封存架位拒绝，事务整体退回 ----
  await scenario('满架位与封存拒绝', {
    artifact: [
      art(1, '已编号', 'ARTI-A'),
      art(2, '已编号', 'ARTI-B'),
      art(3, '已入库', 'ARTI-C', { 入库架位: 1 }),
      art(4, '借出展示', 'ARTI-D', { 入库架位: 1 }),
    ],
    storage: [shelf(1, 'STOR-FULL', 2, 2), shelf(2, 'STOR-LOCK', 5, 0, '临时封存')],
  }, async ({ listEntries, listShelfViews, stockInArtifact }) => {
    const full = await stockInArtifact({ artifactId: 1, shelfId: 1, expectedVersion: 0 })
    check('满架位被拒绝', !full.ok && full.message.includes('无空位'), full.message)
    const locked = await stockInArtifact({ artifactId: 2, shelfId: 2, expectedVersion: 0 })
    check('封存架位被拒绝', !locked.ok && locked.message.includes('临时封存'), locked.message)
    const items = listEntries('artifact').items
    check('两件候选器物都保持已编号',
      items.filter((x) => x.id <= 2).every((x) => x.status === '已编号'))
    check('已占用的两件归档器物状态未动',
      items.filter((x) => x.id > 2).every((x) => ['已入库', '借出展示'].includes(x.status)))
    const s1 = listShelfViews().find((x) => x.id === 1)
    check('满架位仍占2、版本未动', s1.occupied === 2 && s1.version === 0, JSON.stringify(s1))
  })

  // ---- 场景 5：满架位的最后一件成功后自动置满 ----
  await scenario('末件置满', {
    artifact: [
      art(1, '已编号', 'ARTI-A'),
      art(2, '已入库', 'ARTI-B', { 入库架位: 1 }),
    ],
    storage: [shelf(1, 'STOR-0001', 2, 1)],
  }, async ({ listEntries, listShelfViews, stockInArtifact }) => {
    const r = await stockInArtifact({ artifactId: 1, shelfId: 1, expectedVersion: 0 })
    check('最后一件入库成功', r.ok, r.message)
    const s = listShelfViews().find((x) => x.id === 1)
    check('占用=2、剩余=0、状态已满',
      s.occupied === 2 && s.remaining === 0 && s.status === '已满', JSON.stringify(s))
    check('库房页状态与投影一致',
      listEntries('storage').items.find((x) => x.id === 1).status === '已满')
  })

  // ---- 场景 6：已归档历史遗物不能被改写 ----
  await scenario('历史归档保护', undefined, async ({ listEntries, runAction, stockInArtifact }) => {
    const r1 = await stockInArtifact({ artifactId: 4, shelfId: 2, expectedVersion: 0 })
    check('已入库遗物重复入库被挡', !r1.ok && r1.ok !== undefined && r1.message.includes('请勿重复'), r1.message)
    const back = runAction('artifact', 4, '分配编号')
    check('归档遗物不能回退动作', !back.ok && back.message.includes('归档'), back.message)
    const r2 = await stockInArtifact({ artifactId: 5, shelfId: 2, expectedVersion: 0 })
    check('借出展示遗物也视为已入库', !r2.ok && r2.message.includes('请勿重复'), r2.message)
    const seeded = listEntries('artifact').items.find((x) => x.id === 4)
    check('归档器物关联架位保持 seed 值(1)', Number(seeded['入库架位']) === 1)
  })

  // ---- 场景 7：v1 旧数据迁移：不回写器物、旧件数残留被投影清除、重复行去重 ----
  await scenario('v1迁移一致性', {
    artifact: [
      art(1, '已采集', 'ARTI-0001'),
      art(2, '已入库', 'ARTI-0002'), // 旧时代已入库且无架位关联：原样保留
      art(1, '已采集', 'ARTI-0001'), // 重复主键
      art(4, '已编号', 'ARTI-0004'),
      art(5, '已编号', 'ARTI-0004'), // 重复器物编号
    ],
    storage: [
      shelf(1, 'STOR-0001', 0, 0, '已满'),
      shelf(2, 'STOR-0002', 5, 0, '已满'),
    ],
  }, async ({ listEntries, listShelfViews, stockInArtifact }) => {
    // 手工塞入旧版字段形态（非数字容量/旧件数残留）
    const raw = JSON.parse(currentStorage.getItem('field-archaeology-digital:entries'))
    raw.storage[0]['容纳件数'] = '非数字'
    raw.storage[0]['当前件数'] = '旧残留99'
    raw.storage[1]['当前件数'] = 99
    currentStorage.setItem('field-archaeology-digital:entries', JSON.stringify(raw))
    // 重新加载模块以触发迁移解析
    const migrated = await load()
    const arts = migrated.listEntries('artifact').items
    check('重复主键去重剩一条 id=1', arts.filter((x) => x.id === 1).length === 1)
    check('重复器物编号去重 ARTI-0004 一条', arts.filter((x) => x['器物编号'] === 'ARTI-0004').length === 1)
    check('历史已入库记录状态保留', arts.find((x) => x.id === 2).status === '已入库')
    const views = migrated.listShelfViews()
    const s1 = views.find((x) => x.id === 1)
    const s2 = views.find((x) => x.id === 2)
    check('非数字容量归零、旧残留99投影为0', s1.capacity === 0 && s1.occupied === 0, JSON.stringify(s1))
    check('旧满架位无占用自动归为正常使用', s2.status === '正常使用' && s2.occupied === 0, JSON.stringify(s2))
    check('库房列表不显示旧残留99',
      Number(migrated.listEntries('storage').items.find((x) => x.id === 2)['当前件数']) === 0)
    check('无关联的历史入库遗物不摊到架位', views.reduce((sum, x) => sum + x.occupied, 0) === 0)
    const r = await migrated.stockInArtifact({ artifactId: 4, shelfId: 1, expectedVersion: 0 })
    check('容量异常架位拒绝入库', !r.ok && r.message.includes('容量'), r.message)
  })

  // ---- 场景 8：持久化重读（模拟刷新/重新进入/返回列表）一致 ----
  await scenario('持久化后重读', undefined, async (api) => {
    const r = await api.stockInArtifact({ artifactId: 3, shelfId: 2, expectedVersion: 0 })
    check('入库成功', r.ok, r.message)
    // 模拟整页刷新：重新从 localStorage 解析一份全新模块实例
    const fresh = await load()
    const a = fresh.listEntries('artifact').items.find((x) => x.id === 3)
    const s = fresh.listShelfViews().find((x) => x.id === 2)
    check('刷新后器物仍已入库', a.status === '已入库' && Number(a['入库架位']) === 2)
    check('刷新后架位占用仍=1（跨模块一致）', s.occupied === 1, JSON.stringify(s))
    check('刷新后库房页件数=1',
      Number(fresh.listEntries('storage').items.find((x) => x.id === 2)['当前件数']) === 1)
    check('刷新后版本保留=1', s.version === 1, String(s.version))
    const persisted = JSON.parse(currentStorage.getItem('field-archaeology-digital:entries'))
    check('单文档 revision 提升', persisted.revision >= 2, String(persisted.revision))
  })

  // ---- 场景 9：前置状态不足（未编号）拒绝入库 ----
  await scenario('状态前置校验', undefined, async ({ stockInArtifact }) => {
    const r1 = await stockInArtifact({ artifactId: 1, shelfId: 2, expectedVersion: 0 })
    check('已采集不能直接入库', !r1.ok && r1.message.includes('清洗和编号'), r1.message)
    const r2 = await stockInArtifact({ artifactId: 999, shelfId: 2, expectedVersion: 0 })
    check('不存在器物被拒绝', !r2.ok && r2.message.includes('没有找到'), r2.message)
  })

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
