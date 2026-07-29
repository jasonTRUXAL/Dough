#!/usr/bin/env node
/**
 * Mint signed assignment tokens for a mailing.
 *
 * Produces one row per recipient, ready to merge into a print or email run.
 * Randomization happens HERE — server-side, at mail time, before any visit
 * exists — which is why the mail channel avoids the entire class of browser
 * persistence problems that sank the original experiment.
 *
 * Usage:
 *   BREAD_TOKEN_SECRET=... node tools/mint-tokens.js \
 *     --count 50000 --campaign 2026Q3-dunning --base https://www.midlandcredit.com/mcm/
 *
 *   BREAD_TOKEN_SECRET=... node tools/mint-tokens.js \
 *     --accounts accounts.txt --campaign 2026Q3-dunning --split 5000
 *
 * Options:
 *   --count N        mint N tokens with generated ids
 *   --accounts FILE  one account reference per line; ids are derived from these
 *                    so the same account always gets the same assignment across
 *                    re-runs and re-mailings
 *   --campaign NAME  identifies the drop (required)
 *   --split BPS      basis points of 10,000 assigned to test. Omit to let the
 *                    arm be derived from the id like web traffic.
 *   --base URL       prefix the token with a full landing URL
 *   --format         csv (default) or json
 *
 * Output is written to stdout. Redirect it; do not paste it into a ticket —
 * a token is a valid assignment claim for whoever holds it.
 */

import { readFile } from 'node:fs/promises';
import { signToken } from '../src/lib/token.js';
import { deriveArm, ARM_TEST, ARM_CONTROL } from '../src/lib/assign.js';
import { fnv1a } from '../src/lib/hash.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

/**
 * Derive a stable id from an account reference.
 *
 * Deterministic so that re-running the mint, or mailing the same account again
 * in a later drop, produces the same unit rather than silently re-randomizing
 * someone who is already enrolled.
 *
 * The reference is hashed rather than embedded: the token travels in a URL that
 * ends up in browser history, referrer headers, and analytics, and an account
 * reference does not belong in any of those.
 */
function idForAccount(reference, campaign) {
  const h1 = fnv1a(`${campaign}:${reference}`).toString(16).padStart(8, '0');
  const h2 = fnv1a(`${reference}:${campaign}`).toString(16).padStart(8, '0');
  const h3 = fnv1a(`bread:${reference}`).toString(16).padStart(8, '0');
  const h4 = fnv1a(`${reference}`).toString(16).padStart(8, '0');
  // Shaped as a UUID so it satisfies the cookie's format check.
  return `${h1}-${h2.slice(0, 4)}-4${h2.slice(4, 7)}-8${h3.slice(0, 3)}-${h3.slice(3, 8)}${h4.slice(0, 7)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const secret = process.env.BREAD_TOKEN_SECRET;

  if (!secret) {
    console.error('BREAD_TOKEN_SECRET is required. Use the same value the edge handler has.');
    process.exit(1);
  }
  if (!args.campaign) {
    console.error('--campaign is required. Without it, drops pool together and cannot be compared.');
    process.exit(1);
  }
  if (!args.count && !args.accounts) {
    console.error('Provide either --count or --accounts.');
    process.exit(1);
  }

  let ids;
  if (args.accounts) {
    const lines = (await readFile(args.accounts, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    ids = lines.map((reference) => idForAccount(reference, args.campaign));
  } else {
    ids = Array.from({ length: Number(args.count) }, () => crypto.randomUUID());
  }

  const splitBps = args.split === undefined ? null : Number(args.split);
  const rows = [];
  let testCount = 0;

  for (const assignmentId of ids) {
    const arm = splitBps === null ? undefined : deriveArm(assignmentId, splitBps);
    if (arm === ARM_TEST || (arm === undefined && deriveArm(assignmentId, 5000) === ARM_TEST)) {
      testCount++;
    }
    const token = await signToken({ assignmentId, arm, campaign: args.campaign }, secret);
    rows.push({
      assignment_id: assignmentId,
      arm: arm || '(derived)',
      campaign: args.campaign,
      token,
      url: args.base ? `${args.base}${args.base.includes('?') ? '&' : '?'}b=${token}` : '',
    });
  }

  if (args.format === 'json') {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  } else {
    process.stdout.write('assignment_id,arm,campaign,token,url\n');
    for (const row of rows) {
      process.stdout.write(
        `${row.assignment_id},${row.arm},${row.campaign},${row.token},${row.url}\n`,
      );
    }
  }

  // To stderr so it survives redirection of the data itself. The mail team
  // should reconcile this count against what actually ships — that reconciliation
  // is the mail channel's version of an SRM check, and it is exact rather than
  // statistical because the denominator is known.
  console.error(
    `[bread] minted ${rows.length} tokens for "${args.campaign}" `
    + `(${testCount} test / ${rows.length - testCount} control, `
    + `${splitBps === null ? 'derived' : `${splitBps} bps`})`,
  );
  console.error(`[bread] token length: ~${rows[0]?.token.length ?? 0} chars`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
