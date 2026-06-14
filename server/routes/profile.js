'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { levelFromRating, updateProfile } = require('../profile-service');

router.get('/', async (req, res) => {
  const profile = (await query('SELECT * FROM player_profile WHERE user_id = $1', [req.user.id])).rows[0];
  res.json(profile || null);
});

router.post('/rating', async (req, res) => {
  const { reported_rating } = req.body;
  if (typeof reported_rating !== 'number' || reported_rating <= 0) {
    return res.status(400).json({ error: 'reported_rating must be a positive number' });
  }

  const analysedRow = (await query(
    `SELECT COUNT(DISTINCT m.game_id)::int AS n
     FROM moves m
     JOIN games g ON g.id = m.game_id
     WHERE g.user_id = $1 AND m.centipawn_loss IS NOT NULL`,
    [req.user.id]
  )).rows[0];
  const hasAnalysedPlay = analysedRow.n > 0;

  if (!hasAnalysedPlay) {
    const initialLevel = levelFromRating(reported_rating);
    await query(
      `UPDATE player_profile
       SET reported_rating = $1, computed_level = $2, profile_updated_at = NOW()
       WHERE user_id = $3`,
      [reported_rating, initialLevel, req.user.id]
    );
  } else {
    await query(
      `UPDATE player_profile SET reported_rating = $1, profile_updated_at = NOW() WHERE user_id = $2`,
      [reported_rating, req.user.id]
    );
  }

  const profile = (await query('SELECT * FROM player_profile WHERE user_id = $1', [req.user.id])).rows[0];
  res.json(profile);
});

router.post('/update', async (req, res) => {
  const updated = await updateProfile(req.user.id);
  res.json(updated);
});

module.exports = router;
