/**
 * The edge handler. THIS IS THE PORTABLE ARTIFACT.
 *
 * Written against the Fetch API signature Contentstack Launch edge functions
 * use verbatim:
 *
 *     export default function handler(request, context)
 *
 * with standard `Request`, `Response`, `URL` and `fetch`, and a `context`
 * carrying `env` and `waitUntil`. Nothing in this file or anything it imports
 * touches a Node built-in or a browser global.
 *
 * When Contentstack Launch lands at end of year, this file moves into
 * `functions/` and `adapters/do-node.js` is deleted. Nothing else changes.
 *
 * Bundle budget: Launch caps minified edge bundles at 1 MiB. This tree has no
 * dependencies, so there is plenty of headroom — but that is a property to
 * preserve deliberately, not to assume.
 */

import { decide, DEFAULT_CONFIG } from './lib/assign.js';
import { COOKIE_NAME, encodeAssignmentCookie, parseCookies, serializeCookie } from './lib/cookie.js';
import { specByName, specVersion } from './lib/spec.js';
import { verifyToken } from './lib/token.js';

/** Query parameter carrying the signed token. Short, because it rides in QR codes. */
export const TOKEN_PARAM = 'b';

export default async function handler(request, context = {}) {
  const env = context.env || {};
  const url = new URL(request.url);

  if (url.pathname === '/collect') {
    return handleCollect(request, context);
  }

  const spec = specByName(env.BREAD_SPEC || 'legacy');
  const config = configFromEnv(env);

  // A signed token from a QR code or link in a letter or email. Verification
  // failure is indistinguishable from absence on purpose — a URL that has been
  // through print, a scanner and a mail client has many ways to arrive damaged,
  // and the right response to all of them is to assign the visitor normally
  // rather than to fail the request.
  const seeded = env.BREAD_TOKEN_SECRET
    ? await verifyToken(url.searchParams.get(TOKEN_PARAM), env.BREAD_TOKEN_SECRET)
    : null;

  const decision = decide({
    url,
    headers: request.headers,
    cookies: parseCookies(request.headers.get('cookie')),
    spec,
    config,
    now: Date.now(),
    newId: () => crypto.randomUUID(),
    seeded,
  });

  const originResponse = await fetch(request);

  // Only HTML gets personalized. Assets pass through untouched so they stay
  // cacheable — the moment every response becomes uncacheable, mobile
  // performance goes with it.
  const contentType = originResponse.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    return originResponse;
  }

  const html = await originResponse.text();
  const response = new Response(
    injectBootstrap(html, decision, spec),
    originResponse,
  );

  response.headers.set('content-type', contentType);

  // The personalized document must never be shared between visitors. The
  // legacy stack served the control page from a cache keyed only loosely on
  // device class -- the root document came back with `x-cache: HIT` and
  // `x-cache-group: iphone` -- which is the most likely mechanism behind the
  // reported "control users got the test experience" leakage. A cached page
  // carrying one visitor's assignment will hand that assignment to everyone
  // who follows.
  response.headers.set('cache-control', 'private, no-store, max-age=0');
  response.headers.append('vary', 'Cookie');

  if (decision.shouldSetCookie) {
    response.headers.append(
      'set-cookie',
      serializeCookie(COOKIE_NAME, encodeAssignmentCookie(decision.assignment), {
        maxAge: config.cookieMaxAgeSeconds,
        domain: config.cookieDomain,
      }),
    );
  }

  return response;
}

function configFromEnv(env) {
  return {
    ...DEFAULT_CONFIG,
    ...(env.BREAD_TEST_SHARE_BPS
      ? { testShareBps: Number(env.BREAD_TEST_SHARE_BPS) }
      : {}),
    ...(env.BREAD_COOKIE_DOMAIN ? { cookieDomain: env.BREAD_COOKIE_DOMAIN } : {}),
  };
}

/**
 * Inject the assignment into the document, before the application boots.
 *
 * Two things go in, and they go in together on purpose:
 *
 *   window.__BREAD__   the assignment, for the SPA to READ. The client never
 *                      mints, never rolls, never writes. It renders what it is
 *                      told. This is the inversion of the original, where React
 *                      generated the barcode in a useEffect and every other
 *                      system raced to observe it.
 *
 *   dataLayer.push     the enrolment event, emitted from the same code path
 *                      that produced the assignment. In the original these were
 *                      separate — a loader polled localStorage every 50ms
 *                      waiting for React to write keys, then loaded a tracking
 *                      script that immediately no-op'd itself on the only page
 *                      where the barcode existed. Tracking that is emitted by
 *                      the assigner cannot race the assigner.
 *
 * The push happens before the GTM snippet runs, which is safe: `dataLayer` is a
 * plain array and GTM replays whatever it finds on initialisation.
 */
function injectBootstrap(html, decision, spec) {
  const payload = {
    outcome: decision.outcome,
    reason: decision.reason || null,
    specVersion: specVersion(spec),
    assignment: decision.assignment,
  };

  const snippet = `<script>window.__BREAD__=${safeJson(payload)};window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:"bread.assignment",bread_outcome:${safeJson(payload.outcome)},bread_assignment_id:${safeJson(decision.assignment?.assignmentId ?? null)},bread_arm:${safeJson(decision.assignment?.arm ?? null)},bread_barcode:${safeJson(decision.assignment?.barcode ?? null)},bread_campaign:${safeJson(decision.assignment?.campaign ?? null)},bread_conflict:${safeJson(decision.conflict ?? null)},bread_spec:${safeJson(payload.specVersion)}});</script>`;

  const headClose = html.indexOf('</head>');
  if (headClose === -1) {
    // No </head> is a malformed document, but refusing to serve it would be a
    // worse failure than serving it un-personalized.
    return html;
  }
  return html.slice(0, headClose) + snippet + html.slice(headClose);
}

/**
 * JSON for embedding inside a <script> element.
 *
 * `</script>` anywhere in the payload would close the element early, so `<` is
 * escaped. U+2028 and U+2029 are valid JSON but illegal raw in JS string
 * literals, so they go too.
 */
function safeJson(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Event collection.
 *
 * Deliberately minimal for now: it validates and stamps events server-side,
 * then hands them to a sink. What matters at this stage is that the assignment
 * is attached from the COOKIE rather than trusted from the request body — a
 * client that can claim its own assignment_id can corrupt attribution, and the
 * server already knows the true one.
 */
async function handleCollect(request, context) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const cookies = parseCookies(request.headers.get('cookie'));
  const assignment = cookies[COOKIE_NAME];
  if (!assignment) {
    // An event with no assignment cannot be attributed to anything. Count it
    // rather than dropping it silently: a rising unattributed rate is the
    // earliest signal that persistence is broken again.
    return new Response(JSON.stringify({ accepted: false, reason: 'no_assignment' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ accepted: false, reason: 'bad_json' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const event = {
    receivedAt: new Date().toISOString(),
    assignmentCookie: assignment,
    userAgent: request.headers.get('user-agent'),
    event: body?.event ?? null,
    properties: body?.properties ?? {},
  };

  // waitUntil lets the beacon be persisted without holding the response open.
  const sink = context.sink || ((e) => console.log(JSON.stringify(e)));
  if (typeof context.waitUntil === 'function') {
    context.waitUntil(Promise.resolve(sink(event)));
  } else {
    await sink(event);
  }

  return new Response(JSON.stringify({ accepted: true }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  });
}
