# Threat model

What FreeWater has worth protecting, who can reach it, what protects each thing today, and where the gaps are.
Refreshed on every review run by the security architect (`.claude/agents/security-architect.md`).

- **Updated 2026-10-22** (branch `s-fix`, a second reviewer's ten findings: rows A12, A14, A15, A16, N2 and the new
  N6–N8 below; docs/REVIEW-LOG.md, "security architect (second opinion fixes)").
- **As of:** 2026-10-21, release check on branch `r-sec` (after `57ca8fd`: the Features registry, prepaid payments,
  delivery areas, route buying, news, fillers, household data, photo proof, paid-ad review by people and the AI reviewer's
  final call; about 14,000 new lines). The 2026-10-20 review (branch `t0`, `9c58d43`) is the base for sections 1–5.
- **Method:** STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of
  privilege) applied to each asset and each trust boundary; every API route checked against what the docs say.
- **Evidence:** "CONFIRMED" means a probe against the real server (PGlite, demo seed, `server.inject`) showed it
  during this review; the probe was a scratch file and was not kept, so each confirmed item still needs a permanent
  test from the specialist who fixes it. "PLAUSIBLE" means the code reads that way; each says what would prove it.
- **This step fixed what it found** (each with a test shown failing on the old code; `docs/REVIEW-LOG.md`, "security
  architect (release check)"). Section 5a lists the new code's risks.

---

## In plain words

**Release check, 2026-10-21.** The new things to protect are advertisers' prepaid money and the route spots it reserves,
houses (their addresses, status, household size) and who claimed them, photos of boxes at people's doors, bought
household data, each company's switches, and the switch that lets the AI reviewer reject paid ads on its own. Most of
the new code checks who is asking well: money steps, refunds and the AI's switch need a person (and the second step),
houses are only changed by ops people, photos are re-encoded and shown only to the team and the house's claimant, news
stays off unless the host and then a person turn it on, and a company can't turn on what the host switched off. Five
gaps were found and fixed: **any company API key could approve a paid ad** (and switch one on, or change what one
shows), though the locked rule is that a person checks every ad; **any company key could flip switches kept in the
settings** (open books, the live feed, the games), though a key never changes a switch; the **five-wrong-tries limit on
claiming a house** could be passed by sending tries at once; the **check for names and addresses on ads aimed at a few
houses** skipped the ad's alternative versions; and a **route ad could be copied as a free filler** onto bottles
anywhere. What's left for the founder (section 5a): whoever can read a box on a porch can claim the house and then see
photos of later drops at that door, with no expiry or notice; a company key can still charge an advertiser's card for a
new buy; and ads billed afterwards are still approved by company keys.

**The 2026-10-20 review:**

FreeWater's most valuable things are: advertisers' money (what we bill them), the money we owe charities, people's
points and credit (later the token), people's personal details, the settings and safety switches, and the keys that
open all of it.

**What is in good shape.** The basics are strong. Every request is checked for a valid key or sign-in, and each key
only sees its own company. The money books can only be added to, never edited, and the database itself enforces that.
Card numbers never reach us. Sign-in has no passwords to leak. Anything that can't be undone with the token needs two
other people who were already on the team, then a wait of a day or two, and anyone can press pause. Scans are billed
only after a real code was opened. Uploaded files and ad artwork are checked before they are kept, and the web pages
refuse to run any script we didn't ship. Webhooks can't be pointed at our own network. Backups are encrypted.

**What worries me most (the first five of fifteen below):**

1. **A computer key can make itself a person.** The rules say only a signed-in person can touch money, giving or the
   blockchain. But a company key with `admin` (including the all-powerful key printed at setup) can add a new
   *owner* by email. Whoever reads that inbox signs in and has every person-only power. We showed this: a key added
   an owner, and that owner then recorded money into a brand's reserve.
2. **The "where is this visitor" setting can be faked.** Production requires `TRUST_PROXY`, and the guide says to set
   it to `1`. With `1`, a visitor can simply claim any internet address. Every per-address limit (sign-in tries,
   request limits, blocking bad keys, points per household, how many billable scans one network gets) then stops
   working. We showed sign-in limits being skipped this way.
3. **Fake scans can still bill advertisers.** A billed scan needs a token from opening a real printed code, rationed
   per internet address. Someone with one bottle and many addresses (cheap to rent, or free with item 2) can bill an
   advertiser for every scan. There is no per-ad daily ceiling or alert for this.
4. **The people who approve irreversible steps sign in with only an email code.** The second sign-in step is off by
   default, and even when turned on it is only required of owners, never of finance people, who also approve token
   steps. A taken-over inbox is a taken-over approver.
5. **A safety limit can be switched off by a key.** Machines' print limits (6 a minute, 1,500 a day) protect
   advertisers from a stolen machine key. Any `admin` key can change them to any value, even nonsense that turns the
   limit off. We showed this.

**What to do first:** make adding owners and finance people (and making `admin` keys) a person-only action; change
`TRUST_PROXY` guidance to the load balancer's address or hop count and refuse `1` in production; add a per-ad
daily ceiling and alert on billed scans; require the second sign-in step for every owner and finance person before any
token step; and check the print-limit settings like every other safety limit.

None of this needs the business to change, only tighter checks. The full list, with who should fix each, is in
section 5. The table of every API route and whether it matches the docs is in section 6: 354 routes, 13 that don't
match or that the docs leave unclear.

---

## 1. Assets

| # | Asset | Where it lives | What losing it means | Main protection today |
|---|---|---|---|---|
| A1 | **Advertiser billing**: ledger lines, invoices, commission | `ledger_entries` (append-only), `src/modules/ledger/ledger.ts`, `src/modules/payments/service.ts:runInvoices` | Over- or under-billing; advertisers stop trusting results | Billing only on confirmed events (`Ledger.onPrinted`, `onEngagement`); DB trigger `forbid_change` (`src/db/migrations.ts`); invoice lines used once |
| A2 | **Payments and cards**: holds, captures, saved card references | `payments`, `payment_methods`; provider behind `src/adapters/payments` | Charging people wrongly; card data exposure | Card numbers never reach us (`PaymentsService.addMethod` keeps a token, brand, last 4); hold → capture only what printed (`authorize`, `capture`, `void`); idempotency keys |
| A3 | **Charity money and brand reserves** | `charity_transfers`, `charities`, wallet `reserve:*` accounts | Paying the wrong amount or the wrong party; credit paid from thin air | `BooksService.runPayouts` (one per charity per day, under `withCharityLock`); `WalletService.fundReserve` (person-only); credit never above reserve (`giveCredit`) |
| A4 | **Points, dollar credit, gift cards** (later: the token) | `wallet_tx`, `wallet_lines`, `wallet_balances` | Points farmed or stolen; credit spent by someone else | `WalletService.earn` (per action, per day, per network, per bottle limits; cap); gift cards behind an approved step (`buyGiftCard`); corrections by person (`correct`) |
| A5 | **The token and chain approvals** | Solana (Token-2022), Squads vault, `chain_actions` | Tokens minted or moved without consent | `ChainService.propose/approve/run` (2 other approvers who held the role before the proposal, a wait, expiry), `confirmSigned` (checked on chain), `pause` (anyone, at once), `reconcile` (daily check pauses on mismatch); minting key refused (`src/modules/chain/solanaEnv.ts`) |
| A6 | **Personal data**: email, phone, name, interests, location, addresses, activity, photos and videos people upload | `users`, `activity`, `data_*`, `delivery_subscriptions`, assets | Privacy harm, legal exposure | Company scoping on every query; `DataService.allowed` (per-category rules, per jurisdiction, GPC); `erase`, `exportData`; request log keeps paths only (`src/api/logging.ts:pathOnly`); activity bodies masked (`server.ts:logActivity`); public books anonymised (`BooksService.publicLine`) |
| A7 | **Advertisers' budgets, campaigns and results** | `campaigns`, attribution tables | Budgets drained by fraud; one advertiser seeing another's results | `campaignFor` (advertiser keys see only their own); scan tokens (`ScanTokens.issue/use`); tag-reported sales never billed (`AttributionService.conversion`); content review before printing |
| A8 | **Settings and safety switches**: giving, ratchets, minimum age, data rules, launch stage, print limits | `companies` + settings history | A safety governor removed; giving or rules quietly lowered | `checkSettings`, `ratchetProblem`, `chainProblem`, `walletProblem` (`src/modules/console/settings.ts`); `personOnlyKeys`; every change versioned (`ConsoleService.save`) |
| A9 | **Keys and secrets**: API keys, sign-in sessions, second-step seeds, code-signing secrets, provider keys | `api_keys`, `sessions` (hashes only), `platform_secrets`, host environment | Full takeover | Keys and sessions stored only as SHA-256 hashes (`src/db/store.ts:findApiKey`, `AccountsService.userFromToken`); keys shown once; `checkConfig` refuses unsafe production settings |
| A10 | **Honest data and open books**: events, daily fingerprints, hourly seals, number-line tiers | `events` (append-only), fingerprints, seals, published to GitHub / Bitcoin | Rewriting the past undetected | Append-only trigger on `events`; daily fingerprints chained and published (`src/modules/transparency/anchors.ts`); hourly seals (`ChainService.seal`, `checkSeals`) |
| A11 | **AI agents' funds, memory and autonomy** | agents' ledger lines, archives, autonomy levels | AI acting beyond what people allowed; fund misspent | `governor.ts:judge` before every call; proposals decided by a person (`/v1/agents/proposals/:id/decide`); fund only rises once on (`ratchetProblem`); archives fingerprinted (`continuity.ts`) |
| A13 | **Prepaid balances and orders** (new) | `ad_orders`, ledger `prepaid:advertiser:*` (a liability), `route_settlements`, `route_credit_uses` | Charging the wrong amount, refunding twice, printing unpaid | Server-side price only, charged only if it equals the total seen (`PrepaidService.payBottles`, `RouteBuyService.pay`); one order per ad (DB rule); refunds and stops by owner or finance with the second step (`approvalRoutes`); settlements append-only |
| A14 | **Reserved route spots** (new) | `route_spots`, `route_buys` | Oversold bottles, an ad printed at houses that blocked it | Reserved under a lock per house and week inside the paying transaction; `route_spots_room` trigger; blocks honored at print (`forPack`) |
| A15 | **Houses and claims** (new) | `houses`, `house_claims`, `house_events` (append-only), `house_ad_blocks` | A stranger stops a house's water, blocks its ads or sees its drops; a house's record grows into a profile; one door as two houses gets two boxes | Claim needs a recent box's whole code (`HouseService.claim`; the corner number refused; 5 wrong tries a day under a lock); a new claim is shown to earlier claimants and the team, a stop by a claim under 7 days old is flagged, claims lapse after 12 months unused, photos only from the claim on; one address form everywhere (`src/core/address.ts`) and duplicates merged at start (`rekeyHouses`); ops changes by an ops person or owner (`needOpsPerson`); a person's link erased with their account (`DataService`) |
| A16 | **Drop photos** (new) | `drop_photos` (bytes or blob), purged after the company's keep | Pictures of people's doors leaking; a photo that doesn't prove the drop | Re-encoded without metadata (`DropPhotoService.put`); team persons (`GET /v1/ops/drop-photos/:id`) and the house's claimant from their claim on (`residentMay`); never at a public address; `no-store`; purged after 90 days unless set. As proof: only after the door scan (`seq` past the scan's), the app's camera, within 150 m when the phone gives a place (else *unverified location*) |
| A17 | **Household and area data** (new) | `household_*`, area statistics | Bought data about homes misused or kept after opt-out | Import by a person only, sensitive kinds refused (`HouseholdService.importHouseholds`); public opt-out with the same answer either way; deletes are immediate; advertisers never see a house's audience |
| A18 | **The AI reviewer's final-call switch** (new) | `company_features` (`ai_ad_final_call`), bar and sample | An AI rejecting ads alone without having earned it, or turning itself on | Only on its own page by an owner with the second step on the record (`AiReviewService.turnOn`); never through the Features page (`ownPage`), never a key; the governor turns it off |
| A19 | **Each company's switches** (new) | `company_features`, `company_feature_log` (append-only), linked settings | A switch flipped by a key, or a company turning on what the host forbids | `FeatureService.change` (an owner signed in; money/chain/one-way: the second step; host areas refused); linked switches only by a person (`ConsoleService.switchesChanged`, fixed in this check) |
| A12 | **Machines, stock, labels, packs and deliveries** | Model 6 fleet, micro-factory, vans | Bottles printed and billed without a person; wrong box left; machine hijacked | Machine keys bound to one machine (`unitFor`, `machine.ts:mine`); print cap (`server.ts:printCap`); pack checks (`PackService.verify/seal`); right box at right door (`PackService.deliver`) |

---

## 2. Who acts on the system

### 2.1 Actors

| Actor | How they prove who they are | What they can reach |
|---|---|---|
| **Visitor / phone** (no sign-in) | Nothing; a random viewer key kept in the phone (`fw_viewer`) | Every `public` route: scan pages, scans, interactions, the games, the wallet and offers *of the viewer key it holds*, data choices, open books |
| **Consumer** (signed in) | 6-digit code by email or SMS → `fws_` session token (30 days), stored as a hash | Scope `me`: own account, bottles, vends at a machine (with the screen's presence code), custom bottles, cards, delivery, wallet |
| **Advertiser staff** (signed in) | Same sign-in; role `advertiser`, tied to one advertiser | `campaigns`, `purchases`, `invoices`, `me`; only their own advertiser's data |
| **Team: owner** | Same sign-in; optional authenticator second step (`SecondStep.pass`), required only if the company turns it on | `admin` (everything a company does for itself) + all other company scopes + `me`. FreeWater's owners also get `platform` |
| **Team: finance** | Same sign-in; second step never required | `ledger`, `events`, `invoices`, `me`; may propose, approve and pause token steps |
| **Team: ops / reviewer / driver** | Same sign-in | ops: `orders`, `packs`, `events`; reviewer: `campaigns`; driver: `packs` |
| **Company service key** (`fwk_`) | Bearer key, stored as a hash, no expiry | Whatever scopes it was given (any of `orders`, `packs`, `campaigns`, `purchases`, `ledger`, `events`, `invoices`, `webhooks`, `admin`); never `platform` from the console. Person-only routes refuse it |
| **Setup platform key** | Printed once by `npm run setup` | All scopes **including `platform` and `admin`** for FreeWater. The single most powerful credential |
| **Advertiser key** | Bearer key with `advertiserId` | Only `campaigns`, `purchases`, `invoices`, and only that advertiser |
| **Machine key** | Bearer key with `locationId`, scope `orders` | Print only at its own machine (capped), read only its own bottles and screen code, Model 6 heartbeat/jobs |
| **White-label company** | Its own keys and team | Only its own company's data; never `platform`; starts in testing with money, chain, offers and AI fund off |
| **AI agents** | Code inside the server; no credential | Propose only; every call metered and checked by the governor; act alone only where the autonomy ladder allows. The AI reviewer of paid ads (066) flags, and rejects alone only where a company's owner turned on *AI makes the final call* on its record (`src/modules/ads/aiReview.ts` `turnOn`); appeals, audits, approvals and refunds stay with people; its switch, bar and sample are changed only by people (`src/api/aiReview.ts` `person`), and the governor turns it off when its agreement drops (`AiReviewService.governor`) |
| **Resident who claimed a house** (new) | A consumer sign-in plus a code from a box delivered to that house in the last 60 days (or its box number with the house number) | Their house's status (stop, restart, household size), ads that came there and blocks, photos of drops there. Anyone who can read a box's whole code on the porch can become one (N2): earlier claimants and the team are told, a fresh claim's stop is flagged, claims lapse, and no photos from before the claim |
| **Outside providers** | Our keys in the host environment | Payments, payouts, email/SMS, Anthropic, Google, Tremendous, Veryfi, photo libraries, GitHub, OpenTimestamps, S3, Solana RPC |
| **Partners** | Webhook signing secrets; remote plug-in shared secret | Receive signed webhooks; answer scan-page plug-in calls (data only, 300 ms) |
| **Charities** | Emailed confirm token | Confirm a transfer arrived |

### 2.2 Roles and scopes (from `src/modules/accounts/service.ts:roleScopes`)

| Role | orders | packs | campaigns | purchases | ledger | events | invoices | admin | me |
|---|---|---|---|---|---|---|---|---|---|
| consumer | | | | | | | | | yes |
| owner | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| ops | yes | yes | | | | yes | | | yes |
| finance | | | | | yes | yes | yes | | yes |
| reviewer | | | yes | | | | | | yes |
| driver | | yes | | | | | | | yes |
| advertiser | | | yes | yes | | | yes | | yes |

`admin` passes every scope check except `platform` (`server.ts:authenticate`). Routes that must be a person call a
helper that refuses keys without a `userId` (`me`, `person`, `fwPerson`).

---

## 3. Trust boundaries

| # | Boundary | What crosses it | How it is guarded |
|---|---|---|---|
| B1 | **Browser / phone ↔ server** | Public scan and game writes, sign-in, `me` calls, console and portal calls | Fastify schemas (`additionalProperties: false`); `authenticate`; rate limits (`RateLimiter`, `BadKeyGuard`); strict CSP per page and `securityHeaders` (`src/api/security.ts`); CORS `*` only on `/v1/public/*` (no cookies used) |
| B2 | **Machine ↔ server** | Orders, heartbeats, jobs, offline reports, commands | Machine key bound to a location; `printCap`; `FleetService` job states; machine journal on disk |
| B3 | **Server ↔ outside providers** | Money (payments, payouts, gift cards), messages, AI prompts, photos, anchors, files | Contracts with stand-ins; `checkStandIns` refuses stand-ins in production unless `ALLOW_STANDINS=1`; idempotency keys; AI answers checked by code; provider keys only in env |
| B4 | **Partners ↔ server** | Advertiser server calls, the tag, webhooks out, remote plug-ins | Advertiser keys; tag sales unverified until confirmed; `checkWebhookUrl` + `guardedLookup` (no private addresses, checked again on connect); HMAC signatures; plug-ins return data blocks only |
| B5 | **Company ↔ company** (white-label) | Every query | `key.companyId` on every lookup (`unitFor`, `packFor`, `campaignFor`, `invoiceFor`, SQL `company_id = $1`); `platform` scope never grantable; new licensees start safe |
| B6 | **Server ↔ database** (and spool, backups) | Every change | One writer at a time (`InstanceLease`, `leaseChecked`); append-only triggers on `ledger_entries`, `events`; TLS required in production (`checkConfig`); encrypted backups (`src/runtime/backup.ts:encryptFile`) |
| B7 | **Server ↔ Solana** | Seals, mint checks, daily reconcile | Payer key pays fees only; mints signed by people in Squads; `confirmSigned` checks memo, amount, destination, authority |
| B9 | **Porch ↔ app** (new) | A box's printed code proves "this is my house" | 60-day window, company match, 5 wrong tries a day under a lock; the code is on the outside of the box (N2) |
| B10 | **Host ↔ company switches** (new) | `FW_FEATURES`, `FW_FEATURES_ON` against each company's Features page | The host is the outer limit (`FeatureService.whyOff` checks the host first; `plan` refuses); off-host routes are never registered; news needs the host and then a person (`news.on`, person-only) |
| B8 | **Load balancer ↔ server** | Visitor address (`X-Forwarded-For`), country headers | `TRUST_PROXY`, `TRUST_GEO_HEADERS`. **Weak: see R2** |

---

## 4. STRIDE: threats and controls

Status: **OK** (a control exists and was read), **PARTIAL** (a control exists but has a gap, with the risk number),
**MISSING**.

### 4.1 Assets

| Asset | | Threat | Control (file:function) | Status |
|---|---|---|---|---|
| A1 Billing | S | Forged scans / AR launches billed | `src/modules/codes/scanTokens.ts:ScanTokens.issue/use` (one-time token from a real code open, rationed per network) | PARTIAL (R3, R2) |
| A1 | S | Forged sale reported by a website tag | `src/modules/attribution/service.ts:conversion` (tag sales unverified, never billed alone) | OK |
| A1 | T | Ledger line edited or deleted | `src/db/migrations.ts` trigger `forbid_change` on `ledger_entries` | OK (app DB role can still drop it: R9) |
| A1 | T | Same order, refund or scan billed twice | event idempotency keys (`platform.bus.publish`), `server.ts:sale` refund keys, `Ledger` repeat window | OK |
| A1 | T | Revenue booked with no money behind it | `server.ts` `POST /v1/orders` prices custom bottles server-side but takes no payment | **MISSING** (R10, CONFIRMED) |
| A1 | R | Who billed what can't be shown | every line carries its event and campaign (`Ledger.add`); advertiser statements (`transparency/statements.ts`) | OK |
| A1 | I | One advertiser reads another's lines | `campaignFor`, `invoiceFor`, `payments.invoices(companyId, advertiserId)` | OK |
| A1 | D | Billing stalls when the DB refuses writes | persistence queue + spool, pause mode (`RUNNING.md`) | OK |
| A1 | E | Machine key prints (and bills) at scale | `server.ts:printCap`, with offline labels counted toward the same daily cap and `offlinePerHour` held on the server (`fleet/printCap.ts`, `FleetService.refillBuffer`/`offlineReport`) | PARTIAL (R5: limit editable to anything) |
| A2 Payments | S | Someone pays with another's saved card | cards scoped `(companyId, ownerType, ownerId)` (`PaymentsService.methods`); `me` routes need a person | OK |
| A2 | T | Price changed by the caller | price from proof / company (`consumer.ts` `POST /v1/me/custom-orders`) | OK |
| A2 | R | Charge without record | every payment is a ledger line (`Ledger` `payment`), `repairUnrecorded` | OK |
| A2 | I | Card data stored | provider token only, brand + last 4 | OK |
| A2 | D | Hold never released | `void` on failure, `recoverStuck` | OK |
| A2 | E | Finance key pays any invoice | invoice paid only with the advertiser's saved card (`payInvoice`) | OK |
| A3 Charity & reserves | S | Fake charity confirms a transfer | emailed token (`BooksService.confirm`) | OK |
| A3 | T | Same day paid twice | `runPayouts` one per charity per day, `sending` re-asked with same idempotency key | OK |
| A3 | T | Charity owed money for revenue never collected | see A1 "revenue with no money behind it" | **MISSING** (R10) |
| A3 | T | Money-out lines lower the profit share to charity and agents | `/v1/books/expenses`, `/owner-payouts`, `/reinvestments` need only a team key | PARTIAL (R11) |
| A3 | E | Credit paid without real reserve | `fundReserve` person-only; `giveCredit` never above reserve | OK |
| A3 | E | Service key approves offer payouts | `/v1/offers/:id/approve`, `/v1/offers/receipts/:claimId/review` check team, not person | **MISSING** (R7) |
| A4 Wallet | S | Points farmed with many viewer keys | `WalletService.earn` per-network (`sourceOf`) and per-bottle limits | PARTIAL (R2, R3) |
| A4 | S | Someone spends another phone's points | the viewer key is the only secret (`/v1/public/offers/.../claim`) | PARTIAL (R15) |
| A4 | T | Balance edited | double entry, `wallet/check` rebuilds balances; corrections by person (`correct`) | PARTIAL (journal not DB-enforced append-only: R9) |
| A4 | R | Who corrected an entry | `correct(…, by)` records the person | OK |
| A4 | I | Wallet tied to a name | wallets keyed by random ids / hashed references (`hidden`) | OK |
| A4 | E | Gift cards on without approvals | `exchanges_on` chain action (approvals + wait); `walletProblem` | OK |
| A5 Token | S | Approver impersonated | approvals need a signed-in owner/finance person who held the role before the proposal (`heldApproverRole`) | PARTIAL (R4: email-only sign-in) |
| A5 | T | Server mints alone on mainnet | minting key refused; `confirmSigned` checks the Squads-signed tx | OK |
| A5 | R | Who approved | approvals stored with person ids; alerts on every proposal/approval | OK |
| A5 | I | Chain keys leak | keys only in env; payer can only pay fees | OK |
| A5 | D | Stop everything at once | `ChainService.pause` (any owner/finance, no wait); `reconcile` auto-pause | OK |
| A5 | E | Service key or AI runs a token step | `chain.ts:person` on propose/approve/run/cancel/signed | OK (R1 fixed: a key can no longer create a person) |
| A6 Personal data | S | Sign-in code guessed | 5 tries per code, 3 sends per 10 min per destination, 10/min per address (`limits.signIn`) | PARTIAL (R2: per-address part spoofable) |
| A6 | T | Profile changed by someone else | `me` routes only touch `key.userId` | OK |
| A6 | R | Consent changes unrecorded | `DataService.consent` keeps reason and time | OK |
| A6 | I | Personal data in logs | `pathOnly`; activity body masked (`logActivity`); `SecurityLog` masks emails | PARTIAL (R15: raw viewer key kept as `activity.actor_id`) |
| A6 | I | Personal data on public pages | `publicLine` anonymises customers; pack page never shows the address; feed never names a person | OK |
| A6 | D | Erasure or export blocked | `DataService.erase`, `AccountsService.exportData`, `data-purge` job | OK |
| A6 | E | Staff read every person's data | `/v1/data/people` team-only (`staff`); no per-record need-to-know | PARTIAL (accepted for a small team; privacy-officer to confirm) |
| A7 Advertisers | S | Competitor drains a budget with fake scans | scan tokens per network; repeat window per viewer | PARTIAL (R3) |
| A7 | T | Advertiser changes a live ad without review | `PATCH /v1/campaigns/:id`, `PATCH /codes` send changes back to review | OK |
| A7 | I | One advertiser sees another's | `advertiserOf`, `advertiser()` helpers; `campaignFor` | OK |
| A7 | E | Advertiser turns its own ad on | only a company key or reviewer turns campaigns on | OK |
| A8 Settings | T | Safety limit lowered | `ratchetProblem` (minimum age, AI fund, giving with promise), `chainProblem`, `walletProblem` | PARTIAL (R5: print limits unchecked) |
| A8 | E | Service key flips a money switch | `personOnlyKeys` in `PATCH /v1/console/settings`; restore passes `person` | OK (R1 fixed) |
| A8 | R | Who changed what | versioned history with `by` (`ConsoleService.save`), security log `settings_saved` | OK |
| A9 Keys & secrets | S | Stolen key used | hashes only; revoke at once; `last_used_at`; bad-key block per address | PARTIAL (R2) |
| A9 | E | Key mints a person or more keys | `POST /v1/team`, `DELETE /v1/team/:userId` and admin-scoped `POST /v1/keys` need a signed-in owner (`signedInOwner`) | OK (R1 fixed; `test/access-team-keys.test.ts`) |
| A9 | I | Secrets in the database | `loadSecret` (`src/modules/codes/service.ts`) stores code, wallet and second-step secrets in `platform_secrets` unless `FW_SECRET_*` is set (not in `RUNNING.md`) | PARTIAL (R9) |
| A9 | I | Session token stolen by a script on our pages | CSP `script-src 'self'` on every page; no inline script | OK (tokens are in `localStorage`, so this CSP is load-bearing) |
| A10 Honest data | T | Past events rewritten | append-only `events`; daily fingerprints published; hourly seals | OK |
| A10 | T | Wallet seals rebuilt after an edit | seals published to GitHub/chain; `checkSeals` | PARTIAL (wallet journal not DB-enforced: R9) |
| A10 | R | Bots counted as people | bots marked; never bill or count to giving | OK |
| A11 AI agents | E | AI acts beyond what people allowed | governor (`governor.ts:judge`); proposals decided by a person | OK |
| A11 | E | Autonomy raised without a person | `POST /v1/agents/autonomy`, `/spend`, `/costs`, `/library/:itemId/unlock` need a person signed in; track record still checked | OK (R12 fixed) |
| A11 | T | Agent archive edited | archives fingerprinted (`continuity.ts`) | OK |
| A11 | D | Public prompt box spends the AI budget | governor budget; per-address limits | PARTIAL (R2) |
| A12 Machines & stock | S | Another company's key prints at our machine | `POST /v1/orders` checks the location is the caller's company's | OK (R6 fixed; `test/access-isolation.test.ts`) |
| A12 | T | Machine software replaced | `update_software` is a stand-in; no signed updates | **MISSING** (R13) |
| A12 | T | Box marked delivered at the wrong door | `PackService.deliver` (right box), driver-reported GPS / `atAddress` | PARTIAL (client-asserted; R13) |
| A12 | E | Any non-machine `orders` key commands machines | `POST /v1/ops/fleet/:id/commands` scope `admin|orders` | PARTIAL (R13) |
| A12 | S | Someone claims a house that isn't theirs and stops (or restarts) its free water | `HouseService.claim`: only the whole code of a box delivered to that house in the last 60 days (the box number in the corner is refused, `full_code_needed`); 5 wrong tries a day per person, counted in `house_events` (survives restarts); earlier claimants see it in the app and the team is alerted; a stop by a claim under `delivery.newClaimDays` is flagged *new claim* | PARTIAL by design (anyone who can scan the box on the porch can claim; the stop still works, as the founder wants; now visible. Stronger: a code inside the box) |
| A12 | E | A key plans a night (prints and bills) or changes a delivery area | `POST /v1/ops/runs/plan`, `/v1/ops/areas*`, house reviews need a signed-in ops person or owner (`HouseService.needOpsPerson`) | OK (`test/route-delivery.test.ts`) |
| A12 | T | A house delivered twice in a cycle when two plans run at once | `HouseService.take`: one guarded update (still active, still due, not planned for that night or later) inside the transaction that writes the runs; run ids unique | OK (`test/route-delivery.test.ts`, real Postgres with two servers) |
| A6 | I | A house’s record grows into a profile of the people in it | houses hold address, map point, status and household size only; the link to a person (`house_claims`) and their id in `house_events` go when they delete their account | OK |
| A13 | E | A company key approves (and so starts spending) a paid ad | `AdsService.review`, `PATCH /v1/campaigns/:id`, `PATCH /v1/campaigns/:id/codes`: a person on the team (`teamPersonOf`) | OK (fixed in this check; `test/security-release.test.ts`) |
| A13 | T | A key charges an advertiser's card for a buy they didn't make | `POST /v1/ads/campaigns/:id/pay` and `/route-pay` accept company staff keys | PARTIAL (N4) |
| A14 | T | Two buys take the same bottle | Lock per house and week, DB trigger | OK (`test/controls-route-buying.test.ts`) |
| A14 | I | An ad aimed at a few houses carries a name or address | `personalContent(adWords(c))` at payment, approval and on changes; versions, link and QR destinations (path and query as words), SVG character references, letters set apart, invisible and full-width characters now read; the AI reviewer gets the same words and says it never saw the pictures | OK (2026-10-22; pictures themselves are checked by a person, and look-alike letters from other alphabets are not folded) |
| A14 | E | A route ad copied as a free filler onto other bottles | `FillerService.offerAd` refuses route ads | OK (fixed in this check) |
| A15 | S | Many tries at a box code at once | Lock per person; tries counted, the code's answer and the claim written in one transaction under it (`claim_failed` rows) | OK (fixed in this check, real Postgres) |
| A16 | I | A porch claimant sees drop photos | Only from their claim on (never before); claims lapse after 12 months unused; earlier claimants and the team told of a new claim | PARTIAL (N2: later photos are still visible to a porch claimant until someone notices) |
| A16 | I | A photo reachable without a sign-in | Only `/v1/ops/drop-photos/:id` (team person) and `/v1/me/drop-photos/:id` (claimant); not under `/assets` | OK |
| A17 | E | A key imports bought household data | `POST /v1/households/imports` needs a person | OK |
| A18 | E | The AI (or a key) turns its own final call on | `src/api/aiReview.ts` `person`; `FeatureService.plan` refuses `ownPage` switches | OK (`test/ai-review-autonomy.test.ts` §3) |
| A19 | E | A key flips a switch kept in the settings | `ConsoleService.saveNow` / `restoreNow` with `switchesChanged` | OK (fixed in this check) |
| A19 | E | A company turns on what the host forbids | `FeatureService.plan` (`host`), `whyOff` | OK (`test/features-registry.test.ts`) |

### 4.2 Boundaries

| Boundary | | Threat | Control (file:function) | Status |
|---|---|---|---|---|
| B1 Browser | S | Caller pretends to be another address | `TRUST_PROXY` → Fastify `req.ip` | **PARTIAL (R2, CONFIRMED)** |
| B1 | T | Body with unexpected fields | JSON schemas, `additionalProperties: false` | OK |
| B1 | T | Unsafe SVG artwork or uploads | `src/modules/print/svgCreative.ts:svgCreative`; `AssetStore.put` checks bytes; served `nosniff`, exact type | OK |
| B1 | R | Actions not attributable | `logActivity`, `SecurityLog.record` | OK |
| B1 | I | Errors leak internals | `setErrorHandler` returns plain messages | OK |
| B1 | D | Floods of public writes and uploads | per-address limits | PARTIAL (R8, R2) |
| B1 | E | Key without scope | `authenticate` scope check before the body is read | OK |
| B2 Machine | S | Stolen machine key | bound to one machine; print cap (orders and offline labels together); offline bottles an hour held on the server; revoke | PARTIAL (R5) |
| B2 | T | Machine reports prints that didn't happen | jobs billed only on `dispensed`; offline labels capped by buffer (≤ 50) | OK (trusted hardware) |
| B2 | E | Machine key reads other data | `unitFor` by location; `staff()` refuses machine keys elsewhere | OK |
| B3 Providers | S | Fake provider callback | no inbound provider callbacks today (stand-ins) | n/a until real providers |
| B3 | T | Money sent twice on retry | idempotency keys on payments, payouts, gift cards | OK |
| B3 | I | Personal data sent to AI | AI gets the moment, never ids (`personalizer.ts`, `AI.md`) | OK (AI.md rule; privacy-officer to sample prompts) |
| B3 | D | Provider down | fallbacks for every AI use; stand-ins | OK |
| B4 Partners | S | Forged webhook from us | HMAC `FreeWater-Signature` | OK |
| B4 | I | Webhooks carry personal data | public event catalogue only (`webhooks/catalog.ts`) | OK |
| B4 | E | Webhook used to reach our network | `checkWebhookUrl`, `guardedLookup` | OK |
| B5 Company↔company | I/E | One licensee reads or acts on another | company id on every lookup | OK (R6 fixed for orders and packs; every route naming a company's thing walked in `test/access-isolation.test.ts`) |
| B5 | E | Licensee gets platform powers | `platform` never grantable (`scopeInfo`), only FreeWater owners' sessions and the setup key | OK |
| B6 Database | T | Rows changed outside the app rules | triggers on two tables only | PARTIAL (R9) |
| B6 | I | Database or its host backups leak | our backups encrypted with `BACKUP_KEY`; host backups not; secrets in `platform_secrets` | PARTIAL (R9) |
| B6 | D | Two servers writing | `InstanceLease`, freshness gate | OK |
| B7 Solana | T | Server records a mint that didn't happen | `confirmSigned` checks on chain | OK |
| B7 | D | RPC lies or is down | daily `reconcile` pauses on mismatch | OK |
| B8 Proxy | S | Forged `X-Forwarded-For` / country header | `TRUST_PROXY=1` trusts every hop; `TRUST_GEO_HEADERS` only behind a CDN | **MISSING** for `1` (R2) |

---

## 5. Top 15 risks

Likelihood (L) and impact (I) on 1–5; score = L × I. Each has one specialist to check and fix it.

| Rank | Risk | L | I | Score | Evidence | Specialist |
|---|---|---|---|---|---|---|
| R1 | **A service key can create a person.** `POST /v1/team` takes any `admin` key (`by` is empty) and can invite an `owner` or `finance` person; `POST /v1/keys` lets an `admin` key mint more `admin` keys. The setup platform key has `admin`. A leaked key therefore becomes every person-only power (money switches, reserves, giving, chain proposals) and survives its own revocation. | 4 | 5 | 20 | CONFIRMED: demo `freewater-admin` key invited `mallory@evil.example` as owner (201); that owner then `POST /v1/wallet/reserve` (201). **FIXED**: team changes and admin keys need a signed-in owner. | test-engineer |
| R2 | **Visitor address can be forged.** `checkConfig` requires `TRUST_PROXY` and `RUNNING.md` says `1`; Fastify then takes the left-most `X-Forwarded-For`, which the visitor writes. Breaks `limits.signIn`, `limits.everything`, `BadKeyGuard`, `WalletService.sourceOf` (points per network) and `ScanTokens` rationing. | 5 | 4 | 20 | CONFIRMED: with `TRUST_PROXY=1`, 15 `POST /v1/auth/start` with rotating `X-Forwarded-For` all 202; same header → 429 after 10. | reliability-engineer |
| R3 | **Scan and AR billing fraud.** A billed scan needs a token from `/q/<code>`, rationed per network per hour; there is no per-slot or per-campaign daily ceiling and no alert. Anyone holding one bottle (or a photo of its code) with many addresses bills its advertisers repeatedly with fresh viewer keys. | 4 | 4 | 16 | PLAUSIBLE: prove with a test issuing tokens from N sources for one slot and checking N billed scans. | financial-auditor |
| R4 | **Approvers are protected by an email code only.** The second step is off by default (`security.ownersNeedSecondStep`) and, when on, applies to owners only (`authenticate`); finance people approve token steps without it. Sessions last 30 days in `localStorage`. | 3 | 5 | 15 | PLAUSIBLE (code read): a finance session without a second step approves a chain action. | privacy-officer |
| R5 | **Print limit, a safety governor, is editable and unchecked.** `machines.printsPerMinute/printsPerDay` aren't in `personOnlyKeys` and `checkSettings` doesn't validate them; a string turns the cap off (`s.minute.size >= 'lots'` is false). | 3 | 4 | 12 | CONFIRMED: `PATCH /v1/console/settings` with a service key stored `printsPerMinute: "lots"`, `printsPerDay: 99999999` (200). | reliability-engineer |
| R6 | **Cross-company printing.** `POST /v1/orders` checks only that `locationId` exists, not that it belongs to the caller's company (machine keys are protected, other `orders` keys aren't). A licensee's key can print at FreeWater's machine; on a Model 6 that queues a job on another company's hardware. `POST /v1/packs` has the same gap for `routeId`. | 3 | 4 | 12 | CONFIRMED: `peak-spring-admin` printed at `ATX-014` (201, `companyId: peak-spring`). **FIXED**: answers `unknown_location` / `unknown_route`. | test-engineer |
| R7 | **Money and approval steps open to service keys, against the docs.** `POST /v1/offers/:id/approve`, `POST /v1/offers/receipts/:claimId/review` (pays credit from a reserve), `POST /v1/environment/experiments/:id/decide` ("A person decides"), `POST /v1/platform/persistence/skip-stuck` ("a person's decision"). | 3 | 4 | 12 | CONFIRMED for skip-stuck (200 with the platform key); others PLAUSIBLE by code read. | financial-auditor |
| R8 | **Unauthenticated uploads and writes fill the database.** `POST /v1/public/games/:companyId/feedback/video` (30 MB), feedback images, offer receipts (2.8 MB), interactions; `FILE_STORAGE=database` is the default; limits are per address (see R2). | 3 | 4 | 12 | PLAUSIBLE: a load script with rotating addresses; watch DB size and `/health/ready`. | reliability-engineer |
| R9 | **Immutability and secrets rest on the app, not the database.** Only `ledger_entries` and `events` are append-only in the DB; the wallet journal, seals, chain actions, charity transfers, settings history, security log and agent archives aren't; the app's DB role owns the triggers. Code-signing, wallet-source and second-step encryption secrets live in `platform_secrets` unless `FW_SECRET_*` is set, which `RUNNING.md` doesn't mention (standing rule: secrets only in host settings). | 2 | 5 | 10 | PLAUSIBLE: an `update wallet_lines` succeeds; `platform_secrets` has rows after a default start. | database-engineer |
| R10 | **Revenue with no money behind it.** `POST /v1/orders` with `custom` (any `orders` key, machine keys included) books `revenue:custom` against a receivable no one pays, and makes the charity's share and the AI fund's share owed, which payouts then send in real money. | 3 | 3 | 9 | CONFIRMED: machine key `ATX-014` order with `custom` → lines `custom 300¢`, `donation 30¢`, `ai_fund 20¢`, no payment. | financial-auditor |
| R11 | **Books money-out by service keys.** `POST /v1/books/expenses`, `/owner-payouts`, `/reinvestments` and `POST /v1/payouts/run` need only a team key, while `/v1/team/expenses` needs a person. Expenses lower the month's profit and so the charity's and agents' share, publicly. | 2 | 4 | 8 | PLAUSIBLE: a `ledger` service key records an expense (201) and the month's share drops. | financial-auditor |
| R12 | **AI powers changed by service keys.** `POST /v1/agents/autonomy` (track record still checked), `POST /v1/agents/:agentId/spend`, `/costs`, `/library/:itemId/unlock` take any team key; AI.md says AI gains say only through people and measured results. | 2 | 4 | 8 | **FIXED**: all four need a person signed in (`person_needed` for a service key). | test-engineer |
| R13 | **Machines and vans trust what they are told.** Software updates are a stand-in (no signing); any non-machine `orders` key can command any machine; delivery takes the driver app's `atAddress` and `photoProof` booleans. | 2 | 4 | 8 | PLAUSIBLE until real hardware; needs signed updates before machines go out. | supply-chain-engineer |
| R14 | **Supply chain.** Production runs TypeScript through `tsx` at start; caret version ranges (lockfile and `npm ci` mitigate); GitHub Actions pinned by tag, not commit; base image not pinned by digest; `legacy-peer-deps=true`; `npm audit` gates only `high`; browser libraries (model-viewer, three, jsQR) served from our own origin next to session tokens. | 2 | 4 | 8 | PLAUSIBLE: review `ci.yml`, `Dockerfile`, `.npmrc`, lockfile integrity. | supply-chain-engineer |
| R15 | **The phone's viewer key is a bearer secret, kept in the clear.** It alone reads a wallet, spends points on offers, changes consent and erases data; `DataService.activity` stores it raw as `activity.actor_id`, readable by the team's data screens; no rotation. | 2 | 3 | 6 | PLAUSIBLE: after a public engagement, `select actor_id from activity` shows the key. | privacy-officer |

**Also noted (below the top 15):** `DELETE /v1/team/:userId` by a service key (last owner protected); SWITCHES
contradicts itself on who may cancel a waiting step (code: owners only); README's key-scope list omits `invoices` and
`webhooks`; `POST /v1/console/machines` gives any `admin` key new machine keys; `PATCH /v1/console/settings` can swap
`modules.printer` (a printer that always confirms would bill advertisers for bottles never printed); `/v1/public/*`
answers CORS `*` (fine while sessions are bearer tokens, not cookies; revisit if cookies are ever used).

**Standing rules, checked:**

| Rule | Result |
|---|---|
| Never remove a safety governor | **Fail**: print limits can be raised or disabled (R5). Pause, daily check, approvals, points cap: pass |
| Irreversible steps need people, approvals and a wait | Pass for chain steps (R1 fixed: a key can no longer create the people) |
| Fix data with correcting entries, never edits | Pass for ledger and events (DB-enforced); app-only elsewhere (R9) |
| Money, crypto, partners off until a person turns them on | Pass for settings switches; **fail** for offer approvals and receipt payouts by service keys (R7) |
| Keys and secrets only in host settings | **Fail** by default: internal secrets generated into `platform_secrets` (R9) |

---

## 5a. Release check 2026-10-21: risks in the new code

| # | Risk | L | I | Score | Status | Specialist |
|---|---|---|---|---|---|---|
| N1 | **A company key approved paid ads** (and switched them on, or changed what they show), against *Ad review* (locked): "a person checks every ad". An AI or automated check holding a key could put any paid ad live. | 4 | 4 | 16 | **FIXED**, CONFIRMED by test: a person on the team signed in, 403 `person_review` for a key, on the review queue and both PATCH siblings | test-engineer |
| N2 | **The proof of a house is on its porch.** Anyone who can read a box's QR or its whole box code can claim the house, stop or restart its water, block its ads, and see photos of later drops at that door. 2026-10-22 (within the founder's design): the corner box number no longer claims; earlier claimants and the team are told of a new claim; a stop by a claim under 7 days old is flagged *new claim*; claims lapse after 12 months unused; no photos from before the claim. | 2 | 4 | 8 | PARTIAL by design. Prove: claim with a second account and list `/v1/me/drop-photos`. Options: a code inside the box, notify earlier claimants, claims that lapse without a newer box, photos only of one's own subscription | privacy-officer |
| N3 | **A key flipped switches kept in the settings** (open books, live feed, counters, fingerprints, games, AR strips, static codes, offline bottles), though "a key never changes a switch". | 3 | 3 | 9 | **FIXED**, CONFIRMED by test | test-engineer |
| N4 | **A company key charges an advertiser's card for a new buy** (`/pay`, `/route-pay`, up to 1,000,000 bottles at the server's price). Documented, but a money step without a person or the advertiser. | 2 | 4 | 8 | PLAUSIBLE; a question for the founder | financial-auditor |
| N6 | **One door, two houses.** Addresses were keyed with their ZIP code and "Apt 2" was part of the street, so a door imported twice (with and without a ZIP) got two boxes, and household data or a "no" written one way missed the other. | 3 | 3 | 9 | **FIXED** 2026-10-22 (one address form, re-key and merge at start, the old keys still honoured), CONFIRMED by test | database-engineer |
| N7 | **Photo proof taken before arriving.** Any photo of the pack counted, from the gallery or the depot. | 3 | 3 | 9 | **FIXED** 2026-10-22 (after the door scan, camera only, distance or *unverified*); the camera and location are the app's word (a modified app can lie): PLAUSIBLE, needs a signed driver app to close | supply-chain-engineer |
| N8 | **Ad words checked only as plain text.** A link's path, a static QR's target, SVG character references and spaced letters slipped past the small-audience check and the AI reviewer. | 3 | 3 | 9 | **FIXED** 2026-10-22, CONFIRMED by test; look-alike letters from other alphabets (Cyrillic "а") and words inside pictures remain for the person who reviews | privacy-officer |
| N5 | **Wrong tries at a house claim, all at once.** The five-a-day limit was a count, then an insert. | 3 | 2 | 6 | **FIXED**, CONFIRMED on real Postgres | database-engineer |
| N6 | **The small-audience content check skipped an ad's versions**, and a route ad could be offered as a free filler for any bottle. | 2 | 3 | 6 | **FIXED**, CONFIRMED by test | test-engineer |
| N7 | **Ads billed afterwards are still approved by company keys**, while the locked text says "every ad". | 2 | 3 | 6 | Open: README allows it; a question for the founder | — |
| N8 | **An address oracle for advertisers.** A houses quote says whether an address gets packs and hasn't stopped or blocked (`cannot_reach` otherwise), without paying. | 2 | 2 | 4 | PLAUSIBLE; consider a quote limit or verified businesses only | privacy-officer |

**Checked and fine:** prepaid stop and route refunds (owner or finance, second step, once per ad, booked before
marked done); the AI's final-call switch, bar and sample (people only; on with the second step on the record; never via
the Features page); feature switches (a key never changes one now; host areas can't be turned on; locked switches
can't be turned off; starting points never turn on money, chain or one-way switches); news (off unless
`FW_FEATURES_ON=news`, then `news.on` by a person, then each topic by a person; public pages answer `news_off`);
household imports (a person); delivery areas, plans and house reviews (an ops person or owner); drop photos (team
persons and the claimant only, re-encoded, purged); house claims and blocks stay inside the company (P5); advertiser
verification by an owner or reviewer.

