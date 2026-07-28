/**
 * The assignment cookie.
 *
 * One cookie. One value. Everything else — arm, factor levels, barcode — is a
 * pure function of the assignment_id inside it. There is deliberately nothing
 * else persisted anywhere, on the server or the client.
 *
 * Format: `1.<assignment_id>.<enrolled_at_unix_seconds>`
 *
 * The leading integer is a format version. When the format changes, unparseable
 * cookies are treated as absent and the visitor is re-enrolled — which is
 * correct, because a spec or format change means they are entering a different
 * experiment.
 */

export const COOKIE_NAME = 'bread_assignment';
const COOKIE_FORMAT_VERSION = '1';

export function parseCookies(header) {
  const jar = {};
  if (!header) return jar;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    jar[name] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return jar;
}

export function encodeAssignmentCookie({ assignmentId, enrolledAt }) {
  return `${COOKIE_FORMAT_VERSION}.${assignmentId}.${enrolledAt}`;
}

/**
 * Returns null for anything unparseable rather than throwing. A corrupt cookie
 * is a routine condition — truncation, a stale format, a visitor who edited it
 * — and the correct response is always to re-enrol, never to fail the request.
 */
export function decodeAssignmentCookie(value) {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;

  const [version, assignmentId, rawEnrolledAt] = parts;
  if (version !== COOKIE_FORMAT_VERSION) return null;
  if (!/^[0-9a-f-]{36}$/i.test(assignmentId)) return null;

  const enrolledAt = Number(rawEnrolledAt);
  if (!Number.isInteger(enrolledAt) || enrolledAt <= 0) return null;

  return { assignmentId, enrolledAt };
}

/**
 * Serialise a Set-Cookie header.
 *
 * The attributes here are the fix for the single worst defect in the original,
 * which wrote its barcode cookie from `document.cookie` with a SIXTY MINUTE
 * expiry. Two things matter:
 *
 *   HttpOnly  — implies the cookie was set by the server, which is what exempts
 *               it from Safari ITP's seven-day cap on script-written storage.
 *               Since the campaign targets mobile paid traffic, and therefore
 *               largely iOS Safari, this attribute is doing more work for
 *               persistence than the Max-Age is.
 *   Max-Age   — set to the experiment's full duration. A visitor returning next
 *               week must be the same unit they were on first exposure.
 *
 * `domain` is configurable and omitted by default, which yields a host-only
 * cookie. Two reasons it is not hardcoded:
 *
 *   - On DigitalOcean, `ondigitalocean.app` is on the Public Suffix List, so
 *     `Domain=.ondigitalocean.app` is silently rejected by the browser. Omitting
 *     the attribute is the only thing that works there.
 *   - In production the cookie likely needs `.midlandcredit.com` so that
 *     accounts.midlandcredit.com can read it — without that, assignment cannot
 *     be stitched to login success and the experiment measures nothing.
 */
export function serializeCookie(name, value, options = {}) {
  const {
    maxAge,
    path = '/',
    domain,
    secure = true,
    httpOnly = true,
    sameSite = 'Lax',
  } = options;

  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (path) parts.push(`Path=${path}`);
  if (domain) parts.push(`Domain=${domain}`);
  if (Number.isInteger(maxAge)) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push('Secure');
  if (httpOnly) parts.push('HttpOnly');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  return parts.join('; ');
}
