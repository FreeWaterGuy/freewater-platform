// The driver's route map: the run's houses at street scale, readable on a phone in a van.
//   - It zooms to the run's own stops (with padding), not to the micro-factory: six houses on one street fill the map
//     instead of collapsing into one dot beside a far-away depot. The depot, when it's off the map, is an arrow at
//     the edge pointing to it.
//   - Every stop has a numbered marker; the current one is bigger and dark, delivered ones green, ones coming back red.
//   - A line joins the stops in driving order.
//   - Markers that would overlap (two boxes for one house, next-door houses) are fanned out around where they are, each
//     with a thin line back to its house, so every number can be read.
//   - No map tiles are needed: without a tile provider it draws a plain map (a faint grid and a scale bar). With one
//     (FW_MAP_TILES, docs/RUNNING.md "The driver's map"), its tiles are drawn underneath, in the same projection.
// layout() is plain arithmetic (test/route-map.test.ts runs it in Node); draw() makes the SVG in the browser.
(() => {
  'use strict';
  const R = 6378137; // Web Mercator's sphere, in metres (the same projection map tiles use)
  const WORLD = 2 * Math.PI * R;
  const mercator = (p) => ({ x: (R * p.lng * Math.PI) / 180, y: R * Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI) / 360)) });

  /**
   * Where each stop's marker goes. `stops`: [{ stop, point: { lat, lng } }] in driving order. Returns the projection
   * (`toPx`), each marker's place (x, y) and its house's (ax, ay), and the metres one pixel shows (at the run's latitude).
   */
  function layout(stops, opts = {}) {
    const W = opts.width ?? 340, H = opts.height ?? 220, pad = opts.pad ?? 26, r = opts.r ?? 11;
    const minSpan = opts.minSpanM ?? 120; // never closer than this many metres across: one house alone isn't a blur
    const pts = stops.map((s) => mercator(s.point));
    const lat = stops.length ? stops.reduce((n, s) => n + s.point.lat, 0) / stops.length : 0;
    const k = 1 / Math.cos((lat * Math.PI) / 180); // Mercator metres per real metre here
    let minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x)), minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    if (!pts.length) { minX = maxX = minY = maxY = 0; }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const spanX = Math.max(maxX - minX, minSpan * k), spanY = Math.max(maxY - minY, minSpan * k);
    const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY); // px per Mercator metre, same both ways
    const toPx = (p) => { const m = mercator(p); return { x: W / 2 + (m.x - cx) * scale, y: H / 2 - (m.y - cy) * scale }; };
    const markers = stops.map((s) => { const a = toPx(s.point); return { stop: s.stop, x: a.x, y: a.y, ax: a.x, ay: a.y }; });

    // Markers that would overlap are moved apart. Boxes for one house (the same point) are fanned on a small circle round
    // it, in stop order from the top; neighbours a few metres apart are pushed apart along the line between them, so
    // houses along a street stay in their order along it.
    const gap = 2 * r + 3;
    const same = new Map();
    for (const m of markers) { const k = `${Math.round(m.ax)}:${Math.round(m.ay)}`; same.set(k, [...(same.get(k) ?? []), m]); }
    for (const list of same.values()) {
      if (list.length < 2) continue;
      const ring = Math.max(gap / (2 * Math.sin(Math.PI / list.length)), r + 4);
      list.sort((a, b) => a.stop - b.stop).forEach((m, i) => {
        const t = -Math.PI / 2 + (2 * Math.PI * i) / list.length;
        m.x = m.ax + ring * Math.cos(t); m.y = m.ay + ring * Math.sin(t);
      });
    }
    for (let round = 0; round < 300; round++) {
      let moved = false;
      for (let i = 0; i < markers.length; i++) for (let j = i + 1; j < markers.length; j++) {
        const a = markers[i], b = markers[j];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
        if (d >= gap) continue;
        const ux = d ? dx / d : 1, uy = d ? dy / d : 0, push = (gap - d) / 2 + 0.5;
        a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push;
        moved = true;
      }
      for (const m of markers) { m.x = Math.min(W - r - 2, Math.max(r + 2, m.x)); m.y = Math.min(H - r - 2, Math.max(r + 2, m.y)); }
      if (!moved) break;
    }
    return { width: W, height: H, r, scale, metersPerPx: 1 / (scale * k), toPx, center: { x: cx, y: cy }, markers };
  }

  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, a = {}, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v)); if (text != null) e.textContent = text; return e; };
  /** A round number of metres for the scale bar, about a quarter of the map across. */
  const niceMetres = (m) => { const p = 10 ** Math.floor(Math.log10(m)); return [1, 2, 5, 10].map((x) => x * p).filter((x) => x <= m).at(-1) ?? p; };

  /**
   * The map as an SVG element. `run`: { stops: [{ stop, point, status }], depot? }; `current`: the stop to show;
   * `tiles`: { url: 'https://…/{z}/{x}/{y}.png', attribution } or nothing.
   */
  function draw(run, current, opts = {}) {
    const L = layout(run.stops, opts);
    const { width: W, height: H, r } = L;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img', class: 'routemap', 'aria-label': `Map of ${run.stops.length} stops, stop ${current?.stop ?? ''} highlighted` });
    svg.append(el('rect', { width: W, height: H, fill: '#EEF2F5' }));
    if (opts.tiles?.url) {
      // Tiles of the zoom that's just finer than the map, laid under it in the same projection.
      const z = Math.max(0, Math.min(19, Math.ceil(Math.log2((L.scale * WORLD) / 256))));
      const size = WORLD / 2 ** z, px = size * L.scale;
      const left = L.center.x - W / 2 / L.scale, top = L.center.y + H / 2 / L.scale;
      const x0 = Math.floor((left + WORLD / 2) / size), y0 = Math.floor((WORLD / 2 - top) / size);
      for (let tx = x0; tx <= x0 + Math.ceil(W / px) + 1; tx++) for (let ty = y0; ty <= y0 + Math.ceil(H / px) + 1; ty++) {
        const href = opts.tiles.url.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
        svg.append(el('image', { href, x: (tx * size - WORLD / 2 - left) * L.scale, y: (top - (WORLD / 2 - ty * size)) * L.scale,width: px + 0.5, height: px + 0.5, preserveAspectRatio: 'none' }));
      }
      if (opts.tiles.attribution) svg.append(el('text', { x: W - 4, y: H - 4, 'text-anchor': 'end', 'font-size': 8, fill: '#3A4552' }, opts.tiles.attribution));
    } else {
      for (let gx = 0; gx <= W; gx += 34) svg.append(el('line', { x1: gx, y1: 0, x2: gx, y2: H, stroke: '#E1E7EC', 'stroke-width': 1 }));
      for (let gy = 0; gy <= H; gy += 34) svg.append(el('line', { x1: 0, y1: gy, x2: W, y2: gy, stroke: '#E1E7EC', 'stroke-width': 1 }));
    }
    // The order to drive: a line through the markers, stop after stop.
    const line = [...L.markers].sort((a, b) => a.stop - b.stop);
    if (line.length > 1) svg.append(el('polyline', { points: line.map((m) => `${m.x.toFixed(1)},${m.y.toFixed(1)}`).join(' '), fill: 'none', stroke: '#5B6B7B', 'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: 0.55 }));
    // The micro-factory, off the map: an arrow at the edge pointing to it.
    if (run.depot && Number.isFinite(run.depot.lat)) {
      const d = L.toPx(run.depot);
      if (d.x < 0 || d.x > W || d.y < 0 || d.y > H) {
        const dx = d.x - W / 2, dy = d.y - H / 2, t = Math.min((W / 2 - 14) / Math.abs(dx || 1e-9), (H / 2 - 14) / Math.abs(dy || 1e-9));
        const ex = W / 2 + dx * t, ey = H / 2 + dy * t, ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        const g = el('g', { class: 'depot', transform: `translate(${ex.toFixed(1)} ${ey.toFixed(1)})` });
        g.append(el('path', { d: 'M8 0 L-6 -6 L-3 0 L-6 6 Z', fill: '#1F2633', transform: `rotate(${ang.toFixed(0)})` }), el('title', {}, run.depot.name ? `${run.depot.name} (micro-factory)` : 'The micro-factory'));
        svg.append(g);
      } else {
        svg.append(el('rect', { x: d.x - 6, y: d.y - 6, width: 12, height: 12, rx: 2, fill: '#1F2633' }));
      }
    }
    // Leader lines from fanned markers back to their houses, then the markers, the current one last (on top).
    for (const m of L.markers) {
      if (Math.hypot(m.x - m.ax, m.y - m.ay) > 1) svg.append(el('line', { x1: m.ax, y1: m.ay, x2: m.x, y2: m.y, stroke: '#5B6B7B', 'stroke-width': 1.2 }), el('circle', { cx: m.ax, cy: m.ay, r: 2.5, fill: '#5B6B7B' }));
    }
    const byStop = new Map(run.stops.map((s) => [s.stop, s]));
    const order = [...L.markers].sort((a, b) => (a.stop === current?.stop) - (b.stop === current?.stop) || b.stop - a.stop);
    for (const m of order) {
      const s = byStop.get(m.stop);
      const now = m.stop === current?.stop;
      const fill = now ? '#1F2633' : s.status === 'delivered' ? '#1F8A4C' : s.status === 'not_delivered' ? '#B42318' : '#FFFFFF';
      const ink = now || s.status !== 'planned' ? '#FFFFFF' : '#1F2633';
      const g = el('g', { class: `stop${now ? ' current' : ''}`, 'data-stop': m.stop, transform: `translate(${m.x.toFixed(1)} ${m.y.toFixed(1)})` });
      if (now) g.append(el('circle', { r: r + 6, fill: 'none', stroke: '#1F2633', 'stroke-width': 2.5, opacity: 0.35 }));
      g.append(el('circle', { r: now ? r + 2 : r, fill, stroke: s.status === 'planned' && !now ? '#1F2633' : '#FFFFFF', 'stroke-width': 2 }));
      g.append(el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': m.stop > 99 ? 9 : 12, 'font-weight': 700, 'font-family': 'system-ui, sans-serif', fill: ink }, String(m.stop)));
      svg.append(g);
    }
    // A scale bar: how far a stretch of the map is.
    const metres = niceMetres(L.metersPerPx * W * 0.28), bar = metres / L.metersPerPx;
    svg.append(el('rect', { x: 8, y: H - 18, width: bar + 8, height: 14, rx: 3, fill: '#FFFFFF', opacity: 0.8 }), el('line', { x1: 12, y1: H - 8, x2: 12 + bar, y2: H - 8, stroke: '#1F2633', 'stroke-width': 2 }),
      el('text', { x: 12, y: H - 10.5, 'font-size': 9, fill: '#1F2633', 'font-family': 'system-ui, sans-serif' }, metres >= 1000 ? `${metres / 1000} km` : `${metres} m`));
    return svg;
  }

  globalThis.fwRouteMap = { layout, draw, mercator };
})();
