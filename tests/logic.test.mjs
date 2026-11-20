// 纯逻辑冒烟测试（node 直接运行）：空间化数学、路径、叙事事件、WAV 头部。
import { spatialCoefficients, azimuthDeg, directionLabel } from '../js/spatial-math.js';
import { NARRATIVE, OBJECT_IDS, SEGMENT_DURATION, evaluatePath } from '../js/narrative.js';
import { encodeWavBlob } from '../js/wav-encode.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', msg); }
}

// 1. 正前方中心：等功率，左右相等
let c = spatialCoefficients(0, 1, 2.5);
assert(Math.abs(c.gL - c.gR) < 1e-9, '正前方应居中（gL==gR）');
assert(c.gL > 0, '居中应有能量');

// 2. 纯右侧 pan=+1 -> 仅右声道（范围外点声源）
c = spatialCoefficients(9, 0, 1);
assert(c.gR > 0 && Math.abs(c.gL) < 1e-9, '最右侧应只在右声道');

// 3. 纯左侧 -> 仅左声道
c = spatialCoefficients(-9, 0, 1);
assert(c.gL > 0 && Math.abs(c.gR) < 1e-9, '最左侧应只在左声道');

// 4. 能量守恒（点声源，范围外，等功率）
c = spatialCoefficients(6, 3, 0.5);
const e = c.gL * c.gL + c.gR * c.gR;
assert(Math.abs(e - c.distGain * c.distGain) < 1e-9, '等功率能量守恒');

// 5. 进入声源范围 -> 向中心折叠（左右差缩小）
const outside = spatialCoefficients(8, 0, 1);
const inside = spatialCoefficients(0.5, 0, 2.5);
assert(Math.abs(inside.gL - inside.gR) < Math.abs(outside.gL - outside.gR), '进入范围应收窄声像宽度');
assert(inside.width > 0 && outside.width === 0, 'width 标志正确');

// 6. fold=1 -> 完全居中双单声道
c = spatialCoefficients(8, 0, 1, 1, 1);
assert(Math.abs(c.gL - c.gR) < 1e-9, 'fold 应折叠为中心双单声道');

// 7. 距离衰减单调
const near = spatialCoefficients(0, 1, 1).distGain;
const far = spatialCoefficients(0, 9, 1).distGain;
assert(near > far, '距离越远增益越小');

// 8. 方位角与方向标签
assert(Math.abs(azimuthDeg(0, 5)) < 1e-9, '正前方位角 0');
assert(azimuthDeg(-5, 0) < 0, '左侧方位角为负');
assert(directionLabel(0) === '正前' && directionLabel(90) === '右' && directionLabel(-90) === '左', '方向标签');

// 9. 路径连续性与场域约束
for (let s = 0; s < NARRATIVE.segments.length; s++) {
  for (const id of OBJECT_IDS) {
    let prev = evaluatePath(s, id, 0);
    for (let t = 0; t <= SEGMENT_DURATION; t += 0.1) {
      const p = evaluatePath(s, id, t);
      assert(isFinite(p.x) && isFinite(p.y), `路径数值有限 seg${s} ${id} t=${t}`);
      assert(Math.hypot(p.x, p.y) <= 10.01, `路径在场域内 seg${s} ${id}`);
      const jump = Math.hypot(p.x - prev.x, p.y - prev.y);
      assert(jump < 3, `路径连续无跳变 seg${s} ${id} t=${t} jump=${jump.toFixed(2)}`);
      prev = p;
    }
  }
}

// 10. 三个对象路径彼此不同（同段同时刻位置不同）
for (let s = 0; s < NARRATIVE.segments.length; s++) {
  const p1 = evaluatePath(s, 'o1', 5);
  const p2 = evaluatePath(s, 'o2', 5);
  const p3 = evaluatePath(s, 'o3', 5);
  const d12 = Math.hypot(p1.x - p2.x, p1.y - p2.y);
  const d13 = Math.hypot(p1.x - p3.x, p1.y - p3.y);
  assert(d12 > 1 && d13 > 1, '三对象路径相互区分');
}

// 11. 事件时序严格递增且在段内
for (const seg of NARRATIVE.segments) {
  for (const id of OBJECT_IDS) {
    const ts = seg.objects[id].events.map((e) => e.t);
    for (let i = 1; i < ts.length; i++) assert(ts[i] > ts[i - 1], '事件时间递增');
    assert(ts.every((t) => t >= 0 && t < SEGMENT_DURATION), '事件在段范围内');
  }
}

// 12. WAV 编码头
const fake = {
  numberOfChannels: 2,
  sampleRate: 48000,
  length: 4800,
  getChannelData(c) {
    const arr = new Float32Array(4800);
    for (let i = 0; i < arr.length; i++) arr[i] = c === 0 ? 0.1 * Math.sin(i / 10) : 0.05 * Math.cos(i / 12);
    return arr;
  },
};
const blob = encodeWavBlob(fake);
const buf = new Uint8Array(await blob.arrayBuffer());
const view = new DataView(buf.buffer);
const riff = String.fromCharCode(...buf.slice(0, 4));
const wave = String.fromCharCode(...buf.slice(8, 12));
assert(riff === 'RIFF' && wave === 'WAVE', 'WAV 标识正确');
assert(view.getUint32(24, true) === 48000, 'WAV 采样率正确');
assert(view.getUint16(22, true) === 2, 'WAV 双声道');
assert(view.getUint32(40, true) === 4800 * 2 * 2, 'WAV data 块大小正确');
assert(buf.length === 44 + 4800 * 2 * 2, 'WAV 总长度正确');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
