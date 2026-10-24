<script setup lang="ts">
/* =============================================================================
 * RepairWorkbench.vue —— 客户区页签容器（框架核心不改，只在 App.vue 换一行）
 *
 * 两个并列模块：
 *   「通用修复」  —— 整张照片的去模糊/降噪/纹理恢复（photo-repair）
 *   「人像超清修复」—— 人脸专项增强（portrait-repair），五官/发丝/皮肤/唇齿/轮廓
 *
 * 两个模块各自维护自己的图片列表与参数，切页签不丢状态。
 * ========================================================================== */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import PhotoRepair from './photo-repair/PhotoRepair.vue'
import PortraitRepair from './portrait-repair/PortraitRepair.vue'

type TabKey = 'general' | 'portrait'

const tab = ref<TabKey>('general')

/** 菜单命令经 CustomEvent 切换页签（与命令总线解耦） */
function onSwitchPortrait(): void {
  tab.value = 'portrait'
}
function onSwitchGeneral(): void {
  tab.value = 'general'
}

onMounted(() => {
  window.addEventListener('wb:portrait', onSwitchPortrait)
  window.addEventListener('wb:general', onSwitchGeneral)
})
onBeforeUnmount(() => {
  window.removeEventListener('wb:portrait', onSwitchPortrait)
  window.removeEventListener('wb:general', onSwitchGeneral)
})
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <!-- 页签栏 -->
    <div
      class="flex items-center gap-1 px-3 pt-2 border-b border-slate-200 dark:border-slate-700 shrink-0"
    >
      <button
        class="px-3 py-1.5 rounded-t-md text-xs font-medium border-b-2 transition-colors"
        :class="
          tab === 'general'
            ? 'border-sky-500 text-sky-600 dark:text-sky-400'
            : 'border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
        "
        @click="tab = 'general'"
      >
        {{ t('portrait.tabGeneral') }}
      </button>
      <button
        class="px-3 py-1.5 rounded-t-md text-xs font-medium border-b-2 transition-colors"
        :class="
          tab === 'portrait'
            ? 'border-sky-500 text-sky-600 dark:text-sky-400'
            : 'border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
        "
        @click="tab = 'portrait'"
      >
        {{ t('portrait.tabPortrait') }}
      </button>
    </div>

    <!-- 业务组件（v-show 保留各自状态） -->
    <div class="flex-1 min-h-0">
      <div v-show="tab === 'general'" class="h-full">
        <PhotoRepair />
      </div>
      <div v-show="tab === 'portrait'" class="h-full">
        <PortraitRepair />
      </div>
    </div>
  </div>
</template>
