// Financial controls for ads paid up front (docs/SWITCHES.md, "How advertisers pay"), kept as permanent checks: a
// randomized sequence of buys (some cards declined), prints at machines, labels made ahead for a machine's offline
// stock (printed later or let go), exact reprints, changes (the change fee), stops (the refund), pauses and a restart,
// with every money invariant checked after every step:
//   - every cent charged equals the quote; cash in and out of the books equals the card processor's
//   - each printed bottle draws exactly one paid bottle, at the price paid; never more printed than paid; never a draw
//     for a stopped ad; a reprint never draws again
//   - each advertiser's prepaid balance in the books equals what's left to print, is never below nothing, and the
//     database's running balance agrees
//   - refunds go back once, and never more than the card paid
//   - the books balance, and the daily reconciliation's prepaid checks pass
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { Campaign, Share, Unit } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { PrepaidService } from '../src/modules/ads/prepaid';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { seededRandom } from '../src/core/ids';

let db: SqlClient, app: App, provider: TestPaymentProvider;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const n = (v: unknown) => Number(v ?? 0);
const CO = 'freewater';
let k = 0, orderNo = 0;

const boot = () => createApp({ db, seedDemo: k === 0, seed: 21, clock, payments: provider, productLookup: null, anchorPublishers: [] } as any);

beforeAll(async () => {
  PrepaidService.minBottles = 1; // small orders, so a run prints every paid bottle
  db = await createPgliteClient();
  provider = new TestPaymentProvider();
  app = await boot();
  for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === CO) c.active = false; // only this run's ads
}, 120_000);
afterAll(async () => { PrepaidService.minBottles = 100; await app.persistence.flush(); await db.close(); });

