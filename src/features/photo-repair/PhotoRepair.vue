<script setup lang="ts">
/* =============================================================================
 * PhotoRepair.vue —— 照片模糊修复高清：客户区业务组件
 * 拖拽/选择图片 → 参数化增强（去模糊/降噪/增强/纹理） → 前后对比预览 → 单张/批量导出。
 * 付费：功能限制模式（TASK.md 第 7/8 项）—— 免费导出 3 张，超出由 App.vue 唤起收银台解锁。
 * 解锁态与唤起支付通过 provide/inject 从 App.vue 获取（不修改框架核心）。
 * ========================================================================== */
import { ref, reactive, computed, onMounted, onBeforeUnmount, inject, type Ref } from 'vue'
import { t } from '../../i18n'
import { saveBinaryFile, isTauri } from '../../tauri'
import {
  enhanceImage,
  computeOutputSize,
  clarityScore,
  unsharp,
  RES_PRESETS,
  FORMATS,
  type EnhanceOptions,
  type ImageBuffer,
} from './engine'

type ItemStatus = 'pending' | 'processing' | 'done' | 'failed'

interface ImgItem {
  id: number
  name: string
  sizeLabel: string
  width: number
  height: number
  orig: ImageBuffer
  thumbUrl: string
  blur: number
  status: ItemStatus
  enhancedUrl: string
  enhancedBlob: Blob | null
  errorMsg: string
}

const items = ref<ImgItem[]>([])
let nextId = 1

const options = reactive<EnhanceOptions>({
  denoise: true,
  denoiseStrength: 45,
  deblur: true,
  deblurAmount: 55,
  enhance: true,
  enhanceAmount: 50,
  texture: true,
  textureAmount: 40,
  targetLongEdge: 1920,
  format: 'image/jpeg',
  quality: 0.92,
})

const selectedId = ref<number | null>(null)
const processing = ref(false)
const progress = reactive({ cur: 0, total: 0 })
const exportMsg = ref('')
const exportedCount = ref(0)
const comparePos = ref(50)
const dragOver = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const unlocked = inject<Ref<boolean>>('unlocked')
const openPay = inject<() => void>('openPay')

const selected = computed<ImgItem | null>(
  () => items.value.find((i) => i.id === selectedId.value) ?? null,
)
const canExportFree = computed(() => (unlocked?.value ?? false) || exportedCount.value < 3)
const resOptions = computed(() => RES_PRESETS.map((p) => ({ ...p, label: t(p.key) })))
const statusText = (s: ItemStatus): string =>
  ({
    pending: t('repair.statusPending'),
    processing: t('repair.statusProcessing'),
    done: t('repair.statusDone'),
    failed: t('repair.statusFailed'),
  })[s]

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

async function handleFiles(fileList: FileList | File[]): Promise<void> {
  const files = Array.from(fileList)
  for (const file of files) {
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(file.type)) continue
    try {
      const buf = await file.arrayBuffer()
      const bitmap = await createImageBitmap(new Blob([buf]))
      const w = bitmap.width
      const h = bitmap.height
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.drawImage(bitmap, 0, 0)
      const imageData = ctx.getImageData(0, 0, w, h)
      const blur = clarityScore(imageData.data, w, h)
      const scale = Math.min(1, 320 / w)
      const tw = Math.round(w * scale)
      const th = Math.max(1, Math.round(h * scale))
      const tcanvas = document.createElement('canvas')
      tcanvas.width = tw
      tcanvas.height = th
      const tctx = tcanvas.getContext('2d')
      if (!tctx) continue
      tctx.drawImage(bitmap, 0, 0, tw, th)
      const thumbUrl = tcanvas.toDataURL('image/png')
      items.value.push({
        id: nextId++,
        name: file.name,
        sizeLabel: formatBytes(file.size),
        width: w,
        height: h,
        orig: { data: imageData.data, width: w, height: h },
        thumbUrl,
        blur,
        status: 'pending',
        enhancedUrl: '',
        enhancedBlob: null,
        errorMsg: '',
      })
    } catch (e) {
      console.warn('[PhotoRepair] load failed:', file.name, e)
    }
  }
  if (selectedId.value === null && items.value.length) selectedId.value = items.value[0].id
}

