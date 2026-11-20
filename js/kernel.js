// 对象声音内核：拥有全部音频图、统一时间基准、空间声道分配与降级、混合约定与离线导出。
// UI 只通过本内核的方法/事件工作；失败通过 onFault 回传对象声音层并展示。

import { spatialCoefficients } from './spatial-math.js';
import { NARRATIVE, OBJECT_IDS, SEGMENT_DURATION, evaluatePath } from './narrative.js';
import { makeBirdBuffer, makeFootstepBuffer, makeBellBuffer, makeBedBuffer, DURATIONS } from './sound-sources.js';
import { encodeWavBlob } from './wav-encode.js';

const TICK_MS = 25;
const ACCENT_SECONDS = 1.2;
const ACCENT_BOOST = 1.35;

// ---------- 空间声道（单声道输入 -> 立体声输出） ----------
// 该 Chromium 版本中 AudioWorkletNode 的 AudioParamMap 在构造后延迟就绪，
// 统一返回一个在参数可访问后 resolve 的 promise（微任务/帧轮询，离线/实时上下文均适用）。
function whenParamsReady(node, paramName) {
  const need = Array.isArray(paramName) ? paramName : [paramName];
  if (need.every((n) => node.parameters.get(n))) return Promise.resolve();
  return new Promise((resolve) => {
    let tries = 0;
    const check = () => {
      if (need.every((n) => node.parameters.get(n)) || tries++ > 500) return resolve();
      // 离线上下文在 startRendering 前不运行 rAF，统一用计时器轮询参数表
      setTimeout(check, 0);
    };
    check();
  });
}

class WorkletSpatialVoice {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.node = new AudioWorkletNode(ctx, 'spatial-panner', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.connect(destination);
    // 本浏览器 AudioParamMap.get 延迟且不稳定，就绪后一次性捕获 AudioParam 引用
    this._p = null;
    this._ready = whenParamsReady(this.node, ['posX', 'posY', 'range', 'gain', 'fold'])
      .then(() => {
        const P = this.node.parameters;
        this._p = {
          posX: P.get('posX'), posY: P.get('posY'),
          range: P.get('range'), gain: P.get('gain'), fold: P.get('fold'),
        };
      });
  }
  get input() { return this.node; }
  _apply(fn) {
    this._ready = this._ready.then(() => { if (this._p) fn(this._p); });
    return this._ready;
  }
  setPosition(x, y) {
    this._apply((p) => {
      p.posX.setTargetAtTime(x, this.ctx.currentTime, 0.02);
      p.posY.setTargetAtTime(y, this.ctx.currentTime, 0.02);
    });
  }
  setRange(range) {
    this._apply((p) => p.range.setTargetAtTime(range, this.ctx.currentTime, 0.02));
  }
  setGain(g) {
    this._apply((p) => p.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02));
  }
  setFold(f) {
    this._apply((p) => p.fold.setTargetAtTime(f, this.ctx.currentTime, 0.02));
  }
  get ready() { return this._ready; }
}

class GainSpatialVoice {
  // 无 AudioWorklet 时的降级：输入 GainNode 分接到左右声像增益，再经 ChannelMerger 成立体声，
  // 空间数学与 Worklet 版本逐 tick 保持一致（仅平滑在主线程、非采样级）。
  constructor(ctx, destination) {
    this.input = ctx.createGain();
    this.merger = ctx.createChannelMerger(2);
    this.gL = ctx.createGain();
    this.gR = ctx.createGain();
    this.input.connect(this.gL);
    this.input.connect(this.gR);
    this.gL.connect(this.merger, 0, 0);
    this.gR.connect(this.merger, 0, 1);
    this.merger.connect(destination);
    this._range = 2.5;
    this._ext = 1;
    this._fold = 0;
    this._x = 0;
    this._y = 0;
  }
  setRange(range) { this._range = range; this._apply(); }
  setGain(g) { this._ext = g; this._apply(); }
  setFold(f) { this._fold = f; this._apply(); }
  setPosition(x, y) { this._x = x; this._y = y; this._apply(); }
  _apply() {
    const c = spatialCoefficients(this._x, this._y, this._range, this._ext, this._fold);
    this.gL.gain.setTargetAtTime(c.gL, this.gL.context.currentTime, 0.02);
    this.gR.gain.setTargetAtTime(c.gR, this.gR.context.currentTime, 0.02);
  }
}

