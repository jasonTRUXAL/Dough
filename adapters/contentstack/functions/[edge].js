/**
 * Contentstack Launch edge function entry point.
 *
 * The entire adapter. `src/handler.js` already has the exact signature Launch
 * expects — `handler(request, context)` over the Fetch API — so there is
 * nothing to translate.
 *
 * At migration time (end of year): move this file to `functions/[edge].js` at
 * the project root, set BREAD_SPEC / BREAD_COOKIE_DOMAIN / BREAD_TEST_SHARE_BPS
 * as Launch environment variables, and delete `adapters/do-node.js`.
 *
 * BREAD_COOKIE_DOMAIN matters on the way over. On DigitalOcean it must be unset
 * — `ondigitalocean.app` is a public suffix, so a Domain attribute is silently
 * rejected. In production it should be `.midlandcredit.com` so that
 * accounts.midlandcredit.com can read the assignment; without that the login
 * conversion cannot be stitched to the experiment.
 */

export { default } from '../../../src/handler.js';
