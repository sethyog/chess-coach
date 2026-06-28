'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { logCandidate } = require('../principle-candidates');
const { reconstructBeforeFen, buildPositionFacts } = require('../position-facts');
const { buildVerifiedFactsPrompt, buildDegradedPrompt } = require('../coaching-prompt');
const { resolveCascade, ENGINE_CONSULTATION_LEVEL } = require('../engine-cascade');
const { BATCH_THRESHOLD, MIN_GAMES } = require('../format');
const { getReadyFormats } = require('../ready-formats');

// ── Tool definition (sent to Claude on every coaching request with verified facts) ──
const EVALUATE_MOVE_TOOL = {
  name: 'evaluate_alternative_move',
  description:
    'Evaluate a sequence of up to 2 SAN moves from the reviewed position using the chess engine. ' +
    'Use ONLY for tactical claims or student proposals that cannot be answered from the verified facts block. ' +
    'The tool runs a deterministic cascade: legality (chess.js) then optional engine eval (gated by level + budget).',
  input_schema: {
    type: 'object',
    properties: {
      moves: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 2,
        description:
          'SAN moves to apply from the reviewed before-position, in order ' +
          '(e.g. ["Qd8"] for one ply, or ["Qd8", "Rxd8"] for two plies).',
      },
      situation: {
        type: 'string',
        enum: ['DIRECT_CHALLENGE', 'USER_PROPOSAL', 'LINE_EXPLORATION'],
        description:
          'DIRECT_CHALLENGE if the student challenges a tactical claim you made; ' +
          'USER_PROPOSAL if they propose an alternative line; ' +
          'LINE_EXPLORATION for a multi-step line.',
      },
    },
    required: ['moves', 'situation'],
  },
};

// Max iterations of the tool-use loop per request (prevents runaway chains).
const MAX_TOOL_ITERATIONS = 4;

// ── Socratic escalation constants ────────────────────────────────────────────
const MAX_TURNS_BY_LEVEL = { beginner: 3, intermediate: 4, advanced: 5 };
const DEFAULT_MAX_TURNS = 4;

// Phrases that signal the student wants the answer now (case-insensitive substring match).
const GIVE_UP_PHRASES = [
  'just tell me', "i don't know", 'i give up', "what's the answer",
  'what is the answer', 'no idea', 'show me the answer', 'tell me the answer',
  'i have no idea', 'give me the answer', "don't know", 'answer please',
  "i'm stuck", 'i am stuck', 'give up',
];

function detectForceAnswer(message) {
  const lower = message.toLowerCase();
  return GIVE_UP_PHRASES.some(phrase => lower.includes(phrase));
}
// ─────────────────────────────────────────────────────────────────────────────

async function updateConceptualProfile(userId) {
  const recent = (await query(
    `SELECT c.role, c.content
     FROM conversations c
     JOIN moves m ON m.id = c.move_id
     JOIN games g ON g.id = m.game_id
     WHERE g.user_id = $1
     ORDER BY c.created_at DESC
     LIMIT 5`,
    [userId]
  )).rows.reverse();

  if (recent.length === 0) return;

  const transcript = recent.map(c => `${c.role}: ${c.content}`).join('\n\n');
  const prompt = `Based on these chess coaching conversations, summarise in 2-3 sentences what chess concepts this player clearly understands and what they consistently get wrong. Be specific to chess concepts, not general observations.

${transcript}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '<no body>');
    throw new Error(`Anthropic ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const summary = data.content?.[0]?.text?.trim();
  if (!summary) return;

  await query(
    `UPDATE player_profile SET conceptual_profile = $1, profile_updated_at = NOW() WHERE user_id = $2`,
    [summary, userId]
  );
  console.log(`Conceptual profile updated for user ${userId}.`);
}

async function getOwnedMove(moveId, userId) {
  return (await query(
    `SELECT m.id FROM moves m JOIN games g ON g.id = m.game_id WHERE m.id = $1 AND g.user_id = $2`,
    [moveId, userId]
  )).rows[0];
}