async function newAd(share: Share, token = 'tok_visa') {
  const i = ++k;
  const adv = `adv-cp-${i}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,$2,$3,'retail')`, [adv, CO, `Controls Shop ${i}`]);
  await app.payments.addMethod(CO, 'advertiser', adv, token);
  const spec = { brand: `Ctl ${i}`, headline: `Offer ${i}`, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-cp-${i}`, companyId: CO, advertiserId: adv, advertiserName: `Controls Shop ${i}`, category: 'retail', sizes: [share], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: `Offer ${i}` }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  return c;
}

/** Every invariant, against the database, the bottles, the books and the card processor. */
async function invariants(label: string) {
  await app.persistence.flush();
  const entries = app.platform.ledger.entries.filter((l) => l.companyId === CO);
  const bal = (acct: string) => entries.reduce((s, l) => s + (l.credit === acct ? l.amountCents : 0) - (l.debit === acct ? l.amountCents : 0), 0);
  // 1. The books balance.
  let total = 0;
  for (const v of app.platform.ledger.balances().values()) total += v;
  expect(total, `${label}: books balance`).toBe(0);
  // 2. Charged exactly the quote: each paid order's card payment is its total (less credit), captured once.
  const orders = (await db.query<any>(`select o.id, o.kind, o.status, o.total_cents, o.credit_cents, o.advertiser_id, o.bottles, o.price_cents, o.extras_cents, p.amount_cents, p.status as pay, p.provider_ref from ad_orders o left join payments p on p.id = o.payment_id where o.company_id = $1 and o.advertiser_id like 'adv-cp-%'`, [CO])).rows;
  for (const o of orders) {
    if (o.status === 'paid' && o.kind === 'bottles') expect(n(o.total_cents), `${label}: order ${o.id} total = bottles × price + extras`).toBe(n(o.bottles) * n(o.price_cents) + n(o.extras_cents));
    if (o.status === 'paid') expect([o.pay, n(o.amount_cents)], `${label}: order ${o.id} charged`).toEqual(['captured', n(o.total_cents) - n(o.credit_cents)]);
    if (o.status === 'declined') expect(o.pay, `${label}: declined order ${o.id} captured`).not.toBe('captured');
  }
  const captured = (await db.query<any>(`select p.ref, p.purpose, p.amount_cents, p.provider_ref, o.advertiser_id as payer_id from payments p join ad_orders o on o.id = p.ref where p.company_id = $1 and p.status = 'captured' and p.purpose in ('ad_order','ad_change') and o.advertiser_id like 'adv-cp-%'`, [CO])).rows;
  for (const p of captured) expect(orders.find((o) => o.id === p.ref)?.status, `${label}: payment for ${p.ref} captured but its order isn't paid`).toBe('paid');
  // 3. Cash in the books equals the processor: in (captured) and out (refunds), per advertiser.
  const refunds = (await db.query<any>(`select campaign_id, advertiser_id, total_cents, status, payment_id from ad_refunds where company_id = $1 and advertiser_id like 'adv-cp-%'`, [CO])).rows;
  expect(refunds.filter((r) => r.status !== 'refunded'), `${label}: refunds not sent`).toEqual([]);
  for (const p of captured) expect(provider.refundedOn(p.provider_ref), `${label}: refunded more than ${p.ref} took`).toBeLessThanOrEqual(n(p.amount_cents));
  const advertisers = new Set([...orders.map((o) => o.advertiser_id as string)]);
  for (const adv of advertisers) {
    const acct = `prepaid:advertiser:${adv}`;
    const inBooks = entries.filter((l) => l.kind === 'payment' && l.credit === acct).reduce((s, l) => s + l.amountCents, 0);
    const outBooks = entries.filter((l) => l.kind === 'prepay_refund' && l.debit === acct).reduce((s, l) => s + l.amountCents, 0);
    const paidIn = captured.filter((p) => p.payer_id === adv && p.purpose === 'ad_order').reduce((s, p) => s + n(p.amount_cents), 0);
    const paidBack = captured.filter((p) => p.payer_id === adv).reduce((s, p) => s + provider.refundedOn(p.provider_ref), 0);
    expect([inBooks, outBooks], `${label}: ${adv} cash in the books vs the processor`).toEqual([paidIn, paidBack]);
    expect(bal(acct), `${label}: ${adv} prepaid balance below nothing`).toBeGreaterThanOrEqual(0);
  }
  // Change fees: every paid change order is earned once.
  const fees = orders.filter((o) => o.kind === 'change' && o.status === 'paid').reduce((s, o) => s + n(o.total_cents), 0);
  expect(entries.filter((l) => l.credit === 'revenue:change_fee' && l.kind === 'payment').reduce((s, l) => s + l.amountCents, 0) - entries.filter((l) => l.debit === 'revenue:change_fee').reduce((s, l) => s + l.amountCents, 0), `${label}: change fees`).toBe(fees);
  // 4. Each printed bottle drew one paid bottle at the price paid; never more printed than paid; never after a stop.
  const rows = new Map((await db.query<any>(`select * from ad_prepaid where company_id = $1 and advertiser_id like 'adv-cp-%'`, [CO])).rows.map((r) => [r.campaign_id as string, r]));
  const printedBy = new Map<string, Unit[]>();
  for (const u of app.platform.units.values()) {
    if (u.companyId !== CO || u.voided || (u.status !== 'printed' && u.status !== 'dispensed')) continue;
    const ids = u.placements.filter((p) => !p.isHouse).map((p) => p.campaignId);
    expect(new Set(ids).size, `${label}: an ad twice on ${u.id}`).toBe(ids.length);
    for (const p of u.placements) {
      const r = rows.get(p.campaignId);
      if (p.isHouse || !r) continue;
      expect([p.prepaid, p.priceCents], `${label}: ${u.id} carries ${p.campaignId} at another price or undrawn`).toEqual([true, n(r.price_cents)]);
      const stoppedAt = app.platform.campaigns.get(p.campaignId)?.prepaid?.stoppedAt; // (the platform's clock; the row's is the database's)
      if (stoppedAt && !u.replaces) expect(u.createdAt <= stoppedAt, `${label}: ${p.campaignId} printed after it was stopped`).toBe(true);
      printedBy.set(p.campaignId, [...(printedBy.get(p.campaignId) ?? []), u]);
    }
  }
  for (const [id, r] of rows) {
    const c = app.platform.campaigns.get(id)!;
    expect(n(r.printed) + n(r.held) + n(r.refunded), `${label}: ${id} drew more than it paid`).toBeLessThanOrEqual(n(r.paid));
    expect(n(r.printed), `${label}: ${id} printed count vs bottles`).toBe(printedBy.get(id)?.length ?? 0);
    expect([c.prepaid?.paid, c.prepaid?.printed, c.prepaid?.held, c.prepaid?.refunded], `${label}: ${id} memory vs database`).toEqual([n(r.paid), n(r.printed), n(r.held), n(r.refunded)]);
    // Earned from it: exactly the bottles printed at its price (a voided bottle's line is reversed, its reprint's stands).
    const earned = entries.filter((l) => l.campaignId === id && l.kind === 'print').reduce((s, l) => s + (l.credit === 'revenue:print' ? l.amountCents : -l.amountCents), 0);
    expect(earned, `${label}: ${id} earned`).toBe(n(r.printed) * n(r.price_cents));
  }
  // 5. The daily reconciliation's prepaid checks.
  const checks = Object.fromEntries((await app.reconciliation.report(CO)).checks.map((c) => [c.id, c]));
  for (const id of ['prepaid_bottles', 'prepaid_balances', 'ledger_balanced']) expect(checks[id]?.status, `${label}: ${id} ${JSON.stringify(checks[id]?.figures ?? {})}`).toBe('ok');
  expect(checks.prepaid_open?.status, `${label}: prepaid_open`).not.toBe('fail');
}

