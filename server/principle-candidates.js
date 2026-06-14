'use strict';

const { query, withTransaction } = require('./db');
const { buildVocab, vectorize, cosineSimilarity } = require('./embeddings');

const SIMILARITY_HIGH = 0.80;
const SIMILARITY_LOW = 0.60;
const MIN_OCCURRENCE = 3;
const MIN_DISTINCT_USERS = 2;

const LICHESS_THEMES = new Set([
  'fork', 'pin', 'skewer', 'hangingPiece', 'discoveredAttack', 'doubleCheck',
  'xRayAttack', 'deflection', 'attraction', 'sacrifice', 'intermezzo',
  'attackingF2F7', 'kingsideAttack', 'queensideAttack', 'quietMove',
  'defensiveMove', 'clearance',
  'mate', 'mateIn1', 'mateIn2', 'mateIn3', 'backRankMate', 'smotheredMate',
  'hookMate', 'anastasiaMate', 'arabianMate',
  'endgame', 'rookEndgame', 'queenEndgame', 'bishopEndgame', 'knightEndgame',
  'pawnEndgame', 'queenRookEndgame', 'promotion', 'underPromotion', 'zugzwang',
  'exposedKing', 'trappedPiece', 'capturingDefender',
  'opening', 'middlegame',
  'advantage', 'crushing', 'equality', 'castling', 'enPassant',
]);

async function prepareCandidate(suggestedName, hintLevel) {
  const themeList = Array.from(LICHESS_THEMES).sort().join(', ');
  const prompt = `A chess coach has suggested a new principle that doesn't match any in the existing controlled vocabulary. Draft the supporting metadata.

Suggested name: "${suggestedName}"
Player level hint (calibrate language to this): ${hintLevel || 'intermediate'}

Return ONLY a JSON object, no markdown, no preamble:
{
  "description": "1-2 sentences explaining what the principle means and why it matters. Use the same style as existing chess principles — a positive imperative ('Castle early to protect your king'), instructive, no preamble.",
  "lichessTheme": "the single most relevant Lichess puzzle theme name for this principle, chosen from: ${themeList}"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '<no body>');
      throw new Error(`Anthropic ${response.status}: ${errBody}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objMatch) throw new Error('No JSON object in response');
    const parsed = JSON.parse(objMatch[0]);
    return {
      description: String(parsed.description || '').trim(),
      lichessTheme: String(parsed.lichessTheme || '').trim(),
    };
  } catch (err) {
    console.error(`Candidate prep failed for "${suggestedName}":`, err);
    return null;
  }
}

async function computeSimilarity(candidateText) {
  const allPrinciples = (await query('SELECT id, name, description FROM principles ORDER BY id')).rows;
  if (allPrinciples.length === 0) {
    return { similarity: 0, mostSimilarPrincipleId: null };
  }
  const corpus = allPrinciples.map(p => `${p.name} ${p.description || ''}`);
  const vocab = buildVocab([...corpus, candidateText]);
  const candVec = vectorize(candidateText, vocab);

  let maxSim = 0;
  let mostSimilarId = null;
  for (let i = 0; i < allPrinciples.length; i++) {
    const sim = cosineSimilarity(candVec, vectorize(corpus[i], vocab));
    if (sim > maxSim) {
      maxSim = sim;
      mostSimilarId = allPrinciples[i].id;
    }
  }
  return { similarity: maxSim, mostSimilarPrincipleId: mostSimilarId };
}

function computeRouting(c) {
  if (!c.proposed_lichess_theme || !LICHESS_THEMES.has(c.proposed_lichess_theme)) {
    return 'auto_reject';
  }
  if (c.similarity_score != null && c.similarity_score >= SIMILARITY_HIGH) {
    return 'human_review';
  }
  if (c.occurrence_count < MIN_OCCURRENCE || c.distinct_user_count < MIN_DISTINCT_USERS) {
    return 'hold';
  }
  if (c.similarity_score != null && c.similarity_score < SIMILARITY_LOW) {
    return 'auto_approve';
  }
  return 'human_review';
}

