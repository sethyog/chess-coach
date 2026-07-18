'use strict';

// Retire P14 ("Activate your king in the endgame"), a duplicate of P27
// ("Route the endgame king to key squares").
//
// Run once manually:
//   DATABASE_URL=... node server/migrations/retire-p14.js
//
// Hard delete, chosen over adding a soft-delete convention since none
// exists elsewhere in this schema. Clears every FK that could point at P14
// before deleting the principles row itself. Safe to run more than once —
// it's a no-op if P14 is already gone.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pool } = require('../db');

async function run() {
  console.log('── Retire P14 (duplicate of P27) ──');

  const { rows: [p14Row] } = await pool.query("SELECT id FROM principles WHERE id = 'P14'");
  if (!p14Row) {
    console.log('P14 not found — already retired, nothing to do.');
    await pool.end();
    return;
  }

  const themes = await pool.query("DELETE FROM principle_themes WHERE principle_id = 'P14'");
  console.log(`  principle_themes: deleted ${themes.rowCount} row(s)`);

  const embeddings = await pool.query("DELETE FROM principle_embeddings WHERE principle_id = 'P14'");
  console.log(`  principle_embeddings: deleted ${embeddings.rowCount} row(s)`);

  const mostSimilar = await pool.query(
    "UPDATE principle_candidates SET most_similar_principle_id = NULL WHERE most_similar_principle_id = 'P14'"
  );
  console.log(`  principle_candidates.most_similar_principle_id: cleared ${mostSimilar.rowCount} row(s)`);

  const promoted = await pool.query(
    "UPDATE principle_candidates SET promoted_principle_id = NULL WHERE promoted_principle_id = 'P14'"
  );
  console.log(`  principle_candidates.promoted_principle_id: cleared ${promoted.rowCount} row(s)`);

  const mergedInto = await pool.query(
    "UPDATE principle_candidates SET merged_into_principle_id = NULL WHERE merged_into_principle_id = 'P14'"
  );
  console.log(`  principle_candidates.merged_into_principle_id: cleared ${mergedInto.rowCount} row(s)`);

  const deleted = await pool.query("DELETE FROM principles WHERE id = 'P14'");
  console.log(`  principles: deleted ${deleted.rowCount} row(s)`);

  console.log('\nDone. P27 remains as the surviving principle for this concept.');
  await pool.end();
}

run().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
