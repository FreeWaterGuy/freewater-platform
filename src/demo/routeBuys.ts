import type { SqlClient } from '../db/client';
import type { Platform } from '../platform';
import type { Campaign, Share } from '../core/types';
import { posterCreative, type PosterSpec } from '../modules/creative/poster';
import type { RouteBuyService, RouteQuoteInput } from '../modules/ads/routeBuys';
import type { PaymentsService } from '../modules/payments/service';

// The demo's route buys, on the sample Austin pilot area (made-up houses, off until a person turns it on): a blanket
// buy (a tenth of one bottle in every box, every house, two weeks), a whole box with its sides on Leland St, and one
// house (a quarter of the label on two bottles at 1501 Kenwood Ave). Made-up businesses on the test card; no real money.

interface DemoBuy { id: string; advertiser: string; name: string; category: string; share: Share; spec: Omit<PosterSpec, 'colors'> & { colors?: PosterSpec['colors'] }; offer: string; input: RouteQuoteInput; verify?: boolean; laterWeek?: number }

const buys: DemoBuy[] = [
  { id: 'cmp-demo-route-blanket', advertiser: 'Barton Bikes', name: 'Tune-up week', category: 'retail', share: 10, spec: { brand: 'Barton Bikes', headline: 'Tune-ups $39', sub: 'This week only' }, offer: 'A full tune-up for $39 this week. Show this screen.',
    input: { kind: 'blanket', share: 10, weeks: 2, where: { areaIds: ['area-austin-pilot'] } } },
  { id: 'cmp-demo-route-box', advertiser: 'South Congress Pizza', name: 'Pizza night', category: 'food', share: 1, spec: { brand: 'SoCo Pizza', headline: 'Pizza night, delivered', sub: 'Order tonight' }, offer: '20% off your first order tonight.',
    input: { kind: 'box', share: 1, weeks: 1, boxSides: true, where: { streets: [{ areaId: 'area-austin-pilot', street: 'Leland St' }] } }, verify: true, laterWeek: 2 },
  { id: 'cmp-demo-route-house', advertiser: 'Travis Heights Garden Co.', name: 'Spring garden', category: 'home', share: 4, spec: { brand: 'TH Garden Co.', headline: 'Your garden, done', sub: 'Free estimate' }, offer: 'A free garden estimate this month.',
    input: { kind: 'houses', share: 4, weeks: 2, perHouse: 2, where: { addresses: ['1501 Kenwood Ave, Austin, TX 78704'] } }, verify: true },
];

const addWeeks = (monday: string, n: number) => new Date(Date.parse(`${monday}T12:00:00Z`) + n * 7 * 86_400_000).toISOString().slice(0, 10);

export async function seedRouteBuys(platform: Platform, db: SqlClient, routeBuys: RouteBuyService, payments: PaymentsService) {
  for (const b of buys) {
    if ((await db.query(`select 1 from route_buys where campaign_id = $1`, [b.id])).rows.length) continue;
    const adv = `adv-${b.id.slice(4)}`;
    await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,$3) on conflict do nothing`, [adv, b.advertiser, b.category]);
    // A buy aimed at a few houses needs a business the company verified (here, the demo seed stands in for a person).
    if (b.verify) await routeBuys.verify('freewater', adv, true, 'demo seed');
    await payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
    const spec: PosterSpec = { ...b.spec, colors: b.spec.colors ?? { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
    const c: Campaign = { id: b.id, companyId: 'freewater', advertiserId: adv, advertiserName: b.advertiser, category: b.category, sizes: [b.share], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: b.spec.headline, details: b.offer }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, name: b.name, createdAt: platform.bus.now().toISOString() };
    platform.campaigns.set(c.id, c);
    platform.persist.campaign(c);
    // The whole box goes in the third week: the blanket buy (paid first) has a piece in every box the first two.
    const input: RouteQuoteInput = { ...b.input, ...(b.laterWeek ? { startWeek: addWeeks(routeBuys.firstWeek('freewater'), b.laterWeek) } : {}) };
    const q = await routeBuys.quote('freewater', adv, input, c.sizes, { campaignId: c.id, sample: true });
    await routeBuys.pay({ companyId: 'freewater', advertiserId: adv, campaignId: c.id, input, expectedTotalCents: q.totalCents, expectedCreditCents: 0, sizes: c.sizes, words: [b.spec.brand, b.spec.headline, b.spec.sub ?? '', b.offer], sample: true });
    const now = platform.bus.now().toISOString();
    c.review = { status: 'approved', at: now, note: 'Demo: approved by the seed (a sample business on sample houses)' };
    c.active = true;
    platform.persist.campaign(c);
  }
}
