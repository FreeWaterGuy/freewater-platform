# Going live: what's ready, and what's left

## Ready (built and tested)

- **Nothing is lost in a crash or a database outage.** Every change is saved before the platform answers, and
  changes made together are saved together. If the database refuses, changes wait in order (also on disk) and go in
  by themselves when it's back. Meanwhile the platform pauses new changes and background work, and scans still work.
- **No double payments.** Only one server can own the data at a time; a new version takes over in about a second.
- **Background work in one place.** It remembers what it did across restarts, and alerts when something fails.
- **File storage**, with every file checked when it's read back.
- **Health checks, a status page, and alerts** to a chat channel or email.
- **Daily encrypted backups**, and a weekly test that restores one and checks the books.
- **A deploy image and automatic checks on every change**: types, all tests, security holes, the image starting
  against a real database, a second copy refused, and a backup restored.
- **A first-run setup** for an empty database: `npm run setup -- --owner you@freewater.io`.
- **Privacy.** People can download and delete their data. Phones without an account can erase what they did.
  Contact details never go in the activity log.
- **Load-tested.** One server handled about 550 requests a second (roughly 9 million scans a day) with no errors.

## For you to sign up for (then send the keys to whoever sets the server up, never by email or chat)

1. **Hosting** for the server (any that runs a Docker image: Render, Fly.io, Railway, AWS, Google Cloud). One server
   with 4–8 GB of memory is plenty for the pilot.
2. **A managed Postgres database** (version 16 or 17) with automatic backups and point-in-time recovery, plus a
   small spare one for the weekly restore test. Most hosts above offer both.
3. **File storage**: two buckets on S3-compatible storage, one for files and one for backups. Cloudflare R2 is
   cheapest; Amazon S3 works. Turn on "object lock" or a 30-day retention rule on the backups bucket.
4. **The domain** (freewater.io): point it at the server, with https.
5. **An alert channel**: a Slack or Discord channel's incoming-webhook address.
6. **Payments**: a Stripe account (cards for custom bottles and advertisers' invoices).
7. **Payouts to charities**: Stripe Connect, or your bank's transfer service, and the charity's bank details.
8. **Email and texts** for sign-in codes and receipts: e.g. Postmark or Resend for email, Twilio for texts.
9. **Address lookup** for home delivery: Google Maps or Mapbox.
10. **AI keys**: Anthropic (Claude), and Google (one key covers Veo for live-action video and Imagen for ad photos
    made to order: `GEMINI_API_KEY`).
10b. **For the ad studio**: a free Unsplash developer key (`UNSPLASH_ACCESS_KEY`) and/or Pexels key (`PEXELS_API_KEY`)
    for the photo library; and, when chosen, a photo-to-3D service for custom AR (until then, a product photo becomes a
    standing photo card in AR). Before real labels print with library photos, confirm their terms cover printing on
    packaging (a question for the lawyer below).
10c. **Where visitors are** (so each person's own privacy law applies to them): MaxMind's free GeoLite2 City file
    (sign up, download it weekly, set `GEOIP_DB` to its path), or a host that adds a country header (Cloudflare: set
    `TRUST_GEO_HEADERS=1`). Without either, everyone gets the strictest (European) rules. The lawyer should confirm the
    country rules in `src/modules/data/jurisdiction.ts`, the minimum ages, and the sanctioned-country list
    (`SANCTIONED_COUNTRIES`, default Cuba, Iran, North Korea, Syria).
10d. **Reading receipts**: a Veryfi account (`VERYFI_CLIENT_ID`, `VERYFI_USERNAME`, `VERYFI_API_KEY`). Without it,
    your team checks receipts by eye.
10e. **Gift cards**: a Tremendous account with a funding source (`TREMENDOUS_API_KEY`, `TREMENDOUS_FUNDING_SOURCE`;
    `TREMENDOUS_SANDBOX=1` to try their test site first). Without it, a stand-in makes cards that say TEST.
10f. **Solana**: first a free test-network setup (`SOLANA_DEVNET_MINT`, `SOLANA_DEVNET_PAYER`,
    `SOLANA_DEVNET_MINT_AUTHORITY`) to try the whole flow with play money. For the real network: a **Squads** vault
    (squads.so) whose keys are held by at least 3 trusted people, the token created with the vault as its only minter,
    a paid RPC provider (`SOLANA_RPC_URL`), and `SOLANA_MINT`, `SOLANA_PAYER`, `SOLANA_CUSTODY` (the vault). Never put
    a minting key for the real network on the server: it's refused.
11. **The label printer** for the machines, once it's chosen.
12. **A GitHub token** for publishing each day's books fingerprint (optional, but it's what makes the books provable).

## The launch order

**Launch with `FW_FEATURES=pilot`** in the host's settings. The pilot runs only the core loop (bottles, ads, scans and
AR, attribution, the app with points, delivery, the portals and consoles, giving and the open books, data rights,
machines, the games) and takes the token, gift cards, withdrawals, money partners, the AI agents' fund, the operator
network, the prize game, Veo footage and brand offers out of the server entirely (`docs/RUNNING.md`, *The pilot*). So
for the pilot you don't need items 10e (gift cards) or 10f (Solana), Veo in item 10, or approvers for token steps;
steps 4's offers and gift cards and step 5 below wait until those areas are switched back on with a restart.

The full guide to every switch is `docs/SWITCHES.md`. In short:

1. **Invite approvers.** Under *Team*, add at least 2 other owners or finance people. Only people already on the team
   when a step is proposed can approve it. Turn on the second sign-in step for owners (*Security*).
2. **Test.** In *Launch*, run bots, look at everything, reset, repeat. Try the blockchain on Solana's test network.
3. **Go live with points.** *Launch → Propose going live* (only you), wait 24 hours, run it. Test data is wiped.
   This can't be undone.
4. **Turn on money one switch at a time** as each is ready: record brand reserves, then dollar credit, then brand
   offers (each approved), then gift cards (needs approvals).
5. **The token, after the lawyer signs off.** *Launch → Propose going live with the token*: 2 approvals and the wait.
   Then conversions and minting, each signed in Squads. Withdrawals last (not built yet).

To stop anything: *Blockchain → Pause now*, or turn the switch off. Off is always immediate.

## Then wired in (code, once you've chosen)

Items 6–11 each need a small connector written against the provider you pick: payments, payouts, email/text,
address lookup, the printer driver. The platform already has the slot for each one, and stand-ins for testing.
Expect roughly a day each, with tests, once the account exists. Until payments, payouts and email/text are wired,
production only starts with `ALLOW_STANDINS=1` (a staging rehearsal); going live means removing it.

## Also before real money flows

- **A lawyer**: the token (before going live with it), gift cards and points rules, terms of service, privacy policy, advertising rules, the prize game's rules, and the trust that would
  hold the AI agents' 10%.
- **Insurance** (general liability, cyber).
- **An outside security test** (a "pen test") of the live setup.
- **Real numbers** in the console: the costs per bottle (water, bottle, label, machine) are placeholders today, as
  are the AI model prices.
- **A rehearsal**: set it all up on a test copy first (a "staging" server), run the load test there, print and scan
  real bottles, restore a backup, and practice a deploy.

## Later (not needed for the pilot)

One server carries the pilot. At about 1,000 bottles a day, a server with 8 GB lasts well over a year. The memory
alert warns weeks ahead. Past that, or to run several servers at once, the next stage moves the working state out of
memory and into the database. See the end of `docs/RUNNING.md`.
