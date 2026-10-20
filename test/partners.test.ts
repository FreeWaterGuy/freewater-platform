import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { GiftCardRefused, TestGiftCards, TremendousGiftCards } from '../src/modules/wallet/giftcards';

let db: SqlClient, app: App;
let now = new Date('2026-10-19T10:15:00Z').getTime();
beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 111, clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' }, anchorPublishers: [] });
  app.chain.isMember = async () => true;
});
afterAll(async () => { await app.persistence.flush(); await db.close(); });

describe('gift cards', () => {
  it('stay off until exchanges are approved (and only after going live)', async () => {
    await expect(app.wallet.buyGiftCard('freewater', 'user:usr_gc', { email: 'a@b.co', product: 'amazon', cents: 500 }, new TestGiftCards())).rejects.toMatchObject({ code: 'switched_off' });
    await expect(app.chain.propose('freewater', 'exchanges_on', {}, 'user:josh')).rejects.toMatchObject({ code: 'wrong_stage' });
  });

  it('once approved: credit becomes a card; if the card company says no, the credit comes back', async () => {
    const live = await app.chain.propose('freewater', 'go_live_points', {}, 'user:josh');
    now += 25 * 3600_000; await app.chain.run('freewater', live.id, 'user:josh');
    const ex = await app.chain.propose('freewater', 'exchanges_on', {}, 'user:josh');
    await app.chain.approve('freewater', ex.id, 'user:amy'); await app.chain.approve('freewater', ex.id, 'user:raj');
    now += 49 * 3600_000; await app.chain.run('freewater', ex.id, 'user:josh');
    expect(app.wallet.settings('freewater').conversions.enabled).toBe(true);
    const fw = app.platform.companies.get('freewater')!;
    fw.wallet = { ...app.wallet.settings('freewater'), credit: { enabled: true } };
    await app.wallet.fundReserve('freewater', 'brand-x', 2_000, 'test', 'pay-gc');
    await app.wallet.giveCredit('freewater', 'brand-x', 'user:usr_gc', 1_200, 'gc1', 'test');
    const card = await app.wallet.buyGiftCard('freewater', 'user:usr_gc', { email: 'a@b.co', product: 'amazon', cents: 600 }, new TestGiftCards());
    expect(card.code).toMatch(/^TEST-AMAZON/);
    expect((await app.wallet.wallet('freewater', 'user:usr_gc')).credit.balanceCents).toBe(600);
    const failing = { name: 'x', catalog: () => new TestGiftCards().catalog(), order: async () => { throw new GiftCardRefused('Tremendous answered 400', 400); } }; // a definite no (a timeout keeps the credit held)
    await expect(app.wallet.buyGiftCard('freewater', 'user:usr_gc', { email: 'a@b.co', product: 'target', cents: 500 }, failing)).rejects.toMatchObject({ code: 'provider_failed' });
    expect((await app.wallet.wallet('freewater', 'user:usr_gc')).credit.balanceCents).toBe(600);
    await expect(app.wallet.buyGiftCard('freewater', 'user:usr_gc', { email: 'a@b.co', product: 'target', cents: 900 }, new TestGiftCards())).rejects.toMatchObject({ code: 'not_enough' });
    expect((await app.wallet.check('freewater')).ok).toBe(true);
  });

  it('Tremendous gets one order per request, with our reference', async () => {
    const sent: any[] = [];
    const t = new TremendousGiftCards({ apiKey: 'k', fundingSource: 'fs', sandbox: true, products: [{ id: 'P1', name: 'Amazon' }], fetch: (async (url: string, init: any) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ order: { id: 'O1', rewards: [{ delivery: { link: 'https://x' } }] } })); }) as any });
    const r = await t.order({ product: 'P1', cents: 500, email: 'a@b.co', ref: 'gc_1' });
    expect(r.ref).toBe('O1');
    expect(sent[0].url).toContain('testflight');
    expect(sent[0].body.external_id).toBe('gc_1');
    expect(sent[0].body.reward.value.denomination).toBe(5);
  });
});
