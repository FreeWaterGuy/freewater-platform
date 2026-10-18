import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { AttributionError, CLICK_WINDOW_DAYS } from '../modules/attribution/service';
import { ApiError, obj, S, type RouteDef } from './http';

/** The tag advertisers put on their website. It keeps our click id and reports purchases. Nothing else. */
const tagScript = `/* FreeWater tag: remembers the FreeWater click id (fwclid) and reports purchases from FreeWater bottles. */
(function () {
  var s = document.currentScript, tag = s && s.getAttribute('data-tag'), base = s ? new URL(s.src).origin : '';
  var K = '_fwclid', B = '_fwb', DAYS = ${CLICK_WINDOW_DAYS};
  function clickId() {
    try { var v = JSON.parse(localStorage.getItem(K) || 'null'); if (v && Date.now() - v.t < DAYS * 864e5) return v.id; } catch (e) {}
    var m = document.cookie.match(/(?:^|; )_fwclid=([0-9A-Z]{20})/); return m ? m[1] : null;
  }
  var fromLink = new URLSearchParams(location.search).get('fwclid');
  if (fromLink && /^FWC[0-9A-Z]{17}$/.test(fromLink)) {
    try { localStorage.setItem(K, JSON.stringify({ id: fromLink, t: Date.now() })); } catch (e) {}
    document.cookie = K + '=' + fromLink + '; max-age=' + DAYS * 86400 + '; path=/; SameSite=Lax';
  }
  // A static code on a bottle opens this site with the bottle's own reference (fwb). Keep it too.
  function bottle() {
    try { var v = JSON.parse(localStorage.getItem(B) || 'null'); if (v && Date.now() - v.t < DAYS * 864e5) return v.id; } catch (e) {}
    return null;
  }
  var fromCode = new URLSearchParams(location.search).get('fwb');
  if (fromCode && /^[0-9A-Z]{14}$/.test(fromCode)) { try { localStorage.setItem(B, JSON.stringify({ id: fromCode, t: Date.now() })); } catch (e) {} }
  function send(event, d) {
    if (event !== 'purchase') return;
    d = d || {};
    var id = clickId(), fwb = id ? null : bottle();
    if (!id && !fwb && !d.coupon) return; // this sale didn't come from a FreeWater bottle
    var body = JSON.stringify({ tag: tag, fwclid: id, fwb: fwb, coupon: d.coupon || null, orderId: String(d.orderId || ''), valueCents: d.valueCents != null ? Math.round(d.valueCents) : Math.round(Number(d.value || 0) * 100) });
    try { if (navigator.sendBeacon && navigator.sendBeacon(base + '/v1/public/conversions', new Blob([body], { type: 'text/plain' }))) return; } catch (e) {}
    try { fetch(base + '/v1/public/conversions', { method: 'POST', body: body, keepalive: true, mode: 'cors', headers: { 'content-type': 'text/plain' } }); } catch (e) {}
  }
  var queued = (window.freewater && window.freewater.q) || [];
  window.freewater = function () { send.apply(null, arguments); };
  for (var i = 0; i < queued.length; i++) send.apply(null, queued[i]);
})();
`;

