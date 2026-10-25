import { createHash } from 'node:crypto';
import type { SqlClient } from '../db/client';
import { DEMO_BENCHMARK_PREFIX } from '../modules/ads/ratings';

/**
 * A settled month of SAMPLE ad results, so the demo's Benchmarks page shows how benchmarks work (src/modules/ads/ratings.ts,
 * "BENCHMARKS"; docs/AI.md, "Benchmarks: how they're kept anonymous"). Only with the demo seeded into an empty database
 * (SEED_DEMO=1 and the demo scripts), never in production.
 *
 * Nothing about the rules changes: these are ad versions and their outcomes, as the hourly job would have counted them,
 * for made-up advertisers at the demo's two companies, first printed in the latest month that has settled. The real
 * monthly release (snapshotDue) then runs on them as on any month: its thresholds, the check without any one company,
 * complementary suppression, noise and rounding. So some figures are shown, and some are held back (the small industries,
 * and industry-by-channel, where one company alone wouldn't meet the bar), as they would be.
 *
 * Every row's campaign id starts with DEMO_BENCHMARK_PREFIX: that's how the Benchmarks page knows a month holds sample
 * ads and says so, and how the Ad ratings page leaves them out of its list.
 */

/** Industries with enough sample ads to be shown, and two too small to be (held back, to show that too). */
const SHOWN = [['restaurants', 0.09], ['fitness', 0.06], ['personal-care', 0.05], ['services', 0.04]] as const;
const SMALL = [['pets', 0.07], ['entertainment', 0.08]] as const;
const OFFERS = [['free_item', 0.03], ['bogo', 0.025], ['percent_off', 0.015], ['none', 0]] as const;
const CHANNELS = [['machine', 0], ['delivery', 0.01]] as const;

/** The latest month whose ads have settled (first 30 days, then 14 more, as snapshotDue counts it). */
export function settledDemoMonth(now: Date): { period: string; start: Date } {
  const settled = new Date(now.getTime() - (30 + 14 + 1) * 86_400_000);
  const start = new Date(Date.UTC(settled.getUTCFullYear(), settled.getUTCMonth() - 1, 1));
  return { period: start.toISOString().slice(0, 7), start };
}

export async function seedDemoBenchmarks(db: SqlClient, now: Date, companies: string[]) {
  const { period, start } = settledDemoMonth(now);
  // A fixed sequence, so every demo shows the same figures.
  let seed = 20260701;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const asOf = now.toISOString();
  let n = 0;
  for (const company of companies) {
    for (const [category, base, advertisers, adsEach] of [...SHOWN.map(([c, b]) => [c, b, 6, 4] as const), ...SMALL.map(([c, b]) => [c, b, 2, 2] as const)]) {
      for (let a = 1; a <= advertisers; a++) {
        const advertiser = `${DEMO_BENCHMARK_PREFIX}adv-${company}-${category}-${a}`;
        for (let k = 0; k < adsEach; k++) {
          const i = n++;
          const id = `${DEMO_BENCHMARK_PREFIX}v-${i}`;
          const [offerType, offerLift] = OFFERS[(a + k) % OFFERS.length]!;
          const [channel, channelLift] = CHANNELS[i % CHANNELS.length]!;
          const printed = new Date(start.getTime() + Math.floor(rand() * 27) * 86_400_000 + 12 * 3_600_000);
          await db.query(`insert into ad_versions (id, company_id, campaign_id, advertiser_id, content_hash, seen_at, first_printed_at, rated_before_print, category, category_by, features) values ($1,$2,$3,$4,$5,$6,$7,true,$8,'demo',$9) on conflict do nothing`,
            [id, company, `${DEMO_BENCHMARK_PREFIX}${i}`, advertiser, createHash('sha256').update(id).digest('hex'), new Date(printed.getTime() - 86_400_000).toISOString(), printed.toISOString(), category,
              JSON.stringify({ offerType, offerPercent: offerType === 'percent_off' ? 20 : null, offerCents: null, hasAr: k === 0, hasVideo: false, hasLink: true, sizes: [4], distribution: [channel], experienceId: 'offer' })]);
          const scan = Math.max(0.005, base + offerLift + channelLift + (rand() - 0.5) * 0.03);
          for (const [horizon, scale] of [['d7', 0.3], ['d30', 1], ['d90', 2], ['latest', 2]] as const) {
            const bottles = Math.round((120 + Math.floor(rand() * 280)) * scale);
            const scanned = Math.min(bottles, Math.round(bottles * scan));
            const conversions = Math.round(scanned * (0.1 + rand() * 0.1));
            await db.query(`insert into ad_version_outcomes (company_id, version_id, channel, horizon, bottles, scanned_bottles, scans, ar_launches, clicks, conversions, sales_cents, as_of) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing`,
              [company, id, channel, horizon, bottles, scanned, Math.round(scanned * 1.2), k === 0 ? Math.round(scanned * 0.3) : 0, Math.round(scanned * (0.3 + rand() * 0.2)), conversions, conversions * (800 + Math.floor(rand() * 1200)), asOf]);
          }
        }
      }
    }
  }
  return { period, versions: n };
}
