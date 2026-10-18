# FreeWater platform

The first working piece of the FreeWater platform: it takes an order, picks the ads, lays out a print-ready label with a unique QR for every ad, prints it on a virtual printer, and bills only what really happened.

## Try it

You need Node.js 20 or newer.

```bash
npm install
npm run demo         # prints a morning of bottles in Austin; open out/index.html
npm run demo:packs   # prints a night of 6, 12 and 24 packs and delivers them; open out/packs.html
npm test             # checks every business rule
```

## What runs

One order goes through the print pipeline:

1. **Order**: `order.created`
2. **Fill slots** (ad engine): picks 1 to 6 different ads, skips blocked categories, never puts two competitors on one bottle, respects location targeting and budgets, and fills any gap with the house ad.
3. **Render** (label renderer): seam, ad slots, and the locked company panel. Each slot gets its own QR (`/s/<unit>/<slot>`), owned by the advertiser. The panel QR opens the bottle's receipt (`/r/<unit>`).
4. **Print** (printer adapter): retries a jam once. A sale is confirmed only when the printer confirms.
5. **Dispense**, then scans, AR launches and purchases come in as events.

The **ledger** listens to events and bills:

- each confirmed print, at that slot size's price
- each scan and AR launch that loads (repeats by one viewer inside the repeat window are free)
- commission on completed sales, given back on refunds
- the donation for each bottle, when the company has giving turned on

Failed prints, failed AR and duplicate orders are never billed. Ledger lines are only ever added, and debits always equal credits.

## Packs and home delivery

`src/modules/packs` prints 6, 12 and 24 packs for a delivery route:

- **Every bottle is different.** The ad engine is told which labels are already in the pack and picks a different one, and no campaign can take more than its share of a pack (`maxPackShare`, 50% by default).
- **The box is ad space.** Top, front, back and right are sold to four different advertisers (never two competitors), each with its own QR. The left face is the locked company panel with the pack's QR. The bottom stays blank. A small stop code (`R3 · 14`) sits in the corner of the front and top. Box faces are billed only when the box print is confirmed.
- **Checked before sealing.** The packing line scans every bottle. A missing bottle or one from another pack stops the line; the missing bottle is reprinted and the pack is checked again before it can be sealed.
- **Loaded in reverse.** The last stop goes in the van first, so the next box is always by the door.
- **Right box, right door.** A stop is marked delivered only when the driver scans the box planned for that address while at that address. Anything else is rejected with what to grab instead.

## How it's built to be swapped

| Folder | What it is |
|---|---|
| `src/core` | Shared records, the event bus, ids, and the module registry |
| `src/modules/ads` | Ads and slots: `freewater-ads` (default) and `house-only` |
| `src/modules/print` | Label renderer (`svg-label`) and QR drawing |
| `src/modules/ledger` | Billing rules and the open-books receipt |
| `src/modules/packs` | Packs, box faces, packing check, van loading and delivery |
| `src/adapters/printers` | Printer contract and the virtual printer |
| `src/platform.ts` | The thin core that runs the pipeline |
| `src/demo` | Sample companies, made-up advertisers and the demo run |
| `test` | Tests for every rule above |

Every module follows a contract (`contract.ts`). A company's config names which implementation fills each slot (`modules: { ads, renderer, printer }`). The demo's white-label licensee, Peak Spring, uses a different ad engine, its own brand panel, and has giving turned off, all through config.

All prices in `src/demo/seed.ts` are placeholders.

## Next

- A real printer adapter for the Model 6 and the micro-factory lines
- A database (PostgreSQL) behind the in-memory stores
- The public API, so the apps and the advertiser portal can call this
