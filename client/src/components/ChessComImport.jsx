import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const TIME_CLASS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'rapid', label: 'Rapid' },
  { value: 'blitz', label: 'Blitz' },
  { value: 'bullet', label: 'Bullet' },
  { value: 'daily', label: 'Daily' },
];

const COUNT_OPTIONS = [5, 10, 20];

// Adaptive lookback can walk back many months for inactive accounts; give
// the request room before axios's default 60s timeout trips.
const IMPORT_TIMEOUT_MS = 2 * 60 * 1000;

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
  if (r === 'win') return 'win';
  if (r === 'loss') return 'loss';
  if (r === 'draw') return 'draw';
  return '';
}

function labelFor(value) {
  const opt = TIME_CLASS_OPTIONS.find((o) => o.value === value);
  return opt ? opt.label.toLowerCase() : value;
}

export default function ChessComImport({
  initialUsername = '',
  lastImportAt = null,
  onImported,
}) {
  const [username, setUsername] = useState(initialUsername);
  const isConnected = !!initialUsername;
  const [timeClass, setTimeClass] = useState('rapid');
  const [count, setCount] = useState(10);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [importedRows, setImportedRows] = useState([]);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    const cleanUsername = username.trim();
    if (!cleanUsername) {
      setError('Enter your Chess.com username.');
      return;
    }

    setError('');
    setLoading(true);
    setResult(null);
    setImportedRows([]);

    try {
      const { data } = await api.post(
        '/games/import/chesscom',
        {
          username: cleanUsername,
          maxGames: count,
          timeClass,
        },
        { timeout: IMPORT_TIMEOUT_MS }
      );

      // The server returns 200 with `error` in the body for validation/API
      // failures (bad username, Chess.com unreachable). Surface those here.
      if (data.error) {
        setError(data.error);
        return;
      }

      setResult(data);

      // Fetch the full game rows for the newly imported games so we can show
      // opponent/result/date in the success list.
      if (data.gameIds && data.gameIds.length > 0) {
        try {
          const { data: all } = await api.get('/games');
          const byId = new Map(all.map((g) => [g.id, g]));
          setImportedRows(data.gameIds.map((id) => byId.get(id)).filter(Boolean));
        } catch {
          // Best-effort — the counts above still tell the user what happened.
        }
      }

      if (onImported) onImported(data);
    } catch (err) {
      if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')) {
        setError('Chess.com is not responding. Try again in a moment.');
      } else {
        setError(
          err.response?.data?.error || err.message || 'Import failed.'
        );
      }
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setResult(null);
    setImportedRows([]);
    setError('');
  }

  const isSuccess = result && !error && result.imported > 0;
  const isEmptyState =
    result && !error && result.imported === 0 && result.skipped > 0;
  const isNoGamesFound =
    result &&
    !error &&
    result.imported === 0 &&
    result.skipped === 0 &&
    result.total === 0;

  return (
    <section className="panel">
      <h2>Import from Chess.com</h2>
      {isConnected ? (
        <p className="muted" style={{ marginTop: 0 }}>
          Connected as {initialUsername}
          {lastImportAt && ` · Last import: ${formatDate(lastImportAt)}`}
        </p>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          Fetch your recent rated games automatically. Re-running is safe — we
          skip games that are already imported.
        </p>
      )}

      {isSuccess ? (
        <SuccessView result={result} rows={importedRows} onReset={reset} />
      ) : (
        <form className="form-stack" onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="Your Chess.com username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
          />
          <div className="row">
            <select
              value={timeClass}
              onChange={(e) => setTimeClass(e.target.value)}
              disabled={loading}
            >
              {TIME_CLASS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              disabled={loading}
            >
              {COUNT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} games
                </option>
              ))}
            </select>
          </div>

          {error && <div className="error">{error}</div>}

          {isEmptyState && (
            <div className="muted" style={{ fontStyle: 'italic' }}>
              All your recent Chess.com games are already imported.
            </div>
          )}

          {isNoGamesFound && (
            <div className="muted" style={{ fontStyle: 'italic' }}>
              No rated {labelFor(timeClass)} games found for this username.
              Try a different time control.
            </div>
          )}

          {loading && (
            <div className="muted" style={{ fontStyle: 'italic' }}>
              Fetching your latest games from Chess.com…
            </div>
          )}

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button
              type="submit"
              className="primary"
              disabled={loading || !username.trim()}
            >
              {loading ? 'Importing…' : 'Import from Chess.com'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function SuccessView({ result, rows, onReset }) {
  return (
    <div className="form-stack">
      <div>
        Imported {result.imported} new game
        {result.imported === 1 ? '' : 's'}
        {' · '}
        {result.skipped} already existed
        {result.failed > 0 ? ` · ${result.failed} failed` : ''}
      </div>

      {rows.length > 0 && (
        <div className="games-list">
          {rows.map((g) => (
            <Link
              key={g.id}
              to={`/game/${g.id}`}
              className="game-row"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div>
                <div className="opponent">vs {g.opponent || 'Unknown'}</div>
                <div className="date">{formatDate(g.played_at)}</div>
              </div>
              <span className={`result ${resultClass(g.result)}`}>
                {g.result || '—'}
              </span>
              <span className="muted">Review →</span>
            </Link>
          ))}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onReset}>Import more</button>
      </div>
    </div>
  );
}