// Sample data for the demo and tests. All advertisers here are made-up brands; prices are placeholders.
import type { BoxProduct, Campaign, CompanyConfig, Creative, Location, Product, Sixths } from '../core/types';

export const bottle16oz: Product = {
  id: 'bottle-16oz',
  name: '16 oz aluminum bottle',
  label: { widthIn: 8.6, heightIn: 4.5, seamIn: 0.25, panelWidthIn: 0.95 },
  layouts: [[6], [3, 3], [2, 2, 2], [4, 2], [2, 1, 1, 2], [3, 2, 1], [1, 1, 1, 1, 1, 1], [2, 2, 1, 1]],
};

const sides = { adFaces: ['top', 'front', 'back', 'right'] as BoxProduct['adFaces'], panelFace: 'left' as const, blankFaces: ['bottom'] as BoxProduct['blankFaces'] };
export const boxes: BoxProduct[] = [
  { id: 'box-6', bottles: 6, lengthIn: 8, widthIn: 5.4, heightIn: 7.8, ...sides },
  { id: 'box-12', bottles: 12, lengthIn: 10.6, widthIn: 8, heightIn: 7.8, ...sides },
  { id: 'box-24', bottles: 24, lengthIn: 15.8, widthIn: 10.6, heightIn: 7.8, ...sides },
];

const placeholderPrices: CompanyConfig['prices'] = {
  // Sample numbers so the demo can add things up. Each company sets its own.
  perPrintBySixths: { 1: 3, 2: 5, 3: 7, 4: 9, 5: 11, 6: 12 },
  perScan: 25,
  perArLaunch: 40,
  commissionPercent: 8,
  customUnit: 300,
  perBoxFace: 40,
};

export const freewater: CompanyConfig = {
  id: 'freewater',
  name: 'FreeWater',
  receiptBaseUrl: 'https://go.freewater.io',
  brand: { logoTop: 'free', logoBottom: 'water', tagline: "Put your brand in everyone's hand!", panelColor: '#000000', accentColor: '#7FC6EA', textColor: '#FFFFFF', fontFamily: "Comfortaa, 'DM Sans', Arial, sans-serif" },
  productFacts: ['SPRING WATER', '16 fl oz (473 ml)', 'Source: Natural Spring Water, Tiger, GA', 'Manufactured by RAIN Bottling Co for FreeWater Inc, Austin, TX', 'Processed by ozonation'],
  giving: { mode: 'per_unit', centsPerUnit: 10, defaultCharity: 'Austin Parks Foundation', charityByLocation: { 'route-3': 'Central Texas Food Bank', 'route-5': 'Central Texas Food Bank' }, minimumTransferCents: 2500 },
  consumerPricing: 'free',
  timezone: 'America/Chicago',
  consumer: { freeBottlesPerDay: 3, retailValueCents: 100 },
  machines: { offlineWalkUp: true, offlinePerHour: 20, bufferSize: 12 },
  openBooks: true,
  unitCosts: { water: 4, bottle: 18, label: 3, machine: 6 }, // placeholders until real costs are known
  adRules: { minAdsPerUnit: 1, maxAdsPerUnit: 6, blockedCategories: ['alcohol', 'tobacco', 'gambling', 'weapons'], competitorSeparation: true, repeatScanWindowSec: 600, maxPackShare: 0.5 },
  prices: placeholderPrices,
  modules: { ads: 'freewater-ads', renderer: 'svg-label', printer: 'virtual-printer' },
};

/** A made-up white-label licensee that gives nothing and allows every category. Shows that every rule is a setting. */
export const peakSpring: CompanyConfig = {
  ...freewater,
  id: 'peak-spring',
  name: 'Peak Spring Water Co.',
  receiptBaseUrl: 'https://water.peakspring.example',
  brand: { logoTop: 'peak', logoBottom: 'spring', panelColor: '#123B2A', accentColor: '#F2C14E', textColor: '#FFFFFF', fontFamily: "'DM Sans', Arial, sans-serif" },
  productFacts: ['MOUNTAIN SPRING WATER', '16 fl oz (473 ml)', 'Bottled for Peak Spring Water Co.'],
  giving: { mode: 'none' },
  consumerPricing: 'discounted',
  adRules: { ...freewater.adRules, blockedCategories: [] },
  modules: { ads: 'house-only', renderer: 'svg-label', printer: 'virtual-printer' },
};

