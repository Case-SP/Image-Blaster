// Single backend: Supabase. SUPABASE_URL is required at boot.
module.exports = function createStorage() {
  if (!process.env.SUPABASE_URL) {
    throw new Error('SUPABASE_URL not set — Supabase is the only supported storage backend.');
  }
  return require('./supabase');
};
