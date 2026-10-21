import { claudeWithTool } from '../ai/anthropic';

/**
 * Who writes FreeWater News stories. The writer only ever gets the topic, what outlets reported (their facts and where
 * they came from), the style to write in and the corrections so far: never anything about a reader. It returns a
 * headline and paragraphs; the platform adds the brand, the date, the version and the "Based on reporting by …" links
 * itself, so a writer can't miscite or sign as anyone else. Every story is checked (`checkStory`) before it's kept.
 */
export interface NewsReport { outlet: string; url: string; title: string; facts: string }
export interface StoryInput {
  /** The brand the story is published under ("FreeWater News", or a white-label company's own). */
  brand: string;
  subject: string;
  reports: NewsReport[];
  /** The style readers chose by picking a source they like; null is the neutral version. */
  style: { id: string; name: string } | null;
  corrections: string[];
}
export interface StoryDraft { headline: string; paragraphs: string[] }
export interface NewsWriter { readonly name: string; write(i: StoryInput, companyId?: string): Promise<StoryDraft> }

/**
 * The stand-in with no AI key: it never retells anyone's article. It says which outlets are reporting, and the links
 * (added by the platform) take the reader to them. Honest and never stale.
 */
export const builtinNewsWriter: NewsWriter = {
  name: 'built-in (no AI)',
  async write(i) {
    const names = [...new Set(i.reports.map((r) => r.outlet))];
    return {
      headline: `${i.subject}: what’s being reported`,
      paragraphs: [
        `${names.length} outlets are reporting on ${i.subject}: ${list(names)}. Their reports are linked below.`,
        `${i.brand} summaries are written by our AI from several outlets at once. It isn’t switched on here yet, so for now we point you to the reporting itself.`,
      ],
    };
  },
};

export class ClaudeNewsWriter implements NewsWriter {
  readonly name = 'Claude';
  constructor(private opts: { apiKey: string; model?: string; fetch?: typeof fetch; fallback?: NewsWriter }) {}
  async write(i: StoryInput, companyId?: string): Promise<StoryDraft> {
    const style = i.style
      ? `Write it for readers who told us they like ${i.style.name}: lead with what those readers usually find most important, in the tone they're used to. Stay fair and factual, never claim to be ${i.style.name}, never imitate its name, slogans or look, and never add facts or opinions that aren't in the reports.`
      : 'Write it in a neutral, plain style, like a wire service: what happened, who said what, what is not yet known.';
    const system = [
      `You write short news stories for ${i.brand}, which is printed as a topic on free water bottles; the bottle's code opens your story.`,
      'Write in your own words from the facts across all the reports you are given. Never copy a sentence, and never retell one report sentence by sentence: combine what several outlets reported.',
      'Only state facts that appear in at least one report. When outlets disagree or a claim comes from one side, say who reported or said it.',
      'No links, no outlet names in the headline, no numbers that are not in the reports. Under 250 words, 2 to 5 short paragraphs.',
      style,
      i.corrections.length ? `Earlier versions had these corrections; make sure the story is right on them: ${i.corrections.join(' | ')}` : '',
    ].filter(Boolean).join('\n');
    const message = `Topic: ${i.subject}\n\n${i.reports.map((r, n) => `Report ${n + 1} (${r.outlet}): ${r.title}\n${r.facts}`).join('\n\n')}`;
    try {
      const r = await claudeWithTool({
        agent: 'news-writer', companyId, apiKey: this.opts.apiKey, model: this.opts.model, fetch: this.opts.fetch, system, message, history: [], images: [], timeoutMs: 45_000,
        tool: { name: 'story', description: 'The finished story.', input_schema: { type: 'object', properties: { headline: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } }, required: ['headline', 'paragraphs'] } },
      });
      const out = { headline: String(r.input.headline ?? ''), paragraphs: Array.isArray(r.input.paragraphs) ? r.input.paragraphs.map(String) : [] };
      if (!out.headline || !out.paragraphs.length) throw new Error('empty story');
      return out;
    } catch (e) {
      if (this.opts.fallback) return this.opts.fallback.write(i, companyId);
      throw e;
    }
  }
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
const grams = (w: string[], n: number) => { const out = new Set<string>(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' ')); return out; };

/** The most words in a row a story may share with one report (more is copying), and the most of it one report may supply. */
export const COPY_RUN = 8;
export const ONE_SOURCE_SHARE = 0.25;

/**
 * Is this story fit to publish? Returns the problem, or null. It must be in its own words (no run of COPY_RUN words
 * from a report, and no single report behind more than a quarter of its phrasing: never one article retold), carry no
 * links, keep outlets' names out of its headline (it's ours, not theirs), and be the right length.
 */
export function checkStory(d: StoryDraft, reports: NewsReport[], outletNames: string[]): string | null {
  if (typeof d.headline !== 'string' || d.headline.trim().length < 3 || d.headline.length > 120) return 'the headline must be 3 to 120 characters';
  if (!Array.isArray(d.paragraphs) || d.paragraphs.length < 1 || d.paragraphs.length > 8 || d.paragraphs.some((p) => typeof p !== 'string' || !p.trim() || p.length > 900)) return 'a story is 1 to 8 paragraphs of up to 900 characters';
  const text = [d.headline, ...d.paragraphs].join('\n');
  if (/https?:\/\/|www\./i.test(text)) return 'a story carries no links (the sources are linked under it)';
  const head = d.headline.toLowerCase();
  const named = outletNames.find((n) => n.trim().length > 2 && head.includes(n.toLowerCase()));
  if (named) return `the headline names ${named}: it must read as ours, not another outlet’s`;
  const story = words(text);
  const runs = grams(story, COPY_RUN);
  const fives = grams(story, 5);
  for (const r of reports) {
    const src = words(`${r.title} ${r.facts}`);
    for (const g of grams(src, COPY_RUN)) if (runs.has(g)) return `it copies words from ${r.outlet} (“${g}…”): it must be in its own words`;
    if (fives.size >= 8) {
      const from = grams(src, 5);
      let shared = 0;
      for (const g of fives) if (from.has(g)) shared++;
      if (shared / fives.size > ONE_SOURCE_SHARE) return `too much of it follows ${r.outlet}’s wording: it must combine several outlets in its own words`;
    }
  }
  return null;
}
