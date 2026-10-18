import { designMissingLabels } from '../custom/design';
import { claudeWithTool } from './anthropic';
import type { DesignAssistant, DesignAssistantInput, DesignAssistantOutput } from './designContract';

/** The design assistant on Claude. Falls back to the built-in helper if Claude can't be reached. */
export class ClaudeDesigner implements DesignAssistant {
  readonly name: string;
  constructor(private opts: { apiKey: string; model?: string; fallback: DesignAssistant; fetch?: typeof fetch }) {
    this.name = `Claude (${opts.model ?? 'claude-sonnet-5-5'})`;
  }

  async respond(input: DesignAssistantInput): Promise<DesignAssistantOutput> {
    const ctx = input.context;
    const { label, ...rest } = input.design;
    const system = [
      `You help someone design their own bottle of ${ctx.company} water: for a birthday, wedding, team, thank-you, anything. It's paid (${(ctx.priceCents / 100).toFixed(2)} dollars a bottle, up to ${ctx.maxBottles}) and has no ads. They control everything; make what they ask for.`,
      'The label front: big words (headline, under 40 characters is best), optional small words (sub), three colors (bg, fg, accent) with readable contrast, lettering, a decoration, and a photo layout. Put {name} in the words to print a different name on each bottle, and set names.',
      `Lettering: ${ctx.fonts.join(', ')}. Decorations: ${ctx.decorations.join(', ')}. Layouts: words, photo-left, photo-full.`,
      'The scan page is what friends see when they scan the bottle: a message, who it is from, confetti, photos and a video. Attached files are numbered from 0 in this message; use usePhotoOnLabel for the front, and scan.usePhotos / scan.useVideo for the scan page.',
      'Talk like a friendly designer: short, plain words, one question at a time. Make a full first design as soon as you know the occasion. Always call update_design for changes. They review a proof before paying.',
      `Design so far: ${JSON.stringify({ ...rest, label: label ? { ...label, photo: label.photo ? '(photo set)' : undefined } : undefined })}`,
      `Still missing: ${ctx.missing.map((m) => designMissingLabels[m]).join('; ') || 'nothing; suggest reviewing the proof'}.`,
    ].join('\n\n');
    const tool = {
      name: 'update_design', description: 'Change the bottle design. Include only what changes.',
      input_schema: { type: 'object', properties: {
        label: { type: 'object', properties: { headline: { type: 'string' }, sub: { type: 'string' }, font: { type: 'string', enum: ctx.fonts }, decoration: { type: 'string', enum: [...ctx.decorations] }, layout: { type: 'string', enum: ['words', 'photo-left', 'photo-full'] }, colors: { type: 'object', properties: { bg: { type: 'string' }, fg: { type: 'string' }, accent: { type: 'string' } } } } },
        usePhotoOnLabel: { type: 'integer' }, removePhoto: { type: 'boolean' },
        quantity: { type: 'integer', minimum: 1, maximum: ctx.maxBottles }, names: { type: 'array', items: { type: 'string' } },
        scan: { type: 'object', properties: { from: { type: 'string' }, message: { type: 'string' }, confetti: { type: 'boolean' }, useVideo: { type: 'integer' }, usePhotos: { type: 'array', items: { type: 'integer' } }, removeVideo: { type: 'boolean' } } },
        suggestions: { type: 'array', items: { type: 'string' } },
      } },
    };
    try {
      const r = await claudeWithTool({ apiKey: this.opts.apiKey, model: this.opts.model, fetch: this.opts.fetch, system, tool, history: input.history, message: input.message + input.attachments.map((a, i) => `\n[file ${i}: ${a.kind}${a.name ? ` "${a.name}"` : ''}]`).join(''), images: input.attachments.filter((a) => a.kind === 'image' && a.dataUrl).map((a) => a.dataUrl!) });
      const { suggestions, ...patch } = r.input;
      return { reply: r.text || 'Done. Take a look.', patch, suggestions: Array.isArray(suggestions) ? suggestions.slice(0, 3).map(String) : [] };
    } catch {
      return this.opts.fallback.respond(input);
    }
  }
}
