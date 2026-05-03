# Learnings — Nolla Image Client

A running log of what we've learned about getting **diverse, on-brand, usable** images at scale. Updated as we ship and observe output.

---

## 1. The diversity crisis is architectural, not a prompt problem

### What we observed
Looking at `output/generations/does-creatine-cause-hair-loss/` (15 generations), **multiple `gen-*.png.json` files contain byte-identical prompts** differing only by theme (`golden-hour`, `sage-green`, `cool-white`). Cross-title, the same `subject_fill` (e.g. `"creatine capsules"`, `"dairy-free moisturizer"`) recurs verbatim.

### Root cause
`generateBatchPrompts()` produces **one prompt per title**. Then `generateForTitle()` calls `generateSingleImage()` N times with the **same `promptData` object** — the only thing that changes between renders is the fal.ai seed and (optionally) the session theme.

```
Title → 1 LLM call → 1 prompt → N renders (same prompt, different seed)
```

**Implication:** the image model is being asked to be the diversity engine. It's not. Nano-banana on seed variation produces near-duplicates. Even Flux falls into near-duplicates on a tight prompt.

### The fix pattern (untested)
```
Title → 1 LLM call → N distinct prompts → N renders
```
Have the LLM propose a **shot list** per title (5–10 distinct compositions) instead of one selection. This is the single highest-leverage change for the 70/100 KPI.

---

## 2. Most of the authored "prompt strategy" is dead code

### What's actually running
`generateBatchPrompts()` (src/server/api/openrouter.js:339) has its own hardcoded system prompt with wellness-blog-specific rules (50/50 person/product, skincare vocab, etc.).

### What's authored but NOT wired in
- `config/studio-rules.md` — loaded by `loadStudioRules()`, exported, **never passed into the live prompt path**
- `config/client/profile.json` (Nolla brand DNA, mandatory elements, forbidden list) — loaded, **never reaches the LLM**
- `config/client/guardrails.md` — loaded, **never reaches the LLM**
- `config/archetypes.json` (90+ archetypes) — **unused**; the system migrated to `subjects.json` + `compositions.json` but never deleted the archetype library
- `buildTieredSystemPrompt()` — defined and exported, **no caller**
- `settings.masterSuffixes.person` / `.product` — defined, **not referenced anywhere in openrouter.js or fal.js**

### Implication
The "tiered" architecture (Studio Rules → Client Profile → Style References → Category) the code suggests **does not exist in the runtime**. What runs is a single hardcoded system prompt plus category suffix plus theme.

This is why brand-specific guidance feels inert: the LLM never sees it.

---

## 3. Theme-locking unifies the batch at the cost of per-title diversity

Session theme (`sessionTheme` in src/server/index.js:119) is set once per session and applied to **every** image in the batch. Good for portfolio coherence, bad for hit-rate:

- When the theme doesn't fit a specific title, every rendering for that title is wrong in the same way.
- A title gets 10 shots at goal with **all 10 locked into the same background**.

**Tradeoff to explore:** unlock theme per-title (keep 1–2 candidate themes per title, chosen by the LLM) while keeping batch coherence via palette/lighting rather than literal background color.

---

## 4. `subject_fill` is the biggest hidden repetition vector

`subject_fill` is free-text 2–4 words chosen by the LLM. For a single topic ("creatine") across the batch and across re-renders, the LLM reliably returns `"creatine capsules"` or `"creatine powder"`. The composition template then anchors the whole image to that phrase.

**Lever:** pre-compute a list of valid subject noun-phrases per topic (e.g. creatine → `"white crystalline powder"`, `"scoop of fine powder"`, `"clear water glass with dissolving tablet"`, `"single capsule"`, `"blister pack"`) and have the LLM **pick from a list**, not invent. This also transfers across brands: you swap the noun-phrase bank, keep the compositions.

---

## 5. Composition templates are too rigid

Each composition in `compositions.json` is a single string template. `overhead-scatter` always renders as *"{subject} scattered artfully, directly overhead bird's eye view, flat lay composition"*. No variance on surface, light direction, density, cropping, motion.

**Lever:** turn each composition into a **grammar** (template with slotted modifiers):

```json
"overhead-scatter": {
  "skeleton": "{subject} scattered, overhead bird's eye, {surface}, {density}, {light}",
  "slots": {
    "surface": ["linen cloth", "marble slab", "raw plaster", "...", "..."],
    "density": ["sparse with negative space", "overlapping abundance", "..."],
    "light": ["hard raking side light", "soft diffused overhead", "..."]
  }
}
```

One composition = many concrete prompts. Diversity compounds multiplicatively.

---

## 6. Person-shot prompts have no "variation axes" declared

For `person-beauty`, the LLM picks `model: "Black woman"` (ethnicity + gender). That's the only variance. Missing: age, hair, expression, wardrobe, skin finish, gaze direction, crop height, mood modifier. The model defaults to the same editorial-beauty look because the prompt defaults are flat.

**Known weak spots from looking at generations:**
- Portraits trend toward narrow age range (~25–35)
- Same direct-gaze, dewy-skin, centered-crop pattern
- "Skin texture visible" is requested but output often looks smoothed

---

## 7. Category suffixes are adding repetition, not character

