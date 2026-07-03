'use strict';

// Clear all per-move Stockfish analysis so games can be re-analysed.
// Deletes: coaching_facts, conversations, moves (in dependency order).
// Games are preserved. Run reanalyze-all-games.js next to repopulate moves.
//
// Run with:  DATABASE_URL=<railway_url> node server/scripts/clear-move-analysis.js

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pool } = require('../db');

async function main() {
  const client = await pool.connect();
  try {
    // Count before
    const { rows: [{ count: movesBefore }] }    = await client.query('SELECT COUNT(*) FROM moves');
    const { rows: [{ count: convBefore }] }     = await client.query('SELECT COUNT(*) FROM conversations');
    const { rows: [{ count: factsBefore }] }    = await client.query('SELECT COUNT(*) FROM coaching_facts');

    console.log('── Before ───────────────────────────────────────');
    console.log(`  moves:          ${movesBefore}`);
    console.log(`  conversations:  ${convBefore}`);
    console.log(`  coaching_facts: ${factsBefore}`);
    console.log('─────────────────────────────────────────────────\n');

    console.log('Step 1: Deleting coaching_facts...');
    const cf = await client.query('DELETE FROM coaching_facts');
    console.log(`  deleted ${cf.rowCount} row(s)`);

    console.log('Step 2: Deleting conversations...');
    const cv = await client.query('DELETE FROM conversations');
    console.log(`  deleted ${cv.rowCount} row(s)`);

    console.log('Step 3: Deleting moves...');
    const mv = await client.query('DELETE FROM moves');
    console.log(`  deleted ${mv.rowCount} row(s)`);

    console.log('\n── Verification ──────────────────────────────────');
    const { rows: [{ count: movesAfter }] }  = await client.query('SELECT COUNT(*) FROM moves');
    const { rows: [{ count: convAfter }] }   = await client.query('SELECT COUNT(*) FROM conversations');
    const { rows: [{ count: factsAfter }] }  = await client.query('SELECT COUNT(*) FROM coaching_facts');
    console.log(`  moves:          ${movesAfter}  (expect 0)`);
    console.log(`  conversations:  ${convAfter}  (expect 0)`);
    console.log(`  coaching_facts: ${factsAfter}  (expect 0)`);

    const { rows: [{ count: games }] } = await client.query('SELECT COUNT(*) FROM games');
    console.log(`\n  games preserved: ${games}`);
    console.log('\nDone. Re-open any flagged move to trigger fresh analysis.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