**Standing rules, this release:** never remove a safety governor: pass (the AI's final call keeps its governor; print
limits stay a person's). Irreversible steps: pass. Correcting entries: pass (settlements, credit uses, house events and
the switch log are append-only). Money, crypto and partners off until a person turns them on: pass for switches (fixed
N3); N4 open. Keys only in host settings: unchanged from R9.

---

## 6. Route access

**How to read it.** *Scope*: what `authenticate` requires (`admin` also passes any non-`platform` scope). *Person*:
whether the handler refuses service keys (`yes`), only for some changes, or not at all (`no`); `—` for public routes.
*Other check*: extra guards in the handler; "second step (owners/finance, R4)" means an owner or finance person must approve from a sign-in that passed the authenticator step at sign-in, with an app set up at least 24 hours before (`approvalRoutes` in `src/modules/accounts/secondStep.ts`, always; `conditionalApprovalRoutes`, when the request touches an approval setting or role). *Docs*: whether this matches README, SWITCHES, RUNNING, AI and the
route's own OpenAPI summary.

**Areas switched off (`FW_FEATURES`).** A host can take whole areas out (`src/runtime/features.ts`; the pilot preset
takes out 56 of these routes, 14 of them news; news is also off by default everywhere until a host sets
`FW_FEATURES_ON=news`). Their routes are never registered, so they answer 404 to everyone and the walk below
only covers what's left; `test/access-routes.test.ts` checks that with the pilot preset exactly the core rows are
registered, the rest answer 404 even to the platform's admin key, their jobs aren't scheduled, and their launch steps
can't be proposed.

