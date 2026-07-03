import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { api } from '../api.js';
import { getStockfish, evaluatePositionFull } from '../stockfish.js';

const MAX_EXPLORE_PLIES = 6;

export default function Coaching() {
  const { id, moveId } = useParams();

  const [moveContext, setMoveContext] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendingLine, setSendingLine] = useState(false);
  const [error, setError] = useState('');

  // Change 4: first-coaching-session hint, dismissed via localStorage.
  const [hintDismissed, setHintDismissed] = useState(
    () => localStorage.getItem('seenCoachingHint') === 'true'
  );

  function dismissHint() {
    localStorage.setItem('seenCoachingHint', 'true');
    setHintDismissed(true);
  }

  // ── Sequence composer state ────────────────────────────────────────────────
  // composedFen tracks the board position as the user builds a line.
  // Initialized from moveContext.fen when context loads; reset clears it back.
  const [composedFen, setComposedFen] = useState(null);
  const [composedMoves, setComposedMoves] = useState([]); // { san, from, to }
  // chessRef holds the live Chess instance that validates moves against the
  // current composed position (not the original).
  const chessRef = useRef(null);

  // Re-initialize the composer whenever the flagged move changes.
  useEffect(() => {
    if (moveContext?.fen) {
      chessRef.current = new Chess(moveContext.fen);
      setComposedFen(moveContext.fen);
      setComposedMoves([]);
    }
  }, [moveContext?.fen]);

  function handlePieceDrop({ piece, sourceSquare, targetSquare }) {
    if (!chessRef.current || !targetSquare) return false;
    if (composedMoves.length >= MAX_EXPLORE_PLIES) return false;

    // Detect pawn promotion: white pawn reaching rank 8, black pawn rank 1.
    const isPromotion =
      piece.pieceType === 'wP' && targetSquare[1] === '8' ||
      piece.pieceType === 'bP' && targetSquare[1] === '1';

    const result = chessRef.current.move({
      from: sourceSquare,
      to: targetSquare,
      promotion: isPromotion ? 'q' : undefined,
    });

    if (!result) return false; // illegal — snap back

    setComposedFen(chessRef.current.fen());
    setComposedMoves((prev) => [
      ...prev,
      { san: result.san, from: sourceSquare, to: targetSquare },
    ]);
    return true;
  }

  function handleUndo() {
    if (!composedMoves.length || !moveContext?.fen) return;
    const newMoves = composedMoves.slice(0, -1);
    // Replay from the origin FEN so chessRef stays in sync.
    const chess = new Chess(moveContext.fen);
    newMoves.forEach((m) => chess.move(m.san));
    chessRef.current = chess;
    setComposedMoves(newMoves);
    setComposedFen(chess.fen());
  }

  function handleReset() {
    if (!moveContext?.fen) return;
    chessRef.current = new Chess(moveContext.fen);
    setComposedMoves([]);
    setComposedFen(moveContext.fen);
  }

  async function handleSendLine() {
    if (!moveContext?.fen || composedMoves.length === 0 || sendingLine) return;
    setSendingLine(true);
    setError('');

    try {
      // Replay all composed moves from the start FEN to reach the terminal position.
      const chess = new Chess(moveContext.fen);
      for (const m of composedMoves) {
        chess.move(m.san);
      }
      const terminalFen = chess.fen();

      // Evaluate ONLY the terminal position — never per-move.
      const worker = await getStockfish();
      const { cp, bestMove: bestMoveUci } = await evaluatePositionFull(worker, terminalFen);

      // Convert engine's best-move from UCI to SAN for readability.
      let bestMoveSan = null;
      if (bestMoveUci) {
        try {
          const evalChess = new Chess(terminalFen);
          const result = evalChess.move({
            from: bestMoveUci.slice(0, 2),
            to: bestMoveUci.slice(2, 4),
            promotion: bestMoveUci.length === 5 ? bestMoveUci[4] : undefined,
          });
          bestMoveSan = result?.san ?? null;
        } catch (_) {}
      }

      console.log('[Composer] terminal FEN:', terminalFen);
      console.log('[Composer] eval (white POV cp):', cp, '| best move in terminal position:', bestMoveSan ?? bestMoveUci ?? 'none');
      console.log('[Composer] start FEN:', moveContext.fen, '| line:', composedMoves.map(m => m.san).join(' '));

      // TODO Step 2: compute intent signals and send to coach.
    } catch (err) {
      console.error('[Composer] evaluation error:', err);
      setError('Engine evaluation failed — try again.');
    } finally {
      setSendingLine(false);
    }
  }

  const logRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [gameRes, convRes] = await Promise.all([
          api.get(`/games/${id}`),
          api.get(`/coach/conversation/${moveId}`),
        ]);
        if (cancelled) return;

        const move = (gameRes.data.moves || []).find(
          (m) => String(m.id) === String(moveId)
        );
        if (!move) {
          setError('Move not found for this game.');
        } else {
          let fromSquare = null;
          let toSquare = null;
          if (gameRes.data.pgn) {
            try {
              const chess = new Chess();
              chess.loadPgn(gameRes.data.pgn);
              const history = chess.history({ verbose: true });

              const moveNumber = move.move_number;
              const histEntry = history.find(
                (h, i) =>
                  (!moveNumber || Math.floor(i / 2) + 1 === moveNumber) &&
                  h.san === move.move
              );

              if (histEntry) {
                fromSquare = histEntry.from;
                toSquare = histEntry.to;
              } else {
                const replay = new Chess();
                for (const h of history) {
                  replay.move(h.san);
                  if (replay.fen() === move.fen) {
                    fromSquare = h.from;
                    toSquare = h.to;
                    break;
                  }
                }
              }

              console.log(
                '[Coaching] move arrow: from=%s to=%s (san=%s moveNumber=%s method=%s)',
                fromSquare, toSquare, move.move, moveNumber,
                fromSquare ? (histEntry ? 'san' : 'fen') : 'none'
              );
            } catch (err) {
              console.warn('[Coaching] Could not derive move squares from PGN:', err);
            }
          } else {
            console.warn('[Coaching] No PGN available — move arrow disabled');
          }
          setMoveContext({
            move: move.move,
            classification: move.classification,
            fen: move.fen,
            principle_violated: move.principle_violated,
            from: fromSquare,
            to: toSquare,
          });
        }
        setMessages(convRes.data || []);
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.error || err.message || 'Failed to load');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, moveId]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages, sending]);

  async function handleSend(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending || !moveContext) return;

    const optimistic = [
      ...messages,
      { id: `tmp-${Date.now()}`, role: 'user', content: text },
    ];
    setMessages(optimistic);
    setDraft('');
    setSending(true);
    setError('');

    try {
      const { data } = await api.post(`/coach/conversation/${moveId}`, {
        message: text,
        moveContext,
      });

      if (Array.isArray(data)) {
        setMessages(data);
      } else if (data && data.messages && Array.isArray(data.messages)) {
        setMessages(data.messages);
      } else if (data && (data.role === 'assistant' || data.content)) {
        setMessages((prev) => [
          ...prev,
          {
            id: data.id || `srv-${Date.now()}`,
            role: 'assistant',
            content: data.content || data.reply || '',
          },
        ]);
      } else if (data && data.reply) {
        setMessages((prev) => [
          ...prev,
          { id: `srv-${Date.now()}`, role: 'assistant', content: data.reply },
        ]);
      } else {
        const conv = await api.get(`/coach/conversation/${moveId}`);
        setMessages(conv.data || []);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Send failed');
      setMessages(messages);
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  // Use the composed position when the user is exploring a line.
  const boardFen = composedFen ?? moveContext?.fen ?? 'start';

  // Only show the flagged-move arrow/highlights on the original position.
  const isComposing = composedMoves.length > 0;

  const moveArrow = useMemo(() => {
    if (!moveContext?.from || !moveContext?.to) return [];
    return [{ startSquare: moveContext.from, endSquare: moveContext.to, color: '#f0c060' }];
  }, [moveContext]);

  const squareHighlights = useMemo(() => {
    if (!moveContext?.from || !moveContext?.to) return {};
    const tint = { backgroundColor: 'rgba(240, 192, 96, 0.2)' };
    return { [moveContext.from]: tint, [moveContext.to]: tint };
  }, [moveContext]);

  // Format composedMoves into chess-notation tokens: [{ type:'num', text },
  // { type:'move', san }]. Derives starting move number and side from the FEN.
  const composedLineTokens = useMemo(() => {
    if (!composedMoves.length || !moveContext?.fen) return [];
    const parts = moveContext.fen.split(' ');
    let turn = parts[1] || 'w';
    let moveNum = parseInt(parts[5], 10) || 1;
    const tokens = [];
    composedMoves.forEach((m, i) => {
      if (turn === 'w') {
        tokens.push({ type: 'num', text: `${moveNum}.` });
      } else if (i === 0) {
        tokens.push({ type: 'num', text: `${moveNum}...` });
      }
      tokens.push({ type: 'move', san: m.san });
      if (turn === 'b') moveNum++;
      turn = turn === 'w' ? 'b' : 'w';
    });
    return tokens;
  }, [composedMoves, moveContext?.fen]);

  return (
    <>
      <div className="crumb">
        <Link to="/">Dashboard</Link>
        {' / '}
        <Link to={`/game/${id}`}>Game {id}</Link>
        {' / '}
        Coaching
      </div>

      <div className="grid-2">
        <div>
          <div className="panel">
            <h2>Flagged move</h2>
            {loading ? (
              <div className="empty">Loading…</div>
            ) : moveContext ? (
              <>
                <div className="board-wrap" style={{ marginBottom: 16 }}>
                  <div className="board-shell">
                    <Chessboard
                      options={{
                        id: 'coach',
                        position: boardFen,
                        allowDragging: true,
                        allowDrawingArrows: false,
                        boardOrientation: 'white',
                        darkSquareStyle: { backgroundColor: '#3a3a40' },
                        lightSquareStyle: { backgroundColor: '#b6b6bd' },
                        // Hide flagged-move annotations while exploring a line.
                        arrows: isComposing ? [] : moveArrow,
                        squareStyles: isComposing ? {} : squareHighlights,
                        onPieceDrop: handlePieceDrop,
                      }}
                    />
                  </div>
                </div>
                <dl className="move-context">
                  <dt>Move</dt>
                  <dd>{moveContext.move}</dd>
                  <dt>Classification</dt>
                  <dd>
                    <span className={`tag ${moveContext.classification}`}>
                      {moveContext.classification}
                    </span>
                  </dd>
                  {/* Change 3: only show Principle row when a principle is known */}
                  {moveContext.principle_violated && (
                    <>
                      <dt>Principle</dt>
                      <dd>{moveContext.principle_violated}</dd>
                    </>
                  )}
                </dl>

                {/* ── Sequence composer ──────────────────────────── */}
                <div style={{
                  marginTop: 14,
                  paddingTop: 14,
                  borderTop: '1px solid var(--border)',
                }}>
                  <div style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--text-dim)',
                    marginBottom: 8,
                  }}>
                    Explored line
                  </div>
                  {composedMoves.length === 0 ? (
                    <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13 }}>
                      Drag pieces to explore a line.
                    </p>
                  ) : (
                    <>
                      <div style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '2px 6px',
                        alignItems: 'baseline',
                        fontFamily: "'Courier New', monospace",
                        fontSize: 14,
                        lineHeight: 1.8,
                      }}>
                        {composedLineTokens.map((tok, i) =>
                          tok.type === 'num' ? (
                            <span key={i} style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                              {tok.text}
                            </span>
                          ) : (
                            <span key={i} style={{ color: 'var(--text)' }}>
                              {tok.san}
                            </span>
                          )
                        )}
                      </div>
                      {composedMoves.length >= MAX_EXPLORE_PLIES && (
                        <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text-dim)' }}>
                          Max line length reached
                        </p>
                      )}
                    </>
                  )}
                  <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginTop: 12,
                  }}>
                    <button
                      onClick={handleUndo}
                      disabled={composedMoves.length === 0}
                    >
                      Undo
                    </button>
                    <button
                      onClick={handleReset}
                      disabled={composedMoves.length === 0}
                    >
                      Reset
                    </button>
                    <button
                      className="primary"
                      onClick={handleSendLine}
                      disabled={composedMoves.length === 0 || sendingLine}
                    >
                      {sendingLine ? 'Evaluating…' : 'Send line to coach'}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty">No move context.</div>
            )}
          </div>
        </div>

        <div>
          <div className="chat">
            {/* Change 4: first-session Socratic hint, dismissible */}
            {!hintDismissed && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--border)',
                  background: 'rgba(240, 192, 96, 0.04)',
                  fontSize: 12,
                  color: 'var(--text-dim)',
                  lineHeight: 1.55,
                  flexShrink: 0,
                }}
              >
                <span>
                  This coach asks before it tells — share what you were
                  thinking and it'll guide you from there.
                </span>
                <button
                  onClick={dismissHint}
                  aria-label="Dismiss hint"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-dim)',
                    padding: '0 2px',
                    fontSize: 16,
                    lineHeight: 1,
                    cursor: 'pointer',
                    flexShrink: 0,
                    minWidth: 20,
                    opacity: 0.7,
                  }}
                >
                  ×
                </button>
              </div>
            )}

            <div className="chat-log" ref={logRef}>
              {loading ? (
                <div className="muted">Loading conversation…</div>
              ) : messages.length === 0 ? (
                <div className="muted">
                  Start by telling the coach what you were thinking on this move.
                </div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`chat-msg ${m.role}`}>
                    <span className="role">{m.role}</span>
                    {m.content}
                  </div>
                ))
              )}
              {sending && <div className="typing">Coach is thinking…</div>}
            </div>

            <form className="chat-form" onSubmit={handleSend}>
              <textarea
                placeholder="What were you thinking on this move?"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend(e);
                  }
                }}
                disabled={sending || loading || !moveContext}
              />
              <button
                type="submit"
                className="primary"
                disabled={sending || loading || !moveContext || !draft.trim()}
              >
                Send
              </button>
            </form>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </>
  );
}
