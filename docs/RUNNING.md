# Running FreeWater in production

This is the guide for whoever runs the servers. `docs/GO-LIVE.md` is the plain-language checklist of what has to
be signed up for and connected first.

## The shape of it

- **One server** runs the whole platform: the API, the scan pages, the consoles and the background jobs. It keeps its
  working state in memory and writes every change to **Postgres** before it answers.
- **Only one server may own the data at a time.** A second copy waits (up to `LEASE_WAIT_MS`, 2 minutes by default)
  and starts the moment the first lets go; only then does it change any tables. So a deploy means: start the new
  one, stop the old one. The hand-over takes about a second. A server that can't renew its claim within about 18
  seconds stops writing and answering at once, and exits. Every write checks the claim in its own transaction (the
  write queue's and the direct ones alike), and a server whose last renewal is older than about 22 seconds (frozen,
  say, and just resumed) refuses every change (503) and runs no job until a renewal succeeds.
- **Files** (pictures, 3D models, videos, receipts) go to S3-compatible storage, or stay in the database for a pilot.
- **Backups**: the database host's own, plus our own encrypted copy each day, plus a weekly proof that the latest
  copy restores and its books check out.

Measured on one ordinary server, against Postgres, with `npm run load`: about **550 requests a second** with no
errors, which is roughly 9 million scans a day. Memory grows by about **13 KB per bottle** printed, so with 8 GB of
memory a server holds roughly 500,000 bottles. The memory alert says when it's getting full. Past that, the next
stage is moving the working state out of memory (see the end of this file).

## Settings

The server checks these when it starts. In production (`NODE_ENV=production`) anything unsafe or missing stops it,
with a plain explanation.

