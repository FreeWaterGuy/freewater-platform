# The review team

Eight AI agents with professional roles, saved in `.claude/agents/` so the team can be rerun at any time: monthly,
before a big change, or before going live. Each works to a recognized standard and leaves something permanent
behind (tests, checks, runbooks, checklists), not just a list of problems.

| Role | What it does |
|---|---|
| Security architect | Keeps FreeWater's threat model: every valuable asset, every trust boundary, the control protecting each, and the top risks for the rest of the team. Runs first. |
| Financial controls auditor | Checks that every cent reconciles: double-entry balance, reconciliations, separation of duties, approvals, audit trail, idempotency. Turns money rules into permanent automated checks. |
| Site reliability engineer | Production readiness: deploys, rollbacks, backups and restores, alerts, outages, crash safety, capacity. Writes runbooks and makes crash tests permanent. |
| Database engineer | Makes the database itself refuse impossible states: constraints, unique keys, locking, isolation, migrations and indexes, all checked on real Postgres. |
| Privacy and compliance officer | Maps all personal data and checks it against GDPR, CCPA/CPRA, COPPA and sweepstakes rules: consent, rights, retention, erasure, notices. Prepares the lawyer's checklist. |
| Test engineer | Measures how good the tests really are (mutation testing, coverage of rules) and strengthens them: property tests, real-browser tests, and CI gates. |
| Supply-chain and secrets engineer | Secures what the platform depends on: packages, lockfile, the server image, CI, secrets handling and repository settings, measured against the OpenSSF Scorecard. |
| The skeptic | Verifies every fix the team makes by trying to show it doesn't work. Nothing merges without its sign-off. |

**Order:** the security architect writes the threat model first; the six specialists then work in parallel from it,
each fixing what it finds with tests; the skeptic verifies every fix before it merges.

**Limits:** these are all the same AI, so blind spots can be shared. They don't replace a lawyer, real-world testing
(phones, printer, Solana), or, when affordable, an outside review.