// ── Core pattern analysis ─────────────────────────────────────────────────────
// Shared function used by both the legacy /patterns route and the format-aware
// /patterns/batch route. Throws on mapping failure so callers can handle the
// batch lifecycle (pending → failed) correctly.
//
// opts.gameIds    — specific game ids to analyse; if omitted, uses last 5 for user
// opts.format     — stored in pattern_analyses.format; defaults to 'all'
// opts.batchId    — links result row to an analysis_batches row (nullable)
// opts.batchNumber — stored in pattern_analyses.batch_number (nullable)
async function runPatternAnalysis(userId, {
  gameIds: specifiedGameIds = null,
  format = 'all',
  batchId = null,
  batchNumber = null,
} = {}) {
  let games;
  if (specifiedGameIds && specifiedGameIds.length > 0) {
    const ph = specifiedGameIds.map((_, i) => `$${i + 2}`).join(',');
    games = (await query(
      `SELECT id, opponent, played_at FROM games
       WHERE user_id = $1 AND id IN (${ph})
       ORDER BY played_at DESC`,
      [userId, ...specifiedGameIds]
    )).rows;
  } else {
    games = (await query(
      `SELECT id, opponent, played_at FROM games WHERE user_id = $1 ORDER BY played_at DESC LIMIT 5`,
      [userId]
    )).rows;
  }

  const analysedAt = new Date().toISOString();

  if (games.length < 3) {
    return { patterns: [], gamesAnalysed: games.length, gamesSummary: games, totalMistakesMapped: 0, analysedAt };
  }

  const gameIds = games.map(g => g.id);
  const movePh = gameIds.map((_, i) => `$${i + 1}`).join(',');
  const moves = (await query(
    `SELECT id, game_id, move_number, move, classification
     FROM moves
     WHERE game_id IN (${movePh})
     AND classification IN ('blunder', 'mistake')
     ORDER BY game_id, move_number`,
    gameIds
  )).rows;

  if (moves.length === 0) {
    const results = { patterns: [], gamesAnalysed: games.length, gamesSummary: games, totalMistakesMapped: 0, analysedAt };
    await query(
      `INSERT INTO pattern_analyses (user_id, game_ids, results, format, batch_id, batch_number)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, JSON.stringify(gameIds), JSON.stringify(results), format, batchId, batchNumber]
    );
    return results;
  }

  const profile = (await query('SELECT * FROM player_profile WHERE user_id = $1', [userId])).rows[0];
  const level = profile?.computed_level || 'intermediate';
  let principles = (await query('SELECT * FROM principles WHERE level = $1 ORDER BY id', [level])).rows;
  if (principles.length === 0) {
    principles = (await query('SELECT * FROM principles ORDER BY id')).rows;
  }

  const principlesBlock = principles.map(p => `${p.id}: ${p.name} — ${p.description}`).join('\n');
  const movesBlock = moves.map(m => `Game ${m.game_id} Move ${m.move_number} (${m.move}) — ${m.classification}`).join('\n');

  const mappingPrompt = `Map each move below to EXACTLY ONE principle it violates from the provided list.
Return ONLY a JSON array, no markdown, no preamble:
[{ "gameId": 1, "moveRef": "Game 1 Move 14", "principleId": "P02", "reasoning": "one sentence explanation" }]

If a move does not clearly match any principle from the list, use principleId: "OTHER", explain in reasoning, AND include "suggestedName": a 4-8 word principle name. Style it like the existing list — a positive imperative or rule of thumb ("Don't trade off your active pieces"), not a description of the mistake.

PRINCIPLES:
${principlesBlock}

MOVES:
${movesBlock}`;

  let mappings;
  const mapResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 8000, messages: [{ role: 'user', content: mappingPrompt }] }),
  });
  if (!mapResp.ok) {
    const errBody = await mapResp.text().catch(() => '<no body>');
    throw new Error(`Anthropic ${mapResp.status}: ${errBody}`);
  }
  const mapData = await mapResp.json();
  const text = mapData.content?.[0]?.text || '';
  const cleaned = text.replace(/```json|```/g, '').trim();
  if (!cleaned) {
    console.error('Pattern mapping returned empty text. stop_reason:', mapData.stop_reason, 'content:', JSON.stringify(mapData.content));
    throw new Error('Mapping response had empty text');
  }
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  const toParse = arrayMatch ? arrayMatch[0] : cleaned;
  mappings = JSON.parse(toParse);
  if (!Array.isArray(mappings)) throw new Error('Mapping response was not a JSON array');

  const otherMappings = mappings.filter(m => m && m.principleId === 'OTHER' && typeof m.suggestedName === 'string' && m.suggestedName.trim());
  for (const m of otherMappings) {
    try {
      await logCandidate(m.suggestedName, userId, level);
    } catch (err) {
      console.error(`logCandidate failed for "${m.suggestedName}":`, err);
    }
  }

  const buckets = new Map();
  for (const m of mappings) {
    if (!m || typeof m.principleId !== 'string') continue;
    const pid = m.principleId;
    if (!buckets.has(pid)) buckets.set(pid, { principleId: pid, gameIds: new Set(), moveRefs: [], reasonings: [] });
    const b = buckets.get(pid);
    if (m.gameId != null) b.gameIds.add(m.gameId);
    if (m.moveRef) b.moveRefs.push(m.moveRef);
    if (m.reasoning) b.reasonings.push(m.reasoning);
  }

  const candidates = [...buckets.values()]
    .map(b => ({ principleId: b.principleId, gamesAffected: [...b.gameIds], movesViolating: b.moveRefs, reasonings: b.reasonings, frequency: b.gameIds.size }))
    .filter(b => b.frequency >= 2)
    .sort((a, b) => b.frequency - a.frequency);

  const principleMap = new Map(principles.map(p => [p.id, p]));
  const patterns = [];

  for (const cand of candidates) {
    const principle = principleMap.get(cand.principleId);
    const name = principle?.name || (cand.principleId === 'OTHER' ? 'Other (uncategorised)' : cand.principleId);
    const description = principle?.description || '';

    const summaryPrompt = `In 2 sentences, explain this recurring pattern to a ${level} chess player and what they should specifically focus on to fix it.
Principle: ${name} — ${description}
Violated in: ${cand.movesViolating.join(', ')}
Reasoning per move:
${cand.reasonings.map(r => `- ${r}`).join('\n')}`;

    let coachSummary = '';
    try {
      const sumResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 300, messages: [{ role: 'user', content: summaryPrompt }] }),
      });
      if (!sumResp.ok) {
        const errBody = await sumResp.text().catch(() => '<no body>');
        throw new Error(`Anthropic ${sumResp.status}: ${errBody}`);
      }
      const sumData = await sumResp.json();
      coachSummary = sumData.content?.[0]?.text?.trim() || '';
    } catch (err) {
      console.error(`Coach summary call failed for ${cand.principleId}:`, err);
    }

    patterns.push({ principleId: cand.principleId, principleName: name, frequency: cand.frequency, gamesAffected: cand.gamesAffected, movesViolating: cand.movesViolating, coachSummary, reasonings: cand.reasonings });
  }

  const results = { patterns, gamesAnalysed: games.length, gamesSummary: games, totalMistakesMapped: mappings.length, analysedAt };

  await query(
    `INSERT INTO pattern_analyses (user_id, game_ids, results, format, batch_id, batch_number)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, JSON.stringify(gameIds), JSON.stringify(results), format, batchId, batchNumber]
  );

  return results;
}

