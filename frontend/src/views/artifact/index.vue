<template>
  <section class="page" data-module="artifact">
    <header class="page-head">
      <div>
        <h2>出土遗物管理</h2>
        <p class="page-desc">维护出土遗物，围绕器物编号、出土探方、出土层位、器物质地做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记出土遗物</button>
        <button class="btn" type="button" @click="exportRows">导出出土遗物清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent>
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>入库架位</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <RouterLink
              v-if="column === '器物编号'"
              class="link"
              :to="{ name: 'artifact-detail', params: { id: row.id } }"
            >
              {{ row[column] ?? '—' }}
            </RouterLink>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td>{{ shelfCodeOf(row) ?? '—' }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无出土遗物数据，可先登记出土遗物</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条出土遗物记录</span>
      <span v-if="noticeMessage" :class="noticeKind === 'error' ? 'error-text' : 'ok-text'">{{ noticeMessage }}</span>
    </footer>

    <StockInDialog
      v-model="stockInOpen"
      :artifact-id="stockInTarget?.id ?? null"
      :artifact-code="stockInTarget ? String(stockInTarget['器物编号']) : ''"
      @done="onStockInDone"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  downloadEntries,
  listShelfViews,
  runAction as applyAction,
} from '@/api/local-service'
import { useModuleEntries } from '@/api/use-data'
import { SHELF_LINK_FIELD } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import StockInDialog from './StockInDialog.vue'

const columns = ["器物编号", "出土探方", "出土层位", "器物质地", "器物类型", "完残程度", "登记人", "登记状态"]
const actions = ["完成清洗", "分配编号", "办理入库"]
const statuses = ["已采集", "已清洗", "已编号", "已入库", "借出展示"]
const terminalStatuses = ["已入库", "借出展示"]

const { filters, items: rows, total } = useModuleEntries('artifact')
const filterFields = columns.slice(0, 3)

const noticeMessage = ref('')
const noticeKind = ref<'error' | 'ok'>('error')
const stockInOpen = ref(false)
const stockInTarget = ref<EntryRow | null>(null)

const statCards = computed(() => [
  { label: '遗物总数', value: total.value },
  {
    label: '已入库数',
    value: rows.value.filter((row) => terminalStatuses.includes(String(row.status))).length,
  },
  { label: '待清洗数', value: rows.value.filter((row) => String(row.status) === '已采集').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
}

function exportRows() {
  downloadEntries('artifact')
}

function openCreate() {
  noticeKind.value = 'error'
  noticeMessage.value = '出土遗物登记入口尚未接入审批流'
}

// 已归档（已入库/借出）的遗物不再显示状态动作，历史记录不允许被回退改写。
function availableActions(row: EntryRow): string[] {
  return terminalStatuses.includes(String(row.status)) ? [] : actions
}

function shelfCodeOf(row: EntryRow): string | undefined {
  const linked = row[SHELF_LINK_FIELD]
  if (linked === undefined || linked === '') {
    return undefined
  }
  const shelf = listShelfViews().find((item) => item.id === Number(linked))
  return shelf?.code ?? String(linked)
}

function runAction(action: string, row: EntryRow) {
  noticeMessage.value = ''
  if (action === '办理入库') {
    stockInTarget.value = row
    stockInOpen.value = true
    return
  }
  const result = applyAction('artifact', Number(row.id), action)
  noticeKind.value = result.ok ? 'ok' : 'error'
  noticeMessage.value = result.message
}

function onStockInDone(message: string) {
  noticeKind.value = 'ok'
  noticeMessage.value = message
  // 提交后事务已更新 dataTick，列表与库房页的 computed 自动重算，无需手动 reload。
  stockInTarget.value = null
}
</script>