async function processItem(item: ImgItem): Promise<void> {
  item.status = 'processing'
  await new Promise((r) => setTimeout(r, 0))
  try {
    const enhanced = enhanceImage(item.orig.data, item.orig.width, item.orig.height, { ...options })
    const [ow, oh] = computeOutputSize(item.orig.width, item.orig.height, options.targetLongEdge)
    const tmp = document.createElement('canvas')
    tmp.width = item.orig.width
    tmp.height = item.orig.height
    const tctx = tmp.getContext('2d')
    if (!tctx) throw new Error('no ctx')
    tctx.putImageData(new ImageData(enhanced, item.orig.width, item.orig.height), 0, 0)
    const out = document.createElement('canvas')
    out.width = ow
    out.height = oh
    const octx = out.getContext('2d')
    if (!octx) throw new Error('no ctx')
    octx.imageSmoothingEnabled = true
    octx.imageSmoothingQuality = 'high'
    octx.drawImage(tmp, 0, 0, ow, oh)
    // 放大后轻锐化，恢复清晰度（仅长边大于原图时）
    if (ow > item.orig.width) {
      const outData = octx.getImageData(0, 0, ow, oh)
      const sharp = unsharp(outData.data, ow, oh, 25, 1, 2)
      octx.putImageData(new ImageData(sharp, ow, oh), 0, 0)
    }
    const blob = await new Promise<Blob | null>((res) =>
      out.toBlob((b) => res(b), options.format, options.quality),
    )
    if (!blob) throw new Error('toBlob failed')
    if (item.enhancedUrl.startsWith('blob:')) URL.revokeObjectURL(item.enhancedUrl)
    item.enhancedBlob = blob
    item.enhancedUrl = URL.createObjectURL(blob)
    item.status = 'done'
  } catch (e) {
    item.status = 'failed'
    item.errorMsg = e instanceof Error ? e.message : String(e)
  }
}

async function processSelected(): Promise<void> {
  if (processing.value) return
  const sel = selected.value
  if (!sel) {
    exportMsg.value = t('repair.noSelect')
    return
  }
  processing.value = true
  progress.cur = 0
  progress.total = 1
  await processItem(sel)
  processing.value = false
}

async function processAll(): Promise<void> {
  if (processing.value) return
  const pending = items.value.filter((i) => i.status !== 'done')
  if (!pending.length) {
    exportMsg.value = t('repair.allDone')
    return
  }
  processing.value = true
  progress.cur = 0
  progress.total = pending.length
  for (const it of pending) {
    await processItem(it)
    progress.cur++
    await new Promise((r) => setTimeout(r, 0))
  }
  processing.value = false
  exportMsg.value = t('repair.allDone')
}

function fileNameFor(item: ImgItem): string {
  const base = item.name.replace(/\.[^.]+$/, '')
  const ext = options.format === 'image/png' ? 'png' : options.format === 'image/webp' ? 'webp' : 'jpg'
  return `${base}_enhanced.${ext}`
}

async function blobToBase64(blob: Blob): Promise<string> {
  const arr = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin)
}

