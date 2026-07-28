/**
 * Barcodes.
 *
 * The barcode is a DERIVED LABEL, not an identity. It is a pure function of the
 * assignment_id and the spec, which means it is never stored, never
 * synchronised, and never able to disagree with itself.
 *
 * This is the direct answer to the defect that sank the original run: six
 * storage keys spread across localStorage and sessionStorage, with reads
 * checking sessionStorage first, so a second tab could take a different read
 * path from the first. There is nothing here to fall out of sync because there
 * is nothing here to store.
 *
 * Everything downstream — the edge, the client, the warehouse — recomputes the
 * barcode from assignment_id whenever it needs it.
 */

import { indexFor } from './hash.js';

/**
 * Derive each factor's level from an assignment_id.
 *
 * Returns levels as 1-indexed integers keyed by factor name, e.g.
 * `{ headline: 4, subheadline: 11, loginForm: 2, ... }`.
 */
export function deriveFactors(assignmentId, spec) {
  const factors = {};
  for (const factor of spec) {
    factors[factor.name] = indexFor(assignmentId, factor.key, factor.count) + 1;
  }
  return factors;
}

/**
 * Render factors in the business-readable form, e.g. `H4-S11-L2-T1-G3-X2`.
 */
export function formatBarcode(factors, spec) {
  return spec.map((f) => `${f.key}${factors[f.name]}`).join('-');
}

/**
 * Parse a barcode string back into factor levels.
 *
 * Provided for the analytics pipeline, which will encounter barcodes as opaque
 * strings in event payloads and needs to decompose them into one column per
 * factor before anything can be analysed marginally.
 *
 * Validates against the spec rather than parsing loosely: a barcode that does
 * not match the spec it claims is a data-integrity problem worth failing on,
 * not a string to salvage.
 */
export function parseBarcode(barcode, spec) {
  const parts = String(barcode).split('-');
  if (parts.length !== spec.length) {
    throw new Error(
      `Barcode "${barcode}" has ${parts.length} factors, spec expects ${spec.length}`,
    );
  }

  const factors = {};
  for (let i = 0; i < spec.length; i++) {
    const factor = spec[i];
    const match = /^([A-Z]+)(\d+)$/.exec(parts[i]);
    if (!match) {
      throw new Error(`Barcode "${barcode}" has malformed segment "${parts[i]}"`);
    }
    const [, key, rawLevel] = match;
    if (key !== factor.key) {
      throw new Error(
        `Barcode "${barcode}" segment ${i} is "${key}", spec expects "${factor.key}"`,
      );
    }
    const level = Number(rawLevel);
    if (level < 1 || level > factor.count) {
      throw new Error(
        `Barcode "${barcode}" level ${key}${level} is outside 1..${factor.count}`,
      );
    }
    factors[factor.name] = level;
  }
  return factors;
}

/**
 * Convenience: assignment_id straight to barcode string.
 */
export function deriveBarcode(assignmentId, spec) {
  return formatBarcode(deriveFactors(assignmentId, spec), spec);
}
