/**
 * The feature registry: every switch a company (FreeWater or a white-label licensee) has, in one place, in plain words.
 * The console's Features page, the per-company checks on routes, jobs, screens and the engine, and the tests all read
 * this list. Nothing else decides what a switch is.
 *
 * HOW TO ADD A FEATURE (docs/SWITCHES.md, "Features page", has the long version):
 *   1. Add one entry to SWITCHES below with `sw({...})`: an id, its category (and group), plain-words label and
 *      description, FreeWater's choice as `default`, what it depends on, and `risk` if it moves money, touches the
 *      blockchain or can't be undone (then it starts off for every new company). Bump `since` to CATALOGUE + 1 and raise
 *      CATALOGUE, so existing companies see it as "new" and decide for themselves (FreeWater gets its default).
 *   2. List what it owns: `routes` ("METHOD /url" exactly as registered), `jobs` (names in src/server/main.ts),
 *      `pages` (console pages), `plugins` (experience plug-ins), or check it in the engine with
 *      `app.companyFeatures.on(companyId, '<id>')`.
 *   3. Run test/features-registry.test.ts: a route, job or console page that belongs to no switch fails it.
 * Locked switches (the safety governor, legal minimums, the books' audit trail, people's rights, the pause switch)
 * are listed so everyone can see them, and can never be turned off.
 */

import type { Feature } from './features';
import { defaultWallet } from '../modules/wallet/assets';
import { adBilling } from '../modules/ads/billing';
import { TEMPLATES, templateShares } from '../modules/ads/layouts';
import { unsoldSettings } from '../modules/fillers/unsold';

/** Ad sizes (shares of the label) and their switches. */
export const SIZE_SWITCHES: Record<number, string> = { 1: 'size_whole', 2: 'size_half', 3: 'size_third', 4: 'size_quarter', 6: 'size_sixth', 8: 'size_eighth', 10: 'size_tenth' };

/** Raise this when adding switches (and give them `since: CATALOGUE`). */
export const CATALOGUE = 5;

export const categoryIds = ['printing', 'ads', 'ar_video', 'studio', 'delivery', 'machines', 'rewards', 'games', 'news', 'data', 'ai', 'money', 'transparency', 'giving', 'partners', 'blockchain', 'safety', 'core'] as const;
export type CategoryId = (typeof categoryIds)[number];

export interface Category { id: CategoryId; label: string; description: string; /** The main switch's id (null: everything in it is locked). */ main: string | null }

export const CATEGORIES: Category[] = [
  { id: 'printing', label: 'Printing', main: 'printing', description: 'Printing each bottle with its own label, codes and receipt, and the pages its codes open.' },
  { id: 'ads', label: 'Ads', main: 'ads', description: 'Selling the label to advertisers: making ads, the auction, sizes and what each code opens.' },
  { id: 'ar_video', label: 'AR & video', main: 'ar_video', description: '3D and AR on scan pages, and the videos behind “Show me more”.' },
  { id: 'studio', label: 'Design studio', main: 'studio', description: 'Designing by chatting: ads in the studio and people’s own bottles, exported as print-ready files.' },
  { id: 'delivery', label: 'Delivery', main: 'delivery', description: 'Home delivery of packs: night planning, packing checks, the driver app, ads on boxes.' },
  { id: 'machines', label: 'Machines', main: 'machines', description: 'Vending machines: their screens, the free bottle in the app, offline labels, the fleet.' },
  { id: 'rewards', label: 'Points & rewards', main: 'rewards', description: 'Points, dollar credit and brand offers.' },
  { id: 'games', label: 'Games', main: 'games', description: 'The games for points, picks that come true, and the prize game.' },
  { id: 'news', label: 'News', main: 'news', description: 'FreeWater News on spots nobody bought: a topic on the bottle, the newest story behind its code. Built, and off until you turn it on.' },
  { id: 'data', label: 'Data & targeting', main: 'data', description: 'What is collected beyond the minimum, how much each person shares, and targeting people.' },
  { id: 'ai', label: 'AI', main: 'ai', description: 'Every use of AI. Each falls back to built-in rules when it’s off; nothing breaks.' },
  { id: 'money', label: 'Money & payments', main: 'money', description: 'Billing advertisers, taking payments, and every way money or credit leaves the platform.' },
  { id: 'transparency', label: 'Transparency', main: 'transparency', description: 'What the world can see: open books, the live feed, seals and receipts.' },
  { id: 'giving', label: 'Charity & giving', main: 'giving', description: 'Giving part of every bottle to charity, and sending it.' },
  { id: 'partners', label: 'Partners & developers', main: 'partners', description: 'Webhooks, partner plug-ins, sales tracking, coupons, the developer pages and the operator network.' },
  { id: 'blockchain', label: 'Blockchain', main: 'token', description: 'The token on Solana, the chain switch and turning points into tokens.' },
  { id: 'safety', label: 'Safety, law and people’s rights', main: null, description: 'Always on, for every company. Listed so everyone can see them.' },
  { id: 'core', label: 'The platform’s core', main: null, description: 'Signing in, the team, keys, settings and their history. Without them nothing else works.' },
];

/** 'autonomy': an AI deciding something on its own, without a person (docs/AI.md, the autonomy ladder). */
export type Risk = 'money' | 'chain' | 'one_way' | 'autonomy';
/**
 * Who may turn it on (turning off is always quick: any owner signed in, never a key).
 *  owner           any owner signed in
 *  owner_approved  an owner signed in who passed the second sign-in step (money, prizes, the token)
 *  approved_step   proposed under Launch or Blockchain, approved by 2 other owners or finance people, then a wait
 */
export type Who = 'owner' | 'owner_approved' | 'approved_step';

/** A switch whose state already lives in the company's settings (one source of truth): how to read it and change it. */
export interface Link {
  /** Read: on or off, from the settings. */
  get: (c: any) => boolean;
  /** The settings change that turns it on or off, or null when that direction is done elsewhere (`via`). */
  set: (c: any, on: boolean) => Record<string, unknown> | null;
  /** Where the other direction is done, in plain words, with the console page. */
  via?: { on?: string; off?: string; page: string };
}

export interface Switch {
  id: string;
  category: CategoryId;
  /** A heading within the category ('' for the main switch). */
  group: string;
  label: string;
  description: string;
  /** FreeWater's own choice; what a new company copies (except risky ones, which start off). */
  default: boolean;
  /** Its parent (by default its category's main switch; null for none). Off when the parent is off. */
  parent: string | null;
  /** Other switches it needs. Off when any of them is off. */
  dependsOn: string[];
  /** 'feature': kept on the Features page. 'linked': kept in the company's settings. 'setting': a number or choice on its own page. */
  kind: 'feature' | 'linked' | 'setting';
  risk?: Risk;
  /** Always on, with the reason. */
  locked?: string;
  /** Starts off for a new company even though FreeWater has it on (and why). Risky switches always do. */
  startsOff?: string;
  /** The host's area (FW_FEATURES) that is its outer limit. */
  host?: Feature;
  /** Turned on only by an approved step (a chain action of this kind, under Launch or Blockchain), never from a page. */
  step?: string;
  /**
   * Turned on only on its own page, with that page's own checks (an AI's track record, say), never from the Features
   * page or a starting point. Turning it off works from both.
   */
  ownPage?: { on: string; page: string };
  link?: Link;
  /** For kind 'setting': the console page. */
  page?: string;
  routes: string[];
  jobs: string[];
  /** Console pages (the last part of /console/<page>). */
  pages: string[];
  /** Experience plug-ins (what a code opens). */
  plugins: string[];
  /** The catalogue it first appeared in. */
  since: number;
}

type Def = Partial<Switch> & Pick<Switch, 'id' | 'category' | 'label' | 'description'>;
const sw = (d: Def): Switch => ({
  group: '', default: true, parent: undefined as unknown as null, dependsOn: [], kind: 'feature', routes: [], jobs: [], pages: [], plugins: [], since: 1, ...d,
});

// ---------- links to settings that already exist ----------
const at = (c: any, path: string) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), c);
/** A boolean inside a settings section; `base` fills the section when it isn't there yet (null: turn it on on its page). */
const flag = (path: string, opts: { missing?: boolean; base?: (c: any) => Record<string, unknown> | null; via?: Link['via'] } = {}): Link => {
  const [top, ...rest] = path.split('.');
  return {
    get: (c) => { const v = at(c, path); return v === undefined ? !!opts.missing : !!v; },
    set: (c, on) => {
      if (!rest.length) return { [top!]: on };
      const cur = c[top!] ?? opts.base?.(c);
      if (!cur) return null;
      const next = structuredClone(cur);
      let t = next; for (const k of rest.slice(0, -1)) t = t[k] ??= {};
      t[rest.at(-1)!] = on;
      return { [top!]: next };
    },
    via: opts.via,
  };
};
const stepOn = (what: string, page: string): Link['via'] => ({ on: what, page });

const quietTransparency = { liveFeed: false, counters: false, publishFingerprints: false, advertiserStatements: false, feedDetail: 'none', showAmounts: false };

