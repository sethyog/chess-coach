'use strict';

const { query } = require('./db');
const { BATCH_THRESHOLD } = require('./format');

// Returns formats ready for a new analysis batch, with metadata.
//
// A format is ready if EITHER:
//   a) games_since_last_batch >= threshold  (normal incremental path), OR
//   b) no batch has ever completed AND total games >= threshold
//      (first-run path — covers users who had games before the feature shipped).
//
// Returns: Array<{ format, isFirstRun, totalGames }>
async function getReadyFormats(userId) {
  const { rows } = await query(
    `SELECT
       fgc.format,
       fgc.games_since_last_batch,
       fgc.last_batch_completed_at,
       (SELECT COUNT(*)::int FROM games g
        WHERE g.user_id = $1 AND g.format = fgc.format) AS total_game_count
     FROM format_game_counts fgc
     WHERE fgc.user_id = $1`,
    [userId]
  );

  return rows
    .filter(r => {
      const threshold = BATCH_THRESHOLD[r.format];
      if (!threshold) return false;
      if (r.games_since_last_batch >= threshold) return true;
      if (!r.last_batch_completed_at && r.total_game_count >= threshold) return true;
      return false;
    })
    .map(r => ({
      format: r.format,
      isFirstRun: !r.last_batch_completed_at,
      totalGames: r.total_game_count,
    }));
}

// Convenience: return just the format strings (used by import routes that only
// need to know which formats hit threshold, not the full metadata).
async function getReadyFormatNames(userId) {
  return (await getReadyFormats(userId)).map(r => r.format);
}

module.exports = { getReadyFormats, getReadyFormatNames };
