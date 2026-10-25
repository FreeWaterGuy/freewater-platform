// A company's public transparency page (src/modules/transparency/page.ts): who it is, how the free bottle is paid for,
// giving, ads, data, AI, proof and contact. No sign-in. Every word and colour is the company's own; the company is the
// one the address names (?company=) or the one this web address belongs to (its own domain or platform address).
(() => {
  'use strict';
  const fixture = window.__FW_TRANSPARENCY_FIXTURE__;
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
  const money = (c) => (Math.abs(c) < 100 ? `${c}¢` : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  async function api(url, opts) {
    if (fixture) return fixture.api(url, opts);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => null);
    if (!res.ok) { const err = new Error(data?.error?.message || 'Something went wrong.'); err.status = res.status; throw err; }
    return data;
  }
  const param = (k) => new URLSearchParams(fixture ? fixture.search : location.search).get(k);
  const card = (title, ...kids) => h('section', { class: 'card' }, h('h2', { text: title }), ...kids);
  const list = (items) => h('ul', {}, items.map((t) => h('li', { text: t })));

  function optOut(url) {
    const input = h('input', { type: 'text', autocomplete: 'street-address', placeholder: 'Street address', 'aria-label': 'Street address' });
    const note = h('p', { class: 'sub', role: 'status' });
    return h('form', { class: 'tp-optout', onsubmit: async (e) => {
      e.preventDefault();
      try { const r = await api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: input.value.trim() }) }); note.textContent = r.note || 'Done.'; } catch (x) { note.textContent = x.message; }
    } }, input, h('button', { class: 'btn', type: 'submit' }, 'Say no for this address'), note);
  }

  async function render() {
    let id = param('company');
    if (!id || !/^[a-z0-9-]{2,40}$/.test(id)) id = (await api('/v1/public/app-config')).companyId;
    let p;
    try { p = await api(`/v1/public/companies/${encodeURIComponent(id)}/transparency`); } catch (e) {
      root.replaceChildren(h('main', { class: 'wrap' }, h('h1', { class: 'lead', text: e.status === 404 ? 'This page isn’t published' : 'This page can’t be shown right now' }), h('p', { class: 'sub', text: e.status === 404 ? 'This company doesn’t publish a transparency page.' : e.message })));
      return;
    }
    document.title = `How ${p.company} works`;
    const b = p.brand;
    const g = p.giving;
    root.replaceChildren(
      h('header', { class: 'top' }, h('div', { class: 'wrap' },
        h('span', { class: 'tp-brand', style: `background:${b.panelColor};color:${b.textColor}`, 'aria-label': p.company }, h('span', { text: b.logoTop }), h('span', { text: b.logoBottom, style: `color:${b.accentColor}` })),
        h('nav', { class: 'tabs', 'aria-label': 'More' }, p.proof.openBooks ? h('a', { href: p.proof.openBooks, text: 'Open books' }) : null, p.proof.dailyProof ? h('a', { href: p.proof.dailyProof, text: 'Daily proof' }) : null))),
      h('main', { class: 'wrap' },
        h('div', { class: 'eyebrow', text: 'Transparency' }),
        h('h1', { class: 'lead', text: `How ${p.company} works` }),
        h('p', { class: 'sub', text: p.about.join(' ') }),
        h('div', { class: 'tp-sections' },
          card('How your bottle is paid for', list(p.paid)),
          card('Giving', h('p', { text: g.line }), g.totals ? h('div', {},
            h('div', { class: 'ledger-row' }, h('span', { text: 'Given so far' }), h('b', { text: money(g.totals.givenCents) })),
            h('div', { class: 'ledger-row' }, h('span', { text: 'Sent to charities' }), h('b', { text: money(g.totals.sentCents) })),
            h('div', { class: 'ledger-row' }, h('span', { text: 'Owed, sent with the next transfer' }), h('b', { text: money(g.totals.owedCents) })),
            g.totals.byCharity.map((c) => h('div', { class: 'ledger-row' }, h('span', { text: c.name }), h('b', { text: money(c.givenCents) })))) : null,
            h('p', { class: 'sub', text: g.note })),
          card('How ads are chosen', list(p.ads)),
          card('Your data', list(p.data.kept.map((k) => `${k.what}: ${k.consent.toLowerCase()}, kept up to ${k.keepDays} days.`)), h('p', { text: p.data.you }), h('p', { class: 'sub', text: p.data.use }),
            p.data.households ? h('div', {}, h('p', { text: p.data.households.text }), optOut(p.data.households.optOutUrl)) : null),
          card('How AI is used', list(p.ai)),
          card('Proof', h('p', { text: p.proof.text }), p.proof.openBooks ? h('p', {}, h('a', { href: p.proof.openBooks, text: 'See the open books' }), ' · ', h('a', { href: p.proof.dailyProof, text: 'Check the daily proof' })) : null,
            p.proof.fingerprintsPublished ? h('p', { class: 'sub', text: 'Each day’s fingerprint is also published where the company can’t change it.' }) : null),
          p.counters ? card('Live totals', h('div', { class: 'ledger-row' }, h('span', { text: 'Bottles' }), h('b', { text: p.counters.bottles.toLocaleString() })), h('div', { class: 'ledger-row' }, h('span', { text: 'Given' }), h('b', { text: money(p.counters.givenCents) }))) : null,
          p.switches ? card('What’s switched on', p.switches.categories.map((c) => h('div', {}, h('b', { text: c.label }), list(c.switches.map((s) => `${s.label}: ${s.on ? 'on' : 'off'}`))))) : null,
          card('Contact', p.contact.length ? list(p.contact) : h('p', { class: 'sub', text: 'Contact details are on the bottle’s panel.' })))),
      h('footer', { class: 'foot' }, h('div', { class: 'wrap', text: `Everything here comes from ${p.company}’s own settings and books.` })));
  }
  render().catch((e) => root.replaceChildren(h('main', { class: 'wrap' }, h('p', { text: e.message }))));
})();
