// 逐块双耳渲染器：把「每块卷积预算 + 滤波缓存 + 旧尾音处理」串成确定性信号链。
// 两种渲染模式：
//   - budgeted：每块最多 budgetConvolutions 次卷积，按优先级分配；超出预算的对象折叠为
//     中心等功率双单声道（0 卷积，不静音），与主内核 fold 语义一致。
//   - full：全部对象每块双耳卷积（每对象 2 次），作为试听面板的全量渲染参照。
// 每个对象的滤波器在几何键变化时重算，并对新旧 HRIR 做一块线性交叉淡化；
// 旧 HRIR 在过渡块产生的能量即「旧尾音」，单独记录，供对齐比较。

import { SAMPLE_RATE, BLOCK_SIZE, distanceGain, convolveBlock } from './hrir.js';
import { FilterCache, CACHE_REASONS } from './filter-cache.js';
import { makeSignal } from './signals.js';

const INV_SQRT2 = Math.SQRT1_2;

// 折叠路径系数（无卷积）：中心等功率双单声道，距离增益保留
function foldCoeffs(x, y, gain) {
  const dist = Math.hypot(x, y);
  const g = distanceGain(dist) * gain * INV_SQRT2;
  return { gL: g, gR: g };
}

export class BinauralRenderer {
  constructor(scene, { budgetConvolutions = 6, mode = 'budgeted', cacheCapacity = 12 } = {}) {
    this.scene = scene;
    this.sr = scene.sampleRate || SAMPLE_RATE;
    this.blockSize = scene.blockSize || BLOCK_SIZE;
    this.budgetConvolutions = budgetConvolutions;
    this.mode = mode; // 'budgeted' | 'full'
    this.cache = new FilterCache(cacheCapacity);
    this._prepareSignals();
    this._initState();
  }

  _prepareSignals() {
    const n = Math.ceil(this.scene.duration * this.sr);
    this.totalSamples = n;
    this.signals = {};
    for (const obj of this.scene.objects) {
      this.signals[obj.id] = makeSignal(obj.kind, n, obj.bellFreq || 440, this.sr);
    }
  }

  _initState() {
    this.state = {};
    for (const obj of this.scene.objects) {
      this.state[obj.id] = {
        histL: new Float32Array(63),
        histR: new Float32Array(63),
        prevHrirL: null,
        prevHrirR: null,
        prevGain: null,
        crossfade: 0, // 剩余过渡块数（1 块线性交叉淡化）
      };
    }
    this.blocks = Math.ceil(this.totalSamples / this.blockSize);
    this.outL = new Float32Array(this.totalSamples);
    this.outR = new Float32Array(this.totalSamples);
    this.blockLog = [];
    this.cache.reset();
  }

  // 场景在某块的采样帧几何：取块中心时刻，减少块内抖动
  _frameAt(block) {
    const tCenter = (block + 0.5) * this.blockSize / this.sr;
    const heading = this.scene.headingAt(tCenter);
    const objs = this.scene.objects.map((o) => {
      const p = o.positionAt(tCenter);
      const gain = (o.baseGain ?? 1) * (o.gainAt ? o.gainAt(tCenter) : 1)
        * (o.occlusionAt ? o.occlusionAt(tCenter) : 1);
      return { id: o.id, priority: o.priority, x: p.x, y: p.y, gain };
    });
    return { t: tCenter, heading, objects: objs };
  }

  _allocate(frame) {
    // 全量模式：人人有份。预算模式：按优先级降序、同优先级按 id 确定性排序，分配双耳名额
    const ordered = [...frame.objects].sort((a, b) =>
      (b.priority - a.priority) || a.id.localeCompare(b.id));
    const slots = this.mode === 'full'
      ? ordered.length
      : Math.floor(this.budgetConvolutions / 2);
    const spatial = new Set(ordered.slice(0, slots).map((o) => o.id));
    return spatial;
  }

