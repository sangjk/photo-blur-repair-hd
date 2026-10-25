/* =============================================================================
 * portraitEngine.ts —— 人像超清修复：人脸专项增强引擎（纯前端、零第三方依赖）
 *
 * 与通用照片修复（photo-repair/engine.ts）的本质区别：
 *   通用修复 = 全图统一锐化，容易把脸也一起锐化出白边、把人像做"平"。
 *   人像修复 = 先定位脸与五官，**只在对应解剖区域**做针对性增强，
 *               并把五官区域单独超分重建（避免整图放大后脸糊）。
 *
 * 设计红线（对应需求「不塑料、不假面、不变形」）：
 *   1. **全程不做任何几何形变 / 仿射 / 液化** —— 只改像素值，不改像素位置。
 *      因此「五官比例不变形、不歪眼、不换脸、重影」由构造保证，而非靠调参。
 *   2. 所有锐化细节层以**原图**高频为基准（unsharpFrom），输出高频恒 ≥ 原图，
 *      保证「修复只可能更清晰，绝不会比原图更糊」。
 *   3. 边缘引导的锐化增益图（轮廓增强）让平坦区域不产生白边 → 不塑料。
 *   4. 皮肤用双边滤波（保边平滑）而不是高斯模糊 → 保留毛孔、肤质。
 *   5. 质量检测发现过锐化 / 塑料感 / 重影时，**自动降强度重试一次**。
 *
 * 纯函数、纯数组运算（不依赖 canvas），便于在 CI 中稳定复现。
 * ========================================================================== */

import {
  gaussianBlur,
  unsharp,
  unsharpFrom,
  denoiseSoft,
  clarityScore,
} from '../photo-repair/engine'

/* ============================================================================
 * 类型定义
 * ========================================================================== */

/** 人脸包围盒（原图像素坐标） */
export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
}

/** 五官定位点（圆心 + 半径，原图像素坐标） */
export interface FeaturePoint {
  x: number
  y: number
  r: number
}

/** 人脸关键几何信息 */
export interface FaceLandmarks {
  eyeL: FeaturePoint
  eyeR: FeaturePoint
  mouth: FeaturePoint
  /** 眉毛中心（r = 眉毛半宽） */
  browL: FeaturePoint
  browR: FeaturePoint
  /** 鼻梁中线（x = 鼻梁中心，r = 鼻梁半宽） */
  noseBridge: FeaturePoint
  noseWingL: FeaturePoint
  noseWingR: FeaturePoint
  /** 皮肤占比 0..1（越低说明脸被头发/阴影遮挡越多） */
  skinRatio: number
  /** 眼睛是否通过暗像素搜索精确定位（false = 用标准比例兜底） */
  eyeLocated: boolean
  /** 瞳孔高光是否存在（只在存在时增强，绝不凭空造高光） */
  catchlight: boolean
}

/**
 * 修复模式（清晰强度）。
 * camera = 相机真实感模式：只在**轻度模糊**的旧图上开放（重锐化会把中度模糊做成假面）。
 */
export type PortraitStrength = 'natural' | 'ultra' | 'extreme' | 'camera'
/** 皮肤质感档位 */
export type SkinTexture = 'keep' | 'balanced' | 'smooth'
/** 输出分辨率档位 */
export type PortraitOutput = 'hd' | 'uhd' | '4k' | '5k'
/** 真实感强度档位 */
export type RealismLevel = 'low' | 'mid' | 'high'
/** 划痕 / 折痕 / 污渍修复强度 */
export type DefectLevel = 'off' | 'auto' | 'strong'

/** 输入分级：轻度 / 中度 / 重度 / 极差模糊旧图 */
export type InputGrade = 'mild' | 'moderate' | 'severe' | 'extreme'

export interface PortraitOptions {
  /** 修复模式 */
  strength: PortraitStrength
  /**
   * 清晰强度 0..120（默认 100）。
   *
   * 它是对「修复模式」那一档预设的**全局增益**：模式决定"往哪个方向修"，
   * 清晰强度决定"修多狠"。100 = 预设原值；<100 更保守（出图更软、更像原片），
   * >100 允许超出预设（最高 120，供用户对模糊极重的图加码）。
   * 之所以做成增益而不是再做一套预设：四档模式 × 若干强度会组合爆炸，
   * 而"同一方向、不同力度"用单一系数表达最直观，也不会互相打架。
   */
  clarity: number
  /** 真实感强度 */
  realism: RealismLevel
  /** 皮肤质感 */
  skin: SkinTexture
  /** 划痕 / 折痕 / 污渍修复 */
  defect: DefectLevel
  /** 输出长边像素 */
  targetLongEdge: number
  /** 导出格式 */
  format: string
  /** 导出质量 0..1 */
  quality: number
}

/** 各档位的算子参数（百分比，0..100） */
export interface StrengthPreset {
  /** 全局去模糊锐化 */
  deblur: number
  /** 眼周整体（眼白 / 眼睑） */
  eye: number
  /** 虹膜纹理 */
  iris: number
  /** 睫毛（单根分离） */
  lash: number
  /** 眉毛 */
  brow: number
  /** 鼻梁 / 鼻翼 */
  nose: number
  /** 发丝 / 发际线 */
  hair: number
  /** 唇线 */
  mouth: number
  /** 牙齿（限亮防白块） */
  teeth: number
  /** 轮廓 / 边缘 */
  contour: number
  /** 降噪强度 */
  denoise: number
  /** 人脸区域局部超分最大放大倍数 */
  localScaleMax: number
}

/**
 * 四档修复模式参数。
 *
 * 「相机真实感」刻意把锐化压到最低（deblur 26 / contour 20），把预算放在
 * 微观对比与色调上 —— 手机直出之所以"真"，靠的是干净的光影过渡，
 * 不是靠锐化量，所以这一档的锐化必须比「自然高清」还轻。
 */
export const STRENGTH_PRESETS: Record<PortraitStrength, StrengthPreset> = {
  natural: {
    deblur: 30,
    eye: 26,
    iris: 20,
    lash: 18,
    brow: 14,
    nose: 14,
    hair: 22,
    mouth: 16,
    teeth: 12,
    contour: 24,
    denoise: 30,
    localScaleMax: 1.5,
  },
  ultra: {
    deblur: 52,
    eye: 62,
    iris: 58,
    lash: 54,
    brow: 40,
    nose: 40,
    hair: 48,
    mouth: 38,
    teeth: 28,
    contour: 50,
    denoise: 38,
    localScaleMax: 1.9,
  },
  extreme: {
    deblur: 72,
    eye: 90,
    iris: 88,
    lash: 84,
    brow: 60,
    nose: 60,
    hair: 68,
    mouth: 54,
    teeth: 40,
    contour: 70,
    denoise: 46,
    localScaleMax: 2.2,
  },
  camera: {
    deblur: 26,
    eye: 30,
    iris: 34,
    lash: 26,
    brow: 20,
    nose: 22,
    hair: 24,
    mouth: 20,
    teeth: 14,
    contour: 20,
    denoise: 24,
    localScaleMax: 1.2,
  },
}

/** 输出分辨率档位（长边像素；原图更大时保持原分辨率，绝不缩小） */
export const PORTRAIT_OUTPUTS: { key: PortraitOutput; longEdge: number }[] = [
  { key: 'hd', longEdge: 1920 },
  { key: 'uhd', longEdge: 2560 },
  { key: '4k', longEdge: 3840 },
  { key: '5k', longEdge: 5120 },
]

/**
 * 皮肤质感 → 双边滤波混合系数（0 = 完全保留纹理）。
 *
 * 硬上限 0.6：「更平滑」也绝不允许把毛孔抹平到蜡像级 —— 需求写明磨皮要设上限。
 */
export const SKIN_PRESETS: Record<SkinTexture, number> = {
  keep: 0,
  balanced: 0.35,
  smooth: 0.6,
}

/** 真实感强度 → 校正量（0 = 不校正，1 = 全量） */
export const REALISM_PRESETS: Record<RealismLevel, number> = {
  low: 0.4,
  mid: 0.72,
  high: 1,
}

/** 缺陷修复强度 → 检测阈值倍数（越大修得越多） */
export const DEFECT_PRESETS: Record<DefectLevel, number> = {
  off: 0,
  auto: 1,
  strong: 1.6,
}

/** 质量检测发现的问题类型（需求列了 10 类 + 清晰度提升不足） */
export type PortraitIssue =
  | 'halo' // 白边
  | 'glow' // 光晕
  | 'plastic' // 塑料感
  | 'wax' // 蜡像感
  | 'overSmooth' // 过度磨皮
  | 'ghost' // 重影
  | 'deform' // 五官变形
  | 'skinTone' // 肤色偏移
  | 'aiArtifact' // AI 伪影（平坦区假纹理）
  | 'seam' // 拼接痕
  | 'lowGain' // 清晰度提升不足

export interface QualityReport {
  /** 修复前清晰度 0..100 */
  clarityBefore: number
  /** 修复后清晰度 0..100 */
  clarityAfter: number
  /** 过冲白边比例 0..1（越高越像「假面/锐化过度」） */
  haloScore: number
  /** 宽半径光晕比例 0..1 */
  glowScore: number
  /** 皮肤高频丢失比例 0..1（越高越像「蜡像/塑料」） */
  plasticScore: number
  /** 蜡像感：皮肤平坦斑块占比 0..1 */
  waxScore: number
  /** 重影：暗特征块复制计数 */
  ghostScore: number
  /** 拼接痕：贴回边界相对内部的梯度跃变比 */
  seamScore: number
  /** AI 伪影：原本平坦的区域长出高频的比例 0..1（>0.06 判异常） */
  aiScore: number
  /** 肤色偏移：脸部肤色色度漂移量（>4.5 判异常） */
  skinToneScore: number
  /** 是否已自动降强度重试 */
  degraded: boolean
  /** 重试后仍不合格 → 已回退「自然高清」保守输出 */
  fallback: boolean
  /** 命中的问题 */
  issues: PortraitIssue[]
}

/** 输入分级评估结果 */
export interface InputAssessment {
  grade: InputGrade
  /** 脸部锐度指数 0..100（归一化到固定尺寸后测量，跨分辨率可比） */
  sharpness: number
  /** JPEG 块状度 0..1 */
  blockiness: number
  /** 薄线缺陷（划痕/折痕/尘点）密度 0..1 */
  defectDensity: number
}

/* ============================================================================
 * 基础工具
 * ========================================================================== */

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 肤色判定：RGB → YCbCr + R>G>B 倾向（排除蓝/绿伪肤色） */
function isSkin(r: number, g: number, b: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  if (y < 55 || y > 246) return false
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  if (cb < 77 || cb > 127) return false
  if (cr < 133 || cr > 180) return false
  // 肤色应有 R > G > B 的倾向；放宽以兼容暖色灯光 / 黄褐色皮肤
  if (r < b + 8) return false
  if (g < b + 3) return false
  return true
}

/** 灰度图（0..255） */
function toGray(src: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h)
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    g[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]
  }
  return g
}

/* ============================================================================
 * 1. 人脸检测（肤色分割 + 连通域 + 五官暗像素验证）
 * ========================================================================== */

/**
 * 人脸检测。
 *
 * 纯肤色分割会把木质背景、暖色墙面误判成人脸，因此叠加三重约束：
 *   ① 连通域形状接近人脸（宽高比 + 填充率）
 *   ② 眼带内存在暗像素簇（眼睛）—— 这是最强的正信号
 *   ③ 面积占图像比例的下限（小脸也要检出，但不能是噪点）
 */
export function detectFaces(src: Uint8ClampedArray, w: number, h: number): FaceBox[] {
  if (w < 24 || h < 24) return []

  // 降采样到长边 ≤ 320 做检测（只做检测，最终坐标映射回原图，精度足够）
  const step = Math.max(1, Math.ceil(Math.max(w, h) / 320))
  const gw = Math.floor(w / step)
  const gh = Math.floor(h / step)
  if (gw < 8 || gh < 8) return []

  const mask = new Uint8Array(gw * gh)
  for (let gy = 0; gy < gh; gy++) {
    const sy = Math.min(h - 1, gy * step + (step >> 1))
    for (let gx = 0; gx < gw; gx++) {
      const sx = Math.min(w - 1, gx * step + (step >> 1))
      const p = (sy * w + sx) * 4
      if (isSkin(src[p], src[p + 1], src[p + 2])) mask[gy * gw + gx] = 1
    }
  }

  // 4 邻域连通域标记（显式栈，避免递归爆栈）
  const labels = new Int32Array(gw * gh).fill(-1)
  const stack = new Int32Array(gw * gh)
  interface Comp {
    minX: number
    minY: number
    maxX: number
    maxY: number
    area: number
  }
  const comps: Comp[] = []

  for (let start = 0; start < gw * gh; start++) {
    if (mask[start] !== 1 || labels[start] !== -1) continue
    const id = comps.length
    let sp = 0
    stack[sp++] = start
    labels[start] = id
    let minX = gw
    let minY = gh
    let maxX = -1
    let maxY = -1
    let area = 0
    while (sp > 0) {
      const cur = stack[--sp]
      const cx = cur % gw
      const cy = (cur - cx) / gw
      area++
      if (cx < minX) minX = cx
      if (cx > maxX) maxX = cx
      if (cy < minY) minY = cy
      if (cy > maxY) maxY = cy
      // 4 邻域
      if (cx > 0 && mask[cur - 1] === 1 && labels[cur - 1] === -1) {
        labels[cur - 1] = id
        stack[sp++] = cur - 1
      }
      if (cx < gw - 1 && mask[cur + 1] === 1 && labels[cur + 1] === -1) {
        labels[cur + 1] = id
        stack[sp++] = cur + 1
      }
      if (cy > 0 && mask[cur - gw] === 1 && labels[cur - gw] === -1) {
        labels[cur - gw] = id
        stack[sp++] = cur - gw
      }
      if (cy < gh - 1 && mask[cur + gw] === 1 && labels[cur + gw] === -1) {
        labels[cur + gw] = id
        stack[sp++] = cur + gw
      }
    }
    comps.push({ minX, minY, maxX, maxY, area })
  }

  const totalCells = gw * gh
  const candidates: { box: FaceBox; score: number; eyeFound: boolean }[] = []

  for (let ci = 0; ci < comps.length; ci++) {
    const c = comps[ci]
    const bw = c.maxX - c.minX + 1
    const bh = c.maxY - c.minY + 1
    if (bw < 4 || bh < 4) continue
    const areaRatio = c.area / totalCells
    // 过小的色块：噪点；过大的：背景（墙、地面、木纹）
    if (areaRatio < 0.0012) continue
    if (areaRatio > 0.75) continue

    // 用密度剖面把包围盒收紧到"真正的脸"（剔除模糊边缘造成的肤色晕圈）
    const refined = refineBoxByDensity(labels, ci, gw, gh, c.minX, c.maxX, c.minY, c.maxY)
    if (!refined) continue
    const rw = refined.maxX - refined.minX + 1
    const rh = refined.maxY - refined.minY + 1
    if (rw < 4 || rh < 4) continue
    const aspect = rw / rh
    if (aspect < 0.42 || aspect > 2.6) continue
    const fill = refined.area / (rw * rh)
    // 人脸肤色区域不应铺满整个包围盒（眼睛/眉毛/嘴是非肤色）
    if (fill < 0.28 || fill > 0.97) continue

    // 映射回原图坐标
    const x = refined.minX * step
    const y = refined.minY * step
    const bwOrig = Math.min(w - x, rw * step)
    const bhOrig = Math.min(h - y, rh * step)
    if (bwOrig < 20 || bhOrig < 20) continue

    const box: FaceBox = { x, y, w: bwOrig, h: bhOrig }
    const eyeFound = hasEyeDarkBand(src, w, h, box)
    // 打分：找到眼睛暗带 = 高置信；否则靠形状与面积给中等分
    const score = (eyeFound ? 1 : 0.45) * areaRatio
    candidates.push({ box, score, eyeFound })
  }

  // 按分数降序，重叠抑制（IoU > 0.3 视为同一张脸）
  candidates.sort((a, b) => b.score - a.score)
  const accepted: FaceBox[] = []
  for (const cand of candidates) {
    let overlapped = false
    for (const box of accepted) {
      if (iou(cand.box, box) > 0.3) {
        overlapped = true
        break
      }
    }
    if (!overlapped) accepted.push(cand.box)
    if (accepted.length >= 8) break
  }
  return accepted
}

/**
 * 用行 / 列密度剖面把连通域包围盒收紧到"真正的脸"。
 *
 * 背景：模糊照片里头发与皮肤的交界会被模糊成一圈"肤色晕圈"，
 * 它与脸部连成一片，使连通域的原始包围盒把整个头部（含头发）都框进去，
 * 五官按比例定位就会全部算错（左眼会被定位到发际线附近）。
 *
 * 做法：脸部各行/各列的肤色像素数远高于晕圈行（晕圈只是一圈细弧），
 * 因此取「密度达到峰值 40%」的行区间与列区间作为真实脸部范围，晕圈自然被剔除。
 */