async function logCandidate(suggestedName, userId, hintLevel) {
  const cleanName = String(suggestedName || '').trim();
  if (!cleanName) return null;

  const existing = (await query(
    'SELECT * FROM principle_candidates WHERE LOWER(suggested_name) = LOWER($1)',
    [cleanName]
  )).rows[0];

  if (existing) {
    await query(
      `UPDATE principle_candidates
       SET occurrence_count = occurrence_count + 1, last_seen = NOW()
       WHERE id = $1`,
      [existing.id]
    );

    await query(
      'INSERT INTO principle_candidate_users (candidate_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [existing.id, userId]
    );

    const distinctCount = (await query(
      'SELECT COUNT(*)::int AS n FROM principle_candidate_users WHERE candidate_id = $1',
      [existing.id]
    )).rows[0].n;

    await query(
      'UPDATE principle_candidates SET distinct_user_count = $1 WHERE id = $2',
      [distinctCount, existing.id]
    );

    const updated = (await query('SELECT * FROM principle_candidates WHERE id = $1', [existing.id])).rows[0];
    const newRouting = computeRouting(updated);
    if (newRouting !== updated.routing) {
      await query('UPDATE principle_candidates SET routing = $1 WHERE id = $2', [newRouting, existing.id]);
    }

    return existing.id;
  }

  const prep = await prepareCandidate(cleanName, hintLevel);
  const candidateText = `${cleanName} ${prep?.description || ''}`;
  const { similarity, mostSimilarPrincipleId } = await computeSimilarity(candidateText);

  const draftRow = {
    proposed_lichess_theme: prep?.lichessTheme || null,
    similarity_score: similarity,
    occurrence_count: 1,
    distinct_user_count: 1,
  };
  const routing = computeRouting(draftRow);

  const insertRes = await query(
    `INSERT INTO principle_candidates (
       suggested_name, suggested_description, proposed_lichess_theme,
       similarity_score, most_similar_principle_id,
       occurrence_count, distinct_user_count, status, routing
     ) VALUES ($1, $2, $3, $4, $5, 1, 1, 'pending', $6) RETURNING id`,
    [
      cleanName,
      prep?.description || null,
      prep?.lichessTheme || null,
      similarity,
      mostSimilarPrincipleId,
      routing,
    ]
  );
  const newId = insertRes.rows[0].id;

  await query(
    'INSERT INTO principle_candidate_users (candidate_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [newId, userId]
  );

  return newId;
}

async function inferLevelAndCategory(name, description) {
  const prompt = `A new chess principle is being added to a coaching app's controlled vocabulary.

Principle name: "${name}"
Description: "${description}"

Classify it:
- level: exactly one of "beginner" | "intermediate" | "advanced"
- category: exactly one of "king safety" | "piece activity" | "pawn structure" | "development" | "centre control" | "rook placement" | "piece coordination" | "endgame basics" | "tactical awareness"

Return ONLY a JSON object, no markdown:
{"level": "...", "category": "..."}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic ${response.status}`);
    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in response');
    const parsed = JSON.parse(m[0]);
    return {
      level: parsed.level || 'intermediate',
      category: parsed.category || 'piece activity',
    };
  } catch (err) {
    console.error('inferLevelAndCategory failed:', err);
    return { level: 'intermediate', category: 'piece activity' };
  }
}

async function promoteCandidate(candidateId) {
  const candidate = (await query('SELECT * FROM principle_candidates WHERE id = $1', [candidateId])).rows[0];
  if (!candidate) return { ok: false, error: 'Candidate not found' };
  if (candidate.status !== 'pending') {
    return { ok: false, error: `Candidate is already ${candidate.status}` };
  }
  if (!candidate.proposed_lichess_theme || !LICHESS_THEMES.has(candidate.proposed_lichess_theme)) {
    return { ok: false, error: 'Cannot promote: no valid Lichess theme. Assign one in the admin UI first.' };
  }

  const lastIdRow = (await query('SELECT id FROM principles ORDER BY id DESC LIMIT 1')).rows[0];
  const nextNum = lastIdRow
    ? parseInt(lastIdRow.id.replace(/[^0-9]/g, ''), 10) + 1
    : 26;
  const newId = `P${String(nextNum).padStart(2, '0')}`;

  const { level, category } = await inferLevelAndCategory(
    candidate.suggested_name,
    candidate.suggested_description || ''
  );

  await withTransaction(async (client) => {
    await client.query(
      'INSERT INTO principles (id, name, description, level, category) VALUES ($1, $2, $3, $4, $5)',
      [newId, candidate.suggested_name, candidate.suggested_description || '', level, category]
    );
    await client.query(
      'INSERT INTO principle_themes (principle_id, lichess_theme) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [newId, candidate.proposed_lichess_theme]
    );
    await client.query(
      `UPDATE principle_candidates
       SET status = 'approved', promoted_principle_id = $1, decided_at = NOW()
       WHERE id = $2`,
      [newId, candidateId]
    );
  });

  // Rebuild embedding cache so the new principle appears in future similarity checks.
  try {
    const { buildVocab: bv, vectorize: vec } = require('./embeddings');
    const allPrinciples = (await query('SELECT id, name, description FROM principles ORDER BY id')).rows;
    const corpus = allPrinciples.map(p => `${p.name} ${p.description || ''}`);
    const vocab = bv(corpus);
    for (let i = 0; i < allPrinciples.length; i++) {
      await query(
        `INSERT INTO principle_embeddings (principle_id, vector) VALUES ($1, $2)
         ON CONFLICT (principle_id) DO UPDATE SET vector = EXCLUDED.vector`,
        [allPrinciples[i].id, JSON.stringify(vec(corpus[i], vocab))]
      );
    }
    console.log(
      `Auto-approval: promoted candidate ${candidateId} → principle ${newId} ("${candidate.suggested_name}"). Embeddings rebuilt.`
    );
  } catch (err) {
    console.error(`Embedding rebuild failed after promoting ${newId}:`, err);
  }

  return { ok: true, principleId: newId };
}

module.exports = {
  logCandidate,
  promoteCandidate,
  computeRouting,
  computeSimilarity,
  prepareCandidate,
  SIMILARITY_HIGH,
  SIMILARITY_LOW,
  MIN_OCCURRENCE,
  MIN_DISTINCT_USERS,
  LICHESS_THEMES,
};
