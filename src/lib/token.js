/**
 * Signed assignment tokens, for QR codes and links in letters and emails.
 *
 * A token carries an assignment that was decided server-side at MAIL TIME,
 * before the visit exists. This is a strictly better randomization point than a
 * coin flip in a browser:
 *
 *   - No cookie is needed for first touch, so ITP cannot interfere.
 *   - The denominator is known exactly. You sent N letters, so sample ratio
 *     mismatch becomes arithmetic rather than inference.
 *   - The unit is an account, which means outcomes can be followed through to
 *     payment instead of stopping at login as a proxy.
 *
 * Signing exists because the token appears in a URL that anyone can edit. An
 * unsigned assignment in a query string is an invitation to self-select into an
 * arm, which would quietly bias the result. Verification failures are treated
 * as "no token" — the visitor is simply assigned normally.
 *
 * QR DENSITY: tokens land in printed QR codes, where every character costs
 * physical space and scan reliability. The payload uses single-letter keys and
 * the MAC is truncated to 16 bytes — standard practice per RFC 2104, and far
 * more forgery resistance than this threat model needs.
 *
 * A full token (uuid + arm + campaign name) runs about 130 characters, which
 * fits a version 6-7 QR at medium error correction and prints comfortably at
 * normal letter sizes. If print ever needs it smaller, the win is packing the
 * UUID as 16 raw bytes instead of its 36-character text form, which would take
 * the whole token to roughly 75 characters. Not done yet because it trades
 * legibility in logs and CSVs for space nobody has asked for.
 */

const MAC_BYTES = 16;

function b64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, message);
  return new Uint8Array(signature).slice(0, MAC_BYTES);
}

/**
 * Compare in constant time.
 *
 * A byte-by-byte early return leaks how much of the MAC matched via timing,
 * which is enough to forge one byte at a time given enough attempts.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/**
 * Mint a token for a mailing.
 *
 * `assignmentId` is the unit. `arm` is optional: include it to pin the arm at
 * mail time (the usual case for a mail-randomized experiment), omit it to let
 * the arm be derived from the id as it is for web traffic.
 *
 * `campaign` identifies the mailing, so response can be attributed to a
 * specific drop rather than pooled across every letter ever sent.
 */
export async function signToken({ assignmentId, arm, campaign }, secret) {
  if (!secret) throw new Error('signToken: secret is required');

  const payload = { i: assignmentId };
  if (arm) payload.a = arm;
  if (campaign) payload.c = campaign;

  const body = new TextEncoder().encode(JSON.stringify(payload));
  const mac = await hmac(secret, body);
  return `${b64urlEncode(body)}.${b64urlEncode(mac)}`;
}

/**
 * Verify and decode a token.
 *
 * Returns null for anything that does not verify — malformed, truncated by a
 * mail client, tampered with, or signed under a rotated secret. Never throws:
 * a bad token is a routine condition on a URL that has been through print,
 * scanning, and a dozen mail clients, and the right response is always to fall
 * back to normal assignment rather than to fail the request.
 */
export async function verifyToken(token, secret) {
  if (!token || !secret) return null;

  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;

  try {
    const body = b64urlDecode(token.slice(0, dot));
    const presented = b64urlDecode(token.slice(dot + 1));
    const expected = await hmac(secret, body);
    if (!timingSafeEqual(presented, expected)) return null;

    const payload = JSON.parse(new TextDecoder().decode(body));
    if (!payload || typeof payload.i !== 'string') return null;

    return {
      assignmentId: payload.i,
      arm: payload.a || null,
      campaign: payload.c || null,
    };
  } catch {
    return null;
  }
}