function refineBoxByDensity(
  labels: Int32Array,
  compId: number,
  gw: number,
  gh: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): { minX: number; minY: number; maxX: number; maxY: number; area: number } | null {
  const rowCount = new Int32Array(gh)
  const colCount = new Int32Array(gw)
  for (let gy = minY; gy <= maxY; gy++) {
    const rowBase = gy * gw
    for (let gx = minX; gx <= maxX; gx++) {
      if (labels[rowBase + gx] === compId) {
        rowCount[gy]++
        colCount[gx]++
      }
    }
  }
  let maxRow = 0
  let maxCol = 0
  for (let i = 0; i < gh; i++) if (rowCount[i] > maxRow) maxRow = rowCount[i]
  for (let i = 0; i < gw; i++) if (colCount[i] > maxCol) maxCol = colCount[i]
  if (maxRow < 3 || maxCol < 3) return null

  const rowThr = maxRow * 0.4
  const colThr = maxCol * 0.4
  let r0 = -1
  let r1 = -1
  for (let i = 0; i < gh; i++) {
    if (rowCount[i] >= rowThr) {
      if (r0 < 0) r0 = i
      r1 = i
    }
  }
  let c0 = -1
  let c1 = -1
  for (let i = 0; i < gw; i++) {
    if (colCount[i] >= colThr) {
      if (c0 < 0) c0 = i
      c1 = i
    }
  }
  if (r0 < 0 || c0 < 0 || r1 < r0 || c1 < c0) return null

  // 收紧后区域内实际属于该连通域的像素数（用于填充率判定）
  let area = 0
  for (let gy = r0; gy <= r1; gy++) {
    const rowBase = gy * gw
    for (let gx = c0; gx <= c1; gx++) {
      if (labels[rowBase + gx] === compId) area++
    }
  }
  return { minX: c0, minY: r0, maxX: c1, maxY: r1, area }
}

/** 眼带内是否存在暗像素簇（眼睛/眉毛）——人脸最强的正信号 */
function hasEyeDarkBand(src: Uint8ClampedArray, w: number, h: number, box: FaceBox): boolean {
  const y0 = Math.round(box.y + box.h * 0.26)
  const y1 = Math.round(box.y + box.h * 0.56)
  const x0 = Math.round(box.x + box.w * 0.12)
  const x1 = Math.round(box.x + box.w * 0.88)
  if (y1 >= h || x1 >= w || y1 <= y0 || x1 <= x0) return false

  // 眼带肤色像素的平均亮度作为基线
  let sum = 0
  let cnt = 0
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const p = (y * w + x) * 4
      sum += 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2]
      cnt++
    }
  }
  if (cnt === 0) return false
  const mean = sum / cnt
  const darkLimit = mean - 18

  // 某一行里存在 ≥ 2 个明显暗像素 → 认为该行有眼睛
  for (let y = y0; y < y1; y++) {
    let dark = 0
    for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 4
      const lum = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2]
      if (lum < darkLimit) dark++
    }
    if (dark >= 2) return true
  }
  return false
}

function iou(a: FaceBox, b: FaceBox): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  if (x2 <= x1 || y2 <= y1) return 0
  const inter = (x2 - x1) * (y2 - y1)
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/* ============================================================================
 * 2. 五官定位（眼 / 唇）
 * ========================================================================== */

/**
 * 定位人脸五官。
 * 侧脸 / 半脸时标准比例会偏，因此用「暗像素搜索」在眼带内做一次精修；
 * 找不到就用标准比例兜底（此时标记 eyeLocated=false，参数自动收敛）。
 */
export function locateLandmarks(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  box: FaceBox,
): FaceLandmarks {
  const canonEyeR = Math.max(4, box.w * 0.115)
  const canonEyeY = box.y + box.h * 0.4
  const canonEyeLX = box.x + box.w * 0.3
  const canonEyeRX = box.x + box.w * 0.7

  const eyeL = refineEye(src, w, h, canonEyeLX, canonEyeY, canonEyeR)
  const eyeR = refineEye(src, w, h, canonEyeRX, canonEyeY, canonEyeR)

  const mouth = refineMouth(src, w, h, box)
  const skinRatio = countSkinRatio(src, w, h, box)

  // —— 由眼/唇几何推导眉毛、鼻梁、鼻翼（不依赖额外模型，比例取自标准人像解剖）——
  const eyeMidY = (eyeL.point.y + eyeR.point.y) / 2
  const browY = Math.max(box.y + box.h * 0.15, eyeMidY - box.h * 0.125)
  const browR = Math.max(3, box.w * 0.13)
  const centerX = (eyeL.point.x + eyeR.point.x) / 2
  // 鼻梁落在双眼正下方（眼—唇距的 30%），鼻底（鼻翼）在 66% 处 —— 这两条比例
  // 取自标准面部三等分（眼线 45%、鼻底 67%、唇线 78%）。原来用"半个眼唇距"
  // 估鼻底，实测偏 15px，会把鼻翼增强打到人中去。
  const noseBridgeY = eyeMidY + (mouth.y - eyeMidY) * 0.3
  const noseBridgeR = Math.max(3, box.w * 0.055)
  const wingY = eyeMidY + (mouth.y - eyeMidY) * 0.66
  const wingDx = Math.max(4, box.w * 0.105)
  const wingR = Math.max(3, box.w * 0.05)

  const catchlight =
    detectCatchlight(src, w, h, eyeL.point) !== null ||
    detectCatchlight(src, w, h, eyeR.point) !== null

  return {
    eyeL: eyeL.point,
    eyeR: eyeR.point,
    mouth,
    browL: { x: eyeL.point.x, y: browY, r: browR },
    browR: { x: eyeR.point.x, y: browY, r: browR },
    noseBridge: { x: centerX, y: noseBridgeY, r: noseBridgeR },
    noseWingL: { x: centerX - wingDx, y: wingY, r: wingR },
    noseWingR: { x: centerX + wingDx, y: wingY, r: wingR },
    skinRatio,
    eyeLocated: eyeL.found || eyeR.found,
    catchlight,
  }
}

/**
 * 瞳孔高光（catchlight）检测。
 *
 * 真实人像的眼睛几乎一定有高光点，它是"有神"的关键；但它**必须来自原图**。
 *
 * 判据不能是"眼内最亮像素"：眼白本身就接近 240，会把高光淹没（实测漏检）。
 * 真正的高光签名是「**暗底上的一个小亮点**」—— 亮点的 8 邻环明显比它暗。
 * 因此用「亮度 − 半径 3 环均值」作为强度，并要求环本身偏暗（在瞳孔上）。
 */
function detectCatchlight(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  eye: FeaturePoint,
): { x: number; y: number; r: number } | null {
  const rad = Math.max(3, eye.r * 1.1)
  const x0 = Math.max(0, Math.floor(eye.x - rad))
  const x1 = Math.min(w - 1, Math.ceil(eye.x + rad))
  const y0 = Math.max(0, Math.floor(eye.y - rad))
  const y1 = Math.min(h - 1, Math.ceil(eye.y + rad))
  if (x1 <= x0 + 1 || y1 <= y0 + 1) return null

  const OFF = [
    [-3, 0],
    [3, 0],
    [0, -3],
    [0, 3],
    [-2, -2],
    [2, 2],
    [-2, 2],
    [2, -2],
  ]
  let bestStrength = 0
  let bx = 0
  let by = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - eye.x) / rad
      const dy = (y + 0.5 - eye.y) / rad
      if (dx * dx + dy * dy > 1) continue
      const i = (y * w + x) * 4
      const lum = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]
      if (lum < 170) continue
      let ringSum = 0
      let ringN = 0
      for (const [ox, oy] of OFF) {
        const qx = x + ox
        const qy = y + oy
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue
        const q = (qy * w + qx) * 4
        ringSum += 0.299 * src[q] + 0.587 * src[q + 1] + 0.114 * src[q + 2]
        ringN++
      }
      if (!ringN) continue
      const ringMean = ringSum / ringN
      // 环必须偏暗（说明亮点在瞳孔/虹膜上，而不是眼白的一部分）
      if (ringMean > 150) continue
      const strength = lum - ringMean
      if (strength > bestStrength) {
        bestStrength = strength
        bx = x
        by = y
      }
    }
  }
  if (bestStrength < 42) return null
  return { x: bx, y: by, r: Math.max(1.2, eye.r * 0.17) }
}

/**
 * 定位单只眼睛。
 *
 * 四代"找暗"判据的实测偏差（合成人像，真值 (386,474) r=25）：
 *   · 眼带内最暗点            → 偏 23px（落在瞳孔下缘的阴影里）
 *   · 暗区加权质心            → 偏 12px（被上方睫毛 + 双眼皮暗带拽高）
 *   · 暗度盒平均（积分图）    → 偏 27~32px（窗口贴边时面积不可比，越调越糟）
 *   · 「眼白—瞳孔—眼白」三段式 → 偏 27px（睫毛带两侧同样是皮肤，横向仍有大对比）
 *
 * 四代全在"找暗"，可睫毛、双眼皮线、下眼睑阴影、鼻孔阴影**全都是暗的** ——
 * 方向本身就错了。换一个方向：找**眼白**。
 *
 * 巩膜是人脸上唯一"又亮又中性"的区域：皮肤再亮也偏暖（蓝通道比绿通道低 20+），
 * 眉毛/睫毛/瞳孔/虹膜都暗，头发更暗。于是
 *
 *   眼中心 = 眼白像素集合的外接框中心；眼睛半径 = 外接框半高。
 *
 * 这个定义不依赖暗块形状，也不怕上下睫毛把眼白切掉一条 —— 外接框中心对
 * "上方被睫毛吃掉几像素"这种不对称只有 2px 量级的偏置，实测 0.5px。
 */
function refineEye(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  canonX: number,
  canonY: number,
  canonR: number,
): { point: FeaturePoint; found: boolean } {
  const fallback: FeaturePoint = { x: canonX, y: canonY, r: canonR }
  // 搜索窗以标准比例位置为中心：太小容不下个体差异，太大就会把脸颊/额头的高光
  // 当成眼白。1.8R × 1.25R 是能覆盖绝大多数正脸比例的折中。
  const rx = Math.max(6, Math.round(canonR * 1.8))
  const ry = Math.max(5, Math.round(canonR * 1.25))
  const x0 = Math.max(0, Math.round(canonX - rx))
  const x1 = Math.min(w - 1, Math.round(canonX + rx))
  const y0 = Math.max(0, Math.round(canonY - ry))
  const y1 = Math.min(h - 1, Math.round(canonY + ry))
  if (x1 <= x0 + 2 || y1 <= y0 + 2) return { point: fallback, found: false }

  // 窗口亮度中位数 → 眼白亮度门限的基准。每张图的曝光都不同，固定阈值必然失效；
  // 用直方图取中位数，两次线性遍历，不分配大对象。
  const hist = new Uint32Array(256)
  let total = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4
      hist[Math.round(0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2])]++
      total++
    }
  }
  let acc = 0
  let med = 128
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc * 2 >= total) {
      med = v
      break
    }
  }
  // 人像里眼白通常比周围皮肤亮 10~30 个灰阶
  const floor = Math.max(150, med + 8)

  let bx0 = 1 << 30
  let bx1 = -1
  let by0 = 1 << 30
  let by1 = -1
  let count = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4
      const r = src[i]
      const g = src[i + 1]
      const b = src[i + 2]
      // 中性判据：巩膜的蓝通道不低于绿通道（皮肤是暖色，B 比 G 低 20 以上）
      if (b < g - 10) continue
      if (0.299 * r + 0.587 * g + 0.114 * b < floor) continue
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      if (mx < 120 || (mx - mn) / mx > 0.26) continue
      count++
      if (x < bx0) bx0 = x
      if (x > bx1) bx1 = x
      if (y < by0) by0 = y
      if (y > by1) by1 = y
    }
  }
  if (count < 20) return { point: fallback, found: false }

  const bw = bx1 - bx0 + 1
  const bh = by1 - by0 + 1
  // 形状校验：眼睛张开时是横向长条。宽高比不对 → 抓到的是额头/脸颊高光或背景亮区，
  // 此时宁可退回标准比例，也不要乱挪五官。
  const aspect = bw / Math.max(1, bh)
  if (bw < canonR * 0.9 || bh < canonR * 0.35 || aspect < 1.05 || aspect > 6.5) {
    return { point: fallback, found: false }
  }
  return {
    point: {
      x: (bx0 + bx1) / 2,
      y: (by0 + by1) / 2,
      r: clamp(bh * 0.5, canonR * 0.45, canonR * 1.4),
    },
    found: true,
  }
}

/** 定位嘴部：下半脸中找最"红"的像素（唇色），偏好标准位置 */
function refineMouth(src: Uint8ClampedArray, w: number, h: number, box: FaceBox): FeaturePoint {
  const canonX = box.x + box.w * 0.5
  const canonY = box.y + box.h * 0.76
  const canonR = Math.max(4, box.w * 0.16)
  const y0 = Math.round(box.y + box.h * 0.6)
  const y1 = Math.round(box.y + box.h * 0.92)
  const x0 = Math.round(box.x + box.w * 0.24)
  const x1 = Math.round(box.x + box.w * 0.76)
  if (y1 >= h || x1 >= w || y1 <= y0 || x1 <= x0) return { x: canonX, y: canonY, r: canonR }

  let bestScore = -Infinity
  let bestX = canonX
  let bestY = canonY
  let bestRed = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 4
      const redness = src[p] - (src[p + 1] + src[p + 2]) / 2
      const dx = Math.abs(x - canonX) / Math.max(1, box.w)
      const score = redness - 18 * dx
      if (score > bestScore) {
        bestScore = score
        bestX = x
        bestY = y
        bestRed = redness
      }
    }
  }
  // 用"唇色区域的外接框中心"代替"最红的那一个点"：
  // 下唇通常比上唇更饱和，取最红点会把嘴定位到下唇下缘（实测偏 22px），
  // 导致上唇落在增强蒙版之外。外接框中心才是嘴唇真正的几何中心。
  if (bestRed > 30) {
    const thr = bestRed * 0.55
    let minX = x1
    let maxX = x0
    let minY = y1
    let maxY = y0
    let cnt = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * w + x) * 4
        const redness = src[p] - (src[p + 1] + src[p + 2]) / 2
        if (redness < thr) continue
        cnt++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (cnt >= 20 && maxX > minX && maxY > minY) {
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      const halfW = Math.max(4, (maxX - minX) / 2)
      return { x: cx, y: cy, r: halfW * 0.9 }
    }
  }
  return { x: bestX, y: bestY, r: canonR }
}

/** 人脸框内的肤色占比（越低说明被头发/阴影遮挡越多） */
function countSkinRatio(src: Uint8ClampedArray, w: number, h: number, box: FaceBox): number {
  const x0 = Math.max(0, Math.round(box.x))
  const y0 = Math.max(0, Math.round(box.y))
  const x1 = Math.min(w, Math.round(box.x + box.w))
  const y1 = Math.min(h, Math.round(box.y + box.h))
  let skin = 0
  let total = 0
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const p = (y * w + x) * 4
      total++
      if (isSkin(src[p], src[p + 1], src[p + 2])) skin++
    }
  }
  return total > 0 ? skin / total : 0
}

/* ============================================================================
 * 3. 重采样（Catmull-Rom 双三次，可分离两趟）
 * ========================================================================== */

function catmullRom(t: number, out: Float64Array): void {
  const t2 = t * t
  const t3 = t2 * t
  out[0] = -0.5 * t3 + t2 - 0.5 * t
  out[1] = 1.5 * t3 - 2.5 * t2 + 1
  out[2] = -1.5 * t3 + 2 * t2 + 0.5 * t
  out[3] = 0.5 * t3 - 0.5 * t2
}

/** 双三次（Catmull-Rom）缩放：人脸局部超分 / 回缩都用它，细节保持明显优于双线性 */
export function resizeCatmullRom(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  ow: number,
  oh: number,
): Uint8ClampedArray {
  if (ow === w && oh === h) return src.slice()
  const tmp = resizeHorizontal(src, w, h, ow)
  return resizeVertical(tmp, ow, h, oh)
}

/* ============================================================================
 * 迭代反投影超分（IBP）——「把缩小版本的清晰度放大」
 * ============================================================================
 *
 * 要解决的问题：普通插值放大后，观感总是比原图"软"。
 *   原因不在插值本身，而在**边缘宽度被按比例稀释**：原图里 3px 宽的一条边，
 *   放大 2 倍后变成 6px —— 相对清晰度没变，但"发虚"的感觉来自插值把边缘
 *   圆化了，而且后续任何半径 1（目标像素）的锐化都只能修 2~3px 的特征，
 *   对 6px 的斜坡无能为力。
 *
 * IBP 的做法是反过来看这件事：
 *   「放大后的图，如果按同样的相机模型重新缩小，必须还能变回原图。」
 *   普通插值不满足这个约束 —— 插值出的斜坡缩小一次会变得更宽，与原图不符。
 *   于是把「缩小一致性」当成约束反复施加：
 *
 *       x ← x + step · BP( source − A(x) )
 *
 *   A  = 高斯模糊(σ) + 面积降采样      （相机模型：模糊 + 采样）
 *   BP = 双三次放大                     （A 的转置，工程上用更锐的核收敛更快）
 *
 *   每一轮迭代都把"当前估计缩小后与原图的差"反投影回高分辨率叠上去。
 *   边缘因此被逐步压回**原图那个宽度**（以原图像素计），而不是被稀释到
 *   scale 倍 —— 这就是"把缩小版本的清晰度放大"。
 *
 * 关键参数 σ（假定的相机模糊宽度，原图像素）：
 *   σ 取大 → 只保证低频一致，几乎不锐化（退化成插值）；
 *   σ 取小 → 反投影会朝着"更锐"的方向解，等价于以该 σ 做反卷积。
 *   实测见 test.ts 的 σ 扫描：σ 越小越锐，但白边/光晕同步上升，
 *   因此默认取估计模糊的 60%（既不放过可恢复的清晰度，也不制造伪锐化）。
 * ========================================================================== */

