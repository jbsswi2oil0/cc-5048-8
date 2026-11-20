// 试听 / 回归场景：全部用关键帧确定性插值（线性位置、分段朝向与增益），
// 不依赖 Math.random，保证同一场景任意时刻、任意机器逐样本复现。
//
// 三个内置场景分别对应需求中的三类验证：
//   crossing-turn  轨迹交叉 + 突然转身：两个低音量、方向接近的对象先同相叠加，
//                  转头后分开；用于从两耳输出对齐比较相位、能量与旧尾音。
//   occlude-near   一个此前遮挡的声音突然移到听者近处（位置依赖），另一个保持方位
//                  仅调音量（增益依赖）；用两者触发的缓存淘汰范围区分两类依赖。
//   shortest-deviation  能听出预算偏差的最短轨迹，作为项目自带回归场景（含阈值断言）。

import { SAMPLE_RATE, BLOCK_SIZE } from './hrir.js';

// 关键帧插值：frames=[[t, value], ...]，段间线性，两端钳制
function keyframe(frames, t) {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 0; i < frames.length - 1; i++) {
    const [t0, v0] = frames[i];
    const [t1, v1] = frames[i + 1];
    if (t <= t1) {
      const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * k;
    }
  }
  return frames[frames.length - 1][1];
}

function posKeyframes(frames) {
  const xs = frames.map(([t, p]) => [t, p.x]);
  const ys = frames.map(([t, p]) => [t, p.y]);
  return (t) => ({ x: keyframe(xs, t), y: keyframe(ys, t) });
}

// 两个低音量、方向接近的对象：起始都在正前偏右的窄夹角内，t≈4s 轨迹交叉，
// 随后听者在 t=5s 快速转头 90°，两对象在新朝向下被分到不同耳侧。
function crossingTurnScene() {
  const duration = 9;
  const headingFrames = [
    [0, 0], [4.9, 0], [5.3, Math.PI / 2], [duration, Math.PI / 2],
  ];
  const objects = [
    {
      // 与 s2 共用基频 392Hz：窄夹角下两低音量声源相干、可同相相长叠加（谐波细节仍可区分）
      id: 's1', name: '低鸣 A', kind: 'bell', bellFreq: 392, priority: 2, baseGain: 0.16,
      positionAt: posKeyframes([
        [0, { x: 1.2, y: 7 }],
        [4, { x: 2.6, y: 4.2 }], // 交叉点附近
        [6, { x: 4.6, y: 1.6 }],
        [duration, { x: 6.5, y: -1.5 }],
      ]),
    },
    {
      // 同基频相干源：起始与 s1 窄夹角、低音量，叠加变得明显；转头后被分到不同耳侧
      id: 's2', name: '低鸣 B', kind: 'bell', bellFreq: 392, priority: 2, baseGain: 0.15,
      positionAt: posKeyframes([
        [0, { x: 2.4, y: 7 }],
        [4, { x: 2.4, y: 4.2 }], // 与 s1 几乎重合（窄夹角、低音量）
        [6, { x: 0.6, y: 2.2 }],
        [duration, { x: -2.6, y: 3.4 }],
      ]),
    },
    {
      id: 's3', name: '环境钟', kind: 'bird', priority: 3, baseGain: 0.5,
      positionAt: posKeyframes([
        [0, { x: -6, y: 3 }],
        [duration, { x: -5, y: -4 }],
      ]),
    },
  ];
  return {
    id: 'crossing-turn',
    name: '轨迹交叉 + 突然转身',
    description: '两个低音量窄夹角声源先同相叠加，t=5s 听者快速转头 90° 后分开到不同耳侧。',
    duration,
    sampleRate: SAMPLE_RATE,
    blockSize: BLOCK_SIZE,
    headingAt: (t) => keyframe(headingFrames, t),
    objects,
    landmarks: { crossingAt: 4.0, turnStart: 4.9, turnEnd: 5.3, closePair: ['s1', 's2'] },
  };
}

// 位置依赖 vs 增益依赖：
//   mover 前 3s 处于遮挡（occlusion 低）且在远处，t=3s 解除遮挡并快速移到听者近处；
//   gainer 全程方位基本不动，只在 t=3.5s 做一次纯音量调整。
function occludeNearScene() {
  const duration = 9;
  const objects = [
    {
      id: 'mover', name: '遮挡后逼近的脚步', kind: 'footstep', priority: 3, baseGain: 0.9,
      positionAt: posKeyframes([
        [0, { x: -5, y: 7 }],
        [3, { x: -4, y: 6 }],
        [4.5, { x: -1.2, y: 1.6 }], // 突然移到听者近处
        [duration, { x: -1, y: 1.2 }],
      ]),
      occlusionAt: (t) => (t < 3 ? 0.12 : t < 3.4 ? 0.12 + (t - 3) / 0.4 * 0.88 : 1),
    },
    {
      id: 'gainer', name: '方位固定仅调音量的鸟鸣', kind: 'bird', priority: 2, baseGain: 0.5,
      positionAt: posKeyframes([
        [0, { x: 5, y: 4 }],
        [duration, { x: 5, y: 4 }], // 完全不动
      ]),
      gainAt: (t) => (t < 3.5 ? 1 : t < 4 ? 1 - 0.6 * (t - 3.5) / 0.5 : 0.4),
    },
    {
      id: 'anchor', name: '参考钟声', kind: 'bell', bellFreq: 523.25, priority: 1, baseGain: 0.4,
      positionAt: posKeyframes([
        [0, { x: 0, y: 8 }],
        [duration, { x: 0, y: 8 }],
      ]),
    },
  ];
  return {
    id: 'occlude-near',
    name: '遮挡移近（位置依赖） vs 纯音量（增益依赖）',
    description: 'mover 解除遮挡并逼近触发位置型缓存失效；gainer 方位不动仅降音量，应零缓存失效。',
    duration,
    sampleRate: SAMPLE_RATE,
    blockSize: BLOCK_SIZE,
    headingAt: () => 0,
    objects,
    landmarks: { unoccludeAt: 3.0, gainChangeAt: 3.5, positionObject: 'mover', gainObject: 'gainer' },
  };
}

