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

## Update log
- 2026-04-16 — initial audit of prompt strategy, diversity crisis identified as architectural
- 2026-04-18 — email+OTP auth via Supabase; client UI simplified to email→code→titles→download
- 2026-04-19 — (1) anatomy-aware phrase banks for skin-close (back, jawline, chin, forehead, etc.) landed; jawline renders as jaw profile, back renders as actual back. (2) theme-lock per title at N≤5 confirmed working — mini-series effect. (3) known gap: composition-internal `{area}` slots sampled independently from subject_topic, causing "cream on under-eye" renders for back-acne titles. Fix shipped: slot override in resolver + sanitizer substitutes face-only compositions when topic targets a non-face body region.
- 2026-04-20 — Resend sandbox sender identified as root cause of "Error sending magic link email" for all new testers. Added out-of-band access-grants system (`scripts/issue-access.js` + `GET /a/:token` + `POST /api/auth/redeem-code`) so beta onboarding doesn't depend on Supabase email.
- 2026-04-21 — added `AUTH_MODE=open` env-toggle that bypasses auth and resolves every request to a shared public client; beta now ships via the raw URL. Discovered Slackbot link-preview consumes single-use `/a/:token` grants; documented the code-path as Slack-safe fallback. Sean redeemed his grant via Chrome (clean); Dennis's first grant was eaten by Slackbot and we re-issued code-only.
- 2026-04-22 — RLS enable script written (`sql/enable_rls.sql`) after Supabase linter flagged all public tables as missing row-level security. Service key still works; anon key now denied. Six-line, non-breaking, resolves 8 linter errors.
