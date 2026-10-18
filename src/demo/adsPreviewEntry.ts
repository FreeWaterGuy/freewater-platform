// Bundled for the offline preview of FreeWater Ads: the real assistant, draft rules, artwork and label renderer,
// running in the browser so the preview's chat behaves exactly like the server's.
import { BuiltinAdAssistant } from '../modules/ai/builtinAssistant';
import { applyPatch, estimate, missing, missingLabels, themeFromPoster, allowedSizes, maxPerSixth } from '../modules/ads/draft';
import { renderPoster, posterIcons, posterFonts } from '../modules/creative/poster';
import { ExperienceHost, themeFor } from '../modules/experiences/host';
import { builtinPlugins } from '../modules/experiences/builtins';
import { svgLabelRenderer, givingLine } from '../modules/print/renderer';
import { freewater, bottle16oz, sampleCampaigns, locations } from './seed';

export function makeLocal() {
  // A page can't compile code on the fly in some places this preview runs, so it checks required settings only.
  const compile = (schema: any) => (data: any) => {
    if (!data || typeof data !== 'object') return 'Settings are missing';
    const miss = (schema.required ?? []).find((k: string) => data[k] === undefined || data[k] === '');
    return miss ? `Settings must have required property '${miss}'` : null;
  };
  const host = new ExperienceHost({ builtinModel: (id) => `/models/builtin/${id}.glb` }, { compile });
  for (const p of builtinPlugins) host.register(p);
  return { assistant: new BuiltinAdAssistant(), applyPatch, estimate, missing, missingLabels, themeFromPoster, allowedSizes, maxPerSixth, renderPoster, posterIcons, posterFonts, host, themeFor, renderer: svgLabelRenderer, givingLine, company: freewater, product: bottle16oz, campaigns: sampleCampaigns(), locations: locations.filter((l) => l.companyId === 'freewater') };
}
