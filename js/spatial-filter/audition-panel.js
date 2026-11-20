// 空间滤波试听面板控制器：
//  - 选择内置场景与每块卷积预算，离线跑全量与预算两条确定性信号链；
//  - 渲染结果直接装入 AudioBuffer 播放（不是扬声器录音），可在「全量 / 预算」间即时 A/B；
//  - 展示两耳对齐后的相位、能量、旧尾音、每块实际卷积数，以及误差最大对象组合与重算时刻。
// 面板使用独立 AudioContext，与主叙事内核互不影响。

import { BUILTIN_SCENES } from './scenarios.js';
import { runScenario, BUDGET_PRESETS, peakEnergyDbDelta } from './audition.js';
import { COLORS } from '../view.js';

const $ = (id) => document.getElementById(id);

// 场景对象 id 与主叙事 o1/o2/o3 不同，COLORS 未命中时回退到稳定调色板
const FALLBACK_COLORS = ['#5ee6a8', '#7db7ff', '#ffb45e', '#c79bff', '#8fd9ff'];
function colorFor(id, index) {
  return COLORS[id] || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

export class AuditionPanel {
  constructor() {
    this.ctx = null;
    this.report = null;
    this.currentMode = 'budget'; // 'full' | 'budget'
    this.src = null;
    this._fillSelectors();
    this._bind();
  }

  _fillSelectors() {
    const sceneSel = $('af-scene');
    BUILTIN_SCENES.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (i === 0) opt.selected = true;
      sceneSel.appendChild(opt);
    });
    const budgetSel = $('af-budget');
    BUDGET_PRESETS.forEach((b) => {
      const opt = document.createElement('option');
      opt.value = b.value;
      opt.textContent = b.label;
      if (b.value === 4) opt.selected = true;
      budgetSel.appendChild(opt);
    });
  }

  _bind() {
    $('af-run').addEventListener('click', () => this.run());
    $('af-play-full').addEventListener('click', () => this.play('full'));
    $('af-play-budget').addEventListener('click', () => this.play('budget'));
    $('af-stop').addEventListener('click', () => this.stop());
    $('af-export-cmp').addEventListener('click', () => this.exportComparison());
  }

  async _ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  async run() {
    const sceneId = $('af-scene').value;
    const budget = parseInt($('af-budget').value, 10);
    const scene = BUILTIN_SCENES.find((s) => s.id === sceneId);
    const btn = $('af-run');
    btn.disabled = true;
    btn.textContent = '计算中…';
    // 让按钮先重绘再进入同步计算（场景较短，计算在百毫秒级）
    await new Promise((r) => setTimeout(r, 30));
    try {
      this.report = runScenario(scene, { budgetConvolutions: budget });
      this._buffers = null;
      this.renderSummary();
      this.renderBlockChart();
      this.renderDependency();
      this.renderEvents();
      pushAfLog(`已计算「${scene.name}」：全量 ${this.report.full.totalConvolutions} 卷积 / ` +
        `预算 ${this.report.budget.totalConvolutions} 卷积，峰值能量差 ${peakEnergyDbDelta(this.report.compare).toFixed(2)}dB`);
    } catch (err) {
      pushAfLog('计算失败：' + err.message, 'fault');
    } finally {
      btn.disabled = false;
      btn.textContent = '计算全量 / 预算两条链';
    }
  }

  _toAudioBuffer(render) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(2, render.outL.length, render.sampleRate);
    buf.getChannelData(0).set(render.outL);
    buf.getChannelData(1).set(render.outR);
    return buf;
  }

  async play(mode) {
    if (!this.report) { pushAfLog('请先计算场景。', 'warn'); return; }
    const ctx = await this._ensureCtx();
    this.stop();
    if (!this._buffers) {
      this._buffers = {
        full: this._toAudioBuffer(this.report.full),
        budget: this._toAudioBuffer(this.report.budget),
      };
    }
    this.currentMode = mode;
    const src = ctx.createBufferSource();
    src.buffer = this._buffers[mode];
    src.connect(ctx.destination);
    src.onended = () => { if (this.src === src) this.src = null; };
    src.start();
    this.src = src;
    $('af-mode-label').textContent = mode === 'full' ? '正在试听：全量渲染' : '正在试听：预算渲染';
    $('af-mode-label').className = 'af-mode ' + mode;
    pushAfLog(`试听 ${mode === 'full' ? '全量' : '预算'}渲染（两耳输出与另一链样本对齐）`);
  }

  stop() {
    if (this.src) {
      try { this.src.stop(); } catch { /* noop */ }
      try { this.src.disconnect(); } catch { /* noop */ }
      this.src = null;
    }
  }

  exportComparison() {
    if (!this.report) { pushAfLog('请先计算场景。', 'warn'); return; }
    const rows = [
      'block,t_sec,ref_convolutions,budget_convolutions,folded,shared,recomputed,rms_error,energy_db_delta,phase_deg,coherence,tail_energy',
    ];
    const { blockStats } = this.report.compare;
    for (const s of blockStats) {
      rows.push([
        s.block, s.t.toFixed(4), s.refConvolutions, s.tgtConvolutions,
        `"${s.folded.join('|')}"`, `"${s.shared.join('|')}"`, `"${s.recomputed.join('|')}"`,
        s.rmsError.toExponential(5), s.energyDbDelta.toFixed(4),
        s.phaseDeg.toFixed(3), s.coherence.toFixed(5), s.tailEnergy.toExponential(5),
      ].join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.report.scene.id}-budget-${this.report.budgetConvolutions}-comparison.csv`;
    a.click();
    URL.revokeObjectURL(url);
    pushAfLog('已导出逐块对比 CSV（相位/能量/卷积/尾音）');
  }

  renderSummary() {
    const r = this.report;
    const cmp = r.compare;
    const worst = cmp.worstBlock;
    const pair = r.worstPairs[0];
    const html = [];
    html.push(`<div class="af-stat-grid">
      <div><span>全量卷积总数</span><strong>${r.full.totalConvolutions}</strong></div>
      <div><span>预算卷积总数</span><strong>${r.budget.totalConvolutions}</strong></div>
      <div><span>对齐时延(样本)</span><strong>${cmp.alignmentLagSamples}</strong></div>
      <div><span>峰值能量差</span><strong>${peakEnergyDbDelta(cmp).toFixed(2)} dB</strong></div>
    </div>`);
    html.push('<h4>误差最大块（收紧预算时）</h4>');
    html.push(`<div class="af-worst">块 <code>#${worst.block}</code> · t=${worst.t.toFixed(3)}s · ` +
      `RMS 误差 <em>${worst.rmsError.toExponential(3)}</em> · 能量差 ${worst.energyDbDelta.toFixed(2)}dB · ` +
      `相位差 ${worst.phaseDeg.toFixed(1)}° · 该块卷积 ${worst.tgtConvolutions}` +
      (worst.folded.length ? ` · 折叠对象 <em>${worst.folded.join(', ')}</em>` : '') + `</div>`);
    html.push('<h4>误差最大的对象组合（共享滤波状态）</h4>');
    if (pair) {
      html.push(`<div class="af-worst">${pair.names.join(' ↔ ')} ` +
        `（键 <code>${pair.key}</code>）· 共享 ${pair.blocks} 块 · 首发块 #${pair.firstBlock} ` +
        `@${pair.firstT.toFixed(3)}s · 平均块 RMS 误差 <em>${pair.avgRmsError.toExponential(3)}</em></div>`);
    } else {
      html.push('<div class="muted">本场景/预算下未发生跨对象滤波共享。</div>');
    }
    $('af-summary').innerHTML = html.join('');
  }

  renderBlockChart() {
    const canvas = $('af-chart');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 720;
    const H = 200;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const c = canvas.getContext('2d');
    c.scale(dpr, dpr);
    c.clearRect(0, 0, W, H);
    const stats = this.report.compare.blockStats;
    const maxConv = Math.max(...stats.map((s) => s.refConvolutions ?? 0), 1);
    const bw = W / stats.length;

    // 背景网格
    c.strokeStyle = 'rgba(125,183,255,0.12)';
    c.fillStyle = 'rgba(220,232,255,0.5)';
    c.font = '10px system-ui';
    for (let v = 0; v <= maxConv; v += 2) {
      const y = H - 18 - (v / maxConv) * (H - 34);
      c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
      c.fillText(String(v), 2, y - 2);
    }

    for (let i = 0; i < stats.length; i++) {
      const s = stats[i];
      const x = i * bw;
      // 全量卷积（浅底）与预算卷积（实色）
      const hFull = ((s.refConvolutions ?? 0) / maxConv) * (H - 34);
      const hBud = ((s.tgtConvolutions ?? 0) / maxConv) * (H - 34);
      c.fillStyle = 'rgba(125,183,255,0.25)';
      c.fillRect(x, H - 18 - hFull, Math.max(1, bw), hFull);
      c.fillStyle = s.tgtConvolutions < s.refConvolutions ? '#ffb45e' : '#5ee6a8';
      c.fillRect(x, H - 18 - hBud, Math.max(1, bw), hBud);
      // 重算块标红、共享块标蓝点
      if (s.recomputed.length) {
        c.fillStyle = '#ff7d7d';
        c.fillRect(x, 2, Math.max(1, bw), 3);
      }
      if (s.tailEnergy > 0) {
        c.fillStyle = '#c79bff';
        c.fillRect(x, 7, Math.max(1, bw), 2);
      }
    }
    c.fillStyle = '#aac2e8';
    c.fillText('每块实际卷积数（绿=与全量持平，橙=被预算压缩；顶部红条=滤波重算，紫条=旧尾音过渡）', 8, H - 4);
  }

  renderDependency() {
    const r = this.report;
    const rows = r.dependency.map((d, idx) => {
      const color = colorFor(d.id, idx);
      const cls = d.motionInvalidations > 0 ? 'dep-pos' : 'dep-gain';
      return `<tr class="${cls}">
        <td><span class="dot" style="background:${color}"></span>${d.name}</td>
        <td>${d.motionInvalidations}</td>
        <td>${d.misses}</td>
        <td>${d.shares}</td>
        <td>${d.hits}</td>
        <td>${d.gainAdjusts}</td>
        <td>${d.lruEvictions}</td>
      </tr>`;
    }).join('');
    $('af-dependency').innerHTML =
      `<table class="af-table"><thead><tr>
        <th>对象</th><th>相对运动失效</th><th>重算 miss</th><th>共享 share</th><th>命中 hit</th><th>纯增益事件</th><th>LRU 淘汰</th>
      </tr></thead><tbody>${rows}</tbody></table>` +
      `<div class="hint">位置依赖：几何键变化即失效重算；增益依赖：仅记录事件、零缓存失效（见「纯增益事件」列有值而失效列为 0 的对象）。</div>`;
  }

  renderEvents() {
    const r = this.report;
    const recomputes = r.recomputes.slice(0, 12).map((x) =>
      `<div class="af-event">块 <code>#${x.block}</code> @${x.t.toFixed(3)}s 重算：<em>${x.objects.join(', ')}</em></div>`).join('');
    const tails = r.tails.filter((t) => t.tailEnergy > 0).slice(0, 8).map((t) =>
      `<div class="af-event">块 <code>#${t.block}</code> @${t.t.toFixed(3)}s 旧尾音 <em>${t.objectId}</em>：${t.tailEnergy.toExponential(2)}</div>`).join('');
    $('af-events').innerHTML =
      `<h4>触发重算时刻（前 12）</h4>${recomputes || '<div class="muted">无</div>'}` +
      `<h4>可闻旧尾音（前 8）</h4>${tails || '<div class="muted">无</div>'}`;
  }
}

function pushAfLog(text, level = 'info') {
  const box = $('af-log');
  if (!box) return;
  const line = document.createElement('div');
  line.className = 'fault-line ' + (level === 'fault' ? 'fault' : level === 'warn' ? 'warn' : 'ok');
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `${time}  ${text}`;
  box.prepend(line);
  while (box.children.length > 20) box.lastChild.remove();
}
