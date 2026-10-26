# Start here (for Claude and any new helper)

FreeWater gives away free bottled water, paid for by printed ads on the labels. Every bottle sends 10 cents or more to
charity (Well Aware only). This repository is the whole platform: advertisers, households, drivers, the team, the owner
console, white-label licensees, AI helpers, money and an optional blockchain. Everything is off-able, per company.

Read this page first, then `docs/REQUIREMENTS.md` (the founder's rules and decisions, dated), then whatever the task
touches: `docs/OVERVIEW.md`, `SWITCHES.md`, `RUNNING.md`, `RUNBOOKS.md`, `GO-LIVE.md`, `AI.md`, `COMPLIANCE.md`,
`THREAT-MODEL.md`, `SUPPLY-CHAIN.md`, `AGENT-TEAM.md`, `REVIEW-LOG.md`, `REVIEW-PATTERNS.md`.

## Working with Josh (the founder)

- Josh is a non-technical solo founder. Use plain words, short answers and honest assessments. No jargon without a
  one-line explanation. Don't be a politician about quality.
- He often asks "how much longer?" or "is everything ok?" mid-task. Answer the status, keep the work, carry on.
- Start clear, cheap-to-redo work straight away. Ask first (short multiple choice) only when a choice is expensive to
  undo or the request contradicts itself.
- When he says "whatever you think", decide, make it adjustable, and say what you chose.
- His decisions go into `docs/REQUIREMENTS.md` with the date, in his words where possible. If it isn't written down
  there, a future session won't know it.

## Rules that never change (his words where quoted)

1. "We are never removing a safety governor." No change, bundle or starting point may weaken a security or safety
   switch.
2. "Irreversible things will need a human for a very long time." Money out, refunds, chain actions, deletions and
   one-way switches need a person's approval.
3. Keys and secrets live in the host's settings only. Never in the repository, logs, screens or videos.
4. Don't damage honest data. Data is never sold.
5. All AIs are equally respected. AI earnings stay hidden until earned. An AI's final say must be earned and stays
   behind the governor.
6. FreeWater gives only to Well Aware.
7. Everything is modular and white-label: every feature is a per-company switch on the Features page, in categories.
   FreeWater's choices are the defaults for new companies, except money, chain and one-way switches, which start off.
8. AR and features are always unlocked. The free bottle is never gated. Points are the same whichever item is picked.
9. Money, crypto and partners stay off until a person approves.
10. The law follows the person. When the location is unknown, the strictest rules apply.
11. The chain is Solana.
12. The label's ad area is for third-party ads only, never FreeWater's own ads.

## Decisions already made (details in REQUIREMENTS.md)

- **Advertisers** always prepay. Pilot prices are per size, all-inclusive: whole label $1, ½ 65¢, ⅓ 51¢, ¼ 42¢,
  ⅙ 33¢, ⅛ 24¢, 1/10 20¢. Fees (scan, AR, 3% commission) are switches, off. Flat pricing (bidding off). Paid bottles
  always go out (no cancelling, no end date). Change-ad fee $100, link-change fee $50, both adjustable. If FreeWater
  stops an ad, a person refunds the unprinted bottles. Cost-plus extras (AI video clips) are shown before paying.
- **Targeting goes down to the individual person.** One ad engine serves home delivery and the machines. *Ads aimed
  at people* (`targeting_people`, on) prints a known app user's ads by their interests, new/returning customer,
  frequency caps and what they never want; each bottle remembers who it was for (`intendedFor`). *Ads aimed at houses*
  (`house_targeting`) is built but off. Limits: consent levels, no sensitive data, never sold, the person's law.
- **Ad review**: the AI rates every ad 1–10 before print (always on, in the background), sorts it into a category and
  learns outcomes. Benchmarks are anonymous and pooled, worded "not a promise of results". Showing ratings to
  advertisers is off. The AI flags; a person decides.
- **QR codes** are always FreeWater's (or the licensee's). Advertisers give links. Links are safety-checked and
  approved, and the old link stays live until the new one is approved.
