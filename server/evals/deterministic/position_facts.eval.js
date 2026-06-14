'use strict';

// Deterministic eval: buildPositionFacts returns correct board truth.
// Tests sideToMove, piece anchors, legal/illegal moves, and playedMoveValid.

const { Chess } = require('chess.js');
const { buildPositionFacts } = require('../../position-facts');
const cases = require('../datasets/position_facts.json');

function getPieceAt(fen, square) {
  const chess = new Chess(fen);
  return chess.get(square); // {type, color} or null
}

function runCase(c) {
  if (c.fen === 'PLACEHOLDER') {
    return {
      id: c.id,
      pass: null, // null = skipped
      skipped: true,
      message: 'SKIPPED — fill in the FEN (see _note field in position_facts.json)',
    };
  }

  const facts = buildPositionFacts({
    fenBefore: c.fen,
    playedMoveSan: c.played_move,
  });

  const failures = [];

  if (!facts.ok) {
    return { id: c.id, pass: false, failures: [`buildPositionFacts returned ok=false: ${facts.error}`] };
  }

  // CHECK: sideToMove
  if (facts.sideToMove !== c.expected.sideToMove) {
    failures.push(
      `sideToMove: got "${facts.sideToMove}", expected "${c.expected.sideToMove}"`
    );
  }

  // CHECK: piece anchors — verify each known {square, piece, color} against chess.js ground truth
  for (const anchor of (c.expected.pieceAnchors || [])) {
    const actual = getPieceAt(c.fen, anchor.square);
    if (actual === null || actual === undefined) {
      failures.push(
        `pieceAnchor ${anchor.square}: expected ${anchor.color} ${anchor.piece} but square is empty`
      );
    } else if (actual.type !== anchor.piece || actual.color !== anchor.color) {
      failures.push(
        `pieceAnchor ${anchor.square}: expected ${anchor.color}/${anchor.piece} but got ${actual.color}/${actual.type}`
      );
    }
    // Also verify the pieceMap string contains the square (sanity check the formatter)
    if (anchor.color === 'w' && !facts.pieceMap.toLowerCase().includes(anchor.square)) {
      failures.push(
        `pieceMap does not mention square ${anchor.square} (white ${anchor.piece} should appear there)`
      );
    }
  }

  // CHECK: emptySquares — these squares must have no piece
  for (const sq of (c.expected.emptySquares || [])) {
    const actual = getPieceAt(c.fen, sq);
    if (actual !== null && actual !== undefined) {
      failures.push(
        `emptySquare ${sq}: expected empty but got ${actual.color}/${actual.type}`
      );
    }
  }

  // CHECK: legalMove must appear in legalMoves
  if (c.expected.legalMove && c.expected.legalMove !== 'SKIP') {
    if (!facts.legalMoves.includes(c.expected.legalMove)) {
      failures.push(
        `legalMove "${c.expected.legalMove}" not found in legalMoves. ` +
        `First 10 legal moves: ${facts.legalMoves.slice(0, 10).join(', ')}`
      );
    }
  }

  // CHECK: illegalMove must NOT appear in legalMoves
  if (c.expected.illegalMove && c.expected.illegalMove !== 'SKIP') {
    if (facts.legalMoves.includes(c.expected.illegalMove)) {
      failures.push(
        `illegalMove "${c.expected.illegalMove}" unexpectedly appeared in legalMoves — it should be illegal`
      );
    }
  }

  // CHECK: playedMoveValid flag when the played_move is known to be illegal
  if (c.expected.expectPlayedMoveValid === false) {
    if (facts.playedMoveValid !== false) {
      failures.push(
        `playedMoveValid: expected false (played move "${c.played_move}" is illegal) but got ${facts.playedMoveValid}`
      );
    }
  }

  return { id: c.id, pass: failures.length === 0, failures };
}

async function run() {
  const results = cases.map(runCase);

  const skipped = results.filter((r) => r.skipped).length;
  const active = results.filter((r) => !r.skipped);
  const passed = active.filter((r) => r.pass).length;
  const total = results.length; // all cases including skipped

  if (require.main === module) {
    console.log('\n── position_facts ─────────────────────────────────────────────');
    for (const r of results) {
      if (r.skipped) {
        console.log(`  SKIP  ${r.id} — ${r.message}`);
      } else if (r.pass) {
        console.log(`  PASS  ${r.id}`);
      } else {
        console.log(`  FAIL  ${r.id}`);
        for (const f of r.failures) console.log(`        ✗ ${f}`);
      }
    }
    console.log(`\n  ${passed}/${total} passed${skipped > 0 ? `, ${skipped} skipped (placeholder FEN)` : ''}`);
  }

  return { name: 'position_facts', total, passed, skipped, results };
}

module.exports = { run };

if (require.main === module) run();