// Get conversation history for a move.
router.get('/conversation/:moveId', async (req, res) => {
  const moveId = parseInt(req.params.moveId, 10);
  if (!Number.isInteger(moveId)) return res.status(400).json({ error: 'Invalid move id' });
  if (!await getOwnedMove(moveId, req.user.id)) {
    return res.status(404).json({ error: 'Move not found' });
  }
  const messages = (await query(
    'SELECT role, content FROM conversations WHERE move_id = $1 ORDER BY created_at',
    [moveId]
  )).rows;
  res.json(messages);
});

// Send a message to the coach.
router.post('/conversation/:moveId', async (req, res) => {
  const moveId = parseInt(req.params.moveId, 10);
  if (!Number.isInteger(moveId)) return res.status(400).json({ error: 'Invalid move id' });
  const { message } = req.body;

  if (!await getOwnedMove(moveId, req.user.id)) {
    return res.status(404).json({ error: 'Move not found' });
  }

  await query('INSERT INTO conversations (move_id, role, content) VALUES ($1, $2, $3)', [moveId, 'user', message]);

  const profile = (await query('SELECT * FROM player_profile WHERE user_id = $1', [req.user.id])).rows[0];

  const history = (await query(
    'SELECT role, content FROM conversations WHERE move_id = $1 ORDER BY created_at',
    [moveId]
  )).rows;

  // Socratic escalation: turn 1 = first coach reply, turn N = Nth reply.
  const currentTurn = history.filter(h => h.role === 'assistant').length + 1;
  const level = profile?.computed_level || 'intermediate';
  const maxTurns = MAX_TURNS_BY_LEVEL[level] ?? DEFAULT_MAX_TURNS;
  const forceAnswer = detectForceAnswer(message);

  const moveRow = (await query(
    `SELECT m.id, m.game_id, m.move_number, m.move, m.fen,
            m.classification, m.centipawn_loss, m.principle_violated, g.pgn
       FROM moves m
       JOIN games g ON g.id = m.game_id
      WHERE m.id = $1`,
    [moveId]
  )).rows[0];

  // Build (or read cached) verified facts.
  let facts = null;
  const cachedRow = (await query('SELECT facts FROM coaching_facts WHERE move_id = $1', [moveId])).rows[0];
  if (cachedRow?.facts) {
    try {
      const parsed = JSON.parse(cachedRow.facts);
      if (parsed && parsed.ok) facts = parsed;
    } catch (err) {
      console.error(`Cached facts for move ${moveId} failed to parse:`, err);
    }
  }

  if (!facts) {
    try {
      if (moveRow?.pgn) {
        const fenBefore = reconstructBeforeFen(moveRow.pgn, moveRow.move_number, moveRow.move);
        if (fenBefore) {
          const built = buildPositionFacts({
            fenBefore,
            playedMoveSan: moveRow.move,
            classification: moveRow.classification,
            centipawnLoss: moveRow.centipawn_loss,
          });
          if (built && built.ok) {
            facts = built;
            try {
              await query(
                'INSERT INTO coaching_facts (move_id, facts, computed_at) VALUES ($1, $2, NOW()) ON CONFLICT (move_id) DO UPDATE SET facts = EXCLUDED.facts, computed_at = NOW()',
                [moveId, JSON.stringify(facts)]
              );
            } catch (cacheErr) {
              console.error(`Failed to cache coaching facts for move ${moveId}:`, cacheErr);
            }
          }
        }
      }
    } catch (err) {
      console.error('Position facts construction failed:', err);
    }
  }

  if (!facts) {
    console.warn(`Coach falling back to degraded prompt for move ${moveId} (no verified facts).`);
  }

  const systemPrompt = facts
    ? buildVerifiedFactsPrompt({
        facts,
        profile,
        principleViolated: moveRow?.principle_violated,
        currentTurn,
        maxTurns,
        forceAnswer,
        engineLevel: ENGINE_CONSULTATION_LEVEL,
      })
    : buildDegradedPrompt({
        profile,
        moveSan: moveRow?.move,
        classification: moveRow?.classification,
        centipawnLoss: moveRow?.centipawn_loss,
        principleViolated: moveRow?.principle_violated,
        currentTurn,
        maxTurns,
        forceAnswer,
      });

  // Only offer the engine tool when we have verified facts (need fenBefore for cascade).
  const tools = facts ? [EVALUATE_MOVE_TOOL] : [];

  try {
    // Build the initial messages array from stored history.
    // Tool-use turns are ephemeral (within this request only); only the final
    // text reply is persisted to the conversations table.
    const messages = history.map(h => ({ role: h.role, content: h.content }));

    let reply = null;
    let toolCallCount = 0;
    let resolvedAtTier = facts ? 1 : 'none';
    let engineCalled   = false;

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 1000,
          system: systemPrompt,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        }),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '<no body>');
        throw new Error(`Anthropic ${response.status}: ${errBody}`);
      }

      const data = await response.json();

      if (data.stop_reason === 'tool_use') {
        const toolBlock = data.content?.find(b => b.type === 'tool_use');
        if (!toolBlock) {
          // Malformed response; extract any text and stop.
          reply = data.content?.find(b => b.type === 'text')?.text || "I couldn't process that. Try again.";
          break;
        }

        toolCallCount++;
        const { moves, situation } = toolBlock.input || {};
        console.log(`[coach] tool call ${toolCallCount}: evaluate_alternative_move moves=${JSON.stringify(moves)} situation=${situation} moveId=${moveId}`);

        const cascadeResult = await resolveCascade(moveId, facts, moves || [], situation || 'USER_PROPOSAL');
        console.log(`[coach] cascade result: tier=${cascadeResult.tier} evalCp=${cascadeResult.evalCp} note=${cascadeResult.note || ''}`);

        if (cascadeResult.tier === 3) { resolvedAtTier = 3; engineCalled = true; }
        else if (cascadeResult.tier === 2 && resolvedAtTier !== 3) { resolvedAtTier = 2; }

        // Add assistant's tool_use turn + our tool_result to the in-flight messages.
        messages.push({ role: 'assistant', content: data.content });
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: JSON.stringify(cascadeResult),
          }],
        });
        continue;
      }

      // stop_reason is 'end_turn' (or anything else) — extract final text.
      const textBlock = data.content?.find(b => b.type === 'text');
      reply = textBlock?.text || data.content?.[0]?.text || "I couldn't process that. Try again.";
      break;
    }

    if (!reply) reply = "I couldn't generate a response. Please try again.";

    try {
      console.log('[TIER] ' + JSON.stringify({
        conversationId: moveId,
        moveId,
        turnNumber:     currentTurn,
        resolvedAtTier,
        engineCalled,
      }));
    } catch (_) {}

    await query('INSERT INTO conversations (move_id, role, content) VALUES ($1, $2, $3)', [moveId, 'assistant', reply]);

    res.json({ reply });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Best-effort: refresh conceptual_profile every 3rd conversation row (scoped to this user).
  try {
    const totalRow = (await query(
      `SELECT COUNT(*)::int AS n
       FROM conversations c
       JOIN moves m ON m.id = c.move_id
       JOIN games g ON g.id = m.game_id
       WHERE g.user_id = $1`,
      [req.user.id]
    )).rows[0];
    if (totalRow.n % 3 === 0) {
      updateConceptualProfile(req.user.id).catch(err =>
        console.error('Conceptual profile update failed:', err)
      );
    }
  } catch (err) {
    console.error('Conceptual profile trigger check failed:', err);
  }
});

