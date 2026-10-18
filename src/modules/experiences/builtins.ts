import type { Block, ModelRef } from './blocks';
import type { ExperiencePlugin, PluginTools } from './contract';

// FreeWater's built-in experience plug-ins. Each takes settings an advertiser fills in and returns blocks.

type ModelSetting = { builtin: string; alt?: string } | { glbUrl: string; alt: string };
const modelSchema = { oneOf: [{ type: 'object', required: ['builtin'], additionalProperties: false, properties: { builtin: { type: 'string', enum: ['burger', 'fries', 'drink', 'house', 'latte'] }, alt: { type: 'string', maxLength: 200 } } }, { type: 'object', required: ['glbUrl', 'alt'], additionalProperties: false, properties: { glbUrl: { type: 'string', maxLength: 2000 }, alt: { type: 'string', maxLength: 200 } } }] };
const s = (max = 200) => ({ type: 'string', minLength: 1, maxLength: max });
const url = { type: 'string', pattern: '^https://', maxLength: 2000 };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });

function model(m: ModelSetting, tools: PluginTools, alt: string): ModelRef {
  return 'builtin' in m ? { glbUrl: tools.builtinModel(m.builtin), alt: m.alt ?? alt } : { glbUrl: m.glbUrl, alt: m.alt };
}

// ---------- offer ----------
interface OfferConfig { headline: string; details?: string; code?: string; expires?: string; firstTimeHeadline?: string; imageUrl?: string; link?: { label: string; url: string } }
export const offerPlugin: ExperiencePlugin<OfferConfig> = {
  id: 'offer', name: 'Offer', version: '1.0.0',
  description: 'A deal people can save. Optionally a different headline for first-time scanners.',
  configSchema: obj({ headline: s(120), details: s(500), code: s(40), expires: s(60), firstTimeHeadline: s(120), imageUrl: { type: 'string', maxLength: 2000 }, link: obj({ label: s(60), url }, ['label', 'url']) }, ['headline']),
  example: { headline: 'Oat latte, on us', details: 'Show this at the counter before 11 am.', firstTimeHeadline: 'Your first oat latte is free', link: { label: 'Find a café', url: 'https://example.com/cafes' } },
  resolve({ config, scan }) {
    const headline = scan.viewer.firstTimeWithAdvertiser && config.firstTimeHeadline ? config.firstTimeHeadline : config.headline;
    const blocks: Block[] = [{ type: 'hero', title: scan.owner.name, ...(config.imageUrl ? { imageUrl: config.imageUrl } : {}) }];
    blocks.push({ type: 'offer', headline, ...(config.details ? { details: config.details } : {}), ...(config.code ? { code: config.code } : {}), ...(config.expires ? { expires: config.expires } : {}) });
    blocks.push({ type: 'button', label: 'Save this offer', action: { kind: 'save' }, style: config.link ? 'secondary' : 'primary' });
    if (config.link) blocks.push({ type: 'button', label: config.link.label, action: { kind: 'link', url: config.link.url }, style: 'primary' });
    return blocks;
  },
};

// ---------- coupon ----------
interface CouponConfig { headline: string; code: string; details?: string }
export const couponPlugin: ExperiencePlugin<CouponConfig> = {
  id: 'coupon', name: 'Coupon code', version: '1.0.0',
  description: 'A code to use at the counter or online.',
  configSchema: obj({ headline: s(120), code: s(40), details: s(500) }, ['headline', 'code']),
  example: { headline: 'Double stack Tuesdays', code: 'BOTTLE2X', details: 'Show this code at the register.' },
  resolve: ({ config, scan }) => [
    { type: 'hero', title: scan.owner.name },
    { type: 'offer', headline: config.headline, code: config.code, ...(config.details ? { details: config.details } : {}) },
    { type: 'button', label: 'Save this coupon', action: { kind: 'save' } },
  ],
};

