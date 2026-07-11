'use strict';

// Post-generation backstop for the coach's free-text prose (Part 3 of the
// board-hallucination fix — see coaching-prompt.js for the primary,
// prompt-level defense). Prompt instructions are not guarantees; this is the
// enforcement layer for when they're violated. Deliberately conservative: a
// sentence is only removed when it matches a PROVEN-impossible or
// PROVEN-ungrounded claim. Everything else — conceptual prose, correct
// one-ply references, prose that merely narrates an already-demonstrated
// line — passes through untouched.

const SQUARE_RE = '[a-h][1-8]';
const PIECE_WORD = 'king|queen|rook|bishop|knight|pawn';
const PIECE_TO_LETTER = { king: 'k', queen: 'q', rook: 'r', bishop: 'b', knight: 'n', pawn: 'p' };
const INTERACTION_VERB = 'attacks?|captures?|challenges?|defends?|takes?|threatens?|hits?|targets?|pressures?';

// Sentences with this framing are about the past or a counterfactual — the
// squares they name may legitimately be absent from any CURRENT verified
// facts (a piece that already moved away, a move that was never played).
// Mirrors the exclusion list in evals/fact_adherence/fact_checks.js so the
// two layers agree on what "not a live board claim" means.
const PAST_OR_COUNTERFACTUAL_RE = [
  /\byou\s+played\b/i,
  /\bthe\s+move\s+you\s+(?:played|made)\b/i,
  /\bwas\s+played\b/i,
  /\b(?:\d+\s+)?moves?\s+ago\b/i,
  /\bhad\s+you\s+played\b/i,
  /\bif\s+you\s+had\b/i,
  /\balready\s+(?:played|happened|occurred)\b/i,
  /\bthe\s+(?:last|previous|prior)\s+move\b/i,
  /\bjust\s+played\b/i,
];

function squareColor(square) {
  const file = square.toLowerCase().charCodeAt(0) - 96; // a=1..h=8
  const rank = Number(square[1]);
  return (file + rank) % 2 === 0 ? 'dark' : 'light';
}

function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

// ─── CHECK 1: color-binding ───────────────────────────────────────────────
// A bishop is color-bound for its entire existence on the board — a claim
// that one interacts with a square of the opposite color is impossible
// regardless of position, regardless of ply depth, regardless of any
// verified facts. This needs no grounding data at all.
//
// Handles two claim shapes:
//   explicit: "bishop on d3 ... challenges e5"
//   pronoun:  "bishop on d3 ... could challenge it" — "it" resolved to the
//             nearest square mentioned earlier in the sentence (handles the
//             exact reported bug shape: "...recaptures with Bxe5...bishop
//             on d3 could challenge it").
function checkColorBinding(text) {
  const violations = [];
  for (const sentence of splitSentences(text)) {
    if (PAST_OR_COUNTERFACTUAL_RE.some((re) => re.test(sentence))) continue;

    const explicitRe = new RegExp(
      `\\b(${PIECE_WORD})\\b[^.!?]{0,15}?\\bon\\s+(${SQUARE_RE})\\b[^.!?]{0,40}?\\b(?:${INTERACTION_VERB})\\b[^.!?]{0,25}?\\b(${SQUARE_RE})\\b`,
      'gi'
    );
    let m = explicitRe.exec(sentence);
    if (m) {
      const pieceWord = m[1].toLowerCase();
      const fromSq = m[2].toLowerCase();
      const toSq = m[3].toLowerCase();
      if (pieceWord === 'bishop' && fromSq !== toSq && squareColor(fromSq) !== squareColor(toSq)) {
        violations.push({
          sentence: sentence.trim(),
          reason: `claims a bishop on ${fromSq} (${squareColor(fromSq)} square) interacts with ${toSq} (${squareColor(toSq)} square) — impossible, bishops are color-bound`,
        });
        continue;
      }
    }

    const pronounRe = new RegExp(
      `\\b(${PIECE_WORD})\\b[^.!?]{0,15}?\\bon\\s+(${SQUARE_RE})\\b([^.!?]{0,40}?\\b(?:${INTERACTION_VERB})\\b\\s+(?:it|that|them|there)\\b)`,
      'i'
    );
    m = pronounRe.exec(sentence);
    if (m) {
      const pieceWord = m[1].toLowerCase();
      const fromSq = m[2].toLowerCase();
      if (pieceWord === 'bishop') {
        // Resolve "it" to the most recently mentioned square BEFORE this
        // piece-on-square clause (e.g. the square embedded in a prior "Bxe5").
        const before = sentence.slice(0, m.index);
        const priorSquares = before.match(new RegExp(SQUARE_RE, 'gi')) || [];
        const antecedent = priorSquares[priorSquares.length - 1];
        if (antecedent && antecedent.toLowerCase() !== fromSq && squareColor(antecedent) !== squareColor(fromSq)) {
          violations.push({
            sentence: sentence.trim(),
            reason: `claims a bishop on ${fromSq} (${squareColor(fromSq)} square) interacts with ${antecedent} (${squareColor(antecedent)} square, referred to as "it") — impossible, bishops are color-bound`,
          });
        }
      }
    }
  }
  return violations;
}

