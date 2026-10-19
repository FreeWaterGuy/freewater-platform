import { AsyncLocalStorage } from 'node:async_hooks';

// Which AI each operator uses, white-labeled any way they like:
// - "network": the network's shared AI (FreeWater's account and models). The default.
// - "own": the operator's own Anthropic account and models. Its key lives in the host's settings, never in the
//   console, under a name fixed by the operator's id (AI_KEY_<ID>), so no operator can point at anyone else's key.
//   The operator's AI provider bills the operator directly.
// - "off": no AI at all; every feature runs on its built-in rules.
// Whatever the choice, every call is still metered on the agent's line in that operator's books, and the governor
// still decides first. The words the AI is given name the operator, never FreeWater, unless the operator is FreeWater.

import { keySettingFor, type AiSettings } from './settings';
export { checkAiSettings, keySettingFor, type AiMode, type AiSettings } from './settings';

const current = new AsyncLocalStorage<{ companyId: string }>();
/** Run AI work on behalf of one operator, so every call inside it uses that operator's AI. */
export function withCompany<T>(companyId: string | undefined, f: () => Promise<T>): Promise<T> {
  return companyId ? current.run({ companyId }, f) : f();
}
export function currentCompany() { return current.getStore()?.companyId; }

/** Set by the app: each operator's settings and name, and where host settings are read. */
export const aiRouting: { settingsOf: (companyId: string) => AiSettings | undefined; nameOf: (companyId: string) => string | undefined; env: Record<string, string | undefined> } = {
  settingsOf: () => undefined, nameOf: () => undefined, env: process.env,
};

export class AiUnavailable extends Error { constructor(why: string) { super(why); } }

/**
 * The key and model one call uses. Throws AiUnavailable when there's no AI for this operator (its mode is off, or its
 * key isn't set): the caller then falls back to its built-in rules, as it does when the AI can't be reached.
 */
export function routeAi(companyId: string | undefined, networkKey: string, model: string): { apiKey: string; model: string } {
  const s = companyId ? aiRouting.settingsOf(companyId) : undefined;
  if (!s || s.mode === 'network') {
    if (!networkKey) throw new AiUnavailable('The network AI has no key here.');
    return { apiKey: networkKey, model };
  }
  if (s.mode === 'off') throw new AiUnavailable('AI is switched off for this company.');
  const key = aiRouting.env[keySettingFor(companyId!)];
  if (!key) throw new AiUnavailable(`This company's own AI key (${keySettingFor(companyId!)}) isn't set on the host.`);
  const fast = /haiku/i.test(model);
  return { apiKey: key, model: (fast ? s.fastModel ?? s.model : s.model) ?? model };
}

/** The words an AI is given name the operator it works for. */
export function forOperator(text: string, companyId: string | undefined) {
  const name = companyId ? aiRouting.nameOf(companyId) : undefined;
  return name && name !== 'FreeWater' ? text.replace(/FreeWater/g, name) : text;
}
