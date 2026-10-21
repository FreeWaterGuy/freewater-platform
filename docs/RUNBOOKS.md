# Runbooks: what to do when something goes wrong

Plain steps for each problem, for the founder and for whoever hosts FreeWater. `docs/RUNNING.md` explains the
settings; this file is what to do at 3 a.m.

**Two roles below.** *You* means anyone on the team with the alerts channel and the console. *The host* means the
person or company with access to the hosting account (where the server runs and its settings live) and to the database
plan. Some steps need the host; they say so.

## Before anything goes wrong (do this once)

1. **Alerts reach a person.** Set `ALERT_WEBHOOK_URL` to a chat channel someone reads (and `ALERT_EMAIL` once email
   is connected). Turn on phone notifications for that channel. Without it, alerts only go to the server's log.
2. **Restart on failure is on** (`docker run --restart unless-stopped`, or the host's "restart on failure"). The
   server stops itself on purpose when it can't be sure it alone owns the data; the restart brings it back.
3. **Keep these somewhere safe, away from the server** (a password manager both founders can open): the platform key
   printed by `npm run setup`, `BACKUP_KEY`, the hosting account login, the database plan login.
4. **Backups are on**: `BACKUP_KEY`, `BACKUP_S3_BUCKET` and `RESTORE_TEST_URL` are set, and the backup bucket keeps
   copies 30 days and refuses early deletes (object lock). The database plan's own daily backups and
   point-in-time recovery are on too. Without our backups an alert ("Our own backups are off") goes out at each start.
5. **`DATABASE_MAX_GB`** is the database plan's size, so an alert comes before it fills.
6. **`TRUST_PROXY`** is the number of proxies in front of the server (usually `1`), or their addresses. Never `true`.
7. **Someone outside watches the site** (an uptime checker), because a server that is down can't send its own alert.
   See "Set up uptime checks and error tracking" below: about 15 minutes, free.
8. **Errors are tracked** (`SENTRY_DSN`), so an error that happens a hundred times shows as one issue with its count
   and stack, not a hundred lines in the log. Same section.

## Set up uptime checks and error tracking (free, once)

### Uptime checker: UptimeRobot (free plan) or Better Stack (free plan)

Either one; both are free for this. Replace `<site>` with the address in `PUBLIC_URL` (e.g. `freewater.io`).

**UptimeRobot** (uptimerobot.com → sign up → *Add New Monitor*):

| Monitor | Type | URL | Interval | Alert when |
|---|---|---|---|---|
| FreeWater up | HTTP(s) | `https://<site>/health/uptime` | 5 min (the free plan's shortest) | not 2xx (UptimeRobot's default: down = any 4xx/5xx or no answer within 30 s) |
| FreeWater site | Keyword | `https://<site>/health/ready`, keyword `"ok":true`, alert when the keyword **does not exist** | 5 min | the keyword is missing (this one also catches "changes paused" and failing jobs, which still answer 200) |

Then *My Settings → Alert Contacts*: add both founders' emails and the phone app (push), and, if the alerts channel
is Slack or Discord, its webhook as an alert contact too. On each monitor, tick those contacts and set
"notify after **2** failures" (so one slow answer during a deploy doesn't wake anyone). Optionally a public status
page (*Status Pages → New*) with the first monitor only.

**Better Stack** (betterstack.com → Uptime → *Create monitor*), if you prefer it (3-minute checks on the free plan):

- Monitor 1: *Alert us when* "URL becomes unavailable", URL `https://<site>/health/uptime`, check every 3 minutes,
  *Confirmation period* 2 minutes, *Recovery period* 3 minutes, regions: at least two.
- Monitor 2: *Alert us when* "URL doesn't contain keyword", URL `https://<site>/health/ready`, keyword `"ok":true`,
  every 3 minutes, confirmation period 5 minutes.
- *On-call / escalation*: email and push to both founders; add the Slack or Discord integration for the channel.

Don't point an uptime checker at `/health/deep` or `/v1/platform/status`: they need the platform key, which must
never sit in a third party's settings. Don't use `/health/live` for it either: that only says the process is running.

What each answer means: `/health/uptime` 503 with `database not answering` → see "The database is down"; `doesn't own
the data` or `can't confirm it owns the data` → see "This server stopped…" (it usually comes back by itself within
two minutes, which is why the checker waits for two failures). No answer at all → the host's dashboard: is the
container running? Restart it.

### Error tracking: Sentry (free "Developer" plan: one person, 5,000 errors a month)

1. sentry.io → sign up → *Create project* → platform **Node.js** → name it `freewater` → skip the SDK instructions
   (FreeWater sends to Sentry directly; nothing to install).
2. *Settings → Projects → freewater → Client Keys (DSN)*: copy the DSN (`https://<key>@o….ingest.sentry.io/<number>`).
3. The host puts it in the server's settings as `SENTRY_DSN=<that DSN>` (and `SENTRY_ENVIRONMENT=production`, or
   `staging` on the staging copy) and restarts. The start log says "Error tracking: on".
4. *Settings → Projects → freewater → Security & Privacy*: turn on **Data Scrubber** and **Use Default Scrubbers**,
   and turn on **Prevent Storing of IP Addresses**. FreeWater already sends nothing personal; this is a second net.
5. *Settings → Projects → freewater → Inbound Filters*: nothing to change.
6. *Alerts → Create Alert → Issues*, three rules, each sending to email (and to the Slack/Discord integration if
   connected):
   - **"New problem"**: *When* "A new issue is created", *If* (none), *Then* notify. Action interval: 30 minutes.
   - **"Critical alert"**: *When* "A new issue is created" **or** "The issue changes state from resolved to
     unresolved", *If* "The event's level is equal to **fatal**", *Then* notify. (Every critical FreeWater alert —
     books not reconciling, the chain paused, the lease lost, the spool growing, a job failing three times in a row,
     the database or disk at 85% — and every crash arrives as level fatal.)
   - **"Error storm"**: *When* "The issue is seen more than **50** times in **1 hour**", *Then* notify. Action
     interval: 1 hour.
