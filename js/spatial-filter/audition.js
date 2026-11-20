// 试听编排：对同一场景分别跑全量渲染与预算渲染，复用分析模块产出面板/测试所需的完整报告；
// 另含「最短可听偏差」二分求解器：逐步缩短探针横向轨迹时长，找到仍超过听感阈值的最短轨迹，
// 结果固化为回归场景关键帧（见 scenarios.shortestDeviationScene）。

import { BinauralRenderer } from './renderer.js';
import {
  compareRenders, worstSharedPairs, recomputeTimeline, tailSummary, dependencyEvictionReport,
} from './analysis.js';

export const BUDGET_PRESETS = [
  { value: 2, label: '紧张（2 卷积/块 · 仅 1 个双耳对象）' },
  { value: 4, label: '有限（4 卷积/块 · 2 个双耳对象）' },
  { value: 6, label: '充足（6 卷积/块 · 3 个双耳对象）' },
];

export function runScenario(scene, { budgetConvolutions = 4, cacheCapacity = 12 } = {}) {
  const full = new BinauralRenderer(scene, { mode: 'full', cacheCapacity }).render();
  const budget = new BinauralRenderer(scene, {
    mode: 'budgeted', budgetConvolutions, cacheCapacity,
  }).render();
  const compare = compareRenders(full, budget);
  return {
    scene,
    budgetConvolutions,
    full,
    budget,
    compare,
    worstPairs: worstSharedPairs(budget, compare, scene),
    recomputes: recomputeTimeline(budget),
    tails: tailSummary(budget),
    dependency: dependencyEvictionReport(budget, scene),
  };
}

// 块级能量差峰值（dB）：回归场景的可听偏差判据
export function peakEnergyDbDelta(compare) {
  let peak = 0;
  for (const s of compare.blockStats) {
    if (Math.abs(s.energyDbDelta) > peak) peak = Math.abs(s.energyDbDelta);
  }
  return peak;
}

// 二分最短可听偏差：在 minDur..maxDur 之间找「峰值能量差 >= thresholdDb」的最短探针轨迹时长。
// 返回 { duration, peakDb, keyframes }，keyframes 可直接回填场景固化。
export function findShortestAudibleDeviation(baseScene, {
  thresholdDb = 1.0,
  tightBudget = 2,
  minDur = 0.2,
  maxDur = 2.0,
  tolerance = 0.05,
} = {}) {
  const probe = baseScene.objects.find((o) => o.id === baseScene.regression?.probeId);
  if (!probe) throw new Error('回归场景缺少 probe 对象');

  const buildVariant = (moveDur) => {
    const scene = {
      ...baseScene,
      objects: baseScene.objects.map((o) => ({ ...o })),
    };
    const probeObj = scene.objects.find((o) => o.id === probe.id);
    probeObj.positionAt = (t) => {
      // 0..moveDur 完成一次横向偏移再回到原位，其余时间静止在正前
      if (t >= moveDur) return { x: 0, y: 4 };
      const k = t / moveDur;
      const half = k < 0.5 ? k * 2 : 2 - k * 2;
      return { x: 3.4 * half, y: 4 - 0.8 * half };
    };
    return scene;
  };

  const measure = (moveDur) => {
    const variant = buildVariant(moveDur);
    const report = runScenario(variant, { budgetConvolutions: tightBudget });
    return peakEnergyDbDelta(report.compare);
  };

  // 先确认上界确实可听，再二分收敛
  if (measure(maxDur) < thresholdDb) {
    return { duration: null, peakDb: measure(maxDur), thresholdDb, audible: false };
  }
  let lo = minDur, hi = maxDur;
  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2;
    if (measure(mid) >= thresholdDb) hi = mid;
    else lo = mid;
  }
  const peakDb = measure(hi);
  return {
    duration: +hi.toFixed(3),
    peakDb: +peakDb.toFixed(3),
    thresholdDb,
    audible: true,
    tightBudget,
  };
}
