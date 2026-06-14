'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const {
  promoteCandidate,
  computeRouting,
  LICHESS_THEMES,
  SIMILARITY_HIGH,
  SIMILARITY_LOW,
  MIN_OCCURRENCE,
  MIN_DISTINCT_USERS,
} = require('../principle-candidates');

router.get('/me', (req, res) => {
  const { id, email, name, avatar_url, role } = req.user;
  res.json({ id, email, name, avatar_url, role });
});

router.get('/stats', async (req, res) => {
  const userCount = (await query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
  const gameCount = (await query('SELECT COUNT(*)::int AS n FROM games')).rows[0].n;
  const moveCount = (await query('SELECT COUNT(*)::int AS n FROM moves')).rows[0].n;

  const routingBuckets = (await query(
    `SELECT routing, COUNT(*)::int AS n FROM principle_candidates WHERE status = 'pending' GROUP BY routing`
  )).rows;
  const queueByRouting = {};
  for (const row of routingBuckets) queueByRouting[row.routing] = row.n;

  const totalQueue = (await query(
    `SELECT COUNT(*)::int AS n FROM principle_candidates WHERE status = 'pending'`
  )).rows[0].n;

  const principleCount = (await query('SELECT COUNT(*)::int AS n FROM principles')).rows[0].n;

  res.json({
    userCount, gameCount, moveCount, principleCount,
    candidateQueue: {
      total: totalQueue,
      auto_approve: queueByRouting.auto_approve || 0,
      human_review: queueByRouting.human_review || 0,
      hold: queueByRouting.hold || 0,
      auto_reject: queueByRouting.auto_reject || 0,
    },
    thresholds: { SIMILARITY_HIGH, SIMILARITY_LOW, MIN_OCCURRENCE, MIN_DISTINCT_USERS },
  });
});

router.get('/candidates', async (req, res) => {
  const { routing, status } = req.query;
  const conditions = [];
  const params = [];

  if (routing) {
    params.push(routing);
    conditions.push(`routing = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  } else {
    conditions.push("status = 'pending'");
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = (await query(
    `SELECT pc.*, p.name AS most_similar_principle_name
     FROM principle_candidates pc
     LEFT JOIN principles p ON p.id = pc.most_similar_principle_id
     ${where}
     ORDER BY
       CASE routing
         WHEN 'human_review' THEN 1
         WHEN 'auto_approve' THEN 2
         WHEN 'hold'         THEN 3
         WHEN 'auto_reject'  THEN 4
         ELSE 5
       END,
       occurrence_count DESC`,
    params
  )).rows;

  res.json(rows);
});

router.post('/candidates/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const { lichessTheme } = req.body || {};

  if (lichessTheme) {
    if (!LICHESS_THEMES.has(lichessTheme)) {
      return res.status(400).json({ error: `Unknown Lichess theme: ${lichessTheme}` });
    }
    await query(
      'UPDATE principle_candidates SET proposed_lichess_theme = $1 WHERE id = $2',
      [lichessTheme, id]
    );
  }

  const result = await promoteCandidate(id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, principleId: result.principleId });
});

router.post('/candidates/:id/merge', async (req, res) => {
  const id = Number(req.params.id);
  const { targetPrincipleId } = req.body || {};
  if (!targetPrincipleId) {
    return res.status(400).json({ error: 'targetPrincipleId is required' });
  }
  const target = (await query('SELECT id FROM principles WHERE id = $1', [targetPrincipleId])).rows[0];
  if (!target) return res.status(404).json({ error: 'Target principle not found' });

  const candidate = (await query('SELECT id, status FROM principle_candidates WHERE id = $1', [id])).rows[0];
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (candidate.status !== 'pending') {
    return res.status(400).json({ error: `Candidate is already ${candidate.status}` });
  }

  await query(
    `UPDATE principle_candidates
     SET status = 'merged', merged_into_principle_id = $1, decided_at = NOW()
     WHERE id = $2`,
    [targetPrincipleId, id]
  );
  res.json({ ok: true });
});

router.post('/candidates/:id/reject', async (req, res) => {
  const id = Number(req.params.id);
  const candidate = (await query('SELECT id, status FROM principle_candidates WHERE id = $1', [id])).rows[0];
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (candidate.status !== 'pending') {
    return res.status(400).json({ error: `Candidate is already ${candidate.status}` });
  }

  await query(
    `UPDATE principle_candidates SET status = 'rejected', decided_at = NOW() WHERE id = $1`,
    [id]
  );
  res.json({ ok: true });
});

router.post('/candidates/:id/set-theme', async (req, res) => {
  const id = Number(req.params.id);
  const { lichessTheme } = req.body || {};
  if (!lichessTheme || !LICHESS_THEMES.has(lichessTheme)) {
    return res.status(400).json({ error: `Unknown Lichess theme: ${lichessTheme}` });
  }

  // Set the theme, then recompute routing from the updated row.
  await query(
    'UPDATE principle_candidates SET proposed_lichess_theme = $1 WHERE id = $2',
    [lichessTheme, id]
  );
  const updated = (await query('SELECT * FROM principle_candidates WHERE id = $1', [id])).rows[0];
  const newRouting = computeRouting(updated);
  await query('UPDATE principle_candidates SET routing = $1 WHERE id = $2', [newRouting, id]);

  res.json({ ok: true, routing: newRouting });
});

router.get('/principles', async (req, res) => {
  const principles = (await query('SELECT * FROM principles ORDER BY id')).rows;
  const themes = (await query('SELECT * FROM principle_themes ORDER BY principle_id')).rows;

  const themeMap = {};
  for (const t of themes) {
    if (!themeMap[t.principle_id]) themeMap[t.principle_id] = [];
    themeMap[t.principle_id].push(t.lichess_theme);
  }

  res.json(principles.map(p => ({ ...p, themes: themeMap[p.id] || [] })));
});

router.post('/principles', async (req, res) => {
  const { id, name, description, level, category, examples, themes } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id and name are required' });
  if (!Array.isArray(themes) || themes.length === 0) {
    return res.status(400).json({ error: 'At least one Lichess theme mapping is required' });
  }
  const invalidThemes = themes.filter(t => !LICHESS_THEMES.has(t));
  if (invalidThemes.length) {
    return res.status(400).json({ error: `Unknown Lichess theme(s): ${invalidThemes.join(', ')}` });
  }
  const existing = (await query('SELECT id FROM principles WHERE id = $1', [id])).rows[0];
  if (existing) return res.status(409).json({ error: `Principle ${id} already exists` });

  await withTransaction(async (client) => {
    await client.query(
      'INSERT INTO principles (id, name, description, level, category, examples) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, name, description || null, level || 'intermediate', category || null, examples || null]
    );
    for (const theme of themes) {
      await client.query(
        'INSERT INTO principle_themes (principle_id, lichess_theme) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, theme]
      );
    }
  });

  res.status(201).json({ ok: true, id });
});

module.exports = router;
