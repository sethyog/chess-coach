'use strict';

// Tiered cascade resolver for the coaching engine consultation.
//
// Tier 1 — existing facts block (free, handled in the prompt/route, not here)
// Tier 2 — chess.js legality + material check (this file)
// Tier 3 — live Stockfish evaluation (this file, gated by dial + budget)

const { Chess }                          = require('chess.js');
const { evaluateFen, isEngineAvailable } = require('./engine');
const { query }                          = require('./db');

// ── Dial configuration ────────────────────────────────────────────────────────
// Read once at startup; change ENGINE_CONSULTATION_LEVEL in Railway env and redeploy.
const ENGINE_CONSULTATION_LEVEL = (process.env.ENGINE_CONSULTATION_LEVEL || 'LOW').toUpperCase();

// Hard per-conversation engine-call caps.
// Budget is tracked in coaching_facts.engine_calls_used (atomic DB update).
const MAX_ENGINE_CALLS_PER_CONVO = {
  OFF:  0,
  LOW:  1,
  MED:  3,
  HIGH: 5,
};

const MAX_PLIES = 2;  // Tier 3 applies at most 2 plies in this version.

// ── Situation constants ───────────────────────────────────────────────────────
// The coach (LLM) classifies the request; the gate code decides whether to permit it.
const SITUATION = {
  DIRECT_CHALLENGE: 'DIRECT_CHALLENGE',  // "doesn't Qxd8 just win a piece?"
  USER_PROPOSAL:    'USER_PROPOSAL',     // "what if I'd played Nb5 instead?"
  LINE_EXPLORATION: 'LINE_EXPLORATION',  // multi-step line the user wants explored
};

// ── Deterministic gate ────────────────────────────────────────────────────────
// Pure code; no LLM discretion here.
function gateAllowsEngineCall(situation) {
  switch (ENGINE_CONSULTATION_LEVEL) {
    case 'OFF':  return false;
    case 'LOW':  return situation === SITUATION.DIRECT_CHALLENGE;
    case 'MED':  return situation === SITUATION.DIRECT_CHALLENGE || situation === SITUATION.USER_PROPOSAL;
    case 'HIGH': return true;
    default:     return false;
  }
}

// ── Budget: atomic claim ──────────────────────────────────────────────────────
// Returns the updated row if the claim succeeded, or null if the budget is exhausted.
async function tryClaimBudget(moveId) {
  const cap = MAX_ENGINE_CALLS_PER_CONVO[ENGINE_CONSULTATION_LEVEL] ?? 0;
  if (cap === 0) return null;

  const res = await query(
    `UPDATE coaching_facts
        SET engine_calls_used = engine_calls_used + 1
      WHERE move_id = $1
        AND engine_calls_used < $2
     RETURNING engine_calls_used`,
    [moveId, cap]
  );
  return res.rows[0] ?? null;
}

// ── Tier 2: chess.js checks ───────────────────────────────────────────────────
// Returns { hanging: string[] } — which pieces of the side that just moved
// the opponent can immediately capture in the resulting position.
function detectHanging(fen) {
  try {
    const chess = new Chess(fen);
    // Whose pieces can be captured right now?
    const otherSide = chess.turn() === 'w' ? 'b' : 'w';

    const captures = chess.moves({ verbose: true }).filter(m => m.captured);
    const capturedSquares = new Set(captures.map(m => m.to));

    const PIECE_NAME = { k: 'King', q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn' };
    const hanging = [];

    for (const sq of capturedSquares) {
      const piece = chess.get(sq);
      if (!piece || piece.color !== otherSide) continue;
      hanging.push(`${PIECE_NAME[piece.type] || piece.type.toUpperCase()} on ${sq} can be captured`);
    }

    return hanging;
  } catch {
    return [];
  }
}

// ── Main cascade resolver ─────────────────────────────────────────────────────
/**
 * Apply `moves` (≤2 SAN strings) from `facts.fenBefore`, then evaluate with
 * engine if gate + budget allow.
 *
 * Returns:
 *   { ok: true, legal: true,  tier, moves, resultingFen, evalCp, bestResponse, mateIn, whatHangs, comparedToActual, note? }
 *   { ok: true, legal: false, error }
 *   { ok: false, error }
 */
async function resolveCascade(moveId, facts, moves, situation) {
  if (!Array.isArray(moves) || moves.length === 0) {
    return { ok: false, error: 'No moves provided' };
  }
  if (moves.length > MAX_PLIES) {
    return { ok: false, error: `Too many plies — max ${MAX_PLIES} in this version` };
  }
  if (!facts?.fenBefore) {
    return { ok: false, error: 'Before-FEN not available (degraded mode)' };
  }

  // ── Tier 2: apply moves with chess.js ────────────────────────────────────
  const chess = new Chess(facts.fenBefore);
  const moveHistory = [];

  for (const san of moves) {
    let result;
    try {
      result = chess.move(san);
    } catch {
      result = null;
    }
    if (!result) {
      return {
        ok:     true,
        legal:  false,
        error:  `Move "${san}" is not legal in this position`,
        tier:   2,
      };
    }
    moveHistory.push({ san: result.san, from: result.from, to: result.to });
  }

  const resultingFen = chess.fen();
  const whatHangs    = detectHanging(resultingFen);

  const tier2Result = {
    ok:             true,
    legal:          true,
    tier:           2,
    moves:          moveHistory,
    resultingFen,
    whatHangs,
    evalCp:         null,
    bestResponse:   null,
    mateIn:         null,
    comparedToActual: null,
  };

  // ── Gate: does the dial permit a Tier-3 call? ────────────────────────────
  if (!gateAllowsEngineCall(situation)) {
    return { ...tier2Result, note: `Engine not consulted at level ${ENGINE_CONSULTATION_LEVEL}` };
  }

  if (!isEngineAvailable()) {
    return { ...tier2Result, note: 'Engine not available on this server' };
  }

  // ── Budget: atomically claim one call ────────────────────────────────────
  const claimed = await tryClaimBudget(moveId);
  if (!claimed) {
    return { ...tier2Result, note: 'Engine budget exhausted for this conversation' };
  }

  // ── Tier 3: engine evaluation ─────────────────────────────────────────────
  const engineResult = await evaluateFen(resultingFen);

  if (!engineResult.ok) {
    // Budget was claimed but engine failed; note it so the coach can be honest.
    return { ...tier2Result, note: `Engine call failed: ${engineResult.error}` };
  }

  // Compare to the eval after the actual played move (if available).
  let comparedToActual = null;
  if (engineResult.evalCp !== null && facts.engine?.evalAfter !== null) {
    comparedToActual = engineResult.evalCp - facts.engine.evalAfter;
  }

  return {
    ok:               true,
    legal:            true,
    tier:             3,
    moves:            moveHistory,
    resultingFen,
    evalCp:           engineResult.evalCp,
    bestResponse:     engineResult.bestMove,
    mateIn:           engineResult.mateIn,
    whatHangs,
    comparedToActual,
    engineCallsUsed:  claimed.engine_calls_used,
  };
}

module.exports = {
  ENGINE_CONSULTATION_LEVEL,
  MAX_ENGINE_CALLS_PER_CONVO,
  SITUATION,
  gateAllowsEngineCall,
  resolveCascade,
};
