# Experiment Design

How to run a test here that can actually produce an answer.

The rebuilt assignment layer is correct. That was necessary and is not
sufficient — the original Bread run would have failed even with perfect
instrumentation, for reasons in this document. Read this before designing a
test, not after it returns nothing.

---

## Glossary

**A/B test** — two complete experiences, randomly assigned. "Does B beat A?"

**MVT (multivariate test)** — several elements varied independently at once,
with each element's separate contribution untangled from the combinations
people saw. Bread was an MVT: six factors, 22,032 combinations. MVT's appeal is
testing many ideas simultaneously; its price is that traffic requirements grow
fast, and it only pays off at very high volume.

**A/A test** — an experiment where both arms receive *identical* content. Run
exactly like a real test: split traffic, collect data, run the analysis. Since
nothing differs, a correct pipeline must report no difference. If it reports a
winner, you have found a bug, not a result. It is calibration for the
instrument, and the cheapest way to earn back trust in a system that previously
produced nonsense.

**SRM (sample ratio mismatch)** — the observed split between arms differs from
the intended one by more than chance. A 50/50 split landing at 52/48 across
100,000 sessions is not bad luck; it means assignment, logging, or filtering is
broken, and every result from that test is suspect. Checked with a chi-square
test, alerting at p < 0.001.

**MDE (minimum detectable effect)** — the smallest effect a test can reliably
find, given its sample size. Its inverse is the useful question: *what sample do
we need to detect an effect we would actually act on?* Answer this before
launch. If the required sample exceeds available traffic, the test is not worth
running.

**Power** — the probability of detecting an effect that genuinely exists.
Convention is 80%. An underpowered test does not "give a weak signal" — it
mostly returns nothing regardless of whether the effect is real, which is
indistinguishable from the effect not existing.

**Optimization theater** — testing that has the *form* of rigor
(randomization, barcodes, significance tests, dashboards) but is structurally
incapable of producing an actionable answer, usually because it is powered to
detect effects far larger than the changes could ever produce. It generates
numbers, meetings, and confidence, but never a decision. It is worse than not
testing, because it consumes the budget and credibility a real test would need.

The diagnostic question: **what result would make us do something differently?**
If there is no answer, do not run the test.

---

## The two numbers that decide whether a test is worth running

### 1. Effect size vs. sample size

Sessions required per arm to detect a lift on a 10% base rate, 80% power,
p < 0.05:

| Relative lift | Sessions per arm | What produces an effect this size |
| --- | --- | --- |
| 3% | **~160,000** | rewording a headline |
| 10% | ~14,700 | a meaningfully different layout |
| 20% | **~3,800** | a genuinely different offer |
| 30% | ~1,800 | removing a real barrier |

Cosmetic variants — headline wording, theme colour, security icons — move
conversion 1-3% relative, when they move it at all. Twelve headline arms at 3%
needs roughly **1.9 million eligible mobile paid sessions**.

**You cannot buy significance with sample size. You have to test bigger
differences.** This is the single most important sentence in this document.

### 2. Population dilution

MCM buys debt, generates an internal account number, and **mails** it. There is
no registration form. So a visitor without that letter *cannot log in*, no
matter what the page says. No headline creates a credential.

Your paid mobile traffic therefore contains two populations with nothing in
common:

| | Can log in? | What the page can do for them |
| --- | --- | --- |
| **Has the letter** | Yes | Build trust, get them to the login fast |
| **No letter** | **No** | Verify legitimacy, request account info, initiate contact |

The original test measured them together, against a metric only one of them
could move. If the effect exists only in the credentialed group and that group
is 40% of traffic, the observed effect is 40% of the true one — and sample size
scales with the inverse square of effect size:

| Scenario | True lift | Observed lift | Sessions per arm |
| --- | --- | --- | --- |
| Credentialed only | 20% | 20% | ~3,800 |
| Diluted across both | 20% | 8% | **~22,800** |

**Dilution alone is a ~6x sample penalty.** Stack it on cosmetic effect sizes
and the original test was unpowerable by orders of magnitude. This is a better
explanation for "we sent the data correctly and still found nothing" than any
tracking defect, and unlike the tracking defects it is not fixed by anything in
`src/`.

---

## Consequences

**"Logins" is the wrong primary metric for the whole population.** It makes the
no-letter half permanently inert. They need their own success metric — verified
legitimacy, requested a copy of their account information, started a chat.
Scoring them on logins guarantees they contribute noise and nothing else.

**Arrival intent is visible at click time and is not being captured.** Someone
searching "midland credit login" has the letter. Someone searching "is midland
credit a scam" got a phone call and does not. Google Ads ValueTrack parameters
(`{keyword}`, `{matchtype}`) can put that on the landing URL, where the edge
handler can freeze it onto the assignment at enrolment as a pre-registered
segment.

Freeze it at enrolment, not per request: intent is a property of how the unit
*entered* the experiment. A returning visitor arriving organically must keep
their original segment or the segmentation drifts.

