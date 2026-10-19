// Which AI an operator uses: the setting and its checks, kept apart so the browser can use them too.

export type AiMode = 'network' | 'own' | 'off';
export interface AiSettings {
  mode: AiMode;
  /** The operator's own model for most work (with mode "own"). */
  model?: string;
  /** The operator's own fast model, for work that must answer quickly (with mode "own"). */
  fastModel?: string;
}

/** The host setting that holds an operator's own key. */
export function keySettingFor(companyId: string) { return `AI_KEY_${companyId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`; }

export function checkAiSettings(s: AiSettings | undefined): string | null {
  if (!s) return null;
  if (!['network', 'own', 'off'].includes(s.mode)) return 'Choose the network’s AI, your own, or none.';
  for (const m of [s.model, s.fastModel]) if (m !== undefined && !/^[a-z0-9][a-z0-9.\-]{2,60}$/.test(m)) return 'A model name is letters, numbers, dots and dashes.';
  return null;
}
