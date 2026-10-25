import type { FootageProvider, VideoBrief } from './contract';
import { bytesCapped, OUTSIDE_SLOW_TIMEOUT_MS, withTimeout } from '../../core/http';

// Live-action and animated footage from Google's Veo video model (through the Gemini API). Each clip is 8 seconds,
// vertical, with sound, and takes from about 11 seconds to a few minutes to make, so footage is made ahead of time.
// Needs GEMINI_API_KEY. Costs are per second of video (see Google's pricing); the company pays them.
// https://ai.google.dev/gemini-api/docs/veo

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class VeoProvider implements FootageProvider {
  readonly name: string;
  readonly styles: ('live_action' | 'animated')[] = ['live_action', 'animated'];
  constructor(private opts: { apiKey: string; model?: string; fetch?: typeof fetch; image?: (url: string) => Promise<{ mimeType: string; data: string } | null> }) {
    this.name = `Veo (${opts.model ?? 'veo-3.1-generate-preview'})`;
  }
  // Starting and checking a job are quick; downloading the finished video can take a minute.
  private get f() { return withTimeout(this.opts.fetch ?? fetch, OUTSIDE_SLOW_TIMEOUT_MS); }
  private headers = () => ({ 'x-goog-api-key': this.opts.apiKey, 'content-type': 'application/json' });

  /** The words the video model gets: the advertiser's facts, the moment, the look. Never anything about the person. */
  static prompt(b: VideoBrief, style: 'live_action' | 'animated') {
    const s = b.segment;
    const look = style === 'animated'
      ? 'A polished 2D animated commercial, clean shapes, smooth character animation, bright and friendly.'
      : 'A cinematic live-action commercial, natural light, shallow depth of field, smooth camera moves, real people.';
    const when = { morning: 'early morning light', afternoon: 'bright afternoon', evening: 'warm evening light', night: 'a lively night setting' }[s.daypart];
    const f = b.facts;
    return [
      `${look} An 8-second vertical ad for ${b.advertiser} (${b.category}), set in ${when}.`,
      f.headline ? `It shows: ${f.headline}.` : '',
      f.details ? `${f.details}.` : '',
      s.passedOn ? 'The mood: something good shared between friends.' : !s.newCustomer ? 'The mood: a familiar favorite.' : 'The mood: discovering something new.',
      s.interest ? `The setting suits someone who enjoys ${s.interest}.` : '',
      `Brand colors ${b.colors.accent} and ${b.colors.background}. Ends on the product. No on-screen text, no logos other than the product's own, no prices.`,
    ].filter(Boolean).join(' ');
  }

  async start(b: VideoBrief, style: 'live_action' | 'animated') {
    const prompt = VeoProvider.prompt(b, style);
    const ref = b.images[0] && this.opts.image ? await this.opts.image(b.images[0]) : null;
    const res = await this.f(`${BASE}/models/${this.opts.model ?? 'veo-3.1-generate-preview'}:predictLongRunning`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({
        instances: [{ prompt, ...(ref ? { referenceImages: [{ image: { inlineData: ref }, referenceType: 'asset' }] } : {}) }],
        parameters: { aspectRatio: '9:16', durationSeconds: '8', resolution: '720p' },
      }),
    });
    if (!res.ok) throw new Error(`Veo answered ${res.status}`);
    const op: any = await res.json();
    if (!op?.name) throw new Error('Veo gave no job');
    return { jobId: String(op.name), prompt };
  }

  async check(jobId: string): Promise<Uint8Array | null> {
    const res = await this.f(`${BASE}/${jobId}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Veo answered ${res.status}`);
    const op: any = await res.json();
    if (!op.done) return null;
    if (op.error) throw new Error(op.error.message ?? 'Veo failed');
    const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!uri) throw new Error('Veo made no video (it may have been blocked by its safety filters)');
    const file = await this.f(uri, { headers: { 'x-goog-api-key': this.opts.apiKey }, redirect: 'follow' });
    if (!file.ok) throw new Error(`Downloading the video failed (${file.status})`);
    return bytesCapped(file, 200 * 1024 * 1024, 'Veo');
  }
}
