// The FreeWater driver app: take a route, load the van in order, then house after house, scan the box at
// each door. A stop is only marked delivered when it's the right box at the right address.
(() => {
  'use strict';
  const fixture = window.__FW_DRIVER_FIXTURE__;
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
  const sv = (tag, a) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v)); return e; };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
  const toastEl = h('div', { class: 'toast', role: 'status', style: 'bottom:calc(150px + env(safe-area-inset-bottom))' }); document.body.append(toastEl);
  let tt; const toast = (m) => { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove('show'), 2600); };
  const S = { token: store.get('fw_driver_token'), me: null, config: null, run: null };

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
  async function api(method, url, body, raw) {
    if (fixture) return fixture.api(method, url, body);
    const res = await fetch(url, { method, headers: { ...(raw ? { 'content-type': raw.type } : body ? { 'content-type': 'application/json' } : {}), ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) }, body: raw ? raw : body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { S.token = null; store.set('fw_driver_token', null); }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error?.message || 'Something went wrong.'); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  let stop = null;
  const screen = (...kids) => { if (stop) { stop(); stop = null; } root.replaceChildren(h('main', { class: 'screen drive no-nav' }, ...kids)); window.scrollTo(0, 0); };
  const dock = (...btns) => h('div', { class: 'dock' }, h('div', { class: 'dock-inner' }, ...btns));
  const grabCard = (s, label = 'Box to grab') => h('div', { class: 'grab' }, h('div', { class: 'code' }, h('small', { text: 'Stop' }), h('b', { text: String(s.stop) })),
    h('div', { class: 'what' }, h('small', { text: s.pack ? `${label} · box ${s.pack.n} of ${s.pack.of} for this house` : label }), h('b', { text: `#${s.boxNumber} · ${s.packSize}-pack` }), h('span', { text: `Stop code ${s.stopCode} is printed small on the box corner` })));
  /** Is this switch on for the company (its Features page, or the host's FW_FEATURES)? */
  const on = (feature) => !(S.features?.off ?? []).includes(feature);
  /** A delivery area's run is named for the area and the van; a subscribers' run for its route. */
  const runName = (r) => (r.areaName ? `${r.areaName} · van ${r.van}` : `${r.routeName} · ${r.routeId.replace(/^route-/, 'Route ')}`);

  async function signOut() {
    try { if (!fixture) await api('POST', '/v1/auth/sign-out'); } catch {}
    S.token = null; S.me = null; S.run = null; store.set('fw_driver_token', null);
    toast('Signed out');
    boot();
  }
  const signOutBtn = () => h('button', { class: 'link-btn', type: 'button', onclick: signOut }, 'Sign out');

  // ---------- sign in ----------
  async function boot() {
    if (!S.config) S.config = await api('GET', '/v1/public/app-config');
    // What this company switched off (its Features page): the screens don't offer it.
    if (!S.features) S.features = await api('GET', `/v1/public/features?company=${encodeURIComponent(S.config.companyId)}`).catch(() => ({ off: [] }));
    if (S.token && !S.me) { try { S.me = await api('GET', '/v1/me'); } catch { S.me = null; } }
    if (!S.me) return signIn();
    if (!S.me.scopes?.includes('packs') && !S.me.scopes?.includes('admin')) return screen(h('h1', { class: 'dtitle', text: 'This app is for drivers' }), h('p', { class: 'dsub', text: 'Ask your manager to add you as a driver, then sign in again.' }), signOutBtn());
    return routes();
  }
  function signIn() {
    let to = '';
    const step1 = () => {
      const input = h('input', { class: 'input', id: 'd-email', type: 'email', autocomplete: 'email', placeholder: 'you@freewater.io' });
      screen(h('div', { class: 'logo big' }, h('span', { text: 'free' }), h('span', { text: 'water' })), h('h1', { class: 'dtitle', text: 'Driver sign in' }),
        h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); to = input.value.trim(); try { await api('POST', '/v1/auth/start', { companyId: S.config.companyId, channel: 'email', to }); step2(); } catch (x) { toast(x.message); } } },
          h('label', { for: 'd-email', style: 'font-weight:700', text: 'Work email' }), input, h('button', { class: 'btn', type: 'submit' }, 'Email me a code')));
    };
    const step2 = () => {
      const input = h('input', { class: 'input code-input', id: 'd-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', 'aria-label': '6-digit code' });
      screen(h('h1', { class: 'dtitle', text: 'Enter your code' }), h('p', { class: 'dsub', text: `We sent it to ${to}.` }),
        h('form', { style: 'display:flex;flex-direction:column;gap:12px', onsubmit: async (e) => { e.preventDefault(); try { const r = await withSecondStep(await api('POST', '/v1/auth/verify', { companyId: S.config.companyId, channel: 'email', to, code: input.value.trim() })); S.token = r.token; store.set('fw_driver_token', r.token); S.me = null; boot(); } catch (x) { toast(x.message); } } }, input, h('button', { class: 'btn', type: 'submit' }, 'Sign in')));
    };
    step1();
  }

  // ---------- today's routes ----------
  async function routes() {
    const runs = await api('GET', '/v1/driver/runs');
    const mine = runs.find((r) => r.driverId === S.me.id && (r.status === 'ready' || r.status === 'out'));
    if (mine) { S.run = mine; return mine.status === 'out' ? nextStop() : load(); }
    const label = { printing: 'Printing', packing: 'Being packed', ready: 'Ready to load', out: 'Out', done: 'Done' };
    screen(h('div', { class: 'dhead' }, h('div', { text: `Hi${S.me.displayName ? `, ${S.me.displayName}` : ''}` }), h('span', { text: new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) })),
      h('h1', { class: 'dtitle', text: 'Today’s routes' }),
      runs.length ? h('div', { class: 'rows' }, runs.map((r) => h('div', { class: 'row' }, h('span', { class: 'n', text: r.routeId.replace(/^route-/, 'R') }),
        h('span', { class: 'grow' }, h('b', { text: r.areaName ? `${r.areaName} · van ${r.van}` : r.routeName }), h('span', { text: `${r.counts.stops} stops · ${r.counts.bottles} bottles · about ${r.distanceKm} km, ${Math.round(r.minutes / 60 * 10) / 10} h` })),
        r.status === 'ready' && !r.driverId ? h('button', { class: 'btn small', type: 'button', onclick: async () => { try { S.run = await api('POST', `/v1/driver/runs/${r.id}/start`); load(); } catch (x) { toast(x.message); } } }, 'Take it')
          : h('em', { class: r.status === 'done' ? 'ok' : '', text: r.driverId && r.driverId !== S.me.id ? 'Taken' : label[r.status] }))))
        : h('div', { class: 'empty', text: 'No routes today yet. They appear here once tonight’s boxes are printed and packed.' }),
      dock(h('button', { class: 'btn secondary', type: 'button', onclick: routes }, 'Refresh'), signOutBtn()));
  }

  // ---------- scanning a box ----------
  /** Opens the camera; resolves with the pack id read from a box's QR, or a box number typed in. */
  function scanBox(title) {
    return new Promise((resolve) => {
      const video = h('video', { playsinline: true, muted: true, autoplay: true, style: 'width:100%;height:100%;object-fit:cover' });
      const typed = h('input', { class: 'input', id: 'box-no', placeholder: 'Box number, like 7K2QF', autocapitalize: 'characters', maxlength: '8', style: 'text-transform:uppercase' });
      let stream, raf, done = false;
      const finish = (v) => { if (done) return; done = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); wrap.remove(); resolve(v); };
      const fromNumber = (n) => {
        const want = n.replace(/[^a-z0-9]/gi, '').toUpperCase();
        const hit = S.run.stops.find((s) => s.boxNumber === want);
        return hit ? hit.packId : `unknown:${want}`;
      };
      const wrap = h('div', { class: 'sheet-wrap' }, h('div', { class: 'sheet' },
        h('h2', { text: title }),
        h('div', { class: 'camera', style: 'aspect-ratio:4/3' }, fixture ? h('div', { style: 'display:grid;place-items:center;height:100%;color:#fff;padding:20px;text-align:center', text: 'The camera opens here on your phone. In this preview, tap a box below.' }) : video, h('div', { class: 'frame' })),
        fixture ? h('div', { class: 'chips' }, S.run.stops.filter((s) => s.packStatus !== 'delivered').slice(0, 4).map((s) => h('button', { type: 'button', class: 'chip-btn', onclick: () => finish(s.packId) }, `Box #${s.boxNumber}`))) : null,
        h('form', { style: 'display:flex;gap:8px', onsubmit: (e) => { e.preventDefault(); if (typed.value.trim()) finish(fromNumber(typed.value)); } }, typed, h('button', { class: 'btn small', type: 'submit' }, 'Use')),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => finish(null) }, 'Cancel')));
      document.body.append(wrap);
      if (fixture || !navigator.mediaDevices?.getUserMedia) return;
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then((s) => {
        stream = s; video.srcObject = s;
        const c = document.createElement('canvas'); const ctx = c.getContext('2d', { willReadFrequently: true });
        const tick = () => {
          if (done) return;
          if (video.readyState >= 2 && window.jsQR) {
            const w = 480, hh = Math.round((video.videoHeight / video.videoWidth) * w) || 360; c.width = w; c.height = hh; ctx.drawImage(video, 0, 0, w, hh);
            const q = window.jsQR(ctx.getImageData(0, 0, w, hh).data, w, hh, { inversionAttempts: 'dontInvert' });
            const m = q && /\/(?:p|b)\/([A-Za-z0-9_-]+)/.exec(q.data);
            if (m) { navigator.vibrate?.(60); return finish(m[1]); }
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      }).catch(() => toast('Camera is off. Type the box number instead.'));
    });
  }

  // ---------- load the van ----------
  function load() {
    const r = S.run;
    const order = r.loadOrder;
    const loaded = order.filter((s) => s.loaded).length;
    const next = order.find((s) => !s.loaded);
    const stopOf = (n) => r.stops.find((s) => s.stop === n);
    screen(h('div', { class: 'dhead' }, h('div', { text: runName(r) }), h('span', { text: r.depot?.name ?? '' })),
      h('h1', { class: 'dtitle', text: 'Load the van' }), h('p', { class: 'dsub', text: 'Last stop goes in first, so stop 1 ends up by the door.' }),
      h('div', { class: 'dhead', style: 'font-size:14px' }, h('span', { text: 'Boxes loaded' }), h('b', { text: `${loaded} of ${order.length}` })),
      h('div', { class: 'bar' }, h('i', { style: `width:${(loaded / Math.max(1, order.length)) * 100}%` })),
      next ? grabCard(stopOf(next.stop)) : null,
      h('div', { class: 'rows' }, order.map((s) => h('div', { class: 'row' }, h('span', { class: `n${s.loaded ? '' : ' ghost'}`, text: String(s.stop) }), h('span', { class: 'grow' }, h('b', { text: `#${s.boxNumber} · ${s.packSize}-pack` }), h('span', { text: s.address })), h('em', { class: s.loaded ? 'ok' : '', text: s.loaded ? 'Loaded ✓' : next && s.stop === next.stop ? 'Next' : '' })))),
      dock(h('button', { class: 'btn', type: 'button', onclick: async () => {
        const packId = await scanBox(`Scan box #${next.boxNumber}`);
        if (!packId) return;
        try { S.run = await api('POST', `/v1/driver/runs/${r.id}/load`, { packId }); navigator.vibrate?.(40); S.run.status === 'out' ? (toast('Van loaded. Drive safe.'), nextStop()) : load(); }
        catch (x) { toast(x.message); }
      } }, 'Scan box to load')));
  }

  // ---------- house after house ----------
  function miniMap(run, current) {
    const pts = run.stops.map((s) => s.point);
    const all = [...pts, ...(run.depot ? [run.depot] : [])];
    const minLat = Math.min(...all.map((p) => p.lat)), maxLat = Math.max(...all.map((p) => p.lat)), minLng = Math.min(...all.map((p) => p.lng)), maxLng = Math.max(...all.map((p) => p.lng));
    const W = 340, H = 150, pad = 16;
    const x = (p) => pad + ((p.lng - minLng) / Math.max(1e-6, maxLng - minLng)) * (W - pad * 2);
    const y = (p) => H - pad - ((p.lat - minLat) / Math.max(1e-6, maxLat - minLat)) * (H - pad * 2);
    const s = sv('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': `Route map, stop ${current.stop} highlighted` });
    s.append(sv('polyline', { points: run.stops.map((st) => `${x(st.point)},${y(st.point)}`).join(' '), fill: 'none', stroke: '#9AA6B2', 'stroke-width': 2, 'stroke-dasharray': '4 4' }));
    for (const st of run.stops) s.append(sv('circle', { cx: x(st.point), cy: y(st.point), r: st.stop === current.stop ? 8 : 4.5, fill: st.status === 'delivered' ? '#1F8A4C' : st.status === 'not_delivered' ? '#B42318' : st.stop === current.stop ? '#1F2633' : '#C5CED6', stroke: '#fff', 'stroke-width': 2 }));
    return h('div', { class: 'mapbox' }, s);
  }
  function nextStop() {
    const r = S.run;
    const s = r.stops.find((x) => x.status === 'planned');
    if (!s) return finished();
    const after = r.stops.filter((x) => x.status === 'planned' && x.stop > s.stop).slice(0, 3);
    // A house that stopped deliveries in the app after tonight's plan (or is marked to skip): keep its box, go on.
    const keep = s.houseId && s.houseStatus && s.houseStatus !== 'active';
    screen(h('div', { class: 'dhead' }, h('div', { text: runName(r) }), h('span', { text: `${r.counts.delivered + r.counts.notDelivered} done · ${r.counts.stops - r.counts.delivered - r.counts.notDelivered} to go` })),
      miniMap(r, s),
      h('div', {}, h('div', { class: 'small muted', style: 'font-family:ui-monospace,Menlo,monospace;letter-spacing:.08em', text: `STOP ${s.stop} OF ${r.counts.stops}` }), h('h1', { class: 'dtitle', text: s.address.split(',')[0] }), h('p', { class: 'dsub', text: s.address.split(',').slice(1).join(',').trim() })),
      s.notes ? h('div', { class: 'notes' }, h('b', { text: 'Note: ' }), s.notes) : null,
      keep ? h('div', { class: 'verdict bad' }, h('div', { class: 'mark', text: '!' }), h('h2', { text: 'Don’t leave a box here' }), h('p', { text: s.houseStatus === 'opted_out' ? 'This house stopped deliveries in the app after tonight’s plan. Keep the box; it goes back to the micro-factory.' : 'This house is marked to skip. Keep the box.' })) : null,
      grabCard(s),
      after.length ? h('div', {}, h('div', { class: 'small muted', style: 'font-family:ui-monospace,Menlo,monospace;letter-spacing:.08em;margin-bottom:4px', text: 'THEN' }), h('div', { class: 'rows' }, after.map((a) => h('div', { class: 'row' }, h('span', { style: 'width:28px;color:var(--muted)', text: String(a.stop) }), h('span', { class: 'grow', text: a.address.split(',')[0] }))))) : null,
      keep ? dock(h('button', { class: 'btn', type: 'button', onclick: () => keepBox(s) }, 'Keep the box · next house'))
        : dock(h('a', { class: 'btn secondary', href: `https://www.google.com/maps/dir/?api=1&destination=${s.point.lat},${s.point.lng}`, target: '_blank', rel: 'noopener' }, 'Directions'),
          h('button', { class: 'btn', type: 'button', onclick: () => atDoor(s) }, 'I’m at the door · scan box'),
          s.houseId && on('driver_house_skip') ? h('button', { class: 'link-btn', type: 'button', onclick: () => skipSheet(s) }, 'Skip this house') : null));
  }
  /** A house that already stopped (or is marked to skip): the box comes back, nothing to review. Works with skipping switched off too. */
  async function keepBox(s) {
    try { S.run = await api('POST', `/v1/driver/runs/${encodeURIComponent(S.run.id)}/stops/${s.stop}/fail`, { reason: s.houseStatus === 'opted_out' ? 'They stopped deliveries in the app' : 'House marked to skip' }); toast('Box kept. Next house.'); nextStop(); }
    catch (x) { toast(x.message); }
  }
  /** Pass a house in a delivery area by. Its boxes come back; a person reviews the skip before the house is left out for good. */
  async function skipHouse(s, reason, note) {
    try { S.run = await api('POST', `/v1/driver/runs/${encodeURIComponent(S.run.id)}/stops/${s.stop}/skip-house`, { reason, ...(note ? { note } : {}) }); toast('Skipped. The office will review it.'); nextStop(); }
    catch (x) { toast(x.message); }
  }
  function skipSheet(s) {
    const note = h('input', { class: 'input', id: 'skip-note', maxlength: '200', placeholder: 'What you saw (optional)' });
    // Only real access or safety problems. A sign on the door, or someone saying they don't want it, isn't a reason:
    // people stop deliveries themselves in the app (the code on the side of the box takes them there).
    const reasons = [['locked_gate', 'Locked gate'], ['dangerous_animal', 'Dangerous animal'], ['unsafe', 'Not safe'], ['no_safe_place', 'No safe place to leave it'], ['not_a_home', 'Not a home (empty, business, building site)']];
    screen(h('div', { class: 'dhead' }, h('div', { text: `Stop ${s.stop} · ${s.address.split(',')[0]}` })), h('h1', { class: 'dtitle', text: 'Can’t leave it here?' }),
      h('p', { class: 'dsub', text: 'Only for a real access or safety problem. Its box comes back with you, and the house is left out of the next deliveries until the office has looked at why.' }),
      h('p', { class: 'small muted', text: 'Signs on the door don’t count. If someone tells you they don’t want it, leave the box and tell them they can stop deliveries in the app (scan the code on the side of the box).' }),
      h('label', { for: 'skip-note', style: 'font-weight:700', text: 'Note' }), note,
      h('div', { class: 'reasons' }, reasons.map(([r, label]) => h('button', { type: 'button', onclick: () => skipHouse(s, r, note.value.trim()) }, label))),
      dock(h('button', { class: 'btn secondary', type: 'button', onclick: nextStop }, 'Back to this stop')));
  }
  /**
   * A phone's photo is 3 to 15 MB, and the server keeps at most 1600 pixels a side (and refuses more than 8 MB). Shrunk
   * here first to about 300 KB of JPEG, it sends in a second on a weak signal at the door, and a photo from a big
   * camera is never refused. If the phone can't shrink it, the photo is sent as it is.
   */
  async function shrink(f) {
    try {
      if (fixture || !window.createImageBitmap) return f;
      const img = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      img.close?.();
      const b = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
      return b && b.size ? b : f;
    } catch { return f; }
  }
  function here() {
    if (fixture) return Promise.resolve(fixture.here?.() ?? null);
    return new Promise((res) => {
      if (!navigator.geolocation) return res(null);
      const giveUp = setTimeout(() => res(null), 9000); // if the phone never answers, the driver confirms instead
      navigator.geolocation.getCurrentPosition((p) => { clearTimeout(giveUp); res({ lat: p.coords.latitude, lng: p.coords.longitude }); }, () => { clearTimeout(giveUp); res(null); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 });
    });
  }
  async function atDoor(s) {
    const packId = await scanBox(`Scan the box at stop ${s.stop}`);
    if (!packId) return;
    const r = S.run;
    if (packId !== s.packId) {
      // Record the wrong scan so ops can see it, then show what to grab instead.
      let msg = 'That box isn’t for this house.';
      try { await api('POST', `/v1/driver/runs/${r.id}/stops/${s.stop}/deliver`, { scannedPackId: packId.startsWith('unknown:') ? packId : packId, emptiesCollected: 0, confirmedAtDoor: true }); } catch (x) { msg = x.message; }
      navigator.vibrate?.([120, 80, 120]);
      return screen(h('div', { class: 'dhead' }, h('div', { text: `Stop ${s.stop} · ${s.address.split(',')[0]}` })),
        h('div', { class: 'verdict bad' }, h('div', { class: 'mark', text: '!' }), h('h2', { text: 'Wrong box. Don’t leave it.' }), h('p', { text: msg })),
        h('b', { text: 'Grab this one instead:' }), grabCard(s, 'Box to grab'),
        h('p', { class: 'small muted', text: 'This stop can’t be marked delivered until the right box is scanned here. Every box’s bottles were already checked at the micro-factory.' }),
        dock(h('button', { class: 'btn', type: 'button', onclick: () => atDoor(s) }, 'Scan the right box'), h('button', { class: 'btn secondary', type: 'button', onclick: () => problem(s) }, 'Box missing or damaged')));
    }
    let point = null, gpsOk = false, empties = 0, photoOk = false, confirmed = false;
    const needPhoto = on('drop_photo_proof');
    const whereBox = h('div', {}, h('p', { text: `#${s.boxNumber} belongs to this house. Checking your location…` }));
    here().then((p) => {
      point = p;
      const meters = p ? Math.round(distance(p, s.point) * 1000) : null;
      gpsOk = meters !== null && meters <= 100;
      confirmed = gpsOk;
      whereBox.replaceChildren(gpsOk ? h('p', { text: `#${s.boxNumber} belongs to this house. GPS agrees.` })
        : h('div', {}, h('p', { text: meters === null ? `#${s.boxNumber} belongs to this house. Your phone didn’t give a location.` : `#${s.boxNumber} belongs to this house, but GPS puts you ${meters} m away.` }),
            h('label', { class: 'check', style: 'background:#fff;color:var(--ink);margin-top:10px;text-align:left' }, h('input', { type: 'checkbox', onchange: (e) => { confirmed = e.target.checked; } }), h('span', { text: `I’m at ${s.address.split(',')[0]}` }))));
    });
    const out = h('output', { text: '0' });
    const photoBtn = h('button', { class: 'photo', type: 'button', onclick: () => cam.click() }, needPhoto ? 'Take a photo of the box where you left it (needed)' : 'Tap to take a photo of the box at the door');
    // The photo proves the drop: only the office and the people who live there see it, and it's deleted after a while.
    const cam = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', capture: 'environment', hidden: true, onchange: async () => {
      const f = cam.files[0]; if (!f) return;
      photoOk = false;
      photoBtn.replaceChildren(h('img', { src: URL.createObjectURL(f), alt: 'Photo of the box at the door' }));
      try { await api('POST', `/v1/driver/photos?packId=${encodeURIComponent(packId)}`, null, await shrink(f)); photoOk = true; } catch (x) { toast(x.message); photoBtn.replaceChildren(document.createTextNode('That photo didn’t send. Tap to take it again.')); }
    } });
    screen(h('div', { class: 'dhead' }, h('div', { text: `Stop ${s.stop} · ${s.address.split(',')[0]}` })),
      h('div', { class: 'verdict ok' }, h('div', { class: 'mark', text: '✓' }), h('h2', { text: 'Right box' }), whereBox),
      photoBtn, cam,
      h('div', { class: 'stepper' }, h('div', {}, h('b', { text: 'Empties picked up' }), h('div', { class: 'small muted', text: 'Count the empty bottles left out' })),
        h('div', { class: 'ctl' }, h('button', { type: 'button', 'aria-label': 'One fewer', onclick: () => { empties = Math.max(0, empties - 1); out.textContent = String(empties); } }, '−'), out, h('button', { type: 'button', 'aria-label': 'One more', onclick: () => { empties += 1; out.textContent = String(empties); } }, '+'))),
      dock(h('button', { class: 'btn', type: 'button', onclick: async (e) => {
        if (!confirmed) return toast(point || gpsOk ? 'Confirm you’re at the door first.' : 'Still checking your location. Or tick “I’m at” to confirm.');
        if (needPhoto && !photoOk) return toast('Take a photo of the box where you left it first. It isn’t delivered without one.');
        e.currentTarget.disabled = true;
        try { S.run = await api('POST', `/v1/driver/runs/${r.id}/stops/${s.stop}/deliver`, { scannedPackId: packId, ...(point ? { lat: point.lat, lng: point.lng } : {}), confirmedAtDoor: confirmed, emptiesCollected: empties }); navigator.vibrate?.(40); toast(`Stop ${s.stop} delivered`); nextStop(); }
        catch (x) { toast(x.message); e.currentTarget.disabled = false; }
      } }, 'Done · next house'), h('button', { class: 'link-btn', type: 'button', onclick: () => problem(s) }, 'Problem at this stop')));
  }
  function problem(s) {
    const go = async (reason) => { try { S.run = await api('POST', `/v1/driver/runs/${encodeURIComponent(S.run.id)}/stops/${s.stop}/fail`, { reason }); toast(s.houseId ? 'Noted. The box comes back.' : 'Noted. The customer will be told.'); nextStop(); } catch (x) { toast(x.message); } };
    screen(h('div', { class: 'dhead' }, h('div', { text: `Stop ${s.stop} · ${s.address.split(',')[0]}` })), h('h1', { class: 'dtitle', text: 'What happened?' }), h('p', { class: 'dsub', text: 'The box goes back to the micro-factory and the customer gets a message.' }),
      h('div', { class: 'reasons' }, ['No safe place to leave it', 'Gate or door locked', 'Box missing from the van', 'Box damaged', 'Can’t find the address'].map((r) => h('button', { type: 'button', onclick: () => go(r) }, r))),
      s.houseId && on('driver_house_skip') ? h('button', { class: 'link-btn', type: 'button', onclick: () => skipSheet(s) }, 'Can’t get to the door safely? Skip this house') : null,
      dock(h('button', { class: 'btn secondary', type: 'button', onclick: nextStop }, 'Back to this stop')));
  }
  function finished() {
    const c = S.run.counts;
    screen(h('div', { class: 'verdict ok', style: 'margin-top:30px' }, h('div', { class: 'mark', text: '✓' }), h('h2', { text: 'Route done' }), h('p', { text: `${c.delivered} delivered${c.notDelivered ? `, ${c.notDelivered} coming back` : ''}. ${c.empties} empties picked up.` })),
      h('p', { class: 'dsub', style: 'text-align:center', text: 'Head back to the micro-factory. Thanks!' }), dock(h('button', { class: 'btn secondary', type: 'button', onclick: routes }, 'Today’s routes')));
  }
  function distance(a, b) { const R = 6371, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r; const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); }

  boot().catch((e) => screen(h('div', { class: 'notice err', text: e.message })));
})();
