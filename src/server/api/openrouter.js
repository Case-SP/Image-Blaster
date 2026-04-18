const fs = require('fs');
const path = require('path');
const { loadSettings, clearSettingsCache, CONFIG_DIR } = require('../../utils/config');

const configPath = CONFIG_DIR;
const settingsPath = path.join(configPath, 'settings.json');

// ============================================
// Tier Loading Functions (Single Client)
// ============================================

function saveSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  clearSettingsCache();
}

/**
 * Load Tier 1: Studio Rules
 * Returns raw markdown content
 */
function loadStudioRules() {
  const rulesPath = path.join(configPath, 'studio-rules.md');
  if (!fs.existsSync(rulesPath)) {
    return null;
  }
  return fs.readFileSync(rulesPath, 'utf8');
}

/**
 * Load Client Profile (single client, hardcoded path)
 * Returns { name, guardrails, content, references }
 */
function loadClientProfile() {
  const profilePath = path.join(configPath, 'client', 'profile.json');
  if (!fs.existsSync(profilePath)) {
    return null;
  }

  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

  // Required: brand_name (for display)
  const name = profile.brand_name || 'Client';

  // Optional: guardrails markdown file
  let guardrails = '';
  if (profile.guardrails_file) {
    const guardrailsPath = path.join(configPath, 'client', profile.guardrails_file);
    if (fs.existsSync(guardrailsPath)) {
      guardrails = fs.readFileSync(guardrailsPath, 'utf8');
    }
  }

  // Load reference images if they exist
  const references = loadClientReferences();

  // Everything else is injected as formatted content
  const { brand_name, guardrails_file, ...clientContent } = profile;
  return { name, guardrails, content: clientContent, references };
}

/**
 * Load client reference images as base64
 */
function loadClientReferences() {
  const refsDir = path.join(configPath, 'client', 'references');
  if (!fs.existsSync(refsDir)) {
    return [];
  }

  const files = fs.readdirSync(refsDir)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .slice(0, 8); // Max 8 images

  return files.map(filename => {
    const filePath = path.join(refsDir, filename);
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' :
                     ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return {
      filename,
      base64: buffer.toString('base64'),
      mimeType,
      url: `data:${mimeType};base64,${buffer.toString('base64')}`
    };
  });
}

/**
 * Load Category (legacy markdown)
 * Returns raw markdown content or null
 */
function loadCategory(categoryName) {
  if (!categoryName || categoryName === 'general') {
    return null;
  }

  const categoryPath = path.join(configPath, 'categories', `${categoryName}.md`);
  if (!fs.existsSync(categoryPath)) {
    return null;
  }
  return fs.readFileSync(categoryPath, 'utf8');
}

/**
 * Load Themes for batch unification
 * Returns themes object or empty
 */
