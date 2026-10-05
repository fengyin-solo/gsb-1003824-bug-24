<template>
  <div v-if="modelValue" class="modal-mask" role="dialog" aria-modal="true" @click.self="close">
    <div class="modal-card">
      <header class="modal-head">
        <h3>办理入库 · {{ artifactCode }}</h3>
        <button class="link" type="button" @click="close">关闭</button>
      </header>
      <p class="page-desc">选择目标库房架位。器物状态与架位占用在同一事务内提交，失败会整体退回。</p>

      <table class="data-table shelf-table">
        <thead>
          <tr>
            <th>选择</th>
            <th>架位编号</th>
            <th>架位状态</th>
            <th>容量</th>
            <th>已占用</th>
            <th>剩余</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="shelf in shelves"
            :key="shelf.id"
            :class="{ 'shelf-disabled': !selectable(shelf) }"
          >
            <td>
              <input
                v-if="selectable(shelf)"
                type="radio"
                name="shelf"
                :value="shelf.id"
                :checked="selectedId === shelf.id"
                @change="selectShelf(shelf)"
              />
              <span v-else class="error-text">不可选</span>
            </td>
            <td>{{ shelf.code }}</td>
            <td>{{ shelf.status }}</td>
            <td>{{ shelf.capacity }}</td>
            <td>{{ shelf.occupied }}</td>
            <td>{{ shelf.remaining }}</td>
          </tr>
          <tr v-if="!shelves.length">
            <td colspan="6" class="empty-state">暂无可用架位</td>
          </tr>
        </tbody>
      </table>

      <p v-if="errorMessage" class="error-text modal-error">{{ errorMessage }}</p>

      <footer class="modal-foot">
        <button class="btn" type="button" :disabled="submitting" @click="close">取消</button>
        <button
          class="btn primary"
          type="button"
          :disabled="submitting || !selected"
          @click="confirm"
        >
          {{ submitting ? '入库中…' : '确认入库' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { stockInArtifact } from '@/api/local-service'
import { useShelfViews } from '@/api/use-data'
import type { ShelfView } from '@/data/types'

const props = defineProps<{
  modelValue: boolean
  artifactId: number | null
  artifactCode: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'done', message: string): void
}>()

const { shelves } = useShelfViews()
const selectedId = ref<number | null>(null)
const selected = ref<ShelfView | null>(null)
const submitting = ref(false)
const errorMessage = ref('')

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      selectedId.value = null
      selected.value = null
      errorMessage.value = ''
      submitting.value = false
    }
  },
)

function selectable(shelf: ShelfView): boolean {
  return shelf.status === '正常使用' && shelf.remaining > 0
}

function selectShelf(shelf: ShelfView): void {
  selectedId.value = shelf.id
  // 记住打开选择时看到的版本：并发下后到请求据此判定架位是否已被占用。
  selected.value = shelf
  errorMessage.value = ''
}

function close(): void {
  if (submitting.value) {
    return
  }
  emit('update:modelValue', false)
}

async function confirm(): Promise<void> {
  if (!selected.value || props.artifactId === null || submitting.value) {
    return
  }
  submitting.value = true
  errorMessage.value = ''
  try {
    const result = await stockInArtifact({
      artifactId: props.artifactId,
      shelfId: selected.value.id,
      expectedVersion: selected.value.version,
    })
    if (!result.ok) {
      errorMessage.value = result.message
      // 版本冲突后清掉过期选择，必须按刷新后的占用重新挑架位，避免拿着旧版本连点。
      selectedId.value = null
      selected.value = null
      return
    }
    emit('done', result.message)
    emit('update:modelValue', false)
  } finally {
    submitting.value = false
  }
}
</script>
