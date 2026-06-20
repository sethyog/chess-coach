import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { api } from '../api.js';

export default function Coaching() {
  const { id, moveId } = useParams();

  const [moveContext, setMoveContext] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

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
          // Derive from/to squares via the PGN verbose history so the board
          // can draw an arrow showing where the piece came from.
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
              }
            } catch (err) {
              console.warn('Could not derive move squares from PGN:', err);
            }
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
    return () => {
      cancelled = true;
    };
  }, [id, moveId]);

  // Auto-scroll chat to bottom on new messages.
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

      // Server should return either the full updated transcript or the new
      // assistant reply. Handle both shapes.
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
        // Fall back: refetch conversation so we stay in sync.
        const conv = await api.get(`/coach/conversation/${moveId}`);
        setMessages(conv.data || []);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Send failed');
      // Roll back optimistic user message so the user can retry.
      setMessages(messages);
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  const boardFen = useMemo(() => moveContext?.fen || 'start', [moveContext]);

  const moveArrow = useMemo(() => {
    if (!moveContext?.from || !moveContext?.to) return [];
    return [{ startSquare: moveContext.from, endSquare: moveContext.to, color: '#f0c060' }];
  }, [moveContext]);

  const squareHighlights = useMemo(() => {
    if (!moveContext?.from || !moveContext?.to) return {};
    const tint = { backgroundColor: 'rgba(240, 192, 96, 0.2)' };
    return { [moveContext.from]: tint, [moveContext.to]: tint };
  }, [moveContext]);

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
                        allowDragging: false,
                        allowDrawingArrows: false,
                        boardOrientation: 'white',
                        darkSquareStyle: { backgroundColor: '#3a3a40' },
                        lightSquareStyle: { backgroundColor: '#b6b6bd' },
                        arrows: moveArrow,
                        squareStyles: squareHighlights,
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
                  <dt>Principle</dt>
                  <dd>
                    {moveContext.principle_violated || (
                      <span className="muted">
                        (To be discovered through the coaching dialogue.)
                      </span>
                    )}
                  </dd>
                </dl>
              </>
            ) : (
              <div className="empty">No move context.</div>
            )}
          </div>
        </div>

        <div>
          <div className="chat">
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