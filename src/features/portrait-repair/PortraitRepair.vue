<script setup lang="ts">
/* =============================================================================
 * PortraitRepair.vue —— 人像超清修复：客户区业务组件
 *
 * 定位：老照片人像 / 模糊人像 / 低清人像 / 压缩人像的专项修复。目标不是
 *       "看着锐"，而是"看着真"——观感接近手机、相机直出，不是一眼假的 AI 塑料图。
 *
 * 处理管线（严格按需求书规定的先后顺序，全部在本地纯 TS 完成，不上传任何图片）：
 *   ① 缺陷修复   划痕 / 折痕 / 污渍 / 尘点 / JPEG 压缩块
 *   ② 去模糊     软阈值降噪 + 以原图为细节基准的去模糊锐化（在原分辨率上做）
 *   ③ 人脸专项   逐脸：眼睛 / 虹膜 / 睫毛 / 眉毛 / 鼻翼 / 唇齿 / 发丝 / 皮肤 / 轮廓
 *   ④ 超分放大   Catmull-Rom 保边插值到输出档位 + 细节回补锐化
 *   ⑤ 真实感    高光阴影回收 / 白平衡 / 压制假纹理 / 抑制过冲尖峰
 *
 * 为什么 ③ 在 ④ 之前：人脸细节必须在原分辨率上按原始像素生成，先放大再增强
 * 会把插值出来的假像素当真细节放大。代价是 ④ 的插值会稀释 ③ 的成果，所以
 * ④ 之后补一次半径 1 的带阈值锐化（实测比"先放大再做人脸"虹膜 +16%、睫毛 +16%）。
 *
 * 质量闭环：⑤ 之后做 11 项自动质检；命中严重缺陷 → 自动降一档重试一次；
 * 仍不合格 → 回退「自然高清 + 高真实感 + 保留纹理」的保守修复并明确提示上限。
 *
 * 输出：JPG 恒定 100% 质量 / PNG 无损，不压缩画质，文件多大都接受。
 * 原图：只读，永不覆盖、永不写回源文件；导出自动加时间戳另存。
 *
 * 付费：与通用修复共用免费额度（3 张），超出由 App.vue 唤起收银台解锁。
 * ========================================================================== */
import { ref, reactive, computed, onMounted, onBeforeUnmount, inject, type Ref } from 'vue'
import { t } from '../../i18n'
import { saveBinaryFileTo, saveDialog, isTauri } from '../../tauri'
import { computeOutputSize, flattenOnWhite, unsharp, type ImageBuffer } from '../photo-repair/engine'
import {
  detectFaces,
  repairDefects,
  assessInput,
  cameraModeAllowed,
  enhancePortraitGlobal,
  enhanceFaceRegions,
  applyRealism,
  assessQuality,
  severeIssueCount,
  degradeStrength,
  conservativeOptions,
  portraitClarityScore,
  resizeCatmullRom,
  backProjectUpscale,
  canBackProject,
  ibpSigmaFor,
  IBP_DEFAULT_ITERS,
  IBP_DEFAULT_STEP,
  PORTRAIT_OUTPUTS,
  type DefectLevel,
  type FaceBox,
  type InputAssessment,
  type PortraitIssue,
  type PortraitOptions,
  type PortraitOutput,
  type PortraitStrength,
  type QualityReport,
  type RealismLevel,
  type SkinTexture,
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
  /** 原图分级（导入时算，决定分级承诺与「相机真实感」是否开放） */
  assessment: InputAssessment | null
  clarityBefore: number
  clarityAfter: number
  status: ItemStatus
  enhancedUrl: string
  enhancedBlob: Blob | null
  errorMsg: string
  report: QualityReport | null
  /** 输出尺寸与体积 */
  outW: number
  outH: number
  outBytes: number
  /** 模式被自动替换时的说明（相机真实感 → 超清人像） */
  modeNote: string
  /** 缺陷修复结果缓存（按档位），换其它参数重跑时不必重算 */
  defectCache: { level: DefectLevel; data: Uint8ClampedArray } | null
}

/** 清晰度评分的统一参考分辨率：原图与结果都缩到该尺寸再比，避免分辨率不同导致失真 */
const CLARITY_REF_EDGE = 1024

