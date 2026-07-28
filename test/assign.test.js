/**
 * Tests for the assignment core.
 *
 * These are organised around the post-mortem's findings rather than around the
 * module layout: each block pins down a property whose absence caused a real,
 * observed failure in the original run. A test named after the defect it
 * prevents is harder to delete by accident than one named after a function.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decide, deriveArm, DEFAULT_CONFIG, ARM_TEST, ARM_CONTROL } from '../src/lib/assign.js';
import { deriveBarcode, deriveFactors, formatBarcode, parseBarcode } from '../src/lib/barcode.js';
import { checkEligibility, isAdsVisitor, isMobile } from '../src/lib/eligibility.js';
import { COOKIE_NAME, decodeAssignmentCookie, encodeAssignmentCookie, parseCookies, serializeCookie } from '../src/lib/cookie.js';
import { SPEC_LEGACY, SPEC_FOCUSED } from '../src/lib/spec.js';
import { indexFor } from '../src/lib/hash.js';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const adsUrl = () => new URL('https://example.com/?gclid=TEST123&utm_source=google&utm_medium=cpc');
const mobileHeaders = () => new Headers({ 'user-agent': MOBILE_UA });

function uuidFactory() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

describe('barcode derivation (defect 2.4: six storage keys out of sync)', () => {
  test('the barcode is a pure function of the assignment id', () => {
    const id = 'a1b2c3d4-0000-4000-8000-000000000001';
    const first = deriveBarcode(id, SPEC_LEGACY);
    const second = deriveBarcode(id, SPEC_LEGACY);
    assert.equal(first, second);
  });

  test('derivation is stable across repeated calls with no shared state', () => {
    // The property that lets the edge, the client and the warehouse each
    // recompute the barcode without coordinating.
    const ids = Array.from({ length: 200 }, (_, i) => `id-${i}`);
    const round1 = ids.map((id) => deriveBarcode(id, SPEC_LEGACY));
    const round2 = ids.map((id) => deriveBarcode(id, SPEC_LEGACY));
    assert.deepEqual(round1, round2);
  });

  test('barcode includes the login form factor', () => {
    // The legacy format H1-S2-T3-G2-X1 omitted L, the factor nearest the
    // conversion event.
    const barcode = deriveBarcode('some-id', SPEC_LEGACY);
    assert.match(barcode, /(^|-)L\d+(-|$)/);
  });

  test('format and parse round-trip', () => {
    const factors = deriveFactors('round-trip-id', SPEC_LEGACY);
    const barcode = formatBarcode(factors, SPEC_LEGACY);
    assert.deepEqual(parseBarcode(barcode, SPEC_LEGACY), factors);
  });

  test('parsing rejects a barcode from a different spec', () => {
    const barcode = deriveBarcode('x', SPEC_FOCUSED);
    assert.throws(() => parseBarcode(barcode, SPEC_LEGACY), /factors, spec expects/);
  });

  test('every level stays inside its declared range', () => {
    for (let i = 0; i < 1000; i++) {
      const factors = deriveFactors(`range-${i}`, SPEC_LEGACY);
      for (const factor of SPEC_LEGACY) {
        const level = factors[factor.name];
        assert.ok(level >= 1 && level <= factor.count, `${factor.key}${level} out of range`);
      }
    }
  });
});

describe('randomization quality', () => {
  /**
   * Chi-square goodness of fit against a uniform distribution.
   *
   * Independent, uniform draws per factor are the precondition that makes
   * marginal analysis valid. If this degrades, the analysis silently stops
   * being sound while still producing numbers — the worst failure mode
   * available, and worth a test rather than an assumption.
   */
  function chiSquare(counts, expected) {
    return counts.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
  }

  test('each factor is uniform across levels', () => {
    const N = 60000;
    // Critical values at p=0.001 for df = count-1.
    const critical = { 12: 31.26, 17: 39.25, 3: 13.82, 4: 16.27 };

    for (const factor of SPEC_LEGACY) {
      const counts = new Array(factor.count).fill(0);
      for (let i = 0; i < N; i++) {
        counts[indexFor(`unit-${i}`, factor.key, factor.count)]++;
      }
      const stat = chiSquare(counts, N / factor.count);
      assert.ok(
        stat < critical[factor.count],
        `${factor.name}: chi-square ${stat.toFixed(2)} exceeds ${critical[factor.count]}`,
      );
    }
  });

  test('factors are independent of one another', () => {
    // Headline and login form drawn together should show no association.
    // 2x2 collapsed contingency, chi-square with 1 df, p=0.001 critical 10.83.
    const N = 60000;
    const table = [[0, 0], [0, 0]];
    for (let i = 0; i < N; i++) {
      const h = indexFor(`unit-${i}`, 'H', 12) < 6 ? 0 : 1;
      const l = indexFor(`unit-${i}`, 'L', 3) < 1.5 ? 0 : 1;
      table[h][l]++;
    }
    const rowSums = table.map((r) => r[0] + r[1]);
    const colSums = [table[0][0] + table[1][0], table[0][1] + table[1][1]];
    let stat = 0;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const expected = (rowSums[r] * colSums[c]) / N;
        stat += (table[r][c] - expected) ** 2 / expected;
      }
    }
    assert.ok(stat < 10.83, `headline/login association chi-square ${stat.toFixed(2)}`);
  });

  test('arm split honours the configured share (SRM check)', () => {
    // This is the automated check that would have caught the original
    // control/test leakage on day one.
    const N = 60000;
    let testCount = 0;
    for (let i = 0; i < N; i++) {
      if (deriveArm(`srm-${i}`, 5000) === ARM_TEST) testCount++;
    }
    const expected = N / 2;
    const stat = ((testCount - expected) ** 2) / expected + ((N - testCount - expected) ** 2) / expected;
    assert.ok(stat < 10.83, `SRM chi-square ${stat.toFixed(2)}, test arm got ${testCount}/${N}`);
  });

  test('a non-even split is respected', () => {
    const N = 40000;
    let testCount = 0;
    for (let i = 0; i < N; i++) {
      if (deriveArm(`ramp-${i}`, 1000) === ARM_TEST) testCount++;
    }
    const share = testCount / N;
    assert.ok(Math.abs(share - 0.1) < 0.01, `expected ~10% test, got ${(share * 100).toFixed(2)}%`);
  });
});

