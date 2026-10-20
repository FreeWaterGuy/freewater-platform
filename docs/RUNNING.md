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
| `ALLOW_STANDINS=1` | Required in production for now: real payment, payout and email/text providers aren't wired yet, so the server runs on stand-ins (no real money moves, no message is sent) and refuses to start in production unless this says it's a staging rehearsal. It logs and alerts which stand-ins are active. Remove it once the real providers are in. |
| `DATABASE_URL` | Postgres 13–17, e.g. `postgres://user:pass@host:5432/freewater?sslmode=require`. Use a managed one with automatic backups and point-in-time recovery. |
| `PUBLIC_URL` | The https address of the site. It goes on every printed QR code and in every email. |
| `TRUST_PROXY` | Which proxies' word to take for a visitor's address. The number of proxies in front of the server (`1` for one load balancer, `2` with a CDN such as Cloudflare in front of it), or their addresses or ranges (`10.0.0.0/8`), or `none` when nothing is in front. Never `true`: every visitor writes `X-Forwarded-For` too, so trusting every hop lets anyone pose as any address and walk past sign-in limits, request limits and points-per-network rules. The server refuses `true`, `*`, `all` and ranges like `0.0.0.0/0`. With a hop count, make sure the server can only be reached through the load balancer (the usual set-up on hosting platforms); if it can also be reached directly, give the load balancer's addresses instead. |
| `HOST`, `PORT` | `0.0.0.0` and `8080` in the container (already set in the image). |
| `ALERT_WEBHOOK_URL` | A chat channel's incoming webhook (Slack, Discord, Google Chat). Alerts go there. |
| `ALERT_EMAIL` | Also email alerts (once email is connected). |
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

- `GET /health/live`: the process is up. Use it for "restart it if this fails".
- `GET /health/ready`: it can do its work (database answering, owns the data, every change saved, jobs not failing).
  Use it for "send it traffic only if this passes". It returns 503 only when it really can't serve.
- `GET /v1/platform/status` (platform key): the background jobs, saving, which server owns the data, memory,
  recent alerts.
- Alerts go out for: a change that couldn't be saved, a job failing (and again when it recovers), a server error,
  memory at 70% and 85%, the database at 70% and 85% of `DATABASE_MAX_GB`, less than 2 GB (then 0.5 GB) free on the
  spool's disk, visitors' uploads at 80% of the day's ceiling and when it's reached, the server losing its claim to
  the data, a crash, our own backups being off, and an older version running on a newer database (a rollback). The
  same alert repeats at most every 30 minutes.
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
| `fleet-sweep` | 15 s | Opens an "offline" problem for Model 6 machines that stopped calling in; lets go of kept offline labels past their time. | Yes. |
| `videos` | 10 s | Checks on footage being made. | Yes. |
| `books-and-agents` | hourly | Closes any month that's due, measures agents' changes, reads every agent's standing, shares out the AI fund, security review. Company by company. | Yes: a month closes once, a day's share-out once (crash-tested). |
| `agent-exams` | daily | Any agent whose model hasn't passed the current test takes it. | Yes. |
| `game-photos` | 6 hours | Finds photos of the real products for the games' cards, a few at a time. | Yes. |
| `offers` | hourly | Closes brand-offer claims with no receipt after 14 days (points go back); pays approved ones that were held. | Yes: each claim once. |
| `wallet-seals` | 10 min | Seals each finished hour of the wallet journal. | Yes: an hour is sealed once. |
| `chain-check` | daily | Checks the books against the chain; pauses on a mismatch. | Yes. |
| `fingerprints` | hourly | Publishes each finished day's books fingerprint. | Yes: a day is published once. |
| `memory` | 1 min | Alerts when memory is filling. Runs while paused. | Yes. |
| `data-purge` | daily | Deletes data older than each company keeps. | Yes. |
| `capacity` | 10 min | Alerts when the database or the spool's disk is filling. Runs while paused. | Yes. |
| `backup` | daily | Our own encrypted copy of the database (when `BACKUP_KEY` and a backup bucket are set). Runs while paused. | Yes: each copy is new. |
| `restore-check` | weekly | Restores the latest backup into `RESTORE_TEST_URL` and checks its books. | Yes: only ever wipes the spare. |

Each job (except the minute-by-minute watches) remembers when it last ran and whether it worked. After a restart, one that worked waits out its interval;
one that failed or was interrupted is tried again soon (after 1 minute, then 2, 4, 8… up to its interval). A job
never runs twice at once: one past its time limit is reported as stuck and still counts as running until it ends.
Failures alert, and so does recovery. Run one now with `POST /v1/platform/jobs/<name>/run`.

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
