import { createHash } from 'node:crypto';
import type { ScanFacts } from '../experiences/dynamic';
import { claudeWithTool } from './anthropic';

// AI personalization of what a code opens: which of the advertiser's approved versions this person sees, and a
// short greeting written for them. It works the same for a scan page and for each kind of AR.
// The AI only ever chooses among versions the advertiser wrote and the company approved, and its greeting is
// checked before it's shown. It's told facts about the moment (morning, passed-on bottle, likes coffee), never who
// the person is. Answers are kept for an hour per kind of moment, so most scans don't wait for the AI at all.

export interface PersonalizeInput {
  campaignId: string;
  advertiser: string;
  category: string;
  /** "default" is the campaign's own settings; the others are its versions that fit this scan. */
  options: { id: string; name: string; summary: string }[];
  facts: ScanFacts;
  wantGreeting: boolean;
}
export interface PersonalizeOutput { choice: string; greeting?: string; by: string }

export interface Personalizer {
  readonly name: string;
  personalize(input: PersonalizeInput): Promise<PersonalizeOutput>;
}

/** Checks what the AI wrote. Short, plain, nothing to click or call. */
export function checkGreeting(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 90) return null;
  if (/https?:|www\.|\.com\b|@|<|>|\{|\}|\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/i.test(t)) return null;
  // No numbers, prices or discounts: a greeting is never an offer.
  if (/[0-9$€£%]/.test(t)) return null;
  if (t.replace(/[^A-Z]/g, '').length > t.length * 0.5) return null; // no shouting
  return t;
}

/** The built-in personalizer: plain rules, instant, no outside service. */
export const builtinPersonalizer: Personalizer = {
  name: 'built-in',
  async personalize(i) {
    // The most specific version that fits (versions with conditions are listed first).
    const choice = i.options.find((o) => o.id !== 'default')?.id ?? 'default';
    if (!i.wantGreeting) return { choice, by: 'built-in' };
    const f = i.facts;
    const hello = { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Hi, night owl' }[f.daypart];
    const why = f.passedOn ? 'someone passed this bottle to you' : f.newToAdvertiser ? `first time with ${i.advertiser}` : `welcome back to ${i.advertiser}`;
    const liked = f.interests.find((x) => i.category.toLowerCase().includes(x) || x.includes(i.category.toLowerCase()));
    const greeting = checkGreeting(`${hello}! ${why[0]!.toUpperCase()}${why.slice(1)}${liked ? `, and you like ${liked}` : ''}.`) ?? undefined;
    return { choice, ...(greeting ? { greeting } : {}), by: 'built-in' };
  },
};

/** Personalization on Anthropic's Claude. Falls back to the built-in rules if Claude is slow or unreachable. */
export class ClaudePersonalizer implements Personalizer {
  readonly name: string;
  constructor(private opts: { apiKey: string; model?: string; fallback: Personalizer; fetch?: typeof fetch; timeoutMs?: number }) {
    this.name = `Claude (${opts.model ?? 'claude-haiku-5-5'})`;
  }
  async personalize(i: PersonalizeInput): Promise<PersonalizeOutput> {
    try {
      const f = i.facts;
      const r = await claudeWithTool({
        agent: 'personalizer', apiKey: this.opts.apiKey, model: this.opts.model ?? 'claude-haiku-5-5', fetch: this.opts.fetch, timeoutMs: this.opts.timeoutMs ?? 1500, history: [], images: [],
        system: [
          `You personalize what someone sees after scanning the QR code on a free bottle of water, in an ad for ${i.advertiser} (${i.category}).`,
          'Choose the one version that fits this moment best. Only choose from the list. If none is clearly better, choose "default".',
          i.wantGreeting ? 'Also write a warm greeting of at most 12 words, in plain words, that fits the moment. No links, prices, phone numbers, promises or claims the ad doesn’t make. Never guess who the person is.' : 'Do not write a greeting.',
        ].join('\n'),
        message: `The moment: ${JSON.stringify({ daypart: f.daypart, day: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][f.day], firstScanner: f.firstScanner, passedOnFromSomeoneElse: f.passedOn, newToThisAdvertiser: f.newToAdvertiser, interests: f.interests, minutesSinceBottlePrinted: f.keptMinutes, city: f.city })}\nVersions:\n${i.options.map((o) => `- ${o.id}: ${o.name}. ${o.summary}`).join('\n')}`,
        tool: { name: 'personalize', description: 'Choose the version, and optionally a greeting.', input_schema: { type: 'object', properties: { choice: { type: 'string', enum: i.options.map((o) => o.id) }, greeting: { type: 'string', maxLength: 90 } }, required: ['choice'] } },
      });
      const choice = i.options.some((o) => o.id === r.input.choice) ? String(r.input.choice) : 'default';
      const greeting = i.wantGreeting ? checkGreeting(r.input.greeting) ?? undefined : undefined;
      return { choice, ...(greeting ? { greeting } : {}), by: this.name };
    } catch {
      return this.opts.fallback.personalize(i);
    }
  }
}

/**
 * Keeps answers for an hour per campaign and kind of moment, so people in the same moment get an instant answer.
 * A scan never waits long: if the AI hasn't answered in `waitMs`, the built-in rules answer this time and the AI's
 * answer is kept for the next person in the same moment.
 */
export class CachedPersonalizer implements Personalizer {
  readonly name: string;
  private cache = new Map<string, { at: number; out: PersonalizeOutput }>();
  private pending = new Map<string, Promise<PersonalizeOutput>>();
  constructor(private inner: Personalizer, private opts: { ttlMs?: number; max?: number; waitMs?: number; now?: () => number; quick?: Personalizer } = {}) { this.name = inner.name; }

  static segment(i: PersonalizeInput) {
    const f = i.facts;
    const kept = f.keptMinutes < 30 ? 'fresh' : f.keptMinutes < 240 ? 'hours' : 'kept';
    return createHash('sha256').update(JSON.stringify([i.campaignId, i.options.map((o) => o.id), i.wantGreeting, f.firstScanner, f.passedOn, f.newToAdvertiser, f.daypart, f.day, [...f.interests].sort().slice(0, 5), kept, f.city ?? ''])).digest('base64url').slice(0, 22);
  }
  async personalize(i: PersonalizeInput): Promise<PersonalizeOutput> {
    const now = this.opts.now ?? (() => Date.now());
    const key = CachedPersonalizer.segment(i);
    const hit = this.cache.get(key);
    if (hit && now() - hit.at < (this.opts.ttlMs ?? 3_600_000)) return hit.out;
    let job = this.pending.get(key);
    if (!job) {
      job = this.inner.personalize(i).then((out) => {
        if (this.cache.size >= (this.opts.max ?? 5000)) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { at: now(), out });
        return out;
      }).finally(() => this.pending.delete(key));
      job.catch(() => {});
      this.pending.set(key, job);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.opts.waitMs ?? 700); });
    const first = await Promise.race([job.catch(() => null), late]);
    clearTimeout(timer);
    return first ?? (this.opts.quick ?? builtinPersonalizer).personalize(i);
  }
}
