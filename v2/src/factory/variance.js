/**
 * Variance metrics for a list of shots (per-title).
 * Shots are raw LLM selections: {composition, subject_type, subject_topic, theme, model_spec}
 */
function shotListVariance(shots) {
  if (!shots?.length) return { total: 0, score: 0 };
  const counts = { composition: {}, subject_type: {}, theme: {}, model_spec: {} };
  for (const s of shots) {
    for (const k of Object.keys(counts)) {
      const v = s[k] || '(null)';
      counts[k][v] = (counts[k][v] || 0) + 1;
    }
  }
  const distinct = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Object.keys(v).length]));
  const N = shots.length;
  const axes = ['composition', 'subject_type', 'theme', 'model_spec'];
  const score = axes.reduce((acc, k) => acc + Math.min(1, distinct[k] / N), 0) / axes.length;
  return { total: N, distinct, counts, score: Number(score.toFixed(3)) };
}

/**
 * Prompt-level variance: distinct prompt strings and average pairwise token-jaccard distance.
 */
function promptVariance(prompts) {
  if (!prompts?.length) return { total: 0, distinct: 0, avgDistance: 0 };
  const distinctSet = new Set(prompts);
  const tokens = prompts.map(p => new Set(p.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)));
  let total = 0, pairs = 0;
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const inter = [...tokens[i]].filter(x => tokens[j].has(x)).length;
      const union = new Set([...tokens[i], ...tokens[j]]).size;
      total += 1 - (union ? inter / union : 0);
      pairs += 1;
    }
  }
  return { total: prompts.length, distinct: distinctSet.size, avgDistance: pairs ? Number((total / pairs).toFixed(3)) : 0 };
}

/**
 * Diff between two shot lists (before vs after critic).
 */
function shotListDiff(before, after) {
  const out = [];
  const len = Math.max(before.length, after.length);
  for (let i = 0; i < len; i++) {
    const b = before[i], a = after[i];
    if (!b) { out.push({ idx: i, kind: 'added', after: a }); continue; }
    if (!a) { out.push({ idx: i, kind: 'removed', before: b }); continue; }
    const changedKeys = Object.keys({ ...b, ...a }).filter(k => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
    if (changedKeys.length) out.push({ idx: i, kind: 'changed', keys: changedKeys, before: b, after: a });
  }
  return out;
}

module.exports = { shotListVariance, promptVariance, shotListDiff };
