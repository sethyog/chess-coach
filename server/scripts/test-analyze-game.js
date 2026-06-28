#!/usr/bin/env node
// Dry-run comparison: classify game 14 server-side and diff against existing DB moves.
// Does NOT insert anything.
//
// Usage:
//   DATABASE_URL=<url> node server/scripts/test-analyze-game.js [gameId]
//
// Requires STOCKFISH_PATH or stockfish on PATH.

'use strict';

const { query } = require('../db');
const { parsePgn, classifyLoss } = require('../analysis');
const { evaluateFen, isEngineAvailable } = require('../engine');

const GAME_ID = parseInt(process.argv[2] || '14', 10);

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Give the engine a moment to finish its UCI handshake before we queue positions.
async function waitForEngine() {
  for (let i = 0; i < 30; i++) {
    if (isEngineAvailable()) return;
    await wait(500);
  }
  throw new Error('Engine did not become ready within 15 s');
}

async function main() {
  console.log(`\n=== Dry-run analysis of game ${GAME_ID} ===\n`);

  await waitForEngine();

  // Fetch game.
  const { rows: [game] } = await query(
    `SELECT id, pgn, user_color, opponent FROM games WHERE id = $1`,
    [GAME_ID]
  );
  if (!game) { console.error(`Game ${GAME_ID} not found.`); process.exit(1); }
  console.log(`Game vs ${game.opponent}  user_color=${game.user_color}\n`);

  // Fetch existing moves from DB for comparison.
  const { rows: existingMoves } = await query(
    `SELECT move_number, move, classification, centipawn_loss
     FROM moves WHERE game_id = $1 ORDER BY move_number`,
    [GAME_ID]
  );
  console.log(`Existing DB moves: ${existingMoves.length}\n`);

  // Parse PGN and evaluate.
  const { positions, moves } = parsePgn(game.pgn);
  console.log(`PGN positions: ${positions.length}  half-moves: ${moves.length}`);
  console.log(`Evaluating ${positions.length} positions (this takes ~${Math.round(positions.length * 0.6)}s)…\n`);

  const evals = new Array(positions.length);
  for (let i = 0; i < positions.length; i++) {
    const r = await evaluateFen(positions[i].fen);
    if (!r.ok) { console.error(`Engine failed at position ${i}: ${r.error}`); process.exit(1); }
    const stm = positions[i].fen.split(' ')[1];
    evals[i] = stm === 'w' ? r.evalCp : -r.evalCp;
    process.stdout.write(`\r  position ${i + 1}/${positions.length}`);
  }
  console.log('\n');

  const userColorChar =
    game.user_color === 'white' ? 'w'
    : game.user_color === 'black' ? 'b'
    : null;

  const serverMoves = moves
    .map((m, idx) => {
      const rawLoss = m.color === 'w'
        ? evals[idx] - evals[idx + 1]
        : evals[idx + 1] - evals[idx];
      const cpLoss = Math.max(0, rawLoss);
      return {
        move_number:    m.moveNumber,
        move:           m.san,
        color:          m.color,
        classification: classifyLoss(cpLoss),
        centipawn_loss: Math.round(cpLoss),
      };
    })
    .filter(m => userColorChar === null || m.color === userColorChar);

  console.log(`Server-classified moves: ${serverMoves.length}\n`);

  // Diff.
  const existingMap = new Map(existingMoves.map(m => [m.move_number, m]));
  let matches = 0, diffs = 0, serverOnly = 0, dbOnly = 0;

  console.log(`${'#'.padStart(3)}  ${'SAN'.padEnd(7)}  SERVER                    DB`);
  console.log('─'.repeat(70));

  for (const sm of serverMoves) {
    const db = existingMap.get(sm.move_number);
    if (!db) {
      console.log(`${String(sm.move_number).padStart(3)}  ${sm.move.padEnd(7)}  ${sm.classification.padEnd(10)} ${String(sm.centipawn_loss).padStart(5)}cp   ← server only`);
      serverOnly++;
      continue;
    }
    const classMatch = sm.classification === db.classification;
    const cpMatch    = Math.abs(sm.centipawn_loss - (db.centipawn_loss ?? 0)) <= 5; // ±5cp tolerance
    const ok = classMatch && cpMatch;
    if (ok) { matches++; }
    else {
      diffs++;
      const marker = !classMatch ? ' ← CLASS DIFF' : ' ← CP DIFF';
      console.log(
        `${String(sm.move_number).padStart(3)}  ${sm.move.padEnd(7)}  ` +
        `${sm.classification.padEnd(10)} ${String(sm.centipawn_loss).padStart(5)}cp   ` +
        `${db.classification.padEnd(10)} ${String(db.centipawn_loss ?? '?').padStart(5)}cp${marker}`
      );
    }
  }

  for (const db of existingMoves) {
    const found = serverMoves.some(sm => sm.move_number === db.move_number);
    if (!found) {
      console.log(`${String(db.move_number).padStart(3)}  ${db.move.padEnd(7)}  ← db only`);
      dbOnly++;
    }
  }

  console.log('─'.repeat(70));
  console.log(`\nSummary: ${matches} match  ${diffs} differ  ${serverOnly} server-only  ${dbOnly} db-only`);

  if (diffs === 0 && serverOnly === 0 && dbOnly === 0) {
    console.log('\n✓ Server and client classifications are identical.\n');
  } else if (diffs > 0) {
    console.log('\n⚠ Classification differences exist.');
    console.log('  Expected causes: server movetime cap (500ms) vs client unlimited depth search');
    console.log('  at depth 12 may yield slightly different evals for complex positions.\n');
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