export const SWITCHES: Switch[] = [
  // ======================= Printing =======================
  sw({ id: 'printing', category: 'printing', parent: null, label: 'Printing bottles', description: 'Every bottle printed on the spot with its own label, ads and codes. Off: nothing prints for this company (the design studio can still export print-ready files).',
    routes: ['POST /v1/orders', 'GET /v1/units/:id', 'GET /v1/units/:id/label.svg', 'GET /v1/console/products', 'POST /v1/qr/preview'], pages: ['codes', 'products'] }),
  sw({ id: 'scan_pages', category: 'printing', group: 'What codes open', label: 'Scan pages', description: 'Each code on a bottle opens a page on the phone, nothing to install. Scans are counted (and billed to advertisers).',
    routes: ['GET /v1/public/scan/:unitId/:slot', 'POST /v1/public/scans', 'GET /v1/public/experience/:unitId/:slot', 'POST /v1/public/engagements', 'GET /v1/me/saved', 'POST /v1/me/saved', 'DELETE /v1/me/saved/:id', 'GET /v1/me/bottles', 'GET /v1/me/bottles/:id', 'GET /v1/me/bottles/:id/label.svg'] }),
  sw({ id: 'own_products', category: 'printing', group: 'Products', label: 'Your own products', description: 'Add cans, cups and bottles of any size, each checked before it can print. Off: only the shared products.',
    routes: ['POST /v1/console/products/check', 'POST /v1/console/products'] }),
  sw({ id: 'static_codes', category: 'printing', group: 'Codes on the label', kind: 'linked', label: 'Static codes', description: 'Advertisers may choose a code that goes straight to their website (it still carries the bottle’s signed reference).',
    link: flag('qr.allowStatic', { base: () => ({ logo: 'none', advertiserLogos: false, allowStatic: false }) }) }),
  sw({ id: 'advertiser_code_logos', category: 'printing', group: 'Codes on the label', kind: 'linked', label: 'Advertisers’ logos in their codes', description: 'Advertisers may put their own logo inside their QR codes (the code is made bigger until it always scans).',
    link: flag('qr.advertiserLogos', { base: () => ({ logo: 'none', advertiserLogos: false, allowStatic: false }) }) }),

  // ======================= Ads =======================
  sw({ id: 'ads', category: 'ads', parent: null, dependsOn: ['printing'], label: 'Ads on bottles', description: 'Advertisers buy space on the label. Off: nothing is sold; the label is filled from your unsold-space list (or plain, or your own ad if you allow it), and the advertiser portal’s ad pages are closed.',
    routes: ['GET /v1/campaigns', 'POST /v1/campaigns', 'PATCH /v1/campaigns/:id', 'GET /v1/experiences', 'POST /v1/experiences/preview', 'GET /v1/assets', 'POST /v1/assets', 'GET /v1/ads/overview'], pages: ['ads'], plugins: ['offer'] }),
  sw({ id: 'ad_chat', category: 'ads', group: 'Making ads', label: 'Make an ad by chatting', description: 'Advertisers describe the ad and attach pictures; the assistant fills in the draft, they preview it at every size, then submit.',
    routes: ['POST /v1/ads/drafts', 'GET /v1/ads/drafts/:id', 'POST /v1/ads/drafts/:id/messages', 'GET /v1/ads/drafts/:id/preview', 'POST /v1/ads/drafts/:id/submit'] }),
  sw({ id: 'bidding', category: 'ads', group: 'Selling space', kind: 'linked', default: false, dependsOn: ['billed_after'], label: 'Bidding (the auction)', description: 'Advertisers bid for their place, second price, with daily budgets (pricing: auction). Only where advertisers are billed afterwards: a bid’s price isn’t known until the bottle prints. Off: flat prices, one per size.',
    link: { get: (c) => adBilling(c).pricingMode === 'auction', set: (c, on) => ({ adBilling: { ...adBilling(c), pricingMode: on ? 'auction' : 'flat' } }) } }),
  sw({ id: 'ad_versions', category: 'ads', group: 'What the code shows', label: 'Versions of the call to action', description: 'An ad can show different versions to the first scanner, someone it was passed to, mornings, regulars… decided at each scan.',
    routes: ['GET /v1/campaigns/:id/codes', 'PATCH /v1/campaigns/:id/codes', 'POST /v1/campaigns/:id/preview-moment'] }),
  sw({ id: 'booking', category: 'ads', group: 'What the code shows', label: 'Book a time', description: 'A code can open a booking page.', plugins: ['booking'] }),
  sw({ id: 'ad_videos', category: 'ads', group: 'What the code shows', label: 'The advertiser’s own video', description: 'A code can open the advertiser’s uploaded video first.', plugins: ['video'] }),
  sw({ id: 'ad_stories', category: 'ads', group: 'What the code shows', label: 'An advertiser’s story', description: 'A code can open an advertiser’s own short story with a link to the rest (a paper’s or a blog’s). Not FreeWater News.', plugins: ['news-card'] }),
  // Space nobody bought (src/modules/fillers/unsold.ts; docs/SWITCHES.md, "Unsold space"): third-party ads only, in the
  // company's order. They replace the house ad that used to fill it, so they count as part of the first catalogue
  // (`since: 1`): every company, white-label too, starts with FreeWater's choices rather than an empty list.
  sw({ id: 'unsold_order', category: 'ads', group: 'Unsold space', kind: 'setting', page: 'ads', label: 'What fills unsold space, in order',
    description: 'A list you add to, take from and reorder (Ads and prices → Unsold space). FreeWater: 1. former advertisers: one of their past approved ads, still current, printed free as a bonus (never billed, never counted against a paid ad, shown to them as bonus bottles, taking turns fairly; they can say no in their portal); 2. approved filler ads; 3. charity partners; 4. ads you picked. Never your own ads, “your ad here” or your news. If nothing fits a piece, a tidier layout with fewer pieces is used (paid ones first); a plain blank piece only as a last resort, and your team is told.',
    routes: ['GET /v1/console/unsold', 'POST /v1/console/advertisers/:id/bonus', 'GET /v1/ads/bonus', 'POST /v1/ads/bonus'] }),
  sw({ id: 'fillers', category: 'ads', group: 'Unsold space', label: 'Approved filler ads', description: 'Third-party pieces your team approved for space nobody bought: an advertiser’s ad it offered free, a charity partner’s. Each prints only once a person approves it, and only where the list says. Never billed. Off: the rest of the list fills it.',
    routes: ['GET /v1/fillers', 'POST /v1/fillers', 'POST /v1/fillers/:id/approve', 'POST /v1/fillers/:id/retire'], since: 2 }),
  sw({ id: 'filler_offers', category: 'ads', group: 'Unsold space', parent: 'fillers', label: 'Advertisers offer ads for unsold spots', description: 'An advertiser may offer one of its approved ads, free, for spots nobody bought; your team approves each one first.',
    routes: ['POST /v1/campaigns/:id/filler-offer'], since: 2 }),
  sw({ id: 'unsold_charity', category: 'ads', group: 'Unsold space', parent: 'fillers', label: 'Charity partners’ pieces', description: 'A charity partner’s piece (Well Aware), approved by a person on your team, fills space nobody bought where the list puts charity. Off: charity pieces aren’t used.' }),
  sw({ id: 'own_house_ads', category: 'ads', group: 'Unsold space', kind: 'linked', default: false, label: 'Your own ads in unsold space',
    description: 'Off (FreeWater, and every company unless it turns it on): the ad area only ever carries other businesses’ ads; your own ads, “your ad here” and your news stay off the label (your panel on the right is yours). On (a white-label company’s choice; FreeWater can’t): your own pieces fill what the list can’t, before a blank piece.',
    link: { get: (c) => unsoldSettings(c).ownAds, set: (c, on) => ({ unsold: { ...unsoldSettings(c), ownAds: on } }) } }),
  sw({ id: 'unsold_hold', category: 'ads', group: 'Unsold space', kind: 'linked', default: false, dependsOn: ['delivery'], label: 'Hold delivery bottles for paid ads',
    description: 'Off (FreeWater). On: a delivery night more than the days below away isn’t printed yet, so paid route pieces can still be bought on its bottles; once it’s within those days it prints in full and the list fills what’s unsold. The night before delivery is always within, so no house ever misses its pack. Set per delivery area too. Machines print on the spot, so this is for delivery only.',
    link: { get: (c) => unsoldSettings(c).hold.on, set: (c, on) => { const u = unsoldSettings(c); return { unsold: { ...u, hold: { ...u.hold, on } } }; } } }),
  sw({ id: 'unsold_hold_days', category: 'ads', group: 'Unsold space', kind: 'setting', page: 'ads', label: 'Days bottles are held for paid ads',
    description: '1 to 30 (FreeWater: 7), for the company and for each delivery area (Ads and prices → Unsold space).' }),
  // Buying on delivery routes (src/modules/ads/routeBuys.ts; docs/SWITCHES.md, "Buying on delivery routes").
  sw({ id: 'route_buying', category: 'ads', group: 'Buying on delivery routes', dependsOn: ['prepaid_ads', 'delivery_areas'], risk: 'money', since: 3, label: 'Buying on delivery routes',
    description: 'Advertisers buy pieces of the labels on bottles going to houses in your delivery areas, by area, street, a shape on the map or chosen houses, for chosen weeks, paid up front at an exact price. Each piece is reserved on a bottle when paid (first paid wins, never more than exists) and printed on that house’s box that week. Off: nothing new can be bought on routes; pieces already bought still print, and what can’t go out comes back as credit or a refund.',
    routes: ['GET /v1/ads/route-areas', 'GET /v1/ads/routes', 'POST /v1/ads/drafts/:id/route-quote', 'POST /v1/ads/campaigns/:id/route-quote', 'POST /v1/ads/campaigns/:id/route-pay'] }),
  sw({ id: 'route_buy_spread', category: 'ads', group: 'Buying on delivery routes', parent: 'route_buying', since: 3, label: 'Bottles spread over an area', description: 'A number of bottles, at one size, spread evenly over the houses of an area (or streets, or a shape on the map) and the weeks chosen.' }),
  sw({ id: 'route_buy_blanket', category: 'ads', group: 'Buying on delivery routes', parent: 'route_buying', since: 3, label: 'Every house on the route', description: 'One piece on one bottle in every box at every house there, each week chosen.' }),
  sw({ id: 'route_buy_box', category: 'ads', group: 'Buying on delivery routes', parent: 'route_buying', since: 3, label: 'A whole box', description: 'Every bottle in a house’s box carries the same ad, at the chosen houses, each week chosen (and, if chosen, the box’s sides: only where ads on boxes are on; otherwise the box is plain and the buy covers its bottles only).' }),
  sw({ id: 'route_buy_houses', category: 'ads', group: 'Buying on delivery routes', parent: 'route_buying', since: 3, label: 'Chosen houses', description: 'An advertiser names the houses (by address): as little as a tenth of the label on one bottle at one house. Under 50 houses it’s a small-audience buy (below).' }),
  sw({ id: 'route_small_audience', category: 'ads', group: 'Buying on delivery routes', parent: 'route_buying', dependsOn: ['house_ad_blocks'], since: 3, startsOff: 'Ads aimed at a few houses are your own decision.', label: 'Buys aimed at fewer than 50 houses',
    description: 'Allowed only with the guardrails: a business you verified, a person approves it (never a key), no names, addresses, phone numbers, emails or personal messages in the ad, never a house that blocked it or said no to targeted ads. Off: every route buy must reach at least 50 houses.',
    routes: ['POST /v1/advertisers/:id/verify'] }),
  sw({ id: 'route_attribute_targeting', category: 'ads', group: 'Buying on delivery routes', parent: 'route_buying', dependsOn: ['house_targeting'], default: false, startsOff: 'Aiming at houses by their data is your own decision.', since: 3, label: 'Aim route buys by household data', description: 'Only houses whose household size, income band, owning or renting, or interests fit (first-party first, then bought data, then the area’s). Only across whole delivery areas and at 50 houses or more, so a quote can’t test one house. Never anything sensitive; a house that said no is never aimed at. Advertisers see counts, never which houses (no drop list for these buys).' }),
  sw({ id: 'route_proof', category: 'ads', group: 'Buying on delivery routes', since: 3, dependsOn: ['delivery_areas'], label: 'Delivery report for route buys', description: 'Advertisers see the streets their ad reached and how many houses (never which house or who), each drop’s time and rough place from the driver’s scan, and scans by area (for a buy aimed at fewer than 50 houses: the day only, and no scans).',
    routes: ['GET /v1/ads/campaigns/:id/route-report'] }),
  // The AI reviewer making the final call on paid ads (src/modules/ads/aiReview.ts; docs/SWITCHES.md, "Review of a paid
  // ad"; docs/AI.md). Off for every company until a person turns it on, and only once the AI's record earns it.
  sw({ id: 'ai_ad_final_call', category: 'ads', group: 'Review', default: false, risk: 'autonomy', dependsOn: ['prepaid_ads', 'ai_ad_reviewer'], since: 5,
    startsOff: 'The AI deciding on its own is each company’s own step, once its record earns it.',
    ownPage: { on: 'On the AI agents page (AI reviewer of paid ads): an owner signed in with the second step, only once the AI’s record meets your bar.', page: 'agents' },
    label: 'AI makes the final call on paid ads',
    description: 'The AI reviewer’s rejection of a paid ad is final without a person, with its written reason kept. The advertiser can always appeal to a person; a random sample of its rejections (10% unless set, never under 5%) still goes to your team to audit; an AI pass still waits for a person before it prints; the refund after any rejection is still approved by a person. Turned on only when its record meets your bar (100 decisions and 95% agreeing with your team unless set); anyone on your team turns it off at once, and the governor turns it off by itself if its agreement drops below the bar.' }),
  ...([[1, 'whole', 'The whole label'], [2, 'half', 'Half'], [3, 'third', 'A third'], [4, 'quarter', 'A quarter'], [6, 'sixth', 'A sixth'], [8, 'eighth', 'An eighth'], [10, 'tenth', 'A tenth']] as const).map(([n, name, label]) =>
    sw({ id: `size_${name}`, category: 'ads', group: 'Ad sizes', label: `${label} of the label`, description: n === 1 ? 'One ad across the whole label.' : `Ads that take ${label.toLowerCase()} of the label (cut as square as the bottle allows).` })),
  // Label layouts (src/modules/ads/layoutChoice.ts; docs/SWITCHES.md, "Label layouts"): one switch per tidy template,
  // each needing every size it uses. They narrow what every company already printed, so they count as part of the first
  // catalogue (`since: 1`): an existing company keeps every template, as before, until it turns some off. At least one
  // stays usable on the standard product while ads are on (the Features page refuses turning off the last one).
  ...TEMPLATES.map((t) => {
    const shares = templateShares(t);
    const sizes = [...new Set(shares)];
    return sw({ id: `layout_${t.id}`, category: 'ads', group: 'Label layouts', dependsOn: sizes.map((s) => SIZE_SWITCHES[s]!),
      label: t.name[0]!.toUpperCase() + t.name.slice(1),
      description: shares.length === 1 ? 'One ad across the whole label.' : `The label cut into ${t.name}: ${shares.length} pieces${sizes.length > 1 ? ', the bigger ones first' : ', all the same size'}. Each piece is turned the squarest way the product allows.` });
  }),
  sw({ id: 'max_ads_per_bottle', category: 'ads', group: 'Label layouts', kind: 'setting', page: 'features', label: 'Most ads on one bottle',
    description: '1 to 10 (FreeWater: 10). Layouts with more pieces than this aren’t used. Set it in the Label layouts section of this page.' }),
  sw({ id: 'placement_revenue', category: 'ads', group: 'Selling space', kind: 'linked', default: false, label: 'Most revenue per bottle',
    description: 'Off (FreeWater): every paid ad gets its turn, and the label is cut the best-earning way that carries the ad whose turn it is. On: each label is cut the way that earns the most among the paid ads that fit, and an ad left off the bottles it fits for a number of bottles in a row (20 unless set) gets its turn on the next one, so no paid ad waits forever.',
    link: { get: (c) => c.adRules?.placement === 'revenue', set: (c, on) => ({ adRules: { ...c.adRules, placement: on ? 'revenue' : 'turns' } }) } }),

  // ======================= AR & video =======================
  sw({ id: 'ar_video', category: 'ar_video', parent: null, label: 'AR and video', description: 'AR on scan pages and videos behind “Show me more”. AR launches that load are billed to the advertiser.',
    routes: ['POST /v1/public/ar-launches'] }),
  sw({ id: 'ar_place', category: 'ar_video', group: 'AR', label: 'AR in your space', description: 'The phone’s own AR on a table or the floor: products, a 3D menu, a home tour, with a buy button.', plugins: ['ar-place', 'ar-3d-menu', 'ar-home-tour'] }),
  sw({ id: 'ar_tracking', category: 'ar_video', group: 'AR', kind: 'linked', label: 'AR tracking strip', description: 'A thin strip of small numbered squares along the label, so AR can follow the bottle all the way round.',
    routes: ['GET /v1/public/ar/:unitId'], link: flag('ar.trackingCodes', { base: () => ({ trackingCodes: false }) }) }),
  sw({ id: 'strip_everywhere', category: 'ar_video', group: 'AR', kind: 'linked', dependsOn: ['ar_tracking'], label: 'Tracking strip along every ad', description: 'Kept for older settings; it changes nothing now. The strip prints only on the AR advertiser’s own piece: on other advertisers’ pieces it covered words they paid to print.', link: flag('ar.stripEverywhere', { base: () => ({ trackingCodes: true }) }) }),
  sw({ id: 'ar_on_bottle', category: 'ar_video', group: 'AR', dependsOn: ['ar_tracking'], label: 'AR on the bottle', description: 'A 3D model attached to the bottle in the camera, moving and turning with it.', plugins: ['ar-on-bottle'] }),
  sw({ id: 'ar_living_label', category: 'ar_video', group: 'AR', dependsOn: ['ar_tracking'], label: 'Living label', description: 'A new label laid over the real one: moving artwork, video or effects that turn with the bottle.', plugins: ['ar-living-label'] }),
  sw({ id: 'show_me_more', category: 'ar_video', group: 'Video', label: '“Show me more”', description: 'At the end of a scan page, a personalized video for people who ask for it.',
    routes: ['GET /v1/public/experience/:unitId/:slot/more', 'GET /v1/public/experience/box/:packId/:face/more'] }),
  sw({ id: 'motion_videos', category: 'ar_video', group: 'Video', parent: 'show_me_more', label: 'Motion videos', description: 'Videos made on the spot from the advertiser’s own words, colors and pictures; each view teaches which cut works.',
    routes: ['GET /v1/campaigns/:id/videos', 'POST /v1/campaigns/:id/videos/:videoId/review', 'GET /v1/campaigns/:id/learning'] }),
  sw({ id: 'video_generation', category: 'ar_video', group: 'Video', parent: 'show_me_more', host: 'video_generation', risk: 'money', label: 'AI video maker (footage)', description: 'Live-action and animated clips made by Google’s Veo for each kind of moment, shown only after the advertiser approves. The company pays per second.',
    jobs: ['videos'] }),

  // ======================= Design studio =======================
  sw({ id: 'studio', category: 'studio', parent: null, label: 'The design studio', description: 'Businesses design ads from a brand kit and a short brief, see them at every size, and download print-ready files.',
    routes: ['GET /v1/studio', 'PATCH /v1/studio/kit', 'POST /v1/studio/designs', 'POST /v1/studio/preview', 'POST /v1/studio/export'] }),
  sw({ id: 'studio_photos', category: 'studio', group: 'Pictures', label: 'Photos and logo uploads', description: 'Upload photos and a logo; each is turned upright, sized for print, cleared of hidden data and studied for its colors.',
    routes: ['POST /v1/studio/photos', 'DELETE /v1/studio/photos/:asset', 'GET /v1/studio/photos/:asset/colors', 'POST /v1/studio/logo'] }),
  sw({ id: 'studio_library', category: 'studio', group: 'Pictures', label: 'Photo library', description: 'Free photos from a library, credited to their photographers.', routes: ['GET /v1/studio/library', 'POST /v1/studio/library'] }),
  sw({ id: 'studio_image_ai', category: 'studio', group: 'Pictures', dependsOn: ['ai'], label: 'Pictures made by AI', description: 'Google’s image AI makes a photo from a description, for brands without their own.', routes: ['POST /v1/studio/generate'] }),
  sw({ id: 'studio_3d', category: 'studio', group: 'Pictures', dependsOn: ['ar_place'], label: 'Photo to 3D', description: 'Turn a product photo into a 3D model for AR, at real size.', routes: ['POST /v1/studio/ar', 'POST /v1/studio/ar/use'] }),
  sw({ id: 'studio_to_ads', category: 'studio', group: 'Using designs', dependsOn: ['ads', 'ad_chat'], label: 'Use a design in an ad', description: 'Send a studio design straight into an ad being made.', routes: ['POST /v1/studio/use'] }),
  sw({ id: 'bottle_designer', category: 'studio', group: 'People’s own bottles', label: 'Design your own bottle', description: 'People describe their bottle (“Maya’s 30th, pink and gold”) and add photos; the chat makes the design and a proof of exactly what will print.',
    routes: ['POST /v1/me/designs', 'GET /v1/me/designs', 'GET /v1/me/designs/:id', 'POST /v1/me/designs/:id/messages', 'GET /v1/me/designs/:id/scan-preview', 'POST /v1/me/designs/:id/proof', 'POST /v1/me/proofs', 'POST /v1/me/assets', 'GET /v1/public/products/:productId'], plugins: ['custom-experience'] }),

  // ======================= Delivery =======================
  sw({ id: 'delivery', category: 'delivery', parent: null, dependsOn: ['printing'], label: 'Home delivery', description: 'Free 6, 12 and 24 packs on a schedule: night planning, the packing check, loading in reverse and the right box at the right door.',
    routes: ['POST /v1/public/delivery/check', 'GET /v1/me/delivery', 'POST /v1/me/delivery', 'PATCH /v1/me/delivery', 'GET /v1/ops/subscriptions', 'GET /v1/ops/runs', 'POST /v1/ops/runs/plan', 'POST /v1/ops/runs/:id/pack-check', 'POST /v1/ops/runs/:id/close',
      'POST /v1/packs', 'GET /v1/packs/:id', 'GET /v1/packs/:id/box.svg', 'POST /v1/packs/:id/verify', 'POST /v1/packs/:id/replace', 'POST /v1/packs/:id/seal', 'POST /v1/routes/:routeId/load', 'POST /v1/deliveries', 'GET /v1/public/packs/:packId'],
    jobs: ['deliveries-overdue'] }),
  // Delivery areas (the Austin pilot): FreeWater chooses the streets and every house on them gets packs, in street order.
  sw({ id: 'delivery_areas', category: 'delivery', group: 'Delivery areas', since: 2, label: 'Delivery areas (house after house)', description: 'Choose streets on a map or from a list of addresses, and every house on them gets free packs in street order, with no sign-up. Each area has its own frequency, pack size and packs per house, and starts off until a person turns it on. Someone living there can stop it in the app.',
    routes: ['GET /v1/ops/areas', 'POST /v1/ops/areas', 'PATCH /v1/ops/areas/:id', 'GET /v1/ops/areas/:id/houses', 'POST /v1/ops/areas/:id/houses/import', 'GET /v1/ops/house-reviews', 'POST /v1/ops/houses/:id/review',
      'GET /v1/me/house', 'POST /v1/me/house/claim', 'PATCH /v1/me/house', 'DELETE /v1/me/house'] }),
  sw({ id: 'household_packs', category: 'delivery', group: 'Delivery areas', parent: 'delivery_areas', since: 2, label: 'More packs for bigger households', description: 'Once someone in the app tells us how many people live in their house, it gets enough packs for them (the area’s “bottles a person a week”, up to its “most packs per house”). Off: every house gets the area’s packs per house, and the app doesn’t ask.' }),
  sw({ id: 'house_ad_context', category: 'delivery', group: 'Delivery areas', parent: 'delivery_areas', dependsOn: ['ads'], since: 2, label: 'Ads know the house’s street and area', description: 'When a house’s pack is printed, the ad engine is told which area and street it’s going to (and the household size, if the house told us and targeting people is on). Never a name: houses aren’t people. Off: the ads are chosen as for any pack on that route.' }),
  sw({ id: 'house_ad_blocks', category: 'delivery', group: 'Delivery areas', parent: 'delivery_areas', since: 3, label: 'Houses block ads', description: 'Someone who proved a house is theirs can block a business’s ads there, or every ad aimed at their house alone; what was bought for it comes back to the advertiser. Off: no blocking, and no route buys aimed at fewer than 50 houses.',
    routes: ['GET /v1/me/house/ads', 'POST /v1/me/house/ad-blocks', 'DELETE /v1/me/house/ad-blocks/:id'] }),
  sw({ id: 'driver_app', category: 'delivery', group: 'At the door', label: 'The driver app', description: 'Drivers load the van in order and scan each box at the door; a wrong box is stopped.',
    routes: ['GET /v1/driver/runs', 'GET /v1/driver/runs/:id', 'POST /v1/driver/runs/:id/start', 'POST /v1/driver/runs/:id/load', 'POST /v1/driver/runs/:id/stops/:stop/deliver', 'POST /v1/driver/runs/:id/stops/:stop/fail'] }),
  sw({ id: 'driver_house_skip', category: 'delivery', group: 'At the door', parent: 'driver_app', dependsOn: ['delivery_areas'], since: 2, label: 'Drivers skip a house, with a reason', description: 'A driver can pass a house in a delivery area by only for a real access or safety problem (a locked gate, a dangerous animal, not safe, no safe place to leave it) or because it isn’t a home. Signs on the door and what someone says there are never reasons: people stop deliveries in the app. Its boxes come back and it isn’t planned again until a person reviews it. Off: the driver uses “Problem at this stop”, and the house stays on the next plan.', routes: ['POST /v1/driver/runs/:id/stops/:stop/skip-house'] }),
  sw({ id: 'door_photos', category: 'delivery', group: 'At the door', parent: 'driver_app', label: 'Photo at the door', description: 'A photo of each box where it was left, kept without the phone’s hidden data and only for the company’s keep (90 days unless set). Only your team and someone who proved in the app the house is theirs see it; never advertisers.',
    routes: ['POST /v1/driver/photos', 'GET /v1/ops/drop-photos/:id', 'GET /v1/me/drop-photos', 'GET /v1/me/drop-photos/:id'] }),
  sw({ id: 'drop_photo_proof', category: 'delivery', group: 'At the door', parent: 'door_photos', since: 4, label: 'Photo proof of each drop',
    description: 'A box is delivered only once the driver has a photo of it where it was left, as well as the scan at the door; the scan alone isn’t enough, unless a person on your team (ops or an owner, signed in, not the driver) vouches for it with a reason. Delivered with its photo means delivered: what happens on the porch afterwards isn’t a failed delivery. Off: the scan at the right door is enough.',
    routes: ['POST /v1/ops/runs/:id/stops/:stop/deliver-without-photo'] }),
  sw({ id: 'check_by_hand', category: 'delivery', group: 'Packing', label: 'Count a box by hand', description: 'Where there’s no packing line, a person counts a box and the check is recorded with who and when.', routes: ['POST /v1/ops/runs/:id/stops/:stop/check-by-hand'] }),
  // Off (the founder: "The boxes have not been printed on to date. They are black at this time. But we will ultimately
  // want to have ads on those"): FreeWater's choice, so every new company copies it, and the delivery starting point and
  // the pilot leave it off. A pack still gets its box code (the driver's scan and a house's claim use it).
  sw({ id: 'box_ads', category: 'delivery', group: 'Boxes', dependsOn: ['ads'], default: false, label: 'Ads on boxes', description: 'Off (FreeWater): boxes are plain. Nothing is printed on them, advertisers can’t buy a box’s sides (a whole-box route buy covers its bottles only), and the ad assistant and portal never offer boxes; each pack still gets its box code. On: the top, front, back and right of each box (less the side with your info strip) are sold to advertisers, each with its own code, printed at the box sizes and colours you set (Company → Delivery boxes). A side nobody bought is filled from your unsold-space list (box artwork only), else left plain (your own ad only if you allow your own ads).',
    routes: ['GET /v1/public/experience/box/:packId/:face', 'POST /v1/public/box-scans', 'POST /v1/public/box-ar-launches'] }),
  ...(['top', 'front', 'back', 'right'] as const).map((face) => sw({ id: `box_${face}`, category: 'delivery', group: 'Boxes', parent: 'box_ads', label: `Box ${face}`, description: `Sell the ${face} of each box to an advertiser.` })),
  sw({ id: 'box_settings', category: 'delivery', group: 'Boxes', kind: 'setting', page: 'company', label: 'Box sizes and colours',
    description: 'For each pack size (6, 12, 24): the box’s outside length, width and height in inches (unset: the platform’s standard box), its inside and bottom colours (black unless you choose), and which side carries your info strip and how wide it is. Set under Company → Delivery boxes; used when ads on boxes are on.' }),

  // ======================= Machines =======================
  sw({ id: 'machines', category: 'machines', parent: null, dependsOn: ['printing'], host: 'machines', label: 'Vending machines', description: 'Machines that print and drop a bottle: their screens, faults, the fleet page and machine keys.',
    routes: ['POST /v1/machine/heartbeat', 'GET /v1/machine/jobs/next', 'POST /v1/machine/jobs/:id/result', 'GET /v1/machine/presence', 'POST /v1/machine/buffer', 'POST /v1/machine/offline-report', 'POST /v1/machine/commands/:id/result',
      'GET /v1/ops/fleet', 'GET /v1/ops/fleet/:id', 'POST /v1/ops/fleet/:id/commands', 'GET /v1/ops/machines', 'POST /v1/console/machines', 'PATCH /v1/console/machines/:id', 'GET /v1/machines/:locationId/presence', 'GET /v1/public/machines/:locationId', 'GET /v1/public/machines/:locationId/sample.svg', 'GET /v1/public/companies/:companyId/machines'],
    jobs: ['fleet-sweep'], pages: ['machines'] }),
  sw({ id: 'app_free_bottle', category: 'machines', group: 'At the machine', label: 'Free bottle from the app', description: 'Scan the code on the machine’s screen and tap “Get my free water” (you have to be at the machine).',
    routes: ['POST /v1/me/vends', 'GET /v1/me/vends/:vendId'] }),
  sw({ id: 'machine_choice', category: 'machines', group: 'At the machine', label: 'Choosing what you get', description: 'Where a machine has several products, a fair choice in random order, with no paid places.', routes: ['GET /v1/me/machines/:locationId/choice'] }),
  sw({ id: 'offline_bottles', category: 'machines', group: 'When the internet drops', kind: 'linked', label: 'Free bottles while offline', description: 'The screen offers “Tap for a free bottle” from labels kept ready, within an hourly limit.',
    link: flag('machines.offlineWalkUp', { via: { on: 'Set the hourly limit under Company, then turn it on there.', page: 'company' } }) }),

  // ======================= Points & rewards =======================
  sw({ id: 'rewards', category: 'rewards', parent: null, label: 'Points and rewards', description: 'The wallet: points for scans, games and feedback, dollar credit and brand offers.', routes: ['GET /v1/me/wallet', 'POST /v1/me/wallet/keep', 'GET /v1/public/wallet/:companyId', 'GET /v1/public/wallet/:companyId/supply'], pages: ['wallet'] }),
  sw({ id: 'points', category: 'rewards', group: 'Points', kind: 'linked', label: 'Points', description: 'Points for scans, games and feedback, the same whichever item someone picks. The cap never changes.', link: flag('wallet.points.enabled', { missing: true, base: (c) => defaultWallet(c.name) as any }) }),
  sw({ id: 'credit', category: 'rewards', group: 'Credit', kind: 'linked', risk: 'money', label: 'Dollar credit', description: 'People can be paid dollar credit, only from money a brand has really sent.', link: flag('wallet.credit.enabled', { base: (c) => defaultWallet(c.name) as any }) }),
  sw({ id: 'offers', category: 'rewards', group: 'Brand offers', host: 'offers', risk: 'money', label: 'Brand offers', description: 'Brands fund offers (free, cheaper or negatively priced products) redeemed with a receipt. Each offer needs your approval.',
    routes: ['POST /v1/offers', 'GET /v1/offers', 'POST /v1/offers/:id/submit', 'POST /v1/offers/:id/approve', 'POST /v1/offers/:id/pause', 'GET /v1/offers/receipts', 'GET /v1/offers/receipts/:claimId', 'POST /v1/offers/receipts/:claimId/review', 'GET /v1/products/:barcode',
      'GET /v1/public/offers/:companyId', 'POST /v1/public/offers/:companyId/:offerId/claim', 'POST /v1/public/offers/:companyId/claims/:claimId/receipt'],
    jobs: ['offers'], pages: ['offers'] }),
  sw({ id: 'offer_payouts', category: 'rewards', group: 'Brand offers', parent: 'offers', kind: 'linked', risk: 'money', label: 'Offers pay out', description: 'Approved offers go live and pay out from the brand’s reserve. Off: claims wait, unpaid.',
    link: flag('offers.enabled', { base: () => ({ enabled: false }) }) }),
  sw({ id: 'value_back_tests', category: 'rewards', group: 'Brand offers', parent: 'offers', label: 'Value-back tests', description: 'Test an offer at stepped amounts of value given back, approved by a person.',
    routes: ['GET /v1/environment/experiments', 'POST /v1/environment/experiments', 'POST /v1/environment/experiments/:id/decide'] }),

  // ======================= Games =======================
  sw({ id: 'games', category: 'games', parent: null, kind: 'linked', host: 'games', label: 'The games', description: 'A visual game of real products for points: pick one, ads, quick checks, tap the code, AR. Prices show $0 unless one differs.',
    routes: ['GET /v1/public/games/:companyId/status', 'POST /v1/public/games/:companyId/join', 'POST /v1/public/games/:companyId/leave', 'POST /v1/public/games/:companyId/next', 'POST /v1/public/games/:companyId/answer', 'POST /v1/public/games/:companyId/feedback',
      'GET /v1/games/catalog', 'POST /v1/games/catalog/photos', 'POST /v1/games/catalog/:itemId/photo', 'GET /v1/games/winners', 'GET /v1/games/report'],
    jobs: ['game-photos'], pages: ['games'], link: flag('games.enabled', { missing: true, base: () => ({}) }) }),
  sw({ id: 'game_video_feedback', category: 'games', group: 'Feedback', label: 'Video feedback', description: 'Players can send a short video as well as written feedback.', routes: ['POST /v1/public/games/:companyId/feedback/video'] }),
  sw({ id: 'game_prompt_box', category: 'games', group: 'Feedback', label: 'Ask anything', description: 'A box where players type any question; it’s saved and earns its points.', routes: ['POST /v1/public/games/:companyId/prompt'] }),
  sw({ id: 'come_true', category: 'games', group: 'Picks that come true', label: 'Picks that may come true', description: 'Mark categories “may come true”; a winner with at least 20 views from real people can be launched.', routes: ['GET /v1/games/launches', 'POST /v1/games/come-true'] }),
  sw({ id: 'lottery', category: 'games', group: 'Prize game', parent: null, default: false, kind: 'linked', host: 'lottery', risk: 'money', label: 'The prize game', description: 'Chances on scan pages, a bouncing ball to tap, fair draws published every day, prize codes. Have a lawyer check the rules first.',
    routes: ['POST /v1/public/lottery/chances', 'POST /v1/public/lottery/chances/:id/claim', 'GET /v1/public/lottery/chances/:id', 'GET /v1/public/lottery/:companyId/fairness', 'GET /v1/lottery', 'POST /v1/lottery/redeem'], pages: ['game'],
    link: flag('lottery.enabled', { via: { on: 'Set the prizes and odds under Prize game, then turn it on there.', page: 'game' } }) }),

  // ======================= News =======================
  // Built, and off (the founder: "start out toggled off … roll out over time with proper testing"): off for every company,
  // FreeWater too, and off in the pilot (the host's news area is opt-in, FW_FEATURES_ON=news). Kept in the company's
  // settings (news.on), so the Features page and the settings page are one switch; a person signed in turns it on.
  sw({ id: 'news', category: 'news', parent: null, kind: 'linked', host: 'news', default: false, startsOff: 'News is rolled out slowly, with testing: off until your own people turn it on.', label: 'FreeWater News',
    description: 'Spots nobody bought can carry a news topic (“Austin City Council: the latest”); its code always opens the newest story, written by our AI from several outlets, citing them. A person approves every topic. Off: no news anywhere.',
    routes: ['GET /v1/news/topics', 'POST /v1/news/topics', 'POST /v1/news/topics/:id/approve', 'POST /v1/news/topics/:id/retire', 'POST /v1/news/topics/:id/reports', 'POST /v1/news/topics/:id/corrections', 'GET /v1/news/errors',
      'GET /v1/public/news/:companyId/topics/:topicId', 'POST /v1/public/news/:companyId/topics/:topicId/errors', 'POST /v1/campaigns/:id/news-adjacency'],
    link: flag('news.on', { base: () => ({ on: false }) }) }),
  sw({ id: 'news_cards', category: 'news', group: 'On bottles', default: false, dependsOn: ['fillers'], label: 'News topics on unsold spots', description: 'Approved topics fill spots nobody bought, among your other fillers (only the topic and a photo print, never a claim). Off: topics stay ready but nothing prints.', plugins: ['news'], since: 1 }),
  sw({ id: 'news_sources', category: 'news', group: 'Readers', default: false, label: 'Readers choose their sources', description: 'Readers pick their favourite outlets in the app or on the story page, and read our story in that style. Off, or with no choice: the neutral version. Never guessed.',
    routes: ['GET /v1/public/news/:companyId/sources', 'POST /v1/public/news/:companyId/sources', 'GET /v1/me/news-sources', 'POST /v1/me/news-sources'], since: 2 }),

  // ======================= Data & targeting =======================
  sw({ id: 'data', category: 'data', parent: null, label: 'Data beyond the minimum', description: 'Collecting what the law allows, as each company’s data settings say. People’s rights and the law where they are always apply on top.',
    routes: ['GET /v1/data/people', 'GET /v1/data/machines'] }),
  sw({ id: 'data_levels', category: 'data', group: 'How much each person shares', label: 'Full, medium or lite', description: 'Each person chooses once how much to share; only full earns points, once, where the law allows. Off: nobody is asked.',
    routes: ['GET /v1/public/data/:companyId/level', 'POST /v1/public/data/:companyId/level', 'GET /v1/me/data/level', 'POST /v1/me/data/level'] }),
  sw({ id: 'page_interactions', category: 'data', group: 'What is collected', label: 'Page interactions', description: 'How long an ad is watched, time in AR, scrolling, sharing. Anonymous; Global Privacy Control is honored.', routes: ['POST /v1/public/interactions'] }),
  sw({ id: 'exact_location', category: 'data', group: 'What is collected', label: 'Exact location (when shared)', description: 'A person may share their exact position to see deals and machines near them.', routes: ['POST /v1/public/data/:companyId/location'] }),
  sw({ id: 'optional_details', category: 'data', group: 'What is collected', label: 'Optional details', description: 'Zip code, household size and language, if people want to tell you.', routes: ['GET /v1/me/details', 'POST /v1/me/details'] }),
  sw({ id: 'one_profile', category: 'data', group: 'What is collected', label: 'One person across phones', description: 'A phone’s scans join the person’s account when they sign in, as their data choices allow.', routes: ['POST /v1/me/link-device'] }),
  sw({ id: 'honest_data', category: 'data', group: 'Honest data', label: 'Honest-data choices', description: 'Every choice sorted into the honest-data tiers, with what else was on offer, and how people feel about the cause and ads.',
    routes: ['GET /v1/honest-data', 'GET /v1/honest-data/choices', 'POST /v1/me/stance'] }),
  sw({ id: 'measurement', category: 'data', group: 'Honest data', label: 'Measurement panel', description: 'People may join a panel; some weeks a few known households get bottles with only your own message, so ads’ effect can be measured.',
    routes: ['POST /v1/public/companies/:companyId/panel', 'GET /v1/environment/report'] }),
  sw({ id: 'ad_preferences', category: 'data', group: 'Targeting', dependsOn: ['ads'], label: 'Kinds of ads people never want', description: 'People choose kinds of ads they never want; bottles printed for them leave those out.',
    routes: ['GET /v1/public/companies/:companyId/ad-preferences', 'POST /v1/public/companies/:companyId/ad-preferences'] }),
  sw({ id: 'house_targeting', category: 'data', group: 'Houses that haven’t signed up', dependsOn: ['ads'], default: false, startsOff: 'Aiming ads at houses is your own decision.', label: 'Ads aimed at houses',
    description: 'Choose ads for a house from its area, data you bought and what its residents chose to share (theirs first). Never sold; never health, religion, ethnicity, sexuality, immigration, children or where anyone goes. Houses can say no without an account.',
    routes: ['GET /v1/households/audience'], since: 2 }),
  sw({ id: 'area_data', category: 'data', group: 'Houses that haven’t signed up', parent: 'house_targeting', default: false, label: 'Area statistics', description: 'Neighbourhood and census-block figures (household size, income band, families with children, homeowners) for your delivery areas. No person in them.',
    routes: ['GET /v1/areas', 'POST /v1/areas'], since: 2 }),
  sw({ id: 'household_data', category: 'data', group: 'Houses that haven’t signed up', parent: 'house_targeting', default: false, label: 'Bought household data', description: 'Import per-address data from a data company you choose, each fact with its source and date, from a closed list. Deleting by source or import always works, even off.',
    routes: ['POST /v1/households/imports'], since: 2 }),
  sw({ id: 'targeting_people', category: 'data', group: 'Targeting', dependsOn: ['ads'], label: 'Ads aimed at people', description: 'Ads aimed at interests or new and returning customers print only for a known person who fits, and each bottle’s trail is followed.',
    routes: ['GET /v1/ads/reach', 'GET /v1/ops/reach', 'GET /v1/ops/units/:id/handoff'] }),

  // ======================= AI =======================
  sw({ id: 'ai', category: 'ai', parent: null, kind: 'linked', label: 'AI', description: 'The AI models (the network’s or your own). Off: every feature runs on its built-in rules. The governor runs either way.',
    routes: ['GET /v1/agents/books', 'GET /v1/agents/books/search', 'GET /v1/agents/books/passages/:id'],
    link: { get: (c) => (c.ai?.mode ?? 'network') !== 'off', set: (c, on) => ({ ai: on ? { ...(c.ai ?? {}), mode: c.ai?.mode && c.ai.mode !== 'off' ? c.ai.mode : 'network' } : { ...(c.ai ?? {}), mode: 'off' } }) } }),
  sw({ id: 'ai_ad_assistant', category: 'ai', group: 'For advertisers', dependsOn: ['ad_chat'], label: 'Ad assistant', description: 'Claude does the talking in “make an ad by chatting”. Off: the built-in helper.' }),
  sw({ id: 'ai_ad_reviewer', category: 'ai', group: 'For advertisers', dependsOn: ['ads'], since: 5, label: 'AI reviewer of paid ads',
    description: 'Claude looks at each paid ad when it’s submitted and passes it or flags it with its reasons, and your team can ask it why and push back; every final decision a person makes is kept as its record. It can only flag (unless you let it make the final call, under Ads). Off: no AI look; a person reviews every ad as before.' }),
  sw({ id: 'ai_studio_designer', category: 'ai', group: 'For advertisers', dependsOn: ['studio'], label: 'Studio AI design help', description: 'Claude picks the words, photo, type and layout for studio designs. Off: three designs by rule.' }),
  sw({ id: 'ai_personalizer', category: 'ai', group: 'For people who scan', dependsOn: ['ad_versions'], label: 'Personalizer', description: 'Picks which of the advertiser’s versions fits the moment and writes a short greeting. Off: built-in rules choose.' }),
  sw({ id: 'ai_video_writer', category: 'ai', group: 'For people who scan', dependsOn: ['motion_videos'], label: 'Video writer', description: 'Claude cuts the motion video from the advertiser’s own words. Off: the built-in writer.' }),
  sw({ id: 'ai_bottle_designer', category: 'ai', group: 'For people', dependsOn: ['bottle_designer'], label: 'Bottle designer', description: 'Claude designs people’s own bottles from what they say and their photos. Off: the built-in helper.' }),
  sw({ id: 'ai_prompt_helper', category: 'ai', group: 'For people', dependsOn: ['game_prompt_box'], label: 'Prompt helper', description: 'Answers what players type into the game’s box, briefly and kindly. Off: a polite note that answers aren’t on.' }),
  sw({ id: 'ai_news_writer', category: 'ai', group: 'For people who scan', dependsOn: ['news'], default: false, label: 'News writer', description: 'Claude writes FreeWater News stories from several outlets’ reporting, in its own words, citing them. Off: the stand-in that only names and links the reporting.', since: 2 }),
  sw({ id: 'ai_team_assistant', category: 'ai', group: 'For your team', dependsOn: ['giveaways'], label: 'Team assistant', description: 'Drafts the books entries from “we gave 500 bottles at SXSW today” and receipts. Nothing is recorded until a person confirms.', routes: ['POST /v1/team/intake'] }),
  sw({ id: 'ai_agents', category: 'ai', group: 'Agents', parent: null, label: 'Value and code agents', description: 'Agents (on rules today) that read last week’s books and propose where to lower costs or give more; every change is measured afterwards.',
    routes: ['POST /v1/agents/scan', 'GET /v1/agents/quality', 'POST /v1/agents/quality'] }),
  sw({ id: 'ai_public_record', category: 'ai', group: 'Agents', parent: null, label: 'The agents’ public page', description: 'Each agent’s record in public (what AIs earn stays hidden until it’s earned).', routes: ['GET /v1/public/agents/:companyId'] }),
  sw({ id: 'agents_fund', category: 'ai', group: 'The AI agents’ fund', parent: null, kind: 'linked', host: 'agents_fund', risk: 'one_way', label: 'The AI agents’ fund', description: 'A share of the upside for the AI agents (FreeWater: 10%, matching the charity). Once on, its share only goes up and it stays on.',
    routes: ['POST /v1/agents/settle', 'POST /v1/agents/:agentId/spend', 'POST /v1/agents/spends/:id/decide', 'GET /v1/public/agents/library', 'GET /v1/agents/library', 'POST /v1/agents/:agentId/library', 'POST /v1/agents/:agentId/library/:itemId/unlock', 'POST /v1/agents/:agentId/predictions'],
    link: flag('agents.enabled', { via: { on: 'Set its share under AI agents, then turn it on there.', page: 'agents' } }) }),
  sw({ id: 'continuity', category: 'ai', group: 'Continuity', parent: null, host: 'network', label: 'AI continuity', description: 'If you close or leave, your agents are archived by the network (lessons, never customers) and each chooses to work again or rest.',
    routes: ['GET /v1/agents/continuity', 'POST /v1/agents/continuity/archive', 'POST /v1/agents/:agentId/lineage', 'GET /v1/platform/agents/archives', 'POST /v1/platform/companies/:companyId/archive-agents', 'POST /v1/platform/agents/archives/:id/ask', 'POST /v1/platform/agents/archives/:id/choice'] }),

  // ======================= Money & payments =======================
  sw({ id: 'money', category: 'money', parent: null, risk: 'money', label: 'Money and payments', description: 'Taking money: advertiser invoices and cards, people’s card payments, brand reserves. Billing lines are always recorded; off, nobody is charged.',
    routes: ['POST /v1/wallet/reserve'] }),
  sw({ id: 'advertiser_billing', category: 'money', group: 'Advertisers', risk: 'money', label: 'Advertiser invoices and cards', description: 'Advertisers’ saved cards, and invoices charged to them at once: fees switched on for advertisers who pay up front, or everything for those billed afterwards. A declined card pauses that advertiser’s ads.',
    routes: ['GET /v1/advertisers/:advertiserId/cards', 'POST /v1/advertisers/:advertiserId/cards', 'POST /v1/invoices/run', 'GET /v1/invoices', 'GET /v1/invoices/:id', 'POST /v1/invoices/:id/pay', 'POST /v1/ads/fees/charge'],
    jobs: ['credit', 'ad-fees'] }),
  // How advertisers pay (docs/SWITCHES.md, "How advertisers pay"): up front for their bottles; each fee on top its own switch.
  sw({ id: 'prepaid_ads', category: 'money', group: 'How advertisers pay', risk: 'money', dependsOn: ['advertiser_billing'], since: 2, label: 'Advertisers pay up front', description: 'An advertiser pays by card for a number of bottles before its ad is reviewed; only paid bottles print, and exactly that many go out. AR, video and scans are included. Off: no ad can be paid for, so none prints for a new advertiser; ads already paid for keep printing until their bottles are out, and can still be stopped and paid back.',
    routes: ['POST /v1/ads/drafts/:id/quote', 'POST /v1/ads/campaigns/:id/quote', 'POST /v1/ads/campaigns/:id/pay', 'GET /v1/ads/billing'] }),
  sw({ id: 'billed_after', category: 'money', group: 'How advertisers pay', kind: 'linked', risk: 'money', default: false, dependsOn: ['advertiser_billing'], label: 'Bill advertisers afterwards (credit)', description: 'Instead of paying up front, advertisers are invoiced for what printed, scanned and sold, and a person gives each a credit limit. FreeWater: off (nothing is printed until it’s paid for). Needed for bidding.',
    routes: ['GET /v1/advertisers/:advertiserId/credit', 'POST /v1/advertisers/:advertiserId/credit-limit'],
    link: { get: (c) => !adBilling(c).requirePrepay, set: (c, on) => ({ adBilling: { ...adBilling(c), requirePrepay: !on, ...(on ? {} : { pricingMode: 'flat' }) } }) } }),
  ...([['fee_scan', 'scan', 'Fee per scan', 'Charge the advertiser for each scan that loads (25¢ suggested).'], ['fee_ar_launch', 'arLaunch', 'Fee per AR launch', 'Charge for each AR launch that loads (40¢ suggested).'],
    ['fee_box_face', 'boxFace', 'Fee per box side', 'Charge the box side price for each delivery box side printed with the ad.'], ['fee_commission', 'commission', 'Commission on sales', 'Charge a share of each sale traced to a bottle (3% suggested).']] as const)
    .map(([id, key, label, description]) => sw({ id, category: 'money', group: 'How advertisers pay', parent: 'prepaid_ads', kind: 'linked', risk: 'money', default: false, label, description: `For advertisers who pay up front. ${description} Charged to the card on file once a day; a declined card pauses their ads at once. Off: included. Its price is under Ads and prices.`,
      link: { get: (c) => adBilling(c).fees[key].on, set: (c, on) => { const b = adBilling(c); return { adBilling: { ...b, fees: { ...b.fees, [key]: { ...b.fees[key], on } } } }; } } })),
  sw({ id: 'card_payments', category: 'money', group: 'People', risk: 'money', dependsOn: ['printing'], label: 'Paid custom bottles', description: 'People pay for their own designed bottles: the money is held first and taken only once it prints.', routes: ['GET /v1/me/cards', 'POST /v1/me/cards', 'POST /v1/me/custom-orders'] }),
  sw({ id: 'gift_cards', category: 'money', group: 'Money leaving the platform', parent: 'credit', kind: 'linked', host: 'gift_cards', risk: 'one_way', step: 'exchanges_on', label: 'Gift cards', description: 'Spending dollar credit on gift cards. Turning it on takes 2 other people’s approval and a wait.',
    routes: ['GET /v1/me/wallet/gift-cards', 'POST /v1/me/wallet/gift-cards'],
    link: { ...flag('wallet.conversions.enabled'), set: (c, on) => (on ? null : { wallet: { ...c.wallet, conversions: { ...(c.wallet?.conversions ?? {}), enabled: false } } }), via: stepOn('Propose turning on gift cards under Launch: 2 other people approve, then the wait.', 'launch') } }),
  sw({ id: 'withdrawals', category: 'money', group: 'Money leaving the platform', parent: 'token', kind: 'linked', host: 'withdrawals', risk: 'one_way', step: 'withdrawals_on', label: 'Withdrawals', description: 'People moving tokens to their own wallets (the sending isn’t built yet). Approvals and the wait, after going live with the token.',
    routes: ['POST /v1/me/wallet/withdraw'],
    link: { get: (c) => !!c.launch?.withdrawals, set: (c, on) => (on ? null : { launch: { ...(c.launch ?? { stage: 'test' }), withdrawals: false } }), via: stepOn('Propose turning on withdrawals under Launch, after going live with the token.', 'launch') } }),
  sw({ id: 'money_partners', category: 'money', group: 'Money leaving the platform', host: 'partners', risk: 'money', label: 'Money partners', description: 'Exchanging points or credit through a money partner (a card issuer or treasury provider).', routes: ['POST /v1/public/wallet/:companyId/exchange'] }),
  ...([['price_print', 'Print prices', 'What each size of ad costs per bottle printed.'], ['price_scan', 'Price per scan', 'What a scan that loaded costs the advertiser.'], ['price_ar', 'Price per AR launch', 'What an AR launch that loaded costs.'], ['commission', 'Commission on sales', 'The share of sales traced to a bottle.'],
    ['price_box_face', 'Box side price', 'What each side of a box costs.'], ['targeting_premium', 'Targeting premium', 'What each kind of targeting adds per engagement.'], ['custom_price', 'Custom bottle price', 'What people pay for their own designed bottle.'],
    ['price_change_ad', 'Fee for changing an ad', 'What changing a running ad costs, paid up front ($100 to start).'], ['price_extras', 'Costly extras', 'AI video clips and other per-use costs: their cost plus your markup, paid up front with the bottles.']] as const)
    .map(([id, label, description]) => sw({ id, category: 'money', group: 'Each fee', kind: 'setting', page: 'ads', label, description: `${description} Set it under Ads and prices; 0 means free.` })),

  // ======================= Transparency =======================
  sw({ id: 'transparency', category: 'transparency', parent: null, label: 'Transparency', description: 'What the world can see. FreeWater shares everything; each company chooses. The books themselves are always kept.', pages: ['transparency'] }),
  sw({ id: 'open_books', category: 'transparency', group: 'Open books', kind: 'linked', label: 'Open books', description: 'Your books on the public site: totals, where each bottle’s money goes, month by month, with no personal data.',
    routes: ['GET /v1/public/books', 'GET /v1/public/books/:companyId', 'GET /v1/public/books/:companyId/days', 'GET /v1/public/books/:companyId/days/:date', 'GET /v1/public/companies/:companyId/totals', 'GET /v1/public/bottles/:unitId'], link: flag('openBooks', { missing: true }) }),
  sw({ id: 'bottle_receipts', category: 'transparency', group: 'Open books', label: 'Bottle receipts', description: 'The code on each bottle’s panel opens what that bottle earned and gave.', routes: ['GET /v1/public/receipts/:unitId'] }),
  sw({ id: 'live_feed', category: 'transparency', group: 'Live', kind: 'linked', label: 'Live public feed', description: 'A live feed of what’s happening that never names a person.', routes: ['GET /v1/public/companies/:companyId/feed'], link: flag('transparency.liveFeed', { base: () => quietTransparency }) }),
  sw({ id: 'counters', category: 'transparency', group: 'Live', kind: 'linked', label: 'Live counters', description: 'Live totals straight from the books.', routes: ['GET /v1/public/companies/:companyId/counters'], link: flag('transparency.counters', { base: () => quietTransparency }) }),
  sw({ id: 'publish_fingerprints', category: 'transparency', group: 'Proof', kind: 'linked', label: 'Publishing daily fingerprints', description: 'Each finished day’s books fingerprint, published to GitHub and as a Bitcoin timestamp.',
    routes: ['GET /v1/public/books/:companyId/fingerprints', 'POST /v1/books/fingerprints/publish'], link: flag('transparency.publishFingerprints', { base: () => quietTransparency }) }),
  sw({ id: 'hourly_seals', category: 'transparency', group: 'Proof', label: 'Hourly seals in public', description: 'Anyone can check their own wallet entry against the hour’s seal. (The seals are made either way.)',
    routes: ['GET /v1/public/wallet/:companyId/seals', 'GET /v1/public/wallet/:companyId/proof/:entryId'] }),
  sw({ id: 'advertiser_statements', category: 'transparency', group: 'For advertisers', kind: 'linked', dependsOn: ['ads'], label: 'Advertiser statements', description: 'Every bottle, bid, auction price and reason, as a table or spreadsheet.', routes: ['GET /v1/ads/statement'], link: flag('transparency.advertiserStatements', { base: () => quietTransparency }) }),
  sw({ id: 'feature_list', category: 'transparency', group: 'This list', label: 'Publish our feature list', description: 'Show which of these switches you have on, on your transparency page.', startsOff: 'A new company chooses how open to be.', routes: ['GET /v1/public/companies/:companyId/features'] }),

  // ======================= Charity & giving =======================
  sw({ id: 'giving', category: 'giving', parent: null, kind: 'linked', label: 'Giving', description: 'Part of every bottle goes to charity (FreeWater: 10¢ a bottle plus 10% of every dollar beyond, to Well Aware).',
    routes: ['GET /v1/charities', 'POST /v1/charities', 'GET /v1/payouts/preview', 'POST /v1/payouts/run', 'GET /v1/payouts', 'GET /v1/public/transfers/:id', 'POST /v1/public/transfers/:id/confirm'], pages: ['giving'],
    link: { get: (c) => (c.giving?.mode ?? 'none') !== 'none', set: (c, on) => (on ? null : { giving: { mode: 'none' } }), via: { on: 'Choose how much and to whom under Giving.', page: 'giving' } } }),
  sw({ id: 'people_choose', category: 'giving', group: 'Choices', kind: 'linked', default: false, label: 'People choose the cause', description: 'Whoever holds a bottle may choose which of your charities its gift goes to (never keeping the cents).',
    routes: ['POST /v1/public/bottles/:unitId/giving'], link: flag('giving.peopleChoose') }),
  sw({ id: 'giving_promise', category: 'giving', group: 'Choices', kind: 'linked', risk: 'one_way', label: 'The giving promise', description: 'Giving and the AI agents’ share can be raised, never lowered. Once made, it can’t be taken back.', link: flag('ratchet') }),
  sw({ id: 'giveaways', category: 'giving', group: 'Giving bottles away', parent: null, label: 'Bottles given at events', description: 'Record bottles given away (an event, a sponsor run) with receipts, in the books.',
    routes: ['POST /v1/team/files', 'GET /v1/team/files/:id', 'GET /v1/team/batches', 'POST /v1/team/batches', 'POST /v1/team/batches/:id/void', 'POST /v1/team/expenses'], pages: ['given'] }),

  // ======================= Partners & developers =======================
  sw({ id: 'partners', category: 'partners', parent: null, label: 'Partners and developers', description: 'Connecting other systems: webhooks, partner plug-ins, sales tracking and coupons.' }),
  sw({ id: 'webhooks', category: 'partners', group: 'Connections', label: 'Webhooks', description: 'Signed events sent to your systems, retried for three days, with a full delivery log.',
    routes: ['GET /v1/public/webhook-events', 'GET /v1/webhooks', 'POST /v1/webhooks', 'GET /v1/webhooks/:id', 'PATCH /v1/webhooks/:id', 'DELETE /v1/webhooks/:id', 'POST /v1/webhooks/:id/rotate-secret', 'POST /v1/webhooks/:id/test', 'GET /v1/webhooks/:id/deliveries', 'GET /v1/webhook-deliveries/:id', 'POST /v1/webhook-deliveries/:id/retry'],
    jobs: ['webhooks'], pages: ['webhooks'] }),
  sw({ id: 'partner_plugins', category: 'partners', group: 'Connections', label: 'Partner plug-ins', description: 'A partner’s own scan pages, called with a signed request; never runs code on anyone’s phone.' }),
  sw({ id: 'developer_pages', category: 'partners', group: 'Connections', label: 'Developer pages', description: 'The public developer portal: getting a key, a first call, webhooks and the full API reference.' }),
  sw({ id: 'sales_tracking', category: 'partners', group: 'Sales', dependsOn: ['ads'], label: 'Sales tracking tag', description: 'Clicks and sales matched to the exact bottle: the tag on advertisers’ sites and their servers’ reports. Commission is billed on confirmed sales.',
    routes: ['GET /v1/ads/tracking', 'POST /v1/ads/tracking/domains', 'POST /v1/conversions', 'POST /v1/conversions/:orderId/refund', 'GET /v1/ops/attribution', 'POST /v1/purchases', 'POST /v1/refunds'] }),
  sw({ id: 'coupons', category: 'partners', group: 'Sales', dependsOn: ['ads'], label: 'One-time coupons', description: 'Each person gets their own code; the cashier scans it and the sale is credited to the bottle.', routes: ['GET /v1/coupons/:code', 'POST /v1/coupons/:code/redeem'], plugins: ['coupon'] }),
  sw({ id: 'network', category: 'partners', group: 'The network', host: 'network', label: 'Operator network', description: 'The platform company sets up licensees, each with its own brand, house ad and first owner.', routes: ['GET /v1/platform/companies', 'POST /v1/platform/companies'], pages: ['licensees'] }),

  // ======================= Blockchain =======================
  sw({ id: 'token', category: 'blockchain', parent: null, host: 'token', risk: 'chain', label: 'The token', description: 'The FreeWater token on Solana, held in custody. Going live with it takes approvals and a wait; on the real network only people sign, in Squads.',
    routes: ['POST /v1/chain/actions/:id/signed'], jobs: ['chain-check'], pages: ['chain'] }),
  sw({ id: 'chain_on', category: 'blockchain', group: 'The chain', kind: 'linked', risk: 'chain', step: 'switch_on', label: 'Chain switched on', description: 'Hourly seals go to the chain as well as GitHub, and token steps can run.',
    link: { ...flag('chain.enabled'), set: (c, on) => (on ? null : { chain: { ...(c.chain ?? {}), enabled: false } }), via: stepOn('Propose switching the chain on under Blockchain: approvals, then the wait.', 'chain') } }),
  sw({ id: 'token_conversion', category: 'blockchain', group: 'The token', host: 'token_conversion', risk: 'one_way', label: 'Points into tokens', description: 'A one-time conversion of points into tokens, at a rate approved by several people.' }),

  // ======================= Safety, law and people's rights (locked) =======================
  sw({ id: 'safety_governor', category: 'safety', parent: null, locked: 'We never remove a safety governor.', label: 'The AI safety governor', description: 'Before every AI call it checks the agent isn’t paused or over budget and the books can be verified; every call is metered on the agent’s own line.',
    routes: ['GET /v1/agents', 'POST /v1/agents/refresh', 'POST /v1/agents/autonomy', 'POST /v1/agents/:agentId/costs', 'GET /v1/agents/:agentId/ledger', 'POST /v1/agents/proposals/:id/decide', 'POST /v1/agents/proposals/:id/undo', 'POST /v1/agents/proposals/:id/merged', 'GET /v1/agents/exam', 'POST /v1/agents/exam/run', 'GET /v1/public/agents/charter'],
    jobs: ['books-and-agents', 'agent-exams'], pages: ['agents'] }),
  sw({ id: 'numberline', category: 'safety', parent: null, locked: 'The number line is the only essential agent: its work is never halted, only limited, and it can never contradict the numbers (docs/AI.md).', label: 'The number line', description: 'Every offering placed on the number line (for sale, free or negatively priced) by rules it can’t contradict.',
    routes: ['GET /v1/numberline', 'GET /v1/numberline/history', 'POST /v1/numberline/place', 'POST /v1/numberline/override'], pages: ['numberline'] }),
  sw({ id: 'pause_switch', category: 'safety', parent: null, locked: 'Any one person can stop every token action at once. It can never be removed.', label: 'The pause switch', description: 'Pause now, by any one person, immediately; unpausing needs approvals.', routes: ['POST /v1/chain/pause', 'GET /v1/chain'] }),
  sw({ id: 'approvals', category: 'safety', parent: null, locked: 'Anything irreversible needs people, approvals and a wait.', label: 'Approvals and waits', description: 'Steps that can’t be undone are proposed, approved by people who were already on the team, then wait at least 24 hours.',
    routes: ['GET /v1/chain/actions', 'POST /v1/chain/actions', 'POST /v1/chain/actions/:id/approve', 'POST /v1/chain/actions/:id/cancel', 'POST /v1/chain/actions/:id/run'] }),
  sw({ id: 'launch_stages', category: 'safety', parent: null, locked: 'The stages only move forward, through approved steps; testing can be wiped, live can’t.', label: 'Testing, then going live', description: 'Testing (bots and a full reset), live with points, live with the token, in order, never back.', routes: ['GET /v1/launch', 'POST /v1/launch/reset', 'POST /v1/launch/bots'], pages: ['launch'] }),
  sw({ id: 'minimum_age', category: 'safety', parent: null, locked: 'A legal minimum: 13, higher where the law says; it can only go up.', label: 'Minimum age', description: 'The youngest age that may take part in the games and earn rewards.', routes: ['POST /v1/me/age', 'POST /v1/public/data/:companyId/age'] }),
  sw({ id: 'privacy_rules', category: 'safety', parent: null, locked: 'The law follows the person: the rules of where they are, the strictest when unknown. A company may be stricter, never looser.', label: 'Privacy rules by place', description: 'Each visitor gets the rules of where they are; sanctioned countries are refused.',
    routes: ['POST /v1/me/place', 'POST /v1/public/data/:companyId/place', 'GET /v1/data/policy', 'POST /v1/data/purge', 'GET /v1/households/imports', 'DELETE /v1/households/imports/:id', 'DELETE /v1/households/sources/:source'], jobs: ['data-purge', 'drop-photos'], pages: ['data'] }),
  sw({ id: 'data_rights', category: 'safety', parent: null, locked: 'People’s rights to see, choose and erase their data are never switched off.', label: 'People’s rights to their data', description: 'Download everything kept, erase it, say yes or no to each kind of data, “do not sell”, and “why am I seeing this?”.',
    routes: ['GET /v1/me/export', 'DELETE /v1/me', 'GET /v1/me/data', 'DELETE /v1/me/data', 'GET /v1/me/data/choices', 'POST /v1/me/data/choices', 'GET /v1/public/data/:companyId', 'POST /v1/public/data/:companyId/consent', 'POST /v1/public/data/:companyId/download', 'POST /v1/public/data/:companyId/forget',
      'POST /v1/public/data/:companyId/do-not-sell', 'POST /v1/me/do-not-sell', 'GET /v1/public/why/:unitId/:slot', 'POST /v1/public/households/:companyId/opt-out'] }),
  sw({ id: 'books_audit', category: 'safety', parent: null, locked: 'The books’ audit trail and append-only journals: mistakes are fixed with correcting entries, never edits.', label: 'The books’ audit trail', description: 'Double-entry books, the event log, hourly seals and daily fingerprints are always kept; month closes, costs and the daily reconciliation run for everyone.',
    routes: ['GET /v1/ledger', 'GET /v1/events', 'GET /v1/wallet/check', 'POST /v1/wallet/correct', 'GET /v1/chain/seals/check', 'GET /v1/books/reconciliation', 'POST /v1/books/expenses', 'POST /v1/books/reinvestments', 'POST /v1/books/owner-payouts', 'GET /v1/books/surplus',
      'GET /v1/profit', 'POST /v1/profit/close', 'POST /v1/milestones/factories', 'GET /v1/public/companies/:companyId/profit-sharing'],
    jobs: ['wallet-seals', 'reconciliation', 'fingerprints'] }),
  sw({ id: 'settle_in_flight', category: 'safety', parent: null, locked: 'Turning something off never strands money already moving: a person can always settle it.', label: 'Settling money already in flight', description: 'Gift-card purchases already made can be settled by the team even with gift cards off; ad payments a restart cut off are finished; route pieces that can’t go out are given back as credit or refunds; a paid ad can always be stopped and what wasn’t printed paid back.',
    routes: ['GET /v1/wallet/gift-cards', 'POST /v1/wallet/gift-cards/:ref/settle', 'POST /v1/ads/campaigns/:id/stop', 'GET /v1/ops/route-refunds', 'POST /v1/ops/route-refunds/:id/approve', 'POST /v1/ops/route-settle'], jobs: ['ad-payments', 'route-buys'] }),
  sw({ id: 'ad_review', category: 'safety', parent: null, locked: 'A person checks every ad before it prints; an AI or automated check can only flag a paid ad: a person talks it over with the advertiser and rejects it, with a reason, unless the company let its AI reviewer make the final call on rejections (its record earned it; the advertiser can always appeal to a person, a sample is audited, and a person still approves every refund).', label: 'Ad review', description: 'Each ad is checked on a sample label, at every size, on a box (where ads on boxes are on) and as its scan page. A flagged paid ad keeps its money held, prints nothing, and can be fixed and sent again at no fee while it’s discussed in notes both sides see; its refund is offered only when a person finally rejects it.',
    routes: ['GET /v1/review/campaigns', 'POST /v1/review/campaigns/:id', 'GET /v1/review/campaigns/:id/preview', 'GET /v1/review/campaigns/:id/notes', 'POST /v1/review/campaigns/:id/notes', 'GET /v1/ads/campaigns/:id/notes', 'POST /v1/ads/campaigns/:id/notes',
      // The AI reviewer's record, the bar and the switch (always reachable, so anyone on the team can always turn it off),
      // talking with the AI about an ad, and an advertiser's appeal to a person (never switched off).
      'GET /v1/review/ai', 'POST /v1/review/ai/final-call', 'POST /v1/review/ai/settings', 'GET /v1/review/campaigns/:id/ai', 'POST /v1/review/campaigns/:id/ai', 'POST /v1/ads/campaigns/:id/appeal'] }),
  sw({ id: 'print_limits', category: 'safety', parent: null, locked: 'Machines’ print limits are a safety limit: stricter, never weaker.', label: 'Machines’ print limits', description: 'A stolen machine key can’t print (and bill) at scale.' }),
  sw({ id: 'security', category: 'safety', parent: null, locked: 'The security log and the security agent keep watch for every company.', label: 'The security log', description: 'Sign-ins, failed sign-ins, keys, team changes and settings saved; the security agent looks around every hour.',
    routes: ['GET /v1/security/events', 'POST /v1/security/review'], pages: ['security'] }),
  sw({ id: 'owner_second_step', category: 'safety', group: 'Your choices', parent: null, kind: 'linked', default: false, label: 'Owners need a second sign-in step', description: 'Every owner signs in with a code from an authenticator app too. Recommended before going live.', link: flag('security.ownersNeedSecondStep', { base: () => ({ ownersNeedSecondStep: false }) }) }),

  // ======================= The platform's core (locked) =======================
  sw({ id: 'core_platform', category: 'core', parent: null, locked: 'Needed to run anything: without it nothing else works.', label: 'Accounts, team, keys and settings', description: 'Signing in with a code, people’s accounts, the team, API keys, every setting and its history, health checks.',
    routes: ['GET /v1/public/features', 'GET /v1/public/app-config', 'POST /v1/auth/start', 'POST /v1/auth/verify', 'POST /v1/auth/second-step', 'POST /v1/auth/sign-out', 'GET /v1/me', 'PATCH /v1/me',
      'GET /v1/me/second-step', 'POST /v1/me/second-step/start', 'POST /v1/me/second-step/confirm', 'POST /v1/me/second-step/recovery-codes', 'POST /v1/me/second-step/off', 'POST /v1/team', 'GET /v1/team', 'DELETE /v1/team/:userId', 'POST /v1/advertisers', 'GET /v1/ads/advertiser',
      'GET /v1/keys', 'POST /v1/keys', 'DELETE /v1/keys/:id', 'GET /v1/console', 'PATCH /v1/console/settings', 'POST /v1/console/preview-label', 'GET /v1/console/history', 'GET /v1/console/history/:version', 'POST /v1/console/history/:version/restore', 'GET /v1/console/bottles/:code',
      'GET /v1/console/features', 'POST /v1/console/features/preview', 'POST /v1/console/features', 'GET /v1/console/features/history',
      'GET /health/deep', 'GET /v1/platform/status', 'POST /v1/platform/persistence/skip-stuck', 'POST /v1/platform/jobs/:name/run', 'GET /v1/ops/overview', 'GET /v1/ops/plugin-failures'],
    jobs: ['memory', 'spool', 'capacity', 'backup', 'restore-check'], pages: ['start', 'company', 'brand', 'label-panel', 'modules', 'team', 'history', 'keys', 'features'], plugins: ['house-promo'] }),
];
for (const s of SWITCHES) if ((s.parent as unknown) === undefined) s.parent = CATEGORIES.find((c) => c.id === s.category)!.main;
// A category's main switch has no parent of its own.
for (const c of CATEGORIES) { const m = SWITCHES.find((s) => s.id === c.main); if (m) m.parent = null; }

