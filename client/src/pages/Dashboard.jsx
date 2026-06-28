import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { api } from '../api.js';
import ChessComImport from '../components/ChessComImport.jsx';

const FORMAT_LABEL = { classical: 'Classical', rapid: 'Rapid', bullet: 'Bullet' };

// How many games the batch analysis will include (mirrors server/format.js BATCH_THRESHOLD).
const BATCH_THRESHOLD = { classical: 5, rapid: 10, bullet: 15 };

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function resultClass(result) {
  const r = (result || '').toLowerCase();
  if (r === 'win' || r === '1-0' || r === '0-1') return 'win';
  if (r === 'loss' || r === 'lose') return 'loss';
  if (r === 'draw' || r === '1/2-1/2' || r === '½-½') return 'draw';
  return '';
}

function ImportNudge() {
  return (
    <div
      style={{
        fontSize: 12,
        color: 'var(--gold)',
        background: 'rgba(240, 192, 96, 0.08)',
        border: '1px solid var(--gold-dim)',
        borderRadius: 2,
        padding: '8px 12px',
        marginBottom: 14,
      }}
    >
      New games imported since last analysis — re-run pattern analysis to
      update your weakness report.
    </div>
  );
}

// Inline prompt card shown after import when a format hits its batch threshold.
function AnalysisPromptCard({ format, isAnalysing, onRun, onDismiss }) {
  const label = FORMAT_LABEL[format] || format;
  const count = BATCH_THRESHOLD[format] || '?';

  return (
    <section
      className="panel"
      style={{
        borderColor: 'var(--gold-dim)',
        background: 'rgba(240, 192, 96, 0.05)',
      }}
    >
      <div
        className="row"
        style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--gold)',
              marginBottom: 4,
            }}
          >
            {label} analysis ready
          </div>
          <div style={{ fontSize: 14 }}>
            You have enough {label} games for a fresh analysis.
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            We'll analyse your last {count} {label.toLowerCase()} games and surface recurring patterns.
          </div>
        </div>
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-dim)',
            cursor: 'pointer',
            fontSize: 18,
            lineHeight: 1,
            padding: '0 2px',
            flexShrink: 0,
          }}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>

      {isAnalysing ? (
        <div className="muted" style={{ marginTop: 14, fontStyle: 'italic', fontSize: 13 }}>
          Analysing your last {count} {label.toLowerCase()} games… (1–3 min)
        </div>
      ) : (
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <button className="primary" onClick={onRun}>
            Run analysis
          </button>
          <button onClick={onDismiss}>Maybe later</button>
        </div>
      )}
    </section>
  );
}

