import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// Pattern analysis does one mapping call + N sequential per-pattern summary
// calls. Total runtime can exceed the default axios 60s timeout.
const PATTERN_ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;

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

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function dateRangeFromGames(games) {
  if (!games || games.length === 0) return '';
  const dates = games
    .map((g) => new Date(g.played_at))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b);
  if (dates.length === 0) return '';
  if (dates.length === 1) return formatDate(dates[0].toISOString());
  const first = formatDate(dates[0].toISOString());
  const last = formatDate(dates[dates.length - 1].toISOString());
  return first === last ? first : `${first} – ${last}`;
}

export default function PatternAnalysis() {
  // state: 'loading' | 'analysing' | 'ready' | 'error'
  const [state, setState] = useState('loading');
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState({});
  const startedRef = useRef(false);

  useEffect(() => {
    // startedRef alone gates re-entry (React strict mode double-mounts the
    // effect; we want exactly one fetch sequence per real mount).
    if (startedRef.current) return;
    startedRef.current = true;

    async function runFresh() {
      setState('analysing');
      try {
        const { data } = await api.post('/coach/patterns', null, {
          timeout: PATTERN_ANALYSIS_TIMEOUT_MS,
        });
        setResults(data);
        if (data.error) {
          setError(data.error);
          setState('error');
        } else {
          setState('ready');
        }
      } catch (err) {
        setError(err.response?.data?.error || err.message || 'Analysis failed');
        setState('error');
      }
    }

    (async () => {
      try {
        const { data } = await api.get('/coach/patterns/latest');
        const hasCached = data && data.patterns != null && data.analysedAt;
        if (!hasCached) {
          await runFresh();
          return;
        }
        const age = Date.now() - new Date(data.analysedAt).getTime();
        if (age > TWENTY_FOUR_HOURS_MS) {
          await runFresh();
        } else {
          setResults(data);
          setState('ready');
        }
      } catch (err) {
        setError(err.response?.data?.error || err.message || 'Failed to load');
        setState('error');
      }
    })();
  }, []);

  async function handleReanalyse() {
    setError('');
    setState('analysing');
    try {
      const { data } = await api.post('/coach/patterns', null, {
        timeout: PATTERN_ANALYSIS_TIMEOUT_MS,
      });
      setResults(data);
      if (data.error) {
        setError(data.error);
        setState('error');
      } else {
        setState('ready');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Analysis failed');
      setState('error');
    }
  }

  function togglePattern(principleId) {
    setExpanded((prev) => ({ ...prev, [principleId]: !prev[principleId] }));
  }

  return (
    <>
      <div className="crumb">
        <Link to="/">← Dashboard</Link>
        {' / '}
        Pattern analysis
      </div>

      {state === 'loading' && (
        <div className="panel">
          <div className="empty">Loading…</div>
        </div>
      )}

      {state === 'analysing' && (
        <div className="panel">
          <div className="empty">
            Analysing your last {results?.gamesAnalysed || 5} games…
            <div style={{ fontSize: 12, marginTop: 8 }}>
              The AI maps every mistake to a principle, then writes a coach
              summary for each recurring pattern. This usually takes 1–3
              minutes.
            </div>
          </div>
        </div>
      )}

      {state === 'error' && (
        <div className="panel">
          <div className="error">{error || 'Something went wrong'}</div>
          <div className="row" style={{ marginTop: 14 }}>
            <button onClick={handleReanalyse}>Try again</button>
          </div>
        </div>
      )}

      {state === 'ready' && results && (
        <PatternResults
          results={results}
          onReanalyse={handleReanalyse}
          expanded={expanded}
          onToggle={togglePattern}
        />
      )}
    </>
  );
}

function PatternResults({ results, onReanalyse, expanded, onToggle }) {
  const {
    patterns,
    gamesAnalysed,
    gamesSummary,
    totalMistakesMapped,
    analysedAt,
  } = results;

  if (gamesAnalysed < 3) {
    return (
      <div className="panel">
        <h2>Pattern analysis</h2>
        <div className="empty">
          Upload at least 3 games to unlock pattern analysis
        </div>
      </div>
    );
  }

  const topPattern = patterns?.[0];
  const dateRange = dateRangeFromGames(gamesSummary);

  return (
    <>
      <section className="panel">
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
        >
          <div>
            <h2 style={{ marginBottom: 6 }}>Pattern analysis</h2>
            <div className="muted" style={{ fontSize: 12 }}>
              Based on your last {gamesAnalysed} games
              {dateRange ? ` (${dateRange})` : ''}
              {' · '}
              Last analysed: {formatDateTime(analysedAt)}
            </div>
          </div>
          <button onClick={onReanalyse}>Re-analyse</button>
        </div>

        <div className="grid-2" style={{ marginTop: 18 }}>
          <div>
            <div
              className="muted"
              style={{
                fontSize: 11,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              Top weakness
            </div>
            <div
              style={{
                fontFamily: 'var(--font-head)',
                fontSize: 18,
                marginTop: 4,
              }}
            >
              {topPattern ? topPattern.principleName : '—'}
            </div>
          </div>
          <div>
            <div
              className="muted"
              style={{
                fontSize: 11,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              Mistakes mapped
            </div>
            <div
              style={{
                fontFamily: 'var(--font-head)',
                fontSize: 18,
                marginTop: 4,
              }}
            >
              {totalMistakesMapped}
            </div>
          </div>
        </div>
      </section>

      {/* Change 6: section label between summary and cards so the repeated
          principle name reads as "overview → detail" not "duplicate" */}
      <div
        style={{
          margin: '24px 0 10px',
          fontSize: 11,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
          borderBottom: '1px solid var(--border)',
          paddingBottom: 8,
        }}
      >
        {patterns?.length === 0
          ? 'Patterns'
          : `${patterns.length} recurring pattern${patterns.length === 1 ? '' : 's'}`}
      </div>

      {patterns?.length === 0 ? (
        <section className="panel">
          <div className="empty">
            No recurring patterns found in your recent games — keep playing
            and check back
          </div>
        </section>
      ) : (
        patterns.map((p) => (
          <PatternCard
            key={p.principleId}
            pattern={p}
            totalGames={gamesAnalysed}
            gamesSummary={gamesSummary}
            expanded={!!expanded[p.principleId]}
            onToggle={() => onToggle(p.principleId)}
          />
        ))
      )}
    </>
  );
}

function PatternCard({ pattern, totalGames, gamesSummary, expanded, onToggle }) {
  const gameMap = new Map(gamesSummary.map((g) => [g.id, g]));
  const affectedGames = pattern.gamesAffected
    .map((id) => gameMap.get(id))
    .filter(Boolean);
  const moveCount = pattern.movesViolating.length;

  return (
    <section className="panel">
      <div
        className="row"
        style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <h3 style={{ margin: 0 }}>{pattern.principleName}</h3>
        <span className="tag mistake">
          Found in {pattern.frequency} of {totalGames} games
        </span>
      </div>

      {affectedGames.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {affectedGames.map((g, i) => (
            <span key={g.id}>
              {i > 0 ? ' · ' : ''}vs {g.opponent || 'Unknown'} (
              {formatDate(g.played_at)})
            </span>
          ))}
        </div>
      )}

      {pattern.coachSummary && (
        <p style={{ marginTop: 14, marginBottom: 0 }}>{pattern.coachSummary}</p>
      )}

      <button onClick={onToggle} style={{ marginTop: 14 }}>
        {expanded
          ? 'Hide moves'
          : `Show ${moveCount} contributing move${moveCount === 1 ? '' : 's'}`}
      </button>

      {expanded && (
        <ul style={{ marginTop: 12, paddingLeft: 18 }}>
          {pattern.movesViolating.map((moveRef, i) => (
            <li key={i} style={{ marginBottom: 6 }}>
              <span style={{ color: 'var(--text)' }}>{moveRef}</span>
              {pattern.reasonings?.[i] && (
                <span className="muted"> — {pattern.reasonings[i]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}