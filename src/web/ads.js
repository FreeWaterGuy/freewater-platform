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
  const svgSrc = (s) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
  const toastEl = h('div', { class: 'toast', role: 'status' }); document.body.append(toastEl);
  let tt; const toast = (m) => { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove('show'), 2600); };

  const state = { token: store.get('fw_ads_token'), me: null, config: null, path: fixture ? fixture.start : location.pathname };
  async function api(method, url, body) {
    if (fixture) return fixture.api(method, url, body);
    const res = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { state.token = null; state.me = null; store.set('fw_ads_token', null); }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error?.message || 'Something went wrong. Try again.'); e.status = res.status; e.code = data?.error?.code; throw e; }
    return data;
  }

  // ---------- routing ----------
  const routes = [
    [/^\/ads\/?$/, overview], [/^\/ads\/new$/, newAd], [/^\/ads\/drafts\/([\w-]+)$/, builder], [/^\/ads\/drafts\/([\w-]+)\/review$/, review],
    [/^\/ads\/campaigns\/([\w-]+)\/change$/, changeAd], [/^\/ads\/billing$/, billing], [/^\/ads\/tracking$/, tracking], [/^\/ads\/redeem(?:\/([\w-]+))?$/, redeem],
  ];
  let cleanup = null;
  function go(path, replace) { state.path = path; if (!fixture) history[replace ? 'replaceState' : 'pushState'](null, '', path); render(); }
  window.addEventListener('popstate', () => { state.path = location.pathname; render(); });
  const link = (path, attrs, ...kids) => h('a', { href: fixture ? '#' : path, ...attrs, onclick: (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(path); } }, ...kids);
  async function render() {
    if (cleanup) { cleanup(); cleanup = null; }
    if (!(await signedIn())) return;
    for (const [re, fn] of routes) { const m = re.exec(state.path); if (m) { try { await fn(...m.slice(1)); } catch (e) { shell('', h('div', { class: 'notice err', text: e.message })); } window.scrollTo(0, 0); return; } }
    go('/ads', true);
  }
  function shell(active, ...content) {
    const me = state.me;
    root.replaceChildren(h('div', { class: 'shell' },
      h('aside', { class: 'side' },
        h('div', { class: 'logo', 'aria-label': 'FreeWater Ads' }, h('span', { text: 'free' }), h('span', { text: 'water' }), h('small', { text: 'Ads' })),
        h('nav', { 'aria-label': 'Main' },
          link('/ads', { 'aria-current': active === 'overview' ? 'page' : null }, icon(I.chart), 'Overview'),
          link('/ads/new', { 'aria-current': active === 'new' ? 'page' : null }, icon(I.plus), 'New ad'),
          link('/ads/tracking', { 'aria-current': active === 'tracking' ? 'page' : null }, icon(I.target), 'Sales tracking'),
          link('/ads/redeem', { 'aria-current': active === 'redeem' ? 'page' : null }, icon(I.ticket), 'Check a coupon'),
          link('/ads/billing', { 'aria-current': active === 'billing' ? 'page' : null }, icon(I.card), 'Billing')),
        h('div', { class: 'who' }, h('b', { text: state.business?.name ?? '' }), me?.email || me?.phone || '', h('br'), h('button', { type: 'button', onclick: async () => { try { await api('POST', '/v1/auth/sign-out'); } catch {} state.token = null; state.me = null; state.business = null; store.set('fw_ads_token', null); render(); } }, 'Sign out'))),
      h('main', { class: 'main' }, ...content)));
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
        h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); err.hidden = true; try { const r = await api('POST', '/v1/auth/verify', { companyId: state.config.companyId, channel: 'email', to, code: input.value.trim() }); state.token = r.token; store.set('fw_ads_token', r.token); state.me = null; render(); } catch (x) { err.textContent = x.message; err.hidden = false; } } },
          input, err, h('button', { class: 'btn wide', type: 'submit' }, 'Sign in')),
        h('button', { class: 'btn secondary', type: 'button', onclick: step1 }, 'Use a different email'));
      input.focus();
    };
    step1();
  }
  function setupScreen() {
    const name = h('input', { class: 'input', id: 's-name', placeholder: 'Tito’s Tacos', autocomplete: 'organization' });
    const cat = h('select', { class: 'input', id: 's-cat' }, ['Food and drink', 'Coffee', 'Real estate', 'Fitness', 'Health', 'Retail', 'Pets', 'Events', 'Auto', 'News', 'Services'].map((c) => h('option', { value: c.toLowerCase().replace(/ and /g, '-').replace(/\s+/g, '-'), text: c })));
    const site = h('input', { class: 'input', id: 's-site', placeholder: 'https://', type: 'url' });
    const err = h('div', { class: 'notice err', hidden: true });
    root.replaceChildren(h('div', { class: 'auth' }, pitch(), h('div', { class: 'right' },
      h('h2', { style: 'font:700 26px/1.2 var(--display);margin:0', text: 'Tell us about your business' }),
      h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => {
        e.preventDefault(); err.hidden = true;
        try { await api('POST', '/v1/advertisers', { businessName: name.value.trim(), category: cat.value === 'food-drink' ? 'food' : cat.value, ...(site.value.trim() ? { website: site.value.trim() } : {}) }); state.me = null; go('/ads/new'); }
        catch (x) { err.textContent = x.message; err.hidden = false; }
      } }, h('div', { class: 'field' }, h('label', { for: 's-name', text: 'Business name' }), name), h('div', { class: 'field' }, h('label', { for: 's-cat', text: 'What you do' }), cat), h('div', { class: 'field' }, h('label', { for: 's-site', text: 'Website (optional)' }), site), err, h('button', { class: 'btn wide', type: 'submit' }, 'Start making my ad')))));
    name.focus();
  }

  // ---------- sales tracking: the tag, server reporting, and what it found ----------
  async function tracking() {
    const t = await api('GET', '/v1/ads/tracking');
    const s = t.summary;
    const copyBtn = (text) => h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select it and copy it'); } } }, 'Copy');
    const codeBox = (text) => h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, h('pre', { class: 'snippet', text }), h('div', {}, copyBtn(text)));
    const domains = h('input', { class: 'input', id: 't-domains', value: t.domains.join(', '), placeholder: 'joesburgers.com, order.joesburgers.com' });
    const kpi = (label, value, sub, dark) => h('div', { class: `kpi${dark ? ' dark' : ''}` }, h('span', { text: label }), h('b', { text: value }), sub ? h('small', { text: sub }) : null);
    shell('tracking',
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Sales tracking' }), h('p', { text: `Every sale that came from your ads, matched to the exact bottle. Last 30 days.` }))),
      h('div', { class: 'kpis' },
        kpi('Taps on your links', num(s.clicks), 'each gets its own click id', true),
        kpi('Sales from bottles', num(s.sales.count), `${s.sales.bySource.tag} website · ${s.sales.bySource.server} your server · ${s.sales.bySource.coupon} at the counter`),
        kpi('Those sales', dollars(s.sales.valueCents), 'what customers spent'),
        kpi('Commission', dollars(s.sales.commissionCents), 'on your invoice'),
        kpi('Coupons used', `${num(s.coupons.redeemed)}/${num(s.coupons.issued)}`, 'used / given out')),
      h('div', { class: 'review', style: 'max-width:900px' },
        h('section', { class: 'panel', style: 'gap:10px' }, h('h2', { class: 'section', text: '1. Add our tag to your website' }),
          h('p', { style: 'margin:0', text: 'Put this on every page, just before </head>. It remembers when someone arrived from one of your bottles.' }), codeBox(t.install.everyPage),
          h('p', { style: 'margin:0', text: 'On your order confirmation page, report the sale with your order number and the amount:' }), codeBox(t.install.orderConfirmation),
          h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: `It only reports sales from people who came from a bottle in the last ${t.clickWindowDays} days, or who used one of your FreeWater coupons. Nothing about your other customers is sent.` })),
        h('section', { class: 'panel', style: 'gap:10px' }, h('h2', { class: 'section', text: '2. Say which websites are yours' }),
          h('form', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end', onsubmit: async (e) => { e.preventDefault(); try { await api('POST', '/v1/ads/tracking/domains', { domains: domains.value.split(/[\s,]+/).filter(Boolean) }); toast('Saved. Your tag now reports from these sites.'); } catch (x) { toast(x.message); } } },
            h('div', { class: 'field', style: 'flex:1;min-width:240px' }, h('label', { for: 't-domains', text: 'Your websites' }), domains), h('button', { class: 'btn', type: 'submit' }, 'Save')),
          h('p', { style: 'margin:0;color:var(--muted);font-size:14px', text: 'Sales reported from anywhere else are refused, so nobody can report sales in your name.' })),
        h('section', { class: 'panel', style: 'gap:10px' }, h('h2', { class: 'section', text: 'Or report sales from your server' }),
          h('p', { style: 'margin:0', text: 'Send the fwclid your site received (or the coupon code), your order number and the amount. Ask us for a server key.' }),
          codeBox(`curl ${location.origin}/v1/conversions \\\n  -H "Authorization: Bearer YOUR_SERVER_KEY" -H "Content-Type: application/json" \\\n  -d '{ "fwclid": "FWC…", "orderId": "A-10442", "valueCents": 1250 }'`)),
        h('section', { class: 'panel', style: 'gap:10px' }, h('h2', { class: 'section', text: '3. At the counter' }),
          h('p', { style: 'margin:0', text: 'Each customer gets their own one-time coupon with a code to scan. Scan it with your phone’s camera, or type it in. You’ll see at once if it’s real and unused, and screenshots can’t be used twice.' }),
          h('div', {}, link('/ads/redeem', { class: 'btn' }, 'Check a coupon'))),
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

  // ---------- overview ----------
  const statusText = { running: 'Running', in_review: 'In review', paused: 'Paused', finished: 'Finished', not_approved: 'Needs changes' };
  async function overview() {
    const o = await api('GET', '/v1/ads/overview?days=14');
    state.business = o.advertiser;
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
      h('p', { style: 'color:var(--muted);font-size:13px;margin-top:22px', text: `You pay ${Object.entries(o.prices.perPrintCents).map(([s, c]) => `${cents(c)} for ${s}/6`).join(', ')} of a label per bottle printed, ${cents(o.prices.perScanCents)} per scan that loads, ${cents(o.prices.perArLaunchCents)} per AR launch, and ${o.prices.commissionPercent}% of sales. Repeat scans and failed prints are free.` }));
  }
  function campaignCard(c) {
    const r = c.results;
    const actions = [];
    if (c.status === 'running') actions.push(h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { await api('PATCH', `/v1/campaigns/${c.id}`, { active: false }); toast('Paused'); render(); } }, 'Pause'));
    if (c.status === 'paused') actions.push(h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await api('PATCH', `/v1/campaigns/${c.id}`, { active: true }); toast('Running again'); render(); } catch (x) { toast(x.message); } } }, 'Resume'));
    if (c.editable && c.status !== 'in_review') actions.push(link(`/ads/campaigns/${c.id}/change`, { class: 'btn small secondary' }, 'Change it'));
    const budget = c.budget.type === 'guaranteed' ? `${num(c.budget.bottlesLeft)} bottles left` : `${dollars(c.budget.dailyCapCents)} a day`;
    return h('article', { class: 'camp' },
      h('div', { class: 'thumb' }, h('img', { src: svgSrc(c.thumbSvg), alt: `Your ad: ${c.name}` })),
      h('div', {},
        h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px' }, h('span', { class: `status ${c.status}`, text: statusText[c.status] })),
        h('h3', { text: c.name }),
        h('div', { class: 'meta', text: `${c.where === 'all' ? 'Every machine' : c.where.join(', ')} · ${budget} · ${c.formats.includes('box-face') ? 'bottles and boxes' : 'bottles'}` }),
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
      if (tab === 'sizes') stage.replaceChildren(h('div', { class: 'sizes' }, preview.sizes.map((s) => h('figure', {}, h('img', { src: svgSrc(s.svg), alt: `Your ad at ${s.sixths}/6 of the label` }), h('figcaption', { text: `${s.sixths}/6 of the label` })))), h('p', { class: 'caption', text: 'The same ad, laid out for each size you chose. The QR code is added in the corner when it prints.' }));
      if (tab === 'box') stage.replaceChildren(h('img', { class: 'box-img', src: svgSrc(preview.boxFaceSvg), alt: 'Your ad on the side of a delivery box' }), h('p', { class: 'caption', text: 'One side of a delivery box. Each side has its own QR code.' }));
      if (tab === 'scan') {
        frameReady = false;
        frame = fixture?.scanFrame ? fixture.scanFrame() : h('iframe', { src: '/preview/scan', title: 'Your scan page' });
        stage.replaceChildren(frame, h('p', { class: 'caption', text: 'What opens on a phone when someone scans your ad.' }));
      }
      if (tab === 'cost') {
        const e = d.estimate;
        const rows = [...Object.entries(e.perPrintCents).map(([s, c]) => [`Each bottle printed with your ad at ${s}/6`, cents(c)]), ['Each scan that loads', cents(e.perScanCents)], ['Each AR launch', cents(e.perArLaunchCents)], ['Sales from the bottle', `${e.commissionPercent}%`]];
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
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: d.campaignId ? 'Change your ad' : 'Make an ad' }), h('p', { text: `Chat with the assistant (${d.assistant}). Nothing prints until you review it and ${state.config.name} approves it.` }))),
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
    const budget = dr.buy?.type === 'guaranteed' ? `${num(dr.buy.prints)} bottles` : dr.buy ? `${dollars(dr.buy.dailyCapCents)} a day` : 'Not set';
    const submit = h('button', { class: 'btn wide', type: 'button', onclick: async () => {
      err.hidden = true;
      if (!agree.checked) { err.textContent = 'Check the box to confirm you looked it over.'; err.hidden = false; return; }
      submit.disabled = true;
      try { await api('POST', `/v1/ads/drafts/${id}/submit`, { approved: true }); done(); } catch (x) { err.textContent = x.message; err.hidden = false; submit.disabled = false; }
    } }, 'Submit for review');
    const done = () => shell('new', h('div', { class: 'review' }, h('div', { class: 'notice ok' }, h('b', { text: 'Submitted. ' }), `${state.config.name} reviews new ads, usually within a day. It starts printing as soon as it's approved, and you'll see results on your Overview.`), link('/ads', { class: 'btn' }, 'Go to Overview')));
    let frame;
    const onMsg = (e) => { if ((fixture || e.origin === location.origin) && e.data?.type === 'fw-preview-ready' && frame) frame.contentWindow.postMessage({ type: 'fw-preview', ...(p.scan ?? { doc: null }) }, fixture ? '*' : location.origin); };
    window.addEventListener('message', onMsg); cleanup = () => window.removeEventListener('message', onMsg);
    frame = fixture?.scanFrame ? fixture.scanFrame() : h('iframe', { src: '/preview/scan', title: 'Your scan page' });
    shell('new', h('div', { class: 'review' },
      h('div', { class: 'page-head', style: 'margin:0' }, h('div', {}, link(`/ads/drafts/${id}`, {}, '← Back to the chat'), h('h1', { style: 'margin-top:8px', text: 'Review your ad' }), h('p', { text: 'This is exactly what prints and what opens. Look it over before you submit.' }))),
      h('div', { class: 'stage' }, h('img', { class: 'label-img', src: svgSrc(p.labelSvg), alt: 'A sample label with your ad' })),
      h('div', { class: 'stage' }, h('div', { class: 'sizes' }, p.sizes.map((s) => h('figure', {}, h('img', { src: svgSrc(s.svg), alt: `At ${s.sixths}/6` }), h('figcaption', { text: `${s.sixths}/6` })))), p.boxFaceSvg ? h('img', { class: 'box-img', src: svgSrc(p.boxFaceSvg), alt: 'On a box' }) : null),
      h('div', { class: 'stage' }, frame),
      h('div', { class: 'facts' },
        h('div', {}, h('span', { text: 'Where' }), dr.locations === 'all' ? 'Every machine' : (dr.locations || []).join(', ')),
        h('div', {}, h('span', { text: 'Budget' }), budget),
        h('div', {}, h('span', { text: 'Prints on' }), dr.formats?.includes('box-face') ? 'Bottles and delivery boxes' : 'Bottles'),
        h('div', {}, h('span', { text: 'You pay' }), `${Object.entries(d.estimate.perPrintCents).map(([s, c]) => `${cents(c)} per ${s}/6 bottle`).join(', ')}; ${cents(d.estimate.perScanCents)} per scan; ${cents(d.estimate.perArLaunchCents)} per AR launch; ${d.estimate.commissionPercent}% of sales`)),
      h('label', { class: 'check', for: 'agree' }, agree, h('span', {}, h('b', { text: 'It looks right. ' }), 'I checked the words, colors, picture and scan page, and I have the right to use them.')),
      err, submit));
  }

  // ---------- billing ----------
  async function billing() {
    const advId = state.me.advertiserId;
    const [invoices, cards] = await Promise.all([api('GET', '/v1/invoices'), api('GET', `/v1/advertisers/${advId}/cards`).catch(() => [])]);
    shell('billing',
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Billing' }), h('p', { text: 'Invoices list every print, scan, AR launch and sale they charge for.' }))),
      h('h2', { class: 'section', text: 'Card' }),
      cards.length ? h('p', { text: `${cards[0].brand} •••• ${cards[0].last4}, charged automatically when an invoice is made.` })
        : h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px' }, h('span', { style: 'background:#FFF4D6;color:#7A5300;border-radius:6px;padding:1px 6px;font-size:12px;font-weight:700', text: 'Test mode' }), 'Add a test card:', ...[['tok_visa', 'Visa 4242'], ['tok_amex', 'Amex 0005']].map(([t, l]) => h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { await api('POST', `/v1/advertisers/${advId}/cards`, { token: t }); toast('Card saved'); render(); } }, l))),
      h('h2', { class: 'section', style: 'margin-top:22px', text: 'Invoices' }),
      invoices.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ['Up to', 'Lines', 'Total', 'Status', ''].map((x) => h('th', { text: x })))),
        h('tbody', {}, invoices.map((i) => h('tr', {}, h('td', { text: new Date(i.periodEnd).toLocaleDateString() }), h('td', { text: String(i.lines) }), h('td', { text: dollars(i.totalCents) }), h('td', { text: { open: 'Open', paid: 'Paid', failed: 'Card declined' }[i.status] || i.status }),
          h('td', {}, i.status !== 'paid' && cards.length ? h('button', { class: 'btn small', type: 'button', onclick: async () => { await api('POST', `/v1/invoices/${i.id}/pay`); toast('Paid'); render(); } }, 'Pay now') : null))))))
        : h('div', { class: 'empty', text: 'No invoices yet. They’re made from what your ads actually did: prints that printed, scans that loaded, and sales.' }));
  }

  render();
})();
