import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { api } from '../api.js';
import { getStockfish, evaluatePositionFull } from '../stockfish.js';

const MAX_EXPLORE_PLIES = 6;
const DEMO_MOVE_DELAY_MS = 700;
const DEMO_START_DELAY_MS = 500;
const DEMO_BETWEEN_DELAY_MS = 800;

export default function Coaching() {
  const { id, moveId } = useParams();

  const [moveContext, setMoveContext] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendingLine, setSendingLine] = useState(false);
  const [lineSent, setLineSent] = useState(false);
  const [lineNote, setLineNote] = useState('');
  const [error, setError] = useState('');

  const [showCoachingHint] = useState(() => {
    const seen = localStorage.getItem('seenCoachingHint') === 'true';
    if (!seen) localStorage.setItem('seenCoachingHint', 'true');
    return !seen;
  });

  const [showBoardHint] = useState(() => {
    const seen = localStorage.getItem('hint_seen_board') === 'true';
    if (!seen) localStorage.setItem('hint_seen_board', 'true');
    return !seen;
  });

  // ── Sequence composer state ────────────────────────────────────────────────
  const [composedFen, setComposedFen] = useState(null);
  const [composedMoves, setComposedMoves] = useState([]);
  const chessRef = useRef(null);

  // ── Demo animation state ───────────────────────────────────────────────────
  // demoBoard: FEN string while a demo is active, null otherwise.
  const [demoBoard, setDemoBoard] = useState(null);
  const [demoActive, setDemoActive] = useState(false);
  const demoTimersRef = useRef([]);

  function clearDemoTimers() {
    demoTimersRef.current.forEach(t => clearTimeout(t));
    demoTimersRef.current = [];
  }

  // Animate an array of { from, moves, startFen } demonstrations in order.
  const animateDemos = useCallback((demonstrations) => {
    if (!Array.isArray(demonstrations) || demonstrations.length === 0) return;
    clearDemoTimers();
    setDemoActive(true);

    let delay = DEMO_START_DELAY_MS;
    const timers = [];

    for (const demo of demonstrations) {
      // Set board to the demo's start FEN.
      const t0 = setTimeout(() => setDemoBoard(demo.startFen), delay);
      timers.push(t0);
      delay += DEMO_MOVE_DELAY_MS;

      // Play each move.
      const chess = new Chess(demo.startFen);
      for (const san of demo.moves) {
        try {
          chess.move(san);
          const fen = chess.fen();
          const t = setTimeout(() => setDemoBoard(fen), delay);
          timers.push(t);
          delay += DEMO_MOVE_DELAY_MS;
        } catch {
          console.warn('[demo animation] Failed to play move:', san);
          break;
        }
      }

      delay += DEMO_BETWEEN_DELAY_MS;
    }

    // After all demos, mark done (keep board at last demo position).
    const tEnd = setTimeout(() => setDemoActive(false), delay);
    timers.push(tEnd);
    demoTimersRef.current = timers;
  }, []);

  function handleBackToPosition() {
    clearDemoTimers();
    setDemoBoard(null);
    setDemoActive(false);
  }

  // Cancel any demo when the user starts interacting with the composer.
  function cancelDemoIfActive() {
    if (demoBoard !== null) {
      clearDemoTimers();
      setDemoBoard(null);
      setDemoActive(false);
    }
  }

  // Re-initialize the composer whenever the flagged move changes.
  // Anchor to the BEFORE position so the composer and all demonstrations
  // share a single unambiguous starting point.
  useEffect(() => {
    if (moveContext) {
      const anchor = moveContext.fenBefore ?? moveContext.fen;
      chessRef.current = new Chess(anchor);
      setComposedFen(anchor);
      setComposedMoves([]);
      setLineSent(false);
      setLineNote('');
      handleBackToPosition();
    }
  // moveContext.fen uniquely identifies the move; fenBefore is derived from the same move.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveContext?.fen]);

  // Cleanup timers on unmount.
  useEffect(() => () => clearDemoTimers(), []);

  function handlePieceDrop({ piece, sourceSquare, targetSquare }) {
    if (!chessRef.current || !targetSquare) return false;
    if (composedMoves.length >= MAX_EXPLORE_PLIES) return false;

    cancelDemoIfActive();

    const isPromotion =
      piece.pieceType === 'wP' && targetSquare[1] === '8' ||
      piece.pieceType === 'bP' && targetSquare[1] === '1';

    const result = chessRef.current.move({
      from: sourceSquare,
      to: targetSquare,
      promotion: isPromotion ? 'q' : undefined,
    });

    if (!result) return false;

    setComposedFen(chessRef.current.fen());
    setComposedMoves((prev) => [
      ...prev,
      { san: result.san, from: sourceSquare, to: targetSquare },
    ]);
    setLineSent(false);
    return true;
  }

  function handleUndo() {
    if (!composedMoves.length || !moveContext) return;
    cancelDemoIfActive();
    const anchor = moveContext.fenBefore ?? moveContext.fen;
    const newMoves = composedMoves.slice(0, -1);
    const chess = new Chess(anchor);
    newMoves.forEach((m) => chess.move(m.san));
    chessRef.current = chess;
    setComposedMoves(newMoves);
    setComposedFen(chess.fen());
    setLineSent(false);
  }

  function handleReset() {
    if (!moveContext) return;
    cancelDemoIfActive();
    const anchor = moveContext.fenBefore ?? moveContext.fen;
    chessRef.current = new Chess(anchor);
    setComposedMoves([]);
    setComposedFen(anchor);
    setLineSent(false);
    setLineNote('');
  }

  async function handleSendLine() {
    if (!moveContext || composedMoves.length === 0 || sendingLine) return;
    setSendingLine(true);
    setError('');

    const startFen = moveContext.fenBefore ?? moveContext.fen;
    const noteText = lineNote.trim();

    try {
      // Reach the terminal position from the before-position anchor.
      const chess = new Chess(startFen);
      for (const m of composedMoves) {
        chess.move(m.san);
      }
      const terminalFen = chess.fen();

      // Evaluate the terminal position client-side (engine does truth).
      const worker = await getStockfish();
      const { cp } = await evaluatePositionFull(worker, terminalFen);

      console.log('[Composer] startFen (before):', startFen);
      console.log('[Composer] terminalFen:', terminalFen);
      console.log('[Composer] eval (white POV cp):', cp, '| line:', composedMoves.map(m => m.san).join(' '));

      // Show the submitted line as a user message optimistically.
      const sanLine = composedMoves.map(m => m.san).join(' ');
      const optimisticUserMsg = {
        id: `line-${Date.now()}`,
        role: 'user',
        message_type: 'user_moves',
        content: sanLine,
        move_data: {
          moves: composedMoves, startFen, terminalFen, terminalEvalCp: cp,
          ...(noteText ? { userNote: noteText } : {}),
        },
      };
      setMessages(prev => [...prev, optimisticUserMsg]);

      // Send to coach — startFen is the before-position, consistent with 'original' demos.
      const { data } = await api.post(`/coach/conversation/${moveId}/line`, {
        moves: composedMoves,
        startFen,
        terminalFen,
        terminalEvalCp: cp,
        ...(noteText ? { userNote: noteText } : {}),
      });

      // data = { text, demonstrations: [{from, moves, startFen}] }
      const coachMsg = {
        id: `coach-${Date.now()}`,
        role: 'assistant',
        message_type: 'coach_response',
        content: data.text,
        move_data: { demonstrations: data.demonstrations || [] },
      };
      setMessages(prev => [...prev, coachMsg]);

      setLineSent(true);
      if (noteText) setLineNote('');

      // Start animation after coach text appears.
      if (data.demonstrations && data.demonstrations.length > 0) {
        animateDemos(data.demonstrations);
      }
    } catch (err) {
      console.error('[Composer] send line error:', err);
      // Remove the optimistic user message on error.
      setMessages(prev => prev.filter(m => !m.id?.startsWith('line-')));
      setError(err.response?.data?.error || err.message || 'Failed to send line to coach.');
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
            } catch (err) {
              console.warn('[Coaching] Could not derive move squares from PGN:', err);
            }
          }
          setMoveContext({
            move: move.move,
            classification: move.classification,
            fen: move.fen,           // after-position (reference only)
            fenBefore: move.fen_before ?? null, // before-position (canonical anchor)
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
  }, [messages, sending, sendingLine]);

  async function handleSend(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending || !moveContext) return;

    const optimistic = [
      ...messages,
      { id: `tmp-${Date.now()}`, role: 'user', message_type: 'text', content: text },
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

      // Server now returns { text, demonstrations }.
      const coachText = data.text ?? data.reply ?? data.content ?? '';
      const demos = Array.isArray(data.demonstrations) ? data.demonstrations : [];

      setMessages(prev => [
        ...prev,
        {
          id: `srv-${Date.now()}`,
          role: 'assistant',
          message_type: 'coach_response',
          content: coachText,
          move_data: { demonstrations: demos },
        },
      ]);

      if (demos.length > 0) {
        animateDemos(demos);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Send failed');
      setMessages(messages);
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  // Effective board FEN: demo overrides composer, which overrides the before-position anchor.
  const boardFen = demoBoard ?? composedFen ?? moveContext?.fenBefore ?? moveContext?.fen ?? 'start';

  const isComposing = composedMoves.length > 0;
  const inDemoMode = demoBoard !== null;

  const moveArrow = useMemo(() => {
    if (!moveContext?.from || !moveContext?.to) return [];
    return [{ startSquare: moveContext.from, endSquare: moveContext.to, color: '#f0c060' }];
  }, [moveContext]);

  const squareHighlights = useMemo(() => {
    if (!moveContext?.from || !moveContext?.to) return {};
    const tint = { backgroundColor: 'rgba(240, 192, 96, 0.2)' };
    return { [moveContext.from]: tint, [moveContext.to]: tint };
  }, [moveContext]);

  const composedLineTokens = useMemo(() => {
    const anchorFen = moveContext?.fenBefore ?? moveContext?.fen;
    if (!composedMoves.length || !anchorFen) return [];
    const parts = anchorFen.split(' ');
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
  }, [composedMoves, moveContext?.fenBefore, moveContext?.fen]);

  // Render a single message based on its type.
  function renderMessage(m) {
    const key = m.id ?? `msg-${m.role}-${m.content?.slice(0, 20)}`;

    if (m.role === 'user' && m.message_type === 'user_moves') {
      const movesList = m.move_data?.moves?.map(mv => mv.san).join(' ') || m.content;
      const note = m.move_data?.userNote;
      const demos = m.move_data
        ? [{ from: 'original', moves: m.move_data.moves?.map(mv => mv.san) || [], startFen: m.move_data.startFen }]
        : [];
      return (
        <div key={key} className="chat-msg user" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="role">you</span>
          <span style={{ fontFamily: "'Courier New', monospace", fontSize: 13 }}>
            Explored: {movesList}
          </span>
          {note && (
            <span style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--text-dim)' }}>
              &ldquo;{note}&rdquo;
            </span>
          )}
          {demos[0]?.startFen && demos[0]?.moves?.length > 0 && (
            <button
              onClick={() => animateDemos(demos)}
              style={{ alignSelf: 'flex-start', fontSize: 12, padding: '2px 8px' }}
            >
              ▶ Show on board
            </button>
          )}
        </div>
      );
    }

    if (m.role === 'assistant') {
      const demos = m.move_data?.demonstrations || [];
      return (
        <div key={key} className="chat-msg assistant" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="role">coach</span>
          <span>{m.content}</span>
          {demos.length > 0 && (
            <button
              onClick={() => animateDemos(demos)}
              style={{ alignSelf: 'flex-start', fontSize: 12, padding: '2px 8px' }}
            >
              ▶ Show demonstration
            </button>
          )}
        </div>
      );
    }

    // Default: plain text message.
    return (
      <div key={key} className={`chat-msg ${m.role}`}>
        <span className="role">{m.role}</span>
        {m.content}
      </div>
    );
  }

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
                        allowDragging: !inDemoMode,
                        allowDrawingArrows: false,
                        boardOrientation: 'white',
                        darkSquareStyle: { backgroundColor: '#3a3a40' },
                        lightSquareStyle: { backgroundColor: '#b6b6bd' },
                        arrows: (isComposing || inDemoMode) ? [] : moveArrow,
                        squareStyles: (isComposing || inDemoMode) ? {} : squareHighlights,
                        onPieceDrop: handlePieceDrop,
                      }}
                    />
                  </div>
                </div>

                {/* Demo-mode overlay */}
                {inDemoMode && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 10,
                    fontSize: 12,
                    color: 'var(--text-dim)',
                  }}>
                    <span style={{ opacity: 0.8 }}>
                      {demoActive ? 'Demonstrating…' : 'Demonstration complete'}
                    </span>
                    <button onClick={handleBackToPosition} style={{ fontSize: 12, padding: '2px 8px' }}>
                      Back to position
                    </button>
                  </div>
                )}

                <dl className="move-context">
                  <dt>Move</dt>
                  <dd>{moveContext.move}</dd>
                  <dt>Classification</dt>
                  <dd>
                    <span className={`tag ${moveContext.classification}`}>
                      {moveContext.classification}
                    </span>
                  </dd>
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
                      {showBoardHint
                        ? "Can't see the line in your head? Drag the pieces, play it out, and let your coach show you where it leads."
                        : 'Drag pieces to explore a line.'}
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
                      <textarea
                        placeholder="Add a note about your idea (optional)"
                        value={lineNote}
                        onChange={(e) => setLineNote(e.target.value)}
                        disabled={sendingLine}
                        style={{
                          display: 'block',
                          width: '100%',
                          marginTop: 10,
                          padding: '6px 8px',
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid var(--border)',
                          color: 'var(--text)',
                          borderRadius: 4,
                          fontSize: 13,
                          resize: 'vertical',
                          minHeight: 52,
                          boxSizing: 'border-box',
                          fontFamily: 'inherit',
                        }}
                      />
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
                      disabled={composedMoves.length === 0 || sendingLine}
                    >
                      Undo
                    </button>
                    <button
                      onClick={handleReset}
                      disabled={composedMoves.length === 0 || sendingLine}
                    >
                      Reset
                    </button>
                    <button
                      className="primary"
                      onClick={handleSendLine}
                      disabled={composedMoves.length === 0 || sendingLine || lineSent}
                    >
                      {sendingLine ? 'Sending to coach…' : lineSent ? 'Sent' : 'Send line to coach'}
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
            {showCoachingHint && (
              <div
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--border)',
                  background: 'rgba(240, 192, 96, 0.04)',
                  fontSize: 12,
                  color: 'var(--text-dim)',
                  lineHeight: 1.55,
                }}
              >
                Your coach asks before it tells — think out loud, and you'll find the answer yourself.
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
                messages.map(renderMessage)
              )}
              {(sending || sendingLine) && <div className="typing">Coach is thinking…</div>}
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
                disabled={sending || sendingLine || loading || !moveContext}
              />
              <button
                type="submit"
                className="primary"
                disabled={sending || sendingLine || loading || !moveContext || !draft.trim()}
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
