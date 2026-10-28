// Deterministic PCM analysis used in both the real Electron renderer and
// node:test. The reference signal is a generated 440 Hz tone, NOT speech.
(function (root) {
  'use strict';
  function measure(samples, sampleRate, frequency = 440) {
    if (!samples || samples.length < 1024 || !Number.isFinite(sampleRate) || sampleRate < 8000) {
      throw new Error('AUDIO_PCM_SAMPLES_MISSING');
    }
    const n = samples.length;
    let mean = 0;
    for (const x of samples) {
      if (!Number.isFinite(x) || Math.abs(x) > 1.001) throw new Error('AUDIO_PCM_INVALID');
      mean += x;
    }
    mean /= n;
    let meanSin = 0, meanCos = 0;
    for (let i = 0; i < n; i++) {
      const angle = 2 * Math.PI * frequency * i / sampleRate;
      meanSin += Math.sin(angle);
      meanCos += Math.cos(angle);
    }
    meanSin /= n; meanCos /= n;
    let ss = 0, cc = 0, sc = 0, xs = 0, xc = 0;
    let total = 0, clipped = 0;
    for (let i = 0; i < n; i++) {
      const angle = 2 * Math.PI * frequency * i / sampleRate;
      const s = Math.sin(angle) - meanSin, c = Math.cos(angle) - meanCos;
      const v = samples[i] - mean;
      ss += s * s; cc += c * c; sc += s * c;
      xs += v * s; xc += v * c;
      total += v * v;
      if (Math.abs(samples[i]) >= 0.98) clipped++;
    }
    const determinant = ss * cc - sc * sc;
    if (!(determinant > 0)) throw new Error('AUDIO_REFERENCE_NOT_IDENTIFIABLE');
    const a = (xs * cc - xc * sc) / determinant;
    const b = (xc * ss - xs * sc) / determinant;
    let residual = 0, signal = 0;
    for (let i = 0; i < n; i++) {
      const angle = 2 * Math.PI * frequency * i / sampleRate;
      const estimated = a * (Math.sin(angle) - meanSin) + b * (Math.cos(angle) - meanCos);
      const error = samples[i] - mean - estimated;
      signal += estimated * estimated;
      residual += error * error;
    }
    return {
      rms: Math.sqrt(total / n),
      snrDb: Number((10 * Math.log10(Math.max(signal, 1e-20) / Math.max(residual, 1e-20))).toFixed(3)),
      clippingPercent: Number((100 * clipped / n).toFixed(3)),
      dropout: Math.sqrt(total / n) < 0.002,
    };
  }
  const api = { measure };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__audioQualityMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
