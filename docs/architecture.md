# Architecture

## The one idea

**Everything is derived from `assignment_id`.**

```
assignment_id  --(pure function)-->  arm
               --(pure function)-->  factor levels
               --(pure function)-->  barcode
```

Only the `assignment_id` is stored, in one cookie. The arm, the factor levels
and the barcode are recomputed wherever they are needed — at the edge, in the
browser, in the warehouse.

Nothing can fall out of sync because nothing is duplicated. This is the direct
answer to the defect that sank the original run: six storage keys spread across
localStorage and sessionStorage, reads checking sessionStorage first, so a
second browser tab could take a different read path from the first.

Two consequences worth noticing:

- The barcode never needs to be transmitted or stored to be known. Given an
  `assignment_id` in a warehouse table, the barcode is a function call.
- Changing the spec changes every derived barcode. That is why specs are
  versioned and levels are never redefined in place — see `src/lib/spec.js`.

## Layout

```
src/handler.js              THE PORTABLE ARTIFACT — Fetch API edge handler
src/lib/assign.js           the decision: restore / enrol / ineligible
src/lib/barcode.js          derive, format, parse
src/lib/spec.js             factor definitions and the immutability rule
src/lib/eligibility.js      paid-traffic and mobile detection
src/lib/cookie.js           the single cookie
src/lib/hash.js             FNV-1a, identical across runtimes

adapters/do-node.js                    DigitalOcean — DISPOSABLE
adapters/contentstack/functions/[edge].js   Contentstack — one re-export line

public/index.html           placeholder origin document; real SPA drops in here
test/assign.test.js         tests named after the defects they prevent
```

`src/` imports nothing. No dependencies, no Node built-ins, no browser globals
— only Fetch API standards. That is what makes it run unmodified in both
runtimes, and it keeps the bundle far under Launch's 1 MiB cap.

## Portability

Contentstack Launch edge functions use the Fetch API verbatim:

```js
export default function handler(request, context) { /* ... */ return fetch(request) }
```

`src/handler.js` already has that signature. So there is no abstraction layer
here, no adapter interface, no runtime shim in `src/` — the production target's
API *is* the internal API, and DigitalOcean is the one that needs translating.

**Migration at end of year:** move `adapters/contentstack/functions/[edge].js`
to `functions/[edge].js` at the project root, set the environment variables
below, delete `adapters/do-node.js` and `public/`. Nothing in `src/` changes.

## Request flow

```
request
  │
  ├─ /collect ──────────────► attach assignment FROM COOKIE, stamp, sink
  │
  └─ everything else
       │
       ├─ cookie present & valid ──────────────► RESTORED (never re-rolled)
       ├─ no cookie, eligible ─────────────────► ENROLLED (mint + Set-Cookie)
       └─ no cookie, not eligible ─────────────► INELIGIBLE (no cookie set)
       │
       ├─ fetch(request) → origin
       ├─ non-HTML? pass through, stays cacheable
       └─ HTML? inject window.__BREAD__ + dataLayer push, mark private, no-store
```

## Rules that are load-bearing

**A present cookie is never re-evaluated.** Not against eligibility, not
against a clock. The original silently re-randomized enrolled units after 90
days. Enrolment happens exactly once, ever.

**Ineligible visitors are not persisted.** Enrolment should happen at first
*qualifying* exposure. Stamping a permanent "ineligible" on someone who
browsed organically today would exclude them forever when they click an ad
tomorrow.

**The client reads; it never mints.** `window.__BREAD__` is injected before the
application boots. The SPA renders what it is told. The original generated the
barcode in a React `useEffect` and every other system raced to observe it.

**Tracking is emitted by the assigner.** The `dataLayer` push goes in beside
`window.__BREAD__`, from the same code path that produced the assignment, so it
cannot race the thing it measures. The original had a loader polling
localStorage every 50 ms waiting for React, which then loaded a tracking script
that immediately disabled itself on the only page where the barcode existed.

**Personalized HTML is never cached.** `Cache-Control: private, no-store` plus
`Vary: Cookie`. The legacy root document returned `x-cache: HIT` with
`x-cache-group: iphone` — a cached page carrying one visitor's assignment hands
that assignment to everyone who follows, which is the most likely mechanism
behind the reported control/test leakage.

**`/collect` trusts the cookie, not the body.** A client that can claim its own
`assignment_id` can corrupt attribution, and the server already knows the true
one.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `BREAD_SPEC` | `legacy` | `legacy` (22,032 combos) or `focused` (9). See below. |
| `BREAD_TEST_SHARE_BPS` | `5000` | Basis points of 10,000. `5000` = 50/50, `1000` = 10% ramp. |
| `BREAD_COOKIE_DOMAIN` | *(unset)* | **Must stay unset on DigitalOcean** — `ondigitalocean.app` is a public suffix, so a `Domain` attribute is silently rejected. In production set `.midlandcredit.com` so `accounts.midlandcredit.com` can read the assignment. |
| `PORT` | `8080` | DigitalOcean adapter only. |

## Which spec to run

`legacy` reproduces the original inventory (12x17x3x3x4x3) and exists for
continuity with the existing content library. It is analysable **marginally**
— each level estimated across every session that saw it — and hopeless at cell
level.

`focused` is the recommendation: login form and headline, three levels each.
Ordered by expected effect size the factors run
`loginForm > headline > subheadline > heroGraphic > securityIcon ~ theme`, and
the last two are very likely below the detection floor at any traffic level
available here.

At 50k test sessions: 12 headline arms gives ~4,200 per level against roughly
14,700 needed to detect a 10% relative lift on a 10% base. Three arms gives
~16,700. That is the whole argument.

## Running locally

```
npm test                                  # 28 tests: uniformity, SRM, persistence
npm start                                 # http://127.0.0.1:8080

curl -D - -A "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148" \
  "http://127.0.0.1:8080/?gclid=TEST&utm_medium=cpc"
```

Deploy to DigitalOcean App Platform as a **web service**, not a static site. A
static component cannot see a request or set a cookie, which forces assignment
back into the client and reproduces every defect in the post-mortem.

## Not built yet

- **Content binding.** Factor levels are integers; nothing maps `headline: 10`
  to copy. Needs the real inventory plus the versioning discipline in
  `src/lib/spec.js`.
- **Conversion stitching.** The login widget lives on
  `accounts.midlandcredit.com`. Until `assignment_id` reaches whatever records
  a successful login, the experiment cannot measure its own conversion event.
  This is the highest-risk open item — it can invalidate an otherwise correct
  design.
- **A durable sink.** `/collect` currently logs to stdout.
- **Cookie signing.** An HMAC would make tampering detectable. Low priority
  against the items above.