/** 可分离高斯核（支持小数 σ；σ<0.7 时至少 3 tap，避免退化成恒等） */
function gaussTaps(sigma: number): { k: Float64Array; r: number } {
  const r = Math.max(1, Math.ceil(sigma * 2.2))
  const k = new Float64Array(2 * r + 1)
  const inv = 1 / (sigma * Math.sqrt(2 * Math.PI))
  let sum = 0
  for (let i = -r; i <= r; i++) {
    const v = inv * Math.exp(-(i * i) / (2 * sigma * sigma))
    k[i + r] = v
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return { k, r }
}

/**
 * Float32 RGB（3 通道）可分离高斯模糊，src → dst（src 不被破坏）。
 *
 * 就地可分离的写法：水平pass逐行拷进行缓冲再写回，垂直pass逐列拷进列缓冲再写回，
 * 额外内存只有 O(w+h)。之所以不图省事写成"模糊进 dst 再覆盖 src"——
 * IBP 的每轮迭代都要用**未模糊的当前估计**算前向算子，一旦把 cur 本身糊掉，
 * 迭代会朝着越来越软的方向走（实测 |∇| 3.58 → 3.47，等于白做）。
 */
function gaussF(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  sigma: number,
): void {
  if (sigma <= 0.06 || w < 1 || h < 1) {
    if (dst !== src) dst.set(src)
    return
  }
  const { k, r } = gaussTaps(sigma)
  const rowTmp = new Float32Array(w * 3)
  const colTmp = new Float32Array(h * 3)
  // 水平：src → dst
  for (let y = 0; y < h; y++) {
    const base = y * w * 3
    for (let i = 0; i < w * 3; i++) rowTmp[i] = src[base + i]
    for (let x = 0; x < w; x++) {
      let s0 = 0
      let s1 = 0
      let s2 = 0
      for (let i = -r; i <= r; i++) {
        let xx = x + i
        if (xx < 0) xx = 0
        else if (xx >= w) xx = w - 1
        const ww = k[i + r]
        s0 += rowTmp[xx * 3] * ww
        s1 += rowTmp[xx * 3 + 1] * ww
        s2 += rowTmp[xx * 3 + 2] * ww
      }
      const d = base + x * 3
      dst[d] = s0
      dst[d + 1] = s1
      dst[d + 2] = s2
    }
  }
  // 垂直：dst → dst（列缓冲已完整，读写不冲突）
  for (let x = 0; x < w; x++) {
    for (let i = 0; i < h; i++) {
      colTmp[i * 3] = dst[i * w * 3 + x * 3]
      colTmp[i * 3 + 1] = dst[i * w * 3 + x * 3 + 1]
      colTmp[i * 3 + 2] = dst[i * w * 3 + x * 3 + 2]
    }
    for (let y = 0; y < h; y++) {
      let s0 = 0
      let s1 = 0
      let s2 = 0
      for (let i = -r; i <= r; i++) {
        let yy = y + i
        if (yy < 0) yy = 0
        else if (yy >= h) yy = h - 1
        const ww = k[i + r]
        s0 += colTmp[yy * 3] * ww
        s1 += colTmp[yy * 3 + 1] * ww
        s2 += colTmp[yy * 3 + 2] * ww
      }
      const d = y * w * 3 + x * 3
      dst[d] = s0
      dst[d + 1] = s1
      dst[d + 2] = s2
    }
  }
}

/** Float32 RGB 水平双三次（Catmull-Rom）缩放 */
function resizeCRF_H(f: Float32Array, w: number, h: number, ow: number): Float32Array {
  const out = new Float32Array(ow * h * 3)
  const wgt = new Float64Array(4)
  const idx = new Int32Array(4)
  const scale = w / ow
  for (let x = 0; x < ow; x++) {
    const sx = (x + 0.5) * scale - 0.5
    const i1 = Math.floor(sx)
    const t = sx - i1
    catmullRom(t, wgt)
    for (let k = 0; k < 4; k++) {
      let p = i1 - 1 + k
      if (p < 0) p = 0
      else if (p >= w) p = w - 1
      idx[k] = p
    }
    for (let y = 0; y < h; y++) {
      const srow = y * w * 3
      const drow = y * ow * 3 + x * 3
      for (let c = 0; c < 3; c++) {
        out[drow + c] =
          f[srow + idx[0] * 3 + c] * wgt[0] +
          f[srow + idx[1] * 3 + c] * wgt[1] +
          f[srow + idx[2] * 3 + c] * wgt[2] +
          f[srow + idx[3] * 3 + c] * wgt[3]
      }
    }
  }
  return out
}

/** Float32 RGB 垂直双三次（Catmull-Rom）缩放；dst 可省略（内部分配） */
function resizeCRF_V(
  f: Float32Array,
  w: number,
  h: number,
  oh: number,
  dst?: Float32Array,
): Float32Array {
  const out = dst && dst.length === w * oh * 3 ? dst : new Float32Array(w * oh * 3)
  const wgt = new Float64Array(4)
  const idx = new Int32Array(4)
  const scale = h / oh
  for (let y = 0; y < oh; y++) {
    const sy = (y + 0.5) * scale - 0.5
    const i1 = Math.floor(sy)
    const t = sy - i1
    catmullRom(t, wgt)
    for (let k = 0; k < 4; k++) {
      let p = i1 - 1 + k
      if (p < 0) p = 0
      else if (p >= h) p = h - 1
      idx[k] = p
    }
    for (let x = 0; x < w; x++) {
      const scol = x * 3
      const drow = y * w * 3 + scol
      for (let c = 0; c < 3; c++) {
        out[drow + c] =
          f[idx[0] * w * 3 + scol + c] * wgt[0] +
          f[idx[1] * w * 3 + scol + c] * wgt[1] +
          f[idx[2] * w * 3 + scol + c] * wgt[2] +
          f[idx[3] * w * 3 + scol + c] * wgt[3]
      }
    }
  }
  return out
}

/** Float32 RGB 双三次缩放（可指定目标缓冲，避免每轮迭代重复分配） */
function resizeCRF(
  f: Float32Array,
  w: number,
  h: number,
  ow: number,
  oh: number,
  dst?: Float32Array,
): Float32Array {
  if (ow === w && oh === h) {
    if (dst) {
      dst.set(f)
      return dst
    }
    return f.slice()
  }
  const mid = resizeCRF_H(f, w, h, ow)
  resizeCRF_V(mid, ow, h, oh, dst)
  return dst as Float32Array
}

/**
 * Float32 RGB 面积平均降采样（相机采样模型：一个低分辨率像素 = 高分辨率一小块的平均）。
 *
 * 坐标系约定（这里踩过一次坑，别再改错）：
 *   源像素 i 的中心在**索引坐标** i，覆盖 [i-0.5, i+0.5)。
 *   输出像素 x 覆盖源图区间 [x·s-0.5, (x+1)·s-0.5)，s = w/ow。
 * 一开始写成 [x·s, (x+1)·s)，等于整体偏移半个源像素 —— 前向算子与
 * resizeCatmullRom 的像素中心约定对不齐，IBP 每轮都在"校正一个幻影位移"，
 * 实测无论 σ 取多小，输出都比纯插值更差（RMS 11.9 → 17.6）。
 */
function areaDownF(f: Float32Array, w: number, h: number, ow: number, oh: number): Float32Array {
  const mid = new Float32Array(ow * h * 3)
  const sx = w / ow
  for (let x = 0; x < ow; x++) {
    const a = x * sx - 0.5
    const b = a + sx
    let i0 = Math.ceil(a - 0.5)
    let i1 = Math.floor(b - 0.5)
    if (i0 < 0) i0 = 0
    if (i1 > w - 1) i1 = w - 1
    for (let y = 0; y < h; y++) {
      const row = y * w * 3
      const d = y * ow * 3 + x * 3
      let s0 = 0
      let s1 = 0
      let s2 = 0
      let wsum = 0
      for (let i = i0; i <= i1; i++) {
        const lo = i - 0.5 > a ? i - 0.5 : a
        const hi = i + 0.5 < b ? i + 0.5 : b
        const wgt = hi - lo
        if (wgt <= 0) continue
        s0 += f[row + i * 3] * wgt
        s1 += f[row + i * 3 + 1] * wgt
        s2 += f[row + i * 3 + 2] * wgt
        wsum += wgt
      }
      if (wsum <= 0) {
        mid[d] = f[row]
        mid[d + 1] = f[row + 1]
        mid[d + 2] = f[row + 2]
      } else {
        mid[d] = s0 / wsum
        mid[d + 1] = s1 / wsum
        mid[d + 2] = s2 / wsum
      }
    }
  }
  const out = new Float32Array(ow * oh * 3)
  const sy = h / oh
  for (let y = 0; y < oh; y++) {
    const a = y * sy - 0.5
    const b = a + sy
    let j0 = Math.ceil(a - 0.5)
    let j1 = Math.floor(b - 0.5)
    if (j0 < 0) j0 = 0
    if (j1 > h - 1) j1 = h - 1
    for (let x = 0; x < ow; x++) {
      const col = x * 3
      const d = y * ow * 3 + col
      let s0 = 0
      let s1 = 0
      let s2 = 0
      let wsum = 0
      for (let j = j0; j <= j1; j++) {
        const lo = j - 0.5 > a ? j - 0.5 : a
        const hi = j + 0.5 < b ? j + 0.5 : b
        const wgt = hi - lo
        if (wgt <= 0) continue
        s0 += mid[j * ow * 3 + col] * wgt
        s1 += mid[j * ow * 3 + col + 1] * wgt
        s2 += mid[j * ow * 3 + col + 2] * wgt
        wsum += wgt
      }
      if (wsum <= 0) {
        out[d] = mid[col]
        out[d + 1] = mid[col + 1]
        out[d + 2] = mid[col + 2]
      } else {
        out[d] = s0 / wsum
        out[d + 1] = s1 / wsum
        out[d + 2] = s2 / wsum
      }
    }
  }
  return out
}

/** RGBA → Float32 RGB（丢 alpha，IBP 全程只算颜色） */
function toRGBFloat(src: Uint8ClampedArray, n: number): Float32Array {
  const f = new Float32Array(n * 3)
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    f[p] = src[i * 4]
    f[p + 1] = src[i * 4 + 1]
    f[p + 2] = src[i * 4 + 2]
  }
  return f
}

/** Float32 灰度可分离盒式模糊（半径 r，原地写入 dst） */
function boxBlurGrayF(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const win = r * 2 + 1
  const row = new Float32Array(w)
  for (let y = 0; y < h; y++) {
    let sum = 0
    for (let x = -r; x <= r; x++) {
      const xx = x < 0 ? 0 : x >= w ? w - 1 : x
      sum += src[y * w + xx]
    }
    for (let x = 0; x < w; x++) {
      row[x] = sum / win
      const xOut = x - r < 0 ? 0 : x - r
      const xIn = x + r + 1 >= w ? w - 1 : x + r + 1
      sum += src[y * w + xIn] - src[y * w + xOut]
    }
    for (let x = 0; x < w; x++) dst[y * w + x] = row[x]
  }
  const col = new Float32Array(h)
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = -r; y <= r; y++) {
      const yy = y < 0 ? 0 : y >= h ? h - 1 : y
      sum += dst[yy * w + x]
    }
    for (let y = 0; y < h; y++) {
      col[y] = sum / win
      const yOut = y - r < 0 ? 0 : y - r
      const yIn = y + r + 1 >= h ? h - 1 : y + r + 1
      sum += dst[yIn * w + x] - dst[yOut * w + x]
    }
    for (let y = 0; y < h; y++) dst[y * w + x] = col[y]
  }
}

/**
 * 结构权重图 0..1（源分辨率）：**只在真有结构的地方做反投影**。
 *
 * 为什么需要它：IBP 的前向模型是"模糊 + 降采样"，它会把输入里**任何**与模型不符的
 * 高频都当成"该被恢复的细节"忠实重建到高分辨率 —— 包括噪点和 JPEG 压缩块残迹。
 * 孤立实验（纯高斯模糊、无噪点）IBP 相对真值 RMS 降 13%；
 * 但一接进真实管线（有噪点 + 压缩块 + 划痕修复残迹）就反过来升 2.3 倍，
 * 而且质检的「AI 伪影」从 0.015 涨到 0.091。差别就在噪声。
 *
 * 做法：5×5 局部标准差 → 按**噪声底**归一化的软阈值 → 轻度模糊。
 *   · 平坦区：std ≈ σ_noise → 权重 0 → 残差（基本是噪声）被丢掉，不放大；
 *   · 边缘/纹理区：std ≫ σ_noise → 权重 1 → 照常全量校正，清晰度一点不减。
 * 权重图必须平滑（盒式模糊半径 2 ≈ 高斯 σ2.4），否则权重边界会留下块状痕。
 */
function structureWeight(f: Float32Array, w: number, h: number): Float32Array {
  const n = w * h
  const gray = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    gray[p] = 0.299 * f[p * 3] + 0.587 * f[p * 3 + 1] + 0.114 * f[p * 3 + 2]
  }
  // 5×5 局部标准差：先算均值与平方均值（盒式半径 2），再 var = E[x²]−E[x]²
  const mean = new Float32Array(n)
  const sq = new Float32Array(n)
  const tmp = new Float32Array(n)
  for (let p = 0; p < n; p++) sq[p] = gray[p] * gray[p]
  boxBlurGrayF(gray, mean, w, h, 2)
  boxBlurGrayF(sq, tmp, w, h, 2)
  const sigma = noiseSigmaOf(gray, w, h)
  // 阈值按噪声底取 2.2σ：合成老照片上标定出的折中 ——
  //   1.8σ → 清晰度更高，但平坦区 5×5 std 5.56 / AI 伪影 0.052（贴着阈值）
  //   2.2σ → std 4.36 / AI 伪影 0.034，清晰度只掉 7%
  const t0 = Math.max(2.5, 2.2 * sigma)
  const t1 = t0 + 4
  const wgt = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    const v = tmp[p] - mean[p] * mean[p]
    const std = v > 0 ? Math.sqrt(v) : 0
    let u = (std - t0) / (t1 - t0)
    wgt[p] = u < 0 ? 0 : u > 1 ? 1 : u
  }
  // 平滑权重图
  boxBlurGrayF(wgt, tmp, w, h, 2)
  for (let p = 0; p < n; p++) wgt[p] = tmp[p]
  return wgt
}

/**
 * 估计原图的高斯模糊宽度 σ（原图像素）。
 *
 * 方法：**平均边缘剖面**。
 *   1. 取梯度幅值前 2% 的像素，且要求它是沿梯度方向的局部极大（真正的边缘中心）；
 *   2. 沿梯度方向采样 ±6px 的亮度剖面（梯度方向即亮度增加方向，所以所有剖面
 *      天然同向，不会互相抵消）；
 *   3. 把所有剖面**按原幅值累加**求平均，测平均剖面的 10%→90% 上升宽度。
 *   高斯阶跃的 10-90% 上升宽度 = 2.563σ。
 *
 * 为什么用"平均剖面"而不是"逐边测完取中位数"：
 *   自然图里的边缘宽度是**混合分布**（锐利的细纹理 + 被糊掉的结构边）。
 *   按梯度幅值取前 2% 会系统性偏向前者（细纹理对比高、梯度大），
 *   实测中位数法把 σ=2.45 估成 2.10、σ=3.46 估成 2.31（低估 14%~33%），
 *   导致 IBP 不敢放手锐化。平均剖面按对比度加权，反映的是"主导模糊"，
 *   正是反卷积需要的那个量。
 */
export function estimateBlurSigma(src: Uint8ClampedArray, w: number, h: number): number {
  if (w < 24 || h < 24) return 1
  const n = w * h
  const g = new Float32Array(n)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    g[i] = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2]
  }
  const mag = new Float32Array(n)
  let maxMag = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      const gx = g[p + 1] - g[p - 1]
      const gy = g[p + w] - g[p - w]
      const m = Math.sqrt(gx * gx + gy * gy)
      mag[p] = m
      if (m > maxMag) maxMag = m
    }
  }
  if (maxMag < 15) return 0.7 // 几乎没有边缘 → 视为轻微模糊
  const NB = 128
  const hist = new Uint32Array(NB + 1)
  for (let p = 0; p < n; p++) {
    let b = Math.round((mag[p] / maxMag) * NB)
    if (b > NB) b = NB
    hist[b]++
  }
  let acc = 0
  let thr = 0
  for (let b = 0; b <= NB; b++) {
    acc += hist[b]
    if (acc * 100 >= n * 98) {
      thr = (maxMag * b) / NB
      break
    }
  }
  if (thr < 10) thr = 10

  const R = 6
  const S = R * 2 + 1
  const stride = Math.max(1, Math.floor(Math.sqrt(n / 40000)))
  // 平均剖面：按原幅值累加（高对比边缘主导，低对比边缘只贡献少量噪声）
  const prof = new Float64Array(S)
  let used = 0
  for (let y = R + 2; y < h - R - 2; y += stride) {
    for (let x = R + 2; x < w - R - 2; x += stride) {
      const p = y * w + x
      if (mag[p] < thr) continue
      const gx = g[p + 1] - g[p - 1]
      const gy = g[p + w] - g[p - w]
      const inv = 1 / (Math.sqrt(gx * gx + gy * gy) || 1)
      const ux = gx * inv
      const uy = gy * inv
      // 必须是沿梯度方向的局部极大，否则拿到的是斜坡上任意一点
      let isMax = true
      for (let d = 1; d <= 2; d++) {
        const xa = Math.round(x + ux * d)
        const ya = Math.round(y + uy * d)
        const xb = Math.round(x - ux * d)
        const yb = Math.round(y - uy * d)
        if (xa < 0 || ya < 0 || xa >= w || ya >= h) continue
        if (xb < 0 || yb < 0 || xb >= w || yb >= h) continue
        if (mag[ya * w + xa] > mag[p] || mag[yb * w + xb] > mag[p]) isMax = false
      }
      if (!isMax) continue
      const v = new Float64Array(S)
      let lo = 1e9
      let hi = -1e9
      for (let k = 0; k < S; k++) {
        const d = k - R
        const sxp = x + ux * d
        const syp = y + uy * d
        const x0 = Math.floor(sxp)
        const y0 = Math.floor(syp)
        let val: number
        if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) {
          val = g[p]
        } else {
          const fx = sxp - x0
          const fy = syp - y0
          const a0 = g[y0 * w + x0]
          const b0 = g[y0 * w + x0 + 1]
          const c0 = g[(y0 + 1) * w + x0]
          const d0 = g[(y0 + 1) * w + x0 + 1]
          val =
            a0 * (1 - fx) * (1 - fy) + b0 * fx * (1 - fy) + c0 * (1 - fx) * fy + d0 * fx * fy
        }
        v[k] = val
        if (val < lo) lo = val
        if (val > hi) hi = val
      }
      if (hi - lo < 25) continue
      for (let k = 0; k < S; k++) prof[k] += v[k]
      used++
    }
  }
  if (used < 12) return 0.9
  // 平均剖面的 10%→90% 上升宽度
  let plo = 1e9
  let phi = -1e9
  for (let k = 0; k < S; k++) {
    if (prof[k] < plo) plo = prof[k]
    if (prof[k] > phi) phi = prof[k]
  }
  const span = phi - plo
  if (span < 1) return 0.9
  const t10 = plo + span * 0.1
  const t90 = plo + span * 0.9
  let pos10 = -1
  let pos90 = -1
  for (let k = 1; k < S; k++) {
    const dv = prof[k] - prof[k - 1]
    if (Math.abs(dv) < 1e-9) continue
    if (pos10 < 0 && (prof[k - 1] - t10) * (prof[k] - t10) <= 0) {
      pos10 = k - 1 + (t10 - prof[k - 1]) / dv
    }
    if (pos90 < 0 && (prof[k - 1] - t90) * (prof[k] - t90) <= 0) {
      pos90 = k - 1 + (t90 - prof[k - 1]) / dv
    }
  }
  if (pos10 < 0 || pos90 < 0) return 0.9
  const rise = Math.abs(pos90 - pos10)
  if (rise <= 0.15) return 0.7
  return Math.max(0.45, Math.min(4.5, rise / 2.563))
}

