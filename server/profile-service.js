'use strict';

const { query } = require('./db');

function levelFromCpl(avg) {
  if (avg == null) return null;
  if (avg > 150) return 'beginner';
  if (avg >= 80) return 'intermediate';
  return 'advanced';
}

function levelFromRating(rating) {
  if (rating == null) return null;
  if (rating < 1000) return 'beginner';
  if (rating <= 1400) return 'intermediate';
  return 'advanced';
}

async function recomputeStats(userId) {
  const avgRow = (await query(
    `SELECT AVG(m.centipawn_loss) AS avg
     FROM moves m
     JOIN games g ON g.id = m.game_id
     WHERE g.user_id = $1 AND m.centipawn_loss IS NOT NULL`,
    [userId]
  )).rows[0];
  const avgCpl = avgRow.avg != null ? parseFloat(avgRow.avg) : null;

  const blunderRow = (await query(
    `SELECT COUNT(*) FILTER (WHERE m.classification = 'blunder')::int AS blunders,
            COUNT(DISTINCT m.game_id)::int AS analysed_games
     FROM moves m
     JOIN games g ON g.id = m.game_id
     WHERE g.user_id = $1`,
    [userId]
  )).rows[0];
  const blunderRate =
    blunderRow.analysed_games > 0 ? blunderRow.blunders / blunderRow.analysed_games : null;

  return { avgCpl, blunderRate };
}

async function updateProfile(userId) {
  const { avgCpl, blunderRate } = await recomputeStats(userId);
  const current = (await query('SELECT * FROM player_profile WHERE user_id = $1', [userId])).rows[0];

  if (!current) {
    console.error(`updateProfile: no profile row for user ${userId}`);
    return null;
  }

  let computedLevel;
  if (avgCpl != null) {
    computedLevel = levelFromCpl(avgCpl);
  } else if (current.reported_rating != null) {
    computedLevel = levelFromRating(current.reported_rating);
  } else {
    computedLevel = current.computed_level || 'intermediate';
  }

  if (current.reported_rating != null && avgCpl != null) {
    const ratingLevel = levelFromRating(current.reported_rating);
    if (ratingLevel !== computedLevel) {
      console.log(
        `Profile discrepancy (user ${userId}): reported_rating ${current.reported_rating} (${ratingLevel}) vs computed_level ${computedLevel} from avg_cpl=${avgCpl.toFixed(0)}`
      );
    }
  }

  await query(
    `UPDATE player_profile
     SET avg_centipawn_loss = $1, blunder_rate = $2, computed_level = $3, profile_updated_at = NOW()
     WHERE user_id = $4`,
    [avgCpl, blunderRate, computedLevel, userId]
  );

  return (await query('SELECT * FROM player_profile WHERE user_id = $1', [userId])).rows[0];
}

module.exports = { levelFromCpl, levelFromRating, recomputeStats, updateProfile };
