'use strict';

// ── Tunable batch thresholds and minimums ─────────────────────────────────────
// These are the only place these numbers live. Import from here everywhere.

const BATCH_THRESHOLD = {
  classical: 5,
  rapid:     10,
  bullet:    15,
};

const MIN_GAMES = {
  classical: 3,
  rapid:     5,
  bullet:    8,
};

// ── Chess.com time_class → format bucket ──────────────────────────────────────

const CHESSCOM_TYPE_MAP = {
  daily:  'classical',
  rapid:  'rapid',
  blitz:  'bullet',
  bullet: 'bullet',
};

// ── Core bucketing function ───────────────────────────────────────────────────

/**
 * Derive a format bucket from available signals. Both parameters are optional;
 * pass whichever you have. Chess.com type takes precedence over time control.
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.chesscomTimeClass  Chess.com API `time_class`
 * @param {string|null|undefined} opts.timeControlStr     PGN [TimeControl "..."] value
 * @returns {'classical'|'rapid'|'bullet'|'unknown'}
 */
function deriveFormat({ chesscomTimeClass, timeControlStr } = {}) {
  if (chesscomTimeClass) {
    const mapped = CHESSCOM_TYPE_MAP[chesscomTimeClass.toLowerCase()];
    if (mapped) return mapped;
  }
  if (timeControlStr) {
    return parseTimeControl(timeControlStr);
  }
  return 'unknown';
}

// ── Time control string parser ────────────────────────────────────────────────

/**
 * Parse a PGN TimeControl header value into a format bucket.
 *
 * Handles:
 *   "600+0"   → base 600s  → rapid
 *   "180+2"   → base 180s  → bullet
 *   "1800"    → 1800s      → classical
 *   "1/86400" → daily      → classical
 *   "-"       → unknown
 *
 * @param {string} tc
 * @returns {'classical'|'rapid'|'bullet'|'unknown'}
 */
function parseTimeControl(tc) {
  if (!tc || typeof tc !== 'string') return 'unknown';
  const s = tc.trim();
  if (!s || s === '-' || s === '?') return 'unknown';

  // Daily game format: "1/N" means 1 move per N seconds
  if (/^1\/\d+$/.test(s)) return 'classical';

  // Standard: "BaseSeconds+IncrementSeconds"
  const plusMatch = s.match(/^(\d+)\+(\d+)$/);
  if (plusMatch) return baseSecondsToFormat(parseInt(plusMatch[1], 10));

  // Plain integer seconds (no increment listed)
  const plainMatch = s.match(/^(\d+)$/);
  if (plainMatch) return baseSecondsToFormat(parseInt(plainMatch[1], 10));

  return 'unknown';
}

function baseSecondsToFormat(seconds) {
  if (seconds >= 1800) return 'classical';
  if (seconds >= 600)  return 'rapid';
  return 'bullet';
}

// ── PGN header extraction ─────────────────────────────────────────────────────

/**
 * Extract the raw [TimeControl "..."] value from a PGN string.
 * Returns null if the header is absent.
 */
function extractTimeControlFromPgn(pgn) {
  if (!pgn || typeof pgn !== 'string') return null;
  const m = pgn.match(/\[TimeControl\s+"([^"]*)"\]/);
  return m ? m[1] : null;
}

module.exports = {
  BATCH_THRESHOLD,
  MIN_GAMES,
  CHESSCOM_TYPE_MAP,
  deriveFormat,
  parseTimeControl,
  extractTimeControlFromPgn,
};
