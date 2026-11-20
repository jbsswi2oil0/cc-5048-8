// 空间滤波缓存：以「相对几何量化键」索引 HRIR，按听者与声源的相对运动失效。
// 关键性质：
//   - 键只由相对方位/距离决定（见 hrir.geometryKey），与对象增益完全无关；
//     因此纯音量调整不会触发任何重算，只有位置/朝向变化（相对运动）才会。
//   - 多个对象落到同一量化键时临时共享同一份 HRIR 计算状态（share），
//     共享代价是几何量化误差，由分析模块按对象对测量。
//   - 容量超限时按 LRU 淘汰；对象自身几何键变化时旧绑定失效（invalidate），
//     两种淘汰范围都带 reason 记录，便于区分位置依赖与增益依赖。

import { geometryKey, synthHrir } from './hrir.js';

export const CACHE_REASONS = {
  MISS: 'miss', // 冷启动 / 该几何键从未计算
  SHARE: 'share', // 复用其他对象已算的同键滤波器
  HIT: 'hit', // 自身几何未变，直接命中
  INVALIDATE_MOTION: 'invalidate-motion', // 相对运动导致自身旧键失效
  EVICT_LRU: 'evict-lru', // 容量上限触发 LRU 淘汰
};

export class FilterCache {
  constructor(capacity = 12) {
    this.capacity = capacity;
    this.entries = new Map(); // key -> {hrirL, hrirR, ownerId, lastBlock, uses, bornBlock}
    this.bindings = new Map(); // objectId -> key
    this.events = [];
    this._lastGainBlock = new Map(); // objectId -> 上次增益变化块（跳变沿检测）
    this._block = -1;
  }

  reset() {
    this.entries.clear();
    this.bindings.clear();
    this.events.length = 0;
    this._lastGainBlock.clear();
    this._block = -1;
  }

  setBlock(b) { this._block = b; }

  _log(reason, objectId, key, detail = {}) {
    this.events.push({ block: this._block, reason, objectId, key, ...detail });
  }

  // 返回 {hrirL, hrirR, reason}；每次查找都显式区分命中/共享/重算/失效
  lookup(objectId, x, y, heading) {
    const key = geometryKey(x, y, heading);
    const prevKey = this.bindings.get(objectId);

    if (prevKey !== undefined && prevKey !== key) {
      // 相对运动：对象与听者的相对几何跨了量化 bin，旧绑定失效
      this._log(CACHE_REASONS.INVALIDATE_MOTION, objectId, key, { prevKey });
      const old = this.entries.get(prevKey);
      if (old && old.ownerId === objectId) {
        // 无其他对象共享时随绑定一起释放；仍有共享者则保留条目、仅转移归属
        this.entries.delete(prevKey);
      }
    }
    this.bindings.set(objectId, key);

    const existing = this.entries.get(key);
    if (existing) {
      existing.lastBlock = this._block;
      existing.uses += 1;
      // owner 是别的对象即「临时共享其计算状态」，即使自身上一块也命中同键也算共享，
      // 这样长窗口的持续共享能被完整计数；owner 自己回来则是 HIT。
      const reason = existing.ownerId === objectId ? CACHE_REASONS.HIT : CACHE_REASONS.SHARE;
      this._log(reason, objectId, key, { ownerId: existing.ownerId });
      this.entries.delete(key);
      this.entries.set(key, existing); // 触达 -> LRU 最新
      return { hrirL: existing.hrirL, hrirR: existing.hrirR, reason };
    }

    // 冷启动或失效后重算：合成双耳 HRIR（一次重算 = 2 条 FIR 系数）
    const az = Math.atan2(x, y) - heading;
    const dist = Math.hypot(x, y);
    const hrirL = synthHrir(az, dist, -1);
    const hrirR = synthHrir(az, dist, +1);
    if (this.entries.size >= this.capacity) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      this._log(CACHE_REASONS.EVICT_LRU, objectId, oldestKey, { newKey: key });
    }
    this.entries.set(key, {
      hrirL, hrirR, ownerId: objectId, lastBlock: this._block, uses: 1, bornBlock: this._block,
    });
    this._log(CACHE_REASONS.MISS, objectId, key);
    return { hrirL, hrirR, reason: CACHE_REASONS.MISS };
  }

  // 增益变化不参与键计算：仅在「开始变化」的跳变沿记录一次，斜坡中段不重复刷事件，
  // 用于在报告中证明增益依赖为零缓存淘汰。
  noteGainChange(objectId, block) {
    const prev = this._lastGainBlock.get(objectId);
    if (prev !== undefined && block === prev + 1) {
      this._lastGainBlock.set(objectId, block);
      return; // 连续斜坡中，已记录过跳变沿
    }
    this._lastGainBlock.set(objectId, block);
    this.events.push({ block, reason: 'gain-adjust', objectId, key: this.bindings.get(objectId) ?? null });
  }

  recomputeCount(upToBlock) {
    return this.events.filter((e) => e.reason === CACHE_REASONS.MISS && (upToBlock === undefined || e.block <= upToBlock)).length;
  }

  eventsByObject(objectId) {
    return this.events.filter((e) => e.objectId === objectId);
  }

  // 统计某对象因位置变化（相对运动）导致的失效次数；增益调整不计入
  motionInvalidations(objectId) {
    return this.events.filter((e) => e.objectId === objectId && e.reason === CACHE_REASONS.INVALIDATE_MOTION).length;
  }
}
