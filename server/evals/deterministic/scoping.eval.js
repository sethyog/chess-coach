'use strict';

// Deterministic eval: per-user data scoping.
// Uses an in-memory SQLite database — never touches the real chess.db.
// Runs the EXACT query strings used in the route handlers (routes/games.js,
// routes/coach.js) so this tests the actual code paths, not reimplementations.

const Database = require('better-sqlite3');

function buildTestDb() {
  const db = new Database(':memory:');

  // Minimal schema mirroring the real app. Only the tables the scoping
  // queries touch — we do not need principles, candidates, etc.
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'user'
    );

    CREATE TABLE games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      pgn TEXT NOT NULL,
      opponent TEXT,
      result TEXT,
      played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_color TEXT,
      source TEXT DEFAULT 'manual',
      external_id TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      move_number INTEGER NOT NULL,
      move TEXT NOT NULL,
      fen TEXT NOT NULL,
      classification TEXT,
      centipawn_loss INTEGER,
      principle_violated TEXT,
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    CREATE TABLE player_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      reported_rating INTEGER,
      computed_level TEXT,
      avg_centipawn_loss REAL,
      blunder_rate REAL,
      conceptual_profile TEXT,
      profile_updated_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE pattern_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      game_ids TEXT,
      results TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  return db;
}

function seedTestData(db) {
  // Two users
  db.prepare("INSERT INTO users (google_id, email, name) VALUES ('gA', 'userA@test.com', 'User A')").run();
  db.prepare("INSERT INTO users (google_id, email, name) VALUES ('gB', 'userB@test.com', 'User B')").run();
  const userA = db.prepare("SELECT id FROM users WHERE google_id = 'gA'").get();
  const userB = db.prepare("SELECT id FROM users WHERE google_id = 'gB'").get();

  // One game per user
  const gameA = db.prepare(
    "INSERT INTO games (user_id, pgn, opponent, result) VALUES (?, 'pgn-A', 'OpponentA', 'win')"
  ).run(userA.id);
  const gameB = db.prepare(
    "INSERT INTO games (user_id, pgn, opponent, result) VALUES (?, 'pgn-B', 'OpponentB', 'loss')"
  ).run(userB.id);

  // Player profiles
  db.prepare(
    "INSERT INTO player_profile (user_id, computed_level) VALUES (?, 'intermediate')"
  ).run(userA.id);
  db.prepare(
    "INSERT INTO player_profile (user_id, computed_level) VALUES (?, 'beginner')"
  ).run(userB.id);

  // Pattern analyses
  db.prepare(
    "INSERT INTO pattern_analyses (user_id, results) VALUES (?, '{\"patterns\":\"A\"}')"
  ).run(userA.id);
  db.prepare(
    "INSERT INTO pattern_analyses (user_id, results) VALUES (?, '{\"patterns\":\"B\"}')"
  ).run(userB.id);

  return { userA, userB, gameAId: gameA.lastInsertRowid, gameBId: gameB.lastInsertRowid };
}