describe('eligibility (defect 2.7: silent untracked default)', () => {
  test('recognises Google Ads click identifiers including the iOS ones', () => {
    for (const param of ['gclid', 'gbraid', 'wbraid', 'msclkid']) {
      assert.ok(isAdsVisitor(new URL(`https://x.test/?${param}=abc`)), param);
    }
  });

  test('recognises paid utm_medium without a click id', () => {
    assert.ok(isAdsVisitor(new URL('https://x.test/?utm_medium=cpc')));
    assert.ok(!isAdsVisitor(new URL('https://x.test/?utm_medium=email')));
  });

  test('organic traffic is not an ads visitor', () => {
    assert.ok(!isAdsVisitor(new URL('https://x.test/')));
  });

  test('client hints take precedence over the user agent', () => {
    // A desktop UA with the mobile hint set should be treated as mobile.
    assert.ok(isMobile(new Headers({ 'sec-ch-ua-mobile': '?1', 'user-agent': DESKTOP_UA })));
    assert.ok(!isMobile(new Headers({ 'sec-ch-ua-mobile': '?0', 'user-agent': MOBILE_UA })));
  });

  test('falls back to user agent when no hint is present', () => {
    assert.ok(isMobile(new Headers({ 'user-agent': MOBILE_UA })));
    assert.ok(!isMobile(new Headers({ 'user-agent': DESKTOP_UA })));
  });

  test('ineligibility carries a reason', () => {
    assert.equal(
      checkEligibility(new URL('https://x.test/'), mobileHeaders()).reason,
      'not_paid_traffic',
    );
    assert.equal(
      checkEligibility(adsUrl(), new Headers({ 'user-agent': DESKTOP_UA })).reason,
      'not_mobile',
    );
  });
});

describe('enrolment', () => {
  const baseArgs = () => ({
    url: adsUrl(),
    headers: mobileHeaders(),
    cookies: {},
    spec: SPEC_LEGACY,
    config: DEFAULT_CONFIG,
    now: 1700000000000,
    newId: uuidFactory(),
  });

  test('an eligible visitor is enrolled and gets a cookie', () => {
    const decision = decide(baseArgs());
    assert.equal(decision.outcome, 'enrolled');
    assert.equal(decision.shouldSetCookie, true);
    assert.ok(decision.assignment.assignmentId);
  });

  test('an ineligible visitor is NOT persisted (so they can enrol later)', () => {
    // Stamping "ineligible" permanently would exclude anyone who browses
    // organically before ever clicking an ad.
    const decision = decide({ ...baseArgs(), url: new URL('https://x.test/') });
    assert.equal(decision.outcome, 'ineligible');
    assert.equal(decision.shouldSetCookie, false);
    assert.equal(decision.assignment, null);
  });

  test('a visitor ineligible today can enrol tomorrow', () => {
    const organic = decide({ ...baseArgs(), url: new URL('https://x.test/') });
    assert.equal(organic.outcome, 'ineligible');
    const later = decide(baseArgs());
    assert.equal(later.outcome, 'enrolled');
  });

  test('control units carry no barcode', () => {
    // The original put a visit counter (FC, RC1, RC2...) in the same analytics
    // slot the test arm used for barcodes, mixing two data types in one field.
    let sawControl = false;
    const newId = uuidFactory();
    for (let i = 0; i < 50 && !sawControl; i++) {
      const decision = decide({ ...baseArgs(), newId });
      if (decision.assignment.arm === ARM_CONTROL) {
        sawControl = true;
        assert.equal(decision.assignment.barcode, null);
        assert.equal(decision.assignment.factors, null);
      }
    }
    assert.ok(sawControl, 'no control unit produced in 50 draws');
  });

  test('test units carry a barcode matching the spec', () => {
    let sawTest = false;
    const newId = uuidFactory();
    for (let i = 0; i < 50 && !sawTest; i++) {
      const decision = decide({ ...baseArgs(), newId });
      if (decision.assignment.arm === ARM_TEST) {
        sawTest = true;
        assert.doesNotThrow(() => parseBarcode(decision.assignment.barcode, SPEC_LEGACY));
      }
    }
    assert.ok(sawTest, 'no test unit produced in 50 draws');
  });
});

