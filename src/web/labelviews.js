// The two ways a printed label is shown to people, everywhere one is (the advertiser portal's previews, the review
// page in ops, the console's label previews):
//   "On the bottle": the finished 8 × 4 in label, cut. What a customer holds. The default.
//   "Print file":    the file the printer gets, with its bleed round it (backgrounds run past the cut so a cutter that
//                    drifts never leaves a white line), and a thin line where it is cut. Outside the line is trimmed.
// The label drawing the server sends is the finished label (its viewBox is the cut) with the bleed drawn round it, and
// says how much (data-fw-bleed, in drawing units, 100 to the inch): the print file is the same drawing, seen wider.
(() => {
  'use strict';
  const CUT = '#E0218A';

  /** The print file of a label drawing, with its cut line. A drawing without bleed comes back with just the line. */
  function printView(svg) {
    const m = /^<svg\b[^>]*>/.exec(svg);
    if (!m) return svg;
    const vb = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(m[0]);
    if (!vb) return svg;
    const [x, y, w, h] = vb.slice(1).map(Number);
    const b = Number(/data-fw-bleed="([\d.]+)"/.exec(m[0])?.[1] ?? 0);
    const wIn = /width="([\d.]+)in"/.exec(m[0]), hIn = /height="([\d.]+)in"/.exec(m[0]);
    let open = m[0].replace(vb[0], `viewBox="${x - b} ${y - b} ${w + 2 * b} ${h + 2 * b}"`);
    if (wIn) open = open.replace(wIn[0], `width="${Number(wIn[1]) + (2 * b) / 100}in"`);
    if (hIn) open = open.replace(hIn[0], `height="${Number(hIn[1]) + (2 * b) / 100}in"`);
    const line = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${CUT}" stroke-width="1.5" stroke-dasharray="6 4" vector-effect="non-scaling-stroke" data-fw-cut-line="1"/>`;
    const close = svg.lastIndexOf('</svg>');
    return open + svg.slice(m[0].length, close) + line + svg.slice(close);
  }

  const imgOf = (alt) => (svg) => {
    const img = document.createElement('img');
    img.className = 'label-img';
    img.alt = alt;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return img;
  };

  /**
   * A label with its two views. `show` draws a drawing (default: an <img class="label-img">). Returns the element and
   * `set(svg)` to show another drawing (previews that change as settings change keep the chosen view).
   */
  function views(svg, opts = {}) {
    const show = opts.show || imgOf(opts.alt || 'The label');
    let current = svg, mode = 'bottle';
    const el = document.createElement('div');
    el.className = 'label-views';
    const bar = document.createElement('div');
    bar.className = 'label-views-bar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'How to show the label');
    const stage = document.createElement('div');
    stage.className = 'label-views-stage';
    const legend = document.createElement('p');
    legend.className = 'label-views-legend';
    const swatch = document.createElement('span');
    swatch.className = 'label-views-cut';
    swatch.setAttribute('aria-hidden', 'true');
    legend.append(swatch, document.createTextNode('Outside the line is trimmed: the background runs past the cut so no white edge shows if the cutter drifts.'));
    const buttons = [['bottle', 'On the bottle'], ['print', 'Print file']].map(([id, words]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'label-views-btn';
      b.textContent = words;
      b.dataset.view = id;
      b.addEventListener('click', () => { mode = id; draw(); });
      bar.append(b);
      return b;
    });
    function draw() {
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.view === mode));
      if (!current) { stage.replaceChildren(); legend.hidden = true; return; }
      stage.replaceChildren(show(mode === 'print' ? printView(current) : current));
      legend.hidden = mode !== 'print';
    }
    el.append(bar, stage, legend);
    draw();
    return { el, set(next) { current = next; draw(); }, get mode() { return mode; } };
  }

  window.fwLabel = { views, printView };
})();