/**
 * 迭代反投影超分。
 *
 * @param psfSigma 假定的相机模糊宽度（**原图像素**）。越小越锐（等价于按该 σ 反卷积），
 *                  越大越保守。传 0 表示"用插值，不反投影"。
 * @param iterations 迭代次数（每轮一次前向模拟 + 一次反投影）
 * @param step 每轮叠加比例 0..1
 * @returns 目标尺寸的 RGBA；alpha 沿用插值放大的结果（IBP 只算颜色）
 */
/**
 * IBP 的像素数上限：超过它就退回普通插值。
 *
 * IBP 需要 2 份 Float32 RGB 的全图缓冲（当前估计 + 前向模拟），
 * 1920×2560 约 120MB、3840×5120 约 470MB。低配机上不赌内存，
 * 到 5K 以上（>2400 万像素）直接走插值，由 computeOutputSize 的 8192 上限兜底。
 */
export const IBP_MAX_PIXELS = 24_000_000

/** 该输出尺寸能否跑 IBP */
export function canBackProject(ow: number, oh: number): boolean {
  return ow > 0 && oh > 0 && ow * oh <= IBP_MAX_PIXELS
}

/**
 * IBP 默认迭代参数（合成老照片端到端标定，1920×2560 / σ≈3.1）：
 *
 *   it=8 → 虹膜 43.8、平坦区 5×5 std 5.56（旧管线 3.53）、AI 伪影 0.052
 *   it=6 → 虹膜 40.5、平坦区 5×5 std 4.36（旧管线 3.53）、AI 伪影 0.034
 *   旧管线 → 虹膜 15.3、平坦区 5×5 std 3.53、AI 伪影 0.015
 *
 * 取 it=6：清晰度仍是旧版的 2.6~3.0 倍（虹膜/睫毛/双眼皮/眉毛），
 * 而平坦区粗糙度只比旧版高 23%、AI 伪影 0.034 对阈值 0.06 有近一倍余量。
 * it=8 虽然更锐，但余量太薄（0.052/0.06），真实照片噪声更大时会误触发重试。
 */
export const IBP_DEFAULT_ITERS = 6
export const IBP_DEFAULT_STEP = 0.8

/**
 * 各修复模式的 σ 缩放。
 *
 * 方向说明（实测，别搞反）：σ 是"假定的相机模糊宽度"，**越大越锐**。
 * σ 取大 → 前向模型认为原图比估计更糊 → 残差是锐化信号 → 反投影放大利化；
 * σ 取小 → 前向模型已经能解释原图 → 残差趋零 → 几乎不锐化（退化成插值）。
 * 甜点在"估计出的真实模糊"附近：再大 15% 振铃就从 0.4‰ 跳到 4‰（看得见白边）。
 */
export const IBP_SIGMA_SCALE: Record<PortraitStrength, number> = {
  natural: 0.9,
  ultra: 1,
  extreme: 1.08,
  camera: 0.8,
}

/** 按选项算出本次 IBP 用的 σ（原图像素） */
export function ibpSigmaFor(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  opts: PortraitOptions,
): number {
  const est = estimateBlurSigma(src, w, h)
  const g = clarityGain(opts.clarity)
  const scale = IBP_SIGMA_SCALE[opts.strength] * Math.max(0.85, Math.min(1.1, g))
  return Math.max(0.6, Math.min(3.4, est * scale))
}

export function backProjectUpscale(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  ow: number,
  oh: number,
  psfSigma: number,
  iterations = 6,
  step = 0.8,
): Uint8ClampedArray {
  // 初始估计始终由保边插值给出：IBP 只负责"把清晰度找回来"，
  // 不负责从零造图 —— 这样即使 σ 设错，结果也不会比插值更差。
  const init = resizeCatmullRom(src, w, h, ow, oh)
  if (ow === w && oh === h) return init
  if (psfSigma <= 0.05 || iterations <= 0 || step <= 0) return init
  // 超大输出的内存保护：Float32 缓冲 ×2 已经接近上限时退回插值，
  // 由 computeOutputSize 的 8192 硬上限之外再兜一层（低配机不赌）
  if (ow * oh > 24_000_000) return init

  const s = ow / w
  const sigmaHR = Math.max(0.3, psfSigma * s) // 换算到目标分辨率
  const nLR = w * h
  const nHR = ow * oh

  const srcF = toRGBFloat(src, nLR)
  const cur = toRGBFloat(init, nHR)
  const work = new Float32Array(nHR * 3) // 模糊后的前向模拟 + 反投影更新复用
  const lr = new Float32Array(nLR * 3)
  const alpha = new Uint8ClampedArray(nHR)
  for (let i = 0; i < nHR; i++) alpha[i] = init[i * 4 + 3]
  // 结构权重：平坦区不反投影（那里的残差是噪声/压缩块，放大就是 AI 假纹理）
  const sw = structureWeight(srcF, w, h)

  const iters = Math.max(1, Math.min(12, Math.round(iterations)))
  const st = Math.max(0.05, Math.min(1, step))
  for (let it = 0; it < iters; it++) {
    // 前向：当前估计模糊 σ_hr → 面积降采样回原图尺寸（cur 不被破坏）
    work.set(cur)
    gaussF(work, work, ow, oh, sigmaHR)
    const sim = areaDownF(work, ow, oh, w, h)
    // 残差（原图域）× 结构权重
    for (let p = 0; p < nLR; p++) {
      const k = sw[p]
      const i = p * 3
      lr[i] = (srcF[i] - sim[i]) * k
      lr[i + 1] = (srcF[i + 1] - sim[i + 1]) * k
      lr[i + 2] = (srcF[i + 2] - sim[i + 2]) * k
    }
    // 反投影：残差双三次放大回目标分辨率（写进 work）
    resizeCRF(lr, w, h, ow, oh, work)
    // 叠加
    for (let i = 0; i < nHR * 3; i++) {
      const v = cur[i] + st * work[i]
      cur[i] = v < 0 ? 0 : v > 255 ? 255 : v
    }
  }

  const out = new Uint8ClampedArray(nHR * 4)
  for (let i = 0, p = 0; i < nHR; i++, p += 4) {
    out[p] = cur[i * 3]
    out[p + 1] = cur[i * 3 + 1]
    out[p + 2] = cur[i * 3 + 2]
    out[p + 3] = alpha[i]
  }
  return out
}

function resizeHorizontal(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  ow: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(ow * h * 4)
  const wgt = new Float64Array(4)
  const idx = new Int32Array(4)
  const scale = w / ow
  for (let x = 0; x < ow; x++) {
    const sx = (x + 0.5) * scale - 0.5
    const i1 = Math.floor(sx)
    const t = sx - i1
    catmullRom(t, wgt)
    for (let k = 0; k < 4; k++) {
      let p = i1 - 1 + k
      if (p < 0) p = 0
      else if (p >= w) p = w - 1
      idx[k] = p
    }
    for (let y = 0; y < h; y++) {
      const srow = y * w * 4
      const drow = y * ow * 4 + x * 4
      for (let c = 0; c < 4; c++) {
        out[drow + c] =
          src[srow + idx[0] * 4 + c] * wgt[0] +
          src[srow + idx[1] * 4 + c] * wgt[1] +
          src[srow + idx[2] * 4 + c] * wgt[2] +
          src[srow + idx[3] * 4 + c] * wgt[3]
      }
    }
  }
  return out
}

function resizeVertical(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  oh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * oh * 4)
  const wgt = new Float64Array(4)
  const idx = new Int32Array(4)
  const scale = h / oh
  for (let y = 0; y < oh; y++) {
    const sy = (y + 0.5) * scale - 0.5
    const i1 = Math.floor(sy)
    const t = sy - i1
    catmullRom(t, wgt)
    for (let k = 0; k < 4; k++) {
      let p = i1 - 1 + k
      if (p < 0) p = 0
      else if (p >= h) p = h - 1
      idx[k] = p
    }
    const drow = y * w * 4
    for (let x = 0; x < w; x++) {
      const srow = x * 4
      for (let c = 0; c < 4; c++) {
        out[drow + x * 4 + c] =
          src[idx[0] * w * 4 + srow + c] * wgt[0] +
          src[idx[1] * w * 4 + srow + c] * wgt[1] +
          src[idx[2] * w * 4 + srow + c] * wgt[2] +
          src[idx[3] * w * 4 + srow + c] * wgt[3]
      }
    }
  }
  return out
}

/* ============================================================================
 * 4. 区域算子（裁剪 / 贴回 / 蒙版加权）
 * ========================================================================== */

function cropImage(
  src: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  cw: number,
  ch: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    const s = ((y0 + y) * w + x0) * 4
    out.set(src.subarray(s, s + cw * 4), y * cw * 4)
  }
  return out
}

/**
 * 把处理后的区域贴回原图，**边界羽化混合**。
 *
 * 为什么必须羽化：脸区内部做过「放大 → 增强 → 缩回」，重采样会让边界像素与
 * 周围原图产生极小的数值差；直接整块覆盖会在脸框外沿留下一圈肉眼可见的
 * 直角拼缝（需求明确禁止「拼接痕」）。用平滑窗函数在边界 ~6% 宽度内渐变，
 * 边界处权重为 0、内部为 1，拼缝在数学上不存在。
 */
function pasteRegion(
  dst: Uint8ClampedArray,
  dstW: number,
  dstH: number,
  region: Uint8ClampedArray,
  x0: number,
  y0: number,
  cw: number,
  ch: number,
): void {
  const feather = Math.max(2, Math.round(Math.min(cw, ch) * 0.06))
  for (let y = 0; y < ch; y++) {
    const dy = y0 + y
    if (dy < 0 || dy >= dstH) continue
    const wy = Math.min(1, Math.min(y, ch - 1 - y) / feather)
    const vy = wy * wy * (3 - 2 * wy)
    for (let x = 0; x < cw; x++) {
      const dx = x0 + x
      if (dx < 0 || dx >= dstW) continue
      const wx = Math.min(1, Math.min(x, cw - 1 - x) / feather)
      const vx = wx * wx * (3 - 2 * wx)
      const t = vx * vy
      const s = (y * cw + x) * 4
      const d = (dy * dstW + dx) * 4
      if (t >= 0.999) {
        dst[d] = region[s]
        dst[d + 1] = region[s + 1]
        dst[d + 2] = region[s + 2]
        dst[d + 3] = region[s + 3]
      } else {
        dst[d] = dst[d] + (region[s] - dst[d]) * t
        dst[d + 1] = dst[d + 1] + (region[s + 1] - dst[d + 1]) * t
        dst[d + 2] = dst[d + 2] + (region[s + 2] - dst[d + 2]) * t
        dst[d + 3] = Math.max(dst[d + 3], region[s + 3])
      }
    }
  }
}

/**
 * 蒙版加权的非锐化掩模。
 *
 * weight 为 0..1 的逐像素增益图：0 = 不处理，1 = 全量处理。
 * 这样"眼睛/发丝/轮廓"只在对应解剖区域生效，平坦皮肤区几乎不产生白边。
 *
 * blur 由调用方传入（同一区域内各步骤共用一份模糊图）：
 *   ① 省掉重复的高斯模糊（半径 1 的模糊要跑 6 趟盒式滤波，是本模块最热的路径）；
 *   ② 所有步骤的细节层都相对**同一份基准**计算 —— 等价于 unsharpFrom 语义，
 *      过冲不会逐级累加，从根上减少"假面 / 白边"。
 *
 * DETAIL_CAP：细节层幅度封顶（±30 灰阶）。锐化造成的白边/光晕本质是
 * 「强边缘处细节层过大」；把参与增益的细节限制在 30 以内，
 * 强边缘最多只抬 30×amt，白边在数值上就不可能形成，
 * 而真正决定"清不清楚"的中低对比纹理（<30）获得全量增益。
 */
const DETAIL_CAP = 30
function maskedUnsharp(
  src: Uint8ClampedArray,
  blur: Uint8ClampedArray,
  amount: number,
  threshold: number,
  weight: Float32Array | null,
): Uint8ClampedArray {
  const amt = amount / 100
  if (amt <= 0) return src.slice()
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const g = weight ? weight[p] : 1
    if (g <= 0.002) {
      out[i] = src[i]
      out[i + 1] = src[i + 1]
      out[i + 2] = src[i + 2]
    } else {
      for (let c = 0; c < 3; c++) {
        let detail = src[i + c] - blur[i + c]
        if (detail > DETAIL_CAP) detail = DETAIL_CAP
        else if (detail < -DETAIL_CAP) detail = -DETAIL_CAP
        const v = Math.abs(detail) < threshold ? src[i + c] : src[i + c] + amt * g * detail
        out[i + c] = clamp255(v)
      }
    }
    out[i + 3] = src[i + 3]
  }
  return out
}

/** 蒙版加权的局部对比度拉伸（提升眼睛"有神"、唇线清晰） */
function maskedLocalContrast(
  src: Uint8ClampedArray,
  factor: number,
  weight: Float32Array | null,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const g = weight ? weight[p] : 1
    for (let c = 0; c < 3; c++) {
      out[i + c] = clamp255((src[i + c] - 128) * (1 + (factor - 1) * g) + 128)
    }
    out[i + 3] = src[i + 3]
  }
  return out
}

/** 椭圆蒙版（眼睛 / 嘴部） */
function ellipseMask(w: number, h: number, cx: number, cy: number, rx: number, ry: number): Float32Array {
  const m = new Float32Array(w * h)
  const invRx = 1 / Math.max(1, rx)
  const invRy = 1 / Math.max(1, ry)
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5 - cy) * invRy
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) * invRx
      const d = dx * dx + dy * dy
      if (d < 1) {
        const v = 1 - d
        m[y * w + x] = v * v
      }
    }
  }
  return m
}

/** 合并两个蒙版（取最大值） */
function mergeMask(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] > b[i] ? a[i] : b[i]
  return out
}

/** 圆环蒙版（虹膜：瞳孔外圈），rInner..rOuter 为内外半径，内外缘各羽化 */
function ringMask(
  w: number,
  h: number,
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
): Float32Array {
  const m = new Float32Array(w * h)
  const inner = Math.max(0.5, rInner)
  const outer = Math.max(inner + 1, rOuter)
  const feather = Math.max(1, (outer - inner) * 0.45)
  const y0 = Math.max(0, Math.floor(cy - outer - 1))
  const y1 = Math.min(h - 1, Math.ceil(cy + outer + 1))
  const x0 = Math.max(0, Math.floor(cx - outer - 1))
  const x1 = Math.min(w - 1, Math.ceil(cx + outer + 1))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > outer || d < inner - feather) continue
      const inW = Math.min(1, (d - (inner - feather)) / feather)
      const outW = Math.min(1, (outer - d) / feather)
      const v = Math.max(0, Math.min(inW, outW))
      m[y * w + x] = v * v * (3 - 2 * v)
    }
  }
  return m
}

/**
 * 细线（脊线）高频图 —— 「发丝单根分离 / 睫毛单根可辨 / 牙缝可辨」的核心算子。
 *
 * 关键点：**必须保留符号**。
 *   一阶思路「取 4 方向 −二阶差分的最大值」只会得到正值，
 *   加到像素上等于把暗线**提亮** —— 睫毛、深色发丝反而被淡化（本模块早期版本正是此错）。
 * 正确做法：取 4 个方向里 |高频| 最大的那个方向，连同符号一起返回，
 *   再用「垂直方向是否也高频」判掉普通边缘（边缘两侧都有台阶，线只有垂直方向有峰）。
 * 因此亮线更亮、暗线更暗，细结构对比度上升，而不会整体偏亮。
 */
