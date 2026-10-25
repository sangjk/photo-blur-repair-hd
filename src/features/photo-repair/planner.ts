/* =============================================================================
 * planner.ts —— 即梦式「条件约束下的恢复」：诊断规划器 + 连接器 + 执行编排
 *
 * 范式映射（对照《即梦图片修复技术逻辑文档》）：
 *   即梦 VLM 语义锚定   → analyzeImage：图像诊断，输出结构化 RepairPlan
 *                         （软件"知道自己在修什么"：退化类型、严重度、损伤位置）
 *   即梦 连接器         → planToOptions：计划 → 各阶段开关/强度/参考强度
 *                         （structurePreserve 即即梦"参考强度"的映射：
 *                          图越好越保守贴原图，越差越激进放开修复）
 *   即梦 Inpainting     → 损伤掩码 → repairDefects（只修损伤，不动完好像素）
 *   即梦 扩散细节生成   → repairImage 编排原图高频回收（unsharpFrom / IBP 系）
 *
 * 与即梦的本质差异（如实定位，不粉饰）：我们没有扩散模型，不做"无中生有"的
 * 细节生成；所有输出像素都源自原图本身——即梦文档 5.1 承认的语义猜测风险
 * （领带变色、纹理编造）在本管线里结构性不存在。代价是细节上限低于生成式，
 * 这是零依赖本地管线的自觉取舍。
 *
 * 零 npm 依赖（AGENT.md 铁律）；跨 feature 复用 portraitEngine 的已验证实现。
 * ========================================================================== */
import { clarityScore, denoiseSoft, enhanceImage, type EnhanceOptions } from './engine'
import { estimateBlurSigma, repairDefects } from '../portrait-repair/portraitEngine'

export type RepairIssueType =
  | 'blur'
  | 'noise'
  | 'salt'
  | 'defect'
  | 'fade'
  | 'scanlines'
  | 'lowres'

export interface RepairIssue {
  type: RepairIssueType
  /** 严重度 0..1 */
  severity: number
  /** 诊断卡片上显示的读数 */
  reading: string
}

export interface RepairPlan {
  issues: RepairIssue[]
  /** 清晰度 0..100 */
  clarity: number
  /** 估计模糊宽度（平均边缘剖面法，σ） */
  blurSigma: number
  /** 估计噪声水平（拉普拉斯 MAD，σ） */
  noiseSigma: number
  /** 泛黄程度 0..1（R-B 通道均差归一化） */
  yellowness: number
  /** 灰度 / 单色偏色（色相集中度判定） */
  monochrome: boolean
  /** 损伤掩码像素数（分析分辨率下） */
  defectPx: number
  /** 长条损伤（划痕/折痕）连通域数 */
  scratchCount: number
  /** 点块损伤（尘点/霉斑）连通域数 */
  dustCount: number
  /** 扫描线主峰幅值（灰阶） */
  scanlineAmp: number
  /** 参考强度 0..100（越高越保守贴原图；即梦 3.1 映射） */
  structurePreserve: number
  /** 连接器输出：建议参数（可直接喂 repairImage） */
  suggested: EnhanceOptions
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
function clamp01(v: number): number {
  return clamp(v, 0, 1)
}

/* ============================================================================
 * 分析工具（全部在长边 ≤512 的缩采样图上做，读数跨分辨率可比）
 * ========================================================================== */

/** 盒式面积平均降采样（分析用） */
function boxResize(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  ow: number,
  oh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(ow * oh * 4)
  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor((oy * h) / oh)
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * h) / oh))
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor((ox * w) / ow)
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * w) / ow))
      let r = 0
      let g = 0
      let b = 0
      let cnt = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4
          r += src[i]
          g += src[i + 1]
          b += src[i + 2]
          cnt++
        }
      }
      const o = (oy * ow + ox) * 4
      out[o] = r / cnt
      out[o + 1] = g / cnt
      out[o + 2] = b / cnt
      out[o + 3] = 255
    }
  }
  return out
}

