'use strict';

// Server-side per-game move classification.
// Replicates the GameReview.jsx algorithm exactly — same parsePgn logic,
// same rawLoss formula, same classifyLoss thresholds, same user_color filter.
//
// evaluateFen() returns side-to-move POV; we normalize to white POV here
// (same as stockfish.js does in the browser).

const { Chess } = require('chess.js');
const { query }  = require('./db');
const { evaluateFen } = require('./engine');

// Identical to GameReview.jsx parsePgn().
function parsePgn(pgn) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const history = chess.history({ verbose: true });

  const replay = new Chess();
  const positions = [{ fen: replay.fen() }];
  const moves = [];

  history.forEach((m, idx) => {
    replay.move({ from: m.from, to: m.to, promotion: m.promotion });
    const fenAfter = replay.fen();
    positions.push({ fen: fenAfter });
    moves.push({
      san:        m.san,
      fenAfter,
      color:      m.color,           // 'w' | 'b'
      moveNumber: Math.floor(idx / 2) + 1,
    });
  });

  return { positions, moves };
}

// Identical thresholds to client/src/stockfish.js classifyLoss().
function classifyLoss(cpLoss) {
  if (cpLoss > 200)  return 'blunder';
  if (cpLoss >= 100) return 'mistake';
  if (cpLoss >= 50)  return 'inaccuracy';
  return 'good';
}

// Fetch game, evaluate every position sequentially, classify moves,
// and insert results into the moves table.
//
// Returns { gameId, skipped, movesAnalyzed, mistakeCount, blunderCount }.
// Returns { skipped: true } without touching the DB if moves already exist.
async function analyzeGame(gameId, userId) {
  const { rows: [gameRow] } = await query(
    `SELECT pgn, user_color FROM games WHERE id = $1 AND user_id = $2`,
    [gameId, userId]
  );
  if (!gameRow) throw new Error(`Game ${gameId} not found for user ${userId}`);

  // Idempotency guard — never re-analyse a game that already has moves.
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM moves WHERE game_id = $1`,
    [gameId]
  );
  if (count > 0) {
    return { gameId, skipped: true, movesAnalyzed: 0, mistakeCount: 0, blunderCount: 0 };
  }

  const { positions, moves } = parsePgn(gameRow.pgn);

  // Evaluate every FEN sequentially (engine is single-process; do not parallelize).
  // evaluateFen() → side-to-move POV; normalize to white POV to match the browser.
  const evals = new Array(positions.length);
  for (let i = 0; i < positions.length; i++) {
    const r = await evaluateFen(positions[i].fen);
    if (!r.ok) throw new Error(`Engine failed at position ${i}: ${r.error}`);
    const sideToMove = positions[i].fen.split(' ')[1]; // 'w' | 'b'
    evals[i] = sideToMove === 'w' ? r.evalCp : -r.evalCp;
  }

  // Apply rawLoss formula — identical to GameReview.jsx lines 134–158.
  const userColorChar =
    gameRow.user_color === 'white' ? 'w'
    : gameRow.user_color === 'black' ? 'b'
    : null;

  const analysed = moves
    .map((m, idx) => {
      const rawLoss = m.color === 'w'
        ? evals[idx] - evals[idx + 1]
        : evals[idx + 1] - evals[idx];
      const cpLoss = Math.max(0, rawLoss);
      return {
        move_number:       m.moveNumber,
        move:              m.san,
        fen:               m.fenAfter,
        color:             m.color,
        classification:    classifyLoss(cpLoss),
        principle_violated: null,
        centipawn_loss:    Math.round(cpLoss),
      };
    })
    // Drop opponent moves — identical filter to GameReview.jsx line 151.
    .filter(m => userColorChar === null || m.color === userColorChar);

  // Insert into moves table — same columns and values as POST /games/:id/moves.
  for (const m of analysed) {
    await query(
      `INSERT INTO moves
         (game_id, move_number, move, fen, classification, principle_violated, centipawn_loss)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [gameId, m.move_number, m.move, m.fen,
       m.classification, m.principle_violated || null, m.centipawn_loss ?? null]
    );
  }

  const mistakeCount = analysed.filter(m => m.classification === 'mistake').length;
  const blunderCount = analysed.filter(m => m.classification === 'blunder').length;

  console.log(
    `[analyzeGame] game=${gameId} movesAnalyzed=${analysed.length} ` +
    `mistakes=${mistakeCount} blunders=${blunderCount}`
  );

  return { gameId, skipped: false, movesAnalyzed: analysed.length, mistakeCount, blunderCount };
}

module.exports = { analyzeGame, parsePgn, classifyLoss };
