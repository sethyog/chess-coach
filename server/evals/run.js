'use strict';

// Master eval runner. Runs all evals and prints a final scorecard.
// Usage: node evals/run.js
// Tip:   EVALS_LIVE_API=1 node evals/run.js  — enables live API coaching checks

const positionFacts = require('./deterministic/position_facts.eval');
const routing = require('./deterministic/routing.eval');
const scoping = require('./deterministic/scoping.eval');
const coachingAdherence = require('./fact_adherence/coaching_adherence.eval');

async function main() {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  Chess Coach Eval Harness');
  console.log('══════════════════════════════════════════════════════════════════');

  const allResults = await Promise.all([
    positionFacts.run(),
    routing.run(),
    scoping.run(),
    coachingAdherence.run(),
  ]);

  const [pfResult, routingResult, scopingResult, adherenceResult] = allResults;

  // ── Scorecard ──────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  SCORECARD');
  console.log('══════════════════════════════════════════════════════════════════');

  function scoreLine(label, result) {
    const { total, passed, skipped } = result;
    const active = total - (skipped || 0);
    const allPass = passed === active;
    const icon = allPass ? '✓' : '✗';
    const skipNote = skipped ? ` (${skipped} skipped)` : '';
    console.log(`  ${icon}  ${label.padEnd(36)} ${passed}/${active}${skipNote}`);
  }

  console.log('');
  console.log('  Deterministic');
  scoreLine('position_facts', pfResult);
  scoreLine('routing', routingResult);
  scoreLine('scoping', scopingResult);

  console.log('');
  console.log('  Fact-adherence (stored replies)');
  scoreLine('coaching_adherence', adherenceResult);
  const v = adherenceResult.totalViolations;
  console.log(
    `     violations: piece_position=${v.piece_position}  side_to_move=${v.side_to_move}  move_legality=${v.move_legality}`
  );

  // ── Overall ────────────────────────────────────────────────────────────────
  const grandTotal = allResults.reduce((s, r) => s + (r.total - (r.skipped || 0)), 0);
  const grandPassed = allResults.reduce((s, r) => s + r.passed, 0);
  const grandSkipped = allResults.reduce((s, r) => s + (r.skipped || 0), 0);
  const allGreen = grandPassed === grandTotal;

  console.log('\n──────────────────────────────────────────────────────────────────');
  const overallLabel = allGreen ? '  ✓  ALL PASS' : `  ✗  ${grandTotal - grandPassed} FAILING`;
  console.log(`${overallLabel}   (${grandPassed}/${grandTotal} checks passed${grandSkipped > 0 ? `, ${grandSkipped} skipped` : ''})`);
  console.log('══════════════════════════════════════════════════════════════════\n');

  if (!allGreen) process.exit(1);
}

main().catch((err) => {
  console.error('Eval runner crashed:', err);
  process.exit(1);
});
