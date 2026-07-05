'use strict';

const express = require('express');
const router = express.Router();
const { Chess } = require('chess.js');
const { query } = require('../db');
const { logCandidate } = require('../principle-candidates');
const { reconstructBeforeFen, buildPositionFacts } = require('../position-facts');
const { buildVerifiedFactsPrompt, buildDegradedPrompt } = require('../coaching-prompt');
const { resolveCascade, ENGINE_CONSULTATION_LEVEL } = require('../engine-cascade');
const { getEnginePv } = require('../engine');
const { BATCH_THRESHOLD, MIN_GAMES } = require('../format');
const { getReadyFormats } = require('../ready-formats');
const { computeProgression, generateAndCacheProgressionSummary } = require('../progression');

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

// ── Structured response helpers ───────────────────────────────────────────────

// Parse the coach's JSON response. Falls back to { text: rawText, demonstrations: [] }
// if the response is not valid JSON or is missing the expected shape.
function extractStructuredResponse(rawText) {
  const text = (rawText || '').trim();

  // Try pure JSON first.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.text === 'string') {
      return { text: parsed.text, demonstrations: Array.isArray(parsed.demonstrations) ? parsed.demonstrations : [] };
    }
  } catch (_) {}

  // Try extracting from a code fence.
  const codeMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeMatch) {
    try {
      const parsed = JSON.parse(codeMatch[1]);
      if (parsed && typeof parsed.text === 'string') {
        return { text: parsed.text, demonstrations: Array.isArray(parsed.demonstrations) ? parsed.demonstrations : [] };
      }
    } catch (_) {}
  }

  // Try finding a bare JSON object containing a "text" key.
  const jsonStart = text.indexOf('{');
  if (jsonStart !== -1) {
    const jsonEnd = text.lastIndexOf('}');
    if (jsonEnd > jsonStart) {
      try {
        const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
        if (parsed && typeof parsed.text === 'string') {
          return { text: parsed.text, demonstrations: Array.isArray(parsed.demonstrations) ? parsed.demonstrations : [] };
        }
      } catch (_) {}
    }
  }

  return { text, demonstrations: [] };
}

// Validate each demonstration's moves with chess.js from the resolved start FEN.
// Illegal moves cause that demo to be dropped (logged, never animated).
// Returns an array of { from, moves, startFen } with concrete startFens.
function validateAndResolveDemonstrations(demonstrations, flaggedFen, terminalFen) {
  if (!Array.isArray(demonstrations) || demonstrations.length === 0) return [];

  const result = [];
  for (const demo of demonstrations) {
    if (!demo || !Array.isArray(demo.moves) || demo.moves.length === 0) continue;

    const resolvedFen = demo.from === 'userLine' ? terminalFen : flaggedFen;
    if (!resolvedFen) {
      console.warn('[demo] Cannot resolve startFen for from=%s — dropping demo', demo.from);
      continue;
    }

    try {
      const chess = new Chess(resolvedFen);
      const validMoves = [];
      let dropped = false;
      for (const san of demo.moves) {
        const mv = chess.move(san);
        if (!mv) {
          console.warn('[demo] Illegal move "%s" in demo from=%s — dropping rest of this demo', san, demo.from);
          dropped = true;
          break;
        }
        validMoves.push(san);
      }
      if (dropped && validMoves.length === 0) continue;
      result.push({ from: demo.from, moves: validMoves, startFen: resolvedFen });
    } catch (err) {
      console.warn('[demo] Validation error for demo from=%s:', demo.from, err.message);
    }
  }
  return result;
}

// Convert a white-POV centipawn score to a plain-English description.
function cpToPlainLanguage(cp) {
  if (cp == null) return 'unclear';
  if (Math.abs(cp) < 30) return 'roughly equal';
  if (cp > 600) return 'winning for White';
  if (cp > 200) return 'clearly better for White';
  if (cp > 50) return 'slightly better for White';
  if (cp < -600) return 'winning for Black';
  if (cp < -200) return 'clearly better for Black';
  return 'slightly better for Black';
}

