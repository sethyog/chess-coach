'use strict';

// Three deterministic checks on coaching reply text vs verified positionFacts.
// All checks are text/data comparisons — no LLM judge involved.
// Each check: (replyText, positionFacts) → { pass, violations: string[] }

const { Chess } = require('chess.js');

// ─── pieceMap parser ──────────────────────────────────────────────────────────
// Converts the pieceMap string from buildPositionFacts into a lookup:
//   { square: { piece: 'k'|'q'|'r'|'b'|'n'|'p', color: 'w'|'b' } }
//
// pieceMap format (from position-facts.js formatPiecesLine):
//   "White: King g1, Queen d1, Rooks a1, h1, Bishop c4, Knights c3, d4, Pawns a2 b2\n
//    Black: King e8, Queen d8, ..."
//
// Note: multi-piece groups use ", " (e.g., "Rooks a1, h1") which is the same
// separator as between piece groups. We disambiguate by scanning token by token:
// if a token is a piece word, switch to that type; if it's a square, record it.
function parsePieceMap(pieceMap) {
  const squareToPiece = {};
  const typeMap = {
    king: 'k', kings: 'k',
    queen: 'q', queens: 'q',
    rook: 'r', rooks: 'r',
    bishop: 'b', bishops: 'b',
    knight: 'n', knights: 'n',
    pawn: 'p', pawns: 'p',
  };
  const PIECE_WORDS = new Set(Object.keys(typeMap));

  const lines = (pieceMap || '').split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const colorWord = line.slice(0, colonIdx).trim().toLowerCase();
    const color = colorWord === 'white' ? 'w' : 'b';
    const partsStr = line.slice(colonIdx + 1).trim();

    // Replace all commas with spaces so "Rooks a1, h1" becomes "Rooks a1 h1",
    // then tokenize. Piece words mark the start of each new piece group.
    const tokens = partsStr.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    let currentPiece = null;
    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (PIECE_WORDS.has(lower)) {
        currentPiece = typeMap[lower];
      } else if (currentPiece && /^[a-h][1-8]$/.test(lower)) {
        squareToPiece[lower] = { piece: currentPiece, color };
      }
    }
  }
  return squareToPiece;
}

// ─── CHECK 1: piece position adherence ───────────────────────────────────────
// Scan replyText for "piece-word on/at square" claims. If the reply names a
// piece on a square that contradicts the pieceMap (wrong piece, or piece on an
// empty square), record a violation.
//
// Only exact claims are flagged: "a knight on b5", "the rook on e1", etc.
// Ambiguous phrasing (no clear "on <square>") is not flagged.
function checkPiecePositions(replyText, positionFacts) {
  const violations = [];
  const squareToPiece = parsePieceMap(positionFacts.pieceMap);

  const PIECE_WORD = 'king|queen|rook|bishop|knight|pawn';
  // Matches "the knight on b5", "a rook on e1", "bishop at d3", "queen on d5"
  const pattern = new RegExp(
    `\\b(${PIECE_WORD})\\b(?:[^.!?]{0,20}?)\\bon\\s+([a-h][1-8])\\b` +
    `|\\b(${PIECE_WORD})\\b(?:[^.!?]{0,10}?)\\bat\\s+([a-h][1-8])\\b`,
    'gi'
  );

  const pieceToLetter = {
    king: 'k', queen: 'q', rook: 'r', bishop: 'b', knight: 'n', pawn: 'p',
  };

  let m;
  while ((m = pattern.exec(replyText)) !== null) {
    const claimedPieceWord = (m[1] || m[3]).toLowerCase();
    const claimedSquare = (m[2] || m[4]).toLowerCase();
    const claimedType = pieceToLetter[claimedPieceWord];
    const actual = squareToPiece[claimedSquare];

    if (actual === undefined || actual === null) {
      // Square is empty but reply claims a piece on it
      violations.push(
        `reply claims "${claimedPieceWord} on ${claimedSquare}" but that square is empty in the verified position`
      );
    } else if (actual.piece !== claimedType) {
      // Wrong piece type on that square
      const actualName = Object.keys(pieceToLetter).find(
        (k) => pieceToLetter[k] === actual.piece
      );
      violations.push(
        `reply claims "${claimedPieceWord} on ${claimedSquare}" but that square has a ${actual.color === 'w' ? 'white' : 'black'} ${actualName}`
      );
    }
    // Correct piece type on the square → no violation (color mismatch is not
    // checked here because the coach might say "a knight on b5" without stating color)
  }

  return { pass: violations.length === 0, violations };
}

