'use strict';

// Eval for Part 3/4 of the board-hallucination fix. Exercises the LIVE
// production module (server/prose-backstop.js) directly against fixtures
// covering the original bug (a deep invented line ending in a geometrically
// impossible claim) and the gap found during live testing (a shallow, one-ply
// claim referencing a piece that doesn't exist anywhere in verified facts —
// "shallow" does not mean "safe"). Deterministic — no LLM call, no chess.js
// facts logic duplicated here — so a future change that reopens either gap
// in the real module fails this eval immediately.

const { buildPositionFacts, buildBoardFacts } = require('../../position-facts');
const { applyProseBackstop } = require('../../prose-backstop');
const { PROSE_CONCRETE_PLY_LIMIT } = require('../../coaching-prompt');
const { Chess } = require('chess.js');
const cases = require('../datasets/prose_backstop_cases.json');

// Builds the same shape attachTerminalFacts() produces in production, from
// a fixture's { from, moves } spec — but without an engine call (evalPlain
// is a static placeholder; Check 1/Check 2 never read it).
function buildGroundedDemos(fen, groundedDemoSpec) {
  if (!groundedDemoSpec) return [];
  const chess = new Chess(fen);
  for (const san of groundedDemoSpec.moves) {
    const mv = chess.move(san);
    if (!mv) throw new Error(`Fixture error: illegal move "${san}" in grounded_demo from ${fen}`);
  }
  const board = buildBoardFacts(chess.fen());
  return [{
    from: groundedDemoSpec.from,
    moves: groundedDemoSpec.moves,
    terminalFacts: board.ok
      ? { sideToMove: board.sideToMove, pieceMap: board.pieceMap, legalMoves: board.legalMoves, evalPlain: 'not yet computed' }
      : null,
  }];
}

function runCase(c) {
  const facts = buildPositionFacts({ fenBefore: c.fen, playedMoveSan: c.played_move });
  if (!facts.ok) {
    return { id: c.id, pass: false, failures: [`buildPositionFacts failed: ${facts.error}`], reply: c.reply, cleanedText: null, violations: [] };
  }

  const groundedDemos = buildGroundedDemos(c.fen, c.grounded_demo);
  const result = applyProseBackstop(c.reply, { facts, groundedDemos, plyLimit: PROSE_CONCRETE_PLY_LIMIT });

  const wasStripped = result.cleanedText !== c.reply;
  const failures = [];

  if (wasStripped !== c.expect_stripped) {
    failures.push(
      c.expect_stripped
        ? 'Expected the backstop to strip something, but it left the reply untouched'
        : `Expected the backstop to leave the reply untouched, but it stripped: ${JSON.stringify(result.stripped)}`
    );
  }

  if (c.expect_stripped && c.expect_violation_type) {
    const hasType = result.violations.some((v) =>
      c.expect_violation_type === 'color_binding'
        ? v.reason.includes('color-bound')
        : v.reason.includes('no verified position')
    );
    if (!hasType) {
      failures.push(`Expected a "${c.expect_violation_type}" violation, got: ${JSON.stringify(result.violations.map((v) => v.reason))}`);
    }
  }

  return {
    id: c.id,
    pass: failures.length === 0,
    reply: c.reply,
    cleanedText: result.cleanedText,
    violations: result.violations,
    failures,
  };
}

async function run() {
  const results = cases.map(runCase);
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  if (require.main === module) {
    console.log('\n── prose_backstop (live production module) ────────────────────────');
    for (const r of results) {
      const icon = r.pass ? 'PASS' : 'FAIL';
      console.log(`  ${icon}  ${r.id}`);
      if (!r.pass) {
        for (const f of r.failures) console.log(`        ✗ ${f}`);
        console.log(`        reply: ${r.reply}`);
        console.log(`        cleanedText: ${r.cleanedText}`);
      }
    }
    console.log(`\n  ${passed}/${total} passed`);
  }

  return { name: 'prose_backstop', total, passed, skipped: 0, results };
}

module.exports = { run };

if (require.main === module) run();
