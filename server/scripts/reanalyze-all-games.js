'use strict';

// Re-run Stockfish analysis for every game that has no analysed moves.
// Use after clear-move-analysis.js to repopulate moves with best_move,
// eval_before, eval_after.
//
// Run with:  DATABASE_URL=<railway_url> node server/scripts/reanalyze-all-games.js

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pool, query } = require('../db');
const { analyzeGame }  = require('../analysis');

async function main() {
  // Games that have no moves row yet (either never analyzed, or just cleared).
  const { rows: games } = await query(`
    SELECT g.id, g.user_id
    FROM games g
    WHERE NOT EXISTS (SELECT 1 FROM moves m WHERE m.game_id = g.id)
    ORDER BY g.id
  `);

  console.log(`Found ${games.length} game(s) to analyze.\n`);
  if (games.length === 0) {
    console.log('Nothing to do — all games already have moves. Run clear-move-analysis.js first if you want to repopulate.');
    await pool.end();
    return;
  }

  let ok = 0, failed = 0;
  for (const { id: gameId, user_id: userId } of games) {
    try {
      const result = await analyzeGame(gameId, userId);
      if (result.skipped) {
        console.log(`  game ${gameId}: skipped (moves already exist)`);
      } else {
        console.log(`  game ${gameId}: analyzed ${result.movesAnalyzed} moves (${result.mistakeCount} mistakes, ${result.blunderCount} blunders)`);
        ok++;
      }
    } catch (err) {
      console.error(`  game ${gameId}: FAILED — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${ok} analyzed, ${failed} failed.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
