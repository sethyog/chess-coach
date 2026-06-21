'use strict';

// Long-lived native Stockfish process over UCI.
// ONE process is shared across all requests; concurrent calls are queued.
// Set STOCKFISH_PATH env var to override the binary location.

const { spawn } = require('child_process');
const { Chess }  = require('chess.js');

// ── Tunable constants ─────────────────────────────────────────────────────────
const ENGINE_DEPTH        = 12;    // search depth (shallow for speed)
const ENGINE_MOVETIME_MS  = 500;   // hard time cap per search (ms)
const ENGINE_TIMEOUT_MS   = 8000;  // overall per-request timeout (ms)
const ENGINE_HASH_MB      = 32;    // hash table size — keep small for Railway
const ENGINE_THREADS      = 1;     // single thread

// ── FEN eval cache (in-process, shared across all requests) ──────────────────
// Keyed by FEN string. Transpositions and re-evaluated positions are free.
const evalCache = new Map();

// ── Process state ─────────────────────────────────────────────────────────────
let proc         = null;
let engineReady  = false;
let engineState  = 'init';   // 'init' | 'idle' | 'searching'
let outputBuffer = '';

// Per-search state reset before each search.
let lastCp          = 0;
let lastBestMoveUci = null;
let lastMateIn      = null;

// Current in-flight request.
let current = null;  // { fen, resolve, reject, timeoutHandle }

// Pending queue.
const queue = [];

// ── UCI helpers ───────────────────────────────────────────────────────────────

function send(cmd) {
  if (proc?.stdin?.writable) proc.stdin.write(cmd + '\n');
}

function handleLine(line) {
  if (!line) return;

  if (engineState === 'init') {
    if (line === 'readyok') {
      engineState = 'idle';
      engineReady = true;
      console.log('[engine] Stockfish ready');
      drainQueue();
    }
    return;
  }

  if (engineState === 'searching') {
    // Accumulate eval from info lines.
    if (line.startsWith('info') && line.includes(' score ')) {
      const mateMatch = line.match(/ score mate (-?\d+)/);
      const cpMatch   = line.match(/ score cp (-?\d+)/);

      if (mateMatch) {
        const m = parseInt(mateMatch[1], 10);
        // Positive mate = side to move wins; normalize sign but preserve magnitude.
        lastCp     = m > 0 ? 100000 : -100000;
        lastMateIn = Math.abs(m);
      } else if (cpMatch) {
        lastCp     = parseInt(cpMatch[1], 10);
        lastMateIn = null;
      }

      // Best move from the PV (first move of the principal variation).
      const pvMatch = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
      if (pvMatch) lastBestMoveUci = pvMatch[1];
    }

    if (line.startsWith('bestmove')) {
      const uci = line.split(' ')[1];
      if (uci && uci !== '(none)' && !lastBestMoveUci) lastBestMoveUci = uci;

      clearTimeout(current.timeoutHandle);
      engineState = 'idle';

      const result  = { ok: true, evalCp: lastCp, bestMoveUci: lastBestMoveUci, mateIn: lastMateIn };
      const resolve = current.resolve;
      current = null;
      resolve(result);

      drainQueue();
    }
  }
}

function drainQueue() {
  if (!engineReady || engineState !== 'idle' || queue.length === 0) return;

  const next = queue.shift();
  current = next;
  engineState = 'searching';

  // Reset per-search state.
  lastCp          = 0;
  lastBestMoveUci = null;
  lastMateIn      = null;

  current.timeoutHandle = setTimeout(() => {
    console.error('[engine] search timeout for FEN:', current.fen.slice(0, 50));
    send('stop');
    // Give Stockfish 1 s to emit bestmove after stop; if it doesn't, fail hard.
    setTimeout(() => {
      if (!current) return;
      engineState = 'idle';
      const reject = current.reject;
      current = null;
      reject(new Error('Engine search timed out'));
      drainQueue();
    }, 1000);
  }, ENGINE_TIMEOUT_MS);

  send('ucinewgame');
  send(`position fen ${current.fen}`);
  send(`go depth ${ENGINE_DEPTH} movetime ${ENGINE_MOVETIME_MS}`);
}

