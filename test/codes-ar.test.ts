import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { createApiKey } from '../src/db/store';
import { checkQrColor, checkQrLogo, qrPlan, qrSvg } from '../src/modules/print/qr';
import { CachedPersonalizer, checkGreeting, type Personalizer } from '../src/modules/ai/personalizer';
import * as G from '../src/modules/ar/geometry';
import { findMarkers, markerBit, MARKER_CODES } from '../src/modules/ar/markers';
import { checkProduct } from '../src/modules/products/check';
import { can12oz } from '../src/demo/seed';
import type { PrintedCode } from '../src/modules/print/contract';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-03T14:00:00Z').getTime(); // 8 am in Austin
const clock = () => new Date(now);
const asked: string[] = [];
// A stand-in for Claude: picks the morning version when it's offered, and writes a greeting.
const fakeAi: Personalizer = { name: 'test AI', async personalize(i) { asked.push(i.options.map((o) => o.id).join(',')); const m = i.options.find((o) => o.id === 'morning') ?? i.options.find((o) => o.id !== 'default'); return { choice: m ? m.id : 'default', greeting: 'Morning! A bright one for your walk.', by: 'test AI' }; } };
const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).body.token as string;
}
const only = (ids: string[]) => { for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater') c.active = ids.includes(c.id); };
let n = 0;
async function bottleWith(campaignId: string, opts: { productId?: string; others?: string[] } = {}) {
  only([campaignId, ...(opts.others ?? [])]);
  for (let i = 0; i < 120; i++) {
    const r = await app.platform.order({ companyId: 'freewater', orderId: `ca-${n++}`, locationId: 'ATX-014', productId: opts.productId ?? 'bottle-16oz' });
    const p = r.ok ? r.unit.placements.find((x) => x.campaignId === campaignId) : undefined;
    if (r.ok && p) { await app.persistence.flush(); return { unit: r.unit, slot: p.slotIndex, label: r.label }; }
  }
  throw new Error(`No bottle with ${campaignId}`);
}
/** Draw a code as pixels, with whatever we like under its logo, and read it with an independent reader. */
function decodeWithLogo(text: string, fill: 'white' | 'black' | 'noise', share = 0.3) {
  const plan = qrPlan(text, { logo: '<svg viewBox="0 0 1 1"></svg>', logoShare: share });
  const q = plan.matrix, L = plan.logo!, scale = 4, quiet = 4, W = (q.size + quiet * 2) * scale;
  const px = new Uint8ClampedArray(W * W * 4).fill(255);
  let seed = 7;
  for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) {
    const inLogo = r >= L.start && r < L.start + L.modules && c >= L.start && c < L.start + L.modules;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const dark = inLogo ? (fill === 'black' ? true : fill === 'white' ? false : seed % 2 === 0) : q.get(r, c);
    if (dark) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const i = (((r + quiet) * scale + dy) * W + (c + quiet) * scale + dx) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
  }
  return { read: jsQR(px, W, W)?.data ?? null, plan };
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 9, clock, personalizer: fakeAi });
  keys = app.demoKeys!;
  server = await buildServer(app);
  for (const id of ['cmp-fizz', 'cmp-roast']) app.platform.campaigns.get(id)!.review = { status: 'approved', at: new Date(now).toISOString() };
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('logos in our QR codes', () => {
  it('sizes the logo so the code always reads, whatever the logo looks like', () => {
    for (const t of ['HTTPS://GO.FREEWATER.IO/Q/7KX2M9QPA4ZR1C', 'HTTPS://FW.AC/Q/7KX2M9QPA4ZR1C', 'https://shop.example.com/order?fwb=7KX2M9QPA4ZR1C', `https://example.com/${'a'.repeat(300)}`]) {
      for (const fill of ['white', 'black', 'noise'] as const) {
        const { read, plan } = decodeWithLogo(t, fill);
        expect(read).toBe(t);
        expect(plan.logo!.share).toBeGreaterThan(0.15);
        expect(plan.damageTolerance.withLogo).toBeGreaterThan(0.12); // still room for scratches on top of the logo
      }
    }
  });

  it('checks logos and colors before they are saved', () => {
    expect(checkQrLogo('<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>')).toMatch(/scripts/);
    expect(checkQrLogo('data:image/png;base64,iVBORw0KGgo=')).toBeNull();
    expect(checkQrLogo('https://example.com/logo.png')).toMatch(/SVG file or a PNG/);
    expect(checkQrColor('#1A1A1A')).toBeNull();
    expect(checkQrColor('#F2C14E')).toMatch(/too light/);
    expect(qrSvg('HELLO', 0, 0, 100, 'H', { logo: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="red"/></svg>', color: '#2B1A10' })).toContain('fill="#2B1A10"');
  });

  it('prints the company’s logo on its own codes and an advertiser’s logo on theirs, as each company allows', async () => {
    const { label, slot } = await bottleWith('cmp-roast', { others: ['cmp-joes'] });
    const roastQr = label.codes!.find((c) => c.role === 'slot' && c.slotIndex === slot)!;
    expect(label.svg).toContain('>R9</text>'); // Roastery 9's own logo in its code
    expect(label.svg).toContain('<tspan fill="#7FC6EA">w</tspan>'); // FreeWater's initials in the receipt code
    expect(roastQr.text).toMatch(/^HTTPS:\/\/GO\.FREEWATER\.IO\/Q\//);
    // A white-label company can turn advertiser logos off.
    const peak = app.platform.companies.get('peak-spring')!;
    expect(peak.qr!.advertiserLogos).toBe(false);
    const r = await call('PATCH', '/v1/campaigns/cmp-peak-house/codes', keys['peak-spring-admin'], { qr: { mode: 'dynamic', logo: '<svg viewBox="0 0 1 1"></svg>' } });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/doesn't put advertisers' logos/);
    // Preview: how big the logo can be and how much damage the code still takes.
    const p = await call('POST', '/v1/qr/preview', keys['advertiser-joes'], { logo: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#D7262E"/></svg>' });
    expect(p.status).toBe(200);
    expect(p.body.note).toMatch(/still reads with \d+% of it damaged/);
  });
});

describe('static and dynamic codes', () => {
  it('is dynamic unless an advertiser chooses static, and a static code still carries the bottle’s own reference', async () => {
    const joes = app.platform.campaigns.get('cmp-joes')!;
    expect((await call('GET', '/v1/campaigns/cmp-joes/codes', keys['advertiser-joes'])).body.qr.mode).toBe('dynamic');
    const r = await call('PATCH', '/v1/campaigns/cmp-joes/codes', keys['freewater-admin'], { qr: { mode: 'static', staticUrl: 'https://joes.example.com/menu' } });
    expect(r.status).toBe(200);
    const { label, slot } = await bottleWith('cmp-joes');
    const s = label.slots.find((x) => x.slotIndex === slot)!;
    expect(s.qrMode).toBe('static');
    const u = new URL(s.qrUrl);
    expect(u.origin + u.pathname).toBe('https://joes.example.com/menu');
    const fwb = u.searchParams.get('fwb')!;
    expect(await app.codes.find(fwb)).toMatchObject({ kind: 'slot', slot });
    // A sale on Joe's site, reported by our tag with that reference, is matched to the exact bottle.
    const tag = await call('GET', '/v1/ads/tracking', keys['advertiser-joes']);
    await call('POST', '/v1/ads/tracking/domains', keys['advertiser-joes'], { domains: ['joes.example.com'] });
    const sale = await call('POST', '/v1/public/conversions', undefined, JSON.stringify({ tag: tag.body.tagId, fwb, orderId: 'J-500', valueCents: 2400 }), { 'content-type': 'text/plain', origin: 'https://joes.example.com' });
    expect(sale.status).toBe(201);
    const row = (await db.query<any>(`select * from conversions where order_id = 'J-500'`)).rows[0];
    expect(row).toMatchObject({ unit_id: label.unitId, slot, bottle_code: fwb });
    // A dynamic code's reference can't be used to claim a sale (anyone can read it off a bottle).
    await call('PATCH', '/v1/campaigns/cmp-joes/codes', keys['freewater-admin'], { qr: { mode: 'dynamic' } });
    const dyn = await bottleWith('cmp-joes');
    const dynCode = dyn.label.codes!.find((c) => c.role === 'slot' && c.slotIndex === dyn.slot)!.text.split('/').pop()!;
    expect((await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwb: dynCode, orderId: 'J-502', valueCents: 100 })).status).toBe(404);
    // A made-up reference is refused.
    expect((await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwb: 'ZZZZZZZZZZZZZZ', orderId: 'J-501', valueCents: 100 })).status).toBe(404);
    // Back to dynamic.
    await call('PATCH', '/v1/campaigns/cmp-joes/codes', keys['freewater-admin'], { qr: { mode: 'dynamic' } });
    expect(joes.qr).toBeUndefined();
    // A company that doesn't allow static codes.
    const peak = await call('PATCH', '/v1/campaigns/cmp-peak-house/codes', keys['peak-spring-admin'], { qr: { mode: 'static', staticUrl: 'https://peak.example.com' } });
    expect(peak.body.error.message).toMatch(/only prints dynamic codes/);
  });

  it('shows the friend a bottle was passed to a different call to action, decided at the moment of each scan', async () => {
    now = new Date('2026-11-03T20:00:00Z').getTime(); // afternoon in Austin: not morning
    const { unit, slot } = await bottleWith('cmp-fizz');
    const open = (viewer: string) => call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=${viewer}`);
    const first = await open('first-person-01');
    expect(first.body.variant).toBeNull();
    expect(first.body.doc.blocks.find((b: any) => b.type === 'ar')).toMatchObject({ mode: 'label', wrap: { effect: 'sparkle' } });
    await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'first-person-01', experienceLoaded: true, variant: undefined });
    const friend = await open('friend-person-02');
    expect(friend.body.variant).toMatchObject({ id: 'passed-on' });
    expect(friend.body.doc.blocks[0]).toMatchObject({ type: 'hero', title: 'Someone shared this with you' });
    // The first person scanning again still gets theirs; the friend scanning again is still the friend.
    expect((await open('first-person-01')).body.variant).toBeNull();
    await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'friend-person-02', experienceLoaded: true });
    expect((await open('first-person-01')).body.variant).toBeNull();
    expect((await open('friend-person-02')).body.variant).toMatchObject({ id: 'passed-on' });
    // The buy button in AR goes through our click tracking too.
    expect(friend.body.doc.blocks.find((b: any) => b.type === 'ar').cta.url).toMatch(/\/go\//);
    // In the morning, the AI chooses among the versions that fit (and only those).
    now = new Date('2026-11-04T14:00:00Z').getTime();
    asked.length = 0;
    const morning = await open('morning-person-3');
    expect(asked[0]).toBe('default,morning,passed-on');
    expect(morning.body.variant).toMatchObject({ id: 'morning' });
    expect(morning.body.personalizedBy).toBe('test AI');
    expect(morning.body.doc.blocks.find((b: any) => b.type === 'greeting').text).toBe('Morning! A bright one for your walk.');
    expect(morning.body.doc.blocks.find((b: any) => b.type === 'ar').caption).toBe('Morning! A bright one for your walk.');
  });

  it('keeps old bottles useful: once a campaign ends they open the advertiser’s current one', async () => {
    const { unit, slot } = await bottleWith('cmp-luma');
    const luma = app.platform.campaigns.get('cmp-luma')!;
    const fresh = { ...luma, id: 'cmp-luma-2', experienceConfig: { headline: 'Cold brew season is here' }, createdAt: new Date(now).toISOString(), review: { status: 'approved' as const, at: new Date(now).toISOString() } };
    app.platform.campaigns.set(fresh.id, fresh);
    luma.active = false;
    fresh.active = true;
    const page = await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=old-bottle-viewer`);
    expect(page.body.doc.blocks.find((b: any) => b.type === 'offer').headline).toBe('Cold brew season is here');
    luma.afterEnd = 'keep';
    const kept = await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=old-bottle-viewer`);
    expect(kept.body.doc.blocks.find((b: any) => b.type === 'offer').headline).not.toBe('Cold brew season is here');
    app.platform.campaigns.delete(fresh.id);
    luma.active = true;
    delete luma.afterEnd;
  });

  it('checks versions before saving them, and sends an advertiser’s change back to review', async () => {
    const bad = await call('PATCH', '/v1/campaigns/cmp-joes/codes', keys['advertiser-joes'], { variants: [{ id: 'late', name: 'Late night', when: { dayparts: ['midnight'] }, experienceConfig: {} }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/dayparts/);
    const ok = await call('PATCH', '/v1/campaigns/cmp-joes/codes', keys['advertiser-joes'], { variants: [{ id: 'late', name: 'Late night', when: { dayparts: ['night'] }, experienceId: 'coupon', experienceConfig: { headline: 'Late-night double', code: 'NIGHT2' } }], personalize: { ai: true, greeting: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.variants[0].forWhom).toBe('in the night');
    const joes = app.platform.campaigns.get('cmp-joes')!;
    expect(joes.active).toBe(false);
    expect(joes.review?.status).toBe('submitted');
    const preview = await call('POST', '/v1/campaigns/cmp-joes/preview-moment', keys['advertiser-joes'], { daypart: 'night' });
    expect(preview.body.variant).toMatchObject({ id: 'late' });
    // Until review approves it, bottles already out there never show the new version.
    now = new Date('2026-11-05T07:00:00Z').getTime(); // 1 am in Austin
    const printed = [...app.platform.units.values()].find((u) => u.status === 'dispensed' && u.placements.some((p) => p.campaignId === 'cmp-joes'))!;
    const slotJ = printed.placements.find((p) => p.campaignId === 'cmp-joes')!.slotIndex;
    expect((await call('GET', `/v1/public/experience/${printed.id}/${slotJ}?viewer=late-night-viewer`)).body.variant).toBeNull();
    // Nobody else can see or change Joe's code settings.
    expect((await call('GET', '/v1/campaigns/cmp-joes/codes', keys['peak-spring-admin'])).status).toBe(404);
    const pattyKey = (await createApiKey(db, { companyId: 'freewater', name: 'Patty', scopes: ['campaigns'], advertiserId: 'adv-patty' })).key;
    expect((await call('PATCH', '/v1/campaigns/cmp-joes/codes', pattyKey, { personalize: null })).status).toBe(404);
    expect((await call('GET', `/v1/ops/units/${printed.id}/handoff`, keys['peak-spring-admin'])).status).toBe(404);
    await call('PATCH', '/v1/campaigns/cmp-joes/codes', keys['freewater-admin'], { variants: [], personalize: null });
    await call('PATCH', '/v1/campaigns/cmp-joes', keys['freewater-admin'], { active: true });
  });

  it('never makes a scan wait long for the AI, and checks what it writes', async () => {
    let calls = 0;
    const slow: Personalizer = { name: 'slow', personalize: () => { calls++; return new Promise((r) => setTimeout(() => r({ choice: 'v1', greeting: 'Hello there', by: 'slow' }), 120)); } };
    const cached = new CachedPersonalizer(slow, { waitMs: 20 });
    const input = { campaignId: 'c', advertiser: 'A', category: 'food', options: [{ id: 'default', name: 'Standard', summary: '' }, { id: 'v1', name: 'V1', summary: '' }], wantGreeting: true, facts: { firstScanner: true, passedOn: false, newToAdvertiser: true, daypart: 'morning' as const, day: 1, interests: [], keptMinutes: 3 } };
    const t0 = Date.now();
    const quick = await cached.personalize(input);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(quick.by).toBe('built-in');
    await new Promise((r) => setTimeout(r, 150));
    expect(await cached.personalize(input)).toMatchObject({ choice: 'v1', by: 'slow' }); // kept for the next person in the same moment
    expect(calls).toBe(1);
    expect(checkGreeting('Visit www.example.com now')).toBeNull();
    expect(checkGreeting('CALL 512-555-0100 TODAY')).toBeNull();
    expect(checkGreeting('Good morning, coffee lover.')).toBe('Good morning, coffee lover.');
  });
});

/** A camera picture of a bottle wrapped in this label, at this pose: for checking the tracker without a phone. */
function photograph(K: G.Intrinsics, p: G.Pose, W: number, H: number, g: G.LabelGeometry, codes: PrintedCode[]) {
  const out = new Uint8Array(W * H);
  const r = G.radius(g), C = G.circumference(g);
  const Rt: G.Mat3 = [p.R[0], p.R[3], p.R[6], p.R[1], p.R[4], p.R[7], p.R[2], p.R[5], p.R[8]];
  const O: G.Vec3 = [-(Rt[0] * p.t[0] + Rt[1] * p.t[1] + Rt[2] * p.t[2]), -(Rt[3] * p.t[0] + Rt[4] * p.t[1] + Rt[5] * p.t[2]), -(Rt[6] * p.t[0] + Rt[7] * p.t[1] + Rt[8] * p.t[2])];
  const markers = codes.filter((c) => c.role === 'marker');
  const sample = (x: number, y: number) => {
    for (const m of markers) {
      const cell = m.sizeIn / 6, u = (x - m.xIn) / cell, v = (y - m.yIn) / cell;
      if (u >= -1 && u < 7 && v >= -1 && v < 7) { const cc = Math.floor(u), rr = Math.floor(v); if (rr < 0 || cc < 0 || rr > 5 || cc > 5) return 250; return rr === 0 || rr === 5 || cc === 0 || cc === 5 || markerBit(m.markerId!, rr - 1, cc - 1) ? 15 : 250; }
    }
    return 140 + 60 * Math.sin(x * 5) * Math.cos(y * 3); // artwork
  };
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    let acc = 0;
    for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const d = [(u + sx! - K.cx) / K.fx, (v + sy! - K.cy) / K.fy, 1];
      const D = [Rt[0]! * d[0]! + Rt[1]! * d[1]! + Rt[2]! * d[2]!, Rt[3]! * d[0]! + Rt[4]! * d[1]! + Rt[5]! * d[2]!, Rt[6]! * d[0]! + Rt[7]! * d[1]! + Rt[8]! * d[2]!];
      const a = D[0]! * D[0]! + D[2]! * D[2]!, b = 2 * (O[0]! * D[0]! + O[2]! * D[2]!), c = O[0]! * O[0]! + O[2]! * O[2]! - r * r, disc = b * b - 4 * a * c;
      let val = 90;
      if (disc >= 0) {
        const s = (-b - Math.sqrt(disc)) / (2 * a), P = [O[0]! + s * D[0]!, O[1]! + s * D[1]!, O[2]! + s * D[2]!];
        let th = Math.atan2(P[0]!, P[2]!); if (th < 0) th += 2 * Math.PI;
        const x = g.seamIn + (th / (2 * Math.PI)) * C, y = g.heightIn / 2 - P[1]!;
        val = y >= 0 && y <= g.heightIn ? sample(x, y) : 170;
      }
      acc += val;
    }
    out[v * W + u] = acc / 4;
  }
  return out;
}

describe('AR that follows the bottle', () => {
  it('prints the tracking strip only on bottles that carry AR on the bottle, and tells the phone where everything is', async () => {
    const plain = await bottleWith('cmp-luma');
    expect(plain.label.codes!.some((c) => c.role === 'marker')).toBe(false);
    const fizz = await bottleWith('cmp-fizz');
    const markers = fizz.label.codes!.filter((c) => c.role === 'marker');
    expect(markers.length).toBeGreaterThanOrEqual(12); // about every 20 degrees round the full-wrap ad
    expect(new Set(markers.map((m) => m.markerId)).size).toBe(markers.length);
    const map = await call('GET', `/v1/public/ar/${fizz.unit.id}`);
    expect(map.body).toMatchObject({ unitId: fizz.unit.id, label: { widthIn: 8.6, heightIn: 4.5 }, container: { shape: 'bottle', diameterIn: 2.66 } });
    expect(map.body.slots[0].wrap).toMatchObject({ effect: 'sparkle', color: '#E8458B' });
    expect(map.body.codes.length).toBe(fizz.label.codes!.length);
    const svg = await server.inject({ method: 'GET', url: map.body.labelSvgUrl });
    expect(svg.headers['content-type']).toMatch(/svg/);
    // On a bottle with on-bottle AR from one advertiser, the strip runs along every ad so tracking works all the way round.
    const roast = await bottleWith('cmp-roast', { others: ['cmp-joes', 'cmp-daily'] });
    const slotsWithMarkers = new Set(roast.label.codes!.filter((c) => c.role === 'marker').map((c) => c.slotIndex));
    const bottomRow = roast.unit.placements.filter((p) => Math.abs(p.rect.y + p.rect.h - 1) < 0.001).map((p) => p.slotIndex);
    expect([...slotsWithMarkers].sort()).toEqual(bottomRow.sort()); // the strip runs along the bottom of the label, under every ad there
  });

  it('reads the markers in any turn of the picture', () => {
    expect(MARKER_CODES.length).toBe(64);
    for (const id of [0, 9, 33, 63]) for (const ang of [0.2, 1.7, 3.3, 4.6]) {
      const W = 160, img = new Uint8Array(W * W).fill(225), s = 54, c = Math.cos(ang), sn = Math.sin(ang);
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const dx = x + 0.5 - 80, dy = y + 0.5 - 80, u = (dx * c + dy * sn) / s + 0.5, v = (-dx * sn + dy * c) / s + 0.5;
        if (u >= -1 / 6 && u < 7 / 6 && v >= -1 / 6 && v < 7 / 6) { const cc = Math.floor(u * 6), rr = Math.floor(v * 6); const dark = rr >= 0 && rr < 6 && cc >= 0 && cc < 6 && (rr === 0 || rr === 5 || cc === 0 || cc === 5 || markerBit(id, rr - 1, cc - 1)); img[y * W + x] = dark ? 20 : 250; }
      }
      expect(findMarkers(img, W, W).map((m) => m.id)).toEqual([id]);
    }
  });

  it('finds the bottle from its own label all the way around, closely enough to lay a new label over the real one', async () => {
    const { label } = await bottleWith('cmp-fizz');
    const product = app.platform.products.get('bottle-16oz')!;
    const g = product.label;
    const markers = new Map(label.codes!.filter((c) => c.role === 'marker').map((c) => [c.markerId!, c]));
    const W = 640, H = 480, K = G.intrinsicsFor(W, H, 65);
    let good = 0, tried = 0;
    for (let turn = 0.1; turn < 2 * Math.PI; turn += 0.7) for (const tilt of [-0.15, 0.12]) {
      tried++;
      const truth = G.poseLookingAt(turn, 7, tilt, [0.2, -1.2, 0]); // the label's bottom edge, where the strip is, near the middle of the picture
      const seen = findMarkers(photograph(K, truth, W, H, g, label.codes!), W, H, { minSide: 8 });
      const sol = G.solvePoseMulti(K, g, seen.filter((s) => markers.has(s.id)).map((s) => ({ spot: markers.get(s.id)!, corners: s.corners })));
      if (!sol) continue;
      // Check a point on the label well away from the markers: where we'd draw it against where it really is.
      const probe = G.labelPoint(g, g.seamIn + G.circumference(g) * (((turn / (2 * Math.PI)) + 0.1) % 1), 0.6); // near the top, far from the strip
      const [a, b] = [G.project(K, sol.pose, probe), G.project(K, truth, probe)];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < W * 0.012) good++;
    }
    expect(good).toBeGreaterThanOrEqual(tried - 2); // the panel side has no strip; the receipt QR covers it on a phone
  });

  it('serves the AR viewer to phones as one file', async () => {
    const r = await server.inject({ method: 'GET', url: '/static/ar.js' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('FWAR');
    expect(r.body.length).toBeGreaterThan(100_000);
  }, 30_000);
});

describe('right ads, right hands', () => {
  it('prints an ad that targets people only for someone who fits, and proves the bottle reached them', async () => {
    const roast = app.platform.campaigns.get('cmp-roast')!;
    roast.targeting = { audience: { interestsAny: ['coffee'] } };
    // Bottles for nobody in particular never carry it.
    only(['cmp-roast', 'cmp-joes']);
    for (let i = 0; i < 15; i++) {
      const r = await app.platform.order({ companyId: 'freewater', orderId: `anon-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      expect(r.unit.placements.some((p) => p.campaignId === 'cmp-roast')).toBe(false);
    }
    // Someone who likes coffee and turned on personalized offers gets it, from the machine, with the reason recorded.
    const t = await signIn('coffee@example.com');
    await call('PATCH', '/v1/me', t, { consents: { personalizedOffers: true }, interests: ['coffee', 'running'] });
    const viewerKey = (await call('GET', '/v1/me', t)).body.viewerKey as string;
    let unitId: string | null = null;
    for (let i = 0; i < 25 && !unitId; i++) {
      const code = (await call('GET', '/v1/machines/ATX-014/presence', keys['machine-ATX-014'])).body.code;
      const v = await call('POST', '/v1/me/vends', t, { vendId: `v-${i}`, locationId: 'ATX-014', presenceCode: code });
      const u = app.platform.units.get(v.body.bottle?.id);
      if (u?.placements.some((p) => p.campaignId === 'cmp-roast')) unitId = u.id;
      now += 9 * 3600_000; // the daily limit
    }
    expect(unitId).not.toBeNull();
    const unit = app.platform.units.get(unitId!)!;
    expect(unit.intendedFor).toBe(viewerKey);
    expect(unit.placements.find((p) => p.campaignId === 'cmp-roast')!.audienceMatch).toEqual(['likes coffee']);
    // Their own first scan confirms it was in their hands.
    await call('POST', '/v1/public/scans', undefined, { unitId, slot: 0, viewerKey, experienceLoaded: true });
    const trail = await call('GET', `/v1/ops/units/${unitId}/handoff`, keys['freewater-admin']);
    expect(trail.body).toMatchObject({ forPerson: true, handedOver: { how: 'machine' }, firstScan: { byIntended: true }, verdict: 'confirmed', chosenBecause: [{ advertiser: 'Roastery 9', reasons: ['likes coffee'] }] });
    const roastKey = (await createApiKey(db, { companyId: 'freewater', name: 'Roastery', scopes: ['campaigns', 'purchases'], advertiserId: 'adv-roast' })).key;
    const reach = await call('GET', '/v1/ads/reach', roastKey);
    expect(reach.body).toMatchObject({ printedForPeople: 1, handedOver: 1, confirmed: 1, confirmedShare: 1, chosenBecause: [{ reason: 'likes coffee', bottles: 1 }] });
    roast.targeting = {};
  });
});