// Lightweight check: which formats are ready for a new batch analysis.
// Called on dashboard mount so the prompt appears without requiring a fresh import.
router.get('/patterns/ready', async (req, res) => {
  try {
    const readyFormats = await getReadyFormats(req.user.id);
    res.json({ readyFormats });
  } catch (e) {
    console.error('getReadyFormats failed:', e);
    res.json({ readyFormats: [] });
  }
});

// Latest stored pattern analysis for THIS user.
// Optional ?format= query param filters to a specific format (classical/rapid/bullet/all).
// Without format param, returns the most recent analysis regardless of format.
router.get('/patterns/latest', async (req, res) => {
  const { format } = req.query;
  const validFormats = new Set(['classical', 'rapid', 'bullet', 'all']);

  let row;
  if (format && validFormats.has(format)) {
    row = (await query(
      `SELECT * FROM pattern_analyses WHERE user_id = $1 AND format = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [req.user.id, format]
    )).rows[0];
  } else {
    row = (await query(
      `SELECT * FROM pattern_analyses WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [req.user.id]
    )).rows[0];
  }

  if (!row) return res.json({ patterns: null });

  try {
    const results = JSON.parse(row.results);
    res.json({ ...results, format: row.format, batchId: row.batch_id, batchNumber: row.batch_number });
  } catch (e) {
    console.error('Failed to parse stored pattern_analyses.results:', e);
    res.json({ patterns: null });
  }
});

