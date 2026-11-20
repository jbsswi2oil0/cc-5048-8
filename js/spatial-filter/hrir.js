// 确定性双耳空间滤波（HRIR）合成与 FIR 卷积。
// 设计要点（与 gain-only 声像互补，本模块引入真正的滤波器状态）：
//   - 每个耳朵是一条 64 tap 的 FIR：耳间时延 ITD（方位相关）+ 距离低通 + 耳廓梳状纹波；
//   - 滤波器系数只依赖「相对方位/距离」几何量，与增益无关——增益在滤波器外施加，
//     因此仅调音量不会令滤波缓存失效（位置依赖 vs 增益依赖的核心区分）；
//   - 全部用确定性公式生成，无随机数、无外部资源，离线/实时/Node 测试逐样本一致。

export const SAMPLE_RATE = 48000;
export const BLOCK_SIZE = 256;
export const HRIR_TAPS = 64;
export const AZIMUTH_BIN_DEG = 15; // 方位量化：同 bin 的对象可临时共享同一组滤波器
export const DISTANCE_BIN_M = 1; // 距离量化 bin（米）

const NEAR = 0.6;
const FAR = 14;
const ITD_MAX_SAMPLES = 28; // 约 0.58ms，与 SR=48k 匹配的最大耳间时延

// 距离增益：与 spatial-math.js 保持同一约定
export function distanceGain(dist) {
  return FAR / (FAR + Math.max(dist, NEAR));
}

// 听者朝向 heading（弧度，+Y 为 0，顺时针/向右为正）下，声源相对听者的方位角（弧度，正=右）
export function relativeAzimuth(x, y, heading) {
  return Math.atan2(x, y) - heading;
}

function normAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// 量化后的几何键：键相同即视为可共享同一份滤波器计算状态
export function geometryKey(x, y, heading) {
  const az = normAngle(relativeAzimuth(x, y, heading));
  const dist = Math.hypot(x, y);
  const azBin = Math.round((az * 180 / Math.PI) / AZIMUTH_BIN_DEG);
  const distBin = Math.round(dist / DISTANCE_BIN_M);
  return `az${azBin}:d${distBin}`;
}

// 距离造成的低通：越远高频衰减越强，返回一阶低通系数 alpha
function distanceLowpassAlpha(dist) {
  const norm = Math.min(1, Math.max(0, (dist - NEAR) / (FAR - NEAR)));
  const cutoff = 5200 - 3800 * norm; // 5.2kHz(近) -> 1.4kHz(远)
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + 1 / (tau * SAMPLE_RATE));
}

// 合成单耳 HRIR。side: -1=左耳, +1=右耳
export function synthHrir(azimuth, dist, side) {
  const az = normAngle(azimuth);
  const hrir = new Float32Array(HRIR_TAPS);

  // ITD：声源偏向某侧，该侧先到。对侧延迟最大 ITD_MAX，同侧为 0
  const earAdvance = side * Math.sin(az); // 右耳 side=+1：右侧 az>0 时为正
  const delaySamples = Math.round(0.5 * ITD_MAX_SAMPLES * (1 - earAdvance));

  const alpha = distanceLowpassAlpha(dist);
  let lp = 0;
  const rippleF = 2600 + 900 * Math.abs(Math.sin(az)); // 耳廓纹波频率随方位变化
  const ripplePhase = side * 0.9 * Math.sin(az);

  for (let n = 0; n < HRIR_TAPS; n++) {
    // 基础低通脉冲（一阶 IIR 冲激响应的采样）
    lp = alpha * ((n === 0 ? 1 : 0) + (1 - alpha) * (n === 0 ? 0 : lp));
    let v = lp;
    // 耳廓：方位相关的梳状/反射纹波，对侧耳衰减更明显（头影）
    const shadow = side * Math.sin(az) > 0 ? 1 : 0.55 + 0.45 * Math.cos(az) * 0;
    const contralateral = side * Math.sin(az) < 0 ? 0.62 : 1;
    v += 0.32 * Math.cos(2 * Math.PI * rippleF * (n / SAMPLE_RATE) + ripplePhase) * lp;
    v *= contralateral * shadow;
    hrir[n] = v;
  }

  // ITD：整体平移，前置补零
  const out = new Float32Array(HRIR_TAPS);
  for (let n = 0; n < HRIR_TAPS; n++) {
    const src = n - delaySamples;
    if (src >= 0) out[n] = hrir[src];
  }

  // Hann 窗，消除合成尾端的截断点击
  for (let n = 0; n < HRIR_TAPS; n++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (HRIR_TAPS - 1)));
    out[n] *= w;
  }

  // 归一化能量到一个稳定基准，避免不同几何间整体电平漂移（增益仍在滤波器外单独施加）
  let e = 0;
  for (let n = 0; n < HRIR_TAPS; n++) e += out[n] * out[n];
  const norm = e > 1e-12 ? 1 / Math.sqrt(e) : 1;
  for (let n = 0; n < HRIR_TAPS; n++) out[n] *= norm * 0.5;
  return out;
}

// 直接 FIR 卷积一个块，携带跨块的输入历史（旧尾音来自这里的延迟线）
export function convolveBlock(input, hrir, history) {
  const len = input.length;
  const out = new Float32Array(len);
  const M = HRIR_TAPS;
  for (let i = 0; i < len; i++) {
    let acc = 0;
    for (let k = 0; k < M; k++) {
      const idx = i - k;
      const s = idx >= 0 ? input[idx] : history[history.length + idx];
      acc += s * hrir[k];
    }
    out[i] = acc;
  }
  // 刷新历史：保留最后 M-1 个输入样本
  for (let k = 0; k < M - 1; k++) {
    const src = len - (M - 1) + k;
    history[k] = src >= 0 ? input[src] : 0;
  }
  return out;
}
