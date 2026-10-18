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
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (d) => { const s = document.createElementNS(NS, 'svg'); for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v); for (const p of d.split('|')) { const e = document.createElementNS(NS, 'path'); e.setAttribute('d', p); s.append(e); } return s; };
  const I = { today: 'M3 12h4l3-8 4 16 3-8h4', review: 'M4 4h16v16H4z|M8 12l3 3 5-6', machine: 'M6 3h12v18H6z|M9 7h6|M10 17h4', route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z|M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z|M6 15V9a4 4 0 0 1 4-4h6|M18 9v6a4 4 0 0 1-4 4H8', people: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z|M2 21a7 7 0 0 1 14 0|M17 3a4 4 0 0 1 0 8|M22 21a7 7 0 0 0-5-6.7', books: 'M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z|M8 8h8|M8 12h8' };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
  const dollars = (c) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const svgSrc = (s) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
  const toastEl = h('div', { class: 'toast', role: 'status' }); document.body.append(toastEl);
  let tt; const toast = (m) => { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove('show'), 2600); };
  const S = { token: store.get('fw_ops_token'), me: null, config: null, path: fixture ? fixture.start : location.pathname + location.search };
  async function api(method, url, body) {
    if (fixture) return fixture.api(method, url, body);
    const res = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { S.token = null; S.me = null; store.set('fw_ops_token', null); }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || 'Something went wrong.');
    return data;
  }
  const routes = [[/^\/ops\/?$/, today], [/^\/ops\/review$/, reviewPage], [/^\/ops\/machines$/, machinesPage], [/^\/ops\/routes$/, routesPage], [/^\/ops\/subscriptions$/, subsPage], [/^\/ops\/books$/, booksPage]];
  let cleanup = null;
  function go(path, replace) { S.path = path; if (!fixture) history[replace ? 'replaceState' : 'pushState'](null, '', path); render(); }
  window.addEventListener('popstate', () => { S.path = location.pathname + location.search; render(); });
  const link = (path, attrs, ...kids) => h('a', { href: fixture ? '#' : path, ...attrs, onclick: (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(path); } }, ...kids);
  async function render() {
    if (cleanup) { cleanup(); cleanup = null; }
    if (!S.config) S.config = await api('GET', '/v1/public/app-config');
    if (S.token && !S.me) { try { S.me = await api('GET', '/v1/me'); } catch { S.me = null; } }
    if (!S.me) return signIn();
    if (S.me.advertiserId || S.me.role === 'consumer') return shell('', h('div', { class: 'notice err', text: 'This console is for the company’s team. Ask an owner to add you.' }));
    const pathname = S.path.split('?')[0];
    for (const [re, fn] of routes) if (re.test(pathname)) { try { await fn(); } catch (e) { shell('', h('div', { class: 'notice err', text: e.message })); } window.scrollTo(0, 0); return; }
    go('/ops', true);
  }
  function shell(active, ...content) {
    const nav = [['today', '/ops', 'Today', I.today], ['review', '/ops/review', 'Ad review', I.review], ['machines', '/ops/machines', 'Machines', I.machine], ['routes', '/ops/routes', 'Routes', I.route], ['subs', '/ops/subscriptions', 'Deliveries', I.people], ['books', '/ops/books', 'Books', I.books]];
    root.replaceChildren(h('div', { class: 'shell' },
      h('aside', { class: 'side' }, h('div', { class: 'logo', 'aria-label': 'FreeWater Ops' }, h('span', { text: 'free' }), h('span', { text: 'water' }), h('small', { text: 'Ops' })),
        h('nav', { 'aria-label': 'Main' }, nav.map(([id, path, label, ic]) => link(path, { 'aria-current': active === id ? 'page' : null }, icon(ic), label))),
        h('div', { class: 'who' }, h('b', { text: S.me.displayName || S.me.email || '' }), S.me.role, h('br'), h('button', { type: 'button', onclick: async () => { try { await api('POST', '/v1/auth/sign-out'); } catch {} S.token = null; S.me = null; store.set('fw_ops_token', null); render(); } }, 'Sign out'))),
      h('main', { class: 'main' }, ...content)));
  }
  const head = (title, sub, ...right) => h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: title }), sub ? h('p', { text: sub }) : null), right.length ? h('div', { class: 'toolbar' }, right) : null);

  function signIn() {
    let to = '';
    const right = h('div', { class: 'right' });
    root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'left' }, h('div', { class: 'logo' }, h('span', { text: 'free' }), h('span', { text: 'water' }), h('small', { text: 'Ops' })), h('h1', {}, 'Run the ', h('span', { text: 'whole thing' }), ' from here.'), h('p', { style: 'opacity:.6;margin:0', text: 'Machines, ads, routes, deliveries and the books.' })), right));
    const step1 = () => { const input = h('input', { class: 'input', id: 'o-email', type: 'email', autocomplete: 'email', placeholder: 'you@freewater.io' }); right.replaceChildren(h('h2', { style: 'font:700 26px/1.2 var(--display);margin:0', text: 'Team sign in' }), h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); to = input.value.trim(); try { await api('POST', '/v1/auth/start', { companyId: S.config.companyId, channel: 'email', to }); step2(); } catch (x) { toast(x.message); } } }, h('div', { class: 'field' }, h('label', { for: 'o-email', text: 'Work email' }), input), h('button', { class: 'btn wide', type: 'submit' }, 'Email me a code'))); input.focus(); };
    const step2 = () => { const input = h('input', { class: 'input code-input', id: 'o-code', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', 'aria-label': '6-digit code' }); right.replaceChildren(h('h2', { style: 'font:700 26px/1.2 var(--display);margin:0', text: 'Check your email' }), h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); try { const r = await api('POST', '/v1/auth/verify', { companyId: S.config.companyId, channel: 'email', to, code: input.value.trim() }); S.token = r.token; store.set('fw_ops_token', r.token); S.me = null; render(); } catch (x) { toast(x.message); } } }, input, h('button', { class: 'btn wide', type: 'submit' }, 'Sign in'))); input.focus(); };
    step1();
  }

  // ---------- today ----------
  async function today() {
    const [o, machines] = await Promise.all([api('GET', '/v1/ops/overview'), api('GET', '/v1/ops/machines').catch(() => [])]);
    const a = o.attention;
    const hot = [
      a.adsToReview && link('/ops/review', { class: 'hot' }, h('span', { text: `${a.adsToReview} ${a.adsToReview === 1 ? 'ad is' : 'ads are'} waiting for review` }), h('b', { text: 'Review →' })),
      a.printFailures && link('/ops/machines', { class: 'hot' }, h('span', { text: `${a.printFailures} failed print${a.printFailures === 1 ? '' : 's'} today (never billed)` }), h('b', { text: 'Machines →' })),
      a.pluginFailures && h('div', { class: 'hot' }, h('span', { text: `${a.pluginFailures} scan page${a.pluginFailures === 1 ? '' : 's'} fell back to the simple card recently` })),
      o.delivery.wrongBoxScans && link('/ops/routes', { class: 'hot' }, h('span', { text: `${o.delivery.wrongBoxScans} wrong box${o.delivery.wrongBoxScans === 1 ? '' : 'es'} caught at the door today` }), h('b', { text: 'Routes →' })),
    ].filter(Boolean);
    shell('today', head('Today', new Date(`${o.date}T12:00:00Z`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })),
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi dark' }, h('span', { text: 'Bottles printed' }), h('b', { text: o.bottles.printed.toLocaleString() }), h('small', { text: `${o.bottles.inPacks} in packs · ${o.bottles.custom} custom` })),
        h('div', { class: 'kpi' }, h('span', { text: 'Scans' }), h('b', { text: o.engagement.scans.toLocaleString() }), h('small', { text: `${o.engagement.arLaunches} AR launches` })),
        h('div', { class: 'kpi' }, h('span', { text: 'Earned' }), h('b', { text: dollars(o.money.revenueCents) }), h('small', { text: 'from ads and custom bottles' })),
        h('div', { class: 'kpi' }, h('span', { text: 'Given' }), h('b', { text: dollars(o.money.donatedCents) }), h('small', { text: 'to charity' })),
        h('div', { class: 'kpi' }, h('span', { text: 'Deliveries' }), h('b', { text: `${o.delivery.delivered}/${o.delivery.stops}` }), h('small', { text: `${o.delivery.routes} route${o.delivery.routes === 1 ? '' : 's'}${o.delivery.notDelivered ? ` · ${o.delivery.notDelivered} coming back` : ''}` }))),
      h('div', { class: 'grid2' },
        h('section', { class: 'panel-box' }, h('h2', { text: 'Needs attention' }), hot.length ? h('div', { class: 'attn' }, hot) : h('p', { style: 'margin:0;color:var(--muted)', text: 'Nothing right now.' })),
        h('section', { class: 'panel-box' }, h('h2', {}, 'Machines', link('/ops/machines', { style: 'font-size:14px;font-weight:500' }, 'All →')), machineTable(machines))));
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
    const drawList = () => list.replaceChildren(...queue.map((c) => h('button', { type: 'button', 'aria-current': String(c.id === current), onclick: () => { current = c.id; drawList(); show(); } }, h('b', { text: c.advertiser }), h('span', { text: `${c.name ?? c.category} · sent ${new Date(c.submittedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` }))));
    async function show() {
      if (!current) { pane.replaceChildren(h('div', { class: 'empty', text: 'No ads waiting. New ones show up here as soon as an advertiser submits them.' })); return; }
      pane.replaceChildren(h('p', { class: 'caption', text: 'Loading…' }));
      payload = await api('GET', `/v1/review/campaigns/${current}/preview`);
      const c = payload.campaign;
      const note = h('textarea', { class: 'input', id: 'r-note', placeholder: 'What needs to change? The advertiser sees this word for word.' });
      const decide = async (decision) => {
        if (decision === 'reject' && !note.value.trim()) { toast('Say what needs to change.'); note.focus(); return; }
        await api('POST', `/v1/review/campaigns/${c.id}`, { decision, ...(note.value.trim() ? { note: note.value.trim() } : {}) });
        toast(decision === 'approve' ? `Approved. ${c.advertiser} is printing.` : 'Sent back with your note.');
        queue.splice(queue.findIndex((q) => q.id === c.id), 1); current = queue[0]?.id ?? null; drawList(); show();
      };
      frame = fixture?.scanFrame ? fixture.scanFrame() : h('iframe', { src: '/preview/scan', title: 'Scan page' });
      const buy = c.buy.type === 'guaranteed' ? `${c.buy.remainingPrints.toLocaleString()} bottles` : `${dollars(c.buy.dailyCapCents)} a day`;
      pane.replaceChildren(
        h('div', { class: 'run-head' }, h('div', {}, h('h2', { style: 'margin:0;font-size:20px', text: c.name ?? c.advertiser }), h('div', { style: 'color:var(--muted)', text: `${c.advertiser} · ${c.category} · ${c.where === 'all' ? 'every machine' : c.where.join(', ')} · ${buy}` })), h('span', { class: 'pill warn', text: 'Waiting for review' })),
        h('img', { class: 'label-img', style: 'width:100%;border-radius:8px;box-shadow:0 0 0 1px var(--line)', src: svgSrc(payload.labelSvg), alt: 'The ad on a sample label' }),
        h('div', { class: 'row3' },
          h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
            h('div', { class: 'stage', style: 'min-height:0' }, h('div', { class: 'sizes' }, payload.sizes.map((s) => h('figure', {}, h('img', { src: svgSrc(s.svg), alt: `${s.sixths}/6`, style: 'height:200px' }), h('figcaption', { text: `${s.sixths}/6` })))), payload.boxFaceSvg ? h('img', { class: 'box-img', src: svgSrc(payload.boxFaceSvg), alt: 'On a box' }) : null),
            h('div', { class: 'panel-box' }, h('b', { text: 'Check' }), h('ul', { style: 'margin:0;padding-left:18px;line-height:1.8;color:var(--muted)' }, ['Words are true and legal; prices and offers are honest', 'Nothing your rules don’t allow (category, claims, images)', 'Readable at the smallest size', 'Links go where they say; the scan page works'].map((t) => h('li', { text: t })))),
            h('div', { class: 'field' }, h('label', { for: 'r-note', text: 'Note to the advertiser (needed to send it back)' }), note),
            h('div', { class: 'toolbar' }, h('button', { class: 'btn', type: 'button', onclick: () => decide('approve') }, 'Approve and start printing'), h('button', { class: 'btn secondary', type: 'button', onclick: () => decide('reject') }, 'Send back'))),
          frame));
    }
    shell('review', head('Ad review', 'Nothing prints until it’s approved here. Changes to a live ad come back here too.'), queue.length ? h('div', { class: 'queue' }, list, pane) : h('div', { class: 'empty', text: 'No ads waiting. New ones show up here as soon as an advertiser submits them.' }));
    if (queue.length) { drawList(); show(); }
  }

  // ---------- machines ----------
  async function machinesPage() {
    const [machines, failures] = await Promise.all([api('GET', '/v1/ops/machines'), api('GET', '/v1/ops/plugin-failures').catch(() => [])]);
    shell('machines', head('Machines', 'Every machine prints with the printer module set for the company. Failed prints are retried once and never billed.'),
      h('section', { class: 'panel-box' }, machineTable(machines)),
      h('section', { class: 'panel-box', style: 'margin-top:18px' }, h('h2', { text: 'Scan pages that fell back' }),
        failures.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['When', 'Experience', 'Why'].map((x) => h('th', { text: x })))), h('tbody', {}, failures.map((f) => h('tr', {}, h('td', { text: new Date(f.at).toLocaleString() }), h('td', { text: f.pluginId }), h('td', { text: f.reason }))))))
          : h('p', { style: 'margin:0;color:var(--muted)', text: 'None. Every scan page answered in time.' })));
  }

  // ---------- routes ----------
  async function routesPage() {
    const q = new URLSearchParams(S.path.split('?')[1] || '');
    const date = q.get('date') || (await api('GET', '/v1/ops/overview')).date;
    const data = await api('GET', `/v1/ops/runs?date=${date}`);
    const picker = h('input', { type: 'date', value: date, 'aria-label': 'Night', onchange: (e) => go(`/ops/routes?date=${e.target.value}`) });
    const plan = h('button', { class: 'btn', type: 'button', onclick: async () => { plan.disabled = true; plan.textContent = 'Planning and printing…'; try { const r = await api('POST', '/v1/ops/runs/plan', { date }); toast(r.length ? `${r.length} route${r.length === 1 ? '' : 's'} planned and printed` : 'Nobody is due that day'); } catch (x) { toast(x.message); } render(); } }, 'Plan and print this night');
    const stages = ['printing', 'packing', 'ready', 'out', 'done'];
    const stageName = { printing: 'Printing', packing: 'Packing check', ready: 'Ready to load', out: 'Out on the road', done: 'Done' };
    shell('routes', head('Routes', 'Everyone due that night, in driving order, with a box printed for each stop.', picker, plan),
      data.runs.length ? h('div', { style: 'display:flex;flex-direction:column;gap:16px' }, data.runs.map((r) => {
        const at = stages.indexOf(r.status);
        return h('section', { class: 'run' },
          h('div', { class: 'run-head' }, h('div', {}, h('h3', { text: `${r.routeName} · ${r.routeId.replace(/^route-/, 'Route ')}` }), h('div', { style: 'color:var(--muted);font-size:14px', text: `${r.counts.stops} stops · ${r.counts.bottles} bottles · about ${r.distanceKm} km, ${r.minutes} min · from ${r.depot?.name ?? 'the depot'}` })),
            h('div', { class: 'toolbar' }, r.status === 'packing' ? h('button', { class: 'btn small', type: 'button', onclick: async () => { try { const x = await api('POST', `/v1/ops/runs/${r.id}/pack-check`); toast(x.problems.length ? `${x.problems.length} box(es) need attention` : 'Every box checked and sealed'); } catch (e) { toast(e.message); } render(); } }, 'Run packing check') : null, r.driverId ? h('span', { class: 'pill dark', text: 'Driver assigned' }) : null)),
          h('div', { class: 'steps' }, stages.map((s, i) => h('span', { class: i < at ? 'done' : i === at ? 'on' : '', text: stageName[s] }))),
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Stop', 'Address', 'Box', 'Pack', 'Status', ''].map((x) => h('th', { text: x })))),
            h('tbody', {}, r.stops.map((s) => h('tr', {}, h('td', {}, h('b', { text: s.stopCode })), h('td', { text: s.address }), h('td', { text: `#${s.boxNumber ?? '—'}` }), h('td', { text: `${s.packSize}` }),
              h('td', {}, s.status === 'delivered' ? h('span', { class: 'pill ok', text: `Delivered${s.atAddressBy === 'driver' ? ' (driver confirmed)' : ''}` }) : s.status === 'not_delivered' ? h('span', { class: 'pill bad', text: `Not delivered: ${s.reason}` }) : h('span', { class: 'pill', text: s.packStatus === 'loaded' ? 'On the van' : s.packStatus === 'sealed' ? 'Sealed' : s.packStatus ?? 'Planned' })),
              h('td', { style: 'color:var(--muted);font-size:13px', text: s.emptiesCollected ? `${s.emptiesCollected} empties` : '' })))))));
      })) : h('div', { class: 'empty', text: 'No routes planned for this night yet. Plan and print it when the day’s orders are in.' }));
  }

  // ---------- deliveries ----------
  async function subsPage() {
    const subs = await api('GET', '/v1/ops/subscriptions');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const freq = { weekly: 'Weekly', biweekly: 'Every 2 weeks', every4weeks: 'Every 4 weeks' };
    shell('subs', head('Deliveries', `${subs.length} home${subs.length === 1 ? '' : 's'} getting packs. ${subs.reduce((n, s) => n + (s.status === 'active' ? s.packSize : 0), 0)} bottles a cycle.`),
      subs.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Customer', 'Address', 'Route', 'Pack', 'How often', 'Next', 'Status'].map((x) => h('th', { text: x })))),
        h('tbody', {}, subs.map((s) => h('tr', {}, h('td', { text: s.customer }), h('td', { text: s.address }), h('td', { text: s.routeId }), h('td', { text: `${s.packSize}` }), h('td', { text: `${freq[s.frequency]}, ${days[s.day]}` }), h('td', { text: s.nextDate ?? '—' }), h('td', {}, h('span', { class: `pill ${s.status === 'active' ? 'ok' : 'warn'}`, text: s.status === 'active' ? 'Active' : 'Paused' })))))))
        : h('div', { class: 'empty', text: 'No one has signed up for delivery yet.' }));
  }

  // ---------- books ----------
  async function booksPage() {
    const [totals, lines, preview, transfers] = await Promise.all([api('GET', `/v1/public/companies/${S.config.companyId}/totals`), api('GET', '/v1/ledger?limit=500').catch(() => []), api('GET', '/v1/payouts/preview').catch(() => null), api('GET', '/v1/payouts').catch(() => null)]);
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
        h('div', { class: 'kpi dark' }, h('span', { text: 'Bottles, all time' }), h('b', { text: totals.bottles.toLocaleString() })),
        h('div', { class: 'kpi' }, h('span', { text: 'Earned, all time' }), h('b', { text: dollars(totals.revenueCents) })),
        h('div', { class: 'kpi' }, h('span', { text: 'Given, all time' }), h('b', { text: dollars(totals.donatedCents) }))),
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

  render().catch((e) => root.replaceChildren(h('div', { class: 'notice err', text: e.message })));
})();
