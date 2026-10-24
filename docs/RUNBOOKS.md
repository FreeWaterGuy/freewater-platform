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
   (`FILE_STORAGE=s3` and its settings, `docs/RUNNING.md`), restarts, then runs `npm run files:move` (pictures, team
   files and door photos). This is usually most of the size.
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

**What grows, and the plan to prune it** (second review, 2026-10-22; not built yet: a bigger change than a night's
fixes should risk). Every bottle printed (`platform.units`) and every pack (`packs.packs`) is loaded at start and kept
for the life of the server. At a pilot of 1,000 houses × 24 bottles a week that is about 1.2 million bottles a year
(about 15 GB of memory a year at 13 KB each): fine for the first months, not for a year.

- Done now: the hot paths no longer go through all of them. Printing a bottle for a person counts their bottles today
  from a small index of each person's last two days (`Platform.withToday`), as do the free bottles a day a signed-in
  person has left (`recentUnitsOf`); a scan at a door finds its stop's box by an index (`PackService.forStop`); and a
  claim of a house needs the whole box code, looked up by its code, never by going through every pack.
- The plan: keep in memory only what is still live (bottles and packs from the last 90 days, and any not yet
  delivered, scanned out or settled), load an older one from the database when it's asked for (a scan of an old
  bottle, a receipt, a statement), and move the reports that read every bottle (books by month, transparency counters,
  profit, the agents' figures, the daily route-buy checks) to SQL over `units` and `packs`. In this order: (1) reports
  to SQL, each checked against the in-memory figure for a week; (2) a `loadUnit`/`loadPack` fallback on every lookup
  by id; (3) prune what's older than 90 days at start and nightly. Until then: watch memory (above) and give the
  server more.

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
   - `ad-fees`, `ad-payments`, `route-buys`: usually the card processor not answering. Nothing is charged or paid
     back twice (each uses the same request id every try); invoices stay open and are charged on the next try. If it
     lasts all day, check the processor's status page.
   - `drop-photos`: door photos past their keep couldn't be deleted from file storage. See "Photos of drops".
   - `deliveries-overdue`: it only alerts; the error is usually the database. The deliveries themselves are fine.
4. "still running after N s" means stuck: it is never started twice. If it doesn't finish within its next interval,
   the host restarts the server (start new, stop old); it's tried again soon after.

## An outside provider is down

Check the provider's status page first.

- **Card payments, payouts, email/text**: today these are stand-ins (`ALLOW_STANDINS=1`). Once real ones are wired,
  payments and payouts are retried with the same request id, so nothing is charged or paid twice.
- **AI (Anthropic, Google)**: every AI use has a built-in fallback; pages keep working, just plainer.
- **File storage (S3/R2)**: uploads and pictures fail while it's down; scans, orders and the books carry on. Nothing to
  do but wait; if it's long, the host checks the keys haven't expired. **On a delivery day** drivers' door photos fail
  too, and with *Photo proof of each drop* on no drop can be completed: an owner turns that switch off for the day
  (Console → *Features* → *Delivery*), drivers close and reopen the driver app and scan as usual, and it goes back on once storage is back.
- **The card processor**, when an advertiser pays: they see "Something went wrong"; nothing is charged twice. Pressing
  pay again in a few minutes finishes the same order (the same request id). An order the processor never answered is
  let go within the hour by the `ad-payments` job; nothing prints for an unpaid order.
- **The AI reviewer of paid ads**: every ad simply goes to a person under *Ad review*, as before; talking with the AI
  about an ad answers with the stand-in. Its record and the final-call switch are untouched.
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

## A pilot day, step by step

The whole day for the house-after-house pilot, in order. Each step links to its own section below if something goes
wrong. *Ops* is whoever runs the micro-factory that day; they need an ops or owner login (an API key can't plan).

**Once, before the first pilot night (the host):**

1. **Photos go to file storage, not the database**: `FILE_STORAGE=s3` and its settings (`docs/RUNNING.md`). A door
   photo is kept at about 0.2 to 0.5 MB, so 1,000 drops a week add about 1.5 GB a month, and with the 90-day keep
   about 4 to 5 GB are stored at any time. In the database that would be most of its size and of every backup. If
   photos are already in the database: set it up, restart, then `npm run files:move` (it moves door photos too).
2. **Enough memory for the weeks ahead**: the server keeps every bottle in memory (about 13 KB each). 1,000 houses
   with one 24-pack each is 24,000 bottles, about **310 MB more every week**. A server with 8 GB
   (`NODE_OPTIONS=--max-old-space-size=6144`) lasts about 20 weeks; 2 GB lasts about 4. The memory alert warns at 70%.
   Plan the next stage (`docs/RUNNING.md`, the end) before then.
3. Console → *Features* → *Delivery*: *Home delivery*, *Delivery areas*, *The driver app*, *Photo at the door* and
   *Photo proof of each drop* are on. Each area is checked and on (see step 4 of "Plan tonight's deliveries").

**The afternoon before (ops):**

1. Open `https://<site>/health/ready`: it says `"ok": true`. If not, fix what it lists first (the sections below).
2. Check the alerts channel for anything red from the day.
3. The printers have labels, boxes and ink for the night (one label per bottle; one box per house per 24-pack).

**Plan and print the night (ops):** follow "Plan tonight's deliveries" below. For a big night this takes a while:
every bottle is laid out with its own ads and codes and sent to the printer. Measured on a small, busy test machine
against Postgres it was about 0.1 to 0.2 seconds a bottle, so **1,000 houses (24,000 bottles) can take 40 to 80
minutes** on the server alone (likely less on a dedicated one; time your first night). Start early.
- The button may stop with "Something went wrong" after a minute or two. That is the browser (or the host's load
  balancer) giving up waiting, **not** the planning: it carries on. Wait ten minutes, reload the night's runs, and
  watch the vans' runs appear and move from *printing* to *packing*.
- Pressing *Plan and print this night* again is always safe: a second press waits for the first and prints nothing
  twice. That is also how to finish a run left *printing* (a jam, a restart).

**Pack and check (packing line):** every box is scanned by the packing line; the packing check seals the ones it
passed (*Routes* → the run → *Packing check*). A bottle it can't read: see "A bottle's label came out wrong". A run
goes from *packing* to *ready* when every box is sealed.

**Put the sticker on the box (plain boxes):** with ads on boxes off, each pack's bottles come off the printer with one
small **box-code sticker** (2 × 2 in unless set): a QR code, "Box code: …" and the stop code (`R3 · 14`) with the box
number. Before the box is sealed, stick it where the routes page says, under the box number ("Put the box-code
sticker on the front, top-right corner"; the packing line's check says the same). Check its stop code and box
number match the box. Without it the driver can't scan the box at the door (they can type the box number instead) and
the household can't say the house is theirs from the box.
- A sticker lost, torn or smudged: print it again from `GET /v1/packs/<pack>/sticker.svg` (any printer, at its real
  size), or type the box number in the driver app.
- A sticker that didn't print (the printer jammed twice): the pack stays in *printing* with its bottles done. Fix the
  printer and press *Plan and print this night* again: it prints only the sticker, once.
- With ads on boxes on, the code is on the box's printed info strip: there is no sticker to put on.

**Load the vans (each driver):** sign in on the phone at `https://<site>/driver`, take the van's run, and scan the
boxes into the van in the order the app asks (last stop first, so the first stop comes out on top). The run is *out*
once every box is in.

**The drive (each driver):** at each house, the app shows which box. Leave it, take a photo of it where it was left,
scan the box, *Done · next house*. Problems: *Problem at this stop* (the box comes back) or, in an area, *Skip this
house* with a real reason. A charged phone and a car charger matter: the photo and the scan need the phone.

**End of the day (ops):**

1. Every van's run says *done* (*Routes*). A run with stops still *planned*: ask the driver to finish them (*Done*, or
   *Problem at this stop*: the box comes back). Boxes that came back are put away. A run that can't be finished today
   (the van broke down) is closed now: *Routes* → *Close the run…*, with a reason. Its stops not done are marked not
   delivered, the driver's app can't scan another, and the boxes come back like any box a driver couldn't leave
   (subscribers are told). A run left over from an earlier day: *Routes* → pick that day → *Close out…*, with a reason.
   After its last stop a run closes itself; each drop's time shows under *When*.
2. Stops showing "Scanned at the door, no photo yet": see "A drop shows … no photo yet".
3. *Areas* → "driver skips to review": decide each (see "A driver skipped a house").
4. The alerts channel: nothing red left. `/health/ready` says `"ok": true`.
5. Route refunds waiting (`GET /v1/ops/route-refunds`): an owner or finance person approves them (see below).

**When something fails during the day:**

| What happened | What it means | What to do |
|---|---|---|
| The server restarted while planning | Runs already made are kept; boxes already printed are kept | Press *Plan and print this night* again: it finishes what's left, prints nothing twice |
| The server restarted while drivers are out | Every stop already done is saved | Drivers carry on; if a stop says it can't be done, press *Done* (or *Problem*) again: it finishes it, once |
| The database is down ("changes are paused") | Drivers' scans wait | Drivers wait a few minutes and press again; see "The database is down" |
| A printer jams mid-plan | That run stays *printing* | Fix the printer, press *Plan and print this night* again |
| Photos won't send (many drivers at once) | File storage is down, or the phones have no signal | If it's storage (the alerts channel says so, or the host's status page): an owner turns *Photo proof of each drop* off for the day (Console → *Features*), drivers close and reopen the driver app and scan without photos, and it's turned back on at the end of the day. One driver only: see "A drop shows … no photo yet" |
| A driver's phone dies | Their run is saved on the server | Another phone signs in as that driver and carries on from the next stop |
| An advertiser pays while the card processor is down | Nothing is charged twice: their order waits | They see "Something went wrong"; ask them to press pay again in a few minutes. An order never charged is let go within the hour (the `ad-payments` job), and no bottle prints without a paid order |
| The AI reviewer is down | Paid ads aren't looked at by the AI | Nothing to do: every ad goes to a person under *Ad review*, as before. Talking with the AI about an ad answers with the stand-in |
| The daily fees couldn't be charged ("Background job ad-fees failed") | The card processor didn't answer | The invoices stay open and the next try (after 1 minute, then 2, 4, 8… minutes) charges them. Nothing to do unless it fails all day: then check the processor's status page |

## Plan tonight's deliveries (a person, every delivery night)

Nothing plans the night by itself on purpose: planning prints every box and bottle, and printing bills advertisers.
Only a signed-in ops person or owner can plan (never an API key or a driver); the run records who.

1. In the ops console, the night's runs → *Plan and print this night* (or `POST /v1/ops/runs/plan` with the date) for each night routes
   drive, before printing starts. Running it twice for the same night does nothing new (a run stuck "printing"
   picks up its unprinted boxes).
2. Anyone whose delivery day went by without a plan is included on the next night their route drives, once, and
   their next date carries on from their usual day.
3. **Delivery areas** (the pilot's house-after-house streets) are planned in the same press, for every area that is
   on and whose route drives that night. Each house due gets its boxes (the area's pack size and packs per house,
   more for a household that told us its size), in street order from the micro-factory, split into one run per van
   ("Travis Heights pilot · van 1", "van 2", …). Stop numbers run on from van to van, so no two boxes that night share
   a stop code. Houses that stopped in the app, and houses a driver marked to skip, are left out; the next house still
   gets its box.
4. Before the first night of a new area: open it under *Areas*, check the dots on the map and the house list, set
   *Boxes per van* to what one van really carries, then *Turn on*.
5. Each van's run then goes as usual: packing check, the driver loads it, scans each box at each house. A house that
   stopped deliveries after the plan shows "Don't leave a box here" to the driver; its box comes back.
6. **How runs are split**: a van's run ends when the next house's boxes would pass the area's *Boxes per van*, the
   company's payload by weight (`delivery.vanPayloadKg`, 900 kg unless set; a 24-pack weighs about 12 kg, so 73 boxes),
   or the longest shift (`delivery.maxShiftHours`, 8 h) counting the driving and `delivery.minutesPerStop` (4 min) at
   each house. Each run's planned minutes are shown on it. If drivers come back early or late week after week, change
   the minutes per stop (a person signed in, `PATCH /v1/console/settings` with `{ "delivery": { "minutesPerStop": 5 } }`).
6. **No area was planned at all** (the press returns only subscribers' runs, or `feature_off`): check *Console →
   Features → Delivery* for the company. With *Delivery areas* off nothing in any area is planned, printed or alerted
   as overdue (the houses keep their place); with *Home delivery* off nothing is planned at all. Turn it back on (an
   owner signed in) and press *Plan and print this night* again: the houses due come on that night.

## "Houses in delivery areas are overdue"

A house in an area that's on had its night go by without a plan (a night nobody planned), or an area's run from an
earlier day is still "printing". The alert says which areas and which runs.

1. Plan the next night their route drives. Late houses are included automatically, once; their next date then
   carries on from that night.
2. A run stuck printing: fix the printer (or the box printer), then plan **that run's night** again (the date in
   the run's id, like `area_….1@2026-11-03`); it finishes the boxes not yet printed and prints nothing twice. If the
   night is long gone, close the run out instead (*Routes* → that night → *Close out…*, with a reason): its boxes go back.
3. If an area shouldn't be delivered any more, turn it off under *Areas*: it stops being planned or alerted at once.

## A driver skipped a house (a locked gate, a dangerous animal, no safe place, not a home)

The house is left out of every plan until a person decides. *Areas* lists them under "driver skips to review"
(`GET /v1/ops/house-reviews`). A driver can only skip for a real access or safety problem, or because it isn't a home:
signs on the door ("no soliciting") and what someone says at the door are never reasons (the founder: "we will ignore
the no soliciting signs; if they don't want any free stuff they can opt out in our app"). The app refuses any other
reason.

1. Read what the driver said. Is it still true (a gate that's locked only at night, a dog that's kept in now)?
2. *Keep skipping* or *Deliver again* (back on the next night its route drives). Who decided and why is kept with the
   house. *Keep skipping* for getting to the door (a locked gate, a dog, not safe, no safe place) lasts
   `delivery.skipWeeks` (4 weeks unless set), to the Monday after; then the house comes back on its own from the next
   night its route drives ("skip ended" in its history), and the driver tries again. *Not a home* stays until a person
   changes it. Route ads paid for that house in the skipped weeks move to its first delivery after (within the buy);
   what can't move comes back to the advertiser as credit.
3. Someone at a skipped house who wants water can claim the house in the app and press *Start deliveries again*.
4. If a driver tells you someone at the door doesn't want it: that person stops it in the app (scan the code on the
   side of the box, *Your house → Stop deliveries*). Drivers don't decide it for them.

## A drop shows "Scanned at the door, no photo yet" (photo proof)

With *Photo proof of each drop* on (FreeWater: on), a box is delivered only with the driver's photo of it where it was
left. The scan alone is remembered on the stop but not delivered.

1. Ask the driver to take the photo again in the driver app and scan the box again (a weak signal is the usual cause:
   the photo didn't send). That delivers it. A photo counts only if it was taken after the box was scanned at that
   door, with the app's camera (a photo picked from the phone's gallery is refused), and, when the phone knows where it
   is, within 150 m of the house (`delivery.photoMaxMeters`): "Your phone puts you 400 m from …" means take it at the
   door. A photo with no location (GPS off, indoors) counts but shows **unverified location** on the run: if one
   driver's drops are often unverified, ask them to turn on location for the app, and look at a few of those photos.
2. If the photo can't be taken (the phone's camera broke, the driver has left), an ops person or owner, signed in,
   opens *Routes*, presses *Delivered without photo…* on that stop and writes why (for example "camera broke; driver
   confirmed by phone it's on the porch"). It's kept on the stop with who and when. It must be someone other than the
   driver, and only a box scanned at its door and still on the van can be marked so.
3. If the box isn't there, use *Problem at this stop* in the driver app: the box comes back.
4. A box delivered with its photo and gone later (taken from the porch) is delivered: it isn't a failed delivery and
   isn't tracked as ours. If the resident asks, they can see the photo in the app (*Your house → Where we left it*).

## Photos of drops: who sees them, and how long they're kept

- They show people's homes. Only the team (*Routes → Photo*, `GET /v1/ops/drop-photos/:id`) and someone who proved in
  the app the house is theirs see them; never advertisers (their *Where it went* report is street level only). They
  are never at a public address.
- They're deleted after the company's keep (90 days unless set; 1 to 365 days, setting `delivery.photoKeepDays`,
  changed by a person signed in) by the daily `drop-photos` job, which runs for every company whatever the switches.
  A deleted photo can't be brought back (the database refuses).
- If the job fails ("Background job drop-photos failed … couldn't be deleted from file storage"): photos are being kept
  longer than promised. Their records stay, so nothing is forgotten. Fix the cause (usually file storage unreachable,
  or its key lost delete permission: see *An outside provider is down*), then run it now:
  `POST /v1/platform/jobs/drop-photos/run`. It's safe to run again. It deletes at most 5,000 per company a run,
  oldest first, so after a long outage it may take a few days' runs (or run it again by hand) to catch up.
- How much room they take: about 0.2 to 0.5 MB each. 1,000 drops a week is about 1.5 GB a month, and about 4 to 5 GB
  kept at any time with the 90-day keep. Keep them in file storage (`FILE_STORAGE=s3`), not the database.
- Someone asks for a photo to be deleted early: ask an engineer to run the job with a shorter keep for that company
  (set `delivery.photoKeepDays`, run the job, set it back). A legal hold (a dispute about a drop) means saving that one
  photo elsewhere first: ask the founder.

## A bottle's label came out wrong at the packing check

The packing line can't read a bottle (a label torn, smudged, printed off, or missing): it stops the box. Bottles don't
get lost in packing; a bad label is replaced.

1. Take the bad bottle out and press *Reprint* for it (`POST /v1/packs/:id/replace` with its id). The new bottle has
   exactly the same ads in the same places, for the same house or person.
2. The bad bottle is voided: it counts against no advertiser (its books lines are reversed, no paid bottle is used, no
   refund or credit is needed); the reprint is billed instead, once. Throw the bad bottle away (it was never handed
   out; its codes open a page but are never billed).
3. Scan the box again (or check it by hand): it can't be sealed until it's checked with the reprint in it.
4. Pressing *Reprint* twice gives one reprint (the database refuses a second live reprint of one bottle). If the
   printer fails, nothing was billed for the reprint: fix the printer and press it again.
5. If the server stopped in the middle (a deploy, a crash), the next start finishes it by itself (the log says
   "reprint(s) cut off by a restart were finished"): the bad bottle voided, the reprint billed and in the box. Then
   the daily reconciliation checks the counts (`prepaid_bottles`, `prepaid_balances`). A reprint cut off before it
   printed is let go at the next press of *Reprint*.

## Someone at a house wants deliveries to stop (or to start again)

They do it themselves in the app: *Me → Your house's deliveries*, scan the code on the side of a box we left there
(or type the whole box code printed under that code on the box's side panel; the short number in the corner isn't
enough), then *Stop deliveries*. It's left out from the next
plan on; a box already printed for that night comes back with the driver. *Start deliveries again* puts it back from
the next night its route drives. A code proves the house only from a box delivered there in the last 60 days, and a
person gets five wrong tries a day.

If they can't use the app (no smartphone, never had a box), an ops person can't stop it for them yet: the founder chose
app-only. Note the address and pass it on; see "Decisions for the founder" in the delivery section of the README.

**"A house someone already claimed was claimed by someone else"** or **"Deliveries stopped by a new claim"**: anyone
with a delivered box's code can claim a house (that's the design: no sign-up). Usually it's a new household or a
second person living there; the first claimant sees a notice in the app. If it looks wrong (the first claimant says
it isn't theirs, or a stop came from a claim a day old at a house that wants water): look at the house under *Areas*
(`GET /v1/ops/areas/:id/houses`: how many claimed it, and `stoppedByNewClaim`; its whole history is in `house_events`,
for an engineer), and ask the household to start deliveries again in the app (any claimant can).
Claims end by themselves after 12 months without use (`delivery.claimExpiryMonths`); nobody sees door photos from
before their own claim.

## "N houses were the same door as another and were merged"

At start, every house's address is read the one way (`src/core/address.ts`). Two houses that turn out to be one door
(one saved with its ZIP code, one without; "North" and "N") were merged into the older one, so the door never gets two
boxes. The stricter choice of the two holds (a stop or a skip), claims and blocks moved over, the other house shows
`merged` and is never planned, and ads reserved on it came back to their advertisers as credit. Nothing to do, unless
the two were really two doors (two apartments imported without their unit): then import them again with the unit in
the address ("20 Flats Way Apt 1", "… Apt 2"); tell a developer if many. Each house's history (`house_events`) says
which it was merged with.
A CSV line whose address the company already has more than a kilometre away is not added and is named in the import's
problems ("another town?"): check it, and add the town's houses in their own area if they're really different doors.

## A paid ad was flagged in review

An AI or an automated check (anything using an API key) can't reject a paid ad: it can only flag it. The ad shows
"Flagged · being discussed" under *Ad review*, with the reasons. Its money stays held and nothing prints.

1. Read the reasons and the ad. If the concern is wrong, *Approve and start printing* (say why in the note).
2. Otherwise, write to the advertiser in the ad's notes, in plain words: what the concern is and what would fix it.
   They see it in FreeWater Ads and can answer there, or change the ad (free while it's flagged; it comes back here).
3. Only when it truly can't run: a person signed in presses *Reject for good*, with a written reason (at least a
   sentence; it's kept and the advertiser sees it). Only then is the refund offered.
4. The refund: an owner or finance person, signed in with the second step, stops the ad (*Books*, or
   `POST /v1/ads/campaigns/:id/stop`): the unprinted bottles go back to the card, once. While the ad is flagged, stopping
   it is refused: decide first.

## "A route refund waits for approval" (buying on delivery routes)

A house that an advertiser bought on its own stopped deliveries, blocked the business, wasn't delivered that week, or
its box came back: the part not delivered goes back to the advertiser's card once a person approves it.

1. `GET /v1/ops/route-refunds` (with a team key or a signed-in session; no console page yet): the ad, the amount and why.
2. An owner or finance person, signed in with the second step, approves it (`POST /v1/ops/route-refunds/<id>/approve`).
   The refund goes to the card it was paid with, once (pressing again does nothing more).
3. If it says *failed* (the provider refused), approve again later, or refund it at the provider and record it.

Buys on more than one house get credit instead, automatically. Each advertiser's credit (got, used, expired, left) is
in the reconciliation's *route_credit* check and in their portal; it expires only if the company set
`adBilling.limits.creditExpiryDays` (none by default), and then the daily job books what expired, once. The *route_open* check lists
refunds still waiting and pieces past their week not yet given back (the daily `route-buys` job does that; to do it
now, `POST /v1/ops/route-settle`).

## "Home deliveries are overdue"

Someone's delivery day went by and they aren't on a planned, printed run (a night nobody planned, a run stuck
printing, or they signed up after their route's night was planned). The alert lists who and the route.

1. Plan the next night their route drives (above). They're included automatically; the alert stops once they're on
   a printed run.
2. If a run is stuck "printing", read its failures in the console, fix the printer, and plan that night again.
3. Tell the customers it's coming a few days late, if it is.

## "An advertiser's ads were paused: credit"

Its unpaid balance passed its credit limit, or its card was declined with no limit to cover it (docs/SWITCHES.md,
"Credit for advertisers"). Its staff have been emailed.

1. `GET /v1/advertisers/<id>/credit` shows the card, the limit and what it owes; `GET /v1/invoices` the open ones.
2. If it pays (`POST /v1/invoices/<id>/pay` after adding a card, or a transfer recorded in the books), or an owner or
   finance person raises its limit with a reason, turn its ads back on (the advertiser can, or a reviewer).
3. Don't raise a limit only to make the alert go away: that's lending the advertiser money.

## "Machine … reported bottles printed after their labels expired"

A machine said it printed offline labels after their time. Those bottles weren't billed and their codes don't work.
Labels a machine gave out before they expired are still billed when it comes back online, up to 48 hours after
(kept until then, then let go). Check the machine's clock and software version; if it keeps happening, take it out of
service and call the machine's maker.

## "Company … reached its ceiling of … video clips a day"

Live-action and animated clips cost money each. A company stops starting new ones at `FOOTAGE_PER_COMPANY_DAY`
(default 60) in any 24 hours; each ad stops at 12. Motion videos still show. If the company really is that busy, raise
the host setting and restart; if not, check which ads are making clips (`GET /v1/campaigns/<id>/videos`).

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