// ---------- 3D menu in AR ----------
interface MenuConfig { title: string; subtitle?: string; model: ModelSetting; addOns?: { id: string; label: string; model: ModelSetting }[]; firstTimeOffer?: string; regularOffer?: string; orderUrl: string; orderLabel?: string }
export const menuPlugin: ExperiencePlugin<MenuConfig> = {
  id: 'ar-3d-menu', name: '3D menu in AR', version: '1.0.0',
  description: 'Spin the food in 3D, see it on your table in AR, add sides, and order.',
  configSchema: obj({ title: s(120), subtitle: s(300), model: modelSchema, addOns: { type: 'array', maxItems: 8, items: obj({ id: s(40), label: s(40), model: modelSchema }, ['id', 'label', 'model']) }, firstTimeOffer: s(120), regularOffer: s(120), orderUrl: url, orderLabel: s(40) }, ['title', 'model', 'orderUrl']),
  example: { title: '$5 combo', subtitle: 'Burger, fries and a drink. Pickup in 10 minutes.', model: { builtin: 'burger' }, addOns: [{ id: 'fries', label: 'Fries', model: { builtin: 'fries' } }, { id: 'drink', label: 'Drink', model: { builtin: 'drink' } }], firstTimeOffer: 'Free fries on your first order', regularOffer: 'Your usual is ready in 10 minutes', orderUrl: 'https://example.com/order' },
  resolve({ config, scan, tools }) {
    const offer = scan.viewer.firstTimeWithAdvertiser ? config.firstTimeOffer : config.regularOffer ?? config.firstTimeOffer;
    const blocks: Block[] = [
      { type: 'hero', title: config.title, ...(config.subtitle ? { subtitle: config.subtitle } : {}) },
      { type: 'model', model: model(config.model, tools, config.title), arLabel: 'See it on your table', ...(config.addOns ? { addOns: config.addOns.map((a) => ({ id: a.id, label: a.label, model: model(a.model, tools, a.label) })) } : {}) },
    ];
    if (offer) blocks.push({ type: 'offer', headline: offer });
    blocks.push({ type: 'button', label: config.orderLabel ?? 'Order for pickup', action: { kind: 'link', url: config.orderUrl }, style: 'primary' });
    blocks.push({ type: 'button', label: 'Save for later', action: { kind: 'save' }, style: 'secondary' });
    return blocks;
  },
};

// ---------- home tour ----------
interface TourConfig { address: string; price?: string; details?: string; rooms: { name: string; color?: string; imageUrl?: string; note?: string }[]; model?: ModelSetting; slots?: string[]; bookUrl: string }
export const tourPlugin: ExperiencePlugin<TourConfig> = {
  id: 'ar-home-tour', name: 'Home tour', version: '1.0.0',
  description: 'Walk through a home room by room, see a 3D model, and book a showing.',
  configSchema: obj({ address: s(120), price: s(40), details: s(500), rooms: { type: 'array', minItems: 1, maxItems: 20, items: obj({ name: s(60), color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, imageUrl: { type: 'string', maxLength: 2000 }, note: s(200) }, ['name']) }, model: modelSchema, slots: { type: 'array', maxItems: 12, items: s(40) }, bookUrl: url }, ['address', 'rooms', 'bookUrl']),
  example: { address: '1406 Maple St', price: '$685,000', details: '3 bed, 2 bath, big back yard.', rooms: [{ name: 'Living room', color: '#C9D8C5', note: 'South light all afternoon' }, { name: 'Kitchen', color: '#E8DCC8' }, { name: 'Back yard', color: '#9DBF8F' }], model: { builtin: 'house' }, slots: ['Sat 10:00', 'Sat 11:30', 'Sun 1:00'], bookUrl: 'https://example.com/book' },
  resolve: ({ config, tools }) => [
    { type: 'hero', title: config.address, ...(config.price || config.details ? { subtitle: [config.price, config.details].filter(Boolean).join('. ') } : {}) },
    { type: 'tour', title: 'Take the tour', rooms: config.rooms, ...(config.model ? { model: model(config.model, tools, config.address) } : {}) },
    ...(config.slots?.length ? [{ type: 'booking' as const, title: 'Book a showing', slots: config.slots, action: { kind: 'link' as const, url: config.bookUrl } }] : [{ type: 'button' as const, label: 'Book a showing', action: { kind: 'link' as const, url: config.bookUrl } }]),
    { type: 'button', label: 'Save this home', action: { kind: 'save' }, style: 'secondary' },
  ],
};

// ---------- news ----------
interface NewsConfig { headline: string; byline?: string; paragraphs: string[]; url?: string }
export const newsPlugin: ExperiencePlugin<NewsConfig> = {
  id: 'news-card', name: 'News story', version: '1.0.0',
  description: 'A short story, with a link to read the rest.',
  configSchema: obj({ headline: s(200), byline: s(120), paragraphs: { type: 'array', minItems: 1, maxItems: 12, items: s(4000) }, url }, ['headline', 'paragraphs']),
  example: { headline: 'Rail line opens Monday', byline: 'Austin Daily', paragraphs: ['The new line connects downtown to the airport in 22 minutes.', 'Trains run every 10 minutes at rush hour.'], url: 'https://example.com/rail' },
  resolve: ({ config }) => [
    { type: 'article', headline: config.headline, ...(config.byline ? { byline: config.byline } : {}), paragraphs: config.paragraphs },
    ...(config.url ? [{ type: 'button' as const, label: 'Read the full story', action: { kind: 'link' as const, url: config.url } }] : []),
    { type: 'button', label: 'Save to read later', action: { kind: 'save' }, style: 'secondary' },
  ],
};

