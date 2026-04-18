// State
let titles = [];
let settings = {};
let currentFilter = 'all';
let generatingTitles = new Map(); // Track titles: { startTime, current, total }

// Selects gallery state
let allSelects = [];

// DOM Elements
const titleGrid = document.getElementById('titleGrid');
const progressCount = document.getElementById('progressCount');
const imageViewer = document.getElementById('imageViewer');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const toast = document.getElementById('toast');
const apiWarning = document.getElementById('apiWarning');
const apiWarningText = document.getElementById('apiWarningText');

// Viewer state
let viewerTitleId = null;
let viewerFilename = null;
let viewerImages = [];
let viewerIndex = 0;
let touchStartX = 0;
let touchEndX = 0;

// Settings
let selectedCount = 3;

// Init
document.addEventListener('DOMContentLoaded', init);

async function init() {
  await Promise.all([loadSettings(), loadTitles()]);
  setupEventListeners();
}

function setupEventListeners() {
  // Filters
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      if (currentFilter === 'selects') {
        loadSelects();
      } else {
        renderTitles();
      }
    });
  });

  // Prompt Bar
  document.getElementById('promptSubmit').addEventListener('click', handlePromptSubmit);
  document.getElementById('promptInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handlePromptSubmit();
    }
  });

  // Count pills only
  document.querySelectorAll('.option-pill[data-count]').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.option-pill[data-count]').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      selectedCount = parseInt(pill.dataset.count);
    });
  });

  // Image viewer
  document.getElementById('viewerClose').addEventListener('click', closeImageViewer);
  document.getElementById('viewerHeart').addEventListener('click', toggleSelectFromViewer);
  document.getElementById('viewerPrev').addEventListener('click', viewerPrev);
  document.getElementById('viewerNext').addEventListener('click', viewerNext);

  imageViewer.addEventListener('click', (e) => {
    if (e.target === imageViewer) {
      closeImageViewer();
    }
  });

  // Swipe support
  imageViewer.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  imageViewer.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
  }, { passive: true });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (imageViewer.classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') viewerPrev();
    if (e.key === 'ArrowRight') viewerNext();
    if (e.key === 'Escape') closeImageViewer();
  });

  // API Warning close button
  document.getElementById('apiWarningClose').addEventListener('click', hideApiWarning);
}

function handleSwipe() {
  const diff = touchStartX - touchEndX;
  const threshold = 50;
  if (diff > threshold) {
    viewerNext();
  } else if (diff < -threshold) {
    viewerPrev();
  }
}

// ============================================
// API Credit Warning
// ============================================

function showApiWarning(message) {
  apiWarningText.textContent = message;
  apiWarning.classList.remove('hidden');
}

function hideApiWarning() {
  apiWarning.classList.add('hidden');
}

// Check response for API credit errors
function checkApiError(response, data, apiName) {
  if (!response.ok) {
    // Check for common credit/quota error patterns
    const errorMsg = data?.error || data?.message || '';
    const status = response.status;

    if (status === 402 || status === 403 || status === 429 ||
        errorMsg.toLowerCase().includes('credit') ||
        errorMsg.toLowerCase().includes('quota') ||
        errorMsg.toLowerCase().includes('limit') ||
        errorMsg.toLowerCase().includes('insufficient') ||
        errorMsg.toLowerCase().includes('exceeded') ||
        errorMsg.toLowerCase().includes('exhausted') ||
        errorMsg.toLowerCase().includes('balance')) {
      showApiWarning(`${apiName} API: ${errorMsg || 'Out of credits or rate limited'}`);
      return true;
    }
  }
  return false;
}

// ============================================
// Image Viewer
// ============================================

async function openImageViewer(titleId, filename, imagePath, titleText) {
  viewerTitleId = titleId;
  viewerFilename = filename;

  const title = titles.find(t => t.id === titleId);
  viewerImages = [];

  for (let i = 1; i <= title.generationCount; i++) {
    const fn = `gen-${String(i).padStart(3, '0')}.png`;
    viewerImages.push({
      filename: fn,
      path: `/api/images/${title.slug}/${fn}`,
      selected: title.selects?.includes(fn) || title.frozenImages?.includes(fn) || false
    });
  }

  viewerIndex = viewerImages.findIndex(img => img.filename === filename);
  if (viewerIndex === -1) viewerIndex = 0;

  updateViewerImage();
  imageViewer.classList.remove('hidden');
}

