# Review patterns: the mistakes this codebase has made before

Five review rounds found about 200 defects. Almost all of them are one of the patterns below. Every reviewer checks
every pattern in their area, and for each finding, **searches the whole codebase for the same mistake elsewhere**
(siblings). A fix is not done until its siblings are found and fixed too.

| # | Pattern | What it looks like | Examples found before | How to check |
|---|---|---|---|---|
| P1 | **Status before its books entry** | A "done" status is written straight to the database while the matching ledger events are still queued; a crash in between leaves them out of step and a re-run trusts the status | charity payouts, payment capture, month close, batch void, agent settlement | Find every status write near a `bus.publish` or ledger post; the events must be durably saved first, and a re-run must repair missing events |
| P2 | **Check, then update separately** | Read a count or status, decide, then write in another step: two requests at once both pass | coupons, sign-in tries, sales per click, prize draws, daily bottle limit, double void, double approval | Every read-then-write needs one guarded statement (`update … where … returning`), a row lock, or a unique index |
| P3 | **The sibling path** | A rule is enforced on one route but not on another that reaches the same thing | settings restore vs save, proposal undo vs decide, offline report vs orders, team removal vs adding, books expenses vs team expenses | For each protected action, list every route, job and helper that can cause it |
| P4 | **A key acting as a person** | A step the docs give to people accepts a service key | team changes, money steps, approvals, AI autonomy | Every write route: does the docs say a person decides? Then require `key.userId` (and the second step for approvals) |
| P5 | **Missing company boundary** | A query or check without the company, or an id from another company accepted | person lookup, attribution keys, printing at another company's machine | Every query on a shared table filters by company; every id from the client is checked to belong to the caller |
| P6 | **Memory lost on restart** | A limit or "already used" record lives only in memory | scan tokens, print counts, device sightings | After a restart, does the protection still hold? Seed from the database or store it |
| P7 | **Memory that only grows** | A map or set with no pruning | repeat-scan memory, token sets | Every long-lived collection has a bound or an expiry |
| P8 | **Signs ignored in totals** | Sums by kind that ignore debit vs credit, so reversals add instead of subtract | public books, receipts, ops summary, profit, counters | Every report sum: credited adds, debited subtracts; a voided item nets to zero |
| P9 | **Trusting what the caller says** | Prices, origins, times, addresses or ids taken from the request | custom prices, Origin header, offline print times, X-Forwarded-For | Anything that affects money or limits comes from the server or is bounded by it |
| P10 | **Weak "only once" keys** | Idempotency keys that collide, miss a field, or change between retries | refund keys, payout keys, sale keys, gift-card refs | The key identifies exactly one real-world action and is the same on every retry |
| P11 | **Stuck in the middle** | An intermediate state (`ordering`, `capturing`, `running`) with no way out after a crash or timeout | gift cards, payments, chain actions | Every intermediate state has a timeout, a recovery and a person's way to settle it |
| P12 | **Rewriting the past** | New lines dated into days or months already closed or published | backdated batches, voids | New lines carry the time they're recorded; the day they're about goes in the data |
| P13 | **Copying live settings** | A new thing starts as a copy of a live thing's switches | new licensees copying FreeWater | New things start safe: everything off, testing stage |
| P14 | **Silent stand-ins** | Production quietly uses a test provider or a default secret | payments, payouts, messages, gift cards, secrets | Production refuses to start without the real thing unless explicitly allowed |
| P15 | **Tests that can't fail** | A test passes on the buggy code too | many before mutation testing | Every new test is shown to fail on the old code |
| P16 | **Docs and code disagree** | The docs promise one rule, the code does another | who may cancel chain actions, commit messages | Read the doc's rule and the code's rule side by side |