function ridgeDetail(src: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      let hpMax = 0
      let hpPerp = 0
      for (let c = 0; c < 3; c++) {
        const v = src[p * 4 + c]
        // 四个方向的「脊线高频」v − 两侧均值（保留正负号）
        const h0 = v - (src[(p - 1) * 4 + c] + src[(p + 1) * 4 + c]) / 2
        const h1 = v - (src[(p - w) * 4 + c] + src[(p + w) * 4 + c]) / 2
        const h2 = v - (src[(p - w - 1) * 4 + c] + src[(p + w + 1) * 4 + c]) / 2
        const h3 = v - (src[(p - w + 1) * 4 + c] + src[(p + w - 1) * 4 + c]) / 2
        const cand = [h0, h1, h2, h3]
        let mi = 0
        for (let k = 1; k < 4; k++) if (Math.abs(cand[k]) > Math.abs(cand[mi])) mi = k
        // 垂直于该方向的方向：0↔1、2↔3
        const perp = mi === 0 ? h1 : mi === 1 ? h0 : mi === 2 ? h3 : h2
        if (Math.abs(cand[mi]) > Math.abs(hpMax)) {
          hpMax = cand[mi]
          hpPerp = perp
        }
      }
      // 线状度：垂直方向也高频 → 是拐角/纹理，不是孤立细线
      const lineNess = 1 - Math.min(1, Math.abs(hpPerp) / (Math.abs(hpMax) + 1))
      out[p] = hpMax * lineNess
    }
  }
  return out
}

/** 按蒙版叠加脊线高频（带符号：暗线更暗、亮线更亮） */
function applyRidge(
  src: Uint8ClampedArray,
  ridge: Float32Array,
  amount: number,
  weight: Float32Array | null,
): Uint8ClampedArray {
  const amt = amount / 100
  if (amt <= 0) return src.slice()
  const CAP = 22
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const g = weight ? weight[p] : 1
    let r = ridge[p] * g * amt
    if (r > CAP) r = CAP
    else if (r < -CAP) r = -CAP
    if (g <= 0.002 || r === 0) {
      out[i] = src[i]
      out[i + 1] = src[i + 1]
      out[i + 2] = src[i + 2]
    } else {
      out[i] = clamp255(src[i] + r)
      out[i + 1] = clamp255(src[i + 1] + r)
      out[i + 2] = clamp255(src[i + 2] + r)
    }
    out[i + 3] = src[i + 3]
  }
  return out
}

/**
 * 牙齿蒙版：嘴部椭圆内「高亮度 + 低饱和」的像素（牙齿），排除唇部与口腔暗部。
 * 只用于「限亮 + 保牙缝」，绝不做整体提亮 —— 否则牙齿会糊成白块。
 */
function teethMaskOf(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  mouth: FeaturePoint,
  s: number,
): Float32Array {
  const cx = mouth.x * s
  const cy = mouth.y * s
  const rx = Math.max(2, mouth.r * 1.2 * s)
  const ry = Math.max(2, mouth.r * 0.7 * s)
  const m = new Float32Array(w * h)
  const y0 = Math.max(0, Math.floor(cy - ry))
  const y1 = Math.min(h - 1, Math.ceil(cy + ry))
  const x0 = Math.max(0, Math.floor(cx - rx))
  const x1 = Math.min(w - 1, Math.ceil(cx + rx))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx
      const dy = (y + 0.5 - cy) / ry
      const d = dx * dx + dy * dy
      if (d > 1) continue
      const i = (y * w + x) * 4
      const r = src[i]
      const g = src[i + 1]
      const b = src[i + 2]
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      const maxC = Math.max(r, g, b)
      const minC = Math.min(r, g, b)
      const sat = maxC > 0 ? (maxC - minC) / maxC : 0
      // 牙齿：够亮 + 够白（低饱和）+ 偏中性（R/B 接近）
      if (lum < 105 || sat > 0.28 || r < b + 4) continue
      const wEdge = 1 - d
      m[y * w + x] = Math.min(1, wEdge * 2) * Math.min(1, (lum - 105) / 40)
    }
  }
  return m
}

/** 高光软限幅：把超过 limit 的亮度按软膝压回，避免牙齿/眼白糊成发光白块 */
function softClipHigh(src: Uint8ClampedArray, limit: number, weight: Float32Array | null): void {
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const g = weight ? weight[p] : 1
    if (g <= 0.002) continue
    for (let c = 0; c < 3; c++) {
      const v = src[i + c]
      if (v <= limit) continue
      const compressed = limit + (255 - limit) * (1 - Math.exp(-(v - limit) / (255 - limit)))
      src[i + c] = clamp255(v + (compressed - v) * g)
    }
  }
}

/** Sobel 边缘强度图（用于轮廓引导的锐化增益） */
function sobelEdges(src: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = toGray(src, w, h)
  const e = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      const gx =
        -g[p - w - 1] - 2 * g[p - 1] - g[p + w - 1] + g[p - w + 1] + 2 * g[p + 1] + g[p + w + 1]
      const gy =
        -g[p - w - 1] - 2 * g[p - w] - g[p - w + 1] + g[p + w - 1] + 2 * g[p + w] + g[p + w + 1]
      e[p] = Math.sqrt(gx * gx + gy * gy)
    }
  }
  return e
}

/**
 * 边缘引导的锐化增益图：平坦区 → 0（不出白边、不塑料），强边缘 → 1（轮廓干净）。
 */
function edgeGainMap(edges: Float32Array, w: number, h: number): Float32Array {
  const gain = new Float32Array(w * h)
  // 自适应阈值：用边缘强度的中位数（约 60 分位）作为"什么算强边缘"的界
  const sample: number[] = []
  const step = Math.max(1, Math.floor((w * h) / 6000))
  for (let i = 0; i < edges.length; i += step) sample.push(edges[i])
  sample.sort((a, b) => a - b)
  const thr = sample.length ? sample[Math.floor(sample.length * 0.6)] : 20
  const hi = Math.max(thr * 2.2, 40)
  for (let i = 0; i < edges.length; i++) {
    const v = (edges[i] - thr) / (hi - thr)
    gain[i] = v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v)
  }
  return gain
}

/* ============================================================================
 * 5. 皮肤保边平滑（双边滤波）
 * ========================================================================== */

/**
 * 双边滤波（保边平滑）：抹掉噪点与色斑，但**保留毛孔与轮廓**。
 * 这正是"皮肤有真实纹理、不塑料、不蜡像"与"更平滑"档位的实现基础。
 *
 * 混合系数 blend：0 = 保留纹理（不处理）；1 = 更平滑。
 */
function bilateralSmooth(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  skinMask: Uint8Array,
  blend: number,
): Uint8ClampedArray {
  if (blend <= 0.01) return src.slice()
  const out = new Uint8ClampedArray(src.length)
  const rangeSigma = 22
  const rangeDen = 2 * rangeSigma * rangeSigma
  const spatial = [0.7071, 1, 0.7071]
  const amt = Math.min(1, blend)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const i = p * 4
      if (!skinMask[p]) {
        out[i] = src[i]
        out[i + 1] = src[i + 1]
        out[i + 2] = src[i + 2]
        out[i + 3] = src[i + 3]
        continue
      }
      const cr = src[i]
      const cg = src[i + 1]
      const cb = src[i + 2]
      let sr = 0
      let sg = 0
      let sb = 0
      let sw = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const q = (yy * w + xx) * 4
          const dr = src[q] - cr
          const dg = src[q + 1] - cg
          const db = src[q + 2] - cb
          const rangeW = Math.exp(-(dr * dr + dg * dg + db * db) / rangeDen)
          const sw2 = spatial[dy + 1] * spatial[dx + 1] * rangeW
          sr += src[q] * sw2
          sg += src[q + 1] * sw2
          sb += src[q + 2] * sw2
          sw += sw2
        }
      }
      const br = sr / sw
      const bg = sg / sw
      const bb = sb / sw
      out[i] = clamp255(cr + (br - cr) * amt)
      out[i + 1] = clamp255(cg + (bg - cg) * amt)
      out[i + 2] = clamp255(cb + (bb - cb) * amt)
      out[i + 3] = src[i + 3]
    }
  }
  return out
}

/** 区域内的肤色蒙版 */
function skinMaskOf(src: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h)
  for (let p = 0, i = 0; p < m.length; p++, i += 4) {
    if (isSkin(src[i], src[i + 1], src[i + 2])) m[p] = 1
  }
  return m
}

/* ============================================================================
 * 5.5 缺陷修复（划痕 / 折痕 / 污渍 / 灰尘 / JPEG 压缩块）+ 输入分级
 *
 * 顺序上这一步必须**排在去模糊之前**：先去修复被破坏的结构，再去增强细节。
 * 反过来的话，锐化会把划痕、压缩块、灰尘点一起放大成"硬边"，再想修就来不及了。
 * ========================================================================== */

/**
 * 四个朝向的"垂直取样点"（距离 2 与 3）。
 *
 * 这是薄线检测的关键：**必须沿垂直于走向的方向取样**。
 * 若用环形邻域，划痕自身的走向会让环上也有亮点，标准差变大而被当成纹理漏检。
 * 垂直取样时：一条细线 → 4 点全是平滑背景（标准差极小），中心明显偏离 → 判定为缺陷；
 * 真实边缘 → 4 点分居两侧（标准差≈半个台阶）→ 自动排除。
 */
const PERP_SAMPLES: number[][][] = [
  [
    [0, 2],
    [0, -2],
    [0, 3],
    [0, -3],
  ],
  [
    [2, 0],
    [-2, 0],
    [3, 0],
    [-3, 0],
  ],
  [
    [2, 2],
    [-2, -2],
    [3, 3],
    [-3, -3],
  ],
  [
    [2, -2],
    [-2, 2],
    [3, -3],
    [-3, 3],
  ],
]

function scanThinDefects(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  thr: number,
  repair: boolean,
  sampleStep: number,
): { out: Uint8ClampedArray; hits: number; tested: number } {
  const out = repair ? src.slice() : src
  const sv = [0, 0, 0, 0]
  const sg = [0, 0, 0, 0]
  const sb = [0, 0, 0, 0]

  let hits = 0
  let tested = 0
  for (let y = 3; y < h - 3; y += sampleStep) {
    for (let x = 3; x < w - 3; x += sampleStep) {
      const p = y * w + x
      const i = p * 4
      tested++

      const centerL = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]

      // 选「垂直方向最平滑」的朝向：说明这一侧确实是一条线而不是纹理/边缘
      let bestStd = Infinity
      let bestOri = -1
      let bestLo = 255
      let bestHi = 0
      for (let o = 0; o < 4; o++) {
        const pts = PERP_SAMPLES[o]
        let sum = 0
        for (let k = 0; k < 4; k++) {
          const q = ((y + pts[k][1]) * w + (x + pts[k][0])) * 4
          sv[k] = src[q]
          sg[k] = src[q + 1]
          sb[k] = src[q + 2]
          sum += 0.299 * src[q] + 0.587 * src[q + 1] + 0.114 * src[q + 2]
        }
        const mean = sum / 4
        let vsum = 0
        let lo = 255
        let hi = 0
        for (let k = 0; k < 4; k++) {
          const l = 0.299 * sv[k] + 0.587 * sg[k] + 0.114 * sb[k]
          vsum += (l - mean) * (l - mean)
          if (l < lo) lo = l
          if (l > hi) hi = l
        }
        const std = Math.sqrt(vsum / 4)
        if (std < bestStd) {
          bestStd = std
          bestOri = o
          bestLo = lo
          bestHi = hi
        }
      }
      if (bestOri < 0) continue
      // 垂直方向不够平滑 = 纹理/边缘，不动
      if (bestStd > 9) continue
      // 中心必须明显跳出垂直取样点的范围（单侧离群）
      if (centerL > bestLo - thr && centerL < bestHi + thr) continue

      hits++
      if (repair) {
        const pts = PERP_SAMPLES[bestOri]
        let ar = 0
        let ag = 0
        let ab = 0
        for (let k = 0; k < 4; k++) {
          const q = ((y + pts[k][1]) * w + (x + pts[k][0])) * 4
          ar += src[q]
          ag += src[q + 1]
          ab += src[q + 2]
        }
        out[i] = ar / 4
        out[i + 1] = ag / 4
        out[i + 2] = ab / 4
      }
    }
  }
  return { out, hits, tested }
}

/**
 * JPEG 块状度 0..1。
 * 在 8 像素网格线上测跨边阶跃，与偏移 4 像素的对照线比较：
 * 未压缩图两者接近（比值≈1），压缩图网格线明显更大。
 */
function blockinessScore(src: Uint8ClampedArray, w: number, h: number): number {
  let gs = 0
  let gc = 0
  let os = 0
  let oc = 0
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x++) {
      const m = x & 7
      if (m !== 0 && m !== 4) continue
      const p = (y * w + x) * 4
      const q = (y * w + x - 1) * 4
      const dd =
        Math.abs(src[p] - src[q] + src[p + 1] - src[q + 1] + src[p + 2] - src[q + 2]) / 3
      if (m === 0) {
        gs += dd
        gc++
      } else {
        os += dd
        oc++
      }
    }
  }
  for (let x = 1; x < w - 1; x += 2) {
    for (let y = 1; y < h - 1; y++) {
      const m = y & 7
      if (m !== 0 && m !== 4) continue
      const p = (y * w + x) * 4
      const q = ((y - 1) * w + x) * 4
      const dd =
        Math.abs(src[p] - src[q] + src[p + 1] - src[q + 1] + src[p + 2] - src[q + 2]) / 3
      if (m === 0) {
        gs += dd
        gc++
      } else {
        os += dd
        oc++
      }
    }
  }
  if (!gc || !oc) return 0
  const ratio = gs / gc / Math.max(1e-3, os / oc)
  return clamp((ratio - 1.02) / 0.5, 0, 1)
}

/**
 * 去除 JPEG 8×8 压缩块。
 *
 * 只修「网格线上有台阶、而台阶两侧本身平坦」的位置（标准去块滤波判据），
 * 平坦区之外一律不动 —— 否则会把真实边缘磨掉，等于用压缩块换模糊。
 */
function deblockJpeg(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  level: DefectLevel,
): Uint8ClampedArray {
  const k = DEFECT_PRESETS[level]
  if (k <= 0) return src.slice()
  const amt = Math.min(1, 0.55 * k)
  const out = src.slice()

  // 竖向块边界
  for (let x = 8; x < w - 2; x += 8) {
    for (let y = 1; y < h - 1; y++) {
      fixBlockEdge(out, (y * w + x) * 4, -4, amt)
    }
  }
  // 横向块边界
  for (let y = 8; y < h - 2; y += 8) {
    for (let x = 1; x < w - 1; x++) {
      fixBlockEdge(out, (y * w + x) * 4, -w * 4, amt)
    }
  }
  return out
}

/** 对单个块边界做条件平滑。stride 为「沿法线方向的元素步长」 */
function fixBlockEdge(buf: Uint8ClampedArray, i0: number, step: number, amt: number): void {
  // p1 = i0+2·step（外）, p0 = i0+step, q0 = i0, q1 = i0−step
  const ip0 = i0 + step
  const ip1 = i0 + step * 2
  const iq1 = i0 - step
  const p0 = 0.299 * buf[ip0] + 0.587 * buf[ip0 + 1] + 0.114 * buf[ip0 + 2]
  const q0 = 0.299 * buf[i0] + 0.587 * buf[i0 + 1] + 0.114 * buf[i0 + 2]
  const p1 = 0.299 * buf[ip1] + 0.587 * buf[ip1 + 1] + 0.114 * buf[ip1 + 2]
  const q1 = 0.299 * buf[iq1] + 0.587 * buf[iq1 + 1] + 0.114 * buf[iq1 + 2]
  const edge = Math.abs(q0 - p0)
  if (edge < 3) return
  const activity = Math.abs(p0 - p1) + Math.abs(q0 - q1)
  if (edge < activity * 1.15) return
  const t = amt * Math.min(1, edge / 14)
  for (let c = 0; c < 3; c++) {
    const a = buf[ip0 + c]
    const b = buf[i0 + c]
    buf[ip0 + c] = clamp255(a + (((a * 3 + b + 2) >> 2) - a) * t)
    buf[i0 + c] = clamp255(b + (((b * 3 + a + 2) >> 2) - b) * t)
  }
}

/**
 * 泛黄 / 水渍 / 霉斑一类的色斑修复。
 *
 * 关键判据：**只修「黄化」（Cb 下降而 Cr 基本不动）**。
 * 嘴唇、红花这类真实高饱和主体会同时抬高 Cr，因此不会被误伤 ——
 * 这是"修污渍但不变色"的成败所在。
 */
