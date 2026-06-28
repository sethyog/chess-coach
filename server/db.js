'use strict';

const { Pool } = require('pg');
const { buildVocab, vectorize } = require('./embeddings');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function tableExists(client, name) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name]
  );
  return res.rows.length > 0;
}

async function columnExists(client, table, column) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return res.rows.length > 0;
}

// === Seed data ===============================================================

const PRINCIPLES_SEED = [
  ['P01', 'Castle early to protect your king', 'Move the king to safety behind a pawn shield within the first 10-15 moves.', 'intermediate', 'king safety', 'Leaving the king on e1 past move 12 while developing other pieces.'],
  ['P02', 'Rooks belong on open files', 'Place rooks on files with no pawns so they project power down the board.', 'intermediate', 'rook placement', 'Keeping a rook on a1 behind a pawn chain when the e-file is open.'],
  ['P03', "Don't create isolated or backward pawns", 'Pawn weaknesses become long-term targets and restrict piece mobility.', 'intermediate', 'pawn structure', 'Allowing an isolated d-pawn from a capture sequence without compensating piece activity.'],
  ['P04', 'Complete development before attacking', 'Get all minor pieces out and the king castled before launching an attack.', 'intermediate', 'development', 'Sacrificing on f7 with one knight developed and rooks still on a1/h1.'],
  ['P05', 'Control the centre with pawns or pieces', 'Central squares (d4, e4, d5, e5) are the highest-leverage real estate on the board.', 'intermediate', 'centre control', 'Playing fianchettos on both sides without challenging d4 or e4.'],
  ['P06', "Don't move the same piece twice in the opening", 'Each opening tempo is precious; every move should bring a new piece into play.', 'intermediate', 'development', 'Playing Nf3 then retreating to g1 in the first 10 moves.'],
  ['P07', 'Connect your rooks', 'Clear the back rank so rooks defend each other and can double on files.', 'intermediate', 'rook placement', 'Leaving the queen on d1 blocking rook coordination for many moves.'],
  ['P08', 'Avoid premature queen development', 'Bringing the queen out early invites tempo-losing attacks by minor pieces.', 'intermediate', 'development', 'Playing 2.Qh5 against a prepared opponent who chases it with ...Nf6 and ...g6.'],
  ['P09', 'Exploit outpost squares for your pieces', 'A knight on a strong outpost (d5, e5, d4, e4) is often more valuable than a bishop.', 'intermediate', 'piece activity', 'Trading off a knight that was about to land on a permanent d5 outpost.'],
  ['P10', 'Keep your pieces coordinated', 'Pieces working together attack and defend more efficiently than scattered pieces.', 'intermediate', 'piece coordination', 'Pushing a flank attack while your queenside pieces sit on their original squares.'],
  ['P11', 'Trade pieces when ahead in material', 'Simplification converts a material advantage by clearing a path to the endgame.', 'intermediate', 'endgame basics', 'Avoiding a queen trade when up a pawn in a balanced position.'],
  ['P12', 'Avoid pins that restrict your piece activity', 'A pinned piece cannot move freely and becomes a target; recognise pins before they cost material.', 'intermediate', 'tactical awareness', 'Allowing Bb5 pinning a knight to the king, then playing a move that needs that knight.'],
  ['P13', "Don't block your own bishops with pawns", "Bishops need diagonals; pawns on the bishop's colour suffocate it.", 'intermediate', 'piece activity', 'Playing e3 then b3 and caging in the dark-square bishop.'],
  ['P14', 'Activate your king in the endgame', "Once queens are off the board, the king is a fighting piece and belongs in the action.", 'intermediate', 'endgame basics', "Keeping the king on g1 while the opponent's king reaches e4 in a pawn endgame."],
  ['P15', 'Avoid doubled pawns without compensation', 'Doubled pawns lose flexibility unless they open a file or control key squares.', 'intermediate', 'pawn structure', 'Recapturing with the f-pawn instead of the queen and getting nothing for the doubled f-pawn.'],
  ['P16', "Check for opponent's threats before moving", "Every move, ask what the opponent now attacks — missing a one-mover threat costs games.", 'intermediate', 'tactical awareness', 'Playing a developing move while ignoring a piece your opponent just attacked.'],
  ['P17', 'Look for forcing moves first — checks, captures, threats', "Forcing moves limit the opponent's replies and reveal tactics faster than quiet moves.", 'intermediate', 'tactical awareness', 'Playing a slow positional move when Bxh7+ wins material.'],
  ['P18', 'Push passed pawns aggressively in the endgame', 'Passed pawns gain power as they advance; speed of promotion often decides endgames.', 'intermediate', 'endgame basics', 'Stopping to defend a non-critical pawn while your passer sits on its starting square.'],
  ['P19', 'Improve your worst-placed piece', 'The piece doing the least defines your position; activating it is usually the highest-leverage move.', 'intermediate', 'piece activity', 'Doubling rooks on the open file while a bishop on c8 has not moved all game.'],
  ['P20', 'Recapture toward the centre when possible', 'Capturing inward strengthens central pawns and opens better files for rooks.', 'intermediate', 'pawn structure', 'Recapturing on c3 with the b-pawn instead of the d-pawn and weakening the centre.'],
  ['P21', "Don't give up the bishop pair without compensation", 'Two bishops cover all squares and shine in open positions — keep them unless you get something concrete.', 'intermediate', 'piece activity', 'Trading bishop for knight in a position that is about to open up.'],
  ['P22', "Anticipate the opponent's plan before pursuing your own", "Prophylactic moves prevent enemy threats; chess is a two-player game.", 'intermediate', 'piece coordination', "Launching a queenside attack without addressing the opponent's pawn break on the kingside."],
  ['P23', 'Match piece type to pawn structure', 'Bishops thrive in open positions; knights prefer closed ones. Trade your worse-suited piece.', 'intermediate', 'piece activity', 'Trading a knight for a bishop in a locked pawn structure.'],
  ['P24', "Don't push pawns in front of a castled king without strong reason", "Pawn moves near the king create permanent weaknesses; verify there's a concrete need first.", 'intermediate', 'king safety', 'Playing h3 to prevent a future Bg4 when no bishop is threatening that square.'],
  ['P25', "Don't release pawn tension prematurely", "Capturing or pushing a tense pawn locks in the structure; keep options open until you understand the position.", 'intermediate', 'pawn structure', 'Playing cxd5 when the tension favored you, simplifying things for the opponent.'],
];