/** 噪声水平估计：拉普拉斯 MAD 法（对边缘鲁棒，响应方差 = 20σ²） */
function noiseSigmaOf(gray: Float32Array, w: number, h: number): number {
  const laps: number[] = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      laps.push(4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - w] - gray[p + w])
    }
  }
  if (!laps.length) return 0.3
  laps.sort((a, b) => a - b)
  const med = laps[laps.length >> 1]
  const dev = new Float64Array(laps.length)
  for (let i = 0; i < laps.length; i++) dev[i] = Math.abs(laps[i] - med)
  dev.sort()
  return Math.max(0.3, (1.4826 * dev[dev.length >> 1]) / Math.sqrt(20))
}

/** 盒式均值图（半径 r），供局部 std 用 */
/** 一维最小/最大滤波（min/max 可分离，二维 = 先横后纵），半径 r = 3 即 7×7 核 */
function minFilter(gray: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity
      for (let dx = -r; dx <= r; dx++) {
        const xx = clamp(x + dx, 0, w - 1)
        const v = gray[y * w + xx]
        if (v < m) m = v
      }
      tmp[y * w + x] = m
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity
      for (let dy = -r; dy <= r; dy++) {
        const yy = clamp(y + dy, 0, h - 1)
        const v = tmp[yy * w + x]
        if (v < m) m = v
      }
      out[y * w + x] = m
    }
  }
  return out
}

function maxFilter(gray: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity
      for (let dx = -r; dx <= r; dx++) {
        const xx = clamp(x + dx, 0, w - 1)
        const v = gray[y * w + xx]
        if (v > m) m = v
      }
      tmp[y * w + x] = m
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity
      for (let dy = -r; dy <= r; dy++) {
        const yy = clamp(y + dy, 0, h - 1)
        const v = tmp[yy * w + x]
        if (v > m) m = v
      }
      out[y * w + x] = m
    }
  }
  return out
}

export interface DefectScanResult {
  mask: Uint8Array
  defectPx: number
  scratchCount: number
  dustCount: number
  saltRatio: number
}

/**
 * 损伤掩码扫描（形态学顶帽 / 黑帽）：
 *   暗斑（尘点/霉斑）= 闭运算(7×7) − 原图   —— 闭运算填掉比核小的暗特征
 *   亮痕（划痕/折痕）= 原图 − 开运算(7×7)   —— 开运算抹掉比核小的亮特征
 * 黑衣/白高光等大面积极值：直线边界在开/闭运算下精确不变 → 残差为 0，不误报；
 * 噪点残差 ~2σ < 40 阈值 → 不误报。文字块这类"环形残差"由连域空洞检验剔除
 * （环状连域的空洞面积 > 自身 15% → 判为内容边缘）。
 */
