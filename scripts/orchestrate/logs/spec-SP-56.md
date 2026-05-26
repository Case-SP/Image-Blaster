# Reference Modal — Liquid Glass + Stage-Aware Prompt-Steer Dropdowns

> Implement in the worktree you're launched in (a fresh branch off `main`). Task by task; commit after each. **Never** `git push`**.** You cannot use the Playwright MCP — implement the code, do static checks (`node --check` on changed JS, grep for new selectors), and note visual verification as "pending human review" in your final commit.

## Goal

1. Restyle the `+` Reference-override modal as **liquid glass** — match the top-bar `.pill`/`.bubble` treatment (translucent white, `backdrop-filter: blur(28px) saturate(180%)`, inset highlight + soft outer shadow) instead of the opaque `#fafafa` card.
2. Add **stage-aware "Guide the prompt" dropdowns** — one-tap steers that append a short phrase to the next run for the open stage; different dropdowns surface per stage.

## Design (locked)

**Glass:** card (`.ref-modal-stage`) + tabs/dropzone/action buttons adopt the glass treatment. Keep the overlay's dark blur backdrop. **Extract one shared** `.glass-surface` **class** and apply it — do not re-derive blur values inline.

**Steer dropdowns** — a "Guide the prompt" section; surfaced set changes by active stage tab:

* **Sketch:** Spread, Form, Complexity
* **Render:** Color, Weight
* **Both (secondary):** More ▾ → Era/register + "+ Custom steer…" (free text)

Options (starter set — wording tunable later):

* Spread: More variety across the grid · More consistent
* Form: More geometric · More organic · Sharper · Rounder
* Complexity: Simpler · More minimal · More detailed
* Color: Add brand color · Go mono · More saturated · Warmer
* Weight: Bolder · Quieter · More dynamic · Calmer
* More: More retro · More modern · Different era · + Custom steer…

**Behavior:** stackable (one pick per dropdown, multiple active at once; lit trigger shows `Dim: pick`); persistent **per stage** (mirror `sessionRefs[stage]`), survive reopen; "Clear this stage" clears steers + refs together; custom free-text under More. **Chip spacing: generous gap (≥10–12px)** — the prototype read too tight.

**Wiring:** each active steer contributes a phrase; on a run for that stage the joined phrases are appended to the prompt as a steering clause — **reuse the same injection path as the existing amplify-note**. No new pipeline. Drive surfaced dropdowns from a per-stage `STEER_SETS` config keyed by stage id (colocate with `FLOWS` if it exists).

## Files

* `v2/ui-client/styles.css` — `.glass-surface`; restyle `.ref-modal-stage/.ref-modal-tab/.ref-modal-drop/.ref-modal-clear/.ref-modal-done`; `.steer-*` (trigger pills + glass menu, loosened gap).
* `v2/ui-client/index.html` — "Guide the prompt" section inside `#ref-modal`.
* `v2/ui-client/app.js` — `STEER_SETS`; render/refresh dropdowns on open + tab switch; store picks per stage alongside `sessionRefs`; include active steers in the run payload; clear with the stage.
* The amplify-note consumer (server) — extend to carry the steer clause if not already the same field.

## Task 0 — audit first (read-only)

Record file:line verdicts: the `.pill`/`.bubble` glass token values; `#ref-modal` markup + open/tab handlers + where `sessionRefs`/`currentRefStage` live; how the amplify note enters the prompt (the run-payload field + server clause); whether `FLOWS` exists yet. If reality diverges from the above, note it and proceed sensibly.

## Tasks

1. `.glass-surface` + restyle the modal card/tabs/dropzone/buttons. Commit.
2. Steer dropdowns: `STEER_SETS` config + markup + render on open/tab-switch (loosened gap). Commit.
3. Stack, persist per stage, custom-add, clear-with-stage. Commit.
4. Wire active steers into the next run via the amplify-note path; confirm a steer phrase reaches the resolved prompt in a trace. Commit.

## Done when

Modal reads as liquid glass matching the pill/bubbles; Sketch shows Spread/Form/Complexity and Render shows Color/Weight + More; picks stack, persist per stage, clear; a steer phrase reaches the resolved prompt. (Visual/Playwright checks: pending human review.)

## Out of scope

Structured router-lever controls (we chose lightweight steer phrases); new dimensions; mockup stage; DB/schema changes.
