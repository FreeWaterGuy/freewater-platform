import type { Creative } from '../core/types';
import { posterCreative, type PosterSpec } from '../modules/creative/poster';
import { studioCreative, type StudioSpec } from '../modules/studio/layout';
import type { PhotoInfo } from '../modules/studio/photos';
import { sampleCampaigns } from './seed';
import { sampleAd } from '../modules/ads/service';
import { blankCampaign } from '../modules/fillers/unsold';

/**
 * Hard ads for the label's words: long words, all capitals, long headlines, logos, offers, emoji, Arabic and Hebrew,
 * and the three ads from the founder's walkthrough (Maria's Bakery, luma, Austin Daily). The visual check
 * (test/label-visual.test.ts) draws each at every piece of every template on every product and every box side; the
 * contact sheets (scripts/label-sheet.ts) draw the templates with them.
 */

const photo = (asset: string, w: number, h: number, x = 0.5, y = 0.5): PhotoInfo => ({ asset, w, h, focus: { x, y }, tone: { top: 0.6, bottom: 0.4, left: 0.5, right: 0.5, mean: 0.5 }, palette: ['#8A5A3B', '#F4EDE3'] });
export const samplePhotos = { coffee: photo('as_sample_coffee', 1200, 800), cat: photo('as_sample_cat', 900, 1200, 0.5, 0.4) };
const logo = (asset: string, w: number, h: number) => ({ asset, w, h, ext: 'png' as const });
export const sampleLogos = { round: logo('as_sample_round', 200, 200), wide: logo('as_sample_wide', 480, 100) };

const maria = { brand: 'Maria’s Bakery', headline: 'Fresh sourdough, baked every morning', kicker: 'South 1st', offer: 'Free croissant Friday', sub: 'Sourdough on South 1st since 2012.', colors: { paper: '#FFF8EE', ink: '#2A1A12', accent: '#B5462B' } };

export const studioSamples: { name: string; spec: StudioSpec }[] = [
  // The walkthrough: the rules designer's three designs for Maria's Bakery (a serif brand kit, a bakery).
  { name: 'Maria (photo)', spec: { ...maria, type: 'serif', look: 'auto', photo: samplePhotos.coffee } },
  { name: 'Maria (frame)', spec: { ...maria, type: 'grotesk', look: 'frame', photo: samplePhotos.cat } },
  { name: 'Maria (type)', spec: { ...maria, type: 'condensed', look: 'type', icon: 'heart' } },
  { name: 'Maria (logo)', spec: { ...maria, type: 'serif', look: 'type', logo: sampleLogos.round } },
  { name: 'Caps', spec: { brand: 'GRAND CENTRAL MARKET HALL', headline: 'GRAND OPENING WEEKEND', kicker: 'NOW OPEN ON SOUTH CONGRESS AVENUE', offer: 'FREE COFFEE ALL DAY', colors: { paper: '#FFFFFF', ink: '#111111', accent: '#D7262E' }, type: 'grotesk', look: 'type', icon: 'bag' } },
  { name: 'Wide letters', spec: { brand: 'WWW Gym', headline: 'WWW MMM WOW WOW WOW', sub: 'MEMBERS WELCOME — WALK-INS WELCOME', colors: { paper: '#F4F4F4', ink: '#1A1A1A', accent: '#2457D6' }, type: 'rounded', look: 'type' } },
  { name: 'Long word', spec: { brand: 'Supercalifragilistic Bakehouse', headline: 'Supercalifragilisticexpialidociously good bread', colors: { paper: '#FFF7E6', ink: '#2B1A10', accent: '#D7262E' }, type: 'rounded', look: 'type' } },
  { name: 'Longest headline', spec: { brand: 'Taquería La Esquina del Barrio', headline: 'Our whole menu is half price every Tuesday night until close', kicker: 'East Cesar Chavez', sub: 'Tacos, tortas and aguas frescas, made fresh every day since 1987 by the Garza family.', offer: 'Half price Tuesdays', colors: { paper: '#FFF4E0', ink: '#3B1F0E', accent: '#C2410C' }, type: 'grotesk', look: 'cover', photo: samplePhotos.coffee, logo: sampleLogos.wide } },
  { name: 'Split, wide logo', spec: { brand: 'Northside Dental', headline: 'New patients welcome this month', sub: 'Cleanings, whitening and Saturday hours.', offer: '$49 first visit', colors: { paper: '#F2F8FB', ink: '#0E2A3A', accent: '#1E7DB8' }, type: 'serif', look: 'split', photo: samplePhotos.cat, logo: sampleLogos.wide } },
  { name: 'Band', spec: { brand: 'Barton Springs Bikes', headline: 'Tune-ups while you wait', kicker: 'Open Sundays', sub: 'Any bike, any brand, 30 minutes.', offer: '20% off tubes', colors: { paper: '#F7F7F2', ink: '#1E2B1A', accent: '#3E7D2A' }, type: 'condensed', look: 'band', photo: samplePhotos.cat } },
  { name: 'Emoji', spec: { brand: 'Café ☕ Croissant', headline: '☕🥐 Coffee + croissant 🎉', offer: '2 for $5 🔥', colors: { paper: '#FFF8EE', ink: '#2A1A12', accent: '#B5462B' }, type: 'serif', look: 'type' } },
  { name: 'Arabic & Hebrew', spec: { brand: 'مخبز مريم', headline: 'خبز طازج كل صباح', sub: 'מאפייה טרייה בכל בוקר', colors: { paper: '#FFF8EE', ink: '#2A1A12', accent: '#B5462B' }, type: 'serif', look: 'type' } },
  { name: 'Hebrew cover', spec: { brand: 'מאפיית הבוקר', headline: 'לחם טרי כל בוקר בשש', offer: 'קפה חינם', colors: { paper: '#FFF8EE', ink: '#2A1A12', accent: '#B5462B' }, type: 'serif', look: 'cover', photo: samplePhotos.coffee } },
];

