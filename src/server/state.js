const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../../data');
const titlesPath = path.join(dataDir, 'blog-titles.json');
const statePath = path.join(dataDir, 'state.json');
const generationsDir = path.join(__dirname, '../../output/generations');

// Count actual images on disk for a title slug
function countGenerationsOnDisk(slug) {
  const titleDir = path.join(generationsDir, slug);
  if (!fs.existsSync(titleDir)) return 0;
  return fs.readdirSync(titleDir).filter(f => f.endsWith('.png')).length;
}

// Ensure data files exist
function ensureDataFiles() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(titlesPath)) {
    fs.writeFileSync(titlesPath, '[]');
  }
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, JSON.stringify({
      frozen: [],
      complete: [],
      frozenImages: {},
      selects: {},
      winners: {},
      selectedGenerations: {},
      generationCounts: {},
      generatedPrompts: {}
    }, null, 2));
  }
}

ensureDataFiles();

// Load titles from JSON
function getTitles() {
  return JSON.parse(fs.readFileSync(titlesPath, 'utf8'));
}

// Save titles to JSON
function saveTitles(titles) {
  fs.writeFileSync(titlesPath, JSON.stringify(titles, null, 2));
}

// Load state
function getState() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

// Save state
function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// Generate slug from title
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

// Generate unique ID
function generateId() {
  return String(Date.now()).slice(-6) + Math.random().toString(36).slice(-3);
}

// Add a new title
function addTitle(title, category = 'general') {
  const titles = getTitles();
  const id = generateId();
  const slug = slugify(title);

  const newTitle = {
    id,
    title,
    slug,
    category,
    createdAt: new Date().toISOString()
  };

  titles.push(newTitle);
  saveTitles(titles);

  return newTitle;
}

// Update a title
function updateTitle(id, updates) {
  const titles = getTitles();
  const index = titles.findIndex(t => t.id === id);
  if (index === -1) return null;

  if (updates.category) {
    titles[index].category = updates.category;
  }

  saveTitles(titles);
  return titles[index];
}

// Delete a title
function deleteTitle(id) {
  let titles = getTitles();
  titles = titles.filter(t => t.id !== id);
  saveTitles(titles);

  // Clean up state
  const state = getState();
  state.frozen = state.frozen.filter(fid => fid !== id);
  state.complete = state.complete.filter(cid => cid !== id);
  delete state.frozenImages[id];
  delete state.selects[id];
  delete state.winners[id];
  delete state.selectedGenerations[id];
  delete state.generationCounts[id];
  delete state.generatedPrompts[id];
  saveState(state);
}

// Get title by ID
function getTitleById(id) {
  const titles = getTitles();
  return titles.find(t => t.id === id);
}

// Get all titles with status
function getAllTitlesWithStatus() {
  const titles = getTitles();
  const state = getState();

  return titles.map(t => {
    // Use disk count if state count is 0 (handles cleared state)
    const stateCount = state.generationCounts?.[t.id] || 0;
    const diskCount = stateCount === 0 ? countGenerationsOnDisk(t.slug) : stateCount;

    return {
      ...t,
      frozen: state.frozen?.includes(t.id) || state.complete?.includes(t.id) || false,
      complete: state.complete?.includes(t.id) || false,
      frozenImages: state.frozenImages?.[t.id] || [],
      selects: state.selects?.[t.id] || [],
      winner: state.winners?.[t.id] || null,
      selectedGeneration: state.selectedGenerations?.[t.id] || state.winners?.[t.id] || null,
      generationCount: diskCount,
      generatedPrompt: state.generatedPrompts?.[t.id] || null
    };
  });
}

// Get unfrozen titles
function getUnfrozenTitles() {
  const titles = getTitles();
  const state = getState();

  return titles.filter(t =>
    !state.frozen?.includes(t.id) && !state.complete?.includes(t.id)
  );
}

// Generation count management
function incrementGenerationCount(id) {
  const state = getState();
  state.generationCounts = state.generationCounts || {};
  state.generationCounts[id] = (state.generationCounts[id] || 0) + 1;
  saveState(state);
  return state.generationCounts[id];
}

function getGenerationCount(id) {
  const state = getState();
  return state.generationCounts?.[id] || 0;
}

// Select/freeze individual images
function selectImage(id, filename) {
  const state = getState();
  state.selects = state.selects || {};
  state.selects[id] = state.selects[id] || [];
  if (!state.selects[id].includes(filename)) {
    state.selects[id].push(filename);
  }
  saveState(state);
}

