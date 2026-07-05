'use strict';

const { query } = require('./db');

// How many consecutive recent batches without a principle before it is considered RESOLVED.
const RESOLVED_THRESHOLD = 2;

// Load all completed batches for user+format, group patterns by principleId
// (excluding "OTHER"), and compute per-principle progression state.
//
// Returns { canCompute: false, totalBatches } when < 2 batches exist.
// Returns {
//   canCompute, format, totalBatches, maxBatchNumber,
//   counts: { NEW, IMPROVING, RECURRING, RESOLVED },
//   principles: [ { principleId, principleName, coachSummary, state,
//                   fullHistory, mostRecentFreq, maxHistoricalFreq,
//                   recentAbsence, comparisonLine } ]
// }
async function computeProgression(userId, format) {
  const { rows: paRows } = await query(
    `SELECT pa.batch_number, pa.results
     FROM pattern_analyses pa
     JOIN analysis_batches ab ON ab.id = pa.batch_id
     WHERE pa.user_id = $1 AND pa.format = $2
       AND ab.status = 'completed'
     ORDER BY pa.batch_number ASC`,
    [userId, format]
  );

  if (paRows.length < 2) {
    return { canCompute: false, totalBatches: paRows.length };
  }

  const batches = [];
  for (const row of paRows) {
    try {
      const results = JSON.parse(row.results);
      batches.push({ batchNumber: row.batch_number, patterns: results.patterns || [] });
    } catch { /* skip malformed rows */ }
  }

  if (batches.length < 2) {
    return { canCompute: false, totalBatches: batches.length };
  }

  const maxBatchNumber = batches[batches.length - 1].batchNumber;
  const allBatchNumbers = batches.map(b => b.batchNumber);

  // Collect per-principle history. Keep the latest non-empty coachSummary.
  const principleMap = new Map();
  for (const batch of batches) {
    for (const pattern of batch.patterns) {
      if (pattern.principleId === 'OTHER') continue;
      if (!principleMap.has(pattern.principleId)) {
        principleMap.set(pattern.principleId, {
          principleId: pattern.principleId,
          principleName: pattern.principleName,
          coachSummary: pattern.coachSummary || '',
          history: [],
        });
      }
      const entry = principleMap.get(pattern.principleId);
      entry.history.push({ batchNumber: batch.batchNumber, frequency: pattern.frequency });
      if (pattern.coachSummary) entry.coachSummary = pattern.coachSummary;
    }
  }

  const principles = [];
  for (const [, data] of principleMap) {
    const { principleId, principleName, coachSummary, history } = data;
    const freqByBatch = new Map(history.map(h => [h.batchNumber, h.frequency]));

    // fullHistory spans ALL batches for this format (0 = absent) — used for sparklines.
    const fullHistory = allBatchNumbers.map(bn => ({
      batchNumber: bn,
      frequency: freqByBatch.get(bn) || 0,
    }));

    const mostRecentFreq = freqByBatch.get(maxBatchNumber) || 0;
    const maxHistoricalFreq = Math.max(...history.map(h => h.frequency));

    // Count consecutive absent batches counting backwards from the most recent batch.
    let recentAbsence = 0;
    for (let i = allBatchNumbers.length - 1; i >= 0; i--) {
      if ((freqByBatch.get(allBatchNumbers[i]) || 0) === 0) {
        recentAbsence++;
      } else break;
    }

    // State computation — order of checks matters.
    let state;
    if (history.length === 1 && history[0].batchNumber === maxBatchNumber) {
      // Only ever seen in the most recent batch.
      state = 'NEW';
    } else if (recentAbsence >= RESOLVED_THRESHOLD) {
      // Absent from the last RESOLVED_THRESHOLD or more batches.
      state = 'RESOLVED';
    } else if (recentAbsence >= 1) {
      // Absent from 1 recent batch but not enough to call resolved — trending away.
      state = 'IMPROVING';
    } else if (mostRecentFreq < maxHistoricalFreq) {
      // Present in latest batch but at a lower frequency than historical peak.
      state = 'IMPROVING';
    } else {
      // Present in latest batch at or above historical peak.
      state = 'RECURRING';
    }

    // Human-readable line used by the UI (Surface 2 badge and Surface 3 sparkline row).
    let comparisonLine = null;
    if (state === 'IMPROVING' && recentAbsence === 0) {
      comparisonLine = `down from ${maxHistoricalFreq} occurrence${maxHistoricalFreq === 1 ? '' : 's'} at peak`;
    } else if (state === 'IMPROVING' && recentAbsence >= 1) {
      comparisonLine = `not seen in your last ${recentAbsence} batch${recentAbsence === 1 ? '' : 'es'}`;
    } else if (state === 'RECURRING') {
      comparisonLine = `steady across your last ${history.length} batch${history.length === 1 ? '' : 'es'}`;
    } else if (state === 'RESOLVED') {
      comparisonLine = `not seen in your last ${recentAbsence} batch${recentAbsence === 1 ? '' : 'es'}`;
    }

    principles.push({
      principleId,
      principleName,
      coachSummary,
      state,
      fullHistory,
      mostRecentFreq,
      maxHistoricalFreq,
      recentAbsence,
      comparisonLine,
    });
  }

  // Sort: RECURRING first (most urgent), then NEW, IMPROVING, RESOLVED.
  // Within each state, sort by most recent frequency descending.
  const stateOrder = { RECURRING: 0, NEW: 1, IMPROVING: 2, RESOLVED: 3 };
  principles.sort((a, b) => {
    const so = stateOrder[a.state] - stateOrder[b.state];
    if (so !== 0) return so;
    return b.mostRecentFreq - a.mostRecentFreq;
  });

  const counts = { NEW: 0, IMPROVING: 0, RECURRING: 0, RESOLVED: 0 };
  for (const p of principles) counts[p.state]++;

  return { canCompute: true, format, totalBatches: batches.length, maxBatchNumber, principles, counts };
}