export const posterSamples: { name: string; spec: PosterSpec }[] = [
  { name: 'Filler', spec: { brand: 'Austin Animal Center', headline: 'Adopt a best friend this weekend', sub: 'Free adoptions Saturday and Sunday', colors: { bg: '#FFF3D6', fg: '#3B2410', accent: '#C2410C' }, icon: 'paw' } },
  { name: 'News', spec: { brand: 'Austin Daily', headline: 'City council approves the new rail line to the airport', sub: 'Scan for the full story', colors: { bg: '#F1EEE6', fg: '#1B1B1B', accent: '#1B1B1B' }, icon: 'news', font: 'classic' } },
  { name: 'House, caps', spec: { brand: 'FREEWATER', headline: 'SAVE MONEY. DRINK FREEWATER.', sub: 'YOUR AD HERE: FREEWATER.IO', colors: { bg: '#000000', fg: '#FFFFFF', accent: '#7FC6EA' }, icon: 'drop', font: 'bold' } },
  { name: 'Poster, long word', spec: { brand: 'Llanfairpwllgwyngyll Tea Rooms', headline: 'Llanfairpwllgwyngyllgogerychwyrndrobwll welcomes you', colors: { bg: '#FFFFFF', fg: '#1A1A1A', accent: '#2457D6' }, icon: 'coffee', font: 'clean' } },
];

/** Every sample, as the creative that draws it. */
export function labelSamples(): { name: string; creative: Creative }[] {
  return [
    ...studioSamples.map((s) => ({ name: `studio: ${s.name}`, creative: studioCreative(s.spec) })),
    ...posterSamples.map((s) => ({ name: `poster: ${s.name}`, creative: posterCreative(s.spec) })),
    // The demo businesses, the house ad and the fillers as they ship.
    ...sampleCampaigns().map((c) => ({ name: `campaign: ${c.advertiserName}`, creative: c.creative })),
    // Space nobody bought (src/modules/fillers/unsold.ts): the sample bottle's "Sample ad" placeholder and the blank
    // piece of last resort print on the same pieces too.
    { name: 'unsold: Sample ad placeholder', creative: sampleAd('freewater', 0).creative },
    { name: 'unsold: blank piece', creative: blankCampaign('freewater').creative },
  ];
}
