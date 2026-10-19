import { contrast, posterIcons, readableOn, type PosterIcon } from '../creative/poster';
import { claudeWithTool } from '../ai/anthropic';
import { checkStudioSpec, studioLooks, studioTypes, type StudioLook, type StudioSpec, type StudioType } from './layout';
import type { PhotoInfo } from './photos';

/**
 * Turns a brand kit and a short brief into a few finished designs. Any AI (or none) can sit behind it. It only picks
 * words, a photo, a type style and a layout; the layouts draw, and every design is checked before it's offered.
 */
export interface BrandKit {
  name: string;
  category: string;
  /** In their own words: what they sell, where, what makes them different. */
  about?: string;
  colors?: { paper: string; ink: string; accent: string };
  type?: StudioType;
  logo?: StudioSpec['logo'];
  photos: PhotoInfo[];
}
export interface Brief {
  /** What this ad is for: the offer, the news, the reason to scan. */
  message: string;
  offer?: string;
  where?: string;
}
export interface StudioDesigner {
  readonly name: string;
  /** `previews` are small copies of the kit's photos (data URLs), in order, for an AI that can look at them. */
  design(kit: BrandKit, brief: Brief, previews?: string[]): Promise<StudioSpec[]>;
}

// ---------- colors ----------

const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255] as [number, number, number]; };
const hex = (c: number[]) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i]! - v) * t)); };
const sat = (h: string) => { const [r, g, b] = rgb(h).map((v) => v / 255) as [number, number, number]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };

/** A brand palette from a photo's own colors: paper and ink near its lightest and darkest, the accent its boldest. */
export function paletteFromPhoto(p: PhotoInfo): { paper: string; ink: string; accent: string } {
  const cols = p.palette.length ? p.palette : ['#888888'];
  const bold = [...cols].sort((a, b) => sat(b) - sat(a))[0]!;
  const paper = mix(cols[0]!, '#FFFFFF', 0.86);
  const ink = mix(bold, '#000000', 0.82);
  let accent = bold;
  for (let i = 0; i < 6 && contrast(accent, paper) < 3; i++) accent = mix(accent, '#000000', 0.18);
  return fixColors({ paper, ink, accent });
}

/** Keep any palette readable: ink on paper at 4.5:1 or better. */
export function fixColors(c: { paper: string; ink: string; accent: string }) {
  const out = { paper: c.paper.toUpperCase(), ink: c.ink.toUpperCase(), accent: c.accent.toUpperCase() };
  if (contrast(out.paper, out.ink) < 4.5) out.ink = readableOn(out.paper);
  return out;
}

const iconFor = (category: string): PosterIcon | undefined => {
  const c = category.toLowerCase();
  const map: [RegExp, PosterIcon][] = [[/burger|grill/, 'burger'], [/coffee|cafe|tea/, 'coffee'], [/real.?estate|home|house/, 'house'], [/fitness|gym|energy/, 'bolt'], [/news|media|book/, 'news'], [/pizza/, 'pizza'], [/taco|mexican/, 'taco'], [/music|record|concert/, 'music'], [/pet|vet|dog|cat/, 'paw'], [/event|ticket|movie|theat|museum/, 'ticket'], [/shop|retail|store|boutique/, 'bag'], [/dent/, 'tooth'], [/car|auto/, 'car'], [/bak|cake|dessert|sweet/, 'heart']];
  return map.find(([re]) => re.test(c))?.[1];
};

const clip = (s: string | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s) : undefined);

// ---------- the built-in designer (no AI) ----------

/**
 * Three designs by rule: the brand's best photo full-bleed, a second photo (or the same one) in an editorial split,
 * and a type-led design with no photo. Words come from the brief as written.
 */
export class RulesDesigner implements StudioDesigner {
  readonly name = 'rules';
  async design(kit: BrandKit, brief: Brief): Promise<StudioSpec[]> {
    const photos = kit.photos;
    const colors = kit.colors ? fixColors(kit.colors) : photos[0] ? paletteFromPhoto(photos[0]) : fixColors({ paper: '#F5F1EA', ink: '#1A1A1A', accent: '#1E7DB8' });
    const type: StudioType = kit.type ?? 'serif';
    const base = { brand: kit.name.slice(0, 40), headline: clip(brief.message, 60)!, ...(brief.where ? { kicker: clip(brief.where, 40) } : {}), ...(brief.offer ? { offer: clip(brief.offer, 32) } : {}), ...(kit.about ? { sub: clip(kit.about, 90) } : {}), colors, type, ...(kit.logo ? { logo: kit.logo } : {}) };
    const out: StudioSpec[] = [];
    if (photos[0]) out.push({ ...base, look: 'auto', photo: photos[0] });
    if (photos[1] ?? photos[0]) out.push({ ...base, look: 'frame', photo: (photos[1] ?? photos[0])!, type: type === 'serif' ? 'grotesk' : 'serif' });
    const icon = iconFor(kit.category);
    out.push({ ...base, look: 'type', ...(icon ? { icon } : {}), type: type === 'condensed' ? 'serif' : 'condensed' });
    return out.filter((s) => checkStudioSpec(s) === null);
  }
}

// ---------- Claude as the designer ----------

