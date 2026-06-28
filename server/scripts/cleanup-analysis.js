'use strict';

// One-time cleanup: reset all analysis state to a known-empty baseline.
// Run with:  DATABASE_URL=<railway_url> node server/scripts/cleanup-analysis.js

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pool } = require('../db');

async function main() {
  const client = await pool.connect();
  try {
    console.log('Step 1: Deleting all pattern_analyses...');
    const pa = await client.query('DELETE FROM pattern_analyses');
    console.log(`  deleted ${pa.rowCount} row(s)`);

    console.log('Step 2: Deleting all analysis_batches...');
    const ab = await client.query('DELETE FROM analysis_batches');
    console.log(`  deleted ${ab.rowCount} row(s)`);

    console.log('Step 3: Resetting format_game_counts to actual game counts (moves preserved)...');
    const fgc = await client.query(`
      UPDATE format_game_counts fgc
      SET games_since_last_batch = (
        SELECT COUNT(*)::int FROM games g
        WHERE g.user_id = fgc.user_id AND g.format = fgc.format
      ),
      last_batch_completed_at = NULL
    `);
    console.log(`  updated ${fgc.rowCount} row(s)`);

    console.log('\n── Verification ──────────────────────────────');

    const { rows: [{ count: paCount }] } = await client.query('SELECT COUNT(*) FROM pattern_analyses');
    console.log(`pattern_analyses count:   ${paCount}  (expect 0)`);

    const { rows: [{ count: abCount }] } = await client.query('SELECT COUNT(*) FROM analysis_batches');
    console.log(`analysis_batches count:   ${abCount}  (expect 0)`);

    const { rows: fgcRows } = await client.query(
      `SELECT user_id, format, games_since_last_batch, last_batch_completed_at
       FROM format_game_counts
       ORDER BY user_id, format`
    );
    console.log('\nformat_game_counts:');
    for (const r of fgcRows) {
      console.log(`  user=${r.user_id}  format=${r.format}  games_since_last_batch=${r.games_since_last_batch}  last_batch_completed_at=${r.last_batch_completed_at}`);
    }
    console.log('\nDone.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
