/**
 * FNV-1a, 32-bit.
 *
 * Chosen because it is dependency-free, synchronous, and byte-identical across
 * every runtime this code runs in. That last property is the point: the same
 * assignment_id must derive the same barcode at the Contentstack edge, in the
 * DigitalOcean adapter, and in whatever queries the analytics warehouse. A
 * hash that disagreed between those places would silently corrupt attribution
 * in a way no test on a single runtime would catch.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a(input) {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Math.imul keeps the multiply in 32-bit space; a plain `*` would overflow
    // into float territory and diverge from the reference implementation.
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * Map a seed to an integer in [0, n) under a named salt.
 *
 * Each factor uses its own salt so that draws are independent of one another —
 * the property that makes marginal analysis valid. Without distinct salts every
 * factor would draw from the same hash and the barcode would collapse to a
 * single degree of freedom.
 *
 * Modulo bias is bounded by n / 2^32, under 1e-8 for the factor sizes here.
 * That is many orders of magnitude below the noise floor of any test this
 * traffic can power, so rejection sampling would buy nothing real.
 */
export function indexFor(seed, salt, n) {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`indexFor: n must be a positive integer, got ${n}`);
  }
  return fnv1a(`${salt}:${seed}`) % n;
}
