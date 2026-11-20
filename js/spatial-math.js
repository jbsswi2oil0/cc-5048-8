// 与 spatial-worklet.js 完全相同的空间化数学，供主线程降级路径使用。
// 约定：听者固定在原点 (0,0)，面向 +Y；X 为左右（负=左）。
export const SPATIAL_NEAR = 0.6;
export const SPATIAL_FAR = 14;
export const INV_SQRT2 = Math.SQRT1_2;

// 给定声源位置/范围/外部增益/折叠系数，返回 {gL, gR, dist, pan, width, distGain}
export function spatialCoefficients(x, y, range, extGain = 1, fold = 0) {
  const dist = Math.sqrt(x * x + y * y);
  const pan = dist > 1e-9 ? x / dist : 0;
  const dEff = Math.max(dist, SPATIAL_NEAR);
  const distGain = SPATIAL_FAR / (SPATIAL_FAR + dEff);

  const theta = (Math.max(-1, Math.min(1, pan)) + 1) * (Math.PI / 4);
  let gL = Math.cos(theta);
  let gR = Math.sin(theta);

  const width = Math.max(0, Math.min(1, 1 - dist / Math.max(range, 1e-6)));
  gL = (1 - width) * gL + width * INV_SQRT2;
  gR = (1 - width) * gR + width * INV_SQRT2;

  if (fold > 0) {
    gL = (1 - fold) * gL + fold * INV_SQRT2;
    gR = (1 - fold) * gR + fold * INV_SQRT2;
  }
  const g = distGain * extGain;
  return { gL: g * gL, gR: g * gR, dist, pan, width, distGain };
}

// 方位角（度）：0=正前方，负=左，正=右，±180=正后方
export function azimuthDeg(x, y) {
  const a = Math.atan2(x, y) * 180 / Math.PI;
  return Math.max(-180, Math.min(180, a));
}

export function directionLabel(deg) {
  const dirs = ['正前', '右前', '右', '右后', '正后', '左后', '左', '左前'];
  let idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return dirs[idx];
}
