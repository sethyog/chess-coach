'use strict';

// Backfill the revised P03/P11 descriptions (double-edged isolated-pawn
// nuance on P03; "trade pieces not pawns" nuance on P11).
//
// Run once manually:
//   DATABASE_URL=... node server/migrations/backfill-p03-p11-descriptions.js
//
// Guarded on the exact old description text, so this only ever converts
// old -> new once. If a description no longer matches (already migrated,
// or manually edited since), that row is left alone and reported as
// skipped — this will never clobber a later manual edit.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pool } = require('../db');

const UPDATES = [
  {
    id: 'P03',
    oldDescription: 'Pawn weaknesses become long-term targets and restrict piece mobility.',
    newDescription: "Pawn weaknesses like isolated or backward pawns become long-term targets and restrict piece mobility — though an isolated pawn can grant open lines and active piece play while more pieces remain on the board, so weigh both sides before creating one.",
  },
  {
    id: 'P11',
    oldDescription: 'Simplification converts a material advantage by clearing a path to the endgame.',
    newDescription: "Simplification converts a material advantage by clearing a path to the endgame — prefer trading pieces over pawns when ahead, to reduce your opponent's counterplay while keeping your structural advantages intact.",
  },
];

async function run() {
  console.log('── Backfill: P03/P11 descriptions ──');

  for (const { id, oldDescription, newDescription } of UPDATES) {
    const { rows: [current] } = await pool.query('SELECT description FROM principles WHERE id = $1', [id]);
    if (!current) {
      console.log(`  ${id}: not found — skipped`);
      continue;
    }
    if (current.description !== oldDescription) {
      console.log(`  ${id}: description doesn't match the expected old text — skipped (already migrated, or edited since)`);
      continue;
    }
    await pool.query('UPDATE principles SET description = $1 WHERE id = $2', [newDescription, id]);
    console.log(`  ${id}: updated`);
  }

  console.log('\nDone.');
  await pool.end();
}

run().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