function defectScan(gray: Float32Array, w: number, h: number): DefectScanResult {
  const n = w * h
  // 闭运算 = 先膨胀(max)后侵蚀(min)，填掉比核小的暗特征，closing ≥ 原图
  const closing = minFilter(maxFilter(gray, w, h, 3), w, h, 3)
  // 开运算 = 先侵蚀(min)后膨胀(max)，抹掉比核小的亮特征，opening ≤ 原图
  const opening = maxFilter(minFilter(gray, w, h, 3), w, h, 3)
  const mask0 = new Uint8Array(n)
  let raw = 0
  for (let p = 0; p < n; p++) {
    const dark = closing[p] - gray[p]
    const bright = gray[p] - opening[p]
    if (dark > 40 || bright > 40) {
      mask0[p] = 1
      raw++
    }
  }
  // 膨胀 3×3：blob 内部残差弱，膨胀后整片覆盖
  const dil = new Uint8Array(n)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      if (mask0[p] || mask0[p - 1] || mask0[p + 1] || mask0[p - w] || mask0[p + w]) dil[p] = 1
    }
  }
  // 连通域（8 连通 BFS）过滤 4px ~ 2%，空洞检验剔环形内容边
  const label = new Int32Array(n).fill(-1)
  const maxArea = 0.02 * n
  const stack: number[] = []
  let scratchCount = 0
  let dustCount = 0
  const keep = new Uint8Array(n)
  for (let s = 0; s < n; s++) {
    if (!dil[s] || label[s] >= 0) continue
    const comp: number[] = []
    stack.push(s)
    label[s] = s
    while (stack.length) {
      const p = stack.pop() as number
      comp.push(p)
      const px = p % w
      const py = (p / w) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx
          const yy = py + dy
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue
          const q = yy * w + xx
          if (dil[q] && label[q] < 0) {
            label[q] = s
            stack.push(q)
          }
        }
      }
    }
    const area = comp.length
    if (area < 4 || area > maxArea) continue
    let minX = w
    let maxX = 0
    let minY = h
    let maxY = 0
    for (const p of comp) {
      const px = p % w
      const py = (p / w) | 0
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    // 空洞检验：bbox 内从边缘泛洪，非连域且不可达的像素 = 空洞
    const iw = bw + 2
    const ih = bh + 2
    const solid = new Uint8Array(iw * ih)
    for (const p of comp) solid[((p / w | 0) - minY + 1) * iw + ((p % w) - minX + 1)] = 1
    const reach = new Uint8Array(iw * ih)
    const q: number[] = []
    for (let x = 0; x < iw; x++) {
      q.push(x, (ih - 1) * iw + x)
    }
    for (let y = 0; y < ih; y++) {
      q.push(y * iw, y * iw + iw - 1)
    }
    for (const s2 of q) reach[s2] = 1
    let head = 0
    while (head < q.length) {
      const cur = q[head++]
      const cx = cur % iw
      const cy = (cur / iw) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx
          const yy = cy + dy
          if (xx < 0 || xx >= iw || yy < 0 || yy >= ih) continue
          const nxt = yy * iw + xx
          if (!reach[nxt] && !solid[nxt]) {
            reach[nxt] = 1
            q.push(nxt)
          }
        }
      }
    }
    let holes = 0
    for (let i = 0; i < iw * ih; i++) {
      if (!reach[i] && !solid[i]) holes++
    }
    if (holes > area * 0.15) continue
    // 线状（划痕/折痕）：足够长且平均线宽 ≤4px（bbox 长宽比对斜线不可靠）
    const longDim = Math.max(bw, bh)
    if (longDim >= 30 && area <= 4 * longDim) {
      scratchCount++
    } else {
      dustCount++
    }
    for (const p of comp) keep[p] = 1
  }
  return {
    mask: keep,
    defectPx: keep.reduce((a, v) => a + v, 0),
    scratchCount,
    dustCount,
    saltRatio: raw / n,
  }
}

/** 泛黄程度 + 灰度/单色判定（色相集中度，对应 Python v2 is_grayscale） */
function colorCast(a: Uint8ClampedArray, n: number): { yellowness: number; monochrome: boolean } {
  let sumR = 0
  let sumB = 0
  let chroma = 0
  const hues: number[] = []
  for (let p = 0; p < n; p++) {
    const r = a[p * 4]
    const g = a[p * 4 + 1]
    const b = a[p * 4 + 2]
    sumR += r
    sumB += b
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const s = mx === 0 ? 0 : ((mx - mn) / mx) * 255
    if (s > 30) {
      chroma++
      let hue: number
      if (mx === r) hue = (60 * ((g - b) / (mx - mn))) % 360
      else if (mx === g) hue = 60 * ((b - r) / (mx - mn) + 2)
      else hue = 60 * ((r - g) / (mx - mn) + 4)
      if (hue < 0) hue += 360
      hues.push(hue)
    }
  }
  const yellowness = clamp01((sumR - sumB) / (n * 255) / 0.2)
  if (chroma < n * 0.02 || hues.length === 0) return { yellowness, monochrome: true }
  hues.sort((x, y) => x - y)
  const med = hues[hues.length >> 1]
  const d = hues.map((hh) => {
    const dd = Math.abs(hh - med)
    return Math.min(dd, 360 - dd)
  })
  d.sort((x, y) => x - y)
  return { yellowness, monochrome: d[Math.floor(d.length * 0.9)] < 18 }
}

/** 扫描线主峰幅值：全分辨率行均值（亮度）去趋势 → DFT 频带 k∈[h/20, h/6]
 *  （周期 6~20px，网纹/扫描线的真实所在；大尺度行结构如色块/竖条在带外，
 *   避免把内容行结构误报成扫描线） */
