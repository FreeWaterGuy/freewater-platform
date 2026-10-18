import type { Campaign, CompanyConfig, CtaVariant } from '../../core/types';
import { checkQrColor, checkQrLogo } from '../print/qr';
import { safeUrl } from './blocks';
import { checkConditions } from './dynamic';
import type { ExperienceHost } from './host';

// The parts of a campaign beyond its artwork: what kind of QR it prints, the versions of its call to action, AI
// personalization, what old bottles open after it ends, and who it's for. Checked here, the same for the API, the
// advertiser portal and the company console.

export interface CampaignExtras {
  qr?: Campaign['qr'] | null;
  variants?: CtaVariant[];
  personalize?: Campaign['personalize'] | null;
  afterEnd?: Campaign['afterEnd'];
  targeting?: Partial<Campaign['targeting']>;
}

export const extrasSchema = {
  qr: { type: ['object', 'null'], additionalProperties: false, properties: { mode: { type: 'string', enum: ['dynamic', 'static'] }, staticUrl: { type: 'string', maxLength: 1000 }, bottleRef: { type: 'boolean' }, logo: { type: 'string', maxLength: 300_000 }, color: { type: 'string', maxLength: 7 } }, required: ['mode'] },
  variants: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', maxLength: 40 }, name: { type: 'string', minLength: 1, maxLength: 60 }, when: { type: 'object' }, experienceId: { type: 'string', maxLength: 60 }, experienceConfig: { type: 'object' } }, required: ['id', 'name', 'experienceConfig'] } },
  personalize: { type: ['object', 'null'], additionalProperties: false, properties: { ai: { type: 'boolean' }, greeting: { type: 'boolean' } } },
  afterEnd: { type: 'string', enum: ['current', 'keep'] },
  targeting: { type: 'object', additionalProperties: false, properties: {
    locations: { type: 'array', items: { type: 'string' } },
    products: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 60 } },
    productCategories: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } },
    audience: { type: ['object', 'null'], additionalProperties: false, properties: { interestsAny: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } }, customers: { type: 'string', enum: ['new', 'returning'] } } },
  } },
} as const;

/**
 * Check the extras and apply them to the campaign. Returns the problem in plain words, or null when everything was
 * applied. Nothing is changed unless everything is fine.
 */
export function applyExtras(company: CompanyConfig, c: Campaign, x: CampaignExtras, host: ExperienceHost): string | null {
  if (x.qr) {
    if (x.qr.mode === 'static') {
      if (!company.qr?.allowStatic) return `${company.name} only prints dynamic codes.`;
      if (!x.qr.staticUrl || !safeUrl(x.qr.staticUrl) || !x.qr.staticUrl.startsWith('https://')) return 'A static code needs the https:// address it should open.';
    }
    if (x.qr.logo !== undefined && x.qr.logo !== '') {
      if (company.qr && company.qr.advertiserLogos === false) return `${company.name} doesn't put advertisers' logos in codes.`;
      const bad = checkQrLogo(x.qr.logo);
      if (bad) return `Logo: ${bad}.`;
    }
    if (x.qr.color !== undefined && x.qr.color !== '') { const bad = checkQrColor(x.qr.color); if (bad) return `Code color: ${bad}.`; }
  }
  if (x.variants) {
    const ids = new Set<string>();
    for (const [i, v] of x.variants.entries()) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(v.id)) return `Version ${i + 1}: its id must be lowercase letters, numbers and dashes.`;
      if (v.id === 'default' || ids.has(v.id)) return `Version ${i + 1}: "${v.id}" is already used.`;
      ids.add(v.id);
      const cond = checkConditions(v.when);
      if (cond) return `Version "${v.name}": ${cond}.`;
      const bad = host.checkConfig(v.experienceId ?? c.experienceId, v.experienceConfig);
      if (bad) return `Version "${v.name}": ${bad}`;
    }
  }
  if (x.targeting?.products) for (const id of x.targeting.products) if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) return `"${id}" isn't a product id.`;
  if (x.targeting?.audience?.interestsAny && !x.targeting.audience.interestsAny.every((i) => /^[\p{L}\p{N} &'-]{1,40}$/u.test(i))) return 'Interests must be short words like coffee or running.';

  if (x.qr !== undefined) {
    if (x.qr === null) delete c.qr;
    else {
      // A logo already saved stays unless a new one is sent ('' removes it). The same for the color.
      const logo = x.qr.logo === '' ? undefined : x.qr.logo ?? c.qr?.logo;
      const color = x.qr.color === '' ? undefined : x.qr.color ?? c.qr?.color;
      const next = clean({ ...x.qr, logo, color, staticUrl: x.qr.mode === 'static' ? x.qr.staticUrl : undefined, bottleRef: x.qr.mode === 'static' ? x.qr.bottleRef : undefined });
      if (next.mode === 'dynamic' && !next.logo && !next.color) delete c.qr; else c.qr = next;
    }
  }
  if (x.variants !== undefined) { if (x.variants.length) c.variants = x.variants.map((v) => ({ ...v, ...(v.when && Object.keys(v.when).length ? {} : { when: undefined }) })).map(clean); else delete c.variants; }
  if (x.personalize !== undefined) { if (!x.personalize || (!x.personalize.ai && !x.personalize.greeting)) delete c.personalize; else c.personalize = { ai: !!x.personalize.ai, greeting: !!x.personalize.greeting }; }
  if (x.afterEnd !== undefined) c.afterEnd = x.afterEnd;
  if (x.targeting) {
    const t = { ...c.targeting, ...x.targeting };
    for (const k of ['products', 'productCategories'] as const) if (!t[k]?.length) delete t[k];
    if (!t.audience || (!t.audience.interestsAny?.length && !t.audience.customers)) delete t.audience;
    else t.audience = { ...(t.audience.interestsAny?.length ? { interestsAny: t.audience.interestsAny.map((i) => i.toLowerCase()) } : {}), ...(t.audience.customers ? { customers: t.audience.customers } : {}) };
    c.targeting = t;
  }
  return null;
}

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Whether these extras change what people see (so an advertiser's change goes back to review). */
export const changesWhatPeopleSee = (x: CampaignExtras) => x.qr !== undefined || x.variants !== undefined || x.personalize !== undefined;
