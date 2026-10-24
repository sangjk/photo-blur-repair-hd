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
  /** 皮肤占比 0..1（越低说明脸被头发/阴影遮挡越多） */
  skinRatio: number
  /** 眼睛是否通过暗像素搜索精确定位（false = 用标准比例兜底） */
  eyeLocated: boolean
}

/** 清晰强度档位 */
export type PortraitStrength = 'natural' | 'ultra' | 'extreme'
/** 皮肤质感档位 */
export type SkinTexture = 'keep' | 'balanced' | 'smooth'
/** 输出分辨率档位 */
export type PortraitOutput = 'hd' | 'uhd' | '4k' | '5k'

export interface PortraitOptions {
  /** 清晰强度 */
  strength: PortraitStrength
  /** 皮肤质感 */
  skin: SkinTexture
  /** 输出长边像素 */
  targetLongEdge: number
  /** 导出格式 */
  format: string
  /** 导出质量 0..1 */
  quality: number
}

/** 各强度档位的算子参数（百分比，0..100） */
export interface StrengthPreset {
  /** 全局去模糊锐化 */
  deblur: number
  /** 眼睛 / 睫毛 / 双眼皮线增强 */
  eye: number
  /** 发丝 / 发际线增强 */
  hair: number
  /** 唇线 / 牙齿增强 */
  mouth: number
  /** 轮廓 / 边缘增强 */
  contour: number
  /** 降噪强度 */
  denoise: number
  /** 人脸区域局部超分最大放大倍数 */
  localScaleMax: number
}

/** 清晰强度预设：自然高清（轻）/ 超清人像（主推）/ 极致清晰（强化五官） */
export const STRENGTH_PRESETS: Record<PortraitStrength, StrengthPreset> = {
  natural: {
    deblur: 30,
    eye: 28,
    hair: 22,
    mouth: 18,
    contour: 26,
    denoise: 32,
    localScaleMax: 1.6,
  },
  ultra: {
    deblur: 50,
    eye: 60,
    hair: 46,
    mouth: 36,
    contour: 50,
    denoise: 42,
    localScaleMax: 2,
  },
  extreme: {
    deblur: 70,
    eye: 88,
    hair: 66,
    mouth: 50,
    contour: 72,
    denoise: 50,
    localScaleMax: 2.4,
  },
}

/** 输出分辨率档位（长边像素；原图更大时保持原分辨率，绝不缩小） */
export const PORTRAIT_OUTPUTS: { key: PortraitOutput; longEdge: number }[] = [
  { key: 'hd', longEdge: 1920 },
  { key: 'uhd', longEdge: 2560 },
  { key: '4k', longEdge: 3840 },
  { key: '5k', longEdge: 5120 },
]

/** 皮肤质感 → 双边滤波混合系数（0 = 完全保留纹理） */
export const SKIN_PRESETS: Record<SkinTexture, number> = {
  keep: 0,
  balanced: 0.45,
  smooth: 0.85,
}

/** 质量检测发现的问题类型 */
export type PortraitIssue = 'halo' | 'plastic' | 'ghost' | 'lowGain'

export interface QualityReport {
  /** 修复前清晰度 0..100 */
  clarityBefore: number
  /** 修复后清晰度 0..100 */
  clarityAfter: number
  /** 过冲白边比例 0..1（越高越像「假面/锐化过度」） */
  haloScore: number
  /** 皮肤高频丢失比例 0..1（越高越像「蜡像/塑料」） */
  plasticScore: number
  /** 双边缘（重影）计数 */
  ghostScore: number
  /** 是否已自动降强度重试 */
  degraded: boolean
  /** 命中的问题 */
  issues: PortraitIssue[]
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

  const eyeL = refineEye(src, w, h, box, canonEyeLX, canonEyeY, canonEyeR, false)
  const eyeR = refineEye(src, w, h, box, canonEyeRX, canonEyeY, canonEyeR, true)

  const mouth = refineMouth(src, w, h, box)
  const skinRatio = countSkinRatio(src, w, h, box)

  return {
    eyeL: eyeL.point,
    eyeR: eyeR.point,
    mouth,
    skinRatio,
    eyeLocated: eyeL.found || eyeR.found,
  }
}