function scanlineAmplitude(src: Uint8ClampedArray, w: number, h: number): number {
  const rm = new Float64Array(h)
  for (let y = 0; y < h; y++) {
    let s = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      s += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]
    }
    rm[y] = s / w
  }
  const res = new Float64Array(h)
  for (let y = 0; y < h; y++) {
    let s = 0
    let c = 0
    for (let k = -15; k <= 15; k++) {
      const yy = y + k
      if (yy >= 0 && yy < h) {
        s += rm[yy]
        c++
      }
    }
    res[y] = rm[y] - s / c
  }
  const kmin = Math.max(3, Math.floor(h / 20))
  const kmax = Math.floor(h / 6)
  let best = 0
  for (let k = kmin; k <= kmax; k++) {
    let re = 0
    let im = 0
    for (let y = 0; y < h; y++) {
      const ang = (2 * Math.PI * k * y) / h
      re += res[y] * Math.cos(ang)
      im -= res[y] * Math.sin(ang)
    }
    const amp = (2 * Math.hypot(re, im)) / h
    if (amp > best) best = amp
  }
  return best
}

/* ============================================================================
 * 诊断规划器（即梦 VLM 层的本地等价物）
 * ========================================================================== */
export function analyzeImage(src: Uint8ClampedArray, w: number, h: number): RepairPlan {
  const long = Math.max(w, h)
  const scale = Math.min(1, 512 / long)
  const aw = Math.max(1, Math.round(w * scale))
  const ah = Math.max(1, Math.round(h * scale))
  const a = scale < 1 ? boxResize(src, w, h, aw, ah) : src.slice()
  const n = aw * ah
  const gray = new Float32Array(n)
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    gray[p] = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]
  }

  const clarity = clarityScore(a, aw, ah)
  const blurSigma = estimateBlurSigma(a, aw, ah)
  const noiseSigma = noiseSigmaOf(gray, aw, ah)
  const scan = defectScan(gray, aw, ah)
  const { yellowness, monochrome } = colorCast(a, n)
  // 扫描线读数在全分辨率上测（缩采样会把周期 7px 压到 6px 以下、移出检测频带）
  const scanlineAmp = scanlineAmplitude(src, w, h)
  const lowres = long < 600

  const issues: RepairIssue[] = []
  if (blurSigma >= 0.8) {
    issues.push({ type: 'blur', severity: clamp01((blurSigma - 0.6) / 2.4), reading: `σ≈${blurSigma.toFixed(1)}` })
  }
  if (noiseSigma >= 2.5) {
    issues.push({ type: 'noise', severity: clamp01((noiseSigma - 2) / 8), reading: `σ≈${noiseSigma.toFixed(1)}` })
  }
  if (scan.saltRatio >= 0.001) {
    issues.push({ type: 'salt', severity: clamp01(scan.saltRatio * 100), reading: `${(scan.saltRatio * 100).toFixed(2)}%` })
  }
  if (scan.defectPx >= 40) {
    issues.push({
      type: 'defect',
      severity: clamp01((scan.defectPx / n) * 50),
      reading: `${scan.scratchCount}+${scan.dustCount}`,
    })
  }
  if (yellowness >= 0.15) {
    issues.push({ type: 'fade', severity: clamp01(yellowness * 1.5), reading: `${Math.round(yellowness * 100)}%` })
  }
  if (scanlineAmp >= 1.5) {
    issues.push({ type: 'scanlines', severity: clamp01(scanlineAmp / 8), reading: `±${scanlineAmp.toFixed(1)}` })
  }
  if (lowres) {
    issues.push({ type: 'lowres', severity: clamp01((600 - long) / 300), reading: `${long}px` })
  }

  // 参考强度（即梦 3.1 映射）：退化越重越激进，图越好越保守贴原图。
  // 注意不能用 clarityScore —— 拉普拉斯方差被噪声支配（噪声图反而高分），
  // 直边结构又会因 4 邻域拉普拉斯抵消而低分；退化信号用盲估计量更可靠。
  let structurePreserve = 80
  if (blurSigma >= 0.8) structurePreserve -= 20
  if (noiseSigma >= 2.5) structurePreserve -= 10
  if (scan.defectPx > n * 0.005) structurePreserve -= 10
  structurePreserve = Math.round(clamp(structurePreserve, 40, 80))

  const plan: RepairPlan = {
    issues,
    clarity: Math.round(clarity),
    blurSigma,
    noiseSigma,
    yellowness,
    monochrome,
    defectPx: scan.defectPx,
    scratchCount: scan.scratchCount,
    dustCount: scan.dustCount,
    scanlineAmp,
    structurePreserve,
    suggested: {
      denoise: false,
      denoiseStrength: 45,
      deblur: false,
      deblurAmount: 45,
      enhance: false,
      enhanceAmount: 35,
      texture: false,
      textureAmount: 25,
      defect: false,
      colorFix: false,
      scanlineFix: false,
      targetLongEdge: 1920,
      format: 'image/jpeg',
      quality: 0.92,
    },
  }
  plan.suggested = planToOptions(plan)
  return plan
}

