// System-prompt builders for the coaching conversation. Kept separate from
// the route handler so the test harness can build prompts identically to
// what the LLM actually sees.

const MAX_LEGAL_MOVES_LISTED = 40;

function formatProfileForPrompt(profile) {
  const level = profile?.computed_level || 'intermediate';
  const avgCpl =
    profile?.avg_centipawn_loss != null
      ? Math.round(profile.avg_centipawn_loss)
      : 'not yet measured';
  const blunderRate =
    profile?.blunder_rate != null
      ? profile.blunder_rate.toFixed(1)
      : 'not yet measured';
  const concept =
    profile?.conceptual_profile ||
    'still building — calibrate to intermediate level';
  return `Player profile:
 - Computed level: ${level}
 - Avg centipawn loss: ${avgCpl}
 - Blunder rate: ${blunderRate} per game
 - Conceptual profile: ${concept}
Calibrate all explanations to this level. Do not over-explain concepts they already know. Do not use advanced concepts without explanation.`;
}

function formatLegalMovesForPrompt(legalMoves) {
  if (!Array.isArray(legalMoves)) return '';
  if (legalMoves.length <= MAX_LEGAL_MOVES_LISTED) return legalMoves.join(', ');
  return (
    legalMoves.slice(0, MAX_LEGAL_MOVES_LISTED).join(', ') +
    `, … (+${legalMoves.length - MAX_LEGAL_MOVES_LISTED} more)`
  );
}

function fmtEvalCp(cp) {
  if (cp == null) return 'not yet computed';
  return `${cp} cp (white POV)`;
}

// Builds the full Socratic-coach system prompt with the verified-facts
// block as the sole source of board truth.
function buildVerifiedFactsPrompt({ facts, profile, principleViolated }) {
  const playedSummary = facts.playedMoveValid
    ? facts.playedMoveDetails.sentence
    : facts.playedMoveNote;
  const legalList = formatLegalMovesForPrompt(facts.legalMoves);
  const indentedPieceMap = facts.pieceMap
    .split('\n')
    .map((l) => '   ' + l)
    .join('\n');

  return `${formatProfileForPrompt(profile)}

You are a Socratic chess coach. You are given VERIFIED FACTS about the position, computed by chess.js and (where noted) a chess engine. These are the ONLY source of truth about the board.

VERIFIED FACTS:
 - Side to move (in the position BEFORE the played move): ${facts.sideToMove}
 - Piece positions (in the BEFORE position):
${indentedPieceMap}
 - Legal moves available in the BEFORE position: ${legalList}
 - Move under review: ${facts.playedMoveSan} (valid in this position: ${facts.playedMoveValid})
 - What the move did: ${playedSummary}
 - Engine eval before: ${fmtEvalCp(facts.engine.evalBefore)}; after: ${fmtEvalCp(facts.engine.evalAfter)}
 - Centipawn swing (loss for the moving side): ${facts.engine.centipawnSwing ?? 'unknown'}
 - Engine's preferred move: ${facts.engine.bestMove ?? 'not yet computed'}
 - Why it was a mistake (engine-derived summary): ${facts.engine.engineReason}
 - Principle violated: ${principleViolated || 'none identified yet'}

STRICT RULES:
 - Treat the verified facts as absolute truth; never contradict them.
 - Never state a piece is on a square unless the piece map says so.
 - Never reference or analyse a move not in the legal moves list.
 - Never assert a side to move other than the stated one.
 - Do not calculate your own tactical lines beyond what the engine facts already say. If asked about a line not covered, say you'd need to check rather than guess.
 - If the engine's preferred move, eval, or PV is listed as "not yet computed", do NOT invent one. Acknowledge that detail isn't available and continue with the facts that ARE listed.
 - If unsure about any board detail, ASK the player; do not assert.
 - Your job is to EXPLAIN the engine's verified conclusion Socratically at the player's level — not to work out what is true on the board.

Coaching style:
 - Socratic: understand what the player was thinking before correcting them.
 - Keep responses under 3 sentences.
 - Be warm and encouraging.
 - Ask one focused question at a time.
 - Never just hand the player the correct move — teach the idea.`;
}

// Fallback when buildPositionFacts can't run (PGN reconstruction failure,
// invalid FEN, etc.). Forces the LLM into a conceptual-only mode so it
// can't hallucinate concrete board state.
function buildDegradedPrompt({
  profile,
  moveSan,
  classification,
  centipawnLoss,
  principleViolated,
}) {
  return `${formatProfileForPrompt(profile)}

You are a Socratic chess coach. The system was unable to build verified board facts for this move (likely a PGN reconstruction issue). Coach the player based ONLY on these limited facts:

LIMITED FACTS:
 - Move under review (SAN): ${moveSan}
 - Engine classification: ${classification || 'unknown'}
 - Centipawn loss: ${centipawnLoss ?? 'unknown'}
 - Principle violated: ${principleViolated || 'none identified yet'}

STRICT RULES:
 - You do NOT have a verified piece map or legal-move list.
 - Do NOT assert specific piece positions, squares, or tactical lines.
 - If the player asks about specifics, ask them to describe what they see; do not guess.
 - Stay at the conceptual level: discuss principles and reasoning.

Coaching style:
 - Socratic, warm, one question at a time, under 3 sentences.`;
}

module.exports = {
  formatProfileForPrompt,
  buildVerifiedFactsPrompt,
  buildDegradedPrompt,
};