export const locations: Location[] = [
  { id: 'ATX-014', kind: 'machine', companyId: 'freewater', city: 'Austin', name: 'Congress Ave', address: '600 Congress Ave, Austin, TX', lat: 30.2687, lng: -97.7428, printSeconds: 24 },
  { id: 'ATX-022', kind: 'machine', companyId: 'freewater', city: 'Austin', name: 'Rainey St', address: '70 Rainey St, Austin, TX', lat: 30.2589, lng: -97.7387, printSeconds: 24 },
  { id: 'route-3', kind: 'route', companyId: 'freewater', city: 'Austin', name: 'Travis Heights', area: { lat: 30.2468, lng: -97.7445, radiusKm: 2.2 }, depot: { lat: 30.2597, lng: -97.7146, name: 'East Austin micro-factory' }, deliveryDays: [2, 5] },
  { id: 'route-5', kind: 'route', companyId: 'freewater', city: 'Austin', name: 'Mueller', area: { lat: 30.2985, lng: -97.7040, radiusKm: 2 }, depot: { lat: 30.2597, lng: -97.7146, name: 'East Austin micro-factory' }, deliveryDays: [2, 5] },
  { id: 'PS-001', kind: 'machine', companyId: 'peak-spring', city: 'Denver', name: 'Union Station', address: '1701 Wynkoop St, Denver, CO', lat: 39.7527, lng: -105.0002, printSeconds: 30 },
];

// ---------- artwork ----------
// Each creative draws itself at any slot size, the way an AI-sized ad set would.

type Look = { bg: string; fg: string; accent: string; brand: string; brandSize?: number; line: string; sub: string; mark: (w: number, h: number) => string };

function art(look: Look): Creative {
  return {
    svg(w, h) {
      const narrow = w < 160;
      const wide = w > h * 0.95; // box faces: text on the left, picture on the right
      const textW = wide ? w * 0.52 : w;
      const pad = narrow ? 10 : 18;
      const brandSize = Math.min(look.brandSize ?? 34, textW / (look.brand.length * 0.62));
      const lineSize = Math.min(narrow ? 17 : 30, (textW - pad * 2) / Math.max(6, longestWord(look.line) * 0.58));
      const lines = wrapWords(look.line, narrow ? 9 : Math.max(10, Math.floor((textW - pad) / (lineSize * 0.56))));
      let s = `<rect width="${w}" height="${h}" fill="${look.bg}"/>`;
      s += wide ? `<g transform="translate(${(w * 0.24).toFixed(1)} 0)">${look.mark(w, h)}</g>` : look.mark(w, h);
      s += `<text x="${pad}" y="${pad + brandSize}" font-family="Comfortaa, 'DM Sans', Arial, sans-serif" font-weight="700" font-size="${brandSize.toFixed(1)}" fill="${look.accent}">${look.brand}</text>`;
      let y = wide ? Math.max(pad + brandSize + lineSize * 1.6, h * 0.5) : h * 0.6;
      for (const l of lines) {
        s += `<text x="${pad}" y="${y.toFixed(1)}" font-family="'DM Sans', Arial, sans-serif" font-weight="700" font-size="${lineSize.toFixed(1)}" fill="${look.fg}">${l}</text>`;
        y += lineSize * 1.12;
      }
      if (!narrow) s += `<text x="${pad}" y="${(y + 4).toFixed(1)}" font-family="'DM Sans', Arial, sans-serif" font-size="12" fill="${look.fg}" opacity=".85">${look.sub}</text>`;
      return s;
    },
  };
}
const longestWord = (s: string) => Math.max(...s.split(' ').map((w) => w.length));
function wrapWords(s: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of s.split(' ')) {
    if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out;
}