// Generate a plain-language coach narrative from the computed progression and
// cache it in progression_summaries. Called ONLY from the batch-completion
// path — never from a GET handler. One LLM call per new batch per format.
async function generateAndCacheProgressionSummary(userId, format) {
  const result = await computeProgression(userId, format);
  if (!result.canCompute) return null;

  const { principles, totalBatches } = result;

  const fmt = (list) =>
    list.length === 0 ? 'none' : list.map(p => p.principleName).join(', ');

  const prompt = `You are a warm, encouraging chess coach. Write a 3–4 sentence narrative summary of this student's progress across their last ${totalBatches} batches of ${format} games.

PROGRESSION DATA:
- Recurring (still present, not improving yet): ${fmt(principles.filter(p => p.state === 'RECURRING'))}
- Improving (trending down or recently absent): ${fmt(principles.filter(p => p.state === 'IMPROVING'))}
- Resolved (no longer appearing — worth celebrating): ${fmt(principles.filter(p => p.state === 'RESOLVED'))}
- New this batch: ${fmt(principles.filter(p => p.state === 'NEW'))}

Tone rules:
- Celebrate resolved weaknesses genuinely
- For recurring patterns use "still working on" language, not "keep failing"
- Be specific about which patterns are improving vs. stuck
- End with one actionable coaching focus for the next batch
- Plain English only — no centipawn numbers or engine terms
- Return only the narrative, no preamble or labels`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '<no body>');
    throw new Error(`Anthropic ${resp.status}: ${errBody}`);
  }

  const data = await resp.json();
  const summary = data.content?.[0]?.text?.trim() || '';

  await query(
    `INSERT INTO progression_summaries (user_id, format, last_batch_number, summary)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, format)
     DO UPDATE SET last_batch_number = EXCLUDED.last_batch_number,
                   summary           = EXCLUDED.summary,
                   generated_at      = NOW()`,
    [userId, format, result.maxBatchNumber, summary]
  );

  console.log(`[progression] cached summary for user=${userId} format=${format} batch=${result.maxBatchNumber}`);
  return summary;
}

module.exports = { computeProgression, generateAndCacheProgressionSummary, RESOLVED_THRESHOLD };
