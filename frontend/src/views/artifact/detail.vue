<template>
  <section class="page" data-module="artifact-detail">
    <header class="page-head">
      <div>
        <h2>出土遗物详情</h2>
        <p class="page-desc">器物编号、入库状态与库房架位占用同屏核对，入库结果与列表页、库房页共用同一份数据。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="goBack">返回列表</button>
      </div>
    </header>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <p v-if="noticeMessage" class="status-legend"><span class="legend-item">{{ noticeMessage }}</span></p>

    <div v-if="artifact" class="stat-row">
      <article class="stat-card">
        <span class="stat-label">器物编号</span>
        <strong class="stat-value">{{ artifact[codeField] ?? artifact.id }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">当前状态</span>
        <strong class="stat-value">{{ artifact.status }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">入库架位</span>
        <strong class="stat-value">{{ artifact['入库架位'] || '—' }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">架位占用</span>
        <strong class="stat-value">{{ boundShelf ? `${boundShelf.current}/${boundShelf.capacity}` : '—' }}</strong>
      </article>
    </div>

    <table v-if="artifact" class="data-table">
      <tbody>
        <tr v-for="field in meta.fields" :key="field">
          <th>{{ field }}</th>
          <td>{{ artifact[field] || '—' }}</td>
        </tr>
        <tr>
          <th>当前状态</th>
          <td>{{ artifact.status }}</td>
        </tr>
        <tr v-if="placement">
          <th>入库流水</th>
          <td>{{ placement.shelfCode }} · {{ placement.storedAtLabel }}</td>
        </tr>
        <tr v-else-if="artifact.status === '已入库'">
          <th>入库流水</th>
          <td>已归档历史入库记录，按历史数据保留，不按新计数规则改写</td>
        </tr>
      </tbody>
    </table>

    <section v-if="artifact" class="storage-panel">
      <h3>库房架位占用</h3>
      <table class="data-table">
        <thead>
          <tr><th>架位编号</th><th>容纳件数</th><th>当前件数</th><th>架位状态</th><th>是否可用</th></tr>
        </thead>
        <tbody>
          <tr v-for="shelf in shelves" :key="shelf.id">
            <td>{{ shelf.code }}</td>
            <td>{{ shelf.capacity }}</td>
            <td>{{ shelf.current }}</td>
            <td>{{ shelf.status }}</td>
            <td>{{ shelf.sealed ? '已封存' : shelf.full ? '已占满' : '可入库' }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="!placement && artifact.status !== '已入库'" class="store-bar">
        <label class="filter-item">
          <span>入库架位</span>
          <select v-model="selectedShelf">
            <option value="">自动分配首个可用架位</option>
            <option v-for="shelf in availableShelves" :key="shelf.id" :value="String(shelf.id)">
              {{ shelf.code }}（剩余 {{ shelf.capacity - shelf.current }} 件）
            </option>
          </select>
        </label>
        <button class="btn primary" type="button" :disabled="storing" @click="confirmStore">
          {{ storing ? '入库中…' : '办理入库' }}
        </button>
        <span class="page-desc">数据版本 v{{ version }}：并发占用时后到请求会失败并提示。</span>
      </div>
      <p v-else class="page-desc">该遗物已完成入库，重复点击不会再次扣减库位。</p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'

import {
  dataVersion,
  getEntry,
  moduleMeta,
  placementOfArtifact,
  shelfOccupancy,
  storeArtifact,
} from '@/api/local-service'
import type { EntryRow, ShelfOccupancy, StoragePlacement } from '@/data/types'

const meta = moduleMeta('artifact')
const codeField = '器物编号'

const route = useRoute()
const router = useRouter()

const artifact = ref<EntryRow | null>(null)
const shelves = ref<ShelfOccupancy[]>([])
const placement = ref<(StoragePlacement & { storedAtLabel: string }) | null>(null)
const selectedShelf = ref('')
const storing = ref(false)
const errorMessage = ref('')
const noticeMessage = ref('')
const version = ref(0)

const boundShelf = computed(() => {
  const code = artifact.value ? String(artifact.value['入库架位'] ?? '') : ''
  return shelves.value.find((shelf) => shelf.code === code) ?? null
})

const availableShelves = computed(() =>
  shelves.value.filter((shelf) => !shelf.sealed && !shelf.full),
)

function artifactId(): number {
  return Number(route.params.id)
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function reload() {
  errorMessage.value = ''
  try {
    const row = getEntry('artifact', artifactId())
    if (!row) {
      artifact.value = null
      errorMessage.value = `没有找到编号为 ${artifactId()} 的出土遗物`
      return
    }
    artifact.value = row
    shelves.value = shelfOccupancy()
    const record = placementOfArtifact(artifactId())
    placement.value = record ? { ...record, storedAtLabel: formatTime(record.storedAt) } : null
    version.value = dataVersion()
    if (selectedShelf.value && !availableShelves.value.some((shelf) => String(shelf.id) === selectedShelf.value)) {
      selectedShelf.value = ''
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '出土遗物详情读取失败'
  }
}

function confirmStore() {
  errorMessage.value = ''
  noticeMessage.value = ''
  storing.value = true
  // 版本在点击瞬间读取：另一请求若先占了同一架位，这里的乐观锁会让本次入库整体退回。
  const expectedVersion = dataVersion()
  const shelfId = selectedShelf.value ? Number(selectedShelf.value) : undefined
  const result = storeArtifact(artifactId(), shelfId, expectedVersion)
  storing.value = false
  if (!result.ok) {
    errorMessage.value = result.message
    reload()
    return
  }
  noticeMessage.value = result.message
  reload()
}

function goBack() {
  router.push('/artifact')
}

onMounted(reload)
// 详情页之间直接切换（/artifact/1 -> /artifact/3）时组件复用，必须重新读取。
onBeforeRouteUpdate(() => {
  reload()
})
</script>

<style scoped>
.storage-panel {
  margin-top: 16px;
}
.storage-panel h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.data-table th {
  width: 160px;
  white-space: nowrap;
}
.store-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  margin-top: 10px;
}
.store-bar select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  min-width: 240px;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
