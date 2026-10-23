import Ajv, { type ValidateFunction } from 'ajv';
import { checkBlocks, checkTheme, type Block, type ExperienceDoc, type Theme } from './blocks';
import type { ExperiencePlugin, PluginTools, ScanContext } from './contract';

export interface OpenInput {
  pluginId: string;
  config: unknown;
  scan: ScanContext;
  theme: Theme;
}

/**
 * Runs experience plug-ins. Every plug-in, ours or a partner's, goes through the same checks:
 * its settings are checked against its schema before they are saved, it has 300 ms to answer,
 * and what it returns is checked block by block. If anything goes wrong the viewer still sees
 * the owner's simple card, never an error page.
 */
export class ExperienceHost {
  private plugins = new Map<string, ExperiencePlugin<any>>();
  private validators = new Map<string, (data: unknown) => string | null>();
  private compile: (schema: Record<string, unknown>) => (data: unknown) => string | null;
  readonly timeoutMs: number;
  /** The last few failures, so the ops console can show which plug-in is misbehaving. */
  readonly failures: { pluginId: string; at: Date; reason: string }[] = [];

  constructor(readonly tools: PluginTools, opts: { timeoutMs?: number; compile?: (schema: Record<string, unknown>) => (data: unknown) => string | null } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 300;
    this.compile = opts.compile ?? ajvCompiler();
  }

  /** Set by the app: is this plug-in on for this company (its Features page)? Without it, all are. */
  pluginOn?: (companyId: string, pluginId: string) => boolean;

  register(plugin: ExperiencePlugin<any>) {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(plugin.id)) throw new Error(`Plug-in id "${plugin.id}" must be lowercase letters, numbers and dashes`);
    this.validators.set(plugin.id, this.compile(plugin.configSchema));
    this.plugins.set(plugin.id, plugin);
    const err = this.checkConfig(plugin.id, plugin.example);
    if (err) throw new Error(`Plug-in ${plugin.id}'s own example is invalid: ${err}`);
  }

  unregister(id: string) {
    this.plugins.delete(id);
    this.validators.delete(id);
  }

  info(id: string) {
    const p = this.plugins.get(id);
    return p ? { name: p.name, ar: !!p.ar, arMode: p.arMode ?? (p.ar ? 'world' : undefined) } : null;
  }

  has(id: string) {
    return this.plugins.has(id);
  }

  list() {
    return [...this.plugins.values()].map((p) => ({ id: p.id, name: p.name, description: p.description, version: p.version, ar: !!p.ar, arMode: p.arMode ?? (p.ar ? 'world' : null), configSchema: p.configSchema, example: p.example }));
  }

  /** Null when the settings are fine for this plug-in, otherwise a sentence saying what's wrong. */
  checkConfig(pluginId: string, config: unknown): string | null {
    const v = this.validators.get(pluginId);
    if (!v) return `There is no experience called "${pluginId}".`;
    return v(config);
  }

  checkTheme(theme: unknown) {
    return checkTheme(theme);
  }

  async open(input: OpenInput): Promise<ExperienceDoc> {
    const doc = (blocks: Block[], fallback: boolean): ExperienceDoc => ({ pluginId: input.pluginId, owner: { name: input.scan.owner.name, theme: input.theme }, blocks, fallback });
    const fail = (reason: string) => {
      this.failures.unshift({ pluginId: input.pluginId, at: input.scan.now, reason });
      this.failures.length = Math.min(this.failures.length, 50);
      return doc(fallbackCard(input.scan.owner.name), true);
    };

    // A plug-in the company switched off (its Features page) opens the advertiser's simple card instead. Not a failure.
    if (this.pluginOn && !this.pluginOn(input.scan.companyId, input.pluginId)) return doc(fallbackCard(input.scan.owner.name), true);
    const plugin = this.plugins.get(input.pluginId);
    if (!plugin) return fail('plug-in not installed');
    const configErr = this.checkConfig(input.pluginId, input.config);
    if (configErr) return fail(configErr);

    let timer: NodeJS.Timeout | undefined;
    try {
      const blocks = await Promise.race([
        Promise.resolve().then(() => plugin.resolve({ config: input.config, scan: input.scan, tools: this.tools })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`took longer than ${this.timeoutMs} ms`)), this.timeoutMs); }),
      ]);
      const bad = checkBlocks(blocks);
      if (bad) return fail(`returned an unsafe page: ${bad}`);
      return doc(blocks, false);
    } catch (e: any) {
      return fail(e?.message ?? 'failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Checks settings against a plug-in's JSON Schema with Ajv. */
export function ajvCompiler() {
  const ajv = new Ajv({ allErrors: false, strict: false });
  return (schema: Record<string, unknown>) => {
    const v: ValidateFunction = ajv.compile(schema);
    return (data: unknown) => {
      if (v(data)) return null;
      const e = v.errors?.[0];
      return `Settings ${e?.instancePath || '(top level)'} ${e?.message ?? 'are not valid'}`.replace(/\s+/g, ' ').trim();
    };
  };
}

/** What a viewer sees when a plug-in can't answer: still on brand, still useful. */
export function fallbackCard(ownerName: string): Block[] {
  return [
    { type: 'hero', title: ownerName },
    { type: 'text', text: `Thanks for scanning! ${ownerName} paid for this bottle of water.` },
    { type: 'button', label: 'Save for later', action: { kind: 'save' } },
  ];
}

/** The holding page: a live ad whose link is being checked again (src/modules/ads/linkSafety.ts). No link, nowhere to go. */
export function holdingCard(ownerName: string): Block[] {
  return [
    { type: 'hero', title: ownerName },
    { type: 'text', text: 'This link is being checked. Thanks for scanning: please try again later.' },
    { type: 'button', label: 'Save for later', action: { kind: 'save' } },
  ];
}

/** Colors for a scan page: the company's brand, with the advertiser's own colors on top. */
export function themeFor(brand: { panelColor: string; accentColor: string; textColor: string }, own?: Partial<Theme>): Theme {
  return { background: '#FFFFFF', text: '#0B0B0B', accent: brand.accentColor, button: brand.panelColor, buttonText: brand.textColor, ...(own ?? {}) };
}
