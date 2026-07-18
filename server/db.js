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
  ['P03', "Don't create isolated or backward pawns", 'Pawn weaknesses like isolated or backward pawns become long-term targets and restrict piece mobility — though an isolated pawn can grant open lines and active piece play while more pieces remain on the board, so weigh both sides before creating one.', 'intermediate', 'pawn structure', 'Allowing an isolated d-pawn from a capture sequence without compensating piece activity.'],
  ['P04', 'Complete development before attacking', 'Get all minor pieces out and the king castled before launching an attack.', 'intermediate', 'development', 'Sacrificing on f7 with one knight developed and rooks still on a1/h1.'],
  ['P05', 'Control the centre with pawns or pieces', 'Central squares (d4, e4, d5, e5) are the highest-leverage real estate on the board.', 'intermediate', 'centre control', 'Playing fianchettos on both sides without challenging d4 or e4.'],
  ['P06', "Don't move the same piece twice in the opening", 'Each opening tempo is precious; every move should bring a new piece into play.', 'intermediate', 'development', 'Playing Nf3 then retreating to g1 in the first 10 moves.'],
  ['P07', 'Connect your rooks', 'Clear the back rank so rooks defend each other and can double on files.', 'intermediate', 'rook placement', 'Leaving the queen on d1 blocking rook coordination for many moves.'],
  ['P08', 'Avoid premature queen development', 'Bringing the queen out early invites tempo-losing attacks by minor pieces.', 'intermediate', 'development', 'Playing 2.Qh5 against a prepared opponent who chases it with ...Nf6 and ...g6.'],
  ['P09', 'Exploit outpost squares for your pieces', 'A knight on a strong outpost (d5, e5, d4, e4) is often more valuable than a bishop.', 'intermediate', 'piece activity', 'Trading off a knight that was about to land on a permanent d5 outpost.'],
  ['P10', 'Keep your pieces coordinated', 'Pieces working together attack and defend more efficiently than scattered pieces.', 'intermediate', 'piece coordination', 'Pushing a flank attack while your queenside pieces sit on their original squares.'],
  ['P11', 'Trade pieces when ahead in material', "Simplification converts a material advantage by clearing a path to the endgame — prefer trading pieces over pawns when ahead, to reduce your opponent's counterplay while keeping your structural advantages intact.", 'intermediate', 'endgame basics', 'Avoiding a queen trade when up a pawn in a balanced position.'],
  ['P12', 'Avoid pins that restrict your piece activity', 'A pinned piece cannot move freely and becomes a target; recognise pins before they cost material.', 'intermediate', 'tactical awareness', 'Allowing Bb5 pinning a knight to the king, then playing a move that needs that knight.'],
  ['P13', "Don't block your own bishops with pawns", "Bishops need diagonals; pawns on the bishop's colour suffocate it.", 'intermediate', 'piece activity', 'Playing e3 then b3 and caging in the dark-square bishop.'],
  // P14 retired — duplicate of P27 ("Route the endgame king to key squares"); see the retirement migration below.
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

