'use strict';
// Groups ink blobs into letters, lines and words, and labels them from the text the user typed.
//
// A glyph is a set of "parts": a component id plus an x-range of it to keep. Whole components use
// an unbounded range; splitting two touching letters gives each half a clipped range.
const Segment = (() => {
  const XH = new Set('acemnorsuvwxz');
  const TALL = new Set('ABCDEFGHIJKLMNOPRSTUVWXYZ0123456789bdhkl');
  const OFF_BASELINE = new Set(`gjpqyQ,;'"\`^*~-_=+°`);
  const X_HEIGHT = 480, CAP_HEIGHT = 700; // font units, 1000 per em
  const FULL = 1e9;
  let nextUid = 1;

  function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function weightedMedian(values, weights) {
    const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    const total = weights.reduce((s, w) => s + w, 0);
    let acc = 0;
    for (const i of idx) { acc += weights[i]; if (acc >= total / 2) return values[i]; }
    return 0;
  }

  const height = g => g.y1 - g.y0;
  const centerX = g => (g.x0 + g.x1) / 2;

  function makeGlyph(src, parts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, area = 0;
    for (const p of parts) {
      const c = src.compMap.get(p.comp);
      const cx0 = Math.max(c.x0, p.x0), cx1 = Math.min(c.x1, p.x1);
      if (cx1 <= cx0) continue;
      if (cx0 === c.x0 && cx1 === c.x1) {
        x0 = Math.min(x0, c.x0); y0 = Math.min(y0, c.y0);
        x1 = Math.max(x1, c.x1); y1 = Math.max(y1, c.y1);
        area += c.area;
        continue;
      }
      for (let y = c.y0; y < c.y1; y++) {
        for (let x = cx0; x < cx1; x++) {
          if (src.labels[y * src.w + x] !== p.comp) continue;
          area++;
          if (x < x0) x0 = x;
          if (x + 1 > x1) x1 = x + 1;
          if (y < y0) y0 = y;
          if (y + 1 > y1) y1 = y + 1;
        }
      }
    }
    if (!area) return null;
    return { uid: nextUid++, src, parts, x0, y0, x1, y1, area, label: '', flag: 'none', line: null };
  }

  // The glyph's bitmap (1 = ink) cropped to its box plus `pad` pixels of paper on each side.
  function mask(g, pad = 0) {
    g._masks = g._masks || {};
    if (g._masks[pad]) return g._masks[pad];
    const { src } = g;
    const w = g.x1 - g.x0 + 2 * pad, h = g.y1 - g.y0 + 2 * pad;
    const data = new Uint8Array(w * h);
    for (let y = g.y0; y < g.y1; y++) {
      for (let x = g.x0; x < g.x1; x++) {
        const l = src.labels[y * src.w + x];
        if (!l) continue;
        for (const p of g.parts) {
          if (p.comp === l && x >= p.x0 && x < p.x1) { data[(y - g.y0 + pad) * w + x - g.x0 + pad] = 1; break; }
        }
      }
    }
    return (g._masks[pad] = { data, w, h });
  }

  // Joins dots, accents and other small marks to the letter they belong to (i, j, !, ?, :, ;, é…).
  function groupChars(src, comps) {
    const n = comps.length;
    const parent = comps.map((_, i) => i);
    const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    const medH = weightedMedian(comps.map(c => c.y1 - c.y0), comps.map(c => c.area)) || 1;

    for (let i = 0; i < n; i++) {
      const s = comps[i], sw = s.x1 - s.x0, sh = s.y1 - s.y0;
      const small = sh < 0.45 * medH && sw < 0.8 * medH;
      const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
      let best = -1, bestScore = -Infinity;
      for (let j = 0; j < n; j++) {
        const p = comps[j];
        if (j === i || p.area < s.area || (p.area === s.area && j > i)) continue;
        const gap = Math.max(s.y0, p.y0) - Math.min(s.y1, p.y1); // > 0 when vertically apart
        const pcx = (p.x0 + p.x1) / 2;
        let score;
        if (small) {
          if (gap > 0.6 * medH) continue;
          const above = cy < (p.y0 + p.y1) / 2;
          // a mark above may sit off to the side (i-dots); one below must be centred (! and ?)
          if (above ? (cx < p.x0 - 0.25 * medH || cx > p.x1 + 0.25 * medH) : Math.abs(cx - pcx) > 0.3 * medH) continue;
          score = -gap / medH - Math.abs(cx - pcx) / medH;
        } else {
          // a broken-off piece lying inside another letter's box
          const xov = Math.min(s.x1, p.x1) - Math.max(s.x0, p.x0);
          if (gap >= 0 || xov < 0.8 * sw || s.area > 0.5 * p.area) continue;
          score = 0;
        }
        if (score > bestScore) { bestScore = score; best = j; }
      }
      if (best >= 0) parent[find(i)] = find(best);
    }

    const groups = new Map();
    comps.forEach((c, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push({ comp: c.id, x0: -FULL, x1: FULL });
    });
    return [...groups.values()].map(parts => makeGlyph(src, parts)).filter(Boolean);
  }

  // Sweeps left to right, attaching each letter to the line whose recent letters it overlaps
  // vertically the most. Following the recent letters lets lines drift (tilted photos).
  function buildLines(glyphs) {
    const medH = weightedMedian(glyphs.map(height), glyphs.map(g => g.area)) || 1;
    const isSmall = g => height(g) < 0.45 * medH;
    const lines = [];
    for (const g of [...glyphs].sort((a, b) => a.x0 - b.x0)) {
      let best = null, bestOv = 0.25;
      for (const L of lines) {
        const ov = (Math.min(g.y1, L.band.y1) - Math.max(g.y0, L.band.y0)) / Math.min(height(g), L.band.y1 - L.band.y0);
        if (ov > bestOv) { bestOv = ov; best = L; }
      }
      if (!best) { best = { glyphs: [], recent: [] }; lines.push(best); }
      best.glyphs.push(g);
      if (!isSmall(g)) {
        best.recent = best.recent.filter(r => !isSmall(r)).concat(g).slice(-3);
      } else if (!best.recent.length) {
        best.recent.push(g);
      }
      best.band = { y0: median(best.recent.map(r => r.y0)), y1: median(best.recent.map(r => r.y1)) };
    }
    for (const L of lines) {
      L.glyphs.forEach(g => (g.line = L));
      const big = L.glyphs.filter(g => !isSmall(g));
      L.medH = median((big.length ? big : L.glyphs).map(height)) || 1;
      L.cy = median(L.glyphs.map(g => (g.y0 + g.y1) / 2));
      delete L.recent;
      delete L.band;
    }
    return lines.sort((a, b) => a.cy - b.cy);
  }

  // Splits each line into words. When we know how many words were written, the largest gaps win;
  // otherwise any gap wider than about half a letter height counts.
  function splitWords(lines, wordCount) {
    const gaps = [];
    for (const L of lines) {
      let right = -Infinity;
      L.glyphs.forEach((g, i) => {
        if (i) gaps.push({ L, i, v: (g.x0 - right) / L.medH });
        right = Math.max(right, g.x1);
      });
    }
    const K = wordCount - lines.length;
    const breaks = wordCount && K >= 0 && K <= gaps.length
      ? new Set([...gaps].sort((a, b) => b.v - a.v).slice(0, K))
      : new Set(gaps.filter(g => g.v > 0.55));
    const isBreak = new Map([...breaks].map(b => [b.L.glyphs[b.i], true]));
    const words = [];
    for (const L of lines) {
      let cur = [];
      for (const g of L.glyphs) {
        if (isBreak.get(g) && cur.length) { words.push(cur); cur = []; }
        cur.push(g);
      }
      if (cur.length) words.push(cur);
    }
    return words;
  }

  function fitBaseline(pts, medH) {
    const flat = () => ({ a: median(pts.map(p => p[1])), b: 0 });
    const xs = pts.map(p => p[0]);
    if (pts.length < 4 || Math.max(...xs) - Math.min(...xs) < 3 * medH) return flat();
    const ls = ps => {
      const n = ps.length, mx = ps.reduce((s, p) => s + p[0], 0) / n, my = ps.reduce((s, p) => s + p[1], 0) / n;
      let sxy = 0, sxx = 0;
      for (const [x, y] of ps) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
      const b = sxx ? sxy / sxx : 0;
      return { a: my - b * mx, b };
    };
    let fit = ls(pts);
    const inliers = pts.filter(([x, y]) => Math.abs(y - (fit.a + fit.b * x)) <= 0.12 * medH);
    if (inliers.length >= 3) fit = ls(inliers);
    return Math.abs(fit.b) > 0.15 ? flat() : fit;
  }

  // Baseline (a straight line, so slightly tilted writing still sits level) and the scale that
  // brings this line's x-height (or cap height) to the font's.
  function lineMetrics(L) {
    const gs = L.glyphs;
    let pts = gs.filter(g => g.label && !OFF_BASELINE.has(g.label));
    if (!pts.length) pts = gs.filter(g => height(g) >= 0.5 * L.medH);
    if (!pts.length) pts = gs;
    L.base = fitBaseline(pts.map(g => [centerX(g), g.y1]), L.medH);
    const top = g => L.base.a + L.base.b * centerX(g) - g.y0;
    const xh = median(gs.filter(g => XH.has(g.label)).map(top));
    const cap = median(gs.filter(g => TALL.has(g.label)).map(top));
    L.scale = xh > 0 ? X_HEIGHT / xh : cap > 0 ? CAP_HEIGHT / cap : CAP_HEIGHT / L.medH;
  }

  function updateMetrics(src) { src.lines.forEach(lineMetrics); }

  function sync(src) {
    src.lines = src.lines.filter(L => L.glyphs.length);
    src.glyphs = src.lines.flatMap(L => L.glyphs);
  }

  function merge(gs) {
    const src = gs[0].src, L = gs[0].line;
    const g = makeGlyph(src, gs.flatMap(x => x.parts));
    g.label = (gs.find(x => x.label) || {}).label || '';
    g.flag = g.label ? 'fix' : 'none';
    for (const x of gs) x.line.glyphs = x.line.glyphs.filter(y => y !== x);
    g.line = L;
    L.glyphs.push(g);
    L.glyphs.sort((a, b) => a.x0 - b.x0);
    sync(src);
    return g;
  }

  // Cuts a glyph at its thinnest column near the middle (for letters that touch).
  function split(g) {
    const m = mask(g);
    if (m.w < 6) return null;
    const cols = new Array(m.w).fill(0);
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) cols[x] += m.data[y * m.w + x];
    let best = -1, bv = Infinity;
    for (let x = Math.floor(m.w * 0.25); x < Math.ceil(m.w * 0.75); x++) {
      const v = cols[x] + Math.abs(x - m.w / 2) / m.w;
      if (v < bv) { bv = v; best = x; }
    }
    const cut = g.x0 + best;
    const a = makeGlyph(g.src, g.parts.map(p => ({ comp: p.comp, x0: p.x0, x1: Math.min(p.x1, cut) })).filter(p => p.x1 > p.x0));
    const b = makeGlyph(g.src, g.parts.map(p => ({ comp: p.comp, x0: Math.max(p.x0, cut), x1: p.x1 })).filter(p => p.x1 > p.x0));
    if (!a || !b) return null;
    const L = g.line;
    a.line = b.line = L;
    L.glyphs.splice(L.glyphs.indexOf(g), 1, a, b);
    sync(g.src);
    return [a, b];
  }

  function remove(g) {
    g.line.glyphs = g.line.glyphs.filter(x => x !== g);
    sync(g.src);
  }

  // Makes one detected word match the typed word: merges the closest pieces while there are too
  // many, splits the widest blob while there are too few. Returns 'ok', 'fixed' or 'bad'.
  function alignWord(wg, letters) {
    let changed = false;
    while (wg.length > letters.length && wg.length > 1) {
      let bi = 0, bv = Infinity;
      for (let i = 0; i + 1 < wg.length; i++) {
        const v = (wg[i + 1].x0 - wg[i].x1) / wg[i].line.medH;
        if (v < bv) { bv = v; bi = i; }
      }
      wg.splice(bi, 2, merge([wg[bi], wg[bi + 1]]));
      changed = true;
    }
    while (wg.length < letters.length) {
      const order = wg.map((_, i) => i).sort((a, b) => (wg[b].x1 - wg[b].x0) - (wg[a].x1 - wg[a].x0));
      let parts = null, at = -1;
      for (const i of order) if ((parts = split(wg[i]))) { at = i; break; }
      if (!parts) break;
      wg.splice(at, 1, ...parts);
      changed = true;
    }
    wg.forEach((g, i) => {
      g.label = letters[i] || '';
      g.flag = !g.label ? 'none' : changed ? 'fix' : 'ok';
    });
    return wg.length !== letters.length ? 'bad' : changed ? 'fixed' : 'ok';
  }

  // Full pass for one photo: letters → lines → words → labels from src.text → metrics.
  function analyze(src) {
    const glyphs = groupChars(src, src.comps);
    src.lines = buildLines(glyphs);
    sync(src);
    const words = src.text.trim().split(/\s+/).filter(Boolean).map(w => Array.from(w));
    const detected = splitWords(src.lines, words.length);
    const n = src.glyphs.length;

    if (!n) {
      src.message = { kind: 'warn', text: 'No handwriting found. Try raising the ink sensitivity, or drag on the photo to crop to the writing.' };
    } else if (!words.length) {
      src.message = { kind: 'info', text: `Found ${n} letters in ${detected.length} words. Type what you wrote to label them automatically.` };
    } else if (detected.length === words.length) {
      const results = detected.map((wg, k) => alignWord(wg, words[k]));
      const bad = results.filter(r => r === 'bad').length, fixed = results.filter(r => r === 'fixed').length;
      const total = words.flat().length;
      if (!bad && !fixed) src.message = { kind: 'ok', text: `All ${total} letters matched your text.` };
      else src.message = { kind: 'warn', text: `${words.length - bad - fixed} of ${words.length} words matched exactly; ${fixed + bad} needed adjusting. Check the amber letters below.` };
    } else {
      const letters = words.flat();
      src.glyphs.forEach((g, i) => { g.label = letters[i] || ''; g.flag = letters[i] ? 'fix' : 'none'; });
      src.message = { kind: 'warn', text: `Found ${detected.length} words but your text has ${words.length}, so letters were labeled in order. Check them, or adjust the crop and sensitivity.` };
    }
    updateMetrics(src);
  }

  return { analyze, groupChars, mask, merge, split, remove, updateMetrics, X_HEIGHT, CAP_HEIGHT };
})();
