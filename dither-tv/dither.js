/*
 * dither.js — shared dither engine for dither-tv
 *
 * Everything on screen goes through here. Apps draw a grayscale scene plus
 * pure-red areas onto a low-res internal canvas; the engine thresholds every
 * pixel to exactly paper / ink / red and blits it up with nearest-neighbor.
 *
 *   const d = Dither.create({ canvas, width: 480, height: 270, algo: 'bluenoise' });
 *   d.ctx.fillStyle = '#000'; d.ctx.fillRect(0, 0, d.width, d.height);
 *   d.ctx.fillStyle = '#ff3030'; d.ctx.beginPath(); ...; d.ctx.fill();
 *   d.render();
 *
 * See CLAUDE.md in this folder for the full API contract.
 */

(function (global) {
  'use strict';

  const PAPER = [0x0a, 0x0a, 0x0c];
  const INK = [0x9a, 0x9a, 0x9e];
  const RED = [0xe3, 0x3a, 0x3a];

  // how hard `bias` gains scene luminance; bias is kept small (~±0.05) so
  // this brings the useful range to roughly 0.7x .. 1.3x
  const BIAS_GAIN = 6;

  const ALGOS = [
    'bayer4', 'bayer8', 'halftone', 'lines',
    'ign', 'noise', 'bluenoise',
    'atkinson', 'floyd',
  ];

  // ---------------------------------------------------------------------
  // ordered dither matrices, normalized to [0,1) thresholds
  // ---------------------------------------------------------------------

  const BAYER4_RAW = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];

  const BAYER8_RAW = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ];

  // 8x8 clustered-dot halftone — dots grow from centers (newspaper look)
  const HALFTONE_RAW = [
    [24, 10, 12, 26, 35, 47, 49, 37],
    [8, 0, 2, 14, 45, 59, 61, 51],
    [22, 6, 4, 16, 43, 57, 63, 53],
    [30, 20, 18, 28, 33, 39, 55, 41],
    [34, 46, 48, 36, 25, 11, 13, 27],
    [44, 58, 60, 50, 9, 1, 3, 15],
    [42, 56, 62, 52, 23, 7, 5, 17],
    [32, 38, 54, 40, 31, 21, 19, 29],
  ];

  // 45-degree line screen
  const LINES_RAW = (() => {
    const m = [];
    for (let y = 0; y < 8; y++) {
      const row = [];
      for (let x = 0; x < 8; x++) row.push((x + y) % 8);
      m.push(row);
    }
    return m;
  })();

  // Normalize against the matrix's own value range, NOT its cell count — the
  // line screen reuses values (only 0..7 across 64 cells), so dividing by the
  // cell count would cap every threshold near 0.12 and flood the plate solid.
  function normalizeMatrix(raw) {
    let max = 0;
    for (let y = 0; y < raw.length; y++) {
      for (let x = 0; x < raw[y].length; x++) {
        if (raw[y][x] > max) max = raw[y][x];
      }
    }
    const n = max + 1;
    return raw.map((row) => row.map((v) => (v + 0.5) / n));
  }

  const BAYER4 = normalizeMatrix(BAYER4_RAW);
  const BAYER8 = normalizeMatrix(BAYER8_RAW);
  const HALFTONE = normalizeMatrix(HALFTONE_RAW);
  const LINES = normalizeMatrix(LINES_RAW);

  function matrixThreshold(matrix) {
    const h = matrix.length, w = matrix[0].length;
    return (x, y) => matrix[((y % h) + h) % h][((x % w) + w) % w];
  }

  function frac(v) { return v - Math.floor(v); }

  // interleaved gradient noise
  function ignThreshold(x, y) {
    return frac(52.9829189 * frac(0.06711056 * x + 0.00583715 * y));
  }

  // deterministic xorshift32
  function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function makeNoiseTable(len, seed) {
    const rand = makeRng(seed);
    const t = new Float32Array(len);
    for (let i = 0; i < len; i++) t[i] = rand();
    return t;
  }

  /*
   * Blue-noise threshold tile via void-and-cluster style placement:
   * repeatedly drop the next rank into the largest remaining "void" (lowest
   * accumulated energy), then splat a gaussian there. Produces thresholds
   * with no low-frequency clumping — much cleaner than white noise, and
   * unlike an ordered matrix it has no visible grid.
   *
   * Generated lazily (first time the algo is selected) and cached, since it
   * costs ~100ms and most apps never select it.
   */
  const BLUE_N = 64;
  let blueTable = null;

  function makeBlueNoise(n) {
    const len = n * n;
    const energy = new Float32Array(len);
    const rank = new Float32Array(len);
    const rand = makeRng(0x5EEDB10E);
    // tiny jitter so the first few picks aren't decided by array order
    for (let i = 0; i < len; i++) energy[i] = rand() * 1e-3;

    const SIGMA = 1.9;
    const R = 6;
    const gauss = [];
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        gauss.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA))]);
      }
    }

    for (let k = 0; k < len; k++) {
      let best = 0, bestE = Infinity;
      for (let i = 0; i < len; i++) {
        if (energy[i] < bestE) { bestE = energy[i]; best = i; }
      }
      rank[best] = (k + 0.5) / len;
      energy[best] = Infinity;
      const bx = best % n, by = (best / n) | 0;
      for (let g = 0; g < gauss.length; g++) {
        const gx = ((bx + gauss[g][0]) % n + n) % n;
        const gy = ((by + gauss[g][1]) % n + n) % n;
        const gi = gy * n + gx;
        if (energy[gi] !== Infinity) energy[gi] += gauss[g][2];
      }
    }
    return rank;
  }

  function blueThreshold(x, y) {
    if (!blueTable) blueTable = makeBlueNoise(BLUE_N);
    return blueTable[(((y % BLUE_N) + BLUE_N) % BLUE_N) * BLUE_N
      + (((x % BLUE_N) + BLUE_N) % BLUE_N)];
  }

  const THRESHOLD_FNS = {
    bayer4: matrixThreshold(BAYER4),
    bayer8: matrixThreshold(BAYER8),
    halftone: matrixThreshold(HALFTONE),
    lines: matrixThreshold(LINES),
    ign: ignThreshold,
    bluenoise: blueThreshold,
  };

  // error-diffusion kernels: [dx, dy, weight], plus divisor
  const KERNELS = {
    atkinson: {
      taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]],
      div: 8,
    },
    floyd: {
      taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]],
      div: 16,
    },
  };

  // ---------------------------------------------------------------------

  function create(opts) {
    opts = opts || {};
    const canvas = opts.canvas;
    if (!canvas) throw new Error('Dither.create requires { canvas }');
    const width = opts.width || 480;
    const height = opts.height || 270;
    const n = width * height;

    let algo = ALGOS.indexOf(opts.algo) >= 0 ? opts.algo : 'bayer4';
    let bias = opts.bias || 0;
    let tooth = opts.tooth === undefined ? 0.05 : opts.tooth;
    // pure red would otherwise threshold ~93% on and read as a solid fill;
    // holding it below 1 keeps the second plate visibly screened
    let redDensity = opts.redDensity === undefined ? 0.8 : opts.redDensity;

    // internal low-res scene canvas the app draws into
    const scene = document.createElement('canvas');
    scene.width = width;
    scene.height = height;
    const ctx = scene.getContext('2d', { willReadFrequently: true });

    // output buffer (scene resolution, holds thresholded paper/ink/red)
    const buffer = document.createElement('canvas');
    buffer.width = width;
    buffer.height = height;
    const bufCtx = buffer.getContext('2d');
    const outImg = bufCtx.createImageData(width, height);

    const outCtx = canvas.getContext('2d');
    outCtx.imageSmoothingEnabled = false;

    // preallocated once — these used to be rebuilt every frame
    const noiseTable = makeNoiseTable(n, 0xC0FFEE);
    const toothTable = makeNoiseTable(n, 0x7007ED);
    const redMask = new Uint8Array(n);
    const work = new Float32Array(n);

    let labelText = '';
    let labelUntil = 0;

    function setAlgo(name, o) {
      if (ALGOS.indexOf(name) < 0) return;
      algo = name;
      if (!(o && o.silent)) flashLabel(name);
    }

    function cycleAlgo() {
      setAlgo(ALGOS[(ALGOS.indexOf(algo) + 1) % ALGOS.length]);
    }

    function setBias(v) { bias = v; }
    function setTooth(v) { tooth = v; }
    function setRedDensity(v) { redDensity = v; }

    function flashLabel(text, ms) {
      labelText = text;
      labelUntil = performance.now() + (ms || 1400);
    }

    // error diffusion over `work`, red-plate pixels held out (-1 sentinel)
    function errorDiffuse(kernel, thr) {
      const taps = kernel.taps, div = kernel.div;
      for (let y = 0; y < height; y++) {
        const ltr = (y & 1) === 0;
        for (let k = 0; k < width; k++) {
          const x = ltr ? k : width - 1 - k;
          const p = y * width + x;
          const old = work[p];
          if (old < 0) continue;
          const nw = old >= thr ? 255 : 0;
          const err = (old - nw) / div;
          work[p] = nw;
          for (let t = 0; t < taps.length; t++) {
            const sx = x + (ltr ? taps[t][0] : -taps[t][0]);
            const sy = y + taps[t][1];
            if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
            const q = sy * width + sx;
            if (work[q] < 0) continue;
            work[q] += err * taps[t][2];
          }
        }
      }
    }

    function render() {
      // the algo/mode label is part of the scene, so it gets dithered too —
      // nothing reaches the screen without going through the threshold pass
      if (labelText && performance.now() < labelUntil) {
        ctx.save();
        ctx.font = '10px monospace';
        ctx.fillStyle = '#ff3030';
        ctx.fillText(labelText, 8, height - 8);
        ctx.restore();
      }

      const data = ctx.getImageData(0, 0, width, height).data;
      const out = outImg.data;

      // red plate: R clearly dominant
      for (let p = 0, i = 0; p < n; p++, i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        redMask[p] = (r > 90 && r > g * 1.6 && r > b * 1.6) ? 1 : 0;
      }

      const diffusing = algo === 'atkinson' || algo === 'floyd';
      if (diffusing) {
        for (let p = 0, i = 0; p < n; p++, i += 4) {
          if (redMask[p]) { work[p] = -1; continue; }
          const lum = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
          work[p] = lum * (1 - bias * BIAS_GAIN) + tooth * toothTable[p] * 255;
        }
        errorDiffuse(KERNELS[algo], 127.5);
      }

      const fn = THRESHOLD_FNS[algo] || THRESHOLD_FNS.bayer4;
      // red plate always uses an ordered threshold, offset from the ink plate
      // so the two plates never land on the same pixels (risograph misregister)
      const redFn = diffusing ? THRESHOLD_FNS.bayer4 : fn;

      for (let y = 0, p = 0; y < height; y++) {
        for (let x = 0; x < width; x++, p++) {
          const i = p << 2;
          let c;

          if (redMask[p]) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const redLum = ((r * 0.6 + (255 - g) * 0.2 + (255 - b) * 0.2) / 255) * redDensity;
            const t = (algo === 'noise')
              ? noiseTable[(p + 7919) % n]
              : redFn(x + 4, y + 4);
            // red is deliberately not biased — the accent plate holds a
            // steady screen while the ink plate breathes
            c = redLum > t ? RED : PAPER;
          } else if (diffusing) {
            c = work[p] >= 128 ? INK : PAPER;
          } else {
            const lum = (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11) / 255;
            // Bias GAINS the scene's own luminance rather than shifting the
            // threshold. A shift would let a condensing (negative) bias raise
            // pure paper above the threshold and manufacture a dot lattice out
            // of black; a gain maps 0 to 0 by construction. Tooth is added
            // after, so paper texture stays steady across the breath.
            const eff = lum * (1 - bias * BIAS_GAIN) + tooth * toothTable[p];
            const t = (algo === 'noise') ? noiseTable[p] : fn(x, y);
            c = eff > t ? INK : PAPER;
          }

          out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
        }
      }

      bufCtx.putImageData(outImg, 0, 0);

      // letterboxed integer-scaled blit
      const cw = canvas.width, ch = canvas.height;
      if (!cw || !ch) return;
      let scale = Math.min(cw / width, ch / height);
      if (scale >= 1) scale = Math.floor(scale);
      const dw = Math.round(width * scale), dh = Math.round(height * scale);
      const dx = ((cw - dw) / 2) | 0, dy = ((ch - dh) / 2) | 0;

      outCtx.fillStyle = '#0a0a0c';
      outCtx.fillRect(0, 0, cw, ch);
      outCtx.imageSmoothingEnabled = false;
      outCtx.drawImage(buffer, 0, 0, width, height, dx, dy, dw, dh);
    }

    return {
      ctx,
      width,
      height,
      render,
      setAlgo,
      cycleAlgo,
      setBias,
      setTooth,
      setRedDensity,
      flashLabel,
      get algo() { return algo; },
      get bias() { return bias; },
      // exposed for the threshold-range gate in threshold-check.js
      _thr: function (x, y) {
        return (THRESHOLD_FNS[algo] || THRESHOLD_FNS.bayer4)(x, y);
      },
      algos: ALGOS.slice(),
    };
  }

  global.Dither = { create, PAPER, INK, RED, ALGOS };
})(typeof window !== 'undefined' ? window : this);
