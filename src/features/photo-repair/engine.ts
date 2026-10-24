/* =============================================================================
 * engine.ts —— 照片模糊修复高清：纯前端图像处理引擎（零外部依赖，运行于主线程）
 *
 * 实现能力（对应 TASK.md 功能文档）：
 *   - 智能降噪（近似高斯模糊去噪）
 *   - 去模糊锐化（非锐化掩膜 unsharp mask，带阈值抑制噪点放大）
 *   - 人脸 / 文字 / 边缘增强（unsharp + 局部对比度）
 *   - 纹理恢复（高频细节层回加）
 *   - 超分辨率放大（高质量缩放 + 放大后轻锐化）
 *   - 模糊检测（拉普拉斯方差 → 清晰度评分）
 *
 * 所有函数操作 RGBA Uint8ClampedArray，不引入任何第三方库（AGENT.md 铁律：禁止新增 npm 依赖）。
 * ========================================================================== */

export interface ImageBuffer {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface EnhanceOptions {
  denoise: boolean
  denoiseStrength: number // 0..100
  deblur: boolean
  deblurAmount: number // 0..100
  enhance: boolean
  enhanceAmount: number // 0..100
  texture: boolean
  textureAmount: number // 0..100
  targetLongEdge: number // 输出长边像素（如 1920 / 2560 / 3840 / 5120）
  format: string // 'image/jpeg' | 'image/png' | 'image/webp'
  quality: number // 0..1
}

/** 输出分辨率预设（长边像素） */
export const RES_PRESETS: { key: string; longEdge: number }[] = [
  { key: 'repair.res.hd', longEdge: 1920 },
  { key: 'repair.res.fhd', longEdge: 2560 },
  { key: 'repair.res.u4k', longEdge: 3840 },
  { key: 'repair.res.u5k', longEdge: 5120 },
]

/** 导出格式 */
export const FORMATS: { value: string; label: string }[] = [
  { value: 'image/jpeg', label: 'JPG' },
  { value: 'image/png', label: 'PNG' },
  { value: 'image/webp', label: 'WEBP' },
]

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/** 单次一维盒式模糊（水平或垂直），带边缘 clamp，滑动窗口累加 O(n) */
function boxPass(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  r: number,
  horizontal: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length)
  const win = r * 2 + 1
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0
        for (let x = -r; x <= r; x++) {
          const xx = x < 0 ? 0 : x >= w ? w - 1 : x
          sum += src[(y * w + xx) * 4 + c]
        }
        for (let x = 0; x < w; x++) {
          out[(y * w + x) * 4 + c] = sum / win
          const xOut = x - r < 0 ? 0 : x - r
          const xIn = x + r + 1 >= w ? w - 1 : x + r + 1
          sum += src[(y * w + xIn) * 4 + c] - src[(y * w + xOut) * 4 + c]
        }
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0
        for (let y = -r; y <= r; y++) {
          const yy = y < 0 ? 0 : y >= h ? h - 1 : y
          sum += src[(yy * w + x) * 4 + c]
        }
        for (let y = 0; y < h; y++) {
          out[(y * w + x) * 4 + c] = sum / win
          const yOut = y - r < 0 ? 0 : y - r
          const yIn = y + r + 1 >= h ? h - 1 : y + r + 1
          sum += src[(yIn * w + x) * 4 + c] - src[(yOut * w + x) * 4 + c]
        }
      }
    }
  }
  return out
}

/** 三次盒式模糊叠加 ≈ 高斯模糊（强度随 r 增大而增强） */
export function gaussianBlur(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  if (r <= 0) return src.slice()
  let tmp = src.slice()
  for (let i = 0; i < 3; i++) {
    tmp = boxPass(tmp, w, h, r, true)
    tmp = boxPass(tmp, w, h, r, false)
  }
  return tmp
}

/** 非锐化掩膜：原图 − 模糊 = 细节层，按 amount 加回；threshold 抑制纯噪点放大 */
export function unsharp(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  radius: number,
  threshold: number,
): Uint8ClampedArray {
  const amt = amount / 100
  if (amt <= 0) return src.slice()
  const blur = gaussianBlur(src, w, h, Math.max(1, Math.round(radius)))
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const orig = src[i + c]
      const detail = orig - blur[i + c]
      if (Math.abs(detail) < threshold) {
        out[i + c] = orig
      } else {
        out[i + c] = clamp255(orig + amt * detail)
      }
    }
    out[i + 3] = src[i + 3]
  }
  return out
}

/** 局部对比度增强（以中灰为轴线性拉伸），强化人脸/文字/边缘观感 */
function localContrast(src: Uint8ClampedArray, w: number, h: number, amount: number): Uint8ClampedArray {
  const c = 1 + amount / 150 // 1..~1.67
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0; i < src.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      out[i + ch] = clamp255((src[i + ch] - 128) * c + 128)
    }
    out[i + 3] = src[i + 3]
  }
  return out
}

/** 主处理管线：按选项顺序组合各增强步骤，返回与输入同尺寸的增强 RGBA */
export function enhanceImage(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  opts: EnhanceOptions,
): Uint8ClampedArray {
  let img = src.slice()
  if (opts.denoise) {
    const r = Math.max(1, Math.round(1 + opts.denoiseStrength / 40))
    img = gaussianBlur(img, w, h, r)
  }
  if (opts.deblur) {
    img = unsharp(img, w, h, opts.deblurAmount, 1.5, 3)
  }
  if (opts.enhance) {
    img = unsharp(img, w, h, opts.enhanceAmount, 1.2, 4)
    img = localContrast(img, w, h, opts.enhanceAmount * 0.4)
  }
  if (opts.texture) {
    img = unsharp(img, w, h, opts.textureAmount * 0.7, 0.8, 1)
  }
  return img
}

/** 计算输出尺寸（保持原始宽高比，长边对齐 targetLongEdge，且不超过 8192） */
export function computeOutputSize(w: number, h: number, targetLong: number): [number, number] {
  const long = Math.max(w, h)
  if (long <= 0) return [w, h]
  const scale = targetLong / long
  let ow = Math.round(w * scale)
  let oh = Math.round(h * scale)
  const MAX = 8192
  if (ow > MAX) {
    const s = MAX / ow
    ow = MAX
    oh = Math.round(oh * s)
  }
  if (oh > MAX) {
    const s = MAX / oh
    oh = MAX
    ow = Math.round(ow * s)
  }
  return [ow, oh]
}

/** 模糊检测：灰度拉普拉斯方差 → 0..100 清晰度评分（越高越清晰） */
export function clarityScore(src: Uint8ClampedArray, w: number, h: number): number {
  const n = w * h
  if (n === 0) return 0
  const gray = new Float32Array(n)
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    gray[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]
  }
  let sum = 0
  let sumSq = 0
  let cnt = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      const lap = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - w] - gray[p + w]
      sum += lap
      sumSq += lap * lap
      cnt++
    }
  }
  if (cnt === 0) return 0
  const mean = sum / cnt
  const variance = sumSq / cnt - mean * mean
  const score = (variance / (variance + 400)) * 100
  return Math.round(Math.min(100, Math.max(0, score)))
}