  render() {
    let convTotal = 0;
    for (let b = 0; b < this.blocks; b++) {
      this.cache.setBlock(b);
      const frame = this._frameAt(b);
      const spatial = this._allocate(frame);
      let convolutions = 0;
      const folded = [];
      const shared = [];
      const sharedPairs = [];
      const recomputed = [];
      const tails = [];

      const start = b * this.blockSize;
      const len = Math.min(this.blockSize, this.totalSamples - start);

      for (const fo of frame.objects) {
        const input = this.signals[fo.id].subarray(start, start + len);
        const st = this.state[fo.id];

        // 所有对象都查缓存：即使本块被折叠不卷积，也保留几何绑定与失效记录，
        // 这样位置/增益依赖统计覆盖全部对象（折叠只省卷积，不省缓存判定）。
        const found = this.cache.lookup(fo.id, fo.x, fo.y, frame.heading);
        if (found.reason === CACHE_REASONS.MISS) recomputed.push(fo.id);
        if (found.reason === CACHE_REASONS.SHARE) {
          shared.push(fo.id);
          const ev = this.cache.events[this.cache.events.length - 1];
          sharedPairs.push({ sharer: fo.id, owner: ev.ownerId, key: ev.key });
        }
        // 增益变化仅记录、不触发任何缓存失效（几何键不含增益）——增益零淘汰的直接证据
        if (st.prevGain !== null && Math.abs(st.prevGain - fo.gain) > 1e-6) {
          this.cache.noteGainChange(fo.id, b);
        }
        st.prevGain = fo.gain;

        // 几何是否相对上一块真正换了 HRIR（折叠对象也要先判定，避免恢复时用过时引用误触发）
        const changed = st.prevHrirL !== null && st.prevHrirL !== found.hrirL;

        if (!spatial.has(fo.id)) {
          // 预算外：0 卷积折叠路径。折叠期间不推进 FIR 延迟线，并清掉过时滤波器引用，
          // 这样该对象下次恢复空间化时按新几何干净起振，而不是对陈旧历史做交叉淡化。
          const { gL, gR } = foldCoeffs(fo.x, fo.y, fo.gain);
          for (let i = 0; i < len; i++) {
            this.outL[start + i] += input[i] * gL;
            this.outR[start + i] += input[i] * gR;
          }
          st.prevHrirL = null;
          st.prevHrirR = null;
          st.histL.fill(0);
          st.histR.fill(0);
          st.crossfade = 0;
          folded.push(fo.id);
          continue;
        }

        // 几何变化 -> 触发一块交叉淡化，保留旧尾音
        if (changed) st.crossfade = 1;

        let bl, br;
        if (st.crossfade > 0 && st.prevHrirL) {
          // 旧/新两条卷积必须从同一份历史快照出发，否则延迟线会被第一次卷积污染。
          // 旧 HRIR 的过渡输出即「旧尾音」：单独记录其能量，且不计入每块预算卷积数。
          const snapL = st.histL.slice();
          const snapR = st.histR.slice();
          const oldL = convolveBlock(input, st.prevHrirL, snapL);
          const oldR = convolveBlock(input, st.prevHrirR, snapR);
          const newL = convolveBlock(input, found.hrirL, st.histL);
          const newR = convolveBlock(input, found.hrirR, st.histR);
          bl = new Float32Array(len);
          br = new Float32Array(len);
          let tailE = 0;
          for (let i = 0; i < len; i++) {
            const kNew = (i + 1) / len; // 线性：旧 -> 新
            bl[i] = oldL[i] * (1 - kNew) + newL[i] * kNew;
            br[i] = oldR[i] * (1 - kNew) + newR[i] * kNew;
            tailE += oldL[i] * oldL[i] + oldR[i] * oldR[i];
          }
          tails.push({ objectId: fo.id, tailEnergy: Math.sqrt(tailE / (2 * len)) });
          st.crossfade = 0;
        } else {
          bl = convolveBlock(input, found.hrirL, st.histL);
          br = convolveBlock(input, found.hrirR, st.histR);
        }

        st.prevHrirL = found.hrirL;
        st.prevHrirR = found.hrirR;
        convolutions += 2; // 每耳一次实际执行的卷积

        const dg = distanceGain(Math.hypot(fo.x, fo.y)) * fo.gain;
        for (let i = 0; i < len; i++) {
          this.outL[start + i] += bl[i] * dg;
          this.outR[start + i] += br[i] * dg;
        }
      }

      convTotal += convolutions;
      this.blockLog.push({
        block: b,
        t: +frame.t.toFixed(4),
        convolutions,
        spatial: [...spatial],
        folded,
        shared,
        sharedPairs,
        recomputed,
        tails,
      });
    }

    return {
      mode: this.mode,
      budgetConvolutions: this.mode === 'full' ? null : this.budgetConvolutions,
      totalConvolutions: convTotal,
      blocks: this.blocks,
      blockLog: this.blockLog,
      cacheEvents: this.cache.events,
      outL: this.outL,
      outR: this.outR,
      sampleRate: this.sr,
      blockSize: this.blockSize,
    };
  }
}
