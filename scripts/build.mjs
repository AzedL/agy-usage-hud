/**
 * Builds a clean, self-contained distributable plugin bundle under
 * `dist/<plugin.name>/` containing only runtime files (no tests, scripts,
 * package.json, or git metadata).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginMeta = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf-8'));
const pluginName = pluginMeta.name;

if (!pluginName || typeof pluginName !== 'string') {
  console.error('plugin.json must define a valid "name"');
  process.exit(1);
}

const DIST_ROOT = join(ROOT, 'dist');
const OUT_DIR = join(DIST_ROOT, pluginName);

const INCLUDE = [
  'plugin.json',
  'README.md',
  'LICENSE',
  'assets',
  'skills',
  'sidecars',
];

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

for (const entry of INCLUDE) {
  const src = join(ROOT, entry);
  if (!existsSync(src)) {
    console.error(`Required build input missing: ${entry}`);
    process.exit(1);
  }
  cpSync(src, join(OUT_DIR, entry), { recursive: true });
}

// Verify built JS/MJS files and collect summary stats.
let fileCount = 0;
let totalBytes = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else {
      fileCount += 1;
      totalBytes += st.size;
      if (name.endsWith('.mjs') || name.endsWith('.js')) {
        execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
      }
    }
  }
}

walk(OUT_DIR);

// Validate the built bundle with `agy plugin validate --strict` if available.
try {
  execFileSync('agy', ['plugin', 'validate', OUT_DIR, '--strict'], {
    stdio: 'inherit',
  });
} catch (err) {
  if (err && err.code === 'ENOENT') {
    console.warn('Skipping `agy plugin validate` (agy CLI not found on PATH).');
  } else {
    console.error('Built plugin failed `agy plugin validate --strict`.');
    process.exit(1);
  }
}

console.log(
  `Built ${relative(ROOT, OUT_DIR)} (${fileCount} files, ${(totalBytes / 1024).toFixed(1)} KiB).`,
);
