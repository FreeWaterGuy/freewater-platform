# Supply chain and secrets

What we install, build and run, how it is pinned and checked, how keys are handled, and the repository settings the
owner must turn on. Measured against the [OpenSSF Scorecard](https://github.com/ossf/scorecard) checks. Covers threat
model risks R13 and R14 (`docs/THREAT-MODEL.md`). As of 2026-10-20.

## Scorecard, item by item

| Check | State | How |
| --- | --- | --- |
| Pinned-Dependencies (Actions) | PASS | Every `uses:` in `.github/workflows/ci.yml` is a full 40-character commit with the tag in a comment. `test/supply-chain.test.ts` fails on a tag. |
| Pinned-Dependencies (image) | PARTIAL | `node:22.22.0-bookworm-slim` and `postgres:16.10`: exact releases, not yet digests (couldn't be looked up offline). See "Pin the image by digest" below. |
| Pinned-Dependencies (npm) | PASS | `package-lock.json` with integrity hashes; CI and the image install with `npm ci`. `package.json` ranges are caret, which only matters for whoever updates the lockfile. |
| Token-Permissions | PASS | Workflow-wide `permissions: contents: read`; no job asks for more. `actions/checkout` runs with `persist-credentials: false`, so the token isn't left in `.git/config` for later steps. |
| Dangerous-Workflow | PASS | Only `push` and `pull_request` (no `pull_request_target`); no untrusted text (titles, branch names) in `run:` lines. |
| Vulnerabilities | PASS (with allowlist) | `scripts/audit.mjs` runs `npm audit --omit=dev` and fails at **moderate** or above unless the advisory is in `.github/audit-allowlist.json` with a reason and an expiry. |
| Dependency-Update-Tool | PASS | `.github/dependabot.yml`: npm, GitHub Actions and the Docker base image, weekly. |
| Signed-Releases / provenance | PARTIAL | `npm audit signatures` in CI checks every installed package's registry signature. We don't publish releases; images aren't signed yet (see "Next"). |
| Packaging / image | PASS | Two stages, `bookworm-slim`, dev dependencies left out, runs as `USER node`, app files owned by root (read-only to the server), `HEALTHCHECK` on `/health/live`, no key in `ENV`/`ARG`, `.dockerignore` keeps `.env*`, `*.pem`, `*.key`, `.git`, tests and docs out of the build. |
| Binary-Artifacts | PASS | None in the repository. |
| Branch-Protection, Code-Review, Security-Policy, two-step sign-in | OWNER | Repository settings, not code: see the checklist at the end. |
| Fuzzing, SAST, CII badge | N/A for now | Optional; CodeQL is the cheapest next step (checklist). |

## Dependencies

- **All used.** Every entry in `dependencies` is loaded by the server: `fastify`, `pg`, `@electric-sql/pglite` (local
  and tests), `ajv` (plug-in answers), `maxmind` (area lookup), `sharp` (images), `@solana/web3.js` (seals, off until
  turned on), `@google/model-viewer`, `three` and `jsqr` (served to phones), `esbuild` (builds the AR viewer at start)
  and `tsx` (runs the TypeScript). Nothing to remove.
- **`.npmrc` `legacy-peer-deps=true`** stays: vitest 4's peer list can't be reconciled by npm 10. It only affects how
  peers are resolved when the lockfile is regenerated; `npm ci` installs exactly the lockfile.
- **The four moderate advisories in `@solana/web3.js`'s tree** (all through `jayson`):
  - `GHSA-w5hq-g745-h8pq` (`uuid` < 11.1.1): **fixed** by `overrides.jayson.uuid = ^11.1.1` in `package.json`.
    `jayson` only calls `uuid.v4()`, which 11.x keeps in CommonJS; the RPC client loads and works with it.
  - `GHSA-528h-pc64-c93x`, `GHSA-hqr4-qq8f-hg3x`, `GHSA-mjw6-4jj6-33hc` (`stream-json`): **allowed until 2027-01-31**.
    Only `jayson/lib/utils.js` (its server and stream helpers) requires `stream-json`; `@solana/web3.js` loads
    `jayson/lib/client/browser`, which never does. The fixed `stream-json` is ESM-only, so `jayson` (CommonJS) can't use
    it: no safe override exists. Recheck when `@solana/web3.js` or `jayson` moves off it, or by the expiry.
- To allow a new advisory: add it to `.github/audit-allowlist.json` with the package, why it can't reach us, today's
  date and an expiry no more than three months out, in a pull request someone else reviews. An expired entry fails CI.

## TypeScript at runtime

The image runs `node --import tsx src/server/main.ts`. `tsx` is pinned in the lockfile and only strips types, so the
added risk is one more package at runtime and a slower start. Building to JavaScript first (`tsc` to `dist/`, then
`node dist/server/main.js`) would drop `tsx` from production, but the server finds files next to its own source
(`src/web/` pages, the AR viewer's `viewer.ts` that `esbuild` bundles on first request, the books library) and spawns
`src/server/booksCheck.ts` through `tsx`, so the switch touches the start path, the image and the upgrade check in CI. **Not done in this round** (too wide for a parallel review); plan it as its own change, proved by
the existing `image` job in CI.

## Pin the image by digest

On a machine with Docker:

```sh
docker buildx imagetools inspect node:22.22.0-bookworm-slim --format '{{json .Manifest.Digest}}'
docker buildx imagetools inspect postgres:16.10 --format '{{json .Manifest.Digest}}'
```

Write both `FROM` lines in the `Dockerfile` as `node:22.22.0-bookworm-slim@sha256:<digest>` and the two `postgres`
references in `ci.yml` the same way. Dependabot (`docker`) then proposes new digests as pull requests.

## Machine software updates (R13)

- An owner asks a machine to update (`POST /v1/ops/fleet/:id/commands`, `update_software`, `{ version, sha256? }`).
  The server signs a short statement (machine, version, package hash, issued and expiry times, at most 3 days) with
  the Ed25519 key `MACHINE_UPDATE_SIGNING_KEY`. Whatever `manifest`/`signature` the caller sends is replaced.
- The machine (`src/machine/updates.ts: checkUpdate`) holds only the public half, `FW_UPDATE_PUBLIC_KEY`, and refuses:
  no key set, no or a wrong signature, another machine's update, an expired one, or a version that isn't newer (no
  downgrades, no replays). It reports the reason back as the command's result.
- The install itself is still a stand-in until update packages exist; the real updater must check the download
  against `manifest.sha256` before switching.
- **Make the pair:** `npm run key:machine-updates` (prints both halves, writes nothing). Private half: the server
  host's settings only. Public half: every machine's settings. The server refuses to start with a malformed key.
- **Rotate:** make a new pair, put the new public half on every machine (by hand or with the last update signed by
  the old key), then swap the server's private half. **If the private half leaks:** take it out of the server at once
  (updates then answer `updates_not_set_up`) and replace the public half on each machine by hand.

Machine commands need a **signed-in** ops person or owner (scope `orders` or `admin`, and a person, not a service key
or a machine key); software updates need an owner (`admin`). Door reports: `POST /v1/deliveries` needs a signed-in
person and refuses boxes on a planned run (those go through `/v1/driver/runs/...`, which checks the run is that
driver's, the right box, GPS or confirmation); a delivery photo counts only if that driver uploaded it for that company.

## Secrets end to end

| Secret | Made by | Kept | Rotation | Never logged |
| --- | --- | --- | --- | --- |
| API keys, sign-in sessions | `randomBytes` in the server | SHA-256 hash only (`api_keys`, `sessions`); key shown once | Revoke and make a new one; sessions last 30 days | Request log keeps method and path only (`src/api/logging.ts`), never headers or query |
| `MACHINE_UPDATE_SIGNING_KEY` | `npm run key:machine-updates` | Host settings | As above | Never printed by the server; checked at start |
| `BACKUP_KEY`, provider keys (`ANTHROPIC_API_KEY`, S3, messaging, payments) | The provider, or the command in `RUNNING.md` | Host settings | At the provider; restart | Placeholders (`changeme`, `test`) refused at start |
| Code, wallet-source, second-step secrets | `loadSecret`: `FW_SECRET_<NAME>` from host settings, otherwise made once and kept in `platform_secrets` | Database unless `FW_SECRET_*` is set | Not supported without re-issuing what they sign | Not logged. **Gap (R9, database-engineer):** set `FW_SECRET_*` in production so these live only in host settings |
| CI | `GITHUB_TOKEN`, read-only | GitHub | Per run | Not persisted to disk |

Nothing secret is in the image, the repository (`.gitignore` and `.dockerignore` exclude `.env*`, `*.pem`, `*.key`,
`*.p12`, machine data) or the CI file (the `fw:fw` Postgres password is a throwaway test service).

## Settings the owner must change (GitHub)

1. **Two-step sign-in** for every person with access (Organization → Authentication security → require 2FA), using
   an authenticator app or passkey, not SMS.
2. **Ruleset on `main`** (Settings → Rules → Rulesets): require a pull request with 1 approval from someone other than
   the author, dismiss approvals on new commits, require the `test` and `image` checks to pass and be up to date, block
   force pushes and deletion, no bypass list (or owners only, with a reason).
3. **Dependabot alerts** and **Dependabot security updates** on (Settings → Code security). Version updates come from
   `.github/dependabot.yml`.
4. **Secret scanning** and **push protection** on (Settings → Code security), so a pasted key is blocked before it
   lands.
5. **Actions**: Settings → Actions → General → "Workflow permissions: Read repository contents" and untick "Allow
   GitHub Actions to create and approve pull requests"; allow only GitHub-made and verified actions, and require
   approval for workflows from outside contributors.
6. **Private vulnerability reporting** on, and a `SECURITY.md` saying where to report.
7. **CodeQL default setup** (Settings → Code security → Code scanning) for JavaScript/TypeScript.
8. Review who has write and admin access each quarter; remove deploy keys and personal tokens nobody uses.

## Next

- Pin both images by digest (above).
- Build to JavaScript and drop `tsx` from production (above).
- Sign the server image (cosign keyless from CI) and generate an SBOM (`npm sbom` or `docker buildx --sbom`) when
  images are pushed to a registry; nothing is pushed today.
- Move `FW_SECRET_*` into host settings in production (R9).
