/** One call to Anthropic's Messages API with a single tool. Returns what Claude said and what it passed the tool. */
export async function claudeWithTool(o: {
  apiKey: string; model?: string; system: string; tool: { name: string; description: string; input_schema: unknown };
  history: { role: 'user' | 'assistant'; text: string }[]; message: string; images: string[]; fetch?: typeof fetch; timeoutMs?: number;
}): Promise<{ text: string; input: Record<string, any> }> {
  const messages: any[] = o.history.slice(-16).map((m) => ({ role: m.role, content: m.text || '(sent a file)' }));
  const content: any[] = o.images.slice(0, 4).map((d) => {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(d);
    return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null;
  }).filter(Boolean);
  content.push({ type: 'text', text: o.message || '(no words, just the files)' });
  messages.push({ role: 'user', content });
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 30_000);
  try {
    const res = await (o.fetch ?? fetch)('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: o.model ?? 'claude-sonnet-5-5', max_tokens: 1500, system: o.system, tools: [o.tool], messages }),
    });
    if (!res.ok) throw new Error(`Claude answered ${res.status}`);
    const data: any = await res.json();
    const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
    const call = (data.content ?? []).find((b: any) => b.type === 'tool_use' && b.name === o.tool.name);
    return { text, input: call?.input ?? {} };
  } finally {
    clearTimeout(timer);
  }
}
