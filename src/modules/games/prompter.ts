import { claudeWithTool } from '../ai/anthropic';

/** Answers what people ask in the games' prompt box: anything at all. */
export interface Prompter { readonly name: string; answer(text: string, companyId?: string): Promise<string> }

/** Without an AI key: says so plainly (the question is still kept and still counts). */
export const builtinPrompter: Prompter = {
  name: 'builtin',
  async answer() { return 'Thanks! Answers from our AI aren’t switched on here yet, but your question was saved and helps us learn what people want.'; },
};

export class ClaudePrompter implements Prompter {
  readonly name = 'claude';
  constructor(private o: { apiKey: string; model?: string; fetch?: typeof fetch; fallback?: Prompter }) {}
  async answer(text: string, companyId?: string) {
    try {
      const r = await claudeWithTool({
        apiKey: this.o.apiKey, model: this.o.model ?? 'claude-haiku-5-5', fetch: this.o.fetch, agent: 'prompt-helper', companyId, timeoutMs: 20_000,
        system: 'You answer questions people type into a box inside FreeWater, a company that gives people free products paid for by ads. Answer anything helpfully, briefly (under 120 words) and kindly, in the person’s language. Don’t ask for personal information. Call the answer tool with your reply.',
        tool: { name: 'answer', description: 'Your reply to the person.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        history: [], message: text, images: [],
      });
      const out = String(r.input.text ?? r.text ?? '').trim();
      if (out) return out.slice(0, 1500);
    } catch { /* fall through */ }
    return (this.o.fallback ?? builtinPrompter).answer(text);
  }
}