const burger = (w: number, h: number) => {
  const cx = w / 2, cy = h * 0.36, r = Math.min(w * 0.36, 70);
  return `<path d="M${cx - r} ${cy} A${r} ${r * 0.75} 0 0 1 ${cx + r} ${cy} Z" fill="#F2A33A"/><rect x="${cx - r}" y="${cy + 2}" width="${2 * r}" height="${r * 0.14}" rx="4" fill="#7DBA4A"/><rect x="${cx - r * 0.95}" y="${cy + r * 0.16}" width="${1.9 * r}" height="${r * 0.28}" rx="8" fill="#5B2A12"/><rect x="${cx - r}" y="${cy + r * 0.46}" width="${2 * r}" height="${r * 0.3}" rx="${r * 0.15}" fill="#E58E2C"/>`;
};
const cup = (w: number, h: number) => {
  const cx = w / 2, cy = h * 0.38, r = Math.min(w * 0.3, 58);
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#F4EDE3"/><circle cx="${cx}" cy="${cy}" r="${r * 0.78}" fill="#B9814F"/><path d="M${cx} ${cy + r * 0.4} C${cx - r * 0.5} ${cy} ${cx - r * 0.3} ${cy - r * 0.4} ${cx} ${cy - r * 0.15} C${cx + r * 0.3} ${cy - r * 0.4} ${cx + r * 0.5} ${cy} ${cx} ${cy + r * 0.4}Z" fill="#F7E9D5"/>`;
};
const house = (w: number, h: number) => {
  const cx = w / 2, cy = h * 0.36, r = Math.min(w * 0.3, 60);
  return `<path d="M${cx - r} ${cy} L${cx} ${cy - r * 0.8} L${cx + r} ${cy} V${cy + r * 0.8} H${cx - r} Z" fill="#E8F1EA"/><rect x="${cx - r * 0.2}" y="${cy + r * 0.25}" width="${r * 0.4}" height="${r * 0.55}" fill="#2F6B4F"/>`;
};
const paper = (w: number, h: number) => `<rect x="${w * 0.1}" y="${h * 0.2}" width="${w * 0.8}" height="${h * 0.25}" fill="#1B1B1B" opacity=".08"/><rect x="${w * 0.1}" y="${h * 0.2}" width="${w * 0.45}" height="${h * 0.25}" fill="#1B1B1B" opacity=".14"/>`;
const bolt = (w: number, h: number) => `<path d="M${w * 0.55} ${h * 0.1} L${w * 0.3} ${h * 0.45} H${w * 0.5} L${w * 0.42} ${h * 0.62} L${w * 0.72} ${h * 0.27} H${w * 0.52} Z" fill="#FF6A13" opacity=".9"/>`;
const drop = (w: number, h: number) => `<path d="M${w / 2} ${h * 0.12} C${w * 0.3} ${h * 0.35} ${w * 0.28} ${h * 0.45} ${w * 0.5} ${h * 0.5} C${w * 0.72} ${h * 0.45} ${w * 0.7} ${h * 0.35} ${w / 2} ${h * 0.12} Z" fill="#7FC6EA"/>`;
const peak = (w: number, h: number) => `<path d="M0 ${h * 0.55} L${w * 0.35} ${h * 0.15} L${w * 0.55} ${h * 0.38} L${w * 0.7} ${h * 0.25} L${w} ${h * 0.55} Z" fill="#F2C14E" opacity=".9"/>`;

const all: Sixths[] = [1, 2, 3, 4, 6];
type CampaignInput = Omit<Campaign, 'companyId' | 'active' | 'targeting'> & Partial<Pick<Campaign, 'targeting'>>;
const fw = (c: CampaignInput): Campaign => ({ companyId: 'freewater', active: true, targeting: {}, ...c, creativeRef: { kind: 'builtin', id: c.id } });

