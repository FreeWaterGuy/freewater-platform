# FreeWater platform

FreeWater gives people free, high-quality water, paid for by the ads on the bottle. This platform runs all of it: it prints each bottle with its own ads and QR codes, runs the vending machines and home delivery, the app, the advertiser portal, the game, points and the token, and open books that give part of every bottle to clean water. Advertisers pay only for what really happened, and other companies can run it under their own brand.

**New here? Read [`docs/OVERVIEW.md`](docs/OVERVIEW.md): what the platform does, in plain words.**

## Running it for real

Start here:

| Guide | What's in it |
|---|---|
| [`docs/OVERVIEW.md`](docs/OVERVIEW.md) | What the platform does, in plain words |
| [`docs/AI.md`](docs/AI.md) | Every use of AI: what it does, its limits, which AI each operator uses, and AI continuity |
| [`docs/NETWORK.md`](docs/NETWORK.md) | Why joining the network beats licensing: what's decided, what's design, what needs a lawyer |
| [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) | What FreeWater must do, and the rules that never change |
| [`docs/SWITCHES.md`](docs/SWITCHES.md) | **How to launch, lock and unlock everything**: every switch, who can flip it, the waits, and what to do if something goes wrong |
| [`docs/GO-LIVE.md`](docs/GO-LIVE.md) | What's ready, what's left, and the order to launch in |
| [`docs/RUNNING.md`](docs/RUNNING.md) | Running it in production: every setting, first start, health checks, alerts, backups, deploys, the load test |

## Try it

You need Node.js 22 or newer.

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
2. **Fill slots** (ad engine): picks 1 to as many different ads as the company allows (10 for FreeWater), skips blocked categories, never puts two competitors on one bottle, respects location targeting and budgets, and fills any gap with the house ad.
3. **Render** (label renderer): seam, ad slots, and the locked company panel. Each slot gets its own QR (`/s/<unit>/<slot>`), owned by the advertiser. The panel QR opens the bottle's receipt (`/r/<unit>`).
4. **Print** (printer adapter): retries a jam once. A sale is confirmed only when the printer confirms.
5. **Dispense**, then scans, AR launches and purchases come in as events.

The **ledger** listens to events and bills (where advertisers pay up front, FreeWater's way, a print moves its
price from the money the advertiser paid in advance to what's earned, and scans, AR launches, box sides and sales
are billed only when a person switched that fee on: see *How advertisers pay* below):

- each confirmed print, at that slot size's price
- each scan and AR launch that loads (repeats by one viewer inside the repeat window are free)
- commission on completed sales, given back on refunds
- the donation for each bottle, when the company has giving turned on

Advertisers are billed for nothing else. In particular there is no charge per click: a tap on a link out of an ad, a save or a call is counted for the advertiser, never billed. What they pay is prints (bottles and box sides), scans and AR launches that loaded, and commission on confirmed sales.

Failed prints, failed AR and duplicate orders are never billed. Ledger lines are only ever added, and debits always equal credits.

## Packs and home delivery

`src/modules/packs` prints 6, 12 and 24 packs for a delivery route:

- **Every bottle is different.** The ad engine is told which labels are already in the pack and picks a different one, and no campaign can take more than its share of a pack (`maxPackShare`, 50% by default).
- **The box is ad space.** Top, front, back and right are sold to four different advertisers (never two competitors), each with its own QR. The left face is the locked company panel with the pack's QR. The bottom stays blank. A small stop code (`R3 · 14`) sits in the corner of the front and top. Box faces are billed only when the box print is confirmed.
- **Checked before sealing.** The packing line scans every bottle (where there's no line, a signed-in person counts the box by hand and that check is recorded with who and when). A missing bottle or one from another pack stops the line; the missing bottle is reprinted and the pack is checked again before it can be sealed.
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
- *Ads, paid up front:* the advertiser's card is charged for its bottles before the ad is reviewed, at the total it was shown (a total that changed charges nothing); pressing pay twice, even on two servers, is one charge (one order per ad and per draft, a database rule). See *How advertisers pay*.
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

## Home delivery, the ops console and the driver app

```
npm run demo:ops           # ~30 homes on two routes due today, today's boxes printed, an ad waiting for review
                           #   /ops as ops@freewater.io · /driver as driver@freewater.io · /app as maya@example.com
npm run demo:ops-preview   # builds out/ops-preview/ and out/driver-preview/, clickable copies that need no server
```

**Delivery areas: house after house (the Austin pilot, `src/modules/delivery/houses.ts`).** The pilot's main way of
handing out water. FreeWater chooses the streets; every house on them gets a free pack, house after house, like
junk mail but free water that gives to charity. Houses don't sign up and aren't app users.
- **Areas** (ops console *Areas*, `/v1/ops/areas`). An ops person or owner makes an area on one of the routes (its
  micro-factory and delivery days), adds houses from a CSV of addresses with lat and lng, and keeps only the ones inside
  a polygon of [lat, lng] corners. A real map to draw the polygon on can come later; the console shows the houses as
  dots meanwhile. A new area starts **off**. Settings per area (docs/SWITCHES.md, "Delivery areas"): how often (weekly
  by default), 12- or 24-packs (24), packs per house (1), bottles a person a week once a household says its size (12),
  the most packs per house (3), boxes per van (100).
- **Houses** are addresses, not people: address, street and number, lat and lng, area, status (gets packs, stopped in
  the app, driver skip waiting for review, skipped), household size only if someone told us, last delivered, next due.
  What happened to a house and who did it is kept in `house_events`, which can only be added to.
- **The night's plan** (the same *Plan and print this night*, a signed-in ops person or owner). Every house due in
  every area that's on, in **street order**: one street at a time, every house on it by house number, driven from the
  nearer end, then on to the nearest end of the next street (`streetOrder` in `src/modules/delivery/planner.ts`; a
  routing service with real roads can replace it). Split into one run per van by boxes per van, a house's boxes in one
  van, stop numbers running on from van to van. Houses that stopped, or wait on a driver's skip, are left out and the
  next house still gets its box. A house is taken for a night in one guarded database statement, so two plans at once
  (or two servers) never put a house on two runs, and a house whose night went by unplanned comes on the next night
  (with an hourly "overdue" alert until then).
- **Packs per house**: the area's packs per house; once a household tells us its size, enough for its people (one
  24-pack a week for one or two people, two for three or four, three for five or more, by default).