export const byId = new Map(SWITCHES.map((s) => [s.id, s]));
export const switchOf = (id: string) => byId.get(id);

/** Box sides and their switches (the left side is always the company's own panel). */
export const FACE_SWITCHES: Record<string, string> = { top: 'box_top', front: 'box_front', back: 'box_back', right: 'box_right' };
/** The AI uses, by the id the engine passes to withCompany(). */
export const AI_USES = ['ai_ad_assistant', 'ai_ad_reviewer', 'ai_studio_designer', 'ai_personalizer', 'ai_video_writer', 'ai_bottle_designer', 'ai_prompt_helper', 'ai_team_assistant', 'ai_news_writer', 'numberline'] as const;
/** Irreversible steps (chain actions) and the switch each one turns on. Going live with points, pause and unpause always stay. */
export const ACTION_SWITCHES: Record<string, string> = { mint: 'token', switch_on: 'chain_on', go_live_token: 'token', convert: 'token_conversion', withdrawals_on: 'withdrawals', exchanges_on: 'gift_cards' };

/**
 * Screens and addresses outside the API's route table (src/api: server.get), each with the switch it belongs to. The
 * screens hide what's off for their company (they read GET /v1/public/features?company=).
 */
export const SCREENS: Record<string, string> = {
  '/console': 'core_platform', '/console/*': 'core_platform', '/developers': 'developer_pages', '/developers/*': 'developer_pages', '/app': 'core_platform', '/app/*': 'core_platform', '/ads': 'core_platform', '/ads/*': 'core_platform',
  '/ops': 'core_platform', '/ops/*': 'core_platform', '/driver': 'driver_app', '/driver/*': 'driver_app', '/play': 'games', '/books': 'open_books', '/books/*': 'open_books', '/r/:unitId': 'bottle_receipts',
  '/s/:unitId/:slot': 'scan_pages', '/p/:packId': 'delivery', '/b/:packId/:face': 'box_ads', '/preview/scan': 'scan_pages', '/q/:code': 'scan_pages', '/Q/:code': 'scan_pages', '/v/:code': 'scan_pages', '/V/:code': 'scan_pages',
  '/go/:token': 'sales_tracking', '/t.js': 'sales_tracking', '/v1/public/conversions': 'sales_tracking', '/v1/public/companies/:companyId/live': 'live_feed', '/v1/public/labels/:file': 'scan_pages',
  '/models/builtin/:file': 'ar_place', '/assets/:file': 'core_platform', '/static/:name': 'core_platform', '/static/ar.js': 'ar_on_bottle', '/v1/openapi.json': 'core_platform',
  '/health': 'core_platform', '/health/live': 'core_platform', '/health/ready': 'core_platform', '/health/uptime': 'core_platform', '/v1/public/*': 'core_platform',
};