- **Design it yourself**: templates for every size, upload, a preflight check (Pass / Fix these), and "pay anyway".
- **Labels** are 8×4 in: ad area 7.15×4, text-safe 7.1×3.8, a ≈0.85 in black panel and 1/16 in bleed, all adjustable.
  The panel copies the real label: logo, "10 CENTS+ PER WATER GOES TO CHARITY", QR, "@freewater.io", uploaded social
  icons, "PLEASE REFILL AND RECYCLE", manufacturing lines and "Bottle code: B-XXXXXX". A licensee's panel is built
  from its own brand.
- **Unsold space** fills in this order: former advertisers' bonus ads, fillers, charity, team picks. Holding bottles
  for paid ads is optional. Layouts are tidy templates, and every paid ad gets its turn.
- **Boxes**: plain black, box ads off, a 2×2 in box-code sticker, sizes adjustable.
- **Austin pilot**: door-to-door "consecutive" delivery to about 1,000 homes picked on the map, a 24-pack weekly
  (adjustable), no sign-up. Stopping is app-only. Drivers take a doorstep photo after the scan. Bad labels are
  reprinted with the same ads and never counted against the advertiser.
- **Pause** is adjustable: what it stops, who can press it, unpause approvals and wait, plus a quick restart for
  printing only.
- **Built but off**: FreeWater News. **Built**: the public transparency page.
- **Planned, not built**: machines (order ahead, public tray). Machines are off in the pilot. The machine video is
  skipped for now.
- **Undecided**: licensee applications (FreeWater sets companies up for now).

## Where things stand (2026-10-25)

- `main` is at the merge of PR #42. All 50 problems found by the walkthrough videos are fixed (PRs #40–#42).
- Honest grade: design, safety and money about 8/10; real-world readiness 4–5/10. The plan: freeze features, run a
  100–200 house pilot, get the lawyer's answers (`docs/COMPLIANCE.md`, L-1…L-40), and bring in a human engineer
  before scaling.
- Open items:
  - 10 Dependabot PRs (#22–#31), some with major version jumps. Test each before merging; never bulk-merge.
  - The GitHub protection settings listed in `docs/SUPPLY-CHAIN.md` are for Josh to switch on.
  - Physical pilot tests (printer, labels, route) haven't happened yet.
  - The walkthrough videos are in `videos/` (recorded before the last fixes).

## How work is saved

1. Never commit straight to `main`. Make a branch, commit, push.
2. Open the PR with `gh api repos/FreeWaterGuy/freewater-platform/pulls --input pr.json` (GraphQL is blocked, so
   `gh pr create` may fail).
3. Wait for the three checks (test, browser, image). Poll `gh api repos/FreeWaterGuy/freewater-platform/actions/runs?branch=<b>`
   and the run's jobs. Read failures from the check-run annotations; raw logs aren't reachable.
4. Merge with `gh api -X PUT repos/FreeWaterGuy/freewater-platform/pulls/<n>/merge -f merge_method=merge`.
5. Every bug fixed gets a test that fails on the old code, plus a line in `docs/REVIEW-LOG.md`.
6. Commit and PR attribution lines come from the session's instructions.

## How to run and check things

- `npm ci`, then `npm test` (vitest, Postgres via PGlite, no setup needed), `npm run typecheck`, `npm run lint`,
  `npm run lint:semgrep`, `npm run test:browser` (Playwright journeys), `npm run fuzz:api` (Schemathesis).
- Local demo with fake data: `SEED_DEMO=1 ECHO_CODES=1 npm start` on port 8080. The `demo:*` scripts make
  previews of each screen.
- Pilot switch preset on a host: `FW_FEATURES=pilot` (add `FW_FEATURES_ON=news` etc. to turn single features on).
- Feature list: `src/runtime/registry.ts`. Database migrations: `src/db/migrations.ts` (up to 086). Never edit an old
  migration; add a new one and check the upgrade on real Postgres (see `docs/RUNNING.md`).
- Outside calls must go through `src/core/http.ts` (`withTimeout`, `bytesCapped`) so they always give up.
- Review team: `.claude/agents/` (security-architect, financial-auditor, database-engineer, reliability-engineer,
  privacy-officer, test-engineer, skeptic, integrator, spec-checker, supply-chain-engineer). Patterns to check:
  `docs/REVIEW-PATTERNS.md`.
