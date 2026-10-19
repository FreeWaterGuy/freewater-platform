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
    wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z|M3 7l12-4v4|M16 13h.01',
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
    [/^\/app\/wallet$/, walletScreen],
    [/^\/app\/me$/, meScreen],
    [/^\/app\/bottles\/([A-Za-z0-9_-]+)$/, bottleScreen],
    [/^\/app\/design$/, designScreen],
    [/^\/app\/printing$/, printingScreen],
    [/^\/app\/delivery$/, deliveryScreen],
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
    [['home', '/app', 'Home', I.home], ['machines', '/app/machines', 'Machines', I.pin], ['scan', '/app/scan', 'Scan', I.scan], ['wallet', '/app/wallet', 'Wallet', I.wallet], ['me', '/app/me', 'Me', I.me]].map(([id, path, label, ic]) =>
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
              let vk = {}; try { vk = { ...(/^[A-Za-z0-9_-]{8,64}$/.test(localStorage.getItem('fw_viewer') || '') ? { viewerKey: localStorage.getItem('fw_viewer') } : {}) }; } catch {}
              const r = await api('POST', '/v1/auth/verify', { companyId: state.config.companyId, channel, to, code: input.value.trim(), ...vk });
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
    const [machines, mine, saved, delivery] = await Promise.all([
      api('GET', `/v1/public/companies/${state.config.companyId}/machines`).catch(() => []),
      me ? api('GET', '/v1/me/bottles').catch(() => null) : null,
      me ? api('GET', '/v1/me/saved').catch(() => []) : [],
      me ? api('GET', '/v1/me/delivery').catch(() => null) : null,
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
      link('/app/wallet', { class: 'tile ice' }, h('span', { class: 'grow' }, h('b', { text: 'Your wallet' }), h('span', { class: 'muted small', text: 'Points, offers, coupons and what you saved' })), h('span', { class: 'go', text: 'Open' })),
      deliveryCard(delivery),
      m0 && link(`/app/m/${m0.id}`, { class: 'tile ice' }, h('span', { class: 'grow' }, h('b', { text: `${m0.id} on ${m0.name}` }), h('span', { class: 'muted small', text: m0.address || m0.city })), h('span', { class: 'go', text: 'Get one' })),
      me && h('h2', { class: 'section' }, 'Your bottles'),
      me && (mine?.bottles.length
        ? h('div', { class: 'rail' }, mine.bottles.slice(0, 8).map((b) => bottleCard(b)))
        : h('div', { class: 'empty', text: 'Bottles you get from a machine show up here, with their AR and what they gave.' })),
      h('h2', { class: 'section' }, 'Saved from your scans', saved.length ? link('/app/saved', {}, 'See all') : null),
      saved.length ? h('div', { class: 'rail' }, saved.slice(0, 10).map(savedCard)) : h('div', { class: 'empty', text: me ? 'Tap “Save” on any ad you scan and it waits for you here.' : 'Sign in, then tap “Save” on any ad you scan. It waits for you here.' }),
    );
  }
  const truck = 'M3 6h11v10H3z|M14 9h4l3 3v4h-7|M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z|M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z';
  const niceDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  function deliveryLine(d) {
    const t = d.today;
    if (t?.status === 'delivered') return `Delivered today at ${new Date(t.deliveredAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Leave your empties out next time.`;
    if (t?.status === 'not_delivered') return `We couldn’t leave it today (${t.reason.toLowerCase()}). It comes with your next delivery.`;
    if (t && t.runStatus === 'out') return t.stopsAway === 0 ? 'The van is at your door.' : `On the van. You’re ${t.stopsAway} stop${t.stopsAway === 1 ? '' : 's'} away.`;
    if (t) return 'Being printed and packed for you today.';
    if (d.status === 'paused') return 'Paused. Turn it back on any time.';
    return `Printed for you the night before. Leave your empties out.`;
  }
  function deliveryCard(d) {
    if (!state.me) return null;
    if (!d) return link('/app/delivery', { class: 'tile plain' }, h('span', { class: 'tile-ico', style: 'background:var(--ice)' }, icon(truck)), h('span', { class: 'grow' }, h('b', { text: 'Get packs delivered, free' }), h('span', { class: 'muted small', text: '6, 12 or 24 bottles at your door, paid for by the ads.' })), h('span', { class: 'go', text: 'Start' }));
    const when = d.today && d.today.status === 'planned' ? 'today' : d.nextDate ? niceDate(d.nextDate).split(',')[0] : null;
    return h('section', { class: 'tile plain', style: 'flex-direction:column;align-items:stretch;gap:12px' },
      h('div', { style: 'display:flex;gap:14px;align-items:center' }, h('span', { class: 'tile-ico', style: 'background:var(--ice)' }, icon(truck)),
        h('span', { class: 'grow' }, h('b', { text: d.status === 'paused' ? `Your ${d.packSize}-pack is paused` : when ? `Your ${d.packSize}-pack arrives ${when}` : `Your ${d.packSize}-pack` }), h('span', { class: 'muted small', text: deliveryLine(d) }))),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, link('/app/delivery', { class: 'btn small' }, 'Manage delivery'), d.status === 'active' && !d.today ? h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { await api('PATCH', '/v1/me/delivery', { action: 'skip' }); toast('Skipped. See you next time.'); render(); } }, 'Skip next') : null));
  }

  async function deliveryScreen() {
    if (!(await ensureSignedIn('Sign in to get packs delivered.'))) { go('/app', true); return; }
    const d = await api('GET', '/v1/me/delivery');
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const FREQ = [['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['every4weeks', 'Every 4 weeks']];
    const choice = (opts, value, onPick) => h('div', { class: 'chips' }, opts.map(([v, label]) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(v === value), onclick: (e) => { e.currentTarget.parentElement.querySelectorAll('.chip-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); onPick(v); } }, label)));
    const err = h('div', { class: 'notice err', hidden: true });
    if (!d) {
      const f = { packSize: 12, frequency: 'weekly', day: null, address: '', days: [] };
      const addr = h('input', { class: 'input', id: 'dl-addr', autocomplete: 'street-address', placeholder: '1306 Kenwood Ave, Austin, TX' });
      const found = h('div', {});
      const dayBox = h('div', {});
      const notes = h('input', { class: 'input', id: 'dl-notes', maxlength: '300', placeholder: 'Side gate, leave by the porch…' });
      const check = async () => {
        err.hidden = true; found.replaceChildren(); dayBox.replaceChildren();
        if (addr.value.trim().length < 6) return;
        try {
          const c = await api('POST', '/v1/public/delivery/check', { companyId: state.config.companyId, address: addr.value.trim() });
          if (!c.covered) { found.replaceChildren(h('div', { class: 'notice warn', text: 'We don’t deliver there yet. We’re adding neighborhoods all the time.' })); return; }
          f.days = c.days; f.day = c.days[0];
          found.replaceChildren(h('div', { class: 'notice' }, h('b', { text: `We deliver to ${c.routeName}` }), ` on ${c.days.map((x) => DAYS[x]).join(' and ')}.`));
          dayBox.replaceChildren(h('div', { class: 'field' }, h('label', { text: 'Which day' }), choice(c.days.map((x) => [x, DAYS[x]]), f.day, (v) => { f.day = v; })));
        } catch (x) { found.replaceChildren(h('div', { class: 'notice err', text: x.message })); }
      };
      addr.addEventListener('change', check);
      screen({ nav: 'home' }, backBar('Home delivery', 'Free. Printed for you the night before.', '/app'),
        h('div', { class: 'field' }, h('label', { for: 'dl-addr', text: 'Your address' }), h('div', { style: 'display:flex;gap:8px' }, addr, h('button', { class: 'btn small secondary', type: 'button', onclick: check }, 'Check'))),
        found,
        h('div', { class: 'field' }, h('label', { text: 'Pack size' }), choice([[6, '6 bottles'], [12, '12 bottles'], [24, '24 bottles']], f.packSize, (v) => { f.packSize = v; })),
        h('div', { class: 'field' }, h('label', { text: 'How often' }), choice(FREQ, f.frequency, (v) => { f.frequency = v; })),
        dayBox,
        h('div', { class: 'field' }, h('label', { for: 'dl-notes', text: 'Note for the driver (optional)' }), notes),
        h('p', { class: 'small muted', style: 'margin:0', text: 'Every bottle is different and printed fresh. Leave your empties out and the driver takes them for recycling.' }),
        err,
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          err.hidden = true;
          if (!f.day && f.day !== 0) { await check(); if (f.day === null) { err.textContent = 'Check your address first.'; err.hidden = false; return; } }
          try { await api('POST', '/v1/me/delivery', { address: addr.value.trim(), packSize: f.packSize, frequency: f.frequency, day: f.day, ...(notes.value.trim() ? { notes: notes.value.trim() } : {}) }); toast('You’re on the route. See you soon!'); go('/app'); }
          catch (x) { err.textContent = x.message; err.hidden = false; }
        } }, 'Start free delivery'));
      return;
    }
    const change = async (body, msg) => { try { await api('PATCH', '/v1/me/delivery', body); toast(msg); render(); } catch (x) { toast(x.message); } };
    const confirmBox = h('div', { class: 'notice err', hidden: true }, h('p', { style: 'margin:0 0 10px', text: 'Stop all deliveries? You can start again any time.' }), h('button', { class: 'btn small', style: 'background:var(--danger)', type: 'button', onclick: async () => { await api('PATCH', '/v1/me/delivery', { action: 'cancel' }); toast('Deliveries stopped'); go('/app'); } }, 'Yes, stop deliveries'));
    const notes = h('input', { class: 'input', id: 'dl-notes', maxlength: '300', value: d.notes ?? '', placeholder: 'Side gate, leave by the porch…' });
    screen({ nav: 'home' }, backBar('Home delivery', d.address, '/app'),
      h('section', { class: 'hero-card' }, h('div', { class: 'headline' }, d.status === 'paused' ? 'Paused' : `${d.packSize} bottles`, h('span', { text: d.status === 'paused' ? 'Turn it back on any time.' : d.today && d.today.status === 'planned' ? 'Coming today' : d.nextDate ? niceDate(d.nextDate) : '' })),
        h('p', { style: 'margin:0;opacity:.85', text: deliveryLine(d) }), d.today ? h('p', { style: 'margin:0;opacity:.7;font-size:13px', text: `Your box is marked ${d.today.stopCode}.` }) : null),
      d.status === 'active' ? h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, h('button', { class: 'btn small secondary', type: 'button', onclick: () => change({ action: 'skip' }, 'Skipped. See you next time.') }, 'Skip the next one'), h('button', { class: 'btn small secondary', type: 'button', onclick: () => change({ action: 'pause' }, 'Paused') }, 'Pause'))
        : h('button', { class: 'btn', type: 'button', onclick: () => change({ action: 'resume' }, 'Back on. See you soon!') }, 'Turn deliveries back on'),
      h('div', { class: 'field' }, h('label', { text: 'Pack size' }), choice([[6, '6 bottles'], [12, '12 bottles'], [24, '24 bottles']], d.packSize, (v) => change({ action: 'update', packSize: v }, `Now ${v} bottles`))),
      h('div', { class: 'field' }, h('label', { text: 'How often' }), choice(FREQ, d.frequency, (v) => change({ action: 'update', frequency: v }, 'Changed'))),
      h('div', { class: 'field' }, h('label', { text: `Which day (${d.routeName})` }), choice(d.routeDays.map((x) => [x, DAYS[x]]), d.day, (v) => change({ action: 'update', day: v }, `Moved to ${DAYS[v]}`))),
      h('form', { class: 'field', onsubmit: (e) => { e.preventDefault(); change({ action: 'update', notes: notes.value.trim() }, 'Note saved'); } }, h('label', { for: 'dl-notes', text: 'Note for the driver' }), h('div', { style: 'display:flex;gap:8px' }, notes, h('button', { class: 'btn small', type: 'submit' }, 'Save'))),
      h('button', { class: 'btn danger', type: 'button', onclick: () => { confirmBox.hidden = false; } }, 'Stop deliveries'), confirmBox);
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
        const vendId = rid();
        const r = await api('POST', '/v1/me/vends', { vendId, locationId: m.id, presenceCode: code });
        state.printing = { ...r, vendId, machine: m };
        go('/app/printing');
      } catch (x) { err.textContent = x.message; err.hidden = false; get.disabled = false; get.replaceChildren('Get my free water'); }
    } }, 'Get my free water');
    screen({ nav: false },
      backBar(`${m.id} · ${m.name}`, m.address || m.city, '/app'),
      h('div', { class: 'sample' }, bottle, h('span', { class: 'small muted', text: 'Sample label. Yours prints fresh with different ads.' })),
      h('h1', { class: 'display', text: m.pricing === 'free' ? 'Free spring water' : 'Spring water' }),
      h('p', { class: 'muted', style: 'margin:-6px 0 0;font-size:17px', text: `16 oz aluminum bottle, ready in about ${m.printSeconds} seconds. Ads pay for it${m.giving ? `, and ${m.giving.replace(/ goes/, ' goes')}` : ''}.` }),
      !code && h('div', { class: 'notice warn' }, h('b', { text: 'Scan the code on the machine’s screen. ' }), 'It proves you’re here, so nobody can take bottles from far away.'),
      m.availability && m.availability.state !== 'ready' ? h('div', { class: 'notice warn', text: m.availability.message }) : null,
      err,
      (m.availability && m.availability.state !== 'ready' && (get.disabled = true), get),
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
    const many = p.bottles?.length > 1;
    const title = h('h1', { text: many ? `Your ${p.bottles.length} bottles are printing` : 'Your bottle is printing' });
    const sub = h('p', { text: `${many ? 'They drop' : 'It drops'} into the tray in ${left} seconds` });
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
      h('div', {}, h('div', { class: 'progress-row' }, h('span', { text: p.bottles?.length > 1 ? `Printing your ${p.bottles.length} bottles` : p.bottle.kind === 'custom' ? 'Printing your design' : `Printing ${ads} ${ads === 1 ? 'ad' : 'ads'} on your label` }), pct), h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Printing' }, bar)),
      done);
    // At a Model 6 the bottle really is printing: follow it until it's in the tray (or say it didn't work).
    let status = p.status ?? 'ready';
    const finish = () => { left = 0; num.textContent = '0'; arc.setAttribute('stroke-dashoffset', String(C)); bar.style.width = '100%'; pct.textContent = '100%'; title.textContent = many ? 'They’re in the tray' : 'It’s in the tray'; sub.textContent = many ? 'Take them, and scan one to see the page you made.' : 'Take it, and scan any ad on it to open its AR.'; clearInterval(t); };
    let watching = null;
    if (status === 'printing' && p.vendId) {
      watching = setInterval(async () => {
        try {
          const v = await api('GET', `/v1/me/vends/${p.vendId}`);
          if (v.status === 'ready') { status = 'ready'; clearInterval(watching); finish(); }
          else if (v.status === 'failed') { status = 'failed'; clearInterval(watching); clearInterval(t); title.textContent = 'That one didn’t print'; sub.textContent = v.message; bar.style.width = '0%'; pct.textContent = ''; done.replaceWith(h('button', { class: 'btn outline-light', type: 'button', onclick: () => go(`/app/m/${p.machine.id}`) }, 'Try again')); }
        } catch {}
      }, 2000);
    }
    const t = setInterval(() => {
      if (status === 'printing' && left <= 1) { sub.textContent = 'Almost there…'; return; }
      left = Math.max(0, left - 1);
      num.textContent = String(left);
      arc.setAttribute('stroke-dashoffset', String(C * (1 - left / total)));
      const pc = Math.round(((total - left) / total) * 100);
      bar.style.width = `${pc}%`; pct.textContent = `${pc}%`;
      if (left > 0) sub.textContent = `${many ? 'They drop' : 'It drops'} into the tray in ${left} second${left === 1 ? '' : 's'}`;
      else { title.textContent = many ? 'They’re in the tray' : 'It’s in the tray'; sub.textContent = many ? 'Take them, and scan one to see the page you made.' : 'Take it, and scan any ad on it to open its AR.'; clearInterval(t); }
    }, 1000);
    stopCurrent = () => { clearInterval(t); clearInterval(watching); };
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
        h('span', { class: 'size', title: `${a.size} of the label`, text: a.size ?? `${a.sixths}/6` }),
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
  // ---------- wallet: points, credit, the token, offers, coupons, what you saved ----------
  const viewerKey = () => { let v = null; try { v = localStorage.getItem('fw_viewer'); } catch {} if (!v || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) { const a = new Uint8Array(16); crypto.getRandomValues(a); v = btoa(String.fromCharCode(...a)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]); try { localStorage.setItem('fw_viewer', v); } catch {} } return v; };
  async function walletScreen() {
    const me = await loadMe();
    const cid = encodeURIComponent(state.config.companyId);
    const vk = viewerKey();
    const [w, offers] = await Promise.all([me ? api('GET', '/v1/me/wallet') : api('GET', `/v1/public/wallet/${cid}?viewer=${encodeURIComponent(vk)}`), api('GET', `/v1/public/offers/${cid}?viewer=${encodeURIComponent(vk)}`).catch(() => ({ offers: [], mine: [] }))]);
    const tok = (n) => (n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
    const claim = async (o, btn) => {
      if (!me && !(await signIn('Offers pay real money, so they need an account.'))) return;
      btn.disabled = true;
      try { const r = await api('POST', `/v1/public/offers/${cid}/${o.id}/claim`, { viewerKey: vk }); toast(r.how); render(); } catch (e) { toast(e.message); btn.disabled = false; }
    };
    const receipt = (c) => {
      const f = h('input', { type: 'file', accept: 'image/*', capture: 'environment', 'aria-label': 'Photo of the receipt', style: 'max-width:100%' });
      f.addEventListener('change', async () => {
        const file = f.files[0]; if (!file) return;
        try {
          if (file.size > 2 * 1024 * 1024) throw new Error('Photos can be up to 2 MB.');
          const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(file); });
          const r = await api('POST', `/v1/public/offers/${cid}/claims/${c.id}/receipt`, { viewerKey: vk, image: { contentType: file.type, dataBase64: b64 } });
          toast(r.note || 'Thanks!'); render();
        } catch (e) { toast(e.message); }
      });
      return h('label', { class: 'field' }, h('span', { class: 'small muted', text: 'Bought it? Add a photo of the receipt' }), f);
    };
    const said = { claimed: 'Buy it, then add the receipt', receipt_sent: 'Checking your receipt', verified: 'Approved', paid: 'Paid', rejected: 'Receipt not accepted (points returned)', expired: 'Ran out (points returned)', void: 'Closed' };
    screen({ nav: 'wallet' },
      h('h1', { class: 'display', style: 'font-size:26px', text: 'Wallet' }),
      w.test ? h('div', { class: 'notice', text: 'Testing: these points are for trying things out and will be wiped before going live.' }) : null,
      h('section', { class: 'hero-card' },
        h('div', { class: 'stats' },
          h('div', {}, h('b', { text: w.points.balance.toLocaleString() }), h('span', { text: 'points' })),
          (w.credit.enabled || w.credit.balanceCents) ? h('div', {}, h('b', { text: money(w.credit.balanceCents) }), h('span', { text: 'credit' })) : null,
          (w.token.live || w.token.balance) ? h('div', {}, h('b', { text: tok(w.token.balance) }), h('span', { text: 'tokens' })) : null),
        w.token.live ? h('p', { style: 'margin:8px 0 0;opacity:.85;font-size:14px', text: w.token.held }) : null),
      link('/play', { class: 'tile blue' }, h('span', { class: 'tile-ico' }, icon(I.scan)), h('span', { class: 'grow' }, h('b', { text: 'Play for points' }), h('span', { text: 'Pick what you’d really choose. Same points whichever you pick.' }))),
      offers.offers.length || offers.mine.length ? h('h2', { class: 'section' }, 'Offers') : null,
      ...offers.offers.map((o) => { const b = h('button', { class: 'btn small', type: 'button', text: o.pointsCost ? `Claim for ${o.pointsCost} points` : 'Claim' }); b.addEventListener('click', () => claim(o, b)); return h('div', { class: 'list-row' }, h('span', { class: 'grow' }, h('b', { text: o.title }), h('span', { class: 'small muted', text: `${o.deal} · ${o.retailers.includes('any') ? 'any store' : o.retailers.join(', ')}` })), b); }),
      ...offers.mine.map((c) => h('div', { class: 'list-row', style: 'flex-wrap:wrap' }, h('span', { class: 'grow' }, h('b', { text: c.title }), h('span', { class: 'small muted', text: said[c.status] ?? c.status })), c.status === 'claimed' ? receipt(c) : null)),
      w.coupons.length ? h('h2', { class: 'section' }, 'Coupons') : null,
      ...w.coupons.map((c) => h('div', { class: 'list-row' }, h('span', { class: 'grow' }, h('b', { text: c.advertiser ?? 'Coupon' }), h('span', { class: 'small muted', style: 'font-family:ui-monospace,Menlo,monospace', text: c.code })))),
      h('h2', { class: 'section' }, 'Saved from your scans', me ? link('/app/saved', {}, 'See all') : null),
      w.saved.length ? h('div', { class: 'rail' }, w.saved.slice(0, 10).map(savedCard)) : h('div', { class: 'empty', text: me ? 'Tap “Save” on any ad you scan and it waits for you here.' : 'Sign in, then tap “Save” on any ad you scan.' }),
      w.history.length ? h('h2', { class: 'section' }, 'Recent') : null,
      ...w.history.slice(0, 12).map((x) => h('div', { class: 'list-row' }, h('span', { class: 'grow' }, h('b', { text: { 'earn:scan': 'Scanned a bottle', 'earn:game_round': 'Played a screen', 'earn:ad_feedback': 'Picked an ad', 'earn:feedback': 'Sent feedback', 'earn:prompt': 'Asked a question', 'earn:upload': 'Added a picture', 'earn:streak_bonus': 'Streak bonus', spend: 'Claimed an offer', correction: 'Corrected', offer: 'Offer paid', convert: 'Became tokens', mint: 'Tokens' }[x.kind] ?? x.kind }), h('span', { class: 'small muted', text: new Date(x.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })), h('b', { text: `${x.amount > 0 ? '+' : ''}${x.what === 'credit' ? money(x.amount) : x.what === 'token' ? tok(x.amount) : x.amount.toLocaleString()}` }))),
      h('p', { class: 'small muted', style: 'margin-top:18px', text: w.points.terms }),
      !me ? h('button', { class: 'btn secondary', type: 'button', onclick: async () => { if (await signIn('Keep your points on every phone.')) render(); } }, 'Sign in to keep your points') : null);
  }

  async function savedScreen() {
    const me = await loadMe();
    if (!me) {
      screen({ nav: 'wallet' }, h('h1', { class: 'display', style: 'font-size:26px', text: 'Saved' }), h('div', { class: 'empty', text: 'Sign in to keep offers, homes and stories you save from your scans.' }), h('button', { class: 'btn', type: 'button', onclick: async () => { if (await signIn()) render(); } }, 'Sign in'));
      return;
    }
    const items = await api('GET', '/v1/me/saved');
    screen({ nav: 'wallet' },
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
      h('h2', { class: 'section' }, 'What you really get'),
      h('p', { class: 'small muted', style: 'margin:0', text: 'Optional. Tells us honestly whether a free bottle is better than free for you, so we count what you really get.' }),
      (() => {
        const pick = (key, label, opts) => { const sel = h('select', { class: 'input', 'aria-label': label }, h('option', { value: '', text: 'Rather not say' }), opts.map(([v, l]) => h('option', { value: v, text: l }))); sel.value = me.consents?.[key === 'cause' ? 'causeStance' : 'adsStance'] ?? ''; sel.addEventListener('change', async () => { if (!sel.value) return; try { await api('POST', '/v1/me/stance', { [key]: sel.value }); toast('Saved'); } catch (x) { toast(x.message); } }); return h('div', { class: 'field' }, h('label', { text: label }), sel); };
        return h('div', {}, pick('cause', `The cause your bottles support${state.config?.giving?.charity ? ` (${state.config.giving.charity})` : ''}`, [['supports', 'I support it'], ['indifferent', 'I don’t mind either way'], ['opposes', 'I’d rather not support it']]), pick('ads', 'Ads on my bottles', [['welcome', 'Fine by me'], ['unwelcome', 'I’d rather not have them']]));
      })(),
      h('h2', { class: 'section' }, 'Payment'),
      cards.length ? h('div', {}, cards.map((c) => h('div', { class: 'list-row' }, h('span', { class: 'grow' }, h('b', { text: `${c.brand[0].toUpperCase()}${c.brand.slice(1)} •••• ${c.last4}` }), h('span', { class: 'small muted', text: `Expires ${c.expMonth}/${c.expYear}` })))))
        : h('div', { class: 'empty', text: 'No card saved. You only need one to design your own bottles. Free water never needs a card.' }),
      h('h2', { class: 'section' }, 'Your data'),
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
        const data = await api('GET', '/v1/me/export');
        const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'my-freewater-data.json' });
        document.body.append(a); a.click(); a.remove(); toast('Downloaded');
      } }, 'Download my data'),
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
        const data = await api('GET', '/v1/me/data');
        const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'everything-kept-about-me.json' });
        document.body.append(a); a.click(); a.remove(); toast('Downloaded');
      } }, 'Everything kept about me'),
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => { if (!confirm('Erase what we kept about how you used pages and what you chose? Your account stays.')) return; await api('DELETE', '/v1/me/data'); toast('Erased'); } }, 'Erase my activity'),
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await api('POST', '/v1/auth/sign-out'); } catch {} signOutLocal(); toast('Signed out'); go('/app'); } }, 'Sign out'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => { confirmBox.hidden = false; confirmBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 'Delete my account'),
      confirmBox);
  }

  // ---------- design my own bottle, by chatting ----------
  async function shrinkPhoto(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let q = 0.86, out = c.toDataURL('image/jpeg', q);
      while (out.length > 1_400_000 && q > 0.4) { q -= 0.12; out = c.toDataURL('image/jpeg', q); }
      return out;
    } finally { URL.revokeObjectURL(url); }
  }
  async function uploadVideo(file) {
    if (file.size > 15 * 1024 * 1024) throw new Error(`${file.name} is ${(file.size / 1048576).toFixed(0)} MB. Videos can be up to 15 MB.`);
    if (fixture) return fixture.upload(file);
    const res = await fetch(`/v1/me/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': file.type || 'video/mp4', authorization: `Bearer ${state.token}` }, body: file });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || 'That video didn’t upload.');
    return data;
  }
  const scanFrameFor = () => (fixture?.scanFrame ? fixture.scanFrame() : h('iframe', { src: '/preview/scan', title: 'What scanning it opens', style: 'width:100%;height:520px;border:0;border-radius:22px;box-shadow:0 0 0 8px #000;background:#fff' }));

  async function designScreen() {
    const q = query();
    const machineId = q.get('m');
    if (!(await ensureSignedIn('Sign in so your design is saved while you work on it.'))) { go(machineId ? `/app/m/${machineId}` : '/app', true); return; }
    let id = q.get('d');
    let d = id ? await api('GET', `/v1/me/designs/${id}`) : await api('POST', '/v1/me/designs');
    if (!id) { id = d.id; state.path = `/app/design?${machineId ? `m=${machineId}&` : ''}d=${id}`; if (!fixture) history.replaceState(null, '', state.path); }
    let busy = false, files = [], suggestions = d.messages.length <= 1 ? ['Maya’s 30th birthday, pink and gold', 'Thank-you bottles for my team', 'Our wedding, cream and gold'] : [], view = 'label';
    const bottle = h('div', { class: 'bottle', 'aria-hidden': 'true', style: 'width:96px;height:220px' }, h('div', { class: 'cap', style: 'width:32px;margin-left:-16px;height:16px' }), h('div', { class: 'neck', style: 'width:36px;margin-left:-18px;top:14px;height:28px' }), h('div', { class: 'body', style: 'top:40px' }, h('div', { class: 'wrap', style: 'top:36px;height:112px;background-size:cover;background-position:30% 50%' })));
    const info = h('div', { style: 'display:flex;flex-direction:column;gap:4px;min-width:0' });
    const flat = h('div', { class: 'design-preview', style: 'margin-top:10px' });
    const scanBox = h('div', { hidden: true });
    let frame = null, frameReady = false;
    const sendScan = async () => { if (!frame || !frameReady) return; const p = await api('GET', `/v1/me/designs/${id}/scan-preview`); frame.contentWindow.postMessage({ type: 'fw-preview', ...p }, fixture ? '*' : location.origin); };
    const onMsg = (e) => { if ((fixture || e.origin === location.origin) && e.data?.type === 'fw-preview-ready') { frameReady = true; sendScan(); } };
    window.addEventListener('message', onMsg);
    stopCurrent = () => window.removeEventListener('message', onMsg);
    const chips = h('div', { class: 'layers' }, [['label', 'Label'], ['scan', 'Scan page']].map(([k, label]) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(view === k), onclick: (e) => {
      view = k; chips.querySelectorAll('.chip-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
      const scan = k === 'scan';
      flat.hidden = scan; scanBox.hidden = !scan; card.hidden = scan;
      if (scan && !frame) { frame = scanFrameFor(); scanBox.replaceChildren(frame); } else if (scan) sendScan();
    } }, label)));
    const card = h('div', { class: 'sample', style: 'flex-direction:row;justify-content:center;gap:18px;padding:16px' }, bottle, info);
    const msgs = h('div', { style: 'display:flex;flex-direction:column;gap:12px', 'aria-live': 'polite' });
    const sugg = h('div', { class: 'chips' });
    const pending = h('div', { class: 'chips' });
    const input = h('textarea', { class: 'input', id: 'design-ask', rows: 1, placeholder: 'Describe a change', style: 'min-height:48px;border-radius:24px;resize:none;flex:1', 'aria-label': 'Message' });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,video/mp4', multiple: true, hidden: true });
    const review = h('button', { class: 'btn blue', type: 'button' }, 'Review my proof');
    const err = h('div', { class: 'notice err', hidden: true });
    const draw = () => {
      info.replaceChildren(h('span', { class: 'small muted', text: 'Live preview' }), h('b', { style: 'font:700 20px/1.1 var(--display)', text: `${d.design.quantity} ${d.design.quantity === 1 ? 'bottle' : 'bottles'}` }),
        h('span', { class: 'small muted', text: d.design.names?.length ? `A name on each: ${d.design.names.slice(0, 4).join(', ')}${d.design.names.length > 4 ? '…' : ''}` : 'No ads. All yours.' }),
        h('span', { class: 'small', text: `${money(d.totalCents)}${d.design.quantity > 1 ? ` (${money(d.priceCents)} each)` : ''}` }));
      bottle.querySelector('.wrap').style.backgroundImage = `url("${svgData(d.designSvg)}")`;
      flat.innerHTML = d.designSvg;
      msgs.replaceChildren(...d.messages.map((m) => h('div', { style: m.role === 'user' ? 'align-self:flex-end;max-width:85%;background:#000;color:#fff;padding:10px 14px;border-radius:18px 18px 4px 18px;white-space:pre-wrap' : 'max-width:92%;white-space:pre-wrap' }, m.text,
        m.attachments?.length ? h('div', { class: 'small', style: 'opacity:.75;margin-top:4px', text: m.attachments.map((a) => `${a.kind === 'video' ? '🎬' : '🖼'} ${a.name || a.kind}`).join('  ') }) : null)));
      if (busy) msgs.append(h('div', { class: 'muted', text: 'Designing…' }));
      sugg.replaceChildren(...(busy ? [] : suggestions).map((t) => h('button', { type: 'button', class: 'chip-btn', onclick: () => say(t) }, t)));
      pending.replaceChildren(...files.map((f, i) => h('button', { type: 'button', class: 'chip-btn', 'aria-label': `Remove ${f.name}`, onclick: () => { files.splice(i, 1); draw(); } }, `${f.kind === 'video' ? '🎬' : '🖼'} ${f.name} ×`)));
      review.disabled = !d.ready || busy;
      if (view === 'scan') sendScan();
    };
    async function say(text) {
      if (busy) return;
      text = (text ?? input.value).trim();
      if (!text && !files.length) return;
      busy = true; input.value = ''; err.hidden = true;
      d.messages = [...d.messages, { role: 'user', text, attachments: files.map((f) => ({ kind: f.kind, name: f.name })) }];
      draw();
      try {
        const r = await api('POST', `/v1/me/designs/${id}/messages`, { text, attachments: files.map((f) => (f.kind === 'video' ? { assetId: f.assetId, name: f.name } : { dataUrl: f.dataUrl, name: f.name })) });
        d = r; suggestions = r.suggestions || []; files = [];
      } catch (x) { d.messages = [...d.messages, { role: 'assistant', text: x.message }]; }
      busy = false; draw();
      msgs.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    file.addEventListener('change', async () => {
      for (const f of [...file.files].slice(0, 6 - files.length)) {
        try {
          if (f.type.startsWith('video/')) { toast(`Uploading ${f.name}…`); const a = await uploadVideo(f); files.push({ kind: 'video', name: f.name, assetId: a.id }); }
          else files.push({ kind: 'image', name: f.name, dataUrl: await shrinkPhoto(f) });
        } catch (x) { toast(x.message); }
      }
      file.value = ''; draw();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); say(); } });
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = Speech ? h('button', { class: 'back', type: 'button', 'aria-label': 'Speak instead of typing', onclick: () => { const r = new Speech(); r.lang = navigator.language || 'en-US'; r.onresult = (e) => { input.value = `${input.value} ${e.results[0][0].transcript}`.trim(); }; r.start(); toast('Listening…'); } }, icon('M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z|M5 11a7 7 0 0 0 14 0|M12 18v3')) : null;
    review.addEventListener('click', async () => {
      err.hidden = true; review.disabled = true;
      try { const proof = await api('POST', `/v1/me/designs/${id}/proof`); proofScreen(proof, machineId, id); }
      catch (x) { err.textContent = x.message; err.hidden = false; review.disabled = false; }
    });
    screen({ nav: false },
      backBar('Design my bottle', 'Describe it. Add photos and videos.', machineId ? `/app/m/${machineId}` : '/app'),
      card, flat, scanBox, chips, msgs, pending, sugg,
      h('form', { style: 'display:flex;gap:8px;align-items:flex-end', onsubmit: (e) => { e.preventDefault(); say(); } }, file,
        h('button', { class: 'back', type: 'button', 'aria-label': 'Add photos or a video', onclick: () => file.click() }, icon('M12 5v14|M5 12h14')), input, mic,
        h('button', { class: 'back', type: 'submit', 'aria-label': 'Send', style: 'background:#000;color:#fff' }, icon('M5 12h14|M13 6l6 6-6 6'))),
      err, review,
      h('p', { class: 'small muted center', style: 'margin:-6px 0 0', text: `Designer: ${d.assistant}. You’ll see exactly what prints before you pay.` }));
    draw();
  }

  async function proofScreen(proof, machineId, designId) {
    const agree = h('input', { type: 'checkbox', id: 'agree' });
    const err = h('div', { class: 'notice err', hidden: true });
    let cards = await api('GET', '/v1/me/cards').catch(() => []);
    const cardArea = h('div', {});
    const drawCards = () => {
      cardArea.replaceChildren(cards.length
        ? h('div', { class: 'list-row' }, h('span', { class: 'grow' }, h('b', { text: `Pay with ${cards[0].brand} •••• ${cards[0].last4}` }), h('span', { class: 'small muted', text: 'Held first, charged only for bottles that print.' })))
        : h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, h('p', { style: 'margin:0', class: 'small' }, h('span', { class: 'test-badge', text: 'Test mode' }), ' No real money moves yet. Pick a test card:'),
          h('div', { class: 'chips' }, [['tok_visa', 'Visa 4242'], ['tok_mastercard', 'Mastercard 4444'], ['tok_declined', 'A card that declines']].map(([t, l]) => h('button', { type: 'button', class: 'chip-btn', onclick: async () => { try { await api('POST', '/v1/me/cards', { token: t }); cards = await api('GET', '/v1/me/cards'); drawCards(); } catch (x) { toast(x.message); } } }, l)))));
    };
    drawCards();
    const code = machineId ? presenceCode(machineId) : null;
    const total = proof.totalCents ?? proof.priceCents;
    const qty = proof.quantity ?? 1;
    const pay = h('button', { class: 'btn', type: 'button', onclick: async () => {
      err.hidden = true;
      if (!agree.checked) { err.textContent = 'Check the box to confirm the proof looks right.'; err.hidden = false; return; }
      if (!cards.length) { err.textContent = 'Add a card first.'; err.hidden = false; return; }
      if (!machineId || !code) { err.textContent = 'Go to a machine and scan the code on its screen. Your design is saved and will be waiting.'; err.hidden = false; return; }
      pay.disabled = true; pay.replaceChildren(h('span', { class: 'spin' }), 'Paying and printing');
      try {
        const r = await api('POST', '/v1/me/custom-orders', { orderId: rid(), proofId: proof.proofId, locationId: machineId, presenceCode: code });
        state.printing = r;
        if (r.notice) toast(r.notice);
        go('/app/printing');
      } catch (x) { err.textContent = x.message; err.hidden = false; pay.disabled = false; pay.replaceChildren(`Pay ${money(total)} and print`); }
    } }, `Pay ${money(total)} and print`);
    const exp = proof.experience;
    screen({ nav: false },
      backBar('Your proof', qty > 1 ? `Bottle 1 of ${qty}. This is exactly what prints.` : 'This is exactly what prints.', null),
      h('div', { class: 'proof' }, h('img', { src: svgData(proof.labelSvg), alt: 'Your full label, laid flat, with the company panel on the right' })),
      h('p', { class: 'small muted', style: 'margin:-6px 0 0', text: `The label wraps all the way around the bottle. The black panel on the right is the same on every bottle. ${proof.note || ''}` }),
      proof.names?.length ? h('div', { class: 'notice' }, h('b', { text: 'Names: ' }), proof.names.join(', ')) : null,
      exp && h('div', { class: 'notice' }, h('b', { text: 'When someone scans it: ' }), `“${exp.message}” from ${exp.from}${exp.confetti ? ', with confetti' : ''}${exp.videoUrl ? ', and your video' : ''}${exp.photoUrls?.length ? `, and ${exp.photoUrls.length} photo${exp.photoUrls.length === 1 ? '' : 's'}` : ''}.`),
      h('label', { class: 'check', for: 'agree' }, agree, h('span', {}, h('b', { text: 'It looks right. Print it exactly like this. ' }), h('span', { class: 'muted', text: 'I checked the spelling, the photo and the colors, and I have the right to use them.' }))),
      h('div', { class: 'price' }, h('span', { text: qty > 1 ? `${qty} custom bottles, no ads` : 'One custom bottle, no ads' }), h('b', { text: money(total) })),
      cardArea, err, pay,
      h('button', { class: 'btn secondary', type: 'button', onclick: () => go(`/app/design?${machineId ? `m=${machineId}&` : ''}${designId ? `d=${designId}` : ''}`) }, 'Change my design'));
  }

  // ---------- start ----------
  (async () => {
    try { state.config = await api('GET', '/v1/public/app-config'); }
    catch { root.replaceChildren(h('div', { class: 'boot' }, h('p', { text: 'Can’t reach FreeWater. Check your connection and try again.' }))); return; }
    render();
  })();
})();