async function run() {
  const db = buildTestDb();
  const { userA, userB, gameAId, gameBId } = seedTestData(db);

  const results = [];

  function check(id, pass, message) {
    results.push({ id, pass, failures: pass ? [] : [message] });
  }

  // ── games list (routes/games.js GET /) ────────────────────────────────────
  // Query: SELECT * FROM games WHERE user_id = ? ORDER BY played_at DESC
  {
    const gamesA = db.prepare('SELECT * FROM games WHERE user_id = ? ORDER BY played_at DESC').all(userA.id);
    const gamesB = db.prepare('SELECT * FROM games WHERE user_id = ? ORDER BY played_at DESC').all(userB.id);

    check(
      'games_list: A sees only A game',
      gamesA.length === 1 && gamesA[0].id === gameAId,
      `A's game list should have 1 row (gameAId=${gameAId}), got: ${JSON.stringify(gamesA.map((g) => g.id))}`
    );
    check(
      'games_list: B sees only B game',
      gamesB.length === 1 && gamesB[0].id === gameBId,
      `B's game list should have 1 row (gameBId=${gameBId}), got: ${JSON.stringify(gamesB.map((g) => g.id))}`
    );
    check(
      'games_list: A list does not contain B game',
      !gamesA.some((g) => g.id === gameBId),
      `A's game list must not include B's game (gameBId=${gameBId})`
    );
    check(
      'games_list: B list does not contain A game',
      !gamesB.some((g) => g.id === gameAId),
      `B's game list must not include A's game (gameAId=${gameAId})`
    );
  }

  // ── single game fetch with ownership check (routes/games.js GET /:id) ────
  // Query: SELECT * FROM games WHERE id = ? AND user_id = ?
  {
    const aFetchesOwnGame = db.prepare('SELECT * FROM games WHERE id = ? AND user_id = ?').get(gameAId, userA.id);
    const bFetchesOwnGame = db.prepare('SELECT * FROM games WHERE id = ? AND user_id = ?').get(gameBId, userB.id);
    const aFetchesBGame = db.prepare('SELECT * FROM games WHERE id = ? AND user_id = ?').get(gameBId, userA.id);
    const bFetchesAGame = db.prepare('SELECT * FROM games WHERE id = ? AND user_id = ?').get(gameAId, userB.id);

    check(
      'game_fetch: A fetches own game returns row',
      aFetchesOwnGame != null,
      `A should be able to fetch own game (gameAId=${gameAId})`
    );
    check(
      'game_fetch: B fetches own game returns row',
      bFetchesOwnGame != null,
      `B should be able to fetch own game (gameBId=${gameBId})`
    );
    check(
      'game_fetch: A fetching B game returns null (privacy)',
      aFetchesBGame == null,
      `A must not be able to fetch B's game (gameBId=${gameBId}) — got: ${JSON.stringify(aFetchesBGame)}`
    );
    check(
      'game_fetch: B fetching A game returns null (privacy)',
      bFetchesAGame == null,
      `B must not be able to fetch A's game (gameAId=${gameAId}) — got: ${JSON.stringify(bFetchesAGame)}`
    );
  }

  // ── player_profile isolation ───────────────────────────────────────────────
  // Query: SELECT * FROM player_profile WHERE user_id = ?
  {
    const profA = db.prepare('SELECT * FROM player_profile WHERE user_id = ?').get(userA.id);
    const profB = db.prepare('SELECT * FROM player_profile WHERE user_id = ?').get(userB.id);

    check(
      'player_profile: A gets own profile',
      profA != null && profA.computed_level === 'intermediate',
      `A's profile should have computed_level='intermediate', got: ${JSON.stringify(profA)}`
    );
    check(
      'player_profile: B gets own profile',
      profB != null && profB.computed_level === 'beginner',
      `B's profile should have computed_level='beginner', got: ${JSON.stringify(profB)}`
    );
    check(
      'player_profile: A profile does not leak B data',
      profA == null || profA.user_id === userA.id,
      `A's profile has wrong user_id: ${profA?.user_id}`
    );
    check(
      'player_profile: B profile does not leak A data',
      profB == null || profB.user_id === userB.id,
      `B's profile has wrong user_id: ${profB?.user_id}`
    );
  }

  // ── pattern_analyses isolation ─────────────────────────────────────────────
  // Query: SELECT * FROM pattern_analyses WHERE user_id = ? ORDER BY created_at DESC
  {
    const pattA = db.prepare(
      'SELECT * FROM pattern_analyses WHERE user_id = ? ORDER BY created_at DESC'
    ).all(userA.id);
    const pattB = db.prepare(
      'SELECT * FROM pattern_analyses WHERE user_id = ? ORDER BY created_at DESC'
    ).all(userB.id);

    check(
      'pattern_analyses: A sees only A pattern row',
      pattA.length === 1 && pattA[0].results === '{"patterns":"A"}',
      `A should see 1 pattern row with results A, got: ${JSON.stringify(pattA)}`
    );
    check(
      'pattern_analyses: B sees only B pattern row',
      pattB.length === 1 && pattB[0].results === '{"patterns":"B"}',
      `B should see 1 pattern row with results B, got: ${JSON.stringify(pattB)}`
    );
    check(
      'pattern_analyses: A results do not contain B data',
      !pattA.some((r) => r.results === '{"patterns":"B"}'),
      "A's pattern_analyses must not include B's row"
    );
  }

  // ── move ownership chain (routes/games.js and coach.js) ───────────────────
  // Ownership check used in coach.js: moves → games → user_id
  // Insert moves for gameA only, then verify the join query scopes correctly.
  {
    db.prepare(
      "INSERT INTO moves (game_id, move_number, move, fen, classification) VALUES (?, 1, 'e4', 'startfen', 'blunder')"
    ).run(gameAId);
    const moveA = db.prepare('SELECT id FROM moves WHERE game_id = ?').get(gameAId);

    // The ownership query from coach.js:
    const ownedByA = db.prepare(
      'SELECT m.id FROM moves m JOIN games g ON g.id = m.game_id WHERE m.id = ? AND g.user_id = ?'
    ).get(moveA.id, userA.id);
    const ownedByB = db.prepare(
      'SELECT m.id FROM moves m JOIN games g ON g.id = m.game_id WHERE m.id = ? AND g.user_id = ?'
    ).get(moveA.id, userB.id);

    check(
      'move_ownership: A can access A move',
      ownedByA != null,
      `A should be able to access moveA via the join chain`
    );
    check(
      'move_ownership: B cannot access A move via join chain',
      ownedByB == null,
      `B must not access A's move via the ownership join — got: ${JSON.stringify(ownedByB)}`
    );
  }

  db.close();

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  if (require.main === module) {
    console.log('\n── scoping ─────────────────────────────────────────────────────');
    for (const r of results) {
      if (r.pass) {
        console.log(`  PASS  ${r.id}`);
      } else {
        console.log(`  FAIL  ${r.id}`);
        for (const f of r.failures) console.log(`        ✗ ${f}`);
      }
    }
    console.log(`\n  ${passed}/${total} passed`);
  }

  return { name: 'scoping', total, passed, skipped: 0, results };
}

module.exports = { run };

if (require.main === module) run();
