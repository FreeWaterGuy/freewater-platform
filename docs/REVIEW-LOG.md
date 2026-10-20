# Review log

Every finding from every review run, so the next run learns from this one. Newest first.

| Date | Role | Severity | Pattern | Where | Fix | Test |
|---|---|---|---|---|---|---|
| 2026-10-20 | static analysis (ESLint + Semgrep) | HIGH | P9 | `checkSvg` in src/modules/print/svgCreative.ts: `<\s*\/?\s*` and `=\s*["']?\s*` backtracked quadratically on a long run of spaces; any signed-in person can send 2 MB of artwork (`POST /v1/me/proofs`, also ads and custom orders), which stalled the whole server for minutes | split the whitespace runs (`<\s*(?:\/\s*)?`, `=\s*(?:["']\s*)?`), same matches; sibling regexes over uploads and chat text checked (bounded or linear) | test/review-ads.test.ts "checks a hostile upload in linear time" (17 s and failing on the old code) |
| 2026-10-20 | static analysis (ESLint + Semgrep) | LOW | P9 | `AttributionService.click` (`GET /go/:token`): the signature's length was checked in characters, then `timingSafeEqual` threw on 16 non-ASCII characters (more than 16 bytes), so a forged link gave a 500 instead of a 404 | compare byte lengths before `timingSafeEqual`; every other `timingSafeEqual` call checked (all validate the format or byte length first) | test/attribution.test.ts "sends every link out of an ad through our click id" (500 on the old code) |
| 2026-10-20 | static analysis (ESLint + Semgrep) | LOW | P3 | sibling in the published webhook-check snippets (developer pages, src/web/console.js): the Node.js one threw RangeError and the Python one TypeError on a forged non-ASCII signature, crashing the partner's handler | Node compares byte lengths; Python compares bytes | test/static-analysis.test.ts runs both snippets as published (both fail on the old code) |
