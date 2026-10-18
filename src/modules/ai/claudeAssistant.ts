import { askGovernor, reportUsage } from './anthropic';
import { missingLabels } from '../ads/draft';
import type { AdAssistant, AdAssistantInput, AdAssistantOutput } from './contract';

/**
 * The ad assistant on Anthropic's Claude. Set ANTHROPIC_API_KEY to use it (and ANTHROPIC_MODEL to choose the model).
 * Claude proposes changes by calling one tool, `update_ad`; the platform checks every change before keeping it.
 * If Claude can't be reached, the built-in helper answers instead, so the chat never stops working.
 */
export class ClaudeAdAssistant implements AdAssistant {
  readonly name: string;
  constructor(private opts: { apiKey: string; model?: string; fallback: AdAssistant; fetch?: typeof fetch; timeoutMs?: number }) {
    this.name = `Claude (${opts.model ?? 'claude-sonnet-5-5'})`;
  }

  async respond(input: AdAssistantInput): Promise<AdAssistantOutput> {
    try {
      return await this.ask(input);
    } catch {
      const out = await this.opts.fallback.respond(input);
      return { ...out, reply: `${out.reply}` };
    }
  }

  private async ask(input: AdAssistantInput): Promise<AdAssistantOutput> {
    const ctx = input.context;
    const system = [
      `You help a small business make an ad for ${ctx.company.name}: free bottled water whose labels are paid for by ads. Each bottle's label is printed when someone takes it, with 1 to 6 ads side by side. Every ad has its own QR code that opens a page on the phone (the "scan page").`,
      `The business: ${ctx.business.name} (${ctx.business.category}).`,
      `How to talk: short, warm, plain words. No jargon. One question at a time. As soon as you know what the business is, make a complete first version and say what you chose; then improve it as they answer.`,
      `Always call update_ad to change anything. Only change what you need to. Never claim something is saved or live: they review it and ${ctx.company.name} approves it before it prints.`,
      `Artwork: business name (brand), a short headline (the offer, under 40 characters is best), an optional small line, three colors (bg, fg, accent) with readable contrast, an icon from: ${ctx.icons.join(', ')}; lettering from: ${ctx.fonts.join(', ')}. If they attach a picture, use it with useImage (attachment index, role "logo" or "photo").`,
      `Sizes are shares of the label: ${ctx.sizes.join(', ')} (1 is the whole label, 2 is half, 10 is a tenth; each piece is cut as close to square as possible). Starting prices per print by size in cents: ${JSON.stringify(ctx.prices.perPrintByShare)}; bids start at ${ctx.prices.bidStartsAt}¢ for the whole label and go up. Each scan that loads costs ${ctx.prices.perScan}¢, each AR launch ${ctx.prices.perArLaunch}¢, and sales from the bottle pay ${ctx.prices.commissionPercent}% commission.`,
      `Where it can run (machines and delivery routes): ${ctx.machines.map((m) => `${m.id} (${m.name}, ${m.kind})`).join('; ')}. Or "all".`,
      `Budget: either {type:"guaranteed", prints:N} (N bottles, at least 100) or {type:"bid", dailyCapCents:N (at least 500), maxCentsPerLabel:N (optional, at least ${ctx.prices.bidStartsAt})}.`,
      `Not allowed here: ${ctx.company.blockedCategories.join(', ') || 'nothing'}.`,
      `Scan page plug-ins (experienceId) and their settings (experienceConfig must match the schema):\n${ctx.plugins.map((p) => `- ${p.id}: ${p.description} Example: ${JSON.stringify(p.example)}`).join('\n')}\nBuilt-in 3D models: burger, fries, drink, latte, house. Links must start with https://.`,
      `The draft so far: ${JSON.stringify({ ...input.draft, poster: input.draft.poster ? { ...input.draft.poster, image: input.draft.poster.image ? `(${input.draft.poster.image.role} attached)` : undefined } : undefined })}`,
      `Still missing: ${ctx.missing.map((m) => missingLabels[m]).join('; ') || 'nothing. Tell them to review and submit.'}`,
    ].join('\n\n');

    const messages: any[] = input.history.slice(-16).map((m) => ({ role: m.role, content: m.text || '(sent a picture)' }));
    const content: any[] = input.attachments.slice(0, 4).map((a) => {
      const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(a.dataUrl);
      return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null;
    }).filter(Boolean);
    content.push({ type: 'text', text: input.message || '(no words, just the picture)' });
    messages.push({ role: 'user', content });
    // The API wants turns to alternate, starting with the person.
    while (messages.length && messages[0].role !== 'user') messages.shift();

    const tool = {
      name: 'update_ad',
      description: 'Change the ad draft. Include only the fields you are changing.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, category: { type: 'string' },
          poster: { type: 'object', properties: { brand: { type: 'string' }, headline: { type: 'string' }, sub: { type: 'string' }, icon: { type: 'string', enum: [...ctx.icons] }, font: { type: 'string', enum: ctx.fonts }, colors: { type: 'object', properties: { bg: { type: 'string' }, fg: { type: 'string' }, accent: { type: 'string' } } } } },
          useImage: { type: 'object', properties: { attachment: { type: 'integer' }, role: { type: 'string', enum: ['photo', 'logo'] } }, required: ['attachment', 'role'] },
          removeImage: { type: 'boolean' },
          sizes: { type: 'array', items: { type: 'integer', enum: ctx.sizes } },
          formats: { type: 'array', items: { type: 'string', enum: ['label', 'box-face'] } },
          locations: { oneOf: [{ type: 'string', enum: ['all'] }, { type: 'array', items: { type: 'string' } }] },
          buy: { type: 'object' },
          experienceId: { type: 'string', enum: ctx.plugins.map((p) => p.id) },
          experienceConfig: { type: 'object' },
          theme: { type: 'object' },
          suggestions: { type: 'array', items: { type: 'string' }, description: 'Up to 3 short replies the person might tap next.' },
        },
      },
    };

    askGovernor('ad-assistant');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      const res = await (this.opts.fetch ?? fetch)('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.opts.model ?? 'claude-sonnet-5-5', max_tokens: 1500, system, tools: [tool], messages }),
      });
      if (!res.ok) throw new Error(`Claude answered ${res.status}`);
      const data: any = await res.json();
      reportUsage('ad-assistant', this.opts.model ?? 'claude-sonnet-5-5', data);
      const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      const call = (data.content ?? []).find((b: any) => b.type === 'tool_use' && b.name === 'update_ad');
      const { suggestions, ...patch } = call?.input ?? {};
      return { reply: text || 'Done. Take a look at the preview.', patch, suggestions: Array.isArray(suggestions) ? suggestions.slice(0, 3).map(String) : [] };
    } finally {
      clearTimeout(timer);
    }
  }
}
