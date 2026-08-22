/*
 * dither.js — shared dither engine for dither-tv
 *
 * Usage:
 *   const d = Dither.create({ canvas, width: 480, height: 270, algo: 'bayer4' });
 *   // each frame:
 *   d.ctx.fillStyle = '#000'; d.ctx.fillRect(0, 0, d.width, d.height);   // grayscale scene
 *   d.ctx.fillStyle = '#ff3030'; d.ctx.beginPath(); ...; d.ctx.fill();   // pure red = red plate
 *   d.render();
 *
 * See CLAUDE.md in this folder for the full API contract.
 */

(function (global) {
  'use strict';

  const PAPER = [0x0a, 0x0a, 0x0c];
  const INK = [0x9a, 0x9a, 0x9e];
  const RED = [0xe3, 0x3a, 0x3a];

  const ALGOS = ['bayer4', 'bayer8', 'halftone', 'lines', 'ign', 'noise', 'atkinson'];

  // --- ordered dither matrices, normalized to [0,1) thresholds ---

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

  // 8x8 clustered-dot halftone matrix (classic newspaper spiral growth order)
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

  // 45-degree line screen, 8x8, thresholds ramp along one diagonal
  const LINES_RAW = (() => {
    const m = [];
    for (let y = 0; y < 8; y++) {
      const row = [];
      for (let x = 0; x < 8; x++) {
        row.push((x + y) % 8);
      }
      m.push(row);
    }
    return m;
  })();

  function normalizeMatrix(raw) {
    const n = raw.length * raw[0].length;
    return raw.map((row) => row.map((v) => (v + 0.5) / n));
  }

  const BAYER4 = normalizeMatrix(BAYER4_RAW);
  const BAYER8 = normalizeMatrix(BAYER8_RAW);
  const HALFTONE = normalizeMatrix(HALFTONE_RAW);
  const LINES = normalizeMatrix(LINES_RAW);

  function matrixThreshold(matrix) {
    const h = matrix.length, w = matrix[0].length;
    return (x, y) => matrix[y % h][x % w];
  }

  // interleaved gradient noise
  function ignThreshold(x, y) {
    return frac(52.9829189 * frac(0.06711056 * x + 0.00583715 * y));
  }
  function frac(v) {
    return v - Math.floor(v);
  }

  // precomputed static noise table (no per-frame shimmer)
  function makeNoiseTable(width, height, seed) {
    let s = seed >>> 0 || 1;
    const rand = () => {
      // xorshift32
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return (s >>> 0) / 4294967296;
    };
    const table = new Float32Array(width * height);
    for (let i = 0; i < table.length; i++) table[i] = rand();
    return table;
  }

  const THRESHOLD_FNS = {
    bayer4: matrixThreshold(BAYER4),
    bayer8: matrixThreshold(BAYER8),
    halftone: matrixThreshold(HALFTONE),
    lines: matrixThreshold(LINES),
    ign: ignThreshold,
  };

  function create(opts) {
    opts = opts || {};
    const canvas = opts.canvas;
    if (!canvas) throw new Error('Dither.create requires { canvas }');
    const width = opts.width || 480;
    const height = opts.height || 270;
    let algo = ALGOS.includes(opts.algo) ? opts.algo : 'bayer4';

    // internal low-res scene canvas the app draws into
    const scene = document.createElement('canvas');
    scene.width = width;
    scene.height = height;
    const ctx = scene.getContext('2d', { willReadFrequently: true });

    // output buffer canvas (same resolution as scene, holds thresholded paper/ink/red)
    const buffer = document.createElement('canvas');
    buffer.width = width;
    buffer.height = height;
    const bufCtx = buffer.getContext('2d');
    const outImg = bufCtx.createImageData(width, height);

    // visible fullscreen canvas
    const outCtx = canvas.getContext('2d');
    outCtx.imageSmoothingEnabled = false;

    const noiseTable = makeNoiseTable(width, height, 0xC0FFEE);

    // small temporary on-screen label state, shown when algo is cycled/set
    let labelText = '';
    let labelUntil = 0;

    function setAlgo(name, opts) {
      if (!ALGOS.includes(name)) return;
      algo = name;
      const silent = opts && opts.silent;
      if (!silent) {
        labelText = name;
        labelUntil = performance.now() + 1200;
      }
    }

    function cycleAlgo() {
      const i = ALGOS.indexOf(algo);
      setAlgo(ALGOS[(i + 1) % ALGOS.length]);
    }

    function flashLabel(text, ms) {
      labelText = text;
      labelUntil = performance.now() + (ms || 1200);
    }

    function ditherAtkinson(data, redMask) {
      // luminance working buffer, red-plate pixels excluded from diffusion
      const lum = new Float32Array(width * height);
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        lum[p] = redMask[p] ? -1 : data[i]; // -1 sentinel: red plate, skip
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = y * width + x;
          if (lum[p] < 0) continue; // red plate pixel, leave untouched
          const old = lum[p];
          const nw = old < 128 ? 0 : 255;
          const err = (old - nw) / 8;
          lum[p] = nw;
          diffuse(lum, x + 1, y, width, height, err);
          diffuse(lum, x + 2, y, width, height, err);
          diffuse(lum, x - 1, y + 1, width, height, err);
          diffuse(lum, x, y + 1, width, height, err);
          diffuse(lum, x + 1, y + 1, width, height, err);
          diffuse(lum, x, y + 2, width, height, err);
        }
      }
      return lum;
    }

    function diffuse(lum, x, y, w, h, err) {
      if (x < 0 || x >= w || y < 0 || y >= h) return;
      const p = y * w + x;
      if (lum[p] < 0) return; // don't diffuse into red-plate pixels
      lum[p] += err;
    }

    function render() {
      const src = ctx.getImageData(0, 0, width, height);
      const data = src.data;
      const out = outImg.data;
      const n = width * height;

      // build red mask: pure/near-pure red pixels (r dominant, g/b low-ish)
      const redMask = new Uint8Array(n);
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r > 90 && r > g * 1.6 && r > b * 1.6) redMask[p] = 1;
      }

      let atkinsonLum = null;
      if (algo === 'atkinson') {
        atkinsonLum = ditherAtkinson(data, redMask);
      }

      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const x = p % width, y = (p / width) | 0;

        if (redMask[p]) {
          // red plate: dithered separately with an offset threshold so it
          // reads as dots, never a smooth fill
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const redLum = (r * 0.6 + (255 - g) * 0.2 + (255 - b) * 0.2) / 255;
          let t;
          if (algo === 'noise') {
            t = noiseTable[p];
          } else if (algo === 'atkinson') {
            t = THRESHOLD_FNS.bayer4(x + 4, y + 4); // offset ordered fallback for red plate
          } else {
            const fn = THRESHOLD_FNS[algo] || THRESHOLD_FNS.bayer4;
            t = fn(x + 4, y + 4); // offset threshold vs ink plate
          }
          const on = redLum > t;
          const c = on ? RED : PAPER;
          out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
          continue;
        }

        let on;
        if (algo === 'atkinson') {
          on = atkinsonLum[p] >= 128;
        } else {
          const lum = (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11) / 255;
          let t;
          if (algo === 'noise') {
            t = noiseTable[p];
          } else {
            const fn = THRESHOLD_FNS[algo] || THRESHOLD_FNS.bayer4;
            t = fn(x, y);
          }
          on = lum > t;
        }
        const c = on ? INK : PAPER;
        out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
      }

      bufCtx.putImageData(outImg, 0, 0);

      // letterboxed integer-scaled blit to the visible canvas
      const cw = canvas.width, ch = canvas.height;
      const scale = Math.max(1, Math.floor(Math.min(cw / width, ch / height)));
      const dw = width * scale, dh = height * scale;
      const dx = ((cw - dw) / 2) | 0, dy = ((ch - dh) / 2) | 0;

      outCtx.fillStyle = '#0a0a0c';
      outCtx.fillRect(0, 0, cw, ch);
      outCtx.imageSmoothingEnabled = false;
      outCtx.drawImage(buffer, 0, 0, width, height, dx, dy, dw, dh);

      if (labelText && performance.now() < labelUntil) {
        outCtx.font = '12px monospace';
        outCtx.fillStyle = 'rgba(227,58,58,0.85)';
        outCtx.fillText(labelText, 10, ch - 12);
      }
    }

    return {
      ctx,
      width,
      height,
      render,
      setAlgo,
      cycleAlgo,
      flashLabel,
      get algo() { return algo; },
      algos: ALGOS.slice(),
    };
  }

  global.Dither = { create, PAPER, INK, RED, ALGOS };
})(typeof window !== 'undefined' ? window : this);
