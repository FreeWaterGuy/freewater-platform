# Privacy and compliance: the data map and the lawyer's checklist

Written by the privacy review (October 2026) from the code on branch `t-priv`. It says what personal data the
platform keeps, why, for how long and who sees it, and then goes law by law: what the code already does (with the
test that shows it) and what needs a lawyer's decision. Nothing here is legal advice: every **Lawyer** line is open
until a lawyer signs it off.

The standing rules this is checked against (`docs/REQUIREMENTS.md`): collect everything the law allows, with the US
as the maximum; the law follows the person, a company may be stricter but never looser, and an unknown place gets
the strictest rules; data trains our AI and plans free products and is **never sold**; full / medium / lite levels,
asked once with nothing pre-selected; only Full earns points, once, where paying for data is allowed; download and
erase; a minimum age (13 or higher) that only goes up.

## How the rules are applied (where to look)

| What | Where |
|---|---|
| Kinds of data, presets per region, keep days | `src/modules/data/policy.ts` (`dataCategories`, `preset`) |
| Which law applies to whom (strictest of where they connect from and what they told us; unknown = strictest) | `src/modules/data/jurisdiction.ts`, `DataService.policyFor` / `placesFor` |
| Is this kind of data allowed for this person | `DataService.allowed` (consent mode, GPC, do-not-sell, level) |
| Levels | `levelChoices`, `DataService.setLevel` / `level`; points in `src/api/data.ts` `chooseLevel` |
| Download | `GET /v1/me/data` (account, follows linked phones), `POST /v1/public/data/:companyId/download` (a phone alone) |
| Erase | `DELETE /v1/me/data`, `DELETE /v1/me` (account), `POST /v1/public/data/:companyId/forget` (a phone alone) |
| Retention | `DataService.purge` (daily job and `POST /v1/data/purge`) |
| Activity log masking | `logActivity` in `src/api/server.ts` (body fields), `redact` and `viewerTag` in `src/modules/data/service.ts` |

## 1. The data map

"Phone key" is the random id a phone keeps (`fw_viewer`). It names no one, but it is a **bearer secret**: on its own it
opens that phone's wallet, spends its points on offers, changes its data choices and erases its data (threat model
R15). Since this review, logs and team screens see only a keyed fingerprint of it (`vkf:…`, HMAC-SHA-256 with the
`viewer_tags` secret; in production it comes only from `FW_SECRET_VIEWER_TAGS` in the host settings).

"Team" means a company's signed-in people with `admin` or `ledger` scope (owners, finance) unless said otherwise.
Keep days are the US preset; EU/UK/Brazil and unknown places get the shorter strict preset, Canada its own
(`preset()`), and a company can only shorten them.

### People and sign-in

| Table | Personal fields | Why | Kept | Who sees it | Download / erase |
|---|---|---|---|---|---|
| `users` | email, phone, display name, consents, interests, phone key | Sign-in, team roles, consumer account | Until the account is deleted; then email/phone/name/consents/interests cleared, phone key replaced | The person; team page (staff only, masked email in logs) | Both |
| `login_codes` | destination (email/phone), code hash | Emailed sign-in codes | **Now** purged 7 days after expiry | No one (hashes) | Erased with the account |
| `sessions` | user id, token hash, `second_step_at` | Sign-ins | **Now** purged a year after they end | The person (`/v1/me/export`) | Revoked on erase |
| `second_steps`, `recovery_codes`, `second_step_challenges` | encrypted authenticator secret, code hashes | Second sign-in step | While on; **now** deleted with the account; challenges purged 7 days after expiry | No one | **Now** erased with the account |
| `security_events` | actor (masked email or name), IP, IP tag | Security log | Not purged (security purpose) | Team security screen | Contact masked on erase |
| `api_keys`, `webhook_endpoints`, `machine_commands`, `offers` | `created_by` (staff) | Who did what | With the record | Team | Business records; not consumer data |

### What people do and choose