function updateViewerImage() {
  if (viewerImages.length === 0) return;

  const current = viewerImages[viewerIndex];
  viewerFilename = current.filename;

  document.getElementById('viewerImage').src = current.path;
  document.getElementById('viewerCounter').textContent = `${viewerIndex + 1} / ${viewerImages.length}`;

  // Update heart button state
  const heartBtn = document.getElementById('viewerHeart');
  if (current.selected) {
    heartBtn.classList.add('frozen');
  } else {
    heartBtn.classList.remove('frozen');
  }

  // Hide nav buttons at edges
  document.getElementById('viewerPrev').style.visibility = viewerIndex > 0 ? 'visible' : 'hidden';
  document.getElementById('viewerNext').style.visibility = viewerIndex < viewerImages.length - 1 ? 'visible' : 'hidden';
}

function viewerPrev() {
  if (viewerIndex > 0) {
    viewerIndex--;
    updateViewerImage();
  }
}

function viewerNext() {
  if (viewerIndex < viewerImages.length - 1) {
    viewerIndex++;
    updateViewerImage();
  }
}

function closeImageViewer() {
  imageViewer.classList.add('hidden');
  viewerTitleId = null;
  viewerFilename = null;
  viewerImages = [];
  viewerIndex = 0;
}

async function toggleSelectFromViewer() {
  if (!viewerTitleId || !viewerFilename) return;

  const current = viewerImages[viewerIndex];
  const isSelected = current.selected;
  const endpoint = isSelected ? 'unselect' : 'select';

  try {
    const res = await fetch(`/api/images/${viewerTitleId}/${viewerFilename}/${endpoint}`, {
      method: 'POST'
    });

    if (!res.ok) throw new Error('Action failed');

    // Update local state
    current.selected = !isSelected;
    updateViewerImage();

    // Refresh titles in background
    loadTitles();

    showToast(isSelected ? 'Removed' : 'Selected');
  } catch (e) {
    showToast('Action failed', true);
  }
}

async function toggleSelectImage(titleId, filename) {
  const title = titles.find(t => t.id === titleId);
  const isSelected = title?.selects?.includes(filename) || title?.frozenImages?.includes(filename);
  const endpoint = isSelected ? 'unselect' : 'select';

  try {
    const res = await fetch(`/api/images/${titleId}/${filename}/${endpoint}`, {
      method: 'POST'
    });

    if (!res.ok) throw new Error('Action failed');

    await loadTitles();
    if (currentFilter === 'selects') {
      loadSelects();
    }
    showToast(isSelected ? 'Removed' : 'Selected');
  } catch (e) {
    showToast('Action failed', true);
  }
}

// ============================================
// API Functions
// ============================================

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    settings = await res.json();
    selectedCount = settings.generation?.imagesPerBatch || 3;
    syncCountPills();
  } catch (e) {
    showToast('Failed to load settings', true);
  }
}

async function loadTitles() {
  try {
    const res = await fetch('/api/titles');
    const data = await res.json();
    titles = data.titles;
    updateProgress(data.progress);
    if (currentFilter !== 'selects') {
      renderTitles();
    }
  } catch (e) {
    titleGrid.innerHTML = `<div class="empty-state"><h3>Connection failed</h3><p>Check server</p></div>`;
  }
}

async function loadSelects() {
  try {
    const res = await fetch('/api/selects');
    const data = await res.json();
    allSelects = data.selects;
    renderSelectsGallery();
  } catch (e) {
    titleGrid.innerHTML = `<div class="empty-state"><h3>Failed to load selects</h3><p>Check server</p></div>`;
  }
}

function syncCountPills() {
  document.querySelectorAll('.option-pill[data-count]').forEach(pill => {
    pill.classList.toggle('active', parseInt(pill.dataset.count) === selectedCount);
  });
}

// ============================================
// Prompt Bar Handler
// ============================================

