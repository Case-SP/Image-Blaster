// Model allowlists. Partitioning models by surface is part of the
// moat-protection policy (see learnings.md §15) — we don't give API-key
// callers access to experimental models we haven't tuned the prompt
// strategy for.

// Public (API-key callers): stable, prompt-tuned models. Experimental ones
// (gpt-image-2) are also listed but gated per-client via EXPERIMENTAL_MODEL_EMAILS
// — the surface allowlist makes them reachable; the per-client gate decides
// who actually gets to call them. Default-deny for any client not on the list.
const API_ALLOWED_MODELS = new Set([
  'fal-ai/nano-banana-pro',
  'fal-ai/flux-pro/kontext',
  'fal-ai/flux-pro/v1.1-ultra',
  'openai/gpt-image-2'
]);

// Internal (session/UI callers): same set as the API now that gpt-image-2 is
// in both. Kept as a separate constant in case the surfaces diverge again.
const SESSION_ALLOWED_MODELS = new Set([...API_ALLOWED_MODELS]);

const DEFAULT_MODEL = 'fal-ai/nano-banana-pro';

module.exports = { API_ALLOWED_MODELS, SESSION_ALLOWED_MODELS, DEFAULT_MODEL };
