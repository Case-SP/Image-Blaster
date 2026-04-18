require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const state = require('./state');
const generation = require('./api/generation');
const openrouter = require('./api/openrouter');

const app = express();
const PORT = 3001; // Dedicated port for client instance

// Middleware
app.use(express.json({ limit: '50mb' }));

// Serve static UI files
app.use(express.static(path.join(__dirname, '../ui')));

// =====================================
// API Routes
// =====================================

// GET /api/titles - List all blog titles with status
app.get('/api/titles', (req, res) => {
  try {
    const titles = state.getAllTitlesWithStatus();
    const progress = state.getProgressSummary();

    res.json({
      titles: titles,
      progress: progress
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/titles/:id - Get single title details
app.get('/api/titles/:id', (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);

    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    const generations = generation.getGenerationsForTitle(title.slug);
    const titleState = state.getState();

    res.json({
      ...title,
      frozen: (titleState.complete || []).includes(title.id),
      complete: (titleState.complete || []).includes(title.id),
      generationCount: titleState.generationCounts?.[title.id] || 0,
      selectedGeneration: titleState.winners?.[title.id] || null,
      winner: titleState.winners?.[title.id] || null,
      selects: titleState.selects?.[title.id] || [],
      generations: generations
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/titles - Add new title
app.post('/api/titles', (req, res) => {
  try {
    const { title, category } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const newTitle = state.addTitle(title, category);
    res.json(newTitle);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/titles/:id - Update a title (category, etc.)
app.patch('/api/titles/:id', (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);

    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    const updated = state.updateTitle(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/titles/:id - Delete a title
app.delete('/api/titles/:id', (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);

    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    if (state.isComplete(title.id)) {
      return res.status(400).json({ error: 'Cannot delete complete title. Reopen first.' });
    }

    state.deleteTitle(req.params.id);
    res.json({ success: true, id: req.params.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Session theme - persists across generation calls until reset
let sessionTheme = null;

// GET /api/theme - Get current session theme
app.get('/api/theme', (req, res) => {
  res.json({ theme: sessionTheme?.key || null, name: sessionTheme?.name || null });
});

// POST /api/theme/reset - Reset session theme (next generation picks new random theme)
app.post('/api/theme/reset', (req, res) => {
  sessionTheme = null;
  console.log('[Theme] Session theme reset - next generation will pick new theme');
  res.json({ success: true, message: 'Theme reset. Next generation will pick a new random theme.' });
});

// POST /api/generate/:id - Generate images for single title
app.post('/api/generate/:id', async (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);

    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    if (state.isComplete(title.id)) {
      return res.status(400).json({ error: 'Title is complete. Reopen before generating.' });
    }

    // Use session theme if exists, otherwise pick new one and save it
    if (!sessionTheme) {
      sessionTheme = openrouter.getTheme();
      console.log(`[Generate] New session theme selected: ${sessionTheme?.name}`);
    }
    const runtimeTheme = sessionTheme;
    console.log(`[Generate] Using session theme: ${runtimeTheme?.name || 'none'}`);

    const options = {
      model: req.body.model,
      aspectRatio: req.body.aspectRatio,
      count: req.body.count,
      theme: runtimeTheme // Apply theme at image generation time
    };

    const result = await generation.generateForTitle(title, options);
    res.json({ ...result, theme: runtimeTheme?.key });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/generate/batch - Generate for all unfrozen titles
app.post('/api/generate/batch', async (req, res) => {
  try {
    // Use session theme if exists, otherwise pick new one and save it
    if (!sessionTheme) {
      sessionTheme = openrouter.getTheme();
      console.log(`[Generate Batch] New session theme selected: ${sessionTheme?.name}`);
    }
    const runtimeTheme = sessionTheme;
    console.log(`[Generate Batch] Using session theme for all: ${runtimeTheme?.name || 'none'}`);

    const options = {
      model: req.body.model,
      aspectRatio: req.body.aspectRatio,
      count: req.body.count,
      theme: runtimeTheme // Same theme for ALL images in batch
    };

    // Start batch generation
    const result = await generation.generateBatch(options);
    res.json({ ...result, theme: runtimeTheme?.key });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/select/:id - Select winning generation
app.post('/api/select/:id', (req, res) => {
  try {
    const { filename } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'filename is required' });
    }

    const title = state.getTitleById(req.params.id);

    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    state.setSelectedGeneration(title.id, filename);

    res.json({
      success: true,
      id: title.id,
      selectedGeneration: filename
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/complete/:id - Complete title with winner
app.post('/api/complete/:id', (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);

    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    const winner = state.getWinner(title.id);

    if (!winner) {
      return res.status(400).json({ error: 'No winner selected. Select a winner before completing.' });
    }

    // Copy to final folder
    generation.copyToFinal(title.slug, winner);

    // Complete the title
    state.completeTitle(title.id, winner);

    res.json({
      success: true,
      id: title.id,
      complete: true,
      frozen: true,
      winner: winner,
      selectedGeneration: winner
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/uncomplete/:id - Uncomplete for regeneration
app.post('/api/uncomplete/:id', (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);

    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    state.uncompleteTitle(title.id);

    res.json({
      success: true,
      id: title.id,
      complete: false,
      frozen: false
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/images/:id/:filename/select - Select individual image (heart)
app.post('/api/images/:id/:filename/select', (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);
    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    state.selectImage(title.id, req.params.filename);

    res.json({
      success: true,
      id: title.id,
      filename: req.params.filename,
      selected: true,
      frozen: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/images/:id/:filename/unselect - Unselect individual image
app.post('/api/images/:id/:filename/unselect', (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);
    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    state.unselectImage(title.id, req.params.filename);

    res.json({
      success: true,
      id: title.id,
      filename: req.params.filename,
      selected: false,
      frozen: false
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/images/:id/:filename/winner - Set image as winner
app.post('/api/images/:id/:filename/winner', (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);
    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    // Winner must be a select first
    const selects = state.getSelects(title.id);
    if (!selects.includes(req.params.filename)) {
      return res.status(400).json({ error: 'Image must be selected (hearted) before setting as winner' });
    }

    state.setWinner(title.id, req.params.filename);

    res.json({
      success: true,
      id: title.id,
      filename: req.params.filename,
      winner: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/images/:id/:filename/winner - Remove winner status
app.delete('/api/images/:id/:filename/winner', (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);
    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    // Only remove if this is the current winner
    const currentWinner = state.getWinner(title.id);
    if (currentWinner === req.params.filename) {
      state.setWinner(title.id, null);
    }

    res.json({
      success: true,
      id: title.id,
      filename: req.params.filename,
      winner: false
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/selects - Get all selects across all titles
app.get('/api/selects', (req, res) => {
  try {
    const allSelects = state.getAllSelects();
    const titles = state.getTitles();
    const stateData = state.getState();

    // Build a flat list of all selects with title info
    const selectsList = [];
    Object.entries(allSelects).forEach(([titleId, filenames]) => {
      const title = titles.find(t => t.id === titleId);
      if (title) {
        filenames.forEach(filename => {
          selectsList.push({
            titleId,
            filename,
            title: title.title,
            slug: title.slug,
            category: title.category,
            isWinner: stateData.winners[titleId] === filename,
            isComplete: stateData.complete.includes(titleId),
            imagePath: `/api/images/${title.slug}/${filename}`
          });
        });
      }
    });

    res.json({
      selects: selectsList,
      total: selectsList.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/images/:slug/:filename - Serve generated images
app.get('/api/images/:slug/:filename', (req, res) => {
  const { slug, filename } = req.params;
  const imagePath = path.join(__dirname, '../../output/generations', slug, filename);

  if (!fs.existsSync(imagePath)) {
    return res.status(404).json({ error: 'Image not found' });
  }

  res.sendFile(imagePath);
});

// GET /api/final/:slug - Serve final images
app.get('/api/final/:slug', (req, res) => {
  const imagePath = path.join(__dirname, '../../output/final', `${req.params.slug}.png`);

  if (!fs.existsSync(imagePath)) {
    return res.status(404).json({ error: 'Final image not found' });
  }

  res.sendFile(imagePath);
});

// POST /api/export - Export all frozen selections to final folder
app.post('/api/export', (req, res) => {
  try {
    const result = generation.exportAllFinal();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/settings - Get current settings
app.get('/api/settings', (req, res) => {
  try {
    const settingsPath = path.join(__dirname, '../../config/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/progress - Get progress summary
app.get('/api/progress', (req, res) => {
  try {
    const progress = state.getProgressSummary();
    res.json(progress);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================
// Prompt Management API
// =====================================

// POST /api/prompts/generate - Batch generate prompts for unfrozen titles
app.post('/api/prompts/generate', async (req, res) => {
  try {
    const unfrozen = state.getUnfrozenTitles();

    if (unfrozen.length === 0) {
      return res.json({ generated: 0, message: 'All titles are frozen' });
    }

    // Filter by titleIds if provided, otherwise use all unfrozen
    let candidates = unfrozen;
    if (req.body.titleIds && Array.isArray(req.body.titleIds)) {
      candidates = unfrozen.filter(t => req.body.titleIds.includes(t.id));
    }

    // Filter to only titles without prompts (unless force regenerate)
    const titlesToProcess = req.body.forceRegenerate
      ? candidates
      : candidates.filter(t => !state.getGeneratedPrompt(t.id));

    if (titlesToProcess.length === 0) {
      return res.json({ generated: 0, message: 'All unfrozen titles already have prompts' });
    }

    // Add flip hints based on previous prompt performance
    // If title has no selects and had a prompt, flip the person/no-person choice
    const stateData = state.getState();
    const titlesWithHints = titlesToProcess.map(t => {
      const hasSelects = stateData.selects?.[t.id]?.length > 0;
      const prevPrompt = stateData.generatedPrompts?.[t.id];

      if (!hasSelects && prevPrompt && req.body.forceRegenerate) {
        // Flip: if previous had person, try no person (and vice versa)
        return { ...t, flipPerson: !prevPrompt.hasPerson };
      }
      return t;
    });

    // Generate prompts in batches of 30 for larger throughput
    // NOTE: Theme is NOT applied here - it's applied at image generation time
    const batchSize = 30;
    const allPrompts = {};

    for (let i = 0; i < titlesWithHints.length; i += batchSize) {
      const batch = titlesWithHints.slice(i, i + batchSize);
      const result = await openrouter.generateBatchPrompts(batch);
      Object.assign(allPrompts, result.prompts);
    }

    // Save to state
    state.setMultiplePrompts(allPrompts);

    res.json({
      generated: Object.keys(allPrompts).length,
      total: unfrozen.length,
      prompts: allPrompts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/prompts/:id - Get generated prompt for title
app.get('/api/prompts/:id', (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);

    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    const prompt = state.getGeneratedPrompt(title.id);

    res.json({
      id: title.id,
      title: title.title,
      prompt: prompt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/prompts/:id - Update/edit prompt for title
app.put('/api/prompts/:id', (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);

    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    if (!req.body.prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    state.setGeneratedPrompt(title.id, req.body.prompt);

    res.json({
      success: true,
      id: title.id,
      prompt: req.body.prompt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/prompts/:id/generate - Generate prompt for single title (uses archetype system)
app.post('/api/prompts/:id/generate', async (req, res) => {
  try {
    const title = state.getTitleById(req.params.id);

    if (!title) {
      return res.status(404).json({ error: 'Title not found' });
    }

    // Use the new archetype-based system (same as batch)
    const promptData = await openrouter.generateSinglePrompt(title);
    state.setGeneratedPrompt(title.id, promptData);

    res.json({
      success: true,
      id: title.id,
      prompt: promptData.prompt,
      archetype: promptData.archetype,
      lens: promptData.lens,
      theme: promptData.theme,
      hasPerson: promptData.hasPerson
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/prompts - Get all generated prompts
app.get('/api/prompts', (req, res) => {
  try {
    const prompts = state.getAllGeneratedPrompts();
    res.json(prompts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/studio-rules - Get studio rules (read-only)
app.get('/api/studio-rules', (req, res) => {
  try {
    const rules = openrouter.getStudioRules();
    res.json({ rules: rules || '' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/categories - List all available categories
app.get('/api/categories', (req, res) => {
  try {
    const categories = openrouter.listCategories();
    res.json({ categories });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/themes - List all available themes
app.get('/api/themes', (req, res) => {
  try {
    const themes = openrouter.listThemes();
    res.json({ themes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/prompts - Clear all generated prompts (force regeneration)
app.delete('/api/prompts', (req, res) => {
  try {
    state.clearAllPrompts();
    res.json({ success: true, message: 'All prompts cleared. Regenerate to get new prompts.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/images - Clear ALL generated images (fresh start)
app.delete('/api/images', (req, res) => {
  try {
    const cleared = generation.clearAllImages();
    // Also reset generation counts, selects, winners in state
    const stateData = state.getState();
    stateData.generationCounts = {};
    stateData.selects = {};
    stateData.winners = {};
    // Save state changes
    require('fs').writeFileSync(
      require('path').join(__dirname, '../../data/state.json'),
      JSON.stringify(stateData, null, 2)
    );
    res.json({ success: true, filesCleared: cleared, message: 'All images cleared. Ready for fresh generation.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/reset - Nuclear option: clear EVERYTHING (prompts + images + state)
app.delete('/api/reset', (req, res) => {
  try {
    const cleared = generation.clearAllImages();
    state.resetAllState();
    res.json({ success: true, filesCleared: cleared, message: 'Full reset complete. All prompts and images cleared.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================
// Start Server
// =====================================

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log('  Nolla Image Client');
  console.log(`${'='.repeat(50)}`);
  console.log(`\n  Server running at: http://localhost:${PORT}`);
  console.log(`  API endpoints:     http://localhost:${PORT}/api`);

  // Check for API keys
  if (!process.env.FAL_KEY) {
    console.log('\n  WARNING: FAL_KEY not set in .env');
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('  WARNING: OPENROUTER_API_KEY not set in .env');
  }

  const progress = state.getProgressSummary();
  console.log(`\n  Progress: ${progress.complete}/${progress.total} complete · ${progress.selects} selects`);
  console.log(`${'='.repeat(50)}\n`);
});
