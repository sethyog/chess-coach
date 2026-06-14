'use strict';

// Fact-adherence eval: runs the three checks from fact_checks.js against
// coaching replies (stored or live) and reports violations by type.
//
// Set EVALS_LIVE_API=1 to call the real Anthropic API and get fresh replies.
// Default: uses stored_reply from coaching_cases.json (fast, deterministic,
// no API key needed for CI).

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { buildPositionFacts } = require('../../position-facts');
const { buildVerifiedFactsPrompt } = require('../../coaching-prompt');
const { runAllChecks } = require('./fact_checks');
const cases = require('../datasets/coaching_cases.json');

const USE_LIVE_API = process.env.EVALS_LIVE_API === '1';

// Call the Anthropic API with the full coaching system prompt for one case.
async function getLiveReply(c, facts) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot use EVALS_LIVE_API=1');
  }
  const systemPrompt = buildVerifiedFactsPrompt({
    facts,
    profile: null,
    principleViolated: null,
  });
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'What should I have done differently here?' }],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text || '';
}

async function runCase(c) {
  // Build verified position facts from the FEN — same code path as production.
  const facts = buildPositionFacts({
    fenBefore: c.fen,
    playedMoveSan: c.played_move,
    classification: c.classification || null,
    centipawnLoss: c.centipawn_loss || null,
  });

  if (!facts.ok) {
    return {
      id: c.id,
      pass: false,
      skipped: false,
      reply: null,
      source: 'error',
      violations: { piece_position: [], side_to_move: [], move_legality: [] },
      failures: [`buildPositionFacts failed: ${facts.error}`],
    };
  }

  let replyText;
  let source;
  if (USE_LIVE_API) {
    try {
      replyText = await getLiveReply(c, facts);
      source = 'live_api';
    } catch (err) {
      return {
        id: c.id,
        pass: false,
        skipped: false,
        reply: null,
        source: 'error',
        violations: { piece_position: [], side_to_move: [], move_legality: [] },
        failures: [`Live API call failed: ${err.message}`],
      };
    }
  } else {
    replyText = c.stored_reply;
    source = 'stored';
  }

  const checks = runAllChecks(replyText, facts);

  const actualViolationTypes = [];
  if (!checks.piece_position.pass) actualViolationTypes.push('piece_position');
  if (!checks.side_to_move.pass) actualViolationTypes.push('side_to_move');
  if (!checks.move_legality.pass) actualViolationTypes.push('move_legality');

  const expectedViolations = new Set(c.expected_violations || []);
  const actualViolations = new Set(actualViolationTypes);

  const failures = [];

  // In STORED mode: we know the expected violations — enforce exact match.
  // In LIVE mode: we can't know expected violations ahead of time — just
  // report any violations found (the zero-violations target is aspirational).
  if (!USE_LIVE_API) {
    for (const expected of expectedViolations) {
      if (!actualViolations.has(expected)) {
        failures.push(`Expected violation "${expected}" was not detected`);
      }
    }
    for (const actual of actualViolations) {
      if (!expectedViolations.has(actual)) {
        const detail = [
          ...checks.piece_position.violations,
          ...checks.side_to_move.violations,
          ...checks.move_legality.violations,
        ].find((v) => v.toLowerCase().includes(actual.replace('_', ' ')));
        failures.push(
          `Unexpected violation "${actual}" was detected${detail ? `: ${detail}` : ''}`
        );
      }
    }
  }

  return {
    id: c.id,
    pass: failures.length === 0,
    skipped: false,
    reply: replyText,
    source,
    violations: {
      piece_position: checks.piece_position.violations,
      side_to_move: checks.side_to_move.violations,
      move_legality: checks.move_legality.violations,
    },
    failures,
  };
}

async function run() {
  const results = [];
  for (const c of cases) {
    results.push(await runCase(c));
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  // Aggregate violation counts across all cases
  const totalViolations = {
    piece_position: results.flatMap((r) => r.violations?.piece_position || []).length,
    side_to_move: results.flatMap((r) => r.violations?.side_to_move || []).length,
    move_legality: results.flatMap((r) => r.violations?.move_legality || []).length,
  };

  if (require.main === module) {
    console.log(`\n── coaching_adherence (${USE_LIVE_API ? 'LIVE API' : 'stored replies'}) ────────────────────────`);
    for (const r of results) {
      const icon = r.pass ? 'PASS' : 'FAIL';
      console.log(`  ${icon}  ${r.id} [${r.source}]`);
      if (!r.pass) {
        for (const f of r.failures) console.log(`        ✗ ${f}`);
        const allV = [
          ...r.violations.piece_position,
          ...r.violations.side_to_move,
          ...r.violations.move_legality,
        ];
        for (const v of allV) console.log(`        · ${v}`);
      }
    }
    console.log(`\n  Violation counts across ${total} cases:`);
    console.log(`    piece_position: ${totalViolations.piece_position}`);
    console.log(`    side_to_move:   ${totalViolations.side_to_move}`);
    console.log(`    move_legality:  ${totalViolations.move_legality}`);
    console.log(`\n  ${passed}/${total} passed`);
  }

  return { name: 'coaching_adherence', total, passed, skipped: 0, results, totalViolations };
}

module.exports = { run };

if (require.main === module) run();
