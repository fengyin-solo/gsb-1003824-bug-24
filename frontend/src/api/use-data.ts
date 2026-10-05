import { computed, ref } from 'vue'

import { listEntries, listShelfViews } from '@/api/local-service'
import { dataTick } from '@/data/local-store'
import type { EntryRow, ShelfView } from '@/data/types'

// 列表页/详情页共用的响应式数据源：所有读操作都挂在 dataTick 上，
// 任一事务提交或跨标签页写入后整体重算，页面不会留下旧计数、旧状态。
export function useModuleEntries(key: string) {
  const filters = ref<Record<string, string>>({})
  const items = computed<EntryRow[]>(() => {
    void dataTick.value
    return listEntries(key, filters.value).items
  })
  const total = computed(() => {
    void dataTick.value
    return listEntries(key, filters.value).total
  })
  return { filters, items, total }
}

export function useShelfViews() {
  const shelves = computed<ShelfView[]>(() => {
    void dataTick.value
    return listShelfViews()
  })
  return { shelves }
}
