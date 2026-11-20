// 程序化声源合成：所有 AudioBuffer 在运行时按目标采样率生成，无外部资源。
// 每个对象的 buffer 固定时长，循环播放；播放位置通过 timelinePos % duration 锁定，
// 因此 seek/暂停/段落跳转后音频内容与时间基准严格一致，不会残留旧位置的声音。

function makeNoise(ctx, seconds, type = 'white') {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(seconds * sr));
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (type === 'brown') {
      last = 0.98 * last + 0.02 * w;
      d[i] = last * 3.2;
    } else {
      d[i] = w;
    }
  }
  return buf;
}

function toneAt(d, i, sr, t0, dur, f0, f1, amp, type = 'sine') {
  const rel = i / sr - t0;
  if (rel < 0 || rel >= dur) return;
  const p = rel / dur;
  const f = f0 + (f1 - f0) * p;
  const phase = 2 * Math.PI * ((f0 * rel) + 0.5 * (f1 - f0) * rel * rel);
  const env = Math.sin(Math.PI * p);
  let v = 0;
  if (type === 'sine') v = Math.sin(phase);
  else if (type === 'tri') v = 2 * Math.abs(2 * (phase / (2 * Math.PI) - Math.floor(phase / (2 * Math.PI) + 0.5))) - 1;
  d[i] += amp * env * v;
}

// 对象1：鸟鸣（调频啁啾，循环 2.8s）
export function makeBirdBuffer(ctx) {
  const sr = ctx.sampleRate, dur = 2.8;
  const buf = ctx.createBuffer(1, Math.floor(dur * sr), sr);
  const d = buf.getChannelData(0);
  const chirps = [0.1, 0.9, 1.7, 2.35];
  for (let i = 0; i < d.length; i++) {
    for (let k = 0; k < chirps.length; k++) {
      const t0 = chirps[k];
      toneAt(d, i, sr, t0, 0.22, 1800 + 200 * (k % 2), 2600, 0.32, 'sine');
      toneAt(d, i, sr, t0 + 0.03, 0.18, 3600, 4200, 0.12, 'sine');
    }
  }
  return buf;
}

// 对象2：脚步（滤波噪声爆发，循环 3.2s）
export function makeFootstepBuffer(ctx) {
  const sr = ctx.sampleRate, dur = 3.2;
  const buf = ctx.createBuffer(1, Math.floor(dur * sr), sr);
  const d = buf.getChannelData(0);
  const noise = makeNoise(ctx, dur, 'white').getChannelData(0);
  const steps = [0.1, 0.65, 1.2, 1.75, 2.3, 2.85];
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    let v = 0;
    for (let k = 0; k < steps.length; k++) {
      const rel = t - steps[k];
      if (rel >= 0 && rel < 0.12) {
        const p = rel / 0.12;
        const lp = Math.exp(-rel * 42) * (1 - p);
        v += noise[i] * 0.85 * lp * (k % 2 ? 0.75 : 1);
      }
    }
    d[i] = v;
  }
  return buf;
}

// 对象3：钟声（FM/加性，baseFreq 随叙事段落变化）
export function makeBellBuffer(ctx, baseFreq = 440) {
  const sr = ctx.sampleRate, dur = 4.5;
  const buf = ctx.createBuffer(1, Math.floor(dur * sr), sr);
  const d = buf.getChannelData(0);
  const partials = [
    { r: 1, a: 0.5, t: 2.2 },
    { r: 2.01, a: 0.22, t: 1.4 },
    { r: 2.71, a: 0.16, t: 1.0 },
    { r: 3.76, a: 0.1, t: 0.7 },
    { r: 5.4, a: 0.06, t: 0.45 },
  ];
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    let v = 0;
    for (const p of partials) {
      v += p.a * Math.sin(2 * Math.PI * baseFreq * p.r * t) * Math.exp(-t / p.t);
    }
    if (t > dur - 0.1) v *= (dur - t) / 0.1;
    d[i] = v * 0.55;
  }
  return buf;
}

// 环境声床：低频双嗡鸣 + 棕噪声气流（循环 8s，无空间声像，固定立体声床）
export function makeBedBuffer(ctx) {
  const sr = ctx.sampleRate, dur = 8;
  const buf = ctx.createBuffer(2, Math.floor(dur * sr), sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const brownL = makeNoise(ctx, dur, 'brown').getChannelData(0);
  const brownR = makeNoise(ctx, dur, 'brown').getChannelData(0);
  for (let i = 0; i < L.length; i++) {
    const t = i / sr;
    const drone =
      0.5 * Math.sin(2 * Math.PI * 55 * t) +
      0.35 * Math.sin(2 * Math.PI * 82.4 * t + 0.6) +
      0.18 * Math.sin(2 * Math.PI * 110 * t + 1.7);
    const lfo = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.08 * t);
    const windL = 0.28 * brownL[i] * lfo;
    const windR = 0.28 * brownR[i] * (0.75 + 0.25 * Math.sin(2 * Math.PI * 0.08 * t + 1.3));
    L[i] = drone * 0.3 + windL;
    R[i] = drone * 0.3 + windR;
  }
  return buf;
}

export const DURATIONS = { bird: 2.8, footstep: 3.2, bell: 4.5, bed: 8 };
