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

Existing tests changed because they encoded the old behaviour: `test/console.test.ts`, `test/wallet.test.ts`,
`test/review-money.test.ts`, `test/review2-money.test.ts`, `test/review3-money.test.ts` (their owners and finance
people now sign in with the second step before approving) and `test/lottery.test.ts` (the draw key names the phone
by its fingerprint).

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

## 6. What this review could not check

Real phones and browsers sending GPC, real geolocation, the law itself (every **Lawyer** line), printed labels, and
whether advertisers ever receive anything beyond counts outside the code paths read here (PLAUSIBLE: proven by a
review of every advertiser-scope route's response for phone keys).
