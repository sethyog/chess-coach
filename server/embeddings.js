// Term-frequency vector embedding + cosine similarity. Used by the principle
// candidate pipeline to detect near-duplicates against the live core.
//
// Why TF and not a dense semantic embedding (Voyage AI / OpenAI):
// - Zero new dependencies and zero new API keys.
// - The chess principles share a tightly controlled vocabulary, so word
//   overlap is a strong signal for duplicates. ("Castle your king early
//   for safety" vs "Castle early to protect your king" → ~0.75 cosine.)
// - The cache schema (principle_id, vector TEXT) is provider-agnostic. If
//   richer semantic matching is needed later, swap this module for a
//   Voyage/OpenAI client and regenerate the principle_embeddings cache;
//   no callers need to change.

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to',
  'was', 'were', 'will', 'with', 'you', 'your', 'do', 'so', 'not', 'they',
  'them', 'their', 'this', 'these', 'those', 'too', 'when', 'where',
  'which', 'while', 'every', 'any', 'all', 'into', 'before', 'after',
  'most', 'more', 'don', 's', 't',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Sorted-array vocab so the resulting vectors are deterministic given the
// same corpus, regardless of insertion order.
function buildVocab(corpus) {
  const set = new Set();
  for (const text of corpus) {
    for (const t of tokenize(text)) set.add(t);
  }
  return Array.from(set).sort();
}

function vectorize(text, vocab) {
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1);
  return vocab.map((term) => tf.get(term) || 0);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = { tokenize, buildVocab, vectorize, cosineSimilarity };