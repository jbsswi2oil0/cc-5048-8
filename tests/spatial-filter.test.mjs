// 空间滤波子系统的纯逻辑测试（node 直接运行）：
// 卷积预算/计数、相对运动缓存失效、增益零淘汰、共享状态、旧尾音、对齐比较、回归场景阈值。
import {
  synthHrir, convolveBlock, geometryKey, relativeAzimuth, HRIR_TAPS, AZIMUTH_BIN_DEG,
} from '../js/spatial-filter/hrir.js';
import { FilterCache, CACHE_REASONS } from '../js/spatial-filter/filter-cache.js';
import { BinauralRenderer } from '../js/spatial-filter/renderer.js';
import { BUILTIN_SCENES, getScene } from '../js/spatial-filter/scenarios.js';
import {
  runScenario, peakEnergyDbDelta, findShortestAudibleDeviation, BUDGET_PRESETS,
} from '../js/spatial-filter/audition.js';
import { compareRenders } from '../js/spatial-filter/analysis.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('FAIL:', msg); }
}
function approx(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

// ---------- 1. HRIR 确定性与对称性 ----------
{
  const hL = synthHrir(0.5, 4, -1);
  const hL2 = synthHrir(0.5, 4, -1);
  const hR = synthHrir(0.5, 4, +1);
  assert(hL.length === HRIR_TAPS && hR.length === HRIR_TAPS, 'HRIR 长度 = 64 taps');
  let same = true;
  for (let i = 0; i < HRIR_TAPS; i++) if (!approx(hL[i], hL2[i])) same = false;
  assert(same, '同参数 HRIR 逐样本确定（无随机性）');
  // 右侧声源：右耳 ITD 更短，能量重心更靠前
  let centroidL = 0, centroidR = 0, normL = 0, normR = 0;
  for (let i = 0; i < HRIR_TAPS; i++) {
    centroidL += i * hL[i] * hL[i]; normL += hL[i] * hL[i];
    centroidR += i * hR[i] * hR[i]; normR += hR[i] * hR[i];
  }
  assert(centroidR / normR < centroidL / normL, '右侧声源右耳能量重心先到（ITD 正确）');
}

// ---------- 2. 几何键量化与朝向（相对运动） ----------
{
  const k1 = geometryKey(2, 5, 0);
  const k2 = geometryKey(2, 5, Math.PI * 2); // 转一整圈应同键
  assert(k1 === k2, '朝向周期 2π 后几何键不变');
  const kTurn = geometryKey(2, 5, Math.PI / 2); // 转头 90° 必变键
  assert(kTurn !== k1, '转头改变相对方位 -> 几何键变化（相对运动失效基础）');
  // 同一量化 bin 内的小幅物理错位同键
  const kA = geometryKey(2.0, 5.0, 0);
  const kB = geometryKey(1.7, 4.7, 0);
  assert(kA === kB, '同量化 bin 的物理错位共享几何键');
  assert(approx(relativeAzimuth(0, 5, 0), 0), '正前方相对方位为 0');
  assert(AZIMUTH_BIN_DEG === 15, '方位量化 bin 宽度为 15°（共享粒度）');
}

// ---------- 3. 卷积预算：实际卷积数受限，折叠对象 0 卷积 ----------
for (const scene of BUILTIN_SCENES) {
  for (const preset of BUDGET_PRESETS) {
    const r = new BinauralRenderer(scene, {
      mode: 'budgeted', budgetConvolutions: preset.value,
    }).render();
    let over = 0;
    for (const b of r.blockLog) {
      if (b.convolutions > preset.value) over++;
      // 每块卷积数必为 2 的倍数（每耳一次）
      if (b.convolutions % 2 !== 0) assert(false, `${scene.id} 卷积数为偶数`);
    }
    assert(over === 0, `${scene.id} 预算 ${preset.value}：无块超支`);
  }
  const full = new BinauralRenderer(scene, { mode: 'full' }).render();
  const nObj = scene.objects.length;
  assert(full.blockLog.every((b) => b.convolutions === 2 * nObj),
    `${scene.id} 全量渲染每块卷积 = 2×对象数`);
}

// ---------- 4. 相对运动失效缓存，静止对象零失效 ----------
{
  const scene = getScene('occlude-near');
  const r = new BinauralRenderer(scene, { mode: 'full' }).render();
  const gainer = r.cacheEvents.filter((e) => e.objectId === 'gainer');
  const motionGainer = gainer.filter((e) => e.reason === CACHE_REASONS.INVALIDATE_MOTION);
  assert(motionGainer.length === 0, '方位固定的 gainer：相对运动失效为 0');
  const mover = r.cacheEvents.filter((e) =>
    e.objectId === 'mover' && e.reason === CACHE_REASONS.INVALIDATE_MOTION);
  assert(mover.length > 0, '逼近的 mover：发生相对运动失效');
}

// ---------- 5. 增益依赖：纯音量调整零缓存淘汰 ----------
{
  const scene = getScene('occlude-near');
  const r = new BinauralRenderer(scene, { mode: 'full' }).render();
  const gainerEvents = r.cacheEvents.filter((e) => e.objectId === 'gainer');
  const gainAdjusts = gainerEvents.filter((e) => e.reason === 'gain-adjust');
  const evictions = gainerEvents.filter((e) =>
    [CACHE_REASONS.INVALIDATE_MOTION, CACHE_REASONS.EVICT_LRU, CACHE_REASONS.MISS].includes(e.reason));
  assert(gainAdjusts.length >= 1, 'gainer 的音量调整被显式记录');
  // gainer 仅在冷启动有一次 miss，音量变化后不应再产生任何 miss/失效
  const afterGain = gainerEvents.filter((e) => e.block > 600);
  assert(afterGain.every((e) => e.reason === 'hit' || e.reason === 'gain-adjust'),
    '音量变化后 gainer 仅命中/增益事件，零重算零淘汰');
  assert(evictions.length <= 1, 'gainer 全段至多冷启动一次 miss（增益零淘汰）');
}

// ---------- 6. 临时共享计算状态：同 bin 对象复用 HRIR ----------
{
  const scene = getScene('shared-filter');
  const r = new BinauralRenderer(scene, { mode: 'full' }).render();
  const shares = r.cacheEvents.filter((e) =>
    e.reason === CACHE_REASONS.SHARE && e.objectId === 'follower');
  assert(shares.length > 100, 'follower 在静止窗口持续共享 lead 的 HRIR');
  assert(shares.every((e) => e.ownerId === 'lead'), '共享来源稳定指向 lead');
  const report = runScenario(scene, { budgetConvolutions: 6 });
  assert(report.worstPairs.length >= 1 && report.worstPairs[0].pair.includes('follower'),
    '误差最大对象组合识别为 lead~follower');
}

// ---------- 7. 旧尾音：几何切换块产生交叉淡化与可测尾音能量 ----------
{
  const scene = getScene('crossing-turn');
  const r = new BinauralRenderer(scene, { mode: 'full' }).render();
  const tails = r.blockLog.flatMap((b) => b.tails);
  assert(tails.length > 0, '轨迹交叉/转身产生旧尾音过渡块');
  const audible = tails.filter((t) => t.tailEnergy > 0);
  assert(audible.length > 0, '部分过渡块旧尾音能量 > 0');
  // 尾音在 HRIR 引用切换时出现（重算 miss 或共享 share 都会换 HRIR），
  // 因此块数不超过 miss+share 的总切换次数
  const switches = r.cacheEvents.filter((e) =>
    e.reason === CACHE_REASONS.MISS || e.reason === CACHE_REASONS.SHARE).length;
  assert(tails.length <= switches, '旧尾音块数不超过 HRIR 切换（重算+共享）次数');
}

// ---------- 8. 两耳对齐比较：相位/能量/误差与对齐时延 ----------
{
  const scene = getScene('crossing-turn');
  const report = runScenario(scene, { budgetConvolutions: 4 });
  const cmp = report.compare;
  assert(Number.isInteger(cmp.alignmentLagSamples), '输出对齐产生整数样本时延');
  assert(cmp.blockStats.length > 0, '逐块统计非空');
  for (const s of cmp.blockStats) {
    assert(s.rmsError >= 0, '块 RMS 误差非负');
    assert(s.coherence >= -1.0001 && s.coherence <= 1.0001, '相干性在 [-1,1]');
    assert(typeof s.phaseDeg === 'number' && s.phaseDeg >= 0 && s.phaseDeg <= 180.0001,
      '相位差在 [0,180] 度');
  }
  assert(cmp.worstBlock && cmp.worstBlock.rmsError > 0, '存在误差最大块');
  // 全量 vs 全量应几乎零误差（同链一致性）
  const a = new BinauralRenderer(scene, { mode: 'full' }).render();
  const b = new BinauralRenderer(scene, { mode: 'full' }).render();
  const self = compareRenders(a, b);
  assert(self.worstBlock.rmsError < 1e-9, '两次全量渲染逐样本一致（确定性回归基线）');
}

// ---------- 9. 收紧预算显示最大误差对象组合与重算时刻 ----------
{
  const scene = getScene('crossing-turn');
  const tight = runScenario(scene, { budgetConvolutions: 2 });
  const loose = runScenario(scene, { budgetConvolutions: 6 });
  assert(tight.budget.totalConvolutions < loose.budget.totalConvolutions,
    '收紧预算降低实际卷积总数');
  assert(tight.compare.worstBlock.block >= 0, '收紧预算给出误差最大块时刻');
  assert(tight.recomputes.every((x) => Number.isFinite(x.t) && x.objects.length),
    '重算时刻清单含时间与对象');
  // 预算 2 时只有 1 个双耳名额，其余对象每块折叠
  const foldedBlocks = tight.budget.blockLog.filter((bl) => bl.folded.length >= 2);
  assert(foldedBlocks.length === tight.budget.blocks, '预算 2：每块恰有 2 个对象折叠');
}

// ---------- 10. 最短可听偏差回归场景 ----------
{
  const scene = getScene('shortest-deviation');
  const report = runScenario(scene, {
    budgetConvolutions: scene.regression.tightBudget,
  });
  const peak = peakEnergyDbDelta(report.compare);
  assert(peak >= scene.regression.minPeakDbDelta,
    `固化回归场景峰值能量差 ${peak.toFixed(2)}dB >= 阈值 ${scene.regression.minPeakDbDelta}dB`);
  // 探针在紧预算下被折叠（优先级最低）
  const probeFolded = report.budget.blockLog.some((bl) => bl.folded.includes('probe'));
  assert(probeFolded, '紧预算下探针被折叠，偏差可听');
  // 二分求解器返回可听的有限最短时长
  const found = findShortestAudibleDeviation(scene, { thresholdDb: 1.0 });
  assert(found.audible && Number.isFinite(found.duration) && found.duration > 0,
    '二分求出最短可听偏差轨迹时长');
  assert(found.peakDb >= found.thresholdDb, '最短轨迹仍越过听感阈值');
}

// ---------- 11. 两个低音量窄夹角对象：同相叠加变得明显，转头后分开 ----------
{
  const scene = getScene('crossing-turn');
  const subset = (ids) => new BinauralRenderer(
    { ...scene, objects: scene.objects.filter((o) => ids.includes(o.id)) },
    { mode: 'full' }
  ).render();
  const r1 = subset(['s1']);
  const r2 = subset(['s2']);
  const r12 = subset(['s1', 's2']);
  const sr = scene.sampleRate, bs = scene.blockSize;
  const b0 = Math.floor(3.5 * sr / bs), b1 = Math.floor(4.5 * sr / bs);

  // 同相占比：交叉窗口内两相干源同号样本应占绝对多数
  let same = 0, active = 0;
  for (let b = b0; b < b1; b++) {
    for (let i = b * bs; i < b * bs + bs; i++) {
      if (Math.abs(r1.outL[i]) + Math.abs(r2.outL[i]) < 0.0008) continue;
      active++;
      if (r1.outL[i] * r2.outL[i] > 0) same++;
    }
  }
  assert(same / active > 0.95, '交叉窗口两低音量相干源同相叠加（同号占比 >95%）');

  // 相长干涉：合成能量显著高于不相干叠加预期 sqrt(e1²+e2²)
  const rms = (r, ch) => {
    let s = 0, n = 0;
    const a = ch === 'L' ? r.outL : r.outR;
    for (let b = b0; b < b1; b++) for (let i = b * bs; i < b * bs + bs; i++) { s += a[i] * a[i]; n++; }
    return Math.sqrt(s / n);
  };
  for (const ch of ['L', 'R']) {
    const e1 = rms(r1, ch), e2 = rms(r2, ch), e12 = rms(r12, ch);
    const incoherent = Math.sqrt(e1 * e1 + e2 * e2);
    assert(e12 > incoherent * 1.2, `${ch} 耳同相相长叠加：实测能量 > 不相干预期 1.2×`);
  }

  // 转头把两源从同侧窄夹角分到不同耳侧（相对方位差显著拉大）
  const rel = (p, h) => Math.atan2(p.x, p.y) - h;
  const before = scene.objects.slice(0, 2).map((o) => rel(o.positionAt(4.5), 0));
  const after = scene.objects.slice(0, 2).map((o) => rel(o.positionAt(6.5), Math.PI / 2));
  const gapBefore = Math.abs(before[0] - before[1]);
  const gapAfter = Math.abs(after[0] - after[1]);
  assert(gapAfter > gapBefore * 1.5, '突然转头后两对象相对方位差显著拉大（分开）');
}

// ---------- 12. LRU 容量淘汰可触发 ----------
{
  const cache = new FilterCache(2);
  cache.setBlock(0);
  cache.lookup('a', 1, 5, 0);
  cache.setBlock(1); cache.lookup('b', -5, 2, 0);
  cache.setBlock(2); cache.lookup('c', 0, 9, 0); // 超出容量 -> LRU
  const evicts = cache.events.filter((e) => e.reason === CACHE_REASONS.EVICT_LRU);
  assert(evicts.length === 1, '容量超限触发一次 LRU 淘汰');
}

// ---------- 13. 卷积历史跨块连续（旧尾音延迟线） ----------
{
  const hrir = synthHrir(0.3, 5, -1);
  const hist = new Float32Array(HRIR_TAPS - 1);
  const block1 = convolveBlock(new Float32Array(256).fill(0.5), hrir, hist);
  const block2 = convolveBlock(new Float32Array(256).fill(0.5), hrir, hist);
  // 稳态常值输入下，两块尾部应收敛到同一稳态值（历史正确传递）
  assert(approx(block1[255], block2[255], 1e-5), '跨块卷积历史连续，稳态一致');
}

// ---------- 14. 项目自带回归场景 JSON：固化的最短可听偏差仍然越阈 ----------
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures/shortest-deviation.json'), 'utf8'));
  assert(fixture.kind === 'spatial-filter-regression', '回归场景 JSON 类型正确');
  assert(fixture.shortestAudible.audible === true, '固化最短轨迹标记为可听');
  assert(fixture.shortestAudible.peakDbDelta >= fixture.thresholdDb,
    '固化最短轨迹峰值偏差越过阈值');
  assert(fixture.probeKeyframes.length >= 8 && fixture.probeKeyframes[0].t === 0,
    '回归场景含可插值的探针关键帧');

  // 用固化关键帧重建场景并复算，确认当前引擎仍复现基线（防止引擎改动悄悄消除偏差）
  const base = getScene('shortest-deviation');
  const kf = fixture.probeKeyframes;
  const rebuilt = {
    ...base,
    objects: base.objects.map((o) => ({ ...o })),
  };
  const probe = rebuilt.objects.find((o) => o.id === 'probe');
  probe.positionAt = (t) => {
    if (t <= kf[0].t) return { x: kf[0].x, y: kf[0].y };
    for (let i = 0; i < kf.length - 1; i++) {
      if (t <= kf[i + 1].t) {
        const k = (t - kf[i].t) / (kf[i + 1].t - kf[i].t);
        return {
          x: kf[i].x + (kf[i + 1].x - kf[i].x) * k,
          y: kf[i].y + (kf[i + 1].y - kf[i].y) * k,
        };
      }
    }
    return { x: 0, y: 4 };
  };
  const report = runScenario(rebuilt, { budgetConvolutions: fixture.tightBudget });
  const peak = peakEnergyDbDelta(report.compare);
  assert(peak >= fixture.thresholdDb, `重建回归场景峰值 ${peak.toFixed(2)}dB 仍越阈`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