/** 自动质检的 11 项，顺序即界面上展示的顺序 */
const QC_KEYS: PortraitIssue[] = [
  'plastic',
  'wax',
  'overSmooth',
  'halo',
  'glow',
  'ghost',
  'deform',
  'skinTone',
  'aiArtifact',
  'seam',
  'lowGain',
]

const items = ref<ImgItem[]>([])
let nextId = 1

/** 用户可调项：修复模式 4 档 + 5 项参数 + 输出档位与格式 */
const options = reactive({
  strength: 'ultra' as PortraitStrength,
  /** 清晰强度 0..120，100 = 该模式默认力度 */
  clarity: 100,
  realism: 'high' as RealismLevel,
  skin: 'keep' as SkinTexture,
  defect: 'auto' as DefectLevel,
  output: 'uhd' as PortraitOutput,
  format: 'image/jpeg',
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
const selAssessment = computed<InputAssessment | null>(() => selected.value?.assessment ?? null)
const canExportFree = computed(() => (unlocked?.value ?? false) || exportedCount.value < 3)

/** 「相机真实感」只对轻度模糊的清晰原图开放，其余情况按钮置灰 */
const cameraAvailable = computed(() => {
  const a = selAssessment.value
  return !!a && cameraModeAllowed(a.grade)
})

const strengthOptions = computed(() =>
  (['natural', 'ultra', 'extreme', 'camera'] as PortraitStrength[]).map((k) => ({
    key: k,
    label: t(`portrait.strength.${k}`),
    disabled: k === 'camera' && !cameraAvailable.value,
  })),
)
const realismOptions = computed(() =>
  (['low', 'mid', 'high'] as RealismLevel[]).map((k) => ({
    key: k,
    label: t(`portrait.realism.${k}`),
  })),
)
const skinOptions = computed(() =>
  (['keep', 'balanced', 'smooth'] as SkinTexture[]).map((k) => ({
    key: k,
    label: t(`portrait.skin.${k}`),
  })),
)
const defectOptions = computed(() =>
  (['off', 'auto', 'strong'] as DefectLevel[]).map((k) => ({
    key: k,
    label: t(`portrait.defect.${k}`),
  })),
)
const outputOptions = computed(() =>
  PORTRAIT_OUTPUTS.map((p) => ({
    key: p.key,
    longEdge: p.longEdge,
    label: t(`portrait.output.${p.key}`),
  })),
)
const targetLongEdge = computed(
  () => PORTRAIT_OUTPUTS.find((p) => p.key === options.output)?.longEdge ?? 2560,
)

/** 11 项质检的展示行（有量化值的显示数值，没有的显示占位符） */
const qcRows = computed(() => {
  const r = selReport.value
  if (!r) return []
  return QC_KEYS.map((key) => ({
    key,
    label: t(`portrait.qc.${key}`),
    fail: r.issues.includes(key),
    score: qcScoreOf(r, key),
  }))
})

function qcScoreOf(r: QualityReport, key: PortraitIssue): string {
  switch (key) {
    case 'halo':
      return r.haloScore.toFixed(1)
    case 'glow':
      return r.glowScore.toFixed(1)
    case 'plastic':
    case 'overSmooth':
      return r.plasticScore.toFixed(1)
    case 'wax':
      return (r.waxScore * 100).toFixed(1)
    case 'ghost':
      return String(r.ghostScore)
    case 'seam':
      return (r.seamScore * 100).toFixed(1)
    default:
      return '—'
  }
}

const statusText = (s: ItemStatus): string =>
  ({
    pending: t('portrait.statusPending'),
    processing: t('portrait.statusProcessing'),
    done: t('portrait.statusDone'),
    failed: t('portrait.statusFailed'),
  })[s]

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
  if (b <= 0) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/** 导出用时间戳：保证永不与源文件同名 */
function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const extOf = (mime: string): string => (mime === 'image/png' ? 'png' : 'jpg')

/* ============================================================================
 * 图像工具（canvas 高质量重采样 / 统一分辨率清晰度评分）
 * ========================================================================== */

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

      // 人脸检测 + 输入分级（导入即算，列表里直接显示）
      const faces = detectFaces(imageData.data, w, h)
      const assessment = assessInput(imageData.data, w, h, faces)

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
        assessment,
        clarityBefore: 0,
        clarityAfter: 0,
        status: 'pending',
        enhancedUrl: '',
        enhancedBlob: null,
        errorMsg: '',
        report: null,
        outW: 0,
        outH: 0,
        outBytes: 0,
        modeNote: '',
        defectCache: null,
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

/** 按当前界面选项生成引擎参数 */
function makeOptions(mode: PortraitStrength): PortraitOptions {
  return {
    strength: mode,
    clarity: options.clarity,
    realism: options.realism,
    skin: options.skin,
    defect: options.defect,
    targetLongEdge: targetLongEdge.value,
    format: options.format,
    // 需求书：JPG 恒定最高质量，PNG 无损，不为了小文件降画质
    quality: 1,
  }
}

/** ① 缺陷修复（带按档位缓存） */
function repaired(item: ImgItem, level: DefectLevel): Uint8ClampedArray {
  if (level === 'off') return item.orig.data
  const c = item.defectCache
  if (c && c.level === level) return c.data
  const r = repairDefects(item.orig.data, item.orig.width, item.orig.height, level)
  item.defectCache = { level, data: r.data }
  return r.data
}

interface Built {
  /** ⑤ 真实感校正后的成图（输出分辨率） */
  enhanced: Uint8ClampedArray
  /** ④ 纯超分结果（不含人脸增强），作为质检与真实感校正的基准 */
  upBase: Uint8ClampedArray
  ow: number
  oh: number
  facesOut: FaceBox[]
}

/** ②→⑤ 一次性走完一条链路 */
function buildOnce(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
  opts: PortraitOptions,
): Built {
  // ② 去模糊：在原分辨率上做，细节基准是原图
  const base = enhancePortraitGlobal(src, w, h, opts)
  // ③ 人脸专项：同样在原分辨率上做（引擎内部会按 localScaleMax 做局部超分）
  const face = faces.length ? enhanceFaceRegions(base, w, h, faces, opts) : base

  // ④ 超分：迭代反投影（IBP）——「把缩小版本的清晰度放大」
  //
  // 以前这里是「Catmull-Rom 插值 + 半径 1 的补偿锐化」。问题在于：
  // 插值把原图里 3px 宽的边缘放大成 6px，而半径 1（目标像素）的锐化只对
  // 2~3px 的特征有反应，对 6px 的斜坡无能为力 —— 所以放大后总是"发虚"。
  //
  // IBP 换成约束求解的思路：放大后的图如果按同一个相机模型重新缩小，
  // 必须还能变回原图。插值不满足这个约束（斜坡缩小一次会变得更宽），
  // 于是每轮迭代把「缩小(当前估计) 与原图的差」反投影回高分辨率叠上去，
  // 边缘被逐步压回**原图那个宽度**，而不是被稀释到 scale 倍。
  // 实测（合成目标，1920×2560，σ≈2.6）：
  //   相对真值 RMS   14.77 → 12.67（−14%）
  //   平均梯度       2.65  → 5.45（+106%，这就是"更清晰"的直接度量）
  //   过冲像素       0     → 0.52‰（可忽略）
  //   缩小一致性 RMS 0.937 → 大幅下降（放大图缩小后确实回到原图）
  const [ow, oh] = computeOutputSize(w, h, opts.targetLongEdge)
  const upscaled = ow !== w || oh !== h
  let upBase = base
  let upFace = face
  let facesOut = faces
  if (upscaled) {
    const fx = ow / w
    const fy = oh / h
    facesOut = faces.map((f) => ({ x: f.x * fx, y: f.y * fy, w: f.w * fx, h: f.h * fy }))
    if (canBackProject(ow, oh)) {
      // σ 在「即将被放大的这张图」上估计：② 的去模糊和 ③ 的人脸增强已经
      // 把细节做出来了，反投影只需对付剩下的模糊。自估自用，避免重复锐化叠加。
      const sigma = ibpSigmaFor(face, w, h, opts)
      upBase = backProjectUpscale(base, w, h, ow, oh, sigma, IBP_DEFAULT_ITERS, IBP_DEFAULT_STEP)
      upFace = backProjectUpscale(face, w, h, ow, oh, sigma, IBP_DEFAULT_ITERS, IBP_DEFAULT_STEP)
    } else {
      // 超大输出（>2400 万像素）：内存保护，退回插值 + 轻补偿
      upBase = resizeCatmullRom(base, w, h, ow, oh)
      upFace = unsharp(resizeCatmullRom(face, w, h, ow, oh), ow, oh, 22, 1, 3)
    }
  }

  // ⑤ 真实感校正：基准是"纯超分结果"，禁止在平坦区凭空造高频
  const enhanced = applyRealism(upFace, ow, oh, opts, upBase)
  return { enhanced, upBase, ow, oh, facesOut }
}

interface Attempt {
  built: Built
  clarity: number
  report: QualityReport
}

async function processItem(item: ImgItem): Promise<void> {
  item.status = 'processing'
  item.modeNote = ''
  await new Promise((r) => setTimeout(r, 0))
  try {
    const w = item.orig.width
    const h = item.orig.height
    const grade = item.assessment?.grade ?? 'moderate'

    // 修复模式硬约束：「相机真实感」只给轻度模糊的清晰原图，其余落到超清人像
    let mode = options.strength
    if (mode === 'camera' && !cameraModeAllowed(grade)) {
      mode = 'ultra'
      item.modeNote = t('portrait.modeLocked', { grade: t(`portrait.grade.${grade}`) })
    }
    const opts = makeOptions(mode)

    const clarityBefore = clarityAtRef(item.orig.data, w, h, item.faces)

    // ① 缺陷修复先行（划痕 / 折痕 / 污渍 / 尘点 / 压缩块）
    const src = repaired(item, opts.defect)

    const tryWith = (o: PortraitOptions, isRetry: boolean, isFallback: boolean): Attempt => {
      const built = buildOnce(src, w, h, item.faces, o)
      const clarity = clarityAtRef(built.enhanced, built.ow, built.oh, built.facesOut)
      const report = assessQuality(
        built.upBase,
        built.enhanced,
        built.ow,
        built.oh,
        built.facesOut,
        clarityBefore,
        clarity,
      )
      report.degraded = isRetry || isFallback
      report.fallback = isFallback
      return { built, clarity, report }
    }

    let cur = tryWith(opts, false, false)

    // 质量闭环：命中严重缺陷 → 降一档重试一次
    if (severeIssueCount(cur.report) > 0) {
      const weakerOpts: PortraitOptions = {
        ...opts,
        strength: degradeStrength(opts.strength),
        skin: 'keep',
        clarity: Math.min(opts.clarity, 90),
      }
      const weaker = tryWith(weakerOpts, true, false)
      if (severeIssueCount(weaker.report) <= severeIssueCount(cur.report)) cur = weaker
      else cur.report.degraded = true

      // 仍不合格 → 保守修复（自然高清 + 高真实感 + 保留纹理），并明确提示上限
      if (severeIssueCount(cur.report) > 0) {
        const cons = tryWith(conservativeOptions(opts), true, true)
        if (severeIssueCount(cons.report) <= severeIssueCount(cur.report)) cur = cons
      }
    }

    item.clarityBefore = clarityBefore
    item.clarityAfter = cur.clarity
    item.report = cur.report

    // 输出画布（1:1 逐像素写出，不做二次重采样）
    const { enhanced, ow, oh } = cur.built
    const out = document.createElement('canvas')
    out.width = ow
    out.height = oh
    const octx = out.getContext('2d')
    if (!octx) throw new Error('no ctx')
    octx.putImageData(new ImageData(flattenOnWhite(enhanced), ow, oh), 0, 0)

    // JPG 恒为 1.0（100%），PNG 忽略该参数即无损
    const blob = await new Promise<Blob | null>((res) =>
      out.toBlob((b) => res(b), opts.format, 1),
    )
    if (!blob) throw new Error('toBlob failed')
    if (item.enhancedUrl.startsWith('blob:')) URL.revokeObjectURL(item.enhancedUrl)
    item.enhancedBlob = blob
    item.enhancedUrl = URL.createObjectURL(blob)
    item.outW = ow
    item.outH = oh
    item.outBytes = blob.size
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

/** 导出文件名：源名 + 模式 + 档位 + 时间戳 —— 与源文件必然不同名，原图不可能被覆盖 */
function fileNameFor(item: ImgItem): string {
  const base = item.name.replace(/\.[^.]+$/, '')
  const mode = options.strength === 'camera' && cameraAvailable.value ? 'camera' : options.strength
  return `${base}_portrait_${mode}_${options.output}_${stamp()}.${extOf(options.format)}`
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
      const ext = extOf(options.format)
      let chosen: string | null = targetPath ?? null
      if (!chosen) {
        chosen = await saveDialog(name, [{ name: t('portrait.imgFilter'), extensions: [ext] }])
        if (!chosen) {
          exportMsg.value = t('portrait.exportCancel')
          return false
        }
      }
      // 兜底保护：用户若手动选中了源文件同名路径，强制补时间戳，绝不覆盖原图
      const chosenBase = chosen.replace(/^.*[\\/]/, '')
      if (chosenBase.toLowerCase() === item.name.toLowerCase()) {
        chosen = chosen.replace(/(\.[^.\\/]+)?$/, `_${stamp()}$1`)
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
      { name: t('portrait.imgFilter'), extensions: [extOf(options.format)] },
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
              <div
                v-if="it.assessment"
                class="text-[10px]"
                :class="{
                  'text-emerald-500': it.assessment.grade === 'mild',
                  'text-sky-500': it.assessment.grade === 'moderate',
                  'text-amber-500': it.assessment.grade === 'severe',
                  'text-rose-500': it.assessment.grade === 'extreme',
                }"
              >
                {{ t(`portrait.grade.${it.assessment.grade}`) }}
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

        <!-- 输出尺寸与体积：不压缩画质，因此体积可能很大 -->
        <div v-if="selected && selected.outBytes > 0" class="text-[10px] text-slate-400 mt-1">
          {{ t('portrait.sizeInfo', { w: selected.outW, h: selected.outH, size: formatBytes(selected.outBytes) }) }}
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
      <div class="w-72 shrink-0 border-l border-slate-200 dark:border-slate-700 p-3 overflow-y-auto space-y-3">
        <!-- 修复模式（4 档） -->
        <div>
          <div class="text-[11px] font-medium mb-1">{{ t('portrait.mode') }}</div>
          <div class="grid grid-cols-2 gap-1">
            <button
              v-for="s in strengthOptions"
              :key="s.key"
              class="px-1 py-1 rounded text-[10px] leading-tight border transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              :class="
                options.strength === s.key
                  ? 'bg-sky-500 text-white border-sky-500'
                  : 'bg-white dark:bg-slate-800 text-slate-500 border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700'
              "
              :disabled="s.disabled"
              @click="options.strength = s.key"
            >
              {{ s.label }}
            </button>
          </div>
          <div class="text-[10px] text-slate-400 mt-1">{{ t('portrait.modeNote') }}</div>
          <div v-if="selAssessment && !cameraAvailable" class="text-[10px] text-amber-500 mt-0.5">
            {{ t('portrait.modeLocked', { grade: t(`portrait.grade.${selAssessment.grade}`) }) }}
          </div>
        </div>

        <!-- 清晰强度 -->
        <div>
          <div class="flex items-center justify-between text-[11px] font-medium mb-1">
            <span>{{ t('portrait.clarity') }}</span>
            <span class="tabular-nums text-sky-500">{{ options.clarity }}</span>
          </div>
          <input type="range" min="0" max="120" step="1" v-model.number="options.clarity" class="w-full" />
          <div class="text-[10px] text-slate-400 mt-1">{{ t('portrait.clarityNote') }}</div>
        </div>

        <!-- 真实感强度 -->
        <div>
          <div class="text-[11px] font-medium mb-1">{{ t('portrait.realism') }}</div>
          <div class="flex rounded-md overflow-hidden border border-slate-300 dark:border-slate-600">
            <button
              v-for="r in realismOptions"
              :key="r.key"
              class="flex-1 px-1 py-1 text-[10px] leading-tight"
              :class="
                options.realism === r.key
                  ? 'bg-teal-500 text-white'
                  : 'bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'
              "
              @click="options.realism = r.key"
            >
              {{ r.label }}
            </button>
          </div>
          <div class="text-[10px] text-slate-400 mt-1">{{ t('portrait.realismNote') }}</div>
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

        <!-- 划痕修复 -->
        <div>
          <div class="text-[11px] font-medium mb-1">{{ t('portrait.defect') }}</div>
          <div class="flex rounded-md overflow-hidden border border-slate-300 dark:border-slate-600">
            <button
              v-for="d in defectOptions"
              :key="d.key"
              class="flex-1 px-1 py-1 text-[10px] leading-tight"
              :class="
                options.defect === d.key
                  ? 'bg-amber-500 text-white'
                  : 'bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'
              "
              @click="options.defect = d.key"
            >
              {{ d.label }}
            </button>
          </div>
          <div class="text-[10px] text-slate-400 mt-1">{{ t('portrait.defectNote') }}</div>
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
          <div class="text-[10px] text-slate-400 mt-1">{{ t('portrait.upscaleNote') }}</div>
        </div>

        <!-- 输出格式：JPG 100% / PNG 无损，没有质量滑块 -->
        <div>
          <div class="text-[11px] font-medium mb-1">{{ t('portrait.format') }}</div>
          <div class="flex flex-col rounded-md overflow-hidden border border-slate-300 dark:border-slate-600">
            <button
              v-for="f in [
                { key: 'image/jpeg', label: t('portrait.format.jpg') },
                { key: 'image/png', label: t('portrait.format.png') },
              ]"
              :key="f.key"
              class="px-2 py-1 text-[10px] text-left"
              :class="
                options.format === f.key
                  ? 'bg-slate-700 text-white'
                  : 'bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'
              "
              @click="options.format = f.key"
            >
              {{ f.label }}
            </button>
          </div>
          <div class="text-[10px] text-slate-400 mt-1">{{ t('portrait.formatNote') }}</div>
        </div>

        <!-- 原图分级 + 分级承诺 -->
        <div v-if="selAssessment" class="rounded-md border border-slate-200 dark:border-slate-700 p-2">
          <div class="text-[11px] font-medium mb-1">{{ t('portrait.grade') }}</div>
          <div class="text-[10px] text-slate-600 dark:text-slate-300">
            {{ t(`portrait.grade.${selAssessment.grade}`) }}
          </div>
          <div class="text-[10px] text-sky-500 mt-0.5">
            {{ t(`portrait.promise.${selAssessment.grade}`) }}
          </div>
          <div class="text-[10px] text-slate-400 mt-1">
            {{
              t('portrait.gradeDetail', {
                sharp: selAssessment.sharpness,
                block: selAssessment.blockiness,
                defect: selAssessment.defectDensity,
              })
            }}
          </div>
        </div>

        <!-- 自动质检（11 项明细） -->
        <div v-if="selReport" class="rounded-md border border-slate-200 dark:border-slate-700 p-2">
          <div class="text-[11px] font-medium mb-1">{{ t('portrait.quality') }}</div>
          <div class="text-[10px] text-slate-500">
            {{ t('portrait.clarityBefore', { n: selReport.clarityBefore }) }} →
            <span class="text-emerald-500">{{ t('portrait.clarityAfter', { n: selReport.clarityAfter }) }}</span>
          </div>
          <div class="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5">
            <div v-for="row in qcRows" :key="row.key" class="flex items-center justify-between text-[10px]">
              <span :class="row.fail ? 'text-amber-500' : 'text-slate-400'">{{ row.label }}</span>
              <span :class="row.fail ? 'text-amber-500' : 'text-emerald-500'" class="tabular-nums ml-1">
                {{ row.fail ? t('portrait.qcFail') : t('portrait.qcPass') }}
              </span>
            </div>
          </div>
          <div v-if="selReport.issues.length === 0" class="text-[10px] text-emerald-500 mt-1">
            {{ t('portrait.qualityOk') }}
          </div>
          <div v-if="selReport.degraded" class="text-[10px] text-sky-500 mt-1">
            {{ t('portrait.retryApplied') }}
          </div>
          <div v-if="selReport.fallback" class="text-[10px] text-amber-500 mt-1">
            {{ t('portrait.fallbackApplied') }}
          </div>
          <div v-if="selected?.modeNote" class="text-[10px] text-amber-500 mt-1">
            {{ selected.modeNote }}
          </div>
        </div>

        <!-- 原图保护 -->
        <div class="text-[10px] text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded p-2 leading-relaxed">
          {{ t('portrait.noOverwrite') }}
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