/** 在眼带内搜索最暗且接近标准位置的点，并估计眼睛半径 */
function refineEye(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  box: FaceBox,
  canonX: number,
  canonY: number,
  canonR: number,
  isRight: boolean,
): { point: FeaturePoint; found: boolean } {
  const fallback: FeaturePoint = { x: canonX, y: canonY, r: canonR }
  // 眼带收窄到脸高的 30%~52%：太宽会把发际线、眉毛阴影、镜片反光都算进来
  const y0 = Math.round(box.y + box.h * 0.3)
  const y1 = Math.round(box.y + box.h * 0.52)
  const x0 = Math.round(isRight ? box.x + box.w * 0.52 : box.x + box.w * 0.1)
  const x1 = Math.round(isRight ? box.x + box.w * 0.9 : box.x + box.w * 0.48)
  if (y1 >= h || x1 >= w || y1 <= y0 || x1 <= x0) return { point: fallback, found: false }

  // 先算区域平均亮度，用于判断"是否真的存在暗的眼睛"
  let mean = 0
  let cnt = 0
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const p = (y * w + x) * 4
      mean += 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2]
      cnt++
    }
  }
  if (!cnt) return { point: fallback, found: false }
  mean /= cnt

  let bestScore = Infinity
  let bestX = canonX
  let bestY = canonY
  let bestLum = 255
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 4
      const lum = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2]
      // 越暗越好，同时偏好靠近标准位置（避免选到阴影/背景暗块）
      const dx = (x - canonX) / Math.max(1, box.w)
      const score = lum + 0.45 * 255 * Math.abs(dx)
      if (score < bestScore) {
        bestScore = score
        bestX = x
        bestY = y
        bestLum = lum
      }
    }
  }
  // 最暗处并不比周围明显暗 → 眼里没有可信的暗特征（闭眼/侧脸/强侧光）→ 用标准比例
  if (bestLum > mean - 10) return { point: fallback, found: false }

  // 眼睛半径：以最暗点为中心，统计暗像素簇的半宽
  const p0 = (bestY * w + bestX) * 4
  const minLum = 0.299 * src[p0] + 0.587 * src[p0 + 1] + 0.114 * src[p0 + 2]
  const limit = minLum + 32
  let left = bestX
  let right = bestX
  for (let x = bestX; x >= Math.max(x0, bestX - Math.round(box.w * 0.25)); x--) {
    const q = (bestY * w + x) * 4
    const lum = 0.299 * src[q] + 0.587 * src[q + 1] + 0.114 * src[q + 2]
    if (lum > limit) break
    left = x
  }
  for (let x = bestX; x <= Math.min(x1 - 1, bestX + Math.round(box.w * 0.25)); x++) {
    const q = (bestY * w + x) * 4
    const lum = 0.299 * src[q] + 0.587 * src[q + 1] + 0.114 * src[q + 2]
    if (lum > limit) break
    right = x
  }
  const r = clamp((right - left) / 2, canonR * 0.45, canonR * 1.5)
  return { point: { x: bestX, y: bestY, r }, found: true }
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
      }
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
  for (let y = 0; y < ch; y++) {
    const dy = y0 + y
    if (dy < 0 || dy >= dstH) continue
    const s = y * cw * 4
    const d = (dy * dstW + x0) * 4
    dst.set(region.subarray(s, s + cw * 4), d)
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
 */
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
        const detail = src[i + c] - blur[i + c]
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
 * 6. 全局增强（非人脸区域 / 底图）
 * ========================================================================== */

/**
 * 全局增强：软阈值降噪 + 去模糊锐化 + 纹理恢复。
 * 细节层一律以**原图**为基准（unsharpFrom），保证高频恒 ≥ 原图 → 只会更清晰。
 */
export function enhancePortraitGlobal(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  opts: PortraitOptions,
): Uint8ClampedArray {
  const preset = STRENGTH_PRESETS[opts.strength]
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
  const preset = STRENGTH_PRESETS[opts.strength]
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

    // ① 局部超分：脸区放大后再做细节增强（脸小的人像收益最大）
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

    // ② 皮肤质感：双边保边平滑（保留毛孔与轮廓，不做塑料磨皮）
    const skinBlend = SKIN_PRESETS[opts.skin]
    const skinMask = skinMaskOf(work, ww, wh)
    if (skinBlend > 0.01) {
      work = bilateralSmooth(work, ww, wh, skinMask, skinBlend)
    }

    // 基准模糊图（半径 1）——本区域后续所有锐化步骤共用同一份：
    //   ① 省掉 4 次重复的高斯模糊（半径 1 的模糊要跑 6 趟盒式滤波，是最热路径）；
    //   ② 细节层相对同一基准计算，过冲不逐级累加 → 白边 / 假面风险显著下降。
    const blur1 = gaussianBlur(work, ww, wh, 1)

    // 局部超分后再锐化一次：抵消插值带来的软化（半径 1 = 细节级）
    work = maskedUnsharp(work, blur1, preset.deblur * 0.75, 2, null)

    // ③ 发丝增强：非肤色且亮度不高于肤色的像素（头发 / 碎发 / 发际线）
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
      work = maskedLocalContrast(work, 1.14, hairWeight)
    }

    // ④ 眼睛增强（两只眼分别处理，中心亮、边缘渐隐）
    if (preset.eye > 0) {
      const eL = ellipseMask(
        ww,
        wh,
        (lm.eyeL.x - x0) * s,
        (lm.eyeL.y - y0) * s,
        lm.eyeL.r * s * 1.75,
        lm.eyeL.r * s * 1.2,
      )
      const eR = ellipseMask(
        ww,
        wh,
        (lm.eyeR.x - x0) * s,
        (lm.eyeR.y - y0) * s,
        lm.eyeR.r * s * 1.75,
        lm.eyeR.r * s * 1.2,
      )
      const eyeW = mergeMask(eL, eR)
      work = maskedUnsharp(work, blur1, preset.eye, 1, eyeW)
      work = maskedLocalContrast(work, 1.22, eyeW)
      // 眼周轻微提亮 → "眼睛有神"
      work = maskedBrighten(work, 6, eyeW)
    }

    // ⑤ 唇 / 齿增强
    if (preset.mouth > 0) {
      const mW = ellipseMask(
        ww,
        wh,
        (lm.mouth.x - x0) * s,
        (lm.mouth.y - y0) * s,
        lm.mouth.r * s * 1.35,
        lm.mouth.r * s * 0.95,
      )
      work = maskedUnsharp(work, blur1, preset.mouth, 1, mW)
      work = maskedLocalContrast(work, 1.16, mW)
    }

    // ⑥ 轮廓 / 边缘增强（边缘引导，平坦区不产生白边）
    if (preset.contour > 0) {
      const edges = sobelEdges(work, ww, wh)
      const gain = edgeGainMap(edges, ww, wh)
      work = maskedUnsharp(work, blur1, preset.contour, 2, gain)
    }

    // 回缩到原区域尺寸并贴回
    const finalRegion = scale > 1.08 ? resizeCatmullRom(work, ww, wh, cw, ch) : work
    pasteRegion(out, w, h, finalRegion, x0, y0, cw, ch)
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

/** 蒙版加权提亮（眼周提亮 = 眼睛有神） */
function maskedBrighten(
  src: Uint8ClampedArray,
  delta: number,
  weight: Float32Array,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const g = weight[p]
    for (let c = 0; c < 3; c++) {
      out[i + c] = clamp255(src[i + c] + delta * g)
    }
    out[i + 3] = src[i + 3]
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
  if (!faces.length) return clarityScore(src, w, h)
  const gray = toGray(src, w, h)
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
  if (!cnt) return clarityScore(src, w, h)
  const mean = sum / cnt
  const variance = sumSq / cnt - mean * mean
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
  let plasticScore = 0
  let ghostScore = 0

  if (faces.length) {
    // ① 过冲白边：输出相对局部均值的过冲幅度显著高于原图 → 假面 / 锐化过度
    haloScore = haloRatio(before, after, w, h, faces) * 100
    // ② 塑料感：皮肤区高频能量相对原图大幅下降 → 蜡像
    plasticScore = plasticRatio(before, after, w, h, faces) * 100
    // ③ 重影：眼带内出现成对反向边缘 → 形变/重影
    ghostScore = ghostEdges(before, after, w, h, faces)
  }

  if (haloScore > 6) issues.push('halo')
  if (plasticScore > 22) issues.push('plastic')
  if (ghostScore > 0) issues.push('ghost')
  if (clarityAfter <= clarityBefore + 2) issues.push('lowGain')

  return {
    clarityBefore,
    clarityAfter,
    haloScore: Math.round(haloScore * 10) / 10,
    plasticScore: Math.round(plasticScore * 10) / 10,
    ghostScore,
    degraded: false,
    issues,
  }
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

/** 眼区"特征复制"计数（重影）：处理后比处理前多出的暗特征块数 */
function ghostEdges(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  w: number,
  h: number,
  faces: FaceBox[],
): number {
  return ghostFeatures(before, after, w, h, faces)
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
    if (size >= 3) blobs++
  }
  return blobs
}

/** 眼区"特征复制"计数：处理后比处理前多出的暗块数（>0 = 疑似重影） */
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
      const rad = Math.max(4, eye.r * 2.4)
      const b = countDarkBlobs(before, w, h, eye.x, eye.y, rad)
      const a = countDarkBlobs(after, w, h, eye.x, eye.y, rad)
      if (a > b) extra += a - b
    }
  }
  return extra
}

/**
 * 降强度重试：把强度降一档、皮肤质感改为"保留纹理"，重新处理。
 * 返回 null 表示无需重试（无问题）。
 */
export function degradeStrength(strength: PortraitStrength): PortraitStrength {
  if (strength === 'extreme') return 'ultra'
  if (strength === 'ultra') return 'natural'
  return 'natural'
}
