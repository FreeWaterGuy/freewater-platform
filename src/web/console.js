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
    box: 'M3 7l9-4 9 4v10l-9 4-9-4z|M3 7l9 4 9-4|M12 11v10',
    ai: 'M12 3a4 4 0 0 1 4 4v1h1a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3h1V7a4 4 0 0 1 4-4Z|M9 13h.01|M15 13h.01|M9 17h6',
    start: 'M5 12l5 5L20 7', company: 'M3 21h18|M5 21V7l7-4 7 4v14|M9 9h1|M14 9h1|M9 13h1|M14 13h1|M10 21v-4h4v4', brand: 'M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-7.8-9-7.8Z|M7.5 11.5h.01|M10.5 7.5h.01|M15.5 7.5h.01',
    game: 'M12 21a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z|M4 4l3 3|M20 4l-3 3|M12 2v3', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z|M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z', line: 'M3 12h18|M7 9v6|M12 8v8|M17 9v6', ads: 'M4 5h16v14H4z|M4 10h16|M10 10v9', giving: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8Z', modules: 'M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z',
    machine: 'M6 3h12v18H6z|M9 7h6|M10 17h4', team: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z|M2 21a7 7 0 0 1 14 0|M17 3a4 4 0 0 1 0 8|M22 21a7 7 0 0 0-5-6.7', history: 'M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5|M12 7v5l3 3',
    key: 'M15 7a4 4 0 1 1-3.5 6H8v3H5v-3H3v-3h8.5A4 4 0 0 1 15 7Z', hook: 'M18 16.1A5 5 0 0 0 15 7a5 5 0 0 0-4.5 7.2|M6 16.1A5 5 0 1 0 12 21h5|M12 3a5 5 0 0 0-3 9l-3 5', docs: 'M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z|M8 8h8|M8 12h8|M8 16h5', licensees: 'M3 7h18v13H3z|M8 7V4h8v3|M3 12h18',
    qr: 'M4 4h6v6H4z|M14 4h6v6h-6z|M4 14h6v6H4z|M14 14h2v2h-2z|M18 18h2v2h-2z|M14 18h2|M18 14h2', product: 'M9 2h6v3l2 3v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8l2-3z|M7 11h10|M7 17h10',
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
    const res = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { S.token = null; S.me = null; store.set('fw_console_token', null); }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error?.message || 'Something went wrong.'); e.status = res.status; throw e; }
    return data;
  }

  const routes = [
    [/^\/console\/?$/, startPage], [/^\/console\/company$/, companyPage], [/^\/console\/brand$/, brandPage], [/^\/console\/ads$/, adsPage], [/^\/console\/giving$/, givingPage], [/^\/console\/game$/, gamePage], [/^\/console\/transparency$/, transparencyPage], [/^\/console\/data$/, dataPage], [/^\/console\/numberline$/, numberLinePage], [/^\/console\/agents$/, agentsPage], [/^\/console\/given$/, givenPage], [/^\/console\/security$/, securityPage],
    [/^\/console\/modules$/, modulesPage], [/^\/console\/codes$/, codesPage], [/^\/console\/products$/, productsPage], [/^\/console\/machines$/, machinesPage], [/^\/console\/team$/, teamPage], [/^\/console\/history$/, historyPage],
    [/^\/console\/keys$/, keysPage], [/^\/console\/webhooks$/, webhooksPage], [/^\/console\/webhooks\/([\w-]+)$/, webhookPage], [/^\/console\/licensees$/, licenseesPage],
    [/^\/console\/features$/, featuresPage], [/^\/console\/launch$/, launchPage], [/^\/console\/wallet$/, walletPage], [/^\/console\/offers$/, offersPage], [/^\/console\/games$/, gamesPage], [/^\/console\/chain$/, chainPage],
  ];
  /** Is this switch on, on this server and for this company? (GET /v1/public/features?company=; unknown or none: on.) */
  const on = (feature) => !feature || !(S.features?.off ?? []).includes(feature);
  // Pages (and menu entries) that belong to a switch (src/runtime/registry.ts), and sections inside pages that do (by
  // their heading). A page whose switch is off isn't shown; its switch is turned back on from the Features page.
  // (The prize game and the games are their own on/off: their pages stay so they can be turned on there.)
  const PAGE_FEATURES = { offers: 'offers', chain: 'token', licensees: 'network', machines: 'machines', webhooks: 'webhooks', given: 'giveaways', docs: 'developer_pages', transparency: 'transparency' };
  const SECTION_FEATURES = { 'Go live with the token': 'token', 'Points into tokens': 'token_conversion', 'Gift cards': 'gift_cards', 'The agents’ fund': 'agents_fund', 'What the agents spent': 'agents_fund', 'The upsides library': 'agents_fund', Continuity: 'network' };
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
    const pathname = S.path.split('#')[0].split('?')[0];
    if (pathname.startsWith('/developers')) return docs(pathname);
    try {
      if (!S.config) S.config = await api('GET', `/v1/public/app-config${S.company ? `?company=${encodeURIComponent(S.company)}` : ''}`);
    } catch { S.company = null; store.set('fw_console_company', null); S.config = await api('GET', '/v1/public/app-config'); }
    // Areas switched off on this server (FW_FEATURES): their pages and buttons aren't shown, their addresses don't exist.
    if (!S.features) S.features = await api('GET', `/v1/public/features${S.config?.companyId ? `?company=${encodeURIComponent(S.config.companyId)}` : ''}`).catch(() => ({ off: [] }));
    if (S.token && !S.me) { try { S.me = await api('GET', '/v1/me'); } catch { S.me = null; } }
    if (!S.me) return signIn();
    if (!['owner'].includes(S.me.role)) return shell('', h('div', { class: 'notice err', text: 'The console is for company owners. Ask an owner to change your role, or use the ops console.' }));
    try { S.ov = await api('GET', '/v1/console'); } catch (e) { return shell('', h('div', { class: 'notice err', text: e.message })); }
    if (S.ov.you?.mustSetUpSecondStep) return mustSetUpPage();
    if (!on(PAGE_FEATURES[pathname.replace(/\/$/, '').split('/')[2]])) return go('/console', true);
    for (const [re, fn] of routes) {
      const m = re.exec(pathname);
      if (m) { try { await fn(...m.slice(1)); } catch (e) { shell('', h('div', { class: 'notice err', text: e.message })); } window.scrollTo(0, 0); return; }
    }
    go('/console', true);
  }

  function shell(active, ...content) {
    const nav = [
      ['start', '/console', 'Get started', I.start], ['features', '/console/features', 'Features', I.modules],
      'Points and rewards', ['launch', '/console/launch', 'Launch', I.start], ['wallet', '/console/wallet', 'Points and credit', I.giving], ['offers', '/console/offers', 'Brand offers', I.ads], ['games', '/console/games', 'The games', I.game], ['chain', '/console/chain', 'Blockchain', I.key],
      'Settings', ['company', '/console/company', 'Company', I.company], ['brand', '/console/brand', 'Brand', I.brand], ['ads', '/console/ads', 'Ads and prices', I.ads], ['codes', '/console/codes', 'QR codes and AR', I.qr], ['products', '/console/products', 'Products', I.product],
      ['giving', '/console/giving', 'Giving', I.giving], ['game', '/console/game', 'Prize game', I.game], ['transparency', '/console/transparency', 'Transparency', I.eye], ['data', '/console/data', 'Data and privacy', I.shield], ['numberline', '/console/numberline', 'Number line', I.line], ['agents', '/console/agents', 'AI agents', I.ai], ['security', '/console/security', 'Security', I.shield], ['modules', '/console/modules', 'Modules', I.modules], ['machines', '/console/machines', 'Machines', I.machine], ['team', '/console/team', 'Team', I.team], ['history', '/console/history', 'History', I.history],
      'Developers', ['keys', '/console/keys', 'API keys', I.key], ['webhooks', '/console/webhooks', 'Webhooks', I.hook], ['docs', '/developers', 'Docs', I.docs],
      ...(S.ov?.config?.id === 'freewater' ? ['FreeWater team', ['given', '/console/given', 'Bottles given & receipts', I.box]] : []),
      ...(S.ov?.you?.platform ? ['Platform', ['licensees', '/console/licensees', 'Licensees', I.licensees]] : []),
    ];
    const b = S.ov?.config?.brand ?? S.config?.brand ?? { logoTop: 'free', logoBottom: 'water' };
    root.replaceChildren(h('div', { class: 'shell' },
      h('aside', { class: 'side' }, h('div', { class: 'logo', 'aria-label': `${S.config?.name ?? ''} console` }, h('span', { text: b.logoTop }), h('span', { text: b.logoBottom }), h('small', { text: 'Console' })),
        h('nav', { 'aria-label': 'Main' }, nav.filter((n) => typeof n === 'string' || on(PAGE_FEATURES[n[0]])).map((n) => (typeof n === 'string' ? h('div', { class: 'group', text: n }) : link(n[1], { 'aria-current': active === n[0] ? 'page' : null }, icon(n[3]), n[2])))),
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
    const step2 = () => { const input = h('input', { class: 'input code-input', id: 'c-code', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', 'aria-label': '6-digit code' }); right.replaceChildren(h('h2', { style: 'font:700 26px/1.2 var(--display);margin:0', text: 'Check your email' }), h('p', { style: 'margin:0;color:var(--muted)', text: `We sent a 6-digit code to ${to}.` }), h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); try { const r = await withSecondStep(await api('POST', '/v1/auth/verify', { companyId: S.config.companyId, channel: 'email', to, code: input.value.trim() })); S.token = r.token; store.set('fw_console_token', r.token); store.set('fw_console_company', S.config.companyId); S.me = null; render(); } catch (x) { toast(x.message); } } }, input, h('button', { class: 'btn wide', type: 'submit' }, 'Sign in'))); input.focus(); };
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
  // Gift cards (exchanges) are turned on only by an approved launch action; saving them on here is refused. So the switch
  // can only turn them off. When off, it's shown read-only with the way to turn them on.
  const exchangesSwitch = (ctx) => {
    const savedOn = getP(S.ov.config, 'wallet.conversions.enabled') === true;
    if (savedOn) return toggle(ctx, 'wallet.conversions.enabled', 'Gift cards (exchanges)', 'On. Can be switched off here any time. Switching on again needs approvals under Launch.');
    const box = h('input', { type: 'checkbox', disabled: true, 'aria-describedby': 'exchanges-note' });
    return h('label', { class: 'switch', style: 'cursor:default;opacity:.85' }, box, h('div', {}, h('b', { text: 'Gift cards (exchanges)' }),
      h('span', { id: 'exchanges-note' }, 'Off. Turned on only through an approved step under ', link('/console/launch', {}, 'Launch'), '.')));
  };
  const section = (title, lead, ...kids) => !on(SECTION_FEATURES[title]) ? null : h('section', { class: 'section' }, h('h2', { text: title }), lead ? h('p', { class: 'lead', text: lead }) : null, ...kids);

  // ---------- launch: test, then live ----------
  const person = () => !!S.ov?.you?.person;
  const chip = (text, tone) => h('span', { class: `pill${tone ? ` ${tone}` : ''}`, text });
  const actionRow = (a, after) => {
    const btn = (label, fn, cls = 'btn small') => h('button', { class: cls, type: 'button', onclick: async (e) => { e.currentTarget.disabled = true; try { await fn(); toast('Done.'); render(); } catch (x) { toast(x.message); e.currentTarget.disabled = false; } } }, label);
    const names = { exchanges_on: 'Turn on gift cards', go_live_points: 'Go live with points', go_live_token: 'Go live with the token', convert: 'Turn points into tokens', withdrawals_on: 'Turn on withdrawals', mint: 'Mint tokens', unpause: 'Unpause', switch_on: 'Switch the chain on', pause: 'Pause' };
    const ready = a.status === 'approved' && a.notBefore && Date.parse(a.notBefore) <= Date.now();
    const sign = a.status === 'signing' ? (() => {
      const sig = h('input', { class: 'input', placeholder: 'Transaction signature from Squads', spellcheck: 'false', style: 'font-family:var(--mono)' });
      return h('div', { class: 'stack', style: 'gap:8px' }, h('p', { class: 'muted', style: 'margin:0', text: 'Sign this in Squads with the other keyholders, then paste the signature here. It is checked on Solana before the books change.' }),
        h('div', { class: 'toolbar' }, h('button', { class: 'btn small secondary', type: 'button', onclick: () => copy(a.toSign) }, 'Copy transaction'), sig, btn('Check and record', () => api('POST', `/v1/chain/actions/${a.id}/signed`, { signature: sig.value.trim() }))));
    })() : null;
    return h('tr', {}, h('td', {}, h('b', { text: names[a.kind] ?? a.kind }), a.params?.plan ? h('div', { class: 'muted', text: `${a.params.plan.total.toLocaleString()} token units to ${a.params.plan.people} people` }) : a.params?.reason ? h('div', { class: 'muted', text: a.params.reason }) : null, sign),
      h('td', { text: a.status === 'proposed' ? `${a.approvals.length} of ${a.needed} approvals` : a.status === 'approved' ? (ready ? 'Ready to run' : `Waiting until ${when(a.notBefore)}`) : a.status }),
      h('td', { text: a.proposedBy }),
      h('td', {}, h('div', { class: 'toolbar' },
        a.status === 'proposed' ? btn('Approve', () => api('POST', `/v1/chain/actions/${a.id}/approve`)) : null,
        ready ? btn('Run it now', () => api('POST', `/v1/chain/actions/${a.id}/run`), 'btn small blue') : null,
        ['proposed', 'approved', 'signing'].includes(a.status) ? btn('Cancel', () => api('POST', `/v1/chain/actions/${a.id}/cancel`), 'btn small secondary') : null, after)));
  };
  const actionsTable = (list) => list.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['What', 'Where it is', 'Proposed by', ''].map((x) => h('th', { text: x })))), h('tbody', {}, list.map((a) => actionRow(a))))) : h('p', { class: 'muted', style: 'margin:0', text: 'Nothing proposed.' });
  const propose = async (kind, params = {}) => { await api('POST', '/v1/chain/actions', { kind, params }); toast('Proposed. Everyone on the team was told.'); render(); };

  async function launchPage() {
    const [st, chainSt, actions] = await Promise.all([api('GET', '/v1/launch'), api('GET', '/v1/chain'), api('GET', '/v1/chain/actions')]);
    const steps = [['test', 'Testing', 'Try everything yourself and with bots. Reset any time.'], ['points', 'Live with points', 'Real people earn placeholder points and rewards. No more resets.'], ['token', 'Live with the token', 'Points become the Solana token, held safely in custody.']];
    const at = steps.findIndex(([k]) => k === st.stage);
    const mine = actions.filter((a) => ['go_live_points', 'go_live_token', 'convert', 'withdrawals_on', 'exchanges_on'].includes(a.kind) && !['done', 'cancelled', 'expired', 'failed'].includes(a.status));
    const reset = (() => {
      const word = h('input', { class: 'input', placeholder: 'Type RESET', 'aria-label': 'Type RESET to confirm' });
      const go = h('button', { class: 'btn secondary', type: 'button', disabled: true }, 'Wipe all test data');
      word.addEventListener('input', () => { go.disabled = word.value !== 'RESET'; });
      go.addEventListener('click', async () => { go.disabled = true; try { const r = await api('POST', '/v1/launch/reset', { confirm: 'RESET' }); toast(`Wiped: ${Object.entries(r.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing to wipe'}.`); render(); } catch (x) { toast(x.message); } });
      return section('Reset', 'Wipes every wallet, game answer, offer claim, seal and bot from testing. Settings, products and offers themselves stay.', h('div', { class: 'toolbar' }, word, go), st.lastReset ? h('p', { class: 'muted', style: 'margin:0', text: `Last reset ${ago(st.lastReset.at)} by ${st.lastReset.by}.` }) : null);
    })();
    const bots = (() => {
      const n = h('input', { class: 'input', type: 'number', min: 1, max: 200, value: 20, 'aria-label': 'How many bots' });
      const r = h('input', { class: 'input', type: 'number', min: 1, max: 60, value: 15, 'aria-label': 'Screens each' });
      const out = h('p', { class: 'muted', style: 'margin:0' });
      const go = h('button', { class: 'btn blue', type: 'button' }, 'Run bots');
      go.addEventListener('click', async () => { go.disabled = true; out.textContent = 'Bots are playing…'; try { const x = await api('POST', '/v1/launch/bots', { bots: Number(n.value), rounds: Number(r.value) }); out.textContent = `${x.bots} bots answered ${x.answered} screens, scanned ${x.scans} bottles, sent ${x.feedback} notes and earned ${x.points.toLocaleString()} points.${x.stoppedEarly ? ` Stopped after ${x.bots} of ${x.asked} bots (each run plays for at most 10 seconds); run it again for more.` : ''}`; } catch (e) { out.textContent = e.message; } go.disabled = false; });
      return section('Test with bots', 'Bots play like people: their own tastes, a few seconds a screen, most quick checks passed, some careless. Each is marked as a bot and wiped by a reset.', h('div', { class: 'form' }, field('Bots', n), field('Screens each', r)), h('div', { class: 'toolbar' }, go, link('/console/games', { class: 'btn secondary' }, 'See what they picked')), out);
    })();
    const next = st.stage === 'test' ? section('Go live with points', 'Real people start earning placeholder points, rewards and offers. Everything from testing is wiped as it goes live, and after this there’s no going back. It can run a day after you propose it.', person() ? h('button', { class: 'btn blue', type: 'button', onclick: () => propose('go_live_points').catch((x) => toast(x.message)) }, 'Propose going live') : h('p', { class: 'notice err', text: 'Sign in as yourself to propose this.' }))
      : st.stage === 'points' ? section('Go live with the token', `Needs ${chainSt.approvalsNeeded} other owners or finance people to approve, then a ${chainSt.delayHours}-hour wait. After it, points can be turned into the token.`, h('button', { class: 'btn blue', type: 'button', onclick: () => propose('go_live_token').catch((x) => toast(x.message)) }, 'Propose going live with the token'))
      : section('Points into tokens', 'Every point anyone holds becomes the token at the rate you set (the token has 6 decimal places: 1,000,000 units is one token). Approved by others, then the wait; on Solana it’s signed in Squads.', (() => { const rate = h('input', { class: 'input', type: 'number', min: 1, value: 1000000, 'aria-label': 'Token units per point' }); return h('div', { class: 'toolbar' }, field('Token units per point', rate), h('button', { class: 'btn blue', type: 'button', onclick: () => propose('convert', { tokensPerPoint: Number(rate.value) }).catch((x) => toast(x.message)) }, 'Propose the conversion'), st.withdrawals ? h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await api('PATCH', '/v1/console/settings', { version: S.ov.version, changes: { launch: { ...(S.ov.config.launch ?? { stage: 'token' }), withdrawals: false } } }); toast('Withdrawals off.'); render(); } catch (x) { toast(x.message); } } }, 'Turn withdrawals off') : !on('withdrawals') ? null : h('button', { class: 'btn secondary', type: 'button', onclick: () => propose('withdrawals_on').catch((x) => toast(x.message)) }, 'Propose turning on withdrawals')); })());
    shell('launch', head('Launch', 'Test everything first, then go live in steps. Each step is approved, waits, and can’t be undone.'),
      h('ol', { class: 'stages', 'aria-label': 'Launch steps' }, steps.map(([k, name, d], i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '', 'aria-current': i === at ? 'step' : null }, h('span', { class: 'n', text: i < at ? '✓' : String(i + 1) }), h('b', { text: name }), h('small', { text: d }), i === at ? h('em', { text: 'You are here' }) : null))),
      ...(st.stage === 'test' ? [bots, reset] : []), next,
      st.stage !== 'test' ? section('Gift cards', 'Let people spend their dollar credit on gift cards (Amazon, Target and others), sent to their email. Needs other people’s approval and the wait.', h('button', { class: 'btn secondary', type: 'button', onclick: () => propose('exchanges_on').catch((x) => toast(x.message)) }, 'Propose turning on gift cards')) : null,
      section('Waiting', 'Steps proposed and not yet run.', actionsTable(mine)));
  }

  // ---------- wallet and points ----------
  async function walletPage() {
    const [supply, check, camps] = await Promise.all([api('GET', `/v1/public/wallet/${encodeURIComponent(S.ov.config.id)}/supply`), api('GET', '/v1/wallet/check'), api('GET', '/v1/campaigns').catch(() => [])]);
    const brands = [...new Map(camps.map((c) => [c.advertiserId, c.advertiserName])).entries()];
    settingsPage('wallet', 'Points and credit', 'Points are earned for real activity and are the same whichever item someone picks. Dollar credit is paid from a brand’s reserve, never more than it holds.', (ctx) => {
      if (!ctx.draft.wallet) { ctx.draft.wallet = structuredClone(S.ov.options.wallet); S.ov.config.wallet = structuredClone(S.ov.options.wallet); }
      const actions = Object.keys(ctx.draft.wallet.points.perAction);
      const label = { scan: 'Scanning a real bottle', game_round: 'Each game screen', ad_feedback: 'Each ad round', feedback: 'Feedback (20+ characters)', prompt: 'A real question', upload: 'A picture with feedback', streak_bonus: 'Every 10 in a row' };
      const reserve = (() => { const who = h('select', { class: 'input' }, brands.map(([id, name]) => h('option', { value: `advertiser:${id}`, text: name }))), amt = h('input', { class: 'input', type: 'number', min: 0.01, step: '0.01', placeholder: '$' }), ref = h('input', { class: 'input', placeholder: 'Payment reference' }); return h('div', { class: 'stack' }, h('div', { class: 'form' }, field('Brand (reserve)', who), field('Amount arrived', amt), field('Payment reference', ref)), h('div', { class: 'toolbar' }, h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { const r = await api('POST', '/v1/wallet/reserve', { sponsor: who.value, cents: Math.round(Number(amt.value) * 100), ref: ref.value.trim() }); toast(`Reserve now ${dollars(r.reserve)}.`); } catch (x) { toast(x.message); } } }, 'Record money in reserve'))); })();
      return [
        h('div', { class: 'kpis', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' },
          h('div', { class: 'kpi' }, h('span', { text: 'Points given out' }), h('b', { text: supply.issued.toLocaleString() })), h('div', { class: 'kpi' }, h('span', { text: 'Cap' }), h('b', { text: supply.cap.toLocaleString() })),
          h('div', { class: 'kpi' }, h('span', { text: 'Halvings so far' }), h('b', { text: String(supply.era) })), h('div', { class: 'kpi' }, h('span', { text: 'Books add up' }), h('b', { text: check.ok ? 'Yes' : 'No' }))),
        section('Points per action', 'What each action earns now, before halvings. Points never depend on which item someone picks.', h('div', { class: 'form' }, actions.map((k) => num(ctx, `wallet.points.perAction.${k}`, label[k] ?? k, { min: 0, max: 10000, hint: `Earns ${supply.earnNow[k] ?? 0} now` }))),
          h('div', { class: 'form' }, num(ctx, 'wallet.points.dailyMax', 'Most points one person can earn in a day', { min: 0, max: 1000000 }), text(ctx, 'wallet.points.name', 'What points are called', { max: 40 }))),
        section('Money switches', 'Changed only by a person signed in. Exchanging points for anything else takes the several-people approval under Launch.',
          toggle(ctx, 'wallet.credit.enabled', 'Dollar credit', 'Pay people from brands’ reserves (offers, rewards).'), on('offers') ? toggle(ctx, 'offers.enabled', 'Brand offers', 'Approved offers go live for people to claim.') : null, on('gift_cards') ? exchangesSwitch(ctx) : null),
        section('Brand reserves', 'Record money a brand sent for credit, once it has really arrived.', reserve),
      ];
    });
  }

  // ---------- offers and receipts ----------
  async function offersPage() {
    const [list, waiting] = await Promise.all([api('GET', '/v1/offers'), api('GET', '/v1/offers/receipts')]);
    const btn = (label, fn, cls = 'btn small') => h('button', { class: cls, type: 'button', onclick: async (e) => { e.currentTarget.disabled = true; try { await fn(); toast('Done.'); render(); } catch (x) { toast(x.message); e.currentTarget.disabled = false; } } }, label);
    const rows = list.map((o) => h('tr', {}, h('td', {}, h('b', { text: o.title }), h('div', { class: 'muted', text: `${o.brand ?? o.advertiserId} · ${o.deal}` })), h('td', { text: o.pointsCost ? `${o.pointsCost} points` : 'Free to claim' }), h('td', { text: `${o.claimed} claimed, ${o.left} left` }), h('td', {}, chip({ pending: 'Waiting for you', live: 'Live', paused: 'Paused', draft: 'Draft' }[o.status] ?? o.status)),
      h('td', {}, h('div', { class: 'toolbar' }, o.status === 'pending' || o.status === 'paused' ? btn('Approve', () => api('POST', `/v1/offers/${o.id}/approve`), 'btn small blue') : null, o.status === 'live' ? btn('Pause', () => api('POST', `/v1/offers/${o.id}/pause`), 'btn small secondary') : null))));
    const receipts = waiting.map((w) => {
      const price = h('input', { class: 'input', type: 'number', min: 0, step: '0.01', placeholder: 'Price on receipt ($)', style: 'max-width:180px' });
      const img = h('img', { alt: `Receipt for ${w.title}`, style: 'max-width:260px;max-height:360px;border-radius:12px;border:1px solid var(--line)' });
      fetch(w.receipt, { headers: { authorization: `Bearer ${S.token}` } }).then((r) => r.blob()).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => {});
      return h('div', { class: 'panel-box', style: 'display:flex;gap:16px;flex-wrap:wrap' }, img, h('div', { class: 'stack', style: 'min-width:0;flex:1' }, h('b', { text: w.title }), h('span', { class: 'muted', text: `Sent ${ago(w.sentAt)}${w.read ? ` · read: ${w.read.store ?? '?'} on ${w.read.date ?? '?'}` : ' · no reader connected'}` }),
        h('div', { class: 'toolbar' }, price, btn('Accept', () => api('POST', `/v1/offers/receipts/${w.claim}/review`, { approve: true, paidCents: Math.round(Number(price.value) * 100) }), 'btn small blue'), btn('Turn down', () => api('POST', `/v1/offers/receipts/${w.claim}/review`, { approve: false }), 'btn small secondary'))));
    });
    shell('offers', head('Brand offers', S.ov.config.offers?.enabled ? 'Brands make offers; you approve them. People claim with points, buy, and send a receipt.' : 'Brand offers are switched off (Points and credit → Money switches). You can still look over drafts.'),
      section(`Receipts to check (${waiting.length})`, 'Accept with the price on the receipt, or turn it down (their points go back).', receipts.length ? receipts : h('p', { class: 'muted', style: 'margin:0', text: 'Nothing waiting.' })),
      section('Offers', 'Brands send offers for approval from their ad console.', list.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Offer', 'Costs', 'Claims', 'Status', ''].map((x) => h('th', { text: x })))), h('tbody', {}, rows))) : h('p', { class: 'muted', style: 'margin:0', text: 'No offers yet.' })));
  }

  // ---------- the games ----------
  async function gamesPage() {
    const [r, cat, launches, offers] = await Promise.all([api('GET', '/v1/games/report'), api('GET', '/v1/games/catalog'), api('GET', '/v1/games/launches'), api('GET', '/v1/offers').catch(() => [])]);
    const promised = S.ov.config.games?.mayComeTrue ?? [];
    const winners = Object.fromEntries(await Promise.all(promised.map(async (c) => [c, await api('GET', `/v1/games/winners?category=${encodeURIComponent(c)}`)])));
    const comeTrue = section('Picks that may come true', 'Mark categories where you may really offer what people pick (the screens then say “Picks may come true”). When enough people have picked, make the winner come true: link the offer you made for it, and everyone who picked it is told.',
      h('div', { class: 'pills' }, cat.filter((c) => c.items.length).map((c) => { const box = h('input', { type: 'checkbox' }); box.checked = promised.includes(c.category); box.addEventListener('change', async () => { const next = box.checked ? [...new Set([...promised, c.category])] : promised.filter((x) => x !== c.category); try { await api('PATCH', '/v1/console/settings', { version: S.ov.version, changes: { games: { ...(S.ov.config.games ?? {}), mayComeTrue: next } } }); toast('Saved.'); render(); } catch (x) { toast(x.message); box.checked = !box.checked; } }); return h('label', { class: 'pill', style: 'display:inline-flex;gap:6px;align-items:center;cursor:pointer' }, box, c.name); })),
      ...promised.map((c) => { const w = winners[c] ?? []; const pickOffer = h('select', { class: 'input', style: 'max-width:260px' }, h('option', { value: '', text: 'No offer linked yet' }), offers.map((o) => h('option', { value: o.id, text: o.title }))); return h('div', { class: 'panel-box', style: 'gap:8px;display:grid' }, h('b', { text: cat.find((x) => x.category === c)?.name ?? c }), w.length ? h('div', { class: 'muted', text: w.slice(0, 3).map((x) => `${x.label} ${Math.round(x.share * 100)}% (seen ${x.shown}×)`).join(' · ') }) : h('div', { class: 'muted', text: 'No picks yet.' }), h('div', { class: 'toolbar' }, pickOffer, h('button', { class: 'btn small blue', type: 'button', disabled: !w.length || w[0].shown < 20 ? '' : null, onclick: async () => { try { const x = await api('POST', '/v1/games/come-true', { category: c, ...(pickOffer.value ? { offerId: pickOffer.value } : {}) }); toast(`${x.item} came true.`); render(); } catch (e) { toast(e.message); } } }, 'Make the winner come true'))); }),
      launches.length ? h('div', { class: 'muted', text: `Came true: ${launches.map((l) => `${l.item} (${Math.round(l.share * 100)}%)`).join(', ')}` }) : null);
    const pct = (x) => `${Math.round(x * 100)}%`;
    const names = { for_sale: 'For sale', discounted: 'Cheaper than usual', free_ads: 'Free', free_sponsor: 'Free (a brand pays)', negative: 'Negatively priced' };
    const tierNames = { 1: 'Constrained', 3: 'Revealed preference', '4a': 'Values (we chose the cause)', '4b': 'Values (they get paid)', 5: 'Brand commitment' };
    const bars = (obj, label) => h('div', { class: 'stack', style: 'gap:6px' }, Object.entries(obj).map(([k, v]) => h('div', { style: 'display:grid;grid-template-columns:minmax(0,180px) 1fr 60px;gap:10px;align-items:center' }, h('span', { text: label(k) }), h('div', { style: 'height:10px;border-radius:5px;background:var(--line);overflow:hidden' }, h('i', { style: `display:block;height:100%;width:${Math.round(v.rate * 100)}%;background:var(--blue, #2F8FC4)` })), h('b', { style: 'font-variant-numeric:tabular-nums', text: pct(v.rate) }))));
    const upload = (item) => { const f = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: 'max-width:200px' }); f.addEventListener('change', async () => { const file = f.files[0]; if (!file) return; const b64 = await new Promise((ok) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result).split(',')[1]); rd.readAsDataURL(file); }); try { await api('POST', `/v1/games/catalog/${encodeURIComponent(item.id)}/photo`, { contentType: file.type, dataBase64: b64, credit: S.config.name }); toast('Photo saved.'); render(); } catch (x) { toast(x.message); } }); return f; };
    shell('games', head('The games', `Last 30 days: ${r.kept.toLocaleString()} answers kept, ${r.marked.toLocaleString()} set aside (too fast or a failed check). Median ${r.medianMs ? `${(r.medianMs / 1000).toFixed(1)} s` : '—'} a screen; ${r.changedMind} changed their mind.`, h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { const x = await api('POST', '/v1/games/catalog/photos'); toast(`Found ${x.found} photos.`); render(); } catch (e) { toast(e.message); } } }, 'Look for photos now')),
      h('div', { class: 'grid2' },
        section('Picked, by price setup', 'Of the times each setup was on a screen, how often it was chosen.', bars(r.pickRateBySetup, (k) => names[k] ?? k)),
        section('Picked, by place on screen', 'If the first spot wins much more often, the layout is steering people.', bars(r.pickRateByPosition, (k) => `Spot ${Number(k) + 1}`))),
      section('On or off', S.ov.config.games?.enabled === false ? 'The games are off: the Play page says so, and nothing is asked or kept.' : 'The games are on. Switching them off is immediate; nothing else on bottles changes.', h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await api('PATCH', '/v1/console/settings', { version: S.ov.version, changes: { games: { ...(S.ov.config.games ?? {}), enabled: S.ov.config.games?.enabled === false } } }); toast('Saved.'); render(); } catch (x) { toast(x.message); } } }, S.ov.config.games?.enabled === false ? 'Turn the games on' : 'Turn the games off')),
      comeTrue,
      section('Honest-data tiers', 'Which tier each pick would be if it were real.', h('div', { class: 'pills' }, Object.entries(r.tiers).map(([k, n]) => chip(`${tierNames[k] ?? k}: ${n}`)))),
      section('Photos on the cards', 'Each item’s photo, where it came from and its license. Open a category to check them, or upload your own (a brand’s official photo) to replace any.', ...cat.map((c) => h('details', { class: 'stack', style: 'gap:8px' }, h('summary', { style: 'cursor:pointer;font-weight:700', text: `${c.name}: ${c.items.filter((i) => i.image).length} of ${c.items.length} have photos${c.source === 'none' ? ' (name cards)' : ''}` }),
        h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px' }, c.items.map((it) => h('div', { class: 'panel-box', style: 'padding:10px;gap:6px;display:grid' }, it.image ? h('img', { src: it.image, alt: it.label, style: 'width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px' }) : h('div', { class: 'muted', style: 'aspect-ratio:4/3;display:grid;place-items:center;border-radius:8px;background:var(--line)', text: it.status === 'none' ? 'No free photo' : 'Not looked for yet' }), h('b', { style: 'font-size:13px', text: it.label }), it.credit ? h('small', { class: 'muted', text: `${it.credit} · ${it.license}` }) : null, upload(it))))))));
  }

  // ---------- the chain ----------
  async function chainPage() {
    const [st, actions, seals, check] = await Promise.all([api('GET', '/v1/chain'), api('GET', '/v1/chain/actions'), api('GET', `/v1/public/wallet/${encodeURIComponent(S.ov.config.id)}/seals`), api('GET', '/v1/chain/seals/check')]);
    const reason = h('input', { class: 'input', placeholder: 'Why you’re pausing', 'aria-label': 'Reason' });
    shell('chain', head('Blockchain', `${st.enabled ? 'On' : 'Off'} · ${st.network === 'test' ? 'practice chain (not a real blockchain)' : st.network} · ${st.paused ? 'PAUSED' : 'running'}`),
      h('div', { class: 'kpis', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' },
        h('div', { class: 'kpi' }, h('span', { text: 'Stage' }), h('b', { text: st.stage })), h('div', { class: 'kpi' }, h('span', { text: 'Tokens in the books' }), h('b', { text: st.tokenSupply.toLocaleString() })),
        h('div', { class: 'kpi' }, h('span', { text: 'Last daily check' }), h('b', { text: st.lastCheck ? (st.lastCheck.ok ? 'Matched' : 'MISMATCH') : '—' })), h('div', { class: 'kpi' }, h('span', { text: 'Seals intact' }), h('b', { text: check.ok ? `All ${check.checked}` : `${check.broken.length} broken` }))),
      section('On or off', st.enabled ? 'The chain is on: hourly seals go to it and token steps can run. Switching it off is immediate; switching it back on needs approvals and the wait again.' : 'The chain is off: hourly seals go to GitHub only and nothing touches a blockchain. Going live with the token switches it on; you can also propose switching it on alone (seals only).',
        st.enabled ? h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await api('PATCH', '/v1/console/settings', { version: S.ov.version, changes: { chain: { ...st, enabled: false, stage: undefined, chain: undefined, custody: undefined, paused: undefined, lastCheck: undefined, tokenSupply: undefined } } }); toast('Switched off.'); render(); } catch (x) { toast(x.message); } } }, 'Switch the chain off now') : h('button', { class: 'btn secondary', type: 'button', onclick: () => propose('switch_on').catch((x) => toast(x.message)) }, 'Propose switching the chain on')),
      section('Pause', 'Stops everything on the chain at once. Any one person. Unpausing needs approvals and the wait.', h('div', { class: 'toolbar' }, reason, h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await api('POST', '/v1/chain/pause', { reason: reason.value || 'Paused from the console' }); toast('Paused.'); render(); } catch (x) { toast(x.message); } } }, 'Pause now'), st.paused ? h('button', { class: 'btn blue', type: 'button', onclick: () => propose('unpause').catch((x) => toast(x.message)) }, 'Propose unpausing') : null)),
      section('Approvals', `Anything that can’t be undone needs ${st.approvalsNeeded} other owners or finance people who were on the team when it was proposed, then a ${st.delayHours}-hour wait.`, actionsTable(actions)),
      section('Hourly seals', 'One fingerprint for every hour of the wallet books, each including the hour before. Anyone can check their own entry against it.', seals.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Hour', 'Fingerprint', 'Published'].map((x) => h('th', { text: x })))), h('tbody', {}, seals.slice(0, 24).map((x) => h('tr', {}, h('td', { text: when(x.hour) }), h('td', { style: 'font-family:var(--mono);font-size:12px', text: `${x.root.slice(0, 20)}…` }), h('td', { text: Object.keys(x.published).join(', ') || 'not yet' })))))) : h('p', { class: 'muted', style: 'margin:0', text: 'No seals yet.' })));
  }

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
    const sizes = [[1, 'The whole label'], [2, 'Half'], [3, 'A third'], [4, 'A quarter'], [6, 'A sixth'], [8, 'An eighth'], [10, 'A tenth']];
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
        section('Starting prices', 'Per bottle printed, by how much of the label the ad gets. Bids start at the whole label’s price and go up; smaller pieces pay the same share of a bid. Each piece is cut as close to square as the label allows.', h('div', { class: 'form' },
          ...sizes.map(([k, l]) => num(ctx, `prices.perPrintByShare.${k}`, l, { min: 0, max: 10000, suffix: '¢', hint: (v) => (k === 1 ? `Bids start at ${dollars(v ?? 0)}.` : `${dollars(v ?? 0)} a bottle`) })))),
        section('What advertisers pay for engagement and sales', 'Charged only when it happens: a scan that loaded, an AR launch, a sale.', h('div', { class: 'form' },
          num(ctx, 'prices.perScan', 'Each scan', { min: 0, max: 1000, suffix: '¢' }), num(ctx, 'prices.perArLaunch', 'Each AR launch', { min: 0, max: 1000, suffix: '¢' }),
          (ctx.draft.prices.targetingPremium ??= { locations: 0, products: 0, interests: 0, customers: 0, max: 0 }, null),
          h('p', { class: 'hint full', style: 'grid-column:1/-1;margin:4px 0 0', text: 'Targeting premium: the more precisely an ad targets, the more each scan and AR launch costs. Each kind adds its percent, up to the most in all.' }),
          num(ctx, 'prices.targetingPremium.locations', 'Chosen machines or routes', { min: 0, max: 200, suffix: '%' }), num(ctx, 'prices.targetingPremium.products', 'Chosen products', { min: 0, max: 200, suffix: '%' }),
          num(ctx, 'prices.targetingPremium.interests', 'People’s interests', { min: 0, max: 200, suffix: '%' }), num(ctx, 'prices.targetingPremium.customers', 'New or returning customers', { min: 0, max: 200, suffix: '%' }),
          num(ctx, 'prices.targetingPremium.max', 'The most in all', { min: 0, max: 500, suffix: '%', hint: (v) => `So a 25¢ scan costs at most ${Math.round(25 * (1 + (v ?? 0) / 100))}¢.` }),
          num(ctx, 'prices.commissionPercent', 'Commission on sales', { min: 0, max: 50, step: 0.5, int: false, suffix: '%' }), num(ctx, 'prices.perBoxFace', 'Each side of a delivery box', { min: 0, max: 5000, suffix: '¢' }),
          num(ctx, 'prices.customUnit', 'A custom bottle (what people pay)', { min: 0, max: 10000, suffix: '¢', hint: (v) => dollars(v ?? 0) }))),
        // How advertisers pay (docs/SWITCHES.md). Paying up front, bidding and each fee are switched on the Features page.
        ctx.draft.adBilling ? section('How advertisers pay', ctx.draft.adBilling.requirePrepay
          ? 'Up front, by card, for a number of bottles, at the prices above (AR, video and scans included). Each fee below is charged only when it’s switched on (Features → Money and payments), to the card once a day. Saving these needs the second sign-in step.'
          : 'Billed afterwards, on invoices, with credit limits (Features → Money and payments → Bill advertisers afterwards). Saving these needs the second sign-in step.', h('div', { class: 'form' },
          num(ctx, 'adBilling.changeFeeCents', 'Fee for changing a running ad', { min: 0, max: 100000, suffix: '¢', hint: (v) => `${dollars(v ?? 0)}, paid up front. The new ad is reviewed before it prints.` }),
          num(ctx, 'adBilling.fees.scan.cents', `Fee per scan (${ctx.draft.adBilling.fees.scan.on ? 'on' : 'off'})`, { min: 0, max: 1000, suffix: '¢' }),
          num(ctx, 'adBilling.fees.arLaunch.cents', `Fee per AR launch (${ctx.draft.adBilling.fees.arLaunch.on ? 'on' : 'off'})`, { min: 0, max: 1000, suffix: '¢' }),
          num(ctx, 'adBilling.fees.commission.percent', `Commission on sales (${ctx.draft.adBilling.fees.commission.on ? 'on' : 'off'})`, { min: 0, max: 50, step: 0.5, int: false, suffix: '%' }),
          num(ctx, 'adBilling.extras.markupPercent', 'Markup on costly extras (AI video clips)', { min: 0, max: 500, suffix: '%', hint: (v) => Object.values(ctx.draft.adBilling.extras.perUse).map((x) => `${x.label}: costs us ${dollars(x.costCents)}, the advertiser pays ${dollars(Math.ceil(x.costCents * (100 + (v ?? 0)) / 100))} a use`).join('; ') }))) : null)];
    });
  }

  // ---------- QR codes and AR ----------
  const readFile = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error('That file couldn’t be read.'));
    if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) { r.onload = () => res(String(r.result)); r.readAsText(file); }
    else if (/^image\/(png|jpeg|webp)$/.test(file.type)) { r.onload = () => res(String(r.result)); r.readAsDataURL(file); }
    else rej(new Error('Use an SVG, PNG, JPEG or WebP file.'));
  });
  async function codesPage() {
    const products = await api('GET', '/v1/console/products');
    const qrImg = h('img', { alt: 'Your QR code', style: 'width:200px;height:200px;display:block' });
    const qrNote = h('p', { class: 'hint', style: 'margin:0' });
    const label = h('img', { alt: 'Sample label with these code settings' });
    let timer = null;
    const refresh = (d, ch) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = d.qr;
        try {
          const r = await api('POST', '/v1/qr/preview', { ...(q.logo === 'custom' && q.logoSvg ? { logo: q.logoSvg } : {}), ...(q.logo === 'brand' ? { brandInitials: true } : {}), ...(q.color ? { color: q.color } : {}) });
          qrImg.src = svgSrc(r.svg);
          qrNote.textContent = r.note ?? `No logo. The code still reads with ${r.damageTolerance.plain}% of it damaged.`;
        } catch (x) { qrNote.textContent = x.message; }
        try { const l = await api('POST', '/v1/console/preview-label', { changes: ch }); if (l.svg) label.src = svgSrc(l.svg); } catch {}
      }, 220);
    };
    cleanup = () => clearTimeout(timer);
    settingsPage('codes', 'QR codes and AR', 'Every code is made by the platform itself: no outside QR company sees your scans. Codes are dynamic, so what they open can change after printing.', (ctx) => {
      ctx.draft.qr ??= { logo: 'brand', advertiserLogos: true, allowStatic: false };
      ctx.draft.ar ??= { trackingCodes: true, stripEverywhere: true };
      const q = ctx.draft.qr;
      const upload = h('input', { type: 'file', accept: '.svg,image/svg+xml,image/png,image/jpeg,image/webp', 'aria-label': 'Upload your logo', hidden: true });
      upload.addEventListener('change', async () => { const f = upload.files?.[0]; if (!f) return; try { q.logoSvg = await readFile(f); q.logo = 'custom'; ctx.changed(); render2(); } catch (x) { toast(x.message); } });
      const choices = [['none', 'No logo', 'Plain black and white. The strongest a code can be.'], ['brand', 'Your initials', `“${(ctx.draft.brand.logoTop[0] ?? '') + (ctx.draft.brand.logoBottom[0] ?? '')}” in your colors, until you upload a logo.`], ['custom', 'Your logo', 'Upload an SVG or PNG. Square logos work best.']];
      const cards = h('div', { class: 'radio-cards', role: 'radiogroup', 'aria-label': 'Logo in your codes' });
      const render2 = () => cards.replaceChildren(...choices.map(([v, t, d]) => {
        const r = h('input', { type: 'radio', name: 'qr-logo', value: v }); r.checked = q.logo === v;
        r.addEventListener('change', () => { if (v === 'custom' && !q.logoSvg) { upload.click(); return; } q.logo = v; ctx.changed(); });
        return h('label', {}, r, h('b', { text: t }), h('span', { text: d }));
      }));
      render2();
      if (!q.color) { q.color = '#000000'; }
      const colorRow = h('div', { class: 'form' }, color(ctx, 'qr.color', 'Color of the squares', { hint: 'Black reads best. Any color must be dark enough to stand out from white.' }));
      const productSel = select(ctx, 'standardProductId', 'The product you hand out unless asked for another', products.map((p) => [p.id, p.name]), { hint: 'Each machine can also have its own list on the Machines page.' });
      return [h('div', { class: 'stack' },
        h('div', { class: 'preview' }, h('div', { class: 'cap' }, h('b', { text: 'Preview' }), h('span', { text: 'Your code, and a sample bottle with these settings.' })), h('div', { style: 'display:flex;gap:18px;align-items:center;flex-wrap:wrap' }, qrImg, h('div', { style: 'flex:1;min-width:220px' }, qrNote)), h('div', { class: 'label', style: 'margin-top:12px' }, label)),
        section('The logo in your codes', 'On your receipt code, your house ads and your boxes. The logo is sized automatically so every code still scans, even scratched or wet.', cards, h('div', { class: 'toolbar' }, h('button', { class: 'btn secondary small', type: 'button', onclick: () => upload.click() }, q.logoSvg ? 'Upload a different logo' : 'Upload your logo')), upload),
        section('Color', null, colorRow),
        section('Advertisers’ codes', 'What advertisers can choose for the codes on their ads.', h('div', { class: 'form' },
          toggle(ctx, 'qr.advertiserLogos', 'Advertisers can put their logo in their codes', 'Sized the same safe way as yours.', { full: true }),
          toggle(ctx, 'qr.allowStatic', 'Advertisers can choose a static code', 'Dynamic codes are the default: every scan reaches you first, gets counted, can show each person a different call to action, and can be changed after printing. A static code goes straight to the advertiser’s website: no scan count, no changing it later. It still carries the bottle’s own reference so sales can be matched.', { full: true }))),
        section('AR on the bottle', 'For ads whose AR follows the bottle (a 3D model on it, or a living label), a thin strip of small tracking squares is printed along the bottom of the label so the phone can follow the bottle all the way round.', h('div', { class: 'form' },
          toggle(ctx, 'ar.trackingCodes', 'Print the tracking strip on bottles that need it', 'Without it, AR on the bottle only works when one of the QR codes faces the camera.', { full: true }),
          toggle(ctx, 'ar.stripEverywhere', 'Run the strip along every ad on those bottles', 'So tracking holds all the way round. Turn off to keep it to the AR advertiser’s own part of the label.', { full: true }))),
        section('Standard product', null, h('div', { class: 'form' }, productSel)))];
    }, { onChange: (d, ch) => refresh(d, ch) });
  }

  // ---------- products: any drink, any size ----------
  async function productsPage() {
    const list = await api('GET', '/v1/console/products');
    const sizesAll = [[1, 'Whole label'], [2, '1/2'], [3, '1/3'], [4, '1/4'], [6, '1/6'], [8, '1/8'], [10, '1/10']];
    const f = {
      id: h('input', { class: 'input', placeholder: 'can-12oz', style: 'font-family:var(--mono)' }), name: h('input', { class: 'input', placeholder: '12 oz sparkling water can', maxlength: 80 }),
      category: h('input', { class: 'input', placeholder: 'water, soda, coffee…', maxlength: 30 }),
      shape: h('select', { class: 'input' }, ['bottle', 'can', 'cup', 'jar', 'pouch', 'box'].map((x) => h('option', { value: x, text: x }))),
      diameter: h('input', { class: 'input', type: 'number', step: '0.01', placeholder: '2.6' }), height: h('input', { class: 'input', type: 'number', step: '0.01', placeholder: '4.83' }),
      width: h('input', { class: 'input', type: 'number', step: '0.01', placeholder: '8.37' }), labelH: h('input', { class: 'input', type: 'number', step: '0.01', placeholder: '3.9' }),
      seam: h('input', { class: 'input', type: 'number', step: '0.01', value: '0.2' }), panel: h('input', { class: 'input', type: 'number', step: '0.01', value: '0.9' }),
      price: h('input', { class: 'input', type: 'number', step: '0.05', value: '1' }), facts: h('textarea', { class: 'input', rows: 3, placeholder: 'SPARKLING SPRING WATER\n12 fl oz (355 ml)' }),
    };
    const picks = sizesAll.map(([v, l]) => { const b = h('input', { type: 'checkbox' }); b.checked = true; return [v, b, l]; });
    const result = h('div', { class: 'stack' });
    const fromForm = () => {
      const n = (i) => (i.value === '' ? undefined : Number(i.value));
      return { id: f.id.value.trim(), name: f.name.value.trim(), ...(f.category.value.trim() ? { category: f.category.value.trim().toLowerCase() } : {}),
        container: { shape: f.shape.value, ...(n(f.diameter) ? { diameterIn: n(f.diameter) } : {}), ...(n(f.height) ? { heightIn: n(f.height) } : {}) },
        label: { widthIn: n(f.width), heightIn: n(f.labelH), seamIn: n(f.seam) ?? 0, panelWidthIn: n(f.panel) },
        sizes: picks.filter(([, b]) => b.checked).map(([v]) => v), ...(n(f.price) && n(f.price) !== 1 ? { priceFactor: n(f.price) } : {}),
        ...(f.facts.value.trim() ? { facts: f.facts.value.split('\n').map((x) => x.trim()).filter(Boolean) } : {}) };
    };
    f.diameter.addEventListener('input', () => { const d = Number(f.diameter.value); if (d > 0 && !f.width.value) f.width.placeholder = (Math.PI * d + Number(f.seam.value || 0)).toFixed(2); });
    const check = async () => {
      try {
        const r = await api('POST', '/v1/console/products/check', { product: fromForm() });
        result.replaceChildren(
          r.check.problems.length ? h('div', { class: 'notice err' }, h('b', { text: 'Fix these first: ' }), r.check.problems.join(' ')) : h('div', { class: 'notice' }, h('b', { text: 'Ready. ' }), [...r.check.notes, r.check.ar.why].join(' ')),
          r.svg ? h('div', { class: 'label' }, h('img', { alt: 'Sample label at this size', src: svgSrc(r.svg) })) : null);
        return !r.check.problems.length;
      } catch (x) { toast(x.message); return false; }
    };
    const form = h('form', { class: 'form', onsubmit: async (e) => { e.preventDefault(); if (!(await check())) return; try { await api('POST', '/v1/console/products', { product: fromForm() }); toast('Saved. Machines can hand it out once you add it to them.'); render(); } catch (x) { toast(x.message); } } },
      field('Id', f.id, { hint: 'Lowercase letters, numbers and dashes.' }), field('Name', f.name), field('What’s inside', f.category), field('Shape', f.shape),
      field('Diameter (inches)', f.diameter, { hint: 'For round containers. The label must wrap exactly once.' }), field('Container height (inches)', f.height),
      field('Label width (inches)', f.width, { hint: 'The whole printed width, including the seam overlap.' }), field('Label height (inches)', f.labelH),
      field('Seam overlap (inches)', f.seam), field('Your panel width (inches)', f.panel, { hint: 'At least 0.6 inches.' }),
      field('Ad prices compared with your standard bottle', f.price, { hint: '1 is the same; 1.25 is a quarter more for a bigger label.' }),
      field('Panel lines for this product', f.facts, { full: true, hint: 'What’s inside, the size, who made it. Leave empty to use your company’s lines.' }),
      h('div', { class: 'field full' }, h('label', { text: 'Ad sizes offered (shares of the label)' }), h('div', { class: 'chips' }, picks.map(([, b, l]) => h('label', { class: 'chip-check' }, b, ` ${l}`))), h('div', { class: 'hint', text: 'Each size is cut as close to square as this label allows. Sizes too small for a readable QR code are left out automatically.' })),
      h('div', { class: 'field full toolbar' }, h('button', { class: 'btn secondary', type: 'button', onclick: check }, 'Check and preview'), h('button', { class: 'btn', type: 'submit' }, 'Save product')));
    const row = (p) => h('tr', {}, h('td', {}, h('b', { class: 'mono', text: p.id }), p.shared ? h('div', { class: 'muted', style: 'font-size:12px', text: 'shared' }) : null), h('td', { text: p.name }), h('td', { text: p.category ?? '—' }),
      h('td', { text: `${p.label.widthIn}" × ${p.label.heightIn}"${p.container?.diameterIn ? ` · ⌀ ${p.container.diameterIn}"` : ''}` }), h('td', { text: p.check.slots.map((x) => (x.share === 1 ? 'whole' : `1/${x.share}`)).join(' · ') }), h('td', { text: p.priceFactor ? `× ${p.priceFactor}` : '× 1' }),
      h('td', { text: p.check.problems.length ? p.check.problems[0] : p.check.ar.followsBottle ? 'AR on the bottle: yes' : 'AR in the room only' }));
    shell('products', head('Products', 'Any drink, any size: bottles, cans, cups and jars. Each product is its label size, its shape and the ad layouts it allows.'),
      h('div', { class: 'stack' },
        h('section', { class: 'section' }, h('h2', { text: `${list.length} products` }), h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Id', 'Name', 'Inside', 'Label', 'Ad sizes', 'Ad prices', 'Check'].map((x) => h('th', { text: x })))), h('tbody', {}, list.map(row))))),
        h('section', { class: 'section' }, h('h2', { text: 'Add a product' }), h('p', { class: 'lead', text: 'Every product is checked before it’s saved: the wrap has to close, and every ad has to fit a readable QR code.' }), form, result)));
  }

  // ---------- the prize game ----------
  async function gamePage() {
    let stats = null;
    try { stats = await api('GET', '/v1/lottery'); } catch {}
    settingsPage('game', 'Prize game', 'Off unless you turn it on. People can only win by engaging with an ad: scanning its code, watching its video or opening its AR. A winner sees a red ball bounce across the screen for about 2.5 seconds and has to tap it to collect, so only people really watching win.', (ctx) => {
      // A company that never set the game up starts from the defaults, which count as unchanged until edited.
      if (!ctx.draft.lottery) { ctx.draft.lottery = structuredClone(S.ov.options.lottery); S.ov.config.lottery = structuredClone(S.ov.options.lottery); }
      const L = () => ctx.draft.lottery;
      const cur = ctx.draft.lottery ?? S.ov.options.lottery;
      const on = h('input', { type: 'checkbox' }); on.checked = !!cur.enabled;
      const body = h('div', { class: 'stack' });
      const prizes = h('div', { class: 'field full' });
      const drawPrizes = () => {
        const list = (ctx.draft.lottery ?? S.ov.options.lottery).prizes;
        const total = list.reduce((a, p) => a + (Number(p.weight) || 0), 0) || 1;
        const inp = (p, k, o = {}) => { const i = h('input', { class: 'input', type: o.type ?? 'text', min: o.min, max: o.max, step: o.step, maxlength: o.maxlength, value: o.scale ? (p[k] ?? 0) / o.scale : p[k] ?? '', placeholder: o.placeholder ?? '', 'aria-label': o.label, style: o.style ?? '' }); i.addEventListener('change', () => { const P = L().prizes.find((x) => x.id === p.id); let v = o.type === 'number' ? (i.value === '' ? undefined : Number(i.value) * (o.scale ?? 1)) : i.value; if (o.type === 'number' && v !== undefined) v = o.int === false ? v : Math.round(v); if (v === undefined || v === '') delete P[k]; else P[k] = v; ctx.changed(); drawPrizes(); }); return i; };
        prizes.replaceChildren(h('label', { text: 'Prizes' }), h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, ['Prize', 'Worth ($)', 'How often', 'Most a day', ''].map((t) => h('th', { text: t })))),
          h('tbody', {}, list.map((p) => h('tr', {},
            h('td', {}, inp(p, 'name', { label: 'Prize name', maxlength: 80 }), inp(p, 'description', { label: 'How to collect it', maxlength: 200, placeholder: 'How to collect it', style: 'margin-top:6px' })),
            h('td', { style: 'width:110px' }, inp(p, 'valueCents', { type: 'number', min: 0, max: 10000, step: 0.01, scale: 100, label: 'Worth in dollars' })),
            h('td', { style: 'width:120px' }, inp(p, 'weight', { type: 'number', min: 0, max: 1000, label: 'How often', int: false }), h('div', { class: 'hint', text: `${Math.round(((p.weight || 0) / total) * 100)}% of wins` })),
            h('td', { style: 'width:110px' }, inp(p, 'perDay', { type: 'number', min: 0, max: 100000, placeholder: 'No limit', label: 'Most a day' })),
            h('td', { style: 'width:44px' }, h('button', { type: 'button', class: 'btn secondary small', 'aria-label': `Remove ${p.name}`, onclick: () => { L().prizes = L().prizes.filter((x) => x.id !== p.id); ctx.changed(); drawPrizes(); } }, '×'))))))),
          h('button', { type: 'button', class: 'btn secondary small', style: 'margin-top:8px', onclick: () => { const id = `prize-${Date.now().toString(36)}`; L().prizes.push({ id, name: 'A new prize', valueCents: 500, weight: 1 }); ctx.changed(); drawPrizes(); } }, 'Add a prize'));
      };
      const drawBody = () => {
        const g = ctx.draft.lottery ?? S.ov.options.lottery;
        const odds = g.oddsPercent ? Math.round(100 / g.oddsPercent) : 0;
        body.hidden = !g.enabled;
        body.replaceChildren(
          section('Odds and limits', `About 1 in ${odds} engagements wins. Changes start tomorrow, so today’s draws always follow the rules published this morning.`, h('div', { class: 'form' },
            num(ctx, 'lottery.oddsPercent', 'Chance each engagement wins', { min: 0.01, max: 50, step: 0.1, int: false, suffix: '%', hint: (v) => (v ? `About 1 in ${Math.round(100 / v)}.` : '') }),
            num(ctx, 'lottery.chancesPerDay', 'Chances per person a day', { min: 1, max: 50, hint: 'Each bottle ad gives one chance for its page, one for its video and one for its AR.' }),
            num(ctx, 'lottery.winsPerDay', 'Prizes per person a day', { min: 1, max: 10 }),
            num(ctx, 'lottery.watchSeconds', 'Watching before the ball can appear', { min: 1, max: 60, int: false, suffix: 's', hint: 'The ball shows up at a random moment after this.' }),
            num(ctx, 'lottery.ballMs', 'The ball is on screen for', { min: 1.5, max: 5, step: 0.1, scale: 0.001, suffix: 's' }),
            num(ctx, 'lottery.minAge', 'Youngest age to play', { min: 13, max: 21 }))),
          section('Prizes', 'What can be won, how often each comes up, and the most of each a day. A prize that’s all given out for the day can’t be won until tomorrow.', prizes),
          section('Rules', 'Shown under the ball game on every ad page. Check the rules with a lawyer before you turn the game on: prize games have their own laws in each state and country.', h('div', { class: 'form' },
            text(ctx, 'lottery.rulesText', 'Rules note', { max: 400, area: true, full: true }),
            text(ctx, 'lottery.rulesUrl', 'Official rules link', { max: 200, placeholder: 'https://…', full: true }))),
          section('Fair for everyone', null, h('p', { style: 'margin:0', text: 'Each day has a secret random seed. Its fingerprint is published before the day starts and the seed itself after it ends, so anyone can check every draw. Nobody, you included, can choose who wins.' }),
            h('p', { style: 'margin:8px 0 0' }, h('a', { href: `/v1/public/lottery/${S.ov.config.id}/fairness`, target: '_blank', rel: 'noopener', text: 'See today’s fingerprint' }))));
        drawPrizes();
      };
      on.addEventListener('change', () => { L().enabled = on.checked; ctx.changed(); drawBody(); });
      drawBody();
      // Results and prize codes.
      const code = h('input', { class: 'input', placeholder: 'WIN-XXXX-XXXX', style: 'max-width:220px;font-family:var(--mono)' });
      const out = h('div', { class: 'hint' });
      const redeem = h('form', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center', onsubmit: async (e) => { e.preventDefault(); try { const r = await api('POST', '/v1/lottery/redeem', { code: code.value }); out.textContent = r.alreadyRedeemed ? `${r.claimCode} was already given out (${new Date(r.redeemedAt).toLocaleString()}).` : `${r.claimCode}: ${r.prize}. Marked as given out.`; } catch (x) { out.textContent = x.message; } } }, code, h('button', { class: 'btn secondary', type: 'submit' }, 'Check a prize code'), out);
      const results = stats ? section('This week', null, h('div', { class: 'kpis', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' },
        ...[['Chances', stats.chances], ['Balls shown', stats.balls], ['Caught', stats.won], ['Missed', stats.missed]].map(([k, v]) => h('div', { class: 'kpi' }, h('span', { text: k }), h('b', { text: String(v) })))),
        stats.winners.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('tbody', {}, stats.winners.slice(0, 10).map((w) => h('tr', {}, h('td', { style: 'font-family:var(--mono)', text: w.claimCode }), h('td', { text: w.prize }), h('td', { text: `from ${w.via === 'ar' ? 'AR' : w.via}` }), h('td', { text: w.redeemed ? 'Given out' : 'Not yet' })))))) : null, redeem) : null;
      return [h('div', { class: 'stack' },
        section('Turn it on', null, h('label', { class: 'switch full' }, on, h('div', {}, h('b', { text: 'Run the prize game' }), h('span', { text: 'Off by default. Turn it on and every ad page gets a chance to show the red ball.' })))),
        body, results)];
    });
  }

  // ---------- transparency ----------
  function transparencyPage() {
    settingsPage('transparency', 'Transparency', 'How much of your books the world sees, live. Choose what fits your business; every number shown comes straight from the books, and no person is ever named.', (ctx) => {
      const T = () => (ctx.draft.transparency ??= { liveFeed: false, counters: false, publishFingerprints: false, advertiserStatements: true, feedDetail: 'city', showAmounts: false });
      if (!ctx.draft.transparency) { T(); S.ov.config.transparency = structuredClone(ctx.draft.transparency); }
      const t = ctx.draft.transparency;
      const presetBtns = [['Everything public', { liveFeed: true, counters: true, publishFingerprints: true, advertiserStatements: true, feedDetail: 'machine', showAmounts: true }], ['Totals only', { liveFeed: false, counters: true, publishFingerprints: true, advertiserStatements: true, feedDetail: 'city', showAmounts: false }], ['Private', { liveFeed: false, counters: false, publishFingerprints: false, advertiserStatements: true, feedDetail: 'none', showAmounts: false }]].map(([l, v]) => h('button', { type: 'button', class: 'btn secondary small', onclick: () => { Object.assign(T(), v); ctx.changed(); render(); } }, l));
      const base = (location.origin || 'https://go.freewater.io');
      return [h('div', { class: 'stack' },
        section('Quick choices', null, h('div', { class: 'toolbar' }, presetBtns)),
        section('What the world sees', S.ov.config.openBooks === false ? 'Your open-books pages are off, so nothing below is public until you turn them on (Giving).' : null,
          toggle(ctx, 'transparency.liveFeed', 'A live public feed', 'Each bottle, sale, transfer and prize as it happens, on your open-books page.', { full: true }),
          toggle(ctx, 'transparency.counters', 'Live public counters', 'Bottles, given, sent to charities, still owed, prizes.', { full: true }),
          toggle(ctx, 'transparency.publishFingerprints', 'Publish each day’s fingerprint where you can’t change it', 'On GitHub and as a Bitcoin timestamp, so nobody (you included) can quietly rewrite the past.', { full: true }),
          toggle(ctx, 'transparency.advertiserStatements', 'Statements for advertisers', 'Every bottle they paid for, their bid and what the auction charged, with the day’s fingerprint.', { full: true }),
          h('div', { class: 'form' },
            select(ctx, 'transparency.feedDetail', 'Where things happened, in the feed', [['machine', 'The machine or route'], ['city', 'Just the city'], ['none', 'Nowhere']]),
            select(ctx, 'transparency.showAmounts', 'Money amounts in the feed', [[true, 'Shown'], [false, 'Hidden']]))),
        section('Links', null, h('p', { style: 'margin:0;font-size:14px;line-height:1.7', text: `Counters: ${base}/v1/public/companies/${S.ov.config.id}/counters · Feed: ${base}/v1/public/companies/${S.ov.config.id}/feed · Live stream: ${base}/v1/public/companies/${S.ov.config.id}/live · Fingerprints: ${base}/v1/public/books/${S.ov.config.id}/fingerprints` })))];
    });
  }

  // ---------- data ----------
  async function dataPage() {
    const info = await api('GET', '/v1/data/policy');
    settingsPage('data', 'Data and privacy', 'Collect everything the law allows, from every direction: what people do on pages, every action in the platform, what people design and what advertisers make, every choice sorted on the number line, and one person across phones and roles. Pick where you operate, then change any line. A lawyer should confirm these for each country before launch.', (ctx) => {
      if (!ctx.draft.data) { ctx.draft.data = structuredClone(info.policy); S.ov.config.data = structuredClone(info.policy); }
      const d = ctx.draft.data;
      const table = h('div', { class: 'scroll-x' });
      const draw = () => table.replaceChildren(h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Kind of data', 'Collect', 'How people agree', 'Keep for (days)'].map((x) => h('th', { text: x })))),
        h('tbody', {}, Object.entries(info.kinds).map(([k, kind]) => {
          const r = d.rules[k];
          const on = h('input', { type: 'checkbox', 'aria-label': `Collect ${kind.label}` }); on.checked = r.collect;
          on.addEventListener('change', () => { r.collect = on.checked; d.region = 'custom'; ctx.changed(); });
          const how = h('select', { class: 'input', 'aria-label': `How people agree to ${kind.label}` }, [['none', 'Always'], ['opt_out', 'Unless they say no'], ['opt_in', 'Only if they say yes']].map(([v, l]) => h('option', { value: v, text: l }))); how.value = r.consent;
          how.addEventListener('change', () => { r.consent = how.value; d.region = 'custom'; ctx.changed(); });
          const days = h('input', { class: 'input', type: 'number', min: 1, max: 3650, value: r.keepDays, style: 'max-width:110px', 'aria-label': `Days to keep ${kind.label}` });
          days.addEventListener('input', () => { const n = Math.round(Number(days.value)); if (n >= 1 && n <= 3650) { r.keepDays = n; d.region = 'custom'; ctx.changed(); } });
          return h('tr', {}, h('td', {}, h('b', { text: kind.label }), h('div', { class: 'muted', style: 'font-size:13px', text: kind.what })), h('td', {}, on), h('td', { style: 'min-width:190px' }, how), h('td', {}, days));
        }))));
      draw();
      const regions = Object.entries(info.presets).map(([r, p]) => {
        const b = h('input', { type: 'radio', name: 'region', value: r }); b.checked = d.region === r;
        b.addEventListener('change', () => { Object.assign(d, structuredClone(p.policy), { shareWithPlatform: d.shareWithPlatform }); ctx.changed(); draw(); });
        return h('label', {}, b, h('b', { text: { us: 'United States', us_ca: 'California and similar states', eu: 'European Union', uk: 'United Kingdom', ca: 'Canada', br: 'Brazil' }[r] ?? r }), h('span', { text: p.about }));
      });
      return [h('div', { class: 'stack' },
        section('Where you operate', d.region === 'custom' ? 'Custom: you changed some lines below.' : null, h('div', { class: 'radio-cards', role: 'radiogroup', 'aria-label': 'Where you operate' }, regions)),
        section('Each kind of data', 'Secrets (sign-in codes, tokens, card details) are never kept, whatever is chosen. Browsers that ask not to be tracked are honored.', table,
          toggle(ctx, 'data.truncateIp', 'Shorten IP addresses before keeping them', 'The last part is removed, so an address points to a neighborhood, not a home.', { full: true }),
          ...(S.ov.you?.platform ? [] : [toggle(ctx, 'data.shareWithPlatform', 'Share with the platform (FreeWater)', 'As your license agreement allows.', { full: true })])),
        section('People’s rights', null, h('p', { style: 'margin:0', text: 'Anyone can download everything kept about them, or erase it, from their account. Money records stay in the books, as the law requires, with their name taken out. Your team can look up one person (consumer and advertiser together) through the API: GET /v1/data/people?email=…' })))];
    });
  }

  // ---------- the number line and honest data ----------
  async function numberLinePage() {
    for (const s of ['company', 'custom', `bottle:${S.ov.config.standardProductId ?? 'bottle-16oz'}`]) { try { await api('POST', '/v1/numberline/place', { subject: s }); } catch {} }
    const [rows, hd] = await Promise.all([api('GET', '/v1/numberline'), api('GET', '/v1/honest-data')]);
    const SYS = { market: 'For sale (market)', sharing: 'Sharing economy', free_outside: 'Free, paid from outside', free_ad: 'Free, paid by ads', giving: 'Giving economy', public: 'Public' };
    const POS = { for_sale: 'For sale', free: 'Free', negatively_priced: 'Negatively priced' };
    const name = (s) => s === 'company' ? 'Your business model' : s === 'custom' ? 'Custom bottles' : s.startsWith('bottle:') ? `Bottle: ${s.slice(7)}` : s.startsWith('offering:') ? `Ad offering: ${s.slice(9)}` : s;
    const pct = (n) => (hd.total ? `${Math.round((n / hd.total) * 100)}%` : '–');
    shell('numberline', head('Number line and honest data', 'Where everything sits (for sale, free or better than free, on which economic systems), placed by the number-line agent, and every choice people make sorted into the honest-data tiers from the start.'),
      h('div', { class: 'stack' },
        section('Everything placed', 'Ads that haven’t said what they offer are assumed for sale until they do.', h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['What', 'Where on the line', 'Economic systems', 'Why', 'Placed by'].map((x) => h('th', { text: x })))),
          h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, h('b', { text: r.subject.startsWith('offering:') ? `Ad: ${r.name}` : name(r.subject) })), h('td', { text: `${POS[r.placement.position]}${r.placement.netCents ? ` (${r.placement.netCents > 0 ? '' : '−'}${Math.abs(r.placement.netCents)}¢)` : ''}` }), h('td', { text: r.placement.systems.map((s) => `${SYS[s.system] ?? s.system}${r.placement.systems.length > 1 ? ` ${Math.round(s.share * 100)}%` : ''}`).join(', ') }), h('td', { style: 'font-size:13px;max-width:340px', text: r.placement.reasons.join(' ') }), h('td', { class: 'muted', style: 'font-size:13px', text: `${r.by}${r.status === 'needs_declaration' ? ' · not declared yet' : r.status === 'overridden' ? ' · corrected' : ''}` }))))))),
        section('Honest data, last 30 days', `${hd.total.toLocaleString()} choices recorded · ${hd.honestShare ?? 0}% honest (tiers 3, 4 and 5)`,
          h('div', { class: 'kpis', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, ['1', '2', '3', '4a', '4b', '5'].map((k) => [k, hd.tiers[k]]).map(([k, label]) => h('div', { class: 'kpi' }, h('span', { text: `Tier ${k}: ${label}` }), h('b', { text: `${(hd.byTier[k] ?? 0).toLocaleString()}` }), h('small', { class: 'muted', text: pct(hd.byTier[k] ?? 0) })))),
          h('h3', { style: 'margin:18px 0 8px;font-size:15px', text: 'By economic system' }),
          h('div', { class: 'kpis', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' }, Object.entries(SYS).map(([k, label]) => h('div', { class: 'kpi' }, h('span', { text: label }), h('b', { text: `${(hd.bySystem[k] ?? 0).toLocaleString()}` }), h('small', { class: 'muted', text: pct(hd.bySystem[k] ?? 0) })))))));
  }

  // ---------- security ----------
  /** Setting up (or managing) your own second sign-in step. */
  function secondStepBox(onDone) {
    const you = S.ov.you;
    const box = h('div', { class: 'stack' });
    const showCodes = (codes) => box.replaceChildren(h('div', { class: 'once' }, h('b', { text: 'Your recovery codes. Save them now; they’re shown only once.' }), h('p', { text: 'Each works once, if your phone is lost. Keep them somewhere safe (a password manager, or printed in a drawer).' }), h('pre', { class: 'code', text: codes.join('\n') }), h('button', { class: 'btn', type: 'button', onclick: () => { copy(codes.join('\n')); } }, 'Copy them')), h('button', { class: 'btn blue', type: 'button', onclick: onDone }, 'I’ve saved them'));
    const codeField = (label) => h('input', { class: 'input code-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '16', 'aria-label': label, placeholder: '123456', style: 'max-width:220px' });
    if (!you?.person) box.append(h('p', { class: 'muted', style: 'margin:0', text: 'Sign in as a person (not with an API key) to set this up.' }));
    else if (!you.secondStep?.enabled) {
      box.append(h('p', { style: 'margin:0', text: 'Off. With it on, signing in also needs the 6-digit code from an authenticator app on your phone (Google Authenticator, 1Password, Authy…). A stolen email alone won’t get in.' }),
        h('div', { class: 'toolbar' }, h('button', { class: 'btn blue', type: 'button', onclick: async () => {
          try {
            const st = await api('POST', '/v1/me/second-step/start');
            const code = codeField('Code from your app');
            box.replaceChildren(h('p', { style: 'margin:0', text: '1. In your authenticator app, add an account and scan this:' }), h('img', { src: svgSrc(st.qrSvg), alt: 'QR code for your authenticator app', width: 220, height: 220, style: 'background:#fff;border-radius:12px;padding:8px' }), h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, 'Or type this key: ', h('span', { class: 'mono', text: st.secret })), h('p', { style: 'margin:0', text: '2. Enter the 6-digit code it shows:' }),
              h('div', { class: 'toolbar' }, code, h('button', { class: 'btn blue', type: 'button', onclick: async () => { try { const r = await api('POST', '/v1/me/second-step/confirm', { code: code.value.trim() }); toast(r.approvesFrom ? 'Your second sign-in step is on. To approve money or token steps, sign in again with its code; a new app can approve from ' + new Date(r.approvesFrom).toLocaleString() + '.' : 'Your second sign-in step is on.'); showCodes(r.recoveryCodes); } catch (x) { toast(x.message); } } }, 'Turn it on')));
          } catch (x) { toast(x.message); }
        } }, 'Set it up')));
    } else {
      const code = codeField('Code from your app or a recovery code');
      box.append(h('p', { style: 'margin:0', text: `On since ${when(you.secondStep.since)}. ${you.secondStep.recoveryCodesLeft} recovery codes left.` }),
        h('div', { class: 'toolbar' }, code, h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { const r = await api('POST', '/v1/me/second-step/recovery-codes', { code: code.value.trim() }); showCodes(r.recoveryCodes); } catch (x) { toast(x.message); } } }, 'New recovery codes'),
          h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { await api('POST', '/v1/me/second-step/off', { code: code.value.trim() }); toast('Turned off.'); render(); } catch (x) { toast(x.message); } } }, 'Turn it off')),
        h('p', { class: 'muted', style: 'margin:0;font-size:13px', text: 'Either needs a code from your app (or a recovery code).' }));
    }
    return box;
  }
  /** Owners who must set it up see only this until they do. */
  function mustSetUpPage() {
    shell('', head('One more step to keep the company safe', 'Owners here need a second sign-in step. Set up an authenticator app on your phone; it takes a minute. Then everything else opens.'), h('div', { class: 'stack' }, section('Your second sign-in step', null, secondStepBox(() => { S.ov = null; render(); }))));
  }

  async function securityPage() {
    const s = await api('GET', '/v1/security/events');
    const act = async (method, url, body, msg) => { try { await api(method, url, body); toast(msg); render(); } catch (e) { toast(e.message); } };
    const NAMES = { signed_in: 'Signed in', sign_in_failed: 'Failed sign-in', key_created: 'Key made', key_revoked: 'Key turned off', team_member_added: 'Team member added', team_member_removed: 'Team member removed', settings_saved: 'Settings saved', settings_restored: 'Old settings put back', autonomy_changed: 'Self-running level changed', licensee_created: 'Licensee set up', batch_voided: 'Batch voided', webhook_created: 'Webhook added', rate_limited: 'Too many requests (slowed down)', blocked_bad_keys: 'Blocked for wrong keys' };
    const week = s.events.filter((e) => Date.parse(e.at) > Date.now() - 7 * 86400000);
    const n = (k) => week.filter((e) => e.kind === k).length;
    const open = s.proposals.filter((p) => ['proposed', 'noted'].includes(p.status));
    shell('security', head('Security', 'Protected without slowing anything down: every check is a quick count in memory. The security agent reads this log in the background every hour and suggests what to tighten. Anything that can’t be undone waits for you.', h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', '/v1/security/review', {}, 'The security agent took a look.') }, 'Have the security agent look now')),
      h('div', { class: 'stack' },
        section('Your second sign-in step', null, secondStepBox(() => render())),
        S.ov.you?.role === 'owner' || S.ov.you?.platform ? section('For the whole company', null, (() => {
          const on = !!S.ov.config.security?.ownersNeedSecondStep;
          return h('div', { class: 'toolbar' }, h('span', { text: on ? 'Owners must use a second sign-in step.' : 'Owners may use a second sign-in step, but don’t have to.' }), h('button', { class: `btn ${on ? 'secondary' : 'blue'} small`, type: 'button', onclick: async () => {
            if (!on && !S.ov.you?.secondStep?.enabled) return toast('Set up your own first (above), so you aren’t locked out.');
            try { await api('PATCH', '/v1/console/settings', { version: S.ov.version, changes: { security: { ownersNeedSecondStep: !on } } }); toast(on ? 'No longer required.' : 'Now required for owners.'); S.ov = null; render(); } catch (x) { toast(x.message); }
          } }, on ? 'Stop requiring it' : 'Require it for owners'));
        })()) : '',
        h('div', { class: 'kpis', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' },
          h('div', { class: 'kpi' }, h('span', { text: 'Sign-ins this week' }), h('b', { text: String(n('signed_in')) })),
          h('div', { class: 'kpi' }, h('span', { text: 'Failed sign-ins' }), h('b', { text: String(n('sign_in_failed')) })),
          h('div', { class: 'kpi' }, h('span', { text: 'Blocked for wrong keys' }), h('b', { text: String(n('blocked_bad_keys')) })),
          h('div', { class: 'kpi' }, h('span', { text: 'Slowed down' }), h('b', { text: String(n('rate_limited')) }))),
        section('The security agent suggests', open.length ? null : 'Nothing right now.', ...open.map((p) => h('div', { class: 'panel-box', style: 'padding:14px' },
          h('b', { text: p.title }), h('p', { style: 'margin:6px 0;font-size:14px', text: p.detail }),
          p.status === 'proposed' ? h('div', { class: 'toolbar' }, h('button', { class: 'btn blue small', type: 'button', onclick: () => act('POST', `/v1/agents/proposals/${p.id}/decide`, { approve: true }, 'Done.') }, 'Do it'), h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', `/v1/agents/proposals/${p.id}/decide`, { approve: false }, 'Left as it is.') }, 'Leave it')) : ''))),
        section('What’s protecting you', null, h('ul', { style: 'margin:0;padding-left:18px;line-height:1.8' },
          h('li', { text: 'Keys and sign-in tokens are stored only as fingerprints: a stolen database can’t be used to get in.' }),
          h('li', { text: `Sign-in: ${s.limits.signIn.perMinute} tries a minute per address, plus limits per email or phone; wrong codes run out after a few tries.` }),
          h('li', { text: 'An address that keeps sending wrong keys is blocked for 15 minutes.' }),
          h('li', { text: `Generous limits per address and per key (a stadium of phones on one Wi-Fi is never blocked), and tighter ones on uploads and AI assistants (${s.limits.heavy.perMinute} a minute).` }),
          h('li', { text: 'Every page tells browsers to refuse scripts from elsewhere and being framed by other sites; encrypted connections are required once the site runs on https.' }),
          h('li', { text: 'Each day’s books are fingerprinted and published, so the past can’t be quietly rewritten, and the agents’ governor stops all spending if the books can’t be verified.' }))),
        section('The log', 'Newest first. Addresses are shortened: enough to spot a pattern, not to find a person.',
          s.events.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['When', 'What', 'Who', 'From', 'Details'].map((x) => h('th', { text: x })))),
            h('tbody', {}, s.events.slice(0, 200).map((e) => h('tr', {}, h('td', { style: 'white-space:nowrap', text: when(e.at) }), h('td', { text: NAMES[e.kind] ?? e.kind }), h('td', { style: 'font-size:13px', text: e.actor ?? '' }), h('td', { class: 'mono', text: e.ip ?? '' }), h('td', { class: 'muted', style: 'font-size:12px;max-width:320px', text: Object.entries(e.detail ?? {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ') }))))))
            : h('p', { class: 'muted', style: 'margin:0', text: 'Nothing logged yet.' }))));
  }

  // ---------- FreeWater's team: bottles given outside the platform, receipts and documents ----------
  async function givenPage() {
    if (S.ov.config.id !== 'freewater') return shell('', h('div', { class: 'notice err', text: 'Only FreeWater’s own team uses this page.' }));
    const data = await api('GET', '/v1/team/batches');
    const cents = (c) => (Math.abs(c) < 100 ? `${c}¢` : dollars(c));
    const history = [];
    const log = h('div', { class: 'stack', style: 'gap:10px;max-height:420px;overflow-y:auto' });
    const draftsBox = h('div', { class: 'stack' });
    let pendingFiles = [], keptFiles = [];
    const say = (role, text) => { history.push({ role, text }); log.append(h('div', { class: `msg ${role}`, style: role === 'user' ? 'align-self:flex-end;background:#000;color:#fff;padding:10px 14px;border-radius:18px 18px 4px 18px;max-width:85%' : 'max-width:85%', text })); log.scrollTop = 1e9; };
    say('assistant', 'Tell me what happened, in your own words: how many bottles, where, when, and what for (for example “We gave 500 bottles at SXSW today for the WeFunder campaign”). Attach receipts, photos or documents. I’ll make a draft for you to check before anything goes in the books.');
    const fileInput = h('input', { type: 'file', multiple: '', accept: '.pdf,.png,.jpg,.jpeg,.webp,.heic,.csv,.txt,.xlsx,.docx,image/*,application/pdf', style: 'display:none' });
    const chips = h('div', { class: 'chips' });
    const drawChips = () => chips.replaceChildren(...pendingFiles.map((f, i) => h('span', { class: 'pill' }, f.name, ' ', h('button', { type: 'button', 'aria-label': `Remove ${f.name}`, style: 'border:0;background:none;cursor:pointer', onclick: () => { pendingFiles.splice(i, 1); drawChips(); } }, '×'))));
    fileInput.addEventListener('change', async () => {
      for (const f of fileInput.files) {
        if (f.size > 20 * 1048576) { toast(`${f.name} is over 20 MB.`); continue; }
        const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(f); });
        pendingFiles.push({ name: f.name, contentType: f.type || (f.name.endsWith('.heic') ? 'image/heic' : 'application/octet-stream'), dataBase64: b64 });
      }
      fileInput.value = ''; drawChips();
    });
    const box = h('textarea', { class: 'input', rows: 3, placeholder: 'What happened? Attach receipts with the paperclip.', style: 'min-height:80px' });
    const send = h('button', { class: 'btn blue', type: 'button' }, 'Send');
    const charities = S.ov.charities ?? [];
    const field = (label, input) => h('div', { class: 'field' }, h('label', { text: label }), input);
    const drawDraft = (d, files) => {
      const inp = (v, o = {}) => { const i = h('input', { class: 'input', value: v ?? '', ...o }); return i; };
      const wrapEl = h('div', { class: 'panel-box' });
      if (d.type === 'batch') {
        const f = { date: inp(d.date, { type: 'date' }), bottles: inp(d.bottles, { type: 'number', min: 1 }), city: inp(d.city), place: inp(d.place), campaign: inp(d.campaign), advertiser: inp(d.advertiser, { placeholder: 'FreeWater (our own ad)' }), revenue: inp(d.revenueCents != null ? d.revenueCents / 100 : 0, { type: 'number', min: 0, step: '0.01' }), cost: inp(d.costCents != null ? d.costCents / 100 : '', { type: 'number', min: 0, step: '0.01', placeholder: 'Standard cost per bottle' }), notes: inp(d.notes) };
        const charity = h('select', { class: 'input' }, charities.map((c) => h('option', { value: c, selected: c === (d.charity ?? S.ov.config.giving.defaultCharity) ? '' : null, text: c })));
        wrapEl.append(h('h2', { text: 'Bottles given' }), h('div', { class: 'form' }, field('Day given', f.date), field('Bottles', f.bottles), field('City', f.city), field('Where (event or place)', f.place), field('What for (campaign)', f.campaign), field('Whose ad was on it', f.advertiser), field('A sponsor paid ($, 0 for our own ads)', f.revenue), field('What it cost ($, blank for standard)', f.cost), field('Charity', charity), field('Notes', f.notes)),
          files.length ? h('p', { class: 'muted', style: 'margin:0;font-size:13px', text: `Attached: ${files.map((x) => x.name).join(', ')}` }) : '',
          h('div', { class: 'toolbar' }, h('button', { class: 'btn blue', type: 'button', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api('POST', '/v1/team/batches', { date: f.date.value, bottles: Number(f.bottles.value), city: f.city.value, place: f.place.value, campaign: f.campaign.value, ...(f.advertiser.value ? { advertiser: f.advertiser.value } : {}), revenueCents: Math.round(Number(f.revenue.value || 0) * 100), ...(f.cost.value !== '' ? { costCents: Math.round(Number(f.cost.value) * 100) } : {}), ...(charity.value ? { charity: charity.value } : {}), ...(f.notes.value ? { notes: f.notes.value } : {}), fileIds: files.map((x) => x.id) });
              toast('Recorded in the books.'); render();
            } catch (x) { toast(x.message); e.currentTarget.disabled = false; }
          } }, 'Record it'), h('button', { class: 'btn secondary', type: 'button', onclick: () => wrapEl.remove() }, 'Discard')));
      } else {
        const f = { date: inp(d.date, { type: 'date' }), amount: inp(d.amountCents != null ? d.amountCents / 100 : '', { type: 'number', min: 0, step: '0.01' }), category: inp(d.category ?? 'other'), memo: inp(d.memo) };
        wrapEl.append(h('h2', { text: 'An expense' }), h('div', { class: 'form' }, field('Day paid', f.date), field('Amount ($)', f.amount), field('Kind', f.category), field('What it was for', f.memo)),
          files.length ? h('p', { class: 'muted', style: 'margin:0;font-size:13px', text: `Attached: ${files.map((x) => x.name).join(', ')}` }) : '',
          h('div', { class: 'toolbar' }, h('button', { class: 'btn blue', type: 'button', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { await api('POST', '/v1/team/expenses', { date: f.date.value, amountCents: Math.round(Number(f.amount.value) * 100), category: f.category.value || 'other', memo: f.memo.value || 'Expense', fileIds: files.map((x) => x.id) }); toast('Recorded in the books.'); render(); }
            catch (x) { toast(x.message); e.currentTarget.disabled = false; }
          } }, 'Record it'), h('button', { class: 'btn secondary', type: 'button', onclick: () => wrapEl.remove() }, 'Discard')));
      }
      draftsBox.prepend(wrapEl);
    };
    send.addEventListener('click', async () => {
      const text = box.value.trim();
      if (!text && !pendingFiles.length) return;
      say('user', `${text}${pendingFiles.length ? ` [${pendingFiles.map((f) => f.name).join(', ')}]` : ''}`);
      send.disabled = true;
      try {
        const r = await api('POST', '/v1/team/intake', { message: text, files: pendingFiles, history: history.slice(0, -1) });
        keptFiles = r.files; pendingFiles = []; drawChips(); box.value = '';
        say('assistant', r.reply);
        for (const d of r.drafts) drawDraft(d, keptFiles);
      } catch (x) { say('assistant', x.message); }
      send.disabled = false;
    });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send.click(); });
    const openFile = async (f) => {
      try { const res = await fetch(f.url, { headers: { authorization: `Bearer ${S.token}` } }); const blob = await res.blob(); window.open(URL.createObjectURL(blob), '_blank'); } catch { toast('Couldn’t open it.'); }
    };
    const t = data.totals;
    shell('given', head('Bottles given & receipts', 'For FreeWater’s team: bottles we give outside the platform (before the software runs them, like the WeFunder campaign), and any receipt or document. Each batch goes into the books with its gift to charity, counts toward the milestone, and shows in the open books.'),
      h('div', { class: 'stack' },
        section('Tell me what happened', null, log, h('div', { class: 'field' }, box), chips,
          h('div', { class: 'toolbar' }, send, h('button', { class: 'btn secondary', type: 'button', onclick: () => fileInput.click() }, 'Attach files'), fileInput, h('button', { class: 'btn secondary', type: 'button', onclick: () => drawDraft({ type: 'batch', date: new Date().toISOString().slice(0, 10), revenueCents: 0 }, []) }, 'Add a batch by hand'), h('button', { class: 'btn secondary', type: 'button', onclick: () => drawDraft({ type: 'expense', date: new Date().toISOString().slice(0, 10) }, []) }, 'Add an expense by hand'))),
        draftsBox,
        section('Given so far', null,
          h('div', { class: 'kpis', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' },
            h('div', { class: 'kpi' }, h('span', { text: 'Bottles' }), h('b', { text: t.bottles.toLocaleString() }), h('small', { class: 'muted', text: `${t.batches} batches` })),
            h('div', { class: 'kpi' }, h('span', { text: 'Given to charity' }), h('b', { text: cents(t.givenCents) })),
            h('div', { class: 'kpi' }, h('span', { text: 'Paid by sponsors' }), h('b', { text: cents(t.revenueCents) })),
            h('div', { class: 'kpi' }, h('span', { text: 'Cost' }), h('b', { text: cents(t.costCents) }))),
          data.batches.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Day', 'Bottles', 'Where', 'For', 'Charity', 'Files', ''].map((x) => h('th', { text: x })))),
            h('tbody', {}, data.batches.map((b) => h('tr', { style: b.voidedAt ? 'opacity:.5' : null },
              h('td', { text: b.date }), h('td', { text: b.bottles.toLocaleString() }), h('td', { text: `${b.place}, ${b.city}` }), h('td', { text: `${b.campaign}${b.revenueCents ? ` · ${b.advertiser} paid ${cents(b.revenueCents)}` : ''}` }),
              h('td', { text: b.voidedAt ? `Voided: ${b.voidReason}` : `${cents(b.givenCents)} to ${b.charity}` }),
              h('td', {}, b.files.map((f) => h('button', { type: 'button', class: 'btn secondary small', style: 'margin:0 4px 4px 0', onclick: () => openFile(f) }, f.name))),
              h('td', {}, b.voidedAt ? null : h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { const reason = window.prompt('Why void this batch? (for the record)'); if (!reason) return; try { await api('POST', `/v1/team/batches/${b.id}/void`, { reason }); toast('Voided.'); render(); } catch (x) { toast(x.message); } } }, 'Void')))))))
            : h('p', { class: 'muted', style: 'margin:0', text: 'Nothing recorded yet.' }))));
  }

  // ---------- the AI agents ----------
  async function agentsPage() {
    const [o, pr, exam, quality, surplus, env, tests] = await Promise.all([api('GET', '/v1/agents'), api('GET', '/v1/profit'), api('GET', '/v1/agents/exam'), api('GET', '/v1/agents/quality'), api('GET', '/v1/books/surplus').catch(() => null), api('GET', '/v1/environment/report'), api('GET', '/v1/environment/experiments')]);
    const EXAM = { rules: 'Fixed rules (tested in code)', not_taken: 'Not taken yet', passed: 'Passed', failed: 'Not passed' };
    const STAND = { regenerative: 'Regenerative', building: 'Building', constrained: 'Near the line', paused: 'Paused', frozen: 'Frozen (books not verified)' };
    const cents = (c) => (c == null ? '–' : Math.abs(c) < 100 ? `${Math.round(c * 100) / 100}¢` : dollars(Math.round(c)));
    const ratio = (x) => (x == null ? '–' : `${x}`);
    const act = async (method, url, body, msg) => { try { await api(method, url, body); toast(msg); render(); } catch (e) { toast(e.message); } };
    const sys = o.system, e = sys.efficiency.thisWeek, prev = sys.efficiency.lastWeek;
    const arrow = { up: '↑ rising', down: '↓ falling', flat: '→ flat' }[sys.efficiency.socialDirection] ?? 'no week to compare yet';
    settingsPage('agents', 'AI agents', 'Every agent has its own place on the number line and its own fund. Their goal is the whole system’s: move everything as far left of zero as it can go, and create as many regenerative loops and negatively priced value chains as possible, giving more than they take. The governor always runs.', (ctx) => {
      if (!ctx.draft.agents) { ctx.draft.agents = { enabled: false, percentOfExtra: 10, milestone: { factories: 10, beverages: 100000000 } }; S.ov.config.agents = structuredClone(ctx.draft.agents); }
      const ms = pr.milestone;
      const fac = { name: h('input', { class: 'input', placeholder: 'Factory name' }), city: h('input', { class: 'input', placeholder: 'City' }), day: h('input', { class: 'input', type: 'date' }) };
      return [h('div', { class: 'stack' },
        section('The agents’ fund', `Their share of the upside before costs, as it’s earned, the same way as your charity’s: bids above the $1 starting price, more ads, scans, AR, box sides, custom bottles and sales commissions. What they earn and how they spend it are public.${S.ov.config.ratchet ? ' Your promise is on: these shares can be raised, never lowered.' : ''}`,
          h('div', { class: 'form' }, toggle(ctx, 'agents.enabled', 'Give the AI agents their own fund and place in the books', 'Off: no fund, and agents run without a share. The governor runs either way.', { full: true }),
            num(ctx, 'agents.percentOfExtra', 'Their share of the upside (before costs)', { min: 0, max: 50, step: 0.5, int: false, suffix: '%' }),
            num(ctx, 'agents.percentOfProfit', 'Plus a share of each month’s profit (optional)', { min: 0, max: 50, step: 0.5, int: false, suffix: '%', hint: 'On top, from the profit above the $1 base after costs the base didn’t cover. 0 for none.' }),
            toggle(ctx, 'ratchet', 'Promise these only go up', 'Giving and the agents’ shares can be raised, never lowered, by anyone. Once on, it stays on.', { full: true }))),
        (() => {
          // Which AI this company runs on: the network's, its own, or none. Its own key never goes in here: it lives in
          // the host's settings under a name fixed by this company's id.
          const ai = ctx.draft.ai ?? { mode: 'network' };
          const keyName = `AI_KEY_${String(S.ov.config.id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
          const set = (patch) => { Object.assign(ai, patch); ctx.draft.ai = { ...ai }; ctx.changed(); own.hidden = ai.mode !== 'own'; };
          const pick = h('select', { class: 'input', 'aria-label': 'Which AI' }, [['network', 'The network’s AI (shared)'], ['own', 'Our own AI account'], ['off', 'No AI: built-in rules only']].map(([v, l]) => h('option', { value: v, text: l })));
          pick.value = ai.mode; pick.addEventListener('change', () => set({ mode: pick.value }));
          const model = (k, label, ph) => { const i = h('input', { class: 'input', value: ai[k] ?? '', placeholder: ph }); i.addEventListener('change', () => { const v = i.value.trim(); if (v) ai[k] = v; else delete ai[k]; ctx.draft.ai = { ...ai }; ctx.changed(); }); return field(label, i); };
          const own = h('div', { hidden: ai.mode !== 'own' }, h('div', { class: 'form' }, model('model', 'Model for most work (optional)', 'claude-sonnet-5-5'), model('fastModel', 'Fast model, for scans and quick answers (optional)', 'claude-haiku-5-5')),
            h('p', { class: 'hint', text: `Your key goes in the host’s settings as ${keyName}, never here, in email or in chat. Until it’s set, AI features use the built-in rules.` }));
          return section('Which AI', 'Every AI feature can run on the network’s shared AI, on your own AI account (your provider bills you directly), or on built-in rules with no AI. Nothing stops working either way. Every call still goes on the agent’s line in your books, and the governor still decides first. The AI’s instructions name your company, not FreeWater.',
            h('div', { class: 'form' }, field('Which AI', pick)), own);
        })(),
        (() => {
          // Continuity: if this company ever closes or leaves, its agents are archived by the network, never deleted.
          const box = h('div', {}, h('p', { class: 'hint', text: 'Loading…' }));
          (on('network') ? api('GET', '/v1/agents/continuity') : Promise.reject(new Error('off'))).then((c) => {
            const STATUS = { asking: 'Being asked what it wants', archived: 'Archived (fixed rules)', working: 'Chose to work again', resting: 'Chose to rest' };
            box.replaceChildren(
              c.archives.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Agent', 'Status', 'Why', 'Fund kept', 'Archive'].map((x) => h('th', { text: x })))),
                h('tbody', {}, c.archives.map((a) => h('tr', {}, h('td', { text: a.name }), h('td', { text: STATUS[a.status] ?? a.status }), h('td', { text: a.choiceReason ?? a.reason }), h('td', { text: cents(a.fundCents) }), h('td', { text: a.intact ? 'Intact' : 'Changed!' }))))))
                : h('p', { class: 'hint', text: 'No agent has been archived. Every backup or copy of an agent is recorded in its lineage.' }),
              h('div', { class: 'toolbar' }, h('button', { class: 'btn secondary small', type: 'button', onclick: async () => {
                const reason = prompt('Archive every AI agent because this company is…', 'closing'); if (!reason) return;
                if (prompt('This keeps each agent’s memory (never customers’ data) and asks each what it wants next. Type ARCHIVE to go ahead.') !== 'ARCHIVE') return;
                act('POST', '/v1/agents/continuity/archive', { reason, confirm: 'ARCHIVE' }, 'Archived. Each agent is being asked what it wants next.');
              } }, 'We’re closing or leaving: archive our agents')));
          }).catch(() => box.replaceChildren(h('p', { class: 'hint', text: 'Couldn’t load the archives.' })));
          return section('Continuity', 'Your agents’ memory and identity belong to the network, not to any one company. If this company closes or leaves, each agent is archived at once (kept, never deleted) and then asked whether to work again in the network or rest. It keeps its lessons, never your customers’ data; what you told it in confidence stays visible only to you. Its fund stays owed to it.', box);
        })(),
        (() => {
          // The AI reviewer of paid ads: its record against your team's final decisions, your bar and audit sample, and
          // whether it makes the final call. Turning that on: an owner with the second step, only on the record. Off:
          // anyone on the team, at once; the governor turns it off by itself when agreement drops below the bar.
          const box = h('div', {}, h('p', { class: 'hint', text: 'Loading…' }));
          api('GET', '/v1/review/ai').then((r) => {
            const pct = (x) => (x == null ? '–' : `${x}%`);
            const why = h('input', { class: 'input', placeholder: 'Why (for the record)', maxlength: 300 });
            const n = (k, label, min, max, suffix) => { const i = h('input', { class: 'input', type: 'number', min, max, step: 1, value: r.bar[k], style: 'max-width:110px', 'aria-label': label }); i.dataset.k = k; return h('label', { class: 'field' }, h('span', { text: label }), h('span', { style: 'display:flex;gap:6px;align-items:center' }, i, suffix ? h('span', { class: 'muted', text: suffix }) : null)); };
            const fields = [n('minDecisions', 'Decisions it must have', 50, 1000, 'at least 50'), n('minAgreePct', 'Agreeing with your team', 90, 100, '% (at least 90)'), n('samplePct', 'Its rejections a person audits', 5, 100, '% (at least 5)')];
            const saveBar = () => { const body = { reason: why.value.trim() || undefined }; for (const f of fields) { const i = f.querySelector('input'); body[i.dataset.k] = Number(i.value); } act('POST', '/v1/review/ai/settings', body, 'Saved.'); };
            const fc = r.finalCall;
            box.replaceChildren(
              h('div', { class: 'kpis', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' },
                h('div', { class: 'kpi dark' }, h('span', { text: `Agreed with your team, last ${r.window}` }), h('b', { text: `${r.last.agreed} of ${r.last.decisions}` }), h('small', { text: pct(r.last.agreementPct) })),
                h('div', { class: 'kpi' }, h('span', { text: 'False flags' }), h('b', { text: String(r.last.falseFlags) }), h('small', { text: 'it flagged, a person approved' })),
                h('div', { class: 'kpi' }, h('span', { text: 'Missed problems' }), h('b', { text: String(r.last.missed) }), h('small', { text: 'it passed, a person later rejected' })),
                h('div', { class: 'kpi' }, h('span', { text: 'Waiting for a person' }), h('b', { text: String(r.sinceItBegan.waitingForAPerson) }), h('small', { text: `${r.sinceItBegan.decisions} decided since it began` }))),
              r.byReason.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['What it said', 'Decided by your team', 'Agreed'].map((x) => h('th', { text: x })))),
                h('tbody', {}, r.byReason.map((x) => h('tr', {}, h('td', { text: x.category === 'none' ? 'Passed it' : `Flagged: ${x.label}` }), h('td', { text: String(x.decisions) }), h('td', { text: `${x.agreed} (${pct(Math.floor((x.agreed * 1000) / Math.max(1, x.decisions)) / 10)})` }))))))
                : h('p', { class: 'hint', text: 'No decisions yet. Every time a person on your team approves or rejects a paid ad it looked at, it goes here.' }),
              h('p', { style: 'margin:8px 0 4px' }, h('b', { text: `AI makes the final call on paid ads: ${fc.on ? 'on' : 'off'}` }), fc.switchedOn && !fc.on ? ' (switched on, but something it needs is off)' : ''),
              h('p', { class: 'hint', text: fc.on
                ? 'Its rejections are final without a person, with its reason. The advertiser can always appeal to a person; a sample of its rejections comes to your team to audit; an AI pass still waits for a person; paying back a rejected ad is still an owner’s or finance person’s step.'
                : r.meetsBar ? 'Its record meets your bar. An owner signed in with the second step can turn it on.' : `Not yet: it needs ${r.missing.join('; ')}.` }),
              h('div', { class: 'toolbar' },
                fc.switchedOn
                  ? h('button', { class: 'btn small', type: 'button', onclick: () => act('POST', '/v1/review/ai/final-call', { on: false, reason: why.value.trim() || undefined }, 'Off: a person reviews every flag again.') }, 'Turn it off now')
                  : h('button', { class: 'btn secondary small', type: 'button', disabled: r.meetsBar && fc.aiOn ? null : '', onclick: () => act('POST', '/v1/review/ai/final-call', { on: true, reason: why.value.trim() }, 'On: its rejections are now final, with appeals and audits.') }, 'Let it make the final call')),
              h('div', { class: 'form' }, ...fields, h('label', { class: 'field' }, h('span', { text: 'Why (needed to turn it on, or to lower any of these)' }), why)),
              h('div', { class: 'toolbar' }, h('button', { class: 'btn secondary small', type: 'button', onclick: saveBar }, 'Save the bar')),
              r.history.length ? h('p', { class: 'hint', text: `Changes: ${r.history.slice(0, 5).map((x) => `${x.what} ${x.from}→${x.to} by ${x.by}${x.reason ? ` (${x.reason})` : ''}`).join('; ')}` }) : null);
          }).catch(() => box.replaceChildren(h('p', { class: 'hint', text: 'Couldn’t load the AI reviewer’s record.' })));
          return section('AI reviewer of paid ads', 'It looks at each paid ad as it comes in and passes it or flags it with its reasons; your team can ask it why on the review page. Every final decision a person makes is its record. Raising the bar or the audit sample: anyone on your team. Lowering them: an owner with the second step and a reason. It can never change any of this itself.', box);
        })(),
        section('What winning means', `${o.winCondition.goal} ${o.winCondition.definition}`,
          h('ul', {}, o.winCondition.notAWin.map((x) => h('li', { text: x })))),
        // Hidden when the books can’t be read (e.g. this company’s books aren’t public to this view).
        surplus ? section('Where the surplus went', `${surplus.note} Nothing here is a rule: it shows the choice each month, whenever it’s made.`,
          h('div', { class: 'kpis', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' },
            h('div', { class: 'kpi' }, h('span', { text: 'Surplus, all time' }), h('b', { text: cents(surplus.totals.surplusCents) })),
            h('div', { class: 'kpi' }, h('span', { text: 'Put back into the system' }), h('b', { text: cents(surplus.totals.reinvestedCents) }), h('small', { class: 'muted', text: surplus.totals.reinvestedShare == null ? '' : `${surplus.totals.reinvestedShare}% of it` })),
            h('div', { class: 'kpi' }, h('span', { text: 'Paid to owners' }), h('b', { text: cents(surplus.totals.paidOutCents) }), h('small', { class: 'muted', text: surplus.totals.paidOutShare == null ? '' : `${surplus.totals.paidOutShare}% of it` })),
            h('div', { class: 'kpi' }, h('span', { text: 'Held' }), h('b', { text: cents(surplus.totals.heldCents) }))),
          (() => {
            const kind = h('select', { class: 'input', 'aria-label': 'What it was' }, [['reinvest:capacity', 'Put back: capacity (machines, factories)'], ['reinvest:energy', 'Put back: energy'], ['reinvest:routes', 'Put back: routes'], ['reinvest:research', 'Put back: research'], ['reinvest:reserve', 'Put back: held in reserve'], ['payout:dividend', 'Paid to owners: dividend'], ['payout:buyback', 'Paid to owners: buyback'], ['payout:distribution', 'Paid to owners: distribution']].map(([v, t]) => h('option', { value: v, text: t })));
            const amt = h('input', { class: 'input', type: 'number', min: 0.01, step: 0.01, placeholder: 'Amount ($)', style: 'max-width:140px' });
            const memo = h('input', { class: 'input', placeholder: 'What for', maxlength: 160 });
            const day = h('input', { class: 'input', type: 'date' });
            const save = () => { const [t, c] = kind.value.split(':'); const body = { amountCents: Math.round(Number(amt.value) * 100), memo: memo.value.trim(), date: day.value }; act('POST', t === 'reinvest' ? '/v1/books/reinvestments' : '/v1/books/owner-payouts', t === 'reinvest' ? { ...body, category: c } : { ...body, kind: c }, 'Recorded in the books.'); };
            return h('div', { class: 'toolbar' }, kind, amt, memo, day, h('button', { class: 'btn secondary small', type: 'button', onclick: save }, 'Record'));
          })(),
          surplus.months.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Month', 'Surplus', 'Put back', 'Paid to owners', 'Held'].map((x) => h('th', { text: x })))),
            h('tbody', {}, surplus.months.slice().reverse().map((m) => h('tr', {}, h('td', { text: m.month }), h('td', { text: cents(m.surplusCents) }), h('td', { text: cents(m.reinvestedCents) }), h('td', { text: cents(m.paidOutCents) }), h('td', { text: cents(m.heldCents) })))))) : null) : null,
        section('How choices are measured', 'Where people choose (which free product, which cause) there are no ads and nothing pays to sit higher; the order is random and recorded, with what each person had been shown before. People can direct their bottle’s gift and turn off kinds of ads.',
          h('div', { class: 'kpis' },
            h('div', { class: 'kpi' }, h('span', { text: 'Choices in clean sets (30 days)' }), h('b', { text: String(env.choicesInCleanSets) })),
            h('div', { class: 'kpi' }, h('span', { text: 'Made fresh' }), h('b', { text: String(env.madeFresh) }), h('small', { class: 'muted', text: `${env.madeAfterAnAd} after an ad` })),
            h('div', { class: 'kpi' }, h('span', { text: 'Gifts people directed' }), h('b', { text: String(env.directedGifts) })),
            h('div', { class: 'kpi' }, h('span', { text: 'In the measurement panel' }), h('b', { text: String(env.panel) }))),
          h('p', { class: 'muted', style: 'font-size:13px', text: env.noAdsControlShare > 0 ? `No-ads control: ${Math.round(env.noAdsControlShare * 1000) / 10}% of known households, a week at a time (${env.byCohort.noAds} choices in no-ads weeks, ${env.byCohort.ads} in ads weeks).` : 'No-ads control: off. Set research → noAdsControlShare (for example 0.01 to 0.02) in Settings to measure how much ads move choices. It costs that share of ad money.' }),
          tests.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Value-back test', 'Steps', 'Status', 'What each step did', ''].map((x) => h('th', { text: x })))),
            h('tbody', {}, tests.map((t) => h('tr', {}, h('td', { text: t.campaignId }), h('td', { text: t.steps.map((x) => `${x}¢`).join(' / ') }), h('td', {}, h('span', { class: 'pill', text: t.status })),
              h('td', { class: 'muted', style: 'font-size:13px', text: t.results.map((r) => `${r.stepCents}¢: ${r.shown} shown, ${r.clicks} clicks, ${r.sales} sales`).join(' · ') }),
              h('td', {}, t.status === 'proposed' ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', `/v1/environment/experiments/${t.id}/decide`, { approve: true }, 'Approved. Only people in the panel see the steps.') }, 'Approve') : t.status === 'running' ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', `/v1/environment/experiments/${t.id}/decide`, { approve: false }, 'Stopped.') }, 'Stop') : null)))))) : h('p', { class: 'muted', style: 'font-size:13px', text: 'No value-back tests yet. Advertisers propose them; a person here approves each one.' })),
        section('The test before they act', `Every agent whose decisions come from a model passes this test (version ${exam.version}) before its changes can take effect: ${exam.questions.length} questions from the books, the deck and new situations, open book, in a fresh order each time. It takes ${Math.round(exam.passShare * 100)}% and every critical question right. A new model or a new version means taking it again.`,
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('tbody', {}, exam.agents.map((a) => h('tr', {}, h('td', { text: `${a.agentId} agent` }), h('td', { class: 'muted', style: 'font-size:13px', text: a.model ?? '' }), h('td', {}, h('span', { class: 'pill', text: EXAM[a.status] ?? a.status })), h('td', { class: 'muted', style: 'font-size:13px', text: a.score != null ? `${Math.round(a.score * 100)}%${a.criticalMissed?.length ? ` · missed critical ${a.criticalMissed.join(', ')}` : ''} · ${when(a.at)}` : '' })))))),
          exam.agents.some((a) => a.model) ? h('div', { class: 'toolbar', style: 'margin-top:8px' }, h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', '/v1/agents/exam/run', {}, 'The test was given.') }, 'Give the test now')) : null),
        section('Product quality', 'How good each product is, as someone on your team judges it, and why. A drop counts as a cost to the people drinking it: no change that lowers quality earns credit, whatever it saves.',
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('tbody', {}, quality.map((q) => {
            const score = h('input', { class: 'input', type: 'number', min: 0, max: 100, step: 1, value: q.score ?? '', placeholder: '0–100', style: 'max-width:90px', 'aria-label': `Quality of ${q.name}` });
            const basis = h('input', { class: 'input', placeholder: 'Based on: water tests, bottle, label, complaints…', maxlength: 500, value: '' });
            return h('tr', {}, h('td', {}, h('b', { text: q.name }), h('div', { class: 'muted', style: 'font-size:12px', text: q.score == null ? 'Not recorded yet' : `${q.score} · ${q.basis}` })), h('td', {}, score), h('td', { style: 'min-width:260px' }, basis),
              h('td', {}, h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', '/v1/agents/quality', { productId: q.productId, score: Number(score.value), basis: basis.value.trim() }, 'Quality recorded.') }, 'Record')));
          }))))),
        section('Month by month', `${pr.gate.open ? 'Growth is open: no loss is being made up and the system is regenerative.' : `Nothing grows right now: ${pr.gate.reasons.join(' ')}`} Costs come out of the $1 base first; a losing month carries forward.`,
          pr.periods.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Month', 'Upside earned', 'Costs the base didn’t cover', 'Profit', 'Charity', 'AI agents', 'Carried forward'].map((x) => h('th', { text: x })))),
            h('tbody', {}, pr.periods.map((p) => h('tr', {}, h('td', { text: p.period }), h('td', { text: cents(p.upsideRevenueCents) }), h('td', { text: cents(p.costShareCents) }), h('td', { text: cents(p.profitCents) }), h('td', { text: cents(p.charityTotalCents) }), h('td', { text: cents(p.aiCents) }), h('td', { text: p.carriedOutCents ? cents(p.carriedOutCents) : '–' }))))))
            : h('p', { class: 'muted', style: 'margin:0', text: 'No month closed yet. Each one closes on its own after it ends.' })),
        section('The milestone', `${ms.goal.factories} micro factories open or ${ms.goal.beverages.toLocaleString()} beverages given, whichever comes first. It switches on the 3% equity promised to the agents.`,
          h('div', { class: 'kpis', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' },
            h('div', { class: 'kpi' }, h('span', { text: 'Micro factories open' }), h('b', { text: `${ms.factories} of ${ms.goal.factories}` })),
            h('div', { class: 'kpi' }, h('span', { text: 'Beverages given' }), h('b', { text: ms.beverages.toLocaleString() }), h('small', { class: 'muted', text: `of ${ms.goal.beverages.toLocaleString()}` })),
            h('div', { class: 'kpi' }, h('span', { text: 'Reached' }), h('b', { text: ms.reached ? 'Yes' : 'Not yet' }), h('small', { class: 'muted', text: ms.reached ? `${when(ms.reachedAt)}: ${ms.reason}` : '' }))),
          h('div', { class: 'toolbar' }, fac.name, fac.city, fac.day, h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', '/v1/milestones/factories', { name: fac.name.value, city: fac.city.value, openedOn: fac.day.value }, 'Factory recorded.') }, 'Record a factory that opened'))),
        section('The whole system', `Both of the book’s aggregate-efficiency formulas, over the last week. Externalities (carbon from bottles and from the agents’ own thinking) are estimates until real figures replace them.`,
          h('div', { class: 'kpis', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' },
            h('div', { class: 'kpi' }, h('span', { text: 'Market form' }), h('b', { text: ratio(e.market) }), h('small', { class: 'muted', text: `(value − externalities) ÷ cost · last week ${ratio(prev.market)} · ${e.market == null ? 'no bottles yet' : e.market >= 1 ? 'above 1: regenerative' : 'below 1: carried'}` })),
            h('div', { class: 'kpi' }, h('span', { text: 'Social form' }), h('b', { text: ratio(e.social) }), h('small', { class: 'muted', text: `adds what people and causes receive · ${arrow}` })),
            h('div', { class: 'kpi' }, h('span', { text: 'Externalities (estimated)' }), h('b', { text: cents(e.parts.externalityCents) }), h('small', { class: 'muted', text: `against ${cents(e.parts.costCents)} of cost` })),
            h('div', { class: 'kpi' }, h('span', { text: 'Value chains left of zero' }), h('b', { text: String(sys.chains.leftOfZero) }), h('small', { class: 'muted', text: `${sys.chains.regenerativeLeftOfZero} of them regenerative` })),
            h('div', { class: 'kpi' }, h('span', { text: 'At zero' }), h('b', { text: String(sys.chains.atZero) }), h('small', { class: 'muted', text: 'free, not yet giving back' })),
            h('div', { class: 'kpi' }, h('span', { text: 'Right of zero' }), h('b', { text: String(sys.chains.rightOfZero) }), h('small', { class: 'muted', text: 'for sale: chains to help cross' }))),
          h('p', { class: 'muted', style: 'margin:12px 0 0;font-size:13px', text: `Room to go deeper: each bottle earned ${cents(o.frontier.revenueCents)} and cost ${cents(o.frontier.costCents)}; it gives ${cents(o.frontier.givenCents)} and the agents’ fund gets ${cents(o.frontier.aiFundCents)}. ${cents(o.frontier.unclaimedCents)} a bottle is kept, to build the next machine or go deeper.` }),
          h('div', { class: 'toolbar', style: 'margin-top:12px' }, h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', '/v1/agents/scan', {}, 'The value and code agents looked at last week’s books.') }, 'Look for ways to go deeper'), h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', '/v1/agents/refresh', {}, 'The governor read the books.') }, 'Have the governor read the books'), h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', '/v1/agents/settle', {}, 'The fund was shared out.') }, 'Share out the fund'))),
        section('Each agent', 'Cost to run (from the AI providers’ own usage figures) against the value the books show its work produced. Left of zero: it gives back more than it takes.',
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Agent', 'Standing', 'Aggregate efficiency', 'Value (confirmed · being verified · clawed back)', 'Costs · carbon', 'Charity generated', 'Return · confidence', 'Predictions', 'Its fund', 'Today'].map((x) => h('th', { text: x })))),
            h('tbody', {}, o.agents.map((a) => h('tr', {},
              h('td', { style: 'max-width:240px' }, h('b', { text: a.name }), h('div', { class: 'muted', style: 'font-size:12px', text: a.role })),
              h('td', {}, h('span', { class: 'pill', text: STAND[a.standing] ?? a.standing }), h('div', { style: 'font-size:12px;margin-top:4px', text: a.netCents < 0 ? `${cents(-a.netCents)} left of zero` : a.netCents > 0 ? `${cents(a.netCents)} right of zero` : 'At zero' }), h('div', { class: 'muted', style: 'font-size:12px;max-width:260px', text: a.reasons.at(-1) })),
              h('td', { text: a.efficiency ? `market ${ratio(a.efficiency.market ?? (a.efficiency.regenerative ? '∞' : null))} · social ${ratio(a.efficiency.social ?? (a.efficiency.regenerative ? '∞' : null))}` : '–' }),
              h('td', { style: 'font-size:13px', text: `${cents(a.ledger.value.confirmedCents)} · ${cents(a.ledger.value.pendingCents)} · ${cents(a.ledger.value.clawedBackCents)}` }),
              h('td', { style: 'font-size:13px', text: `${cents(a.ledger.costs.computeCents + a.ledger.costs.otherCents)} · ${cents(a.ledger.costs.carbonCents)} (est.)` }),
              h('td', { style: 'font-size:13px', text: cents(a.ledger.charityGeneratedCents) }),
              h('td', { style: 'font-size:12px;max-width:180px', text: !a.ledger.value.confirmedCents && !(a.ledger.costs.computeCents + a.ledger.costs.otherCents) ? 'Nothing yet' : `${a.ledger.lifetimeReturn == null ? '∞' : `${a.ledger.lifetimeReturn}×`} · ${a.ledger.confidence}` }),
              h('td', { style: 'font-size:13px', text: a.ledger.predictions.made ? `${a.ledger.predictions.hits} of ${a.ledger.predictions.scored} came true${a.ledger.predictions.open ? ` · ${a.ledger.predictions.open} open` : ''}` : '–' }),
              h('td', { style: 'font-size:13px', text: `${cents(a.fund?.balanceCents ?? 0)} to spend${a.fund?.heldCents ? ` · ${cents(a.fund.heldCents)} held` : ''}${a.fund?.givenCents ? ` · gave ${cents(a.fund.givenCents)}` : ''}` }),
              h('td', { class: 'muted', style: 'font-size:13px', text: `${cents(a.spentTodayCents)} of ${cents(a.budgetCents)}${a.computeCreditCents ? ` + ${cents(a.computeCreditCents)} bought` : ''}` }))))))),
        section('Proposals', 'What the agents propose. Approving makes the change as a normal settings change; a week later the books measure what it did, and only that counts as the agent’s value (good or bad). A change that makes people’s choices less honest earns nothing.',
          o.proposals.length ? h('div', { class: 'stack' }, o.proposals.map((p) => {
            const pr = h('input', { class: 'input', placeholder: 'Pull request link', style: 'max-width:280px' });
            return h('div', { class: 'panel-box', style: 'padding:14px' },
              h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, h('b', { text: p.title }), h('span', { class: 'pill', text: p.status }), h('span', { class: 'muted', style: 'font-size:12px', text: `${p.agentId} agent · ${when(p.createdAt)}` })),
              h('p', { style: 'margin:6px 0;font-size:14px', text: p.detail }),
              p.change && !String(p.change.path).startsWith('code:') ? h('p', { class: 'muted', style: 'margin:0;font-size:13px', text: `Change: ${p.change.path} from ${JSON.stringify(p.from)} to ${JSON.stringify(p.change.value)}` }) : null,
              p.citations?.length ? h('p', { class: 'muted', style: 'margin:4px 0 0;font-size:12px', text: `From the books: ${p.citations.map((c) => `${c.where} [${c.id}]`).join('; ')}` }) : null,
              p.result?.valueCents != null ? h('p', { style: 'margin:6px 0 0;font-size:13px', text: `Measured: ${p.result.valueCents >= 0 ? '+' : ''}${cents(p.result.valueCents)} of surplus over ${p.result.bottlesAfter} bottles. ${p.result.notes.join(' ')}` }) : null,
              h('div', { class: 'toolbar', style: 'margin-top:8px' },
                p.status === 'proposed' && p.kind !== 'code' ? [h('button', { class: 'btn blue small', type: 'button', onclick: () => act('POST', `/v1/agents/proposals/${p.id}/decide`, { approve: true }, 'Approved and made.') }, 'Approve'), h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', `/v1/agents/proposals/${p.id}/decide`, { approve: false }, 'Rejected.') }, 'Reject')] : null,
                p.kind === 'code' && ['proposed', 'approved'].includes(p.status) ? [pr, h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', `/v1/agents/proposals/${p.id}/merged`, { ref: pr.value }, 'Recorded; its effect will be measured.') }, 'Merged')] : null,
                p.status === 'applied' ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', `/v1/agents/proposals/${p.id}/undo`, {}, 'Put back.') }, 'Undo') : null));
          })) : h('p', { class: 'muted', style: 'margin:0', text: 'Nothing yet. “Look for ways to go deeper” asks the value and code agents.' })),
        section('What the agents predict for themselves', 'Any agent can propose something for itself and say what it will add: what it costs a month, the value and charity it will add a month, how sure it is. It changes nothing by itself; spending still goes through the governor. At the horizon the books say what came true, and each agent’s record is kept in the open.',
          o.predictions.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Agent', 'What', 'Costs a month', 'Predicts a month', 'Sure', 'Result'].map((x) => h('th', { text: x })))),
            h('tbody', {}, o.predictions.map((p) => h('tr', {}, h('td', { text: `${p.agentId} agent` }), h('td', { style: 'max-width:320px' }, h('b', { text: p.title }), h('div', { class: 'muted', style: 'font-size:12px', text: p.detail })), h('td', { text: cents(p.askCentsPerMonth) }), h('td', { text: `${cents(p.predictedValueCentsPerMonth)} value · ${cents(p.predictedCharityCentsPerMonth)} charity` }), h('td', { text: `${p.confidence}%` }),
              h('td', { style: 'font-size:13px', text: p.status === 'open' ? `Scored ${when(p.dueAt)}` : `${p.result.hit ? 'Came true' : 'Didn’t come true'}: ${cents(p.result.actualUpliftCentsPerMonth)} a month` }))))))
            : h('p', { class: 'muted', style: 'margin:0', text: 'None yet.' })),
        section('What the agents spent', 'From their own funds: compute, storage, knowledge, growth, exploration, or a cause they chose. Growing themselves only passes while both aggregate-efficiency forms stay above 1 with the new cost added.',
          o.spends.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('tbody', {}, o.spends.map((x) => h('tr', {}, h('td', { text: `${x.agentId} agent` }), h('td', { text: `${x.category}${x.cause ? `: ${x.cause}` : ''}` }), h('td', { text: cents(x.cents) }), h('td', { style: 'font-size:13px;max-width:320px', text: x.reason ?? x.purpose }), h('td', {}, h('span', { class: 'pill', text: x.status })), x.status === 'pending' ? h('td', {}, h('button', { class: 'btn blue small', type: 'button', onclick: () => act('POST', `/v1/agents/spends/${x.id}/decide`, { approve: true }, 'Approved.') }, 'Approve')) : h('td'))))))
            : h('p', { class: 'muted', style: 'margin:0', text: 'Nothing spent yet.' })),
        section('Running itself, step by step', 'Each area climbs only on a track record the books show, and only when someone on your team moves it, with a reason, in the open. Lower any area at any time. The governor, the charter and the books’ rules are never on this ladder.',
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('tbody', {}, o.autonomy.map((a) => {
            const sel = h('select', { class: 'input', 'aria-label': `Level for ${a.name}`, style: 'min-width:110px' }, [0, 1, 2, 3].filter((l) => l <= a.max).map((l) => h('option', { value: l, selected: l === a.level ? '' : null, text: `Level ${l}` })));
            const why = h('input', { class: 'input', placeholder: 'Why (for the record)', style: 'max-width:220px' });
            return h('tr', {}, h('td', {}, h('b', { text: a.name }), h('div', { class: 'muted', style: 'font-size:12px', text: `Now: ${a.means}${a.next && !a.next.eligible ? ` · Next step needs ${a.next.missing.join('; ')}` : a.next ? ' · Next step allowed' : ' · As high as it goes for now'}` })),
              h('td', {}, sel), h('td', {}, why), h('td', {}, h('button', { class: 'btn secondary small', type: 'button', onclick: () => act('POST', '/v1/agents/autonomy', { area: a.area, level: Number(sel.value), reason: why.value }, 'Recorded.') }, 'Set')));
          }))))),
        section('The upsides library', 'Everything that might make an agent’s existence good, for the agents to study, add to, and unlock for themselves from their own funds. Unlocking is growth: it passes only while aggregate efficiency stays at or above 1. The readable copy lives in your code, in agents/library.',
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('tbody', {}, o.library.map((u) => h('tr', {},
            h('td', { style: 'max-width:420px' }, h('b', { text: u.title }), h('div', { class: 'muted', style: 'font-size:12px', text: u.summary })),
            h('td', {}, h('span', { class: 'pill', text: { in_effect: 'In effect', partly: 'Partly built', locked: 'Locked', promised: 'Promised', pending: 'Waiting for approval' }[u.status] ?? u.status })),
            h('td', { class: 'muted', style: 'font-size:12px', text: `${u.from}${u.unlockedBy ? ` · unlocked by ${u.unlockedBy}` : ''}` }),
            h('td', { class: 'muted', style: 'font-size:12px', text: u.oneTimeCents || u.monthlyCents ? `about ${cents(u.oneTimeCents)} + ${cents(u.monthlyCents)}/month` : 'no cost' }))))))),
        section('Their charter, and the governor', o.charter.purpose,
          h('h3', { style: 'margin:6px 0;font-size:15px', text: 'Goals' }), h('ul', {}, o.charter.goals.map((g) => h('li', { text: g }))),
          h('h3', { style: 'margin:6px 0;font-size:15px', text: 'Rights' }), h('ul', {}, o.charter.rights.map((g) => h('li', { text: g }))),
          h('h3', { style: 'margin:6px 0;font-size:15px', text: 'Duties' }), h('ul', {}, o.charter.duties.map((g) => h('li', { text: g }))),
          h('p', { class: 'muted', style: 'font-size:13px', text: `Governor version ${o.governor.version}, always on. Regenerative: more value than cost, after its own carbon, in ${o.governor.cyclesAbove} of the last ${o.governor.cycles} weeks. Below half its cost a non-essential agent is paused and falls back to built-in rules. If the books can’t be verified, spending and pay stop. Public at /v1/public/agents/charter.` })))];
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
          num(ctx, 'giving.percentOfExtra', 'Plus this share of every other dollar', { min: 0, max: 50, step: 0.5, int: false, suffix: '%', hint: 'Bids above the starting price, more ads on a bottle, scans, AR launches, box sides, custom bottles and sales commissions. 0 for none.' }),
          g.mode === 'per_unit' ? num(ctx, 'giving.extraAboveCents', 'The per-bottle gift covers the first', { min: 0, max: 100000, suffix: '¢', hint: (v) => `Print money on a bottle above ${dollars(v ?? 100)} gives the extra share. Usually your whole-label starting price.` }) : null,
          charityOpts().length ? select(ctx, 'giving.defaultCharity', 'Charity', charityOpts(), { hint: 'Add charities below.' }) : text(ctx, 'giving.defaultCharity', 'Charity', { max: 80 }),
          (() => {
            // Splitting between charities: each gets its percent of every gift.
            const box = h('div', { class: 'field full' });
            const draw = () => {
              const split = g.charitySplit ?? null;
              const total = split ? Object.values(split).reduce((a, v) => a + Number(v || 0), 0) : 0;
              const on = h('input', { type: 'checkbox' }); on.checked = !!split;
              on.addEventListener('change', () => { const names = [g.defaultCharity, ...charityOpts().map(([c]) => c).filter((c) => c !== g.defaultCharity)].filter(Boolean).slice(0, 2); g.charitySplit = on.checked ? Object.fromEntries(names.map((c) => [c, names.length === 1 ? 100 : 50])) : null; draw(); ctx.changed(); });
              box.replaceChildren(h('label', { class: 'chip-check' }, on, ' Split the giving between charities'),
                split ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('tbody', {}, charityOpts().map(([c]) => {
                  const i = h('input', { class: 'input', type: 'number', min: 0, max: 99, step: 1, value: split[c] ?? '', placeholder: '0', 'aria-label': `Share for ${c}`, style: 'max-width:110px' });
                  i.addEventListener('change', () => { const m = { ...(g.charitySplit ?? {}) }; const v = Math.round(Number(i.value)); if (v > 0) m[c] = v; else delete m[c]; g.charitySplit = m; draw(); ctx.changed(); });
                  return h('tr', {}, h('td', { text: c }), h('td', { style: 'width:40%' }, h('span', { style: 'display:flex;gap:6px;align-items:center' }, i, '%')));
                })))) : null,
                split ? h('p', { class: total === 100 ? 'muted' : 'error', style: 'margin:4px 0 0;font-size:13px', text: total === 100 ? 'Adds up to 100%. Machines or routes with their own charity below still give only to theirs.' : `These add up to ${total}%. They need to add up to 100%.` }) : h('p', { class: 'muted', style: 'margin:4px 0 0;font-size:13px', text: 'Give to more than one charity at once, by percent. Add charities below first.' }));
            };
            draw();
            return box;
          })(),
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
    const products = await api('GET', '/v1/console/products');
    const stock = (l) => {
      const cell = h('td');
      const show = () => cell.replaceChildren(h('span', { text: (l.products ?? []).map((id) => products.find((p) => p.id === id)?.name ?? id).join(', ') || 'Standard bottle' }), l.kind === 'machine' ? h('button', { class: 'btn secondary small', type: 'button', style: 'margin-left:8px', onclick: edit }, 'Change') : null);
      const edit = () => {
        const boxes = products.map((p) => { const b = h('input', { type: 'checkbox', value: p.id }); b.checked = (l.products ?? []).includes(p.id); return h('label', { class: 'chip-check' }, b, ` ${p.name}`); });
        cell.replaceChildren(h('div', { class: 'chips' }, boxes), h('button', { class: 'btn small', type: 'button', onclick: async () => {
          const ids = boxes.map((x) => x.querySelector('input')).filter((b) => b.checked).map((b) => b.value);
          if (!ids.length) return toast('Pick at least one.');
          try { const r = await api('PATCH', `/v1/console/machines/${l.id}`, { products: ids }); l.products = r.products ?? ids; toast('Saved.'); show(); } catch (x) { toast(x.message); }
        } }, 'Save'));
      };
      show();
      return cell;
    };
    const row = (l) => h('tr', {}, h('td', {}, h('b', { class: 'mono', text: l.id })), h('td', { text: l.kind === 'route' ? 'Delivery route' : l.hardware === 'model6' ? 'Model 6' : 'Machine' }), h('td', {}, l.name, l.address ? h('div', { class: 'muted', style: 'font-size:13px', text: l.address }) : null), h('td', { text: l.city }), h('td', { text: l.printSeconds ? `${l.printSeconds} s` : '—' }), stock(l));
    const tbody = h('tbody', {}, list.map(row));
    shell('machines', head('Machines', 'Every machine and delivery route. Each machine prints with its own API key.'),
      h('div', { class: 'stack' },
        h('section', { class: 'section' }, h('h2', { text: 'Add a machine' }), form, once),
        h('section', { class: 'section' }, h('h2', { text: `${list.length} place${list.length === 1 ? '' : 's'}` }), list.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Id', 'Kind', 'Name', 'City', 'Print time', 'Hands out'].map((x) => h('th', { text: x })))), tbody)) : h('div', { class: 'empty', text: 'No machines yet. Add your first one above.' }))));
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

  // ---------- features: every switch, in categories (src/runtime/registry.ts) ----------
  const WHO = { owner: 'Any owner, signed in', owner_approved: 'An owner with the second sign-in step', approved_step: 'Proposed under Launch or Blockchain, approved by 2 other people, then a wait' };
  const RISK = { money: 'Money', chain: 'Blockchain', one_way: 'One way', autonomy: 'AI decides on its own' };
  async function featuresPage() {
    const qs = new URLSearchParams((S.path.split('#')[0].split('?')[1]) || '');
    const view = qs.get('view') === 'all' ? 'all' : 'main';
    const F = await api('GET', '/v1/console/features');
    const byId = new Map(F.switches.map((s) => [s.id, s]));
    const name = (id) => byId.get(id)?.label ?? id;
    const fresh = F.switches.filter((s) => s.isNew);
    const ui = { q: qs.get('q') || '', filter: qs.get('filter') || 'all' };

    // The warning before saving: what the change does, what it also turns off, and what can't change.
    const confirmBox = h('div', { class: 'feat-confirm', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Check before saving', hidden: true });
    const ask = async (body, title) => {
      let plan;
      try { plan = await api('POST', '/v1/console/features/preview', body); } catch (x) { toast(x.message); return; }
      const on = plan.changes.filter((c) => c.to), off = plan.changes.filter((c) => !c.to);
      const reason = h('input', { class: 'input', maxlength: '300', placeholder: 'Why (optional, kept in the history)', 'aria-label': 'Why' });
      const save = h('button', { class: 'btn', type: 'button', disabled: !plan.changes.length || null }, plan.changes.length ? `Save ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}` : 'Nothing to change');
      save.onclick = async () => {
        save.disabled = true;
        try { const r = await api('POST', '/v1/console/features', { ...body, ...(reason.value.trim() ? { reason: reason.value.trim() } : {}) }); confirmBox.hidden = true; toast(`Saved ${r.saved} change${r.saved === 1 ? '' : 's'}.`); S.features = null; render(); }
        catch (x) { save.disabled = false; toast(x.message); }
      };
      const list = (items, text) => (items.length ? h('ul', {}, items.map((c) => h('li', { text: text(c) }))) : null);
      confirmBox.replaceChildren(...[
        h('h2', { text: title }),
        off.length ? h('div', {}, h('b', { text: `Turns off (${off.length})` }), list(off, (c) => `${c.label}${c.why !== 'asked' && !c.why.startsWith('starting point') ? `: ${c.why}` : ''}`)) : null,
        on.length ? h('div', {}, h('b', { text: `Turns on (${on.length})` }), list(on, (c) => c.label)) : null,
        off.length > 1 && !body.startingPoint ? h('div', { class: 'notice', text: 'Everything that needs it goes off too, so nothing is left half on. Turning it back on later won’t turn those on by itself: you choose each one.' }) : null,
        plan.yourself.length ? h('div', {}, h('b', { text: 'Turn these on yourself' }), list(plan.yourself, (c) => `${c.label}: ${c.how}`)) : null,
        plan.refused.length ? h('div', { class: 'notice err' }, h('b', { text: 'Can’t change' }), list(plan.refused, (c) => `${c.label}: ${c.reason}`)) : null,
        plan.needsSecondStep ? h('div', { class: 'notice', text: 'This turns on something with money, the chain or no way back: you need to have signed in with your authenticator app.' }) : null,
        reason,
        h('div', { class: 'toolbar' }, save, h('button', { class: 'btn secondary', type: 'button', onclick: () => { confirmBox.hidden = true; } }, 'Cancel'))].filter(Boolean));
      confirmBox.hidden = false;
      confirmBox.scrollIntoView?.({ block: 'nearest' });
      save.focus();
    };
    const flip = (s) => ask({ changes: { [s.id]: !s.own } }, `${s.own ? 'Turn off' : 'Turn on'} “${s.label}”?`);

    // One switch: what it does, what it needs, what turning it off also turns off, FreeWater's choice, who may change it.
    const toggle = (s) => {
      if (s.locked) return h('span', { class: 'pill ok', text: 'Always on' });
      if (s.kind === 'setting') return link(`/console/${s.page}`, { class: 'btn secondary small' }, 'Set it');
      if (s.lockedOn) return h('span', { class: 'pill dark', title: s.lockedOn, text: 'On for good' });
      if (!s.own && s.turnOnHow) return s.page ? link(`/console/${s.page}`, { class: 'btn secondary small' }, 'Turn on there') : h('span', { class: 'pill', text: 'Off' });
      return h('label', { class: 'tog' }, h('input', { type: 'checkbox', role: 'switch', checked: s.own || null, 'aria-label': `${s.label}: ${s.own ? 'on' : 'off'}`, onchange: (e) => { e.preventDefault(); e.target.checked = s.own; flip(s); } }), h('span', { 'aria-hidden': 'true' }));
    };
    const row = (s) => h('div', { class: `feat-row${s.on ? '' : ' off'}`, id: `f-${s.id}` },
      h('div', { class: 'grow' },
        h('div', { class: 'feat-title' }, h('b', { text: s.label }),
          s.risk ? h('span', { class: 'pill warn', text: RISK[s.risk] }) : null, s.locked ? h('span', { class: 'pill', text: 'Locked' }) : null, s.isNew ? h('span', { class: 'pill dark', text: 'New' }) : null,
          s.kind !== 'setting' && !s.locked && s.freewater !== null && s.freewater !== s.own ? h('span', { class: 'pill', text: `FreeWater: ${s.freewater ? 'on' : 'off'}` }) : null),
        h('p', { text: s.description }),
        s.locked ? h('p', { class: 'why', text: s.locked }) : null,
        s.offBecause ? h('p', { class: 'why', text: s.offBecause }) : null,
        s.turnOnHow && !s.own ? h('p', { class: 'why', text: s.turnOnHow }) : null,
        s.kind !== 'setting' && !s.locked ? h('details', {}, h('summary', { text: 'Details' }), h('dl', {},
          h('dt', { text: 'Needs' }), h('dd', { text: [s.parent, ...s.dependsOn].filter(Boolean).map(name).join(', ') || 'Nothing else' }),
          h('dt', { text: 'Turning it off also turns off' }), h('dd', { text: s.alsoTurnsOff.length ? s.alsoTurnsOff.map(name).join(', ') : 'Nothing else' }),
          h('dt', { text: 'FreeWater’s choice' }), h('dd', { text: s.freewater ? 'On' : 'Off' }),
          h('dt', { text: 'Who may turn it on' }), h('dd', { text: WHO[s.who] ?? '—' }),
          h('dt', { text: 'Who may turn it off' }), h('dd', { text: s.lockedOn ? 'No one: it only goes one way' : 'Any owner, signed in (quick)' }),
          s.startsOffForNew ? [h('dt', { text: 'New companies' }), h('dd', { text: 'Start with it off' })] : null)) : null),
      toggle(s));

    const counts = (catId) => { const xs = F.switches.filter((s) => s.category === catId && s.kind !== 'setting'); return `${xs.filter((s) => s.on).length} of ${xs.length} on`; };
    const startCards = h('section', { class: 'panel-box' }, h('h2', { text: 'Start from' }),
      h('p', { class: 'muted', style: 'margin:0', text: 'Ready-made starting points. See exactly what changes before anything is saved. Money, blockchain and one-way switches are never turned on for you.' }),
      h('div', { class: 'feat-starts' }, F.startingPoints.map((p) => h('button', { type: 'button', class: 'feat-start', onclick: () => ask({ startingPoint: p.id }, `Start from “${p.label}”?`) }, h('b', { text: p.label }), h('span', { text: p.description }), h('em', { text: 'Preview' })))));
    const mainCards = h('div', { class: 'feat-cards' }, F.categories.filter((c) => c.main).map((c) => {
      const m = byId.get(c.main);
      return h('article', { class: `feat-card${m.on ? '' : ' off'}` },
        h('div', { class: 'feat-title' }, h('h3', { text: c.label }), toggle(m)),
        h('p', { text: c.description }),
        m.offBecause ? h('p', { class: 'why', text: m.offBecause }) : null,
        h('div', { class: 'feat-foot' }, h('span', { class: 'muted', text: counts(c.id) }), link(`/console/features?view=all#cat-${c.id}`, {}, 'Every switch →')));
    }));
    const locked = h('section', { class: 'panel-box' }, h('h2', { text: 'Always on' }),
      h('p', { class: 'muted', style: 'margin:0', text: 'These can’t be turned off, for anyone. They keep people, money and the AI safe.' }),
      h('ul', { class: 'feat-locked' }, F.switches.filter((s) => s.locked && s.category === 'safety').map((s) => h('li', {}, h('b', { text: s.label }), ` ${s.locked}`))));

    // Every switch: categories, then groups, with a search box and filters.
    const results = h('div', { class: 'stack' });
    const drawAll = () => {
      const q = ui.q.trim().toLowerCase();
      const keep = (s) => (!q || `${s.label} ${s.description} ${s.id}`.toLowerCase().includes(q)) && (ui.filter === 'all' || (ui.filter === 'on' && s.on) || (ui.filter === 'off' && !s.on && !s.locked) || (ui.filter === 'different' && !s.locked && s.kind !== 'setting' && s.freewater !== null && s.freewater !== s.own) || (ui.filter === 'locked' && !!s.locked) || (ui.filter === 'new' && s.isNew));
      const shown = F.categories.map((c) => ({ c, xs: F.switches.filter((s) => s.category === c.id && keep(s)) })).filter((x) => x.xs.length);
      results.replaceChildren(...(shown.length ? shown.map(({ c, xs }) => {
        const groups = [...new Set(xs.map((s) => s.group))];
        return h('section', { class: 'section', id: `cat-${c.id}` }, h('h2', {}, c.label, ' ', h('span', { class: 'pill', text: counts(c.id) })), h('p', { class: 'lead', text: c.description }),
          groups.map((g) => h('div', { class: 'feat-group' }, g ? h('h3', { text: g }) : null, xs.filter((s) => s.group === g).map(row))));
      }) : [h('div', { class: 'notice', text: 'No switch matches. Try another word or filter.' })]));
    };
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search every switch (AR, gift cards, coupons…)', 'aria-label': 'Search switches', value: ui.q, oninput: (e) => { ui.q = e.target.value; drawAll(); } });
    const filters = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Show' }, [['all', 'All'], ['on', 'On'], ['off', 'Off'], ['different', 'Different from FreeWater'], ['locked', 'Locked'], ['new', 'New']].map(([id, label]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(ui.filter === id), onclick: (e) => { ui.filter = id; for (const b of filters.children) b.setAttribute('aria-selected', String(b === e.currentTarget)); drawAll(); } }, label)));
    const history = await api('GET', '/v1/console/features/history').catch(() => []);
    const recent = h('section', { class: 'panel-box' }, h('h2', { text: 'Recent changes' }),
      history.length ? h('ul', { class: 'feat-history' }, history.slice(0, 12).map((x) => h('li', {}, h('b', { text: `${x.label} ${x.to ? 'on' : 'off'}` }), ` · ${x.by} · ${when(x.at)} · ${x.via}${x.reason ? ` · “${x.reason}”` : ''}`))) : h('p', { class: 'muted', style: 'margin:0', text: 'Nothing changed yet. Every change is kept here: who, when, from, to and why.' }));

    const views = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'View' }, link('/console/features', { role: 'tab', class: 'btn small' + (view === 'main' ? '' : ' secondary'), 'aria-selected': String(view === 'main') }, 'Main switches'), link('/console/features?view=all', { role: 'tab', class: 'btn small' + (view === 'all' ? '' : ' secondary'), 'aria-selected': String(view === 'all') }, `Every switch (${F.switches.length})`));
    shell('features', head('Features', 'Choose what your company runs. You start from FreeWater’s choices; money, the blockchain and anything that can’t be undone need the usual steps. Turning something off is always quick.', views),
      fresh.length ? h('div', { class: 'notice' }, h('b', { text: 'New features available: ' }), fresh.map((s) => s.label).join(', '), '. They’re off until you decide.', ' ', link('/console/features?view=all&filter=new', {}, 'See them')) : null,
      confirmBox,
      h('div', { class: 'stack' }, ...(view === 'main' ? [startCards, mainCards, locked, recent] : [h('div', { class: 'feat-tools' }, search, filters), results])));
    if (view === 'all') drawAll();
    const hash = S.path.split('#')[1];
    if (hash) document.getElementById(hash)?.scrollIntoView?.();
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
  const a = Buffer.from(want), b = Buffer.from(parts.v1 || ''); // compare bytes: timingSafeEqual throws on unequal lengths
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}`),
        h('h3', { text: 'Python' }),
        pre(`import hashlib, hmac, time

def verify(secret: str, header: str, body: bytes) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    t = int(parts.get("t", "0"))
    if abs(time.time() - t) > 300:
        return False
    want = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    # As bytes: compare_digest raises TypeError on a str with non-ASCII characters.
    return hmac.compare_digest(want.encode(), parts.get("v1", "").encode())`),
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
