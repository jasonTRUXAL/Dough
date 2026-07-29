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

### 1. Effect size vs. sample size — and base rate

Sessions required per arm, 80% power, p < 0.05. **The base rate matters as much
as the effect size**, and it is the number most often assumed rather than
looked up:

| Base rate | 3% relative lift | 5% | 10% | 20% |
| --- | --- | --- | --- | --- |
| 10% | ~160,000 | ~58,000 | ~14,700 | ~3,800 |
| **40%** | ~26,200 | ~9,500 | **~2,400** | ~600 |
| **60%** | ~10,900 | ~4,100 | **~1,000** | ~250 |

Higher base rates make the same *relative* lift far easier to detect. At MCM's
measured ~60% login-form engagement, a 10% relative improvement needs roughly
**1,000 sessions per arm** — completely reachable. At the 10% base rate one
might naively assume, the same test looks impossible.

Get the real base rate before computing anything. An assumed one will be wrong
by a factor that changes the decision.

What remains true regardless: cosmetic variants (headline wording, theme
colour, security icons) move conversion 1-3% relative, and twelve arms of
anything multiplies the bill twelvefold. **Prefer fewer arms and bigger
differences** — that principle survives the base rate correction, even though
the specific "unreachable" verdicts do not.

### 2. Where the funnel actually leaks

Roughly **60% of sessions engage the login form**. That is a high engagement
rate, and it relocates the problem entirely.

The page is not failing to persuade people to try. Whatever is being lost is
lost *inside the login flow* — between typing an account number and getting in.
Which means every cosmetic factor in the original design was optimizing a step
that already works, and the one factor sitting exactly where the loss occurs —
`L#`, the login form variant — was the one omitted from the barcode.

The flow also includes MFA (`accounts.midlandcredit.com/ssc-mfa-ui/`). Mailed
credentials plus MFA on a phone is a plausible place to lose a meaningful share
of that 60%.

**The number that decides the next test: of the ~60% who engage, what fraction
complete?** That gap is the opportunity, and it is measured, not guessed.

### 3. Population dilution — smaller than it first appears

MCM buys debt, generates an internal account number, and **mails** it. There is
no registration form, so a visitor without their letter cannot log in at all.

That sounds like severe dilution, and would be if the traffic were general. It
is not: paid search targets people looking for how to pay off or log into
existing accounts, and the 60% engagement rate confirms the arriving population
is largely credentialed. **Treat dilution as a modest correction here, not a
dominant one.**

It still matters for two things: no-letter visitors need their own success
metric (they can currently only read about MCM, which is a content gap worth
addressing on its own terms), and any segment analysis must account for them
rather than pooling them into a login-based metric they cannot move.

---

## The mail and email channel

Letters and emails can carry a QR code or link with a **signed assignment
token** (`?b=...`). This is a better experimental substrate than paid search,
and not only for convenience:

- **Randomization happens at mail time, server-side**, before the visit exists.
  No coin flip in a browser, no cookie needed for first touch. The entire class
  of persistence bugs that sank the original run becomes structurally
  impossible.
- **The denominator is known exactly.** You sent N letters. Sample ratio
  mismatch stops being a statistical inference and becomes arithmetic — compare
  the mint log against what shipped.
- **The unit is an account**, so outcomes can be followed through to payment
  rather than stopping at login as a proxy.
- **Email is a fast, cheap pre-test.** Randomize email content, measure
  click-through in days instead of months, promote only winners to print. Given
  the traffic constraints, this is the fastest learning loop available.

Mint with `tools/mint-tokens.js`; the handler verifies and honours tokens when
`BREAD_TOKEN_SECRET` is set. A token outranks a cookie — see the note in
`src/lib/assign.js` for why, and note that conflicts are counted rather than
hidden.

Because the mail channel controls its own split, a mailing can pin arms at mint
time (`--split`) or inherit the global derivation. Pin it when the mailing *is*
the experiment.

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

**Phase 2 — login completion.** The real first test. ~60% of sessions engage
the form; the loss is inside it. Two or three login form variants (`L#`), the
factor the original barcode omitted, measured on completion rather than
engagement. At a ~40% completion base rate a 10% relative lift needs ~2,400 per
arm — roughly 7,200 sessions total for three arms. Reachable.

**Phase 3 — mail/email token pilot.** A small drop with `?b=` tokens, arms
pinned at mint time. Validates end-to-end attribution from letter to login on a
known denominator, and opens account-level outcomes. Run email first — it
returns in days.

**Deferred — cosmetic MVT.** `BREAD_SPEC=legacy` works correctly and should
still not be the first thing run on it. Headline and colour variants optimize a
step that already converts at 60%. Revisit only if Phase 2 shows the login flow
is not where the loss is.

---

## Open questions for the business

These change the plan and cannot be answered from the codebase:

- **Of the ~60% who engage the login form, what fraction complete?** This is the
  single most important unknown. It sizes the opportunity and sets the base rate
  every power calculation depends on.
- **Where in the flow do they fail** — account number entry, password, or MFA?
  Determines whether the fix is a form change, a copy change, or an auth change.
- **Eligible mobile paid sessions per month**, to convert "sessions per arm"
  into a run length.
- What share of paid clicks are no-letter intent? Believed low. Available from
  Google Ads search terms with no engineering.
