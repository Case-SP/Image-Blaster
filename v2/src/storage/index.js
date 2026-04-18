module.exports = function createStorage() {
  if (process.env.SUPABASE_URL) return require('./supabase');
  return require('./fs');
};
