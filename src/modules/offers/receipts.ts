// Reading receipts: a photo of a store receipt becomes the store, the date and the lines bought. A receipt-reading
// service (Veryfi, Microblink, Taggun and others) plugs in here once one is chosen and its contract signed; until then
// every receipt waits for a person on the team to check it.

export interface ReceiptLine { text: string; gtin?: string; cents?: number; quantity?: number }
export interface ReadReceipt { store: string | null; date: string | null; totalCents: number | null; lines: ReceiptLine[]; confidence: number }
export interface ReceiptReader { readonly name: string; read(image: Uint8Array, contentType: string): Promise<ReadReceipt | null> }

/** No service connected: nothing is read automatically, so each receipt goes to the team to check by eye. */
export const manualReader: ReceiptReader = { name: 'manual', async read() { return null; } };

/**
 * Veryfi (veryfi.com): reads receipts, including store, date and line items with UPCs where printed. Not yet tried
 * against the live service: it needs an account (VERYFI_CLIENT_ID, VERYFI_USERNAME, VERYFI_API_KEY).
 */
export class VeryfiReader implements ReceiptReader {
  readonly name = 'veryfi';
  constructor(private o: { clientId: string; username: string; apiKey: string; fetch?: typeof fetch }) {}
  async read(image: Uint8Array, contentType: string) {
    const res = await (this.o.fetch ?? fetch)('https://api.veryfi.com/api/v8/partner/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'client-id': this.o.clientId, authorization: `apikey ${this.o.username}:${this.o.apiKey}` },
      body: JSON.stringify({ file_data: Buffer.from(image).toString('base64'), file_name: contentType === 'image/png' ? 'receipt.png' : 'receipt.jpg', categories: ['Grocery'], auto_delete: true }),
    });
    if (!res.ok) throw new Error(`Veryfi answered ${res.status}`);
    const d: any = await res.json();
    return {
      store: d.vendor?.name ?? null, date: d.date ? String(d.date).slice(0, 10) : null, totalCents: typeof d.total === 'number' ? Math.round(d.total * 100) : null,
      lines: (d.line_items ?? []).map((l: any) => ({ text: String(l.description ?? '').slice(0, 200), ...(l.upc ? { gtin: String(l.upc) } : {}), ...(typeof l.total === 'number' ? { cents: Math.round(l.total * 100) } : {}), ...(l.quantity ? { quantity: Number(l.quantity) } : {}) })),
      confidence: typeof d.ocr_score === 'number' ? d.ocr_score : 0, // unknown: a person checks it
    };
  }
}

export function readerFromEnv(env: NodeJS.ProcessEnv): ReceiptReader {
  if (env.VERYFI_CLIENT_ID && env.VERYFI_USERNAME && env.VERYFI_API_KEY) return new VeryfiReader({ clientId: env.VERYFI_CLIENT_ID, username: env.VERYFI_USERNAME, apiKey: env.VERYFI_API_KEY });
  return manualReader;
}
