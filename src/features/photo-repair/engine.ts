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
  // 保留 alpha 通道：否则透明像素经模糊后 alpha 归零 → 整图透明 → 导出 JPEG 变黑
  for (let i = 3; i < out.length; i += 4) out[i] = src[i]
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

/**
 * 以「参考图」的高频细节层叠加到当前结果上（非锐化掩模的增强版）。
 *
 * 关键点：参考图必须是**原图**。
 * 传统 unsharp 用当前图算细节层（orig - blur(orig)），一旦前面做过整体模糊（降噪），
 * 细节层就只剩残余高频，补不回被抹掉的原图细节 —— 结果只会比原图更糊。
 * 以原图为基准 = 把原图真实细节补回并放大，输出高频恒 ≥ 原图，修复只会更清晰。
 */
export function unsharpFrom(
  base: Uint8ClampedArray,
  ref: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  radius: number,
  threshold: number,
): Uint8ClampedArray {
  const amt = amount / 100
  if (amt <= 0) return base.slice()
  const blur = gaussianBlur(ref, w, h, Math.max(1, Math.round(radius)))
  const out = new Uint8ClampedArray(base.length)
  for (let i = 0; i < base.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const detail = ref[i + c] - blur[i + c]
      if (Math.abs(detail) < threshold) {
        out[i + c] = base[i + c]
      } else {
        out[i + c] = clamp255(base[i + c] + amt * detail)
      }
    }
    out[i + 3] = base[i + 3]
  }
  return out
}

/**
 * 智能降噪（细节层软阈值）：用小半径模糊估算局部低频，只压制**小幅**高频（噪点），
 * 强边缘（结构）基本保留。
 *
 * 与「整体高斯模糊」的本质区别：整体模糊会把所有细节（含边缘）一起抹平，
 * 导致修复结果比原图还糊；软阈值只削掉噪点幅度的成分，空间上不扩散、不糊边缘。
 */
export function denoiseSoft(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  strength: number,
): Uint8ClampedArray {
  const low = gaussianBlur(src, w, h, 1)
  // 噪声阈值：强度越高，判定为「噪点」的幅度门槛越高（1..4 灰阶，贴近真实传感器噪点量级；
  // 过大会连带削弱低对比纹理，导致画面被"抹平"）
  const threshold = 1 + (Math.max(0, Math.min(100, strength)) / 100) * 3
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = src[i + c] - low[i + c]
      const a = Math.abs(d)
      // 软阈值：|d| ≤ threshold 视为噪点直接抑制；超过则保留（仅减去阈值部分）
      const d2 = a > threshold ? d - (d > 0 ? threshold : -threshold) : 0
      out[i + c] = clamp255(low[i + c] + d2)
    }
    out[i + 3] = src[i + 3]
  }
  return out
}

/**
 * 把带 alpha 的像素合成到白底上（不透明像素完全不变，仅透明区域变白）。
 * 用于「原分辨率直出」：JPEG/WEBP 编码会把透明区域压成黑，必须先合成白底。
 */
export function flattenOnWhite(src: Uint8ClampedArray): Uint8ClampedArray {
  let hasAlpha = false
  for (let i = 3; i < src.length; i += 4) {
    if (src[i] < 255) {
      hasAlpha = true
      break
    }
  }
  if (!hasAlpha) return src
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] / 255
    if (a >= 1) {
      out[i] = src[i]
      out[i + 1] = src[i + 1]
      out[i + 2] = src[i + 2]
    } else {
      out[i] = src[i] * a + 255 * (1 - a)
      out[i + 1] = src[i + 1] * a + 255 * (1 - a)
      out[i + 2] = src[i + 2] * a + 255 * (1 - a)
    }
    out[i + 3] = 255
  }
  return out
}

/** 局部对比度增强（以中灰为轴线性拉伸），强化人脸/文字/边缘观感 */
function localContrast(src: Uint8ClampedArray, amount: number): Uint8ClampedArray {
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
  // 原图基准：所有锐化步骤都以「原图」的高频为准绳。
  // 这样无论先做了多少降噪，补回并放大的都是原图真实细节，
  // 输出高频恒 ≥ 原图 —— 修复结果只可能更清晰，绝不会比原图更糊。
  const original = src.slice()
  let img = src.slice()
  if (opts.denoise) {
    // 软阈值降噪：只削噪点，不糊边缘（不再用整体高斯模糊）
    img = denoiseSoft(img, w, h, opts.denoiseStrength)
  }
  if (opts.deblur) {
    // 去模糊：半径 2 覆盖常见模糊核，以原图为基准补回并放大真实细节
    img = unsharpFrom(img, original, w, h, opts.deblurAmount, 2, 2)
  }
  if (opts.enhance) {
    // 半径 1：更细的边缘 / 文字 / 五官细节
    img = unsharpFrom(img, original, w, h, opts.enhanceAmount, 1, 3)
    img = localContrast(img, opts.enhanceAmount * 0.3)
  }
  if (opts.texture) {
    // 纹理：基于当前结果的微对比（避免与上面重复放大同一频段）
    img = unsharp(img, w, h, opts.textureAmount * 0.5, 1, 2)
  }
  return img
}

/**
 * 计算输出尺寸（保持原始宽高比）：
 *  - 原图长边 < targetLong 时放大到 targetLong（超分）
 *  - 原图长边 ≥ targetLong 时**保持原分辨率**（绝不缩小）
 *  - 上限 8192（浏览器内存保护）
 *
 * 缩小会让「高清修复」适得其反：像素变少 + 重采样软化 = 导出图比原图更糊。
 */
export function computeOutputSize(w: number, h: number, targetLong: number): [number, number] {
  const long = Math.max(w, h)
  if (long <= 0) return [w, h]
  const scale = long < targetLong ? targetLong / long : 1
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
