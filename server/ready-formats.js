'use strict';

const { query } = require('./db');
const { BATCH_THRESHOLD } = require('./format');

// Returns the list of formats that are ready for a new analysis batch.
//
// A format is ready if EITHER:
//   a) games_since_last_batch >= threshold  (the normal incremental path), OR
//   b) no batch has ever completed for this format AND total games >= threshold
//      (covers users who had games before the feature shipped — their counter
//       was initialised to 0 by the backfill and was never incremented).
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
    .map(r => r.format);
}

module.exports = { getReadyFormats };
