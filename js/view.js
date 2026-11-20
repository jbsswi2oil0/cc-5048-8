// 空间音画视窗：以听者为中心的俯视场域，绘制声源范围、实时位置、轨迹拖尾，
// 支持直接拖拽声音对象（结果回写内核锚点）。所有状态从内核 snapshot 拉取。

import { FIELD_RADIUS, NARRATIVE, OBJECT_IDS } from './narrative.js';
import { azimuthDeg, directionLabel } from './spatial-math.js';

const COLORS = {
  o1: '#5ee6a8',
  o2: '#7db7ff',
  o3: '#ffb45e',
};

export class SpatialView {
  constructor(canvas, kernel) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.kernel = kernel;
    this.trails = { o1: [], o2: [], o3: [] };
    this.trailMax = 260;
    this.dragId = null;
    this._bindPointer();
  }

  resetTrails() {
    this.trails = { o1: [], o2: [], o3: [] };
  }

  _toWorld(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const scale = (rect.width / 2 - 14) / FIELD_RADIUS;
    const px = evt.clientX - rect.left;
    const py = evt.clientY - rect.top;
    return {
      x: (px - cx) / scale,
      y: -(py - cy) / scale, // 屏幕 y 向下，世界 y 向前（向上）
    };
  }

  _bindPointer() {
    this.canvas.addEventListener('pointerdown', (e) => {
      const snap = this.kernel.snapshot();
      const w = this._toWorld(e);
      let best = null, bestD = 1.4;
      for (const id of OBJECT_IDS) {
        const o = snap.objects[id];
        const d = Math.hypot(o.x - w.x, o.y - w.y);
        if (d < bestD) { bestD = d; best = id; }
      }
      if (best) {
        this.dragId = best;
        this.canvas.setPointerCapture(e.pointerId);
        const p = this._toWorld(e);
        this.kernel.setAnchor(best, p.x, p.y);
      }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragId) return;
      const p = this._toWorld(e);
      const cl = Math.max(-FIELD_RADIUS, Math.min(FIELD_RADIUS, p.x));
      const cl2 = Math.max(-FIELD_RADIUS, Math.min(FIELD_RADIUS, p.y));
      this.kernel.setAnchor(this.dragId, cl, cl2);
    });
    const end = (e) => {
      if (this.dragId) {
        try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
        this.dragId = null;
      }
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  draw(snap) {
    const c = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const cx = W / 2, cy = H / 2;
    const scale = (W / 2 - 14) / FIELD_RADIUS;
    c.clearRect(0, 0, W, H);

    // 背景与网格
    c.fillStyle = '#0d1420';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(125,183,255,0.10)';
    c.lineWidth = 1;
    for (let r = 2.5; r <= FIELD_RADIUS; r += 2.5) {
      c.beginPath(); c.arc(cx, cy, r * scale, 0, Math.PI * 2); c.stroke();
    }
    c.beginPath(); c.moveTo(12, cy); c.lineTo(W - 12, cy); c.stroke();
    c.beginPath(); c.moveTo(cx, 12); c.lineTo(cx, H - 12); c.stroke();

    // 坐标轴标签
    c.fillStyle = 'rgba(220,232,255,0.45)';
    c.font = '11px system-ui, sans-serif';
    c.fillText('前 +Y', cx - 14, 14);
    c.fillText('后 −Y', cx - 14, H - 6);
    c.fillText('左 −X', 6, cy - 4);
    c.fillText('右 +X', W - 34, cy - 4);

    // 路径参考线（当前段落）
    c.setLineDash([5, 5]);
    for (const id of OBJECT_IDS) {
      const o = snap.objects[id];
      c.strokeStyle = COLORS[id] + '55';
      c.lineWidth = 1.2;
      c.beginPath();
      const STEP = 0.25;
      let first = true;
      for (let t = 0; t <= NARRATIVE.segments[snap.segmentIndex].duration; t += STEP) {
        const p = o.meta.path(t);
        const sx = cx + p.x * scale;
        const sy = cy - p.y * scale;
        if (first) { c.moveTo(sx, sy); first = false; } else c.lineTo(sx, sy);
      }
      c.stroke();
    }
    c.setLineDash([]);

    // 拖尾与对象
    for (const id of OBJECT_IDS) {
      const o = snap.objects[id];
      const trail = this.trails[id];
      if (!o.manual) {
        trail.push({ x: o.x, y: o.y });
        if (trail.length > this.trailMax) trail.shift();
      }
      for (let i = 1; i < trail.length; i++) {
        const alpha = (i / trail.length) * 0.5;
        c.strokeStyle = COLORS[id] + Math.round(alpha * 255).toString(16).padStart(2, '0');
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(cx + trail[i - 1].x * scale, cy - trail[i - 1].y * scale);
        c.lineTo(cx + trail[i].x * scale, cy - trail[i].y * scale);
        c.stroke();
      }

      const sx = cx + o.x * scale;
      const sy = cy - o.y * scale;

      // 声源范围
      c.beginPath();
      c.arc(sx, sy, o.meta.range * scale, 0, Math.PI * 2);
      c.fillStyle = COLORS[id] + '1f';
      c.fill();
      c.strokeStyle = COLORS[id] + '88';
      c.lineWidth = 1;
      c.stroke();

      // 听者到声源连线
      c.beginPath();
      c.moveTo(cx, cy); c.lineTo(sx, sy);
      c.strokeStyle = COLORS[id] + '55';
      c.stroke();

      // 对象本体（能量映射半径）
      const lvl = snap.levels[id] || 0;
      const rr = 7 + Math.min(10, lvl * 60);
      c.beginPath();
      c.arc(sx, sy, rr, 0, Math.PI * 2);
      c.fillStyle = COLORS[id];
      c.globalAlpha = o.accent ? 1 : 0.85;
      c.fill();
      c.globalAlpha = 1;
      if (o.anchor) {
        c.strokeStyle = '#fff';
        c.lineWidth = 2;
        c.stroke();
      }
      c.fillStyle = '#e8f0ff';
      c.font = 'bold 11px system-ui, sans-serif';
      c.fillText(o.meta.name, sx + rr + 3, sy + 3);
    }

    // 听者
    c.beginPath();
    c.arc(cx, cy, 6, 0, Math.PI * 2);
    c.fillStyle = '#ffffff';
    c.fill();
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx, cy - 14);
    c.strokeStyle = '#ffffff';
    c.lineWidth = 2;
    c.stroke();
    c.fillStyle = '#aac2e8';
    c.font = '10px system-ui, sans-serif';
    c.fillText('听者', cx + 8, cy + 14);
  }

  // 方向/能量面板数据
  describe(snap) {
    const rows = [];
    for (const id of OBJECT_IDS) {
      const o = snap.objects[id];
      const az = azimuthDeg(o.x, o.y);
      const dist = Math.hypot(o.x, o.y);
      const inside = dist <= o.meta.range;
      rows.push({
        id,
        name: o.meta.name,
        color: COLORS[id],
        az,
        dir: directionLabel(az),
        dist,
        inside,
        level: snap.levels[id] || 0,
        anchor: o.anchor,
        accent: o.accent,
        priority: o.meta.priority,
      });
    }
    return rows;
  }
}

export { COLORS };