async function handlePromptSubmit() {
  const input = document.getElementById('promptInput').value.trim();

  if (!input) {
    showToast('Enter titles', true);
    return;
  }

  // Split by commas
  const titleStrings = input.split(',').map(t => t.trim()).filter(t => t.length > 0);
  if (titleStrings.length === 0) {
    showToast('Enter titles', true);
    return;
  }

  const btn = document.getElementById('promptSubmit');
  btn.classList.add('loading');

  try {
    // Step 0: Reset session theme so we get a fresh color for this batch
    await fetch('/api/theme/reset', { method: 'POST' });

    // Step 1: Add all titles
    showToast(`Adding ${titleStrings.length} titles...`);
    const addedTitles = [];

    for (const titleStr of titleStrings) {
      const res = await fetch('/api/titles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: titleStr, category: 'general' })
      });
      if (res.ok) {
        addedTitles.push(await res.json());
      }
    }

    document.getElementById('promptInput').value = '';
    await loadTitles();

    if (addedTitles.length === 0) {
      showToast('Failed to add titles', true);
      return;
    }

    showToast(`Added ${addedTitles.length}. Generating prompts...`);

    // Step 2: Generate prompts in parallel
    const promptResults = await Promise.all(addedTitles.map(async t => {
      try {
        const res = await fetch(`/api/prompts/${t.id}/generate`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        checkApiError(res, data, 'OpenRouter');
        return res.ok ? data : null;
      } catch (e) {
        return null;
      }
    }));

    await loadTitles();

    showToast(`Prompts ready. Generating images...`);

    // Step 3: Generate images
    const imageCount = selectedCount || 3;

    // Set up progress tracking
    addedTitles.forEach(t => {
      generatingTitles.set(t.id, { startTime: Date.now(), current: 0, total: imageCount });
    });
    renderTitles();
    startTimerIfNeeded();

    // Generate images - parallel across titles with retry
    const imagePromises = addedTitles.map(async (t) => {
      for (let i = 0; i < imageCount; i++) {
        updateProgressBar(t.id, i, imageCount);
        try {
          const res = await fetchWithRetry(`/api/generate/${t.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count: 1 })
          });
          const data = await res.json().catch(() => ({}));
          if (checkApiError(res, data, 'fal.ai')) {
            // Stop generating for this title if out of credits
            break;
          }
        } catch (e) {
          console.error(`Failed to generate image for ${t.id} after retries`, e);
        }
        updateProgressBar(t.id, i + 1, imageCount);
      }
      generatingTitles.delete(t.id);
    });

    await Promise.all(imagePromises);
    stopTimerIfDone();
    await loadTitles();

    showToast(`Done! ${addedTitles.length} titles x ${imageCount} images`);

  } catch (e) {
    showToast('Generation failed', true);
  } finally {
    btn.classList.remove('loading');
    generatingTitles.clear();
    stopTimerIfDone();
  }
}

// ============================================
// Image Generation
// ============================================

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;

      // Don't retry on credit/quota errors
      if (res.status === 402) return res;

      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
          console.log(`Retry ${attempt + 1}/${retries} after ${delay}ms for ${url}`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      return res;
    } catch (e) {
      if (attempt < retries) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`Retry ${attempt + 1}/${retries} after ${delay}ms (network error)`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
}

let timerInterval = null;

function startTimerIfNeeded() {
  if (!timerInterval && generatingTitles.size > 0) {
    timerInterval = setInterval(updateTimers, 1000);
  }
}

function stopTimerIfDone() {
  if (timerInterval && generatingTitles.size === 0) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// Plus button: regenerate prompt (with flip hint) + generate images
async function regenerateAndGenerate(id, btn) {
  const title = titles.find(t => t.id === id);
  if (!title) return;

  const total = selectedCount || 3;

  // Show progress
  generatingTitles.set(id, { startTime: Date.now(), current: 0, total: total });
  renderTitles();
  startTimerIfNeeded();

  try {
    // Step 0: Reset session theme so we get a fresh color
    await fetch('/api/theme/reset', { method: 'POST' });

    // Step 1: Regenerate prompt with forceRegenerate (flip the person/no-person)
    showToast('Regenerating prompt...');
    const promptRes = await fetch('/api/prompts/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        titleIds: [id],
        forceRegenerate: true
      })
    });

    const promptData = await promptRes.json().catch(() => ({}));
    if (checkApiError(promptRes, promptData, 'OpenRouter')) {
      generatingTitles.delete(id);
      stopTimerIfDone();
      await loadTitles();
      return;
    }

    if (!promptRes.ok) {
      throw new Error('Prompt regeneration failed');
    }

    await loadTitles();
    showToast('Generating images...');

    // Step 2: Generate images
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < total; i++) {
      updateProgressBar(id, i, total);

      try {
        const res = await fetchWithRetry(`/api/generate/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 1 })
        });

        const data = await res.json().catch(() => ({}));
        if (checkApiError(res, data, 'fal.ai')) {
          failCount++;
          break; // Stop if out of credits
        }

        if (res.ok) {
          successCount += data.successCount || 1;
        } else {
          failCount++;
        }
      } catch (e) {
        failCount++;
      }

      updateProgressBar(id, i + 1, total);
    }

    if (failCount > 0) {
      showToast(`${successCount} generated, ${failCount} failed`, true);
    } else {
      showToast(`${successCount} images generated`);
    }
  } catch (e) {
    showToast('Generation failed', true);
  } finally {
    generatingTitles.delete(id);
    stopTimerIfDone();
    await loadTitles();
  }
}