function PatternCard({ latest, gameCount, loading, showImportNudge, dimmed }) {
  const wrapStyle = {
    opacity: dimmed ? 0.45 : 1,
    transition: 'opacity 0.3s',
    pointerEvents: dimmed ? 'none' : undefined,
  };

  if (loading) {
    return (
      <div style={wrapStyle}>
        <section className="panel">
          <h2>Pattern analysis</h2>
          <div className="empty">Loading…</div>
        </section>
      </div>
    );
  }

  if (gameCount < 3) {
    const remaining = 3 - gameCount;
    return (
      <div style={wrapStyle}>
        <section className="panel">
          <h2>Pattern analysis</h2>
          <div className="empty">
            Upload {remaining} more game{remaining === 1 ? '' : 's'} to unlock
            pattern analysis
          </div>
        </section>
      </div>
    );
  }

  if (!latest || latest.patterns == null) {
    return (
      <section className="panel">
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <h2 style={{ margin: 0 }}>Pattern analysis</h2>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Pattern analysis ready — see your weaknesses
            </div>
          </div>
          <Link to="/patterns">View →</Link>
        </div>
      </section>
    );
  }

  if (latest.patterns.length === 0) {
    return (
      <section className="panel">
        {showImportNudge && <ImportNudge />}
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
        >
          <div>
            <h2 style={{ margin: 0 }}>Pattern analysis</h2>
            <div style={{ marginTop: 6 }}>
              No recurring patterns yet — keep playing.
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Last analysed: {formatDate(latest.analysedAt)}
            </div>
          </div>
          <Link to="/patterns">View →</Link>
        </div>
      </section>
    );
  }

  const top = latest.patterns[0];
  const formatLabel = latest.format && latest.format !== 'all'
    ? ` · ${FORMAT_LABEL[latest.format] || latest.format}`
    : '';
  return (
    <section className="panel">
      {showImportNudge && <ImportNudge />}
      <div
        className="row"
        style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <div>
          <div
            className="muted"
            style={{
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            Top weakness{formatLabel}
          </div>
          <h2 style={{ margin: '4px 0 6px' }}>{top.principleName}</h2>
          <div className="muted" style={{ fontSize: 12 }}>
            Found in {top.frequency} game{top.frequency === 1 ? '' : 's'}
            {' · '}Last analysed: {formatDate(latest.analysedAt)}
          </div>
        </div>
        <Link to="/patterns">View all →</Link>
      </div>
    </section>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pgn, setPgn] = useState('');
  const [opponent, setOpponent] = useState('');
  const [result, setResult] = useState('win');
  const [userColor, setUserColor] = useState('white');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [latest, setLatest] = useState(null);
  const [latestLoading, setLatestLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // Import section: collapsed by default; auto-expands if user has no games.
  const [importExpanded, setImportExpanded] = useState(false);
  const importInitialized = useRef(false);

  // Format-aware batch analysis prompt state.
  const [readyFormats, setReadyFormats] = useState([]);
  const [analysingFormat, setAnalysingFormat] = useState(null);
  const [batchError, setBatchError] = useState('');

  async function loadGames() {
    try {
      const { data } = await api.get('/games');
      setGames(data);
    } catch (err) {
      setError(err.message || 'Failed to load games');
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/games');
        if (!cancelled) {
          setGames(data);
          if (!importInitialized.current) {
            importInitialized.current = true;
            if (data.length === 0) setImportExpanded(true);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load games');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/coach/patterns/latest');
        if (!cancelled) setLatest(data);
      } catch {
        if (!cancelled) setLatest(null);
      } finally {
        if (!cancelled) setLatestLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/profile');
        if (!cancelled) setProfile(data);
      } catch {
        if (!cancelled) setProfile(null);
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleImported(importData) {
    try { const { data: g } = await api.get('/games'); setGames(g); } catch { /* best-effort */ }
    try { const { data: p } = await api.get('/profile'); setProfile(p); } catch { /* best-effort */ }
    try { const { data: l } = await api.get('/coach/patterns/latest'); setLatest(l); } catch { /* best-effort */ }
    if (importData?.readyFormats?.length) {
      setReadyFormats(prev => {
        const merged = new Set([...prev, ...importData.readyFormats]);
        return [...merged];
      });
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    const trimmed = pgn.trim();
    if (!trimmed) { setError('Paste a PGN first.'); return; }
    try {
      const chess = new Chess();
      chess.loadPgn(trimmed);
    } catch (err) {
      setError('PGN is not valid: ' + err.message);
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post('/games', {
        pgn: trimmed,
        opponent: opponent.trim() || 'Unknown',
        result,
        userColor,
      });
      setPgn('');
      setOpponent('');
      setResult('win');
      setUserColor('white');
      await loadGames();
      if (data?.readyFormats?.length) {
        setReadyFormats(prev => {
          const merged = new Set([...prev, ...data.readyFormats]);
          return [...merged];
        });
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleRunBatchAnalysis(format) {
    setBatchError('');
    setAnalysingFormat(format);
    try {
      await api.post('/coach/patterns/batch', { format }, { timeout: 5 * 60 * 1000 });
      setReadyFormats(prev => prev.filter(f => f !== format));
      try { const { data: l } = await api.get('/coach/patterns/latest'); setLatest(l); } catch { /* best-effort */ }
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Analysis failed';
      setBatchError(`${FORMAT_LABEL[format] || format}: ${msg}`);
    } finally {
      setAnalysingFormat(null);
    }
  }

  function dismissFormat(format) {
    setReadyFormats(prev => prev.filter(f => f !== format));
  }

  const showImportNudge =
    !!profile?.last_import_at &&
    !!latest?.analysedAt &&
    new Date(profile.last_import_at).getTime() > new Date(latest.analysedAt).getTime();

  // New-user state: fewer than 3 games and done loading.
  const isNewUser = !loading && games.length < 3;

  return (
    <>
      {/* Change 1: orientation line for new/light users only */}
      {isNewUser && (
        <p
          style={{
            margin: '0 0 18px',
            fontSize: 13,
            color: 'var(--text-dim)',
            lineHeight: 1.6,
          }}
        >
          Import your games and I'll surface the recurring mistakes holding
          you back — then coach you through them, one move at a time.
        </p>
      )}

      {/* ── Collapsible import section ───────────────────────────────── */}
      <div
        className="panel"
        onClick={() => setImportExpanded((e) => !e)}
        role="button"
        aria-expanded={importExpanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <h2 style={{ margin: 0 }}>Import games</h2>
        <span
          style={{
            fontSize: 20,
            lineHeight: 1,
            color: 'var(--gold)',
            transition: 'transform 0.15s ease',
            transform: importExpanded ? 'rotate(90deg)' : 'none',
          }}
        >
          ▸
        </span>
      </div>

      {importExpanded && (
        <>
          {profileLoading ? (
            <section className="panel">
              <h2>Import from Chess.com</h2>
              <div className="empty">Loading…</div>
            </section>
          ) : (
            <ChessComImport
              initialUsername={profile?.chesscom_username || ''}
              lastImportAt={profile?.last_import_at}
              onImported={handleImported}
            />
          )}

          <div
            style={{
              textAlign: 'center',
              fontSize: 11,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--text-dim)',
              margin: '6px 0',
            }}
          >
            or
          </div>

          <section className="panel">
            <h2>New game</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Paste the PGN. The coach reviews it after Stockfish flags the moves.
            </p>
            <form className="form-stack" onSubmit={handleSave}>
              <div className="row">
                <input
                  type="text"
                  placeholder="Opponent name"
                  value={opponent}
                  onChange={(e) => setOpponent(e.target.value)}
                  disabled={saving}
                />
                <select
                  value={result}
                  onChange={(e) => setResult(e.target.value)}
                  disabled={saving}
                >
                  <option value="win">Win</option>
                  <option value="loss">Loss</option>
                  <option value="draw">Draw</option>
                </select>
                <select
                  value={userColor}
                  onChange={(e) => setUserColor(e.target.value)}
                  disabled={saving}
                >
                  <option value="white">I played White</option>
                  <option value="black">I played Black</option>
                </select>
              </div>
              <textarea
                rows={8}
                placeholder='[Event "Casual"]&#10;[White "You"]&#10;[Black "Opponent"]&#10;&#10;1. e4 e5 2. Nf3 Nc6 ...'
                value={pgn}
                onChange={(e) => setPgn(e.target.value)}
                disabled={saving}
              />
              {/* Change 5: PGN hint for less-technical users */}
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  color: 'var(--text-dim)',
                  lineHeight: 1.5,
                }}
              >
                Paste the game text from Chess.com or Lichess (look under Share → PGN).
              </p>
              {error && <div className="error">{error}</div>}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button type="submit" className="primary" disabled={saving}>
                  {saving ? 'Saving…' : 'Save game'}
                </button>
              </div>
            </form>
          </section>
        </>
      )}
      {/* ── End collapsible import section ──────────────────────────── */}

      {/* ── Format-aware analysis prompts ───────────────────────────── */}
      {batchError && (
        <div className="error" style={{ marginBottom: 8 }}>{batchError}</div>
      )}
      {readyFormats.map(format => (
        <AnalysisPromptCard
          key={format}
          format={format}
          isAnalysing={analysingFormat === format}
          onRun={() => handleRunBatchAnalysis(format)}
          onDismiss={() => dismissFormat(format)}
        />
      ))}
      {/* ── End format analysis prompts ──────────────────────────────── */}

      {/* Change 2: de-emphasize locked pattern card for new users */}
      <PatternCard
        latest={latest}
        gameCount={games.length}
        loading={loading || latestLoading}
        showImportNudge={showImportNudge}
        dimmed={isNewUser}
      />

      {/* Change 2: de-emphasize empty games list for new users */}
      <div
        style={{
          opacity: isNewUser ? 0.45 : 1,
          transition: 'opacity 0.3s',
          pointerEvents: isNewUser ? 'none' : undefined,
        }}
      >
        <section className="panel">
          <h2>Your games</h2>
          {loading ? (
            <div className="empty">Loading…</div>
          ) : games.length === 0 ? (
            <div className="empty">No games yet. Paste a PGN above to begin.</div>
          ) : (
            <div className="games-list">
              {games.map((g) => (
                <div
                  key={g.id}
                  className="game-row"
                  onClick={() => navigate(`/game/${g.id}`)}
                >
                  <div>
                    <div className="opponent">vs {g.opponent || 'Unknown'}</div>
                    <div className="date">{formatDate(g.played_at)}</div>
                  </div>
                  <span className={`result ${resultClass(g.result)}`}>
                    {g.result || '—'}
                  </span>
                  <span className="muted">→</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