export class AudioKernel {
  constructor() {
    this.ctx = null;
    this.mode = null; // 'worklet' | 'gain-fallback'
    this.playing = false;
    this.segmentIndex = 0;
    this.timelinePos = 0;
    this._startCtxTime = 0;
    this._startTimeline = 0;
    this._timer = null;
    this.spatialBudget = 3;
    this.solo = null; // null | 'bed' | objectId
    this.listeners = { tick: [], event: [], fault: [], state: [] };
    this._fired = new Set();
    this._anchors = {}; // objectId -> {x,y} 手动拖拽锚点（切段落/seek 清除）
    this._accentUntil = {};
    this._bedSrc = null;
    this._objSrcs = {};
    this._voices = {};
    this._objGain = {};
    this._analysers = {};
    this._levels = {};
    this._exporting = false;
  }

  on(type, fn) { this.listeners[type].push(fn); }
  _emit(type, payload) { for (const fn of this.listeners[type]) fn(payload); }
  _fault(code, message, detail) {
    const f = { code, message, detail, time: Date.now() };
    this._emit('fault', f);
  }

  get segment() { return NARRATIVE.segments[this.segmentIndex]; }
  get totalDuration() { return NARRATIVE.segments.length * SEGMENT_DURATION; }

  async init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      this._fault('NO_AUDIO_CONTEXT', '当前浏览器不支持 Web Audio API，对象声音无法启动。');
      throw new Error('AudioContext unavailable');
    }
    this.ctx = new Ctx();
    await this._buildGraph();
    await this.ctx.suspend();
    this._resetFired();
    this._emitState();
  }

  async _buildGraph() {
    // 主图：声源 -> 对象增益/声床滤波 -> 空间声道 -> master -> 安全限制器 -> 输出
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.2;
    this.master.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    this.bedGainNode = this.ctx.createGain();
    this.bedFilter = this.ctx.createBiquadFilter();
    this.bedFilter.type = 'lowpass';
    this.bedFilter.frequency.value = this.segment.bedFilterHz;
    this.bedFilter.Q.value = 0.7;
    this.bedGainNode.gain.value = this.segment.bedGain * 0.5;
    this.bedFilter.connect(this.bedGainNode);
    this.bedGainNode.connect(this.master);

    // 混合约定：声床是固定立体声、永不进入空间声道；对象全部走空间声道。
    // 二者在 master 处仅相加一次，不存在重复计入路径。
    this.bedBuf = makeBedBuffer(this.ctx);

    this._objBufs = {};
    for (const id of OBJECT_IDS) {
      const o = this.segment.objects[id];
      this._objBufs[id] = this._makeObjectBuffer(id, o);
      const g = this.ctx.createGain();
      g.gain.value = o.baseGain;
      this._objGain[id] = g;
      g.connect(this.master); // voice 在分配时再接入

      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      g.connect(an);
      this._analysers[id] = an;
      this._levels[id] = 0;
    }
    const bedAn = this.ctx.createAnalyser();
    bedAn.fftSize = 512;
    this.bedGainNode.connect(bedAn);
    this._analysers.bed = bedAn;
    this._levels.bed = 0;

    try {
      await this.ctx.audioWorklet.addModule(new URL('../js/spatial-worklet.js', import.meta.url));
      this.mode = 'worklet';
    } catch (err) {
      this.mode = 'gain-fallback';
      this._fault(
        'WORKLET_UNAVAILABLE',
        'AudioWorklet 加载失败，已降级为主线程双增益等功率声像（空间化数学保持一致，仅非采样级平滑）。',
        String(err)
      );
    }
    this._allocateVoices();
  }

  _makeObjectBuffer(id, o) {
    if (o.kind === 'bird') return makeBirdBuffer(this.ctx);
    if (o.kind === 'footstep') return makeFootstepBuffer(this.ctx);
    return makeBellBuffer(this.ctx, o.bellFreq);
  }

  _newVoice() {
    if (this.mode !== 'worklet') return new GainSpatialVoice(this.ctx, this.master);
    try {
      return new WorkletSpatialVoice(this.ctx, this.master);
    } catch (err) {
      this.mode = 'gain-fallback';
      this._fault('WORKLET_NODE_FAILED', 'Worklet 节点创建失败，切换为双增益降级声道。', String(err));
      return new GainSpatialVoice(this.ctx, this.master);
    }
  }

  // 预算分配：按优先级降序、同优先级按对象 id 确定性排序；
  // 关键叙事声音即使超出预算也不静音——折叠为中心双单声道并显式上报。
  _allocateVoices() {
    const ordered = [...OBJECT_IDS].sort((a, b) => {
      const pa = this.segment.objects[a].priority;
      const pb = this.segment.objects[b].priority;
      if (pb !== pa) return pb - pa;
      return a.localeCompare(b);
    });
    const spatial = new Set(ordered.slice(0, this.spatialBudget));
    for (const id of OBJECT_IDS) {
      const o = this.segment.objects[id];
      if (!this._voices[id]) {
        this._voices[id] = this._newVoice();
        this._objGain[id].connect(this._voices[id].input);
      }
      const voice = this._voices[id];
      voice.setRange(o.range);
      voice.setFold(spatial.has(id) ? 0 : 1);
      if (!spatial.has(id)) {
        this._fault(
          'VOICE_FOLDED',
          `「${o.name}」超出空间声道预算（${this.spatialBudget}），按优先级折叠为中心等功率双单声道，未静音。`
        );
      }
    }
  }

  setBudget(n) {
    this.spatialBudget = Math.max(1, Math.min(3, n));
    if (this.ctx) this._allocateVoices();
    this._emitState();
  }

  // ---------- 传输控制（统一时间基准） ----------
  async play() {
    if (!this.ctx) await this.init();
    if (this.playing) return;
    if (this.timelinePos >= this.totalDuration - 0.05) this.timelinePos = 0;
    await this.ctx.resume();
    this._startCtxTime = this.ctx.currentTime + 0.06;
    this._startTimeline = this.timelinePos;
    this._startSources(this._startCtxTime, this.timelinePos);
    this.playing = true;
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._emitState();
  }

  pause() {
    if (!this.playing) return;
    this.timelinePos = this._readTimeline();
    this._stopSources();
    this.playing = false;
    clearInterval(this._timer);
    this.ctx.suspend();
    // 暂停后声源节点全部销毁，恢复时按当前时间重建——不可能残留旧位置声音。
    this._emitState();
  }

  seek(globalPos) {
    const wasPlaying = this.playing;
    const target = Math.max(0, Math.min(this.totalDuration, globalPos));
    const newSeg = Math.min(NARRATIVE.segments.length - 1, Math.floor(target / SEGMENT_DURATION));
    if (newSeg !== this.segmentIndex) {
      // 跨段 seek：先切段落（会重建该段 buffer 并刷新滤波/增益），再统一处理时间与声源
      this.switchSegment(newSeg);
    }
    this.timelinePos = target;
    this._resetFired();
    this._anchors = {};
    this._accentUntil = {};
    this._stopSources();
    if (wasPlaying) {
      this._startCtxTime = this.ctx.currentTime + 0.06;
      this._startTimeline = target;
      this._startSources(this._startCtxTime, target);
    } else {
      // 暂停态 seek：立即按新位置刷新空间参数，试听位置与时间严格一致
      this._tickPositions(target - this.segmentIndex * SEGMENT_DURATION);
    }
    this._emitState();
  }

  switchSegment(index) {
    if (index < 0 || index >= NARRATIVE.segments.length || index === this.segmentIndex) return;
    const wasPlaying = this.playing;
    this._stopSources();
    this.segmentIndex = index;
    this.timelinePos = index * SEGMENT_DURATION;
    this._anchors = {};
    this._accentUntil = {};
    this._resetFired();
    this._rebuildSegmentBuffers();
    this.bedFilter.frequency.setTargetAtTime(this.segment.bedFilterHz, this.ctx.currentTime, 0.05);
    this.bedGainNode.gain.setTargetAtTime(this.segment.bedGain * 0.5, this.ctx.currentTime, 0.05);
    this._allocateVoices();
    if (wasPlaying) {
      this._startCtxTime = this.ctx.currentTime + 0.06;
      this._startTimeline = this.timelinePos;
      this._startSources(this._startCtxTime, this.timelinePos);
    } else {
      this._tickPositions(0);
      this._emit('tick', this.snapshot());
    }
    this._emitState();
  }

  _rebuildSegmentBuffers() {
    for (const id of OBJECT_IDS) {
      const o = this.segment.objects[id];
      const old = this._objBufs[id];
      this._objBufs[id] = this._makeObjectBuffer(id, o);
      if (old) { try { old.close?.(); } catch { /* noop */ } }
      this._objGain[id].gain.setTargetAtTime(o.baseGain, this.ctx.currentTime, 0.05);
    }
  }

  _readTimeline() {
    if (!this.playing) return this.timelinePos;
    return Math.min(this.totalDuration, this._startTimeline + (this.ctx.currentTime - this._startCtxTime));
  }

  _startSources(when, globalPos) {
    const segLocal = globalPos - this.segmentIndex * SEGMENT_DURATION;
    // 声床：立体声 buffer source，按统一时间取模对齐
    const bed = this.ctx.createBufferSource();
    bed.buffer = this.bedBuf;
    bed.loop = true;
    bed.connect(this.bedFilter);
    const bedOff = ((globalPos % DURATIONS.bed) + DURATIONS.bed) % DURATIONS.bed;
    bed.start(when, bedOff);
    this._bedSrc = bed;

    for (const id of OBJECT_IDS) {
      const src = this.ctx.createBufferSource();
      src.buffer = this._objBufs[id];
      src.loop = true;
      src.connect(this._objGain[id]);
      const dur = src.buffer.duration;
      const off = ((segLocal % dur) + dur) % dur;
      src.start(when, off);
      this._objSrcs[id] = src;
    }
  }

  _stopSources() {
    if (this._bedSrc) { try { this._bedSrc.stop(); } catch { /* noop */ } try { this._bedSrc.disconnect(); } catch { /* noop */ } this._bedSrc = null; }
    for (const id of OBJECT_IDS) {
      const s = this._objSrcs[id];
      if (s) { try { s.stop(); } catch { /* noop */ } try { s.disconnect(); } catch { /* noop */ } }
      this._objSrcs[id] = null;
    }
  }

  // ---------- 每 tick：位置、事件、增益、电平 ----------
  _tick() {
    const pos = this._readTimeline();
    this.timelinePos = pos;

    if (pos >= this.totalDuration - 0.02) {
      this.timelinePos = this.totalDuration;
      this._stopSources();
      this.playing = false;
      clearInterval(this._timer);
      this.ctx.suspend();
      this._pollLevels();
      this._emit('tick', this.snapshot());
      return;
    }

    const newSeg = Math.min(NARRATIVE.segments.length - 1, Math.floor(pos / SEGMENT_DURATION));
    if (newSeg !== this.segmentIndex) {
      // switchSegment 会按新段起点重建声源；本帧直接返回，避免用旧段时间重复起播
      this.switchSegment(newSeg);
      this._pollLevels();
      this._emit('tick', this.snapshot());
      return;
    }

    const segLocal = pos - this.segmentIndex * SEGMENT_DURATION;
    this._fireEvents(segLocal);
    this._tickPositions(segLocal);
    this._applySoloGains(segLocal);
    this._pollLevels();
    this._emit('tick', this.snapshot());
  }

  _resetFired() { this._fired = new Set(); }

  _fireEvents(segLocal) {
    for (const id of OBJECT_IDS) {
      const o = this.segment.objects[id];
      for (let i = 0; i < o.events.length; i++) {
        const e = o.events[i];
        const key = `${this.segmentIndex}:${id}:${i}`;
        if (!this._fired.has(key) && segLocal >= e.t) {
          this._fired.add(key);
          this._accentUntil[id] = segLocal + ACCENT_SECONDS;
          this._emit('event', { ...e, objectId: id, segment: this.segmentIndex, firedAt: segLocal });
        }
      }
    }
  }

  _objectPosition(id, segLocal) {
    if (this._anchors[id]) return { ...this._anchors[id], manual: true };
    const p = evaluatePath(this.segmentIndex, id, segLocal);
    return { ...p, manual: false };
  }

  _tickPositions(segLocal) {
    for (const id of OBJECT_IDS) {
      const p = this._objectPosition(id, segLocal);
      this._voices[id]?.setPosition(p.x, p.y);
    }
  }

  _applySoloGains(segLocal) {
    const now = this.ctx.currentTime;
    const DIM = 0.08;
    let bedTarget;
    if (this.solo === 'bed') bedTarget = this.segment.bedGain * 0.5;
    else if (this.solo) bedTarget = this.segment.bedGain * 0.5 * DIM;
    else bedTarget = this.segment.bedGain * 0.5;
    this.bedGainNode.gain.setTargetAtTime(bedTarget, now, 0.03);

    for (const id of OBJECT_IDS) {
      const o = this.segment.objects[id];
      let g = o.baseGain;
      const until = this._accentUntil[id];
      if (until !== undefined && segLocal < until) g *= ACCENT_BOOST;
      if (this.solo && this.solo !== 'bed') g = this.solo === id ? g : g * DIM;
      this._objGain[id].gain.setTargetAtTime(g, now, 0.03);
    }
  }

  setSolo(target) {
    if (!this.ctx) return;
    this.solo = this.solo === target ? null : target;
    this._applySoloGains(this.timelinePos - this.segmentIndex * SEGMENT_DURATION);
    this._emitState();
  }

  // 视窗拖拽：直接移动声音对象；移动期间暂停轨迹驱动，直到下次 seek/切段落
  setAnchor(id, x, y) {
    this._anchors[id] = { x, y };
    if (this.ctx) this._voices[id]?.setPosition(x, y);
    this._emit('tick', this.snapshot());
  }

  clearAnchor(id) {
    delete this._anchors[id];
    this._emitState();
  }

  clearAllAnchors() {
    this._anchors = {};
    this._emitState();
  }

  _pollLevels() {
    for (const key of Object.keys(this._analysers)) {
      const an = this._analysers[key];
      const data = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      this._levels[key] = Math.sqrt(sum / data.length);
    }
  }

  getLevels() { return { ...this._levels }; }

  snapshot() {
    const segLocal = this.timelinePos - this.segmentIndex * SEGMENT_DURATION;
    const objects = {};
    for (const id of OBJECT_IDS) {
      const p = this._objectPosition(id, segLocal);
      const o = this.segment.objects[id];
      objects[id] = {
        ...p,
        meta: o,
        anchor: !!this._anchors[id],
        accent: this._accentUntil[id] !== undefined && segLocal < this._accentUntil[id],
      };
    }
    return {
      playing: this.playing,
      segmentIndex: this.segmentIndex,
      segmentName: this.segment.name,
      timelinePos: this.timelinePos,
      segLocal,
      totalDuration: this.totalDuration,
      mode: this.mode,
      budget: this.spatialBudget,
      solo: this.solo,
      objects,
      levels: this.getLevels(),
    };
  }

  _emitState() { this._emit('tick', this.snapshot()); }

  // ---------- 离线导出：实际渲染信号链，不录扬声器 ----------
  async exportWav(scope) {
    if (this._exporting) throw new Error('已有导出任务进行中');
    this._exporting = true;
    try {
      const segStart = scope === 'segment' ? this.segmentIndex : 0;
      const segEnd = scope === 'segment' ? this.segmentIndex + 1 : NARRATIVE.segments.length;
      const duration = (segEnd - segStart) * SEGMENT_DURATION;
      const sr = this.ctx ? this.ctx.sampleRate : 48000;
      const off = new OfflineAudioContext(2, Math.ceil(duration * sr), sr);

      try {
        await off.audioWorklet.addModule(new URL('../js/spatial-worklet.js', import.meta.url));
      } catch (err) {
        this._fault('EXPORT_WORKLET', '导出上下文 Worklet 加载失败，导出改用双增益声像。', String(err));
      }
      const hasWorklet = off.audioWorklet !== undefined && (await this._probeWorklet(off));

      const master = off.createGain();
      master.gain.value = 0.9;
      const lim = off.createDynamicsCompressor();
      lim.threshold.value = -3; lim.knee.value = 6; lim.ratio.value = 12;
      lim.attack.value = 0.002; lim.release.value = 0.2;
      master.connect(lim); lim.connect(off.destination);

      // 声床
      const bedBuf = makeBedBuffer(off);
      const bedFilter = off.createBiquadFilter();
      bedFilter.type = 'lowpass';
      const bedGain = off.createGain();
      bedFilter.connect(bedGain); bedGain.connect(master);
      const bedSrc = off.createBufferSource();
      bedSrc.buffer = bedBuf; bedSrc.loop = true;
      bedSrc.connect(bedFilter);
      bedSrc.start(0, 0);

      const bufs = {
        bird: makeBirdBuffer(off),
        footstep: makeFootstepBuffer(off),
      };

      const t0 = performance.now();
      const offlineReady = [];
      for (let s = segStart; s < segEnd; s++) {
        const seg = NARRATIVE.segments[s];
        const segBase = (s - segStart) * SEGMENT_DURATION;
        bedFilter.frequency.setValueAtTime(seg.bedFilterHz, segBase);
        bedGain.gain.setValueAtTime(seg.bedGain * 0.5, segBase);

        for (const id of OBJECT_IDS) {
          const o = seg.objects[id];
          const buf = o.kind === 'bell'
            ? makeBellBuffer(off, o.bellFreq)
            : bufs[o.kind];

          const objGain = off.createGain();
          objGain.gain.setValueAtTime(o.baseGain, segBase);
          let voiceNode;
          let nodeReady = Promise.resolve();
          if (hasWorklet) {
            const wn = new AudioWorkletNode(off, 'spatial-panner', { outputChannelCount: [2] });
            wn.connect(master);
            objGain.connect(wn);
            voiceNode = wn;
            nodeReady = whenParamsReady(wn, ['posX', 'posY', 'range', 'gain', 'fold']);
          } else {
            const merger = off.createChannelMerger(2);
            const gL = off.createGain(), gR = off.createGain();
            gL.connect(merger, 0, 0); gR.connect(merger, 0, 1);
            merger.connect(master);
            objGain.connect(gL); objGain.connect(gR);
            voiceNode = { fallback: true, gL, gR, range: o.range };
          }

          const src = off.createBufferSource();
          src.buffer = buf; src.loop = true;
          src.connect(objGain);
          src.start(segBase, 0);
          src.stop(segBase + SEGMENT_DURATION);

          // 位置自动化：逐 50ms 采样路径（worklet 参数线性插值，平滑）；
          // 本浏览器 AudioParamMap.get 不稳定，就绪时一次性捕获 AudioParam 引用
          const STEP = 0.05;
          nodeReady.then(() => {
            if (voiceNode.fallback) {
              for (let t = 0; t <= SEGMENT_DURATION; t += STEP) {
                const at = segBase + t;
                const pp = o.path(Math.min(t, SEGMENT_DURATION));
                const c = spatialCoefficients(pp.x, pp.y, voiceNode.range, 1, 0);
                voiceNode.gL.gain.setValueAtTime(c.gL, at);
                voiceNode.gR.gain.setValueAtTime(c.gR, at);
              }
              return;
            }
            const P = voiceNode.parameters;
            const px = P.get('posX'), py = P.get('posY'), rg = P.get('range');
            if (!px || !py || !rg) return;
            for (let t = 0; t <= SEGMENT_DURATION; t += STEP) {
              const at = segBase + t;
              const pp = o.path(Math.min(t, SEGMENT_DURATION));
              px.setValueAtTime(pp.x, at);
              py.setValueAtTime(pp.y, at);
            }
            rg.setValueAtTime(o.range, segBase);
          });
          offlineReady.push(nodeReady);

          // 事件增益（accent）
          for (const e of o.events) {
            const at = segBase + e.t;
            objGain.gain.setValueAtTime(o.baseGain, at);
            objGain.gain.linearRampToValueAtTime(o.baseGain * ACCENT_BOOST, at + 0.08);
            objGain.gain.linearRampToValueAtTime(o.baseGain, at + ACCENT_SECONDS);
          }
        }
      }

      // 离线上下文节点参数表就绪、自动化全部写入后再渲染
      await Promise.all(offlineReady);

      const rendered = await off.startRendering();
      const blob = encodeWavBlob(rendered);
      const elapsed = performance.now() - t0;
      return {
        blob,
        url: URL.createObjectURL(blob),
        sampleRate: sr,
        duration,
        channels: 2,
        renderMs: Math.round(elapsed),
        scope: scope === 'segment' ? `段落${this.segment.id}` : '完整场景',
      };
    } catch (err) {
      this._fault('EXPORT_FAILED', '离线渲染失败，未生成文件。', String(err));
      throw err;
    } finally {
      this._exporting = false;
    }
  }

  async _probeWorklet(off) {
    try {
      const n = new AudioWorkletNode(off, 'spatial-panner', { outputChannelCount: [2] });
      n.disconnect();
      return true;
    } catch {
      return false;
    }
  }

  dispose() {
    clearInterval(this._timer);
    this._stopSources();
    this.ctx?.close();
  }
}
