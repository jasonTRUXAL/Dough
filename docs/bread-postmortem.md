# Project Bread — Forensic Post-Mortem

**Date of investigation:** 2026-07-28
**Subject:** the live MCM multivariate experiment at `midlandcredit.com/mcm`
**Purpose:** extract requirements for a greenfield rebuild.

This is not a repair plan. The original implementation is being replaced, not
fixed. What follows is a record of what the deployed system actually did, so
that the replacement can be specified against observed failure modes rather
than imagined ones.

Everything below was read from the live site: the WordPress root document, the
`/mcm/` document, `/opt/mcm5/exp.js`, the 526KB Vite bundle at
`/mcm/assets/index-85f75fdc.js`, and the public GTM container `GTM-T7MRBMK4`.

---

## 1. State at time of investigation

| | Control | Test |
| --- | --- | --- |
| Stack | WordPress on WP Engine | React SPA (Vite) at `/mcm/` |
| Edge | Imperva | Imperva |
| Analytics | Adobe Launch **and** GTM-T7MRBMK4 | GTM-T7MRBMK4 only |

**The experiment was not running.** A mobile visitor carrying a `gclid` on the
root received `redirects=0 code=200` — no redirect to `/mcm/`. No `exp.js`, no
`wp-mcm` cookie read, and no barcode logic appears in the theme JavaScript
(`5.0.js`, `main.js`, `gtm_connect.js`). The assignment layer is absent from
the control side. `/mcm/` remains deployed and fully wired.

The original design intent was:

```
Google Ads visitor? -> mobile? -> persistence cookie present?
  yes -> route per stored arm
  no  -> 50/50 control (WordPress) or test (/mcm), then persist
```

No part of that decision tree is currently implemented on the control side.

---

## 2. Defects found

### 2.1 The barcode cookie expires in 60 minutes

From the bundle:

```js
const E = new Date(Date.now() + 60*60*1e3);
document.cookie = `breadBarcode=${P}; path=/; domain=.midlandcredit.com; secure; SameSite=None; expires=${E.toUTCString()}`
```

This is the reported "persistence lost" symptom, in full. A visitor returning
the next day is indistinguishable from a new one.

Secondary: the cookie is written with `document.cookie`, so Safari ITP caps it
at seven days regardless. Given the campaign targeted **mobile** Google Ads
traffic — heavily iOS Safari — this would have mattered a great deal had the
one-hour expiry not already dominated.

### 2.2 The tracking script disables itself on the page it tracks

Final line of `exp.js`:

```js
if (window.location.pathname.indexOf('/mcm/') < 0) mcm5.init();
```

`exp.js` is loaded *by* `/mcm/`. The guard therefore prevents `init()` from
ever running there. The `variation == 'x1'` branch — the only code path that
reads a barcode into `user_exp_slot_4` — is unreachable on the SPA.

The GTM container is configured to receive that field:

```
"parameter","user_exp_slot_4","parameterValue",["macro",4]
```

GTM was listening for a push that could not occur.

### 2.3 First visits are attributed with no barcode

In `exp.js`'s `track()`, when the barcode is not yet in localStorage the
function falls through to:

```js
mcm5.exp_slot_4_value = mcm5.details.id;   // 1711737330
```

On a first visit, React has not yet written the barcode at the moment `exp.js`
reads it. Paid search traffic is overwhelmingly first-touch, so the majority of
purchased clicks were logged against the raw experiment ID rather than a
barcode.

**This is assessed as the primary cause of weak sample data** — more so than
the combinatorial explosion described below.

### 2.4 Six storage keys, two storage areas, sessionStorage taking priority

Two complete parallel systems run side by side:

- `objBarcodev2` / `objBarcodeDatav2`
- `objBarcodeBAU` / `objBarcodeDataBAU`

selected by a `theme` flag (`0` = BAU, `1` = v2). Each is mirrored into **both**
localStorage and sessionStorage:

```js
jv = function(e,t){
  localStorage.setItem("objBarcodeDatav2", JSON.stringify(t.data||t));
  localStorage.setItem("objBarcodev2", JSON.stringify(e));
  sessionStorage.setItem("objBarcodeDatav2", JSON.stringify(t.data||t));
  sessionStorage.setItem("objBarcodev2", JSON.stringify(e));
}
```

A legacy `objBarcodeData` key, if present, forces regeneration. Reads check
sessionStorage before localStorage, so a second tab takes a different read
path from the first.

This is the reported "multiple barcodes per device" symptom. It is structural,
not a race condition to be tightened.

### 2.5 Silent 90-day re-randomization

```js
Number(localStorage.getItem("unixDay")) + 90 < F
```

An existing user is silently re-randomized after 90 days — mid-flight
reassignment of an already-enrolled unit.

### 2.6 The loader can spin indefinitely

```js
const neededKeys = ['objBarcodev2', 'objBarcodeBAU', 'theme'];
...
if (domComplete && gtmReady && haveLocalStorage) { /* load exp.js */ }
else setTimeout(loadMCMWhenReady, 50);
```

This polls every 50ms waiting for keys that React writes in its own
`useEffect`. If any key never lands, `exp.js` never loads at all. The tracking
layer races the application it measures.

### 2.7 Untracked default arm

`exp.js` defaults to `xn = 'x2'` (`'Ineligible'`) when the
`wp-mcm-1711737330` cookie is absent — which is the case for every first-time
visitor.