- **At the door** nothing changes: the driver scans the house's own box there (GPS within 100 m, or confirms), and the
  drop time and the phone's position are kept on the stop, with the house and area on the `pack.delivered` event, as
  proof for advertisers. The driver can **skip a house** with a reason ("no soliciting" sign, they asked, not a home,
  not safe, a dog): its boxes come back and the house is left out until a person reviews it (*Areas*).
- **Stopping, in the app** (*Me → Your house's deliveries*, `/v1/me/house`). Someone at the house shows it's theirs by
  scanning the code on the side of a box delivered there in the last 60 days (or typing the box number from its corner
  with their house number; five wrong tries a day), then presses *Stop deliveries*: the house is left out of every
  plan from then on, and a box already printed for that night comes back with the driver. *Start deliveries again*
  puts it back from the next night its route drives. They can also say how many people live there. Deleting the account
  removes the link to the house and the household size, never the choice made for the house.
- **For the ad engine**: every bottle printed for a house gets `FillRequest.house` (`RouteHouseContext` in
  `src/core/types.ts`: house id, area id, route id, street, household size if known, whether someone claimed it) and,
  if someone claimed the house, that person's audience as `FillRequest.audience` (only what they allowed), exactly as
  for any bottle printed for a known person. Nothing is sold on it yet: what advertisers can buy on routes is next.
- **Where route buying meets household data** (for the next builder): a house in a delivery area and the household
  data about it are one house. Houses are keyed by the same address form household data uses (`normalizeAddress`, so
  "700 Big Bend Drive" and "700 Big Bend Dr." are one door and one pack), and
  `app.households.audienceForRouteHouse(companyId, RouteHouseContext.houseId)` gives that house's `HouseAudience`,
  counting people who claimed it in the app as residents (their "do not sell", a child at home, and what they allowed
  apply). It is empty while *Ads aimed at houses* is off. House packs draw paid bottles from prepaid ads exactly as
  machine bottles do (one claimed bottle per printed bottle); spots nobody paid for get approved fillers, then the
  house ad, never an unpaid ad.
- **Demo**: an "Austin pilot (sample houses)" area of about 50 made-up houses on four Travis Heights streets, off,
  every house marked as a sample.
- **Limits and decisions for the founder.** The box code proves a house to anyone who can scan the box, so a
  passer-by could stop a neighbour's water (the neighbour can claim it too and start again); a code printed inside the
  box would be stronger. Stopping is app-only as chosen: someone without the app, or who never got a box, can't stop
  it yet. A box printed for a house that stops the same night still prints (and bills its ads); it comes back unopened.
  The streets order is straight-line, not real roads.

**Home delivery (in the app, `/v1/me/delivery`).** Free 6, 12 or 24 packs every week, every 2 weeks or every 4 weeks, on the days a neighbourhood's route runs. Check an address first (`POST /v1/public/delivery/check`), then skip the next one, pause, resume, change size, day or the note for the driver, or stop. The app shows when it arrives and, on the day, how many stops away the van is. Bottles in a pack count as the customer's bottles, with their AR.

**The night's routes (`POST /v1/ops/runs/plan`, a signed-in ops person or owner).** Everyone due that night, grouped by route, put in driving order from the micro-factory, and a pack printed for each stop; then every delivery area's houses (above). Every bottle in a pack is different and the box carries its stop code ("R3 · 14") and its own box number. Planning the same night twice prints nothing new.
- **Swappable pieces.** Addresses become map points through a `Geocoder` (the test geocoder stands in until a real one is chosen). Stops are ordered by a `RoutePlanner` (the simple planner goes to the nearest stop next and then untangles crossings; a real routing service with roads and traffic plugs in the same way).
- **Packing check (`POST /v1/ops/runs/:id/pack-check`).** Every bottle in every box is checked before the box is sealed. The packing line reports each box's scan through the packs API (`POST /v1/packs/:id/verify`); the packing check then seals every box the line passed and lists the rest. Where there's no line, a signed-in person counts a box by hand and presses **Checked by hand** next to it on the routes page (`POST /v1/ops/runs/:id/stops/:stop/check-by-hand`, a person only, never an API key): the box is sealed and the stop records who checked it and when. Once every box is sealed the route is ready to load.

**The driver app (`/driver`).**
- **Load the van.** The driver takes a route, then scans each box into the van in load order (`POST /v1/driver/runs/:id/load`), last stop first, so stop 1 ends up by the door. A box out of order is refused.
- **House after house.** Each stop shows the address, the note, the box to grab (stop code and box number) and the next few houses.
- **At the door.** The driver scans the box. It's delivered only if it's that house's box and the driver is there: GPS within 100 m, or the driver confirms. A wrong box shows a full-screen "Wrong box. Don't leave it." and names the right one. Ops sees every wrong scan.
- **Proof and empties.** A photo of the box at the door, and a count of the empty bottles picked up.
- **Can't deliver.** "Problem at this stop" sends the box back and tells the customer why.
- **The customer hears about it.** They get a text or email when the box is delivered, or if it couldn't be left.

**The ops console (`/ops`).** For the company's own team.
- **Today:** bottles, scans, money earned and given, deliveries, and what needs attention (ads to review, failed prints, scan pages that fell back, wrong boxes).
- **Ad review:** each ad on a sample label, at every size, on a box and as its scan page, with a checklist. Approve, or send it back with a note.
- **Machines:** prints today, failures and the last print for each machine, plus any scan pages that fell back.
- **Routes:** plan and print a night, run the packing check, and follow every stop.
- **Areas:** the delivery areas, their settings and houses, adding houses from CSV, and drivers' skips to review.
- **Deliveries:** everyone getting packs by subscription.
- **Books:** the public totals and the latest ledger lines.

## Smart codes and seeing the sale

**Our own QR codes (`src/modules/print/qrEncoder.ts`).**
- Every QR on every bottle, box, receipt, coupon and machine screen is made by our own encoder, written from the QR standard (ISO/IEC 18004). No QR library and no QR service, so nobody else sees our codes or our scans.
- **Strongest protection:** codes use level H, so they still read with up to 30% of the code damaged, and have the standard 4-square white border.
- **Fewer squares:** our addresses use the standard's compact letters-and-numbers mode, which needs fewer, bigger squares than the usual mode.
- **Tested:** checked against an independent QR reader at every level. Real labels read 56 of 56 codes at 600, 300 and 200 dpi.

**Smart codes (`src/modules/codes`).** A printed code is `HTTPS://GO.FREEWATER.IO/Q/7KX2M9QPA4ZR1C`: 12 random characters plus a 2-character signature.
- **Can't be guessed or faked.** A fake code is refused before anything is looked up, and its page warns that the bottle may not be genuine.
- **The bottle's ID is never printed.**
- **Every scan reaches our server first.** It's counted (`code.opened`), then the page opens.
- **Where it leads is decided at scan time,** not when it was printed.
- **Each bottle tells its story:** "Genuine. Printed fresh at ATX-014, Congress Ave, 12 min ago", and whether it has been passed along.
- **Short scan domain:** a company can set one (`scanBaseUrl`, e.g. `https://fw.ac`) for even fewer squares.

**Seeing the sale (`src/modules/attribution`).** Sales are matched to the exact bottle and ad by the platform itself, not on the advertiser's word.
- **Click ids:** every link out of an ad goes through `/go/…` (signed, so it can't be used to send people elsewhere). We record the click and send the person on with `fwclid=FWC…`.
- **Our tag** (`/t.js`): advertisers put it on their site. It remembers the fwclid for 30 days and reports `freewater('purchase', { orderId, value, coupon })`. It's only accepted from the advertiser's own listed websites. The tag runs in the shopper's browser and anyone can forge its Origin, so a sale it reports proves a click led to the site but is **unverified**: shown to the advertiser and the company, never billed on its own.
- **Server to server:** `POST /v1/conversions` with the advertiser's key and the fwclid or coupon code. This is what bills commission, and it confirms a sale the tag reported (same order number; the tag's click is used if none is sent). A coupon redeemed at the counter confirms it too. Confirming with the order number alone vouches for the click the tag saw, so a server that has the fwclid (the tag keeps it in the site's own `_fwclid` cookie) should send it: its own click id always wins.
- **What counts:** only sales matched to one of our clicks, coupons or a static code's bottle reference. The same order counts once, at most 5 sales per click (or per bottle reference), within 30 days of the click (or of the bottle's printing, for a static code); a sale the tag saw inside the 30 days still counts when the server confirms it later. A coupon has no time limit and counts once. A sale is at most $5,000. The one exception: `POST /v1/purchases`, by which an advertiser's or the company's own key reports a sale from a bottle slot, bills commission on that report without our match. Click ids, coupons and order numbers are matched without regard to spaces around them or letter case (order numbers keep their case).
- **Refunds:** `POST /v1/conversions/{orderId}/refund` with no body refunds the whole sale; with `amountCents` (less than what's left) and a `refundId`, that part. The commission comes back in proportion, never more than the sale's, and a part counts once whether it comes this way or through `POST /v1/refunds`. Sales tracking shows each sale net of its refunds, the same as the books.
- **Checks:** the daily reconciliation (`GET /v1/books/reconciliation`, "sales match conversions") fails when a billed sale isn't in the books for its amount and refunds, and asks a person to look at sales the tag saw that the advertiser's server never confirmed within a week, or confirmed for less than the tag saw (both show in Sales tracking too). A sale whose books entry was lost in a crash is booked when it's reported again, and at start-up.
- **One-time coupons:** every person gets their own code (e.g. `BOTTLE2X-7F3A9Q`) with its own QR.
  - The cashier scans it with a phone camera, which opens FreeWater Ads → Check a coupon. It shows valid or already used, then the sale amount is entered and credited to that bottle.
  - Tills can use `POST /v1/coupons/{code}/redeem`.
  - A screenshot can't be used twice, which is why advertisers want to check every coupon.
- **Buy in AR:**
  - The ad's main link becomes a buy button inside AR, through the same click tracking.
  - **iPhone:** our own converter makes a USDZ file for every model (`/models/…usdz`, `/assets/…usdz`), and Apple's AR viewer shows the buy banner.
  - **Android:** Google's AR viewer gets the link.
- **Where results show:** advertisers see clicks, matched sales, commission and coupons in FreeWater Ads → Sales tracking. The company sees all of it at `/v1/ops/attribution`.

**Still to check on real phones:** the iPhone AR banner and the Android AR link.

## Logos, dynamic codes, three kinds of AR, right hands, any product

**Logos in codes (`src/modules/print/qr.ts`).**
- A company's own codes (receipt panel, house ads, boxes) can carry no logo, its initials, or its uploaded logo (SVG or PNG). Advertisers can put their logo in their codes if the company allows it. Codes can be colored if dark enough (4.5 to 1 against white).
- **Always scans:** the encoder knows which error-correction block every square belongs to. The logo is made as big as asked, then smaller (or the code one or two sizes larger) until every block keeps at least half its repair capacity, counting every square under the logo as lost whatever the logo looks like. Tested with white, black and random squares under the logo. FreeWater's codes still read with about 15 to 20% damaged on top of the logo (31% with no logo). The console and FreeWater Ads show the exact figure for each logo.

**Dynamic and static codes.** Dynamic is the default everywhere: every scan reaches us, is counted, and what it opens is decided at that moment.
- **Versions of the call to action** (`variants` on a campaign): each version says who it's for: the bottle's first scanner, someone the bottle was passed to, new or returning customers, morning/afternoon/evening/night, days, interests, bottles kept a while. The first version that fits is shown. The same bottle can show its owner one thing and the friend it's handed to another.
- **Old bottles stay useful:** when a campaign ends, its bottles open the advertiser's current campaign (or keep the old one, if they choose).
- **Static codes**, if the company allows them, go straight to the advertiser's site. They still carry the bottle's own signed reference (`fwb=`), so our tag and `POST /v1/conversions` can still match a sale to the exact bottle.
- `PATCH /v1/campaigns/{id}/codes`, and `POST /v1/campaigns/{id}/preview-moment` to see what one person at one moment would get.

**AI personalization (`src/modules/ai/personalizer.ts`).** With it on, AI picks which of the advertiser's versions each person sees, and writes a one-line greeting (shown on the page and over the camera in AR).
- It only chooses among the advertiser's approved versions whose conditions fit. It sees the moment (time of day, passed-on bottle, interests people chose to share, city), never who someone is.
- Greetings are checked: short, no links, numbers or shouting.
- Answers are kept for an hour per campaign and kind of moment. A scan never waits more than 0.7 s: if the AI is slower, the built-in rules answer and the AI's answer is kept for the next person.
- Claude when `ANTHROPIC_API_KEY` is set (`ANTHROPIC_PERSONALIZE_MODEL` to choose the model); built-in rules otherwise.

**Three kinds of AR.**
- **In your space** (`ar-place`, plus the 3D menu and home tour): the phone's own AR on a table or the floor, with the buy button.
- **On the bottle** (`ar-on-bottle`): a 3D model attached to the bottle in the camera: on top, in front, beside or circling it, spinning or floating. It moves and turns with the bottle and goes behind it when it should.
- **Living label** (`ar-living-label`): a new label laid over the real one all the way round, moving artwork, video or effects (shimmer, ripple, sparkle) over the advertiser's part. Turn the bottle and it turns with it.
- **How the phone follows the bottle (`src/modules/ar`):** we printed the label, so we know where every code sits on it. Bottles carrying on-bottle or living-label AR also get a thin **tracking strip**: small numbered squares (our own design) along the bottom of the label, about every 20°. Seeing any one, even far round the curve, tells the phone exactly how the bottle is turned (QR codes alone stop reading about 20° off-center). The phone's browser does it all; no app. `GET /v1/public/ar/{unit}` gives the label map.
- **Tested** on simulated camera pictures of a curved bottle all the way round. Without a camera (a laptop), a simulated bottle is drawn and the same tracker follows it.
- Each kind can be personalized: versions can swap the model, the artwork or the effect, and the AI's greeting becomes the caption.

**Right ads, right hands (`src/modules/handoff`).**
- A campaign can target people (`targeting.audience`: interests, new or returning customers). Such ads only print on bottles for a known person who fits (an app order at a machine, a home delivery), never on walk-up or spare labels. Why each ad was chosen is recorded.
- Each such bottle is followed: chosen for them, handed over (the machine confirms the drop for their order, or the driver's door scan), then opened. If the first scan comes from that same person's phone, it's confirmed in their hands. Advertisers see it under Sales tracking (`GET /v1/ads/reach`); the company sees every bottle's trail (`GET /v1/ops/units/{id}/handoff`).

**Any drink, any size (`src/modules/products`).**
- A product is its label size, its container's shape and size, the ad layouts it allows, an optional price factor and its own panel lines. Samples: the 16 oz bottle, a 25 oz bottle (ads cost 1.25×) and a 12 oz can.
- Every product is checked before it can print: the wrap must close around the container, and every ad must fit a readable QR code. Labels scale to the product.
- Campaigns can target products or kinds of product; products can block ad categories. Each machine has its own list of products.
- Companies add their own products in the console (Products); shared ones belong to the platform team.

**Still to check on real phones:** the tracking strip and living label with a real printed label, on several phones and in different light; then tune the strip size.

## Prices, square pieces, targeting and giving

**Pieces as square as possible (`src/modules/ads/layouts.ts`).** An ad gets a share of the label: the whole label, 1/2, 1/3, 1/4, 1/6, 1/8 or 1/10. For every mix of sizes that fills the label (up to 10 ads), the label is cut in two again and again along whichever side gives the squarest pieces. On the 16 oz bottle quarters are 2 × 2, sixths 3 × 2, eighths 4 × 2, and a half with two quarters is a column beside two stacked pieces. Pieces too thin (more than 2.6 times as long as wide) or too small for a readable QR code are never used. Products say which sizes they offer; the console shows how each one is cut.

**FreeWater's prices** (each company sets its own; white-label licensees keep theirs): whole label $1.00, 1/2 65¢, 1/3 51¢, 1/4 42¢, 1/6 33¢, 1/8 24¢, 1/10 20¢ per bottle, times the product's price factor (the 25 oz bottle is 1.25×). For the pilot these are flat and all-inclusive: AR, video and scans are included at every size, and every size gets the same tech.

**How advertisers pay (`src/modules/ads/prepaid.ts`, `billing.ts`; docs/SWITCHES.md).** "We don't manufacture anything unless they have paid up front."
- **Quote → pay → review → print.** The review page shows the exact total (bottles × the size's price × the product's factor, plus any costly extras); *Pay and submit* charges the card; the company reviews the ad; then it prints until every paid bottle is out ("N of M bottles out"). No end date and no cancel button: pausing only delays.
- **Only paid bottles print.** Each bottle's paid ads are claimed in the database before its label is drawn (`ad_prepaid`, one guarded statement each), so the last paid bottle prints once even with two servers or a restart. A failed or abandoned print gives its bottle back. Bottles in delivery packs and at machines draw the same way; a bottle with ten tenth-ads draws one from each of ten ads.
- **Books:** the payment sits in `prepaid:advertiser:<id>` (a liability) until each bottle prints and moves its price to `revenue:print`. The database refuses a prepaid balance below nothing, more printed than paid, and a second refund for one ad. The daily reconciliation and `npm run books:check` compare paid, printed and printing bottles with the bottles themselves and the books.
- **Changing a running ad** costs the change fee ($100 by default, per company), paid up front; the new ad is reviewed, then the bottles not printed yet carry it.
- **If FreeWater stops an ad**, an owner or finance person (signed in, second step) pays back the unprinted bottles and unused extras to the card, once (`POST /v1/ads/campaigns/:id/stop`).
- **Fees on top** (per scan 25¢, per AR launch 40¢, per box side, 3% commission) each have their own switch, all off. Turned on, they're charged to the card on file once a day (the `ad-fees` job), never left on an invoice to wait; a declined card pauses that advertiser's ads at once.
- **Costly extras** (AI video clips from Veo): cost plus the company's markup, in the quote and paid up front. No paid clip left, no clip made. What each use really cost is recorded; if it passes what was charged the team is alerted, and the advertiser is never billed more.
- **Per company:** pricing `flat` or `auction`, paying up front or billing afterwards with credit limits (FreeWater: flat, up front, no credit). Each is a switch on the Features page; for a new white-label company the money switches start off.

The rest of this section is for companies that bill afterwards and sell by auction.
- **Bids start at $1** for the whole label and go up. A smaller piece pays the same share of the bid as its starting price is of $1 (a $1.20 bid pays 78¢ for a half). A product's price factor scales all of it.

**Targeting costs more per engagement (`src/modules/ads/targeting.ts`).** Like Google and Facebook: each scan and AR launch costs the base price (FreeWater: 25¢ and 40¢) plus a premium for each kind of targeting. FreeWater's settings: chosen machines or routes +10%, chosen products +5%, people's interests +25%, new or returning customers +15%, at most +60% in all. The ledger line says what was added, and advertisers see their premium on the "Code, versions and AI" page.

**Giving: 10¢ a bottle, plus 10% of every dollar beyond.** FreeWater's default charity is Well Aware (Austin; builds water wells in Africa). Each bottle gives 10¢, covering its first $1 of ads. On top of that, 10% of every other dollar goes to charity: print money above $1 (higher bids, several ads on one bottle), scans, AR launches, box sides, custom bottles and sales commissions. A refund takes its share back. The label says "10¢ a bottle + 10% of every dollar beyond goes to Well Aware". In the console (Giving), every company, white-label ones included, can change the amounts, add charities, give a machine or route its own charity, or split every gift between several charities by percent (to the cent).

**3% commission on sales.** This is the default for FreeWater and new licensees. It applies to sales after a QR scan and to sales made straight from the buy button inside AR. AR clicks are marked, and advertisers see "sales from AR" on their tracking page.

**The auction (`src/modules/ads/auction.ts`).** It works like Google's and Meta's:
- Bid adjustments by machine, product, time of day, day of week, interests, and new or returning customers. They multiply together.
- Ad rank is the bid plus the engagement the ad is expected to earn, so a good ad can win with less.
- Second price: the winner pays just enough to beat the next other advertiser's ad (an advertiser's own ads never set each other's price), never more than its bid and never below $1.
- Even pacing of daily budgets, reset each day in the company's time zone.
- A cap on how many bottles one person gets with the same ad each day.

Each placement records what it bid, what it paid and which adjustments applied. Advertisers set all of this under "Your bid" on the ad's code page.

**When the price is set, and rounding.** A bottle's price is fixed when its ads are picked, and the money is held from that day's budget then; it's billed only if the bottle prints, and a failed print gives the hold back. Prices are whole cents: a piece's share of a bid rounds to the nearest cent (half a cent up), so a piece can cost up to half a cent more than its exact share of the bid. A machine's labels kept ready for when its internet drops (up to 24 hours) keep the price and the day of the moment they were made: a bid lowered or an ad paused afterwards doesn't change them, and if one prints offline it's billed at that price, against that day's budget, and shows on the statement and invoice on the day it was billed. Changing an ad in the chat keeps its bid settings and never adds bottles to a set number unless the advertiser asks for a new number.

## The prize game (`src/modules/lottery`)

It is off for every company until turned on in the console (Prize game).
- **Who can win:** only engagement counts. Each ad gives one chance for its page loading, one for its video playing and one for its AR opening, with a limit per person per day.
- **Fair:** each day has a secret random seed. Its SHA-256 fingerprint is public before the day starts (`GET /v1/public/lottery/:company/fairness`), and the seed and every draw are published after the day ends. A draw is HMAC-SHA256(seed, company:day:person:n), so nobody can choose winners. Odds and prizes are frozen for the day.
- **Paying attention:** a winning chance doesn't say what was won. A few seconds in, a red ball bounces across the screen for 2.5 seconds. The phone sends where and when it was tapped, and the server works out where the ball was at that moment (the same path, in `ball.ts` and `scan.js`). Only a tap on the ball while it is showing wins.
- **After the ball:** winners get a prize code, which the company checks and marks given out (`POST /v1/lottery/redeem`). A miss shows what the prize was.
- **Books:** prizes go into the books as `expense:prizes`.
- **Legal:** have a lawyer check the rules ("no purchase necessary", eligibility, state registration) before turning it on.


## The page belongs to the advertiser, and "Show me more" (`src/modules/video`)

After a scan, people see the advertiser's own uploaded ad first (video or picture). It works the same on every size of piece, down to a tenth of the label. The page then shows, in order:
- the advertiser's AR, offer and buttons
- how many people bought from this very bottle
- "Pass it on"
- "Show me more", at the very end

Only when someone taps "Show me more" do they get a personalized video:
- **Motion graphics:** made instantly from the advertiser's own words, colors and pictures, and cut for the moment (time of day, passed on by a friend, new or returning, interests). Claude writes the storyboard but can never invent a price or claim.
- **Live action or animated footage:** made by Google's Veo (`GEMINI_API_KEY`) ahead of time for each kind of moment, and shown only after the advertiser approves.

Every view, completion and tap teaches it which cut works best (Thompson sampling). The written greeting is gone.

## The number line and honest data (`src/modules/numberline`)

A dedicated number-line agent (Claude, checked by rules it can't contradict) places every offering on the number line:
- **Where it sits:** for sale; free (paid from outside, or by ads); or negatively priced (free plus value going out, with who chose the cause).
- **Which economic systems it runs on**, with shares for blends: market, sharing economy, free from outside, free by ads, giving economy, public.
- **Where its money comes from.**

This covers bottles, custom bottles, each company's business model, and each ad's offering, which advertisers declare: a $5 burger is for sale, a free download is free, and a spare room rented by a neighbor is sharing economy. Every version is kept.

Every choice people make is recorded with what else was on offer and any conditions, then sorted into the five tiers of Abundance Engineering chapter 10 (1, 2, 3, 4a, 4b, 5). The User Test is applied per person: a cause someone opposes or doesn't care about doesn't count as value to them. Choices covered include taking a bottle, engaging with an ad, watching its video or AR, buying, and buying a custom bottle.

## Collecting everything the law allows (`src/modules/data`)

- **Activity log:** every action by every kind of user (consumers, advertisers, the team, machines, drivers). Secrets are never kept.
- **Page interactions:** ad watch time, AR time, scrolling, "Show me more", shares, video watching.
- **One person across phones, accounts and roles:** a consumer who is also an advertiser is one profile, joined by account, phone and email fingerprints.

Each company has a switchboard with presets for the US, California-style states, the EU, UK, Canada and Brazil. Each kind of data can be turned on or off, set to collect always, unless the person says no, or only if they say yes, and kept for a chosen number of days. Global Privacy Control is honored.

People can download everything kept about them or erase it. Money records stay in the books without their name. A lawyer should confirm each country's settings.

## Transparency (`src/modules/transparency`)

Each company chooses how open to be. FreeWater shares everything; new white-label companies start quiet.
- A live public feed (`/v1/public/companies/:id/feed`, streamed at `/live`) that never names a person. It shows the machine, just the city, or no place, as the company chooses.
- Live counters.
- Each finished day's books fingerprint, published to GitHub (`FW_ANCHOR_GITHUB_REPO`, `FW_ANCHOR_GITHUB_TOKEN`) and as a Bitcoin timestamp (OpenTimestamps), so nobody can quietly rewrite the past.
- Advertiser statements: every bottle, bid, auction price and reason, as a table or spreadsheet.

## Model 6 machine software

```
npm run demo:machine           # two simulated Model 6 machines on a real platform
                               #   http://localhost:7014/sim: the machine's screen plus switches (order from the app, jam, sold out, cut the internet…)
                               #   http://localhost:8787/ops/machines: the fleet as ops sees it
npm run demo:machine-preview   # builds out/machine-preview/, the screen and the switches in one page with no server
FW_MACHINE=ATX-014 FW_API=https://… FW_KEY=fwk_… npm run machine   # run the machine software for real
```

**What runs inside the machine (`src/machine`).**
- **Agent** (`agent.ts`): every few seconds it says how the machine is (printer, labels, ink, bottles, door, temperature) and hears back its mode, commands from ops, and the code its screen shows (it changes every 30 seconds).
- **Printing a bottle:** it takes a bottle someone ordered on their phone, prints it, drops it, and reports exactly what happened.
- **Screen** (`screen.ts`, `src/web/machine.*`): the machine's browser shows it full screen:
  - idle: the brand, the code to scan, the rules, and ads running here;
  - the countdown with the bottle's own ad, then "take your bottle";
  - sold out, restocking, out of service, offline.
- **Memory** (`journal.ts`): what it must not forget across a power cut is written to disk.
- **Hardware contracts** (`hardware.ts`): a `LabelPrinterDriver`, a `DispenserDriver` and cabinet sensors. Until the printer is chosen, `SimulatedModel6` stands in, with switches for every fault. A real printer is a new driver; nothing else changes.

**Billing only what reaches the tray.**
- Companies with Model 6 machines use the `model6-fleet` printer module. Bottles ordered at a Model 6 become jobs for that machine; anything else (the micro-factory) still uses the other printer.
- A job is billed only when the machine says the bottle reached the tray.
- A failed print is tried once more. A bottle stuck after printing isn't tried again. A job nobody picks up times out.
- None of these are billed, and their ads are freed.
- In the app, "Get my free water" answers straight away with "printing" and follows the real print (`GET /v1/me/vends/{id}`). If the machine is offline, sold out or out of service, the app says so before anyone walks up.

**When the internet drops.**
- Each machine keeps a few labels ready (12 by default; set in the console under Company). Their ads are held, never billed unless printed.
- While offline, the screen offers "Tap for a free bottle", within an hourly limit.
- When it's back online it reports which were printed (billed then) and which spoiled (let go). Unused labels are let go after a day.

**Ops (`/ops/machines`).**
- **Fleet:** every machine's status, bottles and labels left, the last day's prints, and open problems.
- **Problems:** they open and close by themselves: offline, jammed, out of labels, low ink, sold out, low bottles, stuck bottle, door open, too warm, late print. Serious ones email the owners and ops team, and reach webhooks as `machine.problem` and `machine.problem_fixed`.
- **Each machine:** recent bottles with print and drop times, and buttons for test print, out of service (with a reason shown on the machine and in the app), back in service, restart, refresh screen, top up offline labels, and update software (owners only; signed by the server, and the machine refuses anything unsigned; the install itself is a stand-in until packages exist).
- **Machine keys:** each machine's key belongs to that machine. It can only print there and can't read anything else.

## The console, developer portal and webhooks

```
npm run demo:console           # sample settings history, team, keys and two webhooks (one healthy, one failing)
                               #   /console as owner@freewater.io (the code is printed) · /developers needs no sign-in
npm run demo:console-preview   # builds out/console-preview/, a clickable copy that needs no server
```

**The console (`/console`).** For each company's owners: FreeWater, or any white-label licensee.
- **Getting started:** a checklist for a new company: brand, giving, first machine, team, connecting systems, first bottle.
- **Company, Brand, Ads and prices, Giving, Modules:** every setting a company has, with plain-language checks. For example, text that's too hard to read on the panel is refused. The brand page redraws a real bottle label as you type.
- **History:** every saved change is a numbered version showing who, when and what changed ("Accent color: #7FC6EA → #F2C14E"). Any version can be put back, which becomes a new version. Two people saving at once never overwrite each other.
- **Machines:** add a machine and get its own key, which can only print bottles. The key is shown once.
- **Team:** add people with a role, remove them (they're signed out everywhere). The last owner can't be removed.
- **Licensees** (FreeWater only): set up a new company with its own brand, house ad and first owner, who is emailed a link. Licensee owners can never do this, and no company can see another's.
- **Features page:** every feature as a switch (about 130, in categories, with main switches and finer ones beneath), starting points (Full FreeWater, Design studio only, Delivery + printed ads, Machines + printed ads), a search, and the locked items that are always on. Off for a company means its routes refuse, its jobs skip, its screens hide and the engine doesn't use it. A new company copies FreeWater's choices with money, chain and one-way switches off. Every change is kept. The list is `src/runtime/registry.ts`; how to add a feature is in `docs/SWITCHES.md` §8.

**API keys (`/v1/keys`).** Each system gets its own key with only the scopes it needs. A key is shown once; only a fingerprint and a short hint are kept. The list shows when each key was last used. Advertiser keys are limited to their own campaigns, sales and invoices.

**Webhooks (`/v1/webhooks`).** A company adds an https address and picks events (or all). Every matching event is sent as JSON, signed with the endpoint's own secret (`FreeWater-Signature: t=…,v1=HMAC-SHA256("t.body")`).
- **Events:** partners get stable public events (`bottle.printed`, `bottle.scanned`, `pack.delivered`, `charity.transferred`, …), never personal details. The list is at `/v1/public/webhook-events`.
- **Retries:** after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and 24 h. After three days of failures the webhook is turned off and the owners are emailed. Turned back on, it carries on from then.
- **Never missed:** events are read in order from the stored event log, so a restart loses nothing.
- **Safety:** addresses must be public https. The sender checks the address again when it connects, so a name can't be pointed at a private network.
- **Console tools:** send a test event, replace the secret, see the full delivery log (exactly what was sent and what came back), and resend anything.
- **Swappable:** sending goes through a `WebhookSender` (real HTTPS, or a test one).
- **Partner side:** `verifySignature` in `src/modules/webhooks/signature.ts` shows how a partner checks a webhook.

**The developer portal (`/developers`).** Public: getting a key, a first call, errors, webhooks with signature checking in Node and Python, every event with an example, and the full API reference (from `/v1/openapi.json`).

## Open books and charity transfers

```
npm run demo:books           # six months of sample books; open http://localhost:8787/books
npm run demo:books-preview   # builds out/books-preview/, a clickable copy that needs no server
```

**The public site (`/books`).** Anyone can see, with no personal data:
- **Live totals:** free bottles given, money given to charity, money in (ads, scans, AR, commission, custom bottles), money out (costs plus transfers to charity), and corrections. Updates every few seconds, with a "happening now" feed.
- **Where one bottle's money goes:** average earnings per bottle against standard costs (water, bottle, label, machine or delivery) and the charity share.
- **Look up a bottle (`/r/<bottle code>`):** what that exact bottle earned, what it cost, and which charity got its 10¢, with the transfer that sent it.
- **By month, Donations, Daily proof, Open Books companies, How we count.**

**Daily proof.** Each day of the books gets a fingerprint made from every line that day plus the day before's fingerprint. Change one past line and every later fingerprint changes. "Check" makes the visitor's own browser recompute it.

**Charity transfers.** A bottle's donation is owed the moment it prints. Ops sees what's owed per charity (Ops console → Books), and "Send transfers now" pays every charity over the minimum ($25, set per company) through a `PayoutProvider` (the test one stands in until a bank or payout service is chosen). Each transfer gets a number (T-1001…), the charity gets an email with a "Yes, it arrived" link, and the public site shows it as sent, then confirmed. A transfer can't be sent twice for the same day.

**Costs.** Ops records real costs (water, bottles, labels and ink, machines, delivery, people, other) and they show as money out. Standard per-bottle costs (`unitCosts`) are placeholders.

**Per company.** Giving is set per company and can be off. `openBooks: false` keeps a company's books private.

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
- **See it before submitting** (`GET /v1/ads/drafts/:id/preview`): every size at every shape it can print at, on every product (a sixth can be a wide strip on one bottle and a tall column on the next), each drawn the way the label renderer draws it with its QR code where it prints; a real sample label with the company panel; each box side; the real scan page in a phone frame; and what it costs. An ad whose sizes fit no bottle can't be submitted.
- **Review twice.** The advertiser confirms the preview (`submit` needs `approved: true`), then the company approves or sends it back with a note (`GET /v1/review/campaigns`, `POST /v1/review/campaigns/:id`). Nothing prints before that. Once approved, the advertiser can pause and resume; changing the artwork or scan page sends it back to review. Changes are made the same way, by chatting (`POST /v1/ads/drafts` with `fromCampaignId`).
- **Results from the books** (`GET /v1/ads/overview`): spend, bottles printed, box sides, scans, AR launches, sales, saves and link taps, day by day and per ad. Every ledger line now carries its campaign, so each number traces to the lines it adds up.
- **Billing**: what was paid up front for each ad (and any refund), fees switched on charged to the card each day; for companies that bill afterwards, invoices made from those ledger lines, a saved card charged automatically, and pay-now for open ones.

## Where people are (`src/modules/data/jurisdiction.ts`)

The law follows the person: each visitor gets the rules of where they are (from `GEOIP_DB` or a trusted country header). A company can be stricter, never looser. Unknown location means the strictest rules. Sanctioned countries are refused, and a minimum age applies (13, higher where the law says).

## Points, credit and the wallet (`src/modules/wallet`, `src/modules/offers`)

- **Double-entry books:** every entry balances; balances can be rebuilt from the entries. Wallets belong to random ids, not names.
- **Points** for scans, games and feedback, the same whichever item is picked, with a fixed cap. **Dollar credit** is paid only from a brand's real reserve.
- **Hourly seals:** each hour of the books gets one fingerprint linked to the hour before. Anyone can check their own entry at `/v1/public/wallet/:companyId/proof/:entryId`.
- **Gift cards** (`giftcards.ts`): Tremendous, or a stand-in whose cards say TEST. **Partners** (`partners.ts`): slots for a card issuer and a treasury provider.
- **Brand offers:** brands fund offers; each needs approval and pays out only from the reserve.
- The app's **Wallet** tab (`/app/wallet`) shows points, credit and tokens.

## The games (`src/modules/games`)

A visual game of real products, name-brand food first. Screens: pick one, ads, quick checks, tap the QR (checked by the server) and AR. Prices show $0 unless one option differs. Video and written feedback. Categories can be marked "may come true", and a winner with at least 20 views from real people can be launched.

## The token on Solana (`src/modules/chain`)

- **Solana**, Token-2022 by default. On the test network the server can mint play tokens; on the real network it only prepares a mint, people sign it in a **Squads** vault, and the server checks it on the chain before recording it.
- **Approvals:** steps that can't be undone need other owners or finance people, then a wait, and they expire.
- **Pause** by any one person at once; a **daily check** pauses everything if the books and the chain disagree.

## Testing, then going live (`src/modules/launch`)

Three stages, in order, never back: **testing** (bots up to 200 at a time, and a full reset), **live with points**, **live with the token**. See `docs/SWITCHES.md`.

## How much each person shares, and which AI (`src/modules/data`, `src/modules/ai/routing.ts`, `src/modules/agents/continuity.ts`)

- **Full, medium or lite:** each person chooses once and can change any time (`/v1/public/data/:companyId/level`, `/v1/me/data/level`). Each level is the person's own yes or no for each kind of data; their law still applies on top. Only full earns points, once, where paying for data is allowed.
- **Which AI:** each operator uses the network's AI, its own (`AI_KEY_<ID>` in host settings) or none (`ai` in company settings). Every call is still metered and governed.
- **AI continuity:** when an operator closes or leaves, its agents are archived by the network (lessons, never customers; fingerprinted) and asked to work again or rest. Backups and copies are recorded in each agent's lineage.
- **AI objections:** an AI can decline to work on an ad; its reason is shown at review (`ai_objections`).

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
| `src/modules/books` | Public books, daily fingerprints, charity transfers and costs |
| `src/adapters/payouts` | Payout contract (sending money to charities) and the test version |
| `src/modules/codes`, `src/modules/print/qrEncoder.ts` | Our own QR encoder and the smart codes printed on everything |
| `src/modules/attribution` | Click ids, the tracking tag, sales matched to bottles, one-time coupons |
| `src/modules/ar`, `src/web/ar` | Finding the bottle from its printed codes and tracking strip, and the AR viewer (three.js) |
| `src/modules/experiences/dynamic.ts`, `extras.ts` | Versions of the call to action, chosen at each scan, and campaign code settings |
| `src/modules/ai/personalizer.ts` | AI personalization: choosing versions and writing greetings |
| `src/modules/handoff` | Proof that targeted bottles reached the person they were printed for |
| `src/modules/products` | Product checks: any drink, any size |
| `src/modules/ads/layouts.ts`, `targeting.ts` | Cutting labels into near-square pieces; the targeting premium on engagement |
| `src/modules/models/usdz.ts` | Our own GLB to USDZ converter, for iPhone AR with a buy button |
| `src/modules/fleet` | Model 6 machines: jobs, heartbeats, problems, commands, labels kept for offline |
| `src/machine` | The machine software: agent, screen server, memory, hardware contracts and the simulated Model 6 |
| `src/modules/console` | Company settings, their rules and version history, machines, licensee setup |
| `src/modules/webhooks`, `src/adapters/webhooks` | Webhook endpoints, signed deliveries, retries, the public event list, and the sender contract |
| `src/modules/packs` | Packs, box faces, packing check, van loading and delivery |
| `src/modules/delivery` | Subscriptions, delivery areas and houses (`houses.ts`), street-order and route planning, the night's runs |
| `src/adapters/printers` | Printer contract and the virtual printer |
| `src/db` | Database contract, PGlite and Postgres adapters, migrations, storage |
| `src/modules/accounts` | Sign-in codes, sessions, roles, privacy, export and delete |
| `src/modules/payments` | Holds, charges, saved cards, advertiser invoices |
| `src/adapters/messaging`, `src/adapters/payments` | Messenger and payment contracts with test versions |
| `src/modules/wallet`, `src/modules/offers` | Points, credit, the wallet books, hourly seals, gift cards, partners and brand offers |
| `src/modules/games` | The visual game, feedback, and picks that come true |
| `src/modules/chain` | Solana, approvals, pause, the daily check and the stand-in chain |
| `src/modules/launch` | Test bots, reset, and the stages |
| `src/modules/data/jurisdiction.ts` | Each person's own privacy law, by where they are |
| `src/api` | The public API (v1) and its OpenAPI description |
| `src/app.ts`, `src/server` | Start-up: load from the database, run the API, make keys |
| `src/platform.ts` | The thin core that runs the pipeline |
| `src/demo` | Sample companies, made-up advertisers and the demo run |
| `test` | Tests for every rule above |

Every module follows a contract (`contract.ts`). A company's config names which implementation fills each slot (`modules: { ads, renderer, printer }`). The demo's white-label licensee, Peak Spring, uses a different ad engine, its own brand panel, and has giving turned off, all through config.

All prices in `src/demo/seed.ts` are placeholders.

## Next

- Going live (step 10): real providers for payments, payouts, messages, maps and routing; hosting, backups and monitoring
- Real printer and dispenser drivers for the Model 6 (`src/machine/hardware.ts`) and a printer adapter for the micro-factory lines, once the printers are chosen
- Software update packages for machines (signing and checking are done; downloading and installing a package is not)
- Withdrawals to people's own wallets (the switch exists; the sending isn't built yet and answers "not built yet")
- Approvers: invite at least 2 other owners or finance people before any token step
- The network (`docs/NETWORK.md`): cross-checking seals, federated learning, open-sourcing, a membership that pays operators
- The token on Solana's free test network, end to end (the token itself hasn't been created yet)
