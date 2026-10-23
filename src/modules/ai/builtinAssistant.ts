import { missingLabels, type DraftPatch, type Missing } from '../ads/draft';
import type { AdAssistant, AdAssistantInput, AdAssistantOutput } from './contract';
import type { Share } from '../../core/types';
import { shareName } from '../ads/layouts';

/**
 * The built-in stand-in for an AI. It reads simple things out of what people type (offers, colors, prices,
 * places, links) and fills in a sensible ad, then asks for whatever is still missing. No outside service.
 * Swap in a real AI with the same contract (see claudeAssistant.ts) for a full conversation.
 */

const CATEGORIES: [RegExp, string, string][] = [
  [/\b(burgers?|fries|grill|bbq)\b/, 'food', 'burger'],
  [/\b(pizza|pizzeria)\b/, 'food', 'pizza'],
  [/\b(tacos?|burrito|tex-mex|mexican)\b/, 'food', 'taco'],
  [/\b(restaurant|food|kitchen|diner|eat|lunch|dinner)\b/, 'food', 'star'],
  [/\b(coffee|cafe|café|latte|espresso|tea)\b/, 'coffee', 'coffee'],
  [/\b(realty|real estate|realtor|home for sale|listing|house|homes?)\b/, 'real-estate', 'house'],
  [/\b(gym|fitness|yoga|pilates|workout|class(es)?|training)\b/, 'fitness', 'bolt'],
  [/\b(news|paper|magazine|story|article)\b/, 'news', 'news'],
  [/\b(dent(al|ist)|teeth|smile)\b/, 'health', 'tooth'],
  [/\b(pets?|dogs?|cats?|groom(ing)?|vet)\b/, 'pets', 'paw'],
  [/\b(music|concert|show|band|venue|festival|tickets?)\b/, 'events', 'ticket'],
  [/\b(car|auto|tires?|oil change|mechanic|dealership)\b/, 'auto', 'car'],
  [/\b(shop|store|boutique|clothing|sale)\b/, 'retail', 'bag'],
  [/\b(beer|wine|brewery|bar|spirits|liquor)\b/, 'alcohol', 'star'],
];
const COLORS: Record<string, string> = {
  red: '#D7262E', orange: '#F28C28', yellow: '#F2C14E', gold: '#C9A227', green: '#2F8F4E', teal: '#14857F', blue: '#1E7DB8', navy: '#1F2A44',
  purple: '#5B3A8C', pink: '#F7A6C9', brown: '#5B3A26', black: '#0B0B0B', white: '#FFFFFF', cream: '#FBF3E3', gray: '#6B7280', grey: '#6B7280',
};
const PALETTES: Record<string, { bg: string; fg: string; accent: string }> = {
  food: { bg: '#D7262E', fg: '#FFFFFF', accent: '#FFC93C' }, coffee: { bg: '#3A1D10', fg: '#FBE9D0', accent: '#F6E3C8' },
  'real-estate': { bg: '#2F6B4F', fg: '#FFFFFF', accent: '#E8F1EA' }, fitness: { bg: '#17171C', fg: '#FFFFFF', accent: '#FF6A13' },
  news: { bg: '#F1EEE6', fg: '#1B1B1B', accent: '#1B1B1B' }, health: { bg: '#E8F4FB', fg: '#0E3B5C', accent: '#1E7DB8' },
  pets: { bg: '#2B1A3F', fg: '#FFFFFF', accent: '#F7A6C9' }, events: { bg: '#1F2A44', fg: '#FFFFFF', accent: '#F2C14E' },
  auto: { bg: '#0B0B0B', fg: '#FFFFFF', accent: '#F2C14E' }, retail: { bg: '#FBF3E3', fg: '#1B1B1B', accent: '#D7262E' },
};
// eslint-disable-next-line security/detect-unsafe-regex -- every repeat is bounded ({2,30}); chat text is capped at 2,000 characters
const OFFER = /\b(free [a-z0-9' ]{2,30}|buy one,? get one(?: free)?|bogo|\d{1,2}% off(?: [a-z ]{2,24})?|\$\d+(?:\.\d\d)? off(?: [a-z ]{2,24})?|(?:two|2|three|3) [a-z]+ for \$\d+|\$\d+(?:\.\d\d)? [a-z][a-z ]{2,20}|first [a-z]+ (?:is )?free|half off(?: [a-z ]{2,24})?)/i;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const trimEnd = (s: string) => s.replace(/\s+(on|at|for|in|with|and|every|this|to)$/i, '').replace(/[.,!;:]+$/, '').trim();

export class BuiltinAdAssistant implements AdAssistant {
  readonly name = 'built-in helper';

  async respond(input: AdAssistantInput): Promise<AdAssistantOutput> {
    const { draft, context: ctx } = input;
    const text = input.message.trim();
    const low = text.toLowerCase();
    const patch: DraftPatch = {};
    const did: string[] = [];

    // What kind of business, and a starting look.
    const cat = CATEGORIES.find(([re]) => re.test(low) || re.test(ctx.business.name.toLowerCase()));
    const category = draft.category ?? cat?.[1] ?? ctx.business.category;
    if (!draft.category && category) patch.category = category;
    const poster: NonNullable<DraftPatch['poster']> = {};
    if (!draft.poster?.brand) poster.brand = ctx.business.name;
    if (!draft.poster?.icon && cat) poster.icon = cat[2] as any;
    if (!draft.poster?.colors) poster.colors = PALETTES[category] ?? { bg: '#000000', fg: '#FFFFFF', accent: '#7FC6EA' };

    // Words: a quoted headline wins, then anything that looks like an offer.
    const quoted = /["“]([^"”]{3,60})["”]/.exec(text)?.[1];
    const headlineCmd = /\b(?:headline|big words|say|title)\b\s*(?:to|:|should be|=)?\s*["“]?([^"”\n]{3,60})/i.exec(text)?.[1];
    const offer = OFFER.exec(text)?.[0];
    const headline = quoted ?? (headlineCmd ? trimEnd(headlineCmd) : offer ? cap(trimEnd(offer)) : undefined);
    if (headline) { poster.headline = headline; did.push(`the headline “${headline}”`); }
    const subCmd = /\b(?:small (?:line|words)|subline|underneath)\b\s*(?:to|:|should be)?\s*["“]?([^"”\n]{3,80})/i.exec(text)?.[1];
    const when = /\b((?:every|on|this) (?:mon|tue|wed|thu|fri|sat|sun)[a-z]*(?: night| morning)?|(?:before|after|until) \d{1,2}(?::\d\d)? ?(?:am|pm)|weekdays|weekends|all week)\b/i.exec(text)?.[0];
    if (subCmd) poster.sub = trimEnd(subCmd);
    else if (when && !draft.poster?.sub) poster.sub = cap(when);

    // Colors: "make it blue", "red and white".
    const named = [...low.matchAll(/\b(red|orange|yellow|gold|green|teal|blue|navy|purple|pink|brown|black|white|cream|gr[ae]y)\b/g)].map((m) => COLORS[m[1]!]!);
    const hex = [...text.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]);
    const colors = [...hex, ...named];
    const inHeadline = (headline ?? '').toLowerCase();
    if (colors.length && !named.length ? true : colors.length && ![...low.matchAll(/\b(red|orange|yellow|gold|green|teal|blue|navy|purple|pink|brown|black|white|cream|gr[ae]y)\b/g)].every((m) => inHeadline.includes(m[1]!))) {
      poster.colors = { bg: colors[0], ...(colors[1] ? { accent: colors[1] } : {}) };
      did.push('your colors');
    }
    if (/\b(serif|classic|elegant)\b/.test(low)) poster.font = 'classic';
    else if (/\b(bold|loud|strong)\b/.test(low)) poster.font = 'bold';
    else if (/\b(clean|simple|modern)\b/.test(low)) poster.font = 'clean';
    if (Object.keys(poster).length) patch.poster = poster;

    // A picture they attached.
    if (input.attachments.length) {
      patch.useImage = { attachment: 0, role: /\blogo\b/.test(low) || /logo/i.test(input.attachments[0]!.name ?? '') ? 'logo' : 'photo' };
      did.push(patch.useImage.role === 'logo' ? 'your logo' : 'your photo');
    }
    if (/\b(no|remove|without) (the )?(photo|picture|image|logo)\b/.test(low)) patch.removeImage = true;

    // Sizes. Named ones first ("a quarter and a sixth", "1/4", "sizes 4 and 6"), then the rough words.
    const sizeNames = new Set<number>();
    for (const [re, s] of [[/\bquarters?\b/, 4], [/\bthirds?\b/, 3], [/\bsixths?\b/, 6], [/\beighths?\b/, 8], [/\btenths?\b/, 10]] as const) if (re.test(low)) sizeNames.add(s);
    for (const m of low.matchAll(/\b1\s*\/\s*(2|3|4|6|8|10)\b/g)) sizeNames.add(Number(m[1]));
    // "sizes 4 and 6": the numbers right after the word, up to the first thing that isn't one.
    const at = low.search(/\bsizes?\s+\d/);
    if (at >= 0) for (const w of low.slice(at).split(/[\s,&]+/).slice(1)) { if (w === 'and' || w === 'or') continue; if (!/^(1|2|3|4|6|8|10)$/.test(w)) break; sizeNames.add(Number(w)); }
    if (sizeNames.size) { if (/\bhalf\b/.test(low)) sizeNames.add(2); if (/\b(full wrap|whole (label|bottle)|full label)\b/.test(low)) sizeNames.add(1); }
    // Sizes named outright go to the platform as asked (one that can't print here is refused there, in plain words);
    // rough words pick only from the sizes that print where this ad goes.
    const printable = (want: number[]) => { const ok = want.filter((x) => ctx.sizes.includes(x)); return (ok.length ? ok : ctx.sizes.length ? [want[0]! >= 6 ? Math.max(...ctx.sizes) : Math.min(...ctx.sizes)] : want) as Share[]; };
    if (sizeNames.size) patch.sizes = [...sizeNames].sort((a, b) => a - b) as Share[];
    else if (/\b(full wrap|whole (label|bottle)|full label)\b/.test(low)) patch.sizes = [1];
    else if (/\bhalf\b/.test(low)) patch.sizes = [2];
    else if (/\b(small|smallest|cheap(est)?)\b/.test(low)) patch.sizes = printable([6, 8, 10]);
    else if (/\b(big|large|biggest)\b/.test(low)) patch.sizes = printable([2, 3]);
    else if (!draft.sizes) patch.sizes = printable([4, 6, 8]);
    // Boxes only where ads on boxes are on (FreeWater's boxes are plain: never offered there).
    if (ctx.boxes !== false && /\b(box|boxes|delivery|packs?)\b/.test(low)) patch.formats = ['label', 'box-face'];
    else if (!draft.formats) patch.formats = ['label'];

    // Where.
    const ids = ctx.machines.filter((m) => low.includes(m.id.toLowerCase()) || low.includes(m.name.toLowerCase())).map((m) => m.id);
    // Something that looks like a machine number we don't have: pass it on, so the person hears it doesn't exist.
    for (const m of text.matchAll(/\b[A-Z]{2,4}-\d{2,4}\b/g)) if (!ids.includes(m[0]) && !ctx.machines.some((x) => x.id === m[0])) ids.push(m[0]);
    if (ids.length) { patch.locations = ids; did.push(`${ids.join(', ')}`); }
    else if (/\b(everywhere|all (machines|of them|locations)|anywhere|whole city)\b/.test(low)) { patch.locations = 'all'; did.push('every machine'); }

    // Budget: "$20 a day" or "5,000 bottles".
    const perDay = /\$\s?(\d[\d,]*)(?:\.\d\d)?\s*(?:a|per|\/)\s*day/i.exec(text);
    const bottles = /(\d[\d,]{2,})\s*(bottles|prints|labels)/i.exec(text);
    const pre = ctx.prices.prepaid;
    if (bottles) { patch.buy = { type: 'guaranteed', prints: Number(bottles[1]!.replace(/,/g, '')) }; did.push(pre ? `${bottles[1]} bottles, paid up front (${pre.included})` : `${bottles[1]} bottles`); }
    else if (perDay && !pre) { patch.buy = { type: 'bid', dailyCapCents: Number(perDay[1]!.replace(/,/g, '')) * 100 }; did.push(`a daily cap of $${perDay[1]} for printed labels only (scans and other charges are billed on top)`); }
    else if (perDay && pre) did.push('nothing for a daily amount: ads here are paid up front for a number of bottles');
    // Houses, streets, a neighbourhood: that's a buy on the delivery routes, chosen on the review page.
    if (pre?.routes && /\b(house|houses|home|homes|street|streets|neighbou?rhood|route|routes|door|doorstep|block)\b/.test(low)) did.push(`a note: to aim it at houses or streets, choose “On our delivery routes” on the review page (${pre.routes.kinds.join('; ')}), where you see the exact price before paying`);

    // What opens when people scan it.
    const url = /https:\/\/[^\s"'<>]+/.exec(text)?.[0];
    const code = /\b(?:code|promo)\s*[:=]?\s*([A-Z0-9]{3,20})\b/.exec(text)?.[1];
    const exp = this.experience(low, category, draft, { headline: headline ?? draft.poster?.headline ?? poster.headline, url, code, sub: poster.sub ?? draft.poster?.sub, slots: [...text.matchAll(/\b((?:mon|tue|wed|thu|fri|sat|sun)[a-z]* \d{1,2}(?::\d\d)? ?(?:am|pm))\b/gi)].map((m) => m[1]!) });
    if (exp) { patch.experienceId = exp.id; patch.experienceConfig = exp.config; did.push(exp.said); }

    // What's still missing after this change.
    const after = new Set<Missing>(ctx.missing);
    if (patch.poster?.headline || draft.poster?.headline) after.delete('artwork');
    if (patch.category) after.delete('category');
    if (patch.sizes) after.delete('sizes');
    if (patch.locations) after.delete('where');
    if (patch.buy) after.delete('budget');
    if (exp?.complete) after.delete('scanPage');
    if (!headline && !draft.poster?.headline) after.add('artwork');

    const reply = this.reply(did, [...after], ctx.business.name, !draft.poster, !!pre, category, ctx.sizes);
    return { reply, patch, suggestions: this.suggestions([...after], category, !!pre, ctx.boxes !== false) };
  }

  private experience(low: string, category: string, draft: AdAssistantInput['draft'], f: { headline?: string; url?: string; code?: string; sub?: string; slots: string[] }) {
    const link = f.url ?? (draft.experienceConfig as any)?.orderUrl ?? (draft.experienceConfig as any)?.bookUrl;
    if (/\b(3d|ar|on (the|your) table|menu)\b/.test(low) && category === 'food') {
      if (!link) return { id: 'ar-3d-menu', config: undefined, said: 'a 3D menu people can put on their table (send me your ordering link)', complete: false };
      return { id: 'ar-3d-menu', config: { title: f.headline ?? 'Our menu', model: { builtin: /fries/.test(low) ? 'fries' : /coffee|latte/.test(low) ? 'latte' : 'burger' }, orderUrl: link, ...(f.sub ? { subtitle: f.sub } : {}) }, said: 'a 3D menu people can put on their table', complete: true };
    }
    if (/\b(tour|listing|open house)\b/.test(low) || (category === 'real-estate' && !draft.experienceId)) {
      if (!link) return { id: 'ar-home-tour', config: undefined, said: 'a 3D home tour (send me the link for booking a showing)', complete: false };
      return { id: 'ar-home-tour', config: { address: f.headline ?? 'Open house', rooms: [{ name: 'Living room' }, { name: 'Kitchen' }, { name: 'Bedroom' }], model: { builtin: 'house' }, bookUrl: link, ...(f.slots.length ? { slots: f.slots } : {}) }, said: 'a 3D home tour', complete: true };
    }
    if (/\b(book|booking|appointment|class(es)?|reserve|schedule)\b/.test(low)) {
      if (!link) return { id: 'booking', config: undefined, said: 'a booking page (send me your booking link)', complete: false };
      return { id: 'booking', config: { title: f.headline ?? 'Book a time', slots: f.slots.length ? f.slots : ['Mon 9:00 am', 'Wed 12:00 pm', 'Fri 5:00 pm'], bookUrl: link }, said: 'a booking page', complete: true };
    }
    if (f.code) return { id: 'coupon', config: { headline: f.headline ?? 'A deal for you', code: f.code }, said: `a coupon with code ${f.code}`, complete: true };
    if (!draft.experienceId && f.headline) return { id: 'offer', config: { headline: f.headline, ...(f.sub ? { details: f.sub } : {}), ...(link ? { link: { label: 'Learn more', url: link } } : {}) }, said: 'an offer people can save', complete: true };
    if (link && draft.experienceId) {
      const c = { ...(draft.experienceConfig ?? {}) } as any;
      if (draft.experienceId === 'ar-3d-menu') c.orderUrl = link; else if (draft.experienceId === 'booking' || draft.experienceId === 'ar-home-tour') c.bookUrl = link; else c.link = { label: 'Learn more', url: link };
      return { id: draft.experienceId, config: c, said: 'your link', complete: true };
    }
    return null;
  }

  private reply(did: string[], left: Missing[], business: string, first: boolean, prepaid = false, category = '', sizes: number[] = []): string {
    const start = did.length ? `${first ? `Here's a first version for ${business}` : 'Done'}: I set ${did.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : first ? `Let's make an ad for ${business}.` : 'Got it.';
    if (!left.length) return `${start} Everything's ready. Look over the preview, then tap “Review and submit”${prepaid ? ': you’ll see the exact total before you pay' : ''}.`;
    const next = left[0]!;
    const q: Record<Missing, string> = {
      artwork: `What should the ad say? A short offer works best, like “${offerFor(category)}”.`,
      category: 'What kind of business is it?',
      sizes: `How big should it be? Small (as little as ${shareName[(sizes.length ? Math.max(...sizes) : 10) as Share]} of the label), a quarter, half, or the whole label? Every piece is about square.`,
      where: 'Where should it run? Name a machine, or say “everywhere”.',
      budget: prepaid ? 'How many bottles should carry it? You pay for them up front and exactly that many go out, like “2,000 bottles” (at least 100).' : 'What’s your budget? Say a daily amount like “$20 a day”, or a number of bottles like “2,000 bottles”.',
      scanPage: 'What should open when people scan it? An offer to save, a coupon code, a booking page, or a 3D menu. A link to your website helps.',
    };
    return `${start} ${q[next]}`;
  }

  private suggestions(left: Missing[], category: string, prepaid = false, boxes = true): string[] {
    const next = left[0];
    if (next === 'budget') return prepaid ? ['500 bottles', '2,000 bottles', '10,000 bottles'] : ['$20 a day', '$50 a day', '2,000 bottles'];
    if (next === 'where') return ['Everywhere', 'Only ATX-014'];
    if (next === 'sizes') return ['Small', 'Half the label', 'Full wrap'];
    if (next === 'scanPage') return category === 'food' ? ['A 3D menu in AR', 'A coupon: code SAVE5'] : ['An offer to save', 'A coupon: code SAVE5', 'A booking page'];
    if (next === 'artwork') return [`“${offerFor(category)}”`, '“20% off your first visit”'];
    return ['Make it blue', 'Use a bolder font', boxes ? 'Also print on delivery boxes' : 'Make the headline shorter'];
  }
}
export { missingLabels };

/**
 * An offer that fits the advertiser's own kind of business, or one that fits any (never another kind of business: a
 * bakery is never shown "We're a taco truck").
 */
const OFFERS: Record<string, string> = {
  'food-drink': 'Buy one, get one free on Fridays', food: 'Buy one, get one free on Fridays', coffee: 'Your first coffee is free',
  'real-estate': 'Open house this Saturday', fitness: 'Your first class is free', health: 'New patients: your first visit is free',
  retail: '20% off everything this weekend', pets: 'New customers: 15% off', events: 'Two tickets for the price of one',
  auto: 'A free check-up with any service', news: 'Your first month free', services: 'A free quote this week',
};
export const offerFor = (category?: string) => OFFERS[category ?? ''] ?? '20% off your first visit';

/**
 * What the chat suggests before anything is said: from the advertiser's own business and kind of business, or plain
 * changes when it's an ad being changed.
 */
export function starterSuggestions(business: { name: string; category?: string }, changing: boolean): string[] {
  if (changing) return ['Make the headline shorter', 'Change the colors', 'Use a bolder font'];
  const offer = offerFor(business.category);
  return [`We’re ${business.name}. ${offer}.`, offer === '20% off your first visit' ? 'Free gift with your first order' : '20% off your first visit'];
}