const notOurs = (company: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not a ${company} code</title>
<body style="margin:0;font:17px/1.5 system-ui,sans-serif;background:#000;color:#fff;display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center">
<main style="max-width:420px"><div style="font-size:56px">!</div><h1 style="margin:.2em 0">This code isn’t one of ours</h1>
<p style="opacity:.8">Every genuine bottle has its own code, and this one doesn’t match. If it’s on a bottle that says ${company}, the bottle may not be genuine.</p></main></body></html>`;

export function attributionRoutes(app: App, server: FastifyInstance, route: (r: RouteDef) => void) {
  const { attribution, codes, platform } = app;
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof AttributionError || e instanceof ApiError) return reply.code(e.status).send({ error: { code: e.code, message: e.message } });
    throw e;
  };

  // ---------- printed codes: every scan reaches us first ----------
  const openCode = async (req: FastifyRequest, reply: FastifyReply) => {
    const row = await codes.find(String((req.params as any).code));
    if (!row) return reply.code(404).type('text/html; charset=utf-8').send(notOurs(platform.companies.get(process.env.APP_COMPANY ?? 'freewater')?.name ?? 'FreeWater'));
    const { opens } = await codes.opened(row.code);
    platform.bus.publish('code.opened', row.companyId, { code: row.code, kind: row.kind, ...(row.unitId ? { unitId: row.unitId } : {}), ...(row.slot !== undefined ? { slot: row.slot } : {}), ...(row.packId ? { packId: row.packId } : {}), ...(row.face ? { face: row.face } : {}), opens }, `${row.code}:${opens}`);
    await app.persistence.flushUnlessPaused();
    const to = row.kind === 'slot' ? `/s/${row.unitId}/${row.slot}` : row.kind === 'receipt' ? `/r/${row.unitId}` : row.kind === 'box' ? `/b/${row.packId}/${row.face}` : `/p/${row.packId}`;
    return reply.header('cache-control', 'no-store').redirect(`${to}?c=${row.code}`, 302);
  };
  server.get('/q/:code', openCode);
  server.get('/Q/:code', openCode);

  // A coupon's code, scanned by the cashier: opens the advertiser portal's check-and-redeem screen.
  const openCoupon = async (req: FastifyRequest, reply: FastifyReply) => reply.header('cache-control', 'no-store').redirect(`/ads/redeem/${encodeURIComponent(String((req.params as any).code).toUpperCase())}`, 302);
  server.get('/v/:code', openCoupon);
  server.get('/V/:code', openCoupon);

  // ---------- links out of ads ----------
  server.get('/go/:token', async (req, reply) => {
    try {
      const q = req.query as Record<string, string>;
      const { url } = await attribution.click(String((req.params as any).token), q.v || undefined, q.from);
      // Anything the page added (like the booking time picked) goes along to the advertiser.
      const out = new URL(url);
      for (const [k, v] of Object.entries(q)) if (k !== 'v' && k !== 'from' && k !== 'fwclid' && typeof v === 'string') out.searchParams.set(k, v);
      await app.persistence.flushUnlessPaused();
      return reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').redirect(out.toString(), 302);
    } catch (e) { return fail(reply, e); }
  });

  // ---------- the tag ----------
  server.get('/t.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'public, max-age=3600').header('access-control-allow-origin', '*').send(tagScript));
  const cors = (reply: FastifyReply) => reply.header('access-control-allow-origin', '*').header('access-control-allow-methods', 'POST, OPTIONS').header('access-control-allow-headers', 'content-type');
  server.options('/v1/public/conversions', async (_req, reply) => cors(reply).code(204).send());
  server.post('/v1/public/conversions', { bodyLimit: 4096 }, async (req, reply) => {
    cors(reply);
    try {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as any);
      const origin = (req.headers.origin as string | undefined) ?? (req.headers.referer as string | undefined) ?? null;
      const r = await attribution.conversion({ source: 'tag', tagId: String(b?.tag ?? ''), origin, clickId: b?.fwclid ?? undefined, couponCode: b?.coupon ?? undefined, bottleCode: b?.fwb ?? undefined, orderId: String(b?.orderId ?? ''), valueCents: Number(b?.valueCents) });
      await app.persistence.flushUnlessPaused();
      return reply.code(r.duplicate ? 200 : 201).send({ ok: true, duplicate: r.duplicate });
    } catch (e) {
      if (e instanceof SyntaxError) return reply.code(400).send({ error: { code: 'bad_json', message: 'Send JSON.' } });
      return fail(reply, e);
    }
  });

  // ---------- advertisers: their tag, server-to-server sales, coupons at the counter ----------
  const advertiser = (key: ApiKey | null) => {
    if (!key?.advertiserId) throw new ApiError(403, 'advertiser_only', 'This is for advertisers. Use an advertiser’s key or sign in as advertiser staff.');
    return key.advertiserId;
  };
  const base = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}`;
  route({ method: 'GET', url: '/v1/ads/tracking', scope: ['campaigns', 'purchases'], summary: 'Your tracking tag, the websites it may report from, how to install it, and the last 30 days: clicks, sales, coupons.', handler: async (req, key) => {
    const adv = advertiser(key);
    const tag = await attribution.tagFor(key!.companyId, adv);
    const src = `${base(req)}/t.js`;
    return { body: { ...tag, clickWindowDays: CLICK_WINDOW_DAYS, install: {
      everyPage: `<script>window.freewater=window.freewater||function(){(freewater.q=freewater.q||[]).push(arguments)};</script>\n<script async src="${src}" data-tag="${tag.tagId}"></script>`,
      orderConfirmation: `<script>freewater('purchase', { orderId: 'YOUR-ORDER-NUMBER', value: 12.50, coupon: 'THE-CODE-IF-ONE-WAS-USED' });</script>`,
    }, summary: await attribution.summary(key!.companyId, adv) } };
  } });
  route({ method: 'POST', url: '/v1/ads/tracking/domains', scope: ['campaigns', 'purchases'], summary: 'The websites your tag may report sales from (like shop.joesburgers.com). Reports from anywhere else are refused.', body: obj({ domains: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 120 } } }, ['domains']), handler: async (req, key) => ({ body: await attribution.setTagDomains(key!.companyId, advertiser(key), (req.body as any).domains) }) });
  route({ method: 'POST', url: '/v1/conversions', scope: 'purchases', summary: 'Your server reports a sale: the fwclid from the link (or the bottle reference fwb from a static code, or the coupon code), your order number and the amount in cents. Matched to the exact bottle; commission is billed once per order.', body: obj({ fwclid: { type: 'string', maxLength: 40 }, fwb: { type: 'string', maxLength: 20 }, couponCode: { type: 'string', maxLength: 40 }, orderId: S.str, valueCents: S.int }, ['orderId', 'valueCents']), handler: async (req, key) => {
    const b = req.body as any;
    const r = await attribution.conversion({ source: 'server', advertiserId: advertiser(key), clickId: b.fwclid, couponCode: b.couponCode, bottleCode: b.fwb, orderId: b.orderId, valueCents: b.valueCents });
    return { status: r.duplicate ? 200 : 201, body: r };
  } });
  route({ method: 'POST', url: '/v1/conversions/:orderId/refund', scope: 'purchases', summary: 'A sale was refunded. Its commission is given back.', handler: async (req, key) => ({ body: await attribution.refund(advertiser(key), decodeURIComponent((req.params as any).orderId)) }) });
  route({ method: 'GET', url: '/v1/coupons/:code', scope: ['campaigns', 'purchases'], summary: 'Check a customer’s coupon: valid, or already used (and when).', handler: async (req, key) => ({ body: await attribution.checkCoupon(String((req.params as any).code), advertiser(key)) }) });
  route({ method: 'POST', url: '/v1/coupons/:code/redeem', scope: ['campaigns', 'purchases'], summary: 'Use a customer’s coupon (once). Send the sale amount; it’s credited to the bottle the coupon came from.', body: obj({ valueCents: S.int, orderId: { type: 'string', maxLength: 80 } }, ['valueCents']), handler: async (req, key) => {
    const b = req.body as any;
    return { body: await attribution.redeem(String((req.params as any).code), advertiser(key), { valueCents: b.valueCents, orderId: b.orderId, by: key!.name }) };
  } });

  // ---------- the company's own view ----------
  route({ method: 'GET', url: '/v1/ops/attribution', scope: ['admin', 'ledger'], summary: 'Clicks, matched sales, commission and coupons across all advertisers, last 30 days.', handler: async (_req, key) => {
    if (key!.advertiserId) throw new ApiError(403, 'missing_scope', 'Only the company’s team can see this.');
    return { body: await attribution.summary(key!.companyId) };
  } });
}
