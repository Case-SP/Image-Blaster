/**
 * Trace shape — documented here as a reference. JS, so no enforcement at runtime.
 *
 * {
 *   id: string,                       // "20260416-153000-abc"
 *   cartridge: string,
 *   status: "running" | "done" | "failed",
 *   startedAt: ISO, finishedAt: ISO|null,
 *   input: { titles: [{id,title,slug,category}], N, options },
 *   stages: {
 *     shotList:  { status, startedAt, finishedAt, model, elapsedMs, tokensUsed,
 *                  raw: {tid: {shots:[]}}, variance: {tid: {...}},
 *                  systemPromptChars, userPromptChars,
 *                  systemPrompt?, userPrompt? },
 *     critic:    { status, enabled, startedAt, finishedAt, model, elapsedMs,
 *                  revised: {tid: {shots:[]}}, diff: {tid: [...]} },
 *     resolved:  { status, startedAt, finishedAt,
 *                  prompts: {tid: [{prompt, composition, subject_phrase, slots_used, theme, ...}]},
 *                  promptVariance: {tid: {distinct, avgDistance}} },
 *     renders:   { status, startedAt, finishedAt,
 *                  items: {tid: [{promptIdx, filename, status, elapsedMs, error?}]} }
 *   },
 *   verdicts: { "<tid>/<filename>": { verdict, reasons, taggedAt } },
 *   error: string|null
 * }
 */
const EVENTS = {
  RUN_STARTED: 'run.started',
  STAGE_STARTED: 'stage.started',
  STAGE_UPDATED: 'stage.updated',
  STAGE_FINISHED: 'stage.finished',
  RENDER_ITEM: 'render.item',
  VERDICT_SET: 'verdict.set',
  RUN_FINISHED: 'run.finished',
  RUN_FAILED: 'run.failed'
};
module.exports = { EVENTS };
