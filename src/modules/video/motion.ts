import { claudeWithTool } from '../ai/anthropic';
import type { MotionScene, MotionSpec, StoryWriter, VideoBrief } from './contract';

// Motion storyboards: 4 to 6 short scenes in the advertiser's colors, cut for the moment. Every word comes from the
// advertiser's own ad or from a short list of lines written for each kind of moment; Claude, when used, may only
// rearrange and tighten the advertiser's words, and everything it writes is checked.

const clip = (s: string | undefined, n: number) => (s ? s.replace(/\s+/g, ' ').trim().slice(0, n) : undefined);

/** Plain words only: short, no links, phone numbers, shouting or code. */
export function cleanLine(t: unknown, max = 60): string | null {
  if (typeof t !== 'string') return null;
  const s = t.replace(/\s+/g, ' ').trim();
  if (!s || s.length > max) return null;
  if (/https?:|www\.|\.com\b|@|<|>|\{|\}|\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/i.test(s)) return null;
  if (s.replace(/[^A-Z]/g, '').length > s.length * 0.6 && s.length > 6) return null;
  return s;
}

const hooks: Record<string, string[]> = {
  morning: ['Start the day right', 'Your morning, sorted', 'Before the day gets busy'],
  afternoon: ['Your afternoon upgrade', 'A better afternoon', 'Midday, made better'],
  evening: ['Tonight, treat yourself', 'Your evening plan', 'End the day well'],
  night: ['Up late? Same', 'For the night owls', 'Still going?'],
};
const passed = ['A friend passed this to you', 'Someone thought of you', 'Passed along, for you'];
const welcomeBack = ['Good to see you again', 'Back for more?', 'Welcome back'];

/** The built-in writer: instant, no outside service. Each "take" is a different cut, so the best one can be learned. */
export const builtinWriter: StoryWriter = {
  name: 'built-in',
  async write(b) {
    const t = b.take;
    const pick = <T,>(list: T[]) => list[t % list.length]!;
    const s = b.segment;
    const hook = s.passedOn ? pick(passed) : !s.newCustomer ? pick(welcomeBack) : pick(hooks[s.daypart]!);
    const f = b.facts;
    const scenes: MotionScene[] = [{ ms: 1800, layout: 'hook', title: hook, sub: b.advertiser, motion: 'rise' }];
    if (b.images[0]) scenes.push({ ms: 2200, layout: 'picture', title: clip(f.headline, 48) ?? b.advertiser, imageUrl: b.images[0], motion: t % 2 ? 'zoom' : 'slide' });
    else if (f.headline) scenes.push({ ms: 2000, layout: 'point', title: clip(f.headline, 48)!, motion: 'pop' });
    const points = [f.details, ...(f.extra ?? [])].map((x) => clip(x, 70)).filter(Boolean) as string[];
    for (const p of (t % 3 === 2 ? points.reverse() : points).slice(0, 2)) scenes.push({ ms: 2100, layout: 'point', title: p, motion: t % 2 ? 'slide' : 'rise' });
    if (s.interest) scenes.push({ ms: 1600, layout: 'point', title: `For people who love ${s.interest}`, motion: 'pop' });
    if (f.offer || f.price) scenes.push({ ms: 2200, layout: 'offer', title: clip(f.offer ?? f.price, 48)!, sub: f.offer && f.price ? clip(f.price, 30) : (s.newCustomer ? 'First time? This one’s for you.' : undefined), motion: 'pop' });
    scenes.push({ ms: 2400, layout: 'end', title: b.cta.label, sub: clip(f.place, 50) ?? b.advertiser, imageUrl: b.images[1], motion: 'rise' });
    return { aspect: '9:16', colors: b.colors, scenes, cta: b.cta, brand: b.advertiser };
  },
};

/** Claude cuts the storyboard. Falls back to the built-in writer if Claude is slow, unreachable or writes something off. */
export class ClaudeWriter implements StoryWriter {
  readonly name: string;
  constructor(private opts: { apiKey: string; model?: string; fetch?: typeof fetch; timeoutMs?: number }) { this.name = `Claude (${opts.model ?? 'claude-sonnet-5-5'})`; }
  async write(b: VideoBrief): Promise<MotionSpec> {
    const base = await builtinWriter.write(b);
    try {
      const r = await claudeWithTool({
        agent: 'video-writer', apiKey: this.opts.apiKey, model: this.opts.model, fetch: this.opts.fetch, timeoutMs: this.opts.timeoutMs ?? 20_000, history: [], images: [],
        system: [
          `You are the editor of a 10 to 14 second vertical motion-graphics video ad for ${b.advertiser} (${b.category}). It plays after someone scanned the QR code on a free bottle of water and asked to see more.`,
          'Write 4 to 6 scenes. Each line is at most 8 words. Use only facts from the advertiser’s words below; never invent prices, claims, discounts or promises. No links, phone numbers or emojis.',
          'Cut it for the moment you are given (time of day, whether a friend passed the bottle on, first-time or returning customer, what they like), without guessing who the person is.',
          `Try a different angle for take ${b.take}.`,
        ].join('\n'),
        message: JSON.stringify({ advertiserWords: b.facts, callToAction: b.cta.label, moment: b.segment, hasPicture: b.images.length > 0 }),
        tool: { name: 'storyboard', description: 'The scenes, in order.', input_schema: { type: 'object', properties: { scenes: { type: 'array', minItems: 4, maxItems: 6, items: { type: 'object', properties: { layout: { type: 'string', enum: ['hook', 'picture', 'point', 'offer', 'end'] }, title: { type: 'string', maxLength: 60 }, sub: { type: 'string', maxLength: 60 }, motion: { type: 'string', enum: ['rise', 'zoom', 'slide', 'pop'] } }, required: ['layout', 'title', 'motion'] } } }, required: ['scenes'] } },
      });
      const raw = Array.isArray(r.input.scenes) ? r.input.scenes : [];
      const scenes: MotionScene[] = [];
      for (const x of raw.slice(0, 6)) {
        const title = cleanLine(x.title); if (!title) throw new Error('bad line');
        const sub = x.sub === undefined ? undefined : cleanLine(x.sub) ?? undefined;
        const layout = ['hook', 'picture', 'point', 'offer', 'end'].includes(x.layout) ? x.layout : 'point';
        scenes.push({ ms: layout === 'hook' ? 1800 : 2200, layout, title, ...(sub ? { sub } : {}), motion: ['rise', 'zoom', 'slide', 'pop'].includes(x.motion) ? x.motion : 'rise', ...(layout === 'picture' && b.images[0] ? { imageUrl: b.images[0] } : {}) });
      }
      if (scenes.length < 4 || scenes.at(-1)!.layout !== 'end') throw new Error('incomplete');
      // A price or offer Claude wrote must appear in the advertiser's own words.
      const words = JSON.stringify(b.facts).toLowerCase();
      for (const s of scenes) for (const m of `${s.title} ${s.sub ?? ''}`.match(/\$\s?\d+(?:\.\d+)?|\d+\s?%/g) ?? []) if (!words.includes(m.replace(/\s/g, '').toLowerCase())) throw new Error('invented a number');
      return { ...base, scenes };
    } catch {
      return base;
    }
  }
}
