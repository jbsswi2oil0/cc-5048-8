// 纯 JS 确定性声源信号：与 sound-sources.js 的程序化合成同源（啁啾鸟鸣 / 噪声脚步 / FM 钟声），
// 但直接输出浮点数组，便于在离线逐块渲染中对两条信号链做样本级对齐比较。
// 无随机数依赖：噪声用固定种子的 LCG，保证回归场景逐样本可复现。

import { SAMPLE_RATE } from './hrir.js';

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function brownNoise(n, seed) {
  const rnd = seededRandom(seed);
  const out = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    last = 0.98 * last + 0.02 * w;
    out[i] = last * 3.2;
  }
  return out;
}

function addChirp(out, t0, dur, f0, f1, amp, sr) {
  const i0 = Math.floor(t0 * sr);
  const i1 = Math.floor((t0 + dur) * sr);
  for (let i = i0; i < i1 && i < out.length; i++) {
    const rel = i / sr - t0;
    const p = rel / dur;
    const phase = 2 * Math.PI * (f0 * rel + 0.5 * (f1 - f0) * rel * rel);
    out[i] += amp * Math.sin(Math.PI * p) * Math.sin(phase);
  }
}

// 鸟鸣：调频啁啾，循环 2.8s
export function makeBirdSignal(totalSamples, sr = SAMPLE_RATE) {
  const loop = 2.8;
  const out = new Float32Array(totalSamples);
  const chirps = [0.1, 0.9, 1.7, 2.35];
  for (let base = 0; base < totalSamples / sr; base += loop) {
    chirps.forEach((t0, k) => {
      addChirp(out, base + t0, 0.22, 1800 + 200 * (k % 2), 2600, 0.32, sr);
      addChirp(out, base + t0 + 0.03, 0.18, 3600, 4200, 0.12, sr);
    });
  }
  return out;
}

// 脚步：滤波噪声爆发，循环 3.2s
export function makeFootstepSignal(totalSamples, sr = SAMPLE_RATE) {
  const loop = 3.2;
  const noise = brownNoise(totalSamples, 7331);
  const out = new Float32Array(totalSamples);
  const steps = [0.1, 0.65, 1.2, 1.75, 2.3, 2.85];
  for (let base = 0; base < totalSamples / sr; base += loop) {
    for (let k = 0; k < steps.length; k++) {
      const t0 = base + steps[k];
      const i0 = Math.floor(t0 * sr);
      const i1 = Math.floor((t0 + 0.12) * sr);
      for (let i = i0; i < i1 && i < out.length; i++) {
        const rel = i / sr - t0;
        const p = rel / 0.12;
        const lp = Math.exp(-rel * 42) * (1 - p);
        out[i] += noise[i] * 0.85 * lp * (k % 2 ? 0.75 : 1);
      }
    }
  }
  return out;
}

// 钟声：FM/加性，带指数衰减，循环 4.5s
export function makeBellSignal(totalSamples, baseFreq = 440, sr = SAMPLE_RATE) {
  const loop = 4.5;
  const out = new Float32Array(totalSamples);
  const partials = [
    { r: 1, a: 0.5, t: 2.2 },
    { r: 2.01, a: 0.22, t: 1.4 },
    { r: 2.71, a: 0.16, t: 1.0 },
    { r: 3.76, a: 0.1, t: 0.7 },
    { r: 5.4, a: 0.06, t: 0.45 },
  ];
  for (let base = 0; base < totalSamples / sr; base += loop) {
    const i1 = Math.min(totalSamples, Math.floor((base + loop) * sr));
    for (let i = Math.floor(base * sr); i < i1; i++) {
      const t = i / sr - base;
      let v = 0;
      for (const p of partials) {
        v += p.a * Math.sin(2 * Math.PI * baseFreq * p.r * t) * Math.exp(-t / p.t);
      }
      if (t > loop - 0.1) v *= (loop - t) / 0.1;
      out[i] += v * 0.55;
    }
  }
  return out;
}

export function makeSignal(kind, totalSamples, bellFreq = 440, sr = SAMPLE_RATE) {
  if (kind === 'bird') return makeBirdSignal(totalSamples, sr);
  if (kind === 'footstep') return makeFootstepSignal(totalSamples, sr);
  return makeBellSignal(totalSamples, bellFreq, sr);
}
