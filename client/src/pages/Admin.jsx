import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

// ─── Lichess themes the admin can assign to candidates ──────────────────────
// Must match server/principle-candidates.js LICHESS_THEMES.
const THEME_OPTIONS = [
  'fork', 'pin', 'skewer', 'hangingPiece', 'discoveredAttack', 'doubleCheck',
  'xRayAttack', 'deflection', 'attraction', 'sacrifice', 'intermezzo',
  'attackingF2F7', 'kingsideAttack', 'queensideAttack', 'quietMove',
  'defensiveMove', 'clearance',
  'mate', 'mateIn1', 'mateIn2', 'mateIn3', 'backRankMate', 'smotheredMate',
  'hookMate', 'anastasiaMate', 'arabianMate',
  'endgame', 'rookEndgame', 'queenEndgame', 'bishopEndgame', 'knightEndgame',
  'pawnEndgame', 'queenRookEndgame', 'promotion', 'underPromotion', 'zugzwang',
  'exposedKing', 'trappedPiece', 'capturingDefender',
  'opening', 'middlegame',
  'advantage', 'crushing', 'equality', 'castling', 'enPassant',
].sort();

const ROUTING_COLORS = {
  auto_approve: 'var(--green)',
  human_review: 'var(--gold)',
  hold: 'var(--text-dim)',
  auto_reject: 'var(--red)',
};

