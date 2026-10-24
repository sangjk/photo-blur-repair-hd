<script setup lang="ts">
/* =============================================================================
 * PortraitRepair.vue —— 人像超清修复：客户区业务组件
 *
 * 定位：针对模糊人像 / 低清人像 / 老照片人像 / 压缩人像做人脸专项增强，
 *       输出高清 / 超清 / 4K / 5K 清晰人像。
 *
 * 与「通用照片修复」并列为独立页签（见 RepairWorkbench.vue）。
 * 处理管线（全部在本地纯 TS 完成，不上传任何图片）：
 *   原图 → 全局增强 → 超分到输出档位 → 人脸区域专项增强 → 质量检测（异常自动降强度重试）
 *
 * 付费：与通用修复共用免费额度（3 张），超出由 App.vue 唤起收银台解锁。
 * ========================================================================== */
import { ref, reactive, computed, onMounted, onBeforeUnmount, inject, type Ref } from 'vue'
import { t } from '../../i18n'
import { saveBinaryFileTo, saveDialog, isTauri } from '../../tauri'
import { computeOutputSize, flattenOnWhite, unsharp, type ImageBuffer } from '../photo-repair/engine'
import {
  detectFaces,
  enhancePortraitGlobal,
  enhanceFaceRegions,
  assessQuality,
  degradeStrength,
  portraitClarityScore,
  PORTRAIT_OUTPUTS,
  type FaceBox,
  type PortraitOptions,
  type PortraitStrength,
  type SkinTexture,
  type PortraitOutput,
  type QualityReport,
} from './portraitEngine'

type ItemStatus = 'pending' | 'processing' | 'done' | 'failed'

interface ImgItem {
  id: number
  name: string
  sizeLabel: string
  width: number
  height: number
  orig: ImageBuffer
  thumbUrl: string
  origUrl: string
  /** 原图分辨率下的人脸框 */
  faces: FaceBox[]
  clarityBefore: number
  clarityAfter: number
  status: ItemStatus
  enhancedUrl: string
  enhancedBlob: Blob | null
  errorMsg: string
  report: QualityReport | null
}

/** 清晰度评分的统一参考分辨率：原图与结果都缩到该尺寸再比，避免分辨率不同导致失真 */
const CLARITY_REF_EDGE = 1024

const items = ref<ImgItem[]>([])
let nextId = 1

/** 用户可调项（简单三项 + 导出格式） */
const options = reactive({
  strength: 'ultra' as PortraitStrength,
  skin: 'keep' as SkinTexture,
  output: 'uhd' as PortraitOutput,
  format: 'image/jpeg',
  quality: 0.95,
})

const selectedId = ref<number | null>(null)
const processing = ref(false)
const progress = reactive({ cur: 0, total: 0 })
const exportMsg = ref('')
const exportedCount = ref(0)
const comparePos = ref(50)
const compareOn = ref(true)
const zoom = ref(1)
const dragOver = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const unlocked = inject<Ref<boolean>>('unlocked')
const openPay = inject<() => void>('openPay')

const selected = computed<ImgItem | null>(
  () => items.value.find((i) => i.id === selectedId.value) ?? null,
)
/** 选中项的质量检测报告（模板里用 v-if 收窄，避免可选链的类型收窄问题） */
const selReport = computed<QualityReport | null>(() => selected.value?.report ?? null)
const canExportFree = computed(() => (unlocked?.value ?? false) || exportedCount.value < 3)

const strengthOptions = computed(() =>
  (['natural', 'ultra', 'extreme'] as PortraitStrength[]).map((k) => ({
    key: k,
    label: t(`portrait.strength.${k}`),
  })),
)
const skinOptions = computed(() =>
  (['keep', 'balanced', 'smooth'] as SkinTexture[]).map((k) => ({
    key: k,
    label: t(`portrait.skin.${k}`),
  })),
)
const outputOptions = computed(() =>
  PORTRAIT_OUTPUTS.map((p) => ({ key: p.key, longEdge: p.longEdge, label: t(`portrait.output.${p.key}`) })),
)
const targetLongEdge = computed(
  () => PORTRAIT_OUTPUTS.find((p) => p.key === options.output)?.longEdge ?? 2560,
)

