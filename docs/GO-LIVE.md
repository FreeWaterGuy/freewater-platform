# Going live: what's ready, and what's left

## Ready (built and tested)

- **Nothing is lost in a crash or a database outage.** Every change is saved before the platform answers, and
  changes made together are saved together. If the database refuses, changes wait in order (also on disk) and go in
  by themselves when it's back. Meanwhile the platform pauses new changes and background work, and scans still work.
- **No double payments.** Only one server can own the data at a time; a new version takes over in about a second.
- **Background work in one place.** It remembers what it did across restarts, and alerts when something fails.
- **File storage**, with every file checked when it's read back.
- **Health checks, a status page, and alerts** to a chat channel or email.
- **Daily encrypted backups**, and a weekly test that restores one and checks the books.
- **A deploy image and automatic checks on every change**: types, all tests, security holes, the image starting
  against a real database, a second copy refused, and a backup restored.
- **A first-run setup** for an empty database: `npm run setup -- --owner you@freewater.io`.
- **Privacy.** People can download and delete their data. Phones without an account can erase what they did.
  Contact details never go in the activity log.
- **Load-tested.** One server handled about 550 requests a second (roughly 9 million scans a day) with no errors.

## For you to sign up for (then send the keys to whoever sets the server up, never by email or chat)

1. **Hosting** for the server (any that runs a Docker image: Render, Fly.io, Railway, AWS, Google Cloud). One server
   with 4–8 GB of memory is plenty for the pilot.
2. **A managed Postgres database** (version 16 or 17) with automatic backups and point-in-time recovery, plus a
   small spare one for the weekly restore test. Most hosts above offer both.
3. **File storage**: two buckets on S3-compatible storage, one for files and one for backups. Cloudflare R2 is
   cheapest; Amazon S3 works. Turn on "object lock" or a 30-day retention rule on the backups bucket.
4. **The domain** (freewater.io): point it at the server, with https.
5. **An alert channel**: a Slack or Discord channel's incoming-webhook address.
6. **Payments**: a Stripe account (cards for custom bottles and advertisers' invoices).
7. **Payouts to charities**: Stripe Connect, or your bank's transfer service, and the charity's bank details.
8. **Email and texts** for sign-in codes and receipts: e.g. Postmark or Resend for email, Twilio for texts.
9. **Address lookup** for home delivery: Google Maps or Mapbox.
10. **AI keys**: Anthropic (Claude), and Google (one key covers Veo for live-action video and Imagen for ad photos
    made to order: `GEMINI_API_KEY`).
10b. **For the ad studio**: a free Unsplash developer key (`UNSPLASH_ACCESS_KEY`) and/or Pexels key (`PEXELS_API_KEY`)
    for the photo library; and, when chosen, a photo-to-3D service for custom AR (until then, a product photo becomes a
    standing photo card in AR). Before real labels print with library photos, confirm their terms cover printing on
    packaging (a question for the lawyer below).
11. **The label printer** for the machines, once it's chosen.
12. **A GitHub token** for publishing each day's books fingerprint (optional, but it's what makes the books provable).

## Then wired in (code, once you've chosen)

Items 6–11 each need a small connector written against the provider you pick: payments, payouts, email/text,
address lookup, the printer driver. The platform already has the slot for each one, and stand-ins for testing.
Expect roughly a day each, with tests, once the account exists.

## Also before real money flows

- **A lawyer**: terms of service, privacy policy, advertising rules, the prize game's rules, and the trust that would
  hold the AI agents' 3%.
- **Insurance** (general liability, cyber).
- **An outside security test** (a "pen test") of the live setup.
- **Real numbers** in the console: the costs per bottle (water, bottle, label, machine) are placeholders today, as
  are the AI model prices.
- **A rehearsal**: set it all up on a test copy first (a "staging" server), run the load test there, print and scan
  real bottles, restore a backup, and practice a deploy.

## Later (not needed for the pilot)

One server carries the pilot. At about 1,000 bottles a day, a server with 8 GB lasts well over a year. The memory
alert warns weeks ahead. Past that, or to run several servers at once, the next stage moves the working state out of
memory and into the database. See the end of `docs/RUNNING.md`.
