#!/usr/bin/env node
// Wipes all user-generated data for every user, leaving accounts and shared
// reference data (principles, principle_themes, principle_embeddings) intact.
//
// Usage:
//   node server/scripts/reset-user-data.js --confirm
//
// Without --confirm the script runs in dry-run mode and prints row counts only.

require('dotenv').config();
const { Pool } = require('pg');

const DRY_RUN = !process.argv.includes('--confirm');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Deletion order respects FK constraints (children before parents).
const STEPS = [
  { table: 'conversations',           desc: 'coaching conversations'        },
  { table: 'coaching_facts',          desc: 'cached coaching facts'         },
  { table: 'moves',                   desc: 'game moves'                    },
  { table: 'games',                   desc: 'imported games'                },
  { table: 'pattern_analyses',        desc: 'pattern analysis results'      },
  { table: 'analysis_batches',        desc: 'analysis batches'              },
  { table: 'format_game_counts',      desc: 'per-format game counters'      },
  { table: 'progression_summaries',   desc: 'cached progression summaries'  },
  { table: 'player_profile',          desc: 'player profiles'               },
  { table: 'principle_candidate_users', desc: 'candidate attribution links' },
  { table: 'principle_candidates',    desc: 'unreviewed principle candidates'},
];

async function main() {
  const client = await pool.connect();
  try {
    if (DRY_RUN) {
      console.log('DRY RUN — pass --confirm to actually delete\n');
    } else {
      console.log('LIVE RUN — deleting all user data\n');
    }

    // Count rows first so the user can see what will be affected.
    for (const { table, desc } of STEPS) {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      console.log(`  ${rows[0].n.toString().padStart(6)}  ${desc} (${table})`);
    }

    const { rows: userRows } = await client.query('SELECT COUNT(*)::int AS n FROM users');
    console.log(`\n  ${userRows[0].n.toString().padStart(6)}  user accounts (PRESERVED)\n`);

    if (DRY_RUN) {
      console.log('Re-run with --confirm to delete the rows above.');
      return;
    }

    await client.query('BEGIN');

    for (const { table, desc } of STEPS) {
      const { rowCount } = await client.query(`DELETE FROM ${table}`);
      console.log(`  deleted ${rowCount} rows from ${table} (${desc})`);
    }

    await client.query('COMMIT');
    console.log('\nDone. All user data cleared; accounts and principles intact.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nError — rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