const statusText = (s: ItemStatus): string =>
  ({
    pending: t('portrait.statusPending'),
    processing: t('portrait.statusProcessing'),
    done: t('portrait.statusDone'),
    failed: t('portrait.statusFailed'),
  })[s]

/** 质量检测结论 → i18n 文案 */
function issueText(issue: string): string {
  if (issue === 'halo') return t('portrait.issueHalo')
  if (issue === 'plastic') return t('portrait.issuePlastic')
  if (issue === 'ghost') return t('portrait.issueGhost')
  return t('portrait.issueLowGain')
}

function zoomIn(): void {
  zoom.value = Math.min(5, Math.round((zoom.value + 0.2) * 10) / 10)
}
function zoomOut(): void {
  zoom.value = Math.max(0.2, Math.round((zoom.value - 0.2) * 10) / 10)
}
function zoomReset(): void {
  zoom.value = 1
}
function onWheel(e: WheelEvent): void {
  e.preventDefault()
  if (e.deltaY < 0) zoomIn()
  else zoomOut()
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/* ============================================================================
 * 图像工具（canvas 高质量重采样 / 统一分辨率清晰度评分）
 * ========================================================================== */

/** canvas 高质量放大（双三次内核由浏览器实现，速度快且质量高） */
function upscaleTo(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  ow: number,
  oh: number,
): Uint8ClampedArray {
  const src = document.createElement('canvas')
  src.width = w
  src.height = h
  const sctx = src.getContext('2d')
  if (!sctx) return data
  sctx.putImageData(new ImageData(flattenOnWhite(data), w, h), 0, 0)
  const dst = document.createElement('canvas')
  dst.width = ow
  dst.height = oh
  const dctx = dst.getContext('2d')
  if (!dctx) return data
  dctx.fillStyle = '#ffffff'
  dctx.fillRect(0, 0, ow, oh)
  dctx.imageSmoothingEnabled = true
  dctx.imageSmoothingQuality = 'high'
  dctx.drawImage(src, 0, 0, ow, oh)
  return dctx.getImageData(0, 0, ow, oh).data
}

/**
 * 在统一参考分辨率下计算清晰度（原图与结果同尺度，数字可直接对比）。
 * 以人脸区域为主指标（人像模块关心的是"脸清不清楚"）。
 */
function clarityAtRef(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  if (!w || !h) return 0
  const scale = CLARITY_REF_EDGE / Math.max(w, h)
  const rw = Math.max(1, Math.round(w * scale))
  const rh = Math.max(1, Math.round(h * scale))
  // 人脸框同步缩放到参考分辨率
  const refFaces: FaceBox[] = faces.map((f) => ({
    x: f.x * scale,
    y: f.y * scale,
    w: f.w * scale,
    h: f.h * scale,
  }))
  if (rw === w && rh === h) return portraitClarityScore(data, w, h, refFaces)
  const src = document.createElement('canvas')
  src.width = w
  src.height = h
  const sctx = src.getContext('2d')
  if (!sctx) return portraitClarityScore(data, w, h, refFaces)
  sctx.putImageData(new ImageData(flattenOnWhite(data), w, h), 0, 0)
  const dst = document.createElement('canvas')
  dst.width = rw
  dst.height = rh
  const dctx = dst.getContext('2d')
  if (!dctx) return portraitClarityScore(data, w, h, refFaces)
  dctx.imageSmoothingEnabled = true
  dctx.imageSmoothingQuality = 'high'
  dctx.drawImage(src, 0, 0, rw, rh)
  const id = dctx.getImageData(0, 0, rw, rh)
  return portraitClarityScore(id.data, rw, rh, refFaces)
}

/* ============================================================================
 * 文件导入
 * ========================================================================== */

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

      // 缩略图（列表用）
      const scale = Math.min(1, 320 / w)
      const tw = Math.max(1, Math.round(w * scale))
      const th = Math.max(1, Math.round(h * scale))
      const tcanvas = document.createElement('canvas')
      tcanvas.width = tw
      tcanvas.height = th
      const tctx = tcanvas.getContext('2d')
      if (!tctx) continue
      tctx.drawImage(bitmap, 0, 0, tw, th)
      const thumbUrl = tcanvas.toDataURL('image/png')

      // 全分辨率原图预览（长边限 4096，透明 PNG 填白底防黑块）
      const oScale = Math.min(1, 4096 / Math.max(w, h))
      const ow = Math.max(1, Math.round(w * oScale))
      const oh = Math.max(1, Math.round(h * oScale))
      const ocanvas = document.createElement('canvas')
      ocanvas.width = ow
      ocanvas.height = oh
      const octx = ocanvas.getContext('2d')
      let origUrl = thumbUrl
      if (octx) {
        octx.fillStyle = '#ffffff'
        octx.fillRect(0, 0, ow, oh)
        octx.drawImage(bitmap, 0, 0, ow, oh)
        origUrl = ocanvas.toDataURL('image/jpeg', 0.95)
      }

      // 人脸检测（导入即检测，列表里直接显示人脸数量）
      const faces = detectFaces(imageData.data, w, h)

      items.value.push({
        id: nextId++,
        name: file.name,
        sizeLabel: formatBytes(file.size),
        width: w,
        height: h,
        orig: { data: imageData.data, width: w, height: h },
        thumbUrl,
        origUrl,
        faces,
        clarityBefore: 0,
        clarityAfter: 0,
        status: 'pending',
        enhancedUrl: '',
        enhancedBlob: null,
        errorMsg: '',
        report: null,
      })
    } catch (e) {
      console.warn('[PortraitRepair] load failed:', file.name, e)
    }
  }
  if (selectedId.value === null && items.value.length) selectedId.value = items.value[0].id
}

