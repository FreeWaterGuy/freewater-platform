// FreeWater games: screens of two to four choices for points. Plain data in, DOM out; ads are shown as images.
(() => {
  'use strict';
  const app = document.getElementById('app');
  const params = new URLSearchParams(location.search);
  const companyId = /^[A-Za-z0-9_-]{1,60}$/.test(params.get('c') || '') ? params.get('c') : 'freewater';

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
  const base = `/v1/public/games/${encodeURIComponent(companyId)}`;
  const api = async (method, url, body) => {
    const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || 'Something went wrong'), { status: res.status, code: data?.error?.code });
    return data;
  };
  const toastEl = h('div', { class: 'toast', role: 'status' });
  document.body.append(toastEl);
  let toastTimer;
  const toast = (msg) => { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800); };

  let balance = 0, pointsName = 'Points', perRound = 0;
  const ptsEl = h('button', { type: 'button', class: 'pts', 'aria-label': 'Your points', onclick: () => openWallet() });
  const showPoints = (bump) => { ptsEl.replaceChildren(String(balance.toLocaleString('en-US')), h('small', { text: 'pts' })); if (bump) { ptsEl.classList.remove('bump'); void ptsEl.offsetWidth; ptsEl.classList.add('bump'); } };
  const top = () => h('div', { class: 'top' }, h('div', { class: 'logo' }, 'free', h('span', { text: 'water' })), ptsEl);

  // ---------- the start ----------
  async function start() {
    let st;
    try { st = await api('GET', `${base}/status?viewer=${encodeURIComponent(viewerKey)}`); } catch { return show(h('p', { class: 'msg', text: 'Couldn’t load the game. Try again in a moment.' })); }
    balance = st.points.balance; pointsName = st.points.name; perRound = st.points.perRound; showPoints();
    if (st.canPlay) return next();
    const notice = h('details', { class: 'notice' }, h('summary', { text: 'What you give and what you get' }), h('p', { text: st.notice }), h('p', { text: st.use }));
    if (st.needs === 'not_available_here' || st.needs === 'off') return show(h('h1', { text: 'Play for points' }), h('p', { class: 'lead', text: 'The games aren’t available where you are. Everything else on your bottle still works.' }));
    if (st.needs === 'too_young') return show(h('h1', { text: 'Play for points' }), h('p', { class: 'lead', text: `The games are for people ${st.minimumAge} and up. Everything else on your bottle still works.` }));
    const intro = [h('h1', { text: 'Play for points' }), h('p', { class: 'lead', text: `Pick what you’d really choose. Every answer earns ${perRound} points, whichever you pick. Nothing else is locked: AR, videos and offers work either way.` })];
    if (st.needs === 'age') {
      const input = h('input', { type: 'date', required: true, max: new Date().toISOString().slice(0, 10), 'aria-label': 'Your birthday' });
      const go = h('button', { type: 'button', class: 'btn', disabled: true, text: 'Continue' });
      input.addEventListener('input', () => { go.disabled = !input.value; });
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          const r = await api('POST', `/v1/public/data/${encodeURIComponent(companyId)}/age`, { viewerKey, birthDate: input.value });
          if (!r.ok) return show(h('h1', { text: 'Play for points' }), h('p', { class: 'lead', text: `The games are for people ${r.minimumAge} and up. Everything else on your bottle still works.` }));
          start();
        } catch (e) { go.disabled = false; toast(e.message); }
      });
      return show(...intro, h('label', { class: 'field' }, 'Your birthday', input), h('p', { class: 'msg', text: 'Only the year is kept, to check you’re old enough where you are.' }), go);
    }
    const yes = h('button', { type: 'button', class: 'btn', text: 'Yes, let’s play' });
    yes.addEventListener('click', async () => { yes.disabled = true; try { await api('POST', `${base}/join`, { viewerKey }); next(); } catch (e) { yes.disabled = false; toast(e.message); } });
    show(...intro, notice, yes, h('p', { class: 'after', text: 'Saying yes lets us keep your answers. You can stop and erase them any time.' }));
  }

  // ---------- a screen ----------
  async function next() {
    let r;
    try { r = await api('POST', `${base}/next`, { viewerKey }); } catch (e) { if (e.status === 403) return start(); return show(h('p', { class: 'msg', text: e.message })); }
    const shownAt = performance.now();
    let picked = null, changes = 0;
    const chip = h('span', { class: `chip ${r.realness.kind === 'real' ? 'real' : r.realness.kind === 'may_come_true' ? 'maybe' : ''}`, text: r.realness.text });
    const cards = r.items.map((it) => {
      const card = r.kind === 'ad'
        ? h('button', { type: 'button', class: 'card ad', 'aria-pressed': 'false' }, h('img', { alt: `Ad for ${it.label}`, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(it.svg)}` }), h('div', { class: 'name', text: it.label }))
        : h('button', { type: 'button', class: `card${it.photo ? ' has-photo' : ''}`, 'aria-pressed': 'false' },
          it.photo ? h('figure', { class: 'photo' }, h('img', { src: it.photo.url, alt: it.label, loading: 'eager' }), it.photo.credit ? h('figcaption', { text: `Photo: ${it.photo.credit}${it.photo.license ? ` (${it.photo.license})` : ''}` }) : null) : null,
          h('div', {}, it.brand && !it.name.toLowerCase().startsWith(it.brand.toLowerCase()) ? h('div', { class: 'brand', text: it.brand }) : null, h('div', { class: 'name', text: it.name })), it.price ? h('div', { class: `price ${it.setup || ''}`, text: it.price }) : null);
      card.addEventListener('click', () => {
        if (picked && picked !== it.key) changes++;
        picked = it.key;
        for (const c of cards) { c.classList.toggle('on', c === card); c.setAttribute('aria-pressed', String(c === card)); }
        go.disabled = false;
      });
      return card;
    });
    const why = r.askWhy ? h('label', { class: 'field why' }, 'Why that one? (optional, earns extra)', h('textarea', { maxlength: '500', placeholder: 'What made it stand out?' })) : null;
    const go = h('button', { type: 'button', class: 'btn', disabled: true, text: 'Next' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const a = await api('POST', `${base}/answer`, { viewerKey, round: r.id, pick: picked, changes, responseMs: Math.round(performance.now() - shownAt), ...(why && why.querySelector('textarea').value.trim() ? { why: why.querySelector('textarea').value.trim() } : {}) });
        if (a.points) { balance += a.points; showPoints(true); toast(`+${a.points} points`); } else if (a.note) toast(a.note);
        next();
      } catch (e) { if (e.status === 409 || e.status === 410) return next(); go.disabled = false; toast(e.message); }
    });
    show(h('div', { class: 'meta' }, h('span', { class: 'chip', text: r.category }), chip), h('h2', { text: r.ask }), h('div', { class: `grid${r.items.length === 2 && r.kind !== 'ad' ? '' : ''}` }, cards), why, go,
      h('div', { class: 'links' }, h('button', { type: 'button', class: 'linkish', text: 'Send feedback', onclick: openFeedback }), h('button', { type: 'button', class: 'linkish', text: 'Stop playing', onclick: stop })));
  }

  async function stop() {
    try { await api('POST', `${base}/leave`, { viewerKey }); } catch {}
    show(h('h1', { text: 'Thanks for playing' }), h('p', { class: 'lead', text: `You have ${balance.toLocaleString('en-US')} points. Nothing more is kept from the games unless you play again.` }), h('button', { type: 'button', class: 'btn ghost', text: 'Play again', onclick: start }));
  }

  // ---------- feedback, the wallet, the prompt box ----------
  function sheet(...kids) {
    const s = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'panel' }, ...kids));
    s.addEventListener('click', (e) => { if (e.target === s) s.remove(); });
    document.body.append(s);
    return s;
  }
  function openFeedback() {
    const text = h('textarea', { maxlength: '2000', placeholder: 'Ideas, problems, what you’d love for free…', rows: '5' });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    const send = h('button', { type: 'button', class: 'btn', text: 'Send' });
    const s = sheet(h('h2', { text: 'Tell us anything' }), h('label', { class: 'field' }, 'Your message', text), h('label', { class: 'field' }, 'Add a picture or screenshot (optional)', file), send);
    send.addEventListener('click', async () => {
      send.disabled = true;
      try {
        const f = file.files && file.files[0];
        if (f && f.size > 2 * 1024 * 1024) throw new Error('Pictures can be up to 2 MB.');
        const image = f ? { contentType: f.type, dataBase64: await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(f); }) } : undefined;
        const r = await api('POST', `${base}/feedback`, { viewerKey, text: text.value, ...(image ? { image } : {}) });
        s.remove();
        if (r.points) { balance += r.points; showPoints(true); }
        toast(r.points ? `Thanks! +${r.points}` : 'Thanks!');
      } catch (e) { send.disabled = false; toast(e.message); }
    });
  }
  async function openWallet() {
    try {
      const w = await api('GET', `/v1/public/wallet/${encodeURIComponent(companyId)}?viewer=${encodeURIComponent(viewerKey)}`);
      sheet(h('h2', { text: 'Your wallet' }),
        h('div', { class: 'wallet-row' }, w.points.name, h('b', { text: w.points.balance.toLocaleString('en-US') })),
        w.credit.enabled || w.credit.balanceCents ? h('div', { class: 'wallet-row' }, 'Credit', h('b', { text: `$${(w.credit.balanceCents / 100).toFixed(2)}` })) : null,
        w.coupons.length ? h('div', { class: 'wallet-row' }, 'Coupons', h('b', { text: String(w.coupons.length) })) : null,
        h('p', { class: 'notice', text: w.points.terms }));
    } catch (e) { toast(e.message); }
  }
  const answerEl = h('div');
  const askBar = (() => {
    const input = h('input', { type: 'text', maxlength: '1000', placeholder: 'Ask anything…', 'aria-label': 'Ask anything' });
    const form = h('form', {}, input, h('button', { type: 'submit', text: 'Ask' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      input.value = ''; input.disabled = true;
      answerEl.replaceChildren(h('div', { class: 'answer' }, h('b', { text: q }), 'Thinking…'));
      try {
        const r = await api('POST', `${base}/prompt`, { viewerKey, text: q });
        answerEl.replaceChildren(h('div', { class: 'answer' }, h('b', { text: q }), r.answer));
        if (r.points) { balance += r.points; showPoints(true); toast(`+${r.points}`); }
      } catch (err) { answerEl.replaceChildren(h('div', { class: 'answer', text: err.message })); }
      input.disabled = false;
    });
    return h('div', { class: 'ask-bar' }, form);
  })();
  document.body.append(askBar);

  function show(...kids) { app.replaceChildren(top(), answerEl, ...kids.filter((k) => k != null)); showPoints(); window.scrollTo(0, 0); }
  start();
})();