function loadThemes() {
  const themesPath = path.join(configPath, 'themes.json');
  if (!fs.existsSync(themesPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(themesPath, 'utf8')).themes || {};
}

/**
 * Get a random theme or specific theme by name
 */
function getTheme(themeName = null) {
  const themes = loadThemes();
  const themeKeys = Object.keys(themes);

  if (themeKeys.length === 0) return null;

  if (themeName && themes[themeName]) {
    return { key: themeName, ...themes[themeName] };
  }

  // Random selection
  const randomKey = themeKeys[Math.floor(Math.random() * themeKeys.length)];
  return { key: randomKey, ...themes[randomKey] };
}

/**
 * Load Category Visual DNA (JSON)
 * Returns { name, visual_dna, archetype_weights, suffix } or default
 */
function loadCategoryDNA(categorySlug) {
  const categoriesDir = path.join(configPath, 'categories');

  // Try exact slug match first
  let categoryPath = path.join(categoriesDir, `${categorySlug}.json`);

  if (!fs.existsSync(categoryPath)) {
    // Fall back to general
    categoryPath = path.join(categoriesDir, 'general.json');
  }

  if (!fs.existsSync(categoryPath)) {
    // Return default if no category files exist
    return {
      name: 'General',
      suffix: 'soft natural lighting, professional editorial aesthetic'
    };
  }

  return JSON.parse(fs.readFileSync(categoryPath, 'utf8'));
}

/**
 * List all available categories (both .md and .json)
 */
function listCategories() {
  const categoriesDir = path.join(configPath, 'categories');
  if (!fs.existsSync(categoriesDir)) {
    return [];
  }

  const files = fs.readdirSync(categoriesDir);
  const categories = new Set();

  files.forEach(f => {
    if (f.endsWith('.md')) categories.add(f.replace('.md', ''));
    if (f.endsWith('.json')) categories.add(f.replace('.json', ''));
  });

  return Array.from(categories);
}

// ============================================
// Tiered System Prompt Builder
// ============================================

function formatClientContent(content) {
  let output = '';

  // System role
  if (content.system_role) {
    output += `You are: ${content.system_role}\n\n`;
  }

  // Objective
  if (content.objective) {
    output += `## Objective\n${content.objective}\n\n`;
  }

  // Brand DNA
  if (content.brand_dna) {
    output += `## Brand DNA\n`;
    if (content.brand_dna.visual_signature) {
      output += `- Visual Signature: ${content.brand_dna.visual_signature}\n`;
    }
    if (content.brand_dna.mandatory_elements) {
      output += `- Mandatory Elements: ${content.brand_dna.mandatory_elements}\n`;
    }
    if (content.brand_dna.forbidden) {
      output += `- FORBIDDEN: ${content.brand_dna.forbidden}\n`;
    }
    output += '\n';
  }

  // Archetype Library
  if (content.archetype_library) {
    output += `## Archetype Library\n`;
    if (content.archetype_library.instruction) {
      output += `${content.archetype_library.instruction}\n\n`;
    }
    if (content.archetype_library.modules) {
      for (const module of content.archetype_library.modules) {
        output += `### ${module.name}\n`;
        output += `- Visuals: ${module.visuals}\n`;
        output += `- Best for: ${module.best_for}\n\n`;
      }
    }
  }

  // Task Workflow
  if (content.task_workflow) {
    output += `## Workflow\n`;
    for (const [key, value] of Object.entries(content.task_workflow)) {
      output += `${key.replace('_', ' ')}: ${value}\n`;
    }
    output += '\n';
  }

  return output;
}

/**
 * Build the complete tiered system prompt (single client)
 */
function buildTieredSystemPrompt(categoryName = null) {
  const parts = [];

  // TIER 1: Studio Rules (highest priority)
  const studioRules = loadStudioRules();
  if (studioRules) {
    parts.push(`=== STUDIO RULES (MANDATORY - OVERRIDE ALL) ===\n\n${studioRules}`);
  }

  // TIER 2: Client Profile
  const client = loadClientProfile();
  if (client) {
    let clientSection = `=== CLIENT: ${client.name} ===\n\n`;
    clientSection += formatClientContent(client.content);

    // Add guardrails if present
    if (client.guardrails) {
      clientSection += `## Client Guardrails\n${client.guardrails}\n`;
    }

    parts.push(clientSection);
  }

  // TIER 3: Style Reference Instructions (if images will be provided)
  if (client?.references?.length > 0) {
    parts.push(`=== STYLE REFERENCE PROTOCOL ===

Reference images will be provided with the user message. You MUST:

1. ANALYZE each image for: color palette, lighting direction/quality, composition style, texture/grain, mood
2. EXTRACT specific visual descriptors (not generic terms - be precise: "warm amber side-lighting" not "nice lighting")
3. INCORPORATE these exact visual elements into every prompt you generate
4. MAINTAIN visual consistency - outputs should feel like they belong in the same photo series

Your prompts should read like a photographer's shot list that references the provided images' style.`);
  }

  // TIER 4: Category (optional, lowest priority)
  const category = loadCategory(categoryName);
  if (category) {
    parts.push(`=== CATEGORY INFLUENCE (OPTIONAL - SUGGESTIONS ONLY) ===\n\nCategory: ${categoryName}\n\nThis category suggests:\n${category}\n\nUse these as directional guidance, not requirements.`);
  }

  // Output instructions
  parts.push(`## Output\nReturn ONLY the image prompt text. No explanations, no archetype labels, just the prompt.`);

  return parts.join('\n\n');
}

// ============================================
// Subject × Composition System Loaders
// ============================================

function loadSubjects() {
  const subjectsPath = path.join(configPath, 'subjects.json');
  if (!fs.existsSync(subjectsPath)) {
    console.warn('[OpenRouter] subjects.json not found, using empty subjects');
    return {};
  }
  return JSON.parse(fs.readFileSync(subjectsPath, 'utf8')).subjects || {};
}

function loadCompositions() {
  const compositionsPath = path.join(configPath, 'compositions.json');
  if (!fs.existsSync(compositionsPath)) {
    console.warn('[OpenRouter] compositions.json not found, using empty compositions');
    return {};
  }
  return JSON.parse(fs.readFileSync(compositionsPath, 'utf8')).compositions || {};
}

/**
 * Build subject library summary for LLM prompt
 */
function buildSubjectLibrary(subjects) {
  return Object.entries(subjects).map(([key, subj]) => {
    const triggers = subj.triggers ? subj.triggers.slice(0, 5).join(', ') : 'default';
    const comps = subj.compositions.slice(0, 4).join(', ');
    return `- ${key}: triggers=[${triggers}...] → compositions=[${comps}...]`;
  }).join('\n');
}

/**
 * Build composition library summary for LLM prompt
 */
function buildCompositionLibrary(compositions) {
  return Object.entries(compositions).map(([key, comp]) => {
    const cameras = comp.cameras.join('/');
    return `- ${key}: "${comp.template.substring(0, 60)}..." [${cameras}]`;
  }).join('\n');
}

// ============================================
// API Functions
// ============================================

async function generateBatchPrompts(titles, options = {}) {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY environment variable not set');
  }

  const settings = loadSettings();

  // Load the new two-layer system
  const subjects = loadSubjects();
  const compositions = loadCompositions();

  const subjectLibrary = buildSubjectLibrary(subjects);
  const compositionLibrary = buildCompositionLibrary(compositions);

  // Build title list with categories and flip hints
  const titlesList = titles.map((t, i) => {
    let hint = '';
    if (t.flipPerson === true) {
      hint = ' [HINT: try NO PERSON - product/ingredient shot]';
    } else if (t.flipPerson === false) {
      hint = ' [HINT: try WITH PERSON - beauty/lifestyle shot]';
    }
    return `${i + 1}. [ID:${t.id}] [CAT:${t.category || 'general'}] "${t.title}"${hint}`;
  }).join('\n');

  const systemPrompt = `You are an art director creating DIVERSE, CINEMATIC image compositions for wellness blog hero images.

## THREE-STEP DECISION PROCESS

### STEP 1: PERSON OR PRODUCT? (CRITICAL - 50/50 BALANCE)

For EACH title, first decide: should this be a PERSON shot or a PRODUCT shot?

TARGET: ~50% person shots, ~50% product shots across the batch.

PERSON shots work for:
- Medical conditions (show person experiencing/treating)
- Wellness topics (show person in lifestyle context)
- Skin conditions (show skin close-up or person with skin)
- Emotional/lifestyle topics (show person)

PRODUCT shots work for:
- When a SPECIFIC PHYSICAL OBJECT is central (coffee, vape, creatine)
- Treatment products (show the cream, tube, bottle)
- Food/ingredient topics (show the food)

BOTH CAN WORK for most titles - choose to maintain 50/50 balance!

### STEP 2: WHAT KIND?

IF PERSON:
- person-beauty: editorial portraits, beauty shots, gaze, profile
- person-lifestyle: duo, trio, environmental, contemplative
- skin-close: macro skin texture, fragments, clinical close-ups

IF PRODUCT:
- powder: creatine, whey, protein, supplements
- liquid: coffee, water, drinks, pourable treatments
- food: chocolate, eggs, dairy, ingredients
- device: vape, inhaler, injection pen
- skincare-bottle: serums, toners, oils
- skincare-cream: moisturizers, creams, balms
- skincare-tube: cleansers, treatments, masks
- supplement-pill: vitamins (USE SPARINGLY)

### STEP 3: WHAT COMPOSITION?

PERSON compositions:
- portrait-direct, portrait-profile, gaze-intense, natural-candid
- applying-touch, mirror-reflection, serene-eyes-closed
- fragment-crop (face fragment), hands-activity
- duo-intimate, duo-parallel, trio-candid, solo-contemplative
- macro-pores, texture-dewy, fragment-cheek (for skin-close)

PRODUCT compositions:
- hero-floating, overhead-arrange, macro-texture
- cloud, scoop, pour, overhead-scatter (powder)
- pour-stream, splash-frozen, glass-vessel, steam-rising (liquid)
- jar-overhead, jar-angle, dollop-finger, swirl-texture (cream)
- tube-squeeze, tube-flat, hand-apply (tube)
- bottle-elegant, pipette-drop, pump-dispense (bottle)

## OUTPUT FORMAT (strict JSON)

{
  "ID": {
    "subject_type": "person-beauty | person-lifestyle | skin-close | powder | liquid | food | device | skincare-bottle | skincare-cream | skincare-tube",
    "subject_fill": "2-4 words describing what's shown",
    "composition": "composition-name",
    "lens": "35mm | 50mm | 85mm | 100mm macro",
    "model": "ethnicity + gender (REQUIRED for person shots, e.g., 'Black woman', 'Latina woman', 'Asian man')"
  }
}

## EXAMPLES WITH PERSON/PRODUCT BALANCE

Title: "How to Get Rid of Canker Sores"
PERSON: subject_type: "person-beauty", subject_fill: "woman with healthy smile", composition: "portrait-direct", model: "Black woman"
OR PRODUCT: subject_type: "skincare-tube", subject_fill: "canker sore treatment", composition: "tube-squeeze"

Title: "How to Treat Cellulitis"
PERSON: subject_type: "skin-close", subject_fill: "healing skin texture", composition: "texture-dewy"
OR PRODUCT: subject_type: "skincare-cream", subject_fill: "antibiotic cream", composition: "jar-angle"

Title: "How Long Does Pinkeye Last?"
PERSON: subject_type: "person-beauty", subject_fill: "person with clear eyes", composition: "fragment-crop", model: "Asian woman"
OR PRODUCT: subject_type: "liquid", subject_fill: "eye drops", composition: "drip-single"

→ CHOOSE to maintain 50/50 balance across the batch!

## DIVERSITY RULES

1. PERSON/PRODUCT BALANCE: Aim for ~50% each. Count as you go!
2. COMPOSITION VARIETY: Never repeat same composition for same subject_type
3. MODEL DIVERSITY: Vary ethnicity (Black, Asian, South Asian, Latino, White). Include men ~25%
4. LENS VARIETY: Mix 35mm, 50mm, 85mm, 100mm macro

## SUBJECT_FILL RULES

For PERSON shots: describe the person/context ("woman with clear skin", "person applying treatment")
For PRODUCT shots: describe the actual product ("canker sore gel", "eye drops", "allergy medication")

## LENS GUIDELINES

- 35mm: environmental, lifestyle, groups
- 50mm: natural perspective, product context
- 85mm: portraits, beauty, shallow depth
- 100mm macro: skin texture, product details`;

  const userPrompt = `Select subject_type + composition for these ${titles.length} blog posts.

${titlesList}

CRITICAL REMINDERS:
1. AIM FOR 50% PERSON SHOTS - count as you go! (${Math.ceil(titles.length / 2)} should be person-beauty, person-lifestyle, or skin-close)
2. VARY compositions - don't repeat
3. For person shots: ALWAYS include "model" field with ethnicity + gender

Respond with ONLY valid JSON. No markdown, no explanation.`;

  console.log(`[OpenRouter] Generating batch prompts for ${titles.length} titles (Subject×Composition system)...`);

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3001',
      'X-Title': 'Nolla Image Client'
    },
    body: JSON.stringify({
      model: settings.openrouter.cheapModel,
      max_tokens: Math.min(titles.length * 400, 16000),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();

  if (!result.choices || result.choices.length === 0) {
    throw new Error('No response from OpenRouter');
  }

  const content = result.choices[0].message.content.trim();

  // Parse JSON response and build prompts from subject × composition
  try {
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const selections = JSON.parse(jsonStr);
    const prompts = {};

    // Build a map of title IDs to their categories
    const titleCategories = {};
    titles.forEach(t => {
      titleCategories[t.id] = t.category || 'general';
    });

    // Track composition usage for diversity logging
    const compositionUsage = {};

    for (const [id, selection] of Object.entries(selections)) {
      const cleanId = id.replace(/^ID:?/, '');
      const titleCategory = titleCategories[cleanId] || 'general';
      const categoryDNA = loadCategoryDNA(titleCategory);

      let basePrompt, hasPerson, lens, camera;

      if (typeof selection === 'object' && selection.composition) {
        const composition = compositions[selection.composition];
        const subjectType = subjects[selection.subject_type];

        lens = selection.lens || '50mm';

        if (composition) {
          // Get camera from composition or use first available
          camera = composition.cameras[0] || 'CU';

          // Build prompt: substitute {subject} in composition template
          basePrompt = composition.template.replace(/\{subject\}/g, selection.subject_fill || 'item');

          // Determine if this is a person shot
          hasPerson = ['person-beauty', 'person-lifestyle', 'skin-close'].includes(selection.subject_type);

          // Add model specification for person shots
          if (hasPerson && selection.model) {
            basePrompt = `${selection.model}, ${basePrompt}`;
          }

          // Track usage
          compositionUsage[selection.composition] = (compositionUsage[selection.composition] || 0) + 1;
        } else {
          console.warn(`[OpenRouter] Unknown composition: ${selection.composition}`);
          basePrompt = `${selection.subject_fill || 'wellness scene'}, professional photography`;
          hasPerson = true;
          camera = 'CU';
        }
      } else if (typeof selection === 'string') {
        basePrompt = selection;
        hasPerson = /\b(woman|man|person|face|skin|portrait)\b/i.test(selection);
        lens = '50mm';
        camera = 'CU';
      } else {
        basePrompt = String(selection);
        hasPerson = true;
        lens = '50mm';
        camera = 'CU';
      }

      // COMBINE: composition template + camera + lens + category suffix
      // Theme is applied at IMAGE GENERATION time
      let finalPrompt = `${basePrompt}, ${camera}, ${lens}. ${categoryDNA.suffix}`;

      prompts[cleanId] = {
        prompt: finalPrompt,
        hasPerson,
        lens,
        category: titleCategory,
        subject_type: selection.subject_type || 'unknown',
        composition: selection.composition || 'unknown'
      };
    }

    // Logging
    const personCount = Object.values(prompts).filter(p => p.hasPerson).length;
    const productCount = Object.values(prompts).filter(p => !p.hasPerson).length;

    const subjectStats = {};
    Object.values(prompts).forEach(p => {
      subjectStats[p.subject_type] = (subjectStats[p.subject_type] || 0) + 1;
    });
    const subjectBreakdown = Object.entries(subjectStats).map(([s, c]) => `${s}:${c}`).join(', ');

    const compositionBreakdown = Object.entries(compositionUsage).map(([c, n]) => `${c}:${n}`).join(', ');

    console.log(`[OpenRouter] Built ${Object.keys(prompts).length} prompts (${personCount} person, ${productCount} product)`);
    console.log(`[OpenRouter] Subject types: ${subjectBreakdown}`);
    console.log(`[OpenRouter] Compositions: ${compositionBreakdown}`);
    console.log(`[OpenRouter] Theme will be applied at image generation time`);

    return { prompts };
  } catch (parseError) {
    console.error('Failed to parse batch response:', content);
    throw new Error('Failed to parse batch prompt response as JSON');
  }
}

/**
 * Generate prompt for a SINGLE title using the archetype system
 * This wraps generateBatchPrompts to ensure consistency
 */
async function generateSinglePrompt(title, options = {}) {
  // Wrap single title in array format expected by batch function
  const titleObj = typeof title === 'object' ? title : {
    id: 'single',
    title: title,
    category: options.category || 'general'
  };

  console.log(`\n[Prompt Gen] Single title: "${titleObj.title}"`);
  console.log(`[Prompt Gen] Category: ${titleObj.category}`);
  console.log(`[Prompt Gen] Using archetype system for single prompt`);

  // Use batch system with single title
  const result = await generateBatchPrompts([titleObj], options);

  // Extract the single prompt
  const promptData = result.prompts[titleObj.id];
  if (!promptData) {
    throw new Error('Failed to generate prompt for title');
  }

  console.log(`[Prompt Gen] Archetype: ${promptData.archetype}`);
  console.log(`[Prompt Gen] Theme: ${promptData.theme || 'none'}`);

  return promptData;
}

// Legacy function - kept for backward compatibility but deprecated
async function generateSinglePromptCheap(blogTitle, category = 'general') {
  console.warn('[DEPRECATED] generateSinglePromptCheap is deprecated. Use generateSinglePrompt instead.');

  // Redirect to new function
  const result = await generateSinglePrompt({
    id: 'single',
    title: blogTitle,
    category
  });

  // Return just the prompt string for backward compatibility
  return result.prompt;
}

function getStudioRules() {
  return loadStudioRules();
}

function listThemes() {
  const themes = loadThemes();
  return Object.keys(themes);
}

module.exports = {
  generateBatchPrompts,
  generateSinglePrompt,
  generateSinglePromptCheap, // deprecated, redirects to generateSinglePrompt
  getStudioRules,
  listCategories,
  listThemes,
  getTheme,
  loadClientProfile,
  loadClientReferences,
  loadCategory,
  buildTieredSystemPrompt
};
