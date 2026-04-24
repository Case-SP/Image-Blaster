// Model allowlists. Partitioning models by surface is part of the
// moat-protection policy (see learnings.md §15) — we don't give API-key
// callers access to experimental models we haven't tuned the prompt
// strategy for.

// Public (API-key callers): only stable, prompt-tuned models.
const API_ALLOWED_MODELS = new Set([
  'fal-ai/nano-banana-pro',
  'fal-ai/flux-pro/kontext',
  'fal-ai/flux-pro/v1.1-ultra'
]);

// Internal (session/UI callers): everything the API supports, plus
// experimental models we're actively tuning prompts for.
const SESSION_ALLOWED_MODELS = new Set([
  ...API_ALLOWED_MODELS,
  'fal-ai/gpt-image-1',   // fal-hosted OpenAI image model (gpt-image-2 once fal exposes it)
  'fal-ai/openai/gpt-image-2'
]);

const DEFAULT_MODEL = 'fal-ai/nano-banana-pro';

module.exports = { API_ALLOWED_MODELS, SESSION_ALLOWED_MODELS, DEFAULT_MODEL };
