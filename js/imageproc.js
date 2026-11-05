'use strict';
// Image processing: loading, grayscale, adaptive thresholding and connected components.
const ImageProc = (() => {
  // Draws an <img>, <video> or <canvas> onto a new canvas no larger than maxDim on its long side.
  function toCanvas(source, maxDim = 2000, mirror = false) {
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    const k = Math.min(1, maxDim / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k));
    c.height = Math.max(1, Math.round(sh * k));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  // Rotates a canvas 90° clockwise.
  function rotate90(canvas) {
    const c = document.createElement('canvas');
    c.width = canvas.height;
    c.height = canvas.width;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.translate(c.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(canvas, 0, 0);
    return c;
  }

  // Luminance, lightly smoothed (3×3) to calm camera noise.
  function grayscale(canvas) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const lum = new Uint16Array(w * h);
    for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    const g = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) { s += lum[yy * w + xx]; n++; }
        }
        g[y * w + x] = s / n;
      }
    }
    return g;
  }

  // Brightness of blank paper: the 90th percentile of the crop.
  function paperLevel(gray, w, roi) {
    const hist = new Uint32Array(256);
    for (let y = roi.y; y < roi.y + roi.h; y++) for (let x = roi.x; x < roi.x + roi.w; x++) hist[gray[y * w + x]]++;
    let acc = 0;
    const target = roi.w * roi.h * 0.9;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  }

  // Bradley–Roth adaptive threshold: a pixel is ink when it is clearly darker than its neighbourhood.
  // Copes with uneven lighting from phone photos and webcams. Areas far darker than the paper
  // (a table or background around the page) are skipped. Returns 1 = ink, only inside roi.
  function threshold(gray, w, h, roi, t) {
    const W = w + 1;
    const integ = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += gray[y * w + x];
        integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row;
      }
    }
    const half = Math.max(6, Math.round(Math.min(roi.w, roi.h) / 16));
    const k = 1 - t;
    const minMean = paperLevel(gray, w, roi) * 0.45;
    const mask = new Uint8Array(w * h);
    const xEnd = roi.x + roi.w, yEnd = roi.y + roi.h;
    for (let y = roi.y; y < yEnd; y++) {
      const y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
      for (let x = roi.x; x < xEnd; x++) {
        const x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
        const n = (x1 - x0) * (y1 - y0);
        const sum = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0];
        const v = gray[y * w + x] * n;
        if (v < sum * k && sum - v > 10 * n && sum > minMean * n) mask[y * w + x] = 1;
      }
    }
    return mask;
  }

  // 8-connected components. labels[i] is the component id (0 = paper).
  function components(mask, w, h) {
    const labels = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    const comps = [];
    let next = 1;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || labels[start]) continue;
      const id = next++;
      let sp = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      stack[sp++] = start;
      labels[start] = id;
      while (sp) {
        const i = stack[--sp];
        const x = i % w, y = (i - x) / w;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (mask[j] && !labels[j]) { labels[j] = id; stack[sp++] = j; }
          }
        }
      }
      comps.push({ id, area, x0, y0, x1: x1 + 1, y1: y1 + 1 });
    }
    return { labels, comps };
  }

  // Marks components that touch the dark surroundings of the page (table, background) — found by
  // flood-filling dark pixels in from the crop border. Real writing is surrounded by paper.
  function touchingBackground(gray, labels, w, h, roi) {
    const dark = paperLevel(gray, w, roi) * 0.35;
    const bg = new Uint8Array(w * h);
    const stack = [];
    const x1 = roi.x + roi.w - 1, y1 = roi.y + roi.h - 1;
    const seed = (x, y) => { const i = y * w + x; if (!bg[i] && gray[i] < dark) { bg[i] = 1; stack.push(i); } };
    for (let x = roi.x; x <= x1; x++) { seed(x, roi.y); seed(x, y1); }
    for (let y = roi.y; y <= y1; y++) { seed(roi.x, y); seed(x1, y); }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      if (x > roi.x) seed(x - 1, y);
      if (x < x1) seed(x + 1, y);
      if (y > roi.y) seed(x, y - 1);
      if (y < y1) seed(x, y + 1);
    }
    const touched = new Set();
    for (let y = roi.y; y <= y1; y++) {
      for (let x = roi.x; x <= x1; x++) {
        if (!bg[y * w + x]) continue;
        for (let yy = Math.max(roi.y, y - 2); yy <= Math.min(y1, y + 2); yy++) {
          for (let xx = Math.max(roi.x, x - 2); xx <= Math.min(x1, x + 2); xx++) {
            const l = labels[yy * w + xx];
            if (l) touched.add(l);
          }
        }
      }
    }
    return touched;
  }

  // Threshold → components → filter. Returns { labels, comps } with only plausible letter blobs.
  function findInk(gray, w, h, roi, t, speck) {
    const { labels, comps } = components(threshold(gray, w, h, roi, t), w, h);
    const touched = touchingBackground(gray, labels, w, h, roi);
    return { labels, comps: filterComps(comps.filter(c => !touched.has(c.id)), roi, speck) };
  }

  // Drops things that aren't handwriting: paper edges and shadows touching the crop border,
  // ruled lines, huge blobs, and specks smaller than `speck` × a typical letter's ink area.
  function filterComps(comps, roi, speck) {
    const kept = comps.filter(c => {
      const bw = c.x1 - c.x0, bh = c.y1 - c.y0;
      if (c.x0 <= roi.x || c.y0 <= roi.y || c.x1 >= roi.x + roi.w || c.y1 >= roi.y + roi.h) return false;
      if (bw > roi.w * 0.5 && bh < bw / 5) return false;
      if (bh > roi.h * 0.5 && bw < bh / 5) return false;
      if (bw * bh > roi.w * roi.h * 0.4) return false;
      return c.area >= 4;
    });
    // Ink-weighted median area: noise specks carry little ink, so they barely move it.
    const sorted = kept.map(c => c.area).sort((a, b) => a - b);
    const total = sorted.reduce((s, a) => s + a, 0);
    let acc = 0, typical = 0;
    for (const a of sorted) { acc += a; if (acc >= total / 2) { typical = a; break; } }
    const min = Math.max(4, typical * speck);
    const letters = kept.filter(c => c.area >= min);
    // Long thin strokes many letters tall are paper edges, folds or ruled lines, not writing.
    const hs = letters.map(c => c.y1 - c.y0).sort((a, b) => a - b);
    const letterH = hs[hs.length >> 1] || 1;
    return letters.filter(c => {
      const long = Math.max(c.x1 - c.x0, c.y1 - c.y0), short = Math.min(c.x1 - c.x0, c.y1 - c.y0);
      return !(long > 4 * letterH && short * 6 < long);
    });
  }

  return { toCanvas, rotate90, grayscale, findInk };
})();