### 2.8 Split measurement stacks

The control page loads Adobe Launch *and* GTM. `/mcm/` loads GTM only. The two
arms of the experiment were measured through different analytics systems, which
is on its own sufficient to produce arm-to-arm discrepancies unrelated to the
content being tested.

### 2.9 Protocol downgrade on redirect

`/mcm` returns `301` to `http://www.midlandcredit.com/mcm/` — plaintext. HSTS
most likely covers this in practice, but it is an avoidable extra hop on
mobile.

### 2.10 Cookie mirror is mobile-gated and retry-driven

The `breadBarcode` cookie write sits behind `useMediaQuery("(max-width: 768px)")`
and retries via `setTimeout(v, 555)`. Desktop sessions never receive the cookie
mirror at all.

---

## 3. What was correct

Randomization draws each factor independently:

```js
let s = Math.floor(Math.random() * e[i].length)   // per factor key
```

This is the condition that makes **marginal analysis** valid — estimating each
factor level's effect across all sessions that saw it, rather than treating the
barcode as a lookup key into a cell.

Consequence: the historical data may be partially salvageable for main effects,
for whichever sessions actually carried a barcode into the dataLayer. Per §2.3
that is likely return visitors only, which is a biased slice — but it is worth
querying before assuming a clean start.

---

## 4. The statistical problem, separately

12 headlines x 17 subheadlines x 3 login forms x 3 themes x 4 hero graphics x
3 security icons = **22,032 combinations**.

At cell level this is unpowerable: even a minimal 1,000 sessions per cell is 22
million sessions. But cell-level data was never required. With independent
randomization (§3), analysis is marginal.

Marginal analysis is still expensive:

| Arms in factor | Sessions/arm at 50k test traffic | Detects +10% relative on a 10% base? |
| --- | --- | --- |
| 12 (headlines) | ~4,200 | No — needs ~14,700/arm |
| 3 (login form) | ~16,700 | Marginally |

Interactions between factors are out of reach at any realistic traffic level
and should be excluded from the design rather than discovered as missing during
analysis.

Expected effect size, ordered: **login form > headline > subheadline > hero
graphic > security icon ≈ theme colour**. The factors nearest the conversion
event dominate. Theme colour and security icons are very likely below the
detection floor permanently; randomizing them is free in code and expensive in
traffic.

Note: the documented barcode format `H1-S2-T3-G2-X1` contains no `L` term. If
the login form variant was genuinely absent from the barcode, the
highest-leverage factor was untracked. Worth confirming against the original
data dump.

---

## 5. Requirements for the rebuild

Derived directly from the defects above.

1. **Assign once, server-side, at the edge, before render.** Eliminates 2.2,
   2.3, 2.6, and the control/test leakage, all of which stem from assignment
   living inside the rendered application.
2. **One storage key, one source of truth.** No parallel systems, no
   localStorage/sessionStorage mirroring, no legacy-key fallbacks (2.4).
3. **Server `Set-Cookie`, `HttpOnly`, first-party, with a lifetime matched to
   the test duration.** Not subject to the ITP cap that applies to
   `document.cookie` (2.1).
4. **The client reads the barcode; it never mints one** (2.3, 2.6).
5. **Assignment is immutable for the life of the experiment.** No 90-day
   regeneration, no re-roll when a cookie is present (2.5).
6. **One measurement stack across both arms** (2.8).
7. **Emit the assignment event from the same code path that mints the
   assignment,** so tracking cannot race the thing it tracks (2.2, 2.6).
8. **`assignment_id` is the analytics join key,** not the barcode. Decompose
   the barcode into columns at ingest (`headline_id`, `login_id`, ..., `arm`).
9. **Stitch `assignment_id` through to login success.** The conversion event
   lives in the portal, possibly on another origin. Without this the
   experiment measures nothing.
10. **Daily automated SRM check** — chi-square on arm counts, alert at
    p < 0.001. This is the check that would have surfaced the control/test
    leakage on day one.
11. **Content variants are immutable and versioned.** Changed copy becomes a
    new ID, never a redefinition of an existing one. Required both
    statistically (no mid-flight redefinition) and for FDCPA / Reg F
    reconstruction of what a given consumer saw on a given date.
12. **Compliance sign-off precedes entry into the variant pool** — a further
    argument for few arms rather than many.

---

## 6. Recommended sequencing

**Phase 1.** SPA with a single fixed variant vs. WordPress, 50/50. Answers
"does the new experience win," is cleanly powered, and exercises the assignment
infrastructure under real traffic before a multivariate test depends on it.

**Phase 2.** Multivariate within the SPA arm, on the two highest-leverage
factors only (login form, headline), three arms each.

These are two distinct experiments with separate power budgets. Stacking them,
as the original did, means neither is cleanly powered.

---

## 7. Open questions

- Was `wp-mcm-1711737330` set server-side by WordPress, or by a tag? This
  determines whether the control/test leakage was a caching artifact. The root
  document returns `x-cache: HIT` with `x-cache-group: iphone`, which is
  suspicious for a cached assignment.
- In the original data dump, how many sessions carried a real barcode into
  `user_exp_slot_4` versus the bare experiment ID `1711737330`? This sizes what
  is salvageable per §3.
- Was the login form variant (`L#`) ever included in the barcode?