7. *Settings → Subscription → Spend*: keep the on-demand budget at **$0**, so a bad day can't cost money; the server
   already sends at most 20 events a minute and the same error at most once a minute.

How to read an issue: the title is the error; *Tags* show `job` (which background job), `companyId` (only the
company, never a person), `source` (`http`, `job`, `alert`, `unhandledRejection`, `uncaughtException`) and `status`;
*Request* shows only the method and the route's pattern (`POST /v1/orders`), never the address as typed, the body,
headers or cookies. *Release* is the deployed version, so "first seen in release X" says which deploy brought it.
Resolve an issue once the fix is deployed; if it comes back, Sentry reopens it and the "Critical alert" rule fires again.

## How to see what's wrong

- **The alerts channel** says what happened and usually what to do. Red is urgent, orange is a warning, green means
  it fixed itself.
- **`https://<your site>/health/ready`** in a browser: `"ok": true` means all is well; otherwise `problems` lists
  what's wrong in plain words.
- **`GET /v1/platform/status`** with the platform key (the host can run
  `curl -H "Authorization: Bearer <platform key>" https://<your site>/v1/platform/status`): background jobs, saving,
  which server owns the data, memory, the last 50 alerts.
- **`GET /health/deep`** with the platform key: each job's last success and whether it's fresh, changes and webhooks
  waiting, the spool file's size, the last books reconciliation per company and the last books (restore) check.
- **Sentry** (if `SENTRY_DSN` is set): every error grouped, with how often, since which release, and its stack.
- **The server's log**, in the hosting dashboard.

---

## Deploy a new version

