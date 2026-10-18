import { claudeWithTool } from '../ai/anthropic';

// The team assistant: a FreeWater team member types what happened in plain words ("we gave 500 bottles at SXSW today
// for the WeFunder campaign") and attaches receipts, photos or documents. The assistant turns it into drafts for the
// books: a batch of bottles given, an expense, or both. Nothing is recorded until the person checks and confirms.

export interface BatchDraft { type: 'batch'; date?: string; bottles?: number; city?: string; place?: string; campaign?: string; advertiser?: string; revenueCents?: number; donationPerBottleCents?: number; charity?: string; costCents?: number; notes?: string }
export interface ExpenseDraft { type: 'expense'; date?: string; amountCents?: number; category?: string; memo?: string }
export type Draft = BatchDraft | ExpenseDraft;
export interface IntakeInput { message: string; images: string[]; fileNames: string[]; today: string; charities: string[]; cities: string[]; history: { role: 'user' | 'assistant'; text: string }[] }
export interface IntakeOutput { reply: string; drafts: Draft[]; by: string }
export interface IntakeAssistant { readonly name: string; respond(i: IntakeInput): Promise<IntakeOutput> }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const money = (s: string) => Math.round(Number(s.replace(/[$,]/g, '')) * 100);

/** The built-in helper: reads numbers, dates, places and amounts from the words. Asks for what's missing. */
export const builtinIntake: IntakeAssistant = {
  name: 'built-in helper',
  async respond(i) {
    const t = i.message.trim();
    const low = t.toLowerCase();
    const day = (() => {
      const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t)?.[1];
      if (iso) return iso;
      const d = new Date(`${i.today}T12:00:00Z`);
      if (/\byesterday\b/.test(low)) { d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
      const m = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`).exec(low);
      if (m) { const y = m[3] ? Number(m[3]) : Number(i.today.slice(0, 4)); return `${y}-${String(MONTHS.indexOf(m[1]!) + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`; }
      return /\btoday\b/.test(low) || !/\d{4}/.test(t) ? i.today : undefined;
    })();
    const bottles = /\b(\d[\d,]*)\s*(?:free\s+)?(?:bottles?|cans?|waters?|beverages?|drinks?)\b/.exec(low)?.[1];
    const city = i.cities.find((c) => low.includes(c.toLowerCase())) ?? /\bin ([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?)/.exec(t)?.[1];
    const place = /\bat (?:the )?([A-Z0-9][^,.;]{1,60}?)(?=[,.;]| for | in | on | today| yesterday|$)/.exec(t)?.[1]?.trim();
    const campaign = /\bwefund(?:e)?r\b/i.test(t) ? 'WeFunder campaign' : /\bfor (?:the |our )?([^,.;]{3,60}?) campaign\b/i.exec(t)?.[1]?.replace(/^\w/, (c) => c.toUpperCase()).concat(' campaign');
    const charity = i.charities.find((c) => low.includes(c.toLowerCase()));
    const paid = /\b(?:paid|sponsor(?:ed)?(?: us)?|bought)\b[^$]{0,30}\$\s?([\d,]+(?:\.\d{1,2})?)/i.exec(t)?.[1];
    const cost = /\b(?:cost|spent|receipt|invoice|bill)\b[^$]{0,30}\$\s?([\d,]+(?:\.\d{1,2})?)/i.exec(t)?.[1] ?? /\$\s?([\d,]+(?:\.\d{1,2})?)[^.]{0,30}\b(?:cost|receipt|invoice|to make)\b/i.exec(t)?.[1];
    const drafts: Draft[] = [];
    if (bottles) {
      drafts.push({ type: 'batch', ...(day ? { date: day } : {}), bottles: Number(bottles.replace(/,/g, '')), ...(city ? { city } : {}), ...(place ? { place } : {}), ...(campaign ? { campaign } : {}), ...(paid ? { revenueCents: money(paid) } : { revenueCents: 0 }), ...(charity ? { charity } : {}), ...(cost ? { costCents: money(cost) } : {}) });
    } else if (cost || i.fileNames.length) {
      const what = /\bfor ([^,.;$]{3,60})/i.exec(t)?.[1]?.trim();
      drafts.push({ type: 'expense', ...(day ? { date: day } : {}), ...(cost ? { amountCents: money(cost) } : {}), category: /\b(print|label)/i.test(t) ? 'printing' : /\b(truck|gas|fuel|deliver)/i.test(t) ? 'delivery' : /\b(bottle|water|can)/i.test(t) ? 'bottles' : 'other', memo: what ?? (i.fileNames[0] ? `Receipt: ${i.fileNames[0]}` : 'Expense') });
    }
    const d = drafts[0];
    const missing = !d ? [] : d.type === 'batch' ? [!d.city && 'the city', !d.place && 'where (the event or place)', !d.campaign && 'what it was for (the campaign)'].filter(Boolean) : [!d.amountCents && 'the amount'].filter(Boolean);
    const reply = !d
      ? 'Tell me what happened: how many bottles, where, when, and what for. Or attach a receipt and say what it was for.'
      : `I made a draft below${i.fileNames.length ? `, with ${i.fileNames.length === 1 ? 'your file' : `your ${i.fileNames.length} files`} attached` : ''}. ${missing.length ? `I still need ${missing.join(', ')}: fill it in below or tell me.` : 'Check it, then record it.'}`;
    return { reply, drafts, by: this.name };
  },
};

/** Claude reads the words and any receipt photos, and fills the drafts. Falls back to the built-in helper. */
export class ClaudeIntake implements IntakeAssistant {
  readonly name: string;
  constructor(private opts: { apiKey: string; model?: string; fetch?: typeof fetch }) { this.name = `Claude (${opts.model ?? 'claude-sonnet-5-5'})`; }
  async respond(i: IntakeInput): Promise<IntakeOutput> {
    try {
      const r = await claudeWithTool({
        agent: 'team-assistant', apiKey: this.opts.apiKey, model: this.opts.model, fetch: this.opts.fetch, history: i.history, images: i.images,
        system: [
          'You help a FreeWater team member put what happened into the books. FreeWater gives free bottles of water carrying ads, and gives to charity for every bottle.',
          'From their words and any receipt or photo, make drafts: a "batch" (bottles given outside the platform: date, bottles, city, place, campaign, who the ad was for, what a sponsor paid in cents, cost in cents) and/or an "expense" (date, amount in cents, category, memo).',
          'Money a sponsor paid is revenue; what it cost to make or hand out is cost. FreeWater advertising itself (for example its WeFunder campaign) has no revenue.',
          `Today is ${i.today}. Their charities: ${i.charities.join(', ') || 'none yet'}. Never invent numbers: leave a field out if you don't know it, and ask for it in one short sentence.`,
        ].join('\n'),
        message: `${i.message}${i.fileNames.length ? `\n[attached: ${i.fileNames.join(', ')}]` : ''}`,
        tool: { name: 'drafts', description: 'The drafts for the books, and a short reply.', input_schema: { type: 'object', properties: {
          reply: { type: 'string', maxLength: 400 },
          drafts: { type: 'array', maxItems: 4, items: { type: 'object', properties: {
            type: { type: 'string', enum: ['batch', 'expense'] }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, bottles: { type: 'integer', minimum: 1 }, city: { type: 'string' }, place: { type: 'string' }, campaign: { type: 'string' }, advertiser: { type: 'string' },
            revenueCents: { type: 'integer', minimum: 0 }, costCents: { type: 'integer', minimum: 0 }, charity: { type: 'string', enum: i.charities.length ? i.charities : [''] }, amountCents: { type: 'integer', minimum: 0 }, category: { type: 'string' }, memo: { type: 'string', maxLength: 200 }, notes: { type: 'string', maxLength: 500 },
          }, required: ['type'] } },
        }, required: ['reply', 'drafts'] } },
      });
      const drafts = (Array.isArray(r.input.drafts) ? r.input.drafts : []).filter((d: any) => d?.type === 'batch' || d?.type === 'expense').map((d: any) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== "" && v != null))) as unknown as Draft[];
      if (!drafts.length && !r.input.reply) throw new Error('empty');
      return { reply: String(r.input.reply || 'Here’s a draft. Check it, then record it.'), drafts, by: this.name };
    } catch {
      return builtinIntake.respond(i);
    }
  }
}
