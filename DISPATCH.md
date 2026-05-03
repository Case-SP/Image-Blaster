# Dispatch — Nolla Image Client

State-of-the-project. Updated as work lands. Companion to `plan.md` (long-form architecture) and `learnings.md` (running log of what we've learned).

Cold start: `DISPATCH.md` (here, now) → `v2/cartridge/product/PLAN.md` (active cartridge plan) → `learnings.md` (history & lessons).

---

## What's running

- **Local server:** `npm start` → `http://localhost:3002`. Open mode (`AUTH_MODE=open` in `.env`) — single shared client, cartridge override per-request enabled.
- **UI:** `v2/ui-client/` (production-style flat-grid + product-cartridge funnel). Admin UI: `v2/ui/` at `/admin-ui`.
- **Cartridges:** `nolla` (default, title mode), `demo` (intake mode), `product` (object mode).
- **Models in cycle:** `nano` → `flux` → `gpt-2*` → `both*` → `all*` (stars are experimental — local open mode counts).

---

## Active work (what just shipped)

### 1. Product cartridge (object mode) — staged funnel
A new `input_mode: "object"` cartridge type that's deterministic (no LLM shot-list, no critic, no rewriter). The cartridge author declares a `style_order` and the orchestrator round-robins through it. The input title IS the subject, fused into the phrase bank verbatim. Per-style reference subfolders supported (`references/<composition>/*.{jpg,png,webp}`).

**Three-stage funnel UI** for the product cartridge only — `Sketch → Product → In-situ`. Pill input always feeds stage 1 (sketch). Promotion advances selected items to the next stage with a per-tile note panel ("walnut, matte" / "tatami room, shoji light"). Notes fuse into the phrase bank for each promoted parent. Per-tile **amplify** and per-column **+ more** for volume.

Other cartridges keep the flat grid + lightbox + multi-select zip download.

### 2. flux endpoint correction
"flux" UI label was pointing at `fal-ai/flux-pro/kontext`, which is an *image-edit* model that requires an `image_url` input — every from-scratch run 422'd. Switched to `fal-ai/flux-pro/v1.1-ultra` (text-to-image). Live-tested both endpoints to confirm.

`fal.js` per-model field name shaping added so kontext (when wired in later for parent-image editing) gets `image_url` (singular) and nano-banana-pro keeps `image_urls` (plural array, multi-image style conditioning).

### 3. Reference-image audit (per model)
Live-tested with a real cartridge ref to verify what each model actually receives:

| Model | Refs | Field | Notes |
|---|---|---|---|
| nano-banana-pro | ✓ multi (up to 8) | `image_urls` | Gemini's response includes a description field — proves it parses the input |
| flux-pro/kontext | ✓ single | `image_url` | not yet wired into UI; reserved for parent-image editing in promote/amplify |
| flux-pro/v1.1-ultra | ✗ | — | pure text-to-image |
| gpt-image-2 | ✗ | — | text-only |

Each render now records `refsAttached` and `refsAvailable` in the trace for visibility.

### 4. Liquid-glass top bar + bouncy grid
Pill input + bubbles (cartridge / N / model / download-selected) live as discrete liquid-glass capsules — translucent fill, 28px backdrop blur, inner highlight. No bar behind them.

Apple-style spring hover on grid tiles (`cubic-bezier(0.34, 1.56, 0.64, 1)`). Click → lightbox with prompt + model + composition. Multi-select downloads via `POST /api/public/zip-selection` (server-side streaming archiver).

---

## What's next (queued)

The product cartridge has a multi-phase plan in `v2/cartridge/product/PLAN.md`. Active priority order:

1. **Material registers** — mirror nolla's body-region pattern. Each input auto-tags with one or more materials (wood-light, wood-dark, suede, ceramic-glazed, glass-milky, mixed). Material drives a `{material}` slot inside compositions. Skin-style for objects.
2. **Palette anchors** — small palette set on the cartridge (sage-clay, terracotta-oak, charcoal-concrete, olive-bone, milk-glass-brass). Lock one palette per title across all three styles for visual continuity. Same shape as nolla theme-lock.
3. **Macro-detail compositions** — add `macro-material` (extreme close on weave/joinery/finish) and `mixed-materials` (two-material studies) to product-shot.
4. **Kontext-as-edit-model on promote** — when promoting from sketch → product, optionally route through kontext with the sketch as `image_url` so the product shot inherits the sketch's geometry. Per-composition model override on the cartridge.
5. **Collections** — group inputs to share palette + material register + environment family.
6. **Per-object dossier (Option D)** — once an object accumulates images across all three stages, click the object name to open a dossier of just that object's lineage.

---

## Repo orientation

- `v2/src/orchestrator.js` — owns input modes (`title`, `intake`, `object`), stage routing, parent lineage, ref filtering per composition.
- `v2/src/factory/cartridge.js` — loads `references/<style>/*` subfolders and tags each ref with its parent dir.
- `v2/src/factory/shotList.js` — title-mode LLM shot-list + sanitizer (Nolla-specific). Object mode bypasses it.
- `v2/src/factory/grammar.js` — slot sampler + prompt builder.
- `v2/src/render/fal.js` — fal.run client. Per-model payload shaping + per-model retry policy.
- `v2/src/routes/public.js` — UI surface. `runs`, `runs/:id`, `runs/:id/zip`, `zip-selection`, `events` (SSE), `cartridges`.
- `v2/ui-client/` — production-style UI. `app.js` is one file; flat-grid + funnel both live there with cartridge-aware branching.
- `v2/cartridge/<name>/` — cartridge data (`profile.json`, `compositions.json`, `subjects.json`, `themes.json`, optional `palette.json`, `suffix.md`, `studio-rules.md`, `guardrails.md`, `references/`).

## Local commands

```
npm start                   # serve on :3002
npm run dev                 # auto-reload via node --watch
node --test v2/src/...      # run unit tests
```

## Environment

`.env` at repo root — `AUTH_MODE=open` for local dev; `FAL_KEY` required; `EXPERIMENTAL_MODEL_EMAILS` to gate gpt-2/both/all in non-open mode; `OPEN_MODE_CARTRIDGE` to set the default cartridge; `REF_BUDGET` to override the per-render ref count (default 8).
