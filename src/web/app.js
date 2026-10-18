// The FreeWater app. One tap for free water, the countdown, your bottles and their AR, saved offers,
// your account, and designing your own bottle. Plain JavaScript, no build step; everything goes through the public API.
(() => {
  'use strict';
  const fixture = window.__FW_APP_FIXTURE__; // only in the offline preview
  const root = document.getElementById('root');

  // ---------- helpers ----------
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
  const svgNS = 'http://www.w3.org/2000/svg';
  const icon = (d, cls = 'ico') => { const s = document.createElementNS(svgNS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', cls); for (const part of d.split('|')) { const p = document.createElementNS(svgNS, 'path'); p.setAttribute('d', part); s.append(p); } return s; };
  const I = {
    home: 'M3 11l9-7 9 7|M5 10v10h14V10',
    pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z|M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
    scan: 'M4 8V5a1 1 0 0 1 1-1h3|M16 4h3a1 1 0 0 1 1 1v3|M20 16v3a1 1 0 0 1-1 1h-3|M8 20H5a1 1 0 0 1-1-1v-3|M8 9h3v3H8z|M13 12h3v3h-3z',
    saved: 'M6 3h12v18l-6-4-6 4V3Z',
    me: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z|M4 21a8 8 0 0 1 16 0',
    back: 'M15 18l-6-6 6-6',
    ar: 'M12 2 3 7v10l9 5 9-5V7l-9-5Z|M12 22V12|M3 7l9 5 9-5',
    open: 'M7 17 17 7|M9 7h8v8',
    drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z',
    brush: 'M14 4l6 6-9 9H5v-6l9-9Z',
    check: 'M5 12l5 5L20 7',
    trash: 'M4 7h16|M10 11v6|M14 11v6|M6 7l1 13h10l1-13|M9 7V4h6v3',
  };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };
  const money = (c) => (c < 100 ? `${c}¢` : `$${(c / 100).toFixed(2)}`);
  const svgData = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const rid = () => { const a = new Uint8Array(9); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
  const toastEl = h('div', { class: 'toast', role: 'status' });
  document.body.append(toastEl);
  let toastT;
  const toast = (m) => { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2600); };

  // ---------- state and API ----------
  const state = { token: store.get('fw_token'), me: null, config: null, printing: null, path: fixture ? fixture.start : location.pathname + location.search };
  class ApiError extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; } }
  async function api(method, url, body) {
    if (fixture) return fixture.api(method, url, body, state);
    const res = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && state.token) { signOutLocal(); }
    const type = res.headers.get('content-type') || '';
    const data = res.status === 204 ? null : type.includes('json') ? await res.json().catch(() => null) : await res.text();
    if (!res.ok) throw new ApiError(res.status, data?.error?.code, data?.error?.message || 'Something went wrong. Try again.');
    return data;
  }
  function signOutLocal() { state.token = null; state.me = null; store.set('fw_token', null); }
  async function loadMe() {
    if (!state.token) return null;
    if (state.me) return state.me;
    try { state.me = await api('GET', '/v1/me'); } catch { state.me = null; }
    return state.me;
  }

  // ---------- routing ----------
  const routes = [
    [/^\/app\/?$/, homeScreen],
    [/^\/app\/machines$/, machinesScreen],
    [/^\/app\/m\/([A-Za-z0-9_-]+)$/, machineScreen],
    [/^\/app\/scan$/, scanScreen],
    [/^\/app\/saved$/, savedScreen],
    [/^\/app\/me$/, meScreen],
    [/^\/app\/bottles\/([A-Za-z0-9_-]+)$/, bottleScreen],
    [/^\/app\/design$/, designScreen],
    [/^\/app\/printing$/, printingScreen],
  ];
  let stopCurrent = null;
  function go(path, replace) {
    state.path = path;
    if (!fixture) history[replace ? 'replaceState' : 'pushState'](null, '', path);
    render();
  }
  window.addEventListener('popstate', () => { state.path = location.pathname + location.search; render(); });
  const link = (path, attrs, ...kids) => h('a', { href: fixture ? '#' : path, ...attrs, onclick: (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(path); } }, ...kids);
  const query = () => new URLSearchParams(state.path.split('?')[1] || '');
  async function render() {
    if (stopCurrent) { stopCurrent(); stopCurrent = null; }
    const [pathname] = state.path.split('?');
    for (const [re, fn] of routes) {
      const m = re.exec(pathname);
      if (m) {
        try { await fn(...m.slice(1)); } catch (e) { root.replaceChildren(screen({ nav: true }, h('div', { class: 'notice err', text: e.message }))); }
        window.scrollTo(0, 0);
        return;
      }
    }
    go('/app', true);
  }
  const screen = (opts, ...kids) => {
    const s = h('main', { class: `screen${opts.dark ? ' dark' : ''}${opts.nav ? '' : ' no-nav'}` }, ...kids);
    root.replaceChildren(...[s, opts.nav ? nav(opts.nav) : null].filter(Boolean));
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', opts.dark ? '#000000' : '#FFFFFF');
    return s;
  };
  const nav = (active) => h('nav', { class: 'nav', 'aria-label': 'Main' }, h('div', { class: 'nav-inner' },
    [['home', '/app', 'Home', I.home], ['machines', '/app/machines', 'Machines', I.pin], ['scan', '/app/scan', 'Scan', I.scan], ['saved', '/app/saved', 'Saved', I.saved], ['me', '/app/me', 'Me', I.me]].map(([id, path, label, ic]) =>
      link(path, { class: id === 'scan' ? 'scan' : '', 'aria-current': active === id ? 'page' : null }, id === 'scan' ? h('span', { class: 'bubble' }, icon(ic)) : icon(ic), label))));
  const backBar = (title, sub, to) => h('div', { class: 'title-row' }, h('button', { class: 'back', type: 'button', 'aria-label': 'Back', onclick: () => (to ? go(to) : fixture || history.length < 2 ? go('/app') : history.back()) }, icon(I.back)), h('div', {}, h('h1', { text: title }), sub && h('p', { text: sub })));
  const initials = (me) => (me?.displayName ? me.displayName.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') : (me?.email || '').slice(0, 1) || '#').toUpperCase();

  // ---------- sign in ----------
  function signIn(reason) {
    return new Promise((resolve) => {
      let channel = 'email', to = '';
      const close = (ok) => { wrap.remove(); resolve(ok); };
      const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => e.target === wrap && close(false) });
      const body = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'si-title' });
      wrap.append(body);
      document.body.append(wrap);
      const step1 = () => {
        const input = h('input', { class: 'input', id: 'si-to', type: channel === 'email' ? 'email' : 'tel', autocomplete: channel === 'email' ? 'email' : 'tel', inputmode: channel === 'email' ? 'email' : 'tel', placeholder: channel === 'email' ? 'you@example.com' : '(512) 555-0142', value: to });
        const err = h('div', { class: 'notice err', hidden: true });
        const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Send my code by' },
          h('button', { type: 'button', 'aria-pressed': String(channel === 'email'), onclick: () => { channel = 'email'; to = ''; step1(); } }, 'Email'),
          h('button', { type: 'button', 'aria-pressed': String(channel === 'sms'), onclick: () => { channel = 'sms'; to = ''; step1(); } }, 'Text message'));
        const send = h('button', { class: 'btn', type: 'submit' }, 'Send my code');
        body.replaceChildren(
          h('h2', { id: 'si-title', text: 'Sign in' }),
          h('p', { class: 'muted', style: 'margin:0', text: reason || 'We’ll send you a 6-digit code. No password.' }),
          seg,
          h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => {
            e.preventDefault(); to = input.value.trim(); if (!to) return;
            send.disabled = true; err.hidden = true;
            try { await api('POST', '/v1/auth/start', { companyId: state.config.companyId, channel, to }); step2(); }
            catch (x) { err.textContent = x.message; err.hidden = false; send.disabled = false; }
          } }, h('div', { class: 'field' }, h('label', { for: 'si-to', text: channel === 'email' ? 'Your email' : 'Your mobile number' }), input), err, send),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => close(false) }, 'Not now'),
          h('p', { class: 'small muted center', style: 'margin:0', text: 'New here? Signing in makes your account. Your privacy choices all start off.' }));
        setTimeout(() => input.focus(), 50);
      };
      const step2 = () => {
        const input = h('input', { class: 'input code-input', id: 'si-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]*', 'aria-label': '6-digit code' });
        const err = h('div', { class: 'notice err', hidden: true });
        const ok = h('button', { class: 'btn', type: 'submit' }, 'Sign in');
        body.replaceChildren(
          h('h2', { id: 'si-title', text: 'Enter your code' }),
          h('p', { class: 'muted', style: 'margin:0', text: `We sent it to ${to}. It works for 10 minutes.` }),
          h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => {
            e.preventDefault(); ok.disabled = true; err.hidden = true;
            try {
              const r = await api('POST', '/v1/auth/verify', { companyId: state.config.companyId, channel, to, code: input.value.trim() });
              state.token = r.token; store.set('fw_token', r.token); state.me = null; await loadMe();
              toast(r.isNew ? 'Welcome to FreeWater' : 'Signed in'); close(true);
            } catch (x) { err.textContent = x.message; err.hidden = false; ok.disabled = false; }
          } }, input, err, ok),
          h('button', { class: 'btn secondary', type: 'button', onclick: step1 }, 'Use a different email or number'));
        setTimeout(() => input.focus(), 50);
      };
      step1();
    });
  }
  async function ensureSignedIn(reason) {
    if (state.token && (await loadMe())) return true;
    return signIn(reason);
  }

  // ---------- home ----------
  async function homeScreen() {
    const me = await loadMe();
    const [machines, mine, saved] = await Promise.all([
      api('GET', `/v1/public/companies/${state.config.companyId}/machines`).catch(() => []),
      me ? api('GET', '/v1/me/bottles').catch(() => null) : null,
      me ? api('GET', '/v1/me/saved').catch(() => []) : [],
    ]);
    const stats = mine?.stats ?? { bottles: 0, donatedCents: 0, savedCents: 0 };
    const m0 = machines[0];
    screen({ nav: 'home' },
      h('div', { class: 'topbar' }, h('div', { class: 'logo', 'aria-label': 'freewater' }, h('span', { text: 'free' }), h('span', { text: 'water' })),
        me ? link('/app/me', { class: 'avatar', 'aria-label': 'Your account' }, initials(me)) : h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { if (await signIn()) render(); } }, 'Sign in')),
      h('section', { class: 'hero-card' },
        h('div', { class: 'headline' }, 'Save money.', h('span', { text: 'Drink FreeWater.' })),
        me ? h('div', { class: 'stats' },
          h('div', {}, h('b', { text: String(stats.bottles) }), h('span', { text: stats.bottles === 1 ? 'bottle' : 'bottles' })),
          h('div', {}, h('b', { text: money(stats.donatedCents) }), h('span', { text: 'to charity' })),
          h('div', {}, h('b', { text: money(stats.savedCents) }), h('span', { text: 'saved' })))
          : h('p', { style: 'margin:0;opacity:.85', text: 'Free spring water, paid for by the ads on the bottle. Every bottle gives to charity.' })),
      link('/app/scan', { class: 'tile blue' }, h('span', { class: 'tile-ico' }, icon(I.scan)), h('span', { class: 'grow' }, h('b', { text: 'Scan a bottle' }), h('span', { text: 'Open the AR printed on any FreeWater' }))),
      m0 && link(`/app/m/${m0.id}`, { class: 'tile ice' }, h('span', { class: 'grow' }, h('b', { text: `${m0.id} on ${m0.name}` }), h('span', { class: 'muted small', text: m0.address || m0.city })), h('span', { class: 'go', text: 'Get one' })),
      me && h('h2', { class: 'section' }, 'Your bottles'),
      me && (mine?.bottles.length
        ? h('div', { class: 'rail' }, mine.bottles.slice(0, 8).map((b) => bottleCard(b)))
        : h('div', { class: 'empty', text: 'Bottles you get from a machine show up here, with their AR and what they gave.' })),
      h('h2', { class: 'section' }, 'Saved from your scans', saved.length ? link('/app/saved', {}, 'See all') : null),
      saved.length ? h('div', { class: 'rail' }, saved.slice(0, 10).map(savedCard)) : h('div', { class: 'empty', text: me ? 'Tap “Save” on any ad you scan and it waits for you here.' : 'Sign in, then tap “Save” on any ad you scan. It waits for you here.' }),
    );
  }
  function bottleCard(b) {
    const strip = h('div', { class: 'strip' });
    labelImage(b).then((src) => { if (src) strip.style.backgroundImage = `url("${src}")`; });
    return link(`/app/bottles/${b.id}`, { class: 'bottle-card' }, strip,
      h('b', { text: b.kind === 'custom' ? 'Your design' : `${b.ads.filter((a) => !a.isHouse).length} ads · gave ${money(b.donatedCents)}` }),
      h('span', { class: 'small muted', text: `${new Date(b.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${b.place}` }));
  }
  function savedCard(s) {
    const t = s.theme || {};
    return h('a', { class: 'saved-card', href: fixture ? '#' : s.url, onclick: fixture ? (e) => e.preventDefault() : null },
      h('div', { class: 'band', style: `background:${t.button || '#000'};color:${t.buttonText || '#fff'}`, text: s.owner }),
      h('div', { class: 'info' }, h('b', { text: s.title }), s.code ? h('span', { class: 'muted', text: `Code ${s.code}` }) : h('span', { class: 'muted', text: 'Open it again' })));
  }
  const labelCache = new Map();
  async function labelImage(b) {
    if (labelCache.has(b.id)) return labelCache.get(b.id);
    try { const svg = await api('GET', b.labelUrl); const src = svgData(svg); labelCache.set(b.id, src); return src; } catch { return null; }
  }

  // ---------- machines ----------
  async function machinesScreen() {
    const list = await api('GET', `/v1/public/companies/${state.config.companyId}/machines`);
    screen({ nav: 'machines' },
      h('h1', { class: 'display', style: 'font-size:26px', text: 'Machines' }),
      h('p', { class: 'muted', style: 'margin:-8px 0 0', text: 'Each one prints your bottle fresh, with its own ads, in about half a minute.' }),
      h('div', {}, list.map((m) => link(`/app/m/${m.id}`, { class: 'list-row' }, h('span', { class: 'tile-ico', style: 'background:var(--ice);width:44px;height:44px;border-radius:12px;display:grid;place-items:center' }, icon(I.drop)),
        h('span', { class: 'grow' }, h('b', { text: `${m.id} · ${m.name}` }), h('span', { class: 'small muted', text: [m.address || m.city, m.giving].filter(Boolean).join(' · ') })), h('span', { class: 'go', style: 'color:var(--link);font-weight:700', text: 'Open' })))),
      h('p', { class: 'small muted', text: 'At a machine, scan the code on its screen to get your bottle from your phone.' }));
  }

  // ---------- one machine: Get my free water ----------
  const codeKey = (id) => `fw_code_${id}`;
  function presenceCode(id) {
    const fromUrl = query().get('c');
    if (fromUrl) { try { sessionStorage.setItem(codeKey(id), JSON.stringify({ c: fromUrl, at: Date.now() })); } catch {} return fromUrl; }
    try { const s = JSON.parse(sessionStorage.getItem(codeKey(id)) || 'null'); if (s && Date.now() - s.at < 80_000) return s.c; } catch {}
    return null;
  }
  async function machineScreen(id) {
    const m = await api('GET', `/v1/public/machines/${id}`);
    const code = presenceCode(id);
    const bottle = h('div', { class: 'bottle', 'aria-hidden': 'true' }, h('div', { class: 'cap' }), h('div', { class: 'neck' }), h('div', { class: 'body' }, h('div', { class: 'wrap' })));
    api('GET', m.sampleLabelUrl).then((svg) => { const w = bottle.querySelector('.wrap'); w.style.backgroundImage = `url("${svgData(svg)}")`; w.style.backgroundPosition = '18% 0'; }).catch(() => {});
    const err = h('div', { class: 'notice err', hidden: true });
    const get = h('button', { class: 'btn', type: 'button', onclick: async () => {
      err.hidden = true;
      if (!code) { go('/app/scan'); return; }
      if (!(await ensureSignedIn('Sign in once so we can keep your free bottles fair: 3 a day.'))) return;
      get.disabled = true; get.replaceChildren(h('span', { class: 'spin' }), 'Sending to the machine');
      try {
        const r = await api('POST', '/v1/me/vends', { vendId: rid(), locationId: m.id, presenceCode: code });
        state.printing = { ...r, machine: m };
        go('/app/printing');
      } catch (x) { err.textContent = x.message; err.hidden = false; get.disabled = false; get.replaceChildren('Get my free water'); }
    } }, 'Get my free water');
    screen({ nav: false },
      backBar(`${m.id} · ${m.name}`, m.address || m.city, '/app'),
      h('div', { class: 'sample' }, bottle, h('span', { class: 'small muted', text: 'Sample label. Yours prints fresh with different ads.' })),
      h('h1', { class: 'display', text: m.pricing === 'free' ? 'Free spring water' : 'Spring water' }),
      h('p', { class: 'muted', style: 'margin:-6px 0 0;font-size:17px', text: `16 oz aluminum bottle, ready in about ${m.printSeconds} seconds. Ads pay for it${m.giving ? `, and ${m.giving.replace(/ goes/, ' goes')}` : ''}.` }),
      !code && h('div', { class: 'notice warn' }, h('b', { text: 'Scan the code on the machine’s screen. ' }), 'It proves you’re here, so nobody can take bottles from far away.'),
      err,
      get,
      link(`/app/design?m=${m.id}`, { class: 'btn secondary' }, 'Design my own bottle'),
      h('p', { class: 'small muted center', style: 'margin:-6px 0 0', text: `Your own design is paid and ad-free · ${money(m.customPriceCents)}` }));
  }

  // ---------- printing: the countdown, with an ad ----------
  async function printingScreen() {
    const p = state.printing;
    if (!p) { go('/app', true); return; }
    const total = p.countdown.seconds;
    let left = total;
    const C = 2 * Math.PI * 50;
    const arc = document.createElementNS(svgNS, 'circle');
    for (const [k, v] of Object.entries({ cx: 56, cy: 56, r: 50, fill: 'none', stroke: '#7FC6EA', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-dasharray': C, 'stroke-dashoffset': 0 })) arc.setAttribute(k, v);
    const track = document.createElementNS(svgNS, 'circle');
    for (const [k, v] of Object.entries({ cx: 56, cy: 56, r: 50, fill: 'none', stroke: '#2a2a2a', 'stroke-width': 8 })) track.setAttribute(k, v);
    const ring = document.createElementNS(svgNS, 'svg'); ring.setAttribute('viewBox', '0 0 112 112'); ring.append(track, arc);
    const num = h('b', { text: String(left) });
    const title = h('h1', { text: 'Your bottle is printing' });
    const sub = h('p', { text: `It drops into the tray in ${left} seconds` });
    const bar = h('i');
    const pct = h('span', { text: '0%' });
    const ads = p.bottle.ads.filter((a) => !a.isHouse).length;
    const ad = p.countdown.ad;
    const done = h('button', { class: 'btn outline-light', type: 'button', onclick: () => go(`/app/bottles/${p.bottle.id}`) }, 'Got it? See your bottle');
    screen({ dark: true },
      h('div', { class: 'printing-head' }, h('div', { class: 'ring' }, ring, num), h('div', {}, title, sub)),
      ad && h('div', { class: 'ad-card' }, h('img', { src: svgData(ad.art), alt: `Ad from ${ad.advertiser}` }), h('span', { class: 'chip', text: 'Ad' }),
        ad.target && h('div', { class: 'actions' }, h('button', { class: 'btn blue', type: 'button', onclick: async (e) => {
          const b = e.currentTarget;
          if (!(await ensureSignedIn())) return;
          try { await api('POST', '/v1/me/saved', { target: ad.target }); b.replaceChildren(icon(I.check), 'Saved'); b.disabled = true; toast('Saved. It’s on your Home screen.'); } catch (x) { toast(x.message); }
        } }, icon(I.saved), `Save this from ${ad.advertiser}`))),
      h('div', {}, h('div', { class: 'progress-row' }, h('span', { text: p.bottle.kind === 'custom' ? 'Printing your design' : `Printing ${ads} ${ads === 1 ? 'ad' : 'ads'} on your label` }), pct), h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Printing' }, bar)),
      done);
    const t = setInterval(() => {
      left = Math.max(0, left - 1);
      num.textContent = String(left);
      arc.setAttribute('stroke-dashoffset', String(C * (1 - left / total)));
      const pc = Math.round(((total - left) / total) * 100);
      bar.style.width = `${pc}%`; pct.textContent = `${pc}%`;
      if (left > 0) sub.textContent = `It drops into the tray in ${left} second${left === 1 ? '' : 's'}`;
      else { title.textContent = 'It’s in the tray'; sub.textContent = 'Take it, and scan any ad on it to open its AR.'; clearInterval(t); }
    }, 1000);
    stopCurrent = () => clearInterval(t);
  }

  // ---------- one bottle: its ads and their AR ----------
  async function bottleScreen(id) {
    const b = await api('GET', `/v1/me/bottles/${id}`);
    const bottle = h('div', { class: 'bottle', 'aria-hidden': 'true' }, h('div', { class: 'cap' }), h('div', { class: 'neck' }), h('div', { class: 'body' }, h('div', { class: 'wrap' })));
    const strip = h('img', { class: 'strip-img', alt: 'Your bottle’s full label, laid flat' });
    labelImage(b).then((src) => { if (!src) return; strip.src = src; const w = bottle.querySelector('.wrap'); w.style.backgroundImage = `url("${src}")`; w.style.backgroundPosition = '18% 0'; });
    const open = (a) => (fixture ? (e) => { e.preventDefault(); toast(`Opens ${a.name}${a.ar ? ' in AR' : ''}`); } : null);
    screen({ nav: 'home' },
      backBar(b.kind === 'custom' ? 'Your design' : 'Your bottle', `${new Date(b.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${b.place}`),
      h('div', { class: 'sample' }, bottle),
      h('h2', { class: 'section' }, b.kind === 'custom' ? 'What it opens' : 'Tap an ad to open it'),
      h('div', {}, b.ads.map((a) => h('div', { class: 'ad-row' },
        h('span', { class: 'size', title: `${a.sixths}/6 of the label`, text: `${a.sixths}/6` }),
        h('span', { class: 'grow' }, h('b', { text: a.name }), h('span', { class: 'small muted', text: a.isHouse ? 'From FreeWater' : a.experience })),
        a.ar ? h('a', { class: 'pill', href: fixture ? '#' : a.url, onclick: open(a) }, icon(I.ar), 'AR')
             : h('a', { class: 'pill light', href: fixture ? '#' : a.url, onclick: open(a) }, 'Open')))),
      h('div', { class: 'notice' }, b.kind === 'custom'
        ? `A custom bottle has no ads.${b.giving ? ` It gave ${money(b.donatedCents)} to charity.` : ''} `
        : `This bottle earned ${money(b.earnedCents)} from its ads so far${b.giving ? ` and gave ${money(b.donatedCents)} to charity` : ''}. `, h('a', { href: fixture ? '#' : b.receiptUrl, text: 'See its receipt' })),
      h('h2', { class: 'section' }, 'The whole label'),
      strip);
  }

  // ---------- scan ----------
  async function scanScreen() {
    const video = h('video', { playsinline: true, muted: true, autoplay: true });
    const status = h('p', { class: 'muted center', style: 'margin:0', text: 'Point at the code on a bottle, a box, or a machine’s screen.' });
    const cam = h('div', { class: 'camera' }, video, h('div', { class: 'frame' }));
    screen({ nav: 'scan' }, h('h1', { class: 'display', style: 'font-size:26px', text: 'Scan' }), cam, status,
      h('p', { class: 'small muted center', text: 'You can also scan with your phone’s own camera. It opens the same page.' }));
    let stream, raf, stopped = false;
    stopCurrent = () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
    if (fixture || !navigator.mediaDevices?.getUserMedia) { cam.replaceChildren(h('div', { style: 'display:grid;place-items:center;height:100%;color:#fff;padding:24px;text-align:center', text: 'The camera opens here on your phone.' })); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
    catch { status.textContent = 'Camera access is off. Use your phone’s camera app to scan instead.'; return; }
    if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
    video.srcObject = stream;
    const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (stopped) return;
      if (video.readyState >= 2 && window.jsQR) {
        const w = 480, hgt = Math.round((video.videoHeight / video.videoWidth) * w) || 640;
        canvas.width = w; canvas.height = hgt; ctx.drawImage(video, 0, 0, w, hgt);
        const found = window.jsQR(ctx.getImageData(0, 0, w, hgt).data, w, hgt, { inversionAttempts: 'dontInvert' });
        if (found) { const next = handleCode(found.data); if (next) { stopCurrent(); stopCurrent = null; if (next.startsWith('/app')) go(next); else location.href = next; return; } status.textContent = 'That code isn’t from FreeWater.'; }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  }
  /** Only FreeWater's own codes are followed: bottles, boxes, packs, receipts and machine screens. */
  function handleCode(text) {
    let u; try { u = new URL(text, location.href); } catch { return null; }
    const ours = u.host === location.host || state.config.hosts.includes(u.host);
    if (!ours) return null;
    if (/^\/(s\/[\w-]+\/\d|b\/[\w-]+\/(top|front|back|right|left)|p\/[\w-]+|r\/[\w-]+)$/.test(u.pathname)) return u.pathname;
    const m = /^\/app\/m\/([\w-]+)$/.exec(u.pathname);
    if (m) return `/app/m/${m[1]}${u.searchParams.get('c') ? `?c=${encodeURIComponent(u.searchParams.get('c'))}` : ''}`;
    return null;
  }

  // ---------- saved ----------
  async function savedScreen() {
    const me = await loadMe();
    if (!me) {
      screen({ nav: 'saved' }, h('h1', { class: 'display', style: 'font-size:26px', text: 'Saved' }), h('div', { class: 'empty', text: 'Sign in to keep offers, homes and stories you save from your scans.' }), h('button', { class: 'btn', type: 'button', onclick: async () => { if (await signIn()) render(); } }, 'Sign in'));
      return;
    }
    const items = await api('GET', '/v1/me/saved');
    screen({ nav: 'saved' },
      h('h1', { class: 'display', style: 'font-size:26px', text: 'Saved' }),
      items.length ? h('div', {}, items.map((s) => h('div', { class: 'list-row' },
        h('span', { class: 'swatch', style: `background:${s.theme?.button || '#000'}` }),
        h('a', { class: 'grow', href: fixture ? '#' : s.url, style: 'text-decoration:none;color:inherit' }, h('b', { text: s.title }), h('span', { class: 'small muted', text: [s.owner, s.code && `Code ${s.code}`].filter(Boolean).join(' · ') })),
        h('button', { class: 'back', type: 'button', 'aria-label': `Remove ${s.title}`, onclick: async () => { await api('DELETE', `/v1/me/saved/${s.id}`); toast('Removed'); render(); } }, icon(I.trash)))))
        : h('div', { class: 'empty', text: 'Nothing saved yet. Tap “Save” on any ad you scan.' }));
  }

  // ---------- me: account and privacy ----------
  async function meScreen() {
    const me = await loadMe();
    if (!me) {
      screen({ nav: 'me' }, h('h1', { class: 'display', style: 'font-size:26px', text: 'Me' }), h('p', { class: 'muted', text: 'Sign in to keep your bottles, saved offers and your own designs in one place.' }), h('button', { class: 'btn', type: 'button', onclick: async () => { if (await signIn()) render(); } }, 'Sign in'));
      return;
    }
    const cards = await api('GET', '/v1/me/cards').catch(() => []);
    const name = h('input', { class: 'input', id: 'me-name', value: me.displayName || '', placeholder: 'What should we call you?', autocomplete: 'name' });
    const consent = (key, title, text) => {
      const input = h('input', { type: 'checkbox', id: `c-${key}`, role: 'switch', onchange: async () => {
        try { state.me = await api('PATCH', '/v1/me', { consents: { [key]: input.checked } }); toast(input.checked ? 'Turned on' : 'Turned off'); if (key === 'personalizedOffers') render(); } catch (x) { input.checked = !input.checked; toast(x.message); }
      } });
      input.checked = !!me.consents[key];
      return h('div', { class: 'toggle' }, h('label', { class: 'grow', for: `c-${key}` }, h('b', { text: title }), h('span', { class: 'muted', text })), h('span', { class: 'switch' }, input, h('span')));
    };
    const allInterests = ['Coffee', 'Food', 'Fitness', 'Music', 'Outdoors', 'Homes', 'News', 'Sports', 'Pets', 'Tech'];
    const mine = new Set(me.interests || []);
    const confirmBox = h('div', { class: 'notice err', hidden: true }, h('p', { style: 'margin:0 0 10px', text: 'This erases your email, phone, name and choices, and signs you out everywhere. The public books keep only a random number in place of you.' }),
      h('button', { class: 'btn small', style: 'background:var(--danger)', type: 'button', onclick: async () => { await api('DELETE', '/v1/me'); signOutLocal(); toast('Your account was deleted'); go('/app'); } }, 'Yes, delete my account'));
    screen({ nav: 'me' },
      h('div', { class: 'topbar' }, h('h1', { class: 'display', style: 'font-size:26px', text: 'Me' }), h('span', { class: 'avatar', text: initials(me) })),
      h('p', { class: 'muted', style: 'margin:-8px 0 0', text: me.email || me.phone }),
      h('form', { class: 'field', onsubmit: async (e) => { e.preventDefault(); state.me = await api('PATCH', '/v1/me', { displayName: name.value.trim() || null }); toast('Saved'); } },
        h('label', { for: 'me-name', text: 'Your name' }), h('div', { style: 'display:flex;gap:8px' }, name, h('button', { class: 'btn small', type: 'submit' }, 'Save'))),
      h('h2', { class: 'section' }, 'Your privacy'),
      h('p', { class: 'small muted', style: 'margin:0', text: 'Everything starts off. Turn on only what you want.' }),
      h('div', {},
        consent('personalizedOffers', 'Offers picked for me', 'Use the interests below to choose which offers you see when you scan.'),
        consent('shareInterestsWithAdvertisers', 'Share my interests with advertisers', 'Advertisers see your interests, never your name or contact details.'),
        consent('location', 'Use my location', 'Show the nearest machines first.'),
        consent('marketing', 'News from FreeWater', 'Now and then, by email or text.')),
      me.consents.personalizedOffers && h('div', { class: 'field' }, h('label', { text: 'Your interests' }), h('div', { class: 'chips' }, allInterests.map((i) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(mine.has(i)), onclick: async (e) => {
        mine.has(i) ? mine.delete(i) : mine.add(i); e.currentTarget.setAttribute('aria-pressed', String(mine.has(i)));
        state.me = await api('PATCH', '/v1/me', { interests: [...mine] });
      } }, i)))),
      h('h2', { class: 'section' }, 'Payment'),
      cards.length ? h('div', {}, cards.map((c) => h('div', { class: 'list-row' }, h('span', { class: 'grow' }, h('b', { text: `${c.brand[0].toUpperCase()}${c.brand.slice(1)} •••• ${c.last4}` }), h('span', { class: 'small muted', text: `Expires ${c.expMonth}/${c.expYear}` })))))
        : h('div', { class: 'empty', text: 'No card saved. You only need one to design your own bottles. Free water never needs a card.' }),
      h('h2', { class: 'section' }, 'Your data'),
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
        const data = await api('GET', '/v1/me/export');
        const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'my-freewater-data.json' });
        document.body.append(a); a.click(); a.remove(); toast('Downloaded');
      } }, 'Download my data'),
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await api('POST', '/v1/auth/sign-out'); } catch {} signOutLocal(); toast('Signed out'); go('/app'); } }, 'Sign out'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => { confirmBox.hidden = false; confirmBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 'Delete my account'),
      confirmBox);
  }

  // ---------- design my own bottle ----------
  const FONTS = { Rounded: 'Comfortaa, Arial, sans-serif', Clean: "'DM Sans', Arial, sans-serif", Classic: 'Georgia, serif' };
  const BG = ['#F7C6D4', '#FFE7A3', '#BFE3F5', '#CDEBC5', '#1F2A44', '#000000', '#FFFFFF', '#E8D9C5'];
  const INK = ['#0B0B0B', '#FFFFFF', '#B8862E', '#D7262E', '#1E7DB8'];
  const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  function wrapText(text, maxChars) {
    const words = String(text).split(/\s+/).filter(Boolean); const lines = []; let line = '';
    for (const w of words) { if ((line + ' ' + w).trim().length > maxChars && line) { lines.push(line); line = w; } else line = (line + ' ' + w).trim(); }
    if (line) lines.push(line);
    return lines.slice(0, 4);
  }
  function designSvg(d, W, H, withQrHint) {
    const parts = [`<rect width="${W}" height="${H}" fill="${d.bg}"/>`];
    if (d.photo) {
      parts.push(`<image href="${d.photo}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`);
      if (d.headline || d.sub) parts.push(`<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="${d.pos === 'top' ? 0 : 0.45}" stop-color="#000" stop-opacity="${d.pos === 'top' ? 0.55 : 0}"/><stop offset="${d.pos === 'top' ? 0.55 : 1}" stop-color="#000" stop-opacity="${d.pos === 'top' ? 0 : 0.6}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#fade)"/>`);
    }
    const head = wrapText(d.headline, Math.max(10, Math.round(W / 34)));
    const sub = wrapText(d.sub, Math.max(18, Math.round(W / 15)));
    const hs = 56, ss = 26, gap = 14;
    const blockH = head.length * hs * 1.08 + (sub.length ? gap + sub.length * ss * 1.3 : 0);
    let y = d.pos === 'top' ? 60 + hs * 0.8 : d.pos === 'middle' ? (H - blockH) / 2 + hs * 0.85 : H - 40 - blockH + hs * 0.85;
    const x = 40;
    for (const l of head) { parts.push(`<text x="${x}" y="${y.toFixed(1)}" font-family="${xml(FONTS[d.font])}" font-weight="700" font-size="${hs}" fill="${d.ink}">${xml(l)}</text>`); y += hs * 1.08; }
    if (sub.length) { y += gap - hs * 0.08; for (const l of sub) { parts.push(`<text x="${x}" y="${y.toFixed(1)}" font-family="${xml(FONTS.Clean)}" font-size="${ss}" fill="${d.ink}" opacity=".9">${xml(l)}</text>`); y += ss * 1.3; } }
    if (withQrHint) parts.push(`<rect x="${W - 92}" y="${H - 92}" width="80" height="80" rx="6" fill="#fff" opacity=".92"/><text x="${W - 52}" y="${H - 47}" text-anchor="middle" font-family="Arial" font-size="13" fill="#555">QR</text>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
  }
  async function shrinkPhoto(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let q = 0.86, out = c.toDataURL('image/jpeg', q);
      while (out.length > 1_500_000 && q > 0.4) { q -= 0.12; out = c.toDataURL('image/jpeg', q); }
      return out;
    } finally { URL.revokeObjectURL(url); }
  }
  const draft = (() => { try { return JSON.parse(store.get('fw_design') || 'null'); } catch { return null; } })() || { bg: '#F7C6D4', ink: '#0B0B0B', font: 'Rounded', pos: 'bottom', headline: '', sub: '', photo: null, from: '', message: '', confetti: true };
  const saveDraft = () => { try { const { photo, ...rest } = draft; store.set('fw_design', JSON.stringify({ ...rest, photo: photo && photo.length < 1_000_000 ? photo : null })); } catch {} };

  async function designScreen() {
    const q = query();
    const machineId = q.get('m');
    const product = await api('GET', '/v1/public/products/bottle-16oz');
    const { widthPx: W, heightPx: H } = product.designArea;
    let layer = 'label';
    const preview = h('div', { class: 'design-preview', 'aria-label': 'Preview of your design' });
    const redraw = () => { preview.innerHTML = designSvg(draft, W, H, true); saveDraft(); };
    const panel = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
    const layerBtns = [['label', 'Label'], ['scan', 'Scan page']].map(([id, label]) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(id === layer), onclick: () => { layer = id; layerBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(['label', 'scan'][i] === layer))); drawPanel(); } }, label));
    const swatches = (list, key) => h('div', { class: 'colors' }, list.map((c) => h('button', { type: 'button', class: 'color', style: `background:${c}`, 'aria-label': c, 'aria-pressed': String(draft[key] === c), onclick: (e) => { draft[key] = c; e.currentTarget.parentElement.querySelectorAll('.color').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); redraw(); } })));
    const choice = (opts, key) => h('div', { class: 'chips' }, opts.map((o) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(draft[key] === o), onclick: (e) => { draft[key] = o; e.currentTarget.parentElement.querySelectorAll('.chip-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); redraw(); } }, o[0].toUpperCase() + o.slice(1))));
    const textField = (id, label, key, max, area) => { const el = h(area ? 'textarea' : 'input', { class: 'input', id, maxlength: String(max), value: area ? null : draft[key] }); if (area) el.value = draft[key]; el.addEventListener('input', () => { draft[key] = el.value; redraw(); }); return h('div', { class: 'field' }, h('label', { for: id, text: label }), el); };
    function drawPanel() {
      if (layer === 'label') {
        const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', id: 'd-photo', hidden: true, onchange: async () => { const f = file.files[0]; if (!f) return; draft.photo = await shrinkPhoto(f); redraw(); drawPanel(); } });
        panel.replaceChildren(
          textField('d-head', 'Big words', 'headline', 60), textField('d-sub', 'Small words', 'sub', 120),
          h('div', { class: 'field' }, h('label', { text: 'Photo' }), h('div', { style: 'display:flex;gap:8px' }, file, h('button', { class: 'btn small secondary', type: 'button', onclick: () => file.click() }, draft.photo ? 'Change photo' : 'Add a photo'), draft.photo && h('button', { class: 'btn small danger', type: 'button', onclick: () => { draft.photo = null; redraw(); drawPanel(); } }, 'Remove'))),
          h('div', { class: 'field' }, h('label', { text: 'Background' }), swatches(BG, 'bg')),
          h('div', { class: 'field' }, h('label', { text: 'Text color' }), swatches(INK, 'ink')),
          h('div', { class: 'field' }, h('label', { text: 'Lettering' }), choice(Object.keys(FONTS), 'font')),
          h('div', { class: 'field' }, h('label', { text: 'Words go' }), choice(['top', 'middle', 'bottom'], 'pos')));
      } else {
        const conf = h('input', { type: 'checkbox', id: 'd-conf', role: 'switch', onchange: () => { draft.confetti = conf.checked; saveDraft(); } }); conf.checked = !!draft.confetti;
        panel.replaceChildren(
          h('p', { class: 'muted', style: 'margin:0', text: 'This is what opens when someone scans your bottle.' }),
          textField('d-from', 'From', 'from', 80), textField('d-msg', 'Your message', 'message', 400, true),
          h('div', { class: 'toggle' }, h('label', { class: 'grow', for: 'd-conf' }, h('b', { text: 'Confetti' }), h('span', { class: 'muted', text: 'A burst of confetti when it opens.' })), h('span', { class: 'switch' }, conf, h('span'))));
      }
    }
    const err = h('div', { class: 'notice err', hidden: true });
    const review = h('button', { class: 'btn blue', type: 'button', onclick: async () => {
      err.hidden = true;
      if (!draft.headline && !draft.photo) { err.textContent = 'Add some words or a photo first.'; err.hidden = false; return; }
      if (!(await ensureSignedIn('Sign in to save your design and see your proof.'))) return;
      review.disabled = true;
      try {
        const experience = draft.message.trim() ? { from: draft.from.trim() || 'A friend', message: draft.message.trim(), confetti: !!draft.confetti } : undefined;
        const proof = await api('POST', '/v1/me/proofs', { productId: product.id, svg: designSvg(draft, W, H, false), ...(experience ? { experience } : {}) });
        proofScreen(proof, machineId, experience);
      } catch (x) { err.textContent = x.message; err.hidden = false; review.disabled = false; }
    } }, 'Review my proof');
    screen({ nav: false },
      backBar('Design my bottle', 'You control every part. No ads.', machineId ? `/app/m/${machineId}` : '/app'),
      preview, h('div', { class: 'layers' }, layerBtns), panel, err, review,
      h('p', { class: 'small muted center', style: 'margin:-6px 0 0', text: 'Next you’ll see exactly what prints, before you pay.' }));
    drawPanel(); redraw();
  }

  async function proofScreen(proof, machineId, experience) {
    const agree = h('input', { type: 'checkbox', id: 'agree' });
    const err = h('div', { class: 'notice err', hidden: true });
    let cards = await api('GET', '/v1/me/cards').catch(() => []);
    const cardArea = h('div', {});
    const drawCards = () => {
      cardArea.replaceChildren(cards.length
        ? h('div', { class: 'list-row' }, h('span', { class: 'grow' }, h('b', { text: `Pay with ${cards[0].brand} •••• ${cards[0].last4}` }), h('span', { class: 'small muted', text: 'Held first, charged only once it prints.' })))
        : h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, h('p', { style: 'margin:0', class: 'small' }, h('span', { class: 'test-badge', text: 'Test mode' }), ' No real money moves yet. Pick a test card:'),
          h('div', { class: 'chips' }, [['tok_visa', 'Visa 4242'], ['tok_mastercard', 'Mastercard 4444'], ['tok_declined', 'A card that declines']].map(([t, l]) => h('button', { type: 'button', class: 'chip-btn', onclick: async () => { try { await api('POST', '/v1/me/cards', { token: t }); cards = await api('GET', '/v1/me/cards'); drawCards(); } catch (x) { toast(x.message); } } }, l)))));
    };
    drawCards();
    const code = machineId ? presenceCode(machineId) : null;
    const pay = h('button', { class: 'btn', type: 'button', onclick: async () => {
      err.hidden = true;
      if (!agree.checked) { err.textContent = 'Check the box to confirm the proof looks right.'; err.hidden = false; return; }
      if (!cards.length) { err.textContent = 'Add a card first.'; err.hidden = false; return; }
      if (!machineId || !code) { err.textContent = 'Go to a machine and scan the code on its screen. Your design is saved and will be waiting.'; err.hidden = false; return; }
      pay.disabled = true; pay.replaceChildren(h('span', { class: 'spin' }), 'Paying and printing');
      try {
        const r = await api('POST', '/v1/me/custom-orders', { orderId: rid(), proofId: proof.proofId, locationId: machineId, presenceCode: code });
        state.printing = r; store.set('fw_design', null);
        go('/app/printing');
      } catch (x) { err.textContent = x.message; err.hidden = false; pay.disabled = false; pay.replaceChildren(`Pay ${money(proof.priceCents)} and print`); }
    } }, `Pay ${money(proof.priceCents)} and print`);
    screen({ nav: false },
      backBar('Your proof', 'This is exactly what prints.', null),
      h('div', { class: 'proof' }, h('img', { src: svgData(proof.labelSvg), alt: 'Your full label, laid flat, with the company panel on the right' })),
      h('p', { class: 'small muted', style: 'margin:-6px 0 0', text: 'The label wraps all the way around the bottle. The black panel on the right is the same on every bottle. The QR codes here are samples; yours get their own.' }),
      experience && h('div', { class: 'notice' }, h('b', { text: 'When someone scans it: ' }), `“${experience.message}” from ${experience.from}${experience.confetti ? ', with confetti' : ''}.`),
      h('label', { class: 'check', for: 'agree' }, agree, h('span', {}, h('b', { text: 'It looks right. Print it exactly like this. ' }), h('span', { class: 'muted', text: 'I checked the spelling, the photo and the colors.' }))),
      h('div', { class: 'price' }, h('span', { text: 'One custom bottle, no ads' }), h('b', { text: money(proof.priceCents) })),
      cardArea, err, pay,
      h('button', { class: 'btn secondary', type: 'button', onclick: () => go(`/app/design${machineId ? `?m=${machineId}` : ''}`) }, 'Change my design'));
  }

  // ---------- start ----------
  (async () => {
    try { state.config = await api('GET', '/v1/public/app-config'); }
    catch { root.replaceChildren(h('div', { class: 'boot' }, h('p', { text: 'Can’t reach FreeWater. Check your connection and try again.' }))); return; }
    render();
  })();
})();
