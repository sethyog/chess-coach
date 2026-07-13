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

// ── Coach feedback review ─────────────────────────────────────────────────────
// The point of collecting thumbs up/down: a dev/admin-facing view of exactly
// what was rated badly and why, with enough context to actually use it as a
// labeled example (the response text, the flagged move, and the conversation
// leading up to it). Friends-and-family scale — a queryable endpoint, not a
// polished UI.

// GET /admin/feedback?rating=down&limit=50
// Returns rated coach messages with full context: the response text, the
// flagged move, the game, and every conversation turn up to and including
// the rated message (so you can see what led to it).
router.get('/feedback', async (req, res) => {
  const rating = req.query.rating === 'up' ? 'up' : req.query.rating === 'all' ? null : 'down';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);

  const params = [];
  let where = '';
  if (rating) {
    params.push(rating);
    where = `WHERE cf.rating = $${params.length}`;
  }
  params.push(limit);

  const rows = (await query(
    `SELECT
       cf.id AS feedback_id, cf.rating, cf.reason, cf.created_at AS rated_at, cf.user_id,
       c.id AS message_id, c.content AS response_text, c.created_at AS message_created_at, c.move_id,
       m.move, m.classification, m.principle_violated, m.fen,
       g.id AS game_id, g.opponent
     FROM coach_feedback cf
     JOIN conversations c ON c.id = cf.message_id
     JOIN moves m ON m.id = c.move_id
     JOIN games g ON g.id = m.game_id
     ${where}
     ORDER BY cf.created_at DESC
     LIMIT $${params.length}`,
    params
  )).rows;

  // Friends-and-family scale: one query per row for the leading conversation
  // is fine here — this is a review endpoint, not a hot path.
  const results = [];
  for (const row of rows) {
    const conversation = (await query(
      `SELECT role, content, message_type, created_at
       FROM conversations
       WHERE move_id = $1 AND created_at <= $2
       ORDER BY created_at`,
      [row.move_id, row.message_created_at]
    )).rows;

    results.push({
      feedbackId: row.feedback_id,
      rating: row.rating,
      reason: row.reason,
      ratedAt: row.rated_at,
      userId: row.user_id,
      message: { id: row.message_id, content: row.response_text, createdAt: row.message_created_at },
      move: {
        id: row.move_id,
        move: row.move,
        classification: row.classification,
        principleViolated: row.principle_violated,
        fen: row.fen,
      },
      game: { id: row.game_id, opponent: row.opponent },
      conversation,
    });
  }

  res.json(results);
});

// GET /admin/feedback/stats
// Aggregate signal: total up/down, down-rate, breakdown by reason chip, and a
// daily up/down time series (last 30 days) so the down-rate is trackable
// over time, not just a pile of individual reports.
router.get('/feedback/stats', async (req, res) => {
  const totals = (await query(
    `SELECT rating, COUNT(*)::int AS n FROM coach_feedback GROUP BY rating`
  )).rows;
  const totalUp = totals.find((r) => r.rating === 'up')?.n || 0;
  const totalDown = totals.find((r) => r.rating === 'down')?.n || 0;
  const total = totalUp + totalDown;

  const reasonRows = (await query(
    `SELECT reason, COUNT(*)::int AS n FROM coach_feedback WHERE rating = 'down' GROUP BY reason`
  )).rows;
  const byReason = { unclear: 0, not_helpful: 0, wrong_tone: 0, too_long: 0, none: 0 };
  for (const r of reasonRows) byReason[r.reason || 'none'] = r.n;

  const dailyRows = (await query(
    `SELECT date_trunc('day', created_at)::date AS day, rating, COUNT(*)::int AS n
     FROM coach_feedback
     WHERE created_at >= NOW() - INTERVAL '30 days'
     GROUP BY day, rating
     ORDER BY day`
  )).rows;
  const byDay = new Map();
  for (const r of dailyRows) {
    const key = r.day.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, { day: key, up: 0, down: 0 });
    byDay.get(key)[r.rating] = r.n;
  }
  const overTime = [...byDay.values()].map((d) => ({
    ...d,
    downRate: d.up + d.down > 0 ? d.down / (d.up + d.down) : null,
  }));

  res.json({
    totalUp,
    totalDown,
    downRate: total > 0 ? totalDown / total : null,
    byReason,
    overTime,
  });
});