function RoutingBadge({ routing }) {
  return (
    <span
      style={{
        fontSize: 11,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: ROUTING_COLORS[routing] || 'var(--text-dim)',
        border: `1px solid ${ROUTING_COLORS[routing] || 'var(--border)'}`,
        borderRadius: 2,
        padding: '2px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      {routing || '—'}
    </span>
  );
}

// ─── Stats panel ─────────────────────────────────────────────────────────────
function StatsPanel() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    api.get('/admin/stats').then(({ data }) => setStats(data)).catch(() => {});
  }, []);

  if (!stats) return <div className="panel"><div className="empty">Loading stats…</div></div>;

  return (
    <section className="panel">
      <h2>Overview</h2>
      <div className="grid-2" style={{ gap: 14 }}>
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Users</div>
          <div style={{ fontSize: 24, fontFamily: 'var(--font-head)', marginTop: 2 }}>{stats.userCount}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Games</div>
          <div style={{ fontSize: 24, fontFamily: 'var(--font-head)', marginTop: 2 }}>{stats.gameCount}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Principles</div>
          <div style={{ fontSize: 24, fontFamily: 'var(--font-head)', marginTop: 2 }}>{stats.principleCount}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Candidate queue</div>
          <div style={{ fontSize: 24, fontFamily: 'var(--font-head)', marginTop: 2 }}>{stats.candidateQueue?.total}</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {stats.candidateQueue?.human_review} need review ·{' '}
            {stats.candidateQueue?.auto_approve} auto-approve ·{' '}
            {stats.candidateQueue?.hold} on hold ·{' '}
            {stats.candidateQueue?.auto_reject} auto-reject
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Candidate card ───────────────────────────────────────────────────────────
function CandidateCard({ candidate, onDecision }) {
  const [busy, setBusy] = useState(false);
  const [themeOverride, setThemeOverride] = useState(candidate.proposed_lichess_theme || '');
  const [error, setError] = useState('');

  async function act(endpoint, body) {
    setBusy(true);
    setError('');
    try {
      await api.post(`/admin/candidates/${candidate.id}/${endpoint}`, body || {});
      onDecision();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Action failed');
      setBusy(false);
    }
  }

  async function handleSetTheme() {
    if (!themeOverride) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/admin/candidates/${candidate.id}/set-theme`, { lichessTheme: themeOverride });
      onDecision();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to set theme');
      setBusy(false);
    }
  }

  const simPct = candidate.similarity_score != null
    ? Math.round(candidate.similarity_score * 100)
    : null;

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <strong style={{ fontSize: 15 }}>{candidate.suggested_name}</strong>
            <RoutingBadge routing={candidate.routing} />
          </div>
          {candidate.suggested_description && (
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>
              {candidate.suggested_description}
            </p>
          )}
        </div>
        <div className="row" style={{ gap: 6, flexShrink: 0 }}>
          <button onClick={() => act('approve', { lichessTheme: themeOverride || undefined })} disabled={busy} className="primary" style={{ fontSize: 12, padding: '4px 10px' }}>
            Approve
          </button>
          <button onClick={() => act('reject')} disabled={busy} style={{ fontSize: 12, padding: '4px 10px' }}>
            Reject
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: '6px 20px' }}>
        <span className="muted">
          Seen <strong>{candidate.occurrence_count}</strong>× by{' '}
          <strong>{candidate.distinct_user_count}</strong> user{candidate.distinct_user_count === 1 ? '' : 's'}
        </span>
        {simPct != null && (
          <span className="muted">
            Similarity{' '}
            <strong style={{ color: simPct >= 80 ? 'var(--red)' : simPct >= 60 ? 'var(--gold)' : 'var(--green)' }}>
              {simPct}%
            </strong>{' '}
            {candidate.most_similar_principle_name && (
              <span>to <em>{candidate.most_similar_principle_name}</em></span>
            )}
          </span>
        )}
        {candidate.proposed_lichess_theme && (
          <span className="muted">Theme: <code style={{ fontSize: 11 }}>{candidate.proposed_lichess_theme}</code></span>
        )}
      </div>

      <div className="row" style={{ marginTop: 10, gap: 6 }}>
        <select
          value={themeOverride}
          onChange={(e) => setThemeOverride(e.target.value)}
          disabled={busy}
          style={{ flex: 1, maxWidth: 240 }}
        >
          <option value="">— override theme —</option>
          {THEME_OPTIONS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <button onClick={handleSetTheme} disabled={busy || !themeOverride} style={{ fontSize: 12, padding: '4px 10px' }}>
          Set theme
        </button>
      </div>

      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

// ─── Candidates tab ───────────────────────────────────────────────────────────
function CandidatesTab() {
  const [candidates, setCandidates] = useState(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  // Increment to force a reload without changing filter.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = filter ? `?routing=${filter}` : '';
        const { data } = await api.get(`/admin/candidates${params}`);
        if (!cancelled) setCandidates(data);
      } catch {
        if (!cancelled) setCandidates([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filter, refreshKey]);

  function load() { setRefreshKey((k) => k + 1); }

  const humanReview = (candidates || []).filter((c) => c.routing === 'human_review');
  const autoApprove = (candidates || []).filter((c) => c.routing === 'auto_approve');
  const hold = (candidates || []).filter((c) => c.routing === 'hold');
  const autoReject = (candidates || []).filter((c) => c.routing === 'auto_reject');

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All pending</option>
          <option value="human_review">Human review</option>
          <option value="auto_approve">Auto-approve</option>
          <option value="hold">Hold</option>
          <option value="auto_reject">Auto-reject</option>
        </select>
      </div>

      {loading && <div className="empty">Loading…</div>}
      {!loading && candidates?.length === 0 && (
        <div className="empty">No candidates in this bucket.</div>
      )}

      {!loading && humanReview.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            Human review ({humanReview.length})
          </div>
          {humanReview.map((c) => <CandidateCard key={c.id} candidate={c} onDecision={load} />)}
        </>
      )}

      {!loading && autoApprove.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '16px 0 8px' }}>
            Auto-approve ({autoApprove.length})
          </div>
          {autoApprove.map((c) => <CandidateCard key={c.id} candidate={c} onDecision={load} />)}
        </>
      )}

      {!loading && hold.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '16px 0 8px' }}>
            On hold ({hold.length})
          </div>
          {hold.map((c) => <CandidateCard key={c.id} candidate={c} onDecision={load} />)}
        </>
      )}

      {!loading && autoReject.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '16px 0 8px' }}>
            Auto-reject ({autoReject.length})
          </div>
          {autoReject.map((c) => <CandidateCard key={c.id} candidate={c} onDecision={load} />)}
        </>
      )}
    </>
  );
}

// ─── Principles tab ───────────────────────────────────────────────────────────
function PrinciplesTab() {
  const [principles, setPrinciples] = useState(null);

  useEffect(() => {
    api.get('/admin/principles').then(({ data }) => setPrinciples(data)).catch(() => setPrinciples([]));
  }, []);

  if (!principles) return <div className="empty">Loading…</div>;

  return (
    <div className="games-list">
      {principles.map((p) => (
        <div key={p.id} style={{ padding: '10px 14px', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 2 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <span className="muted" style={{ fontSize: 11, marginRight: 8 }}>{p.id}</span>
              <strong>{p.name}</strong>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>{p.level} · {p.category}</span>
          </div>
          {p.themes?.length > 0 && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {p.themes.map((t) => (
                <code key={t} style={{ fontSize: 10, marginRight: 6, padding: '1px 5px', background: 'var(--bg-elev-2)', borderRadius: 2 }}>{t}</code>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Admin page ───────────────────────────────────────────────────────────────
export default function Admin() {
  const [tab, setTab] = useState('candidates');

  return (
    <>
      <div className="crumb">
        <Link to="/">← Dashboard</Link>
        {' / '}
        Admin
      </div>

      <StatsPanel />

      <section className="panel" style={{ marginTop: 22 }}>
        <div className="row" style={{ marginBottom: 18 }}>
          {['candidates', 'principles'].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                borderColor: tab === t ? 'var(--gold)' : undefined,
                color: tab === t ? 'var(--gold)' : undefined,
                textTransform: 'capitalize',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'candidates' && <CandidatesTab />}
        {tab === 'principles' && <PrinciplesTab />}
      </section>
    </>
  );
}