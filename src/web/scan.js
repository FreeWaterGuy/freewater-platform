// FreeWater scan pages. Draws the blocks an experience plug-in returned. Plain data in, DOM out:
// nothing from an advertiser is ever inserted as HTML.
(() => {
  'use strict';
  const app = document.getElementById('app');
  const fixture = window.__FW_FIXTURE__; // set only by the offline preview
  const path = fixture ? fixture.path : location.pathname;

  // ---------- small helpers ----------
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const randomKey = () => { const a = new Uint8Array(16); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]); };
  let viewerKey = store.get('fw_viewer');
  if (!viewerKey || !/^[A-Za-z0-9_-]{8,64}$/.test(viewerKey)) { viewerKey = randomKey(); store.set('fw_viewer', viewerKey); }
  const token = store.get('fw_token'); // set by the FreeWater app when someone signs in
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  const api = async (method, url, body) => {
    if (fixture) return fixture.api(method, url, body);
    const res = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...auth }, body: body ? JSON.stringify(body) : undefined, keepalive: method === 'POST' });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || 'Something went wrong'), { status: res.status });
    return data;
  };
  const toastEl = h('div', { class: 'toast', role: 'status' });
  document.body.append(toastEl);
  let toastTimer;
  const toast = (msg) => { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200); };
  const money = (c) => (c < 100 ? `${c}¢` : `$${(c / 100).toFixed(2)}`);
  const icon = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); return s; };
  const ICON = {
    ar: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 0v20M3 7l9 5 9-5',
    save: 'M6 3h12v18l-6-4-6 4V3Z',
    check: 'M5 12l5 5L20 7',
    link: 'M7 17 17 7M9 7h8v8',
    call: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  };
  // Pick readable ink for text on a colored background.
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ink = (bg) => (lum(bg) > 0.4 ? '#0B0B0B' : '#FFFFFF');

  const applyTheme = (t, brand) => {
    const r = document.documentElement.style;
    r.setProperty('--bg', t.background); r.setProperty('--text', t.text); r.setProperty('--accent', t.accent);
    r.setProperty('--button', t.button); r.setProperty('--button-text', t.buttonText);
    r.setProperty('--accent-ink', ink(t.accent));
    if (brand) { r.setProperty('--panel', brand.panelColor); r.setProperty('--panel-text', brand.textColor); r.setProperty('--panel-accent', brand.accentColor); }
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.background);
  };

  // ---------- routes ----------
  const m = {
    slot: /^\/s\/([A-Za-z0-9_-]+)\/(\d)$/.exec(path),
    box: /^\/b\/([A-Za-z0-9_-]+)\/(top|front|back|right|left)$/.exec(path),
    receipt: /^\/r\/([A-Za-z0-9_-]+)$/.exec(path),
    pack: /^\/p\/([A-Za-z0-9_-]+)$/.exec(path),
  };
  const fail = (title, text) => { app.replaceChildren(h('div', { class: 'error' }, h('h1', { text: title }), h('p', { text }))); };

  async function experiencePage(target) {
    const url = target.kind === 'slot' ? `/v1/public/experience/${target.unitId}/${target.slot}` : `/v1/public/experience/box/${target.packId}/${target.face}`;
    let opened;
    try { opened = await api('GET', `${url}?viewer=${encodeURIComponent(viewerKey)}`); }
    catch (e) { return fail(e.status === 404 ? 'We couldn’t find that' : 'That didn’t open', e.status === 404 ? 'This code may be from a bottle that was never printed.' : 'Check your connection and scan again.'); }
    viewerKey = opened.viewerKey; // a signed-in person uses their own key
    renderExperience(opened, target, true);
  }

  function renderExperience(opened, target, record) {
    const { doc, footer } = opened;
    applyTheme(doc.owner.theme, footer.brand);
    document.title = `${doc.owner.name} · ${footer.company}`;
    const ctx = { target, targetKey: opened.targetKey, owner: doc.owner.name };
    const custom = footer.ads === null;

    const top = h('header', { class: 'topbar' },
      h('div', { class: 'who' }, custom ? h('b', { text: 'Made just for you' }) : [h('span', { class: 'chip-ad', text: 'Ad' }), h('b', { text: doc.owner.name })]),
      h('span', { text: target.kind === 'box-face' ? `${target.face} of your box` : '' }));
    const body = h('section', { class: 'blocks' }, doc.blocks.map((b) => block(b, ctx)).filter(Boolean));
    game.info = custom ? null : opened.lottery || null;
    game.ctx = ctx;
    app.replaceChildren(top, ...(game.info ? [gameNote(game.info)] : []), body, panel(footer, target));
    if (game.info && record) checkPending();

    // The scan counts once the page has actually shown. If the experience failed, it isn't billed.
    if (record) requestAnimationFrame(() => setTimeout(() => {
      const loaded = !doc.fallback;
      const rec = target.kind === 'slot'
        ? api('POST', '/v1/public/scans', { unitId: target.unitId, slot: target.slot, viewerKey, experienceLoaded: loaded, ...(opened.variant ? { variant: opened.variant.id } : {}) })
        : api('POST', '/v1/public/box-scans', { packId: target.packId, face: target.face, viewerKey, experienceLoaded: loaded });
      rec.then(() => { if (loaded) play('scan', ctx); }).catch(() => {});
    }, 0));
  }

  let previewMode = false;
  const engage = (ctx, action, detail) => previewMode ? Promise.resolve() : api('POST', '/v1/public/engagements', { target: ctx.targetKey, viewerKey, action, ...(detail ? { detail: String(detail).slice(0, 120) } : {}) }).catch(() => {});
  // Links out of an ad go through our own address (/go/…), which records the click and hands the advertiser a click id.
  // This phone's viewer id goes along, so the click joins up with the scan.
  const withAttribution = (url, from) => {
    try {
      const u = new URL(url, location.href);
      if (u.origin === location.origin && u.pathname.startsWith('/go/')) { u.searchParams.set('v', viewerKey); if (from) u.searchParams.set('from', from); }
      return u.toString();
    } catch { return url; }
  };

  function savedSet() { try { return new Set(JSON.parse(store.get('fw_saved') || '[]')); } catch { return new Set(); } }
  async function save(ctx, btn) {
    const set = savedSet(); set.add(ctx.targetKey); store.set('fw_saved', JSON.stringify([...set]));
    markSaved(btn);
    if (previewMode) { toast('Saving works once your ad is live'); return; }
    if (token) api('POST', '/v1/me/saved', { target: ctx.targetKey }).catch(() => {});
    else engage(ctx, 'save');
    toast(token ? 'Saved to your FreeWater app' : 'Saved on this phone');
  }
  function markSaved(btn) { btn.classList.add('saved'); btn.replaceChildren(icon(ICON.check), 'Saved'); btn.disabled = true; }

  function action(a, ctx, label) {
    if (a.kind === 'link') return { href: withAttribution(a.url), onclick: () => engage(ctx, 'link', label) };
    if (a.kind === 'call') return { href: `tel:${a.phone.replace(/[^\d+]/g, '')}`, onclick: () => engage(ctx, 'call') };
    return {};
  }

  // ---------- blocks ----------
  function block(b, ctx) {
    switch (b.type) {
      case 'hero': return h('div', { class: 'hero' }, h('h1', { text: b.title }), b.subtitle && h('p', { text: b.subtitle }), b.imageUrl && h('img', { src: b.imageUrl, alt: '' }), b.model && modelStage(b.model, [], ctx, 'See it in your space'));
      case 'text': return h('p', { class: 'text', text: b.text });
      case 'offer': {
        const el = h('div', { class: 'offer', style: `color:var(--accent-ink)` }, h('h2', { text: b.headline }), b.details && h('p', { text: b.details }), b.expires && h('div', { class: 'expires', text: b.expires }));
        if (b.code) {
          const copy = h('button', { type: 'button', text: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(b.code); copy.textContent = 'Copied'; } catch { copy.textContent = b.code; } engage(ctx, 'save', 'copied code'); } });
          el.append(h('div', { class: 'code', style: 'border-color:currentColor' }, h('span', { text: b.code }), copy));
        }
        return el;
      }
      case 'button': {
        const cls = `btn${b.style === 'secondary' ? ' secondary' : ''}`;
        if (b.action.kind === 'save') {
          const btn = h('button', { type: 'button', class: cls, onclick: () => save(ctx, btn) }, icon(ICON.save), b.label);
          if (savedSet().has(ctx.targetKey)) markSaved(btn);
          return btn;
        }
        if (b.action.kind === 'ar') {
          return h('button', { type: 'button', class: cls, onclick: () => document.querySelector('model-viewer')?.dispatchEvent(new Event('fw-ar')) }, icon(ICON.ar), b.label);
        }
        return h('a', { class: `button ${cls}`, rel: 'noopener', target: b.action.kind === 'link' ? '_blank' : undefined, ...action(b.action, ctx, b.label) }, b.label, b.action.kind === 'link' ? icon(ICON.link) : icon(ICON.call));
      }
      case 'model': return modelStage(b.model, b.addOns || [], ctx, b.arLabel || 'See it in your space', b.buy);
      case 'coupon': {
        // This person's own code: shown at the counter, scanned by the cashier, and used up through FreeWater.
        const copy = h('button', { type: 'button', text: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(b.code); copy.textContent = 'Copied'; } catch { copy.textContent = b.code; } engage(ctx, 'save', 'copied code'); } });
        return h('div', { class: `offer coupon${b.redeemed ? ' used' : ''}`, style: 'color:var(--accent-ink)' },
          h('h2', { text: b.headline }), b.details && h('p', { text: b.details }),
          h('div', { class: 'coupon-qr' }, h('img', { alt: `Coupon code ${b.code}`, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(b.qrSvg)}` })),
          h('div', { class: 'code', style: 'border-color:currentColor' }, h('span', { text: b.code }), copy),
          h('div', { class: 'expires', text: b.redeemed ? 'Used. Each code works once.' : `Just for you, one use. Show it at the counter${b.expires ? ` · ${b.expires}` : ''}.` }));
      }
      case 'tour': {
        const wrap = h('div', { class: 'tour' }, h('h2', { class: 'section-title', text: b.title }));
        if (b.model) wrap.append(modelStage(b.model, [], ctx, 'Put the house on your table'));
        wrap.append(h('div', { class: 'rooms', style: 'margin-top:12px' }, b.rooms.map((r) => h('button', { type: 'button', class: 'room', style: r.imageUrl ? `background-image:url("${encodeURI(r.imageUrl)}")` : `background:${r.color || '#DDE5DD'}`, onclick: () => engage(ctx, 'room', r.name) }, h('b', { text: r.name }), r.note && h('span', { text: r.note })))));
        return wrap;
      }
      case 'video': {
        const v = h('video', { src: b.url, poster: b.posterUrl, controls: true, playsinline: true, preload: 'metadata' });
        v.addEventListener('play', () => engage(ctx, 'video').then(() => play('video', ctx)), { once: true });
        return h('figure', { style: 'margin:0' }, v, b.caption && h('figcaption', { class: 'text', style: 'margin-top:6px;color:var(--muted)', text: b.caption }));
      }
      case 'article': return h('article', { class: 'article' }, h('h2', { text: b.headline }), b.byline && h('p', { class: 'byline', text: b.byline }), b.paragraphs.map((p) => h('p', { text: p })));
      case 'booking': {
        let picked = null;
        const go = h('a', { class: 'button btn', rel: 'noopener', target: '_blank', 'aria-disabled': 'true', style: 'opacity:.45;pointer-events:none' }, 'Pick a time');
        const pills = b.slots.map((s) => h('button', { type: 'button', class: 'pill', 'aria-pressed': 'false', onclick: (e) => {
          pills.forEach((p) => p.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); picked = s;
          const u = new URL(withAttribution(b.action.url)); u.searchParams.set('slot', s);
          go.href = u.toString(); go.textContent = `Book ${s}`; go.style.cssText = ''; go.removeAttribute('aria-disabled');
          engage(ctx, 'slot', s);
        } }, s));
        go.addEventListener('click', () => picked && engage(ctx, 'link', `book ${picked}`));
        return h('div', { class: 'booking' }, h('h2', { class: 'section-title', text: b.title }), h('div', { class: 'pills', style: 'margin:12px 0 14px;flex-wrap:wrap' }, pills), go);
      }
      case 'gallery': return h('div', { class: 'gallery' }, b.imageUrls.map((u) => h('img', { src: u, alt: '', loading: 'lazy' })));
      case 'message': return h('div', { class: 'message', style: 'color:var(--accent-ink)' }, h('div', { class: 'from', text: `From ${b.from}` }), h('p', { text: b.text }));
      case 'confetti': { setTimeout(confetti, 250); return null; }
      case 'greeting': return h('div', { class: 'greeting' }, h('span', { class: 'spark', 'aria-hidden': 'true', text: '✦' }), h('span', { text: b.text }));
      case 'ar': return arBlock(b, ctx);
      default: return null;
    }
  }

  // In AR, a buy button sits over the 3D model. On iPhone it's Apple's own AR banner, on Android Google's; both go
  // through our click tracking, so a sale made from inside AR is credited to this bottle like any other.
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(navigator.userAgent);
  const usdzFor = (glbUrl) => glbUrl.replace(/\.glb(\?.*)?$/, '.usdz');
  function quickLookSrc(model, buy) {
    const p = new URLSearchParams({ callToAction: buy.label, checkoutTitle: buy.title, checkoutSubtitle: model.alt });
    return `${new URL(usdzFor(model.glbUrl), location.href).toString()}#${p.toString().replace(/\+/g, '%20')}`;
  }
  function sceneViewerIntent(model, buy) {
    const q = new URLSearchParams({ file: new URL(model.glbUrl, location.href).toString(), mode: 'ar_preferred', title: buy.title, link: withAttribution(buy.url, 'ar') });
    return `intent://arvr.google.com/scene-viewer/1.0?${q.toString()}#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(location.href)};end;`;
  }

  function modelStage(model, addOns, ctx, arLabel, buy) {
    const items = [{ id: 'main', label: model.alt, model }, ...addOns];
    const mv = h('model-viewer', { src: model.glbUrl, alt: model.alt, 'camera-controls': true, 'auto-rotate': true, 'auto-rotate-delay': '0', 'rotation-per-second': '24deg', 'shadow-intensity': '1', 'shadow-softness': '0.9', exposure: '1.05', 'environment-image': 'neutral', 'camera-orbit': '30deg 70deg auto', ar: true, 'ar-modes': 'webxr scene-viewer quick-look', 'ar-scale': 'fixed', 'interaction-prompt': 'none', 'touch-action': 'pan-y' });
    const stage = h('div', { class: 'stage' }, mv, h('div', { class: 'hint', text: 'Drag to spin' }));
    let current = model;
    if (buy) {
      if (isIOS) mv.setAttribute('ios-src', quickLookSrc(model, buy));
      // Apple's AR banner button was tapped: go on to buy, through our click tracking.
      mv.addEventListener('quick-look-button-tapped', () => { engage(ctx, 'link', 'buy from AR'); location.href = withAttribution(buy.url, 'ar'); });
    }
    let launched = false;
    const launch = async () => {
      if (!mv.canActivateAR) {
        stage.querySelector('.ar-note')?.remove();
        stage.append(h('div', { class: 'ar-note', text: 'AR opens on a phone. Spin it here, or scan the bottle with your phone’s camera.' }));
        return;
      }
      if (buy && isAndroid) location.href = sceneViewerIntent(current, buy);
      else mv.activateAR();
      if (launched) return;
      launched = true;
      // Billed only once the model actually loaded on this phone.
      const loaded = !!mv.loaded;
      const body = ctx.target.kind === 'slot'
        ? ['/v1/public/ar-launches', { unitId: ctx.target.unitId, slot: ctx.target.slot, viewerKey, loaded }]
        : ['/v1/public/box-ar-launches', { packId: ctx.target.packId, face: ctx.target.face, viewerKey, loaded }];
      api('POST', ...body).then(() => { if (loaded) playWhenBack('ar', ctx); }).catch(() => {});
      setTimeout(() => (launched = false), 1500);
    };
    mv.addEventListener('fw-ar', launch);
    const arBtn = h('button', { type: 'button', class: 'btn', onclick: launch }, icon(ICON.ar), arLabel);
    const parts = [stage];
    if (items.length > 1) {
      const pills = items.map((it, i) => h('button', { type: 'button', class: 'pill', 'aria-pressed': i === 0 ? 'true' : 'false', onclick: (e) => {
        pills.forEach((p) => p.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true');
        mv.src = it.model.glbUrl; mv.alt = it.model.alt; current = it.model;
        if (buy && isIOS) mv.setAttribute('ios-src', quickLookSrc(it.model, buy));
        if (it.id !== 'main') engage(ctx, 'addon', it.id);
      } }, i === 0 ? 'The main event' : it.label));
      parts.push(h('div', { class: 'pills' }, pills));
    }
    parts.push(arBtn);
    return h('div', { class: 'model', style: 'display:flex;flex-direction:column;gap:12px' }, parts);
  }

  // ---------- AR: in your space, on the bottle, or a living label ----------
  function arBlock(b, ctx) {
    const buy = b.cta ? { label: b.cta.label, url: b.cta.url, title: ctx.owner } : undefined;
    if (b.mode === 'world' || ctx.target.kind !== 'slot') {
      // In the room: the phone's own AR (Apple's on iPhone, Google's on Android), with the buy button.
      if (!b.model) return null;
      return h('div', { class: 'ar-card' }, h('h2', { class: 'section-title', text: b.title }), modelStage(b.model, [], ctx, b.caption || 'See it in your space', buy));
    }
    const what = b.mode === 'label'
      ? 'Point your camera at the label, then turn the bottle in your hand. The label comes alive all the way around.'
      : `Point your camera at the bottle. ${b.model?.alt || 'It'} appears on it and moves with it as you turn it.`;
    let reported = false;
    const go = (simulate) => openAr({
      block: b, slotIndex: ctx.target.slot, simulate, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || undefined,
      getMap: () => api('GET', `/v1/public/ar/${ctx.target.unitId}`),
      getLabelSvg: (url) => (fixture ? fixture.text(url) : fetch(url).then((r) => { if (!r.ok) throw new Error('label'); return r.text(); })),
      // An AR launch is billed only once it has actually loaded on this phone.
      onReady: (loaded) => { if (reported || previewMode) return; reported = true; api('POST', '/v1/public/ar-launches', { unitId: ctx.target.unitId, slot: ctx.target.slot, viewerKey, loaded }).then(() => { if (loaded) play('ar', ctx); }).catch(() => {}); },
      onLink: (url) => { engage(ctx, 'link', 'from AR'); location.href = withAttribution(url, 'ar'); },
    });
    return h('div', { class: `ar-card ar-${b.mode}` },
      h('div', { class: 'ar-art', 'aria-hidden': 'true' }, arArt(b.mode)),
      h('h2', { class: 'section-title', text: b.title }),
      h('p', { class: 'text', text: b.caption ? `${b.caption.replace(/[.!?]+$/, '')}. ${what}` : what }),
      h('button', { type: 'button', class: 'btn', onclick: () => go(false) }, icon(ICON.ar), b.mode === 'label' ? 'Bring the label to life' : 'Open AR on the bottle'),
      h('button', { type: 'button', class: 'btn secondary', onclick: () => go(true) }, 'Try it without the camera'));
  }
  // A little drawing of what will happen: a bottle with a model on top, or a bottle with a glowing label.
  function arArt(mode) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 120 90');
    const shape = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); s.append(e); return e; };
    shape('rect', { x: 44, y: 30, width: 32, height: 52, rx: 8, fill: '#c9ced3' });
    shape('rect', { x: 52, y: 20, width: 16, height: 12, rx: 3, fill: '#9aa2aa' });
    shape('rect', { x: 44, y: 44, width: 32, height: 26, fill: mode === 'label' ? 'var(--accent)' : '#ffffff', opacity: mode === 'label' ? 0.9 : 1 });
    if (mode === 'label') { shape('path', { d: 'M30 57 q-8 0 -8 -6 M90 57 q8 0 8 -6', stroke: 'var(--accent)', 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }); shape('path', { d: 'M22 51 l-3 4 m3 -4 l4 2 M98 51 l3 4 m-3 -4 l-4 2', stroke: 'var(--accent)', 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }); }
    else { shape('ellipse', { cx: 60, cy: 12, rx: 16, ry: 9, fill: 'var(--accent)' }); shape('path', { d: 'M38 16 q-10 -6 -4 -14 M82 16 q10 -6 4 -14', stroke: 'var(--accent)', 'stroke-width': 2.5, fill: 'none', 'stroke-dasharray': '3 4' }); }
    return s;
  }
  let arScript = null;
  function openAr(opts) {
    if (window.FWAR) return window.FWAR.open(opts);
    arScript ??= new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = '/static/ar.js'; sc.onload = res; sc.onerror = () => { arScript = null; rej(new Error('ar')); }; document.head.append(sc); });
    arScript.then(() => window.FWAR.open(opts)).catch(() => toast('AR couldn’t load. Check your connection.'));
  }

  // ---------- the prize game (only when the company turns it on) ----------
  // Engaging with an ad (its page, its video, its AR) is a chance. A winning chance shows a red ball that bounces
  // across the screen for about 2.5 seconds; tap it to collect. Miss it and we say what the prize was.
  // ball:start (the same path the server checks taps against, src/modules/lottery/ball.ts)
  function ballAt(seed, tMs, durationMs) {
    let a = seed >>> 0;
    const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const fromLeft = rnd() < 0.5, bounces = 3 + Math.floor(rnd() * 3), floor = 0.55 + rnd() * 0.3, height = 0.25 + rnd() * 0.2;
    const p = Math.max(0, Math.min(1, tMs / durationMs));
    const x = fromLeft ? -0.06 + p * 1.12 : 1.06 - p * 1.12;
    const y = floor - Math.abs(Math.sin(Math.PI * bounces * p)) * height * (1 - 0.45 * p);
    return { x, y };
  }
  // ball:end
  const game = { info: null, ctx: null, asked: new Set(), queue: [], busy: false };
  const pendingKey = 'fw_lottery_pending';
  const pending = { all() { try { return JSON.parse(store.get(pendingKey) || '[]'); } catch { return []; } }, add(id) { pending.save([...pending.all().filter((x) => x !== id), id].slice(-10)); }, drop(id) { pending.save(pending.all().filter((x) => x !== id)); }, save(a) { store.set(pendingKey, JSON.stringify(a)); } };

  /** Ask for a chance for something this person really did. Only once per kind of engagement per ad. */
  function play(via, ctx) {
    ctx = ctx || game.ctx;
    if (!game.info || !ctx || previewMode || game.asked.has(`${ctx.targetKey}|${via}`)) return;
    game.asked.add(`${ctx.targetKey}|${via}`);
    api('POST', '/v1/public/lottery/chances', { target: ctx.targetKey, viewerKey, via }).then((r) => {
      if (!r?.ball || !r.chanceId) return;
      pending.add(r.chanceId);
      setTimeout(() => { game.queue.push({ id: r.chanceId, ...r.ball }); nextBall(); }, r.ball.inMs);
    }).catch(() => {});
  }
  // AR that opens outside the page (Apple's or Google's): the chance starts once the person is back.
  function playWhenBack(via, ctx) {
    if (document.visibilityState === 'visible' && document.hasFocus()) { setTimeout(() => { if (document.visibilityState === 'visible') play(via, ctx); else playWhenBack(via, ctx); }, 1200); return; }
    const back = () => { if (document.visibilityState !== 'visible') return; document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back); play(via, ctx); };
    document.addEventListener('visibilitychange', back); window.addEventListener('focus', back);
  }

  function nextBall() {
    if (game.busy || !game.queue.length) return;
    game.busy = true;
    const b = game.queue.shift();
    const ball = h('button', { type: 'button', class: 'fw-ball', 'aria-label': 'A red ball! Tap it to win' }, h('i'));
    document.body.append(ball);
    const start = performance.now();
    let done = false;
    const place = (t) => { const p = ballAt(b.seed, t, b.durationMs); ball.style.transform = `translate(${p.x * innerWidth}px, ${p.y * innerHeight}px)`; };
    const frame = () => {
      if (done) return;
      const t = performance.now() - start;
      if (t > b.durationMs) { finish(); api('GET', `/v1/public/lottery/chances/${b.id}?viewer=${encodeURIComponent(viewerKey)}`).then((r) => showResult(b.id, r)).catch(() => {}); return; }
      place(t); requestAnimationFrame(frame);
    };
    const finish = () => { done = true; ball.remove(); game.busy = false; };
    ball.addEventListener('pointerdown', (e) => {
      if (done) return;
      e.preventDefault(); e.stopPropagation();
      const tap = { tMs: Math.round(performance.now() - start), x: e.clientX / innerWidth, y: e.clientY / innerHeight };
      finish();
      api('POST', `/v1/public/lottery/chances/${b.id}/claim`, { viewerKey, tap }).then((r) => showResult(b.id, r)).catch(() => toast('That didn’t go through. Check your connection.'));
    });
    place(0); requestAnimationFrame(frame);
    if (navigator.vibrate) try { navigator.vibrate(30); } catch {}
  }

  function showResult(id, r) {
    if (!r || r.status === 'waiting' || r.status === 'none') { if (r?.status === 'none') pending.drop(id); return; }
    pending.drop(id);
    const won = r.status === 'won';
    if (won) confetti();
    const close = () => { sheet.remove(); nextBall(); };
    const copy = won ? h('button', { type: 'button', class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(r.claimCode); toast('Code copied'); } catch { toast(r.claimCode); } } }, 'Copy my code') : null;
    const sheet = h('div', { class: 'fw-prize', role: 'dialog', 'aria-modal': 'true', 'aria-label': won ? 'You won' : 'You missed it' },
      h('div', { class: 'card' },
        h('div', { class: `dot${won ? '' : ' gone'}`, 'aria-hidden': 'true' }),
        h('h2', { text: won ? 'You caught it!' : 'So close. You missed it.' }),
        h('p', { text: won ? `You won ${r.prize.name}.` : `The red ball went by. The prize was ${r.prize.name}.` }),
        r.prize.description && won ? h('p', { class: 'muted', text: r.prize.description }) : null,
        won ? h('div', { class: 'code', text: r.claimCode }) : h('p', { class: 'muted', text: 'Keep an eye out next time: watching an ad, its video or its AR can bring the ball back.' }),
        copy,
        h('button', { type: 'button', class: `btn${won ? ' secondary' : ''}`, onclick: close }, won ? 'Done' : 'Got it')));
    document.body.append(sheet);
  }

  // A ball that came while the person was away (or the page closed) is still a miss they should hear about.
  function checkPending() {
    for (const id of pending.all()) api('GET', `/v1/public/lottery/chances/${id}?viewer=${encodeURIComponent(viewerKey)}`).then((r) => showResult(id, r)).catch((e) => { if (e.status === 404) pending.drop(id); });
  }
  function gameNote(info) {
    return h('div', { class: 'game-note' }, h('span', { class: 'mini-ball', 'aria-hidden': 'true' }),
      h('span', {}, h('b', { text: 'Watch for the red ball. ' }), `Tap it before it’s gone to win a prize. ${info.rulesText ? info.rulesText + ' ' : ''}`, info.rulesUrl ? h('a', { href: info.rulesUrl, target: '_blank', rel: 'noopener', text: 'Official rules' }) : null));
  }

  function confetti() {
    const box = h('div', { class: 'confetti', 'aria-hidden': 'true' });
    const colors = ['#7FC6EA', '#F2C14E', '#F7C6D4', '#FFFFFF', '#1E7DB8', '#D9AE4A'];
    for (let i = 0; i < 80; i++) box.append(h('i', { style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-duration:${2.2 + Math.random() * 2}s;animation-delay:${Math.random() * .6}s;transform:rotate(${Math.random() * 360}deg)` }));
    document.body.append(box);
    setTimeout(() => box.remove(), 5200);
  }

  // The bottle's black panel, carried onto the page: who made it, what it gave, and its receipt.
  function panel(f, target) {
    const facts = [];
    if (f.ads !== null) facts.push(h('div', { text: f.ads === 0 ? (target.kind === 'box-face' ? 'This box carries our own message.' : 'This bottle carries our own message.') : `This ${target.kind === 'box-face' ? 'box' : 'bottle'} has ${f.ads} ${f.ads === 1 ? 'ad' : 'ads'}. They paid for your water.` }));
    else facts.push(h('div', { text: 'A custom bottle, designed and paid for by the sender.' }));
    if (f.giving) facts.push(h('div', { class: 'giving', text: f.giving }));
    if (f.story) {
      const m = f.story.minutesSincePrint;
      const ago = m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
      facts.push(h('div', { class: 'story', text: `Genuine. Printed fresh at ${f.story.place}, ${ago}.${f.story.passedOn ? ` It’s been passed along: ${f.story.people} people have scanned it.` : ''}` }));
    }
    const links = [];
    if (f.receiptUrl) links.push(h('a', { href: fixture ? '#' : f.receiptUrl, text: 'See this bottle’s receipt' }));
    if (f.packUrl && target.kind !== 'slot') links.push(h('a', { href: fixture ? '#' : f.packUrl, text: 'Everything in this pack' }));
    const [top, bottom] = [f.brand.logoTop, f.brand.logoBottom];
    return h('footer', { class: 'panel' },
      h('div', { class: 'logo', 'aria-label': `${top}${bottom}` }, h('span', { text: top }), h('span', { text: bottom })),
      h('div', { class: 'facts' }, facts),
      links.length ? h('nav', {}, links) : null,
      f.brand.tagline && h('div', { class: 'tagline', text: f.brand.tagline }));
  }

  // ---------- receipt ----------
  async function receiptPage(unitId) {
    let r;
    try { r = await api('GET', `/v1/public/receipts/${unitId}`); } catch { return fail('No receipt here', 'This bottle may never have been printed.'); }
    const e = r.earnedCents;
    const rows = [['Ads printed on it', e.print], ['Scans', e.scans], ['AR launches', e.ar], ['Sales it led to (commission)', e.commission], ['Custom design', e.custom]].filter(([, v]) => v > 0);
    document.title = `Receipt · ${r.company}`;
    app.replaceChildren(
      h('header', { class: 'topbar' }, h('div', { class: 'who' }, h('b', { text: `${r.company} · open books` }))),
      h('section', { class: 'sheet' },
        h('p', { style: 'margin:8px 0 0;color:var(--muted)', text: 'This bottle earned' }),
        h('div', { class: 'big', text: money(e.total) }),
        r.givingOn ? h('p', { style: 'margin:0;font-weight:700', text: `and gave ${money(r.donatedCents)} to charity.` }) : null,
        h('div', { class: 'rows' }, rows.map(([k, v]) => h('div', {}, h('span', { text: k }), h('span', { text: money(v) }))), h('div', {}, h('span', { text: 'Printed' }), h('span', { text: new Date(r.printedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) })), h('div', {}, h('span', { text: 'Where' }), h('span', { text: r.place })), h('div', {}, h('span', { text: 'Ads on it' }), h('span', { text: String(r.ads) }))),
        h('p', { style: 'color:var(--muted);font-size:14px', text: 'Every cent comes from the books and can’t be edited after the fact. Scans that didn’t load, and repeat scans, are never billed.' })),
    );
  }

  // ---------- pack ----------
  async function packPage(packId) {
    let p;
    try { p = await api('GET', `/v1/public/packs/${packId}`); } catch { return fail('Pack not found', 'Check the code on the box and try again.'); }
    document.title = `Your ${p.size} pack · ${p.company}`;
    app.replaceChildren(
      h('header', { class: 'topbar' }, h('div', { class: 'who' }, h('b', { text: p.company }))),
      h('section', { class: 'sheet' },
        h('h1', { class: 'big', style: 'font-size:32px', text: `Your ${p.size} pack` }),
        p.givingOn ? h('p', { style: 'margin:0;font-weight:700', text: `It gave ${money(p.donatedCents)} to charity.` }) : null,
        h('p', { style: 'color:var(--muted)', text: `Paid for by ${p.advertisers.join(', ') || p.company}. Every bottle is different.` }),
        h('h2', { class: 'section-title', text: 'On the box' }),
        h('div', { class: 'list' }, p.faces.map((f) => h('a', { href: f.url }, h('span', { text: f.advertiser }), h('span', { style: 'color:var(--muted)', text: f.face })))),
        h('h2', { class: 'section-title', style: 'margin-top:20px', text: 'The bottles' }),
        h('div', { class: 'list' }, p.bottles.map((b, i) => h('a', { href: b.receiptUrl }, h('span', { text: `Bottle ${i + 1}` }), h('span', { style: 'color:var(--muted)', text: `${b.ads} ${b.ads === 1 ? 'ad' : 'ads'} · receipt` }))))),
    );
  }

  // The advertiser portal shows a draft's scan page here before it exists. Nothing is recorded or billed.
  if (path === '/preview/scan') {
    previewMode = true;
    window.addEventListener('message', (e) => {
      if ((!fixture && e.origin !== location.origin) || !e.data || e.data.type !== 'fw-preview') return;
      if (!e.data.doc) { app.replaceChildren(h('div', { class: 'error' }, h('h1', { text: 'Scan page' }), h('p', { text: 'Tell the assistant what should open when people scan your ad.' }))); return; }
      renderExperience({ doc: e.data.doc, footer: e.data.footer, targetKey: 's:preview:0', viewerKey }, { kind: 'slot', unitId: 'preview', slot: 0 }, false);
    });
    window.parent?.postMessage({ type: 'fw-preview-ready' }, fixture ? '*' : location.origin);
    return;
  }
  if (m.slot) experiencePage({ kind: 'slot', unitId: m.slot[1], slot: Number(m.slot[2]) });
  else if (m.box) experiencePage({ kind: 'box-face', packId: m.box[1], face: m.box[2] });
  else if (m.receipt) receiptPage(m.receipt[1]);
  else if (m.pack) packPage(m.pack[1]);
  else fail('Nothing here', 'Scan a code on a bottle or box.');
})();