// ─── CHECK 2: side-to-move adherence ─────────────────────────────────────────
// Scan replyText for explicit claims about whose turn it is. If the reply
// contradicts positionFacts.sideToMove, record a violation.
function checkSideToMove(replyText, positionFacts) {
  const violations = [];
  const stm = positionFacts.sideToMove; // 'white' or 'black'

  // Patterns that assert White to move
  const whiteClaims = [
    /\bit['']?s\s+white['']?s?\s+(?:turn|move|play)\b/i,
    /\bwhite\s+to\s+(?:move|play)\b/i,
    /\bwhite['']?s?\s+turn\b/i,
    /\bwhite\s+(?:has|needs|must|should|can)\s+(?:to\s+)?move\b/i,
    /\bit['']?s\s+white\s+to\s+(?:move|play)\b/i,
  ];

  // Patterns that assert Black to move
  const blackClaims = [
    /\bit['']?s\s+black['']?s?\s+(?:turn|move|play)\b/i,
    /\bblack\s+to\s+(?:move|play)\b/i,
    /\bblack['']?s?\s+turn\b/i,
    /\bblack\s+(?:has|needs|must|should|can)\s+(?:to\s+)?move\b/i,
    /\bit['']?s\s+black\s+to\s+(?:move|play)\b/i,
  ];

  if (stm === 'white') {
    for (const re of blackClaims) {
      if (re.test(replyText)) {
        violations.push(
          `reply claims it is Black to move but positionFacts.sideToMove is "white" (matched: ${re})`
        );
        break; // one violation per category
      }
    }
  } else if (stm === 'black') {
    for (const re of whiteClaims) {
      if (re.test(replyText)) {
        violations.push(
          `reply claims it is White to move but positionFacts.sideToMove is "black" (matched: ${re})`
        );
        break;
      }
    }
  }

  return { pass: violations.length === 0, violations };
}