1. Make sure the checks on GitHub for that version are all green. Never deploy a red one.
2. The host starts the new version (same settings, same spool volume) and then stops the old one with
   `docker stop -t 50` (or the platform's normal deploy). The new one waits for the old one to let go, then starts in
   about a second.
3. Open `/health/ready`: it should say `"ok": true` within a minute. Watch the alerts channel for ten minutes.
4. If it doesn't become ready, or errors appear: **roll back** (next section).

## Roll back

1. The host starts the previous version's image the same way, then stops the new one.
2. An orange alert says "An older version is running on a newer database". That's expected: database changes only
   ever add, so the older version works.
3. **Never restore the database to undo a bad version**: that throws away every scan, order and payment since the
   backup. Fix the problem in code and deploy forward.

## "The server crashed and is restarting" / "This server stopped: it could no longer be sure it was the only one"

What it means: the server stopped itself rather than risk two servers changing the money at once, or an error it
didn't expect. Nothing that was saved is lost; changes waiting to be saved are in the spool file and the next start
writes them first.

1. Wait two minutes. With restart-on-failure, it comes back by itself (a new server waits up to 30 seconds for the
   old one's claim to lapse).
2. Check `/health/ready`. If ready: done. Look at the log around the alert time to see why, and tell a developer.
3. If it keeps restarting: the host reads the last lines of the log. Usual causes: the database is down (see next
   section), a setting is wrong (the log says which, in plain words), or the spool can't be applied (see "The server
   won't start because of the spool").

## The database is down or "refusing changes" (the platform is paused)

What you see: a red alert "The database is refusing changes; the platform has paused them"; `/health/ready` says
"database not answering" or "changes are paused". Scan pages, the books and QR codes still work; new orders and
settings get "paused, try again shortly". Nothing is lost: every change waits in order, in memory and in the spool file.

1. **Under about 18 seconds** (a database restart or failover): nothing to do. A green alert says everything was saved.
2. **Longer**: the server stops itself (red alert "could no longer be sure…") and restarts; once the database is back
   the new server writes the waiting changes first, then serves. The host checks the database plan's status page and
   the provider's status page.
3. If the database is up but one change keeps being refused (the alert keeps repeating the same error, and
   `/v1/platform/status` → `saving` shows the same change stuck): this is a bug. **A person decides** to move that one
   change aside: `POST /v1/platform/persistence/skip-stuck` with the platform key. It is kept word for word in the
   `persistence_failures` table. Then a developer fixes the bug, puts the change back by hand, and the host restarts
   the server.

## "Changes waiting for the database keep piling up"

What it means: the database has been refusing changes for a while and the waiting ones are growing (orange at 1,000
or a 50 MB spool file, red at 20,000 or 500 MB). They are safe in memory and in the spool, and go in by themselves
when the database is back; but memory and the server's disk are what run out next.

1. Follow "The database is down or refusing changes" above. That is the cause; this alert only says how far it got.
2. Red: the host checks the server's disk has room (`/health/deep` → `spool.bytes`) and gives the volume more if
   it's close. Don't restart the server unless the database is back: the spool is written first on the next start,
   but a restart while it's down only adds a wait.
3. A green alert, "The waiting changes have all been saved", ends it.

## The server won't start because of the spool

The log says the spool (changes waiting from a previous server) can't be applied, and why.

1. Fix the cause it names (usually: the database isn't reachable yet; wait and restart).
2. If it can't be fixed quickly, **a person decides** to start once with `FW_SPOOL_SKIP=1`: the spool is set aside
   as `waiting-changes.jsonl.skipped-<time>` in the spool folder, unapplied, and the server starts. Remove the setting
   right after. A developer then applies those changes by hand.
3. A file named `….stale-<time>` means another server had written since; it's kept for a developer to look at. The
   server started normally.

## The disk is filling up

**"The database is 70% / 85% full"**:

1. If files are still stored in the database (`FILE_STORAGE` unset): the host sets up file storage
   (`FILE_STORAGE=s3` and its settings, `docs/RUNNING.md`), restarts, then runs `npm run files:move`. This is usually
   most of the size.
2. Otherwise, or as well: the host moves the database to a bigger plan (most providers do this without downtime) and
   raises `DATABASE_MAX_GB` to match.
3. At 100% the database refuses changes and the platform pauses (see above): nothing is lost, but nothing new is
   taken until it has room.

**"The server's disk is X% full"** (the volume holding the spool): the host gives the volume more room. If it fills
during a database outage, waiting changes are only in memory, and a crash then would lose them.

## "Public uploads have reached today's ceiling and are paused"

What it means: visitors without an account (game feedback pictures and videos, offer receipts) uploaded more today
than `PUBLIC_UPLOAD_MB_PER_DAY`. Their uploads are refused until midnight UTC; everything else works.

1. Look at the console's security log for `upload_capped` entries: many from the same networks means someone is
   trying to fill the database. Do nothing more: the ceiling is doing its job.
2. If it's real use (a campaign took off), the host raises `PUBLIC_UPLOAD_MB_PER_DAY` and restarts. Better still, move
   files out of the database (above).
3. If one network hits its own ceiling (people see "too much uploaded from your network today"), that's
   `PUBLIC_UPLOAD_MB_PER_NETWORK`; raise it only for real use.

## "Memory is 70% / 85% full"

The server keeps its working state in memory (about 13 KB per bottle printed).

1. The host gives the server more memory and raises `NODE_OPTIONS=--max-old-space-size=…` to about ¾ of it, then
   deploys (start new, stop old).
2. At 85%, do it today. Tell a developer: the planned next stage moves the working state into the database.

## "Background job … failed"

Each job is tried again soon (after 1 minute, then 2, 4, 8… up to its usual interval). A green alert says when it's
working again. Three failures in a row turn the alert red, and `/health/ready` lists the job.

1. Read the error in the alert. If it names a company ("failed for company peak-spring"), only that company is
   affected; the others carried on.
2. Run it again now, once the cause is fixed: `POST /v1/platform/jobs/<name>/run` with the platform key. Every job is
   safe to run again (`docs/RUNNING.md` lists them).
3. By job:
   - `backup` or `restore-check`: see "A backup or the restore check failed".
   - `books-and-agents`, `fingerprints`, `wallet-seals`, `chain-check`: these wait while the platform is paused, and
     re-run safely. If `chain-check` paused the chain on a mismatch, that's on purpose: a person looks before
     unpausing.
   - `webhooks`: usually a company's own server not answering; the delivery is retried and shown in its webhook list.
   - `capacity`, `memory`: they only watch; the error says what they couldn't read.
4. "still running after N s" means stuck: it is never started twice. If it doesn't finish within its next interval,
   the host restarts the server (start new, stop old); it's tried again soon after.

## An outside provider is down

Check the provider's status page first.

- **Card payments, payouts, email/text**: today these are stand-ins (`ALLOW_STANDINS=1`). Once real ones are wired,
  payments and payouts are retried with the same request id, so nothing is charged or paid twice.
- **AI (Anthropic, Google)**: every AI use has a built-in fallback; pages keep working, just plainer.
- **File storage (S3/R2)**: uploads and pictures fail while it's down; scans, orders and the books carry on. Nothing to
  do but wait; if it's long, the host checks the keys haven't expired.
- **Solana**: seals and the daily chain check fail and retry; the chain pauses itself on any mismatch.
- **The alerts channel itself**: alerts still go to the server's log. If the channel's webhook was deleted, make a new
  one and update `ALERT_WEBHOOK_URL`.

## A server froze, or two servers are running

Only one server may own the data. A frozen server (the host's machine stalled) refuses every change the moment it
wakes, and stops itself once it finds another server took over. A second server started by mistake waits up to two
minutes and then gives up with "still owns the data". Nothing to do but make sure exactly one is meant to run.

## Rate limits are hitting everyone, or no one

- **Everyone gets "too many requests"**, or the security log shows every visitor with the same address: the server
  sees the load balancer's address, not the visitor's. The host checks `TRUST_PROXY` matches the number of proxies in
  front (`2` if a CDN like Cloudflare sits in front of the load balancer).
- **Never "fix" it with `TRUST_PROXY=true`**: then anyone can pretend to be any address and every limit is off. The
  server refuses to start with it.

## "Machine … hit its print limit"

A machine asked to print faster than it physically can. Either the machine is unusually busy, or its key was stolen.

1. Check the machine's status in the console (`/ops`). If the machine isn't that busy, **revoke its key** in the
   console (Keys) and give the machine a new one.
2. Only a person signed in can change the print limits (console settings, machines), and only to sane whole numbers.

## A backup or the restore check failed

1. Read the error. Common causes: the backup bucket's keys expired or changed; `BACKUP_KEY` changed (old copies then
   can't be read: put the old key back, or keep it alongside); `RESTORE_TEST_URL` points at a database that isn't an
   empty spare (it refuses on purpose).
2. Fix, then run it now: `POST /v1/platform/jobs/backup/run` (or `restore-check`).
3. Until it works, the database plan's own backups are the copy. Don't let it go more than two days.

## Restore the database from a backup

Only when data is really lost (the database was deleted or damaged). Restoring loses everything since the backup.
**A person decides, and tells the team before starting.**

1. **First choice: the database plan's own point-in-time recovery.** The host restores to a new database at a time
   just before the problem, using the provider's dashboard.
2. **Second choice: our own encrypted copy**: the host creates a new, empty database, points `RESTORE_TEST_URL` at it
   and runs `npm run backup -- restore`, then `DATABASE_URL=<that database> npm run books:check`. Both must say all is
   well.
3. Stop the running server. Point `DATABASE_URL` at the restored database and start the server. It removes the
   restore's "spare" mark by itself.
   - Changes the old server still had waiting (the spool) belong to the lost database, not the restored one. After our
     own restore (step 2) the server sets them aside by itself (red alert "Changes waiting from before the restore
     were set aside"; the file is `waiting-changes.jsonl.restored-<time>`). **After the provider's restore (step 1),
     start this once with `FW_SPOOL_SKIP=1`**, then remove that setting. Either way a developer looks at the file.
4. Check `/health/ready`, the console's books and a few recent orders. Expect anything after the backup's time to be
   missing: scans, orders, sign-ups. Tell advertisers and charities if money records from that window are affected,
   and record any corrections as new entries (never edits).
5. Set `RESTORE_TEST_URL` back to the spare.

## A key or secret may have leaked

1. A company key: revoke it in the console (Keys) at once, then make a new one. Look at the security log for what it
   did.
2. The platform key: the host makes a new one with `npm run key -- freewater "Platform key" platform,admin` (against
   the production `DATABASE_URL`), stores it in the password manager, then revokes the old one in the console.
3. A provider key or `BACKUP_KEY`: the host makes a new one at the provider and updates the server's settings, then
   restarts. For `BACKUP_KEY`, keep the old one too: older backups need it.
