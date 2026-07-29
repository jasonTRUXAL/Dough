/**
 * The assignment core.
 *
 * Pure. No `window`, no `document`, no Node built-ins, no framework, no I/O.
 * Its only inputs are a URL, a header bag, a cookie jar, and a clock. That
 * constraint is what makes the same code run unmodified as a Contentstack edge
 * function and under the DigitalOcean adapter, and what makes the whole thing
 * testable without a browser or a server.
 *
 * Every property here exists to close a specific defect from the original run;
 * see docs/bread-postmortem.md for the numbered findings.
 */

import { deriveBarcode, deriveFactors } from './barcode.js';
import { checkEligibility } from './eligibility.js';
import { decodeAssignmentCookie, COOKIE_NAME } from './cookie.js';
import { indexFor } from './hash.js';

export const ARM_CONTROL = 'control';
export const ARM_TEST = 'test';

/**
 * Derive the arm from the assignment_id.
 *
 * Like the barcode, the arm is not stored — it is recomputed. This means the
 * warehouse can determine any unit's arm from its assignment_id alone, with no
 * join against an assignment table that could drift.
 *
 * `testShare` is expressed in basis points of 10,000 so that splits finer than
 * 50/50 (a 10% ramp, say) are possible without changing the encoding.
 */
export function deriveArm(assignmentId, testShareBps) {
  return indexFor(assignmentId, 'ARM', 10000) < testShareBps ? ARM_TEST : ARM_CONTROL;
}

export const DEFAULT_CONFIG = Object.freeze({
  // 50/50. Basis points of 10,000.
  testShareBps: 5000,
  // 180 days. The unit must survive the entire experiment; anything shorter
  // re-enrols returning visitors as fresh units and biases the result toward
  // whatever first-touch behaviour looks like.
  cookieMaxAgeSeconds: 180 * 24 * 60 * 60,
  // Omitted by default: host-only. See cookie.js for why this is not hardcoded.
  cookieDomain: undefined,
});

/**
 * Decide what happens to a request.
 *
 * Outcomes:
 *   'restored'   — a valid assignment cookie was present. Nothing is re-rolled.
 *   'enrolled'   — no valid cookie and the request qualifies. A unit is minted.
 *   'ineligible' — no valid cookie and the request does not qualify.
 *
 * Two rules are load-bearing:
 *
 * 1. A PRESENT COOKIE IS NEVER RE-EVALUATED. Not against eligibility, not
 *    against a clock, not after ninety days. The original silently
 *    re-randomized enrolled units once `unixDay + 90` elapsed, which
 *    reassigns people mid-flight and quietly pools two treatments into one
 *    unit's history. Enrolment happens exactly once, ever.
 *
 * 2. INELIGIBLE VISITORS ARE NOT PERSISTED. They get no cookie, so a visitor
 *    who browses organically today and arrives on an ad tomorrow is enrolled
 *    tomorrow. Enrolment should happen at first QUALIFYING exposure, and
 *    stamping a permanent "ineligible" on someone who has not yet had that
 *    exposure would wrongly exclude them forever.
 */
export function decide({ url, headers, cookies = {}, spec, config = DEFAULT_CONFIG, now, newId, seeded = null }) {
  const existing = decodeAssignmentCookie(cookies[COOKIE_NAME]);

  // A verified token from a letter or email outranks a cookie.
  //
  // This is the one deliberate exception to rule 1 above, and it is not a
  // re-roll: the token carries an assignment decided server-side at mail time
  // for a known account, which is a stronger identity claim than an anonymous
  // browser cookie and is fixed for that recipient forever. Re-scanning the
  // same QR code always yields the same assignment.
  //
  // Honouring it is what makes mail-level randomization possible at all — if
  // the cookie won, anyone who had browsed before receiving their letter would
  // silently drop out of the mailing's assignment and the mail experiment's
  // denominator would stop matching what was sent.
  //
  // A disagreement between token and cookie is real and worth counting: it
  // means this device previously enrolled under a different unit. It is
  // reported rather than hidden, because a rising conflict rate means the
  // mailing list and the web population overlap more than the design assumed.
  if (seeded) {
    const conflict = existing && existing.assignmentId !== seeded.assignmentId
      ? existing.assignmentId
      : null;

    return {
      outcome: 'seeded',
      conflict,
      shouldSetCookie: !existing || conflict !== null,
      assignment: buildAssignment(
        seeded.assignmentId,
        existing && !conflict ? existing.enrolledAt : Math.floor(now / 1000),
        spec,
        config,
        { arm: seeded.arm, campaign: seeded.campaign },
      ),
    };
  }

  if (existing) {
    return {
      outcome: 'restored',
      shouldSetCookie: false,
      assignment: buildAssignment(existing.assignmentId, existing.enrolledAt, spec, config),
    };
  }

  const eligibility = checkEligibility(url, headers);
  if (!eligibility.eligible) {
    return {
      outcome: 'ineligible',
      reason: eligibility.reason,
      shouldSetCookie: false,
      assignment: null,
    };
  }

  const assignmentId = newId();
  const enrolledAt = Math.floor(now / 1000);

  return {
    outcome: 'enrolled',
    shouldSetCookie: true,
    assignment: buildAssignment(assignmentId, enrolledAt, spec, config),
  };
}

function buildAssignment(assignmentId, enrolledAt, spec, config, seed = {}) {
  // A token may pin the arm at mail time. When it does not, the arm is derived
  // from the id exactly as it is for web traffic, so a mailing can choose
  // per-drop whether to control the split itself or inherit the global one.
  const arm = seed.arm || deriveArm(assignmentId, config.testShareBps);

  // Two cases produce no barcode:
  //
  //   control units — there is no varied content to label. The original stored
  //     a visit counter (FC, RC1, RC2...) in the same analytics slot the test
  //     arm used for barcodes, putting two different data types in one field and
  //     making it unusable without knowing the arm first.
  //
  //   an empty spec (A/A) — both arms render identical content by definition, so
  //     a barcode would be a label for a distinction that does not exist.
  const varied = arm === ARM_TEST && spec.length > 0;

  return {
    assignmentId,
    enrolledAt,
    arm,
    barcode: varied ? deriveBarcode(assignmentId, spec) : null,
    factors: varied ? deriveFactors(assignmentId, spec) : null,
    // Which mailing this unit came from, so response can be attributed to a
    // specific drop rather than pooled across every letter ever sent.
    campaign: seed.campaign || null,
  };
}
