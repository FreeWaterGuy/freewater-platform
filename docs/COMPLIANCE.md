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
| `household_attributes` | **Street address** of a house (often of people who never signed up) + attributes from a closed list (size, income band, owner/renter, dwelling, years, interests), each with source, date, bought/first-party | Choosing ads for that house only; **never sold or passed on**; never shown to advertisers per house | **395 d after import** (`purge`); deleted at once by source or import, by a house's opt-out, or by a resident's erase | Team (`GET /v1/households/audience`, no-store) | A resident's download lists what we hold about their delivery address; erase deletes it and opts the house out (tested) |
| `household_optouts` | A per-company **unsalted SHA-256 of the normalised address** (a pseudonym: addresses are guessable, so this is still personal data) | Keeping a house that said no out of every later import | Kept (it is the record of the "no") | No one (no route shows it) | Not deletable by the house itself; see L-21 |

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
| The law of where the house is | Code | Houses in Austin get Texas rules through `jurisdiction.ts` when a resident is known; a house with no account has no person to place. **Lawyer:** L-17. |
| Targeted-ad opt-out without an account | Code | `POST /v1/public/households/:companyId/opt-out` (address only; same answer whether or not we held anything); a resident's do-not-sell or GPC keeps the whole house out. **Lawyer:** L-17 (is an address-only form enough; must it be on the bottle?). |
| Sensitive data never in bought-data targeting | Code | Closed attribute list + `SENSITIVE` refuses health, religion, ethnicity, sexuality, immigration, children, politics, precise location by name and by value; a child at home leaves only area statistics. |
| Bought data never sold onward | Code | No route returns it to anyone but the team; advertisers never see a house's audience (403, tested). **Lawyer:** L-18. |
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
  rules)? Must we honour "no soliciting" signs, and how would drivers know?
- **L-17** Texas Data Privacy and Security Act: is choosing ads for a house from bought data "targeted advertising"
  or "profiling" for the people living there; is our address-only opt-out (no account, no verification) a valid
  method, and must the bottle itself carry it; do we qualify for the small-business exemption (and note that the
  exemption still forbids selling sensitive data without consent); universal opt-out signals (GPC) for a house.
- **L-18** Buying household data: the contract with the data company (its notice and consent basis, no sensitive
  data, our no-resale promise, deletion on request); Texas data-broker registration (the seller's, and whether we
  become one); whether the unsalted address hash in `household_optouts` should be keyed.
- **L-19** AI-written news: accuracy and liability (defamation, copyright and "hot news" from summarising other
  outlets' facts), the corrections policy, the "Based on reporting by" credit and links, and whether
  "FreeWater News" needs any disclosure that AI wrote it.
- **L-20** Household-level scan tracking: what notice a household that never signed up needs that its bottle's
  ads were chosen using data about the house, and that scans are counted (the "why am I seeing this" page explains
  per bottle).
- **L-21** A house's opt-out is kept forever as a hash of its address so later imports skip it: is that the right
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

## 6. What this review could not check

Core slice 3: real phones (AR on iPhone Quick Look and Android Scene Viewer, a phone without AR, a slow network, a
missing model file), real CDN caching behaviour, and Veo itself; see `docs/REVIEW-LOG.md` for what each would prove.


Real phones and browsers sending GPC, real geolocation, the law itself (every **Lawyer** line), printed labels, and
whether advertisers ever receive anything beyond counts outside the code paths read here (PLAUSIBLE: proven by a
review of every advertiser-scope route's response for phone keys).

News, fillers and household data (`p-news`): the law itself (L-16 to L-22), a real data company's file (the import
was tested with CSV and JSON stand-ins), real census files (the Austin areas are made up and labelled SAMPLE), a
real Claude model writing stories (the tests use a stand-in writer and a mocked API call), and printed labels with a
news topic.
