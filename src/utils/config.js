const fs = require('fs');
const path = require('path');

// Config directory path
const CONFIG_DIR = path.join(__dirname, '../../config');

// Settings cache
let settingsCache = null;

/**
 * Load settings from config/settings.json
 */
function loadSettings() {
  if (settingsCache) {
    return settingsCache;
  }

  const settingsPath = path.join(CONFIG_DIR, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    throw new Error('settings.json not found');
  }

  settingsCache = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return settingsCache;
}

/**
 * Clear settings cache (call after updates)
 */
function clearSettingsCache() {
  settingsCache = null;
}

module.exports = {
  CONFIG_DIR,
  loadSettings,
  clearSettingsCache
};