Every category suffix ends with `"no labels, no text, no product branding"` and variations of `"no plants, no foliage, no greenery"`. These appear in **every single prompt**. The negative clauses are load-bearing (we'd get stock-photo smoothies without them) but they also occupy a lot of the prompt and drown out style hints.

**Open question:** does the image model actually respect the negatives, or are we paying prompt-length cost for placebo? Worth A/B testing with and without.

---

## 8. The LLM batcher is cost-efficient, but losing instructions

Batch size is 30 titles per OpenRouter call using Haiku (cheap model). Pros: cheap, fast. Cons: at 30 titles, the LLM often:
- Drifts away from the 50/50 person/product target (observed clustering into one mode)
- Repeats compositions within the batch despite the rule against it
- Picks default subject_fills for all titles in a category

**Lever:** after batch generation, run a **critic pass** (same LLM) that inspects the batch JSON and forces re-rolls on repeats. Or batch smaller (10) with explicit variance budgets.

---

## 9. Model behavior notes (add as we learn)

### nano-banana-pro (current default)
- Fast, cheap, decent beauty portraits
- Tends to smooth skin texture even when asked for macro detail
- Respects "no text" reasonably well
- Shallow DOF is weak — deep focus by default
- _(fill in more as we test)_

### flux-2-pro / flux-1.1-ultra
- _(not yet stress-tested against nano)_

### seedream 4.5
- _(untested in current batch)_

---

## 10. What "usable" actually means (still to define)

Current KPI aspiration: **70 of 100 usable**. We haven't defined "usable." Candidate rubric, to be refined:
1. On-brand (palette + mood match the brand cartridge)
2. Title-relevant (subject or mood connects to the post)
3. Free of model failure (warped hands, text artifacts, melted faces)
4. Distinctive (not a near-duplicate of another winner in the same batch)

Until this rubric is written down, the KPI is vibes. Propose: after every generation batch, tag each output `usable | not-usable | winner` and record the reason. Over time this becomes the training signal for both the prompt factory and the critic pass.

---

## 11. Unused knobs worth wiring up

| Knob | Status | Leverage |
|---|---|---|
| `archetypes.json` (90+ archetypes) | dead code | **high** if we merge into compositions as variations |
| `client/profile.json` brand DNA | loaded, not passed to LLM | **high** — this is where brand voice lives |
| `masterSuffixes.person/product` | defined, never referenced | medium — could de-dupe suffix logic |
| `buildTieredSystemPrompt()` | exported, no caller | low — ghost architecture, decide keep/delete |
| `studio-rules.md` | loaded, not passed | medium — useful floor rules |
| Reference images | supported in `nano-banana-pro` + `kontext` | **high, untested** — load 3–5 brand refs, let the model anchor style |

---

## 12. Generalizing beyond Nolla — the actual product

Nolla is the test instance. The real product is a **prompt-engineering system that turns a cartridge + a list of titles into a high-hit-rate stream of on-brand images**. Every improvement we make against Nolla's outputs should be audited for whether it generalizes.

### Axes the system must handle for ANY brand

1. **Subject extraction** — pull physical nouns from a title, map them to subject types in the cartridge. ✓ Working (substance/device/food cases all resolved correctly for Nolla).
2. **Body-region awareness** — when a title references anatomy, the image should frame that anatomy. First iteration (phrase banks per region) worked for face regions + theme-lock at N≤5, but composition slots still slipped for non-face regions (back, shoulder). Second iteration adds slot overrides + face-only composition substitution.
3. **Series coherence per title** — N shots for one title should read as a set (one palette), while the batch across titles stays varied. Shipped via theme-lock at N≤5. Holds up at 3/title. Untested at 10/title.
4. **Hybrid compositions** — person + visible product is the highest-hitting frame in wellness/beauty. Probably not the right hybrid in other domains (tech, food, fashion). Cartridge-level setting — not system-wide.
5. **Palette adherence** — references + theme + suffix enforce this jointly. Strongest single lever for brand fidelity.

### What doesn't generalize (Nolla-specific guesses)

- The person/product 50/50 default is a wellness-blog assumption. A wine brand cartridge would want 90% product. A dating app would want 95% person. **This should be a cartridge parameter** (`person_product_ratio_target`), not a system default.
- The "apply-product-visible" hybrid composition is beauty-specific. Other brands need other hybrids (a tech brand might have "product-in-hand-using-it," a fashion brand might have "product-worn-walking").
- The model diversity rule (vary ethnicity + gender) is universal for person shots, but the *distribution* may not be — a French luxury brand might target mostly European models; a Black-owned beauty brand might target 80%+ Black models. **Also cartridge-level.**

### The meta-learning

Every time we fix a Nolla-specific issue, we're either:
- Teaching the system a general principle (good — ship it to the engine) → e.g. body-region slot overrides
- Hard-coding a Nolla value (bad — belongs in the cartridge) → e.g. "apply-product-visible" composition being whitelisted globally

The test when adding a new feature: **"Would a non-beauty brand need exactly this, or a different flavor of this?"** If different-flavor, make it cartridge-configurable from the start.

---

## 13. Auth delivery is a product surface, not a checkbox

We burned ~48h on "users can't sign in" problems that had nothing to do with our code. The takeaways compound across any future deploy.

### The Resend sandbox trap

Supabase OTP was wired up correctly and returning a believable error (`"Error sending magic link email"`), but new users got 500s while the project owner's email worked. Root cause: the SMTP sender was set to `onboarding@resend.dev`, Resend's **sandbox sender**, which will *only* deliver to the Resend account owner's email. Every other recipient bounces. The error looked generic and was easy to misread as "Supabase is broken" or "Resend quota hit."

**Rule:** if you're using Resend via Supabase SMTP, the first move is **verify your own domain in Resend** and point the sender at `noreply@yourdomain`. The sandbox sender is a dev convenience that fails silently (or ambiguously) in exactly the way that looks like a code bug.

### You don't have the DNS you think you have

When we went to verify the domain, the registrar was on a Vercel project the user couldn't access. **Assume domain-control friction.** Before staking beta delivery on a domain you control, run `dig NS <domain> +short` and confirm you actually have an account at whatever hosts the NS records. If you don't, either buy a cheap dedicated domain for the tool or route through one you own.

### Single-use tokens and link-preview crawlers

When Supabase email was blocked, we built a parallel out-of-band auth path: `issue-access.js` creates a one-time `access_grants` row (URL + 6-digit code, 2-day expiry), you paste the copy-ready email body into Gmail manually. Works. What didn't work: **Dennis pasted the URL into Slack**, and `Slackbot-LinkExpanding 1.0` crawled it for a preview before Dennis clicked. That GET redeemed the grant, created a session for *Slackbot*, and by the time Dennis clicked, the grant was `used_at != null`.

**Three different lessons:**
1. Single-use GET-redeemed tokens are incompatible with messaging apps — any URL pasted into Slack / iMessage / Discord gets pre-fetched.
2. The paired 6-digit code (redeemed via POST with a JSON body) is Slack-safe because crawlers don't construct requests — they only follow links. Instructing users to paste the code into the sign-in page instead of clicking a link avoids this class of failure entirely.
3. When we re-ship the link path, it needs a bot-UA filter — if `User-Agent` matches `Slackbot|Twitterbot|Discordbot|WhatsApp` etc., return 404 (or redirect without redeeming). That defers redemption until a real browser shows up.

### `AUTH_MODE=open` is the right escape hatch

Once we'd spent a day working around mail delivery, the honest move was to accept that beta onboarding shouldn't block on auth. Added a single env-var switch: `AUTH_MODE=open` makes every request resolve to a shared "public" client (auto-created on first boot), and `/api/auth/me` returns that client so the UI skips the sign-in screen. Flip the env var off and auth is back — no code removed, no rollback.

**Rule:** an auth gate that's tangled with deliverability needs a one-toggle bypass. If the cost of turning it off is "push a code change," you're going to keep it on for bad reasons. Make the toggle an env var from day one.

---

## 14. Database security posture: service key vs. anon key

Supabase's database linter flagged every table we created (`clients`, `runs`, `images`, `sessions`, `invites`, `access_grants`) for `rls_disabled_in_public` + `sensitive_columns_exposed`. This doesn't block the app (we use the service-role key, which bypasses RLS), but it matters.

The threat model is: **the anon key is designed to be public** — it's the same class of secret as a Firebase API key, meant to live in a browser. Supabase's whole security story assumes anon key is exposed and RLS gates the rest. Without RLS, anyone who ever gets our anon key can `SELECT * FROM clients` and harvest every email + token, or `SELECT * FROM access_grants` and redeem live grants.

Today our anon key is server-side only, but it *will* leak eventually (the moment we ever do browser-side realtime, the moment the `.env` ends up in a screenshot, etc.). **Enable RLS before you ever need it.** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` with no policies = anon sees nothing, service role still reads everything. Six lines, non-breaking, covers you.

Saved as `sql/enable_rls.sql`.

---

## 15. Surface partitioning is a deployment invariant, not a per-release checklist item

The moat is the prompt strategy (per vision.md §"The moat"). Every new surface we ship has to answer one question before it goes live: **does a caller on this surface see anything about HOW prompts are built?** If yes, we've leaked the moat.

### Concrete near-miss on the /v1 launch

On the first ship of the `/v1` API-key variant, three leaks slipped through:

1. **`GET /v1/runs/:id` returned each image's full prompt** in the `images[].prompt` field. I'd copied it from the UI's shape without thinking; the UI is an internal surface, `/v1` is not.
2. **API keys authenticated on `/api/public/*` too.** The shared `requireClient` middleware accepted `X-API-Key` anywhere, which meant Sean's key could GET `/api/public/runs/:id` and read the *entire trace* — shot list, critic revisions, system prompts, stage metadata. Every word of the moat.
3. **Render errors echoed back prompt fragments** from fal/OpenRouter failure messages. Subtler but the same class of leak.

None of these were anyone's fault at write-time — they were reasonable defaults for an internal UI. The problem was the **new caller class** (programmatic, external) inherited assumptions made for a different caller class (internal browser).

### The invariant

**Every deploy that touches ingress or auth must re-audit the surface partition.** Not a general "review the diff" pass — a specific checklist, run against the actual live endpoints:

1. **Enumerate every route a non-session client can reach.** (Run them through curl with the external auth method.) For each:
2. **Does the response body contain any of: `prompt`, `shot_list`, `shots`, `composition`, `subject_topic`, `slot`, `system_prompt`, `critic`, `stage`, `trace`, `variance`?** If yes → strip or reject.
3. **Do any error messages include text that came from the prompt path?** (fal, OpenRouter, parser errors can all echo inputs.) If yes → collapse to a generic `error.code` and log the real message server-side only.
4. **Are there image sidecars in storage?** (`.png.json` files written by the renderer — dev-fs only today, but if they ever hit Supabase storage, the ZIP would include them.) Confirm only PNGs are in the archive.
5. **Does auth-method checking happen at the router level, or is it implicit?** Implicit = bug waiting to happen. Every internal surface should have an explicit `requireSession` (or equivalent) gate that rejects non-session auth, not a comment.

Added `requireSession` middleware + `req.authMethod` tag specifically so future surfaces can gate explicitly: `router.use(requireSession)` one line; future diffs read obviously.

### Why this is a standing rule, not a one-time fix

The leak surface grows monotonically with the number of surfaces and the number of LLM stages. Every new endpoint and every new stage adds a way for prompt data to escape. Catching it by code review alone is brittle — reviewers see the code they're diffing, not the whole matrix of (route × auth method × response field × stage output). An explicit surface audit after any ingress/auth change catches what review misses.

---

## 16. gpt-image-2 wants prose, not keyword stacks — and the fix is a rewriter stage, not a prompt rewrite

### What we observed
Running the same keyword-stacked prompts through `fal-ai/nano-banana-pro` and `openai/gpt-image-2` produced visibly different failure modes. Nano renders as intended — handheld, warm, slightly messy. gpt-2 interprets the same string as an editorial instruction: over-lit, symmetric, posed, every subject centered, skin retouched, wardrobe too clean. The model isn't worse — it's reading a different language.

Three prompts that *do* produce candid-looking output on gpt-2 (mirror selfie, home skincare, street-style walking) share a structural shape that the keyword-stacked shape does not have.

### The 9 structural moves in every gpt-2-friendly prompt
1. **Shot qualifier** — "A candid/realistic [setting] photo of a [subject] [doing action]…"
2. **Body + framing** — what each hand/limb is doing, body angle, specific crop ("mid-thigh to head"), posture texture
3. **Wardrobe + grooming** — named fabrics (fitted, ribbed, cotton) with small imperfections (wrinkled, damp, smudged, uneven)
4. **Environment in layers** — 2–3 sentences of architectural depth, practical light sources, depth cues
5. **Lighting in photographer vocabulary** — named source (warm indoor, late-afternoon window, overhead practical), shadow behavior, uneven vs even
6. **Camera / device hint** — "iPhone front camera", "wide-angle around 24-28mm", "handheld, slightly unstable feel"
7. **Imperfection clause** — 3–5 enumerated flaws (motion blur, soft focus, subtle grain, uneven exposure, wrinkled fabric, smudges, asymmetric framing, bg people OOF)
8. **Mood line** — "The mood is [adj], [adj], and [adj]" with a qualifier ("social-media candid", "late-night", "everyday")
9. **Anti-directive tail** — "Avoid [model-like posing / cinematic grading / perfect symmetry / studio polish]. Keep [naturalness]. Do not [introduce glossy retouching]."

Every move matters. Drop #6 (device hint) and gpt-2 defaults to DSLR-studio. Drop #7 (imperfections) and it returns to symmetric polish. Drop #9 (anti-directive tail) and it over-styles. The model treats these as soft negative constraints, not decoration.

### The architectural fix: a rewriter stage, not a better prompt template
The shot-list prompts are keyword-stacked because **nano likes it that way** and we don't want to bifurcate prompt generation. Instead, the rewriter runs as **Stage 3.5** between resolve and render, gated on `model === 'openai/gpt-image-2'`. Each resolved prompt gets a Haiku call with the 9-move system prompt + 3 few-shot examples + the original prompt. Output replaces `shot.prompt`; the original is kept on `shot.__originalPrompt` for A/B.

Why per-prompt rewrite instead of a model-specific shot-list? The shot list decides *what* the image is (composition, subject_type, topic, theme). The rewriter decides *how* gpt-2 should read it. Separating them means: one shot list produces both nano and gpt-2 outputs (the `both` mode), and adding a new model is a new rewriter, not a new prompt pipeline.

### Engine vs. brand split — this is the generalizable move
`v2/src/factory/gpt2Rewriter.js` holds the 9-move template + hard rules (preserve subject, no brand names, no legible text, keep composition family). Zero brand content. `v2/cartridge/<brand>/gpt2_rewriter.md` holds only voice — palette cues, model direction, preferred/avoided lighting vocabulary, subject treatment. The cartridge file is *optional*; the engine works without it.

Swapping brands means replacing one markdown file. Adding a new cartridge inherits gpt-2 handling for free. This is the pattern to repeat for every downstream model that needs a voice layer: engine owns the shape, cartridge owns the flavor.

### Failure handling matters when rewrites are the critical path
Per-shot rewrite failure falls back to the original prompt so the render still fires. Bounded concurrency (`REWRITE_CONCURRENCY`, default 5) matches the shape of the existing render concurrency — if it's a fan-out stage, it needs a back-pressure knob from day one, not retrofitted after the first rate-limit page.

### Still open
- UI doesn't show the before/after in the trace viewer — the rewrite is silent, which makes tuning the 9-move template hard. Needs a Stage 3.5 block that lists original vs. rewritten per shot with char counts and pass/fail flag.
- No end-to-end gpt-2 run has been shot through the rewriter yet — architecture is landed, empirical hit-rate vs. the pre-rewriter baseline is unmeasured.
- The 3 few-shot examples are all people in home/street contexts. No product-only or overhead-composition examples in the few-shot set yet, so the rewriter is extrapolating when the shot list calls for those. Likely needs a 4th example.

---

## Update log
- 2026-04-16 — initial audit of prompt strategy, diversity crisis identified as architectural
- 2026-04-18 — email+OTP auth via Supabase; client UI simplified to email→code→titles→download
- 2026-04-19 — (1) anatomy-aware phrase banks for skin-close (back, jawline, chin, forehead, etc.) landed; jawline renders as jaw profile, back renders as actual back. (2) theme-lock per title at N≤5 confirmed working — mini-series effect. (3) known gap: composition-internal `{area}` slots sampled independently from subject_topic, causing "cream on under-eye" renders for back-acne titles. Fix shipped: slot override in resolver + sanitizer substitutes face-only compositions when topic targets a non-face body region.
- 2026-04-20 — Resend sandbox sender identified as root cause of "Error sending magic link email" for all new testers. Added out-of-band access-grants system (`scripts/issue-access.js` + `GET /a/:token` + `POST /api/auth/redeem-code`) so beta onboarding doesn't depend on Supabase email.
- 2026-04-21 — added `AUTH_MODE=open` env-toggle that bypasses auth and resolves every request to a shared public client; beta now ships via the raw URL. Discovered Slackbot link-preview consumes single-use `/a/:token` grants; documented the code-path as Slack-safe fallback. Sean redeemed his grant via Chrome (clean); Dennis's first grant was eaten by Slackbot and we re-issued code-only.
- 2026-04-22 — RLS enable script written (`sql/enable_rls.sql`) after Supabase linter flagged all public tables as missing row-level security. Service key still works; anon key now denied. Six-line, non-breaking, resolves 8 linter errors.
- 2026-04-23 — Phase A of API-key variant shipped: `/v1/generate` + `/v1/runs*` behind `X-API-Key` header (sha256-hashed at rest). Sean issued first key, full end-to-end verified (auth + generate + image fetch + ZIP + 401 cases). Small fixes same day: `trust proxy` for https URLs behind Railway, shot-list `max_tokens` floor (1200) after N=1 runs hit truncation — root cause was per-shot budget with no floor, not malformed JSON. Retry-on-bad-JSON kept because it's still defensive.
- 2026-04-23 — §15 added: caught three moat-leak paths on first `/v1` ship (prompt field in response, API keys reaching `/api/public/*`, errors echoing prompt fragments). Added `requireSession` middleware + `req.authMethod` so future surfaces partition explicitly. Standing rule: surface audit on every ingress/auth-touching deploy.
- 2026-04-26 (very late evening III) — **Three new style refs (cinematic product, factory BTS, designer sketch) + macro subject families (vegetation, textile) + figures rule revised + glass weather-UI dashboard style + targeted single-spec run.** Bundle (V) through (Z).

  **(V) Figures rule revised** in `profile.json` `forbidden` and `intake.md`. Was: "No human figures of any kind." Now: figures-in-landscape *tropes* still forbidden (hooded silhouettes in fog, lone walker on apron, backlit operator gazing at sky, athletes-mid-action, Magnum-style anonymous-person-in-place), but figures ARE allowed when actively working on/with a large piece of equipment in documentary BTS context (technician on a ladder leaning into industrial vessel, operator at control panel, hands at calibration jig). The equipment is the subject; the figure is incidental, mid-action, never close-up faces, never posed. **Driving signal:** user dropped a Bette Suno BTS factory ref and explicitly named "people working on large machines" as a desired subject family. **Revert path:** put the original "No human figures of any kind" string back in profile.json forbidden + restore the matching intake.md paragraph.

  **(W) Three new refs ingested (refs 29–31) + three new styles in `styles.json`:**
  - `ref-29-cinematic-product-in-grass-night.jpg` (Tommaso Sartori / FLOS) → style `cinematic_product_in_nature` — small Recast hardware emerging from dark organic texture, raking key, deep shadows, 70-85% of frame is natural texture.
  - `ref-30-factory-bts-worker-large-machine.jpg` (Bette Suno BTS) → style `documentary_factory_floor` — available-light industrial bay, technician mid-action on ladder/platform, hexagonal overhead luminaires, polished concrete with hazard stripes. Equipment dominates; figure incidental.
  - `ref-31-designer-working-sketch-blue-pen.jpg` (Barber Osgerby) → style `designer_working_sketch` — loose pen-on-paper sketch (cobalt blue most common), faceted geometric forms, sketchbook paper grain, photographed flat with margin around the sketch. Reads as page from a designer's notebook.

  **(X) Two new ref-less styles** added to surface subject families that don't need a specific anchor ref: `macro_vegetation` (botanical-study macro of wheat heads / leaf veins / seedlings / moss / clover / grass blades / crop canopy / root systems) and `macro_textile` (industrial-fabric macro of gore-tex / ripstop / technical knit / denim twill / mylar / weatherproof shell / fleece / polypropylene). Both styles have empty `refs` arrays — the rules carry without anchor images.

  **(Y) `subjects.recast.json` grew 50 → ~75 subjects** with four new sections: `macro_vegetation` (9 subjects), `macro_textile` (8), `industrial_workers` (6 — figures working on large equipment, the only context they're allowed), `design_sketches` (3). Plus the `recast_logomark` subject in the brand-marks section (added in earlier bundle but worth re-noting since the targeted run uses it).

  **(Z) `glass_weather_ui_dashboard` style added** + targeted single-spec run fired. User shared a weather-UI dashboard ref (tablet screen on green-foliage background, multiple cards, 7-day forecast, dark-mode glass) but didn't share a file path so the style has empty `refs` — the prose carries the law. Then fired run `20260426-195212-66n0` with a single very-specific input title locking every panel to the same composition: dark-mode glass weather dashboard on deep-green foliage, 7-day rain forecast prominent, Recast logomark visible in one corner, with controlled variation in foliage / accent color / camera angle / secondary cards across the 6 panels. N=2 × both models = 4 contact sheets = 24 candidate panels. Note: the engine still wraps everything in the A4-page-with-4:5-grid container, so the output is *24 candidates within 4 contact sheets*, not 24 standalone images — the user can crop the best single panel from the result.

  **Things to watch:** (1) gpt-image-2 / nano are weak at rendering legible text on screens — expect the dashboard's numerals and labels to be partially gibberish; the *layout* should land even if the text doesn't; (2) the Recast logomark may render as a generic dot pattern rather than the exact four-color arrangement — that's a known ref-conditioning weakness; (3) if the LLM ignores "every panel is the SAME composition" and produces 6 different scenes, we'll need to either bypass the contact-sheet wrapper for single-image specs or add a `single-spec` composition variant.

- 2026-04-26 (very late evening II) — **Recast Systems logomark added as a sparingly-used brand asset.** User dropped the official SVG logomark — circular orb of overlapping filled dots in four colors (burnt orange #DA5E15, marigold #FBBF27, cobalt blue #2F5EDC, sky cyan #6BD0ED). User direction: appear in *some* outputs, not all.

  **(P) SVG → PNG ingest path established.** Cartridge ref loader only accepts jpg/jpeg/png/webp (not svg). Used `qlmanage -t -s 1200 -o <dir>` (macOS Quick Look) to render the SVG to PNG at 1200px before ingesting via `scripts/refs.js add`. `rsvg-convert` and `inkscape` not installed; qlmanage works without dependencies. Saved as `ref-28-recast-logomark-color-light.png` (149KB). Same recipe will work for any future SVG brand assets.

  **(Q) `palette.json` extended with the four logo colors** under a new `logo` key, plus a sentence in `notes` constraining when those colors appear together (only when the logomark itself is on the page). Keeps the existing accent palette intact — the logo's four-color riot was leaking into other panels otherwise.

  **(R) New STYLE: `recast_logomark_plate`** in `styles.json`. Photograph of a printed brand-mark plate: logomark centered on a saturated solid-color ground (deep slate / chalk green / ochre / warm white), 25–30% page width, vast even negative space, faint paper grain. Anchored to ref-28. The four logo colors are constant; only the background field varies.

  **(S) New SUBJECT: `recast_logomark`** in `subjects.recast.json`, sitting alongside `recast_systems_wordmark` in the brand-marks section.

  **(T) `profile.json` gains a `brand_assets` block** with a structured logomark record (ref filename + description + usage rules). Future stages can find the asset programmatically without parsing prose. Sits adjacent to `forbidden` inside `brand_dna`.

  **(U) `intake.md` BRAND ASSETS section** added near the top (before BRAND CONTEXT). Hard-codes the usage budget the user described: "roughly one panel out of every two contact sheets — about half the runs get it, half don't"; max 1 logomark panel per sheet; max 35% of panel; only two valid contexts (brand-mark plate OR small printed application stamped on an object). Explicit "never invent additional Recast logos or wordmarks" guard so the LLM doesn't hallucinate variations.

  **Revert paths (if logomark surfaces too aggressively or wrong):**
  - To suppress entirely: delete the BRAND ASSETS section from `intake.md`.
  - To dial down frequency: change "one panel out of every two contact sheets" → "one panel out of every four" in `intake.md`.
  - To remove the structured asset record: drop the `brand_assets` block from `profile.json`.
  - The new style + subject in `styles.json` / `subjects.recast.json` are still proposal-only (engine doesn't read them) — safe to leave or delete.

  **What to verify on next runs:** (1) ~50% of contact sheets have a single logomark panel, ~50% have none; (2) when present, the four colors stay correct (not invented); (3) renderer doesn't put the logomark larger than ~35% of the panel; (4) no rogue extra "Recast" wordmarks invented in adjacent panels.

- 2026-04-26 (very late evening) — **structural change: A4 portrait page + 4:5 interior grid is the new default output container; B&W vintage catalog added as a style.** User confirmed this is structural for the page format AND a style (not a positioning shift) for the B&W catalog look. The brand subjects and territories don't change — but the rendered image is now a *photograph of an A4 page* with the 6-panel 4:5 grid sitting inside the page margins, instead of edge-to-edge contact sheet.

  **(L) Composition rewrite — `v2/cartridge/demo/compositions.json` `contact-sheet-2x3.skeleton`.** Was: "A clean editorial 2x3 contact sheet on uniform #FAFAFA". Now: "A photograph of an A4 portrait-format printed page (~1:1.414, taller than wide) placed flat against #FAFAFA, cream-toned printed paper with faint aged paper-fiber grain and natural drop shadow beneath the page edge. Centered on the page sits a 4:5-aspect interior grid of six panels (2×3) with even thin white gutters and equal margin around the grid on the page. Generous top/bottom paper margin, narrower side margin. No legible text/captions/page numbers." Mood updated: "A4 catalog page with 4:5 interior grid, photographed flat". **Revert path:** restore the prior skeleton string (just one line in compositions.json).

  **(M) fal aspect-ratio default `16:9` → `3:4`.** `v2/src/render/fal.js`. 3:4 is the closest fal-supported aspect to A4 portrait (3:4 = 0.75; A4 = 0.707) — closer than any other standard literal fal accepts reliably. gpt-image-2 mapping (GPT2_SIZE → `portrait_4_3` = 1024×1408 ≈ 0.727) is even closer to A4 than 3:4 itself. Added `'1:1.414'` and `'210:297'` aliases in GPT2_SIZE so future code passing literal A4 strings still works. **Revert path:** flip default back to `'16:9'`.

  **(N) `vintage_catalog_page_bw` added as a STYLE (not a default treatment).** `v2/cartridge/demo/styles.json`. Soft duotone B&W studio photography in the 1960s/70s Scandinavian product catalog manner: single object floated in soft-light empty space, slight grain, faint baseline shadow, generous negative space, no color. Refs: `ref-27-vintage-catalog-page-bw-vase-grid.jpg` (the user-provided catalog page). The B&W is one of many possible panel treatments — the LLM chooses when to apply it. Also surfaced in `intake.md` FEATURED STYLE GRAMMARS print/paper/object section as the new top entry. **Revert path:** delete the `vintage_catalog_page_bw` entry from styles.json + remove the bullet from intake.md FEATURED.

  **(O) `intake.md` preamble + `suffix.md` positives/negatives updated to match the A4 page container.** Preamble now opens with "panel descriptions for an A4 portrait catalog page with a 4:5-aspect interior grid of six panels". Suffix positives lean into the A4 page + paper margin language; negatives gain explicit "no 3x3 grid, no 9-panel grid" — addresses the gpt-2 9-grid misinterpretation user mentioned earlier.

  **What stays the same:** profile.json brand DNA, territories, subjects, refs 01–26 — none of these are touched. The brand IS Recast Systems cloud-seeding company; the BRAND PAGE FORMAT is now A4 catalog. Two separate concerns, finally separable in the schema.

  **What to verify on the next run:** (1) every render is a portrait-shaped image (not landscape) with a single A4 page floating on #FAFAFA, (2) the 6-panel grid sits centered with generous top/bottom margin, (3) at least one of the six panels per sheet leans into the new B&W vintage catalog grammar, (4) no 9-panel/3×3 misfires from gpt-2.

- 2026-04-26 (late evening) — **brand-rename + 7 new style references + schema expansion (Recast Systems).** User dropped a second batch of references that broaden the brand from "cloud-seeding hardware" toward atmospheric / planetary / measurement / editorial-poster territory. Bundle (H), (I), (J), (K) below.

  **(H) Cartridge brand rename: NIMBUS → "Recast Systems".** This is the brand inside the demo cartridge, NOT the project name (project rename earlier handled the engine side). Files touched: `v2/cartridge/demo/profile.json` (`brand_name`, `system_role`), `v2/cartridge/demo/intake.md` (header + territory intro), `v2/cartridge/demo/BRIEF.md`. Crucially the lowercase meteorological "nimbus" in `subjects.recast.json` (cloud-form taxonomy) was preserved — that's the cloud type, not the brand. **Revert path:** `replace_all` "Recast Systems" → "NIMBUS" in those 3 files (subjects.recast.json untouched).

  **(I) Cartridge ref loader cap bumped 24 → 64.** `v2/src/factory/cartridge.js`. With this batch we hit 26 refs total and 25/26 would have been silently dropped. Bumped headroom to 64; first `REF_BUDGET` (default 8) still wins at fal-render time.

  **(J) Seven new references added to demo cartridge (refs 20–26).** Source paths in `~/Pictures/Refs.library/` were renamed to style-focused filenames during ingestion:
  - `ref-20-mars-travel-poster-flat-illustration.jpg` — Mars travel poster (HEIC-converted via sips, downscaled to 1600px → 282KB)
  - `ref-21-burgess-johnson-poster.jpg` — Samuel Burgess-Johnson modernist editorial poster
  - `ref-22-riso-cloud-grid-red-square-album.jpg` — Heavy Cloud album art (riso clouds + grid + red accent square)
  - `ref-23-cumulus-with-crosshatch-grid-overlay.jpg` — photographic cumulus + plus-sign measurement grid overlay (Tabor Cote)
  - `ref-24-satellite-river-delta-ochre-white.jpg` — satellite river delta drainage tracery, ochre/white
  - `ref-25-urdaneta-aerial-landscape.jpg` — large-scale aerial-landscape photography
  - `ref-26-cosmos-deep-space-frame.png` — frame from a Cosmos animation (used pre-rendered thumbnail since source was .mp4)
  Routing notes: HEIC → JPG via `sips -s format jpeg`; oversize JPGs → `sips -Z 1600` to keep base64 inlining manageable.

  **(K) Schema expansion in proposal files (still not wired into engine).** `styles.json` grew 11 → 18 styles: added `editorial_travel_poster_two_tone` (Mars-style), `brand_mark_solid_color_field` (Patagonia-style, no ref attached — user showed it visually but didn't share a file), `riso_cloud_grid_with_accent_square`, `photographic_cloud_with_measurement_grid`, `satellite_earth_surface_aerial`, `cosmic_deep_field`, `modernist_editorial_poster`. `subjects.recast.json` grew ~30 → 50 subjects across four new sections (planetary surfaces & space objects, satellite earth-surface features, cosmic / deep-space, overlays / brand marks / page-as-object) — including `planet_mars_surface`, `planet_earth_orbit`, `river_delta_dendritic`, `salt_flat_dendrites`, `recast_systems_wordmark`, `measurement_grid_atop_sky`, `single_red_grid_cell`, `page_as_object`. **Reminder: proposal files only. Engine still uses the legacy intake.md → resolved → render path with the 5-axis territory model.**

  **What's now clearly different about this brand from the original NIMBUS one:** moving from "cloud-seeding company" toward "atmospheric / planetary / measurement systems with a poster-and-publication design language." `profile.json` system_role still reads cloud-seeding — left intact since user said they'd drive prompt refinement themselves.

- 2026-04-26 (evening late) — **three diagnosis-driven changes after watching live UI run `20260426-141442-kmnv`.** User read: "we've added a lot of new refs but it can't seem to break out of eagles and dudes standing." Verified by counting axes across 6 shots: `anonymous_figures` was used in 4/6 shots and dominated each one (silhouettes, hooded technicians, distant operators). The two shots that *avoided* the figures axis were the most diverse panels of the run. Three changes applied as a tracked bundle so any one is independently revertable.

  **(E) Removed the `anonymous_figures` axis from the demo cartridge.** Five territories now (`studio_hardware`, `atmospheric_sky`, `aerial_top_down`, `modular_typology`, `data_display`). Files touched:
  - `v2/cartridge/demo/intake.md` — territory list trimmed 6→5; `axes_used` valid-name list updated; "all six" → "all five" in run-context language; SHAPE EXAMPLE swapped the figures panel for a topographic-poster panel. Added a hard "No human figures" paragraph at the bottom of the territories section that explicitly translates "people doing X" → "the equipment and traces of X" (the empty workspace, the worn glove, the trail of tracks). Brand reads through its objects, not its inhabitants.
  - `v2/cartridge/demo/profile.json` — removed `anonymous_figures` from `visual_axes` and `axis_aliases`. Tightened `visual_signature` (dropped the "anonymous utility-wear figures" clause). Tightened `mandatory_elements` (dropped the "Anonymous, distant, full-body figures when humans appear" clause). Widened `forbidden` with explicit "No human figures of any kind — no people, no silhouettes, no technicians, no operators, no athletes, no distant figures, no implied-presence figures."
  **Revert path:** restore the `anonymous_figures` block at lines ~16/53 of profile.json, restore territory #5 + axes_used "anonymous_figures" + the Magnum-figure example panel in intake.md, and put the prior `visual_signature` / `mandatory_elements` / `forbidden` strings back. (Diff visible in this commit window.)

  **(F) Default `quality` for gpt-image-2 dropped `'high'` → `'medium'`.** `v2/src/render/fal.js:10`. Test runs were averaging ~100s/render at high quality; medium is roughly 2× faster (~50–60s expected) and visually equivalent for contact-sheet usage where each panel is small. UI/API can still override per-run via `quality` in the request body. **Revert path:** flip the default literal back to `'high'` at the top of `renderOne()`.

  **(G) Intake model swapped Haiku → Sonnet 4.5.** `v2/src/factory/intake.js:36` default model `anthropic/claude-3-haiku` → `anthropic/claude-sonnet-4.5`. Diagnosis: prompts coming back from intake were following the rules but cherry-picking the safest interpretation of each axis ("single sensor on cool gradient" / "isometric grid of identical white modules") and recycling the same shapes across shots — a Haiku-class capacity ceiling, not a system-prompt problem. Cost goes up ~3× per intake call (still pennies — intake is one call per shot, ~600 max_tokens). Smoke-tested the slug via OpenRouter (`status 200`, resolves to `claude-4.5-sonnet-20250929` via Bedrock). Other stages (`shotList`, `critic`, `gpt2Rewriter`) stay on Haiku — they're not the creative bottleneck. **Revert path:** restore `'anthropic/claude-3-haiku'` as the default in `runIntake()` signature.

  **What to verify on the next run:**
  - No human figures, silhouettes, or implied-presence panels in any of the 18 panels (3 titles × N=2 × 6 panels = 36 panels actually, scaled down per N).
  - gpt-2 average elapsed drops from ~100s to ~50–60s.
  - Panel descriptions are notably more varied — Sonnet should reach further into adjacencies + featured grammars and stop recycling shapes.
  - If figures still appear despite the explicit forbidden clause, that's a Sonnet failure mode (not Haiku-class), and the forbidden string needs rewording.

- 2026-04-26 (evening) — **architecture: project rebranded to "Recast" + style/subject schema drafted (files-only, not yet wired).** Driving insight from the user: I'd been treating brand-DNA gaps as touchstone-list and ref-budget tuning problems (bandaids), but the real issue is that the cartridge has no formal *style* layer. Nolla's realism came from a single named style — a long, specific subject-prompt paragraph with sanitizer + composition grammar — that took two days to author. The demo cartridge had no equivalent: refs were doing all the visual law and the intake LLM was inventing both medium AND content per panel, so it kept cherry-picking the easiest combinations and skipping mylar/modernist/celestial entirely. Two top-line layers per cartridge from here on: **STYLE** (how the image is made — medium, treatment, post, the visual law of "what kind of object is this picture") and **SUBJECT** (what's depicted). Refs attach per-style, not per-cartridge. Style starts as `{ id, name, prose }` and grows into sub-fields (lighting, framing, palette, camera, post, surface) as needed. Subject starts as `{ id, phrase }` and grows into slot data when a cartridge demands it. Intake's job becomes a matrix pick: choose 6 (style, subject) pairs that span the matrix and honor mandatory/forbidden — orchestrator composes `${style.prose} ${subject.phrase}`, never asks the LLM to invent both.

  **Rename scope (this session — prompts and UI only).** User explicitly scoped: don't move the directory, don't touch the GitHub repo, don't migrate Supabase, don't rename the `nolla` cartridge (that's a brand inside Recast). Changed: OpenRouter `X-Title` headers in `intake.js`, `critic.js`, `gpt2Rewriter.js`, `shotList.js` ("Brand Image Blaster v2 …" → "Recast …"); UI titles in `v2/ui/index.html`, `v2/ui/run.html`, `v2/ui/brand.html`, `v2/ui-client/index.html`; server boot log in `v2/src/server.js`; access-grant email body in `scripts/issue-access.js`; `v2/README.md` heading. **Revert path:** grep for "Recast" across `v2/` + `scripts/`, restore "Brand Image Blaster v2" / "Image Blaster" / "Image Generator" in each spot.

  **Schema draft (not yet wired).** Two new files in `v2/cartridge/demo/`:
  - `styles.json` — 11 named styles for NIMBUS, each with `prose` paragraph + per-style refs + optional sub-fields. Clusters the existing 19 refs into named styles instead of leaving them as a flat pile: `studio_hardware_cool_gradient`, `atmospheric_sky_photographic`, `aerial_top_down_landscape`, `modular_typology_grid`, `anonymous_figures_distance`, `ios_weather_widget_glassy`, `topographic_poster_photographed`, `risograph_weather_diagram`, `industrial_mylar_packaging`, `modernist_logotype_typography`, `celestial_icon_typology_black`. The last three are the grammars that kept landing at 0× in test runs — now they have real prose and dedicated refs.
  - `subjects.recast.json` — ~30 subjects in plain `{ id, phrase }` shape, grouped roughly by territory but the territories are gone from the schema (style replaces them). File is named `*.recast.json` to avoid clobbering the engine's currently-loaded `subjects.json` (panel-mix shape).

  **What still has to happen to actually use this:**
  1. Cartridge loader (`v2/src/factory/cartridge.js`) reads `styles.json` + `subjects.recast.json` (and eventually subjects.json after the cutover).
  2. New intake prompt that hands the LLM the styles index + subjects index + the user input, and asks for 6 `(style_id, subject_id)` pairs as JSON — no more inventing prose per panel.
  3. New compose stage that joins `style.prose + subject.phrase` per panel; current resolver is bypassed for matrix-pick mode.
  4. Render stage attaches `style.refs` (from the picked style) instead of cartridge-level refs — finally per-style ref grounding.
  5. `profile.input_mode` gets a third value (`matrix` or similar) that gates the new pipeline. `intake` and `title` modes keep working unchanged.

  Schema is files-only and reversible: delete the two new files to back out, no code path touches them.

- 2026-04-26 (afternoon) — investigated run `20260426-100923-18j2` after user reported "new images haven't made it into the brand" + "prompt failures". Three independent issues found, three changes applied. Logged here as a tracked bundle so we can revert any one piece if the next test run regresses.

  **(A) fal reference-image budget bumped 4 → 8.** `v2/src/render/fal.js:37` was hard-slicing references to the first 4 (alphabetical). Cartridge loader sorts by filename and demo had grown to 19 refs, so fal was permanently anchored to ref-01..04 (storm-clouds-bw, cumulus-moon, aerial-tractor-field, white-drone-studio). Every style ref added since (refs 05–19: topographic posters, risograph diagrams, mylar packaging, cascading modernist typography, celestial icon-set, sensor towers, robot arms, etc.) was loaded into memory but never sent to fal. Fix: replaced the literal `4` with `REF_BUDGET` const (default 8, env-tunable 1..16). Bigger budget costs ~1.5–2x vision-conditioning tokens per ref, so monitor latency on next runs and pull back to 6 if responses balloon. **Revert path:** set `REF_BUDGET=4` in `.env`, or restore the hard-coded 4 at `v2/src/render/fal.js`.

  **(B) `intake.md` — directive-input handler added + featured-grammar guardrail.** Run failure: input `"make me a poster for the brand"` → Haiku refused with `"I apologize, but I cannot generate a full poster design for you…"` and broke JSON parse. Root cause: the system prompt told Haiku to produce panel descriptions and Haiku interpreted the word "poster" as a directive it couldn't satisfy. Fix #1: added a "DIRECTIVES, REQUESTS, AND OPEN QUESTIONS — ALL VALID INPUTS" section near the top that explicitly lists shapes (questions, directives, briefs, lists) and tells the LLM never to apologize or refuse — always produce six panels, regardless of input phrasing. Fix #2: separately, the intake LLM was leaning on safe vocabulary (data display 6×, widget 2×, dashboard 2×) and ignoring the painterly touchstones (mylar 0×, modernist typography 0×, celestial 0×, topographic-poster 0×, risograph 0×) — they were buried in a 26-item list. Added a "FEATURED STYLE GRAMMARS" section above the long touchstones list that pulls out the three most-ignored grammars (industrial mylar packaging, topographic-poster cartography, risograph weather diagrams) as *mandatory*-feeling guidance, plus a Rule 4 addendum: "At least 1 of 6 panels MUST come from FEATURED STYLE GRAMMARS." **Revert path:** in `v2/cartridge/demo/intake.md`, remove the two new sections + the Rule 4 addendum. Original Rule 4 was just "At least 2 of 6 panels MUST lean adjacent."

  **(C) UI label for skipped gpt2Rewrite.** Earlier session bug: `v2/ui-client/app.js:395` labeled missing `__gpt2Prompt` as `"gpt-2 (rewrite failed → nano)"` whether it was a real failure or an intentional skip (intake mode / nano-only run). Fixed: now reads `trace.stages.gpt2Rewrite.status` and shows `"gpt-2 (rewriter skipped — <reason>)"` for skips. Also fixed `v2/src/orchestrator.js:197` to finalize `gpt2Rewrite` to `status: "skipped", reason: "no gpt-image-2 model in this run"` for nano-only runs (was leaving it `pending` forever).

  **What to verify on next run:** (1) renders look meaningfully different from the last run — if not, refs aren't reaching fal, check fal payload via trace; (2) at least one panel per contact sheet leans mylar/topographic/risograph; (3) directive inputs ("make me a poster", "design a hero shot") render successfully without JSON parse failures; (4) UI shows "rewriter skipped — …" not "rewrite failed".

  **(D) downloadImage retry added.** Test run `20260426-133438-59wo` (same 3 titles as baseline, both-mode, N=2) produced 6 ok / 6 fail on the render stage despite the prompt-side wins. Failures: 5× `Download 409` (split across nano AND gpt-2 — not REF_BUDGET-related; gpt-2 doesn't use refs) + 1× `fal 500`. The download path at `v2/src/render/fal.js` had ZERO retries: `renderOne` retries the API call on 429/5xx but `downloadImage` would throw on any non-2xx — fal's signed CDN URLs occasionally 409 for a few seconds after mint, eating real renders. Fix: replicated the `renderOne` retry shape inside `downloadImage` (MAX_RETRIES=3, exponential backoff INITIAL_BACKOFF_MS * 2^attempt + jitter). **Revert path:** restore the 4-line implementation at `v2/src/render/fal.js:100-104` (single fetch, throw on !r.ok). **Verification on next run:** total render failures should drop substantially; expect occasional `[fal] download error on attempt N` warnings in stdout for transient 409s that would have been render failures before.

  **Run-result observations also worth recording (no code change yet):**
  - Featured-grammar pickup is **uneven**. `topographic-poster` and `risograph` landed (4× each) but `mylar`, `modernist`, `celestial`, `foil`, `graphic standards` all stayed at **0**. Hypothesis: the LLM cherry-picks the two grammars easiest to translate into a "panel of a poster" and skips the others. Possible follow-up: rotate which grammar is featured per shot (round-robin via `recently_used_grammars` or similar) instead of listing all three with equal weight.
  - 6th-axis `data_display` vocab regressed: `data display` 6→0, `widget` 2→0, `dashboard` 2→0. The LLM swapped its attention budget onto the new FEATURED block at the cost of the `data_display` axis. Net wash on territory diversity — keep an eye on this; if it persists across 5+ runs we should re-balance the prompt structure.

- 2026-04-26 — demo (NIMBUS) cartridge brand DNA expanded post-Strategy-A. Visual axes grew from 5 → 6 (added `data_display` — the software half of the brand: weather widgets, dashboard cards, instrument panels, topographic-poster cartography, risograph weather diagrams, glassy iOS UI mockups read as photographs of screens). Cultural touchstones grew from 15 → 26: added Apple iOS weather-widget aesthetic, topographic-poster art, Outdoor Recreation Archive risograph, Tufte info-design, Rams calculator UI, minimalist conceptual notation (Bas Jan Ader / John Cage), Doppler radar-as-fine-art, plus four style-aesthetic touchstones derived from Graphics-Standards-Manual-era references (industrial mylar/foil packaging, 70s/80s modernist agency typography on flat ground, celestial-body icon typology on black, graphic-standards-manual reference book). User explicitly directed: "ignore the word nasa and instead focus on the style of image" — touchstones name the visual grammar, not the originating brand. References grew from 10 → 19 via `scripts/refs.js add demo …`. Loader cap is 24 (only first 4 reach fal anyway). intake.md updated to surface 6th territory + 6th `axes_used` value + expanded touchstones list. Profile.json axis_aliases augmented for `aerial_top_down` (topographic-poster, risograph) and `modular_typology` (celestial icon-set, conceptual notation, mylar packaging) so adjacency drift covers the new vocabulary.
- 2026-04-23 — §16 added: gpt-image-2 rewriter landed. Engine (`v2/src/factory/gpt2Rewriter.js`) owns the 9-move structural template + 3 few-shot examples from Case's empirical successes (mirror selfie, home skincare, street-style). Brand voice (`v2/cartridge/nolla/gpt2_rewriter.md`) is optional, swap-per-brand. Orchestrator Stage 3.5 gates on `model === 'openai/gpt-image-2'`, bounded concurrency, fallback-to-original on per-shot failure. Still untested end-to-end; trace viewer has no before/after surface.

---

## §17 — Product cartridge: object-mode + per-style refs (2026-05-02)

### What's new
- `input_mode: "object"` added (orchestrator path #3 alongside `title` and `intake`). Each input is a single object name; the orchestrator hand-rolls N shots that round-robin through `cartridge.profile.style_order`. **No LLM shot-list call**, no critic, no sanitizer, no rewriter — the cartridge author already declared the styles, and the input text IS the subject.
- `cartridge.profile.style_order` declares the canonical rotation (`["product-shot","in-situ","sketch"]`). Compositions present in `compositions.json` but missing from the order get appended automatically so nothing silently drops.
- `cartridge.profile.default_aspect_ratio` honored when the request omits one.
- `cartridge.references/<style>/*` subfolders supported. Each ref is tagged with its parent dir (`style: "product-shot"`). At render time the orchestrator filters refs by the shot's composition. Untagged refs at the root remain as fallback. Render trace records `refsAttached` and `refsAvailable` per item for debugging.
- Title text is injected as a per-title `phrase_banks[title.id] = [title.title]` entry on the cartridge's first subject_type, so `{subject}` resolves to the literal object name.
- Run grid filters by active cartridge bubble — switching cartridges re-scopes both the in-flight status chips and the persistent grid.

### Lesson re-applied (the diversity crisis, again)
The first product-cartridge prompts were **over-engineered**: 8+ slots stacked with explicit lighting / fill / shadow / finish directives. The model honored the prompt and ignored the references. The fix mirrors §1: stop asking the *prompt* to do the work the *refs* should do. Loosened to 3 composition slots (angle, framing, background) plus a closing line — *"in the visual register of the reference photographs — the references should drive lighting, surface, and treatment"*. Refs got room to act. **Generalizable rule:** for cartridges that ship strong reference imagery, keep prompts to composition decisions only. Style/light/surface/material are reference-driven.

### Open architectural roadmap (see `v2/cartridge/product/PLAN.md`)
1. **In-situ tone** — push to editorial fashion-publication register (Apartamento, Cereal, Wallpaper*, Sight Unseen, MAQL).
2. **Cameras & details** — add macro-material and mixed-material compositions across all three styles.
3. **Material registers** — mirror nolla's body-region pattern: `wood-light`, `wood-dark`, `metal-warm`, `metal-cool`, `wool`, `suede`, `leather-soft`, `ceramic-glazed`, `ceramic-unglazed`, `glass-clear`, `glass-milky`, `plastic-color`, `mixed-materials`. Auto-tagged by keyword on title text in object mode.
4. **Palette anchors** — small palette set on the cartridge; one palette locked per title across all three styles for visual continuity. Same shape as nolla's `theme-lock` (N≤5).
5. **Collections** — group inputs to share palette + material register + environment family.
6. **Product design** — downstream; LLM drafts form from a brief.

### Open issues being tracked
- **Sketch generation gap on nano-banana-pro**. Photoreal-trained model resists line illustration. Test (a) lead with stricter directive vocabulary ("minimalist line illustration on white", "vector aesthetic"), and (b) consider per-composition model routing — sketch shots could go to flux-pro/kontext or gpt-image-2 which handle flat illustration better. Per-composition model override is a small orchestrator addition: respect `cartridge.compositions[name].model` if present.
- **Reference budget alphabet**. With 8 refs/render and ~26 sketch refs, files starting with non-digit characters never reach fal. Solution: rename refs `01-`, `02-` for stable ordering, or allow `cartridge.profile.ref_budget` override.
- **Prompt redundancy** — theme + suffix + composition all repeat "square 1:1 frame". Token waste; consolidate later.


---

## §18 — Staged funnel + flux endpoint + ref audit (2026-05-02)

### Staged-funnel architecture (product cartridge)
Funnel-shaped workflow added to the orchestrator + UI: `sketch → product → in-situ`, with promotion between stages and **lineage tracked on every render item** (`stage`, `parent: {runId,slug,filename}`).

API surface:
- `POST /api/public/runs` accepts `stage` (one of the cartridge's compositions) and `parents: [{runId, slug, filename, title?, note?}]`.
- When `stage` is set, the orchestrator restricts the cycle to that composition (no rotation).
- When `parents` is set, each parent becomes a synthetic title; the orchestrator looks up the original object name via `readTrace(parent.runId)` and **fuses the user's per-parent note into the phrase bank**: `phrase_banks[id] = ['<object>, <note>']`. Notes flow through `{subject}` substitution — no resolver changes needed.
- `parents` and `stage` together implement both **promote** (multiple parents → next stage) and **amplify** (1 parent, same stage, more renders).

UI surface (product cartridge only):
- Three-column funnel replaces the flat grid when `cartridge === 'product'`. Pill input always feeds stage 1.
- Per-tile `+` (hover-revealed, top-right) — fires amplify with default N for that one tile.
- Per-column `+ more like these` — amplifies the column's selection (or the most recent items if none selected).
- Per-column `Promote N → <next stage>` — opens an inline notes panel: each selected tile gets its own thumbnail + text input ("material + color note" / "in-situ scene note"). Send → POST to `/runs` with stage and parents.
- Persistence by default: every column shows everything ever generated for that cartridge at that stage. Selection state persists across runs.

Generalizable rule: **lineage + per-parent notes = staged batches without changing the resolver.** The note becomes part of the phrase bank, the phrase bank becomes part of `{subject}`, the rest of the prompt machinery is unchanged. Amplify and promote collapse to the same primitive: parents + stage.

### flux endpoint bug — wrong model ID

UI "flux" label was pointing at `fal-ai/flux-pro/kontext`. Live-tested → 422 `{"loc":["body","image_url"],"msg":"Field required"}`. **Kontext is an image-edit model — requires an input image.** Every from-scratch flux run was failing silently from the UI's perspective.

Fix: switched the label to `fal-ai/flux-pro/v1.1-ultra` (text-to-image, also in the allowlist). Verified live: 200 with a 2048×2048 PNG.

`fal.js` now branches per-model on the field name when refs are attached:
- `fal-ai/nano-banana-pro` → `image_urls` (plural array, up to 8)
- `fal-ai/flux-pro/kontext` → `image_url` (singular) — **single input image only, no multi-ref style mixing**
- `fal-ai/flux-pro/v1.1-ultra` → no image input
- `openai/gpt-image-2` → no image input

When we plumb kontext back in for parent-image editing on promote/amplify, this branch is already wired — pass the parent image URL as `references[0]`.

### Reference-image audit
Verified live what each model actually receives. **nano was getting refs all along** (Gemini even returned a `description` field showing it parsed the input). When the visuals didn't echo the refs in earlier runs, the prompt was overpowering them — confirms §17's "let the refs do the work" rule.

Each render item now records `refsAttached` and `refsAvailable` so the trace is auditable.

### Sketch register evolution (product cartridge)
Three-step iteration on sketch:
1. **First pass** — "designer's working sketch" with paper textures and notebook context. Photo-of-paper register. Too literal.
2. **Second pass** — narrowed to nendo minimal-process diagrams: small black line on pure white, vast empty space. Better, but too clean and too narrow — every sketch landed as the same diagram.
3. **Third pass (current)** — kept nendo as the base register, **dropped paper as a slot entirely** (gesture and approach lead, not surface), broadened the `register` slot to five modes: nendo minimal, shape-first chunky-contour, CAD/schematic technical, iPad-thumbnail-sheet, process-diagram. `linework` slot pairs naturally with each. `treatment` slot grew to 17 ways of depicting the same object (orthographic, exploded, cross-section, scale-comparison, motion arrow, action sketch, alternate-form, dimensioned, component-study sheet, etc.).

Prompt skeleton makes the blend explicit: *"in the spirit of nendo's small process diagrams mixed with shape-first chunky-contour studies and CAD-schematic technical drawings"*.

### `all` model option
Cycles after `both` for experimental accounts. Fans out the same shot list across **nano + flux + gpt-2** simultaneously. Filenames get model-suffixed (`-nano`, `-flux`, `-gpt2`) so they don't collide on disk.