/* ============================================================================
 * 连接器（即梦 connector 的等价物）：计划 → 扩散条件 的本地映射
 * ========================================================================== */
export function planToOptions(
  plan: Pick<
    RepairPlan,
    'blurSigma' | 'noiseSigma' | 'defectPx' | 'yellowness' | 'scanlineAmp' | 'structurePreserve'
  >,
  base?: Partial<EnhanceOptions>,
): EnhanceOptions {
  // 激进度：参考强度 40 → 1.0（全开），80 → 0.33（保守）
  const aggressive = (100 - plan.structurePreserve) / 60
  return {
    denoise: plan.noiseSigma >= 2.5,
    denoiseStrength: Math.round(clamp(plan.noiseSigma * 7, 15, 70)),
    deblur: plan.blurSigma >= 0.8,
    deblurAmount: Math.round(clamp(plan.blurSigma * 24, 25, 75)),
    enhance: true,
    enhanceAmount: Math.round(clamp(15 + 30 * aggressive, 15, 45)),
    texture: false,
    textureAmount: 20,
    defect: plan.defectPx >= 40,
    colorFix: plan.yellowness >= 0.15,
    scanlineFix: plan.scanlineAmp >= 1.5,
    targetLongEdge: base?.targetLongEdge ?? 1920,
    format: base?.format ?? 'image/jpeg',
    quality: base?.quality ?? 0.92,
  }
}

/* ============================================================================
 * 执行编排（即梦 扩散执行层的本地等价物；顺序对应文档 5.4「先结构后色彩」）
 *   ① 扫描线/网纹（行周期分量扣除）
 *   ② 缺陷修复（划痕/折痕/尘点/压缩块/色斑，复用 portraitEngine.repairDefects）
 *   ③ enhanceImage（降噪 → 去模糊 → 增强 → 纹理；细节层恒以原图为基准）
 *   ④ 偏色校正（灰世界 + 亮度拉伸，放最后不被后续步骤洗掉）
 * ========================================================================== */

