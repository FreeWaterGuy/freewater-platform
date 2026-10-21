// Open Books: the public site. Every bottle, every dollar: what came in, what went out, and every transfer
// to charity. Anyone can look up their bottle, and check day by day that nothing in the past was changed.
(() => {
  'use strict';
  const fixture = window.__FW_BOOKS_FIXTURE__;
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
  const sv = (tag, a, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v)); if (text !== undefined) e.textContent = text; return e; };
  const usd = (c, dec = true) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: dec ? 2 : 0, maximumFractionDigits: dec ? 2 : 0 })}`;
  const money = (c) => (Math.abs(c) < 100 && c !== 0 ? `${c}¢` : usd(c, Math.abs(c) < 1_000_000));
  const cents1 = (c) => (c < 100 ? `${c}¢` : usd(c));
  const ago = (iso) => { const s = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  const day = (d) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
  async function api(url, opts) {
    if (fixture) return fixture.api(url, opts);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => null);
    if (!res.ok) { const err = new Error(data?.error?.message || 'Something went wrong.'); err.status = res.status; err.code = data?.error?.code; throw err; }
    return data;
  }
  const params = () => new URLSearchParams(state.path.split('?')[1] || '');
  const state = { path: fixture ? fixture.start : location.pathname + location.search, company: null };
  let timer = null;
  function go(path) { state.path = path; if (!fixture) history.pushState(null, '', path); render(); }
  window.addEventListener('popstate', () => { state.path = location.pathname + location.search; render(); });
  const link = (path, attrs, ...kids) => h('a', { href: fixture ? '#' : path, ...attrs, onclick: (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(path); } }, ...kids);
  const q = () => (state.company && state.company !== 'freewater' ? `?company=${state.company}` : '');

  function page(active, ...content) {
    const tabs = [['live', '/books', 'Live totals'], ['bottle', '/books/bottle', 'Look up a bottle'], ['months', '/books/months', 'By month'], ['donations', '/books/donations', 'Donations'], ['proof', '/books/proof', 'Daily proof'], ['companies', '/books/companies', 'Open Books companies'], ['how', '/books/how', 'How we count']];
    root.replaceChildren(
      h('header', { class: 'top' }, h('div', { class: 'wrap' }, link(`/books${q()}`, { class: 'brand' }, h('b', { text: state.summary?.brand ? `${state.summary.brand.logoTop}${state.summary.brand.logoBottom}` : 'freewater' }), h('small', { text: 'Open books' })),
        h('nav', { class: 'tabs', 'aria-label': 'Open books' }, tabs.map(([id, path, label]) => link(`${path}${q()}`, { 'aria-current': active === id ? 'page' : null }, label))))),
      h('main', { class: 'wrap' }, ...content),
      h('footer', { class: 'foot' }, h('div', { class: 'wrap' }, 'Every number on this site comes straight from the books. Lines are never edited or deleted; corrections are new lines, shown here. No personal data, ever.')));
    window.scrollTo(0, 0);
  }

  async function render() {
    clearInterval(timer);
    if (stream) { stream.close(); stream = null; }
    const p = params();
    const path = state.path.split('?')[0];
    try {
      if (p.get('company')) state.company = p.get('company');
      if (!state.company) state.company = (await api('/v1/public/app-config')).companyId;
      if (path === '/books/confirm') return await confirmPage();
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored, linear; the input is this page's own path
      const m = /^\/books\/bottle(?:\/([\w-]+))?$/.exec(path) ?? /^\/r\/([\w-]+)$/.exec(path);
      if (m) return await bottlePage(m[1] || p.get('code'));
      if (path === '/books/months') return await monthsPage();
      if (path === '/books/donations') return await donationsPage();
      if (path === '/books/proof') return await proofPage();
      if (path === '/books/companies') return await companiesPage();
      if (path === '/books/how') return await howPage();
      return await livePage();
    } catch (e) {
      if (notPublic(e)) return notPublicPage();
      page('', h('div', { class: 'notice err', text: e.message }));
    }
  }
  // A company that keeps its books private answers 404 "Those books aren’t public."
  const notPublic = (e) => e?.status === 404 && /aren.t public/i.test(e.message || '');
  function notPublicPage() {
    page('', h('h1', { class: 'lead', text: 'These books aren’t public' }),
      h('p', { class: 'sub', text: 'This company doesn’t publish its books here. ' }, link('/books/companies', {}, 'See the companies that do'), '.'));
  }
  async function summary() { state.summary = await api(`/v1/public/books/${state.company}`); return state.summary; }

  // ---------- live totals ----------
  let stream = null;
  async function livePage() {
    const s = await summary();
    const t = s.totals;
    // Happening now: each bottle, sale, transfer and prize as it happens (for companies that share it).
    const nowList = h('ol', { class: 'now-list', 'aria-live': 'polite' });
    const nowCard = h('section', { class: 'card now', hidden: true }, h('div', { class: 'card-head' }, h('span', { class: 'eyebrow' }, h('i', { class: 'live-dot', 'aria-hidden': 'true' }), 'Happening now'), h('span', { class: 'num', style: 'font-size:13px;color:var(--muted)', text: 'never a name, just what happened' })), nowList);
    const nowItem = (i) => h('li', {}, h('span', { text: i.text }), h('time', { datetime: i.at, text: ago(i.at) }));
    const addNow = (i) => { nowList.prepend(nowItem(i)); while (nowList.children.length > 12) nowList.lastChild.remove(); nowCard.hidden = false; };
    if (stream) { stream.close(); stream = null; }
    if (fixture?.feed) { for (const i of [...fixture.feed].reverse()) addNow(i); }
    else if (!fixture && 'EventSource' in window) {
      stream = new EventSource(`/v1/public/companies/${encodeURIComponent(state.company)}/live`);
      stream.addEventListener('hello', (e) => { const d = JSON.parse(e.data); for (const i of [...d.items].reverse()) addNow(i); });
      stream.addEventListener('item', (e) => addNow(JSON.parse(e.data)));
      stream.onerror = () => { if (!nowList.children.length) { stream.close(); stream = null; } };
    }
    const draw = () => page('live',
      h('h1', { class: 'lead', text: 'Every bottle, every dollar. Live.' }),
      h('p', { class: 'sub', text: `What came in, what went out${s.givingOn ? ', and what went to charity' : ''}. Updated every few seconds.` }),
      h('div', { class: 'figures' },
        figure('Free bottles given', t.bottles.toLocaleString(), 'since launch'),
        s.givingOn ? figure('Given to charity', money(t.donatedCents), s.giving) : figure('Earned per bottle', cents1(s.perBottle.revenueCents), 'on average'),
        figure('Money in', money(t.revenueCents), 'ads, scans, AR, commission, custom'),
        figure('Money out', money(t.moneyOutCents), s.givingOn ? `costs, plus ${money(t.sentCents)} sent to charity` : 'every cost, line by line'),
        figure('Corrections', t.corrections.toLocaleString(), 'all public, none deleted')),
      nowCard,
      h('div', { class: 'cards' }, perBottleCard(s), monthsCard(s.monthly), feedCard(s.activity)),
      s.givingOn && s.charities.length ? h('div', { class: 'split' }, h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', text: 'Latest transfers' }), link(`/books/donations${q()}`, {}, 'Every transfer →')), transfersTable(s.transfers.slice(0, 5))), charitiesCard(s)) : null,
      lookupBox());
    draw();
    timer = setInterval(async () => { try { Object.assign(s, await summary()); const y = window.scrollY; draw(); window.scrollTo(0, y); } catch {} }, 8000);
  }
  const figure = (label, value, small) => h('div', { class: 'figure' }, h('span', { text: label }), h('b', { text: value }), h('small', { text: small || '' }));
  function perBottleCard(s) {
    const pb = s.perBottle, uc = pb.standardCosts;
    const parts = uc ? [['Spring water', uc.water, '#1F2633'], ['Aluminum bottle and cap', uc.bottle, '#4A5568'], ['Label and ink', uc.label, '#8D99A6'], ['Machine or delivery', uc.machine, '#C3CBD3'], ...(s.givingOn ? [['Charity', Math.round(pb.givingCents), '#7FC6EA']] : [])] : [];
    const used = parts.reduce((n, [, c]) => n + c, 0);
    const left = Math.round(pb.revenueCents - used);
    const total = Math.max(pb.revenueCents, used, 1);
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', text: 'Where one bottle’s money goes' }), h('span', { class: 'num', style: 'font-size:13px;color:var(--muted)', text: `earns ${cents1(Math.round(pb.revenueCents))} on average` })),
      uc ? h('div', { class: 'stack', role: 'img', 'aria-label': 'How one bottle’s money is split' }, parts.map(([name, c, color]) => h('i', { title: `${name}: ${c}¢`, style: `width:${(c / total) * 100}%;background:${color}` })), left > 0 ? h('i', { title: `Platform and people: ${left}¢`, style: `width:${(left / total) * 100}%;background:repeating-linear-gradient(135deg,#1F2633 0 4px,#fff 4px 8px)` }) : null) : null,
      parts.map(([name, c, color]) => h('div', { class: 'ledger-row' }, h('span', {}, h('i', { class: 'legend-dot', style: `background:${color}` }), name), h('b', { text: `${c}¢` }))),
      uc ? h('div', { class: 'ledger-row' }, h('span', {}, h('i', { class: 'legend-dot', style: 'background:repeating-linear-gradient(135deg,#1F2633 0 3px,#fff 3px 6px)' }), left >= 0 ? 'Platform and people' : 'Not covered yet'), h('b', { text: `${left}¢` })) : h('p', { class: 'sub', text: 'Costs per bottle aren’t published by this company.' }),
      uc ? h('p', { style: 'font-size:12px;color:var(--muted);margin:10px 0 0', text: 'Costs are standard costs per bottle; actual costs are recorded as money out.' }) : null);
  }
  function monthsCard(months) {
    const rows = months.slice(-6);
    const W = 340, H = 220, pad = 24;
    const max = Math.max(100, ...rows.flatMap((m) => [m.inCents, m.outCents]));
    const s = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Money in and out by month' });
    const bw = ((W - pad) / Math.max(1, rows.length)) / 3;
    rows.forEach((m, i) => {
      const x = pad + i * bw * 3 + bw * 0.5;
      const y = (c) => H - 22 - ((H - 40) * c) / max;
      s.append(sv('rect', { x, y: y(m.inCents), width: bw, height: H - 22 - y(m.inCents), fill: '#1F2633', rx: 2 }));
      s.append(sv('rect', { x: x + bw, y: y(m.outCents), width: bw, height: H - 22 - y(m.outCents), fill: '#8D99A6', rx: 2 }));
      s.append(sv('text', { x: x + bw, y: H - 6, 'text-anchor': 'middle' }, new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString([], { month: 'short', timeZone: 'UTC' })));
    });
    s.append(sv('text', { x: 0, y: 12 }, money(max)));
    return h('section', { class: 'card chart' }, h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', text: 'Money in vs out by month' }), h('span', { style: 'font-size:12px;color:var(--muted)' }, h('i', { class: 'legend-dot', style: 'background:#1F2633' }), 'in ', h('i', { class: 'legend-dot', style: 'background:#8D99A6;margin-left:6px' }), 'out')),
      rows.length ? s : h('p', { class: 'sub', text: 'No months yet.' }));
  }
  const feedCard = (items) => h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', text: 'Happening now' }), h('span', { style: 'font-size:12px;color:var(--muted)', text: 'No personal data, ever' })),
    h('div', { class: 'feed' }, items.slice(0, 9).map((a) => h('div', {}, h('time', { datetime: a.at, text: ago(a.at) }), h('span', { text: a.text })))),
    h('p', { style: 'margin:12px 0 0;font-size:14px' }, link(`/books/bottle${q()}`, {}, 'Have a bottle? Look up its receipt')));
  function charitiesCard(s) {
    const max = Math.max(1, ...s.charities.map((c) => c.donatedCents));
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', text: 'By charity · all time' })),
      s.charities.map((c) => h('div', { style: 'margin-bottom:12px' }, h('div', { style: 'display:flex;justify-content:space-between;gap:10px;font-size:14px' }, h('span', { text: c.name }), h('b', { class: 'num', text: money(c.donatedCents) })), h('div', { class: 'bar' }, h('i', { style: `width:${(c.donatedCents / max) * 100}%` })), h('div', { style: 'font-size:12px;color:var(--muted);margin-top:4px', text: `${money(c.sentCents)} sent · ${money(c.owedCents)} waiting for the next transfer` }))));
  }
  function transfersTable(list) {
    if (!list.length) return h('p', { class: 'sub', text: 'No transfers yet. Donations are sent once each charity’s total reaches the minimum.' });
    return h('div', { class: 'scroll' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Transfer', 'Date', 'Charity', 'Amount', 'From', 'Proof'].map((x, i) => h('th', { class: i === 3 ? 'r' : null, text: x })))),
      h('tbody', {}, list.map((t) => h('tr', {}, h('td', {}, h('code', { text: t.number })), h('td', { text: day(t.sentAt) }), h('td', { text: t.charity }), h('td', { class: 'r', text: usd(t.amountCents) }), h('td', { text: `${t.bottles.toLocaleString()} bottles` }),
        h('td', {}, h('span', { title: `Bank reference ${t.bankReference}`, class: `pill ${t.status === 'confirmed' ? 'ok' : ''}`, text: t.status === 'confirmed' ? 'Charity confirmed' : `Sent · ${t.bankReference}` })))))));
  }
  const lookupBox = () => { const input = h('input', { id: 'code', placeholder: 'Bottle code, like u_7f3a…', 'aria-label': 'Bottle code', autocomplete: 'off' }); return h('form', { class: 'lookup', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim().replace(/^.*\/r\//, ''); if (v) go(`/books/bottle/${encodeURIComponent(v)}${q()}`); } }, input, h('button', { class: 'btn', type: 'submit' }, 'Look up a bottle')); };

  // ---------- a bottle ----------
  async function bottlePage(code) {
    if (!state.summary) await summary().catch(() => null);
    if (!code) return page('bottle', h('h1', { class: 'lead', text: 'Look up a bottle' }), h('p', { class: 'sub', text: 'Scan the QR on the black panel of any bottle, or type the code under it. You’ll see exactly what that bottle earned, what it cost, and where its donation went.' }), lookupBox());
    let b;
    try { b = await api(`/v1/public/bottles/${encodeURIComponent(code)}`); } catch (e) {
      if (notPublic(e)) return page('bottle', h('h1', { class: 'lead', text: 'These books aren’t public' }), h('p', { class: 'sub', text: 'That bottle’s company doesn’t publish its books, so its numbers can’t be shown here.' }), lookupBox());
      return page('bottle', h('h1', { class: 'lead', text: 'No bottle has that code' }), h('p', { class: 'sub', text: 'Check the code under the QR on the black panel and try again.' }), lookupBox()); }
    const uc = b.standardCosts;
    const rows = (pairs) => pairs.map(([k, v]) => h('div', { class: 'ledger-row' }, h('span', { text: k }), h('b', { text: v })));
    const earned = [];
    if (b.earned.print) earned.push([`${b.ads} printed ad${b.ads === 1 ? '' : 's'}`, cents1(b.earned.print)]);
    if (b.earned.scans || b.earned.ar) earned.push(['Scans and AR launches', cents1(b.earned.scans + b.earned.ar)]);
    if (b.earned.commission) earned.push(['Commission on sales', cents1(b.earned.commission)]);
    if (b.earned.custom) earned.push(['Custom design, paid by the customer', cents1(b.earned.custom)]);
    const costTotal = uc ? uc.water + uc.bottle + uc.label + uc.machine : 0;
    page('bottle', h('div', { class: 'receipt' },
      h('div', {}, h('div', { class: 'eyebrow', text: `Open books · from ${b.company}` }), h('h1', { class: 'lead', style: 'font-size:32px', text: 'This bottle’s receipt' }), h('p', { class: 'sub', text: `${b.unitId} · printed ${new Date(b.printedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} at ${b.place}` })),
      h('section', { class: 'card' }, h('div', { class: 'eyebrow', style: 'margin-bottom:6px', text: 'What it earned' }), rows(earned.length ? earned : [['Nothing yet', '0¢']]), h('div', { class: 'ledger-row', style: 'border-top:1.5px solid var(--ink)' }, h('b', { text: 'Total earned' }), h('b', { text: cents1(b.earned.total) }))),
      uc ? h('section', { class: 'card' }, h('div', { class: 'eyebrow', style: 'margin-bottom:6px', text: 'What it cost (standard cost)' }), rows([['Spring water', `${uc.water}¢`], ['Bottle and cap', `${uc.bottle}¢`], ['Label and ink', `${uc.label}¢`], ['Machine and restock', `${uc.machine}¢`]]), h('div', { class: 'ledger-row', style: 'border-top:1.5px solid var(--ink)' }, h('b', { text: 'Total cost' }), h('b', { text: `${costTotal}¢` }))) : null,
      b.giving ? h('div', { class: 'gift' }, h('b', { text: `${cents1(b.giving.cents)} to ${b.giving.charity}` }), b.giving.transfer ? h('span', {}, `Sent ${day(b.giving.transfer.sentAt)} in transfer ${b.giving.transfer.number}, bank reference ${b.giving.transfer.bankReference}${b.giving.transfer.status === 'confirmed' ? '. The charity confirmed it arrived.' : '.'}`) : h('span', { text: 'Owed now, and sent with the next transfer once the total reaches the minimum.' })) : !b.givingOn ? h('p', { class: 'sub', text: `${b.company} doesn’t donate per bottle.` }) : null,
      h('p', { style: 'font-size:13px;color:var(--muted);margin:0', text: 'Every number above traces back to a logged print, scan or sale. Corrections show as new lines.' }),
      lookupBox()));
  }

  // ---------- by month ----------
  async function monthsPage() {
    const s = await summary();
    page('months', h('h1', { class: 'lead', text: 'Month by month' }), h('p', { class: 'sub', text: 'Money in is what advertisers and custom-bottle customers were billed. Money out is costs and transfers to charity.' }),
      h('div', { class: 'cards', style: 'grid-template-columns:1fr;margin-top:24px' }, monthsCard(s.monthly)),
      h('section', { class: 'card', style: 'margin-top:18px' }, h('div', { class: 'scroll' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Month', 'Money in', 'Money out', 'Owed to charity'].map((x, i) => h('th', { class: i ? 'r' : null, text: x })))),
        h('tbody', {}, [...s.monthly].reverse().map((m) => h('tr', {}, h('td', { text: new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: 'UTC' }) }), h('td', { class: 'r', text: usd(m.inCents) }), h('td', { class: 'r', text: usd(m.outCents) }), h('td', { class: 'r', text: usd(m.donatedCents) }))))))),
      h('section', { class: 'card', style: 'margin-top:18px' }, h('div', { class: 'eyebrow', style: 'margin-bottom:8px', text: 'Where money in came from, all time' }),
        [['Ads printed, scanned and opened in AR', s.revenueBy.adsCents], ['Commission on sales', s.revenueBy.commissionCents], ['Custom bottles', s.revenueBy.customCents]].map(([k, v]) => h('div', { class: 'ledger-row' }, h('span', { text: k }), h('b', { text: usd(v) })))));
  }

  // ---------- donations ----------
  async function donationsPage() {
    const s = await summary();
    if (!s.givingOn) return page('donations', h('h1', { class: 'lead', text: `${s.company} doesn’t donate per bottle` }), h('p', { class: 'sub', text: 'Each company on Open Books chooses whether and how much to give. Its books are public either way.' }));
    page('donations', h('h1', { class: 'lead', text: `${money(s.totals.donatedCents)} donated. Here’s every transfer.` }), h('p', { class: 'sub', text: `${s.giving}, owed the moment the bottle prints, and sent to each charity once it reaches the minimum.` }),
      h('div', { class: 'split' }, h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', text: 'Transfers · newest first' })), transfersTable(s.transfers)),
        h('div', { style: 'display:flex;flex-direction:column;gap:18px' }, charitiesCard(s),
          h('section', { class: 'card' }, h('div', { class: 'eyebrow', style: 'margin-bottom:8px', text: 'How a charity is chosen' }), h('p', { style: 'margin:0;font-size:14px', text: `Each machine and route has a charity, shown on the bottle, the app and the scan page. Waiting to be sent right now: ${money(s.totals.owedCents)}.` })))));
  }

  // ---------- daily proof ----------
  async function proofPage() {
    const days = await api(`/v1/public/books/${state.company}/days`);
    // Where each day's fingerprint was also published, out of our hands (if this company publishes them).
    let published = [];
    try { published = await api(`/v1/public/books/${state.company}/fingerprints`); } catch {}
    const pubFor = (date) => published.filter((a) => a.day === date && a.status === 'published');
    const out = h('div', {});
    const check = async (d) => {
      out.replaceChildren(h('p', { class: 'sub', text: `Checking ${d.date}…` }));
      const lines = await api(`/v1/public/books/${state.company}/days/${d.date}`);
      const text = `${d.prevHash}\n${lines.map((l) => [l.id, l.at, l.debit, l.credit, l.amountCents, l.kind].join('|')).join('\n')}`;
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      const hex = [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
      const ok = hex === d.hash;
      out.replaceChildren(h('div', { class: `notice ${ok ? 'ok' : 'err'}` }, h('b', { text: ok ? `${d.date} checks out. ` : `${d.date} doesn’t match. ` }), ok ? `Your browser just hashed all ${lines.length} lines of that day itself and got the same fingerprint we published.` : 'The lines we serve don’t add up to the fingerprint we published. Please tell us.'));
    };
    page('proof', h('h1', { class: 'lead', text: 'Proof that nothing changes' }), h('p', { class: 'sub', text: 'Each day of the books gets a fingerprint, built from every line that day and the day before’s fingerprint. If anyone changed a single past line, every fingerprint after it would change too. Write one down, check it again any time, or tap “Check” and your own browser recomputes it.' }),
      h('section', { class: 'card', style: 'margin-top:24px' }, out, h('div', { class: 'scroll' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Day', 'Lines', 'In', 'Out', 'Fingerprint', ''].map((x, i) => h('th', { class: i === 1 || i === 2 || i === 3 ? 'r' : null, text: x })))),
        h('tbody', {}, days.slice(0, 60).map((d) => h('tr', {}, h('td', { text: day(d.date) }), h('td', { class: 'r', text: String(d.lines) }), h('td', { class: 'r', text: usd(d.inCents) }), h('td', { class: 'r', text: usd(d.outCents) }), h('td', {}, h('span', { class: 'hash', text: `${d.hash.slice(0, 16)}…` }), pubFor(d.date).map((a) => a.target === 'github' && a.ref ? h('a', { class: 'pub', href: a.ref, target: '_blank', rel: 'noopener', text: 'on GitHub' }) : h('span', { class: 'pub', title: 'A Bitcoin timestamp proves this fingerprint existed by this day', text: 'Bitcoin-stamped' }))), h('td', {}, h('button', { class: 'btn light', style: 'min-height:34px;padding:4px 14px', type: 'button', onclick: () => check(d) }, 'Check')))))))));
  }

  // ---------- companies, how we count, confirmations ----------
  async function companiesPage() {
    const list = await api('/v1/public/books');
    page('companies', h('h1', { class: 'lead', text: 'Open Books companies' }), h('p', { class: 'sub', text: 'Every company that runs on this platform and publishes its books, counted the same way.' }),
      h('section', { class: 'card', style: 'margin-top:24px' }, list.map((c) => h('div', { class: 'ledger-row' }, link(`/books?company=${c.id}`, {}, c.name), h('span', { style: 'color:var(--muted)', text: c.giving ?? 'Doesn’t donate per bottle' })))));
  }
  function howPage() {
    page('how', h('div', { class: 'prose' }, h('h1', { class: 'lead', text: 'How we count' }),
      ...[
        ['Only what really happened is billed', 'An advertiser pays for a print only once the printer confirms it. A scan is billed only once its page has actually opened on a phone, and an AR launch only once the 3D model loaded. The same person scanning again within ten minutes is free. Failed prints are never billed to anyone.'],
        ['Every line is final', 'The books are double-entry: every line moves money from one account to another, and the totals always balance. Lines can only be added. A mistake, like a refunded sale, is fixed with a new line that reverses it, and that correction is counted publicly.'],
        ['Donations are owed the moment a bottle prints', 'When a bottle prints, its donation is recorded as owed to that machine’s charity. Transfers then send each charity what it’s owed, with the bank’s reference, and the charity confirms it arrived.'],
        ['No personal data', 'Nothing here names a person. Customers in the public ledger lines are replaced by codes that can’t be traced back. Businesses that advertise, and charities, are named.'],
        ['Check it yourself', 'Every day’s lines are published along with a fingerprint chained to the day before, so anyone can confirm that nothing in the past has changed.'],
      ].flatMap(([t, p]) => [h('h2', { text: t }), h('p', { text: p })])));
  }
  async function confirmPage() {
    const p = params();
    const t = await api(`/v1/public/transfers/${p.get('transfer')}`).catch(() => null);
    if (!t) return page('', h('h1', { class: 'lead', text: 'That link isn’t valid' }));
    const box = h('div', {});
    page('', h('div', { class: 'receipt' }, h('div', { class: 'eyebrow', text: 'For charities' }), h('h1', { class: 'lead', style: 'font-size:32px', text: `Did ${usd(t.amountCents)} arrive?` }),
      h('p', { class: 'sub', text: `Transfer ${t.number} to ${t.charity}, sent ${day(t.sentAt)} with bank reference ${t.bankReference}.` }), box,
      t.status === 'confirmed' ? h('div', { class: 'notice ok', text: 'Already confirmed. Thank you!' }) : h('button', { class: 'btn', type: 'button', onclick: async (e) => { e.currentTarget.disabled = true; try { await api(`/v1/public/transfers/${t.id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: p.get('token') }) }); box.replaceChildren(h('div', { class: 'notice ok', text: 'Confirmed. The public books now show it arrived. Thank you!' })); } catch (x) { box.replaceChildren(h('div', { class: 'notice err', text: x.message })); } } }, 'Yes, it arrived')));
  }

  render();
})();
