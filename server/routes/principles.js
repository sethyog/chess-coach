'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');

router.get('/', async (req, res) => {
  const rows = (await query('SELECT * FROM principles ORDER BY id')).rows;
  res.json(rows);
});

router.get('/:level', async (req, res) => {
  const rows = (await query('SELECT * FROM principles WHERE level = $1 ORDER BY id', [req.params.level])).rows;
  res.json(rows);
});

module.exports = router;