/** 扫描线去除：行均值 DFT 主峰（≥1.5 灰阶、周期 ≥6px）逐行扣除，≤4 个峰 */
export function fixScanlines(src: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  type Peak = { k: number; amp: number; phase: number }
  const peaksPerChan: Peak[][] = []
  let any = false
  for (let c = 0; c < 3; c++) {
    const rm = new Float64Array(h)
    for (let y = 0; y < h; y++) {
      let s = 0
      for (let x = 0; x < w; x++) s += src[(y * w + x) * 4 + c]
      rm[y] = s / w
    }
    const res = new Float64Array(h)
    for (let y = 0; y < h; y++) {
      let s = 0
      let cnt = 0
      for (let k = -15; k <= 15; k++) {
        const yy = y + k
        if (yy >= 0 && yy < h) {
          s += rm[yy]
          cnt++
        }
      }
      res[y] = rm[y] - s / cnt
    }
    const kmin = Math.max(3, Math.floor(h / 20))
    const kmax = Math.floor(h / 6)
    const cands: Peak[] = []
    for (let k = kmin; k <= kmax; k++) {
      let re = 0
      let im = 0
      for (let y = 0; y < h; y++) {
        const ang = (2 * Math.PI * k * y) / h
        re += res[y] * Math.cos(ang)
        im -= res[y] * Math.sin(ang)
      }
      const amp = (2 * Math.hypot(re, im)) / h
      if (amp >= 1.5) cands.push({ k, amp, phase: Math.atan2(im, re) })
    }
    cands.sort((a, b) => b.amp - a.amp)
    const top = cands.slice(0, 4)
    peaksPerChan.push(top)
    if (top.length) any = true
  }
  if (!any) return src.slice()
  const out = new Uint8ClampedArray(src.length)
  for (let y = 0; y < h; y++) {
    const off = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      for (const pk of peaksPerChan[c]) {
        off[c] -= pk.amp * Math.cos((2 * Math.PI * pk.k * y) / h + pk.phase)
      }
    }
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      out[i] = src[i] + off[0]
      out[i + 1] = src[i + 1] + off[1]
      out[i + 2] = src[i + 2] + off[2]
      out[i + 3] = src[i + 3]
    }
  }
  return out
}

/** 偏色校正：① 灰世界白平衡（强度 0.8，防过纠） ② 亮度 Y 百分位拉伸（保色相） */
export function colorFix(src: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const n = w * h
  let mr = 0
  let mg = 0
  let mb = 0
  const yHist = new Float64Array(256)
  for (let p = 0; p < n; p++) {
    const i = p * 4
    mr += src[i]
    mg += src[i + 1]
    mb += src[i + 2]
    const y = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]
    yHist[clamp(Math.round(y), 0, 255)]++
  }
  mr /= n
  mg /= n
  mb /= n
  const gray = (mr + mg + mb) / 3
  // RGBA 通道序：R→mr、G→mg、B→mb（别照搬 OpenCV 的 BGR 口径）
  const gain = [1 + 0.8 * (gray / (mr + 1e-6) - 1), 1 + 0.8 * (gray / (mg + 1e-6) - 1), 1 + 0.8 * (gray / (mb + 1e-6) - 1)]
  // 亮度百分位（0.5% / 99.5%）
  let lo = 0
  let hi = 255
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += yHist[v]
    if (acc >= n * 0.005) {
      lo = v
      break
    }
  }
  acc = 0
  for (let v = 255; v >= 0; v--) {
    acc += yHist[v]
    if (acc >= n * 0.005) {
      hi = v
      break
    }
  }
  const range = Math.max(1, hi - lo)
  const out = new Uint8ClampedArray(src.length)
  for (let p = 0; p < n; p++) {
    const i = p * 4
    for (let c = 0; c < 3; c++) {
      const v = src[i + c] * gain[c]
      const y = 0.299 * v + 0.587 * src[i + 1] * gain[1] + 0.114 * src[i + 2] * gain[2]
      const y2 = clamp(((y - lo) / range) * 255, 0, 255)
      const s = y > 1 ? clamp(y2 / y, 0.5, 2) : 1
      out[i + c] = clamp(v * s, 0, 255)
    }
    out[i + 3] = src[i + 3]
  }
  return out
}

/** 完整修复编排：按计划/手动参数跑 ①→④，顺序即文档 5.4 的分步原则 */
export function repairImage(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  opts: EnhanceOptions,
): Uint8ClampedArray {
  let img = src.slice()
  if (opts.scanlineFix) img = fixScanlines(img, w, h)
  // 降噪先行：先把噪声底压掉，缺陷修复才不会把噪点当细线吃进去，
  // 也避免 repairDefects 内部的 JPEG 去块在噪声图上误触发强平滑（实测清晰度 -20）
  if (opts.denoise) img = denoiseSoft(img, w, h, opts.denoiseStrength)
  if (opts.defect) img = repairDefects(img, w, h, 'auto').data
  img = enhanceImage(img, w, h, { ...opts, denoise: false })
  if (opts.colorFix) img = colorFix(img, w, h)
  return img
}