// ── Coach health (Level 1: queryable view, no dashboard) ─────────────────────
// Unifies the three coach-quality signals, time-bucketed, in one response:
//   1. violations   — prose-backstop's mutating catches (correctness). A rate
//                      spike signals a new code path bypassing the facts
//                      discipline — the recurring bug class.
//   2. sequenceHits  — prose-backstop's log-only sequence-depth check
//                      (compliance, soft Part-1 violation, not harmful).
//   3. thumbs        — human up/down judgment (quality no automated check
//                      captures), plus down-reason breakdown.
// The point is the TREND: a rate change across buckets, not a lifetime total
// (see coach_telemetry for the persisted per-response counts this reads).
const COACH_HEALTH_BUCKETS = new Set(['day', 'week']);

router.get('/coach-health', async (req, res) => {
  const bucket = COACH_HEALTH_BUCKETS.has(req.query.bucket) ? req.query.bucket : 'week';

  const now = new Date();
  const defaultFrom = new Date(now);
  if (bucket === 'day') defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
  else defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 12 * 7);

  const from = req.query.from ? new Date(req.query.from) : defaultFrom;
  const to = req.query.to ? new Date(req.query.to) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return res.status(400).json({ error: 'from/to must be valid dates' });
  }

  const telemetryRows = (await query(
    `SELECT date_trunc($1, created_at) AS bucket,
            COUNT(*)::int AS total_responses,
            COALESCE(SUM(violations_count), 0)::int AS violations_total,
            COALESCE(SUM(sequence_hits_count), 0)::int AS sequence_hits_total
       FROM coach_telemetry
      WHERE created_at >= $2 AND created_at < $3
      GROUP BY bucket`,
    [bucket, from, to]
  )).rows;

  const thumbsRows = (await query(
    `SELECT date_trunc($1, created_at) AS bucket, rating, COUNT(*)::int AS n
       FROM coach_feedback
      WHERE created_at >= $2 AND created_at < $3
      GROUP BY bucket, rating`,
    [bucket, from, to]
  )).rows;

  const reasonRows = (await query(
    `SELECT date_trunc($1, created_at) AS bucket, reason, COUNT(*)::int AS n
       FROM coach_feedback
      WHERE rating = 'down' AND created_at >= $2 AND created_at < $3
      GROUP BY bucket, reason`,
    [bucket, from, to]
  )).rows;

  const bucketKey = (d) => d.toISOString().slice(0, 10);
  const buckets = new Map();
  function getBucket(key) {
    if (!buckets.has(key)) {
      buckets.set(key, {
        bucket: key,
        totalResponses: 0,
        violations: { total: 0, rate: null },
        sequenceHits: { total: 0, rate: null },
        thumbs: {
          up: 0, down: 0, downRate: null,
          byReason: { unclear: 0, not_helpful: 0, wrong_tone: 0, too_long: 0, none: 0 },
        },
      });
    }
    return buckets.get(key);
  }

  for (const row of telemetryRows) {
    const b = getBucket(bucketKey(row.bucket));
    b.totalResponses = row.total_responses;
    b.violations.total = row.violations_total;
    b.sequenceHits.total = row.sequence_hits_total;
  }
  for (const row of thumbsRows) {
    const b = getBucket(bucketKey(row.bucket));
    if (row.rating === 'up') b.thumbs.up = row.n;
    else if (row.rating === 'down') b.thumbs.down = row.n;
  }
  for (const row of reasonRows) {
    getBucket(bucketKey(row.bucket)).thumbs.byReason[row.reason || 'none'] = row.n;
  }

  const buckets_ = [...buckets.values()]
    .map((b) => {
      b.violations.rate = b.totalResponses > 0 ? b.violations.total / b.totalResponses : null;
      b.sequenceHits.rate = b.totalResponses > 0 ? b.sequenceHits.total / b.totalResponses : null;
      const thumbsTotal = b.thumbs.up + b.thumbs.down;
      b.thumbs.downRate = thumbsTotal > 0 ? b.thumbs.down / thumbsTotal : null;
      return b;
    })
    .sort((a, b) => (a.bucket < b.bucket ? 1 : -1)); // most recent bucket first

  res.json({ bucket, from: from.toISOString(), to: to.toISOString(), buckets: buckets_ });
});

module.exports = router;
