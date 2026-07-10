import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';

const FORMAT_TABS = [
  { key: 'classical', label: 'Classical' },
  { key: 'rapid',     label: 'Rapid'     },
  { key: 'bullet',    label: 'Bullet'    },
];

// State badge appearance
const STATE_CONFIG = {
  RECURRING: { label: 'Recurring',    color: 'var(--gold)',     border: 'var(--gold)'                   },
  IMPROVING: { label: 'Improving ↑',  color: 'var(--green)',    border: 'var(--green)'                  },
  RESOLVED:  { label: 'Resolved ✓',   color: 'var(--green)',    border: 'var(--green)'                  },
  NEW:       { label: 'New',          color: 'var(--text-dim)', border: 'var(--border)'                 },
};

// SVG bar chart: one bar per batch, oldest left → newest right.
// height proportional to frequency (0 = absent, shown as a faint stub).
function Sparkline({ history }) {
  const BAR_W   = 12;
  const BAR_GAP = 5;
  const MAX_H   = 30;
  const STUB_H  = 2;

  const maxFreq = Math.max(...history.map(h => h.frequency), 1);
  const svgW    = history.length * (BAR_W + BAR_GAP) - BAR_GAP;

  return (
    <svg
      width={svgW}
      height={MAX_H}
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden="true"
    >
      {history.map((h, i) => {
        const x    = i * (BAR_W + BAR_GAP);
        const barH = h.frequency > 0
          ? Math.max(Math.round((h.frequency / maxFreq) * MAX_H), 4)
          : STUB_H;
        const y    = MAX_H - barH;
        return (
          <rect
            key={h.batchNumber}
            x={x} y={y}
            width={BAR_W} height={barH}
            rx={1}
            fill={h.frequency > 0 ? 'var(--gold-dim)' : 'var(--border)'}
          />
        );
      })}
    </svg>
  );
}

function StateBadge({ state }) {
  const cfg = STATE_CONFIG[state] || STATE_CONFIG.NEW;
  return (
    <span
      className="tag"
      style={{ color: cfg.color, borderColor: cfg.border, flexShrink: 0 }}
    >
      {cfg.label}
    </span>
  );
}

function CountsRow({ counts, totalBatches }) {
  const items = [
    { key: 'RECURRING', label: 'Recurring', color: 'var(--gold)'     },
    { key: 'NEW',       label: 'New',       color: 'var(--text-dim)' },
    { key: 'IMPROVING', label: 'Improving', color: 'var(--green)'    },
    { key: 'RESOLVED',  label: 'Resolved',  color: 'var(--green)'    },
  ];
  return (
    <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      {items.map(({ key, label, color }) => (
        <div key={key}>
          <div style={{ fontFamily: 'var(--font-head)', fontSize: 24, color, lineHeight: 1 }}>
            {counts[key]}
          </div>
          <div
            className="muted"
            style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 4 }}
          >
            {label}
          </div>
        </div>
      ))}
      <div style={{ marginLeft: 'auto' }}>
        <div
          className="muted"
          style={{ fontSize: 12, textAlign: 'right' }}
        >
          across {totalBatches} batch{totalBatches === 1 ? '' : 'es'}
        </div>
      </div>
    </div>
  );
}

function PrincipleCard({ principle }) {
  const {
    principleName, state, fullHistory,
    maxHistoricalFreq, recentAbsence, comparisonLine,
  } = principle;

  return (
    <section className="panel" style={{ marginTop: 10 }}>
      {/* Header: name + badge */}
      <div
        className="row"
        style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}
      >
        <h3 style={{ margin: 0 }}>{principleName}</h3>
        <StateBadge state={state} />
      </div>

      {/* Sparkline + comparison text */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginTop: 14 }}>
        <div>
          <div
            className="muted"
            style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}
          >
            Batch 1 → {fullHistory.length}
          </div>
          <Sparkline history={fullHistory} />
        </div>
        {comparisonLine && (
          <div className="muted" style={{ fontSize: 12, paddingBottom: 2 }}>
            {comparisonLine}
          </div>
        )}
      </div>

      {/* Resolved milestone */}
      {state === 'RESOLVED' && (
        <div
          style={{
            marginTop: 12,
            padding: '8px 12px',
            background: 'rgba(61,184,122,0.07)',
            border: '1px solid rgba(61,184,122,0.25)',
            borderRadius: 2,
            fontSize: 12,
            color: 'var(--green)',
          }}
        >
          You've beaten this — not seen in your last {recentAbsence}{' '}
          batch{recentAbsence === 1 ? '' : 'es'}.
        </div>
      )}
    </section>
  );
}

