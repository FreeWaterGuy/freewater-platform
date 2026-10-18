// Bundled for the offline preview of the console: the real label maker, settings rules and sample artwork,
// so editing the brand redraws the bottle exactly as the server would.
import { svgLabelRenderer } from '../modules/print/renderer';
import { applyChange, checkSettings, describeChange } from '../modules/console/settings';
import { bottle16oz, sampleCampaigns } from './seed';
export { qrPlan, qrSvg, monogramLogo, checkQrLogo, checkQrColor } from '../modules/print/qr';
export { checkProduct } from '../modules/products/check';

export const renderer = svgLabelRenderer;
export const product = bottle16oz;
export const campaigns = () => new Map(sampleCampaigns().map((c) => [c.id, c]));
export { applyChange, checkSettings, describeChange };

/** The same address rules as the server's (which also checks the address again when it connects). */
export function checkWebhookUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'That isn’t a web address. It should look like https://example.com/webhooks/freewater'; }
  if (u.username || u.password) return 'Leave the user name and password out of the address.';
  if (u.protocol !== 'https:') return 'The address must start with https:// so events travel encrypted.';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.internal|.*\.local)$/.test(host) || /^(10|127|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^::1$|^f[cd]/i.test(host)) return 'That address is on a private network. Webhooks go to public addresses.';
  return null;
}