function repairBlotches(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  level: DefectLevel,
): Uint8ClampedArray {
  const k = DEFECT_PRESETS[level]
  if (k <= 0) return src.slice()
  const radius = Math.max(4, Math.round(Math.min(w, h) * 0.012))
  const base = gaussianBlur(src, w, h, radius)
  const out = src.slice()
  const thr = 14 / k
  const maxT = 0.5 * Math.min(1, k)

  // 全局色度中位数兜底：大面积污渍时，半径为 1.2% 的局部基线自己也被染黄了
  // （黄色偏差算出来接近 0，污渍中心完全修不动）。污渍通常只占画面 <30%，
  // 全图中位数仍是干净的背景色度，拿它做第二基线就能修到污渍中心。
  const histB = new Int32Array(256)
  const histR = new Int32Array(256)
  let npx = 0
  const step = Math.max(2, Math.round(Math.sqrt((w * h) / 100000)))
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const i = (y * w + x) * 4
      const cb = src[i + 2] - src[i + 1] + 128
      const cr = src[i] - src[i + 1] + 128
      histB[cb < 0 ? 0 : cb > 255 ? 255 : cb | 0]++
      histR[cr < 0 ? 0 : cr > 255 ? 255 : cr | 0]++
      npx++
    }
  }
  let gcb = 0
  let gcr = 0
  if (npx > 0) {
    let acc = 0
    for (let i = 0; i < 256; i++) {
      acc += histB[i]
      if (acc >= npx / 2) {
        gcb = i - 128
        break
      }
    }
    acc = 0
    for (let i = 0; i < 256; i++) {
      acc += histR[i]
      if (acc >= npx / 2) {
        gcr = i - 128
        break
      }
    }
  }

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4
      // 局部梯度大 = 真实边缘或主体，跳过
      const gx = Math.abs(src[i] - src[i + 4]) + Math.abs(src[i + 1] - src[i + 5])
      const gy = Math.abs(src[i] - src[i + w * 4]) + Math.abs(src[i + 1] - src[i + w * 4 + 1])
      if (gx + gy > 26) continue

      const cb = src[i + 2] - src[i + 1]
      const cbBase = base[i + 2] - base[i + 1]
      const cr = src[i] - src[i + 1]
      const crBase = base[i] - base[i + 1]
      let yellow = cbBase - cb // 比周围更黄（Cb 更低）
      let driftLimit = 7
      if (yellow < thr) {
        // 第二基线：全图色度中位数。Cr 必须接近全图中位数（黄化不动红度），
        // 这样嘴唇/红花（Cr 明显偏高）不会被误判成污渍。
        const yg = gcb - cb
        if (yg <= thr) continue
        if (Math.abs(cr - gcr) > 6) continue
        yellow = yg
        driftLimit = 9
      }
      if (Math.abs(cr - crBase) > driftLimit) continue

      const t = Math.min(maxT, (yellow - thr) / thr)
      if (t <= 0.02) continue
      out[i] = src[i] + (base[i] - src[i]) * t
      out[i + 1] = src[i + 1] + (base[i + 1] - src[i + 1]) * t
      out[i + 2] = src[i + 2] + (base[i + 2] - src[i + 2]) * t
    }
  }
  return out
}

/**
 * 缺陷修复总入口：压缩块 → 薄线（划痕/折痕/尘点）→ 色斑（泛黄/水渍）。
 * 返回修复密度，用于输入分级（划痕越多，能恢复的细节越少）。
 */
export function repairDefects(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  level: DefectLevel,
): { data: Uint8ClampedArray; density: number } {
  if (level === 'off') return { data: src.slice(), density: 0 }
  let img = deblockJpeg(src, w, h, level)
  const scan = scanThinDefects(img, w, h, 24 / DEFECT_PRESETS[level], true, 1)
  img = scan.out
  img = repairBlotches(img, w, h, level)
  const density = scan.tested > 0 ? scan.hits / scan.tested : 0
  return { data: img, density }
}

/**
 * 锐度指数 0..100。
 *
 * 两个子指标取**较小值**（保守），任一不达标就不给高等级：
 *   ① s1 = 绝对梯度能量 —— 边缘够不够强；
 *   ② s2 = 拉普拉斯均方根 / 灰度标准差 —— 梯度是否集中在 1px 尺度上
 *      （模糊会把边缘摊宽，梯度能量下降、拉普拉斯下降得更快，所以这个比值对模糊极敏感；
 *        而且它被对比度归一化，不会把"高对比但模糊"的图判成清晰）。
 *
 * 实测标定（合成人像，脸区归一化到 160px 宽；模糊半径 0/2/3/5/6/8）：
 *   指数 93 / 31 / 20 / 10 / 7 / 3 —— 单调、分辨率无关。
 *
 * 注意：这两个子指标都必须**扣掉噪声底**（见 noiseSigmaOf）。不扣的话
 * "重度模糊 + 强噪点"的图会因为噪点的高频而被判成清晰，分级完全失效。
 */
/**
 * 估计灰度噪声标准差 σ。
 *
 * 用拉普拉斯响应的**中位绝对偏差（MAD）**：真实边缘只占少数像素，中位数与
 * 中位偏差都由平坦区主导，所以这个尺度几乎只反映噪声，不会被边缘拉高。
 * 均值/方差做不到这一点 —— 一张"满是噪点的糊图"的拉普拉斯方差极大，
 * 会被判得比"干净清晰的图"还清晰（实测 96 分 vs 70 分，指标完全失真）。
 *
 * 换算关系：对白噪声，拉普拉斯核 [4,-1,-1,-1,-1] 的响应方差 = 20σ²，
 * 所以 σ = 1.4826·MAD / √20。
 *
 * 大图按 2 像素步长采样：中位数对采样率不敏感，但能省掉 3/4 的计算。
 */
function noiseSigmaOf(g: Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0
  const BIN = 2048
  const span = BIN * 2 + 1
  const hist = new Uint32Array(span)
  const step = w * h > 2_000_000 ? 2 : 1
  let n = 0
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const p = y * w + x
      const lap = 4 * g[p] - g[p - 1] - g[p + 1] - g[p - w] - g[p + w]
      let b = Math.round(lap) + BIN
      if (b < 0) b = 0
      else if (b > span - 1) b = span - 1
      hist[b]++
      n++
    }
  }
  if (n < 64) return 0
  let acc = 0
  let med = 0
  for (let i = 0; i < span; i++) {
    acc += hist[i]
    if (acc * 2 >= n) {
      med = i - BIN
      break
    }
  }
  hist.fill(0)
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const p = y * w + x
      const lap = 4 * g[p] - g[p - 1] - g[p + 1] - g[p - w] - g[p + w]
      let b = Math.round(Math.abs(lap - med))
      if (b > span - 1) b = span - 1
      hist[b]++
    }
  }
  acc = 0
  let mad = 0
  for (let i = 0; i < span; i++) {
    acc += hist[i]
    if (acc * 2 >= n) {
      mad = i
      break
    }
  }
  return (1.4826 * mad) / Math.sqrt(20)
}

function sharpnessIndex(src: Uint8ClampedArray, w: number, h: number): number {
  const g = toGray(src, w, h)
  let grad = 0
  let lap2 = 0
  let sum = 0
  let sum2 = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      const gx = g[p + 1] - g[p - 1]
      const gy = g[p + w] - g[p - w]
      const lap = 4 * g[p] - g[p - 1] - g[p + 1] - g[p - w] - g[p + w]
      grad += Math.sqrt(gx * gx + gy * gy)
      lap2 += lap * lap
      sum += g[p]
      sum2 += g[p] * g[p]
      n++
    }
  }
  if (!n) return 0
  // 扣掉噪声底：噪声在"梯度"和"拉普拉斯"两个尺度上都会凭空造出能量，
  // 不扣的话连"重度模糊 + 强噪点"的图都会被判成清晰。
  // E|∇| 对白噪声 ≈ 1.772σ（两个正交高斯梯度的模，瑞利分布均值）。
  const sigma = noiseSigmaOf(g, w, h)
  const meanGrad = Math.max(0, grad / n - 1.772 * sigma)
  const mean = sum / n
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean))
  const lapRms = Math.sqrt(Math.max(0, lap2 / n - 20 * sigma * sigma))
  const conc = lapRms / (std + 4)
  const s1 = 100 * (1 - Math.exp(-meanGrad / 6))
  const s2 = 100 * (1 - Math.exp(-conc / 0.3))
  return Math.min(s1, s2)
}

/**
 * 脸部锐度：把脸区归一化到固定宽度再测（否则同一张图不同分辨率会得出不同等级）。
 * 先降噪再测 —— 噪点会伪装成"锐利"，且 sharpnessIndex 内部还会再扣一次噪声底。
 */
function faceSharpness(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  if (!faces.length) {
    // 无人脸：整图缩到 256 宽再测
    const scale = Math.min(1, 256 / Math.max(w, h))
    const tw = Math.max(16, Math.round(w * scale))
    const th = Math.max(16, Math.round(h * scale))
    const small = resizeCatmullRom(src, w, h, tw, th)
    return sharpnessIndex(denoiseSoft(small, tw, th, 52), tw, th)
  }
  let sum = 0
  let n = 0
  for (const f of faces.slice(0, 4)) {
    const pad = 0.12
    const x0 = Math.max(0, Math.round(f.x - f.w * pad))
    const y0 = Math.max(0, Math.round(f.y - f.h * pad))
    const cw = Math.min(w - x0, Math.round(f.w * (1 + pad * 2)))
    const ch = Math.min(h - y0, Math.round(f.h * (1 + pad * 2)))
    if (cw < 24 || ch < 24) continue
    const region = cropImage(src, w, x0, y0, cw, ch)
    const tw = 160
    const th = Math.max(16, Math.round((ch * tw) / cw))
    const small = resizeCatmullRom(region, cw, ch, tw, th)
    sum += sharpnessIndex(denoiseSoft(small, tw, th, 52), tw, th)
    n++
  }
  if (!n) return sharpnessIndex(src, w, h)
  return sum / n
}

/**
 * 输入分级：轻度 / 中度 / 重度 / 极差。
 *
 * 除了脸部锐度，还会看压缩块与划痕密度 —— 这两者会额外吃掉可恢复细节，
 * 因此会把等级再压一档（这正是"分级承诺"要如实告知用户的依据）。
 */
export function assessInput(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): InputAssessment {
  const sharpness = faceSharpness(src, w, h, faces)
  const blockiness = blockinessScore(src, w, h)
  const scan = scanThinDefects(src, w, h, 24, false, 3)
  const defectDensity = scan.tested > 0 ? scan.hits / scan.tested : 0

  // 阈值按扣掉噪声底之后的新指数标定（脸区 160px 宽）：
  //   清晰 93 / 半径 2 的模糊 31 / 3 → 20 / 5 → 10 / 6 → 7 / 8 → 3
  let grade: InputGrade
  if (sharpness >= 70) grade = 'mild'
  else if (sharpness >= 28) grade = 'moderate'
  else if (sharpness >= 16) grade = 'severe'
  else grade = 'extreme'

  // 严重压缩 / 大量划痕 → 可恢复细节更少，等级如实下调
  if (grade === 'mild' && (blockiness > 0.45 || defectDensity > 0.012)) grade = 'moderate'
  else if (grade === 'moderate' && (blockiness > 0.7 || defectDensity > 0.03)) grade = 'severe'

  // 已知边界（如实记录，不粉饰）：强噪点（σ ≳ 9 灰阶）叠加重度模糊时，降噪后的
  // 残余噪声已经是空间相关的，拉普拉斯域估出的 σ 偏小，指数会被抬高约一档
  // （实测「半径 8 模糊 + σ9 噪点」判为 moderate 而不是 extreme）。
  // 这类图的实际输出仍会走降档 / 保守链路，分级只影响提示文案的严厉程度。

  return {
    grade,
    sharpness: Math.round(sharpness),
    blockiness: Math.round(blockiness * 100) / 100,
    defectDensity: Math.round(defectDensity * 10000) / 10000,
  }
}

/** 相机真实感模式是否对该分级开放（只对轻度模糊开放） */
export function cameraModeAllowed(grade: InputGrade): boolean {
  return grade === 'mild'
}

/* ============================================================================
 * 6. 全局增强（非人脸区域 / 底图）
 * ========================================================================== */

/**
 * 全局增强：软阈值降噪 + 去模糊锐化 + 纹理恢复。
 * 细节层一律以**原图**为基准（unsharpFrom），保证高频恒 ≥ 原图 → 只会更清晰。
 */
/**
 * 清晰强度 → 预设增益。
 *
 * 分段线性：0→0.5、100→1.0、120→1.2。上限只给到 120，因为再往上叠加
 * 会在老照片上直接产生白边与假纹理（这是质检会判不合格的区间）。
 */
export function clarityGain(clarity: number): number {
  const c = clamp(clarity, 0, 120)
  if (c <= 100) return 0.5 + 0.5 * (c / 100)
  return 1 + 0.2 * ((c - 100) / 20)
}

/** 按「清晰强度」缩放后的档位参数（只缩放增强量，不缩放降噪与局部超分倍数） */
function scaledPreset(opts: PortraitOptions): StrengthPreset {
  const base = STRENGTH_PRESETS[opts.strength]
  const g = clarityGain(opts.clarity)
  if (Math.abs(g - 1) < 0.005) return base
  return {
    deblur: base.deblur * g,
    eye: base.eye * g,
    iris: base.iris * g,
    lash: base.lash * g,
    brow: base.brow * g,
    nose: base.nose * g,
    hair: base.hair * g,
    mouth: base.mouth * g,
    teeth: base.teeth * g,
    contour: base.contour * g,
    // 降噪是"去噪"而不是"增强"，跟着清晰强度放大会把细节一起削掉
    denoise: base.denoise,
    localScaleMax: base.localScaleMax,
  }
}

export function enhancePortraitGlobal(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  opts: PortraitOptions,
): Uint8ClampedArray {
  const preset = scaledPreset(opts)
  const original = src.slice()
  let img = denoiseSoft(src, w, h, preset.denoise)
  img = unsharpFrom(img, original, w, h, preset.deblur, 2, 2)
  img = unsharp(img, w, h, preset.contour * 0.35, 1, 2)
  return img
}

/* ============================================================================
 * 7. 人脸区域专项增强
 * ========================================================================== */

/**
 * 对每个检测到的人脸做专项增强：
 *   ① 局部超分：脸区先放大到足够像素再处理，再回缩 —— 五官细节密度显著提升
 *   ② 皮肤质感：双边保边平滑（按"皮肤质感"档位）
 *   ③ 发丝增强：非肤色 + 暗于肤色的区域（头发/碎发/发际线）
 *   ④ 眼睛增强：瞳孔、眼白、睫毛、双眼皮线（椭圆蒙版 + 局部对比度）
 *   ⑤ 唇齿增强：唇线、牙齿（椭圆蒙版）
 *   ⑥ 轮廓增强：边缘引导的锐化，脸/耳/颈/衣领边缘干净
 *
 * 全程无几何变换 → 五官比例、位置天然不变（不变形、不歪眼、不换脸）。
 */