// BEGINNER_PRINCIPLES_SEED — level: 'beginner'
// Continues the shared `principles` table ID sequence from P29 (production
// has P01–P28; P28 already covers "develop minor pieces before rooks" at
// level=beginner, so that entry is intentionally omitted here to avoid a
// duplicate). Same shape as PRINCIPLES_SEED: [id, name, description, level,
// category, examples]
const BEGINNER_PRINCIPLES_SEED = [
  // --- Piece Safety & Tactical Awareness ---
  ['P29', 'Check for hanging pieces before moving',
    'Before playing a move, check whether it leaves any of your pieces undefended or able to be captured for free.',
    'beginner', 'piece safety',
    'Moving a pawn away from a piece it was protecting, leaving that piece hanging.'],

  ['P30', 'Scan for threats after every move',
    'After any move — yours or your opponent\'s — pause and scan the whole board for new checks, captures, and threats before deciding what to do next.',
    'beginner', 'piece safety',
    'Missing that the opponent\'s last move opened an attack on your queen.'],

  ['P31', 'Don\'t hang pieces in bad trades',
    'Don\'t move a piece to a square where it can be captured for free, or captured for less value than it\'s worth.',
    'beginner', 'piece safety',
    'Placing a knight on a square attacked by a pawn, losing it for nothing.'],

  ['P32', 'Ask what your opponent\'s move threatens',
    'When your opponent makes a move, ask what new threat it creates before you respond with your own plan.',
    'beginner', 'piece safety',
    'Ignoring that the opponent\'s bishop move now attacks a rook.'],

  ['P33', 'Watch for pins',
    'Recognize when one of your pieces is pinned (can\'t move without exposing a more valuable piece behind it) and avoid moving it carelessly.',
    'beginner', 'tactical patterns',
    'Moving a pinned knight and losing the queen behind it.'],

  ['P34', 'Watch for forks',
    'Watch for a single enemy move that attacks two of your pieces at once, since you can usually only save one.',
    'beginner', 'tactical patterns',
    'Allowing an enemy knight to fork the king and rook.'],

  ['P35', 'Watch for back-rank weaknesses',
    'Notice when your king has no escape square on the back rank, since a single rook or queen check along that rank can be checkmate.',
    'beginner', 'tactical patterns',
    'Never making a "luft" pawn move, allowing a back-rank mate later in the game.'],

  // --- Opening Principles ---
  ['P36', 'Control the center early',
    'Occupy or influence the central squares (e4, d4, e5, d5) early, since central pieces control more of the board.',
    'beginner', 'opening principles',
    'Playing e4 or d4 as an opening move.'],

  ['P37', 'Don\'t move the same piece twice without reason',
    'Avoid moving the same piece a second time in the opening unless there\'s a concrete reason — every extra move is a tempo you\'re not developing another piece.',
    'beginner', 'opening principles',
    'Shuffling a knight back and forth instead of developing a new piece.'],

  ['P38', 'Limit unnecessary pawn moves in the opening',
    'Beyond what\'s needed for center control and development, avoid making extra pawn moves early — each one delays getting your pieces out.',
    'beginner', 'opening principles',
    'Pushing several side pawns instead of developing pieces.'],

  ['P39', 'Don\'t bring your queen out too early',
    'Avoid developing your queen early, since it can be attacked and chased by minor pieces, costing you time.',
    'beginner', 'opening principles',
    'Playing an early queen sortie that gets kicked by a knight or bishop, losing tempo.'],

  ['P40', 'Castle within the first 10 moves',
    'Aim to castle relatively early in most games to get your king to safety and connect your rooks.',
    'beginner', 'opening principles',
    'Delaying castling too long and getting caught with the king in the center.'],

  // --- King Safety ---
  ['P41', 'Castle for king safety',
    'Castling tucks your king away from the center and connects your rooks — do it in most games unless there\'s a clear reason not to.',
    'beginner', 'king safety',
    'Failing to castle and getting the king caught in the center after lines open.'],

  ['P42', 'Don\'t weaken your king\'s pawn shelter without reason',
    'Avoid pushing the pawns in front of your castled king unless there\'s a concrete tactical or strategic reason.',
    'beginner', 'king safety',
    'Pushing the g-pawn near a castled king for no reason, creating attackable weaknesses.'],

  ['P43', 'Don\'t leave your king in the center as lines open',
    'Once files and diagonals start opening up (pieces traded, pawns exchanged), an uncastled king in the center becomes dangerous.',
    'beginner', 'king safety',
    'Delaying castling while the center opens, exposing the king to checks.'],

  // --- Material & Trade Evaluation ---
  ['P44', 'Know standard piece values',
    'Know the standard relative values of the pieces (pawn=1, knight/bishop≈3, rook=5, queen=9) and use them to judge whether a trade is good.',
    'beginner', 'material evaluation',
    'Trading a rook for a bishop without realizing it\'s a material loss.'],

  ['P45', 'Count material before and after a trade',
    'Before trading pieces, count what you\'re giving up and what you\'re getting to confirm the trade doesn\'t lose material.',
    'beginner', 'material evaluation',
    'Initiating a series of captures without checking who comes out ahead.'],

  ['P46', 'Don\'t trade down in value without reason',
    'Avoid trading a more valuable piece for a less valuable one unless there\'s a clear tactical or positional reason.',
    'beginner', 'material evaluation',
    'Trading a queen for a rook with no compensation.'],

  // --- Basic Checkmate Patterns ---
  ['P47', 'Recognize the back-rank mate pattern',
    'Learn to spot the back-rank checkmate pattern — a king trapped behind its own pawns, delivered mate by a rook or queen on the back rank.',
    'beginner', 'checkmate patterns',
    'Delivering (or falling to) a rook check on the 8th/1st rank with no escape square.'],

  ['P48', 'Learn king-and-queen vs. king checkmate technique',
    'Learn the basic technique for checkmating a lone king with king and queen.',
    'beginner', 'checkmate patterns',
    'Boxing in the enemy king with the queen and finishing with the king\'s support.'],

  ['P49', 'Learn king-and-rook vs. king checkmate technique',
    'Learn the basic technique for checkmating a lone king with king and rook.',
    'beginner', 'checkmate patterns',
    'Using the rook to cut off the king\'s rank/file while your king approaches.'],

  // --- Basic Endgame Technique ---
  ['P50', 'Activate your king in the endgame',
    'Once queens and many pieces are traded off, your king becomes a strong piece — bring it toward the center or the action.',
    'beginner', 'endgame technique',
    'Leaving the king on the back rank in a king-and-pawn ending instead of centralizing it.'],

  ['P51', 'Learn the square rule for passed pawns',
    'Learn the "square rule" — a quick way to judge whether a lone pawn can outrun the enemy king to promotion.',
    'beginner', 'endgame technique',
    'Pushing a passed pawn without checking if the enemy king can catch it.'],

  ['P52', 'Understand the opposition',
    'Learn the opposition — when kings face each other with one square between them, the player NOT forced to move controls the key squares.',
    'beginner', 'endgame technique',
    'Losing a won king-and-pawn ending by giving away the opposition.'],

  ['P53', 'Know that rook-pawn endings are special',
    'Recognize that endings with only a rook pawn (a-file/h-file) are often drawn even when they look winning, because the defending king can reach the corner.',
    'beginner', 'endgame technique',
    'Assuming an extra rook pawn is automatically winning when it may be a theoretical draw.'],

  ['P54', 'Value passed pawns in the endgame',
    'Recognize that a passed pawn (no enemy pawn can stop it on its file or adjacent files) is a major endgame asset — advance it or use your king to escort it.',
    'beginner', 'endgame technique',
    'Ignoring a passed pawn instead of pushing or supporting it.'],

  // --- Practical Habits ---
  ['P55', 'Use a simple move checklist',
    'Before playing a move, run a simple checklist: is anything of mine hanging, what does my opponent threaten, and does my move address it.',
    'beginner', 'practical habits',
    'Playing a natural-looking move without checking for hanging pieces or threats.'],

  ['P56', 'Slow down on critical moves',
    'Take extra time on sharp or unclear positions rather than moving on instinct.',
    'beginner', 'practical habits',
    'Blitzing out a move in a complicated position and missing a tactic.'],

  ['P57', 'Don\'t give up in difficult positions',
    'Avoid resigning or playing carelessly in "lost" positions — many still have practical chances, especially if the opponent also has to find precise moves.',
    'beginner', 'practical habits',
    'Resigning a worse-but-not-lost position instead of setting practical problems.'],
];

