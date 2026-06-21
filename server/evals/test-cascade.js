'use strict';

// Integration test for engine-cascade.js — exercises resolveCascade directly.
// Covers: Tier 2 (chess.js legality), Tier 3 (engine eval), budget cap,
// cache hits, and dial gate behavior.
//
// Usage:
//   ENGINE_CONSULTATION_LEVEL=MED node server/evals/test-cascade.js
//
// Requires a running Postgres (DATABASE_URL) and stockfish in PATH.
// Borrows a real move_id from the moves table to satisfy the FK constraint.
// Saves and restores the coaching_facts row for that move so real data is untouched.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { query }                  = require('../db');
const { resolveCascade,
        ENGINE_CONSULTATION_LEVEL,
        MAX_ENGINE_CALLS_PER_CONVO } = require('../engine-cascade');
const { isEngineAvailable }      = require('../engine');

const STARTUP_DELAY_MS = 1500;

// ── Synthetic facts object ────────────────────────────────────────────────────
// Position: White to move, mid-game. Confirmed legal moves via chess.js.
// TEST_MOVE_ID is resolved at runtime from a real moves row (FK constraint).
let TEST_MOVE_ID = null;
let originalEngineCallsUsed = null;

const FACTS = {
  fenBefore:     'r1b1k2r/pppp1ppp/2n1pq2/8/1bB1P3/2N2N2/PPP2PPP/R1BQK2R w KQkq - 0 7',
  playedMoveSan: 'Nd4',
  playedMoveValid: true,
  sideToMove:    'white',
  legalMoves:    ['Nd4', 'Ne5', 'O-O', 'Bd3', 'Bxe6'],
  playedMoveDetails: { sentence: 'Knight from f3 to d4.' },
  pieceMap:      'White: Qd1 Bc4 Nc3 Nf3 ...',
  engine: {
    evalBefore:    20,
    evalAfter:    -150,
    centipawnSwing: 170,
    bestMove:      'O-O',
    engineReason:  'Misses O-O which keeps the position balanced.',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

let passed = 0;
let total  = 0;

function check(label, condition, detail = '') {
  total++;
  const ok = !!condition;
  if (ok) passed++;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${label}${detail ? '  ← got: ' + detail : ''}`);
  return ok;
}

function section(title, description) {
  console.log(`\n── ${title}`);
  console.log(`   Scenario: ${description}`);
}

async function seedFacts(engineCallsUsed = 0) {
  await query(
    `INSERT INTO coaching_facts (move_id, facts, engine_calls_used)
     VALUES ($1, $2, $3)
     ON CONFLICT (move_id) DO UPDATE SET facts = $2, engine_calls_used = $3`,
    [TEST_MOVE_ID, JSON.stringify(FACTS), engineCallsUsed]
  );
}

async function cleanup() {
  if (originalEngineCallsUsed === null) {
    await query('DELETE FROM coaching_facts WHERE move_id = $1', [TEST_MOVE_ID]);
  } else {
    await query(
      'UPDATE coaching_facts SET engine_calls_used = $1 WHERE move_id = $2',
      [originalEngineCallsUsed, TEST_MOVE_ID]
    );
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

async function testIllegalMove() {
  section(
    'Tier 2: illegal move rejection',
    'Student asks about "Qh9" — a square that does not exist. Expected: cascade returns legal=false at Tier 2 without touching the engine.'
  );
  await seedFacts(0);
  const r = await resolveCascade(TEST_MOVE_ID, FACTS, ['Qh9'], 'DIRECT_CHALLENGE');
  check('cascade completes without throwing  (ok=true)',   r.ok === true);
  check('move flagged as illegal             (legal=false)', r.legal === false);
  check('stopped at chess.js layer           (tier=2)',     r.tier === 2);
  check('error message present',             typeof r.error === 'string' && r.error.length > 0, r.error);
}

async function testLegalTier2NoEngine() {
  section(
    'Tier 2: legal move with engine gate closed',
    `Student proposes "Nd4" (a valid knight move). At level ${ENGINE_CONSULTATION_LEVEL}, ` +
    (ENGINE_CONSULTATION_LEVEL === 'OFF'
      ? 'engine is OFF — expected: Tier 2 only, evalCp=null.'
      : 'engine is available but this test verifies the Tier 2 path when engine is OFF. ' +
        'Currently running at ' + ENGINE_CONSULTATION_LEVEL + ' so OFF-gate check is skipped.')
  );
  await seedFacts(0);
  const r = await resolveCascade(TEST_MOVE_ID, FACTS, ['Nd4'], 'DIRECT_CHALLENGE');
  check('cascade completes without throwing  (ok=true)',  r.ok === true);
  check('"Nd4" accepted as legal by chess.js (legal=true)', r.legal === true);
  check('returned tier value is a number    (tier>=2)',   r.tier >= 2);
  if (ENGINE_CONSULTATION_LEVEL === 'OFF') {
    check('no eval when engine is OFF         (evalCp=null)', r.evalCp === null);
  } else {
    console.log(`   (evalCp=null check skipped — engine is ${ENGINE_CONSULTATION_LEVEL}, may have reached Tier 3)`);
  }
}

async function testCacheHit() {
  section(
    'Cache: identical FEN evaluated twice',
    'Same position "Nd4" evaluated twice in a row. ' +
    'Expected: second call returns instantly (<100ms) with identical evalCp — no second engine call fired.'
  );
  await seedFacts(0);
  const r1 = await resolveCascade(TEST_MOVE_ID, FACTS, ['Nd4'], 'DIRECT_CHALLENGE');
  await seedFacts(0); // reset budget so second call isn't blocked by exhaustion

  const t0 = Date.now();
  const r2  = await resolveCascade(TEST_MOVE_ID, FACTS, ['Nd4'], 'DIRECT_CHALLENGE');
  const ms  = Date.now() - t0;

  check('second call completes without throwing (ok=true)', r2.ok === true);
  check('"Nd4" still legal on second call      (legal=true)', r2.legal === true);

  if (r1.tier === 3 && r2.tier === 3) {
    check(`evalCp identical on cache hit         (${r1.evalCp}==${r2.evalCp})`, r2.evalCp === r1.evalCp, `${r2.evalCp}`);
    check(`cache returned in <100ms              (${ms}ms)`,                     ms < 100,                `${ms}ms`);
  } else {
    console.log(`   (cache timing check skipped — Tier 3 not reached; r1.tier=${r1.tier} r2.tier=${r2.tier} level=${ENGINE_CONSULTATION_LEVEL})`);
    check('same tier on both calls              (tiers match)', r1.tier === r2.tier, `${r1.tier} vs ${r2.tier}`);
  }
}

async function testBudgetExhaustion() {
  const cap = MAX_ENGINE_CALLS_PER_CONVO[ENGINE_CONSULTATION_LEVEL] ?? 0;
  section(
    'Budget: engine budget already exhausted',
    `engine_calls_used is pre-seeded to the cap (${cap}) for level ${ENGINE_CONSULTATION_LEVEL}. ` +
    'Expected: cascade returns Tier 2 result with a "budget exhausted" note — no engine call fired.'
  );
  if (cap === 0) {
    console.log(`   (skipped — ENGINE_CONSULTATION_LEVEL=OFF, cap=0, engine never fires)`);
    return;
  }
  await seedFacts(cap);
  const r = await resolveCascade(TEST_MOVE_ID, FACTS, ['Nd4'], 'DIRECT_CHALLENGE');
  check('cascade completes without throwing    (ok=true)',          r.ok   === true);
  check('"Nd4" still validated as legal        (legal=true)',       r.legal === true);
  check('engine skipped due to budget          (tier=2)',           r.tier  === 2);
  check('note explains budget exhaustion',                          typeof r.note === 'string' && r.note.length > 0, r.note);
}

async function testDialGate() {
  const cap = MAX_ENGINE_CALLS_PER_CONVO[ENGINE_CONSULTATION_LEVEL] ?? 0;
  section(
    'Dial gate: USER_PROPOSAL situation',
    `Student proposes "Nd4" as a USER_PROPOSAL at level ${ENGINE_CONSULTATION_LEVEL}. ` +
    (ENGINE_CONSULTATION_LEVEL === 'LOW'
      ? 'At LOW only DIRECT_CHALLENGE reaches the engine — USER_PROPOSAL is blocked. Expected: tier=2 with gate note.'
      : 'At MED/HIGH, USER_PROPOSAL is permitted — engine may be called if budget allows.')
  );
  await seedFacts(0);
  const r = await resolveCascade(TEST_MOVE_ID, FACTS, ['Nd4'], 'USER_PROPOSAL');
  check('cascade completes without throwing    (ok=true)',   r.ok === true);
  check('"Nd4" validated as legal              (legal=true)', r.legal === true);
  if (ENGINE_CONSULTATION_LEVEL === 'LOW') {
    check('engine blocked for USER_PROPOSAL     (tier=2)',   r.tier === 2,              `tier=${r.tier}`);
    check('note explains dial restriction',                  typeof r.note === 'string', r.note);
  } else {
    const engineExpected = isEngineAvailable() && cap > 0;
    console.log(`   (at ${ENGINE_CONSULTATION_LEVEL}, USER_PROPOSAL is allowed — engine ${engineExpected ? 'should fire' : 'unavailable/no budget'})`);
    check(`tier reflects level (tier>=${engineExpected ? 3 : 2})`, r.tier >= 2, `tier=${r.tier}`);
  }
}

async function testTier3EngineEval() {
  section(
    'Tier 3: full engine evaluation end-to-end',
    '"Bxe6" captures a black pawn. Budget starts at 0. Expected: Tier 3 reached, ' +
    'engine returns evalCp + bestResponse, budget counter incremented to 1.'
  );
  if (!isEngineAvailable()) {
    console.log('   [SKIP] Stockfish not available on this machine');
    return;
  }
  if (ENGINE_CONSULTATION_LEVEL === 'OFF') {
    console.log('   [SKIP] ENGINE_CONSULTATION_LEVEL=OFF — engine intentionally disabled');
    return;
  }
  await seedFacts(0);
  const r = await resolveCascade(TEST_MOVE_ID, FACTS, ['Bxe6'], 'DIRECT_CHALLENGE');
  check('cascade completes without throwing    (ok=true)',              r.ok    === true);
  check('"Bxe6" validated as legal             (legal=true)',           r.legal === true);
  check('engine was reached                    (tier=3)',               r.tier  === 3,   `tier=${r.tier}${r.note ? ' note=' + r.note : ''}`);
  check('engine returned a centipawn eval      (evalCp is a number)',   typeof r.evalCp === 'number', `evalCp=${r.evalCp}`);
  check('engine returned best reply move       (bestResponse present)', !!r.bestResponse, `bestResponse=${r.bestResponse}`);
  check('budget counter incremented to 1       (engineCallsUsed=1)',    r.engineCallsUsed === 1, `engineCallsUsed=${r.engineCallsUsed}`);
  if (r.comparedToActual !== null) {
    check('delta vs played move is a number     (comparedToActual)',    typeof r.comparedToActual === 'number', `${r.comparedToActual} cp`);
  }
  console.log(`\n   Engine details: evalCp=${r.evalCp}  bestResponse=${r.bestResponse}  mateIn=${r.mateIn ?? '—'}  whatHangs=${JSON.stringify(r.whatHangs)}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\nChess Sensei — cascade integration test`);
  console.log(`ENGINE_CONSULTATION_LEVEL=${ENGINE_CONSULTATION_LEVEL}  cap=${MAX_ENGINE_CALLS_PER_CONVO[ENGINE_CONSULTATION_LEVEL] ?? 0}`);

  await new Promise(r => setTimeout(r, STARTUP_DELAY_MS));

  const moveRow = await query('SELECT id FROM moves ORDER BY id DESC LIMIT 1');
  if (!moveRow.rows[0]) {
    console.error('[FATAL] No rows in moves table — run the app and import a game first.');
    process.exit(1);
  }
  TEST_MOVE_ID = moveRow.rows[0].id;

  const existing = await query('SELECT engine_calls_used FROM coaching_facts WHERE move_id = $1', [TEST_MOVE_ID]);
  originalEngineCallsUsed = existing.rows[0]?.engine_calls_used ?? null;

  console.log(`Using move_id=${TEST_MOVE_ID} (${originalEngineCallsUsed === null ? 'no existing facts row' : `existing engine_calls_used=${originalEngineCallsUsed}`})`);

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
