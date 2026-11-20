// 主控：由对象声音内核（AudioKernel）驱动所有控件；内核故障统一回传并在界面显式呈现。

import { AudioKernel } from './kernel.js';
import { SpatialView, COLORS } from './view.js';
import { NARRATIVE, OBJECT_IDS, BUDGET_LEVELS, SEGMENT_DURATION } from './narrative.js';

const $ = (id) => document.getElementById(id);

const kernel = new AudioKernel();
window.__k = kernel; // 调试/自动化测试句柄
const view = new SpatialView($('spatial-canvas'), kernel);

let started = false;
let lastSegment = -1;
const eventLog = [];
const exportList = [];

// ---------- 启动 ----------
$('start-btn').addEventListener('click', async () => {
  try {
    await kernel.init();
    started = true;
    $('start-overlay').classList.add('hidden');
    pushFault('info', `对象声音已启动（${kernel.mode === 'worklet' ? 'AudioWorklet 采样级空间化' : '主线程双增益降级空间化'}）`);
    refreshStatic();
    render(kernel.snapshot());
    requestAnimationFrame(raf);
  } catch (err) {
    $('start-error').textContent = '启动失败：' + err.message;
  }
});

function raf() {
  render(kernel.snapshot());
  requestAnimationFrame(raf);
}

// ---------- 传输控件 ----------
$('play-btn').addEventListener('click', () => kernel.play());
$('pause-btn').addEventListener('click', () => kernel.pause());
$('seek-btn').addEventListener('click', () => {
  const t = parseFloat($('seek-input').value);
  if (!Number.isNaN(t)) kernel.seek(t);
});
$('timeline').addEventListener('input', (e) => {
  if (started) kernel.seek(parseFloat(e.target.value));
});
$('seg-a').addEventListener('click', () => kernel.switchSegment(0));
$('seg-b').addEventListener('click', () => kernel.switchSegment(1));

$('budget-select').addEventListener('change', (e) => kernel.setBudget(parseInt(e.target.value, 10)));
$('clear-anchors').addEventListener('click', () => {
  kernel.clearAllAnchors();
  view.resetTrails();
});

// 独听
$('solo-bed').addEventListener('click', () => kernel.setSolo('bed'));
for (const id of OBJECT_IDS) {
  $(`solo-${id}`).addEventListener('click', () => kernel.setSolo(id));
  $(`release-${id}`).addEventListener('click', () => kernel.clearAnchor(id));
}

// ---------- 导出 ----------
$('export-segment').addEventListener('click', () => doExport('segment'));
$('export-full').addEventListener('click', () => doExport('full'));

async function doExport(scope) {
  const btn = scope === 'segment' ? $('export-segment') : $('export-full');
  btn.disabled = true;
  btn.textContent = '离线渲染中…';
  try {
    const result = await kernel.exportWav(scope);
    exportList.unshift(result);
    renderExports();
    pushFault('info', `已导出 ${result.scope}：${result.duration}s / ${result.sampleRate}Hz / 双声道，渲染耗时 ${result.renderMs}ms`);
  } catch (err) {
    // 内核已通过 fault 事件上报；这里保证按钮恢复
  } finally {
    btn.disabled = false;
    btn.textContent = scope === 'segment' ? '导出当前段落 WAV' : '导出完整场景 WAV';
  }
}

// ---------- 内核事件 ----------
kernel.on('event', (e) => {
  eventLog.unshift(e);
  if (eventLog.length > 40) eventLog.pop();
  renderEventLog();
});
kernel.on('fault', (f) => {
  pushFault(f.code === 'WORKLET_UNAVAILABLE' ? 'warn' : 'fault', `[${f.code}] ${f.message}${f.detail ? ' — ' + f.detail : ''}`);
});

function pushFault(level, text) {
  const box = $('fault-box');
  const line = document.createElement('div');
  line.className = 'fault-line ' + level;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `${time}  ${text}`;
  box.prepend(line);
  while (box.children.length > 30) box.lastChild.remove();
}

// ---------- 静态信息（启动后填充一次） ----------
function refreshStatic() {
  // 事件时序表
  const wrap = $('event-table');
  wrap.innerHTML = '';
  for (let s = 0; s < NARRATIVE.segments.length; s++) {
    const seg = NARRATIVE.segments[s];
    for (const id of OBJECT_IDS) {
      for (const e of seg.objects[id].events) {
        const row = document.createElement('div');
        row.className = 'event-row';
        row.dataset.key = `${s}:${id}:${e.t}`;
        row.innerHTML =
          `<span class="ev-seg">${seg.id}</span>` +
          `<span class="ev-time">${e.t.toFixed(1)}s</span>` +
          `<span class="ev-obj" style="color:${COLORS[id]}">${seg.objects[id].name}</span>` +
          `<span class="ev-text">${e.text}</span>`;
        wrap.appendChild(row);
      }
    }
  }
}