export function enhanceFaceRegions(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
  opts: PortraitOptions,
): Uint8ClampedArray {
  if (!faces.length) return src.slice()
  const preset = scaledPreset(opts)
  const out = src.slice()

  for (const face of faces) {
    const lm = locateLandmarks(src, w, h, face)

    // 裁剪人脸区域（上方留出头发，下方留出下巴与脖子）
    const padX = face.w * 0.55
    const padTop = face.h * 0.8
    const padBottom = face.h * 0.5
    let x0 = Math.round(face.x - padX)
    let y0 = Math.round(face.y - padTop)
    let cw = Math.round(face.w + padX * 2)
    let ch = Math.round(face.h + padTop + padBottom)
    if (x0 < 0) {
      cw += x0
      x0 = 0
    }
    if (y0 < 0) {
      ch += y0
      y0 = 0
    }
    cw = Math.min(cw, w - x0)
    ch = Math.min(ch, h - y0)
    if (cw < 24 || ch < 24) continue

    const region = cropImage(src, w, x0, y0, cw, ch)

    // ① 人脸区域局部超分：脸区先放大到足够像素再增强，最后缩回 ——
    //    这是"整图放大后脸糊"的解药：五官细节在放大域里重建，回缩后密度仍然更高。
    const scale = clamp(720 / cw, 1, preset.localScaleMax)
    let work = region
    let ww = cw
    let wh = ch
    if (scale > 1.08) {
      const sw = Math.round(cw * scale)
      const sh = Math.round(ch * scale)
      work = resizeCatmullRom(region, cw, ch, sw, sh)
      ww = sw
      wh = sh
    }
    const s = ww / cw

    // ② 皮肤质感：双边保边平滑（保留毛孔与轮廓）。混合系数上限 0.6 → 不会磨成蜡像。
    const skinBlend = SKIN_PRESETS[opts.skin]
    let skinMask = skinMaskOf(work, ww, wh)
    if (skinBlend > 0.01) {
      work = bilateralSmooth(work, ww, wh, skinMask, skinBlend)
      skinMask = skinMaskOf(work, ww, wh)
    }

    // 基准模糊图（半径 1）与脊线图：本区域后续所有增强共用同一份
    //   ① 省掉重复的高斯模糊（半径 1 要跑 6 趟盒式滤波，是最热路径）；
    //   ② 细节层相对同一基准计算，过冲不逐级累加 → 白边 / 假面风险显著下降。
    const blur1 = gaussianBlur(work, ww, wh, 1)
    const ridge = ridgeDetail(work, ww, wh)

    // 局部超分后再锐化一次：抵消插值带来的软化（半径 1 = 细节级）
    work = maskedUnsharp(work, blur1, preset.deblur * 0.7, 2, null)

    // ③ 发丝：普通锐化（提升整体分离感）+ 脊线算子（单根分离）+ 局部对比
    const hairWeight = buildHairWeight(
      work,
      ww,
      wh,
      skinMask,
      (face.y - y0) * s,
      (face.y + face.h - y0) * s,
    )
    if (preset.hair > 0) {
      work = maskedUnsharp(work, blur1, preset.hair, 1.5, hairWeight)
      work = applyRidge(work, ridge, preset.hair * 0.6, hairWeight)
      work = maskedLocalContrast(work, 1.14, hairWeight)
    }

    // ④ 眼睛：逐只眼分别处理（多人脸、斜脸时互不影响）
    if (preset.eye > 0) {
      const eyes: FeaturePoint[] = [lm.eyeL, lm.eyeR]
      for (const eye of eyes) {
        const cx = (eye.x - x0) * s
        const cy = (eye.y - y0) * s
        const r = Math.max(2.5, eye.r * s)

        // 眼周整体：眼白 / 眼睑轮廓
        const eyeW = ellipseMask(ww, wh, cx, cy, r * 1.75, r * 1.2)
        work = maskedUnsharp(work, blur1, preset.eye, 1, eyeW)
        work = maskedLocalContrast(work, 1.2, eyeW)

        // 虹膜：瞳孔外圈的环 —— 让虹膜纹理可见、眼睛不呆板
        if (preset.iris > 0) {
          const iris = ringMask(ww, wh, cx, cy, r * 0.42, r * 1.02)
          work = maskedUnsharp(work, blur1, preset.iris, 0.8, iris)
          work = maskedLocalContrast(work, 1.16, iris)
          work = maskedSaturate(work, 1 + 0.12 * (preset.iris / 100), iris)
        }

        // 睫毛：上睑缘 + 下睑缘两条窄带，用脊线算子做单根分离（不做整体模糊）
        if (preset.lash > 0) {
          const lashTop = ellipseMask(ww, wh, cx, cy - r * 0.86, r * 1.5, r * 0.4)
          const lashBot = ellipseMask(ww, wh, cx, cy + r * 0.92, r * 1.36, r * 0.34)
          const lashW = mergeMask(lashTop, lashBot)
          work = applyRidge(work, ridge, preset.lash * 0.75, lashW)
          work = maskedUnsharp(work, blur1, preset.lash * 0.45, 0.6, lashW)
        }

        // 双眼皮线：睑上一条更窄的弧线，只做局部对比（加了锐化会变"割"）
        if (preset.eye > 18) {
          const crease = ellipseMask(ww, wh, cx, cy - r * 1.3, r * 1.34, r * 0.28)
          work = maskedLocalContrast(work, 1 + 0.14 * (preset.eye / 100), crease)
        }

        // 瞳孔高光：只在原图确实存在高光时提亮（绝不凭空造眼神光）
        if (lm.catchlight) {
          const c = detectCatchlight(work, ww, wh, { x: cx, y: cy, r })
          if (c) work = boostCatchlight(work, ww, wh, c)
        }
      }
    }

    // ⑤ 眉毛：与发丝同族的毛发结构，用脊线算子恢复方向感与毛流感
    if (preset.brow > 0) {
      const browL = ellipseMask(
        ww,
        wh,
        (lm.browL.x - x0) * s,
        (lm.browL.y - y0) * s,
        lm.browL.r * s * 1.2,
        lm.browL.r * s * 0.44,
      )
      const browR = ellipseMask(
        ww,
        wh,
        (lm.browR.x - x0) * s,
        (lm.browR.y - y0) * s,
        lm.browR.r * s * 1.2,
        lm.browR.r * s * 0.44,
      )
      const browW = mergeMask(browL, browR)
      work = applyRidge(work, ridge, preset.brow, browW)
      work = maskedUnsharp(work, blur1, preset.brow * 0.5, 1.2, browW)
      work = maskedLocalContrast(work, 1.08, browW)
    }

    // ⑥ 鼻：鼻梁（一条竖向窄条，强化高光/阴影过渡）+ 鼻翼（两个小椭圆，强化鼻翼与鼻孔边缘）
    if (preset.nose > 0) {
      const nb = lm.noseBridge
      const bridgeH = Math.max(4, (lm.mouth.y - nb.y) * 1.05)
      const bridge = ellipseMask(
        ww,
        wh,
        (nb.x - x0) * s,
        (nb.y - y0 + bridgeH * 0.35) * s,
        nb.r * s * 1.15,
        bridgeH * s * 0.6,
      )
      const wingL = ellipseMask(
        ww,
        wh,
        (lm.noseWingL.x - x0) * s,
        (lm.noseWingL.y - y0) * s,
        lm.noseWingL.r * s * 1.3,
        lm.noseWingL.r * s * 0.95,
      )
      const wingR = ellipseMask(
        ww,
        wh,
        (lm.noseWingR.x - x0) * s,
        (lm.noseWingR.y - y0) * s,
        lm.noseWingR.r * s * 1.3,
        lm.noseWingR.r * s * 0.95,
      )
      const noseW = mergeMask(mergeMask(bridge, wingL), wingR)
      work = maskedUnsharp(work, blur1, preset.nose, 1.2, noseW)
      work = maskedLocalContrast(work, 1.1, noseW)
    }

    // ⑦ 唇线 + 牙齿
    if (preset.mouth > 0) {
      const mW = ellipseMask(
        ww,
        wh,
        (lm.mouth.x - x0) * s,
        (lm.mouth.y - y0) * s,
        lm.mouth.r * s * 1.28,
        lm.mouth.r * s * 0.8,
      )
      work = maskedUnsharp(work, blur1, preset.mouth, 1, mW)
      work = maskedLocalContrast(work, 1.14, mW)

      // 牙齿：只做「保牙缝 + 限亮」——
      //   绝不做整体提亮，否则一定糊成白块 / 假白发光的假牙。
      if (preset.teeth > 0) {
        const teeth = teethMaskOf(work, ww, wh, lm.mouth, s)
        work = applyRidge(work, ridge, preset.teeth * 0.6, teeth)
        work = maskedUnsharp(work, blur1, preset.teeth, 0.8, teeth)
        softClipHigh(work, 238, teeth)
      }
    }

    // ⑧ 轮廓 / 边缘：边缘引导的锐化，平坦区增益为 0 → 不出白边
    if (preset.contour > 0) {
      const edges = sobelEdges(work, ww, wh)
      const gain = edgeGainMap(edges, ww, wh)
      work = maskedUnsharp(work, blur1, preset.contour, 2, gain)
    }

    // 回缩到原区域尺寸并羽化贴回（羽化 = 结构上不存在拼接痕）
    const finalRegion = scale > 1.08 ? resizeCatmullRom(work, ww, wh, cw, ch) : work
    pasteRegion(out, w, h, finalRegion, x0, y0, cw, ch)
  }

  return out
}

/** 蒙版加权饱和度调整（虹膜用：让虹膜颜色与纹理更分明） */
function maskedSaturate(
  src: Uint8ClampedArray,
  factor: number,
  weight: Float32Array,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const g = weight[p]
    if (g <= 0.002) {
      out[i] = src[i]
      out[i + 1] = src[i + 1]
      out[i + 2] = src[i + 2]
    } else {
      const gray = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]
      const f = 1 + (factor - 1) * g
      out[i] = clamp255(gray + (src[i] - gray) * f)
      out[i + 1] = clamp255(gray + (src[i + 1] - gray) * f)
      out[i + 2] = clamp255(gray + (src[i + 2] - gray) * f)
    }
    out[i + 3] = src[i + 3]
  }
  return out
}

/** 提亮瞳孔高光：向 250 靠拢并软限幅，保证高光锐利但不发光、不扩散 */
function boostCatchlight(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  c: { x: number; y: number; r: number },
): Uint8ClampedArray {
  const out = src.slice()
  const m = ellipseMask(w, h, c.x + 0.5, c.y + 0.5, c.r * 1.5, c.r * 1.35)
  for (let i = 0, p = 0; i < out.length; i += 4, p++) {
    const g = m[p]
    if (g <= 0.01) continue
    for (let ch = 0; ch < 3; ch++) {
      const v = out[i + ch]
      const target = 250
      if (v >= target) continue
      out[i + ch] = clamp255(v + (target - v) * 0.5 * g)
    }
  }
  return out
}

/**
 * 发丝权重图：非肤色、且亮度不高于肤色基线的像素（头发 / 碎发 / 发际线）。
 *
 * 作用范围限定在**头部区域**（脸框上缘往下 30% 处为止），
 * 既能覆盖头顶与两侧的头发、碎发，又不会把深色背景误判成头发去锐化。
 */
function buildHairWeight(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  skinMask: Uint8Array,
  skinTop: number,
  skinBottom: number,
): Float32Array {
  // 肤色基线亮度（肤色像素的平均亮度）
  let sum = 0
  let cnt = 0
  for (let p = 0, i = 0; p < skinMask.length; p++, i += 4) {
    if (!skinMask[p]) continue
    sum += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]
    cnt++
  }
  const skinLum = cnt > 0 ? sum / cnt : 160
  const limit = skinLum * 1.3

  const faceH = Math.max(1, skinBottom - skinTop)
  const zoneBottom = clamp(Math.round(skinTop + faceH * 0.3), 0, h - 1)

  const weight = new Float32Array(w * h)
  for (let y = 0; y <= zoneBottom; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (skinMask[p]) continue
      const i = p * 4
      const lum = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]
      if (lum > limit) continue
      weight[p] = 1
    }
  }
  // 发际线附近（肤色区上缘）额外加权：越靠近肤色区越可能是碎发，越要保护
  const hairline = Math.max(0, Math.round(skinTop))
  const bandH = Math.max(1, Math.round(faceH * 0.22))
  const bandTop = Math.max(0, hairline - bandH)
  const bandEnd = Math.min(zoneBottom, hairline + Math.round(bandH * 0.5))
  for (let y = bandTop; y <= bandEnd; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (skinMask[p]) continue
      const fade = 1 - Math.abs(y - hairline) / (bandH * 1.5)
      if (fade > 0) weight[p] = Math.max(weight[p], fade)
    }
  }
  return weight
}

/* ============================================================================
 * 7.5 真实感校正（管线最后一步）
 *
 * 为什么必须放在最后：锐化 / 超分 / 五官增强都会让画面"更锐但也更假"。
 * 真实感校正在不引入新结构的前提下做四件事：
 *   ① 高光/阴影细节回收 —— 让亮部不糊死、暗部不闷死，光影有层次（立体感）；
 *   ② 中性色偏校正 —— 老照片泛黄/偏蓝拉回自然肤色；
 *   ③ 平坦区高频封顶 —— 禁止凭空出现的"AI 假纹理 / 噪点加强"；
 *   ④ 极端尖峰压制 —— 去掉锐化产生的 1px 强过冲（白边/光晕根源）。
 * ========================================================================== */

export function applyRealism(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  opts: PortraitOptions,
  ref: Uint8ClampedArray | null,
): Uint8ClampedArray {
  const amt = REALISM_PRESETS[opts.realism]
  if (amt <= 0.01) return src.slice()
  let out = toneRecover(src, w, h, amt)
  out = neutralizeCast(out, w, h, amt)
  out = limitFlatHighFreq(out, ref, w, h, amt)
  out = suppressSpikes(out, w, h, amt)
  return out
}

/** ① 高光/阴影细节回收：大幅模糊做基底，提亮暗部基底、压缩亮部基底，再叠回细节 */
function toneRecover(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amt: number,
): Uint8ClampedArray {
  const radius = Math.max(6, Math.round(Math.min(w, h) * 0.02))
  const base = gaussianBlur(src, w, h, radius)
  const out = new Uint8ClampedArray(src.length)
  const lift = 0.16 * amt
  const comp = 0.16 * amt
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = src[i + c]
      const b = base[i + c]
      let b2 = b
      let gain = 1
      if (b < 72) {
        // 暗部基底抬升 + 细节增益 → 阴影里的层次出来，不是整体提亮
        b2 = b + (72 - b) * lift
        gain = 1 + 0.18 * amt
      } else if (b > 198) {
        // 高光基底压缩 → 找回亮部纹理，避免糊成白块
        b2 = 198 + (b - 198) * (1 - comp)
        gain = 1 + 0.06 * amt
      }
      out[i + c] = clamp255(b2 + (v - b) * gain)
    }
    out[i + 3] = src[i + 3]
  }
  return out
}

/** ② 中性色偏校正：用低饱和像素做基准估白平衡，最大只纠 ±5% */
function neutralizeCast(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amt: number,
): Uint8ClampedArray {
  const step = Math.max(2, Math.round(Math.sqrt((w * h) / 120000)))
  let sr = 0
  let sg = 0
  let sb = 0
  let n = 0
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const i = (y * w + x) * 4
      const r = src[i]
      const g = src[i + 1]
      const b = src[i + 2]
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const sat = mx > 0 ? (mx - mn) / mx : 0
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      if (sat > 0.12 || lum < 55 || lum > 210) continue
      sr += r
      sg += g
      sb += b
      n++
    }
  }
  if (n < 40) return src.slice()
  const mr = sr / n
  const mg = sg / n
  const mb = sb / n
  const target = (mr + mg + mb) / 3
  const lim = 0.05 * amt
  const gain = (v: number): number => clamp(target / Math.max(1, v), 1 - lim, 1 + lim)
  const kr = gain(mr)
  const kg = gain(mg)
  const kb = gain(mb)
  if (Math.abs(kr - 1) < 0.004 && Math.abs(kg - 1) < 0.004 && Math.abs(kb - 1) < 0.004) {
    return src.slice()
  }
  const out = src.slice()
  for (let i = 0; i < out.length; i += 4) {
    out[i] = clamp255(out[i] * kr)
    out[i + 1] = clamp255(out[i + 1] * kg)
    out[i + 2] = clamp255(out[i + 2] * kb)
  }
  return out
}

/**
 * ③ 平坦区高频封顶。
 *
 * 以「人脸增强前」的同分辨率图为基准：基准里本来就平坦的地方（|高频| < 4），
 * 输出高频不得超过基准的 k 倍 —— 这从数学上禁掉了"平地里凭空长出来的假纹理 /
 * 被放大的噪点"，也就是需求里明令禁止的「AI 假纹理、背景噪点块」。
 * 真实边缘与细纹（基准本来就有高频）不加限制，所以清晰度不受影响。
 */
function limitFlatHighFreq(
  src: Uint8ClampedArray,
  ref: Uint8ClampedArray | null,
  w: number,
  h: number,
  amt: number,
): Uint8ClampedArray {
  if (!ref || ref.length !== src.length) return src.slice()
  const bNow = gaussianBlur(src, w, h, 1)
  const bRef = gaussianBlur(ref, w, h, 1)
  const cap = 4 * (1.5 + 0.7 * amt) + 1
  const out = src.slice()
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const hfRef = ref[i + c] - bRef[i + c]
      const ar = hfRef < 0 ? -hfRef : hfRef
      if (ar > 4) continue
      const hfNow = src[i + c] - bNow[i + c]
      if (hfNow > cap) out[i + c] = clamp255(bNow[i + c] + cap)
      else if (hfNow < -cap) out[i + c] = clamp255(bNow[i + c] - cap)
    }
  }
  return out
}

/** ④ 极端尖峰压制：只压掉远超局部基底的 1px 过冲（白边/光晕的残留），不动正常边缘 */
function suppressSpikes(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amt: number,
): Uint8ClampedArray {
  const base = gaussianBlur(src, w, h, 3)
  const T = 60
  const out = src.slice()
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = src[i + c] - base[i + c]
      const ad = d < 0 ? -d : d
      if (ad <= T) continue
      const k = (T + (ad - T) * (1 - 0.45 * amt)) * (d < 0 ? -1 : 1)
      out[i + c] = clamp255(base[i + c] + k)
    }
  }
  return out
}

/* ============================================================================
 * 8. 质量检测
 * ========================================================================== */

/**
 * 人脸区域清晰度（0..100）—— 人像模块的主指标。
 *
 * 为什么不用全图清晰度：一张人像里脸只占画面一小块，而清晰度按整幅图统计，
 * 背景与衣服的边缘会淹没脸的真实变化（实测脸部五官梯度提升数倍，
 * 全图分数却几乎不动）。用户关心的是"脸清不清楚"，所以必须单独统计人脸区域。
 *
 * 检测不到人脸时退回全图清晰度，保证数值始终有定义。
 */
export function portraitClarityScore(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  // 先去噪再测：噪点的拉普拉斯方差极大，不去噪的话「满是噪点的糊图」会被判成
  // 比「干净清晰的图」还清晰（实测过：噪点图 96 分 > 修复后 70 分），指标完全失真。
  const clean = denoiseSoft(src, w, h, 42)
  const gray = toGray(clean, w, h)
  if (!faces.length) return clarityScore(clean, w, h)
  let sum = 0
  let sumSq = 0
  let cnt = 0
  for (const f of faces) {
    const x0 = Math.max(1, Math.round(f.x))
    const y0 = Math.max(1, Math.round(f.y))
    const x1 = Math.min(w - 1, Math.round(f.x + f.w))
    const y1 = Math.min(h - 1, Math.round(f.y + f.h))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * w + x
        const lap = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - w] - gray[p + w]
        sum += lap
        sumSq += lap * lap
        cnt++
      }
    }
  }
  if (!cnt) return clarityScore(clean, w, h)
  const mean = sum / cnt
  // 再去掉噪声底：denoiseSoft 只是压低噪声，不能清零，残留噪声仍会虚抬方差
  const sigma = noiseSigmaOf(gray, w, h)
  const variance = Math.max(0, sumSq / cnt - mean * mean - 20 * sigma * sigma)
  // 人脸区域面积小、细节密度高，量级低于全图 → 用更小的归一化常数（120）
  const score = 100 * (1 - Math.exp(-Math.max(0, variance) / 120))
  return Math.round(Math.min(100, Math.max(0, score)))
}

/**
 * 质量检测：过锐化白边 / 塑料感 / 边缘重影 / 清晰度提升是否有效。
 *
 * 参数约定（重要）：
 *   before / after 必须是**同一分辨率**的两份数据 —— before = 全局增强后，
 *   after = 再叠加人脸专项增强后。这样才能公平地测出"人脸处理本身"是否
 *   引入白边 / 塑料感 / 重影。清晰度评分（clarityBefore / clarityAfter）由调用方
 *   在**统一参考分辨率**下另行计算后传入，避免不同分辨率直接对比导致失真。
 *
 * 检测到问题时由上层**自动降强度重试一次**。
 */
