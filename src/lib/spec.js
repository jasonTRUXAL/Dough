/**
 * Factor specifications.
 *
 * A spec is an ordered list of factors. Order is load-bearing: it determines
 * the barcode's textual form, so reordering a spec invalidates every barcode
 * ever emitted under it. Add factors at the end; never reorder or renumber.
 *
 * Levels are 1-indexed in the barcode (H1..H12) to match the legacy notation
 * the business already reads.
 *
 * IMMUTABILITY RULE
 * -----------------
 * A level's content may never be redefined in place. If headline 3's copy
 * changes, it becomes headline 13 and H3 is retired. This is required twice
 * over: statistically, because redefining a level mid-flight silently pools two
 * different treatments into one estimate; and for FDCPA / Reg F, because we
 * must be able to reconstruct exactly what a given consumer saw on a given
 * date. Retire levels by dropping their `count` coverage in a new spec version,
 * not by editing them.
 */

/**
 * The original Project Bread inventory, reproduced for continuity with the
 * existing content library.
 *
 * Note `L` (login form) is present here. The legacy barcode format documented
 * as `H1-S2-T3-G2-X1` omitted it, which — if that reflected the shipped code —
 * meant the factor nearest the conversion event went unrecorded. It is included
 * from the start here.
 *
 * 12 x 17 x 3 x 3 x 4 x 3 = 22,032 combinations. That number is fine for
 * MARGINAL analysis (each level estimated across every session that saw it) and
 * hopeless for cell-level analysis. See docs/bread-postmortem.md section 4.
 */
export const SPEC_LEGACY = Object.freeze([
  Object.freeze({ key: 'H', name: 'headline', count: 12 }),
  Object.freeze({ key: 'S', name: 'subheadline', count: 17 }),
  Object.freeze({ key: 'L', name: 'loginForm', count: 3 }),
  Object.freeze({ key: 'T', name: 'theme', count: 3 }),
  Object.freeze({ key: 'G', name: 'heroGraphic', count: 4 }),
  Object.freeze({ key: 'X', name: 'securityIcon', count: 3 }),
]);

/**
 * The recommended live spec: the two factors nearest the conversion event, at
 * three levels each.
 *
 * Ordered by expected effect size, the factors run
 * login form > headline > subheadline > hero graphic > security icon ~ theme.
 * Theme colour and security icons are very likely below the detection floor at
 * any traffic level available here. Randomizing them costs nothing in code and
 * a great deal in traffic, so they are held fixed rather than tested.
 *
 * 3 x 3 = 9 combinations, ~16,700 sessions per level at 50k — which is roughly
 * the minimum to detect a 10% relative lift on a 10% base rate.
 */
export const SPEC_FOCUSED = Object.freeze([
  Object.freeze({ key: 'L', name: 'loginForm', count: 3 }),
  Object.freeze({ key: 'H', name: 'headline', count: 3 }),
]);

/**
 * The A/A spec: no factors at all.
 *
 * Units are still enrolled, still assigned an arm, still persisted, still
 * tracked — but both arms render identical content. Since nothing differs, a
 * correct pipeline must report no difference. If it reports a winner, the
 * pipeline is broken, and you have found that out for the price of a few weeks
 * of traffic rather than a quarter and another failed programme.
 *
 * This is what to run first. See docs/experiment-design.md for the acceptance
 * criteria.
 */
export const SPEC_AA = Object.freeze([]);

const SPECS = {
  aa: SPEC_AA,
  legacy: SPEC_LEGACY,
  focused: SPEC_FOCUSED,
};

/**
 * A short label identifying which spec produced an assignment, carried on every
 * event so that analysis can never silently pool results from two different
 * spec versions.
 */
export function specVersion(spec) {
  return spec.length === 0 ? 'AA' : spec.map((f) => `${f.key}${f.count}`).join('');
}

export function specByName(name) {
  const spec = SPECS[name];
  if (!spec) {
    throw new Error(
      `Unknown spec "${name}". Available: ${Object.keys(SPECS).join(', ')}`,
    );
  }
  return spec;
}