| Setting | What it's for |
|---|---|
| `NODE_ENV=production` | Turns on the strict checks and caching. |
| `FW_FEATURES` | `pilot` switches off everything outside the core loop (see *The pilot* below). Unset (or `all`): everything on. |
| `FW_FEATURES_OFF` | Comma list of further areas to switch off, e.g. `lottery,offers` (added to the preset). The areas: `token`, `token_conversion`, `withdrawals`, `gift_cards`, `partners`, `agents_fund`, `network`, `lottery`, `video_generation`, `offers`, `games`, `news`. An unknown name stops a production start. |
| `FW_FEATURES_ON` | Areas that start **off** everywhere until named here: today only `news` (FreeWater News on unsold spots; docs/SWITCHES.md “News”). Naming it brings it back even over the pilot preset, so it can be tried in the pilot on purpose; `FW_FEATURES_OFF` still wins. Each company must also turn `news.on` on itself (a person, in the console). |
| `ALLOW_STANDINS=1` | Required in production for now: real payment, payout and email/text providers aren't wired yet, so the server runs on stand-ins (no real money moves, no message is sent) and refuses to start in production unless this says it's a staging rehearsal. It logs and alerts which stand-ins are active. Remove it once the real providers are in. |
| `DATABASE_URL` | Postgres 13–17, e.g. `postgres://user:pass@host:5432/freewater?sslmode=require`. Use a managed one with automatic backups and point-in-time recovery. |
| `PUBLIC_URL` | The https address of the site. It goes on every printed QR code and in every email. |
| `TRUST_PROXY` | Which proxies' word to take for a visitor's address. The number of proxies in front of the server (`1` for one load balancer, `2` with a CDN such as Cloudflare in front of it), or their addresses or ranges (`10.0.0.0/8`), or `none` when nothing is in front. Never `true`: every visitor writes `X-Forwarded-For` too, so trusting every hop lets anyone pose as any address and walk past sign-in limits, request limits and points-per-network rules. The server refuses `true`, `*`, `all` and ranges like `0.0.0.0/0`. With a hop count, make sure the server can only be reached through the load balancer (the usual set-up on hosting platforms); if it can also be reached directly, give the load balancer's addresses instead. |
| `HOST`, `PORT` | `0.0.0.0` and `8080` in the container (already set in the image). |
| `ALERT_WEBHOOK_URL` | A chat channel's incoming webhook (Slack, Discord, Google Chat). Alerts go there. |
| `ALERT_EMAIL` | Also email alerts (once email is connected). |
| `SENTRY_DSN` | Error tracking (Sentry's free plan, or GlitchTip): the project's DSN from Settings → Client Keys, `https://<key>@o….ingest.sentry.io/<project>`. Unexpected errors (with their stack), other 5xx answers, failed background jobs, unhandled rejections and crashes, and every critical or warning alert go there, scrubbed of personal data (no query, body, headers, cookies, keys, emails, phones, cards or addresses). Without it nothing is sent. Must be https in production. `SENTRY_ENVIRONMENT` names the environment (default `NODE_ENV`); the release is `FW_VERSION` or `GIT_SHA`. Setup: `docs/RUNBOOKS.md`. |
| `FILE_STORAGE` | `database` (default), `s3`, or `disk` (single server, backed-up disk only). |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_PREFIX` | For `FILE_STORAGE=s3`. `S3_ENDPOINT` for R2, B2 or MinIO (e.g. `https://<account>.r2.cloudflarestorage.com`); leave it out for Amazon S3 and set `S3_REGION`. Give the key read, write, delete **and list** on the bucket (without list, a missing file looks like "access denied"). |
| `FW_SPOOL_DIR` | Where changes waiting for the database are also kept. Default in the image: `/var/lib/freewater/spool`. Mount a volume. In production, an unwritable one stops the start. |
| `DATABASE_POOL_SIZE` | Database connections (default 10). |
| `DATABASE_MAX_GB` | The size of the database plan. An alert goes out at 70% and 85% of it. |
| `PUBLIC_UPLOAD_MB_PER_NETWORK`, `PUBLIC_UPLOAD_MB_PER_DAY` | Ceilings on files sent by visitors without a key (feedback pictures and videos, offer receipts): per network (an IPv4 /24 or IPv6 /48) a day (default 100 MB), and for the whole platform a day (default 1 GB with files in the database, 10 GB with file storage). An alert goes out at 80% and when the ceiling is reached; past it, those uploads are refused until the next day (UTC) and everything else carries on. |
| `FW_SECRET_CODES`, `FW_SECRET_SECOND_STEP`, `FW_SECRET_LINKS`, `FW_SECRET_WALLET`, `FW_SECRET_VIEWER_TAGS` | Required in production: the secrets that sign printed codes, seal second-step seeds, fingerprint links and networks, and fingerprint phones' keys in the activity log and team screens. Each 32+ random characters, or `hex:` and 64 hex digits (`node -e "console.log('hex:'+require('crypto').randomBytes(32).toString('hex'))"`). **A database that ran before already has them in `platform_secrets`; every printed code was signed with those, so set each to `hex:<its value>` from there (the server refuses a different one), then delete the rows.** |
| `BACKUP_KEY` | 32 random bytes, base64. Make with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Keep a copy away from the server; without it no backup can be read.** |
| `MACHINE_UPDATE_SIGNING_KEY` | The Ed25519 key that signs Model 6 software updates. Make the pair with `npm run key:machine-updates`; this half lives only here, the public half goes in each machine as `FW_UPDATE_PUBLIC_KEY`. Without it, software updates are refused. See `docs/SUPPLY-CHAIN.md`. |
| `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION` | Where backups go: a different bucket (ideally a different account) from the files. Turn on object lock / a 30-day retention rule so they can't be deleted early. |
| `RESTORE_TEST_URL` | A spare, empty database the weekly restore check may wipe and fill. **Never the real one.** |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_PERSONALIZE_MODEL` | Claude, for the agents, ad assistant, designer, video writer and team assistant. Without it the built-in rules run. |
| `AI_KEY_<COMPANY ID>` | An operator's own Anthropic key, when it chose "our own AI" in the console (for example `AI_KEY_PEAK_SPRING`). Only that operator's AI calls use it. |
| `GEMINI_API_KEY`, `VEO_MODEL` | Veo, for live-action and animated footage. Optional; costs money per clip. |
| `FOOTAGE_PER_COMPANY_DAY` | Most footage clips one company may start in any 24 hours, across all its ads (default 60; each ad also stops at 12). The team is alerted when a company reaches it. |
| `GEOIP_DB` | Path to MaxMind's GeoLite2 City file, to tell where each visitor is so their own law applies. Without it (and without trusted headers), everyone gets the strictest rules. |
| `TRUST_GEO_HEADERS` | `1` when the host adds a visitor-country header (Cloudflare `CF-IPCountry`, Vercel, Fastly). Only behind such a host: otherwise anyone could send it. |
| `SANCTIONED_COUNTRIES` | Comma-separated country codes where points and prizes aren't offered (default `CU,IR,KP,SY`). |
| `VERYFI_CLIENT_ID`, `VERYFI_USERNAME`, `VERYFI_API_KEY` | Reads receipt photos for brand offers. Without them, each receipt waits for a person on the team to check. |
| `SOLANA_DEVNET_MINT`, `SOLANA_DEVNET_PAYER`, `SOLANA_DEVNET_MINT_AUTHORITY`, `SOLANA_DEVNET_RPC_URL` | Solana's free test network, used before going live with the token (keys as JSON arrays, as Solana's tools save them). Without them, a stand-in runs. |
| `SOLANA_TOKEN_PROGRAM` | `classic` if the token was made with the original SPL token program; Token-2022 otherwise. The Solana connection is the platform company's (`PLATFORM_COMPANY`); white-label companies run on the stand-in until they have their own token. |
| `SOLANA_MINT`, `SOLANA_PAYER`, `SOLANA_CUSTODY`, `SOLANA_RPC_URL` | The real Solana network, used once live with the token. The payer key only pays fees and writes seals; minting and people's tokens belong to the Squads vault (`SOLANA_CUSTODY`), signed by people. A minting key for the real network is refused. |
| `TREMENDOUS_API_KEY`, `TREMENDOUS_FUNDING_SOURCE`, `TREMENDOUS_SANDBOX` | Gift cards bought with credit (Tremendous). Without them, a stand-in answers and its cards say TEST. Gift cards stay off until exchanges are approved under Launch. |
| `GEO_FIXED` | Local runs only (ignored in production): treat every visitor as being in one place, e.g. `US-TX`. |
| `FW_AI_PRICES` | Real per-model prices (JSON), once invoices are in. |
| `FW_ANCHOR_GITHUB_TOKEN`, `FW_ANCHOR_GITHUB_REPO`, `FW_ANCHOR_GITHUB_BRANCH`, `FW_ANCHOR_BITCOIN` | Where each day's books fingerprint is published. |
| `PLATFORM_COMPANY` | The operator's company id (`freewater`). |
| `NODE_OPTIONS` | e.g. `--enable-source-maps --max-old-space-size=6144` to let the server use about 6 GB. Set to about ¾ of the machine's memory. |
| `LOG=0` | Turns off the per-request log (on by default; JSON, one line per request, no secrets). |
| `RUN_JOBS=0` | A server that answers requests but runs no background jobs (for a one-off debug copy). |

Never in production: `SEED_DEMO=1`, `ECHO_CODES=1`, `ALLOW_PRIVATE_WEBHOOKS=1`. The server refuses to start with them.

## The pilot (`FW_FEATURES=pilot`)

The first small launch runs only the core loop, so there's less to secure, explain and watch. Set `FW_FEATURES=pilot`
in the host's settings. Whole areas are then **gone, not refused**: their addresses aren't registered (404, and not in
`/v1/openapi.json`), their background jobs aren't scheduled, the several-people steps that would switch them on can't
be proposed or run, and the console, app, ads portal and ops console hide them (they read `GET /v1/public/features`).
The server logs what's off when it starts. It's a deploy setting: to switch an area back on, change the setting and
restart. Nothing stored is deleted.

**On in the pilot:** bottles, ads and printing; scans, AR, attribution (tracked sales and coupons); the app (free
bottle, points in the wallet, data levels); delivery, packs and the driver app; the advertiser portal and studio; the
ops console, the owner console and the open books; giving; accounts, team and keys (and webhooks); data and privacy
rights; transparency; machines; the games; the AI governor and the AI assistants; and launch up to **live with
points** (testing, bots, reset, going live with points, the pause switch, the hourly seals of the wallet books).

**Off in the pilot**, and why:

| Area | What goes | Why off |
|---|---|---|
| `token` | Going live with the token, minting, switching the chain on, signing in Squads; the daily `chain-check` job | Needs the lawyer and 2 other approvers; nothing in the core loop uses it. |
| `token_conversion` | Turning points into tokens | Comes after the token. (Sales "conversions" are attribution and stay on.) |
| `withdrawals` | Moving tokens to one's own wallet | Comes after the token; not built yet. |
| `gift_cards` | Spending credit on gift cards, and the step that turns exchanges on | Moves money; needs Tremendous and approvals. The team's list and settle screens for purchases already made stay. With it off, the gift-card stand-in no longer counts against `ALLOW_STANDINS`. |
| `partners` | Exchanging points or credit through a money partner (card issuer, treasury stand-ins) | Neither partner is connected. |
| `agents_fund` | Sharing out, spending from and unlocking with the AI agents' fund | Money for the agents waits for the trust the lawyer sets up. The governor, number line, exams, proposals and assistants keep running. |
| `network` | Setting up licensees; archiving agents when an operator leaves (continuity) | One operator in the pilot. |
| `lottery` | The prize game (chances on scan pages, claims, fairness, redeeming) | Off until a lawyer approves its rules. |
| `video_generation` | Veo footage for "Show me more" and its `videos` job | Costs money per clip. Motion videos, made on the spot, stay. |
| `offers` | Brand offers, receipts, barcode lookup, value-back tests on offers, and the `offers` job | They pay people real money from brand reserves and need receipt checking; not needed to give free water. |

**Kept on, by judgment:** points and going live with points, because the app's wallet shows points, the full data
level earns them, the games pay them, and only going live ends the test stage (where points are marked as test and
wiped). The games, because they're how the platform learns honestly what people want and they move no money.

Turning an area off is quick and safe at any time; turning one back on is a deliberate restart. Before switching off
`gift_cards` or `offers` on a server that has used them, settle what's in flight (unknown gift-card purchases are
settled from `GET /v1/wallet/gift-cards`, which stays; offer claims waiting for a receipt wait until offers are on
again).

## First start

```
docker build -t freewater .
docker run --env-file .env freewater npm run setup -- --owner you@freewater.io   # once, on the empty database
docker volume create freewater-spool                                               # once: keeps waiting changes across restarts and deploys
docker run -d --restart unless-stopped -p 8080:8080 --env-file .env -v freewater-spool:/var/lib/freewater --name freewater freewater
```

**Restart it automatically** (`--restart unless-stopped`, or the hosting platform's "restart on failure"). On purpose,
the server stops itself when it can't be sure it's the only one owning the data (a long database outage, a freeze):
the restart is what brings it back once the database is.

Always run the server with that same named volume (on hosting platforms: a persistent disk mounted at
`/var/lib/freewater`), including the new copy during a deploy.

`setup` creates FreeWater itself, its products, boxes, house ad and charity (bank details to add in the console),
and its owner, and prints one platform key, once. Keep that key in a password manager. Then sign in to `/console`
with the owner's email, turn on the second sign-in step, and add team, machines and advertisers there.

## Health, status and alerts

- `GET /health`: the process is up, and its version. Never touches the database.
- `GET /health/live`: the process is up. Use it for "restart it if this fails". It answers even while the server is
  stopping itself.
- `GET /health/ready`: it can do its work (database answering, owns the data, every change saved, jobs not failing).
  Use it for "send it traffic only if this passes". It returns 503 only when it really can't serve; otherwise
  `problems` lists what's wrong (changes paused, a job failing) with a 200.
- `GET /health/uptime`: for an outside uptime checker (UptimeRobot, Better Stack). 200 only when the database answers
  within 2 seconds and this server owns the data and is sure of it; otherwise 503 with the reason. One `select 1`;
  `HEAD` works too.
- `GET /health/deep` (platform key): each background job's freshness (did it work within two of its intervals),
  what's queued (changes waiting for the database, webhooks waiting), the spool file, the last books reconciliation
  per company and the last books check (the weekly restore check), and the error tracker's counts.
- `GET /v1/platform/status` (platform key): the background jobs, saving, which server owns the data, memory,
  recent alerts. Both staff pages answer at once even while changes are waiting for the database.
- Alerts go out for: a change that couldn't be saved, a job failing (and again when it recovers), a server error,
  memory at 70% and 85%, the database at 70% and 85% of `DATABASE_MAX_GB`, less than 2 GB (then 0.5 GB) free on the
  spool's disk, visitors' uploads at 80% of the day's ceiling and when it's reached, the server losing its claim to
  the data, a crash, our own backups being off, an older version running on a newer database (a rollback), books
  that don't reconcile, the chain paused, and changes piling up while the database refuses them (1,000 waiting or a
  50 MB spool, then 20,000 or 500 MB). The same alert repeats at most every 30 minutes, but one that gets worse
  (warning to critical) goes out at once.
- With `SENTRY_DSN`, every critical and warning alert also goes to the error tracker (one issue per alert), and so
  do unexpected errors, other 5xx answers (one issue per status and code), failed jobs and crashes, each at most once
  a minute and at most 20 events a minute in all.
- What to do about each, step by step: `docs/RUNBOOKS.md`.

## If changes are waiting (the database refusing them)

Nothing is dropped. Changes stay queued in order and are tried again and again, waiting a little longer each time (up
to 30 seconds), until the database takes them. Nothing newer jumps ahead, so once it's back the database matches
memory exactly. While changes wait:

- a critical alert goes out, and another when everything is saved;
- the platform is **paused**: pages, scans and the books still read, and scans, QR opens, link clicks and what people
  do on pages are still recorded (queued behind the waiting changes); new orders, settings and the like get a polite
  "paused, try again shortly";
- background jobs wait (no month closed and no fingerprint published from books that are behind), except the memory
  watch and backups;
- every waiting change is also in the spool file in `FW_SPOOL_DIR` (in the image, `/var/lib/freewater/spool`;
  **mount a volume there**). If the server stops before the database is back, the next server writes them first,
  before it reads anything: exactly the ones past what was already saved (every batch records how far it got). If a
  different server has written since, the spool is not applied; it's renamed `….stale-<time>` for a person to look
  at, and the server starts normally. On a database restored with `npm run backup -- restore` (it still carries the
  restore's mark), the spool is set aside as `….restored-<time>` with an alert: those changes would land after a gap.
  After a provider's point-in-time restore, start once with `FW_SPOOL_SKIP=1` (docs/RUNBOOKS.md).
- An outage longer than about 18 seconds also costs the server its claim to the data, so it stops; whichever server
  starts next writes the spool. That's expected during a long database failover.

Usually that's all: a database restart or failover fixes itself. If the database answers but one change keeps being
refused (a bug), it holds the line. Then, as a person's decision, `POST /v1/platform/persistence/skip-stuck` moves
that one change aside (kept word for word in `persistence_failures`) so the rest go in. Fix the bug, put the change
back by hand, and restart the server so its memory is reloaded from the database.

If a spool can't be applied at start-up (the server refuses to start and says why), fix the cause, or as a person's
decision start once with `FW_SPOOL_SKIP=1` to set it aside unapplied (`….skipped-<time>`), and deal with it by hand.

## Background jobs

| Job | How often | What it does | Safe to run again? |
|---|---|---|---|
| `webhooks` | 3 s | Sends webhooks to companies' systems, with retries. | Yes: each delivery is tracked. |
| `fleet-sweep` | 15 s | Opens an "offline" problem for Model 6 machines that stopped calling in; lets go of kept offline labels 48 hours after their time (a machine still offline may yet report a bottle it gave before then). | Yes. |
| `videos` | 10 s | Checks on footage being made; a clip claimed but never started (the server stopped) fails after 15 minutes so it can be tried again. | Yes. |
| `credit` | hourly | Pauses the live ads of advertisers who owe more than their credit allows, alerting the team and emailing the advertiser (docs/SWITCHES.md, "Credit for advertisers"). Also runs at once when an invoice's card is declined. It never turns anything back on. | Yes: an ad already paused is left alone. |
| `deliveries-overdue` | hourly | Alerts when active home deliveries' day (or a delivery area's houses' night) went by without being planned or printed, and when an area's run from an earlier day is still printing. It never plans a night itself (printing bills advertisers): a person does (docs/RUNBOOKS.md). | Yes: it only alerts, and moves on the next date of a subscription a printed run already covers. |
| `ad-fees` | daily | Charges prepaid advertisers' cards for the fees a person switched on (scans, AR, box sides, commission): invoices what's new, and charges invoices an earlier run left open (the provider was down, or a restart). A declined card pauses their ads. | Yes: each line is invoiced once and each invoice charged once (the same request id). If the provider is down the job fails, alerts, and the next try charges what's open. |
| `ad-payments` | hourly | Finishes ad payments and refunds a restart or a timeout cut off, from the payment provider's answer; an order never charged is let go after 2 minutes. | Yes: the same request id, so never twice. |
| `route-buys` | daily | Gives back route pieces that can't go out (their week went by, the house stopped or blocked them, their box came back): credit, or a refund waiting for a person. Finishes approved refunds a restart cut off. | Yes: each piece once (by its status). |
| `drop-photos` | daily | Deletes door photos past each company's keep (90 days unless set), for every company whatever its switches, oldest first, at most 5,000 per company a run. A photo whose file can't be deleted from file storage keeps its record and the job fails (alert), to try again. | Yes: a deleted photo is skipped. |
| `books-and-agents` | hourly | Closes any month that's due, measures agents' changes, reads every agent's standing, shares out the AI fund, security review. Company by company. | Yes: a month closes once, a day's share-out once (crash-tested). |
| `agent-exams` | daily | Any agent whose model hasn't passed the current test takes it. | Yes. |
| `game-photos` | 6 hours | Finds photos of the real products for the games' cards, a few at a time. | Yes. |
| `offers` | hourly | Closes brand-offer claims with no receipt after 14 days (points go back); pays approved ones that were held. | Yes: each claim once. |
| `wallet-seals` | 10 min | Seals each finished hour of the wallet journal. | Yes: an hour is sealed once. |
| `reconciliation` | daily | Reconciles each company's books (card processor, bank, invoices, wallet, published days, prepaid bottles, route pieces) and alerts on anything that fails or needs a look; the last result per company is in `GET /health/deep`. | Yes: it only reads and reports. |
| `chain-check` | daily | Checks the books against the chain; pauses on a mismatch. | Yes. |
| `fingerprints` | hourly | Publishes each finished day's books fingerprint. | Yes: a day is published once. |
| `memory` | 1 min | Alerts when memory is filling. Runs while paused. | Yes. |
| `spool` | 1 min | Alerts when changes keep piling up while the database refuses them (1,000 / 20,000 waiting, or a 50 / 500 MB spool file), and when they've all been saved. Runs while paused. | Yes: it only watches. |
| `data-purge` | daily | Deletes data older than each company keeps. | Yes. |
| `capacity` | 10 min | Alerts when the database or the spool's disk is filling. Runs while paused. | Yes. |
| `backup` | daily | Our own encrypted copy of the database (when `BACKUP_KEY` and a backup bucket are set). Runs while paused. | Yes: each copy is new. |
| `restore-check` | weekly | Restores the latest backup into `RESTORE_TEST_URL` and checks its books. | Yes: only ever wipes the spare. |

Each job (except the minute-by-minute watches) remembers when it last ran and whether it worked. After a restart, one that worked waits out its interval;
one that failed or was interrupted is tried again soon (after 1 minute, then 2, 4, 8… up to its interval). A job
never runs twice at once: one past its time limit is reported as stuck and still counts as running until it ends.
Failures alert, and so does recovery. Run one now with `POST /v1/platform/jobs/<name>/run`.
Jobs that belong to an area switched off with `FW_FEATURES` (`chain-check`: token, `videos`: video generation, `offers`:
offers, `game-photos`: games) aren't scheduled at all; with the agents' fund off, `books-and-agents` skips the share-out.
Jobs that run company by company also skip a company that switched the job's feature off on its Features page
(`src/runtime/registry.ts`: `deliveries-overdue` with Home delivery, `credit` and `ad-fees` with Advertiser invoices and cards);
the locked ones (`data-purge`, `drop-photos`, `ad-payments`, `route-buys`, the books) run for every company.

## Backups by hand

```
npm run backup                 # make one now
npm run backup -- restore      # restore the latest into RESTORE_TEST_URL and check its books
npm run books:check            # check the books of the database in DATABASE_URL (refuses while a server runs on it)
```

The restore only ever wipes a spare: it refuses the database in `DATABASE_URL`, any database a server is running
on, and any that holds companies without the mark a previous restore left. (A server removes that mark from its
own database at start, so a restored database that's made the live one never looks like a spare again.)

To recover the real database from our own copy (only if the host's own backups can't be used): restore into a new
empty database with `RESTORE_TEST_URL` pointing at it, run `books:check` against it, then point `DATABASE_URL` at it
and restart.

## Moving files out of the database

Set `FILE_STORAGE=s3` and its settings, then `npm run files:move`. Each file is stored, read back and checked before
its copy in the database is cleared; stopping halfway is safe. Then restart with the same settings.

## Deploying a new version

The checks on GitHub (types, every test, known security holes, and the image started against a real Postgres, a
second copy refused, a backup restored, the previous release's database migrated, and outages ridden out: the
database away for a few seconds and for longer, a server killed, a server frozen) must pass. Then start the new image
and stop the old one (`docker stop -t 50` gives it time to finish requests, save everything and let go). The new one
starts within about a second.

**Rolling back** is starting the previous image the same way. Database changes only ever add tables and columns, so
the previous version runs on the newer database; it says so in an alert ("an older version is running on a newer
database"). Never restore the database to roll back code: that loses everything since the backup. Fix forward.

A new migration that changes the database's own rules (triggers, checks, unique indexes) is also run on a real
Postgres 16 over data the old version wrote: fill a database with `test/db-seed-postgres.ts` on the old code, then run
`test/db-postgres.test.ts` on the new, and the `test/db-*.test.ts` files with `FW_TEST_PG_ADMIN_URL` set (the steps
are at the top of `test/db-seed-postgres.ts`). The journals refuse edits and deletes from the app's own database
user too; fixing a past entry is always a correcting entry. Indexes are built inside the migration, which holds up
writes while it runs (about 7 seconds per million rows).

### Two database users: one owns the tables, the app only uses them

The journals' rules (append-only ledger and events, the wallet journal, settings history, and the other triggers) are
enforced by triggers. Postgres lets the **owner** of a table drop or disable its triggers, so if the server connects
as the user that owns the tables, anyone who takes over the server can switch those rules off. In production, keep
the two apart:

- **`fw_owner`** owns the database and every table. It runs the migrations, and is used for nothing else (not by the
  server, not by people day to day). Keep its password in your secrets manager, not in the server's settings.
- **`fw_app`** is what `DATABASE_URL` uses. It can read and write rows, but owns no table, so it can't drop, disable or
  replace a trigger (`must be owner of table`), nor alter or drop a table.

Set it up once, as the managed database's admin user (`psql "$ADMIN_URL"`):

```sql
create role fw_owner login password '…';
create role fw_app login password '…';
create database freewater owner fw_owner;
\c freewater
revoke create on schema public from public;
grant usage, create on schema public to fw_owner;
-- The server runs `create table if not exists` for schema_migrations and instance_lease when it starts. Those
-- already exist (see below), but Postgres checks the right to create before it checks they exist. CREATE here lets
-- fw_app make new tables of its own; it never gives it any power over fw_owner's tables or their triggers.
grant usage, create on schema public to fw_app;
alter default privileges for role fw_owner in schema public grant select, insert, update, delete on tables to fw_app;
alter default privileges for role fw_owner in schema public grant usage, select on sequences to fw_app;
```

Then, **before each deploy** (and before the very first start), run the migrations as `fw_owner` from the new image,
and only then start the server as `fw_app`:

```sh
docker run --rm -e OWNER_URL="postgres://fw_owner:…@host:5432/freewater?sslmode=require" <new image> \
  node --import tsx --input-type=module -e "const {createPostgresClient}=await import('./src/db/postgres.ts');const {migrate}=await import('./src/db/migrations.ts');const db=createPostgresClient(process.env.OWNER_URL);console.log('migrated:',await migrate(db));await db.query('create table if not exists instance_lease (name text primary key, holder text not null, expires_at timestamptz not null, started_at timestamptz not null default now())');await db.close()"
# then, the first time and after any migration that adds tables made before the default privileges above:
psql "$OWNER_URL" -c "grant select, insert, update, delete on all tables in schema public to fw_app" \
                  -c "grant usage, select on all sequences in schema public to fw_app"
```

Migrations only ever add, so running them while the old version still serves is safe (the same rule as rolling back).
When the server starts as `fw_app` it finds nothing left to migrate and carries on; if a migration was missed it stops
with a permission error rather than half-applying it, so run the step above and start it again. Backups and restores
by hand (`npm run backup`, below) are run with `DATABASE_URL` set to the owner's address, since only the owner can
dump and recreate the triggers.
`fw.test_reset`, which lets a test-stage reset delete journal rows, still works as `fw_app`: the triggers allow it only
inside that reset's own transaction and only while the company is still testing.

## Load test

Against a test server only (it prints test bottles):

```
BASE_URL=https://staging.example MACHINE_KEY=fwk_… npm run load -- --seconds 120 --people 100
```

## The next stage (when memory or one server stops being enough)

The status page shows bottles and ledger lines in memory. Before memory runs short, or before more than one server
is needed, the working state moves from memory into the database (bottles, ledger, event keys read on demand), so
servers become interchangeable behind the load balancer. That is a planned change, not an emergency: the memory
alert gives weeks of notice at pilot volumes.


## The ad studio's outside services

Without keys, each uses a stand-in that says it's a stand-in, so everything can be tried end to end.

| Setting | What it turns on |
| --- | --- |
| `UNSPLASH_ACCESS_KEY` | The Unsplash photo library (credited to photographers, as their rules ask). |
| `PEXELS_API_KEY` | The Pexels photo library. |
| `GEMINI_API_KEY` | Google Imagen for photos made to order, with the same key as Veo (`IMAGEN_MODEL` picks the model; Google renames them). |
| `ANTHROPIC_API_KEY` | Claude as the art director, writing and choosing the designs (otherwise built-in rules). |

Photos are kept once, shrunk to print size, and stripped of hidden data. Labels point at them; a label sent to a
printer or machine carries its photos inside it, so it prints whole even offline.

## Print files

What a printer or machine gets (and `GET /v1/units/:id/label.svg`) follows the printer's design guide: the label with
its bleed (8.125 × 4.125 in for the standard 8 × 4 in bottle; backgrounds run into the bleed), every picture inside the
file, every word converted to outlines so no printer can swap a font, QR codes as vector squares, and each part its own
element. The outlines come from fonts that ship in the code (`src/modules/print/fonts/files`); nothing has to be
installed for them. Emoji and Chinese, Japanese or Korean letters in an ad, which those fonts don't have, are drawn as
pictures at 600 dpi with the fonts of the machine making the file: the container image has none, so add a font package
(for example `fonts-noto-color-emoji`, `fonts-noto-cjk`) to the image if ads use them, or they print blank (never a
wrong letter). To change the fonts, run `python3 -I scripts/fonts/build-fonts.py <font folder>` (needs fontTools) and
commit the result.
