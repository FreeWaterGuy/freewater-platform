// The Model 6 screen: shows what the machine software says it should, a few times a second. People order from their
// phone by scanning the code; the screen only takes a tap while the machine's internet is down.
(() => {
  'use strict';
  const fixture = window.__FW_MACHINE_FIXTURE__;
  const el = document.getElementById('screen');
  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };
  const svgSrc = (s) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
  const getState = () => (fixture ? fixture.state() : fetch('/local/state', { cache: 'no-store' }).then((r) => r.json()));
  const tap = () => (fixture ? fixture.tap() : fetch('/local/tap', { method: 'POST' }).then((r) => r.json()));

  let shownKey = '';
  let skew = 0; // the machine software's clock minus this page's, for the countdown
  let carousel = null;
  let tick = null;

  function theme(cfg) {
    const b = cfg?.brand;
    if (!b) return;
    el.style.setProperty('--panel', b.panelColor);
    el.style.setProperty('--text', b.textColor);
    el.style.setProperty('--accent', b.accentColor);
  }
  const logo = (cfg) => h('div', { class: 'logo', 'aria-label': cfg?.company ?? 'FreeWater' }, h('span', { text: cfg?.brand?.logoTop ?? 'free' }), h('span', { text: cfg?.brand?.logoBottom ?? 'water' }));
  const foot = (s, style) => h('div', { class: 'foot', style }, h('span', { text: `${s.machine.id}${s.config?.machine?.name ? ` · ${s.config.machine.name}` : ''}` }), h('span', { class: `net${s.machine.online ? '' : ' off'}`, text: s.machine.online ? 'Online' : 'Offline' }));
  const page = (cls, ...kids) => h('div', { class: `page ${cls}` }, ...kids);

  function idle(s) {
    const c = s.config ?? {};
    const qr = h('div', { class: 'qr', 'aria-label': 'Code to scan with your phone' }, s.presence ? h('img', { alt: '', src: svgSrc(s.presence.qrSvg) }) : null);
    const ads = c.ads ?? [];
    const imgs = ads.slice(0, 3).map((a, i) => h('img', { alt: `Ad: ${a.advertiser}`, src: svgSrc(a.art), class: i === 0 ? '' : 'dim' }));
    const dots = h('div', { class: 'dots' }, ads.map((_, i) => h('span', { class: `dot${i === 0 ? ' on' : ''}` })));
    let at = 0;
    if (ads.length > 1) carousel = setInterval(() => {
      at = (at + 1) % ads.length;
      imgs.forEach((img, i) => { const a = ads[(at + i) % ads.length]; img.src = svgSrc(a.art); img.alt = `Ad: ${a.advertiser}`; });
      [...dots.children].forEach((d, i) => d.classList.toggle('on', i === at));
    }, 6000);
    return page('idle',
      h('div', { class: 'top' }, logo(c), c.brand?.tagline ? h('div', { class: 'tagline', text: c.brand.tagline }) : null),
      h('h1', {}, c.pricing === 'free' ? h('em', { text: 'Free' }) : null, c.pricing === 'free' ? ' spring water' : 'Spring water'),
      h('div', { class: 'qr-card' }, qr, h('div', { class: 'how' }, h('b', { text: 'Scan with your phone camera' }), h('ol', {}, h('li', { text: 'Scan this code' }), h('li', { text: 'Tap “Get my free water”' }), h('li', { text: 'Watch it print, then take it' })))),
      h('div', { class: 'facts' },
        h('div', {}, h('b', { text: String(c.freeBottlesPerDay ?? 3) }), 'free bottles a day for each person'),
        h('div', {}, h('b', { text: `${c.printSeconds ?? 25} s` }), 'printed fresh with today’s ads'),
        h('div', {}, h('b', { text: c.giving ? c.giving.split(' ')[0] : 'Ads' }), c.giving ? c.giving.replace(/^\S+\s/, '') : 'pay for every bottle')),
      ads.length ? h('div', { class: 'ads' }, h('div', { class: 'cap' }, h('span', { text: 'On today’s bottles' }), h('span', { text: 'Ads pay for your water' })), h('div', { class: 'frame' }, imgs), dots) : h('div', { style: 'flex:1' }),
      foot(s));
  }

  function printing(s) {
    const j = s.job;
    const C = 2 * Math.PI * 46;
    const NS = 'http://www.w3.org/2000/svg';
    const ring = document.createElementNS(NS, 'svg'); ring.setAttribute('viewBox', '0 0 100 100');
    const track = document.createElementNS(NS, 'circle'); for (const [k, v] of Object.entries({ cx: 50, cy: 50, r: 46, fill: 'none', stroke: 'rgba(255,255,255,.15)', 'stroke-width': 7 })) track.setAttribute(k, v);
    const arc = document.createElementNS(NS, 'circle'); for (const [k, v] of Object.entries({ cx: 50, cy: 50, r: 46, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': C, 'stroke-dashoffset': 0 })) arc.setAttribute(k, v);
    ring.append(track, arc);
    const num = h('b', { text: String(j.seconds) });
    const sub = h('p', { class: 'lead' });
    const s1 = h('div', { class: 'on', text: 'Printing your label' });
    const s2 = h('div', { text: 'Dropping it in the tray' });
    const update = () => {
      const left = Math.max(0, Math.ceil(j.seconds - (Date.now() + skew - j.startedAt) / 1000));
      num.textContent = String(left);
      arc.setAttribute('stroke-dashoffset', String(C * (1 - left / j.seconds)));
      sub.textContent = left > 0 ? `It drops into the tray below in about ${left} second${left === 1 ? '' : 's'}.` : 'Almost there…';
    };
    update();
    tick = setInterval(update, 250);
    const p = page('printing',
      h('div', { class: 'top' }, logo(s.config), h('div', { class: 'tagline', text: j.walkUp ? 'Offline bottle' : 'Ordered from your phone' })),
      h('div', { class: 'count' }, h('div', { class: 'ring' }, ring, num), h('div', {}, h('h1', { text: 'Your bottle is printing' }), sub)),
      j.ad ? h('div', { class: 'ad-big' }, h('img', { alt: `Ad on your bottle: ${j.ad.advertiser}`, src: svgSrc(j.ad.art) }), h('span', { text: `On your bottle: ${j.ad.advertiser}. Scan it on the bottle to open it.` })) : h('div', { style: 'flex:1' }),
      h('div', { class: 'steps' }, s1, s2),
      foot(s));
    p.dataset.step = j.step;
    p._steps = [s1, s2];
    return p;
  }

  function center(s, icon, title, note, ...extra) {
    return page('center', h('div', { class: 'top', style: 'position:absolute;top:5cqh;left:6cqw;right:6cqw' }, logo(s.config)), icon, h('h1', { text: title }), note ? h('p', { class: 'note', text: note }) : null, ...extra, foot(s, 'position:absolute;bottom:3.2cqh;left:6cqw;right:6cqw'));
  }

  function offline(s) {
    const w = s.walkUp ?? { available: false };
    const per = s.config?.offlinePerHour;
    if (!w.available) return center(s, h('div', { class: 'big-icon', text: '…' }), 'We’re offline for a moment', w.reason && w.reason !== 'Use the app' ? w.reason : 'Back in a few minutes. Your app shows machines nearby.');
    const btn = h('button', { class: 'tap', type: 'button', onclick: async () => { btn.disabled = true; btn.textContent = 'Starting…'; try { const r = await tap(); if (!r.ok) { btn.textContent = r.message; setTimeout(() => { btn.disabled = false; btn.textContent = 'Tap for a free bottle'; }, 2500); } } catch { btn.disabled = false; btn.textContent = 'Tap for a free bottle'; } } }, 'Tap for a free bottle');
    return center(s, h('div', { class: 'big-icon', text: '↓' }), 'No internet? No problem.', `While we’re offline, tap for a free bottle. No app needed.${per ? ` Up to ${per} an hour.` : ''}`, btn);
  }

  function render(s) {
    if (!s || !s.kind) return;
    theme(s.config);
    if (s.now) skew = s.now - Date.now();
    const key = [s.kind, s.message ?? '', s.presence?.code ?? '', s.config ? JSON.stringify(s.config.brand) + (s.config.ads?.length ?? 0) : '', s.machine.online, JSON.stringify(s.walkUp ?? null), s.job?.startedAt ?? ''].join('|');
    if (key === shownKey) {
      const p = el.firstChild;
      if (s.kind === 'printing' && p?._steps && p.dataset.step !== s.job.step) { p.dataset.step = s.job.step; p._steps[0].className = 'done'; p._steps[1].className = 'on'; }
      return;
    }
    shownKey = key;
    clearInterval(carousel); clearInterval(tick); carousel = tick = null;
    let p;
    switch (s.kind) {
      case 'idle': p = idle(s); break;
      case 'printing': p = printing(s); if (s.job.step === 'dropping') { p._steps[0].className = 'done'; p._steps[1].className = 'on'; } break;
      case 'take': p = center(s, h('div', { class: 'arrow', 'aria-hidden': 'true', text: '↓' }), 'Take your bottle', 'Scan any ad on it to open it. Enjoy!'); break;
      case 'failed': p = center(s, h('div', { class: 'big-icon', text: '!' }), 'Sorry about that', s.message); break;
      case 'offline': p = offline(s); break;
      case 'sold_out': p = center(s, h('div', { class: 'big-icon', text: '0' }), 'Sold out', `${s.message ?? ''} Your app shows machines nearby.`); break;
      case 'maintenance': p = center(s, h('div', { class: 'big-icon', text: '⟳' }), 'Restocking', s.message); break;
      case 'out_of_service': p = center(s, h('div', { class: 'big-icon', text: '×' }), 'Out of service', s.message); break;
      default: p = center(s, h('div', { class: 'big-icon', text: '…' }), 'Starting up', 'One moment.');
    }
    el.replaceChildren(p);
  }

  async function loop() {
    try { render(await getState()); } catch {}
    setTimeout(loop, 400);
  }
  loop();
})();
