/**
 * Tests for mail/email assignment tokens.
 *
 * The mail channel randomizes at mail time rather than in a browser, so these
 * tests are about a different failure surface than assign.test.js: forgery,
 * damage in transit, and what happens when a mailed assignment meets a device
 * that already enrolled on its own.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { signToken, verifyToken } from '../src/lib/token.js';
import { decide, DEFAULT_CONFIG, ARM_TEST, ARM_CONTROL } from '../src/lib/assign.js';
import { COOKIE_NAME, encodeAssignmentCookie } from '../src/lib/cookie.js';
import { SPEC_LEGACY } from '../src/lib/spec.js';

const SECRET = 'test-secret-not-a-real-one';
const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

const mobileHeaders = () => new Headers({
  'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1',
});

describe('token signing', () => {
  test('round-trips an assignment', async () => {
    const token = await signToken({ assignmentId: ID, arm: ARM_TEST, campaign: 'q3-drop' }, SECRET);
    assert.deepEqual(await verifyToken(token, SECRET), {
      assignmentId: ID,
      arm: ARM_TEST,
      campaign: 'q3-drop',
    });
  });

  test('omitted arm and campaign come back null', async () => {
    const token = await signToken({ assignmentId: ID }, SECRET);
    const decoded = await verifyToken(token, SECRET);
    assert.equal(decoded.assignmentId, ID);
    assert.equal(decoded.arm, null);
    assert.equal(decoded.campaign, null);
  });

  test('stays short enough for a printed QR code', async () => {
    // Realistic campaign name, not a short one — every character costs
    // physical space and scan reliability on a letter. 160 keeps it inside a
    // version 6-7 QR at medium error correction.
    const token = await signToken(
      { assignmentId: ID, arm: ARM_TEST, campaign: '2026Q3-dunning-mobile' },
      SECRET,
    );
    assert.ok(token.length < 160, `token is ${token.length} chars`);
  });

  test('is URL-safe', async () => {
    const token = await signToken({ assignmentId: ID, campaign: 'q3-drop' }, SECRET);
    assert.equal(token, encodeURIComponent(token));
  });
});

describe('token verification rejects', () => {
  test('a tampered payload', async () => {
    // The attack that matters: editing the URL to select your own arm.
    const honest = await signToken({ assignmentId: ID, arm: ARM_CONTROL }, SECRET);
    const forged = await signToken({ assignmentId: ID, arm: ARM_TEST }, 'wrong-secret');
    assert.ok(await verifyToken(honest, SECRET));
    assert.equal(await verifyToken(forged, SECRET), null);
  });

  test('a flipped byte in the signature', async () => {
    const token = await signToken({ assignmentId: ID }, SECRET);
    const [body, mac] = token.split('.');
    const broken = `${body}.${mac.slice(0, -1)}${mac.at(-1) === 'A' ? 'B' : 'A'}`;
    assert.equal(await verifyToken(broken, SECRET), null);
  });

  test('a token signed under a rotated secret', async () => {
    const token = await signToken({ assignmentId: ID }, 'old-secret');
    assert.equal(await verifyToken(token, SECRET), null);
  });

  test('damage in transit, without throwing', async () => {
    // A URL that has been through print, a scanner and a mail client arrives
    // broken in many ways. All of them must degrade to "no token".
    const token = await signToken({ assignmentId: ID }, SECRET);
    const damaged = [
      '', 'garbage', '.', 'a.', '.b',
      token.slice(0, token.length / 2),        // truncated by a line wrap
      token.replace('.', ''),                  // separator lost
      token.toUpperCase(),                     // case-mangled by a scanner
      `${token}extra`,
    ];
    for (const bad of damaged) {
      assert.equal(await verifyToken(bad, SECRET), null, `should reject: ${bad}`);
    }
  });

  test('a missing secret', async () => {
    const token = await signToken({ assignmentId: ID }, SECRET);
    assert.equal(await verifyToken(token, null), null);
    assert.equal(await verifyToken(token, ''), null);
  });
});

describe('seeded assignment', () => {
  const args = (overrides = {}) => ({
    url: new URL('https://x.test/mcm/'),
    headers: mobileHeaders(),
    cookies: {},
    spec: SPEC_LEGACY,
    config: DEFAULT_CONFIG,
    now: 1700000000000,
    newId: () => assert.fail('must not mint an id when a token supplies one'),
    ...overrides,
  });

  test('a token enrols without any ad or mobile qualification', async () => {
    // Someone who received a letter is enrolled by definition. Requiring a
    // gclid would exclude the entire mail channel.
    const seeded = await verifyToken(
      await signToken({ assignmentId: ID, arm: ARM_TEST, campaign: 'q3' }, SECRET),
      SECRET,
    );
    const decision = decide(args({
      url: new URL('https://x.test/mcm/'),
      headers: new Headers({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }),
      seeded,
    }));

    assert.equal(decision.outcome, 'seeded');
    assert.equal(decision.assignment.assignmentId, ID);
    assert.equal(decision.assignment.arm, ARM_TEST);
    assert.equal(decision.assignment.campaign, 'q3');
    assert.equal(decision.shouldSetCookie, true);
  });

  test('a pinned arm overrides the derived one', async () => {
    // Mail-time randomization must win, or the mailing's split is not the
    // split that gets measured.
    const derived = decide(args({
      seeded: { assignmentId: ID, arm: null, campaign: null },
    })).assignment.arm;
    const pinned = derived === ARM_TEST ? ARM_CONTROL : ARM_TEST;

    const decision = decide(args({
      seeded: { assignmentId: ID, arm: pinned, campaign: null },
    }));
    assert.equal(decision.assignment.arm, pinned);
    assert.notEqual(decision.assignment.arm, derived);
  });

  test('an unpinned token derives its arm like web traffic', async () => {
    const decision = decide(args({ seeded: { assignmentId: ID, arm: null, campaign: null } }));
    assert.ok([ARM_TEST, ARM_CONTROL].includes(decision.assignment.arm));
  });

  test('re-scanning the same QR is stable and issues no new cookie', async () => {
    const seeded = { assignmentId: ID, arm: ARM_TEST, campaign: 'q3' };
    const first = decide(args({ seeded }));
    const second = decide(args({
      seeded,
      cookies: { [COOKIE_NAME]: encodeAssignmentCookie(first.assignment) },
    }));

    assert.equal(second.assignment.assignmentId, first.assignment.assignmentId);
    assert.equal(second.assignment.barcode, first.assignment.barcode);
    assert.equal(second.conflict, null);
    assert.equal(second.shouldSetCookie, false, 'no need to rewrite a matching cookie');
  });

  test('a token meeting a different existing assignment reports a conflict', async () => {
    // This device enrolled on its own before the letter arrived. The mailing
    // wins, but the collision is counted rather than hidden: a rising conflict
    // rate means the mailing list and the web population overlap more than the
    // design assumed.
    const prior = { assignmentId: 'bbbbbbbb-0000-4000-8000-000000000002', enrolledAt: 1699000000 };
    const decision = decide(args({
      seeded: { assignmentId: ID, arm: ARM_TEST, campaign: 'q3' },
      cookies: { [COOKIE_NAME]: encodeAssignmentCookie(prior) },
    }));

    assert.equal(decision.outcome, 'seeded');
    assert.equal(decision.assignment.assignmentId, ID);
    assert.equal(decision.conflict, prior.assignmentId);
    assert.equal(decision.shouldSetCookie, true);
  });

  test('web-only traffic is unaffected', async () => {
    // Everything above must not change behaviour when no token is present.
    const decision = decide({
      url: new URL('https://x.test/?gclid=T&utm_medium=cpc'),
      headers: mobileHeaders(),
      cookies: {},
      spec: SPEC_LEGACY,
      config: DEFAULT_CONFIG,
      now: 1700000000000,
      newId: () => ID,
    });
    assert.equal(decision.outcome, 'enrolled');
    assert.equal(decision.assignment.campaign, null);
    assert.equal(decision.conflict, undefined);
  });
});
