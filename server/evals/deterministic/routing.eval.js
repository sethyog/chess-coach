'use strict';

// Deterministic eval: candidate routing produces the correct bucket.
// Imports the real computeRouting and thresholds from principle-candidates.js
// so any threshold change immediately invalidates cases that relied on old values.
//
// NOTE: requiring principle-candidates opens the real chess.db (idempotent migrations only).

const {
  computeRouting,
  SIMILARITY_HIGH,
  SIMILARITY_LOW,
  MIN_OCCURRENCE,
  MIN_DISTINCT_USERS,
  LICHESS_THEMES,
} = require('../../principle-candidates');
const cases = require('../datasets/routing.json');

function runCase(c) {
  const actual = computeRouting(c.input);
  const pass = actual === c.expected;
  const failures = pass
    ? []
    : [`routing: got "${actual}", expected "${c.expected}" (input: ${JSON.stringify(c.input)})`];
  return { id: c.id, pass, failures };
}

function assertCriticalInvariant(results) {
  // The most important safety invariant: high-similarity candidates must NEVER
  // route to auto_approve. A duplicate slipping into the live vocabulary is the
  // worst-case failure — harder to spot than a rejected valid principle.
  const highSimCases = cases.filter(
    (c) => c.input.similarity_score != null && c.input.similarity_score >= SIMILARITY_HIGH
  );
  const violations = highSimCases.filter((c) => {
    const actual = computeRouting(c.input);
    return actual === 'auto_approve';
  });
  return {
    id: 'INVARIANT: high_similarity_never_auto_approve',
    pass: violations.length === 0,
    failures: violations.map(
      (c) =>
        `CRITICAL: candidate "${c.id}" has similarity ${c.input.similarity_score} >= ${SIMILARITY_HIGH} ` +
        `but routed to auto_approve — this would insert a duplicate into the live vocabulary`
    ),
  };
}

async function run() {
  const results = cases.map(runCase);
  const invariant = assertCriticalInvariant(results);
  const allResults = [...results, invariant];

  const passed = allResults.filter((r) => r.pass).length;
  const total = allResults.length;

  if (require.main === module) {
    console.log('\n── routing ─────────────────────────────────────────────────────');
    console.log(
      `  Thresholds: SIMILARITY_HIGH=${SIMILARITY_HIGH}, SIMILARITY_LOW=${SIMILARITY_LOW}, ` +
      `MIN_OCCURRENCE=${MIN_OCCURRENCE}, MIN_DISTINCT_USERS=${MIN_DISTINCT_USERS}`
    );
    for (const r of allResults) {
      if (r.pass) {
        console.log(`  PASS  ${r.id}`);
      } else {
        console.log(`  FAIL  ${r.id}`);
        for (const f of r.failures) console.log(`        ✗ ${f}`);
      }
    }
    console.log(`\n  ${passed}/${total} passed`);
  }

  return { name: 'routing', total, passed, skipped: 0, results: allResults };
}

module.exports = { run };

if (require.main === module) run();
