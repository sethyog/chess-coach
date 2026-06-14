// Computes verified board facts for the coaching prompt. Every value
// returned here is GROUND TRUTH from chess.js — the LLM never derives
// board state from raw FEN itself. Stockfish-derived fields (eval,
// bestMove, engineReason) are added on top of this in a separate step.

const { Chess } = require('chess.js');

const PIECE_NAMES = {
  k: 'King',
  q: 'Queen',
  r: 'Rook',
  b: 'Bishop',
  n: 'Knight',
  p: 'Pawn',
};

// Replays a game PGN forward up to (but not including) the target flagged
// move and returns that "before" position's FEN. Returns null if the move
// can't be located (PGN out of sync with the moves row).
function reconstructBeforeFen(gamePgn, moveNumber, playedMoveSan) {
  const chess = new Chess();
  try {
    chess.loadPgn(gamePgn);
  } catch {
    return null;
  }
  const history = chess.history({ verbose: true });
  // ply index = (move_number - 1) * 2 + (color: 0 if white, 1 if black).
  // We don't know the color from the moves row, so match by both:
  // chess move number AND SAN. SAN disambiguates which half-move it was.
  const targetIdx = history.findIndex(
    (h, i) => Math.floor(i / 2) + 1 === moveNumber && h.san === playedMoveSan
  );
  if (targetIdx === -1) return null;

  const replay = new Chess();
  for (let i = 0; i < targetIdx; i++) {
    replay.move(history[i].san);
  }
  return replay.fen();
}

// Formats one colour's pieces into the spec's "King g1, Rook e2, …, Pawns a3 f2 g2"
// shape. Pawns are space-separated (there can be many), other pieces are
// comma-separated within the line.
function formatPiecesLine(pieces) {
  const groups = { k: [], q: [], r: [], b: [], n: [], p: [] };
  for (const p of pieces) groups[p.type].push(p.square);

  const parts = [];
  if (groups.k.length) parts.push(`King ${groups.k[0]}`);
  if (groups.q.length) {
    parts.push(
      groups.q.length > 1
        ? `Queens ${groups.q.join(', ')}`
        : `Queen ${groups.q[0]}`
    );
  }
  if (groups.r.length) {
    parts.push(
      groups.r.length > 1
        ? `Rooks ${groups.r.join(', ')}`
        : `Rook ${groups.r[0]}`
    );
  }
  if (groups.b.length) {
    parts.push(
      groups.b.length > 1
        ? `Bishops ${groups.b.join(', ')}`
        : `Bishop ${groups.b[0]}`
    );
  }
  if (groups.n.length) {
    parts.push(
      groups.n.length > 1
        ? `Knights ${groups.n.join(', ')}`
        : `Knight ${groups.n[0]}`
    );
  }
  if (groups.p.length) {
    parts.push(`Pawns ${groups.p.join(' ')}`);
  }
  return parts.join(', ');
}

function buildPieceMap(chess) {
  const board = chess.board(); // 8x8 array; null in empty squares
  const white = [];
  const black = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = board[r][f];
      if (!sq) continue;
      const entry = { type: sq.type, square: sq.square };
      (sq.color === 'w' ? white : black).push(entry);
    }
  }
  return `White: ${formatPiecesLine(white)}\nBlack: ${formatPiecesLine(black)}`;
}

function describePlayedMove(chessAfter, moveObj) {
  const piece = PIECE_NAMES[moveObj.piece] || moveObj.piece;
  const capture = moveObj.captured
    ? ` capturing ${PIECE_NAMES[moveObj.captured] || moveObj.captured}`
    : '';
  const promo = moveObj.promotion
    ? ` (promoting to ${PIECE_NAMES[moveObj.promotion] || moveObj.promotion})`
    : '';
  const check = chessAfter.isCheckmate()
    ? ' (delivering checkmate)'
    : chessAfter.inCheck()
      ? ' (giving check)'
      : '';
  return `${piece} from ${moveObj.from} to ${moveObj.to}${capture}${promo}${check}`;
}