// ---------- 每帧渲染 ----------
function render(snap) {
  if (!started) return;
  view.draw(snap);

  if (snap.segmentIndex !== lastSegment) {
    lastSegment = snap.segmentIndex;
    view.resetTrails();
    $('seg-a').classList.toggle('active', snap.segmentIndex === 0);
    $('seg-b').classList.toggle('active', snap.segmentIndex === 1);
    $('segment-title').textContent = snap.segmentName;
  }

  // 时间
  $('time-now').textContent = snap.timelinePos.toFixed(2);
  $('time-seg').textContent = snap.segLocal.toFixed(2);
  $('time-total').textContent = snap.totalDuration.toFixed(0);
  const tl = $('timeline');
  tl.max = snap.totalDuration;
  if (document.activeElement !== tl) tl.value = snap.timelinePos;

  // 状态徽标
  $('mode-badge').textContent = snap.mode === 'worklet' ? 'Worklet 采样级空间化' : '双增益降级空间化';
  $('mode-badge').className = 'badge ' + (snap.mode === 'worklet' ? 'ok' : 'warn');
  $('state-badge').textContent = snap.playing ? '播放中' : '已暂停';
  $('state-badge').className = 'badge ' + (snap.playing ? 'ok' : 'muted');

  // 独听按钮态
  $('solo-bed').classList.toggle('on', snap.solo === 'bed');
  for (const id of OBJECT_IDS) $(`solo-${id}`).classList.toggle('on', snap.solo === id);

  // 方向 / 能量面板
  const rows = view.describe(snap);
  const panel = $('direction-panel');
  panel.innerHTML = '';
  for (const r of rows) {
    const card = document.createElement('div');
    card.className = 'dir-card';
    const pct = Math.min(100, r.level * 100 * 2.2);
    card.innerHTML =
      `<div class="dir-head"><span class="dot" style="background:${r.color}"></span>` +
      `<strong>${r.name}</strong>` +
      (r.accent ? '<span class="tag accent-tag">事件增益</span>' : '') +
      (r.anchor ? '<span class="tag anchor-tag">手动锚点</span>' : '') +
      `<span class="tag">P${r.priority}</span></div>` +
      `<div class="dir-metrics">方位 ${r.az >= 0 ? '+' : ''}${r.az.toFixed(0)}°（${r.dir}） · ` +
      `距离 ${r.dist.toFixed(1)}m ${r.inside ? '· <em>进入声源范围</em>' : ''}</div>` +
      `<div class="meter"><div class="meter-fill" style="width:${pct}%;background:${r.color}"></div></div>`;
    panel.appendChild(card);
  }
  const bedPct = Math.min(100, (snap.levels.bed || 0) * 100 * 2.2);
  $('bed-meter-fill').style.width = bedPct + '%';

  // 事件触发光标
  const firedKeys = new Set([...eventLog.map((e) => `${e.segment}:${e.objectId}:${e.t}`)]);
  for (const row of document.querySelectorAll('.event-row')) {
    row.classList.toggle('fired', firedKeys.has(row.dataset.key));
  }

  // 对象坐标与释放锚点按钮
  for (const id of OBJECT_IDS) {
    const o = snap.objects[id];
    $(`pos-${id}`).textContent = `(${o.x.toFixed(1)}, ${o.y.toFixed(1)}) m`;
    $(`release-${id}`).disabled = !o.anchor;
  }
}

function renderEventLog() {
  const box = $('event-log');
  box.innerHTML = '';
  for (const e of eventLog) {
    const line = document.createElement('div');
    line.className = 'fault-line ok';
    line.innerHTML = `<span style="color:${COLORS[e.objectId]}">${e.text}</span> <em>@${e.firedAt.toFixed(2)}s</em>`;
    box.prepend(line);
  }
}

function renderExports() {
  const box = $('export-list');
  box.innerHTML = '';
  for (const r of exportList) {
    const item = document.createElement('div');
    item.className = 'export-item';
    const name = `narrative-${r.scope}-${r.duration}s.wav`;
    item.innerHTML =
      `<div><strong>${name}</strong><div class="muted small">${r.sampleRate}Hz · ${r.channels}ch · 渲染 ${r.renderMs}ms</div></div>` +
      `<a href="${r.url}" download="${name}"><button class="mini-btn">下载 WAV</button></a>`;
    box.appendChild(item);
  }
}

// 预算选项填充
const sel = $('budget-select');
BUDGET_LEVELS.forEach((b, i) => {
  const opt = document.createElement('option');
  opt.value = b.spatialVoices;
  opt.textContent = b.label;
  if (i === 2) opt.selected = true;
  sel.appendChild(opt);
});

// 段落信息填充
const meta = $('segment-meta');
meta.innerHTML = NARRATIVE.segments.map((seg, i) =>
  `<div class="meta-block"><strong>段落 ${seg.id}：${seg.name}</strong>` +
  OBJECT_IDS.map((id) => {
    const o = seg.objects[id];
    return `<div class="meta-line" style="color:${COLORS[id]}">${o.name}：${o.pathName} · 范围 ${o.range}m · 增益 ${o.baseGain} · 优先级 P${o.priority}${o.priority === 3 ? '（关键叙事）' : ''}</div>`;
  }).join('') +
  `<div class="meta-line muted">声床低通 ${seg.bedFilterHz}Hz · 声床增益 ${seg.bedGain}</div></div>`
).join('');

$('seek-input').value = SEGMENT_DURATION;