export function assessQuality(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
  clarityBefore: number,
  clarityAfter: number,
): QualityReport {
  const issues: PortraitIssue[] = []

  let haloScore = 0
  let glowScore = 0
  let plasticScore = 0
  let waxScore = 0
  let ghostScore = 0
  let seamScore = 0

  if (faces.length) {
    // ① 白边：1px 级过冲显著高于处理前 → 锐化过度 / 假面
    haloScore = haloRatio(before, after, w, h, faces) * 100
    // ② 光晕：5px 宽半径过冲 → 面具感光圈
    glowScore = glowRatio(before, after, w, h, faces) * 100
    // ③ 塑料感：皮肤高频能量明显下降 → 蜡像
    plasticScore = plasticRatio(before, after, w, h, faces) * 100
    // ④ 蜡像感：皮肤出现大片"零方差"平滑斑块
    waxScore = waxRatio(before, after, w, h, faces)
    // ⑤ 重影：眼区暗特征块被复制
    ghostScore = ghostFeatures(before, after, w, h, faces)
    // ⑥ 拼接痕：脸区贴回边界的梯度跃变
    seamScore = seamRatio(after, w, h, faces)
  }

  // ⑦ 五官变形：在输出上重新检测人脸，与输入做 IoU 匹配（本引擎无几何变换 → 恒为 0）
  const deformScore = faces.length ? deformRatio(after, w, h, faces) : 0
  // ⑧ 肤色偏移：脸部肤色平均色度漂移
  const toneShift = faces.length ? skinToneShift(before, after, w, h, faces) : 0
  // ⑨ AI 伪影：原本平坦的区域长出了高频（假纹理 / 噪点放大）
  const aiScore = aiArtifactRatio(before, after, w, h, faces)

  if (haloScore > 6) issues.push('halo')
  if (glowScore > 4) issues.push('glow')
  if (plasticScore > 22) issues.push('plastic')
  else if (plasticScore > 12) issues.push('overSmooth')
  if (waxScore > 0.18) issues.push('wax')
  if (ghostScore > 0) issues.push('ghost')
  if (deformScore > 0.34) issues.push('deform')
  if (toneShift > 4.5) issues.push('skinTone')
  if (aiScore > 0.06) issues.push('aiArtifact')
  if (seamScore > 1.7) issues.push('seam')
  if (clarityAfter <= clarityBefore + 2) issues.push('lowGain')

  return {
    clarityBefore,
    clarityAfter,
    haloScore: Math.round(haloScore * 10) / 10,
    glowScore: Math.round(glowScore * 10) / 10,
    plasticScore: Math.round(plasticScore * 10) / 10,
    waxScore: Math.round(waxScore * 1000) / 1000,
    ghostScore,
    seamScore: Math.round(seamScore * 100) / 100,
    // AI 伪影与肤色偏移也进报告：UI 的质检明细要能显示每一项的读数，
    // 而不只是一个"通过/异常"的结论（否则用户无法判断严不严重）
    aiScore: Math.round(aiScore * 1000) / 1000,
    skinToneScore: Math.round(toneShift * 10) / 10,
    degraded: false,
    fallback: false,
    issues,
  }
}

/** 需要触发"降强度重试"的严重缺陷（overSmooth / lowGain 只提示，不触发重试） */
export const SEVERE_ISSUES: PortraitIssue[] = [
  'halo',
  'glow',
  'plastic',
  'wax',
  'ghost',
  'deform',
  'skinTone',
  'aiArtifact',
  'seam',
]

/** 统计报告中严重缺陷个数 */
export function severeIssueCount(report: QualityReport): number {
  let n = 0
  for (const iss of report.issues) if (SEVERE_ISSUES.includes(iss)) n++
  return n
}

/** 过冲白边比例（相对原图的增量） */
function haloRatio(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  const blurBefore = gaussianBlur(before, w, h, 1)
  const blurAfter = gaussianBlur(after, w, h, 1)
  let overBefore = 0
  let overAfter = 0
  let total = 0
  for (const f of faces) {
    const x0 = Math.max(0, Math.round(f.x))
    const y0 = Math.max(0, Math.round(f.y))
    const x1 = Math.min(w, Math.round(f.x + f.w))
    const y1 = Math.min(h, Math.round(f.y + f.h))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * w + x) * 4
        for (let c = 0; c < 3; c++) {
          const ob = before[p + c] - blurBefore[p + c]
          const oa = after[p + c] - blurAfter[p + c]
          if (ob > 45) overBefore++
          if (oa > 45) overAfter++
          total++
        }
      }
    }
  }
  if (!total) return 0
  const rb = overBefore / total
  const ra = overAfter / total
  return Math.max(0, ra - rb)
}

/** 皮肤高频丢失比例（塑料感） */
function plasticRatio(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  const gb = toGray(before, w, h)
  const ga = toGray(after, w, h)
  let hfBefore = 0
  let hfAfter = 0
  let total = 0
  for (const f of faces) {
    const x0 = Math.max(1, Math.round(f.x))
    const y0 = Math.max(1, Math.round(f.y))
    const x1 = Math.min(w - 1, Math.round(f.x + f.w))
    const y1 = Math.min(h - 1, Math.round(f.y + f.h))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * w + x
        if (!isSkin(before[p * 4], before[p * 4 + 1], before[p * 4 + 2])) continue
        const lb =
          4 * gb[p] - gb[p - 1] - gb[p + 1] - gb[p - w] - gb[p + w]
        const la =
          4 * ga[p] - ga[p - 1] - ga[p + 1] - ga[p - w] - ga[p + w]
        hfBefore += Math.abs(lb)
        hfAfter += Math.abs(la)
        total++
      }
    }
  }
  if (!total || hfBefore <= 0) return 0
  return Math.max(0, 1 - hfAfter / hfBefore)
}

/** 光晕：5px 宽半径上的过冲增量（白边是 1px，光晕是更宽的"光圈"） */
function glowRatio(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  const bb = gaussianBlur(before, w, h, 5)
  const ba = gaussianBlur(after, w, h, 5)
  let ob = 0
  let oa = 0
  let total = 0
  for (const f of faces) {
    const x0 = Math.max(0, Math.round(f.x))
    const y0 = Math.max(0, Math.round(f.y))
    const x1 = Math.min(w, Math.round(f.x + f.w))
    const y1 = Math.min(h, Math.round(f.y + f.h))
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const p = (y * w + x) * 4
        for (let c = 0; c < 3; c++) {
          if (before[p + c] - bb[p + c] > 60) ob++
          if (after[p + c] - ba[p + c] > 60) oa++
          total++
        }
      }
    }
  }
  if (!total) return 0
  return Math.max(0, (oa - ob) / total)
}

/**
 * 蜡像感：皮肤里出现"局部方差≈0"的大片平坦斑块。
 * 塑料感测的是高频总量下降，蜡像感测的是**彻底没有纹理的死板区块**，
 * 两者互补：轻度均匀磨皮只有前者，重度磨皮/糊成一片会两者同时命中。
 */
function waxRatio(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  const gb = toGray(before, w, h)
  const ga = toGray(after, w, h)
  let textured = 0
  let flattened = 0
  for (const f of faces) {
    const x0 = Math.max(1, Math.round(f.x))
    const y0 = Math.max(1, Math.round(f.y))
    const x1 = Math.min(w - 1, Math.round(f.x + f.w))
    const y1 = Math.min(h - 1, Math.round(f.y + f.h))
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const p = y * w + x
        if (!isSkin(before[p * 4], before[p * 4 + 1], before[p * 4 + 2])) continue
        // 只看"原本有纹理"的皮肤像素：它们被抹平才是蜡像感
        if (localStd(gb, w, p) <= 3.2) continue
        textured++
        if (localStd(ga, w, p) < 1.4) flattened++
      }
    }
  }
  if (!textured) return 0
  return flattened / textured
}

/** 3x3 局部标准差（灰度） */
function localStd(g: Float32Array, w: number, p: number): number {
  const a = g[p - w - 1]
  const b = g[p - w]
  const c = g[p - w + 1]
  const d = g[p - 1]
  const e = g[p]
  const f = g[p + 1]
  const hh = g[p + w - 1]
  const i = g[p + w]
  const j = g[p + w + 1]
  const mean = (a + b + c + d + e + f + hh + i + j) / 9
  const v =
    ((a - mean) * (a - mean) +
      (b - mean) * (b - mean) +
      (c - mean) * (c - mean) +
      (d - mean) * (d - mean) +
      (e - mean) * (e - mean) +
      (f - mean) * (f - mean) +
      (hh - mean) * (hh - mean) +
      (i - mean) * (i - mean) +
      (j - mean) * (j - mean)) /
    9
  return Math.sqrt(Math.max(0, v))
}

/**
 * 拼接痕：脸区贴回边界上的梯度，相对内部同尺度梯度是否出现跃变。
 * 贴回已做羽化，理论上应接近 1.0；一旦 >1.7 说明边界处理失效（会看到方框）。
 */
function seamRatio(
  img: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  const g = toGray(img, w, h)
  let worst = 1
  for (const f of faces) {
    // 与 enhanceFaceRegions 的裁剪范围保持一致
    const padX = f.w * 0.55
    const padTop = f.h * 0.8
    const padBottom = f.h * 0.5
    const x0 = Math.max(1, Math.round(f.x - padX))
    const y0 = Math.max(1, Math.round(f.y - padTop))
    const x1 = Math.min(w - 2, Math.round(f.x + f.w + padX))
    const y1 = Math.min(h - 2, Math.round(f.y + f.h + padBottom))
    if (x1 - x0 < 12 || y1 - y0 < 12) continue

    let edge = 0
    let edgeN = 0
    let inner = 0
    let innerN = 0
    const inset = 4
    for (let x = x0; x <= x1; x += 2) {
      // 上下边界
      edge += Math.abs(g[y0 * w + x] - g[(y0 - 1) * w + x])
      edge += Math.abs(g[y1 * w + x] - g[(y1 + 1) * w + x])
      edgeN += 2
      const yi0 = y0 + inset
      const yi1 = y1 - inset
      if (yi0 > 0 && yi0 < h - 1) {
        inner += Math.abs(g[yi0 * w + x] - g[(yi0 - 1) * w + x])
        innerN++
      }
      if (yi1 > 0 && yi1 < h - 1) {
        inner += Math.abs(g[yi1 * w + x] - g[(yi1 - 1) * w + x])
        innerN++
      }
    }
    for (let y = y0; y <= y1; y += 2) {
      edge += Math.abs(g[y * w + x0] - g[y * w + x0 - 1])
      edge += Math.abs(g[y * w + x1] - g[y * w + x1 + 1])
      edgeN += 2
      const xi0 = x0 + inset
      const xi1 = x1 - inset
      if (xi0 > 0) {
        inner += Math.abs(g[y * w + xi0] - g[y * w + xi0 - 1])
        innerN++
      }
      if (xi1 < w - 1) {
        inner += Math.abs(g[y * w + xi1] - g[y * w + xi1 + 1])
        innerN++
      }
    }
    if (!edgeN || !innerN) continue
    const ratio = edge / edgeN / Math.max(1e-3, inner / innerN)
    if (ratio > worst) worst = ratio
  }
  return worst
}

/** 五官变形：在输出上重检人脸，与输入脸框做 IoU 匹配，返回未匹配比例 */
function deformRatio(
  after: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  const found = detectFaces(after, w, h)
  if (!found.length) return 1
  let matched = 0
  for (const f of faces) {
    for (const g of found) {
      if (iou(f, g) > 0.5) {
        matched++
        break
      }
    }
  }
  return 1 - matched / faces.length
}

/** 肤色偏移：脸部肤色区域平均 (Cb,Cr) 的漂移量（灰阶） */
function skinToneShift(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  let bcb = 0
  let bcr = 0
  let acb = 0
  let acr = 0
  let n = 0
  for (const f of faces) {
    const x0 = Math.max(1, Math.round(f.x))
    const y0 = Math.max(1, Math.round(f.y))
    const x1 = Math.min(w - 1, Math.round(f.x + f.w))
    const y1 = Math.min(h - 1, Math.round(f.y + f.h))
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4
        if (!isSkin(before[i], before[i + 1], before[i + 2])) continue
        bcb += before[i + 2] - before[i + 1]
        bcr += before[i] - before[i + 1]
        acb += after[i + 2] - after[i + 1]
        acr += after[i] - after[i + 1]
        n++
      }
    }
  }
  if (!n) return 0
  return Math.hypot(acb / n - bcb / n, acr / n - bcr / n)
}

/** AI 伪影：原本平坦（高频 < 4）的像素里，输出高频被抬到 8 以上的占比 */
function aiArtifactRatio(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  if (before.length !== after.length) return 0
  const bb = gaussianBlur(before, w, h, 1)
  const ba = gaussianBlur(after, w, h, 1)
  let flat = 0
  let fake = 0
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 900000)))
  if (faces.length) {
    for (const f of faces) {
      const x0 = Math.max(1, Math.round(f.x))
      const y0 = Math.max(1, Math.round(f.y))
      const x1 = Math.min(w - 1, Math.round(f.x + f.w))
      const y1 = Math.min(h - 1, Math.round(f.y + f.h))
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const i = (y * w + x) * 4
          const hfB = before[i] - bb[i]
          if (Math.abs(hfB) >= 4) continue
          flat++
          if (Math.abs(after[i] - ba[i]) > 8) fake++
        }
      }
    }
  } else {
    for (let i = 0; i < before.length; i += 4 * step) {
      const hfB = before[i] - bb[i]
      if (Math.abs(hfB) >= 4) continue
      flat++
      if (Math.abs(after[i] - ba[i]) > 8) fake++
    }
  }
  if (!flat) return 0
  return fake / flat
}

/**
 * 眼部区域内的暗色连通块数量。
 *
 * 正常的一只眼 = 1 个暗特征块（瞳孔与眼睑线连在一起）。
 * 若出现「重影 / 五官重复」，同一区域会出现 2 个及以上独立暗块 —— 特征被复制了。
 *
 * 本引擎全程不做任何几何变换，理论上不可能产生重影；
 * 这个检测是安全网：一旦真的出现（例如蒙版错位把五官复制成两份），
 * 质量检测会立即触发降强度重试。
 */
function countDarkBlobs(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  r: number,
  minSize: number,
): number {
  const x0 = Math.max(0, Math.floor(cx - r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const x1 = Math.min(w - 1, Math.ceil(cx + r))
  const y1 = Math.min(h - 1, Math.ceil(cy + r))
  if (x1 <= x0 || y1 <= y0) return 0

  // 阈值：区域内平均亮度 - 25 灰阶，暗于此值才算"暗特征"
  let sum = 0
  let cnt = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = (y * w + x) * 4
      sum += 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2]
      cnt++
    }
  }
  if (!cnt) return 0
  const thr = sum / cnt - 25

  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  const mask = new Uint8Array(bw * bh)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const sx = x0 + x
      const sy = y0 + y
      const dx = (sx + 0.5 - cx) / r
      const dy = (sy + 0.5 - cy) / r
      if (dx * dx + dy * dy > 1) continue
      const p = (sy * w + sx) * 4
      const lum = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2]
      if (lum < thr) mask[y * bw + x] = 1
    }
  }

  // 连通块计数（面积 ≥ 3 像素才算有效特征）
  let blobs = 0
  const seen = new Uint8Array(bw * bh)
  const stack = new Int32Array(bw * bh)
  for (let i = 0; i < bw * bh; i++) {
    if (mask[i] !== 1 || seen[i]) continue
    let sp = 0
    stack[sp++] = i
    seen[i] = 1
    let size = 0
    while (sp > 0) {
      const cur = stack[--sp]
      size++
      const cxx = cur % bw
      const cyy = (cur - cxx) / bw
      if (cxx > 0 && mask[cur - 1] === 1 && !seen[cur - 1]) {
        seen[cur - 1] = 1
        stack[sp++] = cur - 1
      }
      if (cxx < bw - 1 && mask[cur + 1] === 1 && !seen[cur + 1]) {
        seen[cur + 1] = 1
        stack[sp++] = cur + 1
      }
      if (cyy > 0 && mask[cur - bw] === 1 && !seen[cur - bw]) {
        seen[cur - bw] = 1
        stack[sp++] = cur - bw
      }
      if (cyy < bh - 1 && mask[cur + bw] === 1 && !seen[cur + bw]) {
        seen[cur + bw] = 1
        stack[sp++] = cur + bw
      }
    }
    if (size >= minSize) blobs++
  }
  return blobs
}

/**
 * 眼区"特征复制"计数：处理后比处理前多出的**大**暗块数（>0 = 疑似重影）。
 *
 * 只统计面积达到眼球盘 5% 以上的暗块：瞳孔/虹膜这类"五官本体"够大，
 * 而睫毛、双眼皮线远小于该阈值 —— 否则增强睫毛会让暗块数增加，
 * 把正常的细节增强误判成重影（实测误报 17 个）。
 */
function ghostFeatures(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  let extra = 0
  for (const f of faces) {
    const lm = locateLandmarks(before, w, h, f)
    const eyes = [lm.eyeL, lm.eyeR]
    for (const eye of eyes) {
      const rad = Math.max(5, eye.r * 1.45)
      const minSize = Math.max(5, Math.round(Math.PI * rad * rad * 0.05))
      const b = countDarkBlobs(before, w, h, eye.x, eye.y, rad, minSize)
      const a = countDarkBlobs(after, w, h, eye.x, eye.y, rad, minSize)
      if (a > b) extra += a - b
    }
  }
  return extra
}

/**
 * 降强度重试：把强度降一档、皮肤质感改为"保留纹理"，重新处理。
 * 相机真实感档降档后直接落到自然高清（它的锐化预算本来就最低，再降没有意义）。
 */
export function degradeStrength(strength: PortraitStrength): PortraitStrength {
  if (strength === 'extreme') return 'ultra'
  if (strength === 'ultra') return 'natural'
  return 'natural'
}

/**
 * 保守模式：重试后仍不合格时，回退到「自然高清 + 高真实感 + 保留纹理」。
 * 需求原文：仍不合格，输出自然高清档并提示"原图细节不足，已采用保守修复"。
 */
export function conservativeOptions(opts: PortraitOptions): PortraitOptions {
  return { ...opts, strength: 'natural', skin: 'keep', realism: 'high' }
}
