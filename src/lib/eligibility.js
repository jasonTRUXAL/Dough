/**
 * Eligibility: is this request a mobile paid-search visitor?
 *
 * Detection runs server-side, on the request, before anything renders. That is
 * the whole difference from the original implementation — it is not that
 * client-side detection is wrong (a gclid in the URL is perfectly readable from
 * JS), but that a decision made after render cannot govern what was rendered.
 */

/**
 * Click identifiers that mark a paid ad arrival.
 *
 * gclid is the classic Google Ads parameter. gbraid and wbraid are its iOS
 * privacy-era replacements and are easy to forget — omitting them would silently
 * drop a large share of exactly the mobile iOS traffic this experiment targets.
 */
const AD_CLICK_PARAMS = ['gclid', 'gbraid', 'wbraid', 'msclkid'];

const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paidsearch', 'paid-search']);

export function isAdsVisitor(url) {
  for (const param of AD_CLICK_PARAMS) {
    if (url.searchParams.has(param)) return true;
  }
  const medium = url.searchParams.get('utm_medium');
  return medium ? PAID_MEDIUMS.has(medium.toLowerCase()) : false;
}

/**
 * Mobile detection, preferring Client Hints over user-agent sniffing.
 *
 * `Sec-CH-UA-Mobile` is a structured boolean ("?1" / "?0") sent by Chromium
 * browsers and is authoritative when present. Safari does not send it, so the
 * UA fallback still carries most iOS traffic — which is the majority of what we
 * care about here.
 */
export function isMobile(headers) {
  const clientHint = headers.get('sec-ch-ua-mobile');
  if (clientHint === '?1') return true;
  if (clientHint === '?0') return false;

  const ua = headers.get('user-agent') || '';
  return /Android|iPhone|iPod|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(ua)
    // iPadOS reports a desktop UA but keeps the touch platform, so treat any
    // Macintosh with touch points as mobile.
    || (/Macintosh/.test(ua) && /Mobile/.test(ua));
}

/**
 * Is this request eligible for enrolment?
 *
 * Returns a reason alongside the verdict so ineligibility is countable rather
 * than silent. The original defaulted to an "Ineligible" arm with no record of
 * why, which made it impossible to tell a targeting problem from a traffic
 * problem after the fact.
 */
export function checkEligibility(url, headers) {
  if (!isAdsVisitor(url)) {
    return { eligible: false, reason: 'not_paid_traffic' };
  }
  if (!isMobile(headers)) {
    return { eligible: false, reason: 'not_mobile' };
  }
  return { eligible: true, reason: 'eligible' };
}
