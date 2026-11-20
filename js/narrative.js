// 叙事数据：3 个独立声音对象（不同路径/范围/增益/优先级）+ 2 个可切换叙事段落。
// 坐标系：听者固定 (0,0) 面向 +Y，X 负=左、正=右；单位为米；场域半径 10m。
// 路径函数输入为段落内时间 t（秒），输出 {x, y}。

export const FIELD_RADIUS = 10;
export const SEGMENT_DURATION = 24;

function circlePath(r, omega, phase = 0) {
  return (t) => ({ x: r * Math.sin(omega * t + phase), y: r * Math.cos(omega * t + phase) });
}

function pingPongPath(x0, y0, x1, y1, period) {
  return (t) => {
    const p = ((t % period) / period) * 2;
    const k = p < 1 ? p : 2 - p;
    return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k };
  };
}

// 沿闭合折线巡逻：points 为顶点列表（自动首尾闭合），totalSec 为走完一圈的时间
function patrolPath(points, totalSec) {
  const loop = [...points, points[0]];
  const segLen = [];
  let total = 0;
  for (let i = 0; i < loop.length - 1; i++) {
    const dx = loop[i + 1][0] - loop[i][0];
    const dy = loop[i + 1][1] - loop[i][1];
    const l = Math.hypot(dx, dy);
    segLen.push(l);
    total += l;
  }
  return (t) => {
    let d = ((t % totalSec) / totalSec) * total;
    for (let i = 0; i < segLen.length; i++) {
      if (d <= segLen[i]) {
        const k = segLen[i] === 0 ? 0 : d / segLen[i];
        return {
          x: loop[i][0] + (loop[i + 1][0] - loop[i][0]) * k,
          y: loop[i][1] + (loop[i + 1][1] - loop[i][1]) * k,
        };
      }
      d -= segLen[i];
    }
    const last = loop[loop.length - 1];
    return { x: last[0], y: last[1] };
  };
}

// 事件表：用于检查事件时序（内核在到达时间点时触发，seek 会清空已触发记录）
function ev(t, type, text) { return { t, type, text }; }

export const NARRATIVE = {
  segments: [
    {
      id: 'A',
      name: '段落 A · 林间破晓',
      duration: SEGMENT_DURATION,
      bedFilterHz: 900,
      bedGain: 0.85,
      objects: {
        o1: {
          name: '鸟鸣',
          kind: 'bird',
          priority: 2,
          baseGain: 0.9,
          range: 2.2,
          path: circlePath(7, 0.55, 0),
          pathName: '环形路径（顺时针，r=7m）',
          events: [
            ev(3.0, 'accent', '鸟鸣掠至左前'),
            ev(12.5, 'accent', '鸟鸣回环至右后'),
            ev(20.0, 'accent', '鸟鸣贴近听者'),
          ],
        },
        o2: {
          name: '脚步',
          kind: 'footstep',
          priority: 1,
          baseGain: 1.0,
          range: 1.6,
          path: patrolPath(
            [[-8, -6], [-3, -2], [3, -2], [8, 2], [3, 6], [-3, 6], [-8, 2]],
            22
          ),
          pathName: '折线巡逻路径（穿越前方）',
          events: [
            ev(6.0, 'accent', '脚步从左后接近'),
            ev(15.0, 'accent', '脚步横越正前方'),
          ],
        },
        o3: {
          name: '钟声',
          kind: 'bell',
          priority: 3,
          baseGain: 1.1,
          range: 3.0,
          bellFreq: 440,
          path: pingPongPath(-6, 4, 6, 4, 16),
          pathName: 'L 型折返路径（前方往复）',
          events: [
            ev(4.0, 'accent', '钟声自左前响起（关键叙事）'),
            ev(16.0, 'accent', '钟声右前回应（关键叙事）'),
          ],
        },
      },
    },
    {
      id: 'B',
      name: '段落 B · 回声回廊',
      duration: SEGMENT_DURATION,
      bedFilterHz: 350,
      bedGain: 1.0,
      objects: {
        o1: {
          name: '鸟鸣',
          kind: 'bird',
          priority: 2,
          baseGain: 0.7,
          range: 2.6,
          path: circlePath(4.5, -0.8, Math.PI / 2),
          pathName: '反向内圈（逆时针，r=4.5m）',
          events: [ev(8.0, 'accent', '鸟鸣在内圈反向掠过')],
        },
        o2: {
          name: '脚步',
          kind: 'footstep',
          priority: 1,
          baseGain: 1.15,
          range: 1.8,
          path: patrolPath(
            [[8, -6], [8, 6], [0, 8], [-8, 6], [-8, -6]],
            18
          ),
          pathName: '外缘包抄路径',
          events: [
            ev(5.0, 'accent', '脚步沿右侧外缘移动'),
            ev(14.0, 'accent', '脚步绕至左后'),
          ],
        },
        o3: {
          name: '钟声',
          kind: 'bell',
          priority: 3,
          baseGain: 1.25,
          range: 3.6,
          bellFreq: 523.25,
          path: pingPongPath(6, -5, -6, 3, 20),
          pathName: '对角折返路径（范围扩大）',
          events: [
            ev(7.0, 'accent', '钟声在右后低鸣（关键叙事）'),
            ev(18.0, 'accent', '钟声收束于左前（关键叙事）'),
          ],
        },
      },
    },
  ],
};

export const OBJECT_IDS = ['o1', 'o2', 'o3'];
export const BUDGET_LEVELS = [
  { spatialVoices: 1, label: '紧张（1 个空间声道）' },
  { spatialVoices: 2, label: '有限（2 个空间声道）' },
  { spatialVoices: 3, label: '充足（3 个空间声道）' },
];

export function evaluatePath(segment, objectId, t) {
  return NARRATIVE.segments[segment].objects[objectId].path(t);
}
