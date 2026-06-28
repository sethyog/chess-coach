'use strict';

// Backfill format and time_control for all existing games.
//
// Run once manually after deploying the schema changes:
//   DATABASE_URL=... node server/migrations/backfill-format.js
//
// Safe to run multiple times — only updates games where format IS NULL or
// format = 'unknown' (so already-set values are not overwritten).
// Also initialises format_game_counts for all existing users.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pool, query } = require('../db');
const { deriveFormat, extractTimeControlFromPgn, CHESSCOM_TYPE_MAP } = require('../format');

// Chess.com API time_class is not stored in the DB — we derive it from source
// and the PGN [TimeControl] header. Daily games in Chess.com PGN often have
// [TimeControl "1/86400"] or similar.
// For source='chesscom' games we fall back to PGN time control parsing since
// time_class was never persisted.

async function run() {
  console.log('── Backfill: games.format + games.time_control ──');

  // Fetch all games (id, pgn, source, format, time_control).
  const { rows: games } = await pool.query(
    `SELECT id, pgn, source, format, time_control FROM games ORDER BY id`
  );

  console.log(`Total games: ${games.length}`);

  const counts = { classical: 0, rapid: 0, bullet: 0, unknown: 0 };
  const unknownReasons = { missing_pgn: 0, no_timecontrol_header: 0, parse_fail: 0 };
  let updated = 0;
  let alreadySet = 0;

  for (const g of games) {
    // Skip if already bucketed (idempotent).
    if (g.format && g.format !== 'unknown') {
      alreadySet++;
      counts[g.format] = (counts[g.format] || 0) + 1;
      continue;
    }

    if (!g.pgn) {
      unknownReasons.missing_pgn++;
      counts.unknown++;
      continue;
    }

    const tcStr = extractTimeControlFromPgn(g.pgn);
    let format;
    let reason = null;

    if (!tcStr) {
      format = 'unknown';
      reason = 'no_timecontrol_header';
      unknownReasons.no_timecontrol_header++;
    } else {
      format = deriveFormat({ timeControlStr: tcStr });
      if (format === 'unknown') {
        reason = 'parse_fail';
        unknownReasons.parse_fail++;
      }
    }

    counts[format] = (counts[format] || 0) + 1;

    await pool.query(
      `UPDATE games
       SET format = $1,
           time_control = COALESCE(time_control, $2)
       WHERE id = $3`,
      [format, tcStr, g.id]
    );
    updated++;

    if (format === 'unknown') {
      console.log(`  game ${g.id}: unknown — ${reason} (tc header: ${tcStr ?? 'none'})`);
    }
  }

  console.log(`\nUpdated: ${updated}  Already set (skipped): ${alreadySet}`);
  console.log('Format breakdown:');
  for (const [fmt, n] of Object.entries(counts)) {
    console.log(`  ${fmt.padEnd(10)} ${n}`);
  }
  if (counts.unknown > 0) {
    console.log('\nUnknown breakdown:');
    for (const [reason, n] of Object.entries(unknownReasons)) {
      if (n > 0) console.log(`  ${reason}: ${n}`);
    }
  }

  // ── Initialise format_game_counts for all existing users ─────────────────
  // games_since_last_batch = 0 because no format-aware batch has run yet.
  // The first batch will include all games of that format.
  console.log('\n── Backfill: format_game_counts ──');

  const { rows: userFormats } = await pool.query(`
    SELECT user_id, format, COUNT(*)::int AS game_count
    FROM games
    WHERE format IN ('classical', 'rapid', 'bullet')
    GROUP BY user_id, format
  `);

  let fgcInserted = 0;
  let fgcSkipped = 0;

  for (const row of userFormats) {
    const res = await pool.query(`
      INSERT INTO format_game_counts (user_id, format, games_since_last_batch)
      VALUES ($1, $2, 0)
      ON CONFLICT (user_id, format) DO NOTHING
    `, [row.user_id, row.format]);
    if (res.rowCount > 0) fgcInserted++;
    else fgcSkipped++;
  }

  console.log(`format_game_counts: ${fgcInserted} inserted, ${fgcSkipped} already existed (skipped)`);
  console.log('\nBackfill complete.');
  await pool.end();
}

run().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