function unselectImage(id, filename) {
  const state = getState();
  state.selects = state.selects || {};
  state.selects[id] = (state.selects[id] || []).filter(f => f !== filename);
  // Also clear winner if it was this image
  if (state.winners?.[id] === filename) {
    state.winners[id] = null;
  }
  saveState(state);
}

function getSelects(id) {
  const state = getState();
  return state.selects?.[id] || [];
}

function getAllSelects() {
  const state = getState();
  return state.selects || {};
}

// Legacy freeze functions (alias to select)
function freezeImage(id, filename) {
  selectImage(id, filename);
}

function unfreezeImage(id, filename) {
  unselectImage(id, filename);
}

// Winner management
function setWinner(id, filename) {
  const state = getState();
  state.winners = state.winners || {};
  state.winners[id] = filename;
  // Also set as selected generation for legacy support
  state.selectedGenerations = state.selectedGenerations || {};
  state.selectedGenerations[id] = filename;
  saveState(state);
}

function getWinner(id) {
  const state = getState();
  return state.winners?.[id] || null;
}

// Complete/freeze title
function completeTitle(id, winner) {
  const state = getState();
  state.complete = state.complete || [];
  if (!state.complete.includes(id)) {
    state.complete.push(id);
  }
  if (winner) {
    state.winners = state.winners || {};
    state.winners[id] = winner;
    state.selectedGenerations = state.selectedGenerations || {};
    state.selectedGenerations[id] = winner;
  }
  saveState(state);
}

function uncompleteTitle(id) {
  const state = getState();
  state.complete = (state.complete || []).filter(cid => cid !== id);
  state.frozen = (state.frozen || []).filter(fid => fid !== id);
  saveState(state);
}

function isComplete(id) {
  const state = getState();
  return state.complete?.includes(id) || state.frozen?.includes(id) || false;
}

// Legacy freeze functions
function freezeTitle(id, selected) {
  completeTitle(id, selected);
}

function unfreezeTitle(id) {
  uncompleteTitle(id);
}

function isFrozen(id) {
  return isComplete(id);
}

// Selected generation management
function setSelectedGeneration(id, filename) {
  setWinner(id, filename);
}

function getSelectedGeneration(id) {
  return getWinner(id);
}

// Prompt management
function setGeneratedPrompt(id, prompt) {
  const state = getState();
  state.generatedPrompts = state.generatedPrompts || {};
  state.generatedPrompts[id] = prompt;
  saveState(state);
}

function getGeneratedPrompt(id) {
  const state = getState();
  return state.generatedPrompts?.[id] || null;
}

function setMultiplePrompts(prompts) {
  const state = getState();
  state.generatedPrompts = state.generatedPrompts || {};
  Object.assign(state.generatedPrompts, prompts);
  saveState(state);
}

function getAllGeneratedPrompts() {
  const state = getState();
  return state.generatedPrompts || {};
}

function clearAllPrompts() {
  const state = getState();
  state.generatedPrompts = {};
  saveState(state);
  console.log('[State] Cleared all generated prompts');
}

function clearPromptById(id) {
  const state = getState();
  if (state.generatedPrompts && state.generatedPrompts[id]) {
    delete state.generatedPrompts[id];
    saveState(state);
    return true;
  }
  return false;
}

function resetAllState() {
  const state = getState();
  state.generatedPrompts = {};
  state.generationCounts = {};
  state.selects = {};
  state.winners = {};
  state.complete = [];
  saveState(state);
  console.log('[State] Full state reset complete');
}

// Progress summary
function getProgressSummary() {
  const titles = getTitles();
  const state = getState();

  const complete = (state.complete || []).length;
  const total = titles.length;
  const selects = Object.values(state.selects || {}).reduce((sum, arr) => sum + arr.length, 0);

  return {
    total,
    complete,
    pending: total - complete,
    selects
  };
}

module.exports = {
  getTitles,
  getTitleById,
  addTitle,
  updateTitle,
  deleteTitle,
  getAllTitlesWithStatus,
  getUnfrozenTitles,

  getState,

  incrementGenerationCount,
  getGenerationCount,

  selectImage,
  unselectImage,
  getSelects,
  getAllSelects,

  freezeImage,
  unfreezeImage,

  setWinner,
  getWinner,

  completeTitle,
  uncompleteTitle,
  isComplete,

  freezeTitle,
  unfreezeTitle,
  isFrozen,

  setSelectedGeneration,
  getSelectedGeneration,

  setGeneratedPrompt,
  getGeneratedPrompt,
  setMultiplePrompts,
  getAllGeneratedPrompts,
  clearAllPrompts,
  clearPromptById,
  resetAllState,

  getProgressSummary
};