// ── Per-format tab content ────────────────────────────────────────────────────

function FormatProgressContent({ format, cache }) {
  const label = { classical: 'Classical', rapid: 'Rapid', bullet: 'Bullet' }[format] || format;

  const [showProgressionHint] = useState(() => {
    const seen = localStorage.getItem('hint_seen_progression') === 'true';
    if (!seen) localStorage.setItem('hint_seen_progression', 'true');
    return !seen;
  });

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

  const { data } = cache;

  if (!data.canCompute) {
    return (
      <div className="panel">
        <h2 style={{ marginBottom: 8 }}>{label} progression</h2>
        <div className="empty" style={{ paddingTop: 20 }}>
          Play more {label.toLowerCase()} games to see your progression — you need at
          least 2 analysis batches to track trends.
          {data.totalBatches === 1 && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              You have 1 batch. One more and we can show you how your weaknesses are trending.
            </div>
          )}
        </div>
      </div>
    );
  }

  const { principles, counts, totalBatches, coachSummary } = data;

  return (
    <>
      {/* Summary panel: counts + cached coach narrative */}
      <section className="panel">
        {showProgressionHint && (
          <div
            style={{
              padding: '10px 14px',
              marginBottom: 16,
              border: '1px solid var(--border)',
              borderRadius: 2,
              background: 'rgba(240, 192, 96, 0.04)',
              fontSize: 12,
              color: 'var(--text-dim)',
              lineHeight: 1.55,
            }}
          >
            Watch your weaknesses shrink over time — proof that the work is paying off, one batch of games at a time.
          </div>
        )}
        <CountsRow counts={counts} totalBatches={totalBatches} />

        {coachSummary && (
          <div
            style={{
              borderTop: '1px solid var(--border)',
              marginTop: 18,
              paddingTop: 16,
              lineHeight: 1.7,
            }}
          >
            {coachSummary}
          </div>
        )}
      </section>

      {/* Weakness list header */}
      <div
        style={{
          margin: '24px 0 0',
          fontSize: 11,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
          borderBottom: '1px solid var(--border)',
          paddingBottom: 8,
        }}
      >
        {principles.length} tracked weakness{principles.length === 1 ? '' : 'es'}
      </div>

      {principles.length === 0 ? (
        <section className="panel">
          <div className="empty">No recurring patterns found across your batches.</div>
        </section>
      ) : (
        principles.map(p => <PrincipleCard key={p.principleId} principle={p} />)
      )}
    </>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Progression() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFormat = FORMAT_TABS.some(t => t.key === searchParams.get('format'))
    ? searchParams.get('format')
    : 'classical';

  const [selectedFormat, setSelectedFormat] = useState(initialFormat);

  // Per-format cache: { [fmt]: { state: 'loading'|'ready'|'error', data, error } }
  const [formatCache, setFormatCache] = useState({});

  useEffect(() => {
    loadFormat(initialFormat);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadFormat(fmt) {
    if (formatCache[fmt]) return;
    setFormatCache(prev => ({ ...prev, [fmt]: { state: 'loading', data: null, error: '' } }));
    try {
      const { data } = await api.get(`/coach/progression?format=${fmt}`);
      setFormatCache(prev => ({ ...prev, [fmt]: { state: 'ready', data, error: '' } }));
    } catch (err) {
      setFormatCache(prev => ({
        ...prev,
        [fmt]: {
          state: 'error',
          data: null,
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

  return (
    <>
      <div className="crumb">
        <Link to="/">← Dashboard</Link>
        {' / '}
        <Link to="/patterns">Pattern analysis</Link>
        {' / '}
        Progress
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

      <FormatProgressContent
        format={selectedFormat}
        cache={formatCache[selectedFormat]}
      />
    </>
  );
}
