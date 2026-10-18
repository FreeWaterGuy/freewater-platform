# FreeWater platform

The FreeWater platform: it takes an order, picks the ads, lays out a print-ready label with a unique QR for every ad, prints it, and bills only what really happened. It runs as an API server on a Postgres database, and every part, including the database and the printer, can be swapped.

## Try it

You need Node.js 20 or newer.

```bash
npm install
SEED_DEMO=1 ECHO_CODES=1 npm start   # API on http://localhost:8080 with sample data; prints demo keys once and sign-in codes
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
| People signing in (no key) | `POST /v1/auth/start`, `POST /v1/auth/verify`, then `GET/PATCH/DELETE /v1/me`, `GET /v1/me/export`, `POST /v1/auth/sign-out` |
| Consumers | `GET/POST /v1/me/cards`, `POST /v1/me/custom-orders` |
| Finance | `GET /v1/ledger`, `GET /v1/events`, `POST /v1/invoices/run`, `GET /v1/invoices`, `POST /v1/invoices/:id/pay`, `POST /v1/advertisers/:id/cards` |
| Owners | `POST /v1/team` |

**Keys.** Every call except the public ones needs `Authorization: Bearer <key>`. A key belongs to one company and only ever sees that company. It has scopes (`orders`, `packs`, `campaigns`, `purchases`, `ledger`, `events`, `admin`), and an advertiser's key only sees that advertiser's campaigns and sales. New campaigns start paused until a company key turns them on (content review). Only a hash of each key is stored. Make one with `npm run key -- freewater "ATX-022 machine" orders`.

## Accounts and payments

**Signing in.** People sign in with a 6-digit code sent by email or text; there are no passwords to leak. Codes expire after 10 minutes, allow 5 tries, and at most 3 can be sent per 10 minutes. The answer never reveals whether an account exists. A sign-in lasts 30 days and can be ended any time. Only hashes of codes and sign-in tokens are stored.

**Who can do what.** Consumers manage only their own account. Team members are added by an owner with a role: owner, ops, finance, reviewer, driver, or advertiser staff (tied to one advertiser). Roles map to the same scopes as API keys.

**Privacy.** Every choice starts off: personalized offers, sharing interests with advertisers, location, and marketing. Interests are used for offers only while personalized offers is on. People can download everything stored about them and delete their account; deleting erases contact details, name, interests and choices, and ends every sign-in. The books keep only the account's random id.

**Payments.** Card numbers never reach FreeWater: apps send them to the payment provider and FreeWater keeps only a reference, brand and last 4 digits.
- *Custom bottles:* the price is set by the server. The money is held first, taken only once the bottle prints, and released if it doesn't. A declined card prints nothing. The same order sent twice is printed and charged once.
- *Advertiser invoices:* `POST /v1/invoices/run` bills each advertiser for every ledger line since their last invoice (prints, scans, AR launches, commission, box faces, less refunds). Each ledger line can be on only one invoice. A saved card is charged; without one the invoice stays open, and a declined card marks it failed until it's paid.
- Every payment taken is a ledger line, so the books show both what was billed and what was collected.

**Swappable.** Sign-in messages go through a messenger contract (`src/adapters/messaging`) and money through a payment contract (`src/adapters/payments`). The built-in test outbox sends nothing, and the test payment provider moves no real money; its test cards are `tok_visa`, `tok_mastercard`, `tok_amex`, `tok_declined`, `tok_insufficient_funds` and `tok_expired`. A real email or SMS service and a real provider such as Stripe plug in behind the same contracts.

## Scan pages, AR and experience plug-ins

Every QR on a bottle or box opens a page on the phone. Nothing to install.

```
npm run demo:scan            # prints bottles and a pack, then serves their scan pages at http://localhost:8787
npm run demo:scan-preview    # builds out/scan-preview/, an offline page showing them all
```

- **Addresses.** `/s/<bottle>/<slot>` (an ad), `/b/<pack>/<side>` (a side of a box), `/p/<pack>` (what's in a pack, never the address), `/r/<bottle>` (the bottle's open-books receipt).
- **Experiences are plug-ins.** Each campaign names a plug-in and fills in its settings. FreeWater ships nine: `offer`, `coupon`, `ar-3d-menu` (spin the food, add sides, see it on your table in AR, order), `ar-home-tour` (a 3D model of the home, rooms, showing times), `news-card`, `booking`, `video`, `house-promo` (the company's own message) and `custom-experience` (a paid custom bottle: the sender's message, video, photos, confetti).
- **Plug-ins return data, never code.** A plug-in answers with blocks (hero, offer, button, 3D model, tour, video, article, booking, gallery, message, confetti). The page draws them. No plug-in, ours or a partner's, can run anything on a viewer's phone, and every link must be https.
- **Plug-ins can't break a scan.** Settings are checked against the plug-in's schema before they are saved. At scan time it has 300 ms to answer; if it is slow, crashes, or returns anything unsafe, the viewer sees the advertiser's simple card instead and the failure is logged.
- **Partners can host their own.** `remotePlugin()` calls a partner's https endpoint with a signed request (`X-FreeWater-Signature`, HMAC-SHA256; `verifySignature()` checks it). The viewer is never identified to the partner.
- **Personal, with permission.** A plug-in knows whether this phone has scanned the advertiser before (first-timers get free fries; regulars get "your usual"). Interests are passed only when the person turned on personalized offers.
- **Billing is honest.** Opening the page bills nothing. The page reports the scan once it has shown; a scan whose experience failed is not billed. An AR launch is billed only when the model had loaded on the phone. Repeat scans in the window are free. Box sides bill their own advertiser the same way. Saves, link taps and picking a side are counted (`experience.engaged`) and never billed. Links get `fw_unit` and `fw_slot` added so sales can be credited.
- **3D models.** Advertisers upload `.glb` files (and PNG, JPEG, WebP, MP4) with `POST /v1/assets`. Files are checked by their contents, not their names, stored once, and served back as exactly what they are. Built-in demo models (burger, fries, drink, latte, house) are built from code at real-world size and pass the Khronos glTF validator. AR uses Google's model-viewer, served from this server: WebXR and Scene Viewer on Android, Quick Look on iPhone.
- **Advertisers change what their QR opens** with `PATCH /v1/campaigns/:id` (experience, settings, colors). `GET /v1/experiences` lists every plug-in with its settings and an example; `POST /v1/experiences/preview` shows the page before saving. A change by an advertiser goes back to content review.
- **Saved.** Anyone can save on their phone; signed-in people's saves go to `GET /v1/me/saved` for the app.

## The FreeWater app

The app people use on their phones. It's a web app (add it to your home screen); store versions come at go-live.

```
npm run demo:app           # the app at http://localhost:8787/app, plus a stand-in machine screen at /demo/machine/ATX-014
npm run demo:app-preview   # builds out/app-preview/, a clickable copy that needs no server
```

- **One tap.** At a machine, scan the code on its screen, tap "Get my free water", and watch the countdown. Signing in once (a code by email or text) keeps it fair.
- **You have to be at the machine.** The machine's screen shows a code that changes every 30 seconds (`GET /v1/machines/:id/presence`, read by the machine with its own key). The app sends it with the tap; a code older than about 90 seconds is refused, so nobody can take bottles from far away.
- **Fair limits.** Each person gets `consumer.freeBottlesPerDay` free bottles in 24 hours (3 for FreeWater; each company sets its own). Sending the same tap twice prints one bottle.
- **The countdown shows an ad.** For a free bottle it's the biggest ad on that bottle, with a button to save the offer. For a paid custom bottle it's an ad allowed at that machine. The countdown ad isn't billed yet.
- **Your bottles.** Every bottle you got, with each ad on it. Ads with 3D have an AR button that opens its scan page; the others open their page. Each bottle shows what it earned and gave, and links to its receipt. Home adds it up: bottles, given to charity, money saved.
- **Saved, Machines, Scan, Me.** Saved offers from your scans. A list of machines. A scanner that reads FreeWater codes with the camera and ignores everyone else's. Your name, privacy switches (all off to start), interests, saved card, download your data, sign out, delete your account.
- **Design my own bottle, by chatting.** See the next section.

## Designing your own bottle by chatting

The paid, ad-free bottles people design themselves: birthdays, weddings, teams, thank-yous.

- **Describe it.** "Maya's 30th birthday, pink and gold. Love, Jordan" and a photo makes a full design: the words, colors, the photo on the front, confetti, and a message for the scan page. Then change anything by saying so, or with the quick replies. A microphone button lets people talk instead of type, where the phone supports it.
- **Photos and videos.** Photos go on the label (printed from the picture itself) and on the scan page; a video (`POST /v1/me/assets`, MP4 up to 15 MB) plays when friends scan the bottle. Only the person who uploaded a file can use it.
- **Up to 24 bottles, a name on each.** "Make 12 bottles with a name on each. Names: Maya, Ana, Ben…" prints each bottle with its own name.
- **Every layer, one preview.** The label as it will look, on a bottle and flat, and the scan page exactly as friends will see it.
- **Proof, then pay.** `POST /v1/me/designs/:id/proof` makes the full label for bottle 1 with the price for all of them. Paying holds the money, prints the bottles one after another, and takes only what printed: if 1 of 4 jams, you pay for 3.
- **Swappable AI, same as the ad assistant.** Claude when `ANTHROPIC_API_KEY` is set (it sees the photos), the built-in helper otherwise or if Claude can't be reached. Every change is checked (`src/modules/custom/design.ts`): readable colors, real fonts and decorations, 1 to 24 bottles.
- **The template** (`src/modules/creative/keepsake.ts`) lays out words only, photo beside words, or a photo across the whole label, with confetti, stars, hearts, dots, stripes or balloons, and always leaves the corner clear for the QR code.

## FreeWater Ads: the advertiser portal

Where businesses make ads by chatting, watch their results, and pay.

```
npm run demo:ads           # the portal at http://localhost:8787/ads, with two weeks of sample results for joe@joesburgers.example
npm run demo:ads-preview   # builds out/ads-preview/, a clickable copy that needs no server
```

- **Sign up in a minute.** Email code, then business name and type (`POST /v1/advertisers`). Categories a company doesn't allow are refused here, before any work is done.
- **Make the ad by chatting** (`POST /v1/ads/drafts`, then `POST /v1/ads/drafts/:id/messages` with text and up to 4 pictures). The assistant fills in a draft: the artwork (business name, headline, small line, colors, icon or their logo or photo, lettering), sizes, where it runs, the budget, and what opens when people scan it. It asks for whatever is still missing, one thing at a time, and offers quick replies.
- **The AI can't break anything.** It only proposes changes; every change is checked before it's kept (`src/modules/ads/draft.ts`). Colors that would be hard to read are fixed, sizes that aren't sold are dropped, unknown machines and unfinished scan pages are explained back in plain words.
- **Swappable AI.** `AdAssistant` is a contract (`src/modules/ai/contract.ts`). With `ANTHROPIC_API_KEY` set, Claude does the talking (`ANTHROPIC_MODEL` picks the model) through one tool, `update_ad`, and sees attached pictures. Without a key, or if Claude can't be reached, the built-in helper answers: it reads offers, prices, colors, places, links and codes out of what people type. Any other AI can plug in the same way.
- **Artwork that works at every size.** The assistant designs with a template (`src/modules/creative/poster.ts`) that lays the ad out for a thin 1/6 slot, a half label, the full wrap and the side of a box, with text always escaped and contrast always readable.
- **See it before submitting** (`GET /v1/ads/drafts/:id/preview`): every size, a real sample label with the company panel, the side of a box, the real scan page in a phone frame, and what it costs.
- **Review twice.** The advertiser confirms the preview (`submit` needs `approved: true`), then the company approves or sends it back with a note (`GET /v1/review/campaigns`, `POST /v1/review/campaigns/:id`). Nothing prints before that. Once approved, the advertiser can pause and resume; changing the artwork or scan page sends it back to review. Changes are made the same way, by chatting (`POST /v1/ads/drafts` with `fromCampaignId`).
- **Results from the books** (`GET /v1/ads/overview`): spend, bottles printed, box sides, scans, AR launches, sales, saves and link taps, day by day and per ad. Every ledger line now carries its campaign, so each number traces to the lines it adds up.
- **Billing**: invoices made from those ledger lines, a saved card charged automatically, and pay-now for open ones.

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
| `src/modules/accounts` | Sign-in codes, sessions, roles, privacy, export and delete |
| `src/modules/payments` | Holds, charges, saved cards, advertiser invoices |
| `src/adapters/messaging`, `src/adapters/payments` | Messenger and payment contracts with test versions |
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
- The ops console, driver app and delivery subscriptions with route planning (step 6)