export function sampleCampaigns(): Campaign[] {
  return [
    fw({ id: 'cmp-house', formats: ['label', 'box-face'], advertiserId: 'freewater', advertiserName: 'FreeWater', category: 'house', sizes: all, isHouse: true, experienceId: 'house-promo', experienceConfig: { headline: 'Save money. Drink FreeWater.', text: 'Free spring water, paid for by the ads on the bottle. 10¢ of every bottle goes to charity.', appUrl: 'https://freewater.io/app', advertiseUrl: 'https://freewater.io/advertise' }, theme: { background: '#EEF6FB', button: '#000000', accent: '#1E7DB8' }, buy: { type: 'guaranteed', remainingPrints: 1e9 },
      creative: art({ bg: '#000000', fg: '#FFFFFF', accent: '#7FC6EA', brand: 'freewater', line: 'Save money. Drink FreeWater.', sub: 'Your ad here: freewater.io', mark: drop }) }),
    fw({ id: 'cmp-joes', formats: ['label', 'box-face'], advertiserId: 'adv-joes', advertiserName: "Joe's Burgers", category: 'food', competitorGroup: 'burgers', sizes: [1, 2, 3], experienceId: 'ar-3d-menu', experienceConfig: { title: '$5 combo', subtitle: 'Burger, fries and a drink. Ready for pickup in 10 minutes.', model: { builtin: 'burger', alt: "Joe's cheeseburger" }, addOns: [{ id: 'fries', label: '+ Fries', model: { builtin: 'fries', alt: 'Fries' } }, { id: 'drink', label: '+ Drink', model: { builtin: 'drink', alt: 'Soft drink' } }], firstTimeOffer: 'First order? Fries are on us.', regularOffer: 'Welcome back. Your usual is 10 minutes away.', orderUrl: 'https://example.com/joes/order' }, theme: { background: '#FFF7E6', text: '#2B1A10', accent: '#D7262E', button: '#D7262E', buttonText: '#FFFFFF' }, buy: { type: 'guaranteed', remainingPrints: 20000 },
      creative: art({ bg: '#D7262E', fg: '#FFFFFF', accent: '#FFC93C', brand: "JOE'S", line: '$5 combo', sub: 'Scan to see it on your table', mark: burger }) }),
    fw({ id: 'cmp-patty', advertiserId: 'adv-patty', advertiserName: 'Patty Shack', category: 'food', competitorGroup: 'burgers', sizes: [1, 2], experienceId: 'coupon', experienceConfig: { headline: 'Double stack Tuesdays', code: 'BOTTLE2X', details: 'Show this code at the register. Tuesdays only.' }, theme: { background: '#FFF3D6', text: '#3B2410', accent: '#C2410C', button: '#C2410C' }, buy: { type: 'bid', maxCentsPerSixth: 4, dailyCapCents: 5000, spentTodayCents: 0 },
      creative: art({ bg: '#FFF3D6', fg: '#3B2410', accent: '#C2410C', brand: 'Patty Shack', brandSize: 26, line: 'Double stack Tuesdays', sub: 'Scan for a coupon', mark: burger }) }),
    fw({ id: 'cmp-luma', formats: ['label', 'box-face'], advertiserId: 'adv-luma', advertiserName: 'Luma Coffee', category: 'coffee', sizes: [1, 2, 3], experienceId: 'offer', experienceConfig: { headline: 'Oat latte, on us', firstTimeHeadline: 'Your first oat latte is free', details: 'Show this at the counter before 11 am. Luma Coffee, 600 Congress Ave.', expires: 'Ends Sunday', link: { label: 'Find Luma', url: 'https://example.com/luma' } }, theme: { background: '#FBF3E8', text: '#3A1D10', accent: '#8A5A3B', button: '#3A1D10', buttonText: '#FBE9D0' }, buy: { type: 'bid', maxCentsPerSixth: 3, dailyCapCents: 4000, spentTodayCents: 0 },
      creative: art({ bg: '#3A1D10', fg: '#FBE9D0', accent: '#F6E3C8', brand: 'luma', line: 'Oat latte, on us', sub: 'Before 11 am on Congress Ave', mark: cup }) }),
    fw({ id: 'cmp-maple', formats: ['label', 'box-face'], advertiserId: 'adv-maple', advertiserName: 'Maple Realty', category: 'real-estate', sizes: [2, 3, 4], experienceId: 'ar-home-tour', experienceConfig: { address: '1406 Maple St', price: '$685,000', details: '3 bed, 2 bath, big back yard', model: { builtin: 'house', alt: '3D model of 1406 Maple St' }, rooms: [{ name: 'Living room', color: '#D9CBB4', note: 'South light all afternoon' }, { name: 'Kitchen', color: '#E8DCC8', note: 'New in 2024' }, { name: 'Main bedroom', color: '#C9D8C5' }, { name: 'Back yard', color: '#9DBF8F', note: 'Room for a pool' }], slots: ['Sat 10:00', 'Sat 11:30', 'Sun 1:00'], bookUrl: 'https://example.com/maple/book' }, theme: { background: '#F1F6F2', text: '#16352A', accent: '#2F6B4F', button: '#2F6B4F' }, buy: { type: 'guaranteed', remainingPrints: 5000 }, targeting: { locations: ['ATX-014', 'route-3'] },
      creative: art({ bg: '#2F6B4F', fg: '#E8F1EA', accent: '#E8F1EA', brand: 'Maple Realty', brandSize: 26, line: '1406 Maple St. Tour it in 3D', sub: 'Scan the bottle to walk through', mark: house }) }),
    fw({ id: 'cmp-daily', formats: ['label', 'box-face'], advertiserId: 'adv-daily', advertiserName: 'Austin Daily', category: 'news', sizes: [1, 2], experienceId: 'news-card', experienceConfig: { headline: 'Rail line opens Monday', byline: 'Austin Daily', paragraphs: ['The new line connects downtown to the airport in 22 minutes, with stops at the convention center and Riverside.', 'Trains run every 10 minutes at rush hour and every 20 minutes late at night. Rides are free for the first week.'], url: 'https://example.com/daily/rail' }, theme: { background: '#F7F5EF', text: '#1B1B1B', accent: '#1B1B1B', button: '#1B1B1B' }, buy: { type: 'bid', maxCentsPerSixth: 3, dailyCapCents: 3000, spentTodayCents: 0 },
      creative: art({ bg: '#F1EEE6', fg: '#1B1B1B', accent: '#1B1B1B', brand: 'Austin Daily', brandSize: 24, line: 'Rail line opens Monday', sub: 'Scan for the full story', mark: paper }) }),
    fw({ id: 'cmp-orbit', formats: ['label', 'box-face'], advertiserId: 'adv-orbit', advertiserName: 'Orbit Fitness', category: 'fitness', sizes: [1, 2, 3], experienceId: 'booking', experienceConfig: { title: 'Your first class is free', details: 'Strength, cycling or yoga. Bring water. We have the rest.', slots: ['Mon 6:00 am', 'Mon 6:00 pm', 'Tue 7:00 am', 'Wed 12:15 pm'], bookUrl: 'https://example.com/orbit/book' }, theme: { background: '#17171C', text: '#FFFFFF', accent: '#FF6A13', button: '#FF6A13' }, buy: { type: 'bid', maxCentsPerSixth: 3, dailyCapCents: 2500, spentTodayCents: 0 },
      creative: art({ bg: '#1E1E24', fg: '#FFFFFF', accent: '#FF6A13', brand: 'ORBIT', line: 'First class free', sub: 'Scan and book', mark: bolt }) }),
    // Blocked by FreeWater's rules (alcohol), allowed by a licensee that chooses to.
    fw({ id: 'cmp-lager', advertiserId: 'adv-lager', advertiserName: 'Lone Peak Lager', category: 'alcohol', sizes: [1, 2, 3], experienceId: 'offer', experienceConfig: { headline: 'Cold and local', details: 'Find Lone Peak at your local store. 21+ only.' }, buy: { type: 'bid', maxCentsPerSixth: 9, dailyCapCents: 9000, spentTodayCents: 0 },
      creative: art({ bg: '#0F3D5E', fg: '#FFFFFF', accent: '#F2C14E', brand: 'Lone Peak', line: 'Cold and local', sub: '21+', mark: peak }) }),
    { companyId: 'peak-spring', active: true, targeting: {}, creativeRef: { kind: 'builtin', id: 'cmp-peak-house' }, id: 'cmp-peak-house', advertiserId: 'peak-spring', advertiserName: 'Peak Spring', category: 'house', sizes: all, isHouse: true, experienceId: 'house-promo', experienceConfig: { headline: 'Cold mountain water', text: 'Peak Spring, bottled in the Rockies.' }, buy: { type: 'guaranteed', remainingPrints: 1e9 },
      creative: art({ bg: '#123B2A', fg: '#FFFFFF', accent: '#F2C14E', brand: 'peak spring', line: 'Cold mountain water', sub: 'From the Rockies', mark: peak }) },
  ];
}

