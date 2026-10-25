import type { CompanyConfig } from '../../core/types';
import { siteBase } from '../../core/site';
import { adBilling } from '../ads/billing';
import { categoryInfo, dataCategories, dataUse, preset } from '../data/policy';
import { unsoldSettings, UNSOLD_SOURCE_LABELS } from '../fillers/unsold';
import { bottledForOf, panelOf } from '../print/panel';
import { givingLine } from '../print/renderer';
import { transparencyOf, type Counters } from './service';

/**
 * A company's public transparency page (GET /v1/public/companies/:id/transparency; the page at /transparency), in plain
 * words and built only from the company's own settings and books, so every company has its own and none shows another's
 * name. The basics are always there while the page is on (Transparency → Public transparency page): who the company is,
 * how the free bottle is paid for, what goes to charity, how ads are chosen, what data is kept and how a household says
 * no, how AI is used, the open books and daily proof, and how to reach it. The extras are each its own choice: the
 * live counters (transparency.counters) and its switches (Transparency → Publish our feature list).
 */
export interface PageDeps {
  company: CompanyConfig;
  /** The company's switches. */
  on: (id: string) => boolean;
  /** Totals straight from the books (the same as the live counters). */
  counters: () => Counters;
  /** Its switches, when it publishes them. */
  published: () => unknown;
  /** Which AI really answers (routing.ts aiInUse): with no key set, it's the built-in rules, whatever the setting says. */
  ai?: 'network' | 'own' | 'none';
}

const cents = (c: number) => (c < 100 ? `${c}¢` : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export function transparencyPage(d: PageDeps) {
  const c = d.company;
  const name = c.name;
  const t = transparencyOf(c);
  const books = c.openBooks !== false;
  const q = `?company=${encodeURIComponent(c.id)}`;
  const base = siteBase(c);
  const panel = panelOf(c, null);
  const billing = adBilling(c);
  const whole = c.prices.perPrintByShare[1];

  // How the bottle is paid for.
  const price = c.consumerPricing === 'free' ? 'free to you' : c.consumerPricing === 'discounted' ? 'sold to you below its usual price' : 'sold at its usual price';
  const paid = [
    `Each bottle is ${price}. Other businesses pay to put their ads on the label, and that pays for the water, the bottle and the printing.`,
    billing.requirePrepay ? `Advertisers pay up front for the bottles their ad prints on, at ${billing.pricingMode === 'auction' ? 'prices set by bids, starting from' : 'flat prices, from'} ${cents(whole)} for a whole label (smaller pieces cost less).` : `Advertisers are billed for each bottle their ad prints on, from ${cents(whole)} for a whole label.`,
    'An ad is paid for only when its bottle actually prints. Scans that don’t load and repeat scans are never billed.',
  ];

  // Giving, with totals from the books (only when the books are public).
  const line = givingLine(c, '');
  const ct = books ? d.counters() : null;
  const giving = {
    on: c.giving.mode !== 'none',
    line: line ?? `${name} doesn’t give a set amount per bottle.`,
    totals: ct && c.giving.mode !== 'none' ? { givenCents: ct.givenCents, sentCents: ct.sentCents, owedCents: ct.owedCents, byCharity: ct.byCharity } : null,
    note: books ? 'Owed the moment a bottle prints, and sent to each charity in transfers you can see in the open books.' : `${name} keeps its books private, so the totals aren’t shown here.`,
  };

  // How ads are chosen.
  const u = unsoldSettings(c);
  const ads = [
    `Every ad on a bottle is another business’s or a cause’s. ${name}’s only space on the label is its own panel (the logo, the giving line and the receipt code).`,
    `Ads are reviewed before they print. Never printed: ${c.adRules.blockedCategories.length ? c.adRules.blockedCategories.join(', ') : 'nothing is ruled out by category, but every ad is still reviewed'}.`,
    c.adRules.competitorSeparation ? 'Two competitors are never printed on the same bottle.' : '',
    `Space nobody bought is filled, in this order: ${u.order.length ? u.order.map((s) => UNSOLD_SOURCE_LABELS[s].replace(/ \(.*\)$/, '').toLowerCase()).join(', then ') : 'nothing'}${u.ownAds ? `, then ${name}’s own messages` : ''}. Those pieces are free and never billed; anything left prints plain.`,
  ].filter(Boolean);

  // What data is kept, and how a household says no.
  const policy = c.data ?? preset('us');
  const data = {
    kept: dataCategories.filter((k) => policy.rules[k].collect).map((k) => ({ what: categoryInfo[k].label, detail: categoryInfo[k].what, consent: policy.rules[k].consent === 'opt_in' ? 'Only if you say yes' : policy.rules[k].consent === 'opt_out' ? 'Unless you say no' : 'Needed to run the service', keepDays: policy.rules[k].keepDays })),
    use: dataUse,
    you: 'In the app you choose how much you share (Full, Medium or Lite), and you can download or erase your data at any time. Nothing works differently at any level.',
    households: d.on('delivery') ? {
      text: 'A household can say no to ads chosen for it, without an account: anything bought about the address is deleted and never used again. Someone who proved a house is theirs can also stop deliveries or block a business’s ads there in the app.',
      optOutUrl: `/v1/public/households/${encodeURIComponent(c.id)}/opt-out`,
    } : null,
  };

  // AI, in plain words.
  const which = d.ai ?? ((c.ai?.mode ?? 'network') === 'off' ? 'none' : c.ai?.mode === 'own' ? 'own' : 'network');
  const aiOn = d.on('ai') && which !== 'none';
  const ai = [
    aiOn ? `Which AI: ${which === 'own' ? `${name}’s own AI account` : 'Claude, by Anthropic (the network’s AI)'}.`
      : d.on('ai') && (c.ai?.mode ?? 'network') !== 'off' ? 'No AI is connected right now: every feature runs on its built-in rules.' : 'AI is off: every feature runs on its built-in rules.',
    d.on('ad_ratings') ? `Rating: each ad is rated 1 to 10 before it prints${aiOn && d.on('ai_ad_rater') ? ' by the AI' : ' by built-in rules'}, so ${name} can learn what works.` : '',
    aiOn && d.on('ai_ad_reviewer') ? 'Review: the AI looks at each paid ad and can flag it with its reasons; a person makes the final decision, and every decision is kept.' : 'Review: a person on the team reviews ads.',
    'The governor: a safety check that always runs, whatever is switched on. It limits what any AI may do on its own, and nothing that moves money or can’t be undone happens without people approving it.',
  ].filter(Boolean);

  // How to reach the company: its panel's own contact lines, else any line that looks like a way to reach it.
  const reach = [...(panel.contact ?? []), ...panel.maker.filter((l) => /@|\d{3}.?\d{4}|https?:|\.[a-z]{2,}\b/i.test(l))].filter((l) => l.trim());

  return {
    companyId: c.id,
    company: name,
    brand: c.brand,
    site: base,
    about: [`${name} gives out bottled water whose labels carry ads from other businesses.`, bottledForOf(c, c.labelPanel) || '', c.brand.tagline ?? ''].filter(Boolean),
    paid,
    giving,
    ads,
    data,
    ai,
    proof: {
      openBooks: books ? `/books${q}` : null,
      dailyProof: books ? `/books/proof${q}` : null,
      fingerprintsPublished: books && t.publishFingerprints,
      text: books ? 'Every bottle’s money is in the open books. Each day’s books get a fingerprint built on the day before, so anyone can check nothing in the past was changed.' : `${name} keeps its books private.`,
    },
    counters: books && t.counters ? d.counters() : null,
    switches: d.published(),
    contact: reach,
  };
}
