import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { api } from '../api.js';
import { getStockfish, evaluatePosition, classifyLoss } from '../stockfish.js';

const ANALYSIS_DEPTH = 12;

// Build the list of positions visited during the PGN.
// Returns { positions: [{ fen, sideToMove }], moves: [{ san, fenAfter, ply, color }] }
function parsePgn(pgn) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const history = chess.history({ verbose: true });

  const replay = new Chess();
  const positions = [{ fen: replay.fen(), sideToMove: replay.turn() }];
  const moves = [];

  history.forEach((m, idx) => {
    replay.move({ from: m.from, to: m.to, promotion: m.promotion });
    const fenAfter = replay.fen();
    positions.push({ fen: fenAfter, sideToMove: replay.turn() });
    moves.push({
      san: m.san,
      fenAfter,
      ply: idx + 1,
      color: m.color, // 'w' or 'b'
      moveNumber: Math.floor(idx / 2) + 1,
    });
  });

  return { positions, moves };
}

export default function GameReview() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [game, setGame] = useState(null);
  const [moves, setMoves] = useState([]); // moves persisted server-side
  const [parseError, setParseError] = useState('');
  const [boardPly, setBoardPly] = useState(0); // 0 = starting position
  const [positions, setPositions] = useState([]); // [{ fen, sideToMove }]
  const [parsedMoves, setParsedMoves] = useState([]);

  const [analysisStatus, setAnalysisStatus] = useState('idle'); // idle | running | done | error
  const [analysisProgress, setAnalysisProgress] = useState(0); // 0..1
  const [analysisMessage, setAnalysisMessage] = useState('');

  const startedRef = useRef(false);

  // Fetch the game once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/games/${id}`);
        if (cancelled) return;
        setGame(data);
        setMoves(data.moves || []);
        try {
          const parsed = parsePgn(data.pgn);
          setPositions(parsed.positions);
          setParsedMoves(parsed.moves);
        } catch (err) {
          setParseError('Could not parse PGN: ' + err.message);
        }
      } catch (err) {
        setParseError(err.message || 'Failed to load game');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Trigger analysis once game + parsed PGN are loaded and nothing is persisted yet.
  useEffect(() => {
    if (startedRef.current) return;
    if (!game || parsedMoves.length === 0 || moves.length > 0) return;
    startedRef.current = true;

    let cancelled = false;

    (async () => {
      setAnalysisStatus('running');
      setAnalysisMessage('Loading Stockfish…');
      let worker;
      try {
        worker = await getStockfish();
      } catch (err) {
        if (!cancelled) {
          setAnalysisStatus('error');
          setAnalysisMessage('Stockfish failed to load: ' + err.message);
        }
        return;
      }
      if (cancelled) return;

      const evals = new Array(positions.length); // white-POV cp
      setAnalysisMessage('Analysing positions…');

      for (let i = 0; i < positions.length; i++) {
        try {
          evals[i] = await evaluatePosition(
            worker,
            positions[i].fen,
            ANALYSIS_DEPTH
          );
        } catch (err) {
          if (!cancelled) {
            setAnalysisStatus('error');
            setAnalysisMessage('Engine error: ' + err.message);
          }
          return;
        }
        if (cancelled) return;
        setAnalysisProgress((i + 1) / positions.length);
      }

      // Only flag moves played by the user's own colour. When user_color is
      // known, opponent mistakes are silently skipped so the coach never
      // reviews a move the user didn't play. When user_color is NULL (legacy
      // uploads where we couldn't determine colour), we retain all flagged
      // moves as before rather than silently discarding everything.
      const userColorChar =
        game.user_color === 'white' ? 'w'
        : game.user_color === 'black' ? 'b'
        : null;

      const analysed = parsedMoves
        .map((m, idx) => {
          const before = evals[idx];
          const after = evals[idx + 1];
          const rawLoss = m.color === 'w' ? before - after : after - before;
          const cpLoss = Math.max(0, rawLoss);
          return {
            move_number: m.moveNumber,
            move: m.san,
            fen: m.fenAfter,
            color: m.color,
            classification: classifyLoss(cpLoss),
            principle_violated: null,
            centipawn_loss: Math.round(cpLoss),
          };
        })
        // Only save moves the user actually played. When user_color is NULL
        // (legacy games where colour wasn't recorded) keep everything.
        .filter((m) => userColorChar === null || m.color === userColorChar)
        .map((m) => ({
          move_number: m.move_number,
          move: m.move,
          fen: m.fen,
          classification: m.classification,
          principle_violated: m.principle_violated,
          centipawn_loss: m.centipawn_loss,
        }));

      setAnalysisMessage('Saving analysis…');
      try {
        await api.post(`/games/${id}/moves`, { moves: analysed });
        if (cancelled) return;
        // The server returns { saved: N }, not the move rows. Use the
        // locally-computed array directly — we just persisted exactly this.
        setMoves(analysed);
      } catch (err) {
        if (!cancelled) {
          setAnalysisStatus('error');
          setAnalysisMessage('Save failed: ' + err.message);
        }
        return;
      }

      if (!cancelled) {
        setAnalysisStatus('done');
        setAnalysisMessage('');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [game, parsedMoves, moves, positions, id]);

  const flagged = useMemo(
    () =>
      moves.filter(
        (m) => m.classification === 'blunder' || m.classification === 'mistake'
      ),
    [moves]
  );

  const totalPlies = positions.length > 0 ? positions.length - 1 : 0;
  const currentFen = positions[boardPly]?.fen;
  const currentMove = boardPly > 0 ? parsedMoves[boardPly - 1] : null;

  if (parseError) {
    return (
      <>
        <div className="crumb">
          <Link to="/">← Dashboard</Link>
        </div>
        <div className="panel">
          <div className="error">{parseError}</div>
        </div>
      </>
    );
  }

  if (!game) {
    return (
      <>
        <div className="crumb">
          <Link to="/">← Dashboard</Link>
        </div>
        <div className="panel">
          <div className="empty">Loading game…</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="crumb">
        <Link to="/">← Dashboard</Link>
        {' / '}
        Game {game.id} · vs {game.opponent || 'Unknown'} · {game.result}
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Board</h2>
          <div className="board-wrap">
            <div className="board-shell">
              <Chessboard
                options={{
                  id: 'review',
                  position: currentFen || 'start',
                  allowDragging: false,
                  boardOrientation: 'white',
                  showAnimations: true,
                  animationDurationInMs: 150,
                  darkSquareStyle: { backgroundColor: '#3a3a40' },
                  lightSquareStyle: { backgroundColor: '#b6b6bd' },
                }}
              />
            </div>
          </div>

          <div className="move-controls">
            <button onClick={() => setBoardPly(0)} disabled={boardPly === 0}>
              ⏮
            </button>
            <button
              onClick={() => setBoardPly((p) => Math.max(0, p - 1))}
              disabled={boardPly === 0}
            >
              ←
            </button>
            <span className="muted" style={{ minWidth: 120, textAlign: 'center' }}>
              {boardPly === 0
                ? 'Start'
                : `Move ${currentMove.moveNumber}${currentMove.color === 'w' ? '.' : '...'} ${currentMove.san}`}
            </span>
            <button
              onClick={() => setBoardPly((p) => Math.min(totalPlies, p + 1))}
              disabled={boardPly === totalPlies}
            >
              →
            </button>
            <button
              onClick={() => setBoardPly(totalPlies)}
              disabled={boardPly === totalPlies}
            >
              ⏭
            </button>
          </div>

          {analysisStatus === 'running' && (
            <div className="analysis-status">
              {analysisMessage}
              <span className="bar">
                <span
                  style={{ width: `${Math.round(analysisProgress * 100)}%` }}
                />
              </span>
              {' '}
              {Math.round(analysisProgress * 100)}%
            </div>
          )}
          {analysisStatus === 'error' && (
            <div className="error">{analysisMessage}</div>
          )}
        </div>

        <div className="panel">
          <h2>Flagged moves</h2>
          {moves.length === 0 ? (
            <div className="empty">
              {analysisStatus === 'running'
                ? 'Stockfish is reviewing the game…'
                : 'No analysis yet.'}
            </div>
          ) : flagged.length === 0 ? (
            <div className="empty">No blunders or mistakes. Solid game.</div>
          ) : (
            <div className="flagged-list">
              {flagged.map((m) => (
                <div
                  key={m.id}
                  className="flagged-row"
                  onClick={() => navigate(`/game/${id}/move/${m.id}`)}
                >
                  <span className="move-no">{m.move_number}.</span>
                  <div>
                    <div>{m.move}</div>
                    {m.principle_violated && (
                      <div className="principle">{m.principle_violated}</div>
                    )}
                  </div>
                  <span className={`tag ${m.classification}`}>
                    {m.classification}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}