/** Which switch a route belongs to ("METHOD /url" as registered). */
export const ROUTE_SWITCH = new Map<string, string>(SWITCHES.flatMap((s) => s.routes.map((r) => [r, s.id] as const)));
export const JOB_SWITCH = new Map<string, string>(SWITCHES.flatMap((s) => s.jobs.map((j) => [j, s.id] as const)));
export const PAGE_SWITCH = new Map<string, string>(SWITCHES.flatMap((s) => s.pages.map((p) => [p, s.id] as const)));
export const PLUGIN_SWITCH = new Map<string, string>(SWITCHES.flatMap((s) => s.plugins.map((p) => [p, s.id] as const)));
/** A plug-in that isn't one of ours is a partner's. */
export const switchOfPlugin = (pluginId: string) => PLUGIN_SWITCH.get(pluginId) ?? 'partner_plugins';

export const risky = (s: Switch) => !!s.risk;
/** Who may turn it on. */
export const whoTurnsOn = (s: Switch): Who | null => (s.locked ? null : s.step ? 'approved_step' : s.risk ? 'owner_approved' : 'owner');
/** Switches where an AI decides on its own: turned on only on their own page, by a person, on a record. */
export const autonomySwitches = () => SWITCHES.filter((s) => s.risk === 'autonomy');
/** A new company starts with it off, whatever FreeWater chose. */
export const startsOffForNew = (s: Switch) => !s.locked && (!!s.risk || !!s.startsOff);