const PRINCIPLE_THEMES_SEED = [
  ['P01', 'kingsideAttack'], ['P01', 'attackingF2F7'],
  ['P02', 'middlegame'], ['P02', 'rookEndgame'],
  ['P03', 'middlegame'],
  ['P04', 'opening'], ['P04', 'attackingF2F7'],
  ['P05', 'opening'], ['P05', 'middlegame'],
  ['P06', 'opening'],
  ['P07', 'backRankMate'], ['P07', 'middlegame'],
  ['P08', 'opening'], ['P08', 'hangingPiece'],
  ['P09', 'middlegame'], ['P09', 'advantage'],
  ['P10', 'middlegame'], ['P10', 'trappedPiece'],
  ['P11', 'endgame'], ['P11', 'advantage'],
  ['P12', 'pin'],
  ['P13', 'middlegame'], ['P13', 'bishopEndgame'],
  ['P14', 'endgame'], ['P14', 'pawnEndgame'],
  ['P15', 'middlegame'], ['P15', 'pawnEndgame'],
  ['P16', 'hangingPiece'], ['P16', 'fork'],
  ['P17', 'fork'], ['P17', 'pin'], ['P17', 'skewer'], ['P17', 'doubleCheck'], ['P17', 'discoveredAttack'],
  ['P18', 'endgame'], ['P18', 'promotion'], ['P18', 'pawnEndgame'],
  ['P19', 'middlegame'], ['P19', 'trappedPiece'],
  ['P20', 'opening'], ['P20', 'middlegame'],
  ['P21', 'middlegame'], ['P21', 'advantage'],
  ['P22', 'defensiveMove'],
  ['P23', 'middlegame'], ['P23', 'advantage'],
  ['P24', 'kingsideAttack'], ['P24', 'attackingF2F7'], ['P24', 'exposedKing'],
  ['P25', 'middlegame'],
];