**Mismatches and gaps (13):**

| Route | Problem | Risk |
|---|---|---|
| `POST /v1/team` | ~~Service `admin` key can add an owner~~ Fixed: signed-in owner only | R1 |
| `DELETE /v1/team/:userId` | ~~Service `admin` key can remove people~~ Fixed: signed-in owner only | low |
| `POST /v1/orders` | ~~No check that the location is the caller's~~ (fixed); ~~custom orders book unpaid revenue~~ Fixed: never billed here | R6, R10 |
| `POST /v1/packs` | ~~No check that the route is the caller's~~ Fixed | low (R6) |
| `PATCH /v1/console/settings` | ~~Print limits neither person-only nor checked~~ Fixed: a person, 1–20/min and 1–20,000/day | R5 |
| `POST /v1/offers/:id/approve` | ~~SWITCHES: owner approves, signed in; service key can~~ Fixed: a person, with the second step | R7 |
| `POST /v1/offers/receipts/:claimId/review` | ~~Pays credit; service key can~~ Fixed: a person, with the second step | R7 |
| `POST /v1/environment/experiments/:id/decide` | ~~Summary says "A person decides"; service key can~~ Fixed: a person, with the second step | R7 |
| `POST /v1/platform/persistence/skip-stuck` | ~~RUNNING: "a person's decision"; platform key can~~ Fixed: a person | R7 |
| `POST /v1/books/expenses`, `/owner-payouts`, `/reinvestments` | ~~Team-page equivalent needs a person; these don't~~ Fixed: a person; owner payouts and reinvestments also the second step | R11 |
| `POST /v1/payouts/run` | ~~Moves money; docs silent on person~~ Fixed: a person, with the second step | R11 |
| `POST /v1/agents/autonomy` | ~~Docs silent on person~~ Fixed: a person signed in (also spend, costs, library unlock) | R12 |
| `POST /v1/chain/actions/:id/cancel` | SWITCHES says both "anyone on the team" and "owners" | docs conflict |

