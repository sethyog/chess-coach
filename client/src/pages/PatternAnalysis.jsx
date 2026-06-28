import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';

// Pattern analysis does one mapping call + N sequential per-pattern summary
// calls. Total runtime can exceed the default axios 60s timeout.
const PATTERN_ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;

// Minimum games required to unlock per-format analysis (mirrors server/format.js MIN_GAMES).
const MIN_GAMES = { classical: 3, rapid: 5, bullet: 8 };

const FORMAT_TABS = [
  { key: 'classical', label: 'Classical' },
  { key: 'rapid', label: 'Rapid' },
  { key: 'bullet', label: 'Bullet' },
];

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
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFormat = FORMAT_TABS.some(t => t.key === searchParams.get('format'))
    ? searchParams.get('format')
    : 'classical';

  const [selectedFormat, setSelectedFormat] = useState(initialFormat);

  // Per-format cache: { [format]: { state: 'loading'|'ready'|'error', results, error } }
  const [formatCache, setFormatCache] = useState({});

  const [readyFormats, setReadyFormats] = useState([]);
  const [analysingFormat, setAnalysingFormat] = useState(null);

  const [expanded, setExpanded] = useState({});

  // On mount: check which formats are ready for analysis.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/coach/patterns/ready');
        if (data.readyFormats?.length) setReadyFormats(data.readyFormats);
      } catch { /* best-effort */ }
    })();
  }, []);

  // Load the initial format tab on mount.
  useEffect(() => {
    loadFormat(initialFormat);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadFormat(fmt) {
    if (formatCache[fmt]) return;
    setFormatCache(prev => ({ ...prev, [fmt]: { state: 'loading', results: null, error: '' } }));
    try {
      const { data } = await api.get(`/coach/patterns/latest?format=${fmt}`);
      setFormatCache(prev => ({
        ...prev,
        [fmt]: { state: 'ready', results: data, error: '' },
      }));
    } catch (err) {
      setFormatCache(prev => ({
        ...prev,
        [fmt]: {
          state: 'error',
          results: null,
          error: err.response?.data?.error || err.message || 'Failed to load',
        },
      }));
    }
  }

  function selectTab(fmt) {
    setSelectedFormat(fmt);
    setSearchParams({ format: fmt });
    loadFormat(fmt);
  }

  async function handleRunBatchAnalysis(format) {
    setAnalysingFormat(format);
    try {
      const { data } = await api.post(
        '/coach/patterns/batch',
        { format },
        { timeout: PATTERN_ANALYSIS_TIMEOUT_MS },
      );
      setReadyFormats(prev => prev.filter(r => r.format !== format));
      setFormatCache(prev => ({
        ...prev,
        [format]: { state: 'ready', results: data, error: '' },
      }));
    } catch (err) {
      setFormatCache(prev => ({
        ...prev,
        [format]: {
          state: 'error',
          results: null,
          error: err.response?.data?.error || err.message || 'Analysis failed',
        },
      }));
    } finally {
      setAnalysingFormat(null);
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

      {/* Format tabs */}
      <div
        style={{
          display: 'flex',
          gap: 2,
          marginBottom: 16,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {FORMAT_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => selectTab(tab.key)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: selectedFormat === tab.key
                ? '2px solid var(--gold)'
                : '2px solid transparent',
              color: selectedFormat === tab.key ? 'var(--gold)' : 'var(--text-dim)',
              cursor: 'pointer',
              fontSize: 13,
              fontFamily: 'inherit',
              padding: '6px 14px 8px',
              marginBottom: -1,
              transition: 'color 0.1s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <FormatTabContent
        format={selectedFormat}
        cache={formatCache[selectedFormat]}
        readyFormats={readyFormats}
        onRunAnalysis={handleRunBatchAnalysis}
        analysingFormat={analysingFormat}
        expanded={expanded}
        onToggle={togglePattern}
      />
    </>
  );
}

// ── Format-specific tab ───────────────────────────────────────────────────────

function FormatTabContent({ format, cache, readyFormats, onRunAnalysis, analysingFormat, expanded, onToggle }) {
  const label = { classical: 'Classical', rapid: 'Rapid', bullet: 'Bullet' }[format] || format;
  const minGames = MIN_GAMES[format] || 3;
  const readyEntry = readyFormats.find(r => r.format === format);
  const isReady = !!readyEntry;
  const isAnalysing = analysingFormat === format;

  if (!cache || cache.state === 'loading') {
    return (
      <div className="panel">
        <div className="empty">Loading…</div>
      </div>
    );
  }

  if (cache.state === 'error') {
    return (
      <div className="panel">
        <div className="error">{cache.error || 'Failed to load'}</div>
      </div>
    );
  }

  const { results } = cache;
  const hasAnalysis = results && results.patterns != null;

  // State C: completed batch exists — show pattern results.
  if (hasAnalysis) {
    return (
      <PatternResults
        results={results}
        formatLabel={label}
        onReanalyse={null}
        expanded={expanded}
        onToggle={onToggle}
      />
    );
  }

  // State A: enough games, no completed batch yet — invite the user to run analysis.
  if (isReady) {
    const { isFirstRun, totalGames } = readyEntry;
    const threshold = { classical: 3, rapid: 5, bullet: 8 }[format] || 3;
    const bodyText = isFirstRun
      ? `You have ${totalGames} ${label} games ready. We'll analyse them in batches of ${threshold} to show your progression right away.`
      : `You have ${threshold} new ${label} games ready for your next analysis.`;
    const analysingText = isFirstRun
      ? `Analysing ${totalGames} ${label.toLowerCase()} games in batches… (may take a few minutes)`
      : `Analysing your last ${threshold} ${label.toLowerCase()} games… (1–3 min)`;

    return (
      <div className="panel">
        <h2>{label} analysis</h2>
        {isAnalysing ? (
          <div className="muted" style={{ fontStyle: 'italic', fontSize: 13 }}>
            {analysingText}
          </div>
        ) : (
          <>
            <div style={{ fontSize: 14 }}>{bodyText}</div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" onClick={() => onRunAnalysis(format)}>
                Run analysis
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // State B: not enough games yet.
  return (
    <div className="panel">
      <h2>{label} analysis</h2>
      <div className="empty">
        Import at least {minGames} {label.toLowerCase()} games to unlock {label} analysis.
        <div style={{ fontSize: 12, marginTop: 8, color: 'var(--text-dim)' }}>
          Once you have enough games, import them from Dashboard and confirm "Run analysis"
          when prompted.
        </div>
      </div>
    </div>
  );
}

// ── Shared results view ───────────────────────────────────────────────────────

function PatternResults({ results, formatLabel, onReanalyse, expanded, onToggle }) {
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
  const headingLabel = formatLabel ? `${formatLabel} pattern analysis` : 'Pattern analysis';

  return (
    <>
      <section className="panel">
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
        >
          <div>
            <h2 style={{ marginBottom: 6 }}>{headingLabel}</h2>
            <div className="muted" style={{ fontSize: 12 }}>
              Based on your last {gamesAnalysed} games
              {dateRange ? ` (${dateRange})` : ''}
              {' · '}
              Last analysed: {formatDateTime(analysedAt)}
            </div>
          </div>
          {onReanalyse && <button onClick={onReanalyse}>Re-analyse</button>}
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
