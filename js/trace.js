'use strict';
// Turns a glyph's bitmap into smooth closed outlines, in source-image pixel coordinates.
// The bitmap is upscaled and blurred so outlines come out smooth rather than as pixel stairs;
// where the blurred field is cut decides the stroke weight.
const Trace = (() => {
  function upsample(m, w, h, f) {
    const W = w * f, H = h * f, out = new Float32Array(W * H);
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : m[y * w + x]);
    for (let Y = 0; Y < H; Y++) {
      const sy = (Y + 0.5) / f - 0.5, y0 = Math.floor(sy), fy = sy - y0;
      for (let X = 0; X < W; X++) {
        const sx = (X + 0.5) / f - 0.5, x0 = Math.floor(sx), fx = sx - x0;
        out[Y * W + X] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy)
          + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
      }
    }
    return { data: out, W, H };
  }

  function boxBlur(d, W, H, r) {
    const tmp = new Float32Array(W * H), n = 2 * r + 1;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let s = 0;
      for (let x = 0; x <= r && x < W; x++) s += d[row + x];
      for (let x = 0; x < W; x++) {
        tmp[row + x] = s / n;
        if (x + r + 1 < W) s += d[row + x + r + 1];
        if (x - r >= 0) s -= d[row + x - r];
      }
    }
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let y = 0; y <= r && y < H; y++) s += tmp[y * W + x];
      for (let y = 0; y < H; y++) {
        d[y * W + x] = s / n;
        if (y + r + 1 < H) s += tmp[(y + r + 1) * W + x];
        if (y - r >= 0) s -= tmp[(y - r) * W + x];
      }
    }
  }

  // Follows pixel edges with ink always on the right, so outer outlines and holes come out with
  // opposite winding, as fonts need. Returns loops of corner points on the pixel-corner grid.
  function contours(bin, W, H) {
    const VW = W + 1, NV = VW * (H + 1);
    const o1 = new Int32Array(NV).fill(-1), o2 = new Int32Array(NV).fill(-1);
    const add = (s, e) => { if (o1[s] < 0) o1[s] = e; else o2[s] = e; };
    const ink = (x, y) => x >= 0 && y >= 0 && x < W && y < H && bin[y * W + x] === 1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!ink(x, y)) continue;
        const tl = y * VW + x, tr = tl + 1, bl = tl + VW, br = bl + 1;
        if (!ink(x, y - 1)) add(tl, tr);
        if (!ink(x + 1, y)) add(tr, br);
        if (!ink(x, y + 1)) add(br, bl);
        if (!ink(x - 1, y)) add(bl, tl);
      }
    }
    // At a vertex shared by two diagonal pixels there are two ways out; always turning right
    // keeps the two pixels' outlines apart.
    const take = (v, dx, dy) => {
      const e1 = o1[v], e2 = o2[v];
      if (e2 < 0) { o1[v] = -1; return e1; }
      const cx = (e1 % VW) - (v % VW), cy = ((e1 / VW) | 0) - ((v / VW) | 0);
      o2[v] = -1;
      if (dx * cy - dy * cx > 0) { o1[v] = e2; return e1; }
      return e2;
    };
    const loops = [];
    for (let s = 0; s < NV; s++) {
      while (o1[s] >= 0 && o2[s] < 0) {
        const pts = [];
        let v = s, dx = 0, dy = 0;
        do {
          const e = take(v, dx, dy);
          const ndx = (e % VW) - (v % VW), ndy = ((e / VW) | 0) - ((v / VW) | 0);
          if (ndx !== dx || ndy !== dy) pts.push([v % VW, (v / VW) | 0]);
          dx = ndx; dy = ndy; v = e;
        } while (v !== s);
        loops.push(pts);
      }
    }
    return loops;
  }

  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const len = Math.hypot(bx - ax, by - ay);
      let idx = -1, dmax = eps;
      for (let i = a + 1; i < b; i++) {
        const [px, py] = pts[i];
        const d = len ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len : Math.hypot(px - ax, py - ay);
        if (d > dmax) { dmax = d; idx = i; }
      }
      if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function simplifyClosed(pts, eps) {
    if (pts.length < 4) return pts;
    let far = 0, fd = -1;
    pts.forEach(([x, y], i) => {
      const d = (x - pts[0][0]) ** 2 + (y - pts[0][1]) ** 2;
      if (d > fd) { fd = d; far = i; }
    });
    const a = rdp(pts.slice(0, far + 1), eps);
    const b = rdp(pts.slice(far).concat([pts[0]]), eps);
    return a.slice(0, -1).concat(b.slice(0, -1));
  }

  function area(pts) {
    let s = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
    return s / 2;
  }

  // weight: -1 (thinner) … 1 (bolder)
  function traceGlyph(g, weight) {
    const pad = 3, m = Segment.mask(g, pad);
    // Estimate stroke width (ink area / half the edge length) so thin pen lines survive the blur.
    let ink = 0, edges = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (!m.data[i]) continue;
        ink++;
        edges += !m.data[i - 1] + !m.data[i + 1] + !m.data[i - m.w] + !m.data[i + m.w];
      }
    }
    const stroke = edges ? (2 * ink) / edges : 3;
    const f = Math.max(1, Math.min(8, Math.round(320 / Math.max(m.w, m.h))));
    const { data, W, H } = upsample(m.data, m.w, m.h, f);
    boxBlur(data, W, H, Math.max(1, Math.round(f * 0.8)));
    const base = stroke >= 3 ? 0.5 : 0.5 * (0.4 + 0.2 * stroke);
    const T = Math.min(0.85, Math.max(0.08, base - 0.3 * weight));
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < bin.length; i++) bin[i] = data[i] > T ? 1 : 0;
    return contours(bin, W, H)
      .map(l => simplifyClosed(l, 0.9))
      .filter(l => l.length >= 3 && Math.abs(area(l)) >= 3 * f * f)
      .map(l => l.map(([x, y]) => [g.x0 - pad + x / f, g.y0 - pad + y / f]));
  }

  return { traceGlyph };
})();
