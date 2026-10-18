// The FreeWater console: where a company (FreeWater or a white-label licensee) makes the platform its own:
// brand, ad rules and prices, giving, modules, machines, team, every change's history; and where developers
// get API keys and webhooks. /developers is the public developer portal: guides, events and the API reference.
(() => {
  'use strict';
  const fixture = window.__FW_CONSOLE_FIXTURE__;
  const root = document.getElementById('root');
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (d) => { const s = document.createElementNS(NS, 'svg'); for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v); for (const p of d.split('|')) { const e = document.createElementNS(NS, 'path'); e.setAttribute('d', p); s.append(e); } return s; };
  const I = {
    start: 'M5 12l5 5L20 7', company: 'M3 21h18|M5 21V7l7-4 7 4v14|M9 9h1|M14 9h1|M9 13h1|M14 13h1|M10 21v-4h4v4', brand: 'M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-7.8-9-7.8Z|M7.5 11.5h.01|M10.5 7.5h.01|M15.5 7.5h.01',
    ads: 'M4 5h16v14H4z|M4 10h16|M10 10v9', giving: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8Z', modules: 'M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z',
    machine: 'M6 3h12v18H6z|M9 7h6|M10 17h4', team: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z|M2 21a7 7 0 0 1 14 0|M17 3a4 4 0 0 1 0 8|M22 21a7 7 0 0 0-5-6.7', history: 'M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5|M12 7v5l3 3',
    key: 'M15 7a4 4 0 1 1-3.5 6H8v3H5v-3H3v-3h8.5A4 4 0 0 1 15 7Z', hook: 'M18 16.1A5 5 0 0 0 15 7a5 5 0 0 0-4.5 7.2|M6 16.1A5 5 0 1 0 12 21h5|M12 3a5 5 0 0 0-3 9l-3 5', docs: 'M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z|M8 8h8|M8 12h8|M8 16h5', licensees: 'M3 7h18v13H3z|M8 7V4h8v3|M3 12h18',
  };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
  const dollars = (c) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  const ago = (iso) => { if (!iso) return 'never'; const s = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  const svgSrc = (s) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
  const toastEl = h('div', { class: 'toast', role: 'status' }); document.body.append(toastEl);
  let tt; const toast = (m) => { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove('show'), 2800); };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select it and copy it by hand'); } };

  const qp = new URLSearchParams(fixture ? '' : location.search);
  const S = { token: fixture?.token ?? store.get('fw_console_token'), company: qp.get('company') || store.get('fw_console_company'), me: null, config: null, ov: null, dirty: false, path: fixture ? fixture.start : location.pathname + location.search };
  async function api(method, url, body) {
    if (fixture) return fixture.api(method, url, body);
    const res = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { S.token = null; S.me = null; store.set('fw_console_token', null); }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error?.message || 'Something went wrong.'); e.status = res.status; throw e; }
    return data;
  }

  const routes = [
    [/^\/console\/?$/, startPage], [/^\/console\/company$/, companyPage], [/^\/console\/brand$/, brandPage], [/^\/console\/ads$/, adsPage], [/^\/console\/giving$/, givingPage],
    [/^\/console\/modules$/, modulesPage], [/^\/console\/machines$/, machinesPage], [/^\/console\/team$/, teamPage], [/^\/console\/history$/, historyPage],
    [/^\/console\/keys$/, keysPage], [/^\/console\/webhooks$/, webhooksPage], [/^\/console\/webhooks\/([\w-]+)$/, webhookPage], [/^\/console\/licensees$/, licenseesPage],
  ];
  let cleanup = null;
  function go(path, replace) {
    if (S.dirty && !replace) { toast('Save or discard your changes first.'); return; }
    S.path = path; if (!fixture) history[replace ? 'replaceState' : 'pushState'](null, '', path); render();
  }
  window.addEventListener('popstate', () => { S.dirty = false; S.path = location.pathname + location.search; render(); });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  const link = (path, attrs, ...kids) => h('a', { href: fixture ? '#' : path, ...attrs, onclick: (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(path); } }, ...kids);

  async function render() {
    if (cleanup) { cleanup(); cleanup = null; }
    const pathname = S.path.split('?')[0];
    if (pathname.startsWith('/developers')) return docs(pathname);
    try {
      if (!S.config) S.config = await api('GET', `/v1/public/app-config${S.company ? `?company=${encodeURIComponent(S.company)}` : ''}`);
    } catch { S.company = null; store.set('fw_console_company', null); S.config = await api('GET', '/v1/public/app-config'); }
    if (S.token && !S.me) { try { S.me = await api('GET', '/v1/me'); } catch { S.me = null; } }
    if (!S.me) return signIn();
    if (!['owner'].includes(S.me.role)) return shell('', h('div', { class: 'notice err', text: 'The console is for company owners. Ask an owner to change your role, or use the ops console.' }));
    try { S.ov = await api('GET', '/v1/console'); } catch (e) { return shell('', h('div', { class: 'notice err', text: e.message })); }
    for (const [re, fn] of routes) {
      const m = re.exec(pathname);
      if (m) { try { await fn(...m.slice(1)); } catch (e) { shell('', h('div', { class: 'notice err', text: e.message })); } window.scrollTo(0, 0); return; }
    }
    go('/console', true);
  }

  function shell(active, ...content) {
    const nav = [
      ['start', '/console', 'Get started', I.start], ['company', '/console/company', 'Company', I.company], ['brand', '/console/brand', 'Brand', I.brand], ['ads', '/console/ads', 'Ads and prices', I.ads],
      ['giving', '/console/giving', 'Giving', I.giving], ['modules', '/console/modules', 'Modules', I.modules], ['machines', '/console/machines', 'Machines', I.machine], ['team', '/console/team', 'Team', I.team], ['history', '/console/history', 'History', I.history],
      'Developers', ['keys', '/console/keys', 'API keys', I.key], ['webhooks', '/console/webhooks', 'Webhooks', I.hook], ['docs', '/developers', 'Docs', I.docs],
      ...(S.ov?.you?.platform ? ['Platform', ['licensees', '/console/licensees', 'Licensees', I.licensees]] : []),
    ];
    const b = S.ov?.config?.brand ?? S.config?.brand ?? { logoTop: 'free', logoBottom: 'water' };
    root.replaceChildren(h('div', { class: 'shell' },
      h('aside', { class: 'side' }, h('div', { class: 'logo', 'aria-label': `${S.config?.name ?? ''} console` }, h('span', { text: b.logoTop }), h('span', { text: b.logoBottom }), h('small', { text: 'Console' })),
        h('nav', { 'aria-label': 'Main' }, nav.map((n) => (typeof n === 'string' ? h('div', { class: 'group', text: n }) : link(n[1], { 'aria-current': active === n[0] ? 'page' : null }, icon(n[3]), n[2])))),
        h('div', { class: 'who' }, h('b', { text: S.me.displayName || S.me.email || '' }), S.config?.name, h('br'), h('button', { type: 'button', onclick: async () => { try { await api('POST', '/v1/auth/sign-out'); } catch {} S.token = null; S.me = null; S.dirty = false; store.set('fw_console_token', null); render(); } }, 'Sign out'))),
      h('main', { class: 'main' }, ...content)));
  }
  const head = (title, sub, ...right) => h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: title }), sub ? h('p', { text: sub }) : null), right.length ? h('div', { class: 'toolbar' }, right) : null);

  function signIn() {
    let to = '';
    const right = h('div', { class: 'right' });
    const b = S.config.brand;
    root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'left', style: `background:${b.panelColor};color:${b.textColor}` }, h('div', { class: 'logo' }, h('span', { text: b.logoTop }), h('span', { text: b.logoBottom, style: `color:${b.accentColor}` }), h('small', { text: 'Console' })), h('h1', {}, 'Make it ', h('span', { text: 'yours', style: `color:${b.accentColor}` }), '.'), h('p', { style: 'opacity:.7;margin:0', text: `${S.config.name}: brand, ads, giving, machines, team, API keys and webhooks.` })), right));
    const step1 = () => { const input = h('input', { class: 'input', id: 'c-email', type: 'email', autocomplete: 'email', placeholder: 'you@company.com' }); right.replaceChildren(h('h2', { style: 'font:700 26px/1.2 var(--display);margin:0', text: 'Owner sign in' }), h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); to = input.value.trim(); try { await api('POST', '/v1/auth/start', { companyId: S.config.companyId, channel: 'email', to }); step2(); } catch (x) { toast(x.message); } } }, h('div', { class: 'field' }, h('label', { for: 'c-email', text: 'Work email' }), input), h('button', { class: 'btn wide', type: 'submit' }, 'Email me a code'), link('/developers', { style: 'text-align:center' }, 'Just looking? Read the developer docs'))); input.focus(); };
    const step2 = () => { const input = h('input', { class: 'input code-input', id: 'c-code', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', 'aria-label': '6-digit code' }); right.replaceChildren(h('h2', { style: 'font:700 26px/1.2 var(--display);margin:0', text: 'Check your email' }), h('p', { style: 'margin:0;color:var(--muted)', text: `We sent a 6-digit code to ${to}.` }), h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); try { const r = await api('POST', '/v1/auth/verify', { companyId: S.config.companyId, channel: 'email', to, code: input.value.trim() }); S.token = r.token; store.set('fw_console_token', r.token); store.set('fw_console_company', S.config.companyId); S.me = null; render(); } catch (x) { toast(x.message); } } }, input, h('button', { class: 'btn wide', type: 'submit' }, 'Sign in'))); input.focus(); };
    step1();
  }

  // ---------- settings forms ----------
  const getP = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const setP = (o, path, v) => { const ks = path.split('.'); let t = o; for (const k of ks.slice(0, -1)) t = t[k] ??= {}; if (v === undefined) delete t[ks.at(-1)]; else t[ks.at(-1)] = v; };
  let fid = 0;
  const field = (label, control, opts = {}) => { const id = control.id || (control.id = `f${++fid}`); return h('div', { class: `field${opts.full ? ' full' : ''}` }, h('label', { for: id, text: label }), control, opts.hint ? h('div', { class: 'hint', text: opts.hint }) : null); };

  /** One settings page: a working copy of the settings, a save bar that appears on change, and saving with the version it started from. */
  function settingsPage(active, title, sub, build, opts = {}) {
    const draft = structuredClone(S.ov.config);
    const diff = () => { const ch = {}; for (const k of S.ov.options.editable) if (JSON.stringify(draft[k]) !== JSON.stringify(S.ov.config[k])) ch[k] = draft[k]; return ch; };
    const saveBtn = h('button', { class: 'btn blue', type: 'button', onclick: save }, 'Save');
    const bar = h('div', { class: 'savebar', hidden: true, role: 'region', 'aria-label': 'Unsaved changes' }, h('span', { text: 'You have unsaved changes.' }), h('button', { class: 'btn secondary small', type: 'button', onclick: () => { S.dirty = false; render(); } }, 'Discard'), saveBtn);
    const changed = () => { const ch = diff(); S.dirty = Object.keys(ch).length > 0; bar.hidden = !S.dirty; opts.onChange?.(draft, ch); };
    async function save() {
      saveBtn.disabled = true;
      try {
        const r = await api('PATCH', '/v1/console/settings', { version: S.ov.version, changes: diff() });
        S.dirty = false;
        toast(r.changes.length ? `Saved as version ${r.version}. New bottles use it now.` : 'Nothing changed.');
        render();
      } catch (x) {
        saveBtn.disabled = false;
        if (x.status === 409) { bar.replaceChildren(h('span', { text: x.message }), h('button', { class: 'btn blue', type: 'button', onclick: () => { S.dirty = false; render(); } }, 'Reload')); return; }
        toast(x.message);
      }
    }
    const ctx = { draft, changed, diff };
    shell(active, head(title, sub, link('/console/history', { class: 'pill', title: 'See every saved change' }, `Version ${S.ov.version}`)), ...build(ctx), bar);
    opts.onChange?.(draft, {});
  }
  const text = (ctx, path, label, o = {}) => {
    const input = h(o.area ? 'textarea' : 'input', { class: 'input', rows: o.area ? 6 : null, maxlength: o.max, placeholder: o.placeholder, type: o.type, spellcheck: o.mono ? 'false' : null, style: o.mono ? 'font-family:var(--mono)' : null });
    const v = getP(ctx.draft, path);
    input.value = o.lines ? (v ?? []).join('\n') : v ?? '';
    input.addEventListener('input', () => { setP(ctx.draft, path, o.lines ? input.value.split('\n').map((l) => l.trim()).filter(Boolean) : input.value); ctx.changed(); });
    return field(label, input, o);
  };
  const num = (ctx, path, label, o = {}) => {
    const scale = o.scale ?? 1;
    const input = h('input', { class: 'input', type: 'number', inputmode: 'decimal', min: o.min, max: o.max, step: o.step ?? 1 });
    const v = getP(ctx.draft, path);
    input.value = v == null ? '' : String(Math.round(v * scale * 100) / 100);
    const hint = h('div', { class: 'hint' });
    const showHint = () => { const val = getP(ctx.draft, path); hint.textContent = o.hint ? (typeof o.hint === 'function' ? o.hint(val) : o.hint) : ''; };
    input.addEventListener('input', () => { const n = Number(input.value); if (input.value === '' || !Number.isFinite(n)) return; setP(ctx.draft, path, o.int === false ? n / scale : Math.round(n / scale)); showHint(); ctx.changed(); });
    showHint();
    const id = `f${++fid}`; input.id = id;
    return h('div', { class: `field${o.full ? ' full' : ''}` }, h('label', { for: id, text: label }), o.suffix ? h('div', { class: 'suffix' }, input, h('span', { text: o.suffix })) : input, hint);
  };
  const color = (ctx, path, label, o = {}) => {
    const v = getP(ctx.draft, path);
    const pick = h('input', { type: 'color', value: v, 'aria-label': `${label} picker` });
    const hex = h('input', { class: 'input', maxlength: 7, value: v, spellcheck: 'false' });
    const put = (val) => { setP(ctx.draft, path, val.toUpperCase()); ctx.changed(); };
    pick.addEventListener('input', () => { hex.value = pick.value.toUpperCase(); put(pick.value); });
    hex.addEventListener('input', () => { const val = hex.value.trim(); if (/^#[0-9a-fA-F]{6}$/.test(val)) { pick.value = val; put(val); } });
    const id = `f${++fid}`; hex.id = id;
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), h('div', { class: 'color' }, pick, hex), o.hint ? h('div', { class: 'hint', text: o.hint }) : null);
  };
  const select = (ctx, path, label, options, o = {}) => {
    const sel = h('select', { class: 'input' }, options.map(([v, l]) => h('option', { value: v, text: l })));
    sel.value = String(getP(ctx.draft, path) ?? options[0][0]);
    sel.addEventListener('change', () => { const opt = options.find(([v]) => String(v) === sel.value); setP(ctx.draft, path, opt[0]); ctx.changed(); o.onChange?.(); });
    return field(label, sel, o);
  };
  const toggle = (ctx, path, title, desc, o = {}) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = o.invert ? !getP(ctx.draft, path) : getP(ctx.draft, path) !== false && getP(ctx.draft, path) != null;
    box.addEventListener('change', () => { setP(ctx.draft, path, o.invert ? !box.checked : box.checked); ctx.changed(); });
    return h('label', { class: `switch${o.full ? ' full' : ''}` }, box, h('div', {}, h('b', { text: title }), h('span', { text: desc })));
  };
  const section = (title, lead, ...kids) => h('section', { class: 'section' }, h('h2', { text: title }), lead ? h('p', { class: 'lead', text: lead }) : null, ...kids);

  // ---------- get started ----------
  async function startPage() {
    const list = S.ov.checklist;
    const done = list.filter((c) => c.done).length;
    const preview = h('div', { class: 'label' }, h('img', { alt: 'Your bottle label', src: svgSrc((await api('POST', '/v1/console/preview-label', { changes: {} })).svg) }));
    shell('start', head(done === list.length ? `${S.config.name} is all set` : `Welcome to ${S.config.name}`, done === list.length ? 'Everything is set up. Change anything any time; every change is saved as a version you can put back.' : 'A few things to set up before your first bottle. Each one takes a minute or two.'),
      h('div', { class: 'grid2' },
        h('section', { class: 'panel-box' }, h('h2', {}, 'Getting started', h('span', { class: 'pill', text: `${done} of ${list.length}` })), h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': done, 'aria-valuemax': list.length, 'aria-label': 'Setup progress' }, h('i', { style: `width:${(done / list.length) * 100}%` })),
          h('div', { class: 'steps-list' }, list.map((c) => link(c.path, { class: c.done ? 'done' : '' }, h('div', { class: 'tick', 'aria-hidden': 'true' }, c.done ? icon(I.start) : null), h('span', { text: c.label }), h('b', { text: c.done ? 'Done' : 'Set up →' }))))),
        h('div', { class: 'stack' },
          h('div', { class: 'preview big' }, h('div', { class: 'cap' }, h('b', { text: 'Your bottle today' }), h('span', { text: 'Your most recent label, drawn with your current settings' })), preview),
          h('section', { class: 'panel-box' }, h('h2', { text: 'At a glance' }),
            h('div', { class: 'kpis', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' },
              h('div', { class: 'kpi' }, h('span', { text: 'Machines' }), h('b', { text: String(S.ov.locations.filter((l) => l.kind === 'machine').length) })),
              h('div', { class: 'kpi' }, h('span', { text: 'Giving' }), h('b', { text: S.ov.config.giving.mode === 'per_unit' ? `${S.ov.config.giving.centsPerUnit}¢` : S.ov.config.giving.mode === 'percent_of_revenue' ? `${S.ov.config.giving.percentOfRevenue}%` : 'Off' })),
              h('div', { class: 'kpi' }, h('span', { text: 'Settings' }), h('b', { text: `v${S.ov.version}` })))))));
  }

  // ---------- company ----------
  function companyPage() {
    settingsPage('company', 'Company', 'The basics: your name, where your QR codes point, and how people get bottles.', (ctx) => [
      h('div', { class: 'stack' },
        section('Name and web address', null, h('div', { class: 'form' },
          text(ctx, 'name', 'Company name', { max: 60, hint: 'Shown in the app, on receipts and in the open books.' }),
          text(ctx, 'receiptBaseUrl', 'QR web address', { max: 200, mono: true, placeholder: 'https://go.yourbrand.com', hint: 'Every QR code on your bottles opens a page here. Point this domain at the platform before changing it.' }),
          select(ctx, 'timezone', 'Time zone', [...new Set([S.ov.config.timezone, ...S.ov.options.timezones].filter(Boolean))].map((t) => [t, t.replace(/_/g, ' ')]), { hint: 'Used for “today”, delivery nights and daily books.' }))),
        section('Bottles for people', 'What people pay at your machines and in the app, and how many free bottles one person can get.', h('div', { class: 'form' },
          select(ctx, 'consumerPricing', 'Bottle price', [['free', 'Free (paid for by the ads)'], ['discounted', 'Discounted'], ['full', 'Full price']]),
          num(ctx, 'consumer.freeBottlesPerDay', 'Free bottles per person a day', { min: 0, max: 24, hint: 'So nobody empties a machine.' }),
          num(ctx, 'consumer.retailValueCents', 'What a bottle costs in a store', { min: 0, max: 1000, suffix: '¢', hint: (v) => `Used for “you saved ${dollars(v ?? 0)}” in the app.` }))),
        section('When a machine’s internet drops', 'Model 6 machines keep a few labels ready so they can still give water. Those bottles are billed when the machine is back online.', h('div', { class: 'form' },
          ctx.draft.machines ? null : (ctx.draft.machines = { offlineWalkUp: true, offlinePerHour: 20, bufferSize: 12 }, null),
          toggle(ctx, 'machines.offlineWalkUp', 'Give free bottles at the screen while offline', 'No app needed then: people tap the screen. Without the internet the machine can’t check anyone’s daily limit.', { full: true }),
          num(ctx, 'machines.offlinePerHour', 'At most this many an hour, per machine', { min: 0, max: 120 }),
          num(ctx, 'machines.bufferSize', 'Labels each machine keeps ready', { min: 0, max: 50, hint: 'Their ads are held, never billed unless printed. Unused ones are let go after a day.' }))))]);
  }

  // ---------- brand ----------
  function brandPage() {
    const img = h('img', { alt: 'Sample label with your brand' });
    const problem = h('div', { class: 'notice err', hidden: true });
    let timer = null, seq = 0;
    const refresh = (ch) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const r = await api('POST', '/v1/console/preview-label', { changes: ch });
          if (mine !== seq) return;
          if (r.svg && (!r.problem || !img.src)) img.src = svgSrc(r.svg);
          problem.hidden = !r.problem; problem.textContent = r.problem ? `${r.problem} The preview keeps the last colors that worked, and this can’t be saved until it’s fixed.` : '';
        } catch (e) { problem.hidden = false; problem.textContent = e.message; }
      }, 220);
    };
    cleanup = () => clearTimeout(timer);
    settingsPage('brand', 'Brand', 'Your panel on every bottle, the app and the scan pages. The preview updates as you type.', (ctx) => [
      h('div', { class: 'stack' },
        h('div', { class: 'preview' }, h('div', { class: 'cap' }, h('b', { text: 'Preview' }), h('span', { text: 'Your most recent bottle with these settings. The panel on the right is always yours.' })), h('div', { class: 'label' }, img), problem),
        section('Logo and lettering', null, h('div', { class: 'form' },
          text(ctx, 'brand.logoTop', 'Logo, top line', { max: 12 }), text(ctx, 'brand.logoBottom', 'Logo, bottom line', { max: 12, hint: 'Printed in your accent color.' }),
          text(ctx, 'brand.tagline', 'Tagline', { max: 60, full: true, placeholder: 'Optional' }),
          select(ctx, 'brand.fontFamily', 'Lettering', S.ov.options.fonts.map((f) => [f.value, f.label]), { hint: 'Only fonts every printer has.' }))),
        section('Colors', 'Text must be easy to read on the panel; the preview tells you if it isn’t.', h('div', { class: 'form' },
          color(ctx, 'brand.panelColor', 'Panel'), color(ctx, 'brand.textColor', 'Text'), color(ctx, 'brand.accentColor', 'Accent', { hint: 'The bottom logo line, the giving line and buttons in the app.' }))),
        section('Product facts', 'Printed small at the bottom of the panel. One line each.', text(ctx, 'productFacts', 'Lines', { area: true, lines: true, full: true, hint: 'What the water is, the size, the source and who bottled it. Up to 6 lines.' })))],
    { onChange: (_d, ch) => refresh(ch) });
  }

  // ---------- ads and prices ----------
  function adsPage() {
    const sizes = [[1, 'One sixth'], [2, 'Two sixths'], [3, 'Half'], [4, 'Two thirds'], [5, 'Five sixths'], [6, 'The whole wrap']];
    settingsPage('ads', 'Ads and prices', 'What goes on your bottles and what advertisers pay. Prices are per print, scan, AR launch or sale.', (ctx) => {
      const blocked = new Set(ctx.draft.adRules.blockedCategories);
      const cats = [...new Set([...S.ov.options.categories, ...blocked])];
      const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Blocked categories' }, cats.map((c) => h('button', { type: 'button', 'aria-pressed': String(blocked.has(c)), onclick: (e) => { blocked.has(c) ? blocked.delete(c) : blocked.add(c); e.currentTarget.setAttribute('aria-pressed', String(blocked.has(c))); ctx.draft.adRules.blockedCategories = cats.filter((x) => blocked.has(x)); ctx.changed(); } }, c.replace(/-/g, ' '))));
      return [h('div', { class: 'stack' },
        section('Ads on each bottle', null, h('div', { class: 'form' },
          num(ctx, 'adRules.minAdsPerUnit', 'Fewest ads on a bottle', { min: 0, max: 6, hint: 'Empty space is filled with your house ad.' }),
          num(ctx, 'adRules.maxAdsPerUnit', 'Most ads on a bottle', { min: 1, max: 6 }),
          num(ctx, 'adRules.maxPackShare', 'Most of a pack one advertiser can have', { min: 5, max: 100, scale: 100, suffix: '%', int: false, hint: 'In 6, 12 and 24 packs, so every pack has variety.' }),
          select(ctx, 'adRules.repeatScanWindowSec', 'Don’t bill the same person’s repeat scans within', [[0, 'Bill every scan'], [300, '5 minutes'], [600, '10 minutes'], [3600, '1 hour'], [86400, '1 day']]),
          toggle(ctx, 'adRules.competitorSeparation', 'Keep competitors apart', 'Two ads from the same competitor group never share a bottle.', { full: true }))),
        section('Categories you won’t print', 'Tap to block. Advertisers in a blocked category can’t sign up or run ads.', chips),
        section('What advertisers pay', 'Charged only when it happens: a confirmed print, a scan that loaded, an AR launch, a sale.', h('div', { class: 'form' },
          ...sizes.map(([k, l]) => num(ctx, `prices.perPrintBySixths.${k}`, `Print: ${l.toLowerCase()} of the label`, { min: 0, max: 1000, suffix: '¢' })),
          num(ctx, 'prices.perScan', 'Each scan', { min: 0, max: 1000, suffix: '¢' }), num(ctx, 'prices.perArLaunch', 'Each AR launch', { min: 0, max: 1000, suffix: '¢' }),
          num(ctx, 'prices.commissionPercent', 'Commission on sales', { min: 0, max: 50, step: 0.5, int: false, suffix: '%' }), num(ctx, 'prices.perBoxFace', 'Each side of a delivery box', { min: 0, max: 5000, suffix: '¢' }),
          num(ctx, 'prices.customUnit', 'A custom bottle (what people pay)', { min: 0, max: 10000, suffix: '¢', hint: (v) => dollars(v ?? 0) }))))];
    });
  }

  // ---------- giving ----------
  function givingPage() {
    settingsPage('giving', 'Giving', 'What your bottles give, and to whom. It’s printed on every bottle and shown in the open books. Giving can be off.', (ctx) => {
      const g = ctx.draft.giving;
      const amount = h('div', { class: 'form' });
      const charityOpts = () => [...new Set([...S.ov.charities, g.defaultCharity].filter(Boolean))].map((c) => [c, c]);
      const drawAmount = () => {
        const where = S.ov.locations;
        amount.replaceChildren(...(g.mode === 'none' ? [h('p', { class: 'full muted', style: 'margin:0', text: 'Nothing is given and the giving line disappears from your bottles.' })] : [
          g.mode === 'per_unit' ? num(ctx, 'giving.centsPerUnit', 'Each bottle gives', { min: 1, max: 100, suffix: '¢' }) : num(ctx, 'giving.percentOfRevenue', 'Share of ad money given', { min: 0.5, max: 50, step: 0.5, int: false, suffix: '%' }),
          charityOpts().length ? select(ctx, 'giving.defaultCharity', 'Charity', charityOpts(), { hint: 'Add charities below.' }) : text(ctx, 'giving.defaultCharity', 'Charity', { max: 80 }),
          num(ctx, 'giving.minimumTransferCents', 'Send to a charity once it’s owed at least', { min: 1, max: 10000, scale: 0.01, suffix: '$', hint: 'Smaller amounts wait for the next transfer.' }),
          where.length ? h('div', { class: 'field full' }, h('label', { text: 'A different charity for some machines or routes' }), h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('tbody', {}, where.map((l) => {
            const sel = h('select', { class: 'input', 'aria-label': `Charity for ${l.name}` }, h('option', { value: '', text: 'Same as above' }), charityOpts().map(([v]) => h('option', { value: v, text: v })));
            sel.value = g.charityByLocation?.[l.id] ?? '';
            sel.addEventListener('change', () => { const map = { ...(g.charityByLocation ?? {}) }; if (sel.value) map[l.id] = sel.value; else delete map[l.id]; g.charityByLocation = map; ctx.changed(); });
            return h('tr', {}, h('td', {}, h('b', { text: l.id }), h('div', { class: 'muted', style: 'font-size:13px', text: `${l.kind === 'route' ? 'Delivery route' : 'Machine'} · ${l.name}` })), h('td', { style: 'width:55%' }, sel));
          }))))) : null,
        ]));
      };
      const modes = [['per_unit', 'Per bottle', 'A fixed amount from every bottle printed.'], ['percent_of_revenue', 'Share of ad money', 'A percentage of what advertisers pay.'], ['none', 'No giving', 'Nothing is given or printed.']];
      const radios = h('div', { class: 'radio-cards', role: 'radiogroup', 'aria-label': 'How you give' }, modes.map(([v, t, d]) => {
        const r = h('input', { type: 'radio', name: 'gmode', value: v }); r.checked = g.mode === v;
        r.addEventListener('change', () => { g.mode = v; if (v === 'per_unit' && !g.centsPerUnit) g.centsPerUnit = 10; if (v === 'percent_of_revenue' && !g.percentOfRevenue) g.percentOfRevenue = 5; if (v !== 'none' && !g.minimumTransferCents) g.minimumTransferCents = 2500; drawAmount(); ctx.changed(); });
        return h('label', {}, r, h('b', { text: t }), h('span', { text: d }));
      }));
      drawAmount();
      const cName = h('input', { class: 'input', id: 'ch-name', maxlength: 80, placeholder: 'Austin Parks Foundation' });
      const cSite = h('input', { class: 'input', id: 'ch-site', maxlength: 200, placeholder: 'https://…' });
      const cMail = h('input', { class: 'input', id: 'ch-mail', type: 'email', maxlength: 200, placeholder: 'giving@charity.org' });
      const addCharity = h('form', { class: 'form', onsubmit: async (e) => { e.preventDefault(); try { await api('POST', '/v1/charities', { name: cName.value.trim(), ...(cSite.value.trim() ? { website: cSite.value.trim() } : {}), ...(cMail.value.trim() ? { email: cMail.value.trim() } : {}) }); S.ov.charities = [...new Set([...S.ov.charities, cName.value.trim()])].sort(); toast(`${cName.value.trim()} added.`); cName.value = cSite.value = cMail.value = ''; drawAmount(); } catch (x) { toast(x.message); } } },
        field('Charity name', cName), field('Website', cSite), field('Email for transfer receipts', cMail), h('div', { class: 'field', style: 'justify-content:flex-end' }, h('button', { class: 'btn secondary', type: 'submit' }, 'Add charity')));
      return [h('div', { class: 'stack' },
        section('How you give', null, radios, amount),
        section('Your charities', S.ov.charities.length ? `${S.ov.charities.join(', ')}. Transfers go out from the ops console.` : 'None yet.', addCharity),
        section('Open books', 'Your public page shows what came in, what went out and every transfer. Customers are never named.', h('div', { class: 'form' },
          toggle(ctx, 'openBooks', 'Publish our books', 'Anyone can see your totals, each bottle’s receipt and the daily proof.', { full: true }),
          num(ctx, 'unitCosts.water', 'Standard cost: water', { min: 0, max: 500, suffix: '¢' }), num(ctx, 'unitCosts.bottle', 'Standard cost: bottle and cap', { min: 0, max: 500, suffix: '¢' }),
          num(ctx, 'unitCosts.label', 'Standard cost: label and ink', { min: 0, max: 500, suffix: '¢' }), num(ctx, 'unitCosts.machine', 'Standard cost: machine or delivery', { min: 0, max: 500, suffix: '¢' }))))];
    });
  }

  // ---------- modules ----------
  const moduleInfo = {
    'freewater-ads': 'Sells every slot to advertisers: guaranteed buys and bids, your rules, your house ad for the rest.',
    'house-only': 'Only your own house ads. No advertisers.',
    'svg-label': 'Draws print-ready labels and box faces at real size.',
    'virtual-printer': 'Stands in until the real printers are chosen. Confirms every print without printing.',
  };
  function modulesPage() {
    const slots = [['ads', 'Ad engine', 'Decides which ads go on each bottle.'], ['renderer', 'Label maker', 'Turns the chosen ads into the label to print.'], ['printer', 'Printer', 'Talks to the printer at each machine and micro-factory.']];
    settingsPage('modules', 'Modules', 'Each part of the platform can be swapped without touching the others. New choices appear here as they’re added.', (ctx) => [h('div', { class: 'stack' },
      ...slots.map(([slot, title, lead]) => section(title, lead, h('div', { class: 'radio-cards', role: 'radiogroup', 'aria-label': title }, S.ov.options.modules[slot].map((name) => {
        const r = h('input', { type: 'radio', name: `m-${slot}`, value: name }); r.checked = ctx.draft.modules[slot] === name;
        r.addEventListener('change', () => { ctx.draft.modules[slot] = name; ctx.changed(); });
        return h('label', {}, r, h('b', { class: 'mono', text: name }), h('span', { text: moduleInfo[name] ?? 'A module added for your company.' }));
      })))),
      h('div', { class: 'notice', text: 'Printers aren’t chosen yet. When they are, each one is added as a printer module and shows up here.' }))]);
  }

  // ---------- machines ----------
  async function machinesPage() {
    const list = S.ov.locations;
    const once = h('div');
    const hw = h('select', { class: 'input' }, h('option', { value: 'model6', text: 'Model 6 (prints its own bottles)' }), h('option', { value: 'virtual', text: 'Other (uses the company printer)' }));
    const f = { id: h('input', { class: 'input', maxlength: 20, placeholder: 'ATX-031', style: 'text-transform:uppercase;font-family:var(--mono)' }), name: h('input', { class: 'input', maxlength: 60, placeholder: 'South Congress' }), city: h('input', { class: 'input', maxlength: 60, placeholder: 'Austin' }), address: h('input', { class: 'input', maxlength: 200, placeholder: '1600 S Congress Ave, Austin, TX' }) };
    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/v1/console/machines', { id: f.id.value.trim(), hardware: hw.value, name: f.name.value.trim(), city: f.city.value.trim(), ...(f.address.value.trim() ? { address: f.address.value.trim() } : {}) });
        S.ov.locations.push(r.machine);
        tbody.append(row(r.machine));
        once.replaceChildren(h('div', { class: 'once' }, h('b', { text: `${r.machine.id} is added. Here’s its API key.` }), h('p', { text: 'Put this key in the machine’s settings (FW_KEY). It can only print bottles at this machine, and this is the only time it’s shown. If it’s lost, turn it off on the API keys page and add the machine’s key again.' }), h('div', { class: 'secret' }, h('code', { text: r.apiKey }), h('button', { class: 'btn small', type: 'button', onclick: () => copy(r.apiKey) }, 'Copy'))));
        for (const i of Object.values(f)) i.value = '';
      } catch (x) { toast(x.message); }
    } }, field('Machine id', f.id, { hint: 'Printed on the machine. Capital letters, numbers and dashes.' }), field('Name', f.name, { hint: 'Usually the street or building.' }), field('City', f.city), field('Address', f.address), field('Hardware', hw, { full: true }), h('div', { class: 'field full' }, h('button', { class: 'btn', type: 'submit' }, 'Add machine')));
    const row = (l) => h('tr', {}, h('td', {}, h('b', { class: 'mono', text: l.id })), h('td', { text: l.kind === 'route' ? 'Delivery route' : l.hardware === 'model6' ? 'Model 6' : 'Machine' }), h('td', {}, l.name, l.address ? h('div', { class: 'muted', style: 'font-size:13px', text: l.address }) : null), h('td', { text: l.city }), h('td', { text: l.printSeconds ? `${l.printSeconds} s` : '—' }));
    const tbody = h('tbody', {}, list.map(row));
    shell('machines', head('Machines', 'Every machine and delivery route. Each machine prints with its own API key.'),
      h('div', { class: 'stack' },
        h('section', { class: 'section' }, h('h2', { text: 'Add a machine' }), form, once),
        h('section', { class: 'section' }, h('h2', { text: `${list.length} place${list.length === 1 ? '' : 's'}` }), list.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Id', 'Kind', 'Name', 'City', 'Print time'].map((x) => h('th', { text: x })))), tbody)) : h('div', { class: 'empty', text: 'No machines yet. Add your first one above.' }))));
  }

  // ---------- team ----------
  const roles = [['owner', 'Owner', 'Everything, including this console'], ['ops', 'Ops', 'Machines, routes and deliveries'], ['finance', 'Finance', 'Books, transfers and invoices'], ['reviewer', 'Reviewer', 'Approves ads'], ['driver', 'Driver', 'The driver app']];
  async function teamPage() {
    const people = await api('GET', '/v1/team');
    const email = h('input', { class: 'input', type: 'email', maxlength: 200, placeholder: 'sam@company.com' });
    const name = h('input', { class: 'input', maxlength: 80, placeholder: 'Sam' });
    const role = h('select', { class: 'input' }, roles.map(([v, l, d]) => h('option', { value: v, text: `${l}: ${d}` }))); role.value = 'ops';
    const form = h('form', { class: 'form', onsubmit: async (e) => { e.preventDefault(); try { await api('POST', '/v1/team', { email: email.value.trim(), role: role.value, ...(name.value.trim() ? { displayName: name.value.trim() } : {}) }); toast(`${email.value.trim()} can sign in now.`); render(); } catch (x) { toast(x.message); } } },
      field('Email', email), field('Name', name), field('Role', role, { full: true }), h('div', { class: 'field full' }, h('button', { class: 'btn', type: 'submit' }, 'Add to team')));
    const label = (r) => roles.find(([v]) => v === r)?.[1] ?? (r === 'advertiser' ? 'Advertiser staff' : r);
    shell('team', head('Team', 'People who run the company. They sign in with a code sent to their email; there are no passwords.'),
      h('div', { class: 'stack' },
        section('Add someone', null, form),
        section(`${people.length} ${people.length === 1 ? 'person' : 'people'}`, null, h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Name', 'Role', 'Last signed in', ''].map((x) => h('th', { text: x })))),
          h('tbody', {}, people.map((p) => h('tr', {}, h('td', {}, h('b', { text: p.displayName || p.email }), p.displayName ? h('div', { class: 'muted', style: 'font-size:13px', text: p.email }) : null), h('td', {}, h('span', { class: `pill${p.role === 'owner' ? ' dark' : ''}`, text: label(p.role) })), h('td', { text: ago(p.lastSignInAt) }),
            h('td', { style: 'text-align:right' }, p.id === S.me.id ? h('span', { class: 'muted', text: 'You' }) : h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { await api('DELETE', `/v1/team/${p.id}`); toast(`${p.displayName || p.email} is off the team and signed out.`); render(); } catch (x) { toast(x.message); } } }, 'Remove'))))))))));
  }

  // ---------- history ----------
  async function historyPage() {
    const versions = await api('GET', '/v1/console/history');
    shell('history', head('History', 'Every saved change: who made it, when, and what changed. Put any version back; that becomes a new version, so nothing is lost.'),
      h('div', { class: 'history' }, versions.map((v, i) => h('article', {},
        h('div', { class: 'v', text: `v${v.version}` }),
        h('div', {}, h('div', { class: 'who', text: `${v.changedBy ?? 'Set up'} · ${when(v.at)}${i === 0 ? ' · current' : ''}` }), h('ul', {}, v.changes.slice(0, 8).map((c) => h('li', { text: c })), v.changes.length > 8 ? h('li', { class: 'muted', text: `and ${v.changes.length - 8} more` }) : null)),
        i === 0 ? h('span', { class: 'pill ok', text: 'In use' }) : h('button', { class: 'btn secondary small', type: 'button', onclick: async (e) => { const btn = e.currentTarget; btn.disabled = true; try { const r = await api('POST', `/v1/console/history/${v.version}/restore`); toast(r.changes.length ? `Version ${v.version} is back, saved as version ${r.version}.` : 'That’s already what you have.'); render(); } catch (x) { toast(x.message); btn.disabled = false; } } }, 'Put this back')))));
  }

  // ---------- API keys ----------
  async function keysPage() {
    const { keys, scopes } = await api('GET', '/v1/keys');
    const once = h('div');
    const name = h('input', { class: 'input', maxlength: 60, placeholder: 'Warehouse system' });
    const picks = Object.entries(scopes).map(([s, d]) => { const c = h('input', { type: 'checkbox', value: s }); return [c, h('label', {}, c, h('div', {}, h('b', { text: s }), d))]; });
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const chosen = picks.filter(([c]) => c.checked).map(([c]) => c.value);
      if (!chosen.length) return toast('Pick at least one thing the key can do.');
      try {
        const k = await api('POST', '/v1/keys', { name: name.value.trim() || 'Untitled key', scopes: chosen });
        once.replaceChildren(h('div', { class: 'once' }, h('b', { text: `“${k.name}” is ready.` }), h('p', { text: 'Copy it now and keep it somewhere safe, like your server’s secret settings. It’s never shown again; we keep only a fingerprint of it.' }), h('div', { class: 'secret' }, h('code', { text: k.key }), h('button', { class: 'btn small', type: 'button', onclick: () => copy(k.key) }, 'Copy'))));
        tbody.prepend(row(k)); name.value = ''; for (const [c] of picks) c.checked = false;
      } catch (x) { toast(x.message); }
    } }, field('Name', name, { hint: 'So you know what uses it.' }), h('div', { class: 'field' }, h('label', { text: 'What it can do' }), h('div', { class: 'scope-list' }, picks.map(([, l]) => l))), h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Make key')));
    const row = (k) => h('tr', { style: k.revokedAt ? 'opacity:.5' : null }, h('td', {}, h('b', { text: k.name }), h('div', { class: 'mono muted', text: k.hint ?? '' })), h('td', {}, h('div', { class: 'pills' }, k.scopes.map((s) => h('span', { class: 'pill', text: s })))),
      h('td', { text: k.revokedAt ? `Off since ${when(k.revokedAt)}` : ago(k.lastUsedAt) }), h('td', { class: 'muted', text: k.createdBy ?? '—' }),
      h('td', { style: 'text-align:right' }, k.revokedAt ? null : h('button', { class: 'btn secondary small', type: 'button', onclick: async (e) => { const btn = e.currentTarget; try { await api('DELETE', `/v1/keys/${k.id}`); toast(`“${k.name}” is off. Anything using it stops now.`); btn.closest('tr').replaceWith(row({ ...k, revokedAt: new Date().toISOString() })); } catch (x) { toast(x.message); } } }, 'Turn off')));
    const tbody = h('tbody', {}, keys.map(row));
    shell('keys', head('API keys', 'For your systems: machines, the packing line, your warehouse or accounting. People sign in instead.', link('/developers', { class: 'btn secondary small' }, 'Read the docs')),
      h('div', { class: 'stack' }, section('Make a key', 'Give each system its own key with only what it needs.', form, once),
        section('Your keys', null, keys.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Key', 'Can do', 'Last used', 'Made by', ''].map((x) => h('th', { text: x })))), tbody)) : h('div', { class: 'empty', text: 'No keys yet.' }))));
  }

  // ---------- webhooks ----------
  let catalog = null;
  const getCatalog = async () => (catalog ??= await api('GET', '/v1/public/webhook-events'));
  const statusPill = (s) => h('span', { class: `pill ${s === 'delivered' || s === 'active' ? 'ok' : s === 'retrying' || s === 'pending' ? 'warn' : 'bad'}`, text: { delivered: 'Delivered', active: 'On', retrying: 'Retrying', pending: 'Queued', gave_up: 'Gave up', disabled: 'Off' }[s] ?? s });
  function eventPicker(selected) {
    const all = h('input', { type: 'checkbox' }); all.checked = selected.includes('*');
    const boxes = [];
    const groups = {};
    for (const e of catalog.filter((x) => x.type !== 'webhook.test')) (groups[e.group] ??= []).push(e);
    const grid = h('div', { class: 'events-pick' }, Object.entries(groups).map(([g, list]) => [h('h4', { text: g }), list.map((e) => { const c = h('input', { type: 'checkbox', value: e.type }); c.checked = all.checked || selected.includes(e.type); c.disabled = all.checked; boxes.push(c); return h('label', { title: e.description }, c, h('div', {}, h('code', { text: e.type }), h('div', { class: 'muted', style: 'font-size:13px', text: e.description }))); })]));
    all.addEventListener('change', () => { for (const c of boxes) { c.disabled = all.checked; if (all.checked) c.checked = true; } });
    return { el: h('div', { class: 'stack', style: 'gap:8px' }, h('label', { class: 'switch' }, all, h('div', {}, h('b', { text: 'Every event' }), h('span', { text: 'Including new kinds of events as they’re added.' }))), grid), value: () => (all.checked ? ['*'] : boxes.filter((c) => c.checked).map((c) => c.value)) };
  }
  async function webhooksPage() {
    const [list] = await Promise.all([api('GET', '/v1/webhooks'), getCatalog()]);
    const url = h('input', { class: 'input', type: 'url', maxlength: 500, placeholder: 'https://example.com/webhooks/freewater', style: 'font-family:var(--mono)' });
    const desc = h('input', { class: 'input', maxlength: 120, placeholder: 'Warehouse system' });
    const picker = eventPicker([]);
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const events = picker.value();
      if (!events.length) return toast('Pick at least one event.');
      try { const w = await api('POST', '/v1/webhooks', { url: url.value.trim(), events, ...(desc.value.trim() ? { description: desc.value.trim() } : {}) }); S.justMade = w.id; go(`/console/webhooks/${w.id}`); } catch (x) { toast(x.message); }
    } }, h('div', { class: 'form' }, field('Address', url, { hint: 'Must start with https://' }), field('Note', desc, { hint: 'What it’s for.' })), h('div', { class: 'field' }, h('label', { text: 'Events to send' }), picker.el), h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Add webhook')));
    shell('webhooks', head('Webhooks', 'Your systems hear about bottles, scans, deliveries and money the moment they happen. Each one is signed so you know it’s really from us.', link('/developers/webhooks', { class: 'btn secondary small' }, 'How webhooks work')),
      h('div', { class: 'stack' },
        list.length ? section('Your webhooks', null, h('div', { class: 'scroll-x' }, h('table', { class: 'list log' }, h('thead', {}, h('tr', {}, ['Address', 'Events', 'Status', 'Delivered', 'Retrying', 'Gave up', 'Last'].map((x) => h('th', { text: x })))),
          h('tbody', {}, list.map((w) => h('tr', { tabindex: '0', onclick: () => go(`/console/webhooks/${w.id}`), onkeydown: (e) => { if (e.key === 'Enter') go(`/console/webhooks/${w.id}`); } }, h('td', {}, h('b', { class: 'mono', text: w.url }), w.description ? h('div', { class: 'muted', style: 'font-size:13px', text: w.description }) : null), h('td', { text: w.events.includes('*') ? 'All' : String(w.events.length) }), h('td', {}, statusPill(w.status)), h('td', { text: String(w.stats.delivered) }), h('td', { text: String(w.stats.retrying) }), h('td', { text: String(w.stats.gaveUp) }), h('td', { text: ago(w.stats.lastDeliveryAt) }))))))) : null,
        section('Add a webhook', null, form)));
  }
  async function webhookPage(id) {
    const [w] = await Promise.all([api('GET', `/v1/webhooks/${id}`), getCatalog()]);
    let filter = '';
    const logBox = h('div');
    const detail = h('div', { class: 'detail' });
    const secretBox = h('div');
    const showSecret = (s, fresh) => secretBox.replaceChildren(fresh ? h('div', { class: 'once' }, h('b', { text: 'Your signing secret' }), h('p', { text: 'Your server uses it to check each webhook really came from us. Copy it into your server’s secret settings.' }), h('div', { class: 'secret' }, h('code', { text: s }), h('button', { class: 'btn small', type: 'button', onclick: () => copy(s) }, 'Copy'))) : h('div', { class: 'secret' }, h('code', { text: s }), h('button', { class: 'btn small', type: 'button', onclick: () => copy(s) }, 'Copy')));
    secretBox.replaceChildren(h('div', { class: 'toolbar' }, h('span', { class: 'mono muted', text: w.secretHint }), h('button', { class: 'btn secondary small', type: 'button', onclick: () => showSecret(w.secret) }, 'Show secret')));
    if (S.justMade === id) { showSecret(w.secret, true); S.justMade = null; }
    async function loadLog() {
      const rows = await api('GET', `/v1/webhooks/${id}/deliveries?limit=25${filter ? `&status=${filter}` : ''}`);
      logBox.replaceChildren(rows.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list log' }, h('thead', {}, h('tr', {}, ['When', 'Event', 'Status', 'Tries', 'Answer'].map((x) => h('th', { text: x })))),
        h('tbody', {}, rows.map((d) => h('tr', { tabindex: '0', onclick: (e) => openDelivery(d.id, e.currentTarget), onkeydown: (e) => { if (e.key === 'Enter') openDelivery(d.id, e.currentTarget); } }, h('td', { text: when(d.createdAt) }), h('td', { class: 'mono', text: d.type }), h('td', {}, statusPill(d.status)), h('td', { text: String(d.attempts) }), h('td', { class: 'mono', text: d.lastStatus ? String(d.lastStatus) : d.lastError ? 'No answer' : '—' }))))))
        : h('div', { class: 'empty', text: filter ? 'Nothing here.' : 'Nothing sent yet. Send a test event, or wait for something to happen.' }));
    }
    async function openDelivery(did, tr) {
      for (const r of logBox.querySelectorAll('tr[aria-selected]')) r.removeAttribute('aria-selected');
      tr?.setAttribute('aria-selected', 'true');
      const d = await api('GET', `/v1/webhook-deliveries/${did}`);
      let pretty = d.body; try { pretty = JSON.stringify(JSON.parse(d.body), null, 2); } catch {}
      detail.replaceChildren(h('h2', { style: 'margin:0;font-size:16px', text: d.type }),
        h('dl', {}, h('dt', { text: 'Status' }), h('dd', {}, statusPill(d.status)), h('dt', { text: 'Tries' }), h('dd', { text: String(d.attempts) }), h('dt', { text: 'Event id' }), h('dd', { class: 'mono', text: d.eventId }),
          d.lastStatus ? [h('dt', { text: 'Your server said' }), h('dd', { class: 'mono', text: `${d.lastStatus}${d.lastResponse ? ` · ${d.lastResponse.slice(0, 120)}` : ''}` })] : null,
          d.lastError ? [h('dt', { text: 'Problem' }), h('dd', { text: d.lastError })] : null,
          d.nextAttemptAt ? [h('dt', { text: 'Next try' }), h('dd', { text: when(d.nextAttemptAt) })] : null,
          d.durationMs != null ? [h('dt', { text: 'Took' }), h('dd', { text: `${d.durationMs} ms` })] : null),
        h('pre', { class: 'code', text: pretty }),
        d.status !== 'delivered' ? h('div', {}, h('button', { class: 'btn small', type: 'button', onclick: async () => { try { const r = await api('POST', `/v1/webhook-deliveries/${did}/retry`); toast(r.status === 'delivered' ? 'Delivered.' : `Still not delivered: ${r.lastError}`); await loadLog(); openDelivery(did); } catch (x) { toast(x.message); } } }, 'Send again now')) : null);
    }
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['', 'All'], ['delivered', 'Delivered'], ['retrying', 'Retrying'], ['gave_up', 'Gave up']].map(([v, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(v === filter), onclick: (e) => { filter = v; for (const b of tabs.children) b.setAttribute('aria-selected', 'false'); e.currentTarget.setAttribute('aria-selected', 'true'); loadLog(); } }, l)));
    const picker = eventPicker(w.events);
    shell('webhooks', head(w.url, w.description ?? 'Webhook', statusPill(w.status)),
      w.status === 'disabled' && w.disabledReason ? h('div', { class: 'notice err', style: 'margin-bottom:16px', text: w.disabledReason }) : null,
      h('div', { class: 'grid2' },
        h('div', { class: 'stack' },
          section('Try it', null, h('div', { class: 'toolbar' },
            h('button', { class: 'btn', type: 'button', onclick: async (e) => { const btn = e.currentTarget; btn.disabled = true; try { const r = await api('POST', `/v1/webhooks/${id}/test`); toast(r.status === 'delivered' ? `Test delivered. Your server said ${r.lastStatus}.` : `Test failed: ${r.lastError}`); await loadLog(); openDelivery(r.id); } catch (x) { toast(x.message); } btn.disabled = false; } }, 'Send a test event'),
            h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await api('PATCH', `/v1/webhooks/${id}`, { status: w.status === 'active' ? 'disabled' : 'active' }); toast(w.status === 'active' ? 'Turned off. Events are not queued while it’s off.' : 'Turned on. It carries on from now.'); render(); } catch (x) { toast(x.message); } } }, w.status === 'active' ? 'Turn off' : 'Turn on'),
            h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await api('DELETE', `/v1/webhooks/${id}`); toast('Webhook removed.'); go('/console/webhooks'); } catch (x) { toast(x.message); } } }, 'Remove'))),
          section('Signing secret', 'Replace it any time; the new one is used from the next delivery.', secretBox, h('div', {}, h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { const r = await api('POST', `/v1/webhooks/${id}/rotate-secret`); showSecret(r.secret, true); toast('New secret in use.'); } catch (x) { toast(x.message); } } }, 'Replace secret'))),
          section('Events', null, picker.el, h('div', {}, h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { const ev = picker.value(); if (!ev.length) return toast('Pick at least one event.'); try { await api('PATCH', `/v1/webhooks/${id}`, { events: ev }); toast('Events saved.'); } catch (x) { toast(x.message); } } }, 'Save events')))),
        h('div', { class: 'stack' }, h('section', { class: 'section' }, detail), section('Latest deliveries', 'Retried after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and 24 h. After three days of failures the webhook is turned off and your owners are emailed.', tabs, logBox))));
    detail.replaceChildren(h('p', { class: 'muted', style: 'margin:0', text: 'Pick a delivery to see exactly what was sent and what came back.' }));
    await loadLog();
  }

  // ---------- licensees (FreeWater only) ----------
  async function licenseesPage() {
    if (!S.ov.you.platform) return shell('', h('div', { class: 'notice err', text: 'Only the platform operator sets up licensees.' }));
    const list = await api('GET', '/v1/platform/companies');
    const v = { id: '', name: '', ownerEmail: '', ownerName: '', panelColor: '#123B2A', textColor: '#FFFFFF', accentColor: '#F2C14E', logoTop: '', logoBottom: '', giving: 'none' };
    const mini = h('div', { class: 'panel-mini' });
    const drawMini = () => { mini.style.background = v.panelColor; mini.style.color = v.textColor; mini.replaceChildren(h('span', { text: v.logoTop || v.name.split(/\s+/)[0]?.toLowerCase() || 'your' }), h('span', { style: `color:${v.accentColor};margin-top:3px`, text: v.logoBottom || (v.name.split(/\s+/)[1] ?? '').toLowerCase() || 'brand' })); };
    const inp = (k, label, o = {}) => { const i = h('input', { class: 'input', maxlength: o.max ?? 80, placeholder: o.placeholder, type: o.type, style: o.mono ? 'font-family:var(--mono)' : null }); i.value = v[k]; i.addEventListener('input', () => { v[k] = i.value; if (k === 'name' && !idTouched) { v.id = i.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30); idInput.value = v.id; } drawMini(); }); return [i, field(label, i, o)]; };
    let idTouched = false;
    const [, nameF] = inp('name', 'Company name', { placeholder: 'Lake Water Co' });
    const [idInput, idF] = inp('id', 'Company id', { mono: true, max: 30, hint: 'Lowercase, used in links. Can’t be changed later.' });
    idInput.addEventListener('input', () => { idTouched = true; });
    const colorIn = (k, label) => { const pick = h('input', { type: 'color', value: v[k], 'aria-label': label }); pick.addEventListener('input', () => { v[k] = pick.value.toUpperCase(); drawMini(); }); return h('div', { class: 'field' }, h('label', { text: label }), h('div', { class: 'color' }, pick)); };
    const giving = h('select', { class: 'input' }, h('option', { value: 'none', text: 'No giving (they can turn it on)' }), h('option', { value: 'per_unit', text: '10¢ per bottle' }));
    giving.addEventListener('change', () => { v.giving = giving.value; });
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/v1/platform/companies', { id: v.id, name: v.name.trim(), ownerEmail: v.ownerEmail.trim(), ...(v.ownerName.trim() ? { ownerName: v.ownerName.trim() } : {}), giving: v.giving, brand: { panelColor: v.panelColor, textColor: v.textColor, accentColor: v.accentColor, ...(v.logoTop ? { logoTop: v.logoTop } : {}), ...(v.logoBottom ? { logoBottom: v.logoBottom } : {}) } });
        toast(`${r.company.name} is set up. We emailed ${r.owner.email} a link to their console.`);
        render();
      } catch (x) { toast(x.message); }
    } }, h('div', { style: 'display:flex;gap:18px;align-items:flex-start' }, h('div', { class: 'form', style: 'flex:1' }, nameF, idF, inp('ownerEmail', 'Owner’s email', { type: 'email', placeholder: 'ana@lakewater.com' })[1], inp('ownerName', 'Owner’s name', { placeholder: 'Ana' })[1], inp('logoTop', 'Logo, top line', { max: 12, placeholder: 'lake' })[1], inp('logoBottom', 'Logo, bottom line', { max: 12, placeholder: 'water' })[1], colorIn('panelColor', 'Panel'), colorIn('textColor', 'Text'), colorIn('accentColor', 'Accent'), field('Giving', giving)), mini),
      h('p', { class: 'muted', style: 'margin:0', text: 'They start with FreeWater’s ad rules and prices, their own house ad, and the virtual printer. Everything can be changed in their console.' }), h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Set up licensee')));
    drawMini();
    shell('licensees', head('Licensees', 'Every company running on the platform. Each one has its own brand, rules, books and team; none can see another’s.'),
      h('div', { class: 'stack' },
        section(`${list.length} companies`, null, h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['', 'Company', 'Ads', 'Giving', 'Machines', 'Team', 'Bottles', 'Last bottle'].map((x) => h('th', { text: x })))),
          h('tbody', {}, list.map((c) => h('tr', {}, h('td', { style: 'width:40px' }, h('div', { style: `width:26px;height:40px;border-radius:5px;background:${c.brand.panelColor};box-shadow:inset 0 -8px 0 ${c.brand.accentColor}` })), h('td', {}, h('b', { text: c.name }), h('div', { class: 'mono muted', text: c.id })), h('td', { class: 'mono', text: c.modules.ads }), h('td', { text: c.giving === 'none' ? 'Off' : 'On' }), h('td', { text: String(c.machines) }), h('td', { text: String(c.team) }), h('td', { text: c.bottles.toLocaleString() }), h('td', { text: ago(c.lastBottleAt) }))))))),
        section('Set up a new licensee', null, form)));
  }


  // ---------- the developer portal (public) ----------
  const pre = (code) => h('pre', { class: 'code', tabindex: '0' }, code);
  const c = (t) => h('code', { text: t });
  let openapiDoc = null;
  async function docs(pathname) {
    const base = fixture ? 'https://api.freewater.io' : location.origin;
    const pages = [['/developers', 'Overview'], ['/developers/webhooks', 'Webhooks'], ['/developers/events', 'Events'], ['/developers/reference', 'API reference']];
    const page = (...content) => {
      root.replaceChildren(h('div', { class: 'docs' },
        h('aside', { class: 'side' }, h('div', { class: 'logo', 'aria-label': 'FreeWater developers' }, h('span', { text: 'free' }), h('span', { text: 'water' }), h('small', { text: 'Developers' })),
          h('nav', { 'aria-label': 'Docs' }, pages.map(([p, l]) => link(p, { 'aria-current': pathname === p ? 'page' : null }, l))),
          h('div', { class: 'who' }, link('/console/keys', { class: 'btn small', style: 'color:#fff' }, S.token ? 'Your keys and webhooks' : 'Sign in to get a key'))),
        h('main', { class: 'main' }, h('article', { class: 'doc' }, ...content))));
      window.scrollTo(0, 0);
    };
    if (pathname === '/developers/webhooks') {
      return page(h('h1', { text: 'Webhooks' }),
        h('p', {}, 'A webhook is an address on your server that we send events to as they happen: a bottle printed, a QR scanned, a box delivered, money sent to a charity. Add one in the console under ', link('/console/webhooks', {}, 'Webhooks'), ', pick the events, and copy its signing secret.'),
        h('h2', { text: 'What we send' }),
        h('p', {}, 'A ', c('POST'), ' with a JSON body. Every event looks the same on the outside; ', c('data'), ' depends on the ', c('type'), '. Webhooks never contain personal details: no names, emails, phone numbers, addresses or viewer ids.'),
        pre(`POST /webhooks/freewater HTTP/1.1
Content-Type: application/json
FreeWater-Event: bottle.scanned
FreeWater-Delivery: whd_8c1f0e2a9b7d4c11a2f3
FreeWater-Signature: t=1792300000,v1=5f2b9c…

{
  "id": "ev_3a7d1c9e",          // the same event always has the same id
  "type": "bottle.scanned",
  "created": "2026-10-18T15:04:05.000Z",
  "company": "freewater",
  "apiVersion": "2026-10-01",
  "data": { "bottleId": "u_7f3a9c1e2b4d", "slot": 0, "pageLoaded": true }
}`),
        h('h2', { text: 'Check the signature' }),
        h('p', {}, 'Anyone can send a request to your address, so check that each one is really from us before trusting it. The ', c('FreeWater-Signature'), ' header holds the time it was sent (', c('t'), ') and an HMAC-SHA256 of ', c('<t>.<the raw body>'), ' made with your secret (', c('v1'), '). Use the raw body exactly as it arrived, before any JSON parsing, and refuse anything more than 5 minutes old so an old request can’t be replayed.'),
        h('h3', { text: 'Node.js' }),
        pre(`import crypto from 'node:crypto';
import express from 'express';

const app = express();
const secret = process.env.FREEWATER_WEBHOOK_SECRET; // whsec_…

app.post('/webhooks/freewater', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verify(secret, req.get('FreeWater-Signature'), req.body)) return res.sendStatus(400);
  const event = JSON.parse(req.body);
  res.sendStatus(200);           // answer first…
  handle(event).catch(console.error); // …then do the work
});

function verify(secret, header = '', body) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const want = crypto.createHmac('sha256', secret).update(\`\${t}.\`).update(body).digest('hex');
  return want.length === (parts.v1 || '').length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(parts.v1));
}`),
        h('h3', { text: 'Python' }),
        pre(`import hashlib, hmac, time

def verify(secret: str, header: str, body: bytes) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    t = int(parts.get("t", "0"))
    if abs(time.time() - t) > 300:
        return False
    want = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, parts.get("v1", ""))`),
        h('h2', { text: 'Answer quickly, and expect repeats' }),
        h('ul', {}, h('li', {}, 'Answer with any ', c('2xx'), ' within 10 seconds. Do slow work afterwards.'),
          h('li', {}, 'Anything else, or no answer, is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and 24 hours: eight tries over about two days.'),
          h('li', {}, 'Because of retries an event can arrive more than once. Keep the ', c('id'), ' of events you’ve handled and skip ones you’ve seen.'),
          h('li', {}, 'Events usually arrive in order, but a retry can land after a later event. Use ', c('created'), ' when order matters.'),
          h('li', {}, 'If every try fails for three days, the webhook is turned off and your company’s owners are emailed. Nothing is lost: turn it back on in the console and resend anything that was given up on.')),
        h('h2', { text: 'Test it' }),
        h('p', {}, 'In the console, “Send a test event” sends a ', c('webhook.test'), ' event straight away and shows exactly what your server answered. The delivery log keeps every request and answer, and any failed one can be sent again with one tap.'),
        h('p', {}, 'Manage webhooks with the API too: ', c('GET/POST /v1/webhooks'), ', ', c('PATCH/DELETE /v1/webhooks/{id}'), ', ', c('POST /v1/webhooks/{id}/test'), ', ', c('POST /v1/webhooks/{id}/rotate-secret'), ', ', c('GET /v1/webhooks/{id}/deliveries'), ' and ', c('POST /v1/webhook-deliveries/{id}/retry'), ', with a key that has the ', c('webhooks'), ' scope.'));
    }
    if (pathname === '/developers/events') {
      const list = await getCatalog();
      const groups = {};
      for (const e of list) (groups[e.group] ??= []).push(e);
      return page(h('h1', { text: 'Events' }), h('p', {}, 'Every event a webhook can hear about. Each example is the ', c('data'), ' part of the body.'),
        Object.entries(groups).map(([g, l]) => [h('h2', { text: g }), l.map((e) => h('div', { class: 'endpoint', id: e.type }, h('div', { class: 'top' }, h('span', { class: 'path', text: e.type })), h('div', { text: e.description }), pre(JSON.stringify(e.example, null, 2))))]));
    }
    if (pathname === '/developers/reference') {
      openapiDoc ??= await api('GET', '/v1/openapi.json');
      const groupOf = (p) => { const s = p.split('/')[2]; return { public: 'Public (no key)', auth: 'Signing in', me: 'People', units: 'Bottles', orders: 'Bottles', packs: 'Packs and delivery', routes: 'Packs and delivery', deliveries: 'Packs and delivery', driver: 'Packs and delivery', ops: 'Ops', review: 'Ops', campaigns: 'Ads', ads: 'Ads', experiences: 'Ads', assets: 'Ads', advertisers: 'Money', invoices: 'Money', purchases: 'Money', refunds: 'Money', ledger: 'Money', charities: 'Money', payouts: 'Money', books: 'Money', events: 'Events', webhooks: 'Webhooks', 'webhook-deliveries': 'Webhooks', keys: 'Keys and team', team: 'Keys and team', console: 'Console', platform: 'Platform operator' }[s] ?? 'Other'; };
      const all = [];
      for (const [path, ops] of Object.entries(openapiDoc.paths)) for (const [m, op] of Object.entries(ops)) all.push({ path, m, op, group: groupOf(path) });
      const order = ['Bottles', 'Packs and delivery', 'Ads', 'Money', 'Events', 'Webhooks', 'Keys and team', 'Console', 'People', 'Signing in', 'Ops', 'Public (no key)', 'Platform operator', 'Other'];
      const out = h('div', { class: 'stack' });
      const search = h('input', { class: 'input', type: 'search', placeholder: 'Search, e.g. webhook or pack', 'aria-label': 'Search the API' });
      const draw = () => {
        const q = search.value.trim().toLowerCase();
        const shown = all.filter((e) => !q || `${e.path} ${e.op.summary} ${e.group}`.toLowerCase().includes(q));
        out.replaceChildren(...order.filter((g) => shown.some((e) => e.group === g)).map((g) => h('section', { class: 'stack', style: 'gap:8px' }, h('h2', { text: g }), shown.filter((e) => e.group === g).map(({ path, m, op }) => {
          const props = op.requestBody?.content?.['application/json']?.schema?.properties;
          const req = op.requestBody?.content?.['application/json']?.schema?.required ?? [];
          return h('div', { class: 'endpoint' }, h('div', { class: 'top' }, h('span', { class: `method ${m}`, text: m.toUpperCase() }), h('span', { class: 'path', text: path }), op['x-scopes']?.length ? h('span', { class: 'pills' }, op['x-scopes'].map((s) => h('span', { class: 'pill', text: s }))) : h('span', { class: 'pill ok', text: 'no key' })),
            h('div', { text: op.summary }),
            props ? h('div', { class: 'fields' }, 'Body: ', Object.entries(props).map(([k, v], i) => [i ? ', ' : '', c(k), req.includes(k) ? '' : '?', v.type ? ` ${Array.isArray(v.type) ? v.type.join('|') : v.type}` : ''])) : null);
        }))));
      };
      search.addEventListener('input', draw);
      draw();
      return page(h('h1', { text: 'API reference' }), h('p', {}, `${all.length} operations. Machine-readable: `, h('a', { href: '/v1/openapi.json' }, 'openapi.json'), ' (OpenAPI 3.1). Pills show the scope a key needs.'), h('div', { class: 'search' }, search), out);
    }
    return page(h('h1', { text: 'Build on FreeWater' }),
      h('p', {}, 'One API runs everything: machines printing bottles, the micro-factory packing boxes, drivers delivering them, advertisers, apps and partners. Every key belongs to one company and only ever sees that company.'),
      h('h2', { text: '1. Get a key' }),
      h('p', {}, 'An owner makes keys in the console under ', link('/console/keys', {}, 'API keys'), '. Give each system its own key with only what it needs. Keys are shown once; we keep only a fingerprint.'),
      h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', { text: 'Scope' }), h('th', { text: 'Lets a key' }))), h('tbody', {}, [['orders', 'Print bottles (machines use this)'], ['packs', 'Print, check, load and deliver packs'], ['campaigns', 'Create and change ad campaigns, upload artwork'], ['purchases', 'Report sales and refunds made from a bottle'], ['ledger', 'Read the books'], ['events', 'Read the event log'], ['invoices', 'Run and read advertiser invoices'], ['webhooks', 'Add and change webhooks'], ['admin', 'Everything above, plus settings and the team']].map(([s, d]) => h('tr', {}, h('td', {}, c(s)), h('td', { text: d })))))),
      h('h2', { text: '2. Make a call' }),
      h('p', {}, 'Send the key as a bearer token. Everything is JSON over HTTPS.'),
      pre(`curl ${base}/v1/orders \\
  -H "Authorization: Bearer fwk_…" \\
  -H "Content-Type: application/json" \\
  -d '{ "orderId": "ATX-014-000183", "locationId": "ATX-014", "productId": "bottle-16oz" }'`),
      h('p', {}, 'That prints one bottle and answers with its slots, the QR code each one opens, and its receipt link. Sending the same ', c('orderId'), ' again returns the same bottle and prints nothing: retry safely after a timeout.'),
      h('h2', { text: '3. Hear about what happens' }),
      h('p', {}, 'Either read the event log, oldest first, paging with ', c('?after='), ':'),
      pre(`curl "${base}/v1/events?after=0&limit=100&type=label.printed" -H "Authorization: Bearer fwk_…"`),
      h('p', {}, 'or, better, add a ', link('/developers/webhooks', {}, 'webhook'), ' and we’ll send each event to you as it happens.'),
      h('h2', { text: 'Errors' }),
      h('p', {}, 'Errors come back with an HTTP status and a message written for people:'),
      pre(`HTTP/1.1 403 Forbidden
{ "error": { "code": "missing_scope", "message": "This key can't do that. It needs one of: ledger." } }`),
      h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('tbody', {}, [['400', 'Something in the request is wrong; the message says what.'], ['401', 'No key, or the key was turned off.'], ['403', 'The key can’t do that. It needs another scope.'], ['404', 'Not found, or it belongs to another company.'], ['409', 'It conflicts with something, like a change saved by someone else.'], ['422', 'Understood, but not allowed by the rules (for example a blocked ad category).'], ['5xx', 'Our fault. It has been logged; retry with the same ids.']].map(([s, d]) => h('tr', {}, h('td', {}, c(s)), h('td', { text: d })))))),
      h('h2', { text: 'Test and live' }),
      h('p', {}, 'Until real providers are chosen, payments, payouts, printing and messages run on test stand-ins: everything works end to end and no real money moves. Your code doesn’t change when the real ones are switched on.'));
  }

  window.__FW_CONSOLE__ = { h, icon, I, link, go, api, toast, copy, S, render };
  render();
})();
