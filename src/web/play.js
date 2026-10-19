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
    if (st.cameTrue?.length && st.canPlay) { toast(`Your pick came true: ${st.cameTrue[0].item}! Look in your wallet.`); }
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
    if (r.kind === 'tap') return tapRound(r);
    if (r.kind === 'ar') return arRound(r);
    const shownAt = performance.now();
    let picked = null, changes = 0;
    const chip = h('span', { class: `chip ${r.realness.kind === 'real' ? 'real' : r.realness.kind === 'may_come_true' ? 'maybe' : ''}`, text: r.realness.text });
    const cards = r.items.map((it) => {
      const card = r.kind === 'ad'
        ? h('button', { type: 'button', class: 'card ad', 'aria-pressed': 'false' }, h('img', { alt: `Ad for ${it.label}`, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(it.svg)}` }), h('div', { class: 'name', text: it.label }))
        : h('button', { type: 'button', class: `card${it.photo ? ' has-photo' : ''}`, 'aria-pressed': 'false' },
          it.photo ? h('figure', { class: 'photo' }, h('img', { src: it.photo.url, alt: it.label, loading: 'eager' }), it.photo.credit ? h('figcaption', { text: `Photo: ${it.photo.credit}${it.photo.license ? ` (${it.photo.license})` : ''}` }) : null) : null,
          h('div', {}, it.brand && !it.name.toLowerCase().startsWith(it.brand.toLowerCase()) ? h('div', { class: 'brand', text: it.brand }) : null, h('div', { class: 'name', text: it.name })), it.price ? h('div', { class: `price ${it.price === '$0' ? 'zero' : it.setup || ''}`, text: it.price }) : null);
      card.addEventListener('click', () => {
        if (picked && picked !== it.key) changes++;
        picked = it.key;
        for (const c of cards) { c.classList.toggle('on', c === card); c.setAttribute('aria-pressed', String(c === card)); }
        go.disabled = false;
        // One tap answers: a moment to change your mind, then it's in. (Ads wait for "Next", in case you say why.)
        if (!r.askWhy) { clearTimeout(autoGo); autoGo = setTimeout(() => go.click(), 650); }
      });
      return card;
    });
    const why = r.askWhy ? h('label', { class: 'field why' }, 'Why that one? (optional, earns extra)', h('textarea', { maxlength: '500', placeholder: 'What made it stand out?' })) : null;
    let autoGo, sent = false;
    const go = h('button', { type: 'button', class: `btn${r.askWhy ? '' : ' hidden'}`, disabled: true, text: 'Next' });
    go.addEventListener('click', async () => {
      if (sent) return; sent = true;
      go.disabled = true;
      try {
        const a = await api('POST', `${base}/answer`, { viewerKey, round: r.id, pick: picked, changes, responseMs: Math.round(performance.now() - shownAt), ...(why && why.querySelector('textarea').value.trim() ? { why: why.querySelector('textarea').value.trim() } : {}) });
        if (a.points) { balance += a.points; showPoints(true); }
        if (a.streak !== undefined) setStreak(a.streak);
        if (a.bonus) toast(`Streak bonus! +${a.bonus}`); else if (a.early && a.points) toast(`+${a.points} · You’re one of the first to pick here`); else if (a.points) toast(`+${a.points}`); else if (a.note) toast(a.note);
        // The reveal: how everyone else picked.
        if (a.others) {
          r.items.forEach((it, i) => { const pct = a.others[it.key]; if (pct === undefined) return; cards[i].append(h('div', { class: `reveal${it.key === picked ? ' mine' : ''}` }, h('b', { text: `${pct}%` }), h('span', { text: it.key === picked ? 'picked this too' : 'picked this' }))); });
          await new Promise((ok) => setTimeout(ok, 1300));
        }
        next();
      } catch (e) { if (e.status === 409 || e.status === 410) return next(); sent = false; go.disabled = false; toast(e.message); }
    });
    show(h('div', { class: 'meta' }, h('span', { class: 'chip', text: r.category }), chip), streakBar(), h('h2', { text: r.ask }), h('div', { class: `grid${r.items.length === 2 && r.kind !== 'ad' ? '' : ''}` }, cards), why, go,
      h('div', { class: 'links' }, h('button', { type: 'button', class: 'linkish', text: 'Send feedback', onclick: openFeedback }), h('button', { type: 'button', class: 'linkish', text: 'Stop playing', onclick: stop })));
  }

  // ---------- streaks ----------
  let streak = 0;
  const streakEl = h('div', { class: 'streak' });
  function setStreak(n) { streak = n; renderStreak(); }
  function renderStreak() {
    const into = streak % 10;
    streakEl.replaceChildren(h('span', { class: 'streak-n', text: streak ? `${streak} in a row today` : 'Every 10 picks: a bonus' }), h('div', { class: 'bar' }, ...Array.from({ length: 10 }, (_, i) => h('i', { class: i < into || (streak && into === 0) ? 'on' : '' }))));
  }
  function streakBar() { renderStreak(); return streakEl; }

  // Tap the QR: the label shows, and its code pops up somewhere for a moment. Tap it before it's gone.
  function tapRound(r) {
    const it = r.items[0], t = it.target;
    const stage = h('div', { class: 'tap-stage', role: 'button', 'aria-label': 'Tap the code when it appears' }, h('img', { alt: `A bottle label for ${it.label}`, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(it.svg)}` }));
    const code = h('div', { class: 'tap-code', 'aria-hidden': 'true', style: `left:${(t.x - t.size / 2) * 100}%;top:${(t.y - (t.size * 0.75) / 2) * 100}%;width:${t.size * 100}%` });
    for (let i = 0; i < 25; i++) code.append(h('i', { class: [0, 1, 2, 3, 4, 5, 9, 10, 14, 15, 19, 20, 21, 22, 23, 24, 12, 7, 17].includes(i) ? 'on' : '' }));
    let appearedAt = 0, done = false;
    const send = async (tap) => {
      if (done) return; done = true;
      try {
        const a = await api('POST', `${base}/answer`, { viewerKey, round: r.id, pick: 'k0', ...(tap ? { tap } : {}), responseMs: tap ? Math.round(tap.tMs) : 0 });
        if (a.points) { balance += a.points; showPoints(true); }
        if (a.streak !== undefined) setStreak(a.streak);
        toast(a.hit ? `Got it! +${a.points}` : 'Missed it. Next one!');
        setTimeout(next, 900);
      } catch (e) { if (e.status === 409 || e.status === 410) return next(); toast(e.message); }
    };
    stage.addEventListener('pointerdown', (e) => {
      if (!appearedAt) return;
      const b = stage.getBoundingClientRect();
      send({ x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height, tMs: performance.now() - appearedAt });
    });
    setTimeout(() => { stage.append(code); appearedAt = performance.now(); setTimeout(() => { code.remove(); if (!done) send(null); }, t.showMs); }, t.delayMs);
    show(h('div', { class: 'meta' }, h('span', { class: 'chip', text: r.category })), streakBar(), h('h2', { text: r.ask }), stage, h('p', { class: 'after', text: 'Like scanning a real bottle, only faster.' }));
  }

  // In 3D: turn each one around (on a phone, place it in your room), then pick.
  function arRound(r) {
    const shownAt = performance.now();
    let spinMs = 0, spinStart = 0;
    const views = r.items.map((it) => {
      const mv = document.createElement('model-viewer');
      for (const [k, v] of Object.entries({ src: it.model, 'ios-src': it.ios, alt: it.label, 'camera-controls': '', 'auto-rotate': '', ar: '', 'ar-modes': 'webxr scene-viewer quick-look', 'touch-action': 'pan-y', 'shadow-intensity': '1' })) mv.setAttribute(k, v);
      mv.addEventListener('pointerdown', () => { spinStart = performance.now(); });
      mv.addEventListener('pointerup', () => { if (spinStart) spinMs += performance.now() - spinStart; spinStart = 0; });
      const pickBtn = h('button', { type: 'button', class: 'btn', text: `This one: ${it.label}` });
      pickBtn.addEventListener('click', async () => {
        try {
          const a = await api('POST', `${base}/answer`, { viewerKey, round: r.id, pick: it.key, responseMs: Math.round(performance.now() - shownAt), spinMs: Math.round(spinMs) });
          if (a.points) { balance += a.points; showPoints(true); toast(`+${a.points}`); }
          if (a.streak !== undefined) setStreak(a.streak);
          next();
        } catch (e) { if (e.status === 409 || e.status === 410) return next(); toast(e.message); }
      });
      return h('div', { class: 'ar-card' }, mv, pickBtn);
    });
    show(h('div', { class: 'meta' }, h('span', { class: 'chip', text: r.category })), streakBar(), h('h2', { text: r.ask }), h('div', { class: 'ar-grid' }, views), h('p', { class: 'after', text: 'Drag to turn them. On a phone, tap the cube icon to see one in your room.' }));
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
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,video/mp4' });
    const send = h('button', { type: 'button', class: 'btn', text: 'Send' });
    const s = sheet(h('h2', { text: 'Tell us anything' }), h('label', { class: 'field' }, 'Your message', text), h('label', { class: 'field' }, 'Add a picture, screenshot or short video (optional)', file), send);
    send.addEventListener('click', async () => {
      send.disabled = true;
      try {
        const f = file.files && file.files[0];
        if (f && f.type === 'video/mp4') {
          if (f.size > 30 * 1024 * 1024) throw new Error('Videos can be up to 30 MB.');
          const res = await fetch(`${base}/feedback/video?viewer=${encodeURIComponent(viewerKey)}&text=${encodeURIComponent(text.value)}`, { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: f });
          const r = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(r?.error?.message || 'Couldn’t send that video.');
          s.remove(); if (r.points) { balance += r.points; showPoints(true); } toast(r.points ? `Thanks! +${r.points}` : 'Thanks!');
          return;
        }
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
        h('p', { class: 'notice', text: w.points.terms }),
        await offersBlock());
    } catch (e) { toast(e.message); }
  }
  // Brand offers: claim with points, buy it anywhere listed, send the receipt.
  async function offersBlock() {
    let o;
    try { o = await api('GET', `/v1/public/offers/${encodeURIComponent(companyId)}?viewer=${encodeURIComponent(viewerKey)}`); } catch { return null; }
    if (!o.offers.length && !o.mine.length) return null;
    const box = h('div', { class: 'offers' }, h('h3', { text: 'Offers' }));
    for (const of of o.offers) {
      const btn = h('button', { type: 'button', class: 'btn', text: of.pointsCost ? `Claim for ${of.pointsCost} points` : 'Claim' });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { const r = await api('POST', `/v1/public/offers/${encodeURIComponent(companyId)}/${of.id}/claim`, { viewerKey }); balance -= r.pointsSpent; showPoints(true); btn.textContent = 'Claimed'; toast(r.how); }
        catch (e) { btn.disabled = false; toast(e.message); }
      });
      box.append(h('div', { class: 'offer' }, of.brand ? h('div', { class: 'brand', text: of.brand }) : null, h('b', { text: of.title }), h('div', { class: 'deal', text: of.deal }), h('div', { class: 'msg', text: `At ${of.retailers.includes('any') ? 'any store' : of.retailers.join(', ')}` }), btn));
    }
    for (const c of o.mine) {
      const row = h('div', { class: 'claim' }, h('b', { text: c.title }), h('span', { class: 'msg', text: { claimed: 'Buy it, then send the receipt', receipt_sent: 'Checking your receipt', verified: 'Approved', paid: `Paid${c.cents ? ` $${(c.cents / 100).toFixed(2)}` : ''}`, rejected: 'Receipt not accepted', expired: 'Ran out' }[c.status] || c.status }));
      if (c.status === 'claimed') {
        const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': 'Receipt photo' });
        file.addEventListener('change', async () => {
          const f = file.files && file.files[0]; if (!f) return;
          try {
            if (f.size > 2 * 1024 * 1024) throw new Error('Photos can be up to 2 MB.');
            const dataBase64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(f); });
            const r = await api('POST', `/v1/public/offers/${encodeURIComponent(companyId)}/claims/${c.id}/receipt`, { viewerKey, image: { contentType: f.type, dataBase64 } });
            toast(r.note || (r.status === 'paid' ? 'Paid!' : 'Thanks!')); file.replaceWith(h('span', { class: 'msg', text: 'Receipt sent' }));
          } catch (e) { toast(e.message); }
        });
        row.append(h('label', { class: 'field' }, 'Receipt photo', file));
      }
      box.append(row);
    }
    return box;
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
