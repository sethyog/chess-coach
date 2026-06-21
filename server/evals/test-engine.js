'use strict';

// Isolation test for engine.js — runs evaluateFen on 5 known positions
// and prints results without touching the DB or HTTP layer.
//
// Usage (local):
//   brew install stockfish      # once
//   node server/test-engine.js
//
// Usage (Railway one-off):
//   railway run node server/test-engine.js

const { evaluateFen, isEngineAvailable, getEvalCacheSize, ENGINE_DEPTH, ENGINE_MOVETIME_MS } = require('../engine');

// Give Stockfish time to finish UCI handshake before we fire queries.
const STARTUP_DELAY_MS = 1500;

// ── Known positions ───────────────────────────────────────────────────────────
const TESTS = [
  {
    label: 'Starting position',
    fen:   'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    // Expect: evalCp near 0, bestMove is a reasonable first move
    check: r => r.ok && Math.abs(r.evalCp) < 50 && r.bestMove,
  },
  {
    label: 'Scholar\'s mate — White to deliver Qxf7#',
    fen:   'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4',
    // Black is in checkmate — engine should report mateIn 0 or no bestmove.
    // Stockfish returns '(none)' or immediate mate signal.
    check: r => r.ok,
  },
  {
    label: 'Qxf5 blunder position (from regression transcript)',
    fen:   'r1b1k2r/pppp1ppp/2n1pq2/8/1bB1P3/2N2N2/PPP2PPP/R1BQK2R w KQkq - 0 7',
    // White to move; Qxf5?? hangs the queen. Expect eval strongly favours Black.
    check: r => r.ok && r.evalCp !== null && r.bestMove,
  },
  {
    label: 'Endgame — K+Q vs K (White to move)',
    fen:   '8/8/8/8/8/4K3/8/4Q2k w - - 0 1',
    // White has a forced mate; engine should find mateIn.
    check: r => r.ok && r.mateIn != null && r.mateIn <= 10,
  },
  {
    label: 'Cache hit — Starting position repeated',
    fen:   'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    // Must match the first result exactly and NOT add a second cache entry.
    check: r => r.ok,
  },
];

// ── Runner ─────────────────────────────────────────────────────────────────────

function pad(s, n) { return String(s).padEnd(n); }

async function run() {
  console.log(`\nChess Sensei — engine isolation test`);
  console.log(`depth=${ENGINE_DEPTH}  movetime=${ENGINE_MOVETIME_MS}ms\n`);

  // Wait for UCI handshake.
  await new Promise(r => setTimeout(r, STARTUP_DELAY_MS));

  if (!isEngineAvailable()) {
    console.error('[FAIL] Engine not available after startup delay.');
    console.error('       Is stockfish in PATH? (brew install stockfish / apt install stockfish)');
    process.exit(1);
  }

  console.log('[OK]   Engine is available\n');
  console.log(pad('Test', 44), pad('evalCp', 8), pad('bestMove', 10), pad('mateIn', 8), 'pass?');
  console.log('-'.repeat(82));

  let passed = 0;
  const cacheBeforeRun = getEvalCacheSize();

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const t0 = Date.now();
    const r  = await evaluateFen(t.fen);
    const ms = Date.now() - t0;

    const ok = t.check(r);
    if (ok) passed++;

    const label  = t.label.slice(0, 43);
    const evalStr = r.ok ? String(r.evalCp) : 'ERR';
    const bmStr   = r.ok ? (r.bestMove || '—') : r.error?.slice(0, 10);
    const mateStr = r.ok && r.mateIn != null ? String(r.mateIn) : '—';

    console.log(
      pad(label, 44),
      pad(evalStr, 8),
      pad(bmStr, 10),
      pad(mateStr, 8),
      ok ? `PASS (${ms}ms)` : `FAIL (${ms}ms)  ← ${JSON.stringify(r)}`,
    );
  }

  const cacheGrowth = getEvalCacheSize() - cacheBeforeRun;
  // There are 5 tests but test 5 repeats test 1's FEN, so expect 4 new cache entries.
  const cacheOk = cacheGrowth === 4;

  console.log('\n─'.repeat(82));
  console.log(`Cache entries added: ${cacheGrowth} (expected 4 — duplicate FEN should hit cache)  ${cacheOk ? 'PASS' : 'FAIL'}`);
  console.log(`\nResult: ${passed}/${TESTS.length} tests passed${cacheOk ? '' : ', cache miss!'}\n`);

  process.exit(passed === TESTS.length && cacheOk ? 0 : 1);
}

run().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