// Standard generate (no prompt regeneration)
async function generateForTitle(id, btn) {
  const total = selectedCount || 3;

  generatingTitles.set(id, { startTime: Date.now(), current: 0, total: total });
  renderTitles();
  startTimerIfNeeded();

  let successCount = 0;
  let failCount = 0;

  try {
    for (let i = 0; i < total; i++) {
      updateProgressBar(id, i, total);

      try {
        const res = await fetchWithRetry(`/api/generate/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 1 })
        });

        const data = await res.json().catch(() => ({}));
        if (checkApiError(res, data, 'fal.ai')) {
          failCount++;
          break; // Stop if out of credits
        }

        if (res.ok) {
          successCount += data.successCount || 1;
        } else {
          failCount++;
        }
      } catch (e) {
        failCount++;
      }

      updateProgressBar(id, i + 1, total);
    }

    if (failCount > 0) {
      showToast(`${successCount} generated, ${failCount} failed`, true);
    } else {
      showToast(`${successCount} images generated`);
    }
  } catch (e) {
    showToast('Generation failed', true);
  } finally {
    generatingTitles.delete(id);
    stopTimerIfDone();
    await loadTitles();
  }
}

async function deleteTitle(id) {
  const title = titles.find(t => t.id === id);
  if (!confirm(`Delete "${title?.title}"?`)) return;

  try {
    const res = await fetch(`/api/titles/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    await loadTitles();
    showToast('Deleted');
  } catch (e) {
    showToast('Delete failed', true);
  }
}

// ============================================
// Rendering
// ============================================

function renderTitles() {
  if (titles.length === 0) {
    titleGrid.innerHTML = `
      <div class="empty-state">
        <h3>No titles</h3>
        <p>Enter titles in the prompt bar below</p>
      </div>
    `;
    return;
  }

  titleGrid.innerHTML = titles.map(createTitleCard).join('');
  attachCardEventListeners();
}

function renderSelectsGallery() {
  if (allSelects.length === 0) {
    titleGrid.innerHTML = `
      <div class="empty-state">
        <h3>No selects</h3>
        <p>Heart images to add them here</p>
      </div>
    `;
    return;
  }

  const heartIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;

  titleGrid.innerHTML = `
    <div class="selects-gallery">
      ${allSelects.map(select => `
        <div class="select-item"
             data-title-id="${select.titleId}"
             data-filename="${select.filename}">
          <div class="select-image-wrapper">
            <img src="${select.imagePath}" alt="${select.title}" loading="lazy">
            <button class="select-heart" data-title-id="${select.titleId}" data-filename="${select.filename}" title="Remove">
              ${heartIcon}
            </button>
          </div>
          <div class="select-title">${esc(select.title)}</div>
        </div>
      `).join('')}
    </div>
  `;

  attachSelectsEventListeners();
}

function attachSelectsEventListeners() {
  // Click image to open viewer
  document.querySelectorAll('.select-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.select-heart')) return;
      const titleId = item.dataset.titleId;
      const filename = item.dataset.filename;
      const select = allSelects.find(s => s.titleId === titleId && s.filename === filename);
      if (select) {
        const title = titles.find(t => t.id === titleId);
        if (title) {
          openImageViewer(titleId, filename, select.imagePath, title.title);
        }
      }
    });
  });

  // Heart button to remove from selects
  document.querySelectorAll('.select-heart').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const titleId = btn.dataset.titleId;
      const filename = btn.dataset.filename;
      await toggleSelectImage(titleId, filename);
    });
  });
}