const tool = {
  name: 'propose_designs',
  description: 'Propose two or three distinct ad designs for this brand, for a small label on a free water bottle.',
  input_schema: {
    type: 'object', required: ['designs'],
    properties: {
      designs: {
        type: 'array', minItems: 2, maxItems: 3,
        items: {
          type: 'object', required: ['headline', 'type', 'look'],
          properties: {
            photo: { type: 'integer', description: 'Index of the brand photo to use (0-based), or omit for a type-only design.' },
            kicker: { type: 'string', maxLength: 40, description: 'Tiny line above the headline: where, or what is new. Optional.' },
            headline: { type: 'string', maxLength: 48, description: 'The message in 2 to 6 words. Specific, warm, no hype, no exclamation marks.' },
            sub: { type: 'string', maxLength: 80, description: 'One line of practical detail: when, where, how much.' },
            offer: { type: 'string', maxLength: 28, description: 'A short offer for a badge, only if the brief has one.' },
            type: { type: 'string', enum: Object.keys(studioTypes) },
            look: { type: 'string', enum: [...studioLooks] },
            icon: { type: 'string', enum: [...posterIcons], description: 'For type-only designs, an optional drawing.' },
            colors: { type: 'object', properties: { paper: { type: 'string' }, ink: { type: 'string' }, accent: { type: 'string' } }, description: 'Only if the brand has no colors yet: a palette that suits the photo.' },
          },
        },
      },
    },
  },
};

export class ClaudeDesigner implements StudioDesigner {
  readonly name = 'claude';
  constructor(private o: { apiKey: string; model?: string; fallback: StudioDesigner; fetch?: typeof fetch }) {}
  async design(kit: BrandKit, brief: Brief, previews: string[] = []): Promise<StudioSpec[]> {
    const photos = kit.photos.slice(0, 4);
    const system = [
      'You are the art director of a small studio that makes ads for local businesses. The ads print on the labels of free water bottles, each with a QR code in its bottom-right corner, at sizes from 1.9 by 2.25 inches up to the whole label.',
      'Write like a good magazine ad: concrete, warm and short. Never invent facts, prices or offers that are not in the brief. No exclamation marks, no all-caps headlines, no emojis.',
      'Make the designs genuinely different (a different photo, layout or type style each).',
      'Layouts: cover (photo fills the ad, words over a shaded band), split (words left, photo right; best for wide spaces), band (photo on top, words below), frame (photo inset on paper, like a magazine page), type (no photo, the words are the picture). auto picks by shape.',
    ].join('\n');
    const msg = [
      `Brand: ${kit.name} (${kit.category}).`, kit.about ? `About them: ${kit.about}` : '',
      kit.colors ? `Their colors: paper ${kit.colors.paper}, ink ${kit.colors.ink}, accent ${kit.colors.accent}.` : 'They have no brand colors yet.',
      `Brief: ${brief.message}`, brief.offer ? `Offer: ${brief.offer}` : 'No offer.', brief.where ? `Where: ${brief.where}` : '',
      photos.length ? `Their photos, in order: ${photos.map((p, i) => `#${i} (${p.w}×${p.h}${p.credit ? `, from ${p.credit.source}` : ''})`).join(', ')}. The images are attached in that order.` : 'They have no photos; design type-only ads.',
    ].filter(Boolean).join('\n');
    try {
      const images = previews.slice(0, photos.length);
      const r = await claudeWithTool({ apiKey: this.o.apiKey, model: this.o.model, system, tool, history: [], message: msg, images, agent: 'ad-assistant', ...(this.o.fetch ? { fetch: this.o.fetch } : {}) });
      const base = (await this.o.fallback.design(kit, brief))[0];
      const colors = kit.colors ? fixColors(kit.colors) : base?.colors ?? fixColors({ paper: '#F5F1EA', ink: '#1A1A1A', accent: '#1E7DB8' });
      const out: StudioSpec[] = [];
      for (const d of (r.input.designs ?? []) as any[]) {
        const photo = Number.isInteger(d.photo) ? photos[d.photo] : undefined;
        const c = !kit.colors && d.colors && [d.colors.paper, d.colors.ink, d.colors.accent].every((x: unknown) => typeof x === 'string' && /^#[0-9a-fA-F]{6}$/.test(x)) ? fixColors(d.colors) : colors;
        const spec: StudioSpec = {
          brand: kit.name.slice(0, 40), headline: String(d.headline ?? '').slice(0, 60), colors: c, type: (typeof d.type === 'string' && Object.hasOwn(studioTypes, d.type) ? d.type : kit.type ?? 'serif') as StudioType,
          look: (studioLooks.includes(d.look) ? d.look : 'auto') as StudioLook,
          ...(d.kicker ? { kicker: String(d.kicker).slice(0, 40) } : {}), ...(d.sub ? { sub: String(d.sub).slice(0, 90) } : {}),
          ...(d.offer && brief.offer ? { offer: String(d.offer).slice(0, 32) } : {}),
          ...(photo ? { photo } : { look: 'type' as const, ...(posterIcons.includes(d.icon) ? { icon: d.icon } : {}) }),
          ...(kit.logo ? { logo: kit.logo } : {}),
        };
        if (checkStudioSpec(spec) === null) out.push(spec);
      }
      return out.length ? out : this.o.fallback.design(kit, brief);
    } catch {
      return this.o.fallback.design(kit, brief);
    }
  }
}