async function exportItem(item: ImgItem): Promise<boolean> {
  if (!item.enhancedBlob) await processItem(item)
  if (!item.enhancedBlob) {
    exportMsg.value = t('repair.exportFail', { msg: item.errorMsg || 'no blob' })
    return false
  }
  if (!(unlocked?.value ?? false) && exportedCount.value >= 3) {
    exportMsg.value = t('repair.freeReached')
    openPay?.()
    return false
  }
  exportMsg.value = t('repair.exporting')
  const name = fileNameFor(item)
  try {
    if (isTauri()) {
      const b64 = await blobToBase64(item.enhancedBlob)
      const path = await saveBinaryFile(name, b64)
      if (!path) throw new Error('save failed')
    } else {
      const url = URL.createObjectURL(item.enhancedBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    exportedCount.value++
    exportMsg.value = t('repair.exportOk', { n: 1 })
    return true
  } catch (e) {
    exportMsg.value = t('repair.exportFail', { msg: e instanceof Error ? e.message : String(e) })
    return false
  }
}

async function exportSelected(): Promise<void> {
  const sel = selected.value
  if (!sel) {
    exportMsg.value = t('repair.noSelect')
    return
  }
  await exportItem(sel)
}

async function exportAll(): Promise<void> {
  const done = items.value.filter((i) => i.status === 'done')
  if (!done.length) {
    exportMsg.value = t('repair.allDone')
    return
  }
  let ok = 0
  for (const it of done) {
    if (!(unlocked?.value ?? false) && exportedCount.value >= 3) {
      exportMsg.value = t('repair.freeReached')
      openPay?.()
      break
    }
    if (await exportItem(it)) ok++
  }
  exportMsg.value = t('repair.exportOk', { n: ok })
}

function removeItem(id: number): void {
  const idx = items.value.findIndex((i) => i.id === id)
  if (idx >= 0) {
    const it = items.value[idx]
    if (it.enhancedUrl.startsWith('blob:')) URL.revokeObjectURL(it.enhancedUrl)
    items.value.splice(idx, 1)
  }
  if (selectedId.value === id) selectedId.value = items.value[0]?.id ?? null
}

function clearAll(): void {
  items.value.forEach((it) => {
    if (it.enhancedUrl.startsWith('blob:')) URL.revokeObjectURL(it.enhancedUrl)
  })
  items.value = []
  selectedId.value = null
}

// 菜单命令桥接（app.commands.ts 经 CustomEvent 转发，解耦命令与 UI）
function onPrOpen(): void {
  fileInput.value?.click()
}
function onPrProcess(): void {
  void processAll()
}
function onPrExport(): void {
  void exportAll()
}
onMounted(() => {
  window.addEventListener('pr:open', onPrOpen)
  window.addEventListener('pr:process', onPrProcess)
  window.addEventListener('pr:export', onPrExport)
})
onBeforeUnmount(() => {
  window.removeEventListener('pr:open', onPrOpen)
  window.removeEventListener('pr:process', onPrProcess)
  window.removeEventListener('pr:export', onPrExport)
})

function onFileChange(e: Event): void {
  const target = e.target as HTMLInputElement
  if (target.files) void handleFiles(target.files)
  target.value = ''
}
function onDrop(e: DragEvent): void {
  dragOver.value = false
  if (e.dataTransfer?.files) void handleFiles(e.dataTransfer.files)
}
</script>

<template>
  <div class="h-full flex flex-col text-slate-700 dark:text-slate-200">
    <input
      ref="fileInput"
      type="file"
      accept="image/jpeg,image/jpg,image/png,image/webp"
      multiple
      class="hidden"
      @change="onFileChange"
    />

    <!-- 工具栏 -->
    <div class="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700">
      <button
        class="px-3 py-1.5 rounded-md bg-sky-500 hover:bg-sky-600 text-white text-xs font-medium"
        @click="onPrOpen"
      >
        {{ t('repair.addFiles') }}
      </button>
      <button
        class="px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-medium disabled:opacity-40"
        :disabled="processing"
        @click="processSelected"
      >
        {{ t('repair.processSel') }}
      </button>
      <button
        class="px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-medium disabled:opacity-40"
        :disabled="processing"
        @click="processAll"
      >
        {{ t('repair.processAll') }}
      </button>
      <button
        class="px-3 py-1.5 rounded-md bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-medium disabled:opacity-40"
        :disabled="processing"
        @click="exportSelected"
      >
        {{ t('repair.exportSel') }}
      </button>
      <button
        class="px-3 py-1.5 rounded-md bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-medium disabled:opacity-40"
        :disabled="processing"
        @click="exportAll"
      >
        {{ t('repair.exportAll') }}
      </button>
      <button
        class="px-3 py-1.5 rounded-md bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-xs"
        @click="clearAll"
      >
        {{ t('repair.clear') }}
      </button>
      <div class="ml-auto text-[11px] text-slate-400">
        <span v-if="canExportFree">{{ t('repair.freeUsed', { used: exportedCount }) }}</span>
        <span v-else class="text-amber-500">{{ t('repair.freeReached') }}</span>
      </div>
    </div>

    <div class="flex-1 flex min-h-0">
      <!-- 文件列表 -->
      <div class="w-56 shrink-0 border-r border-slate-200 dark:border-slate-700 flex flex-col">
        <div class="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400">
          {{ t('repair.fileList') }}
        </div>
        <div
          class="mx-2 mb-2 px-2 py-3 rounded-md border border-dashed border-slate-300 dark:border-slate-600 text-center text-[11px] text-slate-400 cursor-pointer hover:border-sky-400"
          :class="{ 'border-sky-400 bg-sky-50 dark:bg-sky-900/20': dragOver }"
          @click="onPrOpen"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          {{ t('repair.dropHint') }}
        </div>
        <div class="flex-1 overflow-y-auto px-2 space-y-1">
          <div
            v-for="it in items"
            :key="it.id"
            class="group flex gap-2 p-1.5 rounded-md cursor-pointer"
            :class="
              it.id === selectedId
                ? 'bg-sky-100 dark:bg-sky-900/40'
                : 'hover:bg-slate-100 dark:hover:bg-slate-800'
            "
            @click="selectedId = it.id"
          >
            <img :src="it.thumbUrl" class="w-10 h-10 rounded object-cover bg-slate-200 dark:bg-slate-700" />
            <div class="flex-1 min-w-0">
              <div class="text-[11px] truncate">{{ it.name }}</div>
              <div class="text-[10px] text-slate-400">
                {{ it.width }}×{{ it.height }} · {{ t('repair.blur') }} {{ it.blur }}
              </div>
              <div
                class="text-[10px]"
                :class="{
                  'text-amber-500': it.status === 'pending',
                  'text-sky-500': it.status === 'processing',
                  'text-emerald-500': it.status === 'done',
                  'text-rose-500': it.status === 'failed',
                }"
              >
                {{ statusText(it.status) }}
              </div>
            </div>
            <button
              class="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-500 text-[11px]"
              @click.stop="removeItem(it.id)"
            >
              {{ t('repair.remove') }}
            </button>
          </div>
          <div v-if="!items.length" class="text-[11px] text-slate-400 text-center py-6">
            {{ t('repair.empty') }}
          </div>
        </div>
      </div>

      <!-- 预览 + 参数 -->
      <div class="flex-1 flex min-h-0">
        <div class="flex-1 p-3 flex flex-col min-h-0">
          <div
            class="relative w-full flex-1 bg-slate-100 dark:bg-slate-800 rounded-md overflow-hidden flex items-center justify-center"
          >
            <template v-if="selected">
              <img :src="selected.thumbUrl" class="absolute max-w-full max-h-full object-contain" />
              <img
                v-if="selected.enhancedUrl"
                :src="selected.enhancedUrl"
                class="absolute max-w-full max-h-full object-contain"
                :style="{ clipPath: `inset(0 ${100 - comparePos}% 0 0)` }"
              />
              <div class="absolute bottom-2 left-2 text-[11px] px-2 py-0.5 rounded bg-black/55 text-white">
                {{ t('repair.previewNew') }}
              </div>
              <div class="absolute bottom-2 right-2 text-[11px] px-2 py-0.5 rounded bg-black/55 text-white">
                {{ t('repair.previewOrig') }}
              </div>
            </template>
            <div v-else class="text-[12px] text-slate-400">{{ t('repair.empty') }}</div>
          </div>
          <input
            v-if="selected"
            type="range"
            min="0"
            max="100"
            v-model.number="comparePos"
            class="w-full mt-2"
          />
          <div v-if="selected" class="text-[10px] text-slate-400 mt-1">
            {{ t('repair.preview') }}
          </div>
          <div v-if="processing" class="text-[11px] text-sky-500 mt-1">
            {{ t('repair.processing', { cur: progress.cur, total: progress.total }) }}
          </div>
          <div v-if="exportMsg" class="text-[11px] text-slate-500 mt-1">{{ exportMsg }}</div>
        </div>

        <!-- 参数面板 -->
        <div class="w-60 shrink-0 border-l border-slate-200 dark:border-slate-700 p-3 overflow-y-auto space-y-3">
          <div>
            <div class="text-[11px] font-medium mb-1">{{ t('repair.options') }}</div>
            <label class="flex items-center gap-2 text-[12px] py-0.5">
              <input type="checkbox" v-model="options.denoise" /> {{ t('repair.optDenoise') }}
            </label>
            <input
              type="range"
              min="0"
              max="100"
              v-model.number="options.denoiseStrength"
              :disabled="!options.denoise"
              class="w-full"
            />
            <label class="flex items-center gap-2 text-[12px] py-0.5">
              <input type="checkbox" v-model="options.deblur" /> {{ t('repair.optDeblur') }}
            </label>
            <input
              type="range"
              min="0"
              max="100"
              v-model.number="options.deblurAmount"
              :disabled="!options.deblur"
              class="w-full"
            />
            <label class="flex items-center gap-2 text-[12px] py-0.5">
              <input type="checkbox" v-model="options.enhance" /> {{ t('repair.optEnhance') }}
            </label>
            <input
              type="range"
              min="0"
              max="100"
              v-model.number="options.enhanceAmount"
              :disabled="!options.enhance"
              class="w-full"
            />
            <label class="flex items-center gap-2 text-[12px] py-0.5">
              <input type="checkbox" v-model="options.texture" /> {{ t('repair.optTexture') }}
            </label>
            <input
              type="range"
              min="0"
              max="100"
              v-model.number="options.textureAmount"
              :disabled="!options.texture"
              class="w-full"
            />
          </div>

          <div>
            <div class="text-[11px] font-medium mb-1">{{ t('repair.output') }}</div>
            <div class="text-[11px] text-slate-400 mb-1">{{ t('repair.resolution') }}</div>
            <select v-model.number="options.targetLongEdge" class="w-full text-[12px] rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-1 py-1">
              <option v-for="p in resOptions" :key="p.key" :value="p.longEdge">{{ p.label }}</option>
            </select>
            <div class="text-[11px] text-slate-400 mt-2 mb-1">{{ t('repair.format') }}</div>
            <select v-model="options.format" class="w-full text-[12px] rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-1 py-1">
              <option v-for="f in FORMATS" :key="f.value" :value="f.value">{{ f.label }}</option>
            </select>
            <div class="text-[11px] text-slate-400 mt-2 mb-1">
              {{ t('repair.quality') }} {{ Math.round(options.quality * 100) }}%
            </div>
            <input
              type="range"
              min="0.5"
              max="1"
              step="0.01"
              v-model.number="options.quality"
              :disabled="options.format === 'image/png'"
              class="w-full"
            />
          </div>

          <div v-if="!canExportFree" class="text-[11px] text-amber-500 bg-amber-50 dark:bg-amber-900/20 rounded p-2">
            {{ t('repair.unlockHint') }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
