// Loads Stockfish 18 (single-threaded lite WASM build) as a Web Worker.
// The .js and .wasm files are vendored into /public/stockfish/ so that
// Stockfish's loader finds the .wasm at the expected sibling URL.
const STOCKFISH_URL = '/stockfish/stockfish-18-lite-single.js';

let workerPromise = null;

export function getStockfish() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = new Worker(STOCKFISH_URL);
      await sendAndWait(worker, 'uci', (line) => line === 'uciok');
      await sendAndWait(worker, 'isready', (line) => line === 'readyok');
      return worker;
    })();
  }
  return workerPromise;
}

function sendAndWait(worker, cmd, predicate) {
  return new Promise((resolve) => {
    function onMessage(e) {
      const line = String(e.data ?? '').trim();
      if (predicate(line)) {
        worker.removeEventListener('message', onMessage);
        resolve();
      }
    }
    worker.addEventListener('message', onMessage);
    worker.postMessage(cmd);
  });
}

// Evaluate a position at fixed depth. Returns centipawn score from white's POV.
export function evaluatePosition(worker, fen, depth = 12) {
  return new Promise((resolve) => {
    let lastCp = 0;
    let whiteToMove = fen.split(' ')[1] === 'w';

    function onMessage(e) {
      const line = String(e.data ?? '');

      if (line.startsWith('info ') && line.includes(' score ')) {
        const mate = line.match(/ score mate (-?\d+)/);
        const cp = line.match(/ score cp (-?\d+)/);

        let stmScore;
        if (mate) {
          const m = parseInt(mate[1], 10);
          // Cap mate scores so arithmetic stays sane.
          stmScore = m > 0 ? 10000 - m : -10000 - m;
        } else if (cp) {
          stmScore = parseInt(cp[1], 10);
        } else {
          return;
        }

        // Stockfish returns score from side-to-move's POV. Normalize to white's.
        lastCp = whiteToMove ? stmScore : -stmScore;
      } else if (line.startsWith('bestmove')) {
        worker.removeEventListener('message', onMessage);
        resolve(lastCp);
      }
    }

    worker.addEventListener('message', onMessage);
    worker.postMessage('ucinewgame');
    worker.postMessage('position fen ' + fen);
    worker.postMessage('go depth ' + depth);
  });
}

export function classifyLoss(cpLoss) {
  if (cpLoss > 200) return 'blunder';
  if (cpLoss >= 100) return 'mistake';
  if (cpLoss >= 50) return 'inaccuracy';
  return 'good';
}