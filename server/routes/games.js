'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { Chess } = require('chess.js');
const { updateProfile } = require('../profile-service');
const { BATCH_THRESHOLD, deriveFormat, extractTimeControlFromPgn } = require('../format');

// ─── Chess.com helpers ──────────────────────────────────────────────────────
const TIME_CLASS_OPTIONS = new Set(['bullet', 'blitz', 'rapid', 'daily', 'all']);
const CHESSCOM_TIMEOUT_MS = 10000;
const CHESSCOM_USER_AGENT = 'ChessCoachApp/1.0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function chesscomFetch(url, timeoutMs = CHESSCOM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': CHESSCOM_USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractExternalId(pgn) {
  const m = pgn.match(/chess\.com\/game\/(?:live|daily)\/(\d+)/);
  return m ? m[1] : null;
}

function parseUserResult(pgn, userIsWhite) {
  const m = pgn.match(/\[Result "([^"]+)"\]/);
  if (!m) return 'unknown';
  const r = m[1];
  if (r === '1/2-1/2') return 'draw';
  if (r === '1-0') return userIsWhite ? 'win' : 'loss';
  if (r === '0-1') return userIsWhite ? 'loss' : 'win';
  return 'unknown';
}

function filterGamesForUser(games, username, timeClass) {
  const u = username.toLowerCase();
  return games.filter((g) => {
    if (!g || !g.rated) return false;
    if (timeClass !== 'all' && g.time_class !== timeClass) return false;
    const white = g.white?.username?.toLowerCase();
    const black = g.black?.username?.toLowerCase();
    return white === u || black === u;
  });
}

function deriveUserColorFromResult(pgn, userResult) {
  if (typeof pgn !== 'string' || !pgn) return null;
  const m = pgn.match(/\[Result "([^"]+)"\]/);
  if (!m) return null;
  const pgnResult = m[1];
  if (pgnResult === '1-0') {
    if (userResult === 'win') return 'white';
    if (userResult === 'loss') return 'black';
  } else if (pgnResult === '0-1') {
    if (userResult === 'win') return 'black';
    if (userResult === 'loss') return 'white';
  }
  return null;
}

