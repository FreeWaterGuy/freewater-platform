// The FreeWater ops console: today at a glance, the ad review queue, machines, tonight's routes,
// deliveries, and the books. For the company's own team (owners, ops, reviewers, finance).
(() => {
  'use strict';
  const fixture = window.__FW_OPS_FIXTURE__;
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
  /** "1 bottle", "2 bottles": a count with its noun, singular for exactly one. */
  const plural = (n, one, many) => `${n} ${String(n).replace(/[^0-9.-]/g, '') === '1' ? one : many}`;
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (d) => { const s = document.createElementNS(NS, 'svg'); for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v); for (const p of d.split('|')) { const e = document.createElementNS(NS, 'path'); e.setAttribute('d', p); s.append(e); } return s; };
  const I = { today: 'M3 12h4l3-8 4 16 3-8h4', review: 'M4 4h16v16H4z|M8 12l3 3 5-6', machine: 'M6 3h12v18H6z|M9 7h6|M10 17h4', route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z|M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z|M6 15V9a4 4 0 0 1 4-4h6|M18 9v6a4 4 0 0 1-4 4H8', people: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z|M2 21a7 7 0 0 1 14 0|M17 3a4 4 0 0 1 0 8|M22 21a7 7 0 0 0-5-6.7', books: 'M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z|M8 8h8|M8 12h8' };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
  const dollars = (c) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const svgSrc = (s) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
  const toastEl = h('div', { class: 'toast', role: 'status' }); document.body.append(toastEl);
  let tt; const toast = (m) => { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove('show'), 2600); };
  const S = { token: fixture?.token ?? store.get('fw_ops_token'), me: null, config: null, path: fixture ? fixture.start : location.pathname + location.search };
  /** Plain words for the server's codes, and times in the company's time zone (src/web/words.js). */
  const W = window.fwWords;

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
    if (res.status === 401) { S.token = null; S.me = null; store.set('fw_ops_token', null); }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || 'Something went wrong.');
    return data;
  }
  const routes = [[/^\/ops\/?$/, today, 'today'], [/^\/ops\/review$/, reviewPage, 'review'], [/^\/ops\/review\/links$/, linkChangesPage, 'review'], [/^\/ops\/review\/fillers$/, fillersPage, 'review'], [/^\/ops\/bottles$/, bottlesPage, 'bottles'], [/^\/ops\/machines$/, machinesPage, 'machines'], [/^\/ops\/machines\/([\w-]+)$/, machinePage, 'machines'], [/^\/ops\/routes$/, routesPage, 'routes'], [/^\/ops\/subscriptions$/, subsPage, 'subs'], [/^\/ops\/areas$/, areasPage, 'areas'], [/^\/ops\/areas\/([\w-]+)$/, areaPage, 'areas'], [/^\/ops\/books$/, booksPage, 'books']];
  // The scopes each page's main call needs (from its route in src/api). 'admin' passes them all.
  const PAGE_SCOPES = { today: ['packs', 'events', 'ledger', 'campaigns'], review: ['campaigns'], machines: ['orders', 'packs', 'events'], routes: ['packs'], subs: ['packs'], areas: ['packs'], books: ['ledger'], bottles: ['orders'] };
  // The switch each page belongs to (src/runtime/registry.ts): a page whose switch is off, on this server or for this
  // company (its Features page), isn't shown or opened.
  const PAGE_FEATURES = { review: 'ads', machines: 'machines', routes: 'delivery', subs: 'delivery', areas: 'delivery_areas' };
  const on = (page) => !PAGE_FEATURES[page] || !(S.features?.off ?? []).includes(PAGE_FEATURES[page]);
  const can = (page) => { if (!on(page)) return false; if (page === 'review' && typeof S.me?.reviewsAds === 'boolean') return S.me.reviewsAds; const sc = S.me?.scopes; if (!Array.isArray(sc)) return true; return sc.includes('admin') || (PAGE_SCOPES[page] ?? []).some((x) => sc.includes(x)); };
  let cleanup = null;
  function go(path, replace) { S.path = path; if (!fixture) history[replace ? 'replaceState' : 'pushState'](null, '', path); render(); }
  window.addEventListener('popstate', () => { S.path = location.pathname + location.search; render(); });
  const link = (path, attrs, ...kids) => h('a', { href: fixture ? '#' : path, ...attrs, onclick: (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(path); } }, ...kids);
  async function render() {
    if (cleanup) { cleanup(); cleanup = null; }
    if (!S.config) S.config = await api('GET', '/v1/public/app-config');
    // Areas switched off on this server (FW_FEATURES): pages that belong to one aren't shown or opened.
    if (S.token && !S.me) { try { S.me = await api('GET', '/v1/me'); } catch { S.me = null; } }
    // The signed-in company is the one shown, its name and brand too, whatever address ops was opened at.
    if (S.me?.companyId && S.me.companyId !== S.config.companyId) S.config = await api('GET', `/v1/public/app-config?company=${encodeURIComponent(S.me.companyId)}`).catch(() => S.config);
    W.setZone(S.config.timezone); // times on every page in the company's time zone
    // The switches of the company of the person signed in (a licensee's team sees its own, not the host's).
    if (!S.features) S.features = await api('GET', `/v1/public/features?company=${encodeURIComponent(S.me?.companyId ?? S.config.companyId)}`).catch(() => ({ off: [] }));
    if (!S.me) return signIn();
    if (S.me.advertiserId || S.me.role === 'consumer') return shell('', h('div', { class: 'notice err', text: 'This console is for the company’s team. Ask an owner to add you.' }));
    const pathname = S.path.split('?')[0];
    for (const [re, fn, pg] of routes) { const mm = re.exec(pathname); if (mm) { if (!can(pg)) { shell('', head('Not available for your role', 'Your role can’t use this page. Ask an owner if you need it.')); window.scrollTo(0, 0); return; } try { await fn(...mm.slice(1)); } catch (e) { shell('', h('div', { class: 'notice err', text: e.message })); } window.scrollTo(0, 0); return; } }
    go('/ops', true);
  }
  function shell(active, ...content) {
    const nav = [['today', '/ops', 'Today', I.today], ['review', '/ops/review', 'Review', I.review], ['bottles', '/ops/bottles', 'Find a bottle', I.bottle], ['machines', '/ops/machines', 'Machines', I.machine], ['routes', '/ops/routes', 'Routes', I.route], ['areas', '/ops/areas', 'Areas', I.route], ['subs', '/ops/subscriptions', 'Deliveries', I.people], ['books', '/ops/books', 'Books', I.books]];
    root.replaceChildren(h('div', { class: 'shell' },
      h('aside', { class: 'side' }, h('div', { class: 'logo', 'aria-label': `${S.config?.name ?? ''} Ops` }, h('span', { text: S.config?.brand?.logoTop ?? '' }), h('span', { text: S.config?.brand?.logoBottom ?? '', style: S.config?.brand?.accentColor ? `color:${S.config.brand.accentColor}` : null }), h('small', { text: 'Ops' })),
        h('nav', { 'aria-label': 'Main' }, nav.filter(([id]) => can(id)).map(([id, path, label, ic]) => link(path, { 'aria-current': active === id ? 'page' : null }, icon(ic), label))),
        h('div', { class: 'who' }, h('b', { text: S.me.displayName || S.me.email || '' }), S.me.role, h('br'), h('button', { type: 'button', onclick: async () => { try { await api('POST', '/v1/auth/sign-out'); } catch {} S.token = null; S.me = null; store.set('fw_ops_token', null); render(); } }, 'Sign out'))),
      h('main', { class: 'main' }, ...content)));
  }
  const head = (title, sub, ...right) => h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: title }), sub ? h('p', { text: sub }) : null), right.length ? h('div', { class: 'toolbar' }, right) : null);

  function signIn() {
    let to = '';
    const right = h('div', { class: 'right' });
    root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'left' }, h('div', { class: 'logo' }, h('span', { text: S.config?.brand?.logoTop ?? '' }), h('span', { text: S.config?.brand?.logoBottom ?? '' }), h('small', { text: 'Ops' })), h('h1', {}, 'Run the ', h('span', { text: 'whole thing' }), ' from here.'), h('p', { style: 'opacity:.6;margin:0', text: 'Machines, ads, routes, deliveries and the books.' })), right));
    const step1 = () => { const input = h('input', { class: 'input', id: 'o-email', type: 'email', autocomplete: 'email', placeholder: 'you@work.com' }); right.replaceChildren(h('h2', { style: 'font:700 26px/1.2 var(--display);margin:0', text: 'Team sign in' }), h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); to = input.value.trim(); try { await api('POST', '/v1/auth/start', { companyId: S.config.companyId, channel: 'email', to }); step2(); } catch (x) { toast(x.message); } } }, h('div', { class: 'field' }, h('label', { for: 'o-email', text: 'Work email' }), input), h('button', { class: 'btn wide', type: 'submit' }, 'Email me a code'))); input.focus(); };
    const step2 = () => { const input = h('input', { class: 'input code-input', id: 'o-code', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', 'aria-label': '6-digit code' }); right.replaceChildren(h('h2', { style: 'font:700 26px/1.2 var(--display);margin:0', text: 'Check your email' }), h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); try { const r = await withSecondStep(await api('POST', '/v1/auth/verify', { companyId: S.config.companyId, channel: 'email', to, code: input.value.trim() })); S.token = r.token; store.set('fw_ops_token', r.token); S.me = null; render(); } catch (x) { toast(x.message); } } }, input, h('button', { class: 'btn wide', type: 'submit' }, 'Sign in'))); input.focus(); };
    step1();
  }

  // ---------- today ----------
  async function today() {
    // Panels and links for areas that are off (machines in the pilot, say) aren't shown, and their data isn't asked for;
    // links a role can't open aren't shown either.
    const [o, machines, fleet, notices, linkChanges] = await Promise.all([api('GET', '/v1/ops/overview'), on('machines') ? api('GET', '/v1/ops/machines').catch(() => []) : [], on('machines') ? api('GET', '/v1/ops/fleet').catch(() => []) : [], can('areas') ? api('GET', '/v1/ops/house-notices').catch(() => []) : [], can('review') ? api('GET', '/v1/review/link-changes').catch(() => []) : []]);
    const newNotices = notices.filter((n) => Date.now() - Date.parse(n.at) < 7 * 86_400_000);
    const a = o.attention;
    const hot = [
      ...fleet.filter((m) => m.hardware === 'model6' && (m.availability.state !== 'ready' || m.incidents.some((i) => i.severity === 'critical'))).map((m) => link(`/ops/machines/${m.id}`, { class: 'hot' }, h('span', { text: `${m.id}: ${m.incidents.find((i) => i.severity === 'critical')?.message ?? m.availability.message}` }), h('b', { text: 'Look →' }))),
      a.adsToReview && can('review') && link('/ops/review', { class: 'hot' }, h('span', { text: `${a.adsToReview} ${a.adsToReview === 1 ? 'ad is' : 'ads are'} waiting for review` }), h('b', { text: 'Review →' })),
      linkChanges.length && link('/ops/review/links', { class: 'hot' }, h('span', { text: `${plural(linkChanges.length, 'changed link is', 'changed links are')} waiting for approval` }), h('b', { text: 'Review →' })),
      newNotices.length && link('/ops/areas', { class: 'hot' }, h('span', { text: `${plural(newNotices.length, 'house claim', 'house claims')} to know about this week` }), h('b', { text: 'Areas →' })),
      a.printFailures && (can('machines') ? link('/ops/machines', { class: 'hot' }, h('span', { text: `${a.printFailures} failed print${a.printFailures === 1 ? '' : 's'} today (never billed)` }), h('b', { text: 'Machines →' })) : h('div', { class: 'hot' }, h('span', { text: `${a.printFailures} failed print${a.printFailures === 1 ? '' : 's'} today (never billed)` }))),
      a.pluginFailures && h('div', { class: 'hot' }, h('span', { text: `${a.pluginFailures} scan page${a.pluginFailures === 1 ? '' : 's'} fell back to the simple card recently` })),
      o.delivery.wrongBoxScans && can('routes') && link('/ops/routes', { class: 'hot' }, h('span', { text: `${o.delivery.wrongBoxScans} wrong box${o.delivery.wrongBoxScans === 1 ? '' : 'es'} caught at the door today` }), h('b', { text: 'Routes →' })),
    ].filter(Boolean);
    shell('today', head('Today', new Date(`${o.date}T12:00:00Z`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })),
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi dark' }, h('span', { text: 'Bottles printed' }), h('b', { text: o.bottles.printed.toLocaleString() }), h('small', { text: `${o.bottles.inPacks} in packs · ${o.bottles.custom} custom` })),
        h('div', { class: 'kpi' }, h('span', { text: 'Scans' }), h('b', { text: o.engagement.scans.toLocaleString() }), h('small', { text: `${o.engagement.arLaunches} AR launches` })),
        h('div', { class: 'kpi' }, h('span', { text: 'Earned' }), h('b', { text: dollars(o.money.revenueCents) }), h('small', { text: 'from ads and custom bottles' })),
        h('div', { class: 'kpi' }, h('span', { text: 'Given' }), h('b', { text: dollars(o.money.donatedCents) }), h('small', { text: 'to charity' })),
        on('routes') ? h('div', { class: 'kpi' }, h('span', { text: 'Deliveries' }), h('b', { text: `${o.delivery.delivered}/${o.delivery.stops}` }), h('small', { text: `${o.delivery.routes} route${o.delivery.routes === 1 ? '' : 's'}${o.delivery.notDelivered ? ` · ${o.delivery.notDelivered} coming back` : ''}` })) : null),
      h('div', { class: on('machines') ? 'grid2' : '' },
        h('section', { class: 'panel-box' }, h('h2', { text: 'Needs attention' }), hot.length ? h('div', { class: 'attn' }, hot) : h('p', { style: 'margin:0;color:var(--muted)', text: 'Nothing right now.' })),
        on('machines') ? h('section', { class: 'panel-box' }, h('h2', {}, 'Machines', can('machines') ? link('/ops/machines', { style: 'font-size:14px;font-weight:500' }, 'All →') : null), machineTable(machines)) : null));
  }
  const statusPill = (s) => h('span', { class: `pill ${s === 'ok' ? 'ok' : s === 'attention' ? 'bad' : 'warn'}`, text: s === 'ok' ? 'Printing' : s === 'attention' ? 'Needs a look' : 'Quiet' });
  const machineTable = (machines) => h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Machine', 'Today', 'Failed', 'Last print', ''].map((x) => h('th', { text: x })))),
    h('tbody', {}, machines.map((m) => h('tr', {}, h('td', {}, h('b', { text: m.id }), h('div', { style: 'color:var(--muted);font-size:12px', text: m.name })), h('td', { text: String(m.printedToday) }), h('td', { text: String(m.failedPrintsToday) }), h('td', { text: m.lastPrintAt ? new Date(m.lastPrintAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—' }), h('td', {}, statusPill(m.status)))))));

  // ---------- ad review ----------
  async function reviewPage() {
    const queue = await api('GET', '/v1/review/campaigns');
    let current = queue[0]?.id ?? null;
    const list = h('div', { class: 'list' });
    const pane = h('div', { class: 'review-pane' });
    let frame = null, payload = null;
    const onMsg = (e) => { if ((fixture || e.origin === location.origin) && e.data?.type === 'fw-preview-ready' && frame && payload) frame.contentWindow.postMessage({ type: 'fw-preview', ...(payload.scan ?? { doc: null }) }, fixture ? '*' : location.origin); };
    window.addEventListener('message', onMsg); cleanup = () => window.removeEventListener('message', onMsg);
    const tag = (c) => (c.review?.auditPending ? 'audit of the AI’s rejection · ' : c.review?.appealedAt ? 'appealed · ' : c.review?.status === 'flagged' ? 'flagged · ' : '');
    const drawList = () => list.replaceChildren(...queue.map((c) => h('button', { type: 'button', 'aria-current': String(c.id === current), onclick: () => { current = c.id; drawList(); show(); } }, h('b', { text: c.advertiser }), h('span', { text: `${tag(c)}${c.name ?? c.category} · sent ${new Date(c.submittedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` }))));
    async function show() {
      if (!current) { pane.replaceChildren(h('div', { class: 'empty', text: 'No ads waiting. New ones show up here as soon as an advertiser submits them.' })); return; }
      pane.replaceChildren(h('p', { class: 'caption', text: 'Loading…' }));
      payload = await api('GET', `/v1/review/campaigns/${current}/preview`);
      const c = payload.campaign;
      const item = queue.find((q) => q.id === c.id) ?? {};
      // A paid ad (paid up front): an automated check can only flag it; the team talks it over with the advertiser in
      // the notes, and only a person finally rejects it, with a reason (that's when its refund is offered).
      const paid = !!item.paid, flagged = item.review?.status === 'flagged';
      const audit = !!item.review?.auditPending, appealed = !!item.review?.appealedAt;
      const notes = paid ? await api('GET', `/v1/review/campaigns/${c.id}/notes`).catch(() => []) : [];
      const ai = paid ? await api('GET', `/v1/review/campaigns/${c.id}/ai`).catch(() => null) : null;
      const note = h('textarea', { class: 'input', id: 'r-note', placeholder: paid ? 'Why? Plain words: the advertiser sees this word for word, and it’s kept.' : 'What needs to change? The advertiser sees this word for word.' });
      const say = h('textarea', { class: 'input', id: 'r-say', placeholder: 'Write to the advertiser…' });
      const thread = h('div', { class: 'panel-box' }, h('b', { text: flagged ? 'Being discussed with the advertiser' : 'Notes with the advertiser' }),
        notes.length ? h('ul', { style: 'margin:0;padding-left:18px;line-height:1.6' }, notes.map((n) => h('li', {}, h('b', { text: `${n.from === 'team' ? 'Team' : n.from === 'advertiser' ? c.advertiser : n.from === 'AI reviewer' ? 'AI reviewer' : 'Automated check'}${n.kind === 'flag' ? ' flagged' : n.kind === 'resubmitted' ? ' sent a change' : n.kind === 'appeal' ? ' appealed to a person' : n.kind === 'rejected' && n.from === 'AI reviewer' ? ' rejected (its final call)' : ''}: ` }), n.text, h('span', { style: 'color:var(--muted)', text: ` · ${new Date(n.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` })))) : h('p', { style: 'margin:0;color:var(--muted)', text: 'No notes yet.' }),
        h('div', { class: 'field' }, h('label', { for: 'r-say', text: 'Write to the advertiser' }), say),
        h('div', {}, h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { if (!say.value.trim()) return; try { await api('POST', `/v1/review/campaigns/${c.id}/notes`, { text: say.value.trim() }); toast('Sent.'); await show(); } catch (x) { toast(x.message); } } }, 'Send note')));
      // The AI reviewer: what it said about this ad, and your team's talk with it. Kept with the ad, apart from the
      // notes with the advertiser (who never sees it). It can explain and change its view; it can't decide anything.
      const ask = h('textarea', { class: 'input', id: 'r-ask', maxlength: '2000', placeholder: 'Ask the AI why, or push back…' });
      const latest = ai?.verdicts?.filter((v) => !v.superseded).at(-1) ?? null;
      const said = (v) => (v.verdict === 'pass' ? 'It passed this ad.' : `${v.final ? 'It rejected this ad on its own (your company lets it make the final call)' : 'It flagged this ad'}: ${v.reasons}`);
      const aiBox = ai && (ai.verdicts.length || ai.thread.length) ? h('div', { class: 'panel-box', style: 'border-left:3px solid var(--blue, #1E7DB8)' },
        h('b', { text: 'The AI reviewer (only your team sees this)' }),
        h('p', { style: 'margin:4px 0;color:var(--muted);font-size:13px', text: ai.looksAt || 'It read the ad’s words and links, not its pictures: check the artwork yourself.' }),
        latest ? h('p', { style: 'margin:4px 0', text: `${said(latest)}${latest.changedView ? ` After talking it over, it now says it would ${latest.changedView === 'pass' ? 'pass' : 'flag'} it.` : ''}` }) : null,
        ai.thread.length ? h('ul', { style: 'margin:0;padding-left:18px;line-height:1.6' }, ai.thread.map((m) => h('li', {}, h('b', { text: m.from === 'team' ? 'Team: ' : `AI${m.by === 'stand-in (no AI)' ? ' (stand-in)' : ''}${m.changedView ? `, now ${m.changedView === 'pass' ? 'passing' : 'flagging'} it` : ''}: ` }), m.text))) : null,
        h('div', { class: 'field' }, h('label', { for: 'r-ask', text: 'Ask the AI' }), ask),
        h('div', {}, h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { if (!ask.value.trim()) return; try { await api('POST', `/v1/review/campaigns/${c.id}/ai`, { text: ask.value.trim() }); await show(); } catch (x) { toast(x.message); } } }, 'Ask')),
        h('p', { style: 'margin:0;color:var(--muted);font-size:13px', text: 'It explains, and may change its view; it can’t approve, reject or pay anything back. What it said first stays in its record against your decision.' })) : null;
      const decide = async (decision) => {
        if ((decision === 'reject' || decision === 'flag') && !note.value.trim()) { toast(decision === 'flag' ? 'Say what the concern is.' : paid ? 'Write why it’s rejected.' : 'Say what needs to change.'); note.focus(); return; }
        if (decision === 'reject' && paid && !window.confirm(`Reject ${c.advertiser}’s paid ad for good? Its refund is then offered for approval.`)) return;
        try {
          const out = await api('POST', `/v1/review/campaigns/${c.id}`, { decision, ...(note.value.trim() ? { note: note.value.trim() } : {}) });
          toast(decision === 'approve' ? `Approved. ${c.advertiser} is printing.` : out.review?.status === 'flagged' ? 'Flagged: talk it over with the advertiser in the notes.' : paid ? 'Rejected. Its refund can now be approved (Books).' : 'Sent back with your note.');
          if (out.review?.status === 'flagged') { item.review = out.review; return show(); }
          queue.splice(queue.findIndex((q) => q.id === c.id), 1); current = queue[0]?.id ?? null; drawList(); show();
        } catch (x) {
          // Someone else may have decided it already, or it changed: show why and reload the queue.
          toast(x.message);
          try { const fresh = await api('GET', '/v1/review/campaigns'); queue.splice(0, queue.length, ...fresh); if (!queue.some((q) => q.id === current)) current = queue[0]?.id ?? null; drawList(); await show(); } catch {}
        }
      };
      frame = fixture?.scanFrame ? fixture.scanFrame() : h('iframe', { src: '/preview/scan', title: 'Scan page' });
      const buy = c.buy.type === 'guaranteed' ? `${plural(c.buy.remainingPrints.toLocaleString(), 'bottle', 'bottles')}` : `${dollars(c.buy.dailyCapCents)} a day`;
      pane.replaceChildren(
        h('div', { class: 'run-head' }, h('div', {}, h('h2', { style: 'margin:0;font-size:20px', text: c.name ?? c.advertiser }), h('div', { style: 'color:var(--muted)', text: `${c.advertiser} · ${c.category} · ${c.where === 'all' ? 'every machine' : c.where.join(', ')} · ${buy}` })), h('span', { class: 'pill warn', text: audit ? 'Audit of the AI’s rejection' : appealed ? 'Appealed · back with you' : flagged ? 'Flagged · being discussed' : 'Waiting for review' })),
        flagged ? h('div', { class: 'notice', style: 'border-left:3px solid var(--warn, #c80)' }, h('b', { text: appealed ? 'Appealed: ' : 'Flagged: ' }), item.flag?.reasons ?? '', h('div', { style: 'color:var(--muted)', text: appealed ? 'The advertiser appealed the AI reviewer’s rejection to a person. You decide: approve it, or reject it with your reason. The money stays held and nothing prints meanwhile.' : 'A flag never rejects or refunds. The money stays held and nothing prints. Talk it over in the notes; the advertiser can change it at no fee.' })) : '',
        audit ? h('div', { class: 'notice', style: 'border-left:3px solid var(--warn, #c80)' }, h('b', { text: 'Audit: ' }), `The AI reviewer rejected this ad on its own (${item.review?.note ?? ''}). A sample of its rejections comes to a person. Confirm it (reject, with your reason) or overturn it (approve). Either way it goes in its record.`) : '',
        // On the bottle (as cut), or the print file with its bleed and cut line (labelviews.js).
        window.fwLabel.views(payload.labelSvg, { alt: 'The ad on a sample label' }).el,
        // What fills the other pieces: the real fill from the unsold-space list (or open space), never "Sample ad".
        payload.labelCaption ? h('p', { class: 'caption label-fill', style: 'max-width:none;text-align:left', text: payload.labelCaption }) : '',
        h('div', { class: 'row3' },
          h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
            h('div', { class: 'stage', style: 'min-height:0' }, h('div', { class: 'sizes' }, payload.sizes.flatMap((s) => (s.shapes ?? [{ svg: s.svg }]).map((x) => h('figure', {}, h('img', { src: svgSrc(x.svg), alt: s.label, style: 'height:200px' }), h('figcaption', { text: x.w ? `${s.label} · ${(x.w / 100).toFixed(1)} × ${(x.h / 100).toFixed(1)} in` : s.label }))))), ...(payload.boxFaces ?? (payload.boxFaceSvg ? [{ svg: payload.boxFaceSvg }] : [])).map((f) => h('img', { class: 'box-img', src: svgSrc(f.svg), alt: 'On a box side' }))),
            h('div', { class: 'panel-box' }, h('b', { text: 'Check' }), h('ul', { style: 'margin:0;padding-left:18px;line-height:1.8;color:var(--muted)' }, ['Words are true and legal; prices and offers are honest', 'Nothing your rules don’t allow (category, claims, images)', 'Readable at the smallest size', 'Links go where they say; the scan page works'].map((t) => h('li', { text: t })))),
            payload.objections?.length ? h('div', { class: 'panel-box', style: 'border-left:3px solid var(--warn, #c80)' }, h('b', { text: 'Our AI objected to this ad' }), h('p', { style: 'margin:4px 0;color:var(--muted)', text: 'It chose not to help make it, so the built-in helper carried on. You still decide whether it runs.' }), h('ul', { style: 'margin:0;padding-left:18px' }, payload.objections.map((o) => h('li', { text: o.reason })))) : null,
            aiBox,
            paid ? thread : null,
            h('div', { class: 'field' }, h('label', { for: 'r-note', text: paid ? 'Reason (needed to flag or reject)' : 'Note to the advertiser (needed to send it back)' }), note),
            h('div', { class: 'toolbar' }, h('button', { class: 'btn', type: 'button', onclick: () => decide('approve') }, audit ? 'Overturn: approve and start printing' : 'Approve and start printing'),
              paid && !flagged && !audit ? h('button', { class: 'btn secondary', type: 'button', onclick: () => decide('flag') }, 'Flag to discuss') : null,
              h('button', { class: 'btn secondary', type: 'button', onclick: () => decide('reject') }, audit ? 'Confirm the rejection' : paid ? 'Reject for good (refund offered)' : 'Send back')),
            paid ? h('p', { style: 'margin:0;color:var(--muted);font-size:13px', text: 'Paying back a rejected ad is always a separate step an owner or finance person approves (with the second sign-in step), even when the AI reviewer made the rejection.' }) : null),
          frame));
    }
    shell('review', head('Review', 'Ads, changed links and the pieces that fill unsold space. A person decides each one; nothing prints until it’s approved here.'), reviewTabs('ads'), queue.length ? h('div', { class: 'queue' }, list, pane) : h('div', { class: 'empty', text: 'No ads waiting. New ones show up here as soon as an advertiser submits them.' }));
    if (queue.length) { drawList(); show(); }
  }

  // ---------- machines ----------
  // ---------- machines: the Model 6 fleet ----------
  const avail = (a) => h('span', { class: `pill ${a.state === 'ready' ? 'ok' : a.state === 'offline' || a.state === 'out_of_service' || a.state === 'sold_out' ? 'bad' : 'warn'}`, text: { ready: 'Ready', offline: 'Offline', sold_out: 'Sold out', out_of_service: 'Out of service', maintenance: 'Restocking' }[a.state] ?? a.state });
  const ago = (iso) => { if (!iso) return 'never'; const sec = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 1000)); return sec < 60 ? `${sec} s ago` : sec < 3600 ? `${Math.round(sec / 60)} min ago` : sec < 86400 ? `${Math.round(sec / 3600)} h ago` : `${Math.round(sec / 86400)} d ago`; };
  const meter = (left, cap, low) => { const pc = Math.max(0, Math.min(100, Math.round((left / Math.max(1, cap)) * 100))); return h('div', { class: 'meter', title: `${left} of ${cap}` }, h('i', { style: `width:${pc}%;background:${pc < low ? 'var(--bad)' : 'var(--black)'}` }), h('span', { text: `${left}` })); };
  async function machinesPage() {
    const [fleet, failures] = await Promise.all([api('GET', '/v1/ops/fleet'), api('GET', '/v1/ops/plugin-failures').catch(() => [])]);
    const m6 = fleet.filter((m) => m.hardware === 'model6');
    const ready = m6.filter((m) => m.availability.state === 'ready').length;
    shell('machines', head('Machines', 'Every Model 6 calls in every few seconds. A bottle is only billed once it reaches the tray; failed prints are never billed.'),
      h('div', { class: 'kpis', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' },
        h('div', { class: 'kpi dark' }, h('span', { text: 'Ready' }), h('b', { text: `${ready}/${m6.length}` }), h('small', { text: 'Model 6 machines' })),
        h('div', { class: 'kpi' }, h('span', { text: 'Problems open' }), h('b', { text: String(fleet.reduce((n, m) => n + m.incidents.length, 0)) }), h('small', { text: `${fleet.reduce((n, m) => n + m.incidents.filter((i) => i.severity === 'critical').length, 0)} need someone` })),
        h('div', { class: 'kpi' }, h('span', { text: 'Bottles, last 24 h' }), h('b', { text: String(fleet.reduce((n, m) => n + m.last24h.dispensed, 0)) }), h('small', { text: `${fleet.reduce((n, m) => n + m.last24h.failed + m.last24h.expired, 0)} failed, not billed` })),
        h('div', { class: 'kpi' }, h('span', { text: 'Bottles left' }), h('b', { text: String(m6.reduce((n, m) => n + (m.status?.dispenser.bottlesLeft ?? 0), 0)) }), h('small', { text: 'across the fleet' }))),
      h('section', { class: 'panel-box' }, h('div', { class: 'scroll-x' }, h('table', { class: 'list fleet' }, h('thead', {}, h('tr', {}, ['Machine', 'Status', 'Bottles', 'Labels', 'Last 24 h', 'Last heard', 'Problems'].map((x) => h('th', { text: x })))),
        h('tbody', {}, fleet.map((m) => h('tr', { tabindex: '0', style: 'cursor:pointer', onclick: () => go(`/ops/machines/${m.id}`), onkeydown: (e) => { if (e.key === 'Enter') go(`/ops/machines/${m.id}`); } },
          h('td', {}, h('b', { text: m.id }), h('div', { style: 'color:var(--muted);font-size:12px', text: `${m.name} · ${m.hardware === 'model6' ? 'Model 6' : 'other printer'}` })),
          h('td', {}, m.hardware === 'model6' ? avail(m.availability) : h('span', { class: 'pill', text: 'No machine software' })),
          h('td', {}, m.status ? meter(m.status.dispenser.bottlesLeft, m.status.dispenser.capacity, 15) : '—'),
          h('td', {}, m.status ? meter(m.status.printer.labelsLeft, m.status.printer.labelsCapacity, 10) : '—'),
          h('td', { text: m.hardware === 'model6' ? `${m.last24h.dispensed} out${m.last24h.failed + m.last24h.expired ? ` · ${m.last24h.failed + m.last24h.expired} failed` : ''}` : '—' }),
          h('td', { text: m.hardware === 'model6' ? ago(m.lastSeenAt) : '—' }),
          h('td', {}, m.incidents.length ? h('div', { style: 'display:flex;flex-direction:column;gap:4px' }, m.incidents.slice(0, 2).map((i) => h('span', { class: `pill ${i.severity === 'critical' ? 'bad' : 'warn'}`, text: i.message }))) : h('span', { style: 'color:var(--muted)', text: 'None' })))))))),
      h('section', { class: 'panel-box', style: 'margin-top:18px' }, h('h2', { text: 'Scan pages that fell back' }),
        failures.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['When', 'Experience', 'Why'].map((x) => h('th', { text: x })))), h('tbody', {}, failures.map((f) => h('tr', {}, h('td', { text: new Date(f.at).toLocaleString() }), h('td', { text: f.pluginId }), h('td', { text: f.reason }))))))
          : h('p', { style: 'margin:0;color:var(--muted)', text: 'None. Every scan page answered in time.' })));
    const t = setInterval(() => { if (S.path.split('?')[0] === '/ops/machines' && window.scrollY < 40) render(); }, 8000);
    cleanup = () => clearInterval(t);
  }

  const commandNames = { test_print: 'Test print', restart: 'Restart', out_of_service: 'Out of service', in_service: 'Back in service', refresh_screen: 'Refresh screen', sync_buffer: 'Top up offline labels', update_software: 'Update software' };
  async function machinePage(id) {
    const m = await api('GET', `/v1/ops/fleet/${id}`);
    const send = async (kind, args) => { try { await api('POST', `/v1/ops/fleet/${id}/commands`, { kind, ...(args ? { args } : {}) }); toast(`${commandNames[kind]} sent. The machine picks it up within a few seconds.`); setTimeout(() => { if (S.path.split('?')[0] === `/ops/machines/${id}`) render(); }, 2500); } catch (x) { toast(x.message); } };
    const s = m.status;
    const reason = h('input', { class: 'input', maxlength: 120, placeholder: 'Why? Shown on the machine and in the app', 'aria-label': 'Reason for taking it out of service' });
    const version = h('input', { class: 'input', maxlength: 20, placeholder: '1.0.1', 'aria-label': 'Software version', style: 'max-width:140px' });
    const card = (label, value, sub) => h('div', { class: 'kpi' }, h('span', { text: label }), h('b', { text: value }), sub ? h('small', { text: sub }) : null);
    shell('machines', head(`${m.id} · ${m.name}`, `${m.address ?? m.city}${m.hardware === 'model6' ? ` · Model 6 · software ${m.softwareVersion ?? '—'} · last heard ${ago(m.lastSeenAt)}` : ''}`, link('/ops/machines', { class: 'btn secondary small' }, 'All machines'), m.hardware === 'model6' ? avail(m.availability) : null),
      m.hardware !== 'model6' ? h('div', { class: 'notice', text: 'This machine prints with the company printer, not the Model 6 machine software. Change its hardware in the console under Machines.' }) : [
        m.availability.state !== 'ready' ? h('div', { class: 'notice err', style: 'margin-bottom:16px', text: m.availability.message }) : null,
        h('div', { class: 'kpis', style: 'grid-template-columns:repeat(5,minmax(0,1fr))' },
          card('Bottles left', s ? `${s.dispenser.bottlesLeft}` : '—', s ? `of ${s.dispenser.capacity}` : ''),
          card('Labels left', s ? `${s.printer.labelsLeft}` : '—', s ? `ink ${Math.round(s.printer.inkPercent)}%` : ''),
          card('Inside', s ? `${Math.round(s.temperatureC)}°C` : '—', s ? `door ${s.door}` : ''),
          card('Last 24 h', `${m.last24h.dispensed}`, `${m.last24h.failed + m.last24h.expired} failed${m.last24h.avgPrintMs ? ` · ${(m.last24h.avgPrintMs / 1000).toFixed(1)} s to print` : ''}`),
          card('Offline labels', String(m.bufferHeld), 'kept ready')),
        h('div', { class: 'grid2' },
          h('section', { class: 'panel-box' }, h('h2', { text: 'Ask the machine to…' }),
            h('div', { class: 'toolbar' }, h('button', { class: 'btn small', type: 'button', onclick: () => send('test_print') }, 'Test print'), h('button', { class: 'btn secondary small', type: 'button', onclick: () => send('refresh_screen') }, 'Refresh screen'), h('button', { class: 'btn secondary small', type: 'button', onclick: () => send('sync_buffer') }, 'Top up offline labels'), h('button', { class: 'btn secondary small', type: 'button', onclick: () => send('restart') }, 'Restart')),
            m.mode === 'out_of_service' ? h('div', { class: 'toolbar' }, h('span', { text: `Out of service${m.modeReason ? `: ${m.modeReason}` : ''}` }), h('button', { class: 'btn small', type: 'button', onclick: () => send('in_service') }, 'Put back in service'))
              : h('div', { class: 'toolbar' }, reason, h('button', { class: 'btn secondary small', type: 'button', onclick: () => send('out_of_service', reason.value.trim() ? { reason: reason.value.trim() } : undefined) }, 'Take out of service')),
            h('div', { class: 'toolbar' }, version, h('button', { class: 'btn secondary small', type: 'button', onclick: () => { if (!/^\d+\.\d+\.\d+$/.test(version.value.trim())) return toast('Type a version like 1.0.1'); send('update_software', { version: version.value.trim() }); } }, 'Update software')),
            m.commands.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Asked', 'What', 'By', 'Result'].map((x) => h('th', { text: x })))), h('tbody', {}, m.commands.slice(0, 8).map((c) => h('tr', {}, h('td', { text: ago(c.createdAt) }), h('td', { text: commandNames[c.kind] ?? c.kind }), h('td', { text: W.actor(c.createdBy) }), h('td', {}, h('span', { class: `pill ${c.status === 'done' ? 'ok' : c.status === 'failed' ? 'bad' : 'warn'}`, text: c.status === 'pending' || c.status === 'sent' ? 'Waiting' : c.result || W.status(c.status) }))))))) : null),
          h('section', { class: 'panel-box' }, h('h2', { text: 'Problems' }),
            m.incidentHistory.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('tbody', {}, m.incidentHistory.slice(0, 10).map((i) => h('tr', {}, h('td', {}, h('span', { class: `pill ${i.resolvedAt ? '' : i.severity === 'critical' ? 'bad' : 'warn'}`, text: i.resolvedAt ? 'Fixed' : 'Open' })), h('td', { text: i.message }), h('td', { style: 'color:var(--muted);white-space:nowrap', text: i.resolvedAt ? `${ago(i.openedAt)}, fixed in ${Math.max(1, Math.round((Date.parse(i.resolvedAt) - Date.parse(i.openedAt)) / 60000))} min` : ago(i.openedAt) })))))) : h('p', { style: 'margin:0;color:var(--muted)', text: 'None so far.' }))),
        h('section', { class: 'panel-box', style: 'margin-top:18px' }, h('h2', { text: 'Recent bottles' }),
          m.jobs.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['When', 'Bottle', 'Try', 'Result', 'Print', 'Drop'].map((x) => h('th', { text: x })))), h('tbody', {}, m.jobs.map((j) => h('tr', {}, h('td', { text: ago(j.createdAt) }), h('td', { style: 'font-family:ui-monospace,monospace;font-size:13px', text: j.unitId }), h('td', { text: String(j.attempt) }), h('td', {}, h('span', { class: `pill ${j.status === 'dispensed' ? 'ok' : j.status === 'failed' || j.status === 'expired' ? 'bad' : 'warn'}`, text: { dispensed: 'In the tray', failed: j.reason ?? 'Failed', expired: j.reason ?? 'Timed out', queued: 'Waiting', claimed: 'Printing' }[j.status] })), h('td', { text: j.printMs ? `${(j.printMs / 1000).toFixed(1)} s` : '—' }), h('td', { text: j.dropMs ? `${(j.dropMs / 1000).toFixed(1)} s` : '—' }))))))
            : h('p', { style: 'margin:0;color:var(--muted)', text: 'Nothing printed here yet.' }))]);
    const t = setInterval(() => { if (S.path.split('?')[0] === `/ops/machines/${id}` && window.scrollY < 40 && !document.activeElement?.matches('input')) render(); }, 10000);
    cleanup = () => clearInterval(t);
  }

  // ---------- routes ----------
  /** A drop's photo, for the team only: fetched with the sign-in (never a public address) and opened in a new tab. */
  async function openDropPhoto(id) {
    if (fixture) return toast('Photo');
    try {
      const res = await fetch(`/v1/ops/drop-photos/${encodeURIComponent(id)}`, { headers: S.token ? { authorization: `Bearer ${S.token}` } : {} });
      if (!res.ok) return toast(res.status === 404 ? 'That photo was deleted after the keep.' : 'The photo didn’t load.');
      window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
    } catch { toast('The photo didn’t load.'); }
  }
  /** The driver scanned the right box at the door but no photo came: a person (not the driver) vouches for it, with why. */
  async function vouch(r, s) {
    const reason = window.prompt(`Box #${s.boxNumber ?? '—'} was scanned at ${s.address.split(',')[0]} but has no photo. Why is it delivered? (kept on the record)`);
    if (!reason || reason.trim().length < 5) return;
    try { await api('POST', `/v1/ops/runs/${encodeURIComponent(r.id)}/stops/${s.stop}/deliver-without-photo`, { reason: reason.trim() }); toast('Marked delivered, with your reason.'); } catch (x) { toast(x.message); }
    render();
  }
  /**
   * Close a run with why: today's before its last stop (the van broke down; the driver can't scan another stop), or one
   * from an earlier day that will never be finished. Its boxes not left come back and are handled as any box that comes
   * back. After the last stop a run closes itself.
   */
  async function closeOut(r, today) {
    const name = r.areaName ? `${r.areaName} · van ${r.van}` : r.routeName;
    const left = r.counts.stops - r.counts.delivered - r.counts.notDelivered;
    const reason = window.prompt(today ? `Close ${name} now, before its last stop? The ${plural(left, 'stop', 'stops')} not done ${left === 1 ? 'is' : 'are'} marked not delivered, the driver can’t scan another, and the boxes come back. Why? (kept on the record, e.g. “The van broke down”)` : `Close out ${name}? Stops not delivered are marked not delivered and their boxes go back. Why? (kept on the record)`);
    if (!reason) return;
    if (reason.trim().length < 5) { toast('Say why in a few words (at least 5 letters).'); return; }
    try { const x = await api('POST', `/v1/ops/runs/${encodeURIComponent(r.id)}/close`, { reason: reason.trim() }); toast(`Run closed: ${plural(x.closedOut.length, 'box comes', 'boxes come')} back.`); } catch (x) { toast(x.message); }
    render();
  }
  async function routesPage() {
    const q = new URLSearchParams(S.path.split('?')[1] || '');
    const todayDate = (await api('GET', '/v1/ops/overview')).date;
    const date = q.get('date') || todayDate;
    const data = await api('GET', `/v1/ops/runs?date=${date}`);
    W.setZone(data.runs[0]?.timezone ?? S.config.timezone);
    const today = date === todayDate;
    const picker = h('input', { type: 'date', value: date, 'aria-label': 'Night', onchange: (e) => go(`/ops/routes?date=${e.target.value}`) });
    const plan = h('button', { class: 'btn', type: 'button', onclick: async () => { plan.disabled = true; plan.textContent = 'Planning and printing…'; try { const r = await api('POST', '/v1/ops/runs/plan', { date }); toast(r.length ? `${r.length} route${r.length === 1 ? '' : 's'} planned and printed` : 'Nobody is due that day'); } catch (x) { toast(x.message); } render(); } }, 'Plan and print this night');
    const stages = ['printing', 'packing', 'ready', 'out', 'done'];
    const stageName = { printing: 'Printing', packing: 'Packing check', ready: 'Ready to load', out: 'Out on the road', done: 'Done' };
    shell('routes', head('Routes', 'Everyone due that night, in driving order, and every house due in each delivery area that’s on, street by street, with a box printed for each stop.', picker, plan),
      data.runs.length ? h('div', { style: 'display:flex;flex-direction:column;gap:16px' }, data.runs.map((r) => {
        const at = stages.indexOf(r.status);
        return h('section', { class: 'run' },
          h('div', { class: 'run-head' }, h('div', {}, h('h3', { text: r.areaName ? `${r.areaName} · van ${r.van} · ${r.routeId.replace(/^route-/, 'Route ')}` : `${r.routeName} · ${r.routeId.replace(/^route-/, 'Route ')}` }), h('div', { style: 'color:var(--muted);font-size:14px', text: `${plural(r.counts.stops, 'stop', 'stops')} · ${plural(r.counts.bottles, 'bottle', 'bottles')} · about ${r.distanceKm} km, ${r.minutes} min · from ${r.depot?.name ?? 'the depot'}` })),
            h('div', { class: 'toolbar' }, r.status === 'packing' ? h('button', { class: 'btn small', type: 'button', onclick: async () => { try { const x = await api('POST', `/v1/ops/runs/${r.id}/pack-check`); toast(x.problems.length ? `${x.problems.length} box(es) need attention` : 'Every box checked and sealed'); } catch (e) { toast(e.message); } render(); } }, 'Run packing check') : null, r.driverId ? h('span', { class: 'pill dark', text: 'Driver assigned' }) : null, r.status !== 'done' && date <= todayDate ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => closeOut(r, today) }, today ? 'Close the run…' : 'Close out…') : null)),
          h('div', { class: 'steps' }, stages.map((s, i) => h('span', { class: i < at ? 'done' : i === at ? 'on' : '', text: stageName[s] }))),
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Stop', 'Address', 'Box', 'Pack', 'Status', 'When', ''].map((x) => h('th', { text: x })))),
            h('tbody', {}, r.stops.map((s) => h('tr', {}, h('td', {}, h('b', { text: s.stopCode })), h('td', { text: s.address }), h('td', {}, `#${s.boxNumber ?? '—'}`, (r.status === 'printing' || r.status === 'packing') && s.sticker ? h('div', { class: 'sticker-step', style: 'color:var(--muted);font-size:13px', text: s.sticker }) : null), h('td', { text: `${s.packSize}` }),
              h('td', {}, s.status === 'delivered' ? h('span', {}, h('span', { class: 'pill ok', text: `Delivered${s.atAddressBy === 'driver' ? ' (driver confirmed)' : ''}${s.photoWaived ? ' without a photo' : ''}` }), s.photo ? h('button', { class: 'linkish', type: 'button', onclick: () => openDropPhoto(s.photo.id) }, ' Photo') : null, s.photo && s.photo.location === 'unverified' ? h('span', { class: 'pill warn', title: 'The phone gave no location (or too vague a one) when the photo was taken', text: 'unverified location' }) : null) :
                s.doorScan ? h('span', {}, h('span', { class: 'pill warn', text: 'Scanned at the door, no photo yet' }), h('button', { class: 'btn secondary small', type: 'button', onclick: () => vouch(r, s) }, 'Delivered without photo…')) : s.status === 'not_delivered' ? h('span', { class: `pill ${s.skipped ? 'warn' : 'bad'}`, text: `${s.skipped ? 'Skipped' : 'Not delivered'}${s.reason ? `: ${W.skipReason(s.reason)}` : ''}` }) : s.houseStatus && s.houseStatus !== 'active' ? h('span', { class: 'pill warn', text: 'Stopped since the plan: keep the box' }) : h('span', { class: 'pill', text: W.status(s.packStatus) || 'Planned' })),
              // When the box was left (or the stop given up), in the company's time zone; a box scanned at its door waiting for its photo, then.
              h('td', { class: 'drop-time', style: 'white-space:nowrap', text: s.at ? W.time(s.at) : s.doorScan ? `Scanned ${W.time(s.doorScan.at)}` : '—' }),
              h('td', { style: 'color:var(--muted);font-size:13px' }, s.emptiesCollected ? `${plural(s.emptiesCollected, 'empty', 'empties')}` : '', s.checkedByHand ? `Checked by hand, ${ago(s.checkedByHand.at)}` : '',
                // No packing line for this box: a signed-in person counts every bottle and checks it by hand (who and when are kept).
                r.status === 'packing' && s.packId && (s.packStatus === 'box_printed' || s.packStatus === 'mismatch') ? h('button', { class: 'btn secondary small reprint', type: 'button', onclick: () => reprintSheet(r, s) }, 'Reprint a bad label…') : null,
                r.status === 'packing' && (s.packStatus === 'box_printed' || s.packStatus === 'mismatch') ? h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { if (!confirm(`Did you count all ${plural(s.packSize, 'bottle', 'bottles')} in box #${s.boxNumber ?? '—'} and check each one belongs${s.sticker ? ', and put its box-code sticker on' : ''}? It's sealed and recorded under your name.`)) return; try { const x = await api('POST', `/v1/ops/runs/${encodeURIComponent(r.id)}/stops/${s.stop}/check-by-hand`); toast(x.problems.length ? `Checked and sealed. ${x.problems.length} box(es) still need a check` : 'Checked and sealed. Every box is ready to load'); } catch (e) { toast(e.message); } render(); } }, 'Checked by hand') : null)))))));
      })) : h('div', { class: 'empty', text: 'No routes planned for this night yet. Plan and print it when the day’s orders are in.' }));
  }

  // ---------- delivery areas: the streets FreeWater chooses, every house on them ----------
  const HS = { active: ['ok', 'Gets packs'], opted_out: ['warn', 'Stopped in the app'], skip_pending: ['bad', 'Driver skip: review'], skipped: ['', 'Skipped'] };
  async function areasPage() {
    const [areas, reviews, notices] = await Promise.all([api('GET', '/v1/ops/areas'), api('GET', '/v1/ops/house-reviews').catch(() => []), api('GET', '/v1/ops/house-notices').catch(() => [])]);
    const name = h('input', { class: 'input', id: 'ar-name', placeholder: 'Travis Heights, first 1,000 homes', maxlength: '80' });
    const routeId = h('input', { class: 'input', id: 'ar-route', placeholder: 'route-3', value: 'route-3' });
    const create = h('form', { class: 'panel-box', onsubmit: async (e) => { e.preventDefault(); try { const a = await api('POST', '/v1/ops/areas', { name: name.value.trim(), routeId: routeId.value.trim() }); toast('Area made. It’s off until you turn it on.'); go(`/ops/areas/${a.id}`); } catch (x) { toast(x.message); } } },
      h('h2', { text: 'New area' }), h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: 'Its vans start from the route’s micro-factory and drive on the route’s days. It starts off; add houses, check them, then turn it on.' }),
      h('div', { class: 'field' }, h('label', { for: 'ar-name', text: 'Name' }), name), h('div', { class: 'field' }, h('label', { for: 'ar-route', text: 'Route' }), routeId), h('button', { class: 'btn', type: 'submit' }, 'Make the area'));
    const review = (r) => h('tr', {}, h('td', {}, h('b', { text: r.address.split(',')[0] }), h('div', { style: 'color:var(--muted);font-size:12px', text: r.areaName })), h('td', { text: W.skipReason(r.skipReason) }),
      h('td', {}, h('div', { class: 'toolbar' },
        h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await api('POST', `/v1/ops/houses/${r.id}/review`, { decision: 'deliver' }); toast('It gets packs again from the next night'); } catch (x) { toast(x.message); } render(); } }, 'Deliver again'),
        h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { await api('POST', `/v1/ops/houses/${r.id}/review`, { decision: 'skip' }); toast('Skipped from now on'); } catch (x) { toast(x.message); } render(); } }, 'Keep skipping'))));
    shell('areas', head('Delivery areas', 'House after house on the streets we choose. Nobody signs up: every house gets packs unless someone there stops them in the app, or a driver’s skip is agreed.'),
      noticesBox(notices),
      reviews.length ? h('section', { class: 'panel-box' }, h('h2', { text: `${reviews.length} driver skip${reviews.length === 1 ? '' : 's'} to review` }), h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: 'These houses are left out until you decide.' }),
        h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['House', 'Driver said', ''].map((x) => h('th', { text: x })))), h('tbody', {}, reviews.map(review))))) : null,
      areas.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Area', 'Houses', 'Packs', 'How often', 'Status'].map((x) => h('th', { text: x })))),
        h('tbody', {}, areas.map((a) => h('tr', {}, h('td', {}, link(`/ops/areas/${a.id}`, {}, h('b', { text: a.name })), h('div', { style: 'color:var(--muted);font-size:12px', text: `${a.routeName}${a.sample ? ' · sample houses' : ''}` })),
          h('td', { text: `${a.byStatus.active} of ${a.houses}${a.byStatus.opted_out ? ` · ${a.byStatus.opted_out} stopped` : ''}${a.byStatus.skip_pending ? ` · ${a.byStatus.skip_pending} to review` : ''}` }),
          h('td', { text: `${a.packsPerHouse} × ${a.packSize}` }), h('td', { text: a.frequencyDays === 7 ? 'Weekly' : `Every ${plural(a.frequencyDays, 'day', 'days')}` }),
          h('td', {}, h('span', { class: `pill ${a.active ? 'ok' : ''}`, text: a.active ? 'On' : 'Off' }))))))) : h('div', { class: 'empty', text: 'No delivery areas yet.' }),
      create);
  }
  /** The area's houses as dots, coloured by status; a real map can replace this (docs/OVERVIEW.md). */
  function houseMap(houses, polygon) {
    const pts = [...houses.map((x) => x.point), ...(polygon ?? []).map(([lat, lng]) => ({ lat, lng }))];
    if (!pts.length) return null;
    const minLat = Math.min(...pts.map((p) => p.lat)), maxLat = Math.max(...pts.map((p) => p.lat)), minLng = Math.min(...pts.map((p) => p.lng)), maxLng = Math.max(...pts.map((p) => p.lng));
    const W = 640, H = 300, pad = 14;
    const x = (p) => pad + ((p.lng - minLng) / Math.max(1e-6, maxLng - minLng)) * (W - pad * 2);
    const y = (p) => H - pad - ((p.lat - minLat) / Math.max(1e-6, maxLat - minLat)) * (H - pad * 2);
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Map of ${plural(houses.length, 'house', 'houses')}`, style: 'width:100%;height:auto;background:var(--soft);border-radius:12px' })) svg.setAttribute(k, v);
    const el = (tag, a) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v)); svg.append(e); return e; };
    if (polygon) el('polygon', { points: polygon.map(([lat, lng]) => `${x({ lat, lng })},${y({ lat, lng })}`).join(' '), fill: 'none', stroke: '#9AA6B2', 'stroke-dasharray': '5 4', 'stroke-width': 2 });
    const color = { active: '#1F8A4C', opted_out: '#B7791F', skip_pending: '#B42318', skipped: '#9AA6B2' };
    for (const hs of houses) el('circle', { cx: x(hs.point), cy: y(hs.point), r: 4, fill: color[hs.status] ?? '#1F2633' }).append(Object.assign(document.createElementNS(NS, 'title'), { textContent: `${hs.address} · ${HS[hs.status]?.[1] ?? W.status(hs.status)}` }));
    return svg;
  }
  async function areaPage(id) {
    const [areas, houses] = await Promise.all([api('GET', '/v1/ops/areas'), api('GET', `/v1/ops/areas/${id}/houses`)]);
    const a = areas.find((x) => x.id === id);
    if (!a) throw new Error('Delivery area not found.');
    const num = (key, label, min, max, help) => { const i = h('input', { class: 'input', id: `ar-${key}`, type: 'number', min, max, value: a[key] ?? '' }); return [h('div', { class: 'field' }, h('label', { for: `ar-${key}`, text: label }), i, help ? h('small', { style: 'color:var(--muted)', text: help }) : null), () => (i.value === '' ? null : Number(i.value)), key]; };
    const fields = [num('frequencyDays', 'Every how many days', 1, 28, '7 = weekly (the pilot’s default).'), num('packsPerHouse', 'Packs per house', 1, 6, 'Until a household tells us its size.'), num('bottlesPerPersonWeek', 'Bottles a person a week', 1, 48, 'Once a household says its size it gets enough for this many each; empty = don’t use household size.'), num('maxPacksPerHouse', 'Most packs per house', 1, 6), num('vanPacks', 'Boxes per van', 1, 1000, 'A night’s houses are split into one run per van.')];
    const size = h('select', { class: 'input', id: 'ar-size' }, [12, 24].map((n) => h('option', { value: String(n), text: `${n}-packs`, selected: a.packSize === n })));
    const save = async (patch, msg) => { try { await api('PATCH', `/v1/ops/areas/${id}`, patch); toast(msg); } catch (x) { toast(x.message); } render(); };
    const csv = h('textarea', { class: 'input', id: 'ar-csv', rows: '6', placeholder: 'address,lat,lng\n"1601 Ravey St, Austin, TX",30.2450,-97.7401' });
    const file = h('input', { type: 'file', accept: '.csv,text/csv', onchange: async () => { const f = file.files[0]; if (f) csv.value = await f.text(); } });
    const poly = h('textarea', { class: 'input', id: 'ar-poly', rows: '3', placeholder: '[[30.240,-97.746],[30.252,-97.746],[30.252,-97.734],[30.240,-97.734]]' });
    poly.value = a.polygon ? JSON.stringify(a.polygon) : '';
    const result = h('div', {});
    const counts = houses.reduce((m, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {});
    shell('areas', head(a.name, `${a.routeName} · ${plural(a.houses, 'house', 'houses')} · ${a.packsPerHouse} × ${a.packSize}-pack ${a.frequencyDays === 7 ? 'every week' : `every ${plural(a.frequencyDays, 'day', 'days')}`}${a.sample ? ' · sample houses, not real addresses' : ''}`,
      h('button', { class: `btn ${a.active ? 'secondary' : ''}`, type: 'button', onclick: () => { if (a.active || confirm(`Turn on ${a.name}? Every active house in it is planned and printed from the next night you plan.`)) save({ active: !a.active }, a.active ? 'Turned off. Nothing more is planned for it.' : 'Turned on'); } }, a.active ? 'Turn off' : 'Turn on')),
      h('div', { class: 'grid2' },
        h('section', { class: 'panel-box' }, h('h2', { text: 'Houses' }), houseMap(houses, a.polygon),
          h('div', { class: 'toolbar' }, Object.entries(HS).map(([k, [cls, label]]) => h('span', { class: `pill ${cls}`, text: `${label}: ${counts[k] ?? 0}` })))),
        h('form', { class: 'panel-box', onsubmit: (e) => { e.preventDefault(); const patch = { packSize: Number(size.value) }; for (const [, get, key] of fields) { const v = get(); if (v !== null || key === 'bottlesPerPersonWeek') patch[key] = v; } save(patch, 'Saved. It applies from the next plan.'); } },
          h('h2', { text: 'Settings' }), h('div', { class: 'field' }, h('label', { for: 'ar-size', text: 'Pack size' }), size), fields.map(([el]) => el), h('button', { class: 'btn', type: 'submit' }, 'Save settings'))),
      h('section', { class: 'panel-box' }, h('h2', { text: 'Add houses' }),
        h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: 'A CSV with a header line naming address, lat and lng (street and number are optional). Only houses inside the polygon are added; an address we already have stays as it is.' }),
        file, csv, h('div', { class: 'field' }, h('label', { for: 'ar-poly', text: 'Polygon (optional): corners as [lat, lng]' }), poly),
        h('div', { class: 'toolbar' },
          h('button', { class: 'btn', type: 'button', onclick: async () => {
            let polygon = null;
            try { polygon = poly.value.trim() ? JSON.parse(poly.value) : null; } catch { return toast('The polygon isn’t valid: [[lat, lng], …]'); }
            try { const r = await api('POST', `/v1/ops/areas/${id}/houses/import`, { csv: csv.value, ...(polygon ? { polygon } : {}) }); result.replaceChildren(h('div', { class: 'notice' }, `${r.added} added, ${r.alreadyKnown} already known, ${r.outside} outside the polygon${r.problemCount ? `, ${plural(r.problemCount, 'line', 'lines')} not read (first: line ${r.problems[0].line}, ${r.problems[0].reason})` : ''}.`)); } catch (x) { toast(x.message); }
          } }, 'Add these houses'),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => { let polygon = null; try { polygon = poly.value.trim() ? JSON.parse(poly.value) : null; } catch { return toast('The polygon isn’t valid: [[lat, lng], …]'); } save({ polygon }, 'Polygon saved for the next houses added'); } }, 'Save polygon')),
        result),
      h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Address', 'Status', 'People', 'Last left', 'Next due'].map((x) => h('th', { text: x })))),
        h('tbody', {}, houses.map((x) => h('tr', {}, h('td', {}, x.address, x.claimed ? h('span', { class: 'pill', style: 'margin-left:6px', text: 'In the app' }) : null), h('td', {}, h('span', { class: `pill ${HS[x.status]?.[0] ?? ''}`, text: HS[x.status]?.[1] ?? W.status(x.status) }), x.skipReason ? h('div', { style: 'color:var(--muted);font-size:12px', text: W.skipReason(x.skipReason) }) : null),
          h('td', { text: x.householdSize ? String(x.householdSize) : '—' }), h('td', { text: x.lastDeliveredAt ? ago(x.lastDeliveredAt) : '—' }), h('td', { text: x.status === 'active' ? (x.nextDate ? W.day(x.nextDate) : 'Next plan') : '—' })))))));
  }

  // ---------- deliveries ----------
  async function subsPage() {
    const subs = await api('GET', '/v1/ops/subscriptions');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const freq = { weekly: 'Weekly', biweekly: 'Every 2 weeks', every4weeks: 'Every 4 weeks' };
    shell('subs', head('Deliveries', `${subs.length} home${subs.length === 1 ? '' : 's'} getting packs. ${plural(subs.reduce((n, s) => n + (s.status === 'active' ? s.packSize : 0), 0), 'bottle', 'bottles')} a cycle.`),
      subs.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Customer', 'Address', 'Route', 'Pack', 'How often', 'Next', 'Status'].map((x) => h('th', { text: x })))),
        h('tbody', {}, subs.map((s) => h('tr', {}, h('td', { text: s.customer }), h('td', { text: s.address }), h('td', { text: s.routeName ?? W.route(s.routeId) }), h('td', { text: `${s.packSize}` }), h('td', { text: `${freq[s.frequency]}, ${days[s.day]}` }), h('td', { text: s.nextDate ? W.day(s.nextDate) : '—' }), h('td', {}, h('span', { class: `pill ${s.status === 'active' ? 'ok' : 'warn'}`, text: s.status === 'active' ? 'Active' : W.status(s.status) })))))))
        : h('div', { class: 'empty', text: 'No one has signed up for delivery yet.' }));
  }

  // ---------- books ----------
  async function booksPage() {
    // The signed-in person's own company (a licensee's team sees its own), and only while its open books are on.
    const mine = S.me?.companyId ?? S.config.companyId;
    const [totals, lines, preview, transfers] = await Promise.all([(S.features?.off ?? []).includes('open_books') ? null : api('GET', `/v1/public/companies/${encodeURIComponent(mine)}/totals`), api('GET', '/v1/ledger?limit=500').catch(() => []), api('GET', '/v1/payouts/preview').catch(() => null), api('GET', '/v1/payouts').catch(() => null)]);
    const recent = lines.slice(-40).reverse();
    const send = h('button', { class: 'btn', type: 'button', onclick: async () => {
      send.disabled = true; send.textContent = 'Sending…';
      try { const r = await api('POST', '/v1/payouts/run'); toast(r.sent.length ? `${r.sent.length} transfer${r.sent.length === 1 ? '' : 's'} sent${r.failed.length ? `, ${r.failed.length} returned by the bank` : ''}` : r.failed.length ? 'The bank returned the transfer' : 'Nothing to send yet'); } catch (x) { toast(x.message); }
      render();
    } }, 'Send transfers now');
    const cat = h('select', { class: 'input', id: 'x-cat' }, [['water', 'Water'], ['bottles', 'Bottles and caps'], ['labels-ink', 'Labels and ink'], ['machines', 'Machines'], ['delivery', 'Delivery'], ['people', 'People'], ['rent', 'Rent'], ['other', 'Other']].map(([v, l]) => h('option', { value: v, text: l })));
    const amt = h('input', { class: 'input', id: 'x-amt', inputmode: 'decimal', placeholder: '1250.00' });
    const memo = h('input', { class: 'input', id: 'x-memo', placeholder: 'October spring water, RAIN Bottling' });
    const date = h('input', { class: 'input', id: 'x-date', type: 'date', value: new Date().toISOString().slice(0, 10) });
    shell('books', head('Books', 'Every line is final. Corrections are new lines, never edits. Everything on the public open-books site comes from here.', h('a', { class: 'btn secondary', href: fixture ? '#' : '/books', target: '_blank', rel: 'noopener' }, 'Open the public site')),
      h('div', { class: 'kpis', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' },
        totals && h('div', { class: 'kpi dark' }, h('span', { text: 'Bottles, all time' }), h('b', { text: totals.bottles.toLocaleString() })),
        totals && h('div', { class: 'kpi' }, h('span', { text: 'Earned, all time' }), h('b', { text: dollars(totals.revenueCents) })),
        totals && h('div', { class: 'kpi' }, h('span', { text: 'Given, all time' }), h('b', { text: dollars(totals.donatedCents) }))),
      preview ? h('div', { class: 'grid2' },
        h('section', { class: 'panel-box' }, h('h2', {}, 'Charity transfers', send),
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Charity', 'Owed now', ''].map((x) => h('th', { text: x })))),
            h('tbody', {}, preview.map((p) => h('tr', {}, h('td', { text: p.charity }), h('td', { text: dollars(p.owedCents) }), h('td', {}, p.willSend ? h('span', { class: 'pill ok', text: 'Will send' }) : h('span', { class: 'pill', text: p.why }))))))),
          transfers?.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Transfer', 'Charity', 'Amount', 'Status'].map((x) => h('th', { text: x })))),
            h('tbody', {}, transfers.slice(0, 10).map((t) => h('tr', {}, h('td', { text: `${t.number} · ${new Date(t.sentAt).toLocaleDateString()}` }), h('td', { text: t.charity }), h('td', { text: dollars(t.amountCents) }), h('td', {}, h('span', { class: `pill ${t.status === 'failed' ? 'bad' : t.status === 'confirmed' ? 'ok' : ''}`, text: t.status === 'failed' ? `Returned: ${t.failure}` : t.status === 'confirmed' ? 'Charity confirmed' : `Sent · ${t.bankReference}` }))))))) : null),
        h('section', { class: 'panel-box' }, h('h2', { text: 'Record a cost' }), h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: 'Costs are published as money out, by category.' }),
          h('form', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px', onsubmit: async (e) => {
            e.preventDefault();
            const cents = Math.round(parseFloat(amt.value.replace(/[$,]/g, '')) * 100);
            if (!(cents > 0)) return toast('Enter an amount');
            try { await api('POST', '/v1/books/expenses', { category: cat.value, amountCents: cents, memo: memo.value.trim(), date: date.value }); toast('Recorded'); render(); } catch (x) { toast(x.message); }
          } }, h('div', { class: 'field' }, h('label', { for: 'x-cat', text: 'What for' }), cat), h('div', { class: 'field' }, h('label', { for: 'x-amt', text: 'Amount ($)' }), amt), h('div', { class: 'field', style: 'grid-column:1/-1' }, h('label', { for: 'x-memo', text: 'Description (public)' }), memo), h('div', { class: 'field' }, h('label', { for: 'x-date', text: 'Date' }), date), h('div', { style: 'display:flex;align-items:flex-end' }, h('button', { class: 'btn', type: 'submit' }, 'Record it'))))) : null,
      lines.length ? h('section', { class: 'panel-box', style: 'margin-top:18px' }, h('h2', { text: 'Latest lines' }), h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['When', 'What', 'From', 'To', 'Amount'].map((x) => h('th', { text: x })))),
        h('tbody', {}, recent.map((l) => h('tr', {}, h('td', { text: new Date(l.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }), h('td', { text: l.memo }), h('td', { style: 'font-size:12px;color:var(--muted)', text: l.debit }), h('td', { style: 'font-size:12px;color:var(--muted)', text: l.credit }), h('td', { text: dollars(l.amountCents) })))))))
        : h('div', { class: 'empty', text: 'Your role can’t see ledger lines. Finance and owners can.' }));
  }

  I.bottle = 'M9 2h6v3l2 3v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8l2-3z|M7 11h10|M7 17h10';
  // ---------- the Review section: ads, link changes, filler and charity pieces (one place for ad queues) ----------
  // Who reviews ads is the company's choice (console → Team, "Who reviews ads"; FreeWater: owners and ops). A person
  // decides each one; refunds stay with an owner or finance person. The unsold-space ORDER stays in the console.
  const reviewTabs = (active) => h('div', { class: 'toolbar review-tabs', style: 'margin-bottom:16px' },
    h('nav', { class: 'tabs', 'aria-label': 'Review' }, [['ads', '/ops/review', 'Ads'], ['links', '/ops/review/links', 'Link changes'], ['fillers', '/ops/review/fillers', 'Filler and charity']].filter(([id]) => id !== 'fillers' || !(S.features?.off ?? []).includes('fillers')).map(([id, path, label]) => link(path, { class: `tab${active === id ? ' on' : ''}`, 'aria-current': active === id ? 'page' : null }, label))),
    S.me?.role === 'owner' ? h('a', { class: 'btn secondary small', href: fixture ? '#' : '/console/ads#unsold' }, 'Unsold-space order (console) →') : h('span', { style: 'color:var(--muted);font-size:13px', text: 'What fills unsold space, in order, is set by an owner in the console.' }));
  /** "Nov 10, 7:42 PM" in the company's time zone (src/web/words.js). */
  const when = (iso) => W.when(iso);
  const VERDICT = { pass: ['ok', 'Passed'], flag: ['warn', 'Flagged: look closely'], refuse: ['bad', 'Refused'] };
  const verdictPill = (v) => h('span', { class: `pill ${VERDICT[v]?.[0] ?? ''}`, text: VERDICT[v]?.[1] ?? v });
  const urlLine = (label, items, cls) => h('div', { class: `link-line ${cls}` }, h('b', { text: label }), h('ul', {}, (items ?? []).map((x) => h('li', {}, h('code', { text: x.url }), x.path && x.path !== 'experienceConfig.link.url' ? h('span', { style: 'color:var(--muted);font-size:12px', text: ` (${x.path})` }) : null))));

  async function linkChangesPage() {
    const [queue, holds] = await Promise.all([api('GET', '/v1/review/link-changes'), api('GET', '/v1/review/link-holds').catch(() => [])]);
    const card = (x) => {
      const why = h('textarea', { class: 'input', id: `lc-why-${x.id}`, maxlength: '500', placeholder: 'Why it’s rejected (the advertiser sees this word for word)' });
      const decide = async (decision) => {
        if (decision === 'reject' && why.value.trim().length < 10) { toast('Write why, in plain words (at least 10 characters): the advertiser sees it.'); why.focus(); return; }
        if (decision === 'approve' && !window.confirm(`Approve ${x.advertiser ?? 'this'}’s new link? Every bottle’s code for this ad leads there from now on.`)) return;
        try { await api('POST', `/v1/review/link-changes/${encodeURIComponent(x.id)}`, { decision, ...(why.value.trim() ? { note: why.value.trim() } : {}) }); toast(decision === 'approve' ? 'Approved: the new link is live.' : 'Rejected: the old link stays live, and the advertiser sees why.'); } catch (e) { toast(e.message); }
        render();
      };
      return h('section', { class: 'panel-box link-change', 'data-id': x.id },
        h('h2', {}, h('span', { text: `${x.advertiser ?? 'An advertiser'}${x.name ? ` · ${x.name}` : ''}` }), x.appealedAt ? h('span', { class: 'pill warn', text: 'Appealed to a person' }) : h('span', { class: 'pill', text: `Asked ${when(x.at)}` })),
        urlLine('Old link (still live)', x.before, 'old'), urlLine('New link (waiting for you)', x.changes, 'new'),
        h('div', { class: 'safety' }, h('b', { text: 'Automatic link-safety check: ' }), verdictPill(x.safety.verdict), x.safety.reasons ? h('p', { style: 'margin:6px 0 0', text: x.safety.reasons }) : h('p', { style: 'margin:6px 0 0;color:var(--muted)', text: 'Nothing found: https, no private address, no password, not on the list, the last page read fine.' })),
        x.ai ? h('div', { class: 'ai-view' }, h('b', { text: 'The AI reviewer (it can’t decide): ' }), verdictPill(x.ai.verdict), x.ai.reasons ? h('p', { style: 'margin:6px 0 0', text: x.ai.reasons }) : null) : h('p', { style: 'margin:0;color:var(--muted);font-size:13px', text: 'The AI reviewer hasn’t looked at it (it’s off, or still looking).' }),
        h('p', { style: 'margin:0;color:var(--muted);font-size:13px', text: `${x.feeCents ? `Fee paid ${dollars(x.feeCents)} (kept either way). ` : ''}Nothing pauses meanwhile: the old link keeps working until you approve the new one.` }),
        h('div', { class: 'field' }, h('label', { for: `lc-why-${x.id}`, text: 'Reason (needed to reject)' }), why),
        h('div', { class: 'toolbar' }, h('button', { class: 'btn', type: 'button', onclick: () => decide('approve') }, 'Approve the new link'), h('button', { class: 'btn secondary', type: 'button', onclick: () => decide('reject') }, 'Reject, keep the old link')));
    };
    const held = holds.filter((x) => !x.released);
    shell('review', head('Review', 'Ads, changed links and the pieces that fill unsold space. A person decides each one.'), reviewTabs('links'),
      queue.length ? h('div', { class: 'link-changes', style: 'display:flex;flex-direction:column;gap:16px' }, queue.map(card)) : h('div', { class: 'empty', text: 'No changed links waiting. When an advertiser changes where a live ad’s code leads, it waits here (the old link stays live).' }),
      held.length ? h('section', { class: 'panel-box', style: 'margin-top:18px' }, h('h2', { text: `${plural(held.length, 'ad', 'ads')} on hold: a link turned bad` }), h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: 'Their codes open a holding page until a person checks the link and clears it (it’s checked again first).' }),
        held.map((x) => h('div', { class: 'attn' }, h('div', {}, h('span', {}, h('b', { text: x.advertiser ?? x.campaignId }), ` · ${x.reasons}`), h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { const reason = window.prompt('What did you check? (kept on the record, 10+ characters)'); if (!reason) return; try { await api('POST', `/v1/review/link-holds/${encodeURIComponent(x.campaignId)}/release`, { reason }); toast('Cleared.'); } catch (e) { toast(e.message); } render(); } }, 'Clear the hold…'))))) : null);
  }

  async function fillersPage() {
    const { fillers } = await api('GET', '/v1/fillers');
    const pending = fillers.filter((f) => f.status === 'pending' && f.kind !== 'news'), live = fillers.filter((f) => f.status === 'approved' && f.kind !== 'news');
    const KIND = { charity: 'Charity partner', advertiser: 'An advertiser’s ad, offered free', own: 'Your own message' };
    const card = (f) => {
      const pic = h('div', { class: 'filler-pic' }, h('p', { class: 'caption', text: 'Loading the label…' }));
      api('GET', `/v1/review/campaigns/${encodeURIComponent(f.id)}/preview`).then((p) => pic.replaceChildren(window.fwLabel.views(p.labelSvg, { alt: `${f.name} on a label` }).el, h('p', { class: 'caption', text: 'On a real label, as it would print in space nobody bought.' }))).catch(() => pic.replaceChildren(h('p', { class: 'caption', text: 'The label didn’t load.' })));
      const act = async (path, msg, ask) => { if (ask && !window.confirm(ask)) return; try { await api('POST', `/v1/fillers/${encodeURIComponent(f.id)}/${path}`); toast(msg); } catch (e) { toast(e.message); } render(); };
      return h('section', { class: 'panel-box filler', 'data-id': f.id },
        h('h2', {}, h('span', { text: `${f.name} · ${f.headline}` }), h('span', { class: `pill ${f.status === 'approved' ? 'ok' : 'warn'}`, text: f.status === 'approved' ? 'Printing in unsold space' : 'Waiting for a person' })),
        h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: `${KIND[f.kind] ?? f.kind} · sizes ${f.sizes.map((s) => (s === 1 ? 'full' : `1/${s}`)).join(', ')} · proposed ${when(f.proposedAt)}` }),
        pic,
        h('div', { class: 'toolbar' }, f.status === 'pending' ? h('button', { class: 'btn', type: 'button', onclick: () => act('approve', 'Approved: it can fill unsold space now.') }, 'Approve') : null,
          h('button', { class: 'btn secondary', type: 'button', onclick: () => act('retire', f.status === 'pending' ? 'Rejected: it never prints.' : 'Stopped: it no longer prints.', f.status === 'pending' ? `Reject “${f.headline}”? It never prints; it can be proposed again.` : `Stop “${f.headline}” printing now? Bottles already out still open it.`) }, f.status === 'pending' ? 'Reject' : 'Stop it')));
    };
    shell('review', head('Review', 'Ads, changed links and the pieces that fill unsold space. A person decides each one.'), reviewTabs('fillers'),
      h('h2', { style: 'font-size:18px;margin:0 0 10px', text: pending.length ? `${plural(pending.length, 'piece', 'pieces')} waiting` : 'Waiting' }),
      pending.length ? h('div', { class: 'fillers', style: 'display:flex;flex-direction:column;gap:16px' }, pending.map(card)) : h('div', { class: 'empty', text: 'Nothing waiting. Charity partners’ pieces and ads advertisers offer free for unsold space wait here until a person approves them.' }),
      live.length ? [h('h2', { style: 'font-size:18px;margin:22px 0 10px', text: 'Approved and printing' }), h('div', { style: 'display:flex;flex-direction:column;gap:16px' }, live.map(card))] : null);
  }

  // ---------- find a bottle by the code printed on its label ----------
  async function bottlesPage() {
    const q = new URLSearchParams(S.path.split('?')[1] || '');
    const typed = q.get('code') || '';
    const input = h('input', { class: 'input code-input', id: 'b-code', value: typed, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'B-7F3K29', 'aria-label': 'Bottle code', style: 'max-width:240px' });
    const out = h('div', { class: 'bottle-found' });
    const find = async (code) => {
      if (!code.trim()) return;
      if (!fixture) history.replaceState(null, '', `/ops/bottles?code=${encodeURIComponent(code.trim())}`);
      out.replaceChildren(h('p', { class: 'caption', text: 'Looking…' }));
      try { out.replaceChildren(bottleCard(await api('GET', `/v1/console/bottles/${encodeURIComponent(code.trim().replace(/[^A-Za-z0-9 _-]/g, ''))}`))); } catch (e) { out.replaceChildren(h('div', { class: 'notice err', text: e.message })); }
    };
    shell('bottles', head('Find a bottle', 'Type the code printed at the bottom of its label’s panel (“Bottle code: B-7F3K29”). With or without “B-”, in any case; O and 0, I and 1 are the same.'),
      h('form', { class: 'toolbar', onsubmit: (e) => { e.preventDefault(); find(input.value); } }, input, h('button', { class: 'btn', type: 'submit' }, 'Find')), out);
    if (typed) find(typed); else input.focus();
  }
  const STATUS = { dispensed: 'Printed and handed out', printed: 'Printed', rendered: 'Waiting to print', filled: 'Waiting to print', failed: 'Failed to print (never billed)' };
  function bottleCard(b) {
    const other = (x) => (x ? h('button', { class: 'linkish', type: 'button', onclick: () => go(`/ops/bottles?code=${encodeURIComponent(x.code ?? x.unitId)}`) }, x.code ?? x.unitId) : null);
    const d = b.drop;
    return h('section', { class: 'panel-box bottle-card' },
      h('h2', {}, h('span', { text: b.code ?? b.unitId }), h('span', { class: `pill ${b.voided ? 'bad' : b.status === 'failed' ? 'bad' : 'ok'}`, text: b.voided ? 'Voided at the packing check' : STATUS[b.status] ?? W.status(b.status) })),
      h('dl', { class: 'facts' },
        h('dt', { text: 'Printed' }), h('dd', { text: `${when(b.printedAt)} · ${b.place}` }),
        h('dt', { text: 'Product' }), h('dd', { text: b.product }),
        b.voided ? [h('dt', { text: 'Voided' }), h('dd', {}, `${b.voided.reason}, ${when(b.voided.at)}. Reprinted as `, other(b.voided.reprint) ?? 'not yet', ' with the same ads.')] : null,
        b.reprintOf ? [h('dt', { text: 'Reprint of' }), h('dd', {}, other(b.reprintOf), ' (its label came out wrong)')] : null,
        b.box ? [h('dt', { text: 'Box' }), h('dd', { text: `#${b.box.boxNumber} · ${b.box.address}${b.box.area ? ` · ${b.box.area}` : ''} · ${{ composed: 'being made', box_printed: 'printed, waiting for its check', mismatch: 'needs its check again', verified: 'checked', sealed: 'sealed', loaded: 'on the van', delivered: 'delivered', returned: 'came back' }[b.box.status] ?? W.status(b.box.status)}` })] : [h('dt', { text: 'Box' }), h('dd', { text: 'Not in a delivery box (handed out at a machine, or a custom bottle).' })],
        d ? [h('dt', { text: 'Drop' }), h('dd', {}, d.status === 'delivered' ? `Delivered ${when(d.at)} (night of ${W.day(d.night)}, stop ${d.stop})${d.atAddressBy === 'driver' ? ', driver confirmed the address' : ''}` : d.status === 'not_delivered' ? `Not delivered: ${d.reason ?? ''}` : `Planned for the night of ${W.day(d.night)}, stop ${d.stop}`,
          d.photo ? [' · ', h('button', { class: 'linkish', type: 'button', onclick: () => openDropPhoto(d.photo.id) }, 'Photo at the door'), d.photo.location === 'unverified' ? h('span', { class: 'pill warn', text: 'unverified location' }) : null] : d.withoutPhoto ? ` · no photo, vouched for by the team: ${d.withoutPhoto.reason}` : '')] : null),
      b.custom ? h('p', { style: 'margin:0', text: 'A custom bottle: no ads on it.' }) : h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Piece', 'Size', 'Ad', ''].map((x) => h('th', { text: x })))),
        h('tbody', {}, b.ads.map((a) => h('tr', {}, h('td', { text: String(a.slot + 1) }), h('td', { text: a.size }), h('td', {}, h('b', { text: a.advertiser }), a.ad ? ` · ${a.ad}` : ''), h('td', {}, a.paid ? h('span', { class: 'pill ok', text: 'Paid' }) : h('span', { style: 'color:var(--muted);font-size:13px', text: a.unsold ? `Unsold space: ${a.unsold}` : 'Free' })))))) ));
  }

  // ---------- reprint a bad label from the packing check ----------
  /** A phone-sized sheet over the page; returns a function that closes it. */
  function sheet(title, ...content) {
    const wrap = h('div', { class: 'sheet-wrap', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e) => { if (e.target === wrap) close(); } },
      h('div', { class: 'sheet' }, h('div', { class: 'run-head' }, h('h2', { style: 'margin:0;font-size:20px', text: title }), h('button', { class: 'btn secondary small', type: 'button', onclick: () => close() }, 'Close')), ...content));
    const close = () => wrap.remove();
    document.body.append(wrap);
    return close;
  }
  async function reprintSheet(r, s) {
    let box;
    try { box = await api('GET', `/v1/ops/packs/${encodeURIComponent(s.packId)}/bottles`); } catch (e) { return toast(e.message); }
    const typed = h('input', { class: 'input code-input', id: 'rp-code', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'B-7F3K29', 'aria-label': 'Code on the bad bottle' });
    const picks = box.bottles.map((b) => h('label', { class: 'pick-bottle' }, h('input', { type: 'checkbox', value: b.unitId, 'data-code': b.code ?? '' }), h('span', {}, h('b', { text: b.code ?? b.unitId.slice(-8) }), h('small', { text: b.ads.length ? b.ads.join(', ') : 'no ads' }))));
    const go2 = async () => {
      const chosen = picks.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
      if (typed.value.trim()) chosen.push(typed.value.trim());
      if (!chosen.length) { toast('Pick the bottle whose label came out wrong, or type its code.'); return; }
      if (!window.confirm(`Reprint ${plural(chosen.length, 'bottle', 'bottles')} for box #${box.boxNumber}? Each is printed again with exactly the same ads; the bad one is voided and never billed. Put the new one in the box and check it again.`)) return;
      try {
        const out = await api('POST', `/v1/packs/${encodeURIComponent(s.packId)}/replace`, { missingUnitIds: chosen });
        close();
        toast(out.reprinted.length ? `Reprinted ${plural(out.reprinted.length, 'bottle', 'bottles')} with the same ads. The bad one is voided: check the box again.` : 'Nothing reprinted: that code isn’t a bottle in this box.');
      } catch (e) { toast(e.message); }
      render();
    };
    const close = sheet(`Reprint a bad label · box #${box.boxNumber}`,
      h('p', { style: 'margin:0;color:var(--muted)', text: `${box.address}. Pick the bottle whose label is torn, smudged or printed wrong (its code is on the bottom line of its panel), or type the code.` }),
      box.canReprint ? null : h('div', { class: 'notice err', text: 'This box is already checked and sealed: bottles can only be reprinted before.' }),
      h('div', { class: 'pick-bottles' }, picks),
      h('div', { class: 'field' }, h('label', { for: 'rp-code', text: 'Or type the code on the bad bottle' }), typed),
      h('button', { class: 'btn wide', type: 'button', disabled: box.canReprint ? null : true, onclick: go2 }, 'Reprint with the same ads'));
  }

  // ---------- house claims the team should know about ----------
  const noticesBox = (notices) => (notices.length ? h('section', { class: 'panel-box house-notices' }, h('h2', { text: 'House claims to know about' }),
    h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: 'A house someone already claimed, claimed again by someone else; deliveries stopped by a claim only days old. Usually a new household or a second person living there; if it looks wrong, look at the house and its claims.' }),
    h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['When', 'House', 'What happened', 'Now'].map((x) => h('th', { text: x })))),
      h('tbody', {}, notices.map((n) => h('tr', {}, h('td', { text: when(n.at) }), h('td', {}, h('b', { text: n.address.split(',')[0] }), h('div', { style: 'color:var(--muted);font-size:12px', text: n.area })), h('td', {}, h('span', { class: `pill ${n.kind === 'stopped_by_new_claim' ? 'bad' : 'warn'}`, text: n.kind === 'stopped_by_new_claim' ? 'Stopped by a new claim' : 'Claimed again' }), h('div', { style: 'font-size:13px', text: n.says })), h('td', {}, h('span', { class: `pill ${HS[n.houseStatus]?.[0] ?? ''}`, text: HS[n.houseStatus]?.[1] ?? n.houseStatus })))))))) : null);

  render().catch((e) => root.replaceChildren(h('div', { class: 'notice err', text: e.message })));
})();
