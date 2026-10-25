import { withTimeout } from '../../core/http';
// Barcodes: every product on a shelf has a GTIN (the number under the UPC or EAN barcode). Offers name the exact
// products they cover by GTIN, and receipts are matched against them.

/** Is this a real GTIN (8, 12, 13 or 14 digits with a correct check digit)? Returned as 14 digits, or null. */
export function normalizeGtin(raw: string): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return null;
  const g = d.padStart(14, '0');
  const sum = [...g.slice(0, 13)].reduce((a, c, i) => a + Number(c) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(g[13]) ? g : null;
}

export interface ProductInfo { gtin: string; name: string; brand: string | null; imageUrl: string | null; source: string }
/** Looks up what a barcode is. */
export interface ProductLookup { readonly name: string; lookup(gtin: string): Promise<ProductInfo | null> }

/** Open Food Facts (free, no key): groceries, drinks, snacks, many household items. */
export class OpenFoodFactsLookup implements ProductLookup {
  readonly name = 'openfoodfacts';
  private f: typeof fetch;
  constructor(f: typeof fetch = fetch) { this.f = withTimeout(f); }
  async lookup(gtin: string) {
    for (const code of [gtin, gtin.replace(/^0+/, '').padStart(13, '0'), gtin.replace(/^0+/, '').padStart(12, '0')]) {
      const r = await this.f(`https://world.openfoodfacts.org/api/v2/product/${code}?fields=code,product_name,brands,image_front_url`, { headers: { 'user-agent': 'FreeWater/1.0 (https://freewater.io)' } }).catch(() => null);
      if (!r?.ok) continue;
      const j: any = await r.json().catch(() => null);
      if (j?.status === 1 && j.product?.product_name) return { gtin, name: String(j.product.product_name).slice(0, 120), brand: j.product.brands ? String(j.product.brands).split(',')[0]!.trim().slice(0, 80) : null, imageUrl: j.product.image_front_url ?? null, source: this.name };
    }
    return null;
  }
}
