import { Registry } from './core/registry';
import type { BoxProduct, Campaign, CompanyConfig, Location, Product } from './core/types';
import { PackService } from './modules/packs/service';
import { freewaterAdEngine, houseOnlyAdEngine } from './modules/ads/engine';
import { svgLabelRenderer } from './modules/print/renderer';
import { VirtualPrinter, type VirtualPrinterOptions } from './adapters/printers/virtual';
import { Platform } from './platform';
import type { Persistence } from './core/persistence';

/** Wire up a platform with the default modules. Swap any of them by registering another name and pointing a company at it. */
export function createPlatform(input: {
  companies: CompanyConfig[];
  products: Product[];
  locations: Location[];
  campaigns: Campaign[];
  boxes?: BoxProduct[];
  printer?: VirtualPrinterOptions;
  seed?: number;
  clock?: () => Date;
  persistence?: Persistence;
  keepEventLog?: boolean;
}) {
  const printer = new VirtualPrinter(input.printer);
  const registry = new Registry()
    .registerAds(freewaterAdEngine.name, freewaterAdEngine)
    .registerAds(houseOnlyAdEngine.name, houseOnlyAdEngine)
    .registerRenderer(svgLabelRenderer.name, svgLabelRenderer)
    .registerPrinter(printer.name, printer);
  const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const platform = new Platform(registry, byId(input.companies), byId(input.products), byId(input.locations), byId(input.campaigns), { seed: input.seed, clock: input.clock, persistence: input.persistence, keepEventLog: input.keepEventLog });
  const packs = new PackService(platform, byId(input.boxes ?? []));
  platform.packCompany = (id) => {
    const p = packs.packs.get(id);
    if (!p) throw new Error(`Unknown pack "${id}"`);
    return p.companyId;
  };
  return { platform, printer, registry, packs };
}