| Table | Personal fields | Why | Kept (US) | Who sees it | Download / erase |
|---|---|---|---|---|---|
| `activity` | actor (account id or **phone fingerprint**), person, action, masked body, IP (shortened where required), device | Audit, fraud, training data | `activity` 1095 d; IP 365 d (CA 90, strict 30); device 1095 d | Team via person search | Both (now also rows under a phone's fingerprint) |
| `interactions` | phone key, dwell, AR time, video | Learning what works | 1095 d | Team via person search | Both |
| `events` (append-only books) | phone key in scan payloads | Billing and the books | Kept (books) | Team event feed shows the **fingerprint** | Download yes; erase: stays, the phone gets a new key so it leads nowhere |
| `choices`, `choice_sets`, `numberline` | person (phone key / `user:`), what was picked | Honest-data tiers, AI training, product planning | 3650 d (strict 730) | Team (`/v1/honest-data/choices`) | Both |
| `game_rounds`, `game_notes`, `game_players` | answers, timing, written/video feedback, photos | The games | Choices keep; feedback 1825 d | Team reports (counts); notes to reviewers | Both |
| `data_consents`, `data_levels` | per-kind yes/no, do-not-sell, level | The person's own choices | While they matter | The person; team via person search | Both |
| `person_places` | country, state, city (as rules allow), source | Which law applies | With the person | Team via person search | Both |
| `precise_locations` | lat/lng (~10 m), accuracy | Nearby deals (opt-in) | 365 d (strict 30) | Team via person search | Both |
| `person_details` | birth year (only if old enough), age ok, zip, household, language | Age check, optional details | With the person | Team via person search | Both |
| `people`, `person_links` | joins phones, accounts, hashed email/phone | One profile (Full only, where allowed) | With the person | Team | Both |
| `viewer_advertisers`, `video_seen`, `clicks`, `coupon_codes` | phone key, advertiser, link opened | Frequency, billing | Not purged by age (see L-9) | Team; advertisers see counts | Download yes; erase: deleted or key replaced |
| `videos` (not personal) | the kind of moment a video was made for, which can include one shared interest word (`segment`); never a phone key | "Show me more" | With the ad | The advertiser (`GET /v1/campaigns/:id/videos`) | Not personal; a child's interests never make one (C3) |
| Scan page (`GET /v1/public/experience/...`, not stored) | to anyone with the code: the ad, the bottle's story (printed when, at which machine or "home delivery in <city>", how many scans and people), the giving line; to the phone itself: its own key, coupon, privacy choices | Showing the ad | `no-store` | Whoever holds the bottle | Nothing about the person the bottle was made for (C5) |
| `ad_preferences`, `research_panel`, `bottle_holders`, `giving_directions`, `value_arms` | person | Data environment, panel, gifts | With the person | Team reports | Both (books ones keyed to a random code) |
| `lottery_chances` | phone key, draw key (**now** fingerprint), prize, claim code | The prize game | Not purged by age | Team overview (no keys); public draw list (fingerprints) | Download yes; erase: key replaced |
| `agent_arms` | phone key | Holdout tests for AI agents | Not purged by age | Agents' reports (counts) | Erase: key replaced |

### Ads, their ratings and benchmarks (branch `j-rate`, migration 078)

Nothing here is about a person who gets a bottle: ads, scores, and counts. The advertiser is usually a business; a sole
trader's ad and its score can still be about a natural person (GDPR), so the advertiser's own download includes them.

| Table | Personal fields | Why | Kept | Who sees it | Download / erase |
|---|---|---|---|---|---|
| `ad_ratings` | none about consumers; the advertiser id, and what the rater saw (the ad's own words, colours, sizes, links as words) | Rating each ad version 1–10 before it prints, so the rating can learn (the founder's decision) | Forever, append-only (a finished rating never changes) | The company's team (*Ad ratings*); the advertiser sees only score, meter and tips, and only if the company turns that on | **Now** in the advertiser's download (`asAdvertiser.adRatings`); kept on erase as a business record of an ad (L-34) |
| `ad_versions`, `ad_category_changes`, `ad_subcategories` | advertiser id; who changed an industry (`user:` id) | Which ad was which, its industry | Forever (labels changeable, logged) | Team | Business records |
| `ad_version_outcomes` | none: counts of bottles, scans, AR, clicks, sales per ad version and channel | Whether the score predicts results | Forever | Team (its own ads) | Not personal |
| `ad_benchmark_snapshots`, `benchmark_settings`, `benchmark_setting_changes` | none: pooled averages with no company, advertiser or ad; who changed a threshold | Benchmarks across the network | Forever | Contributing companies' teams | Not personal |

How the rules are applied: the rater gets the ad, never the people (`src/modules/ads/rating.ts`, `RATER_LOOKS_AT`);
outcomes are counted from events and click and sale records, never stored with a phone key; a pooled figure is shown
only at 20+ ads from 5+ advertisers, with no advertiser over half and enough without the viewing company's own (so a
company can't difference itself out); a company that switches *Contribute* off leaves the pool at once; a company that
existed before decides for itself (off until it does). Data is never sold (`docs/AI.md`, "What AI is not used for").

### Money and things people order

| Table | Personal fields | Why | Kept | Who sees it | Download / erase |
|---|---|---|---|---|---|
| `wallet_holders`, `wallet_tx`, `wallet_lines` | subject → random wallet id; network fingerprint on rewards | Points and credit (double-entry books) | Books forever; network fingerprint 2 days | The person; team (no names) | Download yes; erase removes the link only |
| `wallet_giftcards` | subject | Gift cards bought with credit | Books | Team (no subject shown) | **Now** in download; erase replaces the subject |
| `offer_claims` | person, receipt photo, what was read from it | Brand offers | Books | Team reviewers (receipt) | Both (receipt removed, person replaced, unpaid voided) |
| `payment_customers`, `payment_methods`, `payments`, `invoices` | card references (no card numbers), owner | Paying | Books | Finance | Cards deleted on erase; payments stay |
| `subscriptions`, `route_runs`, `packs` | address, lat/lng, notes | Deliveries | With the subscription | Ops, drivers | Address erased |
| `custom_designs`, `proofs`, `custom_order_proofs`, `saved_items`, `assets` | designs, names on labels, uploads | Custom bottles | With the account | The person; team for printing | Both (proofs kept without names/pictures) |

### News, fillers and houses that haven't signed up (branch `p-news`; all off until a person turns them on)

| Table | Personal data | Why | Kept | Who sees it | Download / erase |
|---|---|---|---|---|---|
| `news_topics`, `news_reports`, `news_stories`, `news_corrections` | Only staff names (`proposed_by`, `approved_by`, `by_person`) | FreeWater News: the topic, what outlets reported, each version of the story, corrections (append-only) | With the topic (stories and corrections are never edited) | Team; stories are public by design | Not consumer data |
| `news_error_reports` | Free text a reader wrote; **no** phone key, account, IP or name column (tested) | "Report an error" | 365 d (`purge`) | Team (`GET /v1/news/errors`) | Can't be tied to a person, so not in a download |
| `news_source_prefs` | Phone key or account's phone key, the outlets the person chose | Writing their stories in the style of their first pick (their stated choice, never inferred) | With the person | No one but the person | Both (tested) |
| `fillers` (campaign rows with `filler`) | Staff names who proposed and approved | Approved pieces for unsold spots | With the piece | Team | Not consumer data |
| `area_attributes` | None (neighbourhood or census-block statistics; Austin rows are SAMPLE, labelled) | Choosing ads for an area | Until replaced | Team | Not personal |
| `household_imports` | Staff name who imported | Which data company, what date, how much was refused | Until deleted by source | Team | Not consumer data |
| `household_attributes` | **Street address** of a house (keyed by the same fingerprint as opt-outs) (often of people who never signed up) + attributes from a closed list (size, income band, owner/renter, dwelling, years, interests), each with source, date, bought/first-party | Choosing ads for that house only; **never sold or passed on**; never shown to advertisers per house | **395 d after import** (`purge`); deleted at once by source or import, by a house's opt-out, or by a resident's erase | Team (`GET /v1/households/audience`, no-store) | A resident's download lists what we hold about their delivery address; erase deletes it and opts the house out (tested) |
| `drop_photos` (065) | A **photo of the box at someone's door** (their home, maybe a person or a car), the driver who took it, the pack, run and house | Proof that a drop happened (the founder: delivered with its photo is delivered) | **The company's keep, 90 days unless set (1–365)**: then the picture is deleted by the `drop-photos` job (the row with its time stays); a deleted picture can't be put back (database rule). Re-encoded on the way in: no location, camera or owner from the phone's file | Team only (`GET /v1/ops/drop-photos/:id`, `no-store`); a resident who proved the house is theirs, for drops from two weeks before that on (`GET /v1/me/drop-photos`); **never advertisers**; never at a public address (older ones in `assets` refused at `/assets`, and deleted on the same keep) | **Now** listed in the download (H7). Erase: the pictures of a subscriber's own deliveries go at once; drops at a claimed house stay (the company's record of a drop at an address, seen by whoever lives there now) until the keep ends (L-26) |
| `household_optouts` | A per-company **keyed fingerprint of the normalised address** (HMAC-SHA-256 with the pseudonym secret `FW_SECRET_VIEWER_TAGS`, H5; rows from before keying are a plain hash, still honoured, and moved to the keyed form at start where we hold the address). Without the secret it can't be matched to an address; with it, it can, so it is still pseudonymous personal data | Keeping a house that said no out of every later import and every buy that names it | Kept (it is the record of the "no") | No one (no route shows it) | Not deletable by the house itself; see L-21. **Rotating the pseudonym secret orphans every "no"** (they'd stop matching): don't, without re-keying from the old secret |