function createTitleCard(title) {
  const hasGen = title.generationCount > 0;
  const hasPrompt = !!title.generatedPrompt;
  const isGenerating = generatingTitles.has(title.id);
  const hasSelects = (title.selects?.length > 0) || (title.frozenImages?.length > 0);
  
  // Progress bar for generating state
  let progressBar = '';
  if (isGenerating) {
    const genState = generatingTitles.get(title.id);
    const elapsed = formatElapsed(genState.startTime);
    const percent = genState.total > 0 ? Math.round((genState.current / genState.total) * 100) : 0;
    progressBar = `<div class="generation-progress">
      <div class="progress-bar-container">
        <div class="progress-bar-fill" style="width: ${percent}%"></div>
      </div>
      <span class="progress-text" data-timer="${title.id}">${genState.current}/${genState.total} - ${elapsed}</span>
    </div>`;
  }

  const deleteBtn = `<button class="btn-delete" data-id="${title.id}" title="Delete">x</button>`;

  return `
    <div class="title-card ${isGenerating ? 'generating' : ''}" data-id="${title.id}">
      <div class="card-header">
        <div class="card-info">
          <h3 class="card-title">${esc(title.title)}</h3>
          <div class="card-meta">
            ${hasSelects ? `<span class="card-badge badge-selects">${title.selects?.length || title.frozenImages?.length} SELECT${(title.selects?.length || title.frozenImages?.length) > 1 ? 'S' : ''}</span>` : ''}
            ${!hasPrompt ? '<span class="card-badge badge-no-prompt">NO PROMPT</span>' : ''}
          </div>
        </div>
        <div class="card-actions">
          ${deleteBtn}
        </div>
      </div>
      ${progressBar}
      ${hasGen ? renderGenerationsRow(title) : `<div class="no-generations">${isGenerating ? '' : (hasPrompt ? '<button class="add-more-btn first-gen" data-id="' + title.id + '">+ Generate</button>' : 'Generating prompt...')}</div>`}
    </div>
  `;
}

function formatElapsed(startTime) {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function updateTimers() {
  generatingTitles.forEach((genState, id) => {
    const el = document.querySelector(`[data-timer="${id}"]`);
    if (el) {
      el.textContent = `${genState.current}/${genState.total} - ${formatElapsed(genState.startTime)}`;
    }
  });
}

function updateProgressBar(id, current, total) {
  const genState = generatingTitles.get(id);
  if (genState) {
    genState.current = current;
    genState.total = total;
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    const fillEl = document.querySelector(`.title-card[data-id="${id}"] .progress-bar-fill`);
    if (fillEl) {
      fillEl.style.width = `${percent}%`;
    }
    const textEl = document.querySelector(`[data-timer="${id}"]`);
    if (textEl) {
      textEl.textContent = `${current}/${total} - ${formatElapsed(genState.startTime)}`;
    }
  }
}

function renderGenerationsRow(title) {
  const gens = [];
  const selects = title.selects || title.frozenImages || [];

  for (let i = 1; i <= title.generationCount; i++) {
    const filename = `gen-${String(i).padStart(3, '0')}.png`;
    gens.push({
      filename,
      path: `/api/images/${title.slug}/${filename}`,
      selected: selects.includes(filename)
    });
  }

  const heartIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;

  return `
    <div class="generations-row">
      <div class="generations-scroll">
        ${gens.map(gen => `
          <div class="generation-thumb ${gen.selected ? 'selected' : ''}" data-id="${title.id}" data-filename="${gen.filename}">
            <img src="${gen.path}" alt="${gen.filename}" loading="lazy">
            <button class="thumb-heart ${gen.selected ? 'selected' : ''}" data-id="${title.id}" data-filename="${gen.filename}" title="${gen.selected ? 'Remove' : 'Select'}">
              ${heartIcon}
            </button>
          </div>
        `).join('')}
        <button class="add-more-btn" data-id="${title.id}" title="Regenerate with opposite style">+</button>
      </div>
    </div>
  `;
}

function attachCardEventListeners() {
  // Delete button
  document.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTitle(btn.dataset.id);
    });
  });

  // Generation thumbnails - open viewer
  document.querySelectorAll('.generation-thumb').forEach(thumb => {
    thumb.addEventListener('click', (e) => {
      if (e.target.closest('.thumb-heart')) return;
      const id = thumb.dataset.id;
      const filename = thumb.dataset.filename;
      const title = titles.find(t => t.id === id);
      const imagePath = `/api/images/${title.slug}/${filename}`;
      openImageViewer(id, filename, imagePath, title.title);
    });
  });

  // Thumbnail heart buttons - toggle select
  document.querySelectorAll('.thumb-heart').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelectImage(btn.dataset.id, btn.dataset.filename);
    });
  });

  // Add more button - always regenerate prompt + generate images
  // Logic: if the old prompt was good, you'd have selected an image
  document.querySelectorAll('.add-more-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      regenerateAndGenerate(btn.dataset.id, btn);
    });
  });
}

// ============================================
// UI Helpers
// ============================================

function updateProgress(progress) {
  progressCount.textContent = `${progress.total} titles - ${progress.selects} selects`;
}

function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

let toastTimeout;
function showToast(message, isError = false) {
  clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  toastTimeout = setTimeout(() => toast.classList.remove('visible'), 3000);
}

function esc(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