describe('any drink, any size', () => {
  it('checks a product before it can print', () => {
    expect(checkProduct(can12oz).problems).toEqual([]);
    const wrongWrap = checkProduct({ ...can12oz, container: { shape: 'can', diameterIn: 3.2 } });
    expect(wrongWrap.problems.join(' ')).toMatch(/wrap closes/);
    const tiny = checkProduct({ ...can12oz, id: 'tiny-can', label: { ...can12oz.label, widthIn: 3, heightIn: 1.6, panelWidthIn: 0.7 }, container: { shape: 'can' }, sizes: [10] });
    expect(tiny.problems.join(' ')).toMatch(/1\/10 doesn't fit on this label/);
    expect(checkProduct({ ...can12oz, container: { shape: 'pouch' } }).ar.followsBottle).toBe(false);
  });

  it('prints a can with its own size and facts, keeps ads to the products they target, and prices a bigger label higher', async () => {
    const luma = app.platform.campaigns.get('cmp-luma')!;
    luma.targeting = { products: ['can-12oz'] };
    only(['cmp-luma', 'cmp-joes']);
    const onBottle = await app.platform.order({ companyId: 'freewater', orderId: 'prod-1', locationId: 'ATX-014', productId: 'bottle-16oz' });
    expect(onBottle.unit.placements.some((p) => p.campaignId === 'cmp-luma')).toBe(false);
    const can = await bottleWith('cmp-luma', { productId: 'can-12oz', others: ['cmp-joes'] });
    expect(can.label.widthIn).toBe(8.37);
    expect(can.label.heightIn).toBe(3.9);
    expect(can.label.svg).toContain('12 fl oz (355 ml)');
    luma.targeting = {};
    const big = await bottleWith('cmp-joes', { productId: 'bottle-25oz' });
    const small = await bottleWith('cmp-joes');
    const price = (u: typeof big.unit) => u.placements.find((p) => p.campaignId === 'cmp-joes')!;
    const list = app.platform.companies.get('freewater')!.prices.perPrintByShare;
    expect(price(big.unit).priceCents).toBe(Math.round(list[price(big.unit).share] * 1.25));
    expect(price(small.unit).priceCents).toBe(list[price(small.unit).share]);
  });

  it('lets a company add its own products and choose what each machine hands out', async () => {
    const product = { id: 'cold-brew-8oz', name: '8 oz cold brew can', category: 'coffee', container: { shape: 'can', diameterIn: 2.1 }, label: { widthIn: 6.8, heightIn: 3.4, seamIn: 0.2, panelWidthIn: 0.8 }, sizes: [1, 2, 4] };
    const check = await call('POST', '/v1/console/products/check', keys['freewater-admin'], { product });
    expect(check.body.check.problems).toEqual([]);
    expect(check.body.svg).toContain('width="6.8in"');
    expect((await call('POST', '/v1/console/products', keys['freewater-admin'], { product })).status).toBe(201);
    expect((await call('POST', '/v1/console/products', keys['peak-spring-admin'], { product })).status).toBe(403); // FreeWater's, not theirs
    expect((await call('POST', '/v1/console/products', keys['peak-spring-admin'], { product: { ...app.platform.products.get('bottle-16oz'), name: 'Mine now' } })).status).toBe(403); // shared
    const list = await call('GET', '/v1/console/products', keys['peak-spring-admin']);
    expect(list.body.map((p: any) => p.id)).not.toContain('cold-brew-8oz');
    expect((await call('PATCH', '/v1/console/machines/ATX-014', keys['freewater-admin'], { products: ['bottle-16oz', 'cold-brew-8oz'] })).status).toBe(200);
    expect(app.platform.locations.get('ATX-014')!.products).toEqual(['bottle-16oz', 'cold-brew-8oz']);
    expect((await call('PATCH', '/v1/console/machines/ATX-014', keys['freewater-admin'], { products: ['no-such-thing'] })).body.error.code).toBe('unknown_product');
    const t = await signIn('can@example.com');
    const code = (await call('GET', '/v1/machines/ATX-014/presence', keys['machine-ATX-014'])).body.code;
    const v = await call('POST', '/v1/me/vends', t, { vendId: 'can-1', locationId: 'ATX-014', presenceCode: code, productId: 'can-12oz' });
    expect(v.status).toBe(422);
    expect(v.body.error.code).toBe('not_stocked');
  });
});
