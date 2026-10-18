import type { AdEngine } from '../modules/ads/contract';
import type { LabelRenderer } from '../modules/print/contract';
import type { PrinterAdapter } from '../adapters/printers/contract';
import type { CompanyConfig } from './types';

/**
 * The module registry. Implementations register under a name; each company's config
 * picks which name fills each slot. This is how anything can be swapped per company.
 */
export class Registry {
  private ads = new Map<string, AdEngine>();
  private renderers = new Map<string, LabelRenderer>();
  private printers = new Map<string, PrinterAdapter>();

  registerAds(name: string, impl: AdEngine) { this.ads.set(name, impl); return this; }
  registerRenderer(name: string, impl: LabelRenderer) { this.renderers.set(name, impl); return this; }
  registerPrinter(name: string, impl: PrinterAdapter) { this.printers.set(name, impl); return this; }

  /** Every registered name, so a console can offer the choices. */
  names() { return { ads: [...this.ads.keys()], renderer: [...this.renderers.keys()], printer: [...this.printers.keys()] }; }

  adsFor(c: CompanyConfig): AdEngine { return pick(this.ads, c.modules.ads, 'ad engine'); }
  rendererFor(c: CompanyConfig): LabelRenderer { return pick(this.renderers, c.modules.renderer, 'renderer'); }
  printerFor(c: CompanyConfig): PrinterAdapter { return pick(this.printers, c.modules.printer, 'printer'); }
}

function pick<T>(map: Map<string, T>, name: string, what: string): T {
  const impl = map.get(name);
  if (!impl) throw new Error(`No ${what} registered as "${name}". Registered: ${[...map.keys()].join(', ') || 'none'}.`);
  return impl;
}