describe('persistence (defects 2.1, 2.5: 60-minute cookie, 90-day re-roll)', () => {
  const cookieFor = (assignment) => ({
    [COOKIE_NAME]: encodeAssignmentCookie(assignment),
  });

  test('a returning visitor is restored, not re-enrolled', () => {
    const first = decide({
      url: adsUrl(),
      headers: mobileHeaders(),
      cookies: {},
      spec: SPEC_LEGACY,
      config: DEFAULT_CONFIG,
      now: 1700000000000,
      newId: uuidFactory(),
    });

    const second = decide({
      url: adsUrl(),
      headers: mobileHeaders(),
      cookies: cookieFor(first.assignment),
      spec: SPEC_LEGACY,
      config: DEFAULT_CONFIG,
      now: 1700000000000,
      newId: () => assert.fail('must not mint a new id for a returning visitor'),
    });

    assert.equal(second.outcome, 'restored');
    assert.equal(second.shouldSetCookie, false);
    assert.equal(second.assignment.assignmentId, first.assignment.assignmentId);
    assert.equal(second.assignment.barcode, first.assignment.barcode);
    assert.equal(second.assignment.arm, first.assignment.arm);
  });

  test('assignment survives an arbitrarily long gap', () => {
    // The original re-randomized after 90 days. Two years must change nothing.
    const enrolledAt = 1700000000;
    const assignment = { assignmentId: 'aaaaaaaa-0000-4000-8000-000000000001', enrolledAt };
    const decision = decide({
      url: adsUrl(),
      headers: mobileHeaders(),
      cookies: cookieFor(assignment),
      spec: SPEC_LEGACY,
      config: DEFAULT_CONFIG,
      now: (enrolledAt + 730 * 24 * 60 * 60) * 1000,
      newId: () => assert.fail('must not re-roll an enrolled unit'),
    });
    assert.equal(decision.outcome, 'restored');
    assert.equal(decision.assignment.assignmentId, assignment.assignmentId);
  });

  test('a restored visitor keeps their assignment even when now ineligible', () => {
    // Returning organically after an ad click must not drop them from the test.
    const assignment = { assignmentId: 'bbbbbbbb-0000-4000-8000-000000000002', enrolledAt: 1700000000 };
    const decision = decide({
      url: new URL('https://x.test/'),
      headers: new Headers({ 'user-agent': DESKTOP_UA }),
      cookies: cookieFor(assignment),
      spec: SPEC_LEGACY,
      config: DEFAULT_CONFIG,
      now: 1700000000000,
      newId: () => assert.fail('must not re-roll'),
    });
    assert.equal(decision.outcome, 'restored');
  });

  test('the cookie is HttpOnly, Secure and long-lived', () => {
    const header = serializeCookie(COOKIE_NAME, 'v', {
      maxAge: DEFAULT_CONFIG.cookieMaxAgeSeconds,
    });
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Max-Age=15552000/);
    // Host-only unless a domain is configured: `ondigitalocean.app` is a public
    // suffix and rejects a Domain attribute outright.
    assert.ok(!/Domain=/.test(header));
  });

  test('a configured domain is emitted for production', () => {
    const header = serializeCookie(COOKIE_NAME, 'v', { domain: '.midlandcredit.com' });
    assert.match(header, /Domain=\.midlandcredit\.com/);
  });

  test('corrupt cookies are treated as absent rather than throwing', () => {
    for (const bad of ['', 'garbage', '1.not-a-uuid.123', '9.aaaaaaaa-0000-4000-8000-000000000001.1', '1.aaaaaaaa-0000-4000-8000-000000000001.notanumber']) {
      assert.equal(decodeAssignmentCookie(bad), null, `should reject: ${bad}`);
    }
  });

  test('cookie round-trips through a real Cookie header', () => {
    const assignment = { assignmentId: 'cccccccc-0000-4000-8000-000000000003', enrolledAt: 1700000000 };
    const header = `foo=bar; ${COOKIE_NAME}=${encodeAssignmentCookie(assignment)}; baz=qux`;
    const decoded = decodeAssignmentCookie(parseCookies(header)[COOKIE_NAME]);
    assert.deepEqual(decoded, assignment);
  });
});
