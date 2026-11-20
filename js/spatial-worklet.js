// SpatialPannerProcessor
// 明确声明的空间化方法（采样率执行）：
//   1. 距离增益  gain = far / (far + max(dist, near))，near 为近场钳制距离
//   2. 等功率声像 pan = x / dist，theta = (pan+1)*PI/4，gL=cos(theta), gR=sin(theta)
//   3. 声源范围 crossfeed：width = clamp(1 - dist/range, 0, 1)
//      听者进入声源范围时，向等幅双单声道（中心折叠）交叉混合，范围外为点声源
//   4. fold=1 时完全折叠为中心等功率双单声道（资源降级，不静音）
// 该文件必须独立、无 import，因为它运行在 AudioWorklet 全局作用域。

const INV_SQRT2 = Math.SQRT1_2;
const NEAR = 0.6;
const FAR = 14;

class SpatialPannerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'posX', defaultValue: 0, automationRate: 'a-rate' },
      { name: 'posY', defaultValue: 0, automationRate: 'a-rate' },
      { name: 'range', defaultValue: 2.5, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 1, automationRate: 'a-rate' },
      { name: 'fold', defaultValue: 0, automationRate: 'a-rate' },
    ];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length < 2) return true;

    const inChannels = input.length;
    const outL = output[0];
    const outR = output[1];
    const len = outL.length;

    const px = parameters.posX;
    const py = parameters.posY;
    const pg = parameters.gain;
    const pf = parameters.fold;
    const range = Math.max(parameters.range[0], 1e-6);
    const aRate = (name) => name.length > 1;
    const ax = aRate(px), ay = aRate(py), ag = aRate(pg), af = aRate(pf);

    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < inChannels; c++) s += input[c][i];
      s /= inChannels;

      const x = ax ? px[i] : px[0];
      const y = ay ? py[i] : py[0];
      const extGain = ag ? pg[i] : pg[0];
      const fold = af ? pf[i] : pf[0];

      const dist = Math.sqrt(x * x + y * y);
      const pan = dist > 1e-9 ? x / dist : 0;
      const dEff = Math.max(dist, NEAR);
      const distGain = FAR / (FAR + dEff);

      const theta = (Math.max(-1, Math.min(1, pan)) + 1) * (Math.PI / 4);
      let gL = Math.cos(theta);
      let gR = Math.sin(theta);

      const width = Math.max(0, Math.min(1, 1 - dist / range));
      gL = (1 - width) * gL + width * INV_SQRT2;
      gR = (1 - width) * gR + width * INV_SQRT2;

      if (fold > 0) {
        gL = (1 - fold) * gL + fold * INV_SQRT2;
        gR = (1 - fold) * gR + fold * INV_SQRT2;
      }

      const g = distGain * extGain;
      outL[i] = s * g * gL;
      outR[i] = s * g * gR;
    }
    return true;
  }
}

registerProcessor('spatial-panner', SpatialPannerProcessor);
