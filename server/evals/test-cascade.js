'use strict';

// Integration test for engine-cascade.js — exercises resolveCascade directly.
// Covers: Tier 2 (chess.js legality), Tier 3 (engine eval), budget cap,
// cache hits, and dial gate behavior.
//
// Usage:
//   ENGINE_CONSULTATION_LEVEL=MED node server/test-cascade.js
//
// Requires a running Postgres (DATABASE_URL) and stockfish in PATH.
// Uses a synthetic move_id of 999999 — clears any existing coaching_facts row
// for that id before running, then cleans up after.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { query }                  = require('../db');
const { resolveCascade,
        ENGINE_CONSULTATION_LEVEL,
        MAX_ENGINE_CALLS_PER_CONVO } = require('../engine-cascade');
const { isEngineAvailable }      = require('../engine');

const STARTUP_DELAY_MS = 1500;

// ── Synthetic facts object (mirrors what coach.js builds from coaching_facts) ─
// FEN is from the Qxf5 blunder position (White just played Qxf5?? leaving queen hanging).
const FAKE_MOVE_ID = 999999;

const FACTS = {
  fenBefore:     'r1b1k2r/pppp1ppp/2n1pq2/8/1bB1P3/2N2N2/PPP2PPP/R1BQK2R w KQkq - 0 7',
  playedMoveSan: 'Qxf5',
  playedMoveValid: true,
  sideToMove:    'white',
  legalMoves:    ['Qxf5', 'Nxf6', 'O-O', 'Bd3'],
  playedMoveDetails: { sentence: 'White captured on f5 with the queen.' },
  pieceMap:      'White: Qd1 Bc4 Nc3 Nf3 ...',
  engine: {
    evalBefore:    20,
    evalAfter:    -150,
    centipawnSwing: 170,
    bestMove:      'O-O',
    engineReason:  'Leaves the queen hanging on f5.',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function pad(s, n) { return String(s).padEnd(n); }

let passed = 0;
let total  = 0;

function check(label, condition, detail = '') {
  total++;
  const ok = !!condition;
  if (ok) passed++;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${label}${detail ? '  ← ' + detail : ''}`);
  return ok;
}

async function seedFacts(engineCallsUsed = 0) {
  await query(
    `INSERT INTO coaching_facts (move_id, engine_calls_used)
     VALUES ($1, $2)
     ON CONFLICT (move_id) DO UPDATE SET engine_calls_used = $2`,
    [FAKE_MOVE_ID, engineCallsUsed]
  );
}

async function cleanup() {
  await query('DELETE FROM coaching_facts WHERE move_id = $1', [FAKE_MOVE_ID]);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

async function testIllegalMove() {
  console.log('\n── Tier 2: illegal move ─────────────────────────────────────');
  await seedFacts(0);
  const r = await resolveCascade(FAKE_MOVE_ID, FACTS, ['Qh9'], 'DIRECT_CHALLENGE');
  check('ok=true',    r.ok  === true);
  check('legal=false', r.legal === false);
  check('tier=2',     r.tier === 2);
}

async function testLegalTier2NoEngine() {
  console.log('\n── Tier 2: legal move, dial=OFF (no engine) ─────────────────');
  await seedFacts(0);
  // resolveCascade checks ENGINE_CONSULTATION_LEVEL at runtime; if OFF, gate blocks.
  const r = await resolveCascade(FAKE_MOVE_ID, FACTS, ['Nxf6'], 'DIRECT_CHALLENGE');
  check('ok=true',          r.ok === true);
  check('legal=true',       r.legal === true);
  check('tier=2',           r.tier === 2);
  check('no evalCp',        r.evalCp === null);
  if (ENGINE_CONSULTATION_LEVEL !== 'OFF') {
    console.log('    (skipped OFF-gate check — current level is', ENGINE_CONSULTATION_LEVEL + ')');
  }
}

async function testCacheHit() {
  console.log('\n── Cache: repeated FEN returns instantly ─────────────────────');
  await seedFacts(0);
  // First call (may hit engine if level allows).
  const r1 = await resolveCascade(FAKE_MOVE_ID, FACTS, ['Nxf6'], 'DIRECT_CHALLENGE');
  await seedFacts(0); // reset budget counter

  const t0 = Date.now();
  const r2  = await resolveCascade(FAKE_MOVE_ID, FACTS, ['Nxf6'], 'DIRECT_CHALLENGE');
  const ms  = Date.now() - t0;

  check('second call ok',       r2.ok === true);
  check('same tier or better',  r2.tier >= r1.tier || r2.tier === 2);
  if (r1.tier === 3 && r2.tier === 3) {
    check('cache: same evalCp',   r2.evalCp === r1.evalCp, `${r1.evalCp} == ${r2.evalCp}`);
    check('cache: fast (<100ms)', ms < 100, `${ms}ms`);
  } else {
    console.log('    (cache hit only observable when Tier 3 reached; current level:', ENGINE_CONSULTATION_LEVEL + ')');
  }
}

async function testBudgetExhaustion() {
  console.log('\n── Budget: exhausted → note returned, no engine call ─────────');
  const cap = MAX_ENGINE_CALLS_PER_CONVO[ENGINE_CONSULTATION_LEVEL] ?? 0;
  if (cap === 0) {
    console.log('    (skipped — dial is OFF, budget is 0)');
    return;
  }
  // Seed with budget already at cap.
  await seedFacts(cap);
  const r = await resolveCascade(FAKE_MOVE_ID, FACTS, ['Nxf6'], 'DIRECT_CHALLENGE');
  check('ok=true',            r.ok   === true);
  check('legal=true',         r.legal === true);
  check('tier=2 (no engine)', r.tier  === 2);
  check('note present',       typeof r.note === 'string' && r.note.length > 0, r.note);
}

async function testDialGate() {
  console.log('\n── Dial gate: USER_PROPOSAL blocked at LOW ───────────────────');
  await seedFacts(0);
  const r = await resolveCascade(FAKE_MOVE_ID, FACTS, ['Nb5'], 'USER_PROPOSAL');
  check('ok=true',  r.ok === true);
  check('legal=true', r.legal === true);
  if (ENGINE_CONSULTATION_LEVEL === 'LOW') {
    check('tier=2 (gate blocked)',  r.tier === 2,  `tier=${r.tier}`);
    check('note explains gate',     typeof r.note === 'string', r.note);
  } else {
    console.log(`    (gate test only applies at LOW; current level is ${ENGINE_CONSULTATION_LEVEL})`);
    check('tier>=2', r.tier >= 2);
  }
}

async function testTier3EngineEval() {
  console.log('\n── Tier 3: engine eval on Qxf5 blunder ──────────────────────');
  if (!isEngineAvailable()) {
    console.log('    [SKIP] engine not available');
    return;
  }
  if (ENGINE_CONSULTATION_LEVEL === 'OFF') {
    console.log('    [SKIP] ENGINE_CONSULTATION_LEVEL=OFF');
    return;
  }
  await seedFacts(0);
  const r = await resolveCascade(FAKE_MOVE_ID, FACTS, ['Qxf5'], 'DIRECT_CHALLENGE');
  check('ok=true',         r.ok    === true);
  check('legal=true',      r.legal === true);
  check('tier=3',          r.tier  === 3,  `got tier=${r.tier}${r.note ? ' note=' + r.note : ''}`);
  check('evalCp present',  r.evalCp !== null, `evalCp=${r.evalCp}`);
  check('bestResponse',    !!r.bestResponse,   `bestResponse=${r.bestResponse}`);
  check('budget consumed', r.engineCallsUsed === 1, `engineCallsUsed=${r.engineCallsUsed}`);
  if (r.comparedToActual !== null) {
    check('comparedToActual is number', typeof r.comparedToActual === 'number', `${r.comparedToActual} cp`);
  }
  console.log(`    evalCp=${r.evalCp}  bestResponse=${r.bestResponse}  mateIn=${r.mateIn ?? '—'}  whatHangs=${JSON.stringify(r.whatHangs)}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\nChess Sensei — cascade integration test`);
  console.log(`ENGINE_CONSULTATION_LEVEL=${ENGINE_CONSULTATION_LEVEL}  cap=${MAX_ENGINE_CALLS_PER_CONVO[ENGINE_CONSULTATION_LEVEL] ?? 0}`);

  await new Promise(r => setTimeout(r, STARTUP_DELAY_MS));

  try {
    await testIllegalMove();
    await testLegalTier2NoEngine();
    await testCacheHit();
    await testBudgetExhaustion();
    await testDialGate();
    await testTier3EngineEval();
  } finally {
    await cleanup();
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed}/${total} passed\n`);
  process.exit(passed === total ? 0 : 1);
}

run().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