export const mayaDesign: Creative = {
  svg(w, h) {
    const cx = w * 0.32;
    let s = `<rect width="${w}" height="${h}" fill="#F7C6D4"/>`;
    for (let i = 0; i < 26; i++) s += `<circle cx="${(i * 97) % w}" cy="${(i * 53) % h}" r="${3 + (i % 3)}" fill="#D9AE4A" opacity=".8"/>`;
    s += `<circle cx="${cx}" cy="${h * 0.42}" r="${h * 0.26}" fill="#E9A6BA"/><circle cx="${cx}" cy="${h * 0.36}" r="${h * 0.09}" fill="#C98A73"/><path d="M${cx - h * 0.17} ${h * 0.6} Q${cx} ${h * 0.42} ${cx + h * 0.17} ${h * 0.6} Z" fill="#C98A73"/>`;
    s += `<text x="${w * 0.58}" y="${h * 0.45}" font-family="Comfortaa, Arial, sans-serif" font-weight="700" font-size="64" fill="#B8862E">Maya</text>`;
    s += `<text x="${w * 0.58}" y="${h * 0.6}" font-family="Comfortaa, Arial, sans-serif" font-weight="300" font-size="34" fill="#B8862E">turns 30</text>`;
    return s;
  },
};

/** The demo's generated artwork, by campaign id, so stored campaigns can find their art again after a restart. */
export const builtinCreatives: Record<string, Creative> = Object.fromEntries(sampleCampaigns().map((c) => [c.id, c.creative]));