**The highest-value test is triage, not cosmetics.** Asking "Do you have your
Midland letter?" and routing accordingly addresses a structural mismatch. That
is the class of change that plausibly moves numbers 20-30% — needing ~3,800 per
arm rather than 160,000.

**Some of this may not be a website problem.** If most paid clicks come from
people without letters, that is a media targeting question. And a QR code or
personalized URL on the letter itself would collapse the credential problem
entirely — identity at arrival, pre-filled credentials, clean letter-to-web
attribution. Both are likely outside the web team, and both are probably worth
more than any landing page copy test.

---

## Segmenting on credential state

The most important segment is: does this visitor have their letter?

Two sources, in preference order:

1. **Declared** — the visitor answers a triage question. Recorded via
   `/collect`.
2. **Inferred** — keyword intent as a proxy.

Record it as an **event property, not part of the assignment**. It is an outcome
observed after enrolment, not a randomization input.

This carries a trap worth stating plainly: segmenting analysis on a
post-enrolment variable is only legitimate when the segment is pre-registered
*and* cannot be affected by the treatment. If an arm's content changes who
answers the triage question, then splitting on the answer compares populations
the treatment itself selected, and the comparison is invalid. Pre-declare the
segment, and check that segment sizes are balanced across arms before
interpreting anything within them.

---

## Pre-registration template

Fill this in **before** launch. A test without it is not an experiment.

```
TEST NAME:
HYPOTHESIS:          We believe [change] will cause [effect] because [reason].

PRIMARY METRIC:      (exactly one)
GUARDRAIL METRICS:   (must not regress)

POPULATION:          who is enrolled, and who is explicitly excluded
BASE RATE:           current value of the primary metric in that population
MINIMUM EFFECT
WORTH ACTING ON:     ___% relative
REQUIRED SAMPLE:     ___ per arm  (from the table above)
AVAILABLE TRAFFIC:   ___ per week  ->  RUN LENGTH: ___ weeks

STOP DATE:           fixed in advance; no peeking-and-stopping
PRE-DECLARED
SEGMENTS:            (list them now; anything not listed is exploratory only)

WHAT RESULT WOULD
CHANGE WHAT WE DO:   if this is blank, do not run the test
```

Two rules that protect the result:

**No peeking.** Checking significance repeatedly and stopping at the first
p < 0.05 inflates the false positive rate far above 5%. Fix the stop date, or
use a sequential test designed for continuous monitoring.

**Replicate before acting.** Any winner gets a confirmatory two-arm rerun before
it ships. With six factors across 42 levels you get ~50 implicit comparisons and
expect 2-3 false positives from noise alone; replication is what separates them
from real effects.

---

## The ladder

Work down it in order. Skipping to the bottom is what produced Bread.

1. **Diagnose.** Funnel drop-off for mobile paid traffic: land, scroll, engage,
   reach login, attempt, succeed, pay. Where the mass is lost determines what is
   even testable. Pair with what you already have and are not reading — Pega
   chat transcripts, call centre themes, site search queries. This is where
   hypotheses come from.
2. **Pre-screen messaging where traffic is cheap.** Google Ads responsive search
   ads give asset-level performance across far more impressions than the landing
   page will ever see, with no deploy. A proposition that cannot win in ad copy
   will not win in an H1.
3. **Test big.** Two arms, genuinely different propositions, powered for an
   effect you could plausibly get.
4. **Replicate.** Confirmatory rerun before shipping.
5. **Refine.** Only now do smaller iterations make sense.
6. **MVT.** A late-stage tool for high-traffic programs with a known-good
   baseline. Deferred indefinitely at current traffic.

---

## Sequencing

**Phase 1 — A/A test.** `BREAD_SPEC=aa`. Identical content in both arms.
Validates the pipeline before anyone is asked to trust it.

Acceptance criteria — all four must hold:

- no significant difference on the primary metric
- SRM chi-square p > 0.001
- assignment stable across return visits (same `assignment_id`, no re-issue)
- unattributed `/collect` rate near zero

If any fails, fix it before running anything real. Finding this out costs a few
weeks of traffic; not finding it out costs a quarter and another failed program.

Run the funnel diagnosis concurrently — it needs no test infrastructure.

**Phase 2 — triage test.** Two arms: current generic page vs. a page that asks
whether the visitor has their letter and routes accordingly. Primary metric
differs by branch; guardrails on both.

**Phase 3 — proposition test.** Within the credentialed branch, two or three
genuinely different value propositions. Powered against the *undiluted* base
rate, which is the point of having done Phase 2 first.

**Deferred — cosmetic MVT.** `BREAD_SPEC=legacy` works correctly and should not
be the first thing run on it. Revisit only if traffic grows by an order of
magnitude or a Phase 3 result suggests a specific interaction worth resolving.

---

## Open questions for the business

These change the plan and cannot be answered from the codebase:

- What can a visitor without their account number do today? If the answer is
  "nothing meaningful," that is a product gap worth more than any test.
- Is the mailed letter in scope for change? A QR code or personalized URL would
  collapse the credential problem.
- What share of paid clicks are no-letter intent? Available today from Google
  Ads search terms, with no engineering.