// Builds a short, factual statement of why the move was a mistake from the
// signals we ALREADY have stored (classification + centipawn_loss + the
// played-move details from chess.js). No PV, no bestMove — server-side
// Stockfish isn't wired up yet, so this is intentionally a thin honest
// summary. The prompt rules (Step 5) instruct the LLM not to invent
// tactical lines beyond what's listed here.
function buildEngineReason({ classification, centipawnLoss, playedMoveDetails }) {
  const parts = [];
  if (typeof centipawnLoss === 'number' && centipawnLoss > 0) {
    parts.push(
      `engine evaluation drops by approximately ${centipawnLoss} centipawns`
    );
  }
  if (classification) {
    parts.push(`engine classifies this as a ${classification}`);
  }
  if (playedMoveDetails?.capture) {
    parts.push(
      `the move captures the ${playedMoveDetails.capturedPiece} on ${playedMoveDetails.to}`
    );
  }
  if (playedMoveDetails?.isCheckmate) {
    parts.push('delivers checkmate');
  } else if (playedMoveDetails?.isCheck) {
    parts.push('gives check');
  }
  if (parts.length === 0) {
    return 'no specific engine reason is available for this move.';
  }
  return parts.join('; ') + '.';
}

// Pure facts derived from the BEFORE-FEN. chess.js fields are authoritative
// ground truth. Engine-shaped fields (eval / bestMove) are populated from
// stored analysis where available; server-side Stockfish isn't wired up yet,
// so eval-before/after and best move are intentionally null. centipawnSwing
// comes from the moves.centipawn_loss column; engineReason is built from
// that plus classification plus what the played move actually did.
function buildPositionFacts({
  fenBefore,
  playedMoveSan,
  classification = null,
  centipawnLoss = null,
}) {
  let chess;
  try {
    chess = new Chess(fenBefore);
  } catch (e) {
    return { ok: false, error: `Invalid FEN: ${e.message}` };
  }

  const sideToMove = chess.turn() === 'w' ? 'white' : 'black';
  const pieceMap = buildPieceMap(chess);
  const legalMoves = chess.moves();

  let playedMoveValid = false;
  let playedMoveDetails = null;
  let playedMoveNote = null;

  if (legalMoves.includes(playedMoveSan)) {
    const clone = new Chess(fenBefore);
    const moveObj = clone.move(playedMoveSan);
    if (moveObj) {
      playedMoveValid = true;
      playedMoveDetails = {
        from: moveObj.from,
        to: moveObj.to,
        piece: PIECE_NAMES[moveObj.piece] || moveObj.piece,
        capture: !!moveObj.captured,
        capturedPiece: moveObj.captured
          ? PIECE_NAMES[moveObj.captured] || moveObj.captured
          : null,
        isCheck: clone.inCheck(),
        isCheckmate: clone.isCheckmate(),
        isPromotion: !!moveObj.promotion,
        sentence: describePlayedMove(clone, moveObj),
      };
    } else {
      playedMoveNote = `chess.js rejected SAN "${playedMoveSan}" unexpectedly (ambiguous notation?).`;
    }
  } else {
    playedMoveNote = `SAN "${playedMoveSan}" is NOT legal in this position. The LLM must not explain this move; ask the player to confirm what was played.`;
  }

  // Engine-shaped fields. evalBefore / evalAfter / bestMove require server-
  // side Stockfish, which we haven't wired up. centipawnSwing reuses the
  // already-computed centipawn_loss from the moves row; engineReason
  // summarises what we DO know without inventing tactical lines.
  const engineFacts = {
    evalBefore: null,
    evalAfter: null,
    centipawnSwing: typeof centipawnLoss === 'number' ? centipawnLoss : null,
    bestMove: null,
    engineReason: buildEngineReason({
      classification,
      centipawnLoss,
      playedMoveDetails,
    }),
    engineDetailAvailable: false,
  };

  return {
    ok: true,
    fenBefore,
    sideToMove,
    pieceMap,
    legalMoves,
    playedMoveSan,
    playedMoveValid,
    playedMoveDetails,
    playedMoveNote,
    classification,
    engine: engineFacts,
  };
}

module.exports = {
  buildPositionFacts,
  reconstructBeforeFen,
  PIECE_NAMES,
};