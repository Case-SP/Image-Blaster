require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { loadCartridge } = require('./factory/cartridge');
const { buildShotList, buildRenderPrompts, buildShotListSystemPrompt, sanitizeShotMap } = require('./factory/shotList');
const { promptVariance } = require('./factory/variance');
const { classifyByCartridge, prefixByCartridge } = require('./factory/classifyByCartridge');
// critiqueShotList / runIntake / rewriteForGpt2 — used only by archived
// non-product cartridges. The orchestrator already gates these behind
// inputMode checks (object mode skips all three); these stubs catch any
// future regression that tries to call them outside object mode.
const critiqueShotList = () => { throw new Error('critic disabled (only product/object mode supported)'); };
const runIntake = () => { throw new Error('intake disabled (only product/object mode supported)'); };
const rewriteForGpt2 = () => { throw new Error('gpt2Rewriter disabled (only product/object mode supported)'); };
const { renderOne, downloadImage } = require('./render/fal');
const { createTrace, readTrace } = require('./trace/store');
const createStorage = require('./storage');
const storage = createStorage();

async function runBatch({ cartridgeName = 'product', titles, N = 10, critic = true, model, models, aspectRatio, quality, debug = true, clientId = null, onTraceCreated, stage = null, parents = null, useParentAsSubject = false, referenceOverrides = null }) {
  const cartridge = loadCartridge(cartridgeName);

  // Staged + lineage support (object mode only). When `parents` is set, each
  // parent drives one synthetic title whose phrase bank carries the original
  // object name fused with the user's per-parent note. When `stage` is set,
  // we render only that composition instead of cycling style_order. Every
  // render item records its stage and parent for the staged-funnel UI.
  let parentByTitleId = null;
  let overridesByTitleId = null;
  if (Array.isArray(parents) && parents.length) {
    const { readTrace } = require('./trace/store');
    const resolvedTitles = [];
    parentByTitleId = {};
    overridesByTitleId = {};
    // Resolve cartridge dropdown keys → full phrases. Frontend sends keys
    // (e.g. material: "walnut"); we look them up in cartridge.profile.<dict>
    // and substitute the phrase. Falls back to the raw value on miss.
    const lookup = (dict, key) => {
      if (!key) return null;
      if (dict && Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
      return key;  // assume it's already a phrase
    };
    for (let i = 0; i < parents.length; i++) {
      const p = parents[i] || {};
      let originalTitle = p.title || null;
      // Also pull the parent's resolved prompt for THIS specific filename so
      // the product-shot prompt can include the original design intent.
      // Doing this in the same readTrace call as the title lookup so we only
      // hit Postgres once per parent.
      let parentPrompt = null;
      if (p.runId) {
        const ptrace = await readTrace(p.runId, clientId).catch(() => null);
        if (ptrace) {
          const ptitle = (ptrace.input?.titles || []).find(t => t.slug === p.slug);
          if (ptitle) {
            if (!originalTitle) originalTitle = ptitle.title;
            const items = ptrace.stages?.renders?.items?.[ptitle.id] || [];
            const item = items.find(it => it.filename === p.filename);
            const promptIdx = (item && typeof item.promptIdx === 'number') ? item.promptIdx : null;
            const prompts = ptrace.stages?.resolved?.prompts?.[ptitle.id] || [];
            const promptObj = (promptIdx != null) ? prompts[promptIdx] : prompts[0];
            const txt = promptObj?.prompt || promptObj?.text || null;
            if (txt) parentPrompt = String(txt).trim().slice(0, 500);
          }
        }
      }
      if (!originalTitle) originalTitle = p.slug || `parent-${i}`;

      const ov = p.overrides || {};
      const materialPhrase = lookup(cartridge.profile?.materials, ov.material);
      const colorPhrase = lookup(cartridge.profile?.colors, ov.color);
      const backgroundPhrase = lookup(cartridge.profile?.backgrounds, ov.background);
      const anglePhrase = lookup(cartridge.profile?.angles, ov.angle);
      const lensPhrase = lookup(cartridge.profile?.lenses, ov.lens);

      // Subject fusion. Two distinct shapes:
      //
      // (a) NO parent-as-subject: the title text IS the subject. Material,
      //     color, and note fuse into it as identity descriptors.
      //     "oak counter chair, walnut, warm cream"
      //
      // (b) parent-as-subject ON: the parent IMAGE is the subject. Text-side
      //     identity competes with the image and causes design drift, so we
      //     replace the title with a parent-pointing phrase. Material/color/
      //     note attach as TREATMENT modifiers applied to the parent's form.
      //     "the object shown in the first reference image, in walnut, in warm cream"
      let fused;
      if (useParentAsSubject) {
        const treatmentParts = ['the object shown in the reference image'];
        if (materialPhrase) treatmentParts.push(`in ${materialPhrase}`);
        if (colorPhrase) treatmentParts.push(`in ${colorPhrase}`);
        if (p.note) treatmentParts.push(p.note);
        fused = treatmentParts.join(', ');
      } else {
        const fusedParts = [originalTitle];
        if (materialPhrase) fusedParts.push(materialPhrase);
        if (colorPhrase) fusedParts.push(colorPhrase);
        if (p.note) fusedParts.push(p.note);
        fused = fusedParts.join(', ');
      }

      const id = `p-${Date.now()}-${i}`;
      resolvedTitles.push({
        id,
        title: fused,
        slug: (p.slug || originalTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50),
        category: 'general'
      });
      parentByTitleId[id] = { runId: p.runId, slug: p.slug, filename: p.filename, parentStage: p.stage || null, parentTitle: originalTitle, parentPrompt, note: p.note || null, overrides: ov, parentRefUrl: null };
      overridesByTitleId[id] = {
        slot_overrides: {
          ...(backgroundPhrase ? { background: backgroundPhrase } : {}),
          ...(anglePhrase ? { angle: anglePhrase } : {})
        },
        lensOverride: lensPhrase || null
      };
    }
    titles = resolvedTitles;

    // Pre-fetch parent image bytes once per parent and stash as data URI.
    // Vision-capable models (nano-banana-pro, kontext) will see this as the
    // first reference image with a strong "use this as the subject" prompt
    // prefix injected at render time. gpt-image-2 has no image input so it
    // stays text-only — its output may drift from the source object.
    if (useParentAsSubject) {
      for (const [tid, pref] of Object.entries(parentByTitleId)) {
        if (!pref.runId || !pref.slug || !pref.filename) continue;
        try {
          const buf = await storage.readImage(pref.runId, pref.slug, pref.filename);
          if (buf) {
            const ext = (String(pref.filename).match(/\.([a-z0-9]+)$/i) || [, 'png'])[1].toLowerCase();
            const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : (ext === 'webp' ? 'image/webp' : 'image/png');
            pref.parentRefUrl = `data:${mime};base64,${buf.toString('base64')}`;
          }
        } catch (e) {
          console.warn('[orchestrator] could not read parent image', pref.filename, e.message);
        }
      }
    }
  }
  // Cartridge can declare a default aspect ratio (e.g. '1:1' for product
  // catalog cartridges). Per-request aspectRatio still wins.
  if (!aspectRatio && cartridge.profile?.default_aspect_ratio) {
    aspectRatio = cartridge.profile.default_aspect_ratio;
  }
  // Accept either `models: string[]` (new, for 'both' mode) or legacy `model: string`.
  // Dedupe + preserve order. 'both' lets us render the same shot list across
  // multiple models so we can A/B the rewriter (keyword-stack → nano vs
  // prose-rewritten → gpt-2) without the shot list itself varying.
  let modelList = Array.from(new Set(
    (models && models.length ? models : [model]).filter(Boolean)
  ));
  if (!modelList.length) modelList.push(undefined); // fall back to render default
  // When the request is parent-as-subject:
  //   1. Auto-route the user's gpt-2 selection to gpt-2/edit. The base
  //      gpt-image-2 endpoint silently ignores image_urls (text-only); the
  //      /edit endpoint genuinely vision-conditions on the input. User just
  //      sees "gpt-2" in the bubble — system picks the right variant per stage.
  //   2. Drop any model that still can't honor the parent (flux-pro/v1.1-ultra).
  if (useParentAsSubject) {
    modelList = modelList.map(m => m === 'openai/gpt-image-2' ? 'openai/gpt-image-2/edit' : m);
    const VISION = new Set(['fal-ai/nano-banana-pro', 'fal-ai/flux-pro/kontext', 'openai/gpt-image-2/edit']);
    const filtered = modelList.filter(m => VISION.has(m));
    if (filtered.length) modelList = filtered;
    else modelList = ['fal-ai/nano-banana-pro'];
  }
  const needsRewrite = modelList.includes('openai/gpt-image-2');

  // Object-context classification. One Haiku call per batch, classifies each
  // title into a generalized spatial schema (mounting, scale, use-height,
  // orientation, environments). The result is cached on trace.input so:
  //   - In-situ prompts inject hard facts about how the object actually sits
  //     in the world (no more wall-mounted lamps near the floor).
  //   - Promote runs reuse the parent trace's cached context — no re-classify.
  // Promote runs (parents present) reuse the parent's classification when
  // available; we only classify fresh titles. Parents come pre-merged into
  // `titles` above with synthetic `p-...` IDs, so we look up the cached
  // context by the original parent slug from each parent's source trace.
  let objectContext = {};
  try {
    if (Array.isArray(parents) && parents.length) {
      // Promote: try parent traces first.
      for (let i = 0; i < parents.length && i < titles.length; i++) {
        const p = parents[i];
        const tid = titles[i].id;
        if (!p?.runId || !p?.slug) continue;
        const ptrace = await readTrace(p.runId, clientId).catch(() => null);
        const ptitle = ptrace?.input?.titles?.find(t => t.slug === p.slug);
        const cached = ptrace?.input?.objectContext?.[ptitle?.id];
        if (cached) objectContext[tid] = cached;
      }
      // Any promote title that didn't have a cached context, classify fresh.
      const missing = titles.filter(t => !objectContext[t.id]);
      if (missing.length) {
        const fresh = await classifyByCartridge(cartridge, missing);
        Object.assign(objectContext, fresh);
      }
    } else {
      // Fresh input: classify all titles.
      objectContext = await classifyByCartridge(cartridge, titles);
    }
  } catch (e) {
    console.warn('[objectContext] classification failed (continuing):', e.message);
    objectContext = {};
  }

  const trace = createTrace({
    cartridge: cartridgeName,
    input: { titles, N, stage: stage || null, objectContext, options: { critic, model: modelList[0], models: modelList, aspectRatio, quality, classifier_model: cartridge?.profile?.classifier_model || null } },
    clientId
  });
  if (typeof onTraceCreated === 'function') {
    try { onTraceCreated(trace); } catch (e) { console.warn('[orchestrator] onTraceCreated threw:', e.message); }
  }

  try {
    // STAGE 1: shot list — branches on cartridge.profile.input_mode.
    // - 'title' (default): the standard pipeline. One LLM call per batch
    //   produces N shots per title across the cartridge's full vocabulary
    //   (compositions × subjects × themes).
    // - 'intake': for layout-driven cartridges with a single composition
    //   (e.g. demo's contact-sheet-2x3). Each input becomes N parallel
    //   intake calls (one per render), each emitting 6 panel phrases that
    //   land as slot_overrides on a single shot. Critic + rewriter are
    //   skipped because there's nothing to critique (one composition, one
    //   theme) and a candid-photo rewrite would mangle the grid prompt.
    const inputMode = cartridge.profile?.input_mode || 'title';

    let shotMap;
    if (inputMode === 'object') {
      // Deterministic mode for object-catalog cartridges. The pipeline runs in
      // a fixed order: (1) style is decided first by cycling profile.style_order
      // (or compositions.json key order as fallback); (2) inside the chosen
      // style the resolver picks angle, lens, distance, lighting, etc. from
      // that composition's slot banks. No LLM call. The input text IS the
      // subject and gets substituted verbatim via a per-title phrase bank.
      trace.startStage('shotList', { mode: 'object' });
      const compKeys = Object.keys(cartridge.compositions);
      const declared = Array.isArray(cartridge.profile?.style_order) ? cartridge.profile.style_order : null;
      const styleOrder = declared
        ? declared.filter(s => cartridge.compositions[s])
        : compKeys;
      // Append any compositions defined in compositions.json but missing from
      // the declared order so nothing silently drops out of rotation.
      for (const k of compKeys) if (!styleOrder.includes(k)) styleOrder.push(k);

      const themeNames = Object.keys(cartridge.themes);
      if (!styleOrder.length || !themeNames.length) {
        throw new Error(`object-mode cartridge "${cartridge.name}" needs at least 1 composition and 1 theme`);
      }
      const subjectType = Object.keys(cartridge.subjects)[0] || 'object';
      const theme = themeNames[0];
      const subjDef = cartridge.subjects[subjectType];
      subjDef.phrase_banks = subjDef.phrase_banks || {};

      // When a single `stage` is requested, restrict the cycle to that one
      // composition. Otherwise rotate through the full style_order.
      const styleCycle = (stage && cartridge.compositions[stage]) ? [stage] : styleOrder;

      // Context-aware setting picker for in-situ shots. Titles get matched
      // against cartridge.profile.context_keywords; matching tags collect a
      // pool from settings_by_context. A sink lands in bath/kitchen, not a
      // museum. Falls back to settings_by_context.default if nothing matches.
      const contextKeywords = cartridge.profile?.context_keywords || null;
      const settingsByContext = cartridge.profile?.settings_by_context || null;
      function inferContextTags(titleText) {
        if (!contextKeywords) return [];
        const lower = String(titleText || '').toLowerCase();
        const tags = [];
        for (const [tag, keywords] of Object.entries(contextKeywords)) {
          if (Array.isArray(keywords) && keywords.some(k => k && lower.includes(String(k).toLowerCase()))) {
            tags.push(tag);
          }
        }
        return tags;
      }
      function pickContextualSetting(tags, seed) {
        if (!settingsByContext) return null;
        let pool = [];
        for (const tag of tags) pool.push(...(settingsByContext[tag] || []));
        if (!pool.length) pool = settingsByContext.default || [];
        if (!pool.length) return null;
        return pool[Math.abs(seed) % pool.length];
      }

      const playRatio = Math.max(0, Math.min(1, parseFloat(cartridge.profile?.play_ratio ?? 0)));

      shotMap = {};
      for (const title of titles) {
        subjDef.phrase_banks[title.id] = [title.title];
        const ov = overridesByTitleId?.[title.id] || null;
        const tags = inferContextTags(title.title);
        const titleSeedDigits = parseInt(String(title.id).replace(/\D/g, '').slice(-6) || '0', 10);
        const shots = [];
        for (let i = 0; i < N; i++) {
          const styleIdx = i % styleCycle.length;
          const composition = styleCycle[styleIdx];
          // Per-shot deterministic dice roll for play mode. Each shot gets
          // its own seed offset so a 3-shot batch can include a mix of
          // prescriptive (slot-stitched) and play (loose, ref-driven) prompts.
          // Play mode is disabled when the request is parent-as-subject —
          // wildcards have no "use parent as subject" prefix, so they ignore
          // the parent image and drift. Stay prescriptive when promoting.
          const shotSeed = titleSeedDigits * 31 + i * 1009;
          const compDef = cartridge.compositions[composition];
          const wildcards = compDef?.wildcard_skeletons;
          const playRoll = ((shotSeed * 9301 + 49297) % 233280) / 233280;
          const isPlay = !ov && !useParentAsSubject && wildcards && wildcards.length && playRoll < playRatio;
          const shot = {
            composition,
            subject_type: subjectType,
            subject_topic: title.id,
            theme,
            model_spec: null,
            __styleIndex: styleIdx,
            __style: composition,
            __contextTags: tags
          };
          if (isPlay) {
            shot.__playSkeleton = wildcards[Math.abs(shotSeed) % wildcards.length];
          }
          if (ov) {
            if (ov.slot_overrides && Object.keys(ov.slot_overrides).length) {
              shot.slot_overrides = { ...ov.slot_overrides };
            }
            if (ov.lensOverride) shot.__lensOverride = ov.lensOverride;
          }
          // Style mix — when a composition declares `style_mix: { count: N }`
          // and the cartridge has a `styles` dict on profile, pick N distinct
          // styles deterministically per shot and join the prose into a single
          // string under slot_overrides.style_mix. Used by the logos sketch
          // composition to explore multiple visual directions on one sheet.
          // Skipped under play mode (wildcard skeletons don't reference style_mix).
          const styleMixCfg = compDef?.style_mix;
          const stylesDict = cartridge.profile?.styles;
          if (!isPlay && styleMixCfg?.count && stylesDict && Object.keys(stylesDict).length) {
            // Approach 2 — brand-appropriate spread. The Register Router brief
            // lives at objectContext[title.id] (Task 0 audit: the orchestrator's
            // classifier context var is `objectContext`, NOT `classifierContext`
            // as the spec snippet shows). When a brief is present, spread across
            // the brand's register shortlist, rotating by shot index so
            // consecutive sketches lead with a different primary while staying
            // within the brand's set. Fall back to the original seeded-random
            // pick (brand-agnostic) when no brief is available.
            const brief = objectContext[title.id];
            let picks;
            if (brief?.registers?.length) {
              const regs = brief.registers.filter(k => stylesDict[k]);
              const rotated = regs.map((_, j) => regs[(j + i) % regs.length]);
              picks = rotated.slice(0, Math.min(styleMixCfg.count, rotated.length));
            } else {
              const styleKeys = Object.keys(stylesDict);
              const targetCount = Math.min(styleMixCfg.count, styleKeys.length);
              picks = [];
              let s = shotSeed * 73 + 17;
              while (picks.length < targetCount) {
                s = (s * 9301 + 49297) % 233280;
                const key = styleKeys[s % styleKeys.length];
                if (!picks.includes(key)) picks.push(key);
              }
            }
            const proseList = picks.map(k => stylesDict[k]).join(' / ');
            shot.slot_overrides = shot.slot_overrides || {};
            if (!shot.slot_overrides.style_mix) shot.slot_overrides.style_mix = proseList;
            shot.__stylesPicked = picks;
          }

          // Palette policy — the Register Router's palette_policy decides whether
          // the sketch grid stays mono or uses a brand color: mono brands never
          // pick a color slot; color-policy brands prefer them. Sketch stays FLAT
          // either way (the color slots are solid-fill, no gradient). Accessor is
          // objectContext[title.id] per Task 0 (NOT classifierContext).
          if (composition === 'sketch') {
            const pol = objectContext[title.id]?.palette_policy || 'mono';
            shot.slot_overrides = shot.slot_overrides || {};
            if (!shot.slot_overrides.palette) {
              const palettes = compDef.slots?.palette || [];
              const isColor = p => /brand[- ]color|brand hue|saturated/.test(p);
              const monos = palettes.filter(p => !isColor(p));
              const colors = palettes.filter(isColor);
              const pickFrom = (pol === 'mono' || !colors.length) ? monos
                : (pol === 'one-saturated-field' ? colors.filter(p => /saturated/.test(p)).concat(colors) : colors);
              if (pickFrom.length) shot.slot_overrides.palette = pickFrom[Math.abs(shotSeed) % pickFrom.length];
            }
          }

          // Brand name for the wordmark. The classifier extracts the clean
          // brand_name from the raw title ("Warp" from "warp ... 003"); feed it
          // into any composition with a {brand_name} sink (logos render's
          // wordmark) so the wordmark reads the brand, not the full input title
          // (incl. descriptor + blast suffix). No-op for cartridges whose
          // classifier returns no brand_name (e.g. product) or compositions
          // without the placeholder.
          {
            const brandName = objectContext[title.id]?.brand_name;
            if (brandName) {
              shot.slot_overrides = shot.slot_overrides || {};
              if (!shot.slot_overrides.brand_name) shot.slot_overrides.brand_name = brandName;
            }
          }

          // Per-stage treatment ceiling — stage-scoped suffix. Only built when
          // this stage's stage_resolution declares a ceiling (treatment /
          // negatives / positives); otherwise __stageSuffix stays unset so the
          // cartridge-level suffix.md remains the default (product unaffected).
          // `from_brief` upgrades render by the brand's render_treatment; sketch
          // is pinned flat. Accessor objectContext[title.id] per Task 0.
          {
            const sr = cartridge.profile?.stage_resolution?.[composition] || {};
            if (sr.treatment || sr.negatives || sr.positives || sr.positives_by_treatment) {
              let stageNegatives = sr.negatives || '';
              let stagePositives = sr.positives || '';
              if (sr.treatment === 'from_brief') {
                const t = objectContext[title.id]?.render_treatment || 'flat';
                stagePositives = sr.positives_by_treatment?.[t] || sr.positives_by_treatment?.flat || '';
                if (t === 'flat') stageNegatives = 'no fake glows, no drop shadows';
              }
              shot.__stageSuffix = { positives: stagePositives, negatives: stageNegatives };
            }
          }

          // For in-situ specifically, override the setting slot with a
          // context-appropriate pick. Different shot indexes get different
          // pool members so 3 in-situ shots of "sink" don't all show the
          // same bathroom.
          if (composition === 'in-situ' && settingsByContext && !isPlay) {
            const settingPick = pickContextualSetting(
              tags,
              i * 17 + (parseInt(String(title.id).replace(/\D/g, '').slice(-6) || '0', 10))
            );
            if (settingPick) {
              shot.slot_overrides = shot.slot_overrides || {};
              if (!shot.slot_overrides.setting) shot.slot_overrides.setting = settingPick;
            }
            // Per-tag slot overrides — e.g. surface-macro forces no-figure +
            // macro framing + still-plate camera-move so a tiny ring doesn't
            // pick up "two figures in conversation in the background".
            const tagOverrides = cartridge.profile?.slot_overrides_by_context || null;
            if (tagOverrides) {
              for (const tag of tags) {
                const ov = tagOverrides[tag];
                if (!ov) continue;
                shot.slot_overrides = shot.slot_overrides || {};
                for (const [k, v] of Object.entries(ov)) {
                  if (!shot.slot_overrides[k]) shot.slot_overrides[k] = v;
                }
              }
            }
          }
          shots.push(shot);
        }
        shotMap[title.id] = { shots };
      }
      trace.finishStage('shotList', {
        mode: 'object',
        titles: titles.length,
        shotsPerTitle: N,
        styleOrder,
        styleCycle,
        stage: stage || null,
        cycle: Array.from({ length: N }, (_, i) => styleCycle[i % styleCycle.length]),
        raw: shotMap,
        parents: parentByTitleId ? Object.values(parentByTitleId) : null
      });
    } else if (inputMode === 'intake') {
      trace.startStage('shotList', { mode: 'intake' });
      const intakeResults = [];
      const compNames = Object.keys(cartridge.compositions);
      const themeNames = Object.keys(cartridge.themes);
      if (!compNames.length || !themeNames.length) {
        throw new Error(`intake-mode cartridge "${cartridge.name}" needs at least 1 composition and 1 theme`);
      }
      const composition = compNames[0];
      const theme = themeNames[0];
      const subjectType = Object.keys(cartridge.subjects)[0] || 'panel-mix';

      shotMap = {};
      // Rolling window of axes used in recent shots — fed back into the intake
      // prompt so each call knows what's already been covered. Across-input
      // memory pushes the LLM toward unused territories; without it every
      // input independently re-anchors on the same 2-3 safe axes.
      const ROLLING_AXES_WINDOW = 12; // last ~2 contact sheets worth (6 panels each)
      const recentAxes = [];
      for (const title of titles) {
        const shots = [];
        for (let i = 0; i < N; i++) {
          try {
            const window = recentAxes.slice(-ROLLING_AXES_WINDOW);
            const { panels, axesUsed, meta } = await runIntake({
              cartridge, input: title.title, recentlyUsedAxes: window
            });
            shots.push({
              composition, subject_type: subjectType, subject_topic: 'default', theme,
              model_spec: null,
              axes_used: axesUsed,
              slot_overrides: { p1: panels[0], p2: panels[1], p3: panels[2], p4: panels[3], p5: panels[4], p6: panels[5] }
            });
            recentAxes.push(...axesUsed);
            intakeResults.push({
              titleId: title.id, shotIdx: i, ok: true,
              elapsedMs: meta.elapsedMs,
              panelChars: panels.map(p => p.length),
              axesUsed,
              recentlyUsedAxes: window
            });
          } catch (e) {
            shots.push({ composition, subject_type: subjectType, subject_topic: 'default', theme, model_spec: null, __error: e.message });
            intakeResults.push({ titleId: title.id, shotIdx: i, ok: false, error: e.message });
          }
        }
        shotMap[title.id] = { shots };
      }
      const okCount = intakeResults.filter(r => r.ok).length;
      trace.finishStage('shotList', {
        mode: 'intake',
        intakeCalls: intakeResults.length,
        ok: okCount,
        failed: intakeResults.length - okCount,
        results: intakeResults,
        raw: shotMap
      });
    } else {
      trace.startStage('shotList');
      const systemPrompt = debug ? buildShotListSystemPrompt(cartridge, N) : null;
      const shotResult = await buildShotList(cartridge, titles, { N });
      trace.finishStage('shotList', {
        model: shotResult.meta.model,
        elapsedMs: shotResult.meta.elapsedMs,
        tokensUsed: shotResult.meta.tokensUsed,
        systemPromptChars: shotResult.meta.systemPromptChars,
        userPromptChars: shotResult.meta.userPromptChars,
        systemPrompt: debug ? systemPrompt : undefined,
        raw: shotResult.raw,
        variance: shotResult.variance
      });
      shotMap = shotResult.raw;
    }

    // STAGE 2: critic — skipped in intake mode (single composition + theme,
    // nothing to critique; would just burn a Haiku call per batch).
    // Also skipped in object mode — the shot list is hand-rolled and there's
    // nothing for the critic to revise.
    if (inputMode === 'intake' || inputMode === 'object') {
      trace.updateStage('critic', { status: 'skipped', reason: `${inputMode} mode` });
    } else if (critic) {
      trace.startStage('critic', { enabled: true });
      try {
        const crit = await critiqueShotList(cartridge, titles, shotMap, { N });
        shotMap = crit.revised;
        trace.finishStage('critic', { model: crit.meta.model, elapsedMs: crit.meta.elapsedMs, revised: crit.revised, diff: crit.diff });
      } catch (e) {
        trace.failStage('critic', e);
      }
    } else {
      trace.updateStage('critic', { status: 'skipped', enabled: false });
    }

    // STAGE 2b: sanitize — auto-correct invalid LLM names. Skipped in intake
    // mode because the sanitizer's VALID_SUBJECTS list is hardcoded for Nolla
    // (powder, liquid, person-beauty, ...). For intake-mode cartridges with
    // their own subject vocabulary it would "fix" valid entries into broken ones.
    let substitutions = [];
    if (inputMode !== 'intake' && inputMode !== 'object') {
      const result = sanitizeShotMap(cartridge, shotMap);
      shotMap = result.sanitized;
      substitutions = result.substitutions;
    }

    // STAGE 2c: theme-lock per title when N <= 5 so each title's shots form a
    // visual series (single palette). Pick the most-common theme the LLM chose
    // for that title; tie-break to the earliest shot. Skipped in object mode
    // (single theme already by construction).
    if (N <= 5 && inputMode !== 'object') {
      for (const [tid, sel] of Object.entries(shotMap)) {
        const shots = sel?.shots || [];
        if (shots.length < 2) continue;
        const counts = {};
        shots.forEach(s => { if (s.theme) counts[s.theme] = (counts[s.theme] || 0) + 1; });
        const entries = Object.entries(counts);
        if (!entries.length) continue;
        const maxCount = Math.max(...entries.map(([, c]) => c));
        const tied = entries.filter(([, c]) => c === maxCount).map(([k]) => k);
        const winner = tied.length === 1
          ? tied[0]
          : shots.find(s => tied.includes(s.theme))?.theme;
        if (!winner) continue;
        shots.forEach((s, i) => {
          if (s.theme !== winner) {
            substitutions.push({ titleId: tid, shotIdx: i, field: 'theme', before: s.theme, after: winner, reason: 'theme-lock (N<=5)' });
            s.theme = winner;
          }
        });
      }
    }

    // STAGE 3: resolve prompts
    trace.startStage('resolved');
    const resolved = buildRenderPrompts(cartridge, titles, shotMap, { batchSeed: Date.now() });
    const promptVar = {};
    const resolveErrors = {};
    for (const [tid, arr] of Object.entries(resolved)) {
      const okPrompts = arr.filter(p => !p.__error && p.prompt).map(p => p.prompt);
      promptVar[tid] = promptVariance(okPrompts);
      const errs = arr.filter(p => p.__error).map(p => ({ composition: p.composition, subject_type: p.subject_type, error: p.__error }));
      if (errs.length) resolveErrors[tid] = errs;
    }
    trace.finishStage('resolved', { prompts: resolved, promptVariance: promptVar, resolveErrors, substitutions });

    // STAGE 3.5: model-specific rewrite. gpt-image-2 wants candid-photography
    // prose, not keyword stacks — rewrite each prompt through the 9-move
    // template (engine) + cartridge.gpt2Voice (brand flavor). The rewrite is
    // stored on shot.__gpt2Prompt (NOT mutating shot.prompt) so a single shot
    // list can feed both models in 'both' mode — nano gets shot.prompt,
    // gpt-2 gets shot.__gpt2Prompt, and we can diff them against each other.
    // Skip gpt-2 rewrite in intake mode — the 9-move candid-photo template
    // would mangle a layout-driven grid prompt.
    if (!needsRewrite) {
      trace.updateStage('gpt2Rewrite', { status: 'skipped', reason: 'no gpt-image-2 model in this run' });
    } else if (inputMode === 'intake') {
      trace.updateStage('gpt2Rewrite', { status: 'skipped', reason: 'intake mode (grid prompt incompatible with 9-move rewrite)' });
    } else if (inputMode === 'object') {
      trace.updateStage('gpt2Rewrite', { status: 'skipped', reason: 'object mode (deterministic shot list)' });
    } else if (needsRewrite) {
      trace.startStage('gpt2Rewrite');
      const REWRITE_CONCURRENCY = Math.max(1, Math.min(10, parseInt(process.env.REWRITE_CONCURRENCY || '5', 10)));
      const rewriteTasks = [];
      for (const [tid, arr] of Object.entries(resolved)) {
        for (let i = 0; i < arr.length; i++) {
          const shot = arr[i];
          if (shot.__error || !shot.prompt) continue;
          rewriteTasks.push({ tid, i, shot });
        }
      }
      const rewriteResults = [];
      const rewriteInflight = new Set();
      const rewriteOne = async ({ tid, i, shot }) => {
        try {
          const { rewritten, meta } = await rewriteForGpt2({
            prompt: shot.prompt,
            brandVoice: cartridge.gpt2Voice || '',
            context: {
              subject_type: shot.subject_type,
              subject_topic: shot.subject_topic,
              composition: shot.composition,
              body_region: shot.body_region,
              theme: shot.theme,
              affliction_detail: shot.affliction_detail
            }
          });
          shot.__gpt2Prompt = rewritten;
          rewriteResults.push({ tid, i, ok: true, chars: rewritten.length, elapsedMs: meta.elapsedMs });
        } catch (e) {
          rewriteResults.push({ tid, i, ok: false, error: e.message });
        }
      };
      for (const task of rewriteTasks) {
        const p = rewriteOne(task).finally(() => rewriteInflight.delete(p));
        rewriteInflight.add(p);
        if (rewriteInflight.size >= REWRITE_CONCURRENCY) await Promise.race(rewriteInflight);
      }
      await Promise.all(rewriteInflight);
      const okCount = rewriteResults.filter(r => r.ok).length;
      trace.finishStage('gpt2Rewrite', {
        totalShots: rewriteTasks.length,
        rewritten: okCount,
        failed: rewriteTasks.length - okCount,
        results: rewriteResults
      });
    }

    // STAGE 4: render — one render per (shot × model). In 'both' mode each
    // shot fans out twice; filenames are model-suffixed so they don't collide
    // on disk. gpt-2 reads shot.__gpt2Prompt when present (falls back to the
    // keyword-stack prompt on rewrite failure); everything else reads shot.prompt.
    trace.startStage('renders');
    const CONCURRENCY = Math.max(1, Math.min(20, parseInt(process.env.RENDER_CONCURRENCY || '5', 10)));
    const modelSuffix = (m) => {
      if (!m) return 'default';
      if (m === 'openai/gpt-image-2/edit') return 'gpt2e';
      if (m.includes('gpt-image-2')) return 'gpt2';
      if (m.includes('nano-banana')) return 'nano';
      if (m.includes('flux-pro')) return 'flux';
      return m.split('/').pop().replace(/[^a-z0-9]+/gi, '-');
    };
    const tasks = [];
    for (const title of titles) {
      const shots = resolved[title.id] || [];
      for (let i = 0; i < shots.length; i++) {
        for (const m of modelList) {
          tasks.push({ title, shot: shots[i], idx: i, model: m });
        }
      }
    }

    // Per-shot ref filter: if any references are style-tagged AND the shot's
    // composition matches a tag, scope refs to that style. Untagged refs always
    // remain as fallback. Cartridges with no tagged refs get the full set as
    // before.
    const tagged = cartridge.references.filter(r => r.style);
    const styleTags = new Set(tagged.map(r => r.style));
    // Normalize user-dropped reference overrides per stage. Shape:
    //   referenceOverrides = { sketch: [{filename, dataUrl}], ... }
    // When the user supplies refs for a stage, we COMPLETELY replace the
    // cartridge refs for that stage — that's the point of "override". Other
    // stages still use cartridge defaults. The structure supports any stage,
    // so adding product-shot/in-situ overrides later is just a UI change.
    const overridesByStage = {};
    if (referenceOverrides && typeof referenceOverrides === 'object') {
      for (const [stg, arr] of Object.entries(referenceOverrides)) {
        if (!Array.isArray(arr) || !arr.length) continue;
        overridesByStage[stg] = arr.map((r, i) => ({
          filename: r.filename || `override-${i + 1}.png`,
          style: stg,
          url: r.dataUrl || r.url
        })).filter(r => r.url);
      }
    }
    const refsForComposition = (compName) => {
      if (overridesByStage[compName]?.length) return overridesByStage[compName];
      if (!styleTags.size) return cartridge.references;
      // Compositions can declare ref_sources to pull from MULTIPLE style tags
      // simultaneously (e.g. logos Stage 2 reads from logo-only/ + wordmark/).
      // Untagged refs always remain as fallback. When ref_sources is absent,
      // fall back to the single-tag match (today's behavior).
      const compDef = cartridge.compositions[compName] || {};
      const declaredSources = Array.isArray(compDef.ref_sources) ? compDef.ref_sources : null;
      const styleScoped = declaredSources
        ? cartridge.references.filter(r => r.style && declaredSources.includes(r.style))
        : (styleTags.has(compName) ? cartridge.references.filter(r => r.style === compName) : []);
      const untagged = cartridge.references.filter(r => !r.style);
      return styleScoped.length ? [...styleScoped, ...untagged] : cartridge.references;
    };

    const runOne = async ({ title, shot, idx, model: m }) => {
      const suffix = modelList.length > 1 ? `-${modelSuffix(m)}` : '';
      const filename = `gen-${String(idx + 1).padStart(3, '0')}${suffix}.png`;
      if (shot.__error) {
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'failed', error: 'resolve: ' + shot.__error, stage: 'resolve', model: m });
        return;
      }
      let prompt = (m === 'openai/gpt-image-2' && shot.__gpt2Prompt) ? shot.__gpt2Prompt : shot.prompt;
      let refs = refsForComposition(shot.composition);
      const stageTag = shot.composition;
      const parentRef = parentByTitleId?.[title.id] || null;

      // Fresh-run classifier prefix injection. Promote runs handle this inside
      // the parent-as-subject prefix block (see contextFacts below). For fresh
      // input, prepend the classifier's stage-agnostic prefix once so brand
      // attributes / object facts actually steer the prompt. No-op when the
      // classifier returned nothing or there's no parent-as-subject conflict.
      if (!parentRef?.parentRefUrl) {
        const freshCtx = objectContext[title.id] || null;
        const freshPrefix = freshCtx ? prefixByCartridge(cartridge, freshCtx) : '';
        if (freshPrefix) prompt = `${freshPrefix} ${prompt}`;
      }

      // Vision-conditioned promotion: when the request is a cross-stage
      // promote AND the model accepts an image input, prepend the parent
      // image as the first reference and prefix the prompt so the model
      // treats it as the literal subject. The prefix is shaped by the
      // PARENT's stage:
      //   sketch  → "interpret as a design sketch, render the actual object"
      //   product → "this is the exact object, render it again in a new scene"
      //   in-situ → same as product (already a photograph of the object)
      // nano-banana-pro accepts multi-image refs (parent first); kontext
      // takes a single image (parent only). gpt-image-2 has no image input
      // → text-only, may drift.
      const VISION_MODELS = new Set(['fal-ai/nano-banana-pro', 'fal-ai/flux-pro/kontext', 'openai/gpt-image-2/edit']);
      if (parentRef?.parentRefUrl && VISION_MODELS.has(m)) {
        // Parent-as-subject is on. The parent image must be the FIRST
        // reference (subject anchor). When the user supplied vibe refs for
        // this stage (e.g. dropped sketch refs that should also steer the
        // product render), append them after the parent — they shape look
        // and material without competing for subject identity. Cartridge
        // style refs are skipped to prevent subject dilution.
        const stageOverrides = overridesByStage[shot.composition] || [];
        // Cartridge style refs are normally skipped on promote to keep the
        // parent the sole subject. EXCEPTION: a composition that declares
        // `ref_sources` (e.g. logos render's logo-only + wordmark) uses those
        // as STYLE-SYSTEM anchors, not subject competitors — append them after
        // the parent so the finished-system look carries through. User
        // overrides, when present, still replace them (override semantics).
        const promoteCompDef = cartridge.compositions[shot.composition] || {};
        const dualSourceRefs = (promoteCompDef.ref_sources && !stageOverrides.length)
          ? cartridge.references.filter(r => r.style && promoteCompDef.ref_sources.includes(r.style))
          : [];
        refs = [
          { filename: 'parent.png', style: 'parent', url: parentRef.parentRefUrl },
          ...stageOverrides,
          ...dualSourceRefs
        ];
        const parentStage = parentRef.parentStage || null;
        const parentTitle = parentRef.parentTitle || 'the depicted object';
        const parentPrompt = parentRef.parentPrompt || null;
        const isIterate = parentStage && parentStage === shot.composition;
        // Quote-safe rendering: collapse internal quotes so we don't
        // accidentally close the outer quote or trip the model's parser.
        const intent = parentPrompt
          ? ` The original design intent for that ${parentTitle} was: ${parentPrompt.replace(/["']/g, '').replace(/\s+/g, ' ').trim()}.`
          : '';
        // Object-context facts (mounting, scale, use-height, orientation,
        // typical environments). Most useful for in-situ where the model
        // otherwise floats objects at arbitrary heights. Empty string when
        // classification didn't run or returned nothing.
        const ctx = objectContext[title.id] || null;
        const contextFacts = ctx
          ? ' ' + prefixByCartridge(cartridge, ctx)
          : '';
        // Promote prefix lookup. Cartridges can declare prefixes in
        // profile.promote_prefixes keyed by transition:
        //   - "iterate"           same-stage amplify
        //   - "{from}_to_{to}"    cross-stage promote (e.g. "sketch_to_product-shot")
        // Falls back to the hardcoded product-cartridge prose for cartridges
        // that don't declare them. {parentTitle} and {intent} are interpolated.
        const transition = isIterate
          ? 'iterate'
          : `${parentStage || 'unknown'}_to_${shot.composition}`;
        const prefixTemplates = cartridge.profile?.promote_prefixes || {};
        const interp = (tpl) => tpl
          .replace(/\{parentTitle\}/g, parentTitle)
          .replace(/\{intent\}/g, intent);

        let prefix;
        if (prefixTemplates[transition]) {
          prefix = interp(prefixTemplates[transition]);
        } else if (isIterate) {
          // Same-stage amplify — "iterate on this" mode (product fallback).
          prefix = `CRITICAL: Iterate on the reference image, which depicts a ${parentTitle}. Use it as the starting point and produce a close variation of the same design — keep the silhouette, proportions, key features, and overall identity faithful to the reference. Vary only the framing, angle, light, surface treatment, or composition. The output must clearly belong to the same family as the reference.${intent} Apply the following direction to the variation:`;
        } else if (parentStage === 'sketch') {
          // Cross-stage: sketch → product (product fallback). The first
          // reference is a hand-drawn design; the original sketch prompt
          // (intent) tells the model what the sketch was meant to show.
          prefix = `CRITICAL: The first reference image is a hand-drawn design sketch of a ${parentTitle}.${intent} Render that exact ${parentTitle} as a real product photograph — interpret the sketch as the design intent and faithfully preserve its silhouette, proportions, joinery, and every key feature. The output must be a photographic render of a real ${parentTitle}, NOT a copy of the line drawing, NOT an icon or illustration. If the sketch shows multiple variants or a process diagram, focus on the most resolved final form. Any additional reference images shown after the first are vibe cues — use them for material, surface, lighting, and palette guidance, NOT as alternate subjects. Then place that ${parentTitle} in the following scene:`;
        } else {
          // Cross-stage: product → in-situ (product fallback).
          prefix = `CRITICAL: The first reference image shows the EXACT ${parentTitle} to render. The object in the output image must be visually identical to the ${parentTitle} in the reference — same form, silhouette, proportions, construction, materials, finish, and color. Do not invent a new ${parentTitle}.${intent}${contextFacts} Any additional reference images shown after the first are vibe cues — use them for setting, atmosphere, and palette guidance, NOT as alternate subjects. Then place that exact ${parentTitle} in the following scene:`;
        }
        prompt = `${prefix} ${prompt}`;
      }

      const refCount = refs.length;
      const refBudget = Math.max(1, Math.min(16, parseInt(cartridge.profile?.ref_budget ?? process.env.REF_BUDGET ?? '8', 10)));
      const refsAttached = Math.min(refCount, refBudget);
      try {
        const img = await renderOne(prompt, {
          model: m,
          aspectRatio,
          quality,
          references: refs,
          refBudget,
          stage: shot.composition,
          stageResolution: cartridge.profile?.stage_resolution || null
        });
        const buf = await downloadImage(img.url);
        const metadata = { ...shot, prompt, model: img.model, generatedAt: new Date().toISOString(), runId: trace.id, refsAttached, refsAvailable: refCount, stage: stageTag, parent: parentRef };
        await storage.writeImage(trace.id, title.slug, filename, buf, metadata);
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'ok', elapsedMs: img.elapsedMs, model: img.model, refsAttached, refsAvailable: refCount, stage: stageTag, parent: parentRef });
      } catch (e) {
        trace.recordRenderItem(title.id, { promptIdx: idx, filename, status: 'failed', error: e.message, model: m, refsAttached, refsAvailable: refCount, stage: stageTag, parent: parentRef });
      }
    };

    const inflight = new Set();
    for (const task of tasks) {
      const p = runOne(task).finally(() => inflight.delete(p));
      inflight.add(p);
      if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    trace.finishStage('renders');
    trace.finish();
  } catch (e) {
    trace.fail(e);
    throw e;
  }

  return trace.id;
}

module.exports = { runBatch };