// INTERMEDIATE_ADDITIONS_SEED — level: 'intermediate'
// Continues the shared `principles` table ID sequence from P58 (after the
// beginner tier above ends at P57). Same shape as PRINCIPLES_SEED:
// [id, name, description, level, category, examples]
const INTERMEDIATE_ADDITIONS_SEED = [
  ['P58', 'Hanging pawns are double-edged',
    'A pawn pair with no pawns behind or beside them can be a dynamic strength if they advance, or a long-term liability if blockaded.',
    'intermediate', 'pawn structure',
    'Leaving hanging pawns fixed in place for many moves, letting the opponent blockade and target them.'],
  ['P59', 'Play the minority attack',
    'Advance pawns on the side where you have fewer pawns than your opponent to provoke a structural weakness in their majority.',
    'intermediate', 'pawn structure',
    'Missing the b4-b5 minority attack plan in a Carlsbad-type structure.'],
  ['P60', 'Target the base of a pawn chain',
    'The base of a pawn chain cannot be defended by another pawn, making it the critical point to attack or defend.',
    'intermediate', 'pawn structure',
    'Attacking the tip of a pawn chain instead of its undefendable base.'],
  ['P61', 'Prioritize activity over material when unclear',
    'In unclear positions, an active piece can outweigh a small material deficit — don\'t default to material count alone.',
    'intermediate', 'piece activity',
    'Returning material to simplify into a passive but "safe" position instead of keeping active piece play.'],
  ['P62', 'Infiltrate the 7th/2nd rank with a rook',
    'A rook on the opponent\'s 7th (or your 2nd) rank attacks pawns and restricts the enemy king — look for chances to get one there.',
    'intermediate', 'rook placement',
    'Trading off the rook that had a clear path to the 7th rank instead of activating it.'],
  ['P63', 'Blockade a dangerous enemy passed pawn',
    'Use a knight or well-placed piece to blockade an advanced or dangerous enemy passed pawn before it becomes unstoppable.',
    'intermediate', 'pawn structure',
    'Allowing an enemy passed pawn to advance unblockaded until it queens or ties down major pieces.'],
  ['P64', 'Consider overprotection (a debated idea)',
    'Some strong players recommend guarding a key strategic square or pawn beyond its immediate defensive need, to free your other pieces to maneuver without losing control of that point. This idea is debated among strong players and coaches — treat it as one lens, not a rule to apply rigidly.',
    'intermediate', 'piece coordination',
    'Ignoring a key central point entirely once it seems "defended enough," losing flexibility later.'],
  ['P65', 'Use a space advantage to restrict mobility',
    'A space advantage limits the opponent\'s piece mobility — use it to cramp their position rather than letting it go to waste.',
    'intermediate', 'space',
    'Having more space but making passive moves that let the opponent untangle.'],
  ['P66', 'Be cautious trading with a space advantage',
    'More space favors keeping more pieces on the board to make use of it — be cautious about trading down when you have a space edge.',
    'intermediate', 'space',
    'Trading pieces freely despite having a cramping space advantage, easing the opponent\'s position.'],
  ['P67', 'Treat the initiative as an asset',
    'Being the side dictating the game\'s pace (the initiative) is a real asset — consider concrete or material investments to keep it.',
    'intermediate', 'initiative',
    'Handing back the initiative with a slow move instead of maintaining pressure.'],
  ['P68', 'Seek counterplay from a passive position',
    'When your position is passive, look for a plan to generate counterplay rather than only defending.',
    'intermediate', 'initiative',
    'Playing purely defensively for many moves with no attempt to create counter-chances.'],
  ['P69', 'Fianchetto for the long diagonal',
    'Fianchettoing a bishop gives it a long, flexible diagonal from a safe square — consider it as a development option.',
    'intermediate', 'piece activity',
    'Developing a bishop to a passive square when a fianchetto would give it a strong long diagonal.'],
  ['P70', 'Race pawn storms after opposite-side castling',
    'When kings are castled on opposite sides, the game often becomes a race — prioritize your own pawn storm and attack speed over slower plans.',
    'intermediate', 'king safety',
    'Playing slow positional moves in an opposite-side-castling position where speed decides the game.'],
  ['P71', 'Count attackers before sacrificing into a king',
    'Before sacrificing material to expose the enemy king, count the attacking pieces that follow up, not just the piece given up.',
    'intermediate', 'tactical awareness',
    'Sacrificing a bishop on h7/f7 without enough remaining attackers to follow through.'],
  ['P72', 'Let king safety override other advantages',
    'Recognize when your own king safety justifies giving up some other advantage (tempo, structure) to address it.',
    'intermediate', 'king safety',
    'Continuing a queenside plan while ignoring a serious threat building against your own king.'],
  ['P73', 'Recognize deflection',
    'Deflection forces a defending piece away from its critical duty, opening up what it was protecting.',
    'intermediate', 'tactical awareness',
    'Missing a deflecting sacrifice that pulls away the defender of a key square or piece.'],
  ['P74', 'Recognize decoy',
    'A decoy lures a piece onto a square where it becomes vulnerable to a follow-up tactic.',
    'intermediate', 'tactical awareness',
    'Not seeing that a check forces the king onto a square where a fork follows.'],
  ['P75', 'Recognize overloading',
    'An overloaded defender is responsible for guarding more than it can actually cover — exploit or avoid creating this.',
    'intermediate', 'tactical awareness',
    'Relying on one piece to defend two things at once without noticing the overload.'],
  ['P76', 'Recognize interference',
    'Interference blocks the line between a defender and what it defends, breaking the defensive connection.',
    'intermediate', 'tactical awareness',
    'Missing an interfering move that cuts a defender off from its target.'],
  ['P77', 'Recognize zwischenzug',
    'A zwischenzug (in-between move) inserts a stronger threat before completing an expected sequence — watch for it on both sides.',
    'intermediate', 'tactical awareness',
    'Automatically recapturing instead of checking for a stronger in-between move first.'],
  ['P78', 'Recognize x-ray attacks/defenses',
    'Pieces aligned through an enemy piece on the same line can attack or defend "through" it — watch for these hidden connections.',
    'intermediate', 'tactical awareness',
    'Missing that a queen defends a bishop through an enemy piece via x-ray.'],
  ['P79', 'Recognize a trapped piece',
    'A piece with no safe square to retreat to is vulnerable regardless of its nominal value — look to exploit (or avoid creating) this.',
    'intermediate', 'tactical awareness',
    'Chasing an enemy piece into what looks like activity but is actually a trap with no escape.'],
  ['P80', 'Recognize discovered attacks and double checks',
    'A discovered attack (including a discovered or double check) is often more powerful than the moving piece\'s own threat — watch for these on both sides.',
    'intermediate', 'tactical awareness',
    'Moving a piece without noticing it discovers a devastating attack from another piece behind it.'],
  ['P81', 'When behind, complicate and keep pieces on',
    'When you\'re worse, look to complicate the position and keep pieces on the board rather than simplifying into a clearly worse endgame.',
    'intermediate', 'endgame basics',
    'Trading into a lost endgame instead of keeping tension and practical chances alive.'],
  ['P82', 'Trade to fix an opponent\'s weakness, not just to relieve pressure',
    'Before trading, consider whether it locks in a real target in the opponent\'s position, versus simply relieving your own pressure without gaining anything concrete.',
    'intermediate', 'pawn structure',
    'Trading pieces to "simplify" a tense position without checking whether it actually fixes a target or just eases the opponent\'s defense.'],
  ['P83', 'Evaluate structure and activity before any trade',
    'Before any trade — not just when ahead in material — weigh the resulting pawn structure and piece activity, not just material equality.',
    'intermediate', 'piece activity',
    'Trading a pair of knights without noticing it hands the opponent a much better resulting structure.'],
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

    if (!await columnExists(client, 'moves', 'best_move')) {
      await client.query('ALTER TABLE moves ADD COLUMN best_move TEXT');
      console.log('Migration: added moves.best_move');
    }
    if (!await columnExists(client, 'moves', 'eval_before')) {
      await client.query('ALTER TABLE moves ADD COLUMN eval_before INTEGER');
      console.log('Migration: added moves.eval_before');
    }
    if (!await columnExists(client, 'moves', 'eval_after')) {
      await client.query('ALTER TABLE moves ADD COLUMN eval_after INTEGER');
      console.log('Migration: added moves.eval_after');
    }

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

    if (!await columnExists(client, 'conversations', 'message_type')) {
      await client.query("ALTER TABLE conversations ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'");
      console.log("Migration: added conversations.message_type");
    }
    if (!await columnExists(client, 'conversations', 'move_data')) {
      await client.query('ALTER TABLE conversations ADD COLUMN move_data JSONB');
      console.log('Migration: added conversations.move_data');
    }

    // ── coach_feedback ───────────────────────────────────────────────────────
    // Thumbs up/down on a coach response. message_id IS conversations.id —
    // no parallel id scheme. UNIQUE(user_id, message_id) means re-rating is
    // an upsert, not a new row (one tap to rate, a second tap to switch/undo).
    await client.query(`
      CREATE TABLE IF NOT EXISTS coach_feedback (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
        reason TEXT CHECK (reason IN ('unclear', 'not_helpful', 'wrong_tone', 'too_long')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, message_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (message_id) REFERENCES conversations(id)
      )
    `);

    // ── coach_telemetry ──────────────────────────────────────────────────────
    // One row per coach response (correctness/compliance signal), written
    // from the prose-backstop path alongside its existing stdout logging —
    // this is what makes a time-bucketed RATE computable instead of only
    // living in ephemeral logs. message_id IS conversations.id, same
    // identifier coach_feedback uses. Always inserted (even 0/0 counts) so
    // total_responses is a true denominator for the rate.
    await client.query(`
      CREATE TABLE IF NOT EXISTS coach_telemetry (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        violations_count INTEGER NOT NULL DEFAULT 0,
        sequence_hits_count INTEGER NOT NULL DEFAULT 0,
        violations JSONB,
        sequence_hits JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (message_id) REFERENCES conversations(id)
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

    // Row-level ON CONFLICT DO NOTHING (rather than the table-wide COUNT(*)
    // guard above) so this still seeds correctly on databases where
    // PRINCIPLES_SEED already ran and P26–P28 already exist out-of-band.
    for (const row of BEGINNER_PRINCIPLES_SEED) {
      await client.query(
        'INSERT INTO principles (id, name, description, level, category, examples) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
        row
      );
    }
    console.log(`Migration: seeded ${BEGINNER_PRINCIPLES_SEED.length} beginner principles (id range P29-P57)`);

    for (const row of INTERMEDIATE_ADDITIONS_SEED) {
      await client.query(
        'INSERT INTO principles (id, name, description, level, category, examples) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
        row
      );
    }
    console.log(`Migration: seeded ${INTERMEDIATE_ADDITIONS_SEED.length} intermediate principles (id range P58-P83)`);

    // P03/P11 description backfill is a one-off correction, not permanent
    // startup logic — run server/migrations/backfill-p03-p11-descriptions.js
    // manually once instead of re-asserting these on every restart (which
    // would silently clobber any future manual edit to either description).

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

    // P14 retirement (duplicate of P27) is a one-off cleanup, not permanent
    // reference-data seeding — run server/migrations/retire-p14.js manually
    // once instead of baking a delete-and-no-op into every startup.

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

    // ── progression_summaries ────────────────────────────────────────────────
    // One cached coach narrative per user per format, regenerated only when a
    // new batch completes. Never generated on GET requests (cost control).
    await client.query(`
      CREATE TABLE IF NOT EXISTS progression_summaries (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id),
        format        TEXT    NOT NULL
          CHECK (format IN ('classical', 'rapid', 'bullet')),
        last_batch_number INTEGER NOT NULL,
        summary       TEXT    NOT NULL,
        generated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, format)
      )
    `);

    console.log('Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction, initDb };
