// 渲染结果分析：把「预算渲染」与「全量渲染」从两耳输出逐样本对齐，
// 输出每块的相位差、能量差、旧尾音，以及收紧预算时误差最大的对象组合与触发重算时刻。
// 所有指标纯函数计算，可在 Node 测试与浏览器面板复用。

function rms(a, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

// 子样本对齐：在 ±maxLag 样本内用互相关找最优时延，返回应平移量
function alignmentLag(refL, refR, tgtL, tgtR, maxLag = 64) {
  let bestLag = 0;
  let bestCorr = -Infinity;
  const n = refL.length;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = maxLag; i < n - maxLag; i++) {
      const j = i + lag;
      if (j < 0 || j >= n) continue;
      corr += refL[i] * tgtL[j] + refR[i] * tgtR[j];
    }
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  return bestLag;
}

// 两信号在一块内的相位差（度）：以归一化内积作为相干性 cos(phi)，稳健且无反正切卷绕
function phaseDifferenceDeg(a, b, from, to) {
  let dot = 0, ea = 0, eb = 0;
  for (let i = from; i < to; i++) {
    dot += a[i] * b[i];
    ea += a[i] * a[i];
    eb += b[i] * b[i];
  }
  const coherence = dot / Math.sqrt((ea || 1e-12) * (eb || 1e-12));
  const phi = Math.acos(Math.max(-1, Math.min(1, coherence))) * 180 / Math.PI;
  return { phaseDeg: phi, coherence };
}

// 主入口：对齐比较两条渲染（ref=全量，tgt=预算）
export function compareRenders(ref, tgt) {
  const n = Math.min(ref.outL.length, tgt.outL.length);
  const lag = alignmentLag(ref.outL, ref.outR, tgt.outL, tgt.outR);

  const bs = ref.blockSize;
  const blockStats = [];
  let worst = null;

  for (let b = 0; b < ref.blocks; b++) {
    const from = b * bs;
    const to = Math.min(n, from + bs);
    if (to - from < 8) break;

    const shift = (i) => i + lag;
    let se = 0;
    for (let i = from; i < to; i++) {
      const j = shift(i);
      const dl = j >= 0 && j < n ? tgt.outL[j] - ref.outL[i] : ref.outL[i];
      const dr = j >= 0 && j < n ? tgt.outR[j] - ref.outR[i] : ref.outR[i];
      se += dl * dl + dr * dr;
    }
    const rmsErr = Math.sqrt(se / (2 * (to - from)));
    const eRef = rms(ref.outL, from, to) + rms(ref.outR, from, to);
    const eTgt = rms(tgt.outL, from, to) + rms(tgt.outR, from, to);
    const dbDelta = 20 * Math.log10((eTgt + 1e-9) / (eRef + 1e-9));
    const ph = phaseDifferenceDeg(ref.outL, tgt.outL, from, to);

    const refBlock = ref.blockLog[b] || {};
    const tgtBlock = tgt.blockLog[b] || {};
    const stat = {
      block: b,
      t: refBlock.t ?? b * bs / ref.sampleRate,
      rmsError: rmsErr,
      energyDbDelta: dbDelta,
      phaseDeg: ph.phaseDeg,
      coherence: ph.coherence,
      refConvolutions: refBlock.convolutions ?? null,
      tgtConvolutions: tgtBlock.convolutions ?? null,
      folded: tgtBlock.folded ?? [],
      shared: tgtBlock.shared ?? [],
      recomputed: tgtBlock.recomputed ?? [],
      tailEnergy: (tgtBlock.tails || []).reduce((s, x) => s + x.tailEnergy, 0),
      tails: tgtBlock.tails || [],
    };
    blockStats.push(stat);
    if (!worst || rmsErr > worst.rmsError) worst = stat;
  }

  return {
    alignmentLagSamples: lag,
    blockStats,
    worstBlock: worst,
    totalConvolutions: { ref: ref.totalConvolutions, tgt: tgt.totalConvolutions },
  };
}

// 收紧预算时误差最大的对象组合：共享同键 HRIR 的 owner/sharer 对，按块级 RMS 误差聚合
export function worstSharedPairs(render, compare, scene) {
  const byId = new Map(scene.objects.map((o) => [o.id, o]));
  const statByBlock = new Map(compare.blockStats.map((s) => [s.block, s]));
  const pairScores = new Map();
  for (const b of render.blockLog) {
    for (const sp of b.sharedPairs || []) {
      const key = [sp.owner, sp.sharer].sort().join('~');
      const stat = statByBlock.get(b.block);
      const cur = pairScores.get(key) || {
        pair: [sp.owner, sp.sharer],
        rmsError: 0,
        blocks: 0,
        firstBlock: b.block,
        firstT: b.t,
        key: sp.key,
      };
      cur.rmsError += stat ? stat.rmsError : 0;
      cur.blocks += 1;
      pairScores.set(key, cur);
    }
  }
  const pairs = [...pairScores.values()].map((p) => ({
    ...p,
    names: p.pair.map((id) => byId.get(id)?.name ?? id),
    avgRmsError: p.rmsError / Math.max(1, p.blocks),
  }));
  pairs.sort((a, b) => b.avgRmsError - a.avgRmsError);
  return pairs;
}

// 触发重算的时刻清单（块 -> 时间 -> 对象），供面板标注
export function recomputeTimeline(render) {
  return render.blockLog
    .filter((b) => b.recomputed.length > 0)
    .map((b) => ({ block: b.block, t: b.t, objects: b.recomputed }));
}

// 旧尾音汇总：每个对象过渡块的旧 HRIR 能量
export function tailSummary(render) {
  const out = [];
  for (const b of render.blockLog) {
    for (const tail of b.tails) out.push({ block: b.block, t: b.t, ...tail });
  }
  return out;
}

// 位置依赖 vs 增益依赖：统计两类事件的缓存淘汰范围
export function dependencyEvictionReport(render, scene) {
  const events = render.cacheEvents;
  const byObject = new Map(scene.objects.map((o) => [o.id, {
    id: o.id, name: o.name,
    motionInvalidations: 0, misses: 0, shares: 0, hits: 0, gainAdjusts: 0, lruEvictions: 0,
  }]));
  for (const e of events) {
    const row = byObject.get(e.objectId);
    if (!row) continue;
    if (e.reason === 'invalidate-motion') row.motionInvalidations += 1;
    else if (e.reason === 'miss') row.misses += 1;
    else if (e.reason === 'share') row.shares += 1;
    else if (e.reason === 'hit') row.hits += 1;
    else if (e.reason === 'gain-adjust') row.gainAdjusts += 1;
    else if (e.reason === 'evict-lru') row.lruEvictions += 1;
  }
  return [...byObject.values()];
}
