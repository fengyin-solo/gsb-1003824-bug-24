<template>
  <section class="page" data-module="artifact-detail">
    <header class="page-head">
      <div>
        <h2>出土遗物详情</h2>
        <p class="page-desc">详情页与列表页读取同一份事务数据，入库结果、架位占用始终一致。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" :to="{ name: 'artifact' }">返回列表</RouterLink>
      </div>
    </header>

    <template v-if="row">
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">器物编号</span>
          <strong class="stat-value">{{ row['器物编号'] }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">当前状态</span>
          <strong class="stat-value">{{ row.status }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">入库架位</span>
          <strong class="stat-value">{{ shelfCode ?? '—' }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">入库时间</span>
          <strong class="stat-value">{{ String(row['入库时间'] ?? '—') }}</strong>
        </article>
      </div>

      <table class="data-table detail-table">
        <tbody>
          <tr v-for="field in fields" :key="field">
            <th>{{ field }}</th>
            <td>{{ row[field] ?? '—' }}</td>
          </tr>
        </tbody>
      </table>

      <div class="detail-actions">
        <button
          v-for="action in availableActions"
          :key="action"
          class="btn"
          :class="{ primary: action === '办理入库' }"
          type="button"
          @click="runAction(action)"
        >
          {{ action }}
        </button>
      </div>

      <footer class="page-foot">
        <span v-if="noticeMessage" :class="noticeKind === 'error' ? 'error-text' : 'ok-text'">{{ noticeMessage }}</span>
        <span v-else-if="archived">该器物已归档，历史记录不会被新的计数规则改写</span>
      </footer>
    </template>

    <section v-else class="empty-block">
      <p class="empty-state">没有找到这件出土遗物，可能已被清理或编号无效。</p>
      <RouterLink class="btn primary" :to="{ name: 'artifact' }">返回出土遗物列表</RouterLink>
    </section>

    <StockInDialog
      v-model="stockInOpen"
      :artifact-id="row ? Number(row.id) : null"
      :artifact-code="row ? String(row['器物编号']) : ''"
      @done="onStockInDone"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { listShelfViews, runAction as applyAction } from '@/api/local-service'
import { useModuleEntries } from '@/api/use-data'
import { SHELF_LINK_FIELD } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import StockInDialog from './StockInDialog.vue'

const route = useRoute()
const { items: rows } = useModuleEntries('artifact')

const fields = ["器物编号", "出土探方", "出土层位", "器物质地", "器物类型", "完残程度", "登记人", "登记状态"]
const actions = ["完成清洗", "分配编号", "办理入库"]
const terminalStatuses = ["已入库", "借出展示"]

const noticeMessage = ref('')
const noticeKind = ref<'error' | 'ok'>('error')
const stockInOpen = ref(false)

const artifactId = computed(() => Number(route.params.id))

// 路由参数变化（列表点不同器物）与事务提交后都靠这个 computed 重新取值。
const row = computed<EntryRow | undefined>(() =>
  rows.value.find((item) => Number(item.id) === artifactId.value),
)

const archived = computed(() => (row.value ? terminalStatuses.includes(String(row.value.status)) : false))
const availableActions = computed(() => (archived.value ? [] : actions))
const shelfCode = computed(() => {
  if (!row.value) {
    return undefined
  }
  const linked = row.value[SHELF_LINK_FIELD]
  if (linked === undefined || linked === '') {
    return undefined
  }
  const shelf = listShelfViews().find((item) => item.id === Number(linked))
  return shelf?.code ?? String(linked)
})

watch(
  () => route.params.id,
  () => {
    noticeMessage.value = ''
    stockInOpen.value = false
  },
)

function runAction(action: string) {
  if (!row.value) {
    return
  }
  noticeMessage.value = ''
  if (action === '办理入库') {
    stockInOpen.value = true
    return
  }
  const result = applyAction('artifact', Number(row.value.id), action)
  noticeKind.value = result.ok ? 'ok' : 'error'
  noticeMessage.value = result.message
}

function onStockInDone(message: string) {
  noticeKind.value = 'ok'
  noticeMessage.value = message
}
</script>