/* ============================================================================
 * 核心处理管线
 * ========================================================================== */

async function processItem(item: ImgItem): Promise<void> {
  item.status = 'processing'
  await new Promise((r) => setTimeout(r, 0))
  try {
    const w = item.orig.width
    const h = item.orig.height
    const opts: PortraitOptions = {
      strength: options.strength,
      skin: options.skin,
      targetLongEdge: targetLongEdge.value,
      format: options.format,
      quality: options.quality,
    }

    // ① 全局增强（降噪 + 去模糊锐化 + 纹理），在原分辨率上做，细节最足
    const base = enhancePortraitGlobal(item.orig.data, w, h, opts)

    // ② 输出尺寸：只放大不缩小（原图更大时保持原分辨率）
    const [ow, oh] = computeOutputSize(w, h, opts.targetLongEdge)

    // ③ 超分到输出档位
    let upData = base
    if (ow !== w || oh !== h) {
      upData = upscaleTo(base, w, h, ow, oh)
      // 插值会轻微软化 → 轻锐化补回（半径 1，力度温和，不出白边）
      upData = unsharp(upData, ow, oh, 22, 1, 3)
    }

    // ④ 人脸框映射到输出分辨率
    const fx = ow / w
    const fy = oh / h
    const facesOut: FaceBox[] = item.faces.map((f) => ({
      x: f.x * fx,
      y: f.y * fy,
      w: f.w * fx,
      h: f.h * fy,
    }))

    // ⑤ 人脸区域专项增强（局部超分 + 眼睛 + 皮肤 + 发丝 + 唇齿 + 轮廓）
    let enhanced = enhanceFaceRegions(upData, ow, oh, facesOut, opts)

    // ⑥ 清晰度对比：以**人脸区域**为主指标（统一参考分辨率，原图 ↔ 结果 直接可比）
    const clarityBefore = clarityAtRef(item.orig.data, w, h, item.faces)
    let clarityAfter = clarityAtRef(enhanced, ow, oh, facesOut)

    // ⑦ 质量检测；出现假面 / 塑料感 / 重影 → 自动降强度重试一次
    let report = assessQuality(upData, enhanced, ow, oh, facesOut, clarityBefore, clarityAfter)
    const defectCount = (r: QualityReport): number =>
      r.issues.filter((i) => i === 'halo' || i === 'plastic' || i === 'ghost').length
    if (defectCount(report) > 0) {
      const weaker: PortraitOptions = {
        ...opts,
        strength: degradeStrength(opts.strength),
        skin: 'keep',
      }
      const retry = enhanceFaceRegions(upData, ow, oh, facesOut, weaker)
      const retryClarity = clarityAtRef(retry, ow, oh, facesOut)
      const retryReport = assessQuality(upData, retry, ow, oh, facesOut, clarityBefore, retryClarity)
      // 只有重试后缺陷更少（或持平但更清晰）才采用重试结果
      if (
        defectCount(retryReport) < defectCount(report) ||
        (defectCount(retryReport) === defectCount(report) && retryClarity >= clarityAfter)
      ) {
        enhanced = retry
        clarityAfter = retryClarity
        report = retryReport
      }
      report.degraded = true
    }

    item.clarityBefore = clarityBefore
    item.clarityAfter = clarityAfter
    item.report = report

    // ⑧ 输出画布（1:1 逐像素写出，不做二次重采样）
    const out = document.createElement('canvas')
    out.width = ow
    out.height = oh
    const octx = out.getContext('2d')
    if (!octx) throw new Error('no ctx')
    octx.putImageData(new ImageData(flattenOnWhite(enhanced), ow, oh), 0, 0)

    const blob = await new Promise<Blob | null>((res) =>
      out.toBlob((b) => res(b), opts.format, opts.quality),
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
    exportMsg.value = t('portrait.noSelect')
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
    exportMsg.value = t('portrait.allDone')
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
  exportMsg.value = t('portrait.allDone')
}

/* ============================================================================
 * 导出（可选保存位置）
 * ========================================================================== */

function fileNameFor(item: ImgItem): string {
  const base = item.name.replace(/\.[^.]+$/, '')
  const ext = options.format === 'image/png' ? 'png' : options.format === 'image/webp' ? 'webp' : 'jpg'
  return `${base}_portrait_${options.output}.${ext}`
}

async function blobToBase64(blob: Blob): Promise<string> {
  const arr = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin)
}

async function exportOne(item: ImgItem, targetPath?: string): Promise<boolean> {
  if (!item.enhancedBlob) await processItem(item)
  if (!item.enhancedBlob) {
    exportMsg.value = t('portrait.exportFail', { msg: item.errorMsg || 'no blob' })
    return false
  }
  if (!(unlocked?.value ?? false) && exportedCount.value >= 3) {
    exportMsg.value = t('portrait.freeReached')
    openPay?.()
    return false
  }
  exportMsg.value = t('portrait.exporting')
  const name = fileNameFor(item)
  try {
    if (isTauri()) {
      const ext =
        options.format === 'image/png' ? 'png' : options.format === 'image/webp' ? 'webp' : 'jpg'
      let chosen: string | null = targetPath ?? null
      if (!chosen) {
        chosen = await saveDialog(name, [{ name: t('portrait.imgFilter'), extensions: [ext] }])
        if (!chosen) {
          exportMsg.value = t('portrait.exportCancel')
          return false
        }
      }
      const b64 = await blobToBase64(item.enhancedBlob)
      const path = await saveBinaryFileTo(chosen, b64)
      if (!path) throw new Error('save failed')
      exportMsg.value = t('portrait.exportOkPath', { path })
    } else {
      const url = URL.createObjectURL(item.enhancedBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      exportMsg.value = t('portrait.exportOkPath', { path: name })
    }
    exportedCount.value++
    return true
  } catch (e) {
    exportMsg.value = t('portrait.exportFail', { msg: e instanceof Error ? e.message : String(e) })
    return false
  }
}

async function exportSelected(): Promise<void> {
  const sel = selected.value
  if (!sel) {
    exportMsg.value = t('portrait.noSelect')
    return
  }
  await exportOne(sel)
}

async function exportAll(): Promise<void> {
  const done = items.value.filter((i) => i.status === 'done')
  if (!done.length) {
    exportMsg.value = t('portrait.allDone')
    return
  }
  // 批量导出：仅弹一次对话框选择输出目录，全部文件写入该目录
  let baseDir: string | null = null
  if (isTauri()) {
    const probe = await saveDialog(fileNameFor(done[0]), [
      { name: t('portrait.imgFilter'), extensions: ['jpg', 'png', 'webp'] },
    ])
    if (!probe) {
      exportMsg.value = t('portrait.exportCancel')
      return
    }
    baseDir = probe.replace(/[\\/][^\\/]*$/, '')
  }
  let ok = 0
  for (const it of done) {
    if (!(unlocked?.value ?? false) && exportedCount.value >= 3) {
      exportMsg.value = t('portrait.freeReached')
      openPay?.()
      break
    }
    const target = baseDir ? `${baseDir}/${fileNameFor(it)}` : undefined
    if (await exportOne(it, target)) ok++
  }
  exportMsg.value = t('portrait.exportOk', { n: ok })
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
  exportMsg.value = ''
}

/* ============================================================================
 * 菜单命令桥接（app.commands.ts 经 CustomEvent 转发）
 * ========================================================================== */
function onPtOpen(): void {
  fileInput.value?.click()
}
function onPtProcess(): void {
  void processAll()
}
function onPtExport(): void {
  void exportAll()
}
onMounted(() => {
  window.addEventListener('pt:open', onPtOpen)
  window.addEventListener('pt:process', onPtProcess)
  window.addEventListener('pt:export', onPtExport)
})
onBeforeUnmount(() => {
  window.removeEventListener('pt:open', onPtOpen)
  window.removeEventListener('pt:process', onPtProcess)
  window.removeEventListener('pt:export', onPtExport)
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

    <!-- 标题区 -->
    <div class="px-4 pt-3 pb-2 border-b border-slate-200 dark:border-slate-700">
      <h1 class="text-[15px] font-semibold leading-tight">{{ t('portrait.title') }}</h1>
      <p class="text-[11px] text-slate-400 mt-0.5">{{ t('portrait.subtitle') }}</p>
    </div>

    <!-- 工具栏 -->
    <div class="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700">
      <button
        class="px-3 py-1.5 rounded-md bg-sky-500 hover:bg-sky-600 text-white text-xs font-medium"
        @click="onPtOpen"
      >
        {{ t('portrait.upload') }}
      </button>
      <button
        class="px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-medium disabled:opacity-40"
        :disabled="processing"
        @click="processSelected"
      >
        {{ t('portrait.process') }}
      </button>
      <button
        class="px-3 py-1.5 rounded-md text-xs font-medium border transition-colors"
        :class="
          compareOn
            ? 'bg-slate-700 text-white border-slate-700 dark:bg-slate-600 dark:border-slate-600'
            : 'bg-slate-200 hover:bg-slate-300 text-slate-600 border-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:border-slate-600'
        "
        @click="compareOn = !compareOn"
      >
        {{ t('portrait.compare') }}
      </button>
      <button
        class="px-3 py-1.5 rounded-md bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-medium disabled:opacity-40"
        :disabled="processing"
        @click="exportSelected"
      >
        {{ t('portrait.export') }}
      </button>
      <button
        class="px-2 py-1.5 rounded-md bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-[11px] disabled:opacity-40"
        :disabled="processing"
        @click="processAll"
      >
        {{ t('portrait.processAll') }}
      </button>
      <button
        class="px-2 py-1.5 rounded-md bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-[11px] disabled:opacity-40"
        :disabled="processing"
        @click="exportAll"
      >
        {{ t('portrait.exportAll') }}
      </button>
      <button
        class="px-2 py-1.5 rounded-md bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-[11px]"
        @click="clearAll"
      >
        {{ t('portrait.clear') }}
      </button>
      <div class="ml-auto text-[11px] text-slate-400">
        <span v-if="canExportFree">{{ t('portrait.freeUsed', { used: exportedCount }) }}</span>
        <span v-else class="text-amber-500">{{ t('portrait.freeReached') }}</span>
      </div>
    </div>

    <div class="flex-1 flex min-h-0">
      <!-- 文件列表 -->
      <div class="w-56 shrink-0 border-r border-slate-200 dark:border-slate-700 flex flex-col">
        <div class="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400">
          {{ t('portrait.fileList') }}
        </div>
        <div
          class="mx-2 mb-2 px-2 py-3 rounded-md border border-dashed border-slate-300 dark:border-slate-600 text-center text-[11px] text-slate-400 cursor-pointer hover:border-sky-400"
          :class="{ 'border-sky-400 bg-sky-50 dark:bg-sky-900/20': dragOver }"
          @click="onPtOpen"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          {{ t('portrait.dropHint') }}
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
              <div class="text-[10px] text-slate-400">{{ it.width }}×{{ it.height }}</div>
              <div class="text-[10px]" :class="it.faces.length ? 'text-violet-500' : 'text-slate-400'">
                {{
                  it.faces.length
                    ? t('portrait.facesFound', { n: it.faces.length })
                    : t('portrait.facesNone')
                }}
              </div>
              <div v-if="it.status === 'done'" class="text-[10px] text-emerald-500">
                {{ it.clarityBefore }} → {{ it.clarityAfter }}
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
              {{ t('portrait.remove') }}
            </button>
          </div>
          <div v-if="!items.length" class="text-[11px] text-slate-400 text-center py-6">
            {{ t('portrait.empty') }}
          </div>
        </div>
      </div>

      <!-- 预览区 -->
      <div class="flex-1 p-3 flex flex-col min-h-0">
        <div
          class="relative w-full flex-1 bg-slate-100 dark:bg-slate-800 rounded-md overflow-hidden flex items-center justify-center"
          @wheel.prevent="onWheel"
        >
          <template v-if="selected">
            <div class="preview-stage" :style="{ transform: `scale(${zoom})` }">
              <img v-if="selected.origUrl" :src="selected.origUrl" class="preview-img" />
              <img
                v-if="selected.enhancedUrl && compareOn"
                :src="selected.enhancedUrl"
                class="preview-img"
                :style="{ clipPath: `inset(0 ${100 - comparePos}% 0 0)` }"
              />
            </div>
            <div
              v-if="compareOn"
              class="absolute bottom-2 left-2 text-[11px] px-2 py-0.5 rounded bg-black/55 text-white"
            >
              {{ t('portrait.previewNew') }}
            </div>
            <div
              v-if="compareOn"
              class="absolute bottom-2 right-2 text-[11px] px-2 py-0.5 rounded bg-black/55 text-white"
            >
              {{ t('portrait.previewOrig') }}
            </div>
            <div
              v-else
              class="absolute bottom-2 left-2 text-[11px] px-2 py-0.5 rounded bg-black/55 text-white"
            >
              {{ selected.enhancedUrl ? t('portrait.previewNew') : t('portrait.previewOrig') }}
            </div>
          </template>
          <div v-else class="text-[12px] text-slate-400">{{ t('portrait.empty') }}</div>
        </div>

        <div v-if="selected" class="flex items-center gap-2 mt-2">
          <button
            class="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-[13px] leading-none"
            :title="t('portrait.zoomOut')"
            @click="zoomOut"
          >
            −
          </button>
          <span class="text-[11px] w-12 text-center tabular-nums">{{ Math.round(zoom * 100) }}%</span>
          <button
            class="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-[13px] leading-none"
            :title="t('portrait.zoomIn')"
            @click="zoomIn"
          >
            +
          </button>
          <button
            class="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-[11px]"
            @click="zoomReset"
          >
            {{ t('portrait.fit') }}
          </button>
          <span class="text-[10px] text-slate-400 ml-1">{{ t('portrait.zoomHint') }}</span>
        </div>

        <input
          v-if="selected && compareOn && selected.enhancedUrl"
          type="range"
          min="0"
          max="100"
          v-model.number="comparePos"
          class="w-full mt-2"
        />
        <div v-if="processing" class="text-[11px] text-sky-500 mt-1">
          {{ t('portrait.processing', { cur: progress.cur, total: progress.total }) }}
        </div>
        <div v-if="exportMsg" class="text-[11px] text-slate-500 mt-1">{{ exportMsg }}</div>
      </div>

      <!-- 参数面板 -->
      <div class="w-64 shrink-0 border-l border-slate-200 dark:border-slate-700 p-3 overflow-y-auto space-y-3">
        <!-- 清晰强度 -->
        <div>
          <div class="text-[11px] font-medium mb-1">{{ t('portrait.strength') }}</div>
          <div class="flex rounded-md overflow-hidden border border-slate-300 dark:border-slate-600">
            <button
              v-for="s in strengthOptions"
              :key="s.key"
              class="flex-1 px-1 py-1 text-[10px] leading-tight"
              :class="
                options.strength === s.key
                  ? 'bg-sky-500 text-white'
                  : 'bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'
              "
              @click="options.strength = s.key"
            >
              {{ s.label }}
            </button>
          </div>
          <div class="text-[10px] text-slate-400 mt-1">{{ t('portrait.strengthNote') }}</div>
        </div>

        <!-- 皮肤质感 -->
        <div>
          <div class="text-[11px] font-medium mb-1">{{ t('portrait.skin') }}</div>
          <div class="flex rounded-md overflow-hidden border border-slate-300 dark:border-slate-600">
            <button
              v-for="s in skinOptions"
              :key="s.key"
              class="flex-1 px-1 py-1 text-[10px] leading-tight"
              :class="
                options.skin === s.key
                  ? 'bg-violet-500 text-white'
                  : 'bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'
              "
              @click="options.skin = s.key"
            >
              {{ s.label }}
            </button>
          </div>
          <div class="text-[10px] text-slate-400 mt-1">{{ t('portrait.skinNote') }}</div>
        </div>

        <!-- 输出档位 -->
        <div>
          <div class="text-[11px] font-medium mb-1">{{ t('portrait.output') }}</div>
          <div class="flex rounded-md overflow-hidden border border-slate-300 dark:border-slate-600">
            <button
              v-for="o in outputOptions"
              :key="o.key"
              class="flex-1 px-1 py-1 text-[10px] leading-tight"
              :class="
                options.output === o.key
                  ? 'bg-emerald-500 text-white'
                  : 'bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'
              "
              @click="options.output = o.key"
            >
              {{ o.label }}
            </button>
          </div>
          <div class="text-[10px] text-slate-400 mt-1">{{ t('portrait.outputNote') }}</div>
        </div>

        <!-- 格式 / 质量 -->
        <div>
          <div class="text-[11px] text-slate-400 mb-1">{{ t('portrait.format') }}</div>
          <select
            v-model="options.format"
            class="w-full text-[12px] rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-1 py-1"
          >
            <option value="image/jpeg">JPG</option>
            <option value="image/png">PNG</option>
            <option value="image/webp">WEBP</option>
          </select>
          <div class="text-[11px] text-slate-400 mt-2 mb-1">
            {{ t('portrait.qualityLabel') }} {{ Math.round(options.quality * 100) }}%
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

        <!-- 质量检测结果 -->
        <div v-if="selReport" class="rounded-md border border-slate-200 dark:border-slate-700 p-2">
          <div class="text-[11px] font-medium mb-1">{{ t('portrait.quality') }}</div>
          <div class="text-[10px] text-slate-500">
            {{ t('portrait.clarityBefore', { n: selReport.clarityBefore }) }} →
            <span class="text-emerald-500">{{ t('portrait.clarityAfter', { n: selReport.clarityAfter }) }}</span>
          </div>
          <div v-if="selReport.issues.length" class="mt-1 space-y-0.5">
            <div
              v-for="iss in selReport.issues"
              :key="iss"
              class="text-[10px]"
              :class="iss === 'lowGain' ? 'text-slate-400' : 'text-amber-500'"
            >
              {{ issueText(iss) }}
            </div>
          </div>
          <div v-else class="text-[10px] text-emerald-500 mt-1">{{ t('portrait.qualityOk') }}</div>
          <div v-if="selReport.degraded" class="text-[10px] text-sky-500 mt-1">
            {{ t('portrait.retryApplied') }}
          </div>
        </div>

        <!-- 限制说明 -->
        <div class="text-[10px] text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded p-2 leading-relaxed">
          {{ t('portrait.limitHint') }}
        </div>

        <div v-if="!canExportFree" class="text-[11px] text-amber-500 bg-amber-50 dark:bg-amber-900/20 rounded p-2">
          {{ t('portrait.unlockHint') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 预览舞台：整块缩放，原图/修复后两层叠合，缩放时始终居中 */
.preview-stage {
  position: relative;
  width: 100%;
  height: 100%;
  transform-origin: center center;
}
.preview-img {
  position: absolute;
  inset: 0;
  margin: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}
</style>
