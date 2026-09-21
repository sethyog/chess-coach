#!/usr/bin/env node
// Wipes all user-generated data for every user or a specific user, leaving
// accounts and shared reference data (principles, principle_themes,
// principle_embeddings) intact.
//
// Usage:
//   node server/scripts/reset-user-data.js --confirm                    # All users
//   node server/scripts/reset-user-data.js --email user@example.com     # Dry run for specific user
//   node server/scripts/reset-user-data.js --email user@example.com --confirm  # Delete specific user data
//
// Without --confirm the script runs in dry-run mode and prints row counts only.

require('dotenv').config();
const { Pool } = require('pg');

const DRY_RUN = !process.argv.includes('--confirm');
const EMAIL_INDEX = process.argv.indexOf('--email');
const USER_EMAIL = EMAIL_INDEX !== -1 ? process.argv[EMAIL_INDEX + 1] : null;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Deletion order respects FK constraints (children before parents).
// Each step can optionally specify a join path to filter by user_id.
const STEPS = [
  { table: 'conversations',           desc: 'coaching conversations',        viaTable: 'moves' },
  { table: 'coaching_facts',          desc: 'cached coaching facts',         viaTable: 'moves' },
  { table: 'moves',                   desc: 'game moves',                    viaTable: 'games' },
  { table: 'games',                   desc: 'imported games',                userIdColumn: 'user_id' },
  { table: 'pattern_analyses',        desc: 'pattern analysis results',      userIdColumn: 'user_id' },
  { table: 'analysis_batches',        desc: 'analysis batches',              userIdColumn: 'user_id' },
  { table: 'format_game_counts',      desc: 'per-format game counters',      userIdColumn: 'user_id' },
  { table: 'progression_summaries',   desc: 'cached progression summaries',  userIdColumn: 'user_id' },
  { table: 'player_profile',          desc: 'player profiles',               userIdColumn: 'user_id' },
  { table: 'principle_candidate_users', desc: 'candidate attribution links', userIdColumn: 'user_id' },
  { table: 'principle_candidates',    desc: 'unreviewed principle candidates', viaCandidateUsers: true },
];

async function main() {
  const client = await pool.connect();
  try {
    let userId = null;
    let userInfo = '';

    // Resolve email to user_id if --email was provided
    if (USER_EMAIL) {
      const { rows } = await client.query(
        'SELECT id, email, name FROM users WHERE LOWER(email) = LOWER($1)',
        [USER_EMAIL]
      );
      if (rows.length === 0) {
        console.error(`Error: No user found with email: ${USER_EMAIL}`);
        process.exit(1);
      }
      userId = rows[0].id;
      userInfo = ` for user: ${rows[0].name || rows[0].email} (ID: ${userId})`;
    }

    if (DRY_RUN) {
      console.log(`DRY RUN — pass --confirm to actually delete${userInfo}\n`);
    } else {
      console.log(`LIVE RUN — deleting${userId ? ' user' : ' all'} data${userInfo}\n`);
    }

    // Count rows first so the user can see what will be affected.
    for (const { table, desc, userIdColumn, viaTable, viaCandidateUsers } of STEPS) {
      let countQuery;
      let params = [];

      if (userId) {
        if (userIdColumn) {
          // Simple case: table has user_id column
          countQuery = `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${userIdColumn} = $1`;
          params = [userId];
        } else if (viaTable) {
          // Complex case: need to join through another table
          if (viaTable === 'games') {
            // moves -> games
            countQuery = `SELECT COUNT(*)::int AS n FROM ${table} 
                         WHERE game_id IN (SELECT id FROM games WHERE user_id = $1)`;
            params = [userId];
          } else if (viaTable === 'moves') {
            // conversations, coaching_facts -> moves -> games
            countQuery = `SELECT COUNT(*)::int AS n FROM ${table} 
                         WHERE move_id IN (
                           SELECT id FROM moves WHERE game_id IN (
                             SELECT id FROM games WHERE user_id = $1
                           )
                         )`;
            params = [userId];
          }
        } else if (viaCandidateUsers) {
          // principle_candidates via principle_candidate_users
          countQuery = `SELECT COUNT(*)::int AS n FROM ${table} pc
                       WHERE EXISTS (
                         SELECT 1 FROM principle_candidate_users pcu 
                         WHERE pcu.candidate_id = pc.id AND pcu.user_id = $1
                       )`;
          params = [userId];
        } else {
          // Skip tables that can't be filtered by user
          countQuery = `SELECT 0::int AS n`;
        }
      } else {
        // All users: simple count
        countQuery = `SELECT COUNT(*)::int AS n FROM ${table}`;
      }

      const { rows } = await client.query(countQuery, params);
      console.log(`  ${rows[0].n.toString().padStart(6)}  ${desc} (${table})`);
    }

    if (userId) {
      console.log(`\n  User account (PRESERVED): ${USER_EMAIL}\n`);
    } else {
      const { rows: userRows } = await client.query('SELECT COUNT(*)::int AS n FROM users');
      console.log(`\n  ${userRows[0].n.toString().padStart(6)}  user accounts (PRESERVED)\n`);
    }

    if (DRY_RUN) {
      console.log('Re-run with --confirm to delete the rows above.');
      return;
    }

    await client.query('BEGIN');

    let totalDeleted = 0;
    for (const { table, desc, userIdColumn, viaTable, viaCandidateUsers } of STEPS) {
      let deleteQuery;
      let params = [];

      if (userId) {
        if (userIdColumn) {
          // Simple case: table has user_id column
          deleteQuery = `DELETE FROM ${table} WHERE ${userIdColumn} = $1`;
          params = [userId];
        } else if (viaTable) {
          // Complex case: need to filter via subquery
          if (viaTable === 'games') {
            // moves -> games
            deleteQuery = `DELETE FROM ${table} 
                          WHERE game_id IN (SELECT id FROM games WHERE user_id = $1)`;
            params = [userId];
          } else if (viaTable === 'moves') {
            // conversations, coaching_facts -> moves -> games
            deleteQuery = `DELETE FROM ${table} 
                          WHERE move_id IN (
                            SELECT id FROM moves WHERE game_id IN (
                              SELECT id FROM games WHERE user_id = $1
                            )
                          )`;
            params = [userId];
          }
        } else if (viaCandidateUsers) {
          // principle_candidates via principle_candidate_users
          deleteQuery = `DELETE FROM ${table} 
                        WHERE id IN (
                          SELECT candidate_id FROM principle_candidate_users 
                          WHERE user_id = $1
                        )`;
          params = [userId];
        } else {
          // Skip tables that can't be filtered by user
          continue;
        }
      } else {
        // All users: delete everything
        deleteQuery = `DELETE FROM ${table}`;
      }

      const { rowCount } = await client.query(deleteQuery, params);
      totalDeleted += rowCount;
      console.log(`  deleted ${rowCount} rows from ${table} (${desc})`);
    }

    await client.query('COMMIT');
    
    if (userId) {
      console.log(`\nDone. Deleted ${totalDeleted} rows for ${USER_EMAIL}; account intact.`);
    } else {
      console.log('\nDone. All user data cleared; accounts and principles intact.');
    }
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
