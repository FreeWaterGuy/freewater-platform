import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { checkKeepsake, renderKeepsake } from '../src/modules/creative/keepsake';
import { ClaudeDesigner } from '../src/modules/ai/claudeDesigner';
import { BuiltinDesigner } from '../src/modules/ai/builtinDesigner';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(200)]);

async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).json().token as string;
}
const say = async (t: string, id: string, text: string, attachments?: unknown[]) => (await call('POST', `/v1/me/designs/${id}/messages`, t, { text, ...(attachments ? { attachments } : {}) })).json();
const presence = async () => (await call('GET', '/v1/machines/ATX-014/presence', keys['machine-ATX-014'])).json().code as string;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 12, clock });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('the keepsake label', () => {
  it('puts each name in, escapes everything, and keeps the QR corner clear', () => {
    const spec = { headline: 'Cheers, {name}!', sub: 'Love <3 & hugs', colors: { bg: '#F7C6D4', fg: '#0B0B0B', accent: '#B8862E' }, layout: 'words' as const, decoration: 'confetti' as const };
    const a = renderKeepsake(spec, 590, 450, 'Ana');
    // (Lines may break anywhere between words: measured in the widest likely font, src/modules/creative/text.ts.)
    expect(a.replace(/<\/text><text[^>]*>/g, ' ')).toContain('Cheers, Ana!');
    expect(a).toContain('Love &lt;3 &amp; hugs');
    expect(renderKeepsake(spec, 590, 450, 'Ana')).toBe(a); // the same design draws the same way every time
    expect(checkKeepsake({ ...spec, layout: 'photo-left' })).toMatch(/needs a photo/);
  });
});

