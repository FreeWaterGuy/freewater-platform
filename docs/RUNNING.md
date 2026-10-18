# Running FreeWater in production

This is the guide for whoever runs the servers. `docs/GO-LIVE.md` is the plain-language checklist of what has to
be signed up for and connected first.

## The shape of it

- **One server** runs the whole platform: the API, the scan pages, the consoles and the background jobs. It keeps its
  working state in memory and writes every change to **Postgres** before it answers.
- **Only one server may own the data at a time.** A second copy waits (up to `LEASE_WAIT_MS`, 2 minutes by default)
  and starts the moment the first lets go; only then does it change any tables. So a deploy means: start the new
  one, stop the old one. The hand-over takes about a second. A server that can't renew its claim within about 18
  seconds stops writing and answering at once, and exits.
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
| `DATABASE_URL` | Postgres 13–17, e.g. `postgres://user:pass@host:5432/freewater?sslmode=require`. Use a managed one with automatic backups and point-in-time recovery. |
| `PUBLIC_URL` | The https address of the site. It goes on every printed QR code and in every email. |
| `TRUST_PROXY` | `1` (or the load balancer's address) so rate limits see each visitor's real address. |
| `HOST`, `PORT` | `0.0.0.0` and `8080` in the container (already set in the image). |
| `ALERT_WEBHOOK_URL` | A chat channel's incoming webhook (Slack, Discord, Google Chat). Alerts go there. |
| `ALERT_EMAIL` | Also email alerts (once email is connected). |
| `FILE_STORAGE` | `database` (default), `s3`, or `disk` (single server, backed-up disk only). |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_PREFIX` | For `FILE_STORAGE=s3`. `S3_ENDPOINT` for R2, B2 or MinIO (e.g. `https://<account>.r2.cloudflarestorage.com`); leave it out for Amazon S3 and set `S3_REGION`. Give the key read, write, delete **and list** on the bucket (without list, a missing file looks like "access denied"). |
| `FW_SPOOL_DIR` | Where changes waiting for the database are also kept. Default in the image: `/var/lib/freewater/spool`. Mount a volume. |
| `DATABASE_POOL_SIZE` | Database connections (default 10). Each statement may take at most 60 seconds. |
| `BACKUP_KEY` | 32 random bytes, base64. Make with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Keep a copy away from the server; without it no backup can be read.** |
| `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION` | Where backups go: a different bucket (ideally a different account) from the files. Turn on object lock / a 30-day retention rule so they can't be deleted early. |
| `RESTORE_TEST_URL` | A spare, empty database the weekly restore check may wipe and fill. **Never the real one.** |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_PERSONALIZE_MODEL` | Claude, for the agents, ad assistant, designer, video writer and team assistant. Without it the built-in rules run. |
| `GEMINI_API_KEY`, `VEO_MODEL` | Veo, for live-action and animated footage. Optional; costs money per clip. |
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
docker run -d -p 8080:8080 --env-file .env --name freewater freewater
```

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
  memory at 70% and 85%, the server losing its claim to the data, a crash. The same alert repeats at most every
  30 minutes.

## If changes are waiting (the database refusing them)

Nothing is dropped. Changes stay queued in order and are tried again and again, waiting a little longer each time (up
to 30 seconds), until the database takes them. Nothing newer jumps ahead, so once it's back the database matches
memory exactly. While changes wait:

- a critical alert goes out, and another when everything is saved;
- the platform is **paused**: pages, scans and the books still read, and scans are still counted (queued behind the
  waiting changes); new orders, settings and sign-ups get a polite "paused, try again shortly";
- background jobs wait (no month closed and no fingerprint published from books that are behind), except the memory
  watch and backups;
- the waiting changes are also written to the spool file in `FW_SPOOL_DIR` (in the image, `/var/lib/freewater/spool`;
  **mount a volume there**). If the server stops before the database is back, the next server writes them first,
  before it reads anything.

Usually that's all: a database restart or failover fixes itself. If the database answers but one change keeps being
refused (a bug), it holds the line. Then, as a person's decision, `POST /v1/platform/persistence/skip-stuck` moves
that one change aside (kept word for word in `persistence_failures`) so the rest go in. Fix the bug, put the change
back by hand, and restart the server so its memory is reloaded from the database.

## Background jobs

| Job | How often | What it does |
|---|---|---|
| `webhooks` | 3 s | Sends webhooks to companies' systems, with retries. |
| `videos` | 10 s | Checks on footage being made. |
| `books-and-agents` | hourly | Closes any month that's due, measures agents' changes, reads every agent's standing, shares out the AI fund, security review. |
| `fingerprints` | hourly | Publishes each finished day's books fingerprint. |
| `memory` | 1 min | Alerts when memory is filling. |
| `data-purge` | daily | Deletes data older than each company keeps. |
| `backup` | daily | Our own encrypted copy of the database (when `BACKUP_KEY` and a backup bucket are set). |
| `restore-check` | weekly | Restores the latest backup into `RESTORE_TEST_URL` and checks its books. |

Each job remembers when it last ran and whether it worked. After a restart, one that worked waits out its interval;
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
on, and any that holds companies without the mark a previous restore left.

To recover the real database from our own copy (only if the host's own backups can't be used): restore into a new
empty database with `RESTORE_TEST_URL` pointing at it, run `books:check` against it, then point `DATABASE_URL` at it
and restart.

## Moving files out of the database

Set `FILE_STORAGE=s3` and its settings, then `npm run files:move`. Each file is stored, read back and checked before
its copy in the database is cleared; stopping halfway is safe. Then restart with the same settings.

## Deploying a new version

The checks on GitHub (types, every test, known security holes, and the image started against a real Postgres, a
second copy refused, a backup restored) must pass. Then start the new image and stop the old one (`docker stop -t 50`
gives it time to finish requests, save everything and let go). The new one starts within about a second.

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