// ---------- booking ----------
interface BookingConfig { title: string; details?: string; slots: string[]; bookUrl: string }
export const bookingPlugin: ExperiencePlugin<BookingConfig> = {
  id: 'booking', name: 'Book a time', version: '1.0.0',
  description: 'Pick a time and book: classes, appointments, tours.',
  configSchema: obj({ title: s(120), details: s(500), slots: { type: 'array', minItems: 1, maxItems: 12, items: s(40) }, bookUrl: url }, ['title', 'slots', 'bookUrl']),
  example: { title: 'Your first class is free', details: 'Bring water. We have the rest.', slots: ['Mon 6:00 am', 'Mon 6:00 pm', 'Tue 7:00 am'], bookUrl: 'https://example.com/book' },
  resolve: ({ config, scan }) => [
    { type: 'hero', title: scan.owner.name, subtitle: config.title },
    ...(config.details ? [{ type: 'text' as const, text: config.details }] : []),
    { type: 'booking', title: 'Pick a time', slots: config.slots, action: { kind: 'link', url: config.bookUrl } },
  ],
};

// ---------- video ----------
interface VideoConfig { title: string; url: string; posterUrl?: string; link?: { label: string; url: string } }
export const videoPlugin: ExperiencePlugin<VideoConfig> = {
  id: 'video', name: 'Video', version: '1.0.0',
  description: 'A video, with an optional button after it.',
  configSchema: obj({ title: s(120), url: { type: 'string', maxLength: 2000 }, posterUrl: { type: 'string', maxLength: 2000 }, link: obj({ label: s(60), url }, ['label', 'url']) }, ['title', 'url']),
  example: { title: 'See how it’s made', url: 'https://example.com/video.mp4' },
  resolve: ({ config }) => [
    { type: 'hero', title: config.title },
    { type: 'video', url: config.url, ...(config.posterUrl ? { posterUrl: config.posterUrl } : {}) },
    ...(config.link ? [{ type: 'button' as const, label: config.link.label, action: { kind: 'link' as const, url: config.link.url } }] : []),
  ],
};

// ---------- the company's own house ad ----------
interface HouseConfig { headline: string; text: string; appUrl?: string; advertiseUrl?: string }
export const housePlugin: ExperiencePlugin<HouseConfig> = {
  id: 'house-promo', name: 'House ad', version: '1.0.0',
  description: "The company's own message, shown on slots nobody bought.",
  configSchema: obj({ headline: s(120), text: s(500), appUrl: url, advertiseUrl: url }, ['headline', 'text']),
  example: { headline: 'Save money. Drink FreeWater.', text: 'Free spring water, paid for by the ads on the bottle. 10¢ of every bottle goes to charity.', appUrl: 'https://freewater.io/app', advertiseUrl: 'https://freewater.io/advertise' },
  resolve: ({ config }) => [
    { type: 'hero', title: config.headline, subtitle: config.text },
    ...(config.appUrl ? [{ type: 'button' as const, label: 'Get the app', action: { kind: 'link' as const, url: config.appUrl } }] : []),
    ...(config.advertiseUrl ? [{ type: 'button' as const, label: 'Put your ad on a bottle', action: { kind: 'link' as const, url: config.advertiseUrl }, style: 'secondary' as const }] : []),
  ],
};

// ---------- custom bottles ----------
interface CustomConfig { from: string; message: string; videoUrl?: string; photoUrls?: string[]; confetti?: boolean }
export const customPlugin: ExperiencePlugin<CustomConfig> = {
  id: 'custom-experience', name: 'Custom bottle', version: '1.0.0',
  description: 'What a paid custom bottle opens: the sender’s message, video, photos and AR confetti.',
  configSchema: obj({ from: s(80), message: s(1000), videoUrl: { type: 'string', maxLength: 2000 }, photoUrls: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 2000 } }, confetti: { type: 'boolean' } }, ['from', 'message']),
  example: { from: 'Jordan and friends', message: 'Happy 30th, Maya!', confetti: true },
  resolve: ({ config }) => [
    { type: 'message', from: config.from, text: config.message },
    ...(config.confetti ? [{ type: 'confetti' as const }] : []),
    ...(config.videoUrl ? [{ type: 'video' as const, url: config.videoUrl }] : []),
    ...(config.photoUrls?.length ? [{ type: 'gallery' as const, imageUrls: config.photoUrls }] : []),
  ],
};

export const builtinPlugins: ExperiencePlugin<any>[] = [offerPlugin, couponPlugin, menuPlugin, tourPlugin, newsPlugin, bookingPlugin, videoPlugin, housePlugin, customPlugin];
