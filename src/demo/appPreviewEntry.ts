// Bundled for the offline preview of the FreeWater app: the real design assistant, design rules and label
// renderer, running in the page so designing a bottle behaves exactly like it does on the server.
import { BuiltinDesigner } from '../modules/ai/builtinDesigner';
import { applyDesignPatch, designMissing, designMissingLabels, experienceOf, labelSpec } from '../modules/custom/design';
import { checkKeepsake, keepsakeDecorations, keepsakeFonts, keepsakeSvg, renderKeepsake } from '../modules/creative/keepsake';
import { ExperienceHost, themeFor } from '../modules/experiences/host';
import { builtinPlugins } from '../modules/experiences/builtins';
import { svgLabelRenderer, givingLine } from '../modules/print/renderer';
import { svgCreative } from '../modules/print/svgCreative';
import { freewater, bottle16oz, sampleCampaigns } from './seed';

export function makeLocal() {
  const compile = (schema: any) => (data: any) => {
    if (!data || typeof data !== 'object') return 'Settings are missing';
    const miss = (schema.required ?? []).find((k: string) => data[k] === undefined || data[k] === '');
    return miss ? `Settings must have required property '${miss}'` : null;
  };
  const host = new ExperienceHost({ builtinModel: (id) => `/models/builtin/${id}.glb` }, { compile });
  for (const p of builtinPlugins) host.register(p);
  return { designer: new BuiltinDesigner(), applyDesignPatch, designMissing, designMissingLabels, experienceOf, labelSpec, checkKeepsake, keepsakeDecorations, keepsakeFonts, keepsakeSvg, renderKeepsake, host, themeFor, renderer: svgLabelRenderer, givingLine, svgCreative, company: freewater, product: bottle16oz, campaigns: sampleCampaigns() };
}