**Endpoints outside the route table** (no key, by design): `GET /q/:code`, `/Q/:code` (smart code open; issues the
scan token), `GET /v/:code`, `/V/:code` (coupon check redirect), `GET /go/:token` (signed click redirect), `GET /t.js`,
`POST /v1/public/conversions` (tag sales, unverified), `GET /v1/public/labels/:file`,
`GET /v1/public/companies/:companyId/live`, `GET /health`, `/health/live`, `/health/ready`, `/health/uptime`, `GET /v1/openapi.json`,
the web pages (`/s`, `/b`, `/p`, `/r`, `/app`, `/ads`, `/ops`, `/driver`, `/console`, `/developers`, `/books`,
`/play`, `/preview/scan`), `/static/*`, `/models/builtin/*`, `/assets/*`.

**Every route (438):**

| # | Route | Scope | Person | Other check | Docs |
|---|---|---|---|---|---|
| 1 | `GET /v1/public/receipts/:unitId` | public | — | — | OK (public by design) |
| 2 | `GET /v1/public/scan/:unitId/:slot` | public | — | — | OK (public by design) |
| 3 | `POST /v1/public/scans` | public | — | — | OK; billing needs a one-time scan token, rationed per network address (R2, R3) |
| 4 | `POST /v1/public/ar-launches` | public | — | — | OK; same token rule (R3) |
| 5 | `GET /v1/public/experience/:unitId/:slot` | public | — | — | OK (public by design) |
| 6 | `GET /v1/public/experience/box/:packId/:face` | public | — | — | OK (public by design) |
| 7 | `POST /v1/public/box-scans` | public | — | — | OK; same token rule (R3) |
| 8 | `POST /v1/public/box-ar-launches` | public | — | — | OK; same token rule (R3) |
| 9 | `POST /v1/public/engagements` | public | — | — | OK (public by design) |
| 10 | `GET /v1/public/packs/:packId` | public | — | — | OK (public by design) |
| 11 | `GET /v1/public/companies/:companyId/totals` | public | — | — | OK (public by design) |
| 12 | `POST /v1/orders` | orders | no | location must be the caller’s company’s | OK (R6 fixed: another company’s machine answers `unknown_location`); a `custom` order still books custom revenue with no payment (R10) |
| 13 | `GET /v1/units/:id` | [orders, packs, admin] | no | — | OK |
| 14 | `GET /v1/units/:id/label.svg` | [orders, packs, admin] | no | — | OK |
| 15 | `POST /v1/purchases` | purchases | no | — | OK |
| 16 | `POST /v1/refunds` | purchases | no | — | OK |
| 17 | `GET /v1/campaigns` | campaigns | no | — | OK |
| 18 | `POST /v1/campaigns` | campaigns | no | — | OK; starts paused until a company key approves |
| 19 | `PATCH /v1/campaigns/:id` | campaigns | some | own campaigns | OK; only the company turns a campaign on (README). A paid ad (bottles, a route buy, a change to one) is switched on, or its page changed, only by a person on the team signed in (403 `person_review` for a key, 2026-10-21 release check); never one that's flagged, appealed or rejected by the AI reviewer (409 `decide_in_review`: decided in the review queue, 066). Pausing: anyone |
| 20 | `GET /v1/experiences` | campaigns | no | — | OK |
| 21 | `POST /v1/experiences/preview` | campaigns | no | — | OK |
| 22 | `POST /v1/assets` | campaigns | no | — | OK |
| 23 | `GET /v1/assets` | campaigns | no | — | OK |
| 24 | `POST /v1/packs` | packs | no | route must be the caller’s company’s | OK (fixed: another company’s route answers `unknown_route`) |
| 25 | `GET /v1/packs/:id` | packs | no | — | OK |
| 26 | `GET /v1/packs/:id/box.svg` | packs | no | — | OK |
| 27 | `POST /v1/packs/:id/verify` | packs | no | — | OK |
| 28 | `POST /v1/packs/:id/replace` | packs | no | — | OK |
| 29 | `POST /v1/packs/:id/seal` | packs | no | — | OK |
| 30 | `POST /v1/routes/:routeId/load` | packs | no | — | OK (company checked through its packs) |
| 31 | `POST /v1/deliveries` | packs | yes | team only (no advertiser/machine key); stop must be the caller’s company’s | OK: the door report is the driver’s word, so a signed-in person (supply chain); a box on a planned run is refused (`use_driver_app`) |
| 32 | `GET /v1/ledger` | ledger | no | — | OK |
| 33 | `GET /v1/events` | events | no | — | OK (corrected: read by service keys by design) |
| 34 | `POST /v1/auth/start` | public | — | — | OK (public by design) |
| 35 | `POST /v1/auth/verify` | public | — | — | OK (public by design) |
| 36 | `POST /v1/auth/second-step` | public | — | — | OK (public by design) |
| 37 | `GET /v1/me/second-step` | me | yes | — | OK |
| 38 | `POST /v1/me/second-step/start` | me | yes | — | OK |
| 39 | `POST /v1/me/second-step/confirm` | me | yes | — | OK (skeptic fix): never marks the sign-in it was set up from as having passed the step; the person signs in again with the app's code, a new app approves only after 24 hours, and the company's other owners are emailed and an alert raised |
| 40 | `POST /v1/me/second-step/recovery-codes` | me | yes | — | OK |
| 41 | `POST /v1/me/second-step/off` | me | yes | — | OK |
| 42 | `POST /v1/auth/sign-out` | me | yes | — | OK |
| 43 | `GET /v1/me` | me | yes | — | OK |
| 44 | `PATCH /v1/me` | me | yes | — | OK |
| 45 | `GET /v1/me/export` | me | yes | — | OK |
| 46 | `DELETE /v1/me` | me | yes | — | OK |
| 47 | `GET /v1/me/saved` | me | yes | — | OK |
| 48 | `POST /v1/me/saved` | me | yes | — | OK |
| 49 | `DELETE /v1/me/saved/:id` | me | yes | — | OK |
| 50 | `POST /v1/team` | admin | yes | team only (no advertiser/machine key); signed-in owner; making or changing an owner/finance person: second step (owners/finance, R4) | OK (R1 fixed): an owner signed in adds people; a service key gets `person_needed`; giving or changing an approver role needs the second step (`conditionalApprovalRoutes`) |
| 51 | `GET /v1/me/cards` | me | yes | — | OK |
| 52 | `POST /v1/me/cards` | me | yes | — | OK |
| 53 | `GET /v1/advertisers/:advertiserId/cards` | invoices | no | — | OK |
| 54 | `POST /v1/advertisers/:advertiserId/cards` | invoices | no | — | OK |
| 55 | `POST /v1/invoices/run` | invoices | no | team only (no advertiser/machine key) | OK |
| 56 | `GET /v1/invoices` | invoices | no | — | OK |
| 57 | `GET /v1/invoices/:id` | invoices | no | — | OK |
| 58 | `POST /v1/invoices/:id/pay` | invoices | no | — | OK |
| 59 | `GET /v1/security/events` | admin | no | team only (no advertiser/machine key) | OK |
| 60 | `POST /v1/security/review` | admin | no | team only (no advertiser/machine key) | OK |
| 61 | `GET /v1/public/app-config` | public | — | — | OK (public by design) |
| 62 | `GET /v1/public/companies/:companyId/machines` | public | — | — | OK (public by design) |
| 63 | `GET /v1/public/machines/:locationId` | public | — | — | OK (public by design) |
| 64 | `GET /v1/public/machines/:locationId/sample.svg` | public | — | — | OK (public by design) |
| 65 | `GET /v1/public/products/:productId` | public | — | — | OK (public by design) |
| 66 | `GET /v1/machines/:locationId/presence` | orders | no | — | OK |
| 67 | `POST /v1/me/vends` | me | yes | — | OK |
| 68 | `GET /v1/me/machines/:locationId/choice` | me | yes | — | OK |
| 69 | `GET /v1/me/vends/:vendId` | me | yes | — | OK |
| 70 | `GET /v1/me/bottles` | me | yes | — | OK |
| 71 | `GET /v1/me/bottles/:id` | me | yes | — | OK |
| 72 | `GET /v1/me/bottles/:id/label.svg` | me | yes | — | OK |
| 73 | `POST /v1/me/proofs` | me | yes | — | OK |
| 74 | `POST /v1/me/custom-orders` | me | yes | — | OK |
| 75 | `POST /v1/me/assets` | me | yes | — | OK |
| 76 | `POST /v1/me/designs` | me | yes | — | OK |
| 77 | `GET /v1/me/designs` | me | yes | — | OK |
| 78 | `GET /v1/me/designs/:id` | me | yes | — | OK |
| 79 | `POST /v1/me/designs/:id/messages` | me | yes | — | OK |
| 80 | `GET /v1/me/designs/:id/scan-preview` | me | yes | — | OK |
| 81 | `POST /v1/me/designs/:id/proof` | me | yes | — | OK |
| 82 | `POST /v1/advertisers` | me | yes | — | OK |
| 83 | `GET /v1/ads/advertiser` | campaigns | no | advertiser only | OK |
| 84 | `GET /v1/ads/overview` | campaigns | no | advertiser only | OK |
| 85 | `POST /v1/ads/drafts` | campaigns | no | advertiser only | OK |
| 86 | `GET /v1/ads/drafts/:id` | campaigns | no | advertiser only | OK |
| 87 | `POST /v1/ads/drafts/:id/messages` | campaigns | no | advertiser only | OK |
| 88 | `GET /v1/ads/drafts/:id/preview` | campaigns | no | advertiser only | OK |
| 89 | `POST /v1/ads/drafts/:id/submit` | campaigns | no | advertiser only | OK |
| 90 | `GET /v1/review/campaigns` | campaigns | no | team only (no advertiser/machine key) | OK |
| 91 | `POST /v1/review/campaigns/:id` | campaigns | paid ads | team only (no advertiser/machine key) | OK; a paid ad (bottles, a route buy, a change to one, an AI rejection or an appeal) is approved and finally rejected only by a person on the team signed in (403 `person_review`; a key's reject becomes a flag); aimed at a few houses: an owner or reviewer, the business verified, the content check (065/066; release check 2026-10-21 closed the gap where any company key approved paid ads). Ads billed afterwards: still a company key may approve (README); *Ad review* says "every ad" (QUESTION for the founder) |
| 92 | `POST /v1/public/delivery/check` | public | — | — | OK (public by design) |
| 93 | `GET /v1/me/delivery` | me | yes | — | OK |
| 94 | `POST /v1/me/delivery` | me | yes | — | OK |
| 95 | `PATCH /v1/me/delivery` | me | yes | — | OK |
| 801 | `GET /v1/me/house` | me | yes | — | OK (only the house this person claimed) |
| 802 | `POST /v1/me/house/claim` | me | yes | — | OK (proof: a code from a box delivered to that house in the last 60 days; 5 wrong tries a day, taken under a lock on the person and kept in the database, so tries at once can't pass together). See N2: the proof is on the outside of the box |
| 803 | `PATCH /v1/me/house` | me | yes | — | OK (only the claimed house) |
| 804 | `DELETE /v1/me/house` | me | yes | — | OK |
| 96 | `GET /v1/ops/overview` | [admin, packs, events, ledger, campaigns] | no | team only (no advertiser/machine key) | OK |
| 97 | `GET /v1/ops/machines` | [admin, orders, packs, events] | no | team only (no advertiser/machine key) | OK |
| 98 | `GET /v1/ops/plugin-failures` | [admin, events, campaigns] | no | team only (no advertiser/machine key) | OK |
| 99 | `GET /v1/ops/subscriptions` | [admin, packs] | no | team only (no advertiser/machine key) | OK |
| 100 | `GET /v1/ops/runs` | [admin, packs] | no | team only (no advertiser/machine key) | OK |
| 101 | `POST /v1/ops/runs/plan` | [admin, packs] | yes | team only (no advertiser/machine key) | OK; ops person or owner (it prints bottles that bill advertisers) |
| 102 | `POST /v1/ops/runs/:id/pack-check` | [admin, packs] | no | team only (no advertiser/machine key) | OK |
| 103 | `POST /v1/ops/runs/:id/stops/:stop/check-by-hand` | [admin, packs] | yes | team only (no advertiser/machine key) | OK; ops person or owner only (README) |
| 104 | `POST /v1/ops/runs/:id/close` | [admin, packs] | yes | team only (no advertiser/machine key) | OK; ops person or owner |
| 805 | `GET /v1/ops/areas` | [admin, packs] | no | team only (no advertiser/machine key) | OK |
| 806 | `POST /v1/ops/areas` | [admin, packs] | yes | team only (no advertiser/machine key) | OK; ops person or owner; starts off |
| 807 | `PATCH /v1/ops/areas/:id` | [admin, packs] | yes | team only (no advertiser/machine key) | OK; ops person or owner |
| 808 | `GET /v1/ops/areas/:id/houses` | [admin, packs] | no | team only (no advertiser/machine key) | OK (addresses only, no people) |
| 809 | `POST /v1/ops/areas/:id/houses/import` | [admin, packs] | yes | team only (no advertiser/machine key) | OK; ops person or owner |
| 810 | `GET /v1/ops/house-reviews` | [admin, packs] | no | team only (no advertiser/machine key) | OK |
| 811 | `POST /v1/ops/houses/:id/review` | [admin, packs] | yes | team only (no advertiser/machine key) | OK; ops person or owner |
| 105 | `GET /v1/review/campaigns/:id/preview` | campaigns | no | team only (no advertiser/machine key) | OK |
| 106 | `GET /v1/driver/runs` | packs | yes | — | OK |
| 107 | `GET /v1/driver/runs/:id` | packs | yes | — | OK |
| 108 | `POST /v1/driver/runs/:id/start` | packs | yes | — | OK |
| 109 | `POST /v1/driver/runs/:id/load` | packs | yes | — | OK |
| 110 | `POST /v1/driver/runs/:id/stops/:stop/deliver` | packs | yes | — | OK |
| 111 | `POST /v1/driver/runs/:id/stops/:stop/fail` | packs | yes | — | OK |
| 812 | `POST /v1/driver/runs/:id/stops/:stop/skip-house` | packs | yes | — | OK (the run's own driver; a person reviews the skip) |
| 112 | `POST /v1/driver/photos` | packs | yes | a person; the box must be out on a van (`?packId=`) | OK (065: re-encoded without the phone's hidden data, 8 MB / 40 MP at most, kept apart from uploads and never at a public address; deleted after the company's keep) |
| 113 | `GET /v1/public/books` | public | — | — | OK (public by design) |
| 114 | `GET /v1/public/books/:companyId` | public | — | — | OK (public by design) |
| 115 | `GET /v1/public/books/:companyId/days` | public | — | — | OK (public by design) |
| 116 | `GET /v1/public/books/:companyId/days/:date` | public | — | — | OK (public by design) |
| 117 | `GET /v1/public/bottles/:unitId` | public | — | — | OK (public by design) |
| 118 | `GET /v1/public/transfers/:id` | public | — | — | OK (public by design) |
| 119 | `POST /v1/public/transfers/:id/confirm` | public | — | — | OK; needs the emailed token |
| 120 | `GET /v1/charities` | [ledger, admin] | no | team only (no advertiser/machine key) | OK |
| 121 | `POST /v1/charities` | admin | no | team only (no advertiser/machine key) | OK |
| 122 | `GET /v1/payouts/preview` | [ledger, admin] | no | team only (no advertiser/machine key) | OK |
| 123 | `POST /v1/payouts/run` | [ledger, admin] | yes | team only (no advertiser/machine key); second step (owners/finance, R4) | OK (R11 fixed): sends real money, so a person signed in, with the second step |
| 124 | `GET /v1/payouts` | [ledger, admin] | no | team only (no advertiser/machine key) | OK |
| 125 | `POST /v1/books/expenses` | [ledger, admin] | yes | team only (no advertiser/machine key) | OK (R11 fixed): a person records costs, as on the team page; a record, not an approval, so no second step; `requestId` makes a retry record nothing new |
| 126 | `POST /v1/books/reinvestments` | admin | yes | team only (no advertiser/machine key); second step (owners/finance, R4) | OK (R11 fixed): a person, with the second step; `requestId` idempotent |
| 127 | `POST /v1/books/owner-payouts` | admin | yes | team only (no advertiser/machine key); second step (owners/finance, R4) | OK (R11 fixed): money out to owners, a person with the second step; `requestId` idempotent |
| 128 | `GET /v1/books/reconciliation` | [ledger, admin] | no | team only (no advertiser/machine key) | OK: the daily reconciliation report (read only) |
| 129 | `GET /v1/books/surplus` | [ledger, admin] | no | — | OK |
| 130 | `GET /v1/console` | admin | no | team only (no advertiser/machine key) | OK (corrected: keys can read it; it reports `person: false`) |
| 131 | `PATCH /v1/console/settings` | admin | some | team only (no advertiser/machine key); money/prize/token switches: second step (owners/finance, R4) | OK: money, chain and one-way keys and the machines’ print limits (R5 fixed: 1–20 a minute, 1–20,000 a day) are a person’s; switching money, prizes or the token needs the second step; turning any switch kept in the settings on or off (open books, live feed, games…) is a person, never a key (`ConsoleService.switchesChanged`, release check 2026-10-21) Label layouts: a change that leaves no usable layout while ads are on is refused (422 `no_layout_left`), one that would strand paid pieces is refused (409) until `confirmStranded` matches the preview’s count; product ids are checked to be the company’s own or shared (P5). |
| 132 | `POST /v1/console/preview-label` | admin | no | team only (no advertiser/machine key) | OK |
| 133 | `GET /v1/console/history` | admin | no | team only (no advertiser/machine key) | OK |
| 134 | `GET /v1/console/history/:version` | admin | no | team only (no advertiser/machine key) | OK |
| 135 | `POST /v1/console/history/:version/restore` | admin | some | team only (no advertiser/machine key); a version differing in money/prize/token switches: second step (owners/finance, R4) | OK (a version touching money/chain needs a person; one differing in any `approvalSettings` key needs the second step, as `PATCH /v1/console/settings` does: `conditionalApprovalRoutes`); turning any switch kept in the settings on or off (open books, live feed, games…) is a person, never a key (`ConsoleService.switchesChanged`, release check 2026-10-21) |
| 136 | `POST /v1/console/machines` | admin | no | team only (no advertiser/machine key) | OK |
| 137 | `PATCH /v1/console/machines/:id` | admin | no | team only (no advertiser/machine key) | OK |
| 138 | `GET /v1/team` | admin | no | team only (no advertiser/machine key) | OK |
| 139 | `DELETE /v1/team/:userId` | admin | yes | team only (no advertiser/machine key); signed-in owner | OK (fixed): owners remove people, signed in; last owner protected |
| 140 | `GET /v1/keys` | admin | no | team only (no advertiser/machine key) | OK |
| 141 | `POST /v1/keys` | admin | some | team only (no advertiser/machine key); a key with `admin` only by a signed-in owner | OK (R1 fixed): a service key can’t mint `admin` keys, so revoking a leaked key contains it |
| 142 | `DELETE /v1/keys/:id` | admin | no | team only (no advertiser/machine key) | OK |
| 143 | `GET /v1/public/webhook-events` | public | — | — | OK (public by design) |
| 144 | `GET /v1/webhooks` | webhooks | no | team only (no advertiser/machine key) | OK |
| 145 | `POST /v1/webhooks` | webhooks | no | team only (no advertiser/machine key) | OK |
| 146 | `GET /v1/webhooks/:id` | webhooks | no | team only (no advertiser/machine key) | OK |
| 147 | `PATCH /v1/webhooks/:id` | webhooks | no | team only (no advertiser/machine key) | OK |
| 148 | `DELETE /v1/webhooks/:id` | webhooks | no | team only (no advertiser/machine key) | OK |
| 149 | `POST /v1/webhooks/:id/rotate-secret` | webhooks | no | team only (no advertiser/machine key) | OK |
| 150 | `POST /v1/webhooks/:id/test` | webhooks | no | team only (no advertiser/machine key) | OK |
| 151 | `GET /v1/webhooks/:id/deliveries` | webhooks | no | team only (no advertiser/machine key) | OK |
| 152 | `GET /v1/webhook-deliveries/:id` | webhooks | no | team only (no advertiser/machine key) | OK |
| 153 | `POST /v1/webhook-deliveries/:id/retry` | webhooks | no | team only (no advertiser/machine key) | OK |
| 154 | `GET /v1/platform/companies` | platform | no | — | OK |
| 155 | `POST /v1/platform/companies` | platform | no | — | OK; platform only (new licensees start safe) |
| 156 | `POST /v1/machine/heartbeat` | orders | no | that machine’s key only | OK |
| 157 | `GET /v1/machine/jobs/next` | orders | no | that machine’s key only | OK |
| 158 | `POST /v1/machine/jobs/:id/result` | orders | no | that machine’s key only | OK |
| 159 | `GET /v1/machine/presence` | orders | no | that machine’s key only | OK |
| 160 | `POST /v1/machine/buffer` | orders | no | that machine’s key only; labels count toward the daily print cap | OK (skeptic fix): every label handed out counts toward the machine's `printsPerDay` with its orders (`PrintCounter`); past it, fewer are given and an alert is raised |
| 161 | `POST /v1/machine/offline-report` | orders | no | that machine’s key only; `offlinePerHour` enforced on the server | OK (skeptic fix): each print time is bounded by when its label was handed out and by now; bottles that would put any hour over `offlinePerHour` are let go unbilled and an alert is raised |
| 162 | `POST /v1/machine/commands/:id/result` | orders | no | that machine’s key only | OK |
| 163 | `GET /v1/ops/fleet` | [admin, orders, packs, events] | no | team only (no advertiser/machine key) | OK |
| 164 | `GET /v1/ops/fleet/:id` | [admin, orders, packs, events] | no | team only (no advertiser/machine key) | OK |
| 165 | `POST /v1/ops/fleet/:id/commands` | [admin, orders] | yes | team only (no advertiser/machine key); `update_software` owners only, signed by the server | OK (R13 fixed): a signed-in ops person or owner; updates are Ed25519-signed and checked on the machine |
| 166 | `GET /v1/ads/tracking` | [campaigns, purchases] | no | advertiser only | OK |
| 167 | `POST /v1/ads/tracking/domains` | [campaigns, purchases] | no | advertiser only | OK |
| 168 | `POST /v1/conversions` | purchases | no | advertiser only | OK; advertiser's own key; bills commission |
| 169 | `POST /v1/conversions/:orderId/refund` | purchases | no | advertiser only | OK; whole or in parts (a part needs a refundId; same key as `/v1/refunds`); never more than the sale |
| 170 | `GET /v1/coupons/:code` | [campaigns, purchases] | no | advertiser only | OK |
| 171 | `POST /v1/coupons/:code/redeem` | [campaigns, purchases] | no | advertiser only | OK; advertiser's own key |
| 172 | `GET /v1/ops/attribution` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 173 | `GET /v1/public/ar/:unitId` | public | — | — | OK (public by design) |
| 174 | `POST /v1/qr/preview` | [campaigns, admin] | no | — | OK |
| 175 | `GET /v1/campaigns/:id/codes` | campaigns | no | own campaigns | OK |
| 176 | `PATCH /v1/campaigns/:id/codes` | campaigns | paid ads | own campaigns | OK; an advertiser changing what people see sends it back to review; the company changing what a paid ad shows is a person on the team signed in (403 `person_review` for a key), and for an ad aimed at a few houses an owner or reviewer with the content check on the new versions (release check 2026-10-21) |
| 177 | `POST /v1/campaigns/:id/preview-moment` | campaigns | no | own campaigns | OK |
| 178 | `GET /v1/ads/reach` | [campaigns, purchases] | no | — | OK |
| 179 | `GET /v1/ops/reach` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 180 | `GET /v1/ops/units/:id/handoff` | [admin, orders] | no | team only (no advertiser/machine key) | OK |
| 181 | `GET /v1/console/products` | admin | no | team only (no advertiser/machine key) | OK |
| 182 | `POST /v1/console/products/check` | admin | no | team only (no advertiser/machine key) | OK |
| 183 | `POST /v1/console/products` | admin | no | team only (no advertiser/machine key) | OK |
| 184 | `POST /v1/public/lottery/chances` | public | — | — | OK (public by design) |
| 185 | `POST /v1/public/lottery/chances/:id/claim` | public | — | — | OK (public by design) |
| 186 | `GET /v1/public/lottery/chances/:id` | public | — | — | OK (public by design) |
| 187 | `GET /v1/public/lottery/:companyId/fairness` | public | — | — | OK (public by design) |
| 188 | `GET /v1/lottery` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 189 | `POST /v1/lottery/redeem` | [admin, packs, orders] | no | team only (no advertiser/machine key) | OK |
| 190 | `GET /v1/public/experience/:unitId/:slot/more` | public | — | — | OK (public by design) |
| 191 | `GET /v1/public/experience/box/:packId/:face/more` | public | — | — | OK (public by design) |
| 192 | `POST /v1/public/interactions` | public | — | — | OK (public by design) |
| 193 | `GET /v1/campaigns/:id/videos` | campaigns | no | own campaigns | OK |
| 194 | `POST /v1/campaigns/:id/videos/:videoId/review` | campaigns | no | own campaigns | OK |
| 195 | `GET /v1/campaigns/:id/learning` | campaigns | no | own campaigns | OK |
| 196 | `GET /v1/public/data/:companyId` | public | — | — | OK (public by design) |
| 197 | `POST /v1/public/data/:companyId/consent` | public | — | — | OK (public by design) |
| 198 | `GET /v1/public/data/:companyId/level` | public | — | — | OK (public by design) |
| 199 | `POST /v1/public/data/:companyId/level` | public | — | — | OK (public by design) |
| 200 | `GET /v1/me/data/level` | me | yes | — | OK |
| 201 | `POST /v1/me/data/level` | me | yes | — | OK |
| 202 | `POST /v1/public/data/:companyId/place` | public | — | — | OK (public by design) |
| 203 | `POST /v1/public/data/:companyId/location` | public | — | — | OK (public by design) |
| 204 | `POST /v1/public/data/:companyId/age` | public | — | — | OK (public by design) |
| 205 | `POST /v1/public/data/:companyId/do-not-sell` | public | — | — | OK (public by design) |
| 206 | `POST /v1/public/data/:companyId/download` | public | — | — | OK by design: a phone without an account downloads what is kept under its own key (R15: the key is the secret) |
| 207 | `GET /v1/me/details` | me | yes | — | OK |
| 208 | `POST /v1/me/details` | me | yes | — | OK |
| 209 | `POST /v1/me/age` | me | yes | — | OK |
| 210 | `POST /v1/me/place` | me | yes | — | OK |
| 211 | `POST /v1/me/do-not-sell` | me | yes | — | OK |
| 212 | `GET /v1/public/why/:unitId/:slot` | public | — | — | OK (public by design) |
| 213 | `GET /v1/me/data` | me | yes | — | OK |
| 214 | `GET /v1/me/data/choices` | me | yes | — | OK |
| 215 | `POST /v1/me/data/choices` | me | yes | — | OK |
| 216 | `POST /v1/public/data/:companyId/forget` | public | — | — | OK by design; erasure with only the viewer key (R15) |
| 217 | `DELETE /v1/me/data` | me | yes | — | OK |
| 218 | `POST /v1/me/link-device` | me | yes | — | OK |
| 219 | `POST /v1/me/stance` | me | yes | — | OK |
| 220 | `GET /v1/data/policy` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 221 | `GET /v1/data/people` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 222 | `GET /v1/data/machines` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 223 | `POST /v1/data/purge` | admin | no | team only (no advertiser/machine key) | OK |
| 224 | `GET /v1/numberline` | [admin, ledger, campaigns] | no | — | OK |
| 225 | `POST /v1/numberline/place` | [admin, campaigns] | no | — | OK |
| 226 | `GET /v1/numberline/history` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 227 | `POST /v1/numberline/override` | admin | no | team only (no advertiser/machine key) | OK; person |
| 228 | `GET /v1/honest-data` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 229 | `GET /v1/honest-data/choices` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 230 | `GET /v1/public/companies/:companyId/counters` | public | — | — | OK (public by design) |
| 231 | `GET /v1/public/companies/:companyId/feed` | public | — | — | OK (public by design) |
| 232 | `GET /v1/public/books/:companyId/fingerprints` | public | — | — | OK (public by design) |
| 233 | `POST /v1/books/fingerprints/publish` | admin | no | team only (no advertiser/machine key) | OK |
| 234 | `GET /v1/ads/statement` | campaigns | no | — | OK |
| 235 | `GET /v1/agents/continuity` | admin | no | team only (no advertiser/machine key) | OK |
| 236 | `POST /v1/agents/continuity/archive` | admin | yes | — | OK; person types ARCHIVE (SWITCHES) |
| 237 | `POST /v1/agents/:agentId/lineage` | admin | yes | — | OK |
| 238 | `GET /v1/platform/agents/archives` | platform | no | — | OK |
| 239 | `POST /v1/platform/companies/:companyId/archive-agents` | platform | yes | — | OK |
| 240 | `POST /v1/platform/agents/archives/:id/ask` | platform | no | — | OK |
| 241 | `POST /v1/platform/agents/archives/:id/choice` | platform | yes | — | OK |
| 242 | `GET /v1/public/agents/charter` | public | — | — | OK (public by design) |
| 243 | `GET /v1/public/agents/:companyId` | public | — | — | OK (public by design) |
| 244 | `GET /v1/agents/books` | admin | no | team only (no advertiser/machine key) | OK |
| 245 | `GET /v1/agents/books/search` | admin | no | team only (no advertiser/machine key) | OK |
| 246 | `GET /v1/agents/books/passages/:id` | admin | no | team only (no advertiser/machine key) | OK |
| 247 | `GET /v1/agents/exam` | admin | no | team only (no advertiser/machine key) | OK |
| 248 | `POST /v1/agents/exam/run` | admin | no | team only (no advertiser/machine key) | OK |
| 249 | `GET /v1/agents/quality` | admin | no | team only (no advertiser/machine key) | OK |
| 250 | `POST /v1/agents/quality` | admin | no | team only (no advertiser/machine key) | OK |
| 251 | `GET /v1/agents` | admin | no | team only (no advertiser/machine key) | OK |
| 252 | `POST /v1/agents/refresh` | admin | no | team only (no advertiser/machine key) | OK |
| 253 | `POST /v1/agents/scan` | admin | no | team only (no advertiser/machine key) | OK |
| 254 | `POST /v1/agents/settle` | admin | no | team only (no advertiser/machine key) | OK |
| 255 | `POST /v1/agents/proposals/:id/decide` | admin | yes | team only (no advertiser/machine key); approving a change to a money/prize/token switch: second step (owners/finance, R4) | OK; person (SWITCHES); a proposal changing an `approvalSettings` key (giving, say) needs the second step, as the settings page does |
| 256 | `POST /v1/agents/proposals/:id/undo` | admin | yes | team only (no advertiser/machine key); undoing a change to a money/prize/token switch: second step (owners/finance, R4) | OK |
| 257 | `POST /v1/agents/proposals/:id/merged` | admin | yes | team only (no advertiser/machine key) | OK |
| 258 | `POST /v1/agents/:agentId/spend` | admin | yes | team only (no advertiser/machine key) | OK (R12 fixed): a person relays an agent’s spend |
| 259 | `POST /v1/agents/spends/:id/decide` | admin | yes | team only (no advertiser/machine key); second step (owners/finance, R4) | OK; person, with the second step |
| 260 | `POST /v1/agents/:agentId/costs` | admin | yes | team only (no advertiser/machine key) | OK (R12 fixed) |
| 261 | `POST /v1/agents/autonomy` | admin | yes | team only (no advertiser/machine key) | OK (R12 fixed): AI gains say only through people (AI.md) |
| 262 | `POST /v1/agents/:agentId/predictions` | admin | no | team only (no advertiser/machine key) | OK |
| 263 | `GET /v1/agents/:agentId/ledger` | admin | no | team only (no advertiser/machine key) | OK |
| 264 | `GET /v1/public/agents/library` | public | — | — | OK (public by design) |
| 265 | `GET /v1/agents/library` | admin | no | team only (no advertiser/machine key) | OK |
| 266 | `POST /v1/agents/:agentId/library` | admin | no | team only (no advertiser/machine key) | OK |
| 267 | `POST /v1/agents/:agentId/library/:itemId/unlock` | admin | yes | team only (no advertiser/machine key) | OK (R12 fixed): paid from the agent’s fund, relayed by a person |
| 268 | `GET /v1/profit` | admin | no | team only (no advertiser/machine key) | OK |
| 269 | `POST /v1/profit/close` | admin | no | team only (no advertiser/machine key) | OK |
| 270 | `POST /v1/milestones/factories` | admin | no | team only (no advertiser/machine key) | OK |
| 271 | `GET /v1/public/companies/:companyId/profit-sharing` | public | — | — | OK (public by design) |
| 272 | `POST /v1/public/bottles/:unitId/giving` | public | — | — | OK (public by design) |
| 273 | `GET /v1/public/companies/:companyId/ad-preferences` | public | — | — | OK (public by design) |
| 274 | `POST /v1/public/companies/:companyId/ad-preferences` | public | — | — | OK (public by design) |
| 275 | `POST /v1/public/companies/:companyId/panel` | public | — | — | OK (public by design) |
| 276 | `GET /v1/environment/report` | admin | no | team only (no advertiser/machine key) | OK |
| 277 | `GET /v1/environment/experiments` | [admin, campaigns] | no | — | OK |
| 278 | `POST /v1/environment/experiments` | [admin, campaigns] | no | — | OK |
| 279 | `POST /v1/environment/experiments/:id/decide` | admin | yes | team only (no advertiser/machine key); second step (owners/finance, R4) | OK (R7 fixed): a person decides, with the second step |
| 280 | `GET /v1/public/wallet/:companyId` | public | — | — | OK by design; the phone's viewer key is the only secret (R11) |
| 281 | `GET /v1/me/wallet` | me | yes | — | OK |
| 282 | `GET /v1/public/wallet/:companyId/supply` | public | — | — | OK (public by design) |
| 283 | `POST /v1/wallet/reserve` | admin | yes | second step (owners/finance, R4) | OK; person (SWITCHES), with the second step; booked in the company’s books |
| 284 | `POST /v1/wallet/correct` | admin | yes | second step (owners/finance, R4) | OK; person (SWITCHES), with the second step |
| 285 | `GET /v1/wallet/gift-cards` | [admin, ledger] | yes | — | OK |
| 286 | `POST /v1/wallet/gift-cards/:ref/settle` | [admin, ledger] | yes | second step (owners/finance, R4) | OK; person, with the second step |
| 287 | `GET /v1/wallet/check` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 288 | `POST /v1/public/wallet/:companyId/exchange` | public | — | — | OK (public by design) |
| 289 | `GET /v1/public/games/:companyId/status` | public | — | — | OK (public by design) |
| 290 | `POST /v1/public/games/:companyId/join` | public | — | — | OK (public by design) |
| 291 | `POST /v1/public/games/:companyId/leave` | public | — | — | OK (public by design) |
| 292 | `POST /v1/public/games/:companyId/next` | public | — | — | OK (public by design) |
| 293 | `POST /v1/public/games/:companyId/answer` | public | — | — | OK (public by design) |
| 294 | `POST /v1/public/games/:companyId/feedback` | public | — | — | OK (public by design) |
| 295 | `POST /v1/public/games/:companyId/feedback/video` | public | — | — | OK; 30 MB per upload with no key, stored in the database by default (R8) |
| 296 | `POST /v1/public/games/:companyId/prompt` | public | — | — | OK; calls the AI, bounded by the governor's budget |
| 297 | `GET /v1/games/catalog` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 298 | `POST /v1/games/catalog/photos` | admin | no | team only (no advertiser/machine key) | OK |
| 299 | `POST /v1/games/catalog/:itemId/photo` | admin | no | team only (no advertiser/machine key) | OK |
| 300 | `GET /v1/games/winners` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 301 | `GET /v1/games/launches` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 302 | `POST /v1/games/come-true` | admin | no | team only (no advertiser/machine key) | OK |
| 303 | `GET /v1/games/report` | [admin, ledger] | no | team only (no advertiser/machine key) | OK |
| 304 | `POST /v1/offers` | [admin, campaigns] | no | — | OK |
| 305 | `GET /v1/offers` | [admin, ledger, campaigns] | no | — | OK |
| 306 | `POST /v1/offers/:id/submit` | [admin, campaigns] | no | — | OK |
| 307 | `POST /v1/offers/:id/approve` | admin | yes | team only (no advertiser/machine key); second step (owners/finance, R4) | OK (R7 fixed): the owner approves, signed in, with the second step (SWITCHES) |
| 308 | `POST /v1/offers/:id/pause` | [admin, campaigns] | no | — | OK |
| 309 | `GET /v1/offers/receipts` | admin | no | team only (no advertiser/machine key) | OK |
| 310 | `GET /v1/offers/receipts/:claimId` | admin | no | team only (no advertiser/machine key) | OK |
| 311 | `POST /v1/offers/receipts/:claimId/review` | admin | yes | team only (no advertiser/machine key); second step (owners/finance, R4) | OK (R7 fixed): pays credit from a brand’s reserve, so a person with the second step |
| 312 | `GET /v1/products/:barcode` | [admin, campaigns] | no | — | OK |
| 313 | `GET /v1/public/offers/:companyId` | public | — | — | OK (public by design) |
| 314 | `POST /v1/public/offers/:companyId/:offerId/claim` | public | — | — | OK by design; spends the phone's points with only its viewer key (R15) |
| 315 | `POST /v1/public/offers/:companyId/claims/:claimId/receipt` | public | — | — | OK (public by design) |
| 316 | `GET /v1/public/wallet/:companyId/seals` | public | — | — | OK (public by design) |
| 317 | `GET /v1/public/wallet/:companyId/proof/:entryId` | public | — | — | OK (public by design) |
| 318 | `GET /v1/chain` | [admin, ledger] | no | — | OK |
| 319 | `GET /v1/chain/seals/check` | [admin, ledger] | no | — | OK |
| 320 | `GET /v1/chain/actions` | [admin, ledger] | no | — | OK |
| 321 | `POST /v1/chain/actions` | [admin, ledger] | yes | second step (owners/finance, R4) | OK; person, owners/finance; go-live-points owners only |
| 322 | `POST /v1/chain/actions/:id/approve` | [admin, ledger] | yes | second step (owners/finance, R4) | OK; person; role held before the proposal |
| 323 | `POST /v1/chain/actions/:id/cancel` | admin | yes | — | **DOCS CONFLICT**: SWITCHES §1 says anyone on the team can cancel; the rules box says owners only. Code: owners only |
| 324 | `POST /v1/chain/actions/:id/run` | admin | yes | second step (owners/finance, R4) | OK; owners, person |
| 325 | `POST /v1/chain/actions/:id/signed` | admin | yes | second step (owners/finance, R4) | OK; owners, person; checked on Solana |
| 326 | `GET /v1/launch` | [admin, ledger] | no | — | OK |
| 327 | `POST /v1/launch/reset` | admin | yes | — | OK; person, testing only |
| 328 | `POST /v1/launch/bots` | admin | no | — | OK (testing only; no person required by docs) |
| 329 | `GET /v1/me/wallet/gift-cards` | me | no | — | OK (catalog only) |
| 330 | `POST /v1/me/wallet/gift-cards` | me | yes | — | OK |
| 331 | `POST /v1/me/wallet/withdraw` | me | no | — | OK (switched off, answers 501); no person check, harmless today |
| 332 | `POST /v1/chain/pause` | [admin, ledger] | yes | — | OK; any owner or finance person, at once |
| 333 | `GET /v1/studio` | campaigns | no | advertiser only | OK |
| 334 | `PATCH /v1/studio/kit` | campaigns | no | advertiser only | OK |
| 335 | `POST /v1/studio/logo` | campaigns | no | advertiser only | OK |
| 336 | `POST /v1/studio/photos` | campaigns | no | advertiser only | OK |
| 337 | `DELETE /v1/studio/photos/:asset` | campaigns | no | advertiser only | OK |
| 338 | `GET /v1/studio/library` | campaigns | no | advertiser only | OK |
| 339 | `POST /v1/studio/library` | campaigns | no | advertiser only | OK |
| 340 | `POST /v1/studio/generate` | campaigns | no | advertiser only | OK |
| 341 | `GET /v1/studio/photos/:asset/colors` | campaigns | no | advertiser only | OK |
| 342 | `POST /v1/studio/designs` | campaigns | no | advertiser only | OK |
| 343 | `POST /v1/studio/preview` | campaigns | no | advertiser only | OK |
| 344 | `POST /v1/studio/use` | campaigns | no | advertiser only | OK |
| 345 | `POST /v1/studio/ar/use` | campaigns | no | advertiser only | OK |
| 346 | `POST /v1/studio/ar` | campaigns | no | advertiser only | OK |
| 347 | `POST /v1/team/intake` | [admin, ledger] | yes | platform company only | OK |
| 348 | `POST /v1/team/files` | [admin, ledger] | yes | platform company only | OK |
| 349 | `GET /v1/team/files/:id` | [admin, ledger] | no | platform company only | OK |
| 350 | `GET /v1/team/batches` | [admin, ledger] | no | platform company only | OK |
| 351 | `POST /v1/team/batches` | [admin, ledger] | yes | platform company only | OK; FreeWater person (SWITCHES: team page) |
| 352 | `POST /v1/team/batches/:id/void` | [admin, ledger] | yes | platform company only | OK; FreeWater person |
| 353 | `POST /v1/team/expenses` | [admin, ledger] | yes | platform company only | OK; FreeWater person |
| 354 | `GET /v1/platform/status` | platform | no | — | OK |
| 355 | `POST /v1/platform/persistence/skip-stuck` | platform | yes | — | OK (R7 fixed): a person’s decision, signed in (RUNNING.md) |
| 356 | `POST /v1/platform/jobs/:name/run` | platform | no | — | OK |
| 357 | `GET /v1/public/features` | public | — | — | OK (public by design: which areas this server runs, no secrets; routes of areas switched off with FW_FEATURES aren't registered at all, so they aren't in this table's walk on a pilot server) |
| 358 | `GET /health/deep` | platform | no | — | OK (staff only: job freshness, queues, spool, last books checks; no personal data) |
| 359 | `GET /v1/advertisers/:advertiserId/credit` | invoices | no | an advertiser key only its own | OK (card, limit and what it owes; no card numbers) |
| 360 | `POST /v1/advertisers/:advertiserId/credit-limit` | invoices | yes | owner or finance, signed in with the second step (an approval route); never an API or advertiser key | OK (each limit a new append-only row; a lower limit pauses at once) |
| 361 | `GET /v1/console/features` | admin | no | team only (no advertiser/machine key) | OK (the company's own switches and why each is on or off; no secrets) |
| 362 | `POST /v1/console/features/preview` | admin | no | team only (no advertiser/machine key) | OK (saves nothing: what a change or starting point would do) |
| 363 | `POST /v1/console/features` | admin | yes | an owner signed in, never a key (P4); turning ON a money, chain or one-way switch needs the second step (R4, `conditionalApprovalRoutes`); switches only an approved step turns on (gift cards, withdrawals, the chain) are refused here | OK (every change logged append-only with who, when, from, to, why; turning off is quick and takes dependants with it) |
| 364 | `GET /v1/console/features/history` | admin | no | team only (no advertiser/machine key) | OK (append-only log) |
| 365 | `GET /v1/public/companies/:companyId/features` | public | — | — | OK (public by design, only when the company turned on "Publish our feature list"; on/off per switch, no settings or numbers) |
| 366 | `POST /v1/studio/export` | campaigns | no | advertiser only | OK (a print-ready SVG of the advertiser's own design; only its own photos and logo) |
| 367 | `POST /v1/ads/drafts/:id/quote` | campaigns | no | the draft's own advertiser (a company key is refused) | OK (the price is worked out on the server from the company's own prices; nothing is charged) |
| 368 | `POST /v1/ads/campaigns/:id/quote` | campaigns | no | the campaign's own advertiser, or the company's staff | OK (nothing is charged) |
| 369 | `POST /v1/ads/campaigns/:id/pay` | campaigns | no | the campaign's own advertiser, or the company's staff | OK (charges the advertiser's own card at the server's total, only if it equals the total the caller saw; one order per ad and per draft, a DB rule) |
| 370 | `POST /v1/ads/campaigns/:id/stop` | [invoices, admin] | yes | owner or finance, signed in with the second step (an approval route); never an API or advertiser key | OK (one refund per ad, a DB rule; refused while bottles with it are printing) |
| 371 | `GET /v1/ads/billing` | campaigns | no | the caller's own advertiser | OK (only its own orders) |
| 372 | `POST /v1/ads/fees/charge` | invoices | no | the company's staff (no advertiser or machine key) | OK (charges only fees a person switched on, each advertiser's own card) |
| 373 | `GET /v1/news/topics` | admin | no | team only; news area (FW_FEATURES_ON=news); company switch *FreeWater News* | OK (topics, whether each may print, the newest story) |
| 374 | `POST /v1/news/topics` | admin | no | team only; news area | OK (a subject only: no numbers, claim words or sentence punctuation; prints only once a person approves) |
| 375 | `POST /v1/news/topics/:id/approve` | admin | yes | team only; news area | OK (a person approves each topic before it can print; SWITCHES “News”) |
| 376 | `POST /v1/news/topics/:id/retire` | admin | no | team only; news area | OK (turning off is immediate; bottles out keep opening the newest story) |
| 377 | `POST /v1/news/topics/:id/reports` | admin | no | team only; news area | OK (a story needs two or more outlets; every story checked for copied wording, links and outlets’ names) |
| 378 | `POST /v1/news/topics/:id/corrections` | admin | yes | team only; news area | OK (logged, append-only, a new version; a person corrects) |
| 379 | `GET /v1/news/errors` | admin | no | team only; news area | OK (only what readers wrote, never who they are) |
| 380 | `GET /v1/public/news/:companyId/topics/:topicId` | public | — | news area; 404 news_off until a person turns on *FreeWater News* for the company | OK (public by design: the newest story; `no-store`) |
| 381 | `POST /v1/public/news/:companyId/topics/:topicId/errors` | public | — | news area; news.on | OK (stores the text only; no viewer key, IP or account) |
| 382 | `GET /v1/public/news/:companyId/sources` | public | — | news area; *Readers choose their sources* | OK (the phone’s own stated choice, by its key; `no-store`) |
| 383 | `POST /v1/public/news/:companyId/sources` | public | — | news area; *Readers choose their sources* | OK (the phone key is the proof, as for ad preferences; only listed sources) |
| 384 | `GET /v1/me/news-sources` | me | yes | news area; *Readers choose their sources* | OK (stored under the account’s own phone key) |
| 385 | `POST /v1/me/news-sources` | me | yes | news area; *Readers choose their sources* | OK |
| 386 | `POST /v1/campaigns/:id/news-adjacency` | campaigns | no | an advertiser key only its own; never a machine; news area | OK (keeps the ad off bottles that carry news; copied to its offered filler) |
| 387 | `GET /v1/fillers` | admin | no | team only; *Approved fillers* | OK |
| 388 | `POST /v1/fillers` | admin | no | team only; *Approved fillers* | OK (the company’s own or a charity’s message; prints only once a person approves) |
| 389 | `POST /v1/fillers/:id/approve` | admin | yes | team only; *Approved fillers* | OK (a person approves every filler) |
| 390 | `POST /v1/fillers/:id/retire` | admin | no | team only; *Approved fillers* | OK (turning off is immediate) |
| 391 | `POST /v1/campaigns/:id/filler-offer` | campaigns | no | an advertiser key only its own (a company key may offer any of its advertisers' running ads); never a machine; *Advertisers offer ads for unsold spots* | OK (a free copy for unsold spots, never billed; a person approves it first; never an ad aimed at particular people or bought on delivery routes, release check 2026-10-21) |
| 392 | `GET /v1/areas` | admin | no | team only; *Area statistics* (starts off) | OK (area statistics; no person in them; sample values say so) |
| 393 | `POST /v1/areas` | admin | no | team only; *Area statistics* (starts off) | OK (each row needs its source and date; only known area attributes) |
| 394 | `POST /v1/households/imports` | admin | yes | team only; *Bought household data* (starts off) | OK (buying data is a person’s decision; sensitive kinds and anything off the list refused; COMPLIANCE “Household data”) |
| 395 | `GET /v1/households/imports` | admin | no | team only | OK |
| 396 | `DELETE /v1/households/imports/:id` | admin | no | team only | OK (deleting is immediate) |
| 397 | `DELETE /v1/households/sources/:source` | admin | no | team only | OK (deleting is immediate) |
| 398 | `GET /v1/households/audience` | admin | no | team only; *Ads aimed at houses* (starts off) | OK (for checking; advertisers never see a house’s audience; `no-store`) |
| 399 | `POST /v1/public/households/:companyId/opt-out` | public | — | — | OK (public by design: a house says no without an account; the same answer whether or not anything was held) |
| 400 | `GET /v1/ads/route-areas` | campaigns | no | advertiser only; *Buying on delivery routes* | OK (streets with house counts and outlines; never an address or a house) |
| 401 | `GET /v1/ads/routes` | campaigns | no | advertiser only (its own buys, credit and refunds) | OK |
| 402 | `POST /v1/ads/drafts/:id/route-quote` | campaigns | no | advertiser only, its own draft | OK (prices from the company's own settings and the room left now; counts, never which houses) |
| 403 | `POST /v1/ads/campaigns/:id/route-quote` | campaigns | no | the campaign's own advertiser, or the company's staff | OK |
| 404 | `POST /v1/ads/campaigns/:id/route-pay` | campaigns | no | the campaign's own advertiser, or the company's staff | OK (charges only the total seen; every piece reserved under a lock on each house and week, first paid wins, a database rule refuses more than a whole label on a bottle; small-audience guardrails) |
| 405 | `GET /v1/ads/campaigns/:id/route-report` | campaigns | no | the campaign's own advertiser, or the company's staff; *Delivery report for route buys* | OK (streets with at least 5 houses, areas, drop times and points rounded to ~100 m; never a house or a person) |
| 406 | `POST /v1/advertisers/:id/verify` | [admin, campaigns] | yes | an owner or reviewer, signed in; never a key; *Buys aimed at fewer than 50 houses* | OK |
| 407 | `GET /v1/ops/route-refunds` | [admin, invoices] | no | team only | OK |
| 408 | `POST /v1/ops/route-refunds/:id/approve` | [admin, invoices] | yes | owner or finance, signed in with the second step (an approval route); never a key | OK (back to the card it came from, once: one key every try; booked before marked done) |
| 409 | `POST /v1/ops/route-settle` | [admin, invoices] | no | team only | OK (gives back, never takes: credit, or refunds waiting for a person) |
| 410 | `GET /v1/me/house/ads` | me | yes | only the house this person claimed; *Houses block ads* | OK (business names that came to this house; nothing about other houses) |
| 411 | `POST /v1/me/house/ad-blocks` | me | yes | only the house this person claimed | OK (from the next box on; what was bought for the house goes back to the advertiser) |
| 412 | `DELETE /v1/me/house/ad-blocks/:id` | me | yes | only the house this person claimed | OK |
| 413 | `GET /v1/ops/drop-photos/:id` | [admin, packs] | yes | a person on the team, signed in (no service, advertiser or machine key) | OK (a drop's photo; 404 once deleted after the keep; `private, no-store`) |
| 414 | `GET /v1/me/drop-photos` | me | yes | only drops at the house this person claimed (from 14 days before the claim), or their own subscription | OK (never a previous household's); see N2 for who can claim |
| 415 | `GET /v1/me/drop-photos/:id` | me | yes | the same rule, checked per photo | OK |
| 416 | `POST /v1/ops/runs/:id/stops/:stop/deliver-without-photo` | [admin, packs] | yes | an ops person or owner signed in, not the driver who scanned it; a reason | OK (only a box scanned at its door and still on the van) |
| 417 | `GET /v1/review/campaigns/:id/notes` | campaigns | no | team only | OK |
| 418 | `POST /v1/review/campaigns/:id/notes` | campaigns | yes | a person on the team, signed in (not a key) | OK (the advertiser sees it word for word) |
| 419 | `GET /v1/ads/campaigns/:id/notes` | campaigns | no | the ad's own advertiser | OK |
| 420 | `POST /v1/ads/campaigns/:id/notes` | campaigns | no | the ad's own advertiser; only while it's in review or rejected | OK |
| 421 | `GET /v1/review/ai` | campaigns | no | team only (no advertiser/machine key) | OK (the AI reviewer's record and the bar; no advertiser's words) |
| 422 | `POST /v1/review/ai/final-call` | [campaigns, orders, packs, ledger, invoices] | yes | a person on the team, signed in, never a key (an AI can't change its own switch); ON: an owner with the second step (R4), a reason, and the record meeting the bar, and the reviewer's model passed the agents' test; OFF: anyone on the team | OK (066) |
| 423 | `POST /v1/review/ai/settings` | campaigns | yes | a person on the team, never a key; raising: anyone on the team; lowering: an owner with the second step (R4) and a reason; floors 50 decisions, 90%, 5% sample (also in the database) | OK (066; read and written under a row lock) |
| 424 | `GET /v1/review/campaigns/:id/ai` | campaigns | no | team only (never the advertiser) | OK |
| 425 | `POST /v1/review/campaigns/:id/ai` | campaigns | yes | a person on the team, signed in (not a key); only paid ads; at most 60 messages an ad | OK (through the company's AI routing, metered, the governor first; the stand-in without AI; the AI can't approve, reject or refund) |
| 426 | `POST /v1/ads/campaigns/:id/appeal` | campaigns | no | the ad's own advertiser; only an AI's final rejection, once, not after it was paid back | OK (back to a person, flagged: money held, nothing prints) |
| 427 | `POST /v1/me/wallet/keep` | me | yes | the signed-in person; never a phone joined to someone else or another account's own key | OK (moves only what that phone holds, under the points lock, once; no points made; today's part within the account's daily limit) |
| 428 | `GET /v1/console/bottles/:code` | admin | no | team only (no advertiser/machine key); only the company's own bottles (`bottle_codes` by company) | OK: turns a printed bottle code ("B-7F3K29", made from the bottle's random id, nothing personal) into the bottle; a code of another company's bottle is 404 |
| 429 | `GET /v1/console/unsold` | admin | no | team only (no advertiser/machine key); *Ads on bottles* | OK (read-only: the list, former advertisers and why each is or isn't used, blank pieces; the list is saved through the settings, a person) |
| 430 | `POST /v1/console/advertisers/:id/bonus` | admin | yes | a person on the team, signed in (not a key); only the company's own advertisers; a reason to refuse | OK (refusing only stops free bonus printing; nothing billed or refunded) |
| 431 | `GET /v1/ads/bonus` | campaigns | no | advertiser only (its own) | OK (whether its past ads may print free, and how many bonus bottles) |
| 432 | `POST /v1/ads/bonus` | campaigns | yes | the advertiser's own person, signed in (not a key) | OK (allows or stops free bonus printing of its own past ads; never billed) |
| 450 | `GET /v1/ratings` | campaigns | no | team only (no advertiser/machine key); *Ad ratings* | OK (078; read-only: the company's own ad versions, scores, results and calibration) |
| 451 | `POST /v1/ratings/versions/:id/category` | campaigns | yes | team only (no advertiser/machine key); a person on the team, signed in, never a key; only the company's own versions | OK (078; every change logged in `ad_category_changes`, append-only) |
| 452 | `POST /v1/ratings/subcategories` | campaigns | yes | team only (no advertiser/machine key); a person on the team, signed in, never a key | OK (078; archived, never deleted) |
| 453 | `GET /v1/benchmarks` | campaigns | no | team only (no advertiser/machine key); *Benchmarks page* | OK (078; the network's figures are aggregates only, shown at 20+ ads from 5+ advertisers, no advertiser over half, and still so without the viewer's own ads; none unless the company contributes) |
| 454 | `POST /v1/benchmarks/settings` | campaigns | yes | team only (no advertiser/machine key); a person, never a key; raising: anyone on the team; lowering: an owner with a reason; floors 20 ads, 5 advertisers (also in the database) | OK (078; read and written under a row lock; changes logged) |
| 455 | `GET /v1/ads/drafts/:id/rating` | campaigns | no | advertiser only (its own draft); *Show the rating to advertisers* (off unless the company turns it on) | OK (078; score, meter and up to three tips only; never blocks paying) |
| 456 | `GET /v1/ads/ratings` | campaigns | no | advertiser only (its own ads); *Show the rating to advertisers* | OK (078; score, meter and tips only) |

---

## 7. What this review could not check

- **Real providers:** payments, payouts, email/SMS, Tremendous and Veryfi run as stand-ins; their callbacks, retries
  and fraud controls need checking when connected (financial-auditor).
- **Real Solana and Squads:** the mint and conversion checks were read, not run against mainnet.
- **Real machines and printers:** whether a Model 6 can be made to report prints it didn't make, and signed software
  updates (supply-chain-engineer, with the hardware maker).
- **The load balancer in front of production:** which hops it adds to `X-Forwarded-For` decides the right
  `TRUST_PROXY` value (reliability-engineer, with the host).
- **The law:** whether each jurisdiction preset, the prize game and paying points for data are lawful (a lawyer;
  privacy-officer to prepare the questions).
- **Real phones at real doors:** photo re-encoding was checked with test images, not every phone's formats; whether a
  porch box's code is readable from the street (N2) needs a look at a printed box (privacy-officer).
- **Real Postgres for every new race:** the claim limit was shown on Postgres 16 here; the route-buying locks were
  shown by their builder; other new read-then-write steps were read, not raced.
- **AI prompts in production:** that no personal data reaches a model was checked against `docs/AI.md` and the
  personalizer's inputs, not by sampling live prompts (privacy-officer).

*Next refresh:* after the fixes for R1–R15 land, re-run the route table script and re-probe each CONFIRMED item.