// === initDb =================================================================
// Creates all tables, indexes, and seeds reference data. Safe to call on every
// restart — all DDL is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
async function initDb() {
  const client = await pool.connect();
  try {
    // ── users ────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        google_id TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        name TEXT,
        avatar_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    if (!await columnExists(client, 'users', 'role')) {
      await client.query("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
      console.log("Migration: added users.role (default 'user')");
    }

    // ── One-time auth rebuild ────────────────────────────────────────────────
    // Drop pre-auth tables that were created without user_id so they can be
    // recreated with proper scoping below. Principles is never touched.
    const gamesExists = await tableExists(client, 'games');
    if (gamesExists && !await columnExists(client, 'games', 'user_id')) {
      await client.query('DROP TABLE IF EXISTS pattern_analyses CASCADE');
      await client.query('DROP TABLE IF EXISTS conversations CASCADE');
      await client.query('DROP TABLE IF EXISTS moves CASCADE');
      await client.query('DROP TABLE IF EXISTS player_profile CASCADE');
      await client.query('DROP TABLE IF EXISTS games CASCADE');
      console.log('Migration: dropped legacy data tables for auth rebuild');
    }

    // ── Data tables ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        pgn TEXT NOT NULL,
        opponent TEXT,
        result TEXT,
        played_at TIMESTAMPTZ DEFAULT NOW(),
        source TEXT DEFAULT 'manual',
        external_id TEXT,
        chesscom_username TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    if (!await columnExists(client, 'games', 'user_color')) {
      await client.query('ALTER TABLE games ADD COLUMN user_color TEXT');
      console.log('Migration: added games.user_color');
    }

    if (!await columnExists(client, 'games', 'time_control')) {
      await client.query('ALTER TABLE games ADD COLUMN time_control TEXT');
      console.log('Migration: added games.time_control');
    }

    if (!await columnExists(client, 'games', 'format')) {
      await client.query(`ALTER TABLE games ADD COLUMN format TEXT
        CHECK (format IN ('classical', 'rapid', 'bullet', 'unknown')) DEFAULT 'unknown'`);
      console.log("Migration: added games.format (default 'unknown')");
    }

    // Composite unique index on (user_id, external_id). Two users who played
    // each other can both import the same Chess.com game. NULLs are distinct
    // in Postgres (same semantics as SQLite), so Layer-3 PGN dedup still
    // covers games whose Site URL didn't parse.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_games_external_id
      ON games(user_id, external_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS moves (
        id SERIAL PRIMARY KEY,
        game_id INTEGER NOT NULL,
        move_number INTEGER NOT NULL,
        move TEXT NOT NULL,
        fen TEXT NOT NULL,
        classification TEXT,
        centipawn_loss INTEGER,
        principle_violated TEXT,
        FOREIGN KEY (game_id) REFERENCES games(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        move_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (move_id) REFERENCES moves(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS player_profile (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE,
        reported_rating INTEGER,
        computed_level TEXT,
        avg_centipawn_loss DOUBLE PRECISION,
        blunder_rate DOUBLE PRECISION,
        conceptual_profile TEXT,
        profile_updated_at TIMESTAMPTZ,
        chesscom_username TEXT,
        last_import_at TIMESTAMPTZ,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pattern_analyses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        game_ids TEXT,
        results TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // ── principles (shared reference data) ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS principles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        level TEXT,
        category TEXT,
        examples TEXT
      )
    `);

    const principleCount = (await client.query('SELECT COUNT(*)::int AS n FROM principles')).rows[0].n;
    if (principleCount === 0) {
      for (const row of PRINCIPLES_SEED) {
        await client.query(
          'INSERT INTO principles (id, name, description, level, category, examples) VALUES ($1, $2, $3, $4, $5, $6)',
          row
        );
      }
      console.log(`Migration: seeded ${PRINCIPLES_SEED.length} principles`);
    }

    // ── principle_themes ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS principle_themes (
        id SERIAL PRIMARY KEY,
        principle_id TEXT NOT NULL,
        lichess_theme TEXT NOT NULL,
        UNIQUE(principle_id, lichess_theme),
        FOREIGN KEY (principle_id) REFERENCES principles(id)
      )
    `);

    const themeCount = (await client.query('SELECT COUNT(*)::int AS n FROM principle_themes')).rows[0].n;
    if (themeCount === 0) {
      for (const [principleId, lichessTheme] of PRINCIPLE_THEMES_SEED) {
        await client.query(
          'INSERT INTO principle_themes (principle_id, lichess_theme) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [principleId, lichessTheme]
        );
      }
      console.log(`Migration: seeded ${PRINCIPLE_THEMES_SEED.length} principle_theme mappings`);
    }

    // ── principle_embeddings ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS principle_embeddings (
        principle_id TEXT PRIMARY KEY,
        vector TEXT NOT NULL,
        FOREIGN KEY (principle_id) REFERENCES principles(id)
      )
    `);

    const allPrinciples = (await client.query('SELECT id, name, description FROM principles ORDER BY id')).rows;
    const embeddedIds = new Set(
      (await client.query('SELECT principle_id FROM principle_embeddings')).rows.map(r => r.principle_id)
    );
    const anyMissingEmbedding = allPrinciples.some(p => !embeddedIds.has(p.id));
    if (anyMissingEmbedding && allPrinciples.length > 0) {
      const corpus = allPrinciples.map(p => `${p.name} ${p.description || ''}`);
      const vocab = buildVocab(corpus);
      for (let i = 0; i < allPrinciples.length; i++) {
        const vec = vectorize(corpus[i], vocab);
        await client.query(
          `INSERT INTO principle_embeddings (principle_id, vector) VALUES ($1, $2)
           ON CONFLICT (principle_id) DO UPDATE SET vector = EXCLUDED.vector`,
          [allPrinciples[i].id, JSON.stringify(vec)]
        );
      }
      console.log(`Migration: cached ${allPrinciples.length} principle embeddings (vocab=${vocab.length} tokens)`);
    }

    // ── principle_candidates ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS principle_candidates (
        id SERIAL PRIMARY KEY,
        suggested_name TEXT NOT NULL,
        suggested_description TEXT,
        proposed_lichess_theme TEXT,
        similarity_score DOUBLE PRECISION,
        most_similar_principle_id TEXT,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        distinct_user_count INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        routing TEXT,
        promoted_principle_id TEXT,
        merged_into_principle_id TEXT,
        first_seen TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW(),
        decided_at TIMESTAMPTZ,
        FOREIGN KEY (most_similar_principle_id) REFERENCES principles(id),
        FOREIGN KEY (promoted_principle_id) REFERENCES principles(id),
        FOREIGN KEY (merged_into_principle_id) REFERENCES principles(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS principle_candidate_users (
        candidate_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(candidate_id, user_id),
        FOREIGN KEY (candidate_id) REFERENCES principle_candidates(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_lower_name ON principle_candidates(LOWER(suggested_name))`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_status ON principle_candidates(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_routing ON principle_candidates(routing)`);

    // ── coaching_facts ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS coaching_facts (
        move_id INTEGER PRIMARY KEY,
        facts TEXT NOT NULL,
        computed_at TIMESTAMPTZ DEFAULT NOW(),
        engine_calls_used INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (move_id) REFERENCES moves(id)
      )
    `);

    if (!await columnExists(client, 'coaching_facts', 'engine_calls_used')) {
      await client.query('ALTER TABLE coaching_facts ADD COLUMN engine_calls_used INTEGER NOT NULL DEFAULT 0');
      console.log('Migration: added coaching_facts.engine_calls_used');
    }

    // ── analysis_batches ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS analysis_batches (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        format TEXT NOT NULL
          CHECK (format IN ('classical', 'rapid', 'bullet', 'all')),
        game_ids JSONB NOT NULL,
        game_count INTEGER NOT NULL,
        batch_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'completed', 'failed')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        UNIQUE(user_id, format, batch_number)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_analysis_batches_user_format ON analysis_batches(user_id, format)`);

    // ── format_game_counts ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS format_game_counts (
        user_id INTEGER NOT NULL REFERENCES users(id),
        format TEXT NOT NULL
          CHECK (format IN ('classical', 'rapid', 'bullet')),
        games_since_last_batch INTEGER NOT NULL DEFAULT 0,
        last_batch_completed_at TIMESTAMPTZ,
        PRIMARY KEY (user_id, format)
      )
    `);

    // ── pattern_analyses — format columns ────────────────────────────────────
    if (!await columnExists(client, 'pattern_analyses', 'format')) {
      await client.query(`ALTER TABLE pattern_analyses ADD COLUMN format TEXT
        CHECK (format IN ('classical', 'rapid', 'bullet', 'all')) DEFAULT 'all'`);
      // Mark pre-existing rows as legacy 'all' (they predate format-aware analysis).
      await client.query(`UPDATE pattern_analyses SET format = 'all' WHERE format IS NULL`);
      console.log("Migration: added pattern_analyses.format (existing rows set to 'all')");
    }

    if (!await columnExists(client, 'pattern_analyses', 'batch_id')) {
      await client.query(`ALTER TABLE pattern_analyses ADD COLUMN batch_id INTEGER REFERENCES analysis_batches(id)`);
      console.log('Migration: added pattern_analyses.batch_id');
    }

    if (!await columnExists(client, 'pattern_analyses', 'batch_number')) {
      await client.query('ALTER TABLE pattern_analyses ADD COLUMN batch_number INTEGER');
      console.log('Migration: added pattern_analyses.batch_number');
    }

    console.log('Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction, initDb };