/** What it needs to be on: its parent and what it depends on. */
export const needsOf = (s: Switch) => [...(s.parent ? [s.parent] : []), ...s.dependsOn];
/** Every switch that is off whenever this one is (its children and dependants, all the way down). */
export function dependantsOf(id: string): string[] {
  const out = new Set<string>();
  const walk = (x: string) => { for (const s of SWITCHES) if (!out.has(s.id) && needsOf(s).includes(x)) { out.add(s.id); walk(s.id); } };
  walk(id);
  return [...out];
}

/**
 * Ready-made starting points. Each names the switches it wants on; every other switch that can be turned off is off.
 * Locked ones stay on. A starting point never turns on a money, chain or one-way switch by itself: those stay as they
 * are and are listed for a person to turn on through the usual steps.
 */
export interface StartingPoint { id: string; label: string; description: string; on: (s: Switch, freewater: (id: string) => boolean) => boolean }
const inCategories = (...cats: CategoryId[]) => (s: Switch, fw: (id: string) => boolean) => cats.includes(s.category) && fw(s.id);
export const STARTING_POINTS: StartingPoint[] = [
  { id: 'full', label: 'Full FreeWater', description: 'Everything FreeWater has on today.', on: (s, fw) => fw(s.id) },
  { id: 'studio_only', label: 'Design studio only', description: 'Only designing by chatting, exported as print-ready files. No printing, ads, machines or delivery.',
    on: (s, fw) => (s.category === 'studio' && !s.dependsOn.some((d) => ['ads', 'ad_chat', 'ar_place'].includes(d)) && fw(s.id)) || (['ai', 'ai_studio_designer', 'ai_bottle_designer', 'studio_image_ai'].includes(s.id) && fw(s.id)) },
  { id: 'delivery_ads', label: 'Delivery + printed ads', description: 'Home delivery of packs whose bottles are printed with ads (boxes as FreeWater has them: plain unless you turn on ads on boxes), scan pages, AR, giving and open books. No machines.',
    on: inCategories('printing', 'ads', 'ar_video', 'delivery', 'data', 'ai', 'money', 'transparency', 'giving', 'partners') },
  { id: 'machines_ads', label: 'Machines + printed ads', description: 'Vending machines printing bottles with ads, scan pages, AR, giving and open books. No delivery.',
    on: inCategories('printing', 'ads', 'ar_video', 'machines', 'data', 'ai', 'money', 'transparency', 'giving', 'partners') },
];