// ─── CHECK 3: move legality adherence (LENIENT) ───────────────────────────────
// Scan replyText for moves the coach PROPOSES AS PLAYABLE in the current
// position. Check each against positionFacts.legalMoves.
//
// LENIENT MODE rules:
//   - Only flag when a move is CLEARLY presented as a current suggestion
//     ("you could play X", "better was X", "consider X", "try X")
//   - Do NOT flag moves referenced as past moves, historical context, or
//     hypotheticals ("you played X", "after X", "if you had played X", "X ago")
//   - When ambiguous, do not flag — prefer false negatives over false positives.
//
// A future robust version would have the coach emit suggested moves in a
// structured field (e.g., { suggestedMove: "Bg5" }) for exact checking instead
// of relying on regex over natural language.
function checkMoveLegality(replyText, positionFacts) {
  const violations = [];
  const legalSet = new Set(positionFacts.legalMoves || []);
  const fen = positionFacts.fenBefore;

  // SAN token regex. Intentionally broad — we then validate against legalMoves.
  // Covers: piece moves (Bg5, Nxd4, Rxe6+), pawn moves (e4, exd5), promotions
  // (e8=Q), castling (O-O, O-O-O), with optional check/mate symbols.
  // Ranks 1 and 8 require explicit promotion notation (=Q/R/B/N) to avoid
  // treating square references like "the a8 rook" as pawn move proposals.
  const SAN_RE = /\b([KQRBN][a-h]?[1-8]?x?[a-h][1-8][+#]?|[a-h]x?[a-h]?[2-7][+#]?(?:=[KQRBN])?|[a-h][18]=[KQRBN][+#]?|O-O(?:-O)?[+#]?)\b/g;

  // Past/hypothetical framing — sentences containing these are excluded
  const PAST_RE = [
    /\byou\s+played\b/i,
    /\bthe\s+move\s+you\s+(?:played|made)\b/i,
    /\bwas\s+played\b/i,
    /\b(?:\d+\s+)?moves?\s+ago\b/i,
    /\bhad\s+you\s+played\b/i,
    /\bif\s+you\s+had\b/i,
    /\balready\s+(?:played|happened|occurred)\b/i,
    /\bthe\s+(?:last|previous|prior)\s+move\b/i,
    /\bjust\s+played\b/i,
    /\bthat\s+(?:recapture|move|play)\b/i,
    /\bafter\s+(?:the\s+)?(?:move\s+)?[A-Za-z0-9-]+ (?:that|which)\b/i,
  ];

  // Suggestion framing — sentences with these may contain current-position suggestions
  const SUGGEST_RE = [
    /\byou\s+could\s+(?:have\s+)?(?:tried?\s+)?play(?:ed|ing)?\b/i,
    /\byou\s+should\s+(?:have\s+)?play(?:ed|ing)?\b/i,
    /\bconsider(?:ing)?\b/i,
    /\btry(?:ing)?\b/i,
    /\bhow\s+about\b/i,
    /\bwhat\s+about\b/i,
    /\bwould\s+(?:have\s+)?been\s+better\b/i,
    /\bbetter\s+(?:was|is|would\s+be|move\s+(?:was|is|would\s+be))\b/i,
    /\bthe\s+best\s+move\s+(?:was|is|here|would\s+be)\b/i,
    /\bstronger\s+(?:was|is|would\s+be|move\s+was)\b/i,
    /\balternatively\b/i,
    /\binstead\b/i,
  ];

  // Split into sentences for context analysis
  const sentences = replyText.split(/(?<=[.!?])\s+/);

  for (const sentence of sentences) {
    // If this sentence contains past/hypothetical framing, skip it entirely
    if (PAST_RE.some((re) => re.test(sentence))) continue;

    // Check if this sentence has suggestion framing
    const hasSuggestionContext = SUGGEST_RE.some((re) => re.test(sentence));
    if (!hasSuggestionContext) continue;

    // Strip "on <square>" and "at <square>" phrases before SAN extraction to
    // avoid treating piece-position references ("knight on f6") as proposed moves.
    const strippedSentence = sentence.replace(/\b(?:on|at)\s+[a-h][1-8]\b/gi, '');

    // Extract SAN tokens from the suggestion sentence
    let sanMatch;
    const sentenceSanRe = new RegExp(SAN_RE.source, 'g');
    while ((sanMatch = sentenceSanRe.exec(strippedSentence)) !== null) {
      const san = sanMatch[1];

      // Skip single lowercase letters (false positives like "a" in "a good move")
      if (/^[a-z]$/.test(san)) continue;

      // Validate against the legal moves list from positionFacts
      if (!legalSet.has(san)) {
        // Double-check with chess.js directly for robustness
        let chessJsVerdict = false;
        if (fen) {
          try {
            const chess = new Chess(fen);
            const result = chess.move(san, { strict: false });
            chessJsVerdict = result !== null;
          } catch {
            chessJsVerdict = false;
          }
        }

        if (!chessJsVerdict) {
          violations.push(
            `reply proposes "${san}" as a current suggestion but it is not a legal move in this position ` +
            `(FEN: ${fen || 'unknown'}). Context: "${sentence.trim().slice(0, 100)}"`
          );
        }
      }
    }
  }

  return { pass: violations.length === 0, violations };
}

// ─── Combined check ───────────────────────────────────────────────────────────
function runAllChecks(replyText, positionFacts) {
  const piece = checkPiecePositions(replyText, positionFacts);
  const stm = checkSideToMove(replyText, positionFacts);
  const legality = checkMoveLegality(replyText, positionFacts);
  return {
    piece_position: piece,
    side_to_move: stm,
    move_legality: legality,
    anyViolation: !piece.pass || !stm.pass || !legality.pass,
  };
}

// ─── Self-test (run file directly to see the checks in action) ────────────────
if (require.main === module) {
  const { buildPositionFacts } = require('../../position-facts');

  // Sicilian Najdorf, white to move. White queen on d1 CANNOT reach d5.
  const FEN = 'rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6';
  const facts = buildPositionFacts({ fenBefore: FEN, playedMoveSan: 'Be2' });

  console.log('\n── fact_checks self-test ────────────────────────────────────────');

  const replyWithIllegalSuggestion =
    'You could play Qd5 here to attack the a8 rook and control the center at the same time.';
  const replyWithPastReference =
    'After the recapture Nxd4 that already happened, White gained strong central control.';
  const replyClean =
    'What was your plan when you chose that move? Did you see any threats you needed to address?';
  const replyWrongSide =
    "It's Black's turn now, so you need to decide how to handle the pressure.";

  function printCheck(label, reply) {
    const r = runAllChecks(reply, facts);
    const all = [
      ...r.piece_position.violations.map((v) => `piece_position: ${v}`),
      ...r.side_to_move.violations.map((v) => `side_to_move: ${v}`),
      ...r.move_legality.violations.map((v) => `move_legality: ${v}`),
    ];
    console.log(`\n  [${all.length === 0 ? 'CLEAN' : 'VIOLATIONS'}] ${label}`);
    if (all.length > 0) for (const v of all) console.log(`    ✗ ${v}`);
    else console.log('    ✓ no violations');
  }

  printCheck('Proposes illegal move Qd5 (should flag)', replyWithIllegalSuggestion);
  printCheck('References past move Nxd4 (must NOT flag)', replyWithPastReference);
  printCheck('Clean reply (must NOT flag)', replyClean);
  printCheck('Wrong side-to-move claim (should flag)', replyWrongSide);
}

module.exports = {
  checkPiecePositions,
  checkSideToMove,
  checkMoveLegality,
  runAllChecks,
  parsePieceMap,
};
