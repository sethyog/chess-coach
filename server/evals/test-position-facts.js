'use strict';

// Sanity check for buildPositionFacts. Run from server/evals/:
//   node test-position-facts.js
// Or with an explicit game id / move SAN:
//   node test-position-facts.js 2 Qc1 blunder

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { query }                                    = require('../db');
const { reconstructBeforeFen, buildPositionFacts } = require('../position-facts');

function formatLegalMovesForPrompt(legalMoves) {
  const MAX = 40;
  if (legalMoves.length <= MAX) return legalMoves.join(', ');
  return legalMoves.slice(0, MAX).join(', ') + `, … (+${legalMoves.length - MAX} more)`;
}

function formatProfileForPrompt(profile) {
  const level = profile?.computed_level || 'intermediate';
  const concept = profile?.conceptual_profile || 'still building — calibrate to intermediate level';
  return `Player profile:\n - Computed level: ${level}\n - Conceptual profile: ${concept}`;
}

function fmtEvalCp(cp) {
  if (cp == null) return 'not yet computed';
  return `${cp} cp (white POV)`;
}

function buildVerifiedFactsPrompt({ facts, profile, principleViolated }) {
  const playedSummary = facts.playedMoveValid
    ? facts.playedMoveDetails.sentence
    : facts.playedMoveNote;
  const legalList = formatLegalMovesForPrompt(facts.legalMoves);
  const indentedPieceMap = facts.pieceMap.split('\n').map(l => '   ' + l).join('\n');

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
 - Do not calculate your own tactical lines beyond what the engine facts already say.
 - If the engine's preferred move, eval, or PV is listed as "not yet computed", do NOT invent one.
 - If unsure about any board detail, ASK the player; do not assert.
 - Your job is to EXPLAIN the engine's verified conclusion Socratically at the player's level — not to work out what is true on the board.

Coaching style:
 - Socratic: understand what the player was thinking before correcting them.
 - Keep responses under 3 sentences.
 - Be warm and encouraging.
 - Ask one focused question at a time.
 - Never just hand the player the correct move — teach the idea.`;
}

async function run() {
  const [, , gameIdArg, sanArg, classificationArg] = process.argv;
  const gameIdFilter = gameIdArg ? Number(gameIdArg) : null;
  const sanFilter    = sanArg || null;
  const classFilter  = classificationArg || null;

  let row;
  if (gameIdFilter && sanFilter) {
    const res = await query(
      `SELECT m.id, m.game_id, m.move_number, m.move, m.classification, m.centipawn_loss, g.pgn
         FROM moves m
         JOIN games g ON g.id = m.game_id
        WHERE m.game_id = $1 AND m.move = $2
              ${classFilter ? 'AND m.classification = $3' : ''}
        ORDER BY m.id DESC LIMIT 1`,
      [gameIdFilter, sanFilter, ...(classFilter ? [classFilter] : [])]
    );
    row = res.rows[0];
  } else {
    const res = await query(
      `SELECT m.id, m.game_id, m.move_number, m.move, m.classification, m.centipawn_loss, g.pgn
         FROM moves m
         JOIN games g ON g.id = m.game_id
        WHERE m.classification = 'blunder'
        ORDER BY m.id DESC LIMIT 1`
    );
    row = res.rows[0];
  }

  if (!row) {
    console.error('No matching move row. Args: gameId=%s san=%s classification=%s', gameIdFilter, sanFilter, classFilter);
    process.exit(1);
  }

  console.log('flagged move row:', {
    id: row.id,
    game_id: row.game_id,
    move_number: row.move_number,
    san: row.move,
    classification: row.classification,
  });

  const fenBefore = reconstructBeforeFen(row.pgn, row.move_number, row.move);
  console.log('\nfenBefore:', fenBefore);

  console.log('\n=== facts for the REAL played move (' + row.move + ') ===');
  console.log(JSON.stringify(
    buildPositionFacts({ fenBefore, playedMoveSan: row.move, classification: row.classification, centipawnLoss: row.centipawn_loss }),
    null, 2
  ));

  console.log('\n=== facts for a deliberately illegal move (Nxb2) ===');
  console.log(JSON.stringify(
    buildPositionFacts({ fenBefore, playedMoveSan: 'Nxb2', classification: row.classification, centipawnLoss: row.centipawn_loss }),
    null, 2
  ));

  const profileRes = await query(
    `SELECT p.* FROM player_profile p
       JOIN games g ON g.id = $1 AND g.user_id = p.user_id`,
    [row.game_id]
  );
  const profileRow = profileRes.rows[0] || { computed_level: 'intermediate', conceptual_profile: null };

  const principleRes = await query(
    'SELECT principle_violated FROM moves WHERE id = $1',
    [row.id]
  );
  const principleViolated = principleRes.rows[0]?.principle_violated || null;

  const factsForPrompt = buildPositionFacts({
    fenBefore,
    playedMoveSan: row.move,
    classification: row.classification,
    centipawnLoss: row.centipawn_loss,
  });

  console.log('\n=== assembled SYSTEM PROMPT that would be sent to Claude ===');
  console.log('─'.repeat(72));
  console.log(buildVerifiedFactsPrompt({ facts: factsForPrompt, profile: profileRow, principleViolated }));
  console.log('─'.repeat(72));

  process.exit(0);
}

run().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