### Houses in delivery areas and route buys (since `p-news`; reviewed here, H1–H8)

| Table | Personal data | Why | Kept | Who sees it | Download / erase |
|---|---|---|---|---|---|
| `delivery_areas` | None (staff name who made it) | Which streets get packs | With the area | Ops | Not personal |
| `houses` | **Street address** and map point of every house on the chosen streets (mostly people who never signed up); whether it stopped deliveries (`opted_out`, a household's choice), a driver's skip reason and note (free text, up to 200 characters), **household size** a resident told us, last delivery | Delivering, planning, packs per house | **No keep set (L-31)**; household size cleared when its last claimant erases | Ops (the house list), drivers (stops); advertisers see **street names and counts only**, never an address | The claimant's download (both `GET /v1/me/export` and `GET /v1/me/data`, H7); erase clears household size |
| `house_claims` | Which account says a house is theirs, the box that proved it | Letting a resident stop deliveries, set household size, block ads, see drop photos; their choices reach the house's audience | Until unclaimed or erased | The person; ops sees "claimed" | Both |
| `house_events` | Who did what to a house (claims, stops, restarts, driver skips with notes, reviews), **append-only** | The house's history; five wrong claim codes a day | **No keep set (L-31)** | Ops | Erase takes the person's id off (the rest stays) |
| `house_ad_blocks` | Which account blocked which advertiser (or every ad aimed at the house alone) | A house's say over the ads that come to it | Until taken back (`removed_at`) | The person (`GET /v1/me/house/ads`); never the advertiser | **Now** in the download; erase removes who asked, the block stays (H7) |
| `route_buys.target` | The **street addresses an advertiser named** (its own list of houses), household-data conditions | What was bought | **No keep set (L-31)** | That advertiser; the team | Not deleted by a resident's erase (the advertiser's order); L-31 |
| `route_spots` | Which ad went to which house in which week | Placing paid pieces on the right bottles; credit and refunds | With the books | Team; the advertiser sees streets and counts | Not personal on its own (a house id) |
| `route_settlements` | Why pieces came back (a house stopped, blocked, was skipped) | Credit and refunds | With the books | Team (exact reason); the advertiser reads "the house is no longer on the route for this ad" (H1) | — |
| `route_runs.stops` (existing table, new fields) | Each drop's **GPS point at the door**, time, metres from the house, photo waiver reason | Proof of delivery | **No keep set (L-31)** | Ops, drivers; the advertiser's report rounds the point to ~100 m and, for a few houses, shows the day only | — |
| `advertisers.verified_*`, `ad_review_notes`, `ad_ai_verdicts`, `ad_ai_conversation` | Staff ids; an advertiser's (often a sole trader's) messages and the AI's reasons about their ad | Review of paid ads, its record and appeals | Append-only, no keep (business records) | Team; the advertiser sees its own notes | Business data; L-27 |

