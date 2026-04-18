const fs = require('fs');
const path = require('path');
const state = require('../state');
const fal = require('./fal');

const outputDir = path.join(__dirname, '../../../output');
const generationsDir = path.join(outputDir, 'generations');
const finalDir = path.join(outputDir, 'final');

// Concurrency limit for parallel image generation
const MAX_CONCURRENT_IMAGES = 5;

// Ensure output directories exist
function ensureOutputDirs() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  if (!fs.existsSync(generationsDir)) {
    fs.mkdirSync(generationsDir, { recursive: true });
  }
  if (!fs.existsSync(finalDir)) {
    fs.mkdirSync(finalDir, { recursive: true });
  }
}

ensureOutputDirs();

/**
 * Clear all generated images for a title
 */
function clearImagesForTitle(slug) {
  const titleDir = path.join(generationsDir, slug);
  if (fs.existsSync(titleDir)) {
    const files = fs.readdirSync(titleDir);
    files.forEach(file => {
      fs.unlinkSync(path.join(titleDir, file));
    });
    console.log(`[Generation] Cleared ${files.length} files for ${slug}`);
    return files.length;
  }
  return 0;
}

/**
 * Clear ALL generated images and directories
 */
function clearAllImages() {
  if (!fs.existsSync(generationsDir)) return 0;

  const dirs = fs.readdirSync(generationsDir);
  let totalCleared = 0;

  dirs.forEach(dir => {
    const titleDir = path.join(generationsDir, dir);
    if (fs.statSync(titleDir).isDirectory()) {
      const files = fs.readdirSync(titleDir);
      files.forEach(file => {
        fs.unlinkSync(path.join(titleDir, file));
      });
      totalCleared += files.length;
      // Remove the empty directory too
      fs.rmdirSync(titleDir);
    }
  });

  console.log(`[Generation] Cleared ${totalCleared} files and ${dirs.length} directories`);
  return totalCleared;
}

/**
 * Run tasks with concurrency limit
 */
async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = [];

  for (const task of tasks) {
    const promise = task().then(result => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });
    results.push(promise);
    executing.push(promise);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

/**
 * Generate a single image and save it
 * @param {object} options - Includes model, aspectRatio, and runtime theme
 */
async function generateSingleImage(title, promptData, options, titleDir) {
  try {
    // Generate image - pass full prompt object with runtime theme
    const imageResult = await fal.generateImage(promptData, {
      model: options.model,
      aspectRatio: options.aspectRatio,
      theme: options.theme // Runtime theme for unified backgrounds
    });

    // Download and save
    const buffer = await fal.downloadImage(imageResult.url);
    const genNum = state.incrementGenerationCount(title.id);
    const filename = `gen-${String(genNum).padStart(3, '0')}.png`;
    const filepath = path.join(titleDir, filename);

    fs.writeFileSync(filepath, buffer);

    // Save metadata (store prompt with runtime theme applied)
    const basePrompt = typeof promptData === 'object' ? promptData.prompt : promptData;
    const themeApplied = options.theme ? `${basePrompt}, ${options.theme.background}, ${options.theme.color_grade}` : basePrompt;
    const metaPath = path.join(titleDir, `${filename}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({
      prompt: themeApplied,
      hasPerson: typeof promptData === 'object' ? promptData.hasPerson : null,
      theme: options.theme?.key || null,
      model: imageResult.model,
      width: imageResult.width,
      height: imageResult.height,
      generatedAt: new Date().toISOString()
    }, null, 2));

    console.log(`[Generation] ${title.slug}: ${filename}`);

    return {
      filename,
      path: filepath,
      model: imageResult.model
    };
  } catch (error) {
    console.error(`[Generation] Failed for ${title.slug}:`, error.message);
    return { error: error.message };
  }
}

/**
 * Generate images for a single title (parallel within title)
 */
async function generateForTitle(title, options = {}) {
  const promptData = state.getGeneratedPrompt(title.id);

  if (!promptData) {
    throw new Error('No prompt generated for this title. Generate a prompt first.');
  }

  const count = options.count || 1;

  // Ensure title's generation directory exists
  const titleDir = path.join(generationsDir, title.slug);
  if (!fs.existsSync(titleDir)) {
    fs.mkdirSync(titleDir, { recursive: true });
  }

  // Generate images in parallel (within concurrency limit)
  const tasks = Array(count).fill(null).map(() =>
    () => generateSingleImage(title, promptData, options, titleDir)
  );

  const results = await runWithConcurrency(tasks, MAX_CONCURRENT_IMAGES);
  const successCount = results.filter(r => !r.error).length;

  return {
    titleId: title.id,
    slug: title.slug,
    successCount,
    failCount: count - successCount,
    results
  };
}

/**
 * Get all generations for a title
 */
function getGenerationsForTitle(slug) {
  const titleDir = path.join(generationsDir, slug);

  if (!fs.existsSync(titleDir)) {
    return [];
  }

  const files = fs.readdirSync(titleDir)
    .filter(f => f.endsWith('.png'));

  return files.map(filename => {
    const metaPath = path.join(titleDir, `${filename}.json`);
    let meta = {};
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }

    return {
      filename,
      path: `/api/images/${slug}/${filename}`,
      ...meta
    };
  });
}

/**
 * Copy selected image to final folder
 */
function copyToFinal(slug, filename) {
  const sourcePath = path.join(generationsDir, slug, filename);
  const destPath = path.join(finalDir, `${slug}.png`);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source image not found: ${filename}`);
  }

  fs.copyFileSync(sourcePath, destPath);
  console.log(`[Final] Copied ${slug}/${filename} to final/`);

  return destPath;
}

/**
 * Export all completed titles to final folder
 */
function exportAllFinal() {
  const titles = state.getAllTitlesWithStatus();
  const stateData = state.getState();

  let exported = 0;
  const errors = [];

  for (const title of titles) {
    if (stateData.complete?.includes(title.id) && stateData.winners?.[title.id]) {
      try {
        copyToFinal(title.slug, stateData.winners[title.id]);
        exported++;
      } catch (error) {
        errors.push({ slug: title.slug, error: error.message });
      }
    }
  }

  return {
    exported,
    errors: errors.length > 0 ? errors : undefined
  };
}

/**
 * Generate batch for all unfrozen titles (parallel across titles)
 */
async function generateBatch(options = {}) {
  const unfrozen = state.getUnfrozenTitles();

  // Filter to only titles with prompts
  const titlesToProcess = unfrozen.filter(t => state.getGeneratedPrompt(t.id));

  if (titlesToProcess.length === 0) {
    return { processed: 0, results: [] };
  }

  console.log(`[Batch] Processing ${titlesToProcess.length} titles in parallel...`);

  // Create tasks for each title
  const tasks = titlesToProcess.map(title =>
    () => generateForTitle(title, options)
      .catch(error => ({
        titleId: title.id,
        slug: title.slug,
        error: error.message
      }))
  );

  // Process titles in parallel (limit to 3 concurrent titles, each with up to 5 concurrent images)
  const results = await runWithConcurrency(tasks, 3);

  const successful = results.filter(r => !r.error);
  console.log(`[Batch] Complete: ${successful.length}/${titlesToProcess.length} titles succeeded`);

  return {
    processed: results.length,
    results
  };
}

module.exports = {
  generateForTitle,
  getGenerationsForTitle,
  copyToFinal,
  exportAllFinal,
  generateBatch,
  clearImagesForTitle,
  clearAllImages
};
