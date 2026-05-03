#!/usr/bin/env node
/**
 * refs.js — manage cartridge reference images from the CLI.
 *
 * Usage:
 *   node scripts/refs.js list <cartridge>
 *   node scripts/refs.js add <cartridge> <file> [<file>...]
 *   node scripts/refs.js rm <cartridge> <pattern>      # glob (e.g. "ref-03*", "*.png")
 *   node scripts/refs.js renumber <cartridge>          # re-sequence ref-NN- prefixes
 *
 * Examples:
 *   node scripts/refs.js list demo
 *   node scripts/refs.js add demo ~/Desktop/sky-01.jpg ~/Desktop/sky-02.png
 *   node scripts/refs.js rm demo "ref-03*"
 *   node scripts/refs.js rm demo "ref-09-storant*"
 *
 * Notes:
 * - Images land at v2/cartridge/<name>/references/ref-NN-<sanitized>.<ext>
 * - The cartridge loader auto-picks all matching files (jpg/jpeg/png/webp).
 * - Server is on --watch; cartridge changes apply to the next request, no restart.
 * - References are only sent to fal for ref-supporting models (nano-banana-pro,
 *   flux-pro/kontext). The cheap nano-banana variant ignores them.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'v2', 'cartridge');
const SUPPORTED = /\.(jpe?g|png|webp)$/i;

function refsDir(cartridge) {
  const dir = path.join(ROOT, cartridge, 'references');
  if (!fs.existsSync(dir)) {
    console.error(`cartridge "${cartridge}" not found (no ${dir})`);
    process.exit(1);
  }
  return dir;
}

function listRefs(cartridge) {
  const dir = refsDir(cartridge);
  const files = fs.readdirSync(dir).filter(f => SUPPORTED.test(f)).sort();
  if (!files.length) { console.log('(no references)'); return; }
  let totalBytes = 0;
  for (const f of files) {
    const stat = fs.statSync(path.join(dir, f));
    totalBytes += stat.size;
    console.log(`  ${f.padEnd(50)} ${(stat.size / 1024).toFixed(1).padStart(8)} KB`);
  }
  console.log(`  ${files.length} file(s), ${(totalBytes / 1024 / 1024).toFixed(2)} MB total`);
}

function nextSeq(dir) {
  const files = fs.readdirSync(dir).filter(f => SUPPORTED.test(f));
  let max = 0;
  for (const f of files) {
    const m = f.match(/^ref-(\d{2,})-/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function sanitize(s) {
  return s.toLowerCase()
    .replace(/\.[^.]+$/, '')           // strip ext
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'ref';
}

function addRefs(cartridge, files) {
  const dir = refsDir(cartridge);
  if (!files.length) { console.error('add: at least one source file required'); process.exit(1); }

  let seq = nextSeq(dir);
  let added = 0;
  for (const src of files) {
    const abs = path.resolve(src);
    if (!fs.existsSync(abs)) { console.warn(`  skip (not found): ${src}`); continue; }
    if (!SUPPORTED.test(abs)) { console.warn(`  skip (not jpg/png/webp): ${src}`); continue; }
    const ext = path.extname(abs).toLowerCase();
    const slug = sanitize(path.basename(abs));
    const target = path.join(dir, `ref-${String(seq).padStart(2, '0')}-${slug}${ext}`);
    fs.copyFileSync(abs, target);
    const stat = fs.statSync(target);
    console.log(`  + ${path.basename(target)}  (${(stat.size / 1024).toFixed(1)} KB)`);
    seq++;
    added++;
  }
  console.log(`added ${added} ref(s) to cartridge "${cartridge}"`);
}

function rmRefs(cartridge, pattern) {
  const dir = refsDir(cartridge);
  if (!pattern) { console.error('rm: pattern required'); process.exit(1); }
  // Glob → regex (only * and ? supported, matching most cases)
  const re = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$', 'i');
  const files = fs.readdirSync(dir).filter(f => SUPPORTED.test(f) && re.test(f));
  if (!files.length) { console.log(`no files match "${pattern}"`); return; }
  for (const f of files) {
    fs.unlinkSync(path.join(dir, f));
    console.log(`  - ${f}`);
  }
  console.log(`removed ${files.length} ref(s) from cartridge "${cartridge}"`);
}

function renumber(cartridge) {
  const dir = refsDir(cartridge);
  const files = fs.readdirSync(dir).filter(f => SUPPORTED.test(f)).sort();
  let seq = 1;
  for (const f of files) {
    const slug = f.replace(/^ref-\d+-/, '').replace(/^[^a-z0-9]+/i, '');
    const ext = path.extname(f);
    const base = path.basename(slug, ext);
    const target = `ref-${String(seq).padStart(2, '0')}-${base}${ext}`;
    if (target !== f) {
      fs.renameSync(path.join(dir, f), path.join(dir, target));
      console.log(`  ${f}  →  ${target}`);
    }
    seq++;
  }
  console.log(`renumbered ${files.length} ref(s)`);
}

const [, , cmd, cartridge, ...rest] = process.argv;
if (!cmd || !cartridge) {
  console.error('usage:');
  console.error('  node scripts/refs.js list <cartridge>');
  console.error('  node scripts/refs.js add <cartridge> <file>...');
  console.error('  node scripts/refs.js rm <cartridge> <pattern>');
  console.error('  node scripts/refs.js renumber <cartridge>');
  process.exit(1);
}

switch (cmd) {
  case 'list': listRefs(cartridge); break;
  case 'add': addRefs(cartridge, rest); break;
  case 'rm': rmRefs(cartridge, rest[0]); break;
  case 'renumber': renumber(cartridge); break;
  default:
    console.error('unknown command:', cmd);
    process.exit(1);
}