// Build the LLM messages array from stored conversation rows.
// user_moves and coach_response rows have their readable text in content already;
// raw move_data is NOT sent to the LLM.
function buildLLMMessages(rows) {
  return rows.map(row => ({ role: row.role, content: row.content }));
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

  const moveIdLookup = new Map();
  for (const m of moves) {
    moveIdLookup.set(`${m.game_id}-${m.move_number}`, { moveId: m.id, gameId: m.game_id });
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
    if (m.moveRef) {
      const moveNumMatch = m.moveRef.match(/Move (\d+)/i);
      const moveNum = moveNumMatch ? parseInt(moveNumMatch[1], 10) : null;
      const ids = (m.gameId != null && moveNum != null) ? moveIdLookup.get(`${m.gameId}-${moveNum}`) : undefined;
      b.moveRefs.push({ moveRef: m.moveRef, moveId: ids?.moveId, gameId: ids?.gameId });
    }
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
Violated in: ${cand.movesViolating.map(mv => (typeof mv === 'string' ? mv : mv.moveRef)).join(', ')}
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
    'SELECT id, role, content, message_type, move_data FROM conversations WHERE move_id = $1 ORDER BY created_at',
    [moveId]
  )).rows;
  res.json(messages);
});

// Send a text message to the coach.
router.post('/conversation/:moveId', async (req, res) => {
  const moveId = parseInt(req.params.moveId, 10);
  if (!Number.isInteger(moveId)) return res.status(400).json({ error: 'Invalid move id' });
  const { message } = req.body;

  if (!await getOwnedMove(moveId, req.user.id)) {
    return res.status(404).json({ error: 'Move not found' });
  }

  await query(
    "INSERT INTO conversations (move_id, role, content, message_type) VALUES ($1, $2, $3, 'text')",
    [moveId, 'user', message]
  );

  const profile = (await query('SELECT * FROM player_profile WHERE user_id = $1', [req.user.id])).rows[0];

  const history = (await query(
    'SELECT id, role, content, message_type, move_data FROM conversations WHERE move_id = $1 ORDER BY created_at',
    [moveId]
  )).rows;

  // Socratic escalation: turn 1 = first coach reply, turn N = Nth reply.
  const currentTurn = history.filter(h => h.role === 'assistant').length + 1;
  const level = profile?.computed_level || 'intermediate';
  const maxTurns = MAX_TURNS_BY_LEVEL[level] ?? DEFAULT_MAX_TURNS;
  const forceAnswer = detectForceAnswer(message);

  const moveRow = (await query(
    `SELECT m.id, m.game_id, m.move_number, m.move, m.fen,
            m.classification, m.centipawn_loss, m.principle_violated,
            m.best_move, m.eval_before, m.eval_after, g.pgn
       FROM moves m
       JOIN games g ON g.id = m.game_id
      WHERE m.id = $1`,
    [moveId]
  )).rows[0];

  // Compute the before-position FEN (where the player made their choice).
  // 'original' demonstrations must start here, not from the after-position stored in moves.fen.
  let fenBefore = null;
  try {
    if (moveRow?.pgn) {
      fenBefore = reconstructBeforeFen(moveRow.pgn, moveRow.move_number, moveRow.move);
    }
  } catch (err) {
    console.warn(`[coach] Could not reconstruct fenBefore for move ${moveId}:`, err.message);
  }

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
            playedMoveSan:  moveRow.move,
            classification: moveRow.classification,
            centipawnLoss:  moveRow.centipawn_loss,
            bestMove:       moveRow.best_move   ?? null,
            evalBefore:     moveRow.eval_before ?? null,
            evalAfter:      moveRow.eval_after  ?? null,
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

  // Compute engine PV for the before-position so the coach can demonstrate the
  // engine's recommended short line. Best-effort: failures yield an empty array.
  let enginePv = [];
  if (facts && fenBefore) {
    try {
      enginePv = await getEnginePv(fenBefore);
    } catch (err) {
      console.warn('[coach] getEnginePv failed for move', moveId, ':', err.message);
    }
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
        enginePv,
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
    // LLM only sees readable text — raw move_data is intentionally excluded.
    const messages = buildLLMMessages(history);

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

    // Parse structured {text, demonstrations} response. Text-only responses
    // also go through here — demonstrations array will just be empty.
    const structured = extractStructuredResponse(reply);
    const resolvedDemos = validateAndResolveDemonstrations(
      structured.demonstrations,
      fenBefore ?? moveRow?.fen,  // before-position where the choice was made
      null                        // no terminalFen for text-only turns
    );
    const moveData = resolvedDemos.length > 0 ? { demonstrations: resolvedDemos } : null;

    await query(
      "INSERT INTO conversations (move_id, role, content, message_type, move_data) VALUES ($1, $2, $3, 'coach_response', $4)",
      [moveId, 'assistant', structured.text, moveData ? JSON.stringify(moveData) : null]
    );

    res.json({ text: structured.text, demonstrations: resolvedDemos });
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

// Submit a composed line for coaching. Stores user_moves + coach_response rows.
// Body: { moves:[{san,from,to}], startFen, terminalFen, terminalEvalCp }
router.post('/conversation/:moveId/line', async (req, res) => {
  const moveId = parseInt(req.params.moveId, 10);
  if (!Number.isInteger(moveId)) return res.status(400).json({ error: 'Invalid move id' });

  if (!await getOwnedMove(moveId, req.user.id)) {
    return res.status(404).json({ error: 'Move not found' });
  }

  const { moves, startFen, terminalFen, terminalEvalCp, userNote } = req.body || {};
  if (!Array.isArray(moves) || moves.length === 0 || !startFen || !terminalFen) {
    return res.status(400).json({ error: 'moves, startFen, and terminalFen are required' });
  }

  // Build a readable, plain-text description of the submitted line for LLM history.
  // When the student attaches a note, include it so that the LLM history captures
  // the stated intent alongside the engine-verified line description.
  const sanList = moves.map(m => m.san).join(' ');
  const evalDesc = cpToPlainLanguage(terminalEvalCp);
  const trimmedNote = (typeof userNote === 'string' ? userNote.trim() : '') || null;
  const noteClause = trimmedNote ? ` Student's stated intent: "${trimmedNote}".` : '';
  const userContent =
    `Student submitted a line for board review: ${sanList} (${moves.length} move${moves.length !== 1 ? 's' : ''} from the flagged position). ` +
    `Engine evaluation of the terminal position: ${evalDesc}.${noteClause}`;

  // Store the user_moves row before calling Claude so history includes it.
  // userNote is stored in move_data so the client can display it on reload.
  const moveDataToStore = { moves, startFen, terminalFen, terminalEvalCp, ...(trimmedNote ? { userNote: trimmedNote } : {}) };
  await query(
    "INSERT INTO conversations (move_id, role, content, message_type, move_data) VALUES ($1, $2, $3, 'user_moves', $4)",
    [moveId, 'user', userContent, JSON.stringify(moveDataToStore)]
  );

  const profile = (await query('SELECT * FROM player_profile WHERE user_id = $1', [req.user.id])).rows[0];

  const history = (await query(
    'SELECT id, role, content, message_type, move_data FROM conversations WHERE move_id = $1 ORDER BY created_at',
    [moveId]
  )).rows;

  const currentTurn = history.filter(h => h.role === 'assistant').length + 1;
  const level = profile?.computed_level || 'intermediate';
  const maxTurns = MAX_TURNS_BY_LEVEL[level] ?? DEFAULT_MAX_TURNS;
  // A note containing give-up phrases ("just tell me", etc.) is treated the same
  // as typing that phrase in chat — it triggers the escalation-ladder bailout.
  const forceAnswer = trimmedNote ? detectForceAnswer(trimmedNote) : false;

  const moveRow = (await query(
    `SELECT m.id, m.game_id, m.move_number, m.move, m.fen,
            m.classification, m.centipawn_loss, m.principle_violated,
            m.best_move, m.eval_before, m.eval_after, g.pgn
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
            playedMoveSan:  moveRow.move,
            classification: moveRow.classification,
            centipawnLoss:  moveRow.centipawn_loss,
            bestMove:       moveRow.best_move   ?? null,
            evalBefore:     moveRow.eval_before ?? null,
            evalAfter:      moveRow.eval_after  ?? null,
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

  // Compute engine PV from the before-position (= startFen for line turns).
  let enginePv = [];
  if (facts && startFen) {
    try {
      enginePv = await getEnginePv(startFen);
    } catch (err) {
      console.warn('[coach/line] getEnginePv failed for move', moveId, ':', err.message);
    }
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
        includeLineDemos: true,
        enginePv,
        userNote: trimmedNote,
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

  const tools = facts ? [EVALUATE_MOVE_TOOL] : [];

  try {
    const llmMessages = buildLLMMessages(history);
    let reply = null;
    let toolCallCount = 0;
    let resolvedAtTier = facts ? 1 : 'none';
    let engineCalled = false;
    const messagesInFlight = [...llmMessages];

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
          max_tokens: 1200,
          system: systemPrompt,
          messages: messagesInFlight,
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
          reply = data.content?.find(b => b.type === 'text')?.text || "I couldn't process that. Try again.";
          break;
        }

        toolCallCount++;
        const { moves: toolMoves, situation } = toolBlock.input || {};
        console.log(`[coach/line] tool call ${toolCallCount}: evaluate_alternative_move moves=${JSON.stringify(toolMoves)} situation=${situation} moveId=${moveId}`);

        const cascadeResult = await resolveCascade(moveId, facts, toolMoves || [], situation || 'LINE_EXPLORATION');
        console.log(`[coach/line] cascade result: tier=${cascadeResult.tier} evalCp=${cascadeResult.evalCp}`);

        if (cascadeResult.tier === 3) { resolvedAtTier = 3; engineCalled = true; }
        else if (cascadeResult.tier === 2 && resolvedAtTier !== 3) { resolvedAtTier = 2; }

        messagesInFlight.push({ role: 'assistant', content: data.content });
        messagesInFlight.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: JSON.stringify(cascadeResult) }],
        });
        continue;
      }

      const textBlock = data.content?.find(b => b.type === 'text');
      reply = textBlock?.text || data.content?.[0]?.text || "I couldn't process that. Try again.";
      break;
    }

    if (!reply) reply = "I couldn't generate a response. Please try again.";

    console.log('[TIER/line] ' + JSON.stringify({ moveId, turnNumber: currentTurn, resolvedAtTier, engineCalled }));

    const structured = extractStructuredResponse(reply);
    const resolvedDemos = validateAndResolveDemonstrations(
      structured.demonstrations,
      startFen,
      terminalFen
    );
    const moveData = { demonstrations: resolvedDemos };

    await query(
      "INSERT INTO conversations (move_id, role, content, message_type, move_data) VALUES ($1, $2, $3, 'coach_response', $4)",
      [moveId, 'assistant', structured.text, JSON.stringify(moveData)]
    );

    res.json({ text: structured.text, demonstrations: resolvedDemos });
  } catch (e) {
    // Roll back the user_moves row on error so the client doesn't see a dangling entry.
    try {
      await query(
        "DELETE FROM conversations WHERE move_id = $1 AND message_type = 'user_moves' AND role = 'user' AND id = (SELECT MAX(id) FROM conversations WHERE move_id = $1 AND message_type = 'user_moves')",
        [moveId]
      );
    } catch (_) {}
    return res.status(500).json({ error: e.message });
  }

  // Best-effort profile refresh.
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

// Cross-batch progression for a specific format.
// Returns computed progression states plus the cached coach summary (if any).
// The coach summary is NEVER generated here — only served from cache.
// Query param: format = classical | rapid | bullet
router.get('/progression', async (req, res) => {
  const { format } = req.query;
  if (!['classical', 'rapid', 'bullet'].includes(format)) {
    return res.status(400).json({ error: 'format must be one of classical, rapid, bullet' });
  }
  try {
    const result = await computeProgression(req.user.id, format);
    if (!result.canCompute) {
      return res.json({ canCompute: false, totalBatches: result.totalBatches });
    }
    // Serve cached summary only — no LLM call on GET.
    const { rows } = await query(
      `SELECT summary, last_batch_number, generated_at
       FROM progression_summaries
       WHERE user_id = $1 AND format = $2`,
      [req.user.id, format]
    );
    const cached = rows[0];
    const summaryIsCurrent = cached && cached.last_batch_number >= result.maxBatchNumber;
    return res.json({
      ...result,
      coachSummary: summaryIsCurrent ? cached.summary : null,
      summaryGeneratedAt: summaryIsCurrent ? cached.generated_at : null,
    });
  } catch (e) {
    console.error('Progression load failed:', e);
    return res.status(500).json({ error: 'Failed to load progression data' });
  }
});

// Lightweight check: which formats are ready for a new batch analysis.
// Returns: { readyFormats: Array<{ format, isFirstRun, totalGames }> }
// Called on dashboard and pattern-analysis mount so the prompt appears
// without requiring a fresh import.
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
//
// First run (no completed batches exist for this format):
//   Fetches ALL games oldest-first, slices into complete fixed-size batches,
//   analyses each sequentially, and sets games_since_last_batch to the remainder.
//
// Subsequent runs:
//   Analyses exactly one new batch of the most recent BATCH_THRESHOLD games,
//   sets games_since_last_batch to 0.
router.post('/patterns/batch', async (req, res) => {
  const format = req.body?.format;
  if (!['classical', 'rapid', 'bullet'].includes(format)) {
    return res.status(400).json({ error: 'format must be one of classical, rapid, bullet' });
  }

  const threshold = BATCH_THRESHOLD[format];
  const minGames = MIN_GAMES[format];

  try {
    // Reject concurrent runs for the same user+format, but only for recently
    // started batches. A pending batch older than 5 minutes is considered stuck
    // (client disconnected, server restarted, etc.) and the ON CONFLICT upsert
    // below will reset it rather than blocking the user indefinitely.
    const { rows: [activePending] } = await query(
      `SELECT id FROM analysis_batches
       WHERE user_id = $1 AND format = $2 AND status = 'pending'
         AND created_at > NOW() - INTERVAL '5 minutes'
       LIMIT 1`,
      [req.user.id, format]
    );
    if (activePending) {
      return res.status(409).json({ error: 'Analysis already in progress for this format' });
    }

    // Has any batch ever completed for this format?
    const { rows: [priorRow] } = await query(
      `SELECT MAX(batch_number) AS max_batch
       FROM analysis_batches
       WHERE user_id = $1 AND format = $2 AND status = 'completed'`,
      [req.user.id, format]
    );
    const priorBatchNumber = priorRow?.max_batch ?? null;
    const isFirstRun = priorBatchNumber === null;

    let batchSlices; // array of game-id arrays, one entry per batch to run
    let startingBatchNumber;

    if (isFirstRun) {
      // Fetch ALL games oldest-first and slice into complete batches.
      // threshold is a compile-time constant — safe to interpolate.
      const allGames = (await query(
        `SELECT id, opponent, played_at FROM games
         WHERE user_id = $1 AND format = $2
         ORDER BY played_at ASC`,
        [req.user.id, format]
      )).rows;

      if (allGames.length < minGames) {
        return res.status(400).json({
          error: `Not enough ${format} games (need ${minGames}, have ${allGames.length})`,
        });
      }

      const completeBatches = Math.floor(allGames.length / threshold);
      batchSlices = [];
      for (let i = 0; i < completeBatches; i++) {
        batchSlices.push(allGames.slice(i * threshold, (i + 1) * threshold).map(g => g.id));
      }
      startingBatchNumber = 1;

      console.log(
        `[batch] first run format=${format} total=${allGames.length} ` +
        `threshold=${threshold} completeBatches=${completeBatches} ` +
        `remainder=${allGames.length % threshold}`
      );
    } else {
      // Subsequent run: one batch of the most recent threshold games.
      const recentGames = (await query(
        `SELECT id, opponent, played_at FROM games
         WHERE user_id = $1 AND format = $2
         ORDER BY played_at DESC
         LIMIT ${threshold}`,
        [req.user.id, format]
      )).rows;

      if (recentGames.length < minGames) {
        return res.status(400).json({
          error: `Not enough ${format} games (need ${minGames}, have ${recentGames.length})`,
        });
      }

      batchSlices = [recentGames.map(g => g.id)];
      startingBatchNumber = priorBatchNumber + 1;
    }

    if (batchSlices.length === 0) {
      return res.status(400).json({
        error: `Not enough ${format} games for a complete batch (need ${threshold})`,
      });
    }

    // Run each batch sequentially. Stop and surface the error on any failure.
    let lastResults;
    let lastBatchId;
    let lastBatchNumber;

    for (let i = 0; i < batchSlices.length; i++) {
      const gameIds = batchSlices[i];
      const batchNumber = startingBatchNumber + i;

      // ON CONFLICT: a prior failed/pending run may have already inserted this
      // batch_number — reset it rather than violating the unique constraint.
      const { rows: [{ id: batchId }] } = await query(
        `INSERT INTO analysis_batches (user_id, format, game_ids, game_count, batch_number, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         ON CONFLICT (user_id, format, batch_number)
         DO UPDATE SET game_ids = EXCLUDED.game_ids, game_count = EXCLUDED.game_count,
                       status = 'pending', completed_at = NULL
         RETURNING id`,
        [req.user.id, format, JSON.stringify(gameIds), gameIds.length, batchNumber]
      );

      console.log(`[batch] created batch ${batchId} format=${format} batchNumber=${batchNumber} games=${gameIds.length}`);

      try {
        const results = await runPatternAnalysis(req.user.id, { gameIds, format, batchId, batchNumber });

        await query(
          `UPDATE analysis_batches SET status = 'completed', completed_at = NOW() WHERE id = $1`,
          [batchId]
        );

        console.log(`[batch] completed batch ${batchId} format=${format} batchNumber=${batchNumber} patterns=${results.patterns?.length ?? 0}`);

        lastResults = results;
        lastBatchId = batchId;
        lastBatchNumber = batchNumber;
      } catch (analysisErr) {
        console.error(`[batch] batch ${batchId} analysis failed:`, analysisErr);
        await query(
          `UPDATE analysis_batches SET status = 'failed' WHERE id = $1`,
          [batchId]
        );
        throw analysisErr;
      }
    }

    // Update game count: remainder for first run (those games wait for the next
    // batch), 0 for subsequent single-batch runs.
    let newGamesSince;
    if (isFirstRun) {
      // Re-fetch total to compute remainder (game count may have changed during analysis).
      const { rows: [{ total }] } = await query(
        `SELECT COUNT(*)::int AS total FROM games WHERE user_id = $1 AND format = $2`,
        [req.user.id, format]
      );
      newGamesSince = total % threshold;
    } else {
      newGamesSince = 0;
    }

    await query(
      `UPDATE format_game_counts
       SET games_since_last_batch = $3, last_batch_completed_at = NOW()
       WHERE user_id = $1 AND format = $2`,
      [req.user.id, format, newGamesSince]
    );

    console.log(`[batch] all done format=${format} batchesRun=${batchSlices.length} games_since_last_batch=${newGamesSince}`);

    // Trigger progression summary generation when >= 2 completed batches exist.
    // This is the ONLY place we call the LLM for progression — never on GET.
    // Fire-and-forget so the batch response is not delayed by summary generation.
    query(
      `SELECT COUNT(*)::int AS n FROM analysis_batches WHERE user_id = $1 AND format = $2 AND status = 'completed'`,
      [req.user.id, format]
    ).then(({ rows: [{ n }] }) => {
      if (n >= 2) {
        generateAndCacheProgressionSummary(req.user.id, format).catch(err =>
          console.error('[progression] summary generation failed:', err)
        );
      }
    }).catch(err => console.error('[progression] batch count check failed:', err));

    res.json({ ...lastResults, format, batchId: lastBatchId, batchNumber: lastBatchNumber, batchesRun: batchSlices.length });
  } catch (e) {
    console.error('Pattern batch analysis failed:', e);
    return res.status(500).json({ error: 'Analysis failed — try again' });
  }
});

module.exports = router;