// 最短可听偏差回归：单个对象在正前方做一段越来越短的横向偏移；预算收紧（2 卷积/块）
// 时它被折叠，与全量渲染的能量差超过听感阈值的最短时长由测试二分确定并固化关键帧。
function shortestDeviationScene() {
  const duration = 4;
  const objects = [
    {
      id: 'probe', name: '偏差探针', kind: 'bell', bellFreq: 466.16, priority: 1, baseGain: 0.7,
      positionAt: posKeyframes([
        [0, { x: 0, y: 4 }],
        [0.6, { x: 3.4, y: 3.2 }],
        [1.4, { x: 0, y: 4 }],
        [duration, { x: 0, y: 4 }],
      ]),
    },
    {
      id: 'ref1', name: '高优先参考 1', kind: 'bird', priority: 3, baseGain: 0.5,
      positionAt: posKeyframes([
        [0, { x: -5, y: 2 }],
        [duration, { x: -4, y: -3 }],
      ]),
    },
    {
      id: 'ref2', name: '高优先参考 2', kind: 'footstep', priority: 2, baseGain: 0.5,
      positionAt: posKeyframes([
        [0, { x: 5, y: 2 }],
        [duration, { x: 4, y: -3 }],
      ]),
    },
  ];
  return {
    id: 'shortest-deviation',
    name: '最短可听偏差轨迹（回归）',
    description: '预算=2 时探针被折叠；固化的关键帧是能量差超过 1dB 阈值的最短横向轨迹。',
    duration,
    sampleRate: SAMPLE_RATE,
    blockSize: BLOCK_SIZE,
    headingAt: () => 0,
    objects,
    // 回归阈值：预算渲染相对全量渲染的块级能量差峰值（dB），低于该值则视为回归失败
    regression: { tightBudget: 2, minPeakDbDelta: 1.0, probeId: 'probe' },
  };
}

export const BUILTIN_SCENES = [crossingTurnScene(), occludeNearScene(), sharedFilterScene(), shortestDeviationScene()];

export function getScene(id) {
  return BUILTIN_SCENES.find((s) => s.id === id) || null;
}

// 共享计算状态：两个对象在中段长时间停在同一方位/距离量化 bin（15°/1m）内，
// 全量预算（6 卷积）下两者都做双耳卷积，但后入 bin 的对象复用先入者已合成的 HRIR（share）。
function sharedFilterScene() {
  const duration = 8;
  const objects = [
    {
      id: 'lead', name: '先导声源', kind: 'bell', bellFreq: 440, priority: 2, baseGain: 0.4,
      // 1.5s 进入静止 bin 并保持到 6s，与 follower 同键长时间共存
      positionAt: posKeyframes([
        [0, { x: -3, y: 6 }],
        [1.5, { x: 2.0, y: 5.0 }],
        [6, { x: 2.0, y: 5.0 }],
        [duration, { x: 3, y: 2 }],
      ]),
    },
    {
      id: 'follower', name: '跟随声源', kind: 'bell', bellFreq: 466.16, priority: 2, baseGain: 0.35,
      // 与 lead 同量化键（az1:d5）的小幅物理错位：x=1.7 使方位落入同一 15° bin，
      // 但与 lead(2.0,5.0) 物理位置不同——共享 HRIR 的量化误差由此产生；与 lead 同时进入、长时间保持
      positionAt: posKeyframes([
        [0, { x: 6, y: 3 }],
        [1.5, { x: 1.7, y: 4.7 }],
        [6, { x: 1.7, y: 4.7 }],
        [duration, { x: 5.5, y: 2.2 }],
      ]),
    },
    {
      id: 'distant', name: '远场参考', kind: 'bird', priority: 3, baseGain: 0.45,
      positionAt: posKeyframes([
        [0, { x: -6, y: 5 }],
        [duration, { x: -6, y: -4 }],
      ]),
    },
  ];
  return {
    id: 'shared-filter',
    name: '滤波状态共享（同量化 bin）',
    description: 'lead 与 follower 中段落在同一方位/距离量化 bin，follower 共享 lead 的 HRIR，误差按对象对测量。',
    duration,
    sampleRate: SAMPLE_RATE,
    blockSize: BLOCK_SIZE,
    headingAt: () => 0,
    objects,
    landmarks: { sharedPair: ['lead', 'follower'], shareWindow: [1.5, 6] },
  };
}

export { keyframe, posKeyframes };