// ── Process lifecycle ─────────────────────────────────────────────────────────

function startEngine() {
  const enginePath = process.env.STOCKFISH_PATH || 'stockfish';

  try {
    proc = spawn(enginePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    console.error('[engine] Failed to spawn Stockfish (is it installed?):', err.message);
    console.error('[engine] Mac: brew install stockfish  |  Linux: apt-get install stockfish');
    return;
  }

  proc.stdout.on('data', (chunk) => {
    outputBuffer += chunk.toString();
    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop();
    for (const line of lines) handleLine(line.trim());
  });

  proc.stderr.on('data', (chunk) => {
    console.error('[engine] stderr:', chunk.toString().trim());
  });

  proc.on('close', (code) => {
    console.error(`[engine] process exited (code ${code})`);
    proc        = null;
    engineReady = false;
    engineState = 'init';

    if (current) {
      clearTimeout(current.timeoutHandle);
      current.reject(new Error('Engine process exited'));
      current = null;
    }
    // Drain remaining queue with failure.
    while (queue.length) queue.shift().reject(new Error('Engine unavailable'));

    // Restart after a short back-off.
    setTimeout(startEngine, 5000);
  });

  proc.on('error', (err) => {
    console.error('[engine] spawn error:', err.message);
    engineReady = false;
  });

  // UCI handshake.
  send('uci');
  send(`setoption name Hash value ${ENGINE_HASH_MB}`);
  send(`setoption name Threads value ${ENGINE_THREADS}`);
  send('isready');

  console.log(`[engine] spawned Stockfish (path: ${enginePath}, depth: ${ENGINE_DEPTH}, movetime: ${ENGINE_MOVETIME_MS}ms)`);
}

// ── SAN conversion ────────────────────────────────────────────────────────────
// Stockfish returns moves in UCI format (e.g. 'e2e4', 'a7a8q').
// Convert to SAN using chess.js so the coach can quote it naturally.
function uciToSan(fen, uciMove) {
  if (!uciMove) return null;
  try {
    const chess = new Chess(fen);
    const move  = chess.move({
      from:      uciMove.slice(0, 2),
      to:        uciMove.slice(2, 4),
      promotion: uciMove.length === 5 ? uciMove[4] : undefined,
    });
    return move ? move.san : uciMove;
  } catch {
    return uciMove;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Evaluate a FEN position. Returns:
 *   { ok: true,  evalCp, bestMove (SAN), bestMoveUci, mateIn }
 *   { ok: false, error }
 *
 * evalCp is from the side-to-move's perspective (positive = good for them).
 * Cache hit returns immediately with no engine call.
 */
async function evaluateFen(fen) {
  if (evalCache.has(fen)) {
    return evalCache.get(fen);
  }

  if (!engineReady || !proc) {
    return { ok: false, error: 'Engine not available' };
  }

  let raw;
  try {
    raw = await new Promise((resolve, reject) => {
      queue.push({ fen, resolve, reject, timeoutHandle: null });
      drainQueue();
    });
  } catch (err) {
    console.error('[engine] evaluateFen error:', err.message);
    return { ok: false, error: err.message };
  }

  const result = {
    ok:          true,
    evalCp:      raw.evalCp,
    bestMove:    uciToSan(fen, raw.bestMoveUci),
    bestMoveUci: raw.bestMoveUci,
    mateIn:      raw.mateIn,
  };

  evalCache.set(fen, result);
  return result;
}

function isEngineAvailable() {
  return engineReady && proc !== null;
}

function getEvalCacheSize() {
  return evalCache.size;
}

// ── Start on module load ──────────────────────────────────────────────────────
startEngine();

module.exports = {
  evaluateFen,
  isEngineAvailable,
  getEvalCacheSize,
  // Constants exposed for logging / test harness.
  ENGINE_DEPTH,
  ENGINE_MOVETIME_MS,
};