// Save a new game with PGN
router.post('/', async (req, res) => {
  const { pgn, opponent, result, userColor } = req.body;
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const resolvedColor =
      (userColor === 'white' || userColor === 'black')
        ? userColor
        : deriveUserColorFromResult(pgn, result);

    const timeControl = extractTimeControlFromPgn(pgn);
    const format = deriveFormat({ timeControlStr: timeControl });

    const insertRes = await query(
      `INSERT INTO games (user_id, pgn, opponent, result, user_color, time_control, format)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.id, pgn, opponent || 'Unknown', result || '?', resolvedColor, timeControl, format]
    );
    const gameId = insertRes.rows[0].id;

    // Track new games per format for batch trigger logic.
    let readyFormats = [];
    if (format !== 'unknown') {
      await query(
        `INSERT INTO format_game_counts (user_id, format, games_since_last_batch)
         VALUES ($1, $2, 1)
         ON CONFLICT (user_id, format) DO UPDATE
           SET games_since_last_batch = format_game_counts.games_since_last_batch + 1`,
        [req.user.id, format]
      );
      const { rows: fgcRows } = await query(
        `SELECT format, games_since_last_batch FROM format_game_counts WHERE user_id = $1`,
        [req.user.id]
      );
      readyFormats = fgcRows
        .filter(r => BATCH_THRESHOLD[r.format] && r.games_since_last_batch >= BATCH_THRESHOLD[r.format])
        .map(r => r.format);
    }

    res.json({ id: gameId, readyFormats });
  } catch (e) {
    res.status(400).json({ error: 'Invalid PGN: ' + e.message });
  }
});

// Import games from Chess.com — three-layer dedup, sequential fetches.
router.post('/import/chesscom', async (req, res) => {
  const body = req.body || {};
  const usernameRaw = body.username;
  if (typeof usernameRaw !== 'string' || !usernameRaw.trim()) {
    return res.status(400).json({ error: 'username is required' });
  }
  const username = usernameRaw.trim();
  const maxGames = Math.min(Math.max(parseInt(body.maxGames, 10) || 10, 1), 50);
  const timeClass = TIME_CLASS_OPTIONS.has(body.timeClass) ? body.timeClass : 'rapid';

  // Step 1 — validate username.
  let playerResp;
  try {
    playerResp = await chesscomFetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}`);
  } catch (err) {
    console.error('Chess.com player lookup failed:', err);
    return res.json({ error: 'Chess.com is not responding' });
  }
  if (playerResp.status === 404) return res.json({ error: `Chess.com username '${username}' not found` });
  if (!playerResp.ok) return res.json({ error: 'Chess.com is not responding' });

  // Persist the confirmed username on THIS user's profile.
  try {
    await query(
      `UPDATE player_profile SET chesscom_username = $1, profile_updated_at = NOW() WHERE user_id = $2`,
      [username, req.user.id]
    );
  } catch (e) {
    console.error('Profile chesscom_username update failed:', e);
  }

  // Step 2 — fetch archives.
  let archives = [];
  try {
    const archResp = await chesscomFetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`);
    if (!archResp.ok) return res.json({ error: 'Chess.com is not responding' });
    const archData = await archResp.json();
    archives = Array.isArray(archData.archives) ? archData.archives : [];
  } catch (err) {
    console.error('Chess.com archives fetch failed:', err);
    return res.json({ error: 'Chess.com is not responding' });
  }

  if (archives.length === 0) {
    return res.json({ imported: 0, skipped: 0, failed: 0, total: 0, gameIds: [] });
  }

  // Step 3 — fetch archives sequentially, newest first.
  const allGames = [];
  for (let i = archives.length - 1; i >= 0; i--) {
    const url = archives[i];
    try {
      const r = await chesscomFetch(url);
      if (!r.ok) {
        console.error(`Chess.com month fetch failed: ${url} status=${r.status}`);
      } else {
        const data = await r.json();
        if (Array.isArray(data.games)) allGames.push(...data.games);
      }
    } catch (err) {
      console.error(`Chess.com month fetch error: ${url}`, err);
    }
    const filteredSoFar = filterGamesForUser(allGames, username, timeClass);
    if (filteredSoFar.length >= maxGames) break;
    if (i > 0) await sleep(1000);
  }

  // Step 4 — filter, sort, take maxGames.
  const filtered = filterGamesForUser(allGames, username, timeClass)
    .sort((a, b) => (b.end_time || 0) - (a.end_time || 0))
    .slice(0, maxGames);

  // Step 5 — three-layer dedup + insert.
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const gameIds = [];

  for (const g of filtered) {
    try {
      const pgn = g.pgn;
      if (typeof pgn !== 'string' || !pgn.trim()) { failed++; continue; }

      const externalId = extractExternalId(pgn);
      if (externalId == null) {
        const siteHeader = (pgn.match(/\[Site "([^"]*)"\]/) || [])[1] || '<missing>';
        console.warn(`Warning: could not extract external_id from Site header: ${siteHeader}`);
      }

      // Layer 1: check for existing game before inserting.
      if (externalId != null) {
        const existing = (await query('SELECT id FROM games WHERE user_id = $1 AND external_id = $2', [req.user.id, externalId])).rows[0];
        if (existing) { skipped++; continue; }
      } else {
        const existing = (await query('SELECT id FROM games WHERE user_id = $1 AND pgn = $2', [req.user.id, pgn])).rows[0];
        if (existing) { skipped++; continue; }
      }

      const userIsWhite = g.white?.username?.toLowerCase() === username.toLowerCase();
      const opp = userIsWhite ? g.black : g.white;
      const opponentDisplay = opp?.username && opp?.rating != null
        ? `${opp.username} (${opp.rating})`
        : opp?.username || 'Unknown';
      const gameResult = parseUserResult(pgn, userIsWhite);
      const playedAt = Number.isFinite(g.end_time) ? new Date(g.end_time * 1000) : null;
      const userColor = userIsWhite ? 'white' : 'black';

      // Derive format: Chess.com time_class takes precedence over PGN header.
      const timeControl = extractTimeControlFromPgn(pgn);
      const format = deriveFormat({ chesscomTimeClass: g.time_class, timeControlStr: timeControl });

      // Layer 2: INSERT with ON CONFLICT DO NOTHING as atomic safety net.
      // (ON CONFLICT fires for non-NULL external_id; NULLs are distinct in PG.)
      const insertRes = await query(
        `INSERT INTO games
         (user_id, pgn, opponent, result, played_at, source, external_id, chesscom_username, user_color, time_control, format)
         VALUES ($1, $2, $3, $4, $5, 'chesscom', $6, $7, $8, $9, $10)
         ON CONFLICT (user_id, external_id) DO NOTHING
         RETURNING id`,
        [req.user.id, pgn, opponentDisplay, gameResult, playedAt, externalId, username, userColor, timeControl, format]
      );

      if (insertRes.rowCount === 0) { skipped++; continue; }

      const newGameId = insertRes.rows[0].id;
      imported++;
      gameIds.push(newGameId);

      // Track new games per format for batch trigger logic.
      if (format !== 'unknown') {
        try {
          await query(
            `INSERT INTO format_game_counts (user_id, format, games_since_last_batch)
             VALUES ($1, $2, 1)
             ON CONFLICT (user_id, format) DO UPDATE
               SET games_since_last_batch = format_game_counts.games_since_last_batch + 1`,
            [req.user.id, format]
          );
        } catch (e) {
          console.error('format_game_counts update failed:', e.message);
        }
      }
    } catch (err) {
      console.error('Chess.com import per-game failure:', err);
      failed++;
    }
  }

  // Step 6 — stamp last_import_at for THIS user.
  try {
    await query(`UPDATE player_profile SET last_import_at = NOW() WHERE user_id = $1`, [req.user.id]);
  } catch (e) {
    console.error('Profile last_import_at update failed:', e);
  }

  // Step 7 — check which formats have hit their batch threshold.
  let readyFormats = [];
  if (imported > 0) {
    try {
      const { rows: fgcRows } = await query(
        `SELECT format, games_since_last_batch FROM format_game_counts WHERE user_id = $1`,
        [req.user.id]
      );
      readyFormats = fgcRows
        .filter(r => BATCH_THRESHOLD[r.format] && r.games_since_last_batch >= BATCH_THRESHOLD[r.format])
        .map(r => r.format);
    } catch (e) {
      console.error('readyFormats check failed:', e.message);
    }
  }

  res.json({ imported, skipped, failed, total: filtered.length, gameIds, readyFormats });
});

// Get all games (this user only).
router.get('/', async (req, res) => {
  const games = (await query(
    'SELECT * FROM games WHERE user_id = $1 ORDER BY played_at DESC',
    [req.user.id]
  )).rows;
  res.json(games);
});

// Get one game with its moves.
router.get('/:id', async (req, res) => {
  const game = (await query(
    'SELECT * FROM games WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  )).rows[0];
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const moves = (await query(
    'SELECT * FROM moves WHERE game_id = $1 ORDER BY move_number',
    [req.params.id]
  )).rows;
  res.json({ ...game, moves });
});

// Save analysed moves for a game.
router.post('/:id/moves', async (req, res) => {
  const ownsGame = (await query(
    'SELECT id FROM games WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  )).rows[0];
  if (!ownsGame) return res.status(404).json({ error: 'Game not found' });

  const { moves } = req.body;
  await withTransaction(async (client) => {
    for (const m of moves) {
      await client.query(
        `INSERT INTO moves (game_id, move_number, move, fen, classification, principle_violated, centipawn_loss)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.params.id, m.move_number, m.move, m.fen, m.classification, m.principle_violated || null, m.centipawn_loss ?? null]
      );
    }
  });

  try {
    await updateProfile(req.user.id);
  } catch (e) {
    console.error('Profile update after moves save failed:', e);
  }

  res.json({ saved: moves.length });
});

module.exports = router;
