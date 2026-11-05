'use strict';
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const dpr = () => window.devicePixelRatio || 1;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const CHARSET = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' + `.,!?'"-:;()&@#$%/+=*`);
  const SUGGESTIONS = [
    'the quick brown fox jumps over the lazy dog',
    'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG',
    '12345 67890',
    `. , ! ? ' " - : ; ( ) & @ # $ % / + = *`,
  ];
  const FLAG_COLORS = { ok: '#1f9d55', fix: '#e0a100', none: '#9a9a9a' };

  const state = { sources: [], selected: new Set(), choice: new Map(), byUid: new Map(), hoverUid: 0, nextSrc: 1 };
  const settings = { weight: 0, spacing: 40, space: 300, fillCase: true };

  const allGlyphs = () => state.sources.flatMap(s => s.glyphs);

  // ---------------------------------------------------------------- sources

  function addSource(canvas, name, text = '') {
    const src = {
      id: state.nextSrc++, name, canvas, w: canvas.width, h: canvas.height,
      gray: ImageProc.grayscale(canvas), roi: null, text, sensitivity: 60, speck: 30, glyphs: [], lines: [],
    };
    state.sources.push(src);
    buildSourceCard(src);
    detect(src);
    src.card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return src;
  }

  // Find ink and blobs, then segment and label.
  function detect(src) {
    const roi = src.roi || { x: 0, y: 0, w: src.w, h: src.h };
    const { labels, comps } = ImageProc.findInk(src.gray, src.w, src.h, roi, 0.4 - src.sensitivity * 0.0036, src.speck / 1000);
    src.labels = labels;
    src.comps = comps;
    src.compMap = new Map(src.comps.map(c => [c.id, c]));
    src.inkLayer = null;
    segment(src);
  }

  function segment(src) {
    Segment.analyze(src);
    structureChanged();
  }

  function structureChanged() {
    state.byUid = new Map(allGlyphs().map(g => [g.uid, g]));
    for (const uid of state.selected) if (!state.byUid.has(uid)) state.selected.delete(uid);
    for (const [ch, uid] of state.choice) {
      const g = state.byUid.get(uid);
      if (!g || g.label !== ch) state.choice.delete(ch);
    }
    state.sources.forEach(src => { drawSource(src); showMessage(src); });
    renderTiles();
    updateToolbar();
    labelsChanged();
  }

  function labelsChanged() {
    renderAlphabet();
    markChosenTiles();
    scheduleBuild();
  }

  function showMessage(src) {
    const m = src.message || { kind: '', text: '' };
    src.msgEl.className = 'msg ' + m.kind;
    src.msgEl.textContent = m.text;
    src.statsEl.textContent = `${src.glyphs.length} letters · ${src.w}×${src.h}`;
  }

  function buildSourceCard(src) {
    const card = el('div', 'source');
    const head = el('div', 'source-head');
    const stats = el('span', 'muted');
    const rot = el('button', 'ghost small', 'Rotate ↻');
    const reset = el('button', 'ghost small', 'Reset crop');
    const rm = el('button', 'ghost small danger', 'Remove');
    head.append(el('strong', null, src.name), stats, el('span', 'spacer'), rot, reset, rm);

    const wrap = el('div', 'view-wrap');
    const view = el('canvas', 'view');
    wrap.append(view);
    const hint = el('div', 'crop-hint', 'Drag across the photo to crop to the writing · click a box to select that letter');

    const textRow = el('label', 'text-row');
    const text = el('textarea');
    text.rows = 2;
    text.placeholder = 'Type exactly what you wrote in this photo, word for word';
    text.value = src.text;
    textRow.append(el('span', null, 'What did you write?'), text);

    const chips = el('div', 'chips');
    chips.append(el('span', 'muted', 'Insert:'));
    for (const s of SUGGESTIONS) {
      const b = el('button', 'chip', s.length > 26 ? s.slice(0, 24) + '…' : s);
      b.title = s;
      b.onclick = () => {
        text.value = (text.value.trim() ? text.value.trim() + '\n' : '') + s;
        text.dispatchEvent(new Event('input'));
      };
      chips.append(b);
    }

    const sliders = el('div', 'controls');
    sliders.append(
      slider('Ink sensitivity', 0, 100, src.sensitivity, v => { src.sensitivity = v; detect(src); }),
      slider('Ignore specks', 0, 100, src.speck, v => { src.speck = v; detect(src); }),
    );
    const msg = el('div', 'msg');
    card.append(head, wrap, hint, textRow, chips, sliders, msg);
    $('#sources').append(card);
    Object.assign(src, { card, view, msgEl: msg, statsEl: stats });

    text.addEventListener('input', debounce(() => { src.text = text.value; segment(src); }, 400));
    rot.onclick = () => {
      src.canvas = ImageProc.rotate90(src.canvas);
      src.w = src.canvas.width; src.h = src.canvas.height;
      src.gray = ImageProc.grayscale(src.canvas);
      src.roi = null;
      detect(src);
    };
    reset.onclick = () => { src.roi = null; detect(src); };
    rm.onclick = () => {
      state.sources = state.sources.filter(s => s !== src);
      card.remove();
      structureChanged();
    };
    attachViewInteractions(src);
  }

  function slider(label, min, max, value, onChange) {
    const l = el('label', null, label);
    const input = el('input');
    Object.assign(input, { type: 'range', min, max, value });
    input.addEventListener('input', debounce(() => onChange(+input.value), 150));
    l.append(input);
    return l;
  }

  // Ink pixels the detector kept, tinted, drawn over the photo.
  function inkLayer(src) {
    if (src.inkLayer) return src.inkLayer;
    const c = document.createElement('canvas');
    c.width = src.w; c.height = src.h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(src.w, src.h);
    const keep = new Set(src.compMap.keys());
    for (let i = 0; i < src.labels.length; i++) {
      if (!keep.has(src.labels[i])) continue;
      img.data[i * 4] = 47; img.data[i * 4 + 1] = 91; img.data[i * 4 + 2] = 234; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return (src.inkLayer = c);
  }

  function drawSource(src) {
    const cv = src.view;
    const cssW = Math.min(cv.parentElement.clientWidth || 800, src.w);
    const k = cssW / src.w, cssH = Math.round(src.h * k), r = dpr();
    cv.width = Math.round(cssW * r);
    cv.height = Math.round(cssH * r);
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    src.viewScale = k;
    const ctx = cv.getContext('2d');
    ctx.setTransform(r * k, 0, 0, r * k, 0, 0); // draw in image pixels
    ctx.drawImage(src.canvas, 0, 0);
    ctx.globalAlpha = 0.5;
    ctx.drawImage(inkLayer(src), 0, 0);
    ctx.globalAlpha = 1;

    if (src.roi) {
      const { x, y, w, h } = src.roi;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, src.w, y);
      ctx.fillRect(0, y + h, src.w, src.h - y - h);
      ctx.fillRect(0, y, x, h);
      ctx.fillRect(x + w, y, src.w - x - w, h);
    }

    const px = 1 / k;
    ctx.font = `600 ${Math.round(13 * px)}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    for (const g of src.glyphs) {
      const sel = state.selected.has(g.uid), hov = state.hoverUid === g.uid;
      const color = FLAG_COLORS[g.flag];
      if (hov) { ctx.fillStyle = 'rgba(47,91,234,0.25)'; ctx.fillRect(g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0); }
      ctx.strokeStyle = sel ? '#2f5bea' : color;
      ctx.lineWidth = (sel ? 3 : 1.5) * px;
      ctx.strokeRect(g.x0 - 2 * px, g.y0 - 2 * px, g.x1 - g.x0 + 4 * px, g.y1 - g.y0 + 4 * px);
      if (g.label) {
        const tw = ctx.measureText(g.label).width + 6 * px;
        ctx.fillStyle = sel ? '#2f5bea' : color;
        ctx.fillRect(g.x0 - 2 * px, g.y0 - 18 * px, tw, 16 * px);
        ctx.fillStyle = '#fff';
        ctx.fillText(g.label, g.x0 + px, g.y0 - 3 * px);
      }
    }

    if (src.drag && src.drag.moved) {
      const [ax, ay] = src.drag.a, [bx, by] = src.drag.b;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 * px;
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.setLineDash([]);
    }
  }

  function attachViewInteractions(src) {
    const cv = src.view;
    const toImg = e => {
      const r = cv.getBoundingClientRect();
      return [(e.clientX - r.left) / src.viewScale, (e.clientY - r.top) / src.viewScale];
    };
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      src.drag = { a: toImg(e), b: toImg(e), moved: false };
    });
    cv.addEventListener('pointermove', e => {
      if (!src.drag) return;
      src.drag.b = toImg(e);
      const [ax, ay] = src.drag.a, [bx, by] = src.drag.b;
      if (Math.hypot(bx - ax, by - ay) * src.viewScale > 6) src.drag.moved = true;
      if (src.drag.moved) drawSource(src);
    });
    cv.addEventListener('pointerup', () => {
      const d = src.drag;
      src.drag = null;
      if (!d) return;
      if (d.moved) {
        const clamp = (v, hi) => Math.max(0, Math.min(hi, Math.round(v)));
        const x0 = clamp(Math.min(d.a[0], d.b[0]), src.w), x1 = clamp(Math.max(d.a[0], d.b[0]), src.w);
        const y0 = clamp(Math.min(d.a[1], d.b[1]), src.h), y1 = clamp(Math.max(d.a[1], d.b[1]), src.h);
        if (x1 - x0 > 20 && y1 - y0 > 20) { src.roi = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; detect(src); }
        else drawSource(src);
        return;
      }
      const [x, y] = d.a, tol = 4 / src.viewScale;
      const hits = src.glyphs.filter(g => x >= g.x0 - tol && x <= g.x1 + tol && y >= g.y0 - tol && y <= g.y1 + tol);
      hits.sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));
      if (hits[0]) {
        toggleSelect(hits[0].uid);
        const tile = document.querySelector(`.tile[data-uid="${hits[0].uid}"]`);
        if (tile) tile.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  // ---------------------------------------------------------------- letter tiles

  function drawThumb(canvas, g) {
    const m = Segment.mask(g, 1);
    const tmp = document.createElement('canvas');
    tmp.width = m.w; tmp.height = m.h;
    const tctx = tmp.getContext('2d');
    const img = tctx.createImageData(m.w, m.h);
    for (let i = 0; i < m.data.length; i++) if (m.data[i]) img.data[i * 4 + 3] = 255;
    tctx.putImageData(img, 0, 0);
    const size = 56 * dpr();
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const k = Math.min(size / m.w, size / m.h);
    ctx.drawImage(tmp, (size - m.w * k) / 2, (size - m.h * k) / 2, m.w * k, m.h * k);
  }

  function renderTiles() {
    const box = $('#tiles');
    box.textContent = '';
    const withGlyphs = state.sources.filter(s => s.glyphs.length);
    if (!withGlyphs.length) { box.append(el('p', 'empty', 'Letters appear here after you add a photo.')); return; }
    for (const src of withGlyphs) {
      box.append(el('div', 'tile-group', src.name));
      const grid = el('div', 'tile-grid');
      for (const g of src.glyphs) grid.append(makeTile(g));
      box.append(grid);
    }
  }

  function tileClass(g) {
    return `tile ${g.flag}${state.selected.has(g.uid) ? ' selected' : ''}`;
  }

  function makeTile(g) {
    const t = el('div', tileClass(g));
    t.dataset.uid = g.uid;
    const c = el('canvas');
    drawThumb(c, g);
    const input = el('input');
    input.value = g.label;
    input.maxLength = 2;
    input.setAttribute('aria-label', 'Letter');
    const star = el('button', 'star', '★');
    star.title = 'Use this version in the font';
    t.append(star, c, input);

    input.addEventListener('input', () => {
      g.label = Array.from(input.value.trim())[0] || '';
      if (input.value !== g.label) input.value = g.label;
      g.flag = g.label ? 'ok' : 'none';
      t.className = tileClass(g);
      Segment.updateMetrics(g.src);
      drawSource(g.src);
      labelsChanged();
    });
    input.addEventListener('focus', () => input.select());
    star.addEventListener('click', e => {
      e.stopPropagation();
      if (!g.label) return;
      state.choice.set(g.label, g.uid);
      labelsChanged();
    });
    t.addEventListener('click', e => { if (e.target !== input) toggleSelect(g.uid); });
    t.addEventListener('mouseenter', () => { state.hoverUid = g.uid; drawSource(g.src); });
    t.addEventListener('mouseleave', () => { state.hoverUid = 0; drawSource(g.src); });
    return t;
  }

  function markChosenTiles() {
    for (const t of document.querySelectorAll('.tile')) {
      const g = state.byUid.get(+t.dataset.uid);
      if (!g) continue;
      const n = g.label ? variants(g.label).length : 0;
      t.classList.toggle('chosen', n > 1 && chosen(g.label) === g);
      t.classList.toggle('single', n <= 1);
    }
  }

  function toggleSelect(uid) {
    if (state.selected.has(uid)) state.selected.delete(uid); else state.selected.add(uid);
    const g = state.byUid.get(uid);
    const t = document.querySelector(`.tile[data-uid="${uid}"]`);
    if (t && g) t.className = tileClass(g);
    markChosenTiles();
    if (g) drawSource(g.src);
    updateToolbar();
  }

  const selectedGlyphs = () => [...state.selected].map(u => state.byUid.get(u)).filter(Boolean);

  function updateToolbar() {
    const n = state.selected.size;
    $('#mergeBtn').disabled = n < 2;
    $('#splitBtn').disabled = n < 1;
    $('#deleteBtn').disabled = n < 1;
    $('#clearSelBtn').disabled = n < 1;
  }

  function afterEdit(srcs, newSelection = []) {
    srcs.forEach(Segment.updateMetrics);
    state.selected = new Set(newSelection.map(g => g.uid));
    structureChanged();
  }

  $('#mergeBtn').onclick = () => {
    const gs = selectedGlyphs();
    if (new Set(gs.map(g => g.src)).size > 1) { alert('Pick pieces from the same photo to merge.'); return; }
    const m = Segment.merge(gs);
    afterEdit([m.src], [m]);
  };
  $('#splitBtn').onclick = () => {
    const pieces = [];
    let failed = 0;
    for (const g of selectedGlyphs()) {
      const p = Segment.split(g);
      if (p) pieces.push(...p); else failed++;
    }
    if (failed) alert(`${failed} letter(s) were too narrow to split.`);
    afterEdit([...new Set(pieces.map(p => p.src))], pieces);
  };
  $('#deleteBtn').onclick = () => {
    const gs = selectedGlyphs();
    gs.forEach(Segment.remove);
    afterEdit([...new Set(gs.map(g => g.src))]);
  };
  $('#clearSelBtn').onclick = () => afterEdit([]);

  // ---------------------------------------------------------------- alphabet

  const variants = ch => allGlyphs().filter(g => g.label === ch);

  function chosen(ch) {
    const list = variants(ch);
    const picked = state.byUid.get(state.choice.get(ch));
    if (picked && picked.label === ch) return picked;
    return list.find(g => g.flag === 'ok') || list[0] || null;
  }

  // Missing letters can borrow the other case's shape (scaled), if that option is on.
  function borrowedFrom(ch) {
    if (!settings.fillCase || !/^[A-Za-z]$/.test(ch) || chosen(ch)) return null;
    const other = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
    return chosen(other) ? other : null;
  }

  function renderAlphabet() {
    const box = $('#alphabet');
    box.textContent = '';
    const labeled = new Set(allGlyphs().map(g => g.label).filter(Boolean));
    const chars = [...CHARSET, ...[...labeled].filter(c => !CHARSET.includes(c)).sort()];
    let have = 0, borrowed = 0;
    for (const ch of chars) {
      const list = variants(ch);
      const from = borrowedFrom(ch);
      const cell = el('div', 'cell');
      cell.append(el('span', 'g', ch), el('small', null, ch));
      if (list.length) {
        have++;
        if (list.length > 1) {
          cell.classList.add('multi');
          const cur = list.indexOf(chosen(ch));
          cell.append(el('em', null, `${cur + 1}/${list.length}`));
          cell.title = 'Click to use a different version';
          cell.onclick = () => {
            state.choice.set(ch, list[(cur + 1) % list.length].uid);
            labelsChanged();
          };
        }
      } else if (from) {
        borrowed++;
        cell.classList.add('filled');
        cell.title = `Not written yet — borrowing your “${from}”`;
      } else {
        cell.classList.add('missing');
        cell.title = 'Not written yet';
      }
      box.append(cell);
    }
    $('#alphaSummary').textContent = `You have ${have} of ${chars.length} characters` + (borrowed ? `, plus ${borrowed} borrowed from the other case.` : '.');
  }

  // ---------------------------------------------------------------- font

  function traced(g) {
    if (!g._trace || g._trace.weight !== settings.weight) {
      g._trace = { weight: settings.weight, polys: Trace.traceGlyph(g, settings.weight) };
    }
    return g._trace.polys;
  }

  // Places a traced glyph in font units: its line's baseline at y = 0, scaled by its line's
  // x-height (times `extra` for borrowed case), with side bearings from the spacing setting.
  function entryFor(ch, g, extra = 1) {
    const polys = traced(g);
    if (!polys.length) return null;
    const L = g.line, s = L.scale * extra;
    const by = L.base.a + L.base.b * (g.x0 + g.x1) / 2;
    let minX = Infinity, maxX = -Infinity;
    for (const p of polys) for (const [x] of p) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    const sp = settings.spacing;
    return {
      ch, polys,
      advance: Math.max(10, Math.round((maxX - minX) * s + 2 * sp)),
      tf: ([x, y]) => [(x - minX) * s + sp, (by - y) * s],
    };
  }

  function borrowScale(ch, g) {
    const top = (g.line.base.a + g.line.base.b * (g.x0 + g.x1) / 2 - g.y0) * g.line.scale;
    if (top <= 0) return 1;
    if (ch === ch.toUpperCase()) return Math.max(1, Segment.CAP_HEIGHT / top);
    return /[bdfhklt]/.test(ch) ? 1 : Math.min(1, Segment.X_HEIGHT / top);
  }

  let buildSeq = 0, previewFace = null, fontBuffer = null;
  const scheduleBuild = debounce(buildFont, 150);

  async function buildFont() {
    const seq = ++buildSeq;
    const entries = [];
    const labeled = new Set(allGlyphs().map(g => g.label).filter(Boolean));
    for (const ch of labeled) {
      const e = entryFor(ch, chosen(ch));
      if (e) entries.push(e);
    }
    for (const ch of CHARSET) {
      const from = borrowedFrom(ch);
      if (!from) continue;
      const g = chosen(from);
      const e = entryFor(ch, g, borrowScale(ch, g));
      if (e) entries.push(e);
    }
    const btn = $('#downloadBtn');
    if (!entries.length) { fontBuffer = null; btn.disabled = true; return; }
    try {
      const font = FontBuild.build({ family: familyName(), entries, spaceWidth: settings.space });
      const buffer = font.toArrayBuffer();
      const face = new FontFace('HWPreview' + seq, buffer);
      await face.load();
      if (seq !== buildSeq) return;
      document.fonts.add(face);
      if (previewFace) document.fonts.delete(previewFace);
      previewFace = face;
      fontBuffer = buffer;
      document.documentElement.style.setProperty('--hw', `"HWPreview${seq}", serif`);
      btn.disabled = false;
    } catch (err) {
      console.error(err);
      if (seq === buildSeq) btn.disabled = true;
    }
  }

  const familyName = () => $('#fontName').value.trim() || 'My Handwriting';

  $('#downloadBtn').onclick = () => {
    if (!fontBuffer) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([fontBuffer], { type: 'font/otf' }));
    a.download = familyName().replace(/[^\w -]+/g, '').replace(/\s+/g, '-') + '.otf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('#fontName').addEventListener('input', scheduleBuild);

  const bindRange = (id, fn) => $(id).addEventListener('input', debounce(e => { fn(+e.target.value); }, 60));
  bindRange('#weight', v => { settings.weight = v / 100; scheduleBuild(); });
  bindRange('#spacing', v => { settings.spacing = v; scheduleBuild(); });
  bindRange('#space', v => { settings.space = v; scheduleBuild(); });
  bindRange('#previewSize', v => { $('#preview').style.fontSize = v + 'px'; });
  $('#fillCase').addEventListener('change', e => { settings.fillCase = e.target.checked; labelsChanged(); });

  // ---------------------------------------------------------------- input: files, paste, webcam

  function loadFile(file) {
    if (!file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { addSource(ImageProc.toCanvas(img), file.name || 'Pasted image'); URL.revokeObjectURL(url); };
    img.onerror = () => alert(`Couldn't read ${file.name}. If it's an iPhone HEIC photo, export it as JPEG first.`);
    img.src = url;
  }

  const drop = $('#dropzone');
  $('#fileInput').addEventListener('change', e => { [...e.target.files].forEach(loadFile); e.target.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); [...e.dataTransfer.files].forEach(loadFile); });
  document.addEventListener('paste', e => {
    for (const item of e.clipboardData.items) if (item.type.startsWith('image/')) loadFile(item.getAsFile());
  });

  const cam = { stream: null, timer: 0, count: 0 };
  const video = $('#camVideo'), overlay = $('#camOverlay'), stage = $('#camStage');

  $('#webcamBtn').onclick = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('This browser cannot use the webcam here. Open the app through the start script (http://localhost) in Chrome, Edge, Firefox or Safari.');
      return;
    }
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (err) {
      alert('Could not open the webcam: ' + err.message);
      return;
    }
    video.srcObject = cam.stream;
    await video.play();
    $('#webcamPanel').hidden = false;
    $('#webcamPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    clearInterval(cam.timer);
    cam.timer = setInterval(liveDetect, 300);
  };

  // Quick, low-res pass so you can see which letters the camera can pick out before capturing.
  function liveDetect() {
    if (!video.videoWidth) return;
    const c = ImageProc.toCanvas(video, 640);
    const w = c.width, h = c.height, roi = { x: 0, y: 0, w, h };
    const { labels, comps } = ImageProc.findInk(ImageProc.grayscale(c), w, h, roi, 0.18, 0.03);
    const boxes = Segment.groupChars({ w, h, labels, compMap: new Map(comps.map(k => [k.id, k])) }, comps);
    overlay.width = w; overlay.height = h;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#3df59a';
    ctx.lineWidth = 1.5;
    for (const b of boxes) ctx.strokeRect(b.x0 - 1, b.y0 - 1, b.x1 - b.x0 + 2, b.y1 - b.y0 + 2);
    $('#camStatus').textContent = boxes.length ? `${boxes.length} letters in view` : 'Hold your page up to the camera…';
  }

  function capture() {
    stage.classList.remove('flash');
    void stage.offsetWidth;
    stage.classList.add('flash');
    addSource(ImageProc.toCanvas(video, 2000, $('#camMirror').checked), `Webcam photo ${++cam.count}`);
  }

  $('#camSnap').onclick = capture;
  $('#camSnap3').onclick = () => {
    const cd = $('#camCountdown');
    let n = 3;
    cd.hidden = false;
    cd.textContent = n;
    const t = setInterval(() => {
      if (--n > 0) { cd.textContent = n; return; }
      clearInterval(t);
      cd.hidden = true;
      capture();
    }, 1000);
  };
  $('#camMirror').addEventListener('change', e => stage.classList.toggle('mirror', e.target.checked));
  $('#camClose').onclick = () => {
    clearInterval(cam.timer);
    if (cam.stream) cam.stream.getTracks().forEach(t => t.stop());
    cam.stream = null;
    $('#webcamPanel').hidden = true;
  };

  // ---------------------------------------------------------------- demo

  // Writes the suggested sentences in a handwriting-style system font, with a little wobble.
  function makeDemo() {
    const c = document.createElement('canvas');
    c.width = 2000; c.height = 760;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fbfaf5';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#1b2a4a';
    ctx.font = '50px "Bradley Hand", "Segoe Print", "Comic Sans MS", "Chalkboard SE", cursive';
    ctx.textBaseline = 'alphabetic';
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    SUGGESTIONS.forEach((line, row) => {
      let x = 60;
      const y = 140 + row * 170;
      for (const ch of line) {
        if (ch === ' ') { x += 34; continue; }
        ctx.save();
        ctx.translate(x, y + rand() * 4);
        ctx.rotate(rand() * 0.06);
        ctx.fillText(ch, 0, 0);
        ctx.restore();
        x += ctx.measureText(ch).width + 9;
      }
    });
    return c;
  }

  $('#demoBtn').onclick = () => addSource(makeDemo(), 'Demo page', SUGGESTIONS.join('\n'));

  // ---------------------------------------------------------------- start

  for (const s of SUGGESTIONS) $('#suggestionList').append(el('li', null, s));
  window.addEventListener('resize', debounce(() => state.sources.forEach(drawSource), 150));
  renderAlphabet();
  updateToolbar();
  // handy for debugging from the console
  window.HandwritingFont = { state, addSource, get fontBuffer() { return fontBuffer; } };
})();