// Pattern recognition across this user's 5 most recent games (legacy/all-format path).
router.post('/patterns', async (req, res) => {
  try {
    const results = await runPatternAnalysis(req.user.id);
    res.json(results);
  } catch (e) {
    console.error('Pattern analysis failed:', e);
    return res.json({ patterns: [], error: 'Analysis failed — try again' });
  }
});

// Format-aware batch analysis.
// Body: { format: 'classical' | 'rapid' | 'bullet' }
// Creates an analysis_batches row, runs analysis on the last BATCH_THRESHOLD[format]
// games for this format, saves results, resets format_game_counts on success.
router.post('/patterns/batch', async (req, res) => {
  const format = req.body?.format;
  if (!['classical', 'rapid', 'bullet'].includes(format)) {
    return res.status(400).json({ error: 'format must be one of classical, rapid, bullet' });
  }

  const threshold = BATCH_THRESHOLD[format];
  const minGames = MIN_GAMES[format];

  try {
    // Fetch the most recent threshold-many games of this format.
    // threshold is a known integer from BATCH_THRESHOLD — safe to interpolate.
    const games = (await query(
      `SELECT id, opponent, played_at FROM games
       WHERE user_id = $1 AND format = $2
       ORDER BY played_at DESC
       LIMIT ${threshold}`,
      [req.user.id, format]
    )).rows;

    if (games.length < minGames) {
      return res.status(400).json({
        error: `Not enough ${format} games (need ${minGames}, have ${games.length})`,
      });
    }

    const gameIds = games.map(g => g.id);

    // Next batch_number for this user+format.
    const { rows: [{ max_batch }] } = await query(
      `SELECT COALESCE(MAX(batch_number), 0) AS max_batch FROM analysis_batches WHERE user_id = $1 AND format = $2`,
      [req.user.id, format]
    );
    const batchNumber = max_batch + 1;

    // Create batch row.
    const { rows: [{ id: batchId }] } = await query(
      `INSERT INTO analysis_batches (user_id, format, game_ids, game_count, batch_number, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
      [req.user.id, format, JSON.stringify(gameIds), gameIds.length, batchNumber]
    );

    console.log(`[batch] created batch ${batchId} format=${format} batchNumber=${batchNumber} games=${gameIds.length}`);

    let results;
    try {
      results = await runPatternAnalysis(req.user.id, { gameIds, format, batchId, batchNumber });

      // Mark completed and reset game count.
      await query(
        `UPDATE analysis_batches SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [batchId]
      );
      await query(
        `UPDATE format_game_counts
         SET games_since_last_batch = 0, last_batch_completed_at = NOW()
         WHERE user_id = $1 AND format = $2`,
        [req.user.id, format]
      );

      console.log(`[batch] completed batch ${batchId} format=${format} patterns=${results.patterns?.length ?? 0}`);
    } catch (analysisErr) {
      console.error(`[batch] batch ${batchId} analysis failed:`, analysisErr);
      await query(
        `UPDATE analysis_batches SET status = 'failed' WHERE id = $1`,
        [batchId]
      );
      throw analysisErr;
    }

    res.json({ ...results, format, batchId, batchNumber });
  } catch (e) {
    console.error('Pattern batch analysis failed:', e);
    return res.status(500).json({ error: 'Analysis failed — try again' });
  }
});

module.exports = router;