describe('designing a bottle by chatting', () => {
  it('turns a description into a design, with photos, a video, names and a message', async () => {
    const t = await signIn('jordan@example.com');
    const d = (await call('POST', '/v1/me/designs', t)).json();
    expect(d.ready).toBe(false);

    let r = await say(t, d.id, "Maya's 30th birthday, pink and gold. Love, Jordan", [{ dataUrl: png, name: 'maya.png' }]);
    expect(r.design.label).toMatchObject({ headline: 'Maya turns 30', colors: { bg: '#F7C6D4' }, photo: true, layout: 'photo-left', decoration: 'confetti' });
    expect(r.design.scan).toMatchObject({ from: 'Jordan', confetti: true });
    expect(r.design.scan.message).toMatch(/Happy birthday, Maya/);
    expect(r.designSvg).toMatch(/Maya[\s\S]*turns[\s\S]*30/);
    expect(r.messages.at(-2).attachments[0]).toMatchObject({ kind: 'image', name: 'maya.png' });

    // A video for the scan page: uploaded first, then mentioned in the chat.
    const v = await call('POST', '/v1/me/assets?name=toast.mp4', t, mp4, { 'content-type': 'video/mp4' });
    expect(v.statusCode).toBe(201);
    r = await say(t, d.id, 'When friends scan it, play our video and say "Happy 30th, Maya! We love you."', [{ assetId: v.json().id, name: 'toast.mp4' }]);
    expect(r.design.scan.videoUrl).toBe(v.json().url);
    expect(r.design.scan.message).toBe('Happy 30th, Maya! We love you.');

    // Someone else's video can't be used.
    const other = await signIn('other@example.com');
    const ov = (await call('POST', '/v1/me/assets', other, mp4, { 'content-type': 'video/mp4' })).json();
    expect((await call('POST', `/v1/me/designs/${d.id}/messages`, t, { text: 'use this', attachments: [{ assetId: ov.id }] })).json().error.code).toBe('not_found');
    expect((await call('GET', `/v1/me/designs/${d.id}`, other)).statusCode).toBe(404);

    r = await say(t, d.id, 'Make 3 bottles with a name on each. Names: Maya, Ana, Ben');
    expect(r.design).toMatchObject({ quantity: 3, names: ['Maya', 'Ana', 'Ben'] });
    expect(r.design.label.sub).toBe('{name}');
    expect(r.totalCents).toBe(900);
    expect(r.ready).toBe(true);

    const scan = (await call('GET', `/v1/me/designs/${d.id}/scan-preview`, t)).json();
    expect(scan.doc.blocks.map((b: any) => b.type)).toEqual(['message', 'confetti', 'video']);

    // The proof shows bottle 1 exactly as it prints; paying prints all three, each with its own name.
    const proof = (await call('POST', `/v1/me/designs/${d.id}/proof`, t)).json();
    expect(proof).toMatchObject({ quantity: 3, names: ['Maya', 'Ana', 'Ben'], totalCents: 900 });
    expect(proof.labelSvg).toContain('>Maya<');
    await call('POST', '/v1/me/cards', t, { token: 'tok_visa' });
    const order = await call('POST', '/v1/me/custom-orders', t, { orderId: 'party', proofId: proof.proofId, locationId: 'ATX-014', presenceCode: await presence() });
    expect(order.statusCode).toBe(201);
    const o = order.json();
    expect(o.bottles).toHaveLength(3);
    expect(o.payment).toMatchObject({ status: 'captured', amountCents: 900 });
    expect(o.countdown.seconds).toBe(72);
    const labels = await Promise.all(o.bottles.map((b: any) => app.platform.labelSvg(b.id)));
    expect(labels[1]).toContain('>Ana<');
    expect(labels[2]).toContain('>Ben<');
    const page = (await call('GET', `/v1/public/experience/${o.bottles[2].id}/0?viewer=friend-phone-99`)).json();
    expect(page.doc.blocks[0]).toEqual({ type: 'message', from: 'Jordan', text: 'Happy 30th, Maya! We love you.' });
    expect((await call('GET', `/v1/me/designs/${d.id}`, t)).json().status).toBe('ordered');
    expect((await call('POST', `/v1/me/designs/${d.id}/messages`, t, { text: 'more' })).json().error.code).toBe('already_ordered');
  });

  it('charges only for bottles that print', async () => {
    const t = await signIn('team@example.com');
    await call('POST', '/v1/me/cards', t, { token: 'tok_visa' });
    const d = (await call('POST', '/v1/me/designs', t)).json();
    await say(t, d.id, 'Thank-you bottles for my team. 4 bottles. When they scan it say "You made this year."');
    const proof = (await call('POST', `/v1/me/designs/${d.id}/proof`, t)).json();
    expect(proof.quantity).toBe(4);
    (app.printer as any).failNext('jam'); (app.printer as any).failNext('jam'); // the first bottle fails, and fails again on retry
    const o = (await call('POST', '/v1/me/custom-orders', t, { orderId: 'team', proofId: proof.proofId, locationId: 'ATX-014', presenceCode: await presence() })).json();
    expect(o.bottles.length).toBe(3);
    expect(o.payment.amountCents).toBe(900);
    expect(o.notice).toMatch(/1 of 4 didn't print/);
  });

  it('won’t make a proof until the words and message are there', async () => {
    const t = await signIn('early@example.com');
    const d = (await call('POST', '/v1/me/designs', t)).json();
    const r = await call('POST', `/v1/me/designs/${d.id}/proof`, t);
    expect(r.json().error.code).toBe('not_ready');
  });
});

describe('swapping the design AI', () => {
  it('runs Claude through the same checks', async () => {
    let sent: any;
    const fetchStub = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Gold on navy, very elegant.' }, { type: 'tool_use', name: 'update_design', input: { label: { headline: 'Class of 2026', colors: { bg: '#1F2A44', fg: '#1F2A45', accent: '#F2C14E' }, font: 'script', decoration: 'fireworks' }, quantity: 99, scan: { message: 'We did it!' } } }] }), { status: 200 });
    }) as typeof fetch;
    const original = app.designs.assistant;
    app.designs.assistant = new ClaudeDesigner({ apiKey: 'k', fallback: new BuiltinDesigner(), fetch: fetchStub });
    try {
      const t = await signIn('grad@example.com');
      const d = (await call('POST', '/v1/me/designs', t)).json();
      const r = await say(t, d.id, 'graduation bottles', [{ dataUrl: png, name: 'grads.png' }]);
      expect(sent.tools[0].name).toBe('update_design');
      expect(sent.messages.at(-1).content[0].type).toBe('image');
      expect(r.design.label).toMatchObject({ headline: 'Class of 2026', font: 'script', colors: { fg: '#FFFFFF' } });
      expect(r.design.label.decoration).toBeUndefined(); // not a decoration we have
      expect(r.design.quantity).toBe(1); // 99 is too many
      expect(r.messages.at(-1).text).toMatch(/elegant[\s\S]*1 to 24 bottles/);
    } finally {
      app.designs.assistant = original;
    }
  });
});