**What an advertiser can learn about one house** (the release check's question), after this review:

- The quote and the areas list: street names and counts of active houses (a count on a one- or two-house street can
  change when a house stops: L-29). A named house we can't take reads the same whatever the reason.
- The report: streets and houses reached (streets under 5 grouped unless the advertiser named the houses), each drop's
  ~100 m point and time (for under 50 houses: the day only), scans by area (**none** for under 50 houses, H3), what
  came back (never why a house said no, H1). For a buy aimed by household data: no drops at all (H2).
- The overview: no saves or taps for a buy under 50 houses (H3). Billed scans if a company turns scan fees on (L-28).
- Never: an address it didn't send, a house's audience, bought data (a quote can't test one house any more, H2), a
  resident, a claim, a photo.

**Seeing it** (console → *Household data*, `GET /v1/households/summary`, owners and finance): totals only. The
switches, area statistics (sample or real, and their source), each import (source, date, kept, refused, how many were
sensitive: recorded by kind from migration 086; older imports show their total only), what's held by source and kind,
deleting a source, and how many houses said no. Never a house, an address or one house's attributes. The single-house
check (`GET /v1/households/audience`) stays API-only and isn't on the screen: it takes no reason and keeps no log of who
looked (for the lawyer: add a stated reason and a log before it's shown to people).

#### Household data: the formats (for the data company the founder picks)

`POST /v1/households/imports` (a person signed in; *Bought household data* on), body
`{ source, sourceDate: "YYYY-MM-DD", origin?: "bought" | "first_party", format: "csv" | "json", data }`:

- **CSV**: a header row; `address` (required), `block_id` (optional census block group GEOID), then one column per
  attribute. **JSON**: `[{ "address": "...", "blockId"?: "...", "attributes": { "household_size": 3, ... } }]`.
- Attributes (a closed list, `src/modules/households/vocabulary.ts`): `household_size` 1–12, `income_band`
  (`under_35k`, `35k_75k`, `75k_150k`, `150k_plus`), `homeowner` (`owner`/`renter`), `dwelling_type`,
  `years_at_address` 0–80, `interest_<cooking|coffee|fitness|…>` = `yes`. Anything else is refused and counted
  (`sensitive`, `unknown_attribute`, `bad_value`, `house_said_no`); nothing sensitive is stored, even refused.
- Every attribute is kept with the import's source, date and bought/first-party flag. Delete a whole source with
  `DELETE /v1/households/sources/:source`, one import with `DELETE /v1/households/imports/:id`.

Area statistics: `POST /v1/areas` with `{ areas: [{ areaId, kind: block_group|tract|zip|route|neighbourhood, name,
attributes: { households, median_household_size, median_income_band, share_families_with_children, homeowner_share },
source, asOf, sample?, lat?, lng? }] }`. Real data: the Census Bureau's ACS 5-year estimates by block group for
Travis County (tables B11001, B25010, B19013, B11003, B25003), one row per GEOID with the release as `source`.

The audience for one house, for the route-buying engine: `app.households.audienceForHouse(companyId, { address,
routeId?, lat?, lng? })` returns `HouseAudience` (`src/modules/households/service.ts`): first-party (residents, as
their choices allow) over bought over area, each value saying where it came from; `optedOut`, `childAtHome`; empty
when the company's switches are off. For choosing ads only; never shown to advertisers or passed on. For a house in a delivery area,
`audienceForRouteHouse(companyId, houseId)` reads the house's own address and route; residents are the people with a
delivery at that address and the people who claimed the house in the app (`house_claims`), so either one's "do not
sell or share" keeps the house out, and their data download and erasure reach the bought data about it.

## 2. Findings fixed in this review

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| R4 | CRITICAL | Owners and finance people approved token steps, payouts, reserves and money switches with an email code only; the second step was off by default and owner-only. | `approvalRoutes` and `approvalSettings` in `src/modules/accounts/secondStep.ts`: owners and finance people must approve from a sign-in that passed the authenticator step (`sessions.second_step_at`, migration `053_priv_second_step_sessions`), whatever the company set. Setting the app up never counts for the sign-in it was set up from (sign in again with its code), a new app approves only after 24 hours and the other owners are told; turning it off clears every sign-in. The pause is never gated. | `test/privacy-approvers.test.ts` |
| R15 | HIGH | The phone key was stored raw as `activity.actor_id` (and could appear in bodies), shown on the team's person search and event feed, and published in prize-draw keys. | Keyed fingerprint (`DataService.viewerTag`) in the activity log, the person search, the event feed and draw keys; old rows re-tagged at start and by the daily purge; erase and purge find rows by fingerprint. | `test/privacy-data.test.ts` (R15 block), `test/lottery.test.ts` |
| P1 | HIGH | A phone without an account could erase but not download its data (right to know / access). | `POST /v1/public/data/:companyId/download` (key in the body, never the URL); phone-only like `forget`. | `privacy-data` |
| P2 | MEDIUM | Downloads missed the data level, games joined, choice screens, ad preferences, panel, bottles held, gifts directed, value tests, videos, advertisers seen, links opened, coupons and gift cards; activity showed only rows under a linked person. | Added to `profile` / `more`; activity also by account id and phone fingerprint. | `privacy-data` |
| P3 | MEDIUM | Global Privacy Control was honored only for the request carrying it; later processing without the header ignored it. | `honorGpc` records it as the person's do-not-sell choice (a later explicit yes wins). | `privacy-data` |
| P4 | MEDIUM | A person who said they're under the minimum age still had page interactions recorded. | `recordInteraction` refuses them. | `privacy-data` |
| P5 | MEDIUM | The prize game let anyone over the app's minimum age (13) play, despite its own `minAge` (18); it could be turned on without official rules or a "No purchase necessary" statement. | The chance route checks `minAge` against the birth year; `checkLottery` requires an https rules link and the words "No purchase necessary". | `privacy-data` |
| P6 | MEDIUM | No notice of financial incentive with the points for Full (California). | `financialIncentiveNotice` returned with the level wherever Full pays. | `privacy-data` |
| P7 | LOW | Erasing an account left its authenticator secret and recovery codes; gift cards kept the phone key; expired sign-in codes, challenges and old sessions were never purged. | Deleted / re-keyed on erase; purged daily (codes and challenges after 7 days, ended sessions after a year). | `privacy-data` |

### Core slice 3 review (scan, AR and video; October 2026, branch `c-ar`)

What a scan shows, to whom, and what it lets anyone learn about the person a bottle was made for. All in
`test/core-experience.test.ts`, which runs the loop end to end in the pilot (`FW_FEATURES=pilot`): a bottle printed
for one person, its code scanned, the page, AR, what they do, what's billed; a stranger with the same bottle; an ad
edited or paused while its bottles are out; "Show me more" with no video model.

| # | Severity | Finding | Fix |
|---|---|---|---|
| C1 | HIGH | An advertiser's edit to an approved ad's page showed on bottles already out before content review (and minted coupons from it). | `ExperienceService.open`: only approved pages; until then the owner's simple card, unbilled. |
| C2 | HIGH | "Show me more" kept replaying videos made from the ad's old words (an old price) after it changed. | Videos carry a fingerprint of what they were made from (`videos.content`). |
| C3 | HIGH | A person known to be under the minimum age still had their interests pick their scan page, their videos (and the AI prompts behind them) and the ads printed on their own bottles. | `mayPersonalize` (age on file) gates every use of interests: `ExperienceService`, `AccountsService.audienceFor`. |
| C4 | MEDIUM | Partners' plug-ins received the person's interests on every scan. | Never sent (`remotePlugin`). |
| C5 | MEDIUM | A home-delivery bottle named its neighbourhood (a ~2 km area round the person's home) to whoever held it: scan page, receipt, public bottle page, "why". | `publicPlace`: "Home delivery in <city>". |
| C6 | MEDIUM | One person's scan page (their coupon, phone key, choices) could be cached. | `cache-control: private, no-store`. |

Existing tests changed because they encoded the old behaviour: `test/console.test.ts`, `test/wallet.test.ts`,
`test/review-money.test.ts`, `test/review2-money.test.ts`, `test/review3-money.test.ts` (their owners and finance
people now sign in with the second step before approving) and `test/lottery.test.ts` (the draw key names the phone
by its fingerprint).

### News, fillers and household data (October 2026, branch `p-news`)

Built switched off. Each rule's test was shown failing with its code taken out (`docs/REVIEW-LOG.md`).

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| N1 | HIGH | The Features page's News switches (`news_cards`, `news_sources`, `ai_news_writer`) started **on** under a News that was off: turning News on (one click) would print topics, use readers' sources and call the AI at once, and switching AI or Ads off and on again could not put them back (refused "turn on News first"). | They start off for every company; each is a person's own step. `news_cards` also needs *Approved fillers* (the engine only fills unsold spots when that's on, so the dependency is now said, not hidden). | `test/news.test.ts` ("still off", "with News on but … still off"), `test/features-registry.test.ts` |
| N2 | MEDIUM | An advertiser's offered filler ad printed whenever *Approved fillers* was on: the *Advertisers offer ads for unsold spots* switch was registered but never checked. | `FillerService.mayPrint` checks `filler_offers` per company. | `test/fillers.test.ts` (shown failing without the check) |
| N3 | LOW | Test gap: removing the *Ads aimed at houses* check left every test passing, though residents' shared interests would then reach a house's audience with the switch off. | Test added: with the switch off, a claimed house with consent gives `strongest: none`. | `test/household-data.test.ts` |
| N4 | LOW | `features/service.ts` had an uncommitted change (an already-off switch no longer turned off what needs it) made only to paper over N1. | Reverted: the shared file is unchanged; N1 fixed at the source. | `test/features-registry.test.ts` |

### Houses, route buys and the law (release check, October 2026, branch `r-priv`)

Each test was shown failing on the code before the fix (`test/privacy-houses.test.ts`, all 8 failed on it).

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| H1 | HIGH | An advertiser read why its pieces came back: "the house blocked these ads", "the house stopped deliveries". For a one-house buy it knows the address, so it learned that household's choice. | Advertisers read "the house is no longer on the route for this ad"; the team keeps the reason. | H1 |
| H2 | HIGH (switch off) | With *Aim route buys by household data* on, a free quote for one named house (or a street, or a small shape) said whether the bought data matched: an oracle for an income band, household size or interests. | Household data aims only across whole areas at 50 houses or more, refused without a count otherwise; no drop list in its report. | H2 |
| H3 | MEDIUM | A buy for a few houses reported scans by area and saves and taps: whether that household engaged. | Withheld under 50 houses. Scan fees, if turned on, still count them (L-28). | H3, `test/route-buying.test.ts` |
| H4 | MEDIUM | The no-account opt-out kept a house out of buys for fewer than 50 houses only; a buy naming 50+ addresses still reached it. | Any buy that names houses leaves out houses that said no. | H4 |
| H5 | MEDIUM | The opt-out kept a plain hash of the address: reversible by anyone with a list of Austin addresses. | Keyed fingerprint; old rows still honoured and re-keyed. | H5 |
| H6 | MEDIUM | The no-account opt-out had no page: only an API route. | On the scan page: "Don't use information about my home to choose ads". | H6 |
| H7 | MEDIUM | A resident's download missed their claimed house, blocks and drop photos; erase left their id on blocks and their own door's photos for 90 days. | Added; erase removes who blocked and deletes their own deliveries' pictures. | H7 |
| H8 | MEDIUM | "Unknown place = strictest" didn't reach houses: routes have no country, so house data and one-house buys applied anywhere. | Routes carry `country`/`state`; a house not known to be in the US gets nothing used and can't be bought for alone. | H8 |

## 3. The second sign-in step for approvers (R4): how it works

- **Who:** every owner and finance person, before any route in `approvalRoutes` (chain proposals, approvals, runs,
  signed mints; offer approvals and receipt reviews; agent spends; payouts, owner payouts, reinvestments; wallet
  reserve, corrections, gift-card settlement; value-test decisions) and before saving any setting in
  `approvalSettings` (wallet, offers, chain, launch, giving, agents, lottery), whether by `PATCH /v1/console/settings`,
  by putting back an older version that differs in one, or by approving (or undoing) an agent's proposal that changes
  one; and before making or changing an owner or finance person (`conditionalApprovalRoutes`).
- **Setup path:** `GET /v1/me/second-step` says `neededToApprove` and, until it's done, how (`toApprove`).
  `POST /v1/me/second-step/start` gives the QR code; `POST /v1/me/second-step/confirm` with a code from the app turns
  it on and returns recovery codes. It never lets the sign-in it was set up from approve: that sign-in came from the
  inbox alone, and whoever holds the inbox could set up an app of their own. The person signs in again, entering the
  app's code after the emailed one (`POST /v1/auth/second-step`), and a newly set-up (or replaced) app can approve
  only 24 hours after it was set up; the company's other owners are emailed at once and an alert is raised, so a
  stranger's app is seen and stopped in that day. A refused approval says which applies (`second_step_required`).
- **Unchanged:** the company's `security.ownersNeedSecondStep` still makes owners use it for everything; the chain
  pause needs no second step; service keys can't approve (person-only checks).

## 4. Checklist by law

Status: **Code** = done and tested; **Partly** = done with a gap noted; **Lawyer** = needs a decision; **N/A**.

### CCPA / CPRA (California) and other US state laws

| Item | Status | Notes |
|---|---|---|
| Notice at collection: kinds, purposes, keep days | Code | `GET /v1/public/data/:companyId`, `/v1/public/why/...`, `dataUse` text. **Lawyer:** approve wording and a full privacy policy page (none in the code). |
| Never sold | Code | No sale path; `dataUse` says so. **Lawyer:** confirm white-label `shareWithPlatform` and advertiser reports (counts only) aren't a "sale" or "sharing". |
| Do not sell or share link; GPC | Code | `/do-not-sell` routes; GPC honored and now persisted (P3). |
| Right to know / download | Code | Accounts and (now) phones alone (P1, P2). **Lawyer:** is the phone key enough verification for a phone-only download (it's the same secret that already opens the wallet)? |
| Right to delete | Code | Erase covers every personal table in §1; books keep records under random codes. **Lawyer:** confirm the "books" exception for `events`, wallet, offer claims and lottery records. |
| Right to correct | Partly | People can change details, age (from an account), place, level, choices. No general correction request flow. **Lawyer:** is that enough? |
| Sensitive data (precise location) | Code | Opt-in everywhere, ~10 m, short keep; Lite never collects it. **Lawyer:** "limit the use of my sensitive personal information" link needed? |
| Financial incentive (points for Full) | Code | Notice (P6) with summary, categories, how to join and leave, value. **Lawyer:** the value-of-data estimate and method; whether other states (CO, CT, VA, OR, TX…) need wording. |
| Non-discrimination | Code | Everything works the same at every level; every game choice earns the same. |
| Retention disclosed and enforced | Code | Daily purge per region (`purge`). **Lawyer:** confirm the US keep days (up to 3650 for choices). |
| Minors 13–15 (opt-in to sale/sharing) | Partly | Nothing is sold; ages 13–15 get the same levels. **Lawyer:** require opt-in for "sharing" or Full for 13–15? |

### GDPR / UK GDPR (and Brazil's LGPD via the same preset)

| Item | Status | Notes |
|---|---|---|
| Lawful basis per kind | Partly | Strict preset: opt-in for interactions, choices, location, device, linking; activity and IP "needed to run". **Lawyer:** basis for activity/IP (legitimate interests assessment) and for AI training. |
| Consent: freely given, nothing pre-selected, withdrawable | Code | Level asked once, nothing pre-selected, changeable any time. |
| Unknown place = strictest | Code | `strictestPlace`; purge uses the strict keep for unknown people. |
| Access, erasure, portability | Code | JSON download; erase. |
| Points for consent | Code | Points only in the US (`levelPaysHere`); never in the EU/UK. |
| IP minimisation | Code | Truncated in strict regions; IP and device nulled after the strict keep for everyone. |
| International transfers, DPA with processors (hosting, email, AI provider) | Lawyer | Not in code. |
| Records of processing, DPIA for AI training and profiling | Lawyer | This data map is a start. |
| Age of digital consent (13–16 by country) | Code | `minimumAgeAll` uses the highest age of every place that applies; only goes up. **Lawyer:** confirm the table. |

### COPPA (under 13)

| Item | Status | Notes |
|---|---|---|
| Age gate | Code | Birthday asked (`/age`); an under-age answer keeps only "not old enough"; a known adult can only be changed from an account. |
| No profiling of known children | Code | No details, interactions (P4), rewards or prize game. |
| No personalized advertising to known children | Code | Their interests never pick their scan page, their videos, or the ads on their own bottles, whatever they turned on (C3). **Lawyer:** see L-12 for ads a child may still see (alcohol). |
| Actual knowledge from other signals | Lawyer | The scan page itself isn't age-gated (a free bottle is never gated). Is the service "directed to children"? |

### Sweepstakes (the prize game)

| Item | Status | Notes |
|---|---|---|
| No purchase necessary | Partly | Entry is a scan or video of a free bottle (no purchase). The game can't be turned on without an official rules link and "No purchase necessary" (P5). **Lawyer:** write the official rules; is a free-entry method without a bottle (mail-in) needed? |
| Age | Code | The game's own `minAge` (18 by default) is enforced when an age is on file. **Lawyer:** must a winner confirm age before a prize is redeemed (unknown age can still play)? |
| Odds, prizes, sponsor, dates disclosed | Partly | Odds, chances per day, prizes and rules link are public; the draw is committed and re-checkable. **Lawyer:** registration/bonding (NY, FL over $5,000; RI retail), void where prohibited, tax forms over $600. |
| Sanctioned places | Code | No rewards or play where sanctions forbid. |

### CAN-SPAM / TCPA

| Item | Status | Notes |
|---|---|---|
| Marketing email or SMS | N/A | Only sign-in codes (transactional) are sent; `consents.marketing` defaults off and nothing sends marketing. **Lawyer:** before any marketing send, add unsubscribe, address and TCPA consent records. |

### Security of personal data

| Item | Status | Notes |
|---|---|---|
| Secrets hashed or encrypted | Code | Sessions, API keys, sign-in codes, recovery codes hashed; authenticator secrets encrypted; phone keys fingerprinted in logs (R15). |
| Approvers' accounts | Code | Second step required to approve (R4). |
| Personal data in logs | Code | Request logs path-only; activity bodies masked; phone keys fingerprinted. |
| Breach notification process | Lawyer | Not in code. |

### Texas (Austin): TDPSA, data brokers, doors (news, fillers and household data)

| Item | Status | Notes |
|---|---|---|
| The law of where the house is | Code | A house takes its route's `country`/`state` (H8); unknown or outside the US, nothing about it is used and it can't be bought for alone. Residents' own rules still apply through `jurisdiction.ts`. **Lawyer:** L-17, L-33. |
| Targeted-ad opt-out without an account | Code | **Yes, a no-account path exists and is always on** (not behind a switch; listed under the locked *Privacy rules by place*): the scan page's "Don't use information about my home to choose ads" (H6) and `POST /v1/public/households/:companyId/opt-out` (address only; same answer whether or not we held anything; keeps a keyed fingerprint, never the address). It deletes bought data, skips later imports, and keeps the house out of data-aimed buys, buys for a few houses and any buy that names it (H4). A resident's do-not-sell or GPC keeps the whole house out. Stopping **deliveries** is separate and app-only (the founder's choice). **Lawyer:** L-17, L-32. |
| Sensitive data never in bought-data targeting | Code | Closed attribute list + `SENSITIVE` refuses health, religion, ethnicity, sexuality, immigration, children, politics, precise location by name and by value (at import, and again at use); route-buy conditions are a closed list too; a child at home leaves only area statistics. |
| Bought data never sold onward | Code | No route returns it to anyone but the team; advertisers never see a house's audience (403, tested), and a quote can no longer test one house (H2). **Lawyer:** L-18. |
| Bought data deletable by source; dated | Code | `DELETE /v1/households/sources/:source`, per-import delete, 395-day purge. |
| AI-written news | Partly | Two or more outlets, own words (checked for copied wording, links, outlets' names), cited and linked, corrections logged as new versions, a person approves each topic, the bottle prints only a topic. **Lawyer:** L-19. |
| Household-level scan tracking notice | Lawyer | Scans of a bottle left at a door are counted per bottle and phone, not per household; area and bought data choose the ads. L-20. |
| Children taking bottles | Partly | A known child at home stops bought and first-party data; nothing stops a child picking up a bottle left at a door. L-22. |
| Leaving items at doors (Austin) | Lawyer | L-16. |

## 5. Open items for the lawyer (summary)

- **L-1** Privacy policy page and the wording of every notice (collection, levels, financial incentive).
- **L-2** Value-of-data estimate and method for the Full points (California § 7016); other states' incentive rules.
- **L-3** Whether `shareWithPlatform` (a white-label company's data seen by FreeWater) or advertiser reports count as
  "sharing"; the contracts that make FreeWater a service provider.
- **L-4** Lawful basis for activity and IP logs and for AI training under GDPR; a DPIA; processor agreements.
- **L-5** The prize game's official rules, free-entry method, registration/bonding, age confirmation before prizes,
  and tax reporting.
- **L-6** Whether ages 13–15 need opt-in for Full; whether the service is "directed to children".
- **L-7** The books exception: scans, wallet, offer claims and draws kept under random codes after erasure.
- **L-8** Verification standard for a phone-only download or erase (the phone key alone).
- **L-9** Retention for billing tables not purged by age (`clicks`, `coupon_codes`, `viewer_advertisers`,
  `video_seen`, `lottery_chances`, `agent_arms`, `security_events`): set keep periods or confirm "with the books".
- **L-10** Breach-notification plan and the 30-day session length for approvers.
- **L-11** Lite says "counted, not profiled", but a person's own "personalized offers" yes still lets their shared
  interests pick their scan page and video at any level, and every level keeps which advertisers a phone has met
  (`viewer_advertisers`, for "first order?" offers and new/returning ads) and which video it was shown (`video_seen`).
  Should Lite (or GPC / do-not-sell) turn these off, or are they "needed to run things"?
- **L-12** Ads with age limits on their own scan pages (the sample alcohol ad says "21+ only"): nothing checks the
  scanner's age, and a bottle can reach a child. Rules for alcohol (and similar) advertising on a free, ungated bottle.
- **L-13** Interest words in AI prompts: the personalizer (Claude) and the video writer get a signed-in adult's shared
  interests; Veo gets one interest word per kind of moment (pooled, never per person). Is that covered by processor
  terms, and should "Show me more" footage ever be made from interests at all?
- **L-14** Partners' plug-ins still get a stable per-partner pseudonymous id for each phone (a hash of its key) with
  every scan. Is that "sharing" a persistent identifier (CCPA cross-context advertising) for people who said do not
  sell or share, and should it be left out for them?
- **L-15** Custom bottles: the sender's message and photos (often a name, sometimes a child's) open for anyone who
  holds the bottle. Is a notice to the sender enough?

- **L-16** Austin rules on leaving items at doors: does a bottle with ads left at a house that didn't sign up count
  as a handbill or unsolicited advertising under Austin city code (no-solicitation signs, litter, door-hanger
  rules)? Must we honour "no soliciting" signs, and how would drivers know? **The founder decided (2026-10-21): signs are
  ignored; anyone who doesn't want the water opts out in the app and the house is skipped; drivers skip only for access
  or safety problems.** A lawyer should still confirm the city code allows leaving it at a house with such a sign.
- **L-17** Texas Data Privacy and Security Act: is choosing ads for a house from bought data "targeted advertising"
  or "profiling" for the people living there; is our address-only opt-out (no account, no verification) a valid
  method, and must the bottle itself carry it; do we qualify for the small-business exemption (and note that the
  exemption still forbids selling sensitive data without consent); universal opt-out signals (GPC) for a house.
- **L-18** Buying household data: the contract with the data company (its notice and consent basis, no sensitive
  data, our no-resale promise, deletion on request); Texas data-broker registration (the seller's, and whether we
  become one). (The address fingerprint in `household_optouts` is now keyed, H5.)
- **L-19** AI-written news: accuracy and liability (defamation, copyright and "hot news" from summarising other
  outlets' facts), the corrections policy, the "Based on reporting by" credit and links, and whether
  "FreeWater News" needs any disclosure that AI wrote it.
- **L-20** Household-level scan tracking: what notice a household that never signed up needs that its bottle's
  ads were chosen using data about the house, and that scans are counted (the "why am I seeing this" page explains
  per bottle).
- **L-21** A house's opt-out is kept forever as a keyed fingerprint of its address (H5) so later imports skip it: is that the right
  balance, and how long should it last when the house changes hands?
- **L-22** Children taking bottles left at doors: whether ad categories must be limited on undirected bottles
  (alcohol is already a concern, L-12), and whether area statistics such as "share of families with children" may
  choose ads at all.
- **L-23** Buying on delivery routes for one house or a few ("the house of their dreams"): is an ad bought for a
  single address, delivered by us, "targeted advertising" or "profiling" of the people there under TDPSA (and other
  states) even when no data about them is used? We keep these buys from any house that said no to targeted ads, let a
  claimed house block a business or every ad aimed at it alone, require a verified business and stricter review, and
  refuse names, addresses and personal messages in the ad (`docs/SWITCHES.md`, "Buying on delivery routes"). Is
  that enough, or must a single-house buy need the household's consent? Could such an ad be harassment or stalking
  in some uses, and what must the verification of the business cover?
- **L-24** The advertiser's proof report shows streets, house counts, each drop's time and a point rounded to about
  100 m (streets with fewer than five houses reached shown together). For a buy aimed at fewer than 50 houses we
  show the day only, since the time says when someone could be home. Is the time of day on larger buys, or the day
  on small ones, personal information about a household?
- **L-25** Credit instead of a refund when a house stops (buys on more than one house): a stored-value or
  unclaimed-property question if credit is never used, and whether advertisers must be able to ask for cash instead.
- **L-26** Photos of drops (065): a photo of a house's door (sometimes a person, a car plate, the inside through an open
  door), kept 90 days. Is the keep right (they are now listed in a resident's download, and a subscriber's own are deleted when they erase; photos at a claimed house stay until the keep: is that right); should drivers be told to frame
  only the box; do we need a notice on the box or in the app that a photo is taken? A privacy lawyer should confirm.
- **L-27** An AI deciding about a business on its own (066): where a company turns on "AI makes the final call on
  paid ads", the AI reviewer's rejection of an advertiser's paid ad is final without a person (its written reason is
  kept and shown; the advertiser can appeal to a person, once; a sample is audited by people; the refund is always a
  person's step). Do automated-decision rules apply when the decision is about a business rather than a person: the
  EU AI Act and GDPR Art. 22 (sole traders and named owners are people), the EU Platform-to-Business Regulation
  (statement of reasons, internal complaints for business users), the Colorado AI Act and California's ADMT
  regulations, and the FTC's view of unfair practices? Must the advertiser be told up front that an AI may decide, and
  what the appeal is? Is "appeal to a person, once" enough, and does a rejection need a deadline for the appeal?

- **L-28** Scan fees on a buy for a few houses: we no longer report scans, saves or taps for buys under 50 houses (the
  advertiser knows the houses), but if a company turns on per-scan fees, the bill and statement for such a buy count
  that household's scans. Should per-scan fees be impossible on small buys (our recommendation), or is a billed count
  acceptable?
- **L-29** Exact counts over time: an advertiser can see how many houses on each street get deliveries. On a street
  with one or two houses, a change in that count can show that a particular house stopped. Exact quotes are a product
  promise; is that residual risk acceptable, or should short streets be grouped?
- **L-30** News outlets a reader picks (`news_source_prefs`) may reveal political opinions: a special category under
  GDPR (not under Texas law). Kept only to write that person's stories, never for ads. Outside the US, is a
  separate explicit consent needed before we keep it?
- **L-31** How long to keep house records: every house's address and whether it stopped deliveries (`houses`), the
  driver's skip notes and the house's history (`house_events`, append-only), which ads went to which house
  (`route_spots`), the addresses an advertiser named (`route_buys.target`) and each drop's GPS point and time
  (`route_runs`). None has a keep period today.
- **L-32** The Texas opt-out method: is our address-only form (no account, no verification, on the scan page and as an
  API) "clear and conspicuous" enough, must the bottle label or box carry a short line pointing to it, and must the
  privacy notice describe it? (Opting out needs no verification; a neighbour could opt a house out, which only reduces
  targeting.)
- **L-33** Houses outside Austin: houses get US rules only when their route says US and a state. Before any route
  outside Texas, confirm that state's rules for aiming ads at a house (for example Maryland's limits on targeted ads
  and data minimisation).

- **L-34** Automated assessments of businesses (ad ratings, `j-rate`): every ad is scored 1–10 by an AI (or rules)
  and kept for good. It never decides anything about the advertiser (it never stops, flags or prices an ad), so we read
  it as outside GDPR art. 22 and outside California's automated decision-making rules; confirm. For sole traders: is
  the score their personal data (we include it in their download), may it be kept after they ask to be erased (we keep
  it as a record of the ad, with no contact details), and does the privacy notice for advertisers need to say ads are
  scored by AI?
- **L-35** Showing the score to advertisers (off by default): wording so a low score or a tip isn't read as a promise
  of results or as pressure to buy extras (FTC Act s. 5); the portal says "a guide … it never stops your ad".
- **L-36** Pooling across companies (benchmarks): averages of competing advertisers' and competing licensees' results
  (scan and sale rates by industry). Is this an exchange of competitively sensitive information (US antitrust; the
  agencies withdrew their information-exchange safe harbours in 2023)? Are 20 ads / 5 advertisers / no one over half /
  monthly, aggregated history enough, or should figures be older, coarser or held by a third party? Do the licensee
  and advertiser contracts allow their results to be pooled, and is "anonymous aggregates, never sold" the right
  promise for them?
- **L-37** Using advertisers' content and results to improve the rating (training): covered by the advertiser terms?
- **L-38** Link safety (docs/SWITCHES.md, "Link safety"): may we fetch every page an ad links to (and each redirect)
  from our server, refuse or flag links by our own list (adult, malware, phishing, shorteners), and put a live ad's code
  on a holding page while its link is checked, without breaching the advertiser's contract? Is keeping the $50 link fee
  when a change is rejected fair and clearly disclosed (docs/ADVERTISER-TERMS.md §8)? Does "I understand — use it as it
  is" (paying with quality issues left) need terms on refunds for poor prints (§6)?
- **L-39** Google Safe Browsing: the v4 Lookup API is for non-commercial use; a commercial service may need Google's
  Web Risk API (paid) instead. Which do we use, under which terms, and may advertisers' URLs be sent to Google?
- **L-40** **No promises** (the founder): every rating, score, meter, tip and benchmark now says "This rating is our
  opinion of how well the ad is put together. It isn't a promise of results." Is that wording, with the draft terms
  section "Ratings and benchmarks are guidance, not guarantees" (docs/ADVERTISER-TERMS.md §1–5), enough under the FTC
  Act s. 5 and state consumer-protection law, including for benchmarks with deliberate noise (docs/AI.md)? Should the
  noise be disclosed in the terms as well as on the page? Replaces the portal's earlier "a guide …" wording in L-35.

### Before the Austin pilot: what the lawyer must answer (for the founder)

In plain words, the questions that block the pilot (the rest can follow it):

1. **Leaving bottles with ads at houses that didn't ask** (L-16): does Austin city code allow it, signs or not?
2. **Is choosing ads for a house "targeted advertising" under Texas law** (L-17, L-23), even when only its street or
   address is used, and is our no-account opt-out (scan page and form, L-32) a valid way to say no? Must the bottle
   point to it?
3. **Buying household data** (L-18): the contract with the data company, whether we must register as a Texas data
   broker, and confirmation that the list we accept has nothing sensitive.
4. **Buys aimed at one house** (L-23, L-24, L-28): do they need the household's consent; is the advertiser's report
   (day of the drop, rough place) personal information; should scan fees be impossible on them?
5. **Photos of doors** (L-26): is 90 days right, is a notice needed, and should drivers frame only the box?
6. **Children** (L-6, L-12, L-22): bottles at doors reach children; may alcohol or similar ads be on them, and may
   "share of families with children" choose ads?
7. **The privacy policy and notices** (L-1), including how long house records are kept (L-31).

What the code already does for each is in the tables above; nothing about houses is switched on until a person does.

## 6. What this review could not check

Ad ratings (`j-rate`): a real Claude answering the rating prompt (tests use a stand-in and a mocked API call), the law
(L-34 to L-37), and how the outcome query performs on years of real events (it scans a company's print, scan and AR
events since the oldest version it refreshes, hourly; PLAUSIBLE that it needs incremental counters at scale, proven by
running `refreshOutcomes` against a production-sized copy).

Core slice 3: real phones (AR on iPhone Quick Look and Android Scene Viewer, a phone without AR, a slow network, a
missing model file), real CDN caching behaviour, and Veo itself; see `docs/REVIEW-LOG.md` for what each would prove.


Real phones and browsers sending GPC, real geolocation, the law itself (every **Lawyer** line), printed labels, and
whether advertisers ever receive anything beyond counts outside the code paths read here (PLAUSIBLE: proven by a
review of every advertiser-scope route's response for phone keys).

News, fillers and household data (`p-news`): the law itself (L-16 to L-22), a real data company's file (the import
was tested with CSV and JSON stand-ins), real census files (the Austin areas are made up and labelled SAMPLE), a
real Claude model writing stories (the tests use a stand-in writer and a mocked API call), and printed labels with a
news topic.

Release check (`r-priv`): the law itself (every L line, above all L-16, L-17, L-23, L-32), a real data company's file,
real phones on the scan page's new opt-out (it was checked only as code, not in a browser), whether the pilot's real
routes are created with `country`/`state` (the seed's are; there is no console field for routes, so whoever creates the
pilot's routes must set them, or house data stays unused there), and Postgres itself for `rekey` under concurrent
imports (run at start, before requests; tested on the in-process database).
