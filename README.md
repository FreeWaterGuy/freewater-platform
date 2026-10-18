# FreeWater platform

The FreeWater platform: it takes an order, picks the ads, lays out a print-ready label with a unique QR for every ad, prints it, and bills only what really happened. It runs as an API server on a Postgres database, and every part, including the database and the printer, can be swapped.

## Try it

You need Node.js 20 or newer.

```bash
npm install
SEED_DEMO=1 npm start   # starts the API on http://localhost:8080 with sample data; prints demo API keys once
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

## The API

One API for every app, machine, micro-factory, driver, advertiser and partner. The full list of endpoints is at `/v1/openapi.json` while the server runs.

| Who | What they call |
|---|---|
| Machines and the app | `POST /v1/orders` (send the same `orderId` again and nothing prints twice), `GET /v1/units/:id`, `GET /v1/units/:id/label.svg` |
| Scan pages and the open-books site (no key) | `GET /v1/public/scan/:unit/:slot`, `POST /v1/public/scans`, `POST /v1/public/ar-launches`, `GET /v1/public/receipts/:unit`, `GET /v1/public/companies/:id/totals` |
| Advertisers | `GET/POST /v1/campaigns` (SVG artwork, checked for anything unsafe), `PATCH /v1/campaigns/:id`, `POST /v1/purchases`, `POST /v1/refunds` |
| Micro-factory and drivers | `POST /v1/packs`, `/verify`, `/replace`, `/seal`, `POST /v1/routes/:id/load`, `POST /v1/deliveries` |
| Finance | `GET /v1/ledger`, `GET /v1/events` |

**Keys.** Every call except the public ones needs `Authorization: Bearer <key>`. A key belongs to one company and only ever sees that company. It has scopes (`orders`, `packs`, `campaigns`, `purchases`, `ledger`, `events`, `admin`), and an advertiser's key only sees that advertiser's campaigns and sales. New campaigns start paused until a company key turns them on (content review). Only a hash of each key is stored. Make one with `npm run key -- freewater "ATX-022 machine" orders`.

## The database

`src/db` holds the database contract (`SqlClient`) and two adapters:

- **Built-in (PGlite):** Postgres running inside the app, no server to install. Used by default (data in `./data`) and by the tests.
- **Postgres server:** set `DATABASE_URL=postgres://…` and the same code runs on it.

Migrations run on start. Events and ledger lines are append-only, enforced by the database itself: an update or delete is refused. Every change is written in the order it happened, and an API call answers only after its changes are stored. On restart the platform reloads everything, including budgets, which orders were already printed, and recent scans for the repeat window, so nothing is printed or billed twice.

The server keeps working state in memory and writes through to the database, so for now it runs as one instance. Running many instances side by side is a later step; the database already holds everything that would need.

## How it's built to be swapped

| Folder | What it is |
|---|---|
| `src/core` | Shared records, the event bus, ids, and the module registry |
| `src/modules/ads` | Ads and slots: `freewater-ads` (default) and `house-only` |
| `src/modules/print` | Label renderer (`svg-label`) and QR drawing |
| `src/modules/ledger` | Billing rules and the open-books receipt |
| `src/modules/packs` | Packs, box faces, packing check, van loading and delivery |
| `src/adapters/printers` | Printer contract and the virtual printer |
| `src/db` | Database contract, PGlite and Postgres adapters, migrations, storage |
| `src/api` | The public API (v1) and its OpenAPI description |
| `src/app.ts`, `src/server` | Start-up: load from the database, run the API, make keys |
| `src/platform.ts` | The thin core that runs the pipeline |
| `src/demo` | Sample companies, made-up advertisers and the demo run |
| `test` | Tests for every rule above |

Every module follows a contract (`contract.ts`). A company's config names which implementation fills each slot (`modules: { ads, renderer, printer }`). The demo's white-label licensee, Peak Spring, uses a different ad engine, its own brand panel, and has giving turned off, all through config.

All prices in `src/demo/seed.ts` are placeholders.

## Next

- A real printer adapter for the Model 6 and the micro-factory lines, once the printers are chosen (the virtual printer shows the contract any printer must follow)
- Webhooks, so partners hear about events without polling
- The consumer app and advertiser portal, built on this API