describe('prepaid money controls', () => {
  it('a randomized run of buys, prints, offline stock, reprints, changes, stops, pauses and a restart keeps every invariant after every step', async () => {
    const random = seededRandom(2026);
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]!;
    const ads: Campaign[] = [];
    const prepared: string[] = [];
    let restarted = false;
    const seen = new Set<string>();
    const owner = (await app.accounts.invite({ companyId: CO, email: 'owner-cp@freewater.io', role: 'owner' })).id;
    const live = () => ads.map((c) => app.platform.campaigns.get(c.id)!).filter((c) => c.prepaid && !c.prepaid.stoppedAt);
    for (let step = 0; step < 60; step++) {
      now += 7 * 60_000;
      const roll = random();
      let label = `step ${step}`;
      if (roll < 0.18 || ads.length < 2) {
        const share = pick([2, 3, 4, 6, 8] as Share[]);
        const c = await newAd(share, random() < 0.15 ? 'tok_declined' : 'tok_visa');
        const bottles = 1 + Math.floor(random() * 6);
        const q = app.prepaid.quote(CO, { bottles, share }, c.sizes);
        expect(q.totalCents, `${label}: quote`).toBe(bottles * q.perBottleCents);
        try {
          const paid = await app.prepaid.payBottles({ companyId: CO, advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles, share }, expectedTotalCents: q.totalCents, sizes: c.sizes });
          expect(paid.totalCents).toBe(q.totalCents);
          await app.ads.review({ companyId: CO, campaignId: c.id, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
          ads.push(c);
          label += ` bought ${bottles} at 1/${share}`;
        } catch (e: any) {
          expect(e.code, `${label}: ${e.message}`).toBe('card_declined');
          expect(c.prepaid).toBeUndefined();
          label += ' card declined';
        }
      } else if (roll < 0.5) {
        const out = await app.platform.order({ companyId: CO, orderId: `cp-${++orderNo}`, locationId: 'ATX-022', productId: 'bottle-16oz' });
        label += ` printed ${out.unit.id} (${out.unit.placements.filter((p) => p.prepaid).length} paid)`;
      } else if (roll < 0.6) {
        // A machine's offline stock: a label made ahead (its paid bottles held), printed later or let go.
        if (prepared.length && random() < 0.6) {
          const id = prepared.splice(Math.floor(random() * prepared.length), 1)[0]!;
          const ok = random() < 0.7 ? app.platform.confirmPrepared(id, `job-cp-${step}`) : app.platform.abandonPrepared(id, 'Never printed');
          label += ` offline label ${id} settled (${ok})`;
        } else {
          const { unit } = await app.platform.prepare({ companyId: CO, orderId: `cp-pre-${++orderNo}`, locationId: 'ATX-022', productId: 'bottle-16oz' });
          prepared.push(unit.id);
          label += ` offline label ${unit.id} made`;
        }
      } else if (roll < 0.68) {
        const printed = [...app.platform.units.values()].filter((u) => u.companyId === CO && !u.voided && u.status === 'dispensed' && u.placements.some((p) => p.prepaid && ads.some((c) => c.id === p.campaignId)) && ![...app.platform.units.values()].some((x) => x.replaces === u.id));
        if (printed.length) {
          const u = pick(printed);
          const out = await app.platform.reprint(u.id, 'smudged');
          label += ` reprinted ${u.id} (${out.ok})`;
        }
      } else if (roll < 0.76) {
        // The company stops an ad (a person): only when nothing with it is printing.
        const c = live().find((x) => x.prepaid!.held === 0 && random() < 0.5);
        if (c) {
          const r = await app.prepaid.stop({ companyId: CO, campaignId: c.id, by: `user:${owner}`, reason: 'Stopped in the controls run' });
          expect(r.status, `${label}: refund`).toBe('refunded');
          label += ` stopped ${c.id} (${r.totalCents}¢ back)`;
        }
      } else if (roll < 0.84) {
        // The advertiser changes a running ad: the change fee, then review again.
        const c = live().find((x) => x.creativeRef?.kind === 'poster' && x.review?.status === 'approved' && random() < 0.5);
        if (c) {
          try {
            const d = await app.ads.createDraft({ companyId: CO, advertiserId: c.advertiserId, fromCampaignId: c.id });
            await app.ads.submit({ id: d.id, companyId: CO, advertiserId: c.advertiserId, pay: { expectedFeeCents: 10_000 } });
            await app.ads.review({ companyId: CO, campaignId: c.id, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
            label += ` changed ${c.id}`;
          } catch (e: any) {
            expect(['all_printed', 'card_declined'], `${label}: ${e.message}`).toContain(e.code);
            label += ` change of ${c.id} refused (${e.code})`;
          }
        }
      } else if (roll < 0.92) {
        const c = live().length ? pick(live()) : undefined;
        if (c && c.review?.status === 'approved') { c.active = !c.active; app.platform.persist.campaign(c); label += ` ${c.active ? 'resumed' : 'paused'} ${c.id}`; }
      } else if (!restarted && !prepared.length) {
        // A restart: everything comes back from the database and the bottles.
        await app.persistence.flush();
        app = await boot();
        restarted = true;
        for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === CO && !ads.some((x) => x.id === c.id)) c.active = false;
        for (let i = 0; i < ads.length; i++) ads[i] = app.platform.campaigns.get(ads[i]!.id)!;
        label += ' restarted';
      }
      for (const w of ['bought', 'declined', 'printed', 'offline label', 'reprinted', 'stopped', 'changed', 'restarted']) if (label.includes(w)) seen.add(w);
      await invariants(label);
    }
    // The run went through every kind of step (so it can fail).
    expect([...seen].sort()).toEqual(['bought', 'changed', 'declined', 'offline label', 'printed', 'reprinted', 'restarted', 'stopped']);
    // At the end: every offline label settled, every live ad printed out or stopped.
    for (const id of prepared) app.platform.confirmPrepared(id, `job-cp-end-${id}`);
    for (const c of live()) { c.active = true; c.review = { status: 'approved', at: new Date(now).toISOString() }; }
    for (let i = 0; i < 40 && live().some((c) => c.prepaid!.printed + c.prepaid!.refunded < c.prepaid!.paid); i++) await app.platform.order({ companyId: CO, orderId: `cp-${++orderNo}`, locationId: 'ATX-022', productId: 'bottle-16oz' });
    await invariants('end');
    for (const c of live()) expect(app.ads.status(c), c.id).toBe('finished');
  }, 600_000);

  it('a change to an ad with nothing left to print is refused before the change fee is charged', async () => {
    const c = await newAd(4);
    const q = app.prepaid.quote(CO, { bottles: 2, share: 4 }, c.sizes);
    await app.prepaid.payBottles({ companyId: CO, advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles: 2, share: 4 }, expectedTotalCents: q.totalCents, sizes: c.sizes });
    await app.ads.review({ companyId: CO, campaignId: c.id, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
    for (const x of app.platform.campaigns.values()) if (!x.isHouse && x.companyId === CO && x.id !== c.id) x.active = false;
    const printOne = () => app.platform.order({ companyId: CO, orderId: `cp-${++orderNo}`, locationId: 'ATX-022', productId: 'bottle-16oz' });
    await printOne();
    // A change begun with one bottle left, submitted after the last one printed: nothing is charged.
    const d = await app.ads.createDraft({ companyId: CO, advertiserId: c.advertiserId, fromCampaignId: c.id });
    await printOne();
    expect(app.ads.status(c)).toBe('finished');
    const charges = async () => (await db.query<any>(`select count(*)::int as n from payments p join ad_orders o on o.id = p.ref where o.advertiser_id = $1`, [c.advertiserId])).rows[0].n;
    const before = await charges();
    await expect(app.ads.submit({ id: d.id, companyId: CO, advertiserId: c.advertiserId, pay: { expectedFeeCents: 10_000 } })).rejects.toMatchObject({ code: 'all_printed' });
    await expect(app.ads.createDraft({ companyId: CO, advertiserId: c.advertiserId, fromCampaignId: c.id })).rejects.toMatchObject({ code: 'all_printed' });
    expect(await charges()).toBe(before);
    await invariants('finished ad');
  });
});

describe('the daily reconciliation shows money waiting on a person', () => {
  it('a paid ad finally rejected by a person: its refund waiting is in the report until someone stops it and pays it back', async () => {
    const c = await newAd(4);
    const q = app.prepaid.quote(CO, { bottles: 3, share: 4 }, c.sizes);
    await app.prepaid.payBottles({ companyId: CO, advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles: 3, share: 4 }, expectedTotalCents: q.totalCents, sizes: c.sizes });
    c.review = { status: 'submitted', at: new Date(now).toISOString() };
    const person = (await app.accounts.invite({ companyId: CO, email: 'reviewer-cp@freewater.io', role: 'owner' })).id;
    await app.ads.review({ companyId: CO, campaignId: c.id, decision: 'reject', note: 'Claims a cure it can’t back up', by: { userId: person, role: 'owner' } });
    const open = async () => Object.fromEntries((await app.reconciliation.report(CO)).checks.map((x) => [x.id, x])).prepaid_open!;
    expect((await open()).figures?.rejectedNotRefunded).toEqual([c.id]);
    expect((await open()).status).toBe('attention');
    const r = await app.prepaid.stop({ companyId: CO, campaignId: c.id, by: `user:${person}`, reason: 'Rejected in review' });
    expect(r).toMatchObject({ status: 'refunded', totalCents: q.totalCents });
    expect((await open()).figures?.rejectedNotRefunded).toEqual([]);
    await invariants('rejected and paid back');
  });
});
