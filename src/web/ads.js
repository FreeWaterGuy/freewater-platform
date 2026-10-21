// FreeWater Ads: the advertiser portal. Results, making an ad by chatting, reviewing it, and billing.
(() => {
  'use strict';
  const fixture = window.__FW_ADS_FIXTURE__; // only in the offline preview
  const root = document.getElementById('root');
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
  const icon = (d) => { const s = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }); for (const p of d.split('|')) s.append(svgEl('path', { d: p })); return s; };
  const I = { target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z|M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z|M12 12h.01', ticket: 'M3 7h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4z|M13 7v12', chart: 'M4 20V10|M10 20V4|M16 20v-7|M22 20H2', plus: 'M12 5v14|M5 12h14', card: 'M3 6h18v12H3z|M3 10h18', clip: 'M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7', send: 'M5 12h14|M13 6l6 6-6 6', back: 'M15 18l-6-6 6-6' };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
  const dollars = (c) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
  const cents = (c) => (c < 100 ? `${c}¢` : dollars(c));
  const num = (n) => n.toLocaleString();
  const sizeName = (s) => (String(s) === '1' ? 'the whole label' : `1/${s} of the label`);
  const svgSrc = (s) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
  // Every shape the ad prints at, size by size, then each box side: what's approved is what prints.
  const everyShape = (p) => h('div', { class: 'stack' },
    ...p.sizes.map((s) => ({ ...s, shapes: s.shapes ?? [{ svg: s.svg, w: 0, h: 0 }] })).map((s) => h('div', {}, h('h3', { text: `${s.label}${s.shapes.length > 1 ? ` · ${s.shapes.length} shapes` : ''}` }),
      s.shapes.length ? h('div', { class: 'sizes' }, s.shapes.map((x) => h('figure', {}, h('img', { src: svgSrc(x.svg), alt: `Your ad at ${s.label}, ${Math.round(x.w)} by ${Math.round(x.h)}` }), h('figcaption', { text: x.w ? `${(x.w / 100).toFixed(1)} × ${(x.h / 100).toFixed(1)} in` : s.label })))) : h('p', { class: 'muted', text: 'This size doesn’t fit on the bottles here, so it won’t print. Pick another size.' }))),
    ...(p.boxFaces?.length ? [h('div', {}, h('h3', { text: 'Box sides' }), h('div', { class: 'sizes' }, p.boxFaces.map((f) => h('figure', {}, h('img', { class: 'box-img', src: svgSrc(f.svg), alt: 'Your ad on a box side' }), h('figcaption', { text: `${(f.w / 40).toFixed(1)} × ${(f.h / 40).toFixed(1)} in` })))))] : []));
  const toastEl = h('div', { class: 'toast', role: 'status' }); document.body.append(toastEl);
  let tt; const toast = (m) => { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove('show'), 2600); };

  const state = { token: store.get('fw_ads_token'), me: null, config: null, path: fixture ? fixture.start : location.pathname + location.search };

  // The second sign-in step: when it's on, sign-in asks for the code from the authenticator app (or a recovery code).
  const withSecondStep = (r) => (!r || !r.secondStep ? Promise.resolve(r) : new Promise((resolve, reject) => {
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', 'Second sign-in step');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:100;padding:16px';
    const card = document.createElement('form');
    card.style.cssText = 'background:#fff;color:#0B0B0B;border-radius:20px;padding:24px;max-width:380px;width:100%;display:flex;flex-direction:column;gap:12px';
    const title = document.createElement('h2'); title.textContent = 'One more step'; title.style.cssText = 'margin:0;font-size:22px';
    const p = document.createElement('p'); p.textContent = 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.'; p.style.margin = '0';
    const input = document.createElement('input'); input.className = 'input code-input'; input.autocomplete = 'one-time-code'; input.setAttribute('aria-label', 'Code from your app'); input.maxLength = 16;
    const err = document.createElement('div'); err.className = 'notice err'; err.hidden = true;
    const ok = document.createElement('button'); ok.className = 'btn wide'; ok.type = 'submit'; ok.textContent = 'Sign in';
    const cancel = document.createElement('button'); cancel.className = 'btn secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.onclick = () => { wrap.remove(); reject(new Error('Sign-in cancelled.')); };
    card.onsubmit = async (e) => { e.preventDefault(); err.hidden = true; ok.disabled = true; try { const out = await api('POST', '/v1/auth/second-step', { challenge: r.challenge, code: input.value.trim() }); wrap.remove(); resolve(out); } catch (x) { err.textContent = x.message; err.hidden = false; ok.disabled = false; } };
    card.append(title, p, input, err, ok, cancel); wrap.append(card); document.body.append(wrap); input.focus();
  }));
  async function api(method, url, body) {
    if (fixture) return fixture.api(method, url, body);
    const res = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { state.token = null; state.me = null; store.set('fw_ads_token', null); }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error?.message || 'Something went wrong. Try again.'); e.status = res.status; e.code = data?.error?.code; throw e; }
    return data;
  }

  /** Upload a file as it is (a video or picture) to the asset store. */
  async function uploadFile(file) {
    if (fixture) return fixture.api('POST', '/v1/assets', { name: file.name, type: file.type });
    const res = await fetch('/v1/assets', { method: 'POST', headers: { 'content-type': file.type, ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) }, body: file });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || 'That file didn’t upload.');
    return data;
  }

  // ---------- routing ----------
  const routes = [
    [/^\/ads\/?$/, overview], [/^\/ads\/new$/, newAd], [/^\/ads\/drafts\/([\w-]+)$/, builder], [/^\/ads\/drafts\/([\w-]+)\/review$/, review],
    // eslint-disable-next-line security/detect-unsafe-regex -- route patterns, anchored and linear; the input is this page's own path
    [/^\/ads\/campaigns\/([\w-]+)\/change$/, changeAd], [/^\/ads\/campaigns\/([\w-]+)\/code$/, codePage], [/^\/ads\/billing$/, billing], [/^\/ads\/studio(?:\?.*)?$/, studioPage], [/^\/ads\/tracking$/, tracking], [/^\/ads\/redeem(?:\/([\w-]+))?$/, redeem], [/^\/ads\/statement$/, statementPage], [/^\/ads\/offers$/, offersPage], [/^\/ads\/campaigns\/([\w-]+)\/report$/, routeReport],
  ];
  let cleanup = null;
  function go(path, replace) { state.path = path; if (!fixture) history[replace ? 'replaceState' : 'pushState'](null, '', path); render(); }
  window.addEventListener('popstate', () => { state.path = location.pathname; render(); });
  const link = (path, attrs, ...kids) => h('a', { href: fixture ? '#' : path, ...attrs, onclick: (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(path); } }, ...kids);
  async function render() {
    if (cleanup) { cleanup(); cleanup = null; }
    if (!(await signedIn())) return;
    // Areas switched off on this server (FW_FEATURES): their pages and menu entries aren't shown.
    if (!state.features) state.features = await api('GET', `/v1/public/features${state.me?.companyId ? `?company=${encodeURIComponent(state.me.companyId)}` : ''}`).catch(() => ({ off: [] }));
    if (!on('offers') && /^\/ads\/offers/.test(state.path)) return go('/ads', true);
    for (const [re, fn] of routes) { const m = re.exec(state.path); if (m) { try { await fn(...m.slice(1)); } catch (e) { shell('', h('div', { class: 'notice err', text: e.message })); } window.scrollTo(0, 0); return; } }
    go('/ads', true);
  }
  const on = (feature) => !(state.features?.off ?? []).includes(feature);
  function shell(active, ...content) {
    const me = state.me;
    root.replaceChildren(h('div', { class: 'shell' },
      h('aside', { class: 'side' },
        h('div', { class: 'logo', 'aria-label': 'FreeWater Ads' }, h('span', { text: 'free' }), h('span', { text: 'water' }), h('small', { text: 'Ads' })),
        h('nav', { 'aria-label': 'Main' },
          link('/ads', { 'aria-current': active === 'overview' ? 'page' : null }, icon(I.chart), 'Overview'),
          !on('ad_chat') ? null : link('/ads/new', { 'aria-current': active === 'new' ? 'page' : null }, icon(I.plus), 'New ad'),
          !on('studio') ? null : link('/ads/studio', { 'aria-current': active === 'studio' ? 'page' : null }, icon(I.plus), 'Ad studio'),
          !on('offers') ? null : link('/ads/offers', { 'aria-current': active === 'offers' ? 'page' : null }, icon(I.ticket), 'Offers'),
          !on('sales_tracking') ? null : link('/ads/tracking', { 'aria-current': active === 'tracking' ? 'page' : null }, icon(I.target), 'Sales tracking'),
          !on('coupons') ? null : link('/ads/redeem', { 'aria-current': active === 'redeem' ? 'page' : null }, icon(I.ticket), 'Check a coupon'),
          !on('advertiser_statements') ? null : link('/ads/statement', { 'aria-current': active === 'statement' ? 'page' : null }, icon(I.chart), 'Statement'),
          !on('advertiser_billing') ? null : link('/ads/billing', { 'aria-current': active === 'billing' ? 'page' : null }, icon(I.card), 'Billing')),
        h('div', { class: 'who' }, h('b', { text: state.business?.name ?? '' }), me?.email || me?.phone || '', h('br'), h('button', { type: 'button', onclick: async () => { try { await api('POST', '/v1/auth/sign-out'); } catch {} state.token = null; state.me = null; state.business = null; store.set('fw_ads_token', null); render(); } }, 'Sign out'))),
      h('main', { class: 'main' }, ...content)));
  }

  // ---------- the ad studio: brand kit, photos, finished designs at every size, custom AR ----------
  async function studioPage() {
    const draftId = new URLSearchParams(state.path.split('?')[1] ?? '').get('draft');
    let data = await api('GET', '/v1/studio');
    let designs = [], made3d = null;
    const out = h('div', { class: 'studio' });
    // eslint-disable-next-line no-unsanitized/property -- our own server-drawn SVG (text escaped, colours and photos validated); the page's CSP blocks inline script
    const inline = (svg) => { const d = h('div', { class: 'art' }); d.innerHTML = svg; return d; }; // our own drawing (it loads your photos from this site); nosemgrep: fw-web-unsafe-html -- our own server-drawn SVG; see the ESLint note above
    const field = (label, control, hint) => { const fid = `s${Math.random().toString(36).slice(2, 8)}`; control.id ||= fid; return h('div', { class: 'field' }, h('label', { for: control.id, text: label }), control, hint ? h('div', { class: 'hint', text: hint }) : null); };
    const upload = async (url, file) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': file.type, authorization: `Bearer ${state.token}` }, body: file });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message || 'That didn’t upload.');
      return body;
    };
    const conn = data.connections;
    const standInNote = [conn.photoLibraries[0]?.standIn ? 'the photo library' : null, conn.imageAi.standIn ? 'the image AI' : null, conn.photoTo3d.standIn ? 'photo-to-3D' : null].filter(Boolean);

    function draw() {
      const k = data.kit;
      // 1. Brand kit
      const name = h('input', { class: 'input', value: k.name, maxlength: 40 });
      const about = h('textarea', { class: 'input', rows: 2, maxlength: 300, placeholder: 'What you sell, where, what makes you different' }); about.value = k.about ?? '';
      const col = (v) => h('input', { type: 'color', value: v, class: 'swatch' });
      const c = k.colors ?? { paper: '#F5F1EA', ink: '#1A1A1A', accent: '#1E7DB8' };
      const paper = col(c.paper), ink = col(c.ink), accent = col(c.accent);
      const type = h('select', { class: 'input' }, [['serif', 'Serif (classic, editorial)'], ['grotesk', 'Grotesk (bold, modern)'], ['condensed', 'Condensed (tall, punchy)'], ['rounded', 'Rounded (friendly)']].map(([v, t]) => h('option', { value: v, text: t, ...(k.type === v ? { selected: true } : {}) })));
      const logoIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
      logoIn.onchange = async () => { const f = logoIn.files[0]; if (!f) return; try { await upload('/v1/studio/logo', f); data = await api('GET', '/v1/studio'); toast('Logo saved'); draw(); } catch (x) { toast(x.message); } };
      const saveKit = async () => { try { data.kit = await api('PATCH', '/v1/studio/kit', { name: name.value, about: about.value, colors: { paper: paper.value, ink: ink.value, accent: accent.value }, type: type.value }); toast('Brand kit saved'); } catch (x) { toast(x.message); } };
      const kit = h('section', { class: 'card stack' }, h('h2', { text: '1. Your brand kit' }), h('p', { class: 'muted', text: 'Set this up once. Every design uses it.' }),
        h('div', { class: 'form' }, field('Name on your ads', name), field('About you', about), field('Type style', type)),
        h('div', { class: 'swatches' }, h('label', {}, paper, ' Background'), h('label', {}, ink, ' Words'), h('label', {}, accent, ' Accent')),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: saveKit }, 'Save brand kit'), logoIn, h('button', { class: 'btn secondary', type: 'button', onclick: () => logoIn.click() }, k.logo ? 'Change logo' : 'Add your logo'), k.logo ? h('img', { class: 'logo-thumb', src: `/assets/${k.logo.asset}.png`, alt: 'Your logo' }) : null));

      // 2. Photos
      const photoIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true });
      photoIn.onchange = async () => { for (const f of [...photoIn.files].slice(0, 10)) { try { await upload('/v1/studio/photos', f); } catch (x) { toast(`${f.name}: ${x.message}`); } } data = await api('GET', '/v1/studio'); draw(); };
      const q = h('input', { class: 'input', placeholder: 'Search photos, like “iced latte on a table”' });
      const results = h('div', { class: 'photo-grid' });
      const search = async () => {
        try {
          const r = await api('GET', `/v1/studio/library?q=${encodeURIComponent(q.value)}`);
          results.replaceChildren(...(r.photos.length ? r.photos.map((p) => h('figure', {}, h('img', { src: p.previewUrl, alt: p.description }), h('figcaption', { text: `${p.credit.name}` }),
            h('button', { class: 'btn small', type: 'button', onclick: async (e) => { e.target.disabled = true; try { await api('POST', '/v1/studio/library', { library: r.library, id: p.id }); data = await api('GET', '/v1/studio'); toast('Added to your photos'); draw(); } catch (x) { toast(x.message); e.target.disabled = false; } } }, 'Use this'))) : [h('p', { class: 'muted', text: 'Nothing found. Try other words.' })]));
        } catch (x) { toast(x.message); }
      };
      const prompt = h('input', { class: 'input', placeholder: 'Describe a picture, like “a smash burger on butcher paper, golden hour”' });
      const shape = h('select', { class: 'input' }, ['4:3', '1:1', '3:4', '16:9'].map((v) => h('option', { value: v, text: v })));
      const generate = async (e) => { e.target.disabled = true; try { await api('POST', '/v1/studio/generate', { prompt: prompt.value, aspect: shape.value }); data = await api('GET', '/v1/studio'); toast('Picture made'); draw(); } catch (x) { toast(x.message); } e.target.disabled = false; };
      const mine = h('div', { class: 'photo-grid' }, k.photos.map((p) => h('figure', {}, h('img', { src: `/assets/${p.asset}.jpg`, alt: '' }), p.credit ? h('figcaption', { text: `${p.credit.name} · ${p.credit.source}` }) : h('figcaption', { text: 'Your photo' }),
        h('button', { class: 'linkish', type: 'button', onclick: async () => { try { await api('DELETE', `/v1/studio/photos/${p.asset}`); data = await api('GET', '/v1/studio'); draw(); } catch (x) { toast(x.message); } } }, 'Remove'))));
      const photos = h('section', { class: 'card stack' }, h('h2', { text: '2. Photos' }), h('p', { class: 'muted', text: 'Your own photos look best. No photos? Use the free photo library, or have the image AI make one. Each photo is cropped around its subject for every size.' }),
        h('div', { class: 'row' }, photoIn, h('button', { class: 'btn', type: 'button', onclick: () => photoIn.click() }, 'Upload photos')),
        k.photos.length ? mine : h('p', { class: 'muted', text: 'No photos yet.' }),
        h('div', { class: 'row' }, q, h('button', { class: 'btn secondary', type: 'button', onclick: search }, 'Search the library')), results,
        h('div', { class: 'row' }, prompt, shape, h('button', { class: 'btn secondary', type: 'button', onclick: generate }, 'Make it with AI')));

      // 3. Designs
      const msg = h('input', { class: 'input', maxlength: 120, placeholder: 'What is this ad for? Like “Our new cold brew is here”' });
      const offer = h('input', { class: 'input', maxlength: 60, placeholder: 'An offer, if any. Like “First cup free”' });
      const where = h('input', { class: 'input', maxlength: 60, placeholder: 'Where, if it helps. Like “South Congress”' });
      const gallery = h('div', { class: 'designs' });
      const showDesigns = async () => {
        gallery.replaceChildren(h('p', { class: 'muted', text: 'Designing…' }));
        const cards = [];
        for (const spec of designs) {
          const pv = await api('POST', '/v1/studio/preview', { spec });
          const use = async (e) => {
            e.target.disabled = true;
            try {
              const id = draftId || (await api('POST', '/v1/ads/drafts', {})).id;
              await api('POST', '/v1/studio/use', { draftId: id, spec });
              if (made3d) await api('POST', '/v1/studio/ar/use', { draftId: id, asset: made3d.asset, alt: made3d.model.alt, title: spec.headline });
              go(`/ads/drafts/${id}`);
            } catch (x) { toast(x.message); e.target.disabled = false; }
          };
          cards.push(h('article', { class: 'design card' }, h('div', { class: 'design-sizes' }, pv.sizes.slice(0, 4).map((s) => h('figure', {}, inline(s.svg), h('figcaption', { text: s.label })))),
            h('details', {}, h('summary', { text: 'On a bottle, and on a box' }), inline(pv.labelSvg), pv.boxFaceSvg ? inline(pv.boxFaceSvg) : null),
            h('button', { class: 'btn', type: 'button', onclick: use }, draftId ? 'Use this design in my ad' : 'Make an ad with this design')));
        }
        gallery.replaceChildren(...cards);
      };
      const designNow = async (e) => { e.target.disabled = true; try { designs = (await api('POST', '/v1/studio/designs', { message: msg.value, offer: offer.value || undefined, where: where.value || undefined })).designs; await showDesigns(); } catch (x) { toast(x.message); gallery.replaceChildren(); } e.target.disabled = false; };
      const designer = h('section', { class: 'card stack' }, h('h2', { text: '3. Designs' }), h('p', { class: 'muted', text: `Say what the ad is for. You get finished designs at every label size, with your photos, colors and type (designer: ${conn.designer === 'claude' ? 'Claude' : 'built-in rules'}).` }),
        h('div', { class: 'form' }, field('The ad is for', msg), field('Offer', offer), field('Where', where)), h('div', {}, h('button', { class: 'btn', type: 'button', onclick: designNow }, 'Design my ad')), gallery);

      // 4. Custom AR
      const arPhoto = h('select', { class: 'input' }, k.photos.map((p, i) => h('option', { value: p.asset, text: `Photo ${i + 1}${p.credit ? ` (${p.credit.source})` : ''}` })));
      const arName = h('input', { class: 'input', maxlength: 60, placeholder: 'What it is, like “Cold brew, 16 oz”' });
      const arH = h('input', { class: 'input', type: 'number', min: 1, max: 300, placeholder: 'Real height in cm (optional)' });
      const arOut = h('div', {});
      const makeAr = async (e) => {
        e.target.disabled = true;
        try {
          made3d = await api('POST', '/v1/studio/ar', { asset: arPhoto.value, name: arName.value || 'Product', ...(arH.value ? { heightCm: Number(arH.value) } : {}) });
          arOut.replaceChildren(h('div', { class: 'notice ok', text: `3D model ready${made3d.standIn ? ' (a stand-in: your photo on a standing card; a full 3D model comes once a photo-to-3D service is connected)' : ''}. Designs you use from here put it on your ad's scan page, in AR at real size.` }), h('a', { href: made3d.glbUrl, class: 'btn secondary small', target: '_blank', rel: 'noopener' }, 'Open the 3D file'));
        } catch (x) { toast(x.message); }
        e.target.disabled = false;
      };
      const ar = h('section', { class: 'card stack' }, h('h2', { text: '4. Custom AR (optional)' }), h('p', { class: 'muted', text: 'Turn a product photo into a 3D model people can put on their table when they scan your ad.' }),
        k.photos.length ? h('div', { class: 'form' }, field('Product photo', arPhoto), field('Name', arName), field('Height', arH)) : h('p', { class: 'muted', text: 'Add a product photo first.' }),
        k.photos.length ? h('div', {}, h('button', { class: 'btn secondary', type: 'button', onclick: makeAr }, 'Make 3D model')) : null, arOut);

      out.replaceChildren(kit, photos, designer, ar);
    }
    shell('studio', h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Ad studio' }), h('p', { text: 'Your brand kit and photos in, finished ads at every size out.' }))),
      standInNote.length ? h('div', { class: 'notice', style: 'margin-bottom:16px', text: `Test mode for ${standInNote.join(', ')}: these use stand-ins until ${state.config.name} connects the real services.` }) : null, out);
    draw();
  }

  // ---------- statement: every bottle, what you bid and what the auction charged ----------
  async function statementPage() {
    const to = new Date(), from = new Date(to.getTime() - 30 * 86_400_000);
    const iso = (d) => d.toISOString().slice(0, 10);
    const fromI = h('input', { class: 'input', type: 'date', value: iso(from) }), toI = h('input', { class: 'input', type: 'date', value: iso(to) });
    const out = h('div', { class: 'stack' });
    const load = async () => {
      try {
        const s = await api('GET', `/v1/ads/statement?from=${fromI.value}&to=${toI.value}`);
        const t = s.totals;
        out.replaceChildren(
          h('div', { class: 'kpis', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' }, [['Bottles', String(t.bottles)], ['Printing', cents(t.paidCents)], ['Scans and AR', cents(t.engagementCents)], ['Sales commission', cents(t.commissionCents)]].map(([k, v]) => h('div', { class: 'kpi' }, h('span', { text: k }), h('b', { text: v })))),
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['When', 'Where', 'Piece', 'Your bid', 'Auction price', 'You paid', 'Why', 'Scans', 'AR', 'Sales'].map((x) => h('th', { text: x })))),
            h('tbody', {}, s.lines.slice(-300).reverse().map((l) => h('tr', {}, h('td', { text: new Date(l.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }), h('td', { text: l.place }), h('td', { text: l.piece }), h('td', { text: l.bidCents == null ? 'set price' : cents(l.bidCents) }), h('td', { text: l.paidLabelCents == null ? '–' : cents(l.paidLabelCents) }), h('td', {}, h('b', { text: cents(l.paidCents) })), h('td', { style: 'font-size:13px', text: l.adjustments.join(', ') || '–' }), h('td', { text: String(l.scans) }), h('td', { text: String(l.arLaunches) }), h('td', { text: String(l.sales) })))))),
          s.fingerprints.length ? h('p', { style: 'margin:0;font-size:13px;color:var(--muted)', text: `Each day’s books fingerprint, to check against the public open books: ${s.fingerprints.map((f) => `${f.date} ${f.fingerprint.slice(0, 12)}…`).join(' · ')}` }) : null);
      } catch (x) { out.replaceChildren(h('div', { class: 'notice err', text: x.message })); }
    };
    const csv = async () => {
      try {
        const res = await fetch(`/v1/ads/statement?from=${fromI.value}&to=${toI.value}&format=csv`, { headers: { authorization: `Bearer ${state.token}` } });
        const blob = await res.blob(); const a = h('a', { href: URL.createObjectURL(blob), download: `statement-${fromI.value}-to-${toI.value}.csv` }); document.body.append(a); a.click(); a.remove();
      } catch (x) { toast(x.message); }
    };
    shell('statement', h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Statement' }), h('p', { text: 'Every bottle you paid for: your bid, what the auction charged and why, and what each one earned you. You pay just enough to beat the next other advertiser’s ad, never more than your bid.' })), h('button', { class: 'btn secondary', type: 'button', onclick: csv }, 'Download spreadsheet')),
      h('div', { class: 'form', style: 'max-width:520px;margin-bottom:16px' }, h('div', { class: 'field' }, h('label', { text: 'From' }), fromI), h('div', { class: 'field' }, h('label', { text: 'To' }), toI)),
      h('div', {}, h('button', { class: 'btn', type: 'button', onclick: load }, 'Show')), out);
    load();
  }

  // ---------- sign in and sign up ----------
  async function signedIn() {
    if (!state.config) state.config = await api('GET', '/v1/public/app-config');
    if (state.token && !state.me) { try { state.me = await api('GET', '/v1/me'); } catch { state.me = null; } }
    if (!state.me) { authScreen(); return false; }
    if (!state.me.advertiserId) { setupScreen(); return false; }
    if (!state.business) { try { state.business = await api('GET', '/v1/ads/advertiser'); } catch {} }
    return true;
  }
  const pitch = () => h('div', { class: 'left' },
    h('div', { class: 'logo' }, h('span', { text: 'free' }), h('span', { text: 'water' }), h('small', { text: 'Ads' })),
    h('div', {}, h('h1', {}, 'Put your brand in ', h('span', { text: 'everyone’s hand.' })),
      h('ul', {}, h('li', { text: 'Your ad prints on free bottles of water, fresh, one at a time.' }), h('li', { text: 'Pay for prints, scans, AR launches and sales. Nothing else.' }), h('li', { text: 'Make the ad by chatting. Review it before it prints.' }))),
    h('p', { style: 'opacity:.6;font-size:13px;margin:0', text: 'Every bottle gives to charity, and the books are open.' }));
  function authScreen() {
    let to = '';
    const right = h('div', { class: 'right' });
    root.replaceChildren(h('div', { class: 'auth' }, pitch(), right));
    const step1 = () => {
      const input = h('input', { class: 'input', id: 'a-email', type: 'email', autocomplete: 'email', placeholder: 'you@yourbusiness.com', value: to });
      const err = h('div', { class: 'notice err', hidden: true });
      right.replaceChildren(h('h2', { style: 'font:700 26px/1.2 var(--display);margin:0', text: 'Sign in or get started' }), h('p', { style: 'margin:0;color:var(--muted)', text: 'We’ll email you a 6-digit code. No password.' }),
        h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); to = input.value.trim(); if (!to) return; err.hidden = true; try { await api('POST', '/v1/auth/start', { companyId: state.config.companyId, channel: 'email', to }); step2(); } catch (x) { err.textContent = x.message; err.hidden = false; } } },
          h('div', { class: 'field' }, h('label', { for: 'a-email', text: 'Work email' }), input), err, h('button', { class: 'btn wide', type: 'submit' }, 'Email me a code')));
      input.focus();
    };
    const step2 = () => {
      const input = h('input', { class: 'input code-input', id: 'a-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', 'aria-label': '6-digit code' });
      const err = h('div', { class: 'notice err', hidden: true });
      right.replaceChildren(h('h2', { style: 'font:700 26px/1.2 var(--display);margin:0', text: 'Check your email' }), h('p', { style: 'margin:0;color:var(--muted)', text: `We sent a code to ${to}.` }),
        h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); err.hidden = true; try { let vk = {}; try { vk = { ...(/^[A-Za-z0-9_-]{8,64}$/.test(localStorage.getItem('fw_viewer') || '') ? { viewerKey: localStorage.getItem('fw_viewer') } : {}) }; } catch {} const r = await withSecondStep(await api('POST', '/v1/auth/verify', { companyId: state.config.companyId, channel: 'email', to, code: input.value.trim(), ...vk })); state.token = r.token; store.set('fw_ads_token', r.token); state.me = null; render(); } catch (x) { err.textContent = x.message; err.hidden = false; } } },
          input, err, h('button', { class: 'btn wide', type: 'submit' }, 'Sign in')),
        h('button', { class: 'btn secondary', type: 'button', onclick: step1 }, 'Use a different email'));
      input.focus();
    };
    step1();
  }
  function setupScreen() {
    const name = h('input', { class: 'input', id: 's-name', placeholder: 'Tito’s Tacos', autocomplete: 'organization' });
    const cat = h('select', { class: 'input', id: 's-cat' }, ['Food and drink', 'Coffee', 'Real estate', 'Fitness', 'Health', 'Retail', 'Pets', 'Events', 'Auto', 'News', 'Services'].map((c) => h('option', { value: c.toLowerCase().replace(/ and /g, '-').replace(/\s+/g, '-'), text: c })));
    const site = h('input', { class: 'input', id: 's-site', placeholder: 'https://', type: 'url', pattern: 'https://.*', title: 'Start with https:// (a secure web address), like https://titostacos.com', 'aria-describedby': 's-site-hint' });
    const siteHint = h('p', { class: 'hint', id: 's-site-hint', style: 'margin:4px 0 0;font-size:13px;color:var(--muted)', text: 'Must start with https://' });
    // The server checks the fields too; turn its technical wording into plain words.
    const plain = (x) => {
      if (x.code !== 'invalid_request') return x.message;
      if (/website/i.test(x.message)) return 'Your website needs to start with https:// (a secure address), like https://titostacos.com.';
      if (/business ?name/i.test(x.message)) return 'Give your business name (2 to 60 characters).';
      return 'Something in the form isn’t right. Check it and try again.';
    };
    const err = h('div', { class: 'notice err', hidden: true });
    root.replaceChildren(h('div', { class: 'auth' }, pitch(), h('div', { class: 'right' },
      h('h2', { style: 'font:700 26px/1.2 var(--display);margin:0', text: 'Tell us about your business' }),
      h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => {
        e.preventDefault(); err.hidden = true;
        try { await api('POST', '/v1/advertisers', { businessName: name.value.trim(), category: cat.value === 'food-drink' ? 'food' : cat.value, ...(site.value.trim() ? { website: site.value.trim() } : {}) }); state.me = null; go('/ads/new'); }
        catch (x) { err.textContent = plain(x); err.hidden = false; }
      } }, h('div', { class: 'field' }, h('label', { for: 's-name', text: 'Business name' }), name), h('div', { class: 'field' }, h('label', { for: 's-cat', text: 'What you do' }), cat), h('div', { class: 'field' }, h('label', { for: 's-site', text: 'Website (optional)' }), site, siteHint), err, h('button', { class: 'btn wide', type: 'submit' }, 'Start making my ad')))));
    name.focus();
  }

  // ---------- sales tracking: the tag, server reporting, and what it found ----------
  // ---------- brand offers ----------
  async function offersPage() {
    const list = await api('GET', '/v1/offers');
    const f = {};
    const inp = (id, o = {}) => (f[id] = h('input', { class: 'input', id: `of-${id}`, ...o }));
    const fld = (id, label, el, hint) => h('div', { class: 'field' }, h('label', { for: `of-${id}`, text: label }), el, hint ? h('small', { style: 'color:var(--muted)', text: hint }) : null);
    let pctBox, offBox;
    const kind = h('select', { class: 'input', id: 'of-kind' }, [['free', 'Free'], ['percent_off', 'A percent off'], ['cents_off', 'An amount off']].map(([v, l]) => h('option', { value: v, text: l })));
    const found = h('div', { style: 'font-size:14px;color:var(--muted)' });
    inp('barcodes', { placeholder: '040000004325', spellcheck: 'false' });
    f.barcodes.addEventListener('change', async () => {
      const codes = f.barcodes.value.split(/[\s,]+/).filter(Boolean);
      const names = await Promise.all(codes.map((c) => api('GET', `/v1/products/${encodeURIComponent(c)}`).then((p) => `${c}: ${p.name ? `${p.brand ? `${p.brand} ` : ''}${p.name}` : 'not found (it still works if the barcode is right)'}`).catch((x) => `${c}: ${x.message}`)));
      found.textContent = names.join(' · ');
    });
    const $ = (id) => Math.round(Number(f[id].value || 0) * 100);
    const form = h('form', { class: 'panel', style: 'gap:12px', onsubmit: async (e) => {
      e.preventDefault();
      const reward = { kind: kind.value, upToCents: $('upto'), ...(kind.value === 'percent_off' ? { percent: Number(f.percent.value) } : {}), ...(kind.value === 'cents_off' ? { cents: $('off') } : {}), ...($('youget') ? { youGetCents: $('youget') } : {}), ...($('cause') ? { causeCents: $('cause') } : {}) };
      try {
        const o = await api('POST', '/v1/offers', { title: f.title.value.trim(), ...(f.details.value.trim() ? { details: f.details.value.trim() } : {}), products: f.barcodes.value.split(/[\s,]+/).filter(Boolean), retailers: f.stores.value.split(',').map((x) => x.trim()).filter(Boolean), reward, pointsCost: Number(f.points.value || 0), perPerson: Number(f.per.value || 1), maxClaims: Number(f.max.value || 1) });
        await api('POST', `/v1/offers/${o.id}/submit`);
        toast('Sent to FreeWater to approve.'); go('/ads/offers');
      } catch (x) { toast(x.message); }
    } },
      h('h2', { class: 'section', text: 'Make an offer' }),
      h('p', { style: 'margin:0;color:var(--muted)', text: 'People trade points for it, buy your product at any store you list, and send a photo of the receipt. You pay back what they spent (and anything extra) from your reserve. FreeWater approves each offer.' }),
      fld('title', 'What it is', inp('title', { maxlength: 80, placeholder: 'A free king-size Snickers' })),
      fld('barcodes', 'The exact products (barcode numbers)', f.barcodes, 'The number under the UPC or EAN barcode. Several? Separate them with commas.'), found,
      fld('stores', 'Where', inp('stores', { placeholder: 'Walmart, Target (or “any”)' })),
      fld('kind', 'The deal', kind), (pctBox = fld('percent', 'Percent off', inp('percent', { type: 'number', min: 1, max: 100, placeholder: '50' }))), (offBox = fld('off', 'Amount off ($)', inp('off', { type: 'number', min: 0, step: '0.01' }))),
      fld('upto', 'Pay back up to ($)', inp('upto', { type: 'number', min: 0, step: '0.01', value: '3.00' }), 'The most paid back for the product itself.'),
      fld('youget', 'Plus, to the person ($)', inp('youget', { type: 'number', min: 0, step: '0.01', placeholder: '0.25' }), 'Optional: makes it negatively priced.'),
      fld('cause', 'Plus, to the cause ($)', inp('cause', { type: 'number', min: 0, step: '0.01', placeholder: '0.10' }), `Optional: goes to ${state.me?.company?.cause ?? 'FreeWater’s cause'}.`),
      fld('points', 'Points it costs', inp('points', { type: 'number', min: 0, value: 100 })), fld('per', 'Each person, up to', inp('per', { type: 'number', min: 1, value: 1 })), fld('max', 'In all, up to', inp('max', { type: 'number', min: 1, value: 1000 })),
      fld('details', 'Anything else (optional)', inp('details', { maxlength: 500 })),
      h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Send for approval')));
    const showDeal = () => { pctBox.hidden = kind.value !== 'percent_off'; offBox.hidden = kind.value !== 'cents_off'; };
    kind.addEventListener('change', showDeal); showDeal();
    const status = { draft: 'Draft', pending: 'Waiting for FreeWater', live: 'Live', paused: 'Paused' };
    shell('offers',
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Offers' }), h('p', { text: 'Free, cheaper or negatively priced: your product at any store, paid for from your reserve.' }))),
      list.length ? h('div', { class: 'cards', style: 'margin-bottom:24px' }, list.map((o) => h('div', { class: 'panel', style: 'gap:6px' }, h('b', { text: o.title }), h('span', { text: o.deal }), h('span', { style: 'color:var(--muted)', text: `${status[o.status] ?? o.status} · ${o.claimed} claimed · ${o.left} left` }),
        o.status === 'live' ? h('div', {}, h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { await api('POST', `/v1/offers/${o.id}/pause`); toast('Paused.'); go('/ads/offers'); } catch (x) { toast(x.message); } } }, 'Pause')) : null))) : h('div', { class: 'empty', text: 'No offers yet.' }),
      h('div', { class: 'review', style: 'max-width:720px' }, form));
  }

  async function tracking() {
    const t = await api('GET', '/v1/ads/tracking');
    const reach = await api('GET', '/v1/ads/reach').catch(() => null);
    const s = t.summary;
    const copyBtn = (text) => h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select it and copy it'); } } }, 'Copy');
    const codeBox = (text) => h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, h('pre', { class: 'snippet', text }), h('div', {}, copyBtn(text)));
    const domains = h('input', { class: 'input', id: 't-domains', value: t.domains.join(', '), placeholder: 'joesburgers.com, order.joesburgers.com' });
    const kpi = (label, value, sub, dark) => h('div', { class: `kpi${dark ? ' dark' : ''}` }, h('span', { text: label }), h('b', { text: value }), sub ? h('small', { text: sub }) : null);
    shell('tracking',
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Sales tracking' }), h('p', { text: `Every sale that came from your ads, matched to the exact bottle. Last 30 days.` }))),
      h('div', { class: 'kpis' },
        kpi('Taps on your links', num(s.clicks), 'each gets its own click id; taps are never billed', true),
        kpi('Sales from bottles', num(s.sales.count), `${s.sales.bySource.tag} website · ${s.sales.bySource.server} your server · ${s.sales.bySource.coupon} at the counter`),
        kpi('Those sales', dollars(s.sales.valueCents), 'what customers spent'),
        kpi('Commission', dollars(s.sales.commissionCents), 'on confirmed sales only; on your invoice'),
        kpi('Sales from AR', num(s.sales.fromAr?.count ?? 0), `${dollars(s.sales.fromAr?.valueCents ?? 0)} bought from the buy button inside AR`),
        kpi('Coupons used', `${num(s.coupons.redeemed)}/${num(s.coupons.issued)}`, 'used / given out'),
        s.unverified && s.unverified.count ? kpi('Waiting for your server', num(s.unverified.count), `${dollars(s.unverified.valueCents)} reported by your website, not billed until your server confirms`) : null),
      h('div', { class: 'review', style: 'max-width:900px' },
        h('section', { class: 'panel', style: 'gap:10px' }, h('h2', { class: 'section', text: '1. Add our tag to your website' }),
          h('p', { style: 'margin:0', text: 'Put this on every page, just before </head>. It remembers when someone arrived from one of your bottles.' }), codeBox(t.install.everyPage),
          h('p', { style: 'margin:0', text: 'On your order confirmation page, report the sale with your order number and the amount:' }), codeBox(t.install.orderConfirmation),
          h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: `It only reports sales from people who came from a bottle in the last ${t.clickWindowDays} days, or who used one of your FreeWater coupons. Nothing about your other customers is sent. Sales the tag reports show here as unverified and aren’t billed until your server confirms them (below) or the coupon is used at the counter.` })),
        h('section', { class: 'panel', style: 'gap:10px' }, h('h2', { class: 'section', text: '2. Say which websites are yours' }),
          h('form', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end', onsubmit: async (e) => { e.preventDefault(); try { await api('POST', '/v1/ads/tracking/domains', { domains: domains.value.split(/[\s,]+/).filter(Boolean) }); toast('Saved. Your tag now reports from these sites.'); } catch (x) { toast(x.message); } } },
            h('div', { class: 'field', style: 'flex:1;min-width:240px' }, h('label', { for: 't-domains', text: 'Your websites' }), domains), h('button', { class: 'btn', type: 'submit' }, 'Save')),
          h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: 'Sales reported from anywhere else are refused, so nobody can report sales in your name.' })),
        h('section', { class: 'panel', style: 'gap:10px' }, h('h2', { class: 'section', text: 'Or report sales from your server' }),
          h('p', { style: 'margin:0', text: 'Send the fwclid your site received (or the coupon code), your order number and the amount. Ask us for a server key. This also confirms a sale your tag reported: only confirmed sales are billed.' }),
          codeBox(`curl ${location.origin}/v1/conversions \\\n  -H "Authorization: Bearer YOUR_SERVER_KEY" -H "Content-Type: application/json" \\\n  -d '{ "fwclid": "FWC…", "orderId": "A-10442", "valueCents": 1250 }'`)),
        h('section', { class: 'panel', style: 'gap:10px' }, h('h2', { class: 'section', text: '3. At the counter' }),
          h('p', { style: 'margin:0', text: 'Each customer gets their own one-time coupon with a code to scan. Scan it with your phone’s camera, or type it in. You’ll see at once if it’s real and unused, and screenshots can’t be used twice.' }),
          h('div', {}, link('/ads/redeem', { class: 'btn' }, 'Check a coupon'))),
        reach && reach.printedForPeople ? h('section', { class: 'panel', style: 'gap:10px' }, h('h2', { class: 'section', text: 'Right ads, right hands' }),
          h('p', { style: 'margin:0', text: `Your ads that target people were printed on ${num(reach.printedForPeople)} bottles for someone who fits. ${num(reach.handedOver)} were handed to that person at a machine or their door, and ${num(reach.confirmed)} were then first opened by that same person${reach.confirmedShare !== null ? ` (${Math.round(reach.confirmedShare * 100)}% of those scanned)` : ''}. ${num(reach.passedOn)} were passed to someone else first.` }),
          reach.chosenBecause.length ? h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: `Chosen because: ${reach.chosenBecause.map((r) => `${r.reason} (${num(r.bottles)})`).join(', ')}.` }) : null) : null,
        s.recent.length ? h('section', { class: 'panel', style: 'gap:10px' }, h('h2', { class: 'section', text: 'Recent sales from bottles' }),
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['When', 'Order', 'How', 'Amount', 'Commission'].map((x) => h('th', { text: x })))),
            h('tbody', {}, s.recent.map((c) => h('tr', {}, h('td', { text: new Date(c.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }), h('td', { text: c.orderId }), h('td', { text: { tag: 'Website', server: 'Your server', coupon: 'Coupon' }[c.source] }), h('td', { text: dollars(c.valueCents) }), h('td', { text: c.refunded ? 'Refunded' : dollars(c.commissionCents) }))))))) : null));
  }

  // ---------- checking and using a coupon at the counter ----------
  async function redeem(code) {
    if (!code) {
      const input = h('input', { class: 'input code-input', id: 'r-code', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'BOTTLE2X-7F3A9Q', style: 'letter-spacing:.06em' });
      shell('redeem', h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Check a coupon' }), h('p', { text: 'Scan the code on the customer’s phone with your camera, or type it here.' }))),
        h('form', { class: 'review', style: 'max-width:480px', onsubmit: (e) => { e.preventDefault(); const c = input.value.trim().toUpperCase(); if (c) go(`/ads/redeem/${encodeURIComponent(c)}`); } }, h('div', { class: 'field' }, h('label', { for: 'r-code', text: 'Coupon code' }), input), h('button', { class: 'btn wide', type: 'submit' }, 'Check it')));
      input.focus();
      return;
    }
    let c;
    try { c = await api('GET', `/v1/coupons/${encodeURIComponent(code)}`); }
    catch (x) { shell('redeem', h('div', { class: 'review', style: 'max-width:520px' }, h('div', { class: 'verdict bad' }, h('b', { text: 'Not valid' }), h('span', { text: x.message })), link('/ads/redeem', { class: 'btn secondary' }, 'Check another'))); return; }
    const amount = h('input', { class: 'input', id: 'r-amount', inputmode: 'decimal', placeholder: '12.50' });
    const order = h('input', { class: 'input', id: 'r-order', placeholder: 'Optional' });
    const box = h('div', { class: 'review', style: 'max-width:520px' });
    const show = (cc, done) => box.replaceChildren(
      cc.status === 'valid' ? h('div', { class: 'verdict ok' }, h('b', { text: 'Valid' }), h('span', { text: 'Real, and not used yet.' })) : h('div', { class: 'verdict bad' }, h('b', { text: done ? 'Done' : 'Already used' }), h('span', { text: done ? `Credited${cc.valueCents ? `: ${dollars(cc.valueCents)}` : ''}. It can’t be used again.` : `Used ${new Date(cc.usedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Don’t accept it again.` })),
      h('div', { class: 'facts' }, h('div', {}, h('span', { text: 'Offer' }), h('b', { text: cc.headline || '' })), h('div', {}, h('span', { text: 'Code' }), h('b', { text: cc.code })), h('div', {}, h('span', { text: 'From' }), h('b', { text: cc.from })), h('div', {}, h('span', { text: 'Given' }), h('b', { text: new Date(cc.issuedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }))),
      cc.status === 'valid' ? h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => {
        e.preventDefault();
        const v = Math.round(Number(String(amount.value).replace(/[^0-9.]/g, '')) * 100);
        if (!Number.isFinite(v) || v < 0) return toast('Type the sale amount, like 12.50');
        try { const r = await api('POST', `/v1/coupons/${encodeURIComponent(cc.code)}/redeem`, { valueCents: v, ...(order.value.trim() ? { orderId: order.value.trim() } : {}) }); show(r, true); } catch (x) { toast(x.message); }
      } }, h('div', { class: 'field' }, h('label', { for: 'r-amount', text: 'Sale amount ($)' }), amount), h('div', { class: 'field' }, h('label', { for: 'r-order', text: 'Order or receipt number' }), order), h('button', { class: 'btn wide', type: 'submit' }, 'Use this coupon')) : null,
      link('/ads/redeem', { class: 'btn secondary' }, 'Check another'));
    show(c, false);
    shell('redeem', h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Check a coupon' }))), box);
  }

  // ---------- the code, its versions, AI, and who it's for ----------
  const readFile = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error('That file couldn’t be read.'));
    if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) { r.onload = () => res(String(r.result)); r.readAsText(file); }
    else if (/^image\/(png|jpeg|webp)$/.test(file.type)) { r.onload = () => res(String(r.result)); r.readAsDataURL(file); }
    else rej(new Error('Use an SVG, PNG, JPEG or WebP file.'));
  });
  const SCANNERS = [['', 'Anyone'], ['first', 'The first person to scan the bottle'], ['passed_on', 'Someone the bottle was passed to'], ['new_to_advertiser', 'People new to you'], ['returning', 'People who’ve scanned you before']];
  const DAYPARTS = [['morning', 'Morning'], ['afternoon', 'Afternoon'], ['evening', 'Evening'], ['night', 'Night']];
  async function codePage(id) {
    const c = await api('GET', `/v1/campaigns/${id}/codes`);
    const d = { qr: { mode: c.qr.mode, staticUrl: c.qr.staticUrl ?? '', bottleRef: c.qr.bottleRef, color: c.qr.color ?? '' }, logo: undefined, variants: c.variants.map(({ forWhom, ...v }) => v), personalize: { ...c.personalize }, afterEnd: c.afterEnd, targeting: structuredClone(c.targeting) };
    const field = (label, control, hint) => { const fid = `c${Math.random().toString(36).slice(2, 8)}`; control.id ||= fid; return h('div', { class: 'field' }, h('label', { for: control.id, text: label }), control, hint ? h('div', { class: 'hint', text: hint }) : null); };
    const check = (label, on, set, hint) => { const b = h('input', { type: 'checkbox' }); b.checked = !!on; b.addEventListener('change', () => set(b.checked)); return h('label', { class: 'switch' }, b, h('div', {}, h('b', { text: label }), hint ? h('span', { text: hint }) : null)); };

    // 1. The code.
    const qrImg = h('img', { alt: 'Your code', style: 'width:180px;height:180px' });
    const qrNote = h('p', { style: 'margin:0;color:var(--muted);font-size:14px' });
    const refreshQr = async () => { try { const r = await api('POST', '/v1/qr/preview', { ...(d.logo ? { logo: d.logo } : {}), ...(d.qr.color ? { color: d.qr.color } : {}) }); qrImg.src = svgSrc(r.svg); qrNote.textContent = r.note ?? (c.qr.hasLogo && d.logo === undefined ? 'Your logo is saved. Upload another to change it.' : `The code still reads with ${r.damageTolerance.plain}% of it damaged.`); } catch (x) { qrNote.textContent = x.message; } };
    const staticUrl = h('input', { class: 'input', type: 'url', placeholder: 'https://yourbusiness.com/menu', value: d.qr.staticUrl });
    staticUrl.addEventListener('input', () => { d.qr.staticUrl = staticUrl.value.trim(); });
    const staticBox = h('div', { class: 'stack', hidden: d.qr.mode !== 'static' }, field('Where the code goes', staticUrl), check('Add the bottle’s reference to the address', d.qr.bottleRef, (v) => { d.qr.bottleRef = v; }, 'So our tag on your site can still match a sale to the exact bottle.'));
    const modes = h('div', { class: 'radio-cards', role: 'radiogroup', 'aria-label': 'Kind of code' }, [['dynamic', 'Dynamic (recommended)', 'Every scan reaches us first: counted, matched to the bottle, and decided at that moment, so each person can get a different call to action and you can change it after printing.'], ['static', 'Static', c.allowed.static ? 'Straight to your website, nothing in between. No scan counts and no changing it once printed.' : 'Not offered by this company.']].map(([v, t, desc]) => {
      const r = h('input', { type: 'radio', name: 'qr-mode', value: v, disabled: v === 'static' && !c.allowed.static }); r.checked = d.qr.mode === v;
      r.addEventListener('change', () => { d.qr.mode = v; staticBox.hidden = v !== 'static'; });
      return h('label', {}, r, h('b', { text: t }), h('span', { text: desc }));
    }));
    const upload = h('input', { type: 'file', accept: '.svg,image/svg+xml,image/png,image/jpeg,image/webp', 'aria-label': 'Upload your logo', hidden: true });
    upload.addEventListener('change', async () => { const f = upload.files?.[0]; if (!f) return; try { d.logo = await readFile(f); refreshQr(); } catch (x) { toast(x.message); } });
    const color = h('input', { class: 'input', placeholder: '#000000', maxlength: 7, value: d.qr.color, style: 'max-width:140px' });
    color.addEventListener('change', () => { d.qr.color = color.value.trim(); refreshQr(); });

    // 0. The ad people see first, what it offers (the number line), and "Show me more".
    d.firstSeen = c.firstSeen ? { ...c.firstSeen } : null;
    d.socialProof = c.socialProof;
    d.more = { videos: [...c.more.videos], approveFirst: c.more.approveFirst };
    d.offering = c.offering ? { ...c.offering } : null;
    const adPreview = h('div', { class: 'ad-preview' });
    const drawAd = () => adPreview.replaceChildren(d.firstSeen ? (d.firstSeen.kind === 'video' ? h('video', { src: d.firstSeen.url, controls: true, muted: true, playsinline: true, style: 'width:100%;max-height:360px;border-radius:12px;background:#000' }) : h('img', { src: d.firstSeen.url, alt: d.firstSeen.alt, style: 'width:100%;max-height:360px;object-fit:cover;border-radius:12px' })) : h('div', { class: 'empty', text: 'No ad uploaded yet: people see your page straight away.' }));
    drawAd();
    const adFile = h('input', { type: 'file', accept: 'video/mp4,image/png,image/jpeg,image/webp', hidden: true, 'aria-label': 'Upload your ad' });
    const adAlt = h('input', { class: 'input', maxlength: 200, placeholder: 'Joe’s double stack, sizzling on the grill', value: d.firstSeen?.alt ?? '' });
    adAlt.addEventListener('input', () => { if (d.firstSeen) d.firstSeen.alt = adAlt.value.trim() || 'Your ad'; });
    adFile.addEventListener('change', async () => {
      const f = adFile.files?.[0]; if (!f) return;
      try { toast('Uploading…'); const a = await uploadFile(f); d.firstSeen = { kind: f.type.startsWith('video/') ? 'video' : 'image', url: a.url, alt: adAlt.value.trim() || `${state.business?.name ?? 'Our'} ad` }; drawAd(); toast('Uploaded. Save to use it.'); } catch (x) { toast(x.message); }
    });
    const money = (v) => h('input', { class: 'input', inputmode: 'decimal', value: v ? (v / 100).toFixed(2) : '', placeholder: '0.00', style: 'max-width:150px' });
    const o = d.offering ?? { description: '', priceCents: 0 };
    const oDesc = h('input', { class: 'input', maxlength: 300, placeholder: 'A double stack burger', value: o.description ?? '' });
    const oPrice = money(o.priceCents), oDon = money(o.donationCents), oPay = money(o.paymentCents);
    const oCause = h('input', { class: 'input', maxlength: 80, placeholder: 'Who the donation goes to', value: o.cause ?? '' });
    const oPeer = h('input', { type: 'checkbox' }); oPeer.checked = !!o.peerToPeer;
    const oCond = h('input', { class: 'input', maxlength: 200, placeholder: 'Sign up, watch a video… (leave empty if nothing)', value: (o.conditions ?? []).join(', ') });
    const oOut = h('div', { class: 'nl-out' });
    const readOffering = () => {
      const c2 = (i) => Math.round(Number(i.value || 0) * 100);
      return oDesc.value.trim().length >= 3 ? { description: oDesc.value.trim(), priceCents: c2(oPrice), ...(c2(oDon) ? { donationCents: c2(oDon) } : {}), ...(c2(oPay) ? { paymentCents: c2(oPay) } : {}), ...(oCause.value.trim() ? { cause: oCause.value.trim() } : {}), ...(oPeer.checked ? { peerToPeer: true } : {}), ...(oCond.value.trim() ? { conditions: oCond.value.split(',').map((x) => x.trim()).filter((x) => x.length >= 2).slice(0, 5) } : {}) } : null;
    };
    const SYS = { market: 'For sale', sharing: 'Sharing economy', free_outside: 'Free, paid from outside', free_ad: 'Free, paid by ads', giving: 'Giving economy (better than free)', public: 'Public' };
    const POS = { for_sale: 'For sale: people pay', free: 'Free', negatively_priced: 'Better than free: value goes back' };
    const showPlacement = async () => {
      try {
        const r = await api('POST', '/v1/numberline/place', { subject: `offering:${id}` });
        const p = r.placement;
        oOut.replaceChildren(h('div', { class: 'nl-line', 'aria-hidden': 'true' }, h('span', { text: 'For sale' }), h('i', { class: `nl-mark nl-${p.position}` }), h('span', { text: 'Free' }), h('span', { text: 'Better than free' })),
          h('b', { text: POS[p.position] }), h('div', { class: 'meta', text: p.systems.map((s) => `${SYS[s.system] ?? s.system}${p.systems.length > 1 ? ` ${Math.round(s.share * 100)}%` : ''}`).join(' · ') }),
          h('ul', { class: 'nl-why' }, p.reasons.map((x) => h('li', { text: x }))), h('div', { class: 'meta', text: `Placed by ${r.by === 'rules' ? 'the rules' : `the number-line agent (${r.by})`}${r.status === 'needs_declaration' ? ' · say what it costs above so it’s placed exactly' : ''}` }));
      } catch (x) { oOut.textContent = x.message; }
    };
    const styles = [['motion', 'Motion graphics', 'Made instantly from your own words, colors and pictures, cut for each moment.'], ['animated', 'Animated (cartoon)', 'Made by a video model ahead of time, for each kind of moment.'], ['live_action', 'Live action', 'Made by a video model ahead of time, for each kind of moment.']];
    const styleBoxes = styles.map(([v, t, desc]) => { const b = h('input', { type: 'checkbox', value: v, disabled: !c.more.canMake.includes(v) }); b.checked = d.more.videos.includes(v); b.addEventListener('change', () => { d.more.videos = styleBoxes.filter(([x]) => x.checked).map(([x]) => x.value); }); return [b, h('label', { class: 'switch' }, b, h('div', {}, h('b', { text: t }), h('span', { text: c.more.canMake.includes(v) ? desc : `${desc} Not set up on this platform yet.` })))]; });
    const vidList = h('div', { class: 'stack' });
    const learn = h('div', { class: 'kpis', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' });
    const drawVideos = async () => {
      try {
        const [vids, l] = await Promise.all([api('GET', `/v1/campaigns/${id}/videos`), api('GET', `/v1/campaigns/${id}/learning`)]);
        learn.replaceChildren(...[['Watched your ad to the end', l.ad.watchedToEnd == null ? '–' : `${l.ad.watchedToEnd}%`], ['Asked for more', l.askedForMore == null ? '–' : `${l.askedForMore}%`], ['Passed it on', l.passedItOn == null ? '–' : `${l.passedItOn}%`], ['Tapped your offer', l.tappedOffer == null ? '–' : `${l.tappedOffer}%`]].map(([k, v]) => h('div', { class: 'kpi' }, h('span', { text: k }), h('b', { text: v }))));
        const SEG = (s) => { const [dp, who, cust, int] = s.split('|'); return `${dp}, ${who === 'passed' ? 'passed on by a friend' : 'first to scan'}, ${cust === 'new' ? 'new to you' : 'returning'}${int !== '-' ? `, likes ${int}` : ''}`; };
        vidList.replaceChildren(...(vids.length ? vids.slice(0, 20).map((v) => h('div', { class: 'version' },
          h('div', {}, h('b', { text: `${styles.find(([k]) => k === v.style)?.[1] ?? v.style} · ${SEG(v.segment)}` }), h('div', { class: 'meta', text: v.status !== 'ready' ? (v.status === 'making' ? 'Being made…' : `Couldn’t be made: ${v.error ?? ''}`) : `${v.views} views · ${v.watchedToEnd ?? 0}% to the end · ${v.tapped ?? 0}% tapped · ${v.review === 'pending' ? 'waiting for your OK' : v.review}` })),
          v.status === 'ready' && v.review !== 'approved' && v.style !== 'motion' ? h('div', { class: 'toolbar' }, v.url ? h('a', { class: 'btn small secondary', href: v.url, target: '_blank', rel: 'noopener' }, 'Watch') : null, h('button', { class: 'btn small', type: 'button', onclick: async () => { await api('POST', `/v1/campaigns/${id}/videos/${v.id}/review`, { approve: true }); drawVideos(); } }, 'Approve'), h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { await api('POST', `/v1/campaigns/${id}/videos/${v.id}/review`, { approve: false }); drawVideos(); } }, 'Turn down')) : null)) : [h('div', { class: 'empty', text: 'None yet. They’re made the first time someone asks to see more.' })]));
      } catch (x) { vidList.textContent = x.message; }
    };
    drawVideos();
    showPlacement();
    const firstBox = h('section', { class: 'panel', style: 'gap:12px' }, h('h2', { class: 'section', text: 'Your ad: what people see first' }),
      h('p', { style: 'margin:0', text: 'The first thing anyone sees after scanning your code, whatever size your piece of the label is (even a tenth). Then your AR, your offer and your buttons. Nothing else comes in between.' }),
      adPreview, h('div', { class: 'toolbar' }, h('button', { class: 'btn secondary', type: 'button', onclick: () => adFile.click() }, d.firstSeen ? 'Change your ad' : 'Upload your ad (video or picture)'), d.firstSeen ? h('button', { class: 'btn small secondary', type: 'button', onclick: () => { d.firstSeen = null; drawAd(); } }, 'Remove') : null, adFile),
      field('Describe it (for people who can’t see it)', adAlt),
      check('Show how many people bought', d.socialProof, (v) => { d.socialProof = v; }, 'Like “12 people bought from this very bottle”, so people pass it on and it sells again.'));
    const offerBox = h('section', { class: 'panel', style: 'gap:12px' }, h('h2', { class: 'section', text: 'What your ad offers' }),
      h('p', { style: 'margin:0', text: 'So every sale and scan is sorted right from the start: what people pay for what you advertise (0 if it’s free), and anything that goes back to them or a cause.' }),
      h('div', { class: 'form' }, field('What it is', oDesc), field('What people pay ($)', oPrice, '0 for something free, like a free download.'), field('Paid back to the person ($)', oPay, 'If you pay people to use it.'), field('Donated for them ($)', oDon), field('To which cause', oCause), field('Anything they must do first', oCond)),
      h('label', { class: 'switch' }, oPeer, h('div', {}, h('b', { text: 'One person renting something idle to another' }), h('span', { text: 'A spare room, a seat in a car, a tool, an hour of time: the sharing economy.' }))),
      h('div', {}, h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { const off = readOffering(); if (!off) { toast('Say what it is first.'); return; } try { await api('PATCH', `/v1/campaigns/${id}/codes`, { offering: off }); showPlacement(); } catch (x) { toast(x.message); } } }, 'Place it on the number line')),
      oOut);
    const moreBox = h('section', { class: 'panel', style: 'gap:12px' }, h('h2', { class: 'section', text: 'Show me more' }),
      h('p', { style: 'margin:0', text: 'Only if someone taps “Show me more” after your ad: a short video made for their moment (morning or night, passed on by a friend, new or returning, what they like). Every view teaches it which cut works best.' }),
      ...styleBoxes.map(([, l]) => l),
      check('I approve footage before anyone sees it', d.more.approveFirst, (v) => { d.more.approveFirst = v; }, 'Motion graphics use only your own approved words and pictures, so they don’t need it.'),
      learn, vidList);

    // 2. Versions of the call to action.
    const textFields = Object.entries(c.experienceConfig).filter(([k, v]) => typeof v === 'string' && !/url$/i.test(k) && !/^#/.test(v));
    const linkLabel = c.experienceConfig.link?.label;
    const vlist = h('div', { class: 'stack' });
    const drawVersions = () => vlist.replaceChildren(...(d.variants.length ? d.variants.map((v, i) => h('div', { class: 'version' },
      h('div', {}, h('b', { text: v.name }), h('div', { class: 'meta', text: `For ${describe(v.when)} · ${Object.values(v.experienceConfig).filter((x) => typeof x === 'string' && !/^https?:/.test(x)).slice(0, 2).join(' · ')}` })),
      h('div', { class: 'toolbar' }, i > 0 ? h('button', { class: 'btn small secondary', type: 'button', onclick: () => { [d.variants[i - 1], d.variants[i]] = [d.variants[i], d.variants[i - 1]]; drawVersions(); } }, 'Move up') : null,
        h('button', { class: 'btn small secondary', type: 'button', onclick: () => { d.variants.splice(i, 1); drawVersions(); } }, 'Remove')))) : [h('div', { class: 'empty', text: 'Just one version so far: everyone sees the same thing.' })]));
    const describe = (w) => { if (!w) return 'anyone'; const out = []; if (w.scanner) out.push(SCANNERS.find(([k]) => k === w.scanner)[1].toLowerCase()); if (w.dayparts?.length) out.push(`in the ${w.dayparts.join(' or ')}`); if (w.interestsAny?.length) out.push(`who like ${w.interestsAny.join(' or ')}`); if (w.keptMinutes) out.push(`bottles kept ${w.keptMinutes}+ min`); return out.join(', ') || 'anyone'; };
    drawVersions();
    const vName = h('input', { class: 'input', placeholder: 'Passed-on bottles', maxlength: 60 });
    const vWho = h('select', { class: 'input' }, SCANNERS.map(([v, l]) => h('option', { value: v, text: l })));
    const vParts = DAYPARTS.map(([v, l]) => { const b = h('input', { type: 'checkbox', value: v }); return [b, h('label', { class: 'chip-check' }, b, ` ${l}`)]; });
    const vInterests = h('input', { class: 'input', placeholder: 'coffee, running' });
    const vTexts = textFields.map(([k, v]) => [k, h('input', { class: 'input', value: v, maxlength: 300 })]);
    const vLink = linkLabel ? h('input', { class: 'input', value: linkLabel, maxlength: 40 }) : null;
    const addVersion = () => {
      const name = vName.value.trim();
      if (!name) return toast('Give the version a name.');
      const when = {};
      if (vWho.value) when.scanner = vWho.value;
      const parts = vParts.filter(([b]) => b.checked).map(([b]) => b.value); if (parts.length) when.dayparts = parts;
      const ints = vInterests.value.split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean); if (ints.length) when.interestsAny = ints;
      const cfg = structuredClone(c.experienceConfig);
      for (const [k, input] of vTexts) cfg[k] = input.value.trim() || c.experienceConfig[k];
      if (vLink && cfg.link) cfg.link.label = vLink.value.trim() || linkLabel;
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'version';
      let vid = base, k = 2; while (d.variants.some((v) => v.id === vid)) vid = `${base}-${k++}`;
      d.variants.push({ id: vid, name, ...(Object.keys(when).length ? { when } : {}), experienceConfig: cfg });
      vName.value = ''; drawVersions(); toast('Added. Save to keep it.');
    };

    // 3. Who it's for.
    const aud = d.targeting.audience ?? {};
    const tInterests = h('input', { class: 'input', placeholder: 'Anyone', value: (aud.interestsAny ?? []).join(', ') });
    const tCustomers = h('select', { class: 'input' }, [['', 'Everyone'], ['new', 'Only people new to you'], ['returning', 'Only people who’ve scanned you before']].map(([v, l]) => h('option', { value: v, text: l })));
    tCustomers.value = aud.customers ?? '';
    const prodBoxes = c.products.map((p) => { const b = h('input', { type: 'checkbox', value: p.id }); b.checked = (d.targeting.products ?? []).includes(p.id); return [b, h('label', { class: 'chip-check' }, b, ` ${p.name}`)]; });

    // 3b. The bid, for ads that bid.
    const bidBox = (() => {
      if (c.buy?.type !== 'bid') return null;
      const b = c.buy, a = b.adjustments ?? {};
      const money = (v) => h('input', { class: 'input', inputmode: 'decimal', value: (v / 100).toFixed(2), style: 'max-width:140px' });
      const pct = (v) => h('input', { class: 'input', type: 'number', min: -90, max: 300, step: 5, value: v ?? '', placeholder: '0', style: 'max-width:110px' });
      const pairs = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}%`).join(', ');
      const parsePairs = (t) => Object.fromEntries(t.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const m = /^(.+?)\s*([+-]?\d+)\s*%?$/.exec(x); return m ? [m[1].trim(), Number(m[2])] : null; }).filter(Boolean));
      const f = { bid: money(b.maxCentsPerLabel), cap: money(b.dailyCapCents), pacing: h('select', { class: 'input' }, h('option', { value: 'even', text: 'Spread it over the day' }), h('option', { value: 'fast', text: 'Spend it as bottles come' })), freq: h('input', { class: 'input', type: 'number', min: 1, max: 50, value: b.frequencyCap ?? '', placeholder: 'No cap', style: 'max-width:120px' }),
        parts: DAYPARTS.map(([k, l]) => [k, l, pct(a.dayparts?.[k])]), newC: pct(a.newCustomers), retC: pct(a.returningCustomers), ints: h('input', { class: 'input', value: pairs(a.interests), placeholder: 'coffee +20, running +10' }), locs: h('input', { class: 'input', value: pairs(a.locations), placeholder: 'ATX-014 +15, ATX-022 -20' }) };
      f.pacing.value = b.pacing ?? 'even';
      d.bidding = () => {
        const num = (i) => (i.value === '' ? undefined : Number(i.value));
        const adjustments = { dayparts: Object.fromEntries(f.parts.filter(([, , i]) => num(i)).map(([k, , i]) => [k, num(i)])), interests: parsePairs(f.ints.value), locations: parsePairs(f.locs.value), ...(num(f.newC) ? { newCustomers: num(f.newC) } : {}), ...(num(f.retC) ? { returningCustomers: num(f.retC) } : {}) };
        for (const k of ['dayparts', 'interests', 'locations']) if (!Object.keys(adjustments[k]).length) delete adjustments[k];
        return { maxCentsPerLabel: Math.round(Number(f.bid.value) * 100), dailyCapCents: Math.round(Number(f.cap.value) * 100), pacing: f.pacing.value, frequencyCap: num(f.freq) ?? null, adjustments: Object.keys(adjustments).length ? adjustments : null };
      };
      return h('section', { class: 'panel', style: 'gap:12px' }, h('h2', { class: 'section', text: 'Your bid' }),
        h('p', { style: 'margin:0', text: `You bid for the whole label; smaller pieces pay the same share. Bidding starts at ${cents(c.engagement?.floorCents ?? 100)}. You pay only enough to beat the next other advertiser’s ad (your own ads never raise each other’s price), never more than your bid. Ads people engage with more can win with lower bids.` }),
        h('div', { class: 'form' }, field('Most you’ll pay for the whole label ($)', f.bid), field('Most you’ll pay a day for printed labels ($)', f.cap, 'Covers only what you pay for labels printed. Scans, AR launches, box sides and sales commission are billed on top.'), field('Budget pacing', f.pacing), field('Most bottles one person gets a day', f.freq)),
        h('div', { class: 'field' }, h('label', { text: 'Bid more or less (%) by time of day' }), h('div', { class: 'chips' }, f.parts.map(([, l, i]) => h('label', { class: 'chip-check' }, `${l} `, i)))),
        h('div', { class: 'form' }, field('New customers (%)', f.newC), field('Returning customers (%)', f.retC), field('By interest', f.ints, 'Only for people who shared their interests.'), field('By machine or route', f.locs)));
    })();

    // 4. Try a moment.
    const mDay = h('select', { class: 'input' }, DAYPARTS.map(([v, l]) => h('option', { value: v, text: l })));
    const mWho = h('select', { class: 'input' }, [['first', 'First to scan, new to you'], ['passed', 'Passed the bottle by someone'], ['returning', 'Has scanned you before']].map(([v, l]) => h('option', { value: v, text: l })));
    const mInt = h('input', { class: 'input', placeholder: 'coffee' });
    const mOut = h('div', { class: 'moment' });
    const tryMoment = async () => {
      try {
        const r = await api('POST', `/v1/campaigns/${id}/preview-moment`, { daypart: mDay.value, passedOn: mWho.value === 'passed', firstScanner: mWho.value !== 'passed', newToAdvertiser: mWho.value !== 'returning', interests: mInt.value.split(',').map((x) => x.trim()).filter(Boolean) });
        const hero = r.doc.blocks.find((b) => b.type === 'hero'), ar = r.doc.blocks.find((b) => b.type === 'ar');
        mOut.replaceChildren(...[h('div', { class: 'meta', text: r.variant ? `Version: ${r.variant.name}${r.personalizedBy ? ` · picked by ${r.personalizedBy}` : ''}` : 'Your standard version' }),
          hero ? h('b', { text: hero.title }) : null, ar ? h('div', { class: 'meta', text: `AR ${ar.mode === 'label' ? 'living label' : ar.mode === 'bottle' ? 'on the bottle' : 'in the room'}${ar.caption ? `: “${ar.caption}”` : ''}` }) : null].filter(Boolean));
      } catch (x) { toast(x.message); }
    };

    const save = async () => {
      const body = {
        qr: d.qr.mode === 'static' ? { mode: 'static', staticUrl: d.qr.staticUrl, bottleRef: d.qr.bottleRef, ...(d.logo ? { logo: d.logo } : {}), ...(d.qr.color ? { color: d.qr.color } : {}) } : { mode: 'dynamic', ...(d.logo ? { logo: d.logo } : {}), ...(d.qr.color ? { color: d.qr.color } : {}) },
        variants: d.variants, personalize: { ai: !!d.personalize.ai, greeting: false }, afterEnd: d.afterEnd, ...(d.bidding ? { bidding: d.bidding() } : {}),
        firstSeen: d.firstSeen, socialProof: d.socialProof, more: d.more, ...(readOffering() ? { offering: readOffering() } : {}),
        targeting: { products: prodBoxes.filter(([b]) => b.checked).map(([b]) => b.value), audience: { interestsAny: tInterests.value.split(',').map((x) => x.trim()).filter(Boolean), ...(tCustomers.value ? { customers: tCustomers.value } : {}) } },
      };
      try { await api('PATCH', `/v1/campaigns/${id}/codes`, body); toast('Saved. Changes to what people see go to review first.'); go('/ads'); } catch (x) { toast(x.message); }
    };

    shell('overview',
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Code, versions and AI' }), h('p', { text: 'What your code is, what each person sees when they scan it, and who your ad is printed for.' })), h('button', { class: 'btn', type: 'button', onclick: save }, 'Save')),
      h('div', { class: 'review', style: 'max-width:900px' },
        firstBox, offerBox, moreBox,
        h('section', { class: 'panel', style: 'gap:12px' }, h('h2', { class: 'section', text: 'Your code' }), modes, staticBox,
          h('div', { style: 'display:flex;gap:18px;align-items:center;flex-wrap:wrap' }, qrImg, h('div', { class: 'stack', style: 'flex:1;min-width:220px' }, qrNote,
            c.allowed.logos ? h('div', { class: 'toolbar' }, h('button', { class: 'btn small secondary', type: 'button', onclick: () => upload.click() }, c.qr.hasLogo ? 'Change your logo' : 'Put your logo in it'), upload) : h('p', { style: 'margin:0;font-size:14px', text: 'This company doesn’t put advertisers’ logos in codes.' }),
            field('Color of the squares', color, 'Optional. Dark colors only, so it always scans.')))),
        h('section', { class: 'panel', style: 'gap:12px' }, h('h2', { class: 'section', text: 'Who sees what' }),
          h('p', { style: 'margin:0', text: 'Make other versions for different moments. At each scan the first version that fits is shown; your standard settings are for everyone else.' }), vlist,
          h('details', {}, h('summary', { text: 'Add a version' }), h('div', { class: 'stack', style: 'margin-top:10px' }, field('Name', vName), field('For', vWho), h('div', { class: 'field' }, h('label', { text: 'Only at these times (optional)' }), h('div', { class: 'chips' }, vParts.map(([, l]) => l))), field('Who like (optional)', vInterests, 'Only counts for people who turned on personalized offers.'),
            ...vTexts.map(([k, input]) => field(`Says: ${k}`, input)), vLink ? field('Button', vLink) : null, h('div', {}, h('button', { class: 'btn secondary', type: 'button', onclick: addVersion }, 'Add this version'))))),
        h('section', { class: 'panel', style: 'gap:12px' }, h('h2', { class: 'section', text: 'AI personalization' }),
          check('Let AI pick the version for each person', d.personalize.ai, (v) => { d.personalize.ai = v; }, 'It only ever chooses among your versions, and only ones whose conditions fit. It sees the moment (time of day, passed-on bottle, interests people shared), never who someone is.'),
          ),
        h('section', { class: 'panel', style: 'gap:12px' }, h('h2', { class: 'section', text: 'Who your ad is printed for' }),
          h('div', { class: 'form' }, field('People who like', tInterests, 'Your ad then only prints on bottles for someone who fits, and we show you each bottle reached them.'), field('Customers', tCustomers)),
          // Paid up front with no fee per scan or AR launch: targeting costs nothing more, so nothing is said about it.
          c.engagement?.table && (c.engagement.perScanCents || c.engagement.perArLaunchCents) ? h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: `Targeting makes each engagement worth more, so it costs more: places +${c.engagement.table.locations}%, products +${c.engagement.table.products}%, interests +${c.engagement.table.interests}%, new or returning customers +${c.engagement.table.customers}% (at most +${c.engagement.table.max}% in all). Right now yours adds ${c.engagement.premium.percent}%: ${cents(Math.round(c.engagement.perScanCents * (1 + c.engagement.premium.percent / 100)))} a scan and ${cents(Math.round(c.engagement.perArLaunchCents * (1 + c.engagement.premium.percent / 100)))} an AR launch.` }) : null,
          c.products.length > 1 ? h('div', { class: 'field' }, h('label', { text: 'Only on these products (none ticked: all)' }), h('div', { class: 'chips' }, prodBoxes.map(([, l]) => l))) : null),
        bidBox,
        h('section', { class: 'panel', style: 'gap:12px' }, h('h2', { class: 'section', text: 'When this ad ends' }),
          h('div', { class: 'radio-cards', role: 'radiogroup', 'aria-label': 'When this ad ends' }, [['current', 'Old bottles open your current ad', 'Bottles still out there keep working for you.'], ['keep', 'Old bottles keep this ad', 'For offers that should stay as printed.']].map(([v, t, desc]) => { const r = h('input', { type: 'radio', name: 'after', value: v }); r.checked = d.afterEnd === v; r.addEventListener('change', () => { d.afterEnd = v; }); return h('label', {}, r, h('b', { text: t }), h('span', { text: desc })); }))),
        h('section', { class: 'panel', style: 'gap:12px' }, h('h2', { class: 'section', text: 'Try a moment' }),
          h('div', { class: 'form' }, field('Time', mDay), field('Person', mWho), field('Likes', mInt)), h('div', {}, h('button', { class: 'btn secondary', type: 'button', onclick: tryMoment }, 'Show what they’d see')), mOut),
        h('div', {}, h('button', { class: 'btn wide', type: 'button', onclick: save }, 'Save'))));
    refreshQr();
  }

  // ---------- overview ----------
  const statusText = { running: 'Running', in_review: 'In review', paused: 'Paused', finished: 'Finished', not_approved: 'Needs changes', stopped: 'Stopped', not_paid: 'Not paid for' };
  // How ads are paid for here, in plain words (prepaid: up front, per bottle; otherwise billed after the fact).
  const prepaidTerms = (b) => `You pay up front for a number of bottles, and exactly that many go out with your ad: there's no end date and nothing to cancel, and pausing only delays. ${b.included}. ${b.feesOn.length ? `On top: ${b.feesOn.join(', ')}, charged to your card each day.` : 'Nothing is charged per scan, AR launch or sale.'} Changing a running ad costs ${dollars(b.changeFeeCents)}, paid when you submit the change.`;
  async function overview() {
    const o = await api('GET', '/v1/ads/overview?days=14');
    state.business = o.advertiser;
    state.changeFeeCents = o.billing?.changeFeeCents;
    const p = o.period, t = o.total;
    shell('overview',
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: o.advertiser.name }), h('p', { text: 'The last 14 days. Every number comes from the books.' })), link('/ads/new', { class: 'btn' }, icon(I.plus), 'New ad')),
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi dark' }, h('span', { text: 'Spent' }), h('b', { text: dollars(p.spendCents) }), h('small', { text: `${dollars(t.spendCents)} all time` })),
        h('div', { class: 'kpi' }, h('span', { text: 'Bottles with your ad' }), h('b', { text: num(p.prints) }), h('small', { text: p.boxFaces ? `+ ${num(p.boxFaces)} boxes` : 'printed' })),
        h('div', { class: 'kpi' }, h('span', { text: 'Scans' }), h('b', { text: num(p.scans) }), h('small', { text: p.prints ? `${Math.round((p.scans / p.prints) * 100)}% of bottles` : 'that loaded' })),
        h('div', { class: 'kpi' }, h('span', { text: 'AR launches' }), h('b', { text: num(p.arLaunches) }), h('small', { text: `${num(t.saves)} saves all time` })),
        h('div', { class: 'kpi' }, h('span', { text: 'Sales from bottles' }), h('b', { text: dollars(p.salesCents) }), h('small', { text: `${num(p.sales)} orders` }))),
      chart(o.daily),
      o.drafts.length ? h('div', {}, h('h2', { class: 'section', text: 'Unfinished ads' }), h('div', { class: 'drafts' }, o.drafts.map((d) => link(`/ads/drafts/${d.id}`, {}, h('span', { text: d.headline || 'New ad' }), h('span', { style: 'color:var(--muted)', text: `${d.campaignId ? 'Change to a live ad · ' : ''}Continue` }))))) : null,
      h('h2', { class: 'section', text: 'Your ads' }),
      o.campaigns.length ? h('div', { class: 'cards' }, o.campaigns.map(campaignCard)) : h('div', { class: 'empty' }, 'No ads yet. ', link('/ads/new', {}, 'Make your first one'), ' — it takes a few minutes.'),
      h('p', { style: 'color:var(--muted);font-size:13px;margin-top:22px', text: o.billing?.model === 'prepaid'
        ? `Price per bottle: ${Object.entries(o.prices.perPrintCents).map(([s, c]) => `${cents(c)} for ${sizeName(s)}`).join(', ')}. ${prepaidTerms(o.billing)}`
        : `Starting prices per bottle printed: ${Object.entries(o.prices.perPrintCents).map(([s, c]) => `${cents(c)} for ${sizeName(s)}`).join(', ')}. Bids start at ${cents(o.prices.bidStartsAtCents)} for the whole label and go up from there. Then ${cents(o.prices.perScanCents)} per scan that loads, ${cents(o.prices.perArLaunchCents)} per AR launch, and ${o.prices.commissionPercent}% of sales. The more an ad targets (places, products, interests, new or returning customers), the more each scan and AR launch costs. Repeat scans and failed prints are free.` }));
  }
  function campaignCard(c) {
    const r = c.results;
    const actions = [];
    if (c.status === 'running') actions.push(h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { await api('PATCH', `/v1/campaigns/${c.id}`, { active: false }); toast('Paused'); render(); } }, 'Pause'));
    if (c.status === 'paused') actions.push(h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await api('PATCH', `/v1/campaigns/${c.id}`, { active: true }); toast('Running again'); render(); } catch (x) { toast(x.message); } } }, 'Resume'));
    const paid = c.budget.type === 'prepaid' ? c.budget : null;
    if (c.editable && c.status !== 'in_review' && c.status !== 'stopped' && c.status !== 'finished') actions.push(link(`/ads/campaigns/${c.id}/change`, { class: 'btn small secondary' }, paid ? `Change it (${dollars(state.changeFeeCents ?? 0)})` : 'Change it'));
    actions.push(link(`/ads/campaigns/${c.id}/code`, { class: 'btn small secondary' }, 'Code, versions and AI'));
    if (c.route && on('route_proof')) actions.push(link(`/ads/campaigns/${c.id}/report`, { class: 'btn small secondary' }, 'Where it went'));
    // Paid up front: how many of the bottles paid for are out. No end date and no cancelling: it runs until they are.
    const budget = paid ? (paid.stopped ? `stopped by ${state.config.name}: ${num(paid.printed)} of ${num(paid.paid)} bottles went out, ${num(paid.refunded)} paid back`
      : `${num(paid.printed)} of ${num(paid.paid)} bottles out${paid.printing ? ` (${num(paid.printing)} printing)` : ''}, ${sizeName(paid.share)} at ${cents(paid.perBottleCents)} each, paid`)
      : c.budget.type === 'guaranteed' ? `${num(c.budget.bottlesLeft)} bottles left` : `up to ${dollars(c.budget.dailyCapCents)} a day for printed labels (scans and other charges on top)`;
    return h('article', { class: 'camp' },
      h('div', { class: 'thumb' }, h('img', { src: svgSrc(c.thumbSvg), alt: `Your ad: ${c.name}` })),
      h('div', {},
        h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px' }, h('span', { class: `status ${c.status}`, text: statusText[c.status] })),
        h('h3', { text: c.name }),
        h('div', { class: 'meta', text: `${c.route ? `On delivery routes: ${ROUTE_KINDS[c.route.kind] ?? c.route.kind}, ${num(c.route.houses)} houses` : c.where === 'all' ? 'Every machine' : c.where.join(', ')} · ${budget} · ${c.formats.includes('box-face') ? 'bottles and boxes' : 'bottles'}` }),
        h('div', { class: 'nums' }, [['Bottles', num(r.prints)], ['Scans', num(r.scans)], ['AR', num(r.arLaunches)], ['Spent', dollars(r.spendCents)]].map(([k, v]) => h('div', {}, h('b', { text: v }), k))),
        c.status === 'not_approved' && c.review?.note ? h('div', { class: 'note' }, h('b', { text: 'What to change: ' }), c.review.note) : null,
        actions.length ? h('div', { class: 'actions' }, actions) : null));
  }
  function chart(daily) {
    const W = 1000, H = 220, padL = 44, padB = 22, padT = 10;
    const maxSpend = Math.max(100, ...daily.map((d) => d.spendCents));
    const maxScans = Math.max(1, ...daily.map((d) => d.scans));
    const step = Math.max(100, Math.ceil(maxSpend / 4 / 100) * 100);
    const top = step * 4;
    const x = (i) => padL + ((W - padL - 8) / daily.length) * (i + 0.5);
    const bw = Math.max(6, ((W - padL - 8) / daily.length) * 0.56);
    const y = (c) => padT + (H - padT - padB) * (1 - c / top);
    const s = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Spend and scans per day' });
    for (let i = 0; i <= 4; i++) { const v = step * i; s.append(svgEl('line', { x1: padL, x2: W - 4, y1: y(v), y2: y(v), stroke: '#E3EAF0' })); const t = svgEl('text', { x: padL - 6, y: y(v) + 4, 'text-anchor': 'end' }); t.textContent = dollars(v); s.append(t); }
    daily.forEach((d, i) => {
      const r = svgEl('rect', { x: x(i) - bw / 2, y: y(d.spendCents), width: bw, height: Math.max(0, y(0) - y(d.spendCents)), rx: 3, fill: '#0B0B0B' });
      const ti = svgEl('title', {}); ti.textContent = `${d.day}: ${dollars(d.spendCents)}, ${d.prints} bottles, ${d.scans} scans`; r.append(ti); s.append(r);
      if (i % 2 === 0 || daily.length <= 8) { const t = svgEl('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }); t.textContent = new Date(`${d.day}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric' }); s.append(t); }
    });
    const pts = daily.map((d, i) => `${x(i)},${padT + (H - padT - padB) * (1 - d.scans / maxScans)}`).join(' ');
    s.append(svgEl('polyline', { points: pts, fill: 'none', stroke: '#7FC6EA', 'stroke-width': 3, 'stroke-linejoin': 'round' }));
    const last = daily.length - 1; s.append(svgEl('circle', { cx: x(last), cy: padT + (H - padT - padB) * (1 - daily[last].scans / maxScans), r: 4.5, fill: '#1E7DB8' }));
    return h('section', { class: 'chart' }, h('div', { class: 'chart-head' }, h('h2', { text: 'Day by day' }), h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:#0B0B0B' }), 'Spent'), h('span', {}, h('i', { style: 'background:#7FC6EA' }), `Scans (top = ${maxScans})`))), s);
  }

  // ---------- making an ad ----------
  async function newAd() { const d = await api('POST', '/v1/ads/drafts', {}); go(`/ads/drafts/${d.id}`, true); }
  async function changeAd(id) { const d = await api('POST', '/v1/ads/drafts', { fromCampaignId: id }); go(`/ads/drafts/${d.id}`, true); }

  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const png = file.type === 'image/png' && c.toDataURL('image/png');
      if (png && png.length < 900_000) return png; // logos keep their clear background
      let q = 0.86, out = c.toDataURL('image/jpeg', q);
      while (out.length > 900_000 && q > 0.4) { q -= 0.12; out = c.toDataURL('image/jpeg', q); }
      return out;
    } finally { URL.revokeObjectURL(url); }
  }

  async function builder(id) {
    let d = await api('GET', `/v1/ads/drafts/${id}`);
    if (d.status !== 'open') { go('/ads', true); return; }
    let tab = 'bottle', preview = null, attachments = [], busy = false, suggestions = [];
    const msgs = h('div', { class: 'msgs', 'aria-live': 'polite' });
    const sugg = h('div', { class: 'sugg' });
    const attached = h('div', { class: 'attached' });
    const ta = h('textarea', { rows: 1, id: 'ask', placeholder: 'Describe your ad, or ask for a change', 'aria-label': 'Message' });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true });
    const send = h('button', { class: 'icon-btn send', type: 'submit', 'aria-label': 'Send' }, icon(I.send));
    const checklist = h('div', { class: 'checklist' });
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const stage = h('div', { class: 'stage' });
    const submitBtn = link(`/ads/drafts/${id}/review`, { class: 'btn wide', id: 'to-review' }, 'Review and submit');
    const drawMsgs = () => {
      msgs.replaceChildren(...d.messages.map((m) => h('div', { class: `msg ${m.role}` }, m.text, m.attachments?.length ? h('div', { class: 'att', text: `📎 ${m.attachments.join(', ')}` }) : null)));
      if (busy) msgs.append(h('div', { class: 'msg assistant thinking', 'aria-label': 'Thinking' }, h('i'), h('i'), h('i')));
      sugg.replaceChildren(...(busy ? [] : suggestions).map((s) => h('button', { type: 'button', onclick: () => say(s) }, s)));
      attached.replaceChildren(...attachments.map((a, i) => h('span', {}, h('img', { src: a.dataUrl, alt: '' }), a.name, h('button', { type: 'button', 'aria-label': `Remove ${a.name}`, onclick: () => { attachments.splice(i, 1); drawMsgs(); } }, '×'))));
      requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
    };
    const all = ['artwork', 'category', 'sizes', 'where', 'budget', 'scanPage'];
    const names = { artwork: 'Artwork', category: 'Business type', sizes: 'Sizes', where: 'Where', budget: 'Budget', scanPage: 'Scan page' };
    const drawSide = () => {
      const left = new Set(d.missing.map((m) => m.id));
      checklist.replaceChildren(...all.map((k) => h('span', { class: left.has(k) ? '' : 'done', text: `${left.has(k) ? '○' : '✓'} ${names[k]}` })));
      submitBtn.toggleAttribute('aria-disabled', !d.ready); submitBtn.style.pointerEvents = d.ready ? '' : 'none'; submitBtn.style.opacity = d.ready ? '' : '.4';
      const t = [['bottle', 'On the bottle'], ['sizes', 'Every size'], ...(d.draft.formats?.includes('box-face') ? [['box', 'On a box']] : []), ['scan', 'Scan page'], ['cost', 'Cost']];
      if (!t.some(([k]) => k === tab)) tab = 'bottle';
      tabs.replaceChildren(...t.map(([k, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; drawSide(); } }, label)));
      drawStage();
    };
    let frame = null, frameReady = false;
    const sendScan = () => { if (frame && frameReady && preview) frame.contentWindow.postMessage({ type: 'fw-preview', ...(preview.scan ?? { doc: null }) }, fixture ? '*' : location.origin); };
    const onMsg = (e) => { if ((fixture || e.origin === location.origin) && e.data?.type === 'fw-preview-ready') { frameReady = true; sendScan(); } };
    window.addEventListener('message', onMsg);
    cleanup = () => window.removeEventListener('message', onMsg);
    function drawStage() {
      if (!preview) { stage.replaceChildren(h('p', { class: 'caption', text: 'Your ad appears here as you chat.' })); return; }
      if (tab === 'bottle') stage.replaceChildren(h('img', { class: 'label-img', src: svgSrc(preview.labelSvg), alt: 'A sample label with your ad on it' }), h('p', { class: 'caption', text: 'A sample label. Your ad is on the left; the other slots go to other advertisers. The black panel is the same on every bottle.' }));
      if (tab === 'sizes') stage.replaceChildren(everyShape(preview), h('p', { class: 'caption', text: 'Your ad exactly as it prints, at every shape each size comes in (a piece can be wide on one bottle and tall on the next), with its QR code where it prints.' }));
      if (tab === 'box') stage.replaceChildren(h('img', { class: 'box-img', src: svgSrc(preview.boxFaceSvg), alt: 'Your ad on the side of a delivery box' }), h('p', { class: 'caption', text: 'One side of a delivery box. Each side has its own QR code.' }));
      if (tab === 'scan') {
        frameReady = false;
        frame = fixture?.scanFrame ? fixture.scanFrame() : h('iframe', { src: '/preview/scan', title: 'Your scan page' });
        stage.replaceChildren(frame, h('p', { class: 'caption', text: 'What opens on a phone when someone scans your ad.' }));
      }
      if (tab === 'cost' && d.payment) {
        // Paid up front: the exact total for the bottles (or the change fee), before anything is charged.
        const pay = d.payment, q = pay.kind === 'bottles' ? pay.quote : null;
        const rows = pay.kind === 'change' ? [['Changing this ad (paid when you submit the change)', dollars(pay.feeCents)], ['Your bottles', 'unchanged: the ones not printed yet carry the new ad once it’s approved']]
          : q ? [[`${num(q.bottles)} bottles with your ad on ${sizeName(q.share)}`, `${cents(q.perBottleCents)} each`], ['AR, video and scans', 'included'], ['You pay up front', dollars(q.totalCents)]] : [];
        stage.replaceChildren(h('table', { class: 'cost' }, h('tbody', {}, rows.map(([a, b]) => h('tr', {}, h('td', { text: a }), h('td', { text: b }))))),
          h('p', { class: 'caption', style: 'text-align:left', text: pay.kind === 'change' ? 'The new ad is reviewed before it prints.' : q ? 'Exactly that many bottles go out. You can pick another size before you pay.' : pay.problem }));
      } else if (tab === 'cost') {
        const e = d.estimate;
        const rows = [...Object.entries(e.perPrintCents).map(([s, c]) => [`Each bottle printed with your ad on ${sizeName(s)} (starting price)`, cents(c)]), ['Each scan that loads', cents(e.perScanCents)], ['Each AR launch', cents(e.perArLaunchCents)], ['Sales from the bottle', `${e.commissionPercent}%`]];
        if (d.draft.formats?.includes('box-face')) rows.push(['Each delivery box side', cents(e.perBoxFaceCents)]);
        const sum = e.printsCostCents ? `${num(d.draft.buy.prints)} bottles cost ${dollars(e.printsCostCents[0])}${e.printsCostCents[1] !== e.printsCostCents[0] ? ` to ${dollars(e.printsCostCents[1])}, depending on size` : ''}, plus scans and sales.` : e.bottlesPerDay ? `${dollars(d.draft.buy.dailyCapCents)} a day buys about ${num(e.bottlesPerDay[0])}${e.bottlesPerDay[1] !== e.bottlesPerDay[0] ? `–${num(e.bottlesPerDay[1])}` : ''} bottles a day. You never pay more than your daily budget for prints.` : 'Tell the assistant your budget to see what it buys.';
        stage.replaceChildren(h('table', { class: 'cost' }, h('tbody', {}, rows.map(([a, b]) => h('tr', {}, h('td', { text: a }), h('td', { text: b }))))), h('p', { class: 'caption', style: 'text-align:left', text: sum }));
      }
      if (tab === 'scan') sendScan();
    }
    async function refreshPreview() { try { preview = await api('GET', `/v1/ads/drafts/${id}/preview`); drawStage(); } catch {} }
    async function say(text) {
      if (busy) return;
      text = (text ?? ta.value).trim();
      if (!text && !attachments.length) return;
      busy = true; ta.value = ''; send.disabled = true;
      d.messages.push({ role: 'user', text, attachments: attachments.map((a) => a.name) });
      drawMsgs();
      try {
        const r = await api('POST', `/v1/ads/drafts/${id}/messages`, { text, attachments: attachments.map(({ dataUrl, name }) => ({ dataUrl, name })) });
        d = r; suggestions = r.suggestions || []; attachments = [];
        await refreshPreview();
      } catch (x) { d.messages.push({ role: 'assistant', text: x.message }); }
      busy = false; send.disabled = false; drawMsgs(); drawSide(); ta.focus();
    }
    file.addEventListener('change', async () => { for (const f of [...file.files].slice(0, 4 - attachments.length)) { try { attachments.push({ dataUrl: await shrink(f), name: f.name }); } catch { toast(`Couldn’t read ${f.name}`); } } file.value = ''; drawMsgs(); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); say(); } });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(140, ta.scrollHeight)}px`; });
    shell('new',
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: d.campaignId ? 'Change your ad' : 'Make an ad' }), h('p', { text: `Chat with the assistant (${d.assistant}). Nothing prints until you review it and ${state.config.name} approves it.` })), link(`/ads/studio?draft=${id}`, { class: 'btn secondary' }, 'Design it with photos')),
      h('div', { class: 'builder' },
        h('section', { class: 'chat', 'aria-label': 'Chat' }, msgs, sugg, attached,
          h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); say(); } }, file, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Attach a logo or photo', onclick: () => file.click() }, icon(I.clip)), ta, send)),
        h('section', { class: 'panel', 'aria-label': 'Preview' }, checklist, tabs, stage, submitBtn)));
    if (d.messages.length <= 1) suggestions = ['We’re a taco truck. Two tacos for $5 on Tuesdays.', 'Free coffee for first-time customers'];
    drawMsgs(); drawSide(); refreshPreview(); ta.focus();
  }

  async function review(id) {
    const d = await api('GET', `/v1/ads/drafts/${id}`);
    if (d.status !== 'open') { go('/ads', true); return; }
    const p = await api('GET', `/v1/ads/drafts/${id}/preview`);
    const agree = h('input', { type: 'checkbox', id: 'agree' });
    const err = h('div', { class: 'notice err', hidden: true });
    const dr = d.draft;
    const budget = dr.buy?.type === 'guaranteed' ? `${num(dr.buy.prints)} bottles` : dr.buy ? `up to ${dollars(dr.buy.dailyCapCents)} a day for printed labels (scans and other charges on top)` : 'Not set';
    // Paid up front: pick the size (and any extras), see the exact total, then pay and submit in one step.
    const pay = d.payment;
    let quote = pay?.kind === 'bottles' ? pay.quote : null;
    const sizePick = pay?.kind === 'bottles' && quote ? h('select', { class: 'input', id: 'pay-size' }, (dr.sizes || []).map((s) => h('option', { value: String(s), text: sizeName(s), ...(String(s) === String(quote.share) ? { selected: true } : {}) }))) : null;
    const terms = pay ? (await api('GET', '/v1/ads/billing').catch(() => null)) : null;
    const extraInputs = pay?.kind === 'bottles' && terms?.extras?.length ? terms.extras.map((x) => ({ x, input: h('input', { class: 'input', type: 'number', min: 0, max: 1000, value: 0, style: 'max-width:100px', 'aria-label': x.label }) })) : [];
    const totalEl = h('b', { text: quote ? dollars(quote.totalCents) : '' });
    const payLine = h('span', { text: quote ? `${num(quote.bottles)} bottles × ${cents(quote.perBottleCents)}${quote.extrasCents ? ` + extras ${dollars(quote.extrasCents)}` : ''}` : '' });
    const requote = async () => {
      try {
        quote = await api('POST', `/v1/ads/drafts/${id}/quote`, { share: Number(sizePick.value), extras: Object.fromEntries(extraInputs.map(({ x, input }) => [x.id, Math.max(0, Math.floor(Number(input.value) || 0))])) });
        totalEl.textContent = dollars(quote.totalCents); payLine.textContent = `${num(quote.bottles)} bottles × ${cents(quote.perBottleCents)}${quote.extrasCents ? ` + extras ${dollars(quote.extrasCents)}` : ''}`;
        submit.textContent = `Pay ${dollars(quote.totalCents)} and submit for review`;
      } catch (x) { err.textContent = x.message; err.hidden = false; }
    };
    if (sizePick) sizePick.addEventListener('change', requote);
    for (const { input } of extraInputs) input.addEventListener('change', requote);
    const submitLabel = pay?.kind === 'bottles' ? (quote ? `Pay ${dollars(quote.totalCents)} and submit for review` : 'Submit for review') : pay?.kind === 'change' && pay.feeCents ? `Pay the ${dollars(pay.feeCents)} change fee and submit` : 'Submit for review';
    // Where it goes: anywhere (a number of bottles), or on the delivery routes (areas, streets, a shape, or houses).
    let routeQuote = null, routeInput = null, submit = null;
    const routes = pay?.kind === 'bottles' && on('route_buying') ? routePicker({ quoteUrl: `/v1/ads/drafts/${id}/route-quote`, sizes: dr.sizes || [], onQuote: (q, input) => { routeQuote = q; routeInput = input; if (submit && routeMode()) submit.textContent = q ? `Pay ${dollars(q.cardCents)}${q.creditCents ? ` (+ ${dollars(q.creditCents)} credit)` : ''} and submit for review` : 'See the price first'; } }) : null;
    const whereMode = routes ? h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Where your ad goes' },
      ...[['anywhere', 'Anywhere we hand out bottles'], ['routes', 'On our delivery routes']].map(([v, t]) => h('label', { class: 'chip-check' }, h('input', { type: 'radio', name: 'where-mode', value: v, ...(v === 'anywhere' ? { checked: true } : {}), onchange: () => { routes.el.hidden = v !== 'routes'; submit.textContent = v === 'routes' ? (routeQuote ? `Pay ${dollars(routeQuote.cardCents)} and submit for review` : 'See the price first') : submitLabel; } }), t))) : null;
    function routeMode() { return !!routes && !routes.el.hidden; }
    submit = h('button', { class: 'btn wide', type: 'button', onclick: async () => {
      err.hidden = true;
      if (!agree.checked) { err.textContent = 'Check the box to confirm you looked it over.'; err.hidden = false; return; }
      if (routeMode() && !routeQuote) { err.textContent = 'Choose where on the routes, then press “See the exact price”.'; err.hidden = false; return; }
      if (pay?.kind === 'bottles' && !routeMode() && !quote) { err.textContent = pay.problem || 'Tell the assistant how many bottles first.'; err.hidden = false; return; }
      submit.disabled = true;
      const body = { approved: true, ...(routeMode() ? { pay: { route: routeInput, expectedTotalCents: routeQuote.totalCents, expectedCreditCents: routeQuote.creditCents } } : pay?.kind === 'bottles' ? { pay: { share: quote.share, extras: Object.fromEntries(extraInputs.map(({ x, input }) => [x.id, Math.max(0, Math.floor(Number(input.value) || 0))])), expectedTotalCents: quote.totalCents } } : pay?.kind === 'change' ? { pay: { expectedFeeCents: pay.feeCents } } : {}) };
      try { const out = await api('POST', `/v1/ads/drafts/${id}/submit`, body); done(out); } catch (x) { err.textContent = x.code === 'card_needed' ? `${x.message} Add one under Billing.` : x.message; err.hidden = false; submit.disabled = false; }
    } }, submitLabel);
    const done = (out) => shell('new', h('div', { class: 'review' }, h('div', { class: 'notice ok' }, h('b', { text: out?.route ? `Paid ${dollars(out.paidCents)} for ${num(out.bottles)} pieces at ${num(out.route.houses)} houses. Submitted. ${out.route.small ? 'It’s aimed at a few houses, so a person looks at it more closely. ' : ''}` : out?.paidCents ? `Paid ${dollars(out.paidCents)} for ${num(out.bottles)} bottles. Submitted. ` : out?.changeFeeCents ? `Paid the ${dollars(out.changeFeeCents)} change fee. Submitted. ` : 'Submitted. ' }), `${state.config.name} reviews new ads, usually within a day. It starts printing as soon as it's approved, and you'll see results on your Overview.`), link('/ads', { class: 'btn' }, 'Go to Overview')));
    let frame;
    const onMsg = (e) => { if ((fixture || e.origin === location.origin) && e.data?.type === 'fw-preview-ready' && frame) frame.contentWindow.postMessage({ type: 'fw-preview', ...(p.scan ?? { doc: null }) }, fixture ? '*' : location.origin); };
    window.addEventListener('message', onMsg); cleanup = () => window.removeEventListener('message', onMsg);
    frame = fixture?.scanFrame ? fixture.scanFrame() : h('iframe', { src: '/preview/scan', title: 'Your scan page' });
    shell('new', h('div', { class: 'review' },
      h('div', { class: 'page-head', style: 'margin:0' }, h('div', {}, link(`/ads/drafts/${id}`, {}, '← Back to the chat'), h('h1', { style: 'margin-top:8px', text: 'Review your ad' }), h('p', { text: 'This is exactly what prints and what opens. Look it over before you submit.' }))),
      h('div', { class: 'stage' }, h('img', { class: 'label-img', src: svgSrc(p.labelSvg), alt: 'A sample label with your ad' })),
      h('div', { class: 'stage' }, everyShape(p)),
      h('div', { class: 'stage' }, frame),
      h('div', { class: 'facts' },
        h('div', {}, h('span', { text: 'Where' }), dr.locations === 'all' ? 'Every machine' : (dr.locations || []).join(', ')),
        h('div', {}, h('span', { text: 'Budget' }), budget),
        h('div', {}, h('span', { text: 'Prints on' }), dr.formats?.includes('box-face') ? 'Bottles and delivery boxes' : 'Bottles'),
        pay?.kind === 'bottles' && quote ? h('div', {}, h('label', { for: 'pay-size', text: 'Size you pay for' }), sizePick) : null,
        ...extraInputs.map(({ x, input }) => h('div', {}, h('span', { text: `${x.label} (${dollars(x.perUseCents)} each, paid now)` }), input)),
        pay?.kind === 'bottles' ? h('div', {}, h('span', { text: 'You pay now' }), totalEl, ' ', payLine, h('br'), h('small', { text: terms ? prepaidTerms(terms) : 'AR, video and scans included.' }))
          : pay?.kind === 'change' ? h('div', {}, h('span', { text: 'You pay now' }), `${dollars(pay.feeCents)} to change it. Your bottles stay as they are; the ones not printed yet carry the new ad once it's approved.`)
          : h('div', {}, h('span', { text: 'You pay' }), `${Object.entries(d.estimate.perPrintCents).map(([s, c]) => `from ${cents(c)} per bottle for ${sizeName(s)}`).join(', ')}; ${cents(d.estimate.perScanCents)} per scan; ${cents(d.estimate.perArLaunchCents)} per AR launch; ${d.estimate.commissionPercent}% of sales`)),
      whereMode, routes ? routes.el : null,
      h('label', { class: 'check', for: 'agree' }, agree, h('span', {}, h('b', { text: 'It looks right. ' }), 'I checked the words, colors, picture and scan page, and I have the right to use them.')),
      err, submit));
  }

  // ---------- buying on delivery routes ----------
  const ROUTE_KINDS = { spread: 'Bottles spread over an area', blanket: 'One bottle in every box, at every house', box: 'A whole box (every bottle, and its sides)', houses: 'Chosen houses' };
  const ROUTE_SWITCH = { spread: 'route_buy_spread', blanket: 'route_buy_blanket', box: 'route_buy_box', houses: 'route_buy_houses' };
  /**
   * Choose where on the routes: the kind of buy, the size, the weeks, and areas, streets, a shape drawn on the map, or
   * houses by address. "See the exact price" asks the server; nothing is charged until the advertiser pays.
   */
  function routePicker(o) {
    const el = h('section', { class: 'route-pick', hidden: true, 'aria-label': 'Buy on our delivery routes' });
    const err = h('div', { class: 'notice err', hidden: true });
    const out = h('div', { class: 'route-quote' });
    const kinds = Object.keys(ROUTE_KINDS).filter((k) => on(ROUTE_SWITCH[k]));
    const kind = h('select', { class: 'input', id: 'route-kind' }, kinds.map((k) => h('option', { value: k, text: ROUTE_KINDS[k] })));
    const size = h('select', { class: 'input', id: 'route-size' }, o.sizes.map((sz) => h('option', { value: String(sz), text: sizeName(sz) })));
    const weeks = h('input', { class: 'input', id: 'route-weeks', type: 'number', min: 1, max: 26, value: 1 });
    const start = h('input', { class: 'input', id: 'route-start', type: 'date', 'aria-describedby': 'route-start-hint' });
    const bottles = h('input', { class: 'input', id: 'route-bottles', type: 'number', min: 1, max: 1000000, value: 100 });
    const perHouse = h('input', { class: 'input', id: 'route-per-house', type: 'number', min: 1, max: 72, value: 1 });
    const sides = h('input', { type: 'checkbox', id: 'route-sides' });
    const addresses = h('textarea', { class: 'input', id: 'route-addresses', rows: 3, placeholder: '1501 Kenwood Ave, Austin, TX\none address a line' });
    const areaBox = h('div', { class: 'route-areas' }, h('p', { class: 'muted', text: 'Loading the delivery areas…' }));
    let areas = [], polygon = [];
    const picked = new Set(), streets = new Set();
    const field = (label, control, hint) => h('div', { class: 'field' }, h('label', { for: control.id, text: label }), control, hint ? h('div', { class: 'hint', id: `${control.id}-hint`, text: hint }) : null);
    const show = () => {
      const k = kind.value;
      for (const [f, ks] of [[bottlesField, ['spread']], [perHouseField, ['houses']], [sidesField, ['box']], [addressField, ['houses', 'box']]]) f.hidden = !ks.includes(k);
      areaBox.hidden = k === 'houses';
      o.onQuote(null);
    };
    const bottlesField = field('How many bottles in all', bottles, 'Spread evenly over the houses and weeks you choose.');
    const perHouseField = field('Bottles at each house, each week', perHouse);
    const sidesField = h('label', { class: 'check', for: 'route-sides' }, sides, h('span', { text: 'Include the box’s sides too' }));
    const addressField = field('Houses (street addresses, one a line)', addresses, 'Fewer than 50 houses: a person checks the ad more closely; no names, addresses or personal messages in it.');
    // Each area as a small map: its outline and its streets (never a house). Click it to draw a shape: houses inside it.
    const sketch = (a) => {
      const pts = [...(a.polygon || []), ...a.streets.map((x) => [x.lat, x.lng])];
      if (!pts.length) return null;
      const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1]);
      const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
      const pad = 0.0006, W = 320, H = 200;
      const X = (lng) => ((lng - (minLng - pad)) / ((maxLng - minLng) + 2 * pad)) * W, Y = (lat) => H - ((lat - (minLat - pad)) / ((maxLat - minLat) + 2 * pad)) * H;
      const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'route-map', role: 'img', 'aria-label': `Map of ${a.name}: click to draw a shape` });
      if (a.polygon) svg.append(svgEl('polygon', { points: a.polygon.map((p) => `${X(p[1])},${Y(p[0])}`).join(' '), fill: '#EEF6FB', stroke: '#1E7DB8', 'stroke-width': 1.5 }));
      for (const st of a.streets) { const c = svgEl('circle', { cx: X(st.lng), cy: Y(st.lat), r: 5, fill: '#0B0B0B' }); const t = svgEl('title', {}); t.textContent = `${st.street}: ${st.houses} houses`; c.append(t); svg.append(c); }
      const drawn = svgEl('polygon', { points: '', fill: 'rgba(215,38,46,.12)', stroke: '#D7262E', 'stroke-width': 2 });
      svg.append(drawn);
      svg.addEventListener('click', (e) => {
        const r = svg.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
        polygon.push([+(minLat - pad + ((H - y) / H) * ((maxLat - minLat) + 2 * pad)).toFixed(6), +(minLng - pad + (x / W) * ((maxLng - minLng) + 2 * pad)).toFixed(6)]);
        drawn.setAttribute('points', polygon.map((p) => `${X(p[1])},${Y(p[0])}`).join(' '));
        o.onQuote(null);
      });
      return svg;
    };
    api('GET', '/v1/ads/route-areas').then((list) => {
      areas = list;
      areaBox.replaceChildren(...(areas.length ? areas.map((a) => h('fieldset', { class: 'route-area' },
        h('legend', {}, h('label', { class: 'chip-check' }, h('input', { type: 'checkbox', onchange: (e) => { e.target.checked ? picked.add(a.id) : picked.delete(a.id); o.onQuote(null); } }), `${a.name}: ${num(a.houses)} houses, ${a.packSize}-packs`)),
        h('div', { class: 'muted', text: `Next week: ${num(a.nextWeek.bottles)} bottles, ${a.nextWeek.labelsFree}% of their labels still free.` }),
        sketch(a),
        h('details', {}, h('summary', { text: `Or pick streets (${a.streets.length})` }), h('div', { class: 'street-list' }, a.streets.map((st) => h('label', { class: 'chip-check' }, h('input', { type: 'checkbox', onchange: (e) => { const k = JSON.stringify({ areaId: a.id, street: st.street }); e.target.checked ? streets.add(k) : streets.delete(k); o.onQuote(null); } }), `${st.street} (${st.houses})`)))))) : [h('p', { class: 'muted', text: 'No delivery areas are open for ads right now.' })]),
        h('button', { class: 'btn small secondary', type: 'button', onclick: () => { polygon = []; for (const p of areaBox.querySelectorAll('.route-map polygon:last-of-type')) p.setAttribute('points', ''); o.onQuote(null); } }, 'Clear the shape'));
    }).catch((x) => areaBox.replaceChildren(h('div', { class: 'notice err', text: x.message })));
    const input = () => {
      const k = kind.value;
      const where = k === 'houses' || (k === 'box' && addresses.value.trim())
        ? { addresses: addresses.value.split('\n').map((x) => x.trim()).filter(Boolean) }
        : { ...(picked.size ? { areaIds: [...picked] } : {}), ...(streets.size ? { streets: [...streets].map((x) => JSON.parse(x)) } : {}), ...(polygon.length >= 3 ? { polygon } : {}) };
      return { kind: k, share: Number(size.value), weeks: Math.max(1, Math.min(26, Math.floor(Number(weeks.value) || 1))), ...(start.value ? { startWeek: start.value } : {}), where,
        ...(k === 'spread' ? { bottles: Math.max(1, Math.floor(Number(bottles.value) || 1)) } : {}), ...(k === 'houses' ? { perHouse: Math.max(1, Math.floor(Number(perHouse.value) || 1)) } : {}), ...(k === 'box' && sides.checked ? { boxSides: true } : {}) };
    };
    const ask = h('button', { class: 'btn', type: 'button', onclick: async () => {
      err.hidden = true; out.replaceChildren();
      const body = input();
      try {
        const q = await api('POST', o.quoteUrl, body);
        o.onQuote(q, body);
        out.replaceChildren(h('div', { class: 'facts' },
          h('div', {}, h('span', { text: 'Houses' }), `${num(q.housesReached)} of the ${num(q.houses)} chosen get it${q.noRoom ? ` (${num(q.noRoom)} were already full those weeks; not charged)` : ''}`),
          h('div', {}, h('span', { text: 'Bottles' }), `${num(q.bottles)} × ${cents(q.perBottleCents)} (${q.size}) = ${dollars(q.bottlesCents)}`),
          q.faces ? h('div', {}, h('span', { text: 'Box sides' }), `${num(q.faces)} × ${cents(q.perFaceCents)} = ${dollars(q.facesCents)}`) : null,
          h('div', {}, h('span', { text: 'Weeks' }), q.perWeek.map((w) => `${new Date(`${w.week}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric' })}: ${num(w.bottles)} bottles at ${num(w.houses)} houses`).join(' · ')),
          h('div', {}, h('span', { text: 'Streets' }), q.streets.map((x) => `${x.street} (${x.houses})`).join(', ')),
          h('div', {}, h('span', { text: 'You pay now' }), h('b', { text: dollars(q.cardCents) }), q.creditCents ? ` + ${dollars(q.creditCents)} from your credit` : '', h('br'), h('small', { text: `${q.included} Every piece paid for goes out; there's nothing to cancel. ${q.ifAHouseStops}` }))),
        q.guardrails.length ? h('div', { class: 'notice' }, h('b', { text: 'Aimed at a few houses. ' }), q.guardrails.join(' ')) : null);
      } catch (x) { o.onQuote(null); err.textContent = x.message; err.hidden = false; }
    } }, 'See the exact price');
    for (const c of [kind, size, weeks, start, bottles, perHouse, sides, addresses]) c.addEventListener('change', () => o.onQuote(null));
    kind.addEventListener('change', show);
    el.append(h('h2', { class: 'section', text: 'On our delivery routes' }),
      h('p', { text: 'Every house on these streets gets a free box of water each week. Your ad goes on the bottles going to the houses you choose: as little as a tenth of one label at one house, or every bottle in every box.' }),
      h('div', { class: 'facts' }, h('div', {}, field('Kind of buy', kind)), h('div', {}, field('Size on each bottle', size)), h('div', {}, field('Weeks', weeks)), h('div', {}, field('Starting the week of (a Monday; next week if empty)', start))),
      bottlesField, perHouseField, sidesField, addressField, areaBox, ask, err, out);
    show();
    return { el };
  }

  /** Where a route ad went: streets and houses reached (never which house), each drop, scans by area, what came back. */
  async function routeReport(id) {
    const p = await api('GET', `/v1/ads/campaigns/${id}/route-report`);
    const day = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–');
    shell('overview', h('div', { class: 'review' },
      h('div', { class: 'page-head', style: 'margin:0' }, h('div', {}, link('/ads', {}, '← Overview'), h('h1', { style: 'margin-top:8px', text: 'Where your ad went' }), h('p', { text: `${p.kindWords}, ${p.size}, ${p.weeks} week${p.weeks === 1 ? '' : 's'} from ${p.startWeek}.` }))),
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi dark' }, h('span', { text: 'Houses reached' }), h('b', { text: num(p.housesReached) }), h('small', { text: `of ${num(p.bought.houses)} chosen` })),
        h('div', { class: 'kpi' }, h('span', { text: 'Bottles delivered' }), h('b', { text: num(p.progress.delivered) }), h('small', { text: `${num(p.progress.printed)} printed, ${num(p.progress.waiting)} waiting` })),
        h('div', { class: 'kpi' }, h('span', { text: 'Given back' }), h('b', { text: num(p.progress.credited + p.progress.refunded) }), h('small', { text: 'houses that stopped or blocked, weeks gone by' }))),
      h('h2', { class: 'section', text: 'Streets' }),
      p.streets.length ? h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Area', 'Street', 'Houses', 'Bottles'].map((x) => h('th', { text: x })))), h('tbody', {}, p.streets.map((x) => h('tr', {}, h('td', { text: x.area }), h('td', { text: x.street }), h('td', { text: num(x.houses) }), h('td', { text: num(x.bottles) })))))
        : h('div', { class: 'empty', text: 'Nothing delivered yet.' }),
      h('h2', { class: 'section', text: 'Scans by area' }),
      h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Area', 'Bottles', 'Scans', 'Scan rate'].map((x) => h('th', { text: x })))), h('tbody', {}, p.scansByArea.map((a) => h('tr', {}, h('td', { text: a.area }), h('td', { text: num(a.bottles) }), h('td', { text: num(a.scans) }), h('td', { text: `${a.scanRatePercent}%` }))))),
      h('h2', { class: 'section', text: 'Drops' }),
      h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['When', 'Street', 'Where the driver scanned it (about 100 m)', 'At the door'].map((x) => h('th', { text: x })))),
        h('tbody', {}, p.drops.map((d) => h('tr', {}, h('td', { text: day(d.at) }), h('td', { text: d.street }), h('td', { text: d.point ? `${d.point.lat}, ${d.point.lng}` : '–' }), h('td', { text: d.atDoor ? 'Yes' : 'Driver confirmed' })))))),
      p.givenBack.length ? h('div', {}, h('h2', { class: 'section', text: 'Given back to you' }), h('ul', {}, p.givenBack.map((g) => h('li', { text: `${dollars(g.totalCents)} ${g.kind === 'credit' ? 'as credit' : g.status === 'refunded' ? 'refunded to your card' : 'to be refunded (waiting for approval)'}: ${g.reason}` })))) : null,
      h('p', { class: 'muted', text: p.note })));
  }

  // ---------- billing ----------
  async function billing() {
    const advId = state.me.advertiserId;
    const [invoices, cards, terms, routeInfo] = await Promise.all([api('GET', '/v1/invoices'), api('GET', `/v1/advertisers/${advId}/cards`).catch(() => []), api('GET', '/v1/ads/billing').catch(() => ({ model: 'billed_after' })), on('route_buying') ? api('GET', '/v1/ads/routes').catch(() => null) : null]);
    const prepaid = terms.model === 'prepaid';
    const kindText = { bottles: 'Bottles, paid in advance', change: 'Changing an ad' };
    const statusOf = (o) => (o.refund ? (o.refund.status === 'refunded' ? `Paid; ${dollars(o.refund.totalCents)} paid back` : 'Paid; paying back') : { paid: 'Paid', paying: 'Being paid', declined: 'Card declined' }[o.status] || o.status);
    shell('billing',
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Billing' }), h('p', { text: prepaid ? prepaidTerms(terms) : 'Invoices list every print, scan, AR launch and sale they charge for.' }))),
      h('h2', { class: 'section', text: 'Card' }),
      cards.length ? h('p', { text: `${cards[0].brand} •••• ${cards[0].last4}, ${prepaid ? 'charged when you pay for an ad' : 'charged automatically when an invoice is made'}.` })
        : h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px' }, h('span', { style: 'background:#FFF4D6;color:#7A5300;border-radius:6px;padding:1px 6px;font-size:12px;font-weight:700', text: 'Test mode' }), 'Add a test card:', ...[['tok_visa', 'Visa 4242'], ['tok_amex', 'Amex 0005']].map(([t, l]) => h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { await api('POST', `/v1/advertisers/${advId}/cards`, { token: t }); toast('Card saved'); render(); } }, l))),
      prepaid ? h('h2', { class: 'section', style: 'margin-top:22px', text: 'What you paid' }) : null,
      prepaid ? (terms.orders.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['When', 'For', 'Bottles', 'Total', 'Status'].map((x) => h('th', { text: x })))),
        h('tbody', {}, terms.orders.map((o) => h('tr', {}, h('td', { text: new Date(o.at).toLocaleDateString() }), h('td', { text: kindText[o.kind] || o.kind }), h('td', { text: o.bottles ? `${num(o.bottles)} × ${cents(o.perBottleCents)}` : '–' }), h('td', { text: dollars(o.totalCents) }), h('td', { text: statusOf(o) }))))))
        : h('div', { class: 'empty', text: 'Nothing paid yet. You pay for an ad’s bottles when you submit it.' })) : null,
      routeInfo && (routeInfo.creditCents || routeInfo.buys.length) ? h('div', {}, h('h2', { class: 'section', style: 'margin-top:22px', text: 'Delivery routes' }),
        h('p', { text: `Credit from houses that stopped or blocked: ${dollars(routeInfo.creditCents)}, used first on your next route buy.${routeInfo.verified ? ' Your business is verified.' : ''}` }),
        routeInfo.buys.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Ad', 'Kind', 'Houses', 'Pieces', 'Weeks', 'Paid'].map((x) => h('th', { text: x })))),
          h('tbody', {}, routeInfo.buys.map((b) => h('tr', {}, h('td', {}, on('route_proof') ? link(`/ads/campaigns/${b.campaignId}/report`, {}, b.name || b.campaignId) : (b.name || b.campaignId)), h('td', { text: b.kindWords }), h('td', { text: num(b.houses) }), h('td', { text: `${num(b.bottles)} × ${b.size}${b.boxSides ? ` + ${num(b.boxSides)} sides` : ''}` }), h('td', { text: `${b.weeks} from ${b.startWeek}` }), h('td', { text: `${dollars(b.totalCents)}${b.creditCents ? ` (${dollars(b.creditCents)} credit)` : ''}` })))))) : null) : null,
      !prepaid || invoices.length ? h('h2', { class: 'section', style: 'margin-top:22px', text: prepaid ? 'Fees charged after the fact' : 'Invoices' }) : null,
      invoices.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Up to', 'Lines', 'Total', 'Status', ''].map((x) => h('th', { text: x })))),
        h('tbody', {}, invoices.map((i) => h('tr', {}, h('td', { text: new Date(i.periodEnd).toLocaleDateString() }), h('td', { text: String(i.lines) }), h('td', { text: dollars(i.totalCents) }), h('td', { text: { open: 'Open', paid: 'Paid', failed: 'Card declined' }[i.status] || i.status }),
          h('td', {}, i.status !== 'paid' && cards.length ? h('button', { class: 'btn small', type: 'button', onclick: async () => { await api('POST', `/v1/invoices/${i.id}/pay`); toast('Paid'); render(); } }, 'Pay now') : null))))))
        : prepaid ? null : h('div', { class: 'empty', text: 'No invoices yet. They’re made from what your ads actually did: prints that printed, scans that loaded, and sales.' }));
  }

  render();
})();
