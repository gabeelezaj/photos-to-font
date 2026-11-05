'use strict';
// Builds an OpenType (.otf) font from traced outlines using opentype.js.
const FontBuild = (() => {
  const UPM = 1000;

  // Adds closed outlines to an opentype.Path. Points become smooth quadratic curves through the
  // midpoints of each edge, except at sharp turns, which stay as corners. Returns the y-extent.
  function addOutlines(path, polys, tf) {
    let yMin = Infinity, yMax = -Infinity;
    const r = v => Math.round(v);
    for (const poly of polys) {
      const p = poly.map(tf);
      const n = p.length;
      if (n < 3) continue;
      for (const [, y] of p) { yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); }
      const corner = p.map((pt, i) => {
        const a = p[(i + n - 1) % n], b = p[(i + 1) % n];
        const ux = pt[0] - a[0], uy = pt[1] - a[1], vx = b[0] - pt[0], vy = b[1] - pt[1];
        const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
        return lu > 0 && lv > 0 && (ux * vx + uy * vy) / (lu * lv) < 0.3;
      });
      const mid = i => { const a = p[i], b = p[(i + 1) % n]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
      let m = mid(n - 1);
      path.moveTo(r(m[0]), r(m[1]));
      for (let i = 0; i < n; i++) {
        m = mid(i);
        if (corner[i]) {
          path.lineTo(r(p[i][0]), r(p[i][1]));
          path.lineTo(r(m[0]), r(m[1]));
        } else {
          path.quadraticCurveTo(r(p[i][0]), r(p[i][1]), r(m[0]), r(m[1]));
        }
      }
      path.close();
    }
    return { yMin, yMax };
  }

  function glyphName(ch) {
    if (/^[A-Za-z]$/.test(ch)) return ch;
    return 'uni' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  }

  function notdefPath() {
    const p = new opentype.Path();
    p.moveTo(60, 0); p.lineTo(60, 700); p.lineTo(440, 700); p.lineTo(440, 0); p.close();
    p.moveTo(110, 50); p.lineTo(390, 50); p.lineTo(390, 650); p.lineTo(110, 650); p.close();
    return p;
  }

  // entries: [{ ch, polys, tf, advance }] — tf maps a source-image point to font units.
  function build({ family, entries, spaceWidth }) {
    const glyphs = [
      new opentype.Glyph({ name: '.notdef', advanceWidth: 500, path: notdefPath() }),
      new opentype.Glyph({ name: 'space', unicode: 32, advanceWidth: spaceWidth, path: new opentype.Path() }),
      new opentype.Glyph({ name: 'uni00A0', unicode: 0xa0, advanceWidth: spaceWidth, path: new opentype.Path() }),
    ];
    let ascender = 800, descender = -200;
    const sorted = [...entries].sort((a, b) => a.ch.codePointAt(0) - b.ch.codePointAt(0));
    for (const e of sorted) {
      const path = new opentype.Path();
      const { yMin, yMax } = addOutlines(path, e.polys, e.tf);
      if (isFinite(yMax)) { ascender = Math.max(ascender, Math.ceil(yMax + 20)); descender = Math.min(descender, Math.floor(yMin - 20)); }
      glyphs.push(new opentype.Glyph({ name: glyphName(e.ch), unicode: e.ch.codePointAt(0), advanceWidth: e.advance, path }));
    }
    return new opentype.Font({
      familyName: family,
      styleName: 'Regular',
      unitsPerEm: UPM,
      ascender,
      descender,
      designer: 'Made with Handwriting → Font',
      glyphs,
    });
  }

  return { build };
})();