// ─── CHECK 2: piece-existence grounding ──────────────────────────────────
// A claimed "<piece> on <square>" must exist in SOME known verified piece
// map — the flagged position, or a demonstrated line's computed terminal
// position (Part 2). If it exists nowhere we know about, the claim is
// ungrounded, whether it's a one-ply "shallow" reference or a deep one —
// closes the gap where a shallow claim reuses a stock pattern regardless of
// whether the piece it names is actually there (e.g. "h3 kicks the
// g4-knight" when no knight is anywhere near g4).
function parsePieceMapSquares(pieceMap) {
  const squareToPiece = {};
  const typeMap = {
    king: 'k', kings: 'k', queen: 'q', queens: 'q', rook: 'r', rooks: 'r',
    bishop: 'b', bishops: 'b', knight: 'n', knights: 'n', pawn: 'p', pawns: 'p',
  };
  for (const line of (pieceMap || '').split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const tokens = line.slice(colonIdx + 1).replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    let current = null;
    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (typeMap[lower]) current = typeMap[lower];
      else if (current && /^[a-h][1-8]$/.test(lower)) squareToPiece[lower] = current;
    }
  }
  return squareToPiece;
}

function collectKnownPieceMaps(facts, groundedDemos) {
  const maps = [];
  if (facts?.pieceMap) maps.push(facts.pieceMap);
  for (const demo of groundedDemos || []) {
    if (demo?.terminalFacts?.pieceMap) maps.push(demo.terminalFacts.pieceMap);
  }
  return maps.map(parsePieceMapSquares);
}

function checkPieceExistence(text, facts, groundedDemos) {
  const violations = [];
  const knownMaps = collectKnownPieceMaps(facts, groundedDemos);
  if (knownMaps.length === 0) return violations;

  const claimRe = new RegExp(`\\b(${PIECE_WORD})\\b[^.!?]{0,15}?\\bon\\s+(${SQUARE_RE})\\b`, 'gi');
  for (const sentence of splitSentences(text)) {
    if (PAST_OR_COUNTERFACTUAL_RE.some((re) => re.test(sentence))) continue;

    let m;
    const re = new RegExp(claimRe.source, 'gi');
    while ((m = re.exec(sentence)) !== null) {
      const pieceWord = m[1].toLowerCase();
      const square = m[2].toLowerCase();
      const claimedType = PIECE_TO_LETTER[pieceWord];
      const existsSomewhere = knownMaps.some((map) => map[square] === claimedType);
      if (!existsSomewhere) {
        violations.push({
          sentence: sentence.trim(),
          reason: `claims a ${pieceWord} on ${square}, but no verified position (current or demonstrated) has a ${pieceWord} there`,
        });
      }
    }
  }
  return violations;
}

// ─── CHECK 3: narrated sequence depth — measurement signal only ─────────
// Logs prose that spells out a run of moves deeper than the allowed ply
// limit. Never strips: a narrated sequence that matches a demonstrated line
// is redundant, not wrong. This is purely to measure how often the
// prompt-level restriction (coaching-prompt.js) is actually violated.
const SAN_TOKEN = '(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x?[a-h]?[2-7])(?:=[KQRBN])?[+#]?|O-O(?:-O)?[+#]?';

function checkNarratedSequenceDepth(text, plyLimit) {
  const re = new RegExp(`(?:\\b(?:${SAN_TOKEN})\\b[\\s,]+){${plyLimit + 1},}\\b(?:${SAN_TOKEN})\\b`, 'gi');
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) hits.push(m[0]);
  return hits;
}

// ─── Combined entry point ────────────────────────────────────────────────
// Returns { cleanedText, violations, sequenceHits, stripped }.
// Only CHECK 1 (color-binding) and CHECK 2 (piece-existence) cause the
// offending SENTENCE to be removed. CHECK 3 is logged only.
function applyProseBackstop(text, { facts, groundedDemos = [], plyLimit }) {
  if (!text) return { cleanedText: text, violations: [], sequenceHits: [], stripped: [] };

  const colorViolations = checkColorBinding(text);
  const existenceViolations = checkPieceExistence(text, facts, groundedDemos);
  const sequenceHits = checkNarratedSequenceDepth(text, plyLimit);
  const violations = [...colorViolations, ...existenceViolations];

  if (violations.length === 0) {
    return { cleanedText: text, violations, sequenceHits, stripped: [] };
  }

  const badSentences = new Set(violations.map((v) => v.sentence));
  const sentences = splitSentences(text);
  const kept = sentences.filter((s) => !badSentences.has(s.trim()));
  const cleanedText = kept.join(' ').trim() ||
    "Let me stick to what I can verify — could you tell me what you're seeing, and I'll check it properly?";

  return { cleanedText, violations, sequenceHits, stripped: [...badSentences] };
}

module.exports = {
  applyProseBackstop,
  checkColorBinding,
  checkPieceExistence,
  checkNarratedSequenceDepth,
  squareColor,
  parsePieceMapSquares,
};
