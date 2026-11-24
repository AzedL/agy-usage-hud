/**
 * Static validation script for the agy-usage-hud plugin.
 *
 * Checks:
 *  1. Node syntax (`node --check`) on every .mjs/.js file in sidecars/, scripts/, tests/.
 *  2. Classic-script syntax (`vm.Script`) on browser scripts under `sidecars/usage_hud/web/`
 *     (and no `type="module"` `<script>` tags in `index.html`) for sandboxed iframe safety.
 *  3. `plugin.json` schema and Antigravity allowed top-level keys.
 *  4. `sidecar.json` schema and entrypoint existence.
 *  5. `skills/usage-hud/SKILL.md` frontmatter presence.
 *  6. Required assets and web static files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_PLUGIN_KEYS = new Set([
  'name',
  'displayName',
  'description',
  'logo',
  'version',
  'author',
  'homepage',
  'repository',
  'disabled',
  'suggestedPrompts',
]);

const ALLOWED_LOGO_EXTS = new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp']);

const errors = [];

function fail(msg) {
  errors.push(msg);
}

function collectJsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectJsFiles(full, out);
    else if (entry.endsWith('.mjs') || entry.endsWith('.js')) out.push(full);
  }
  return out;
}

// 1. Syntax check all JS/MJS files.
const jsFiles = [
  ...collectJsFiles(join(ROOT, 'sidecars')),
  ...collectJsFiles(join(ROOT, 'scripts')),
  ...collectJsFiles(join(ROOT, 'tests')),
];
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail(`Syntax error in ${relative(ROOT, file)}: ${err.stderr?.toString() || err.message}`);
  }
}

// 1b. Classic-script validation for browser assets (package.json has "type": "module",
// so `node --check` alone would allow ES module syntax that breaks in sandboxed iframes).
const webDir = join(ROOT, 'sidecars', 'usage_hud', 'web');
for (const file of collectJsFiles(webDir)) {
  const rel = relative(ROOT, file);
  try {
    new vm.Script(readFileSync(file, 'utf-8'), { filename: rel });
  } catch (err) {
    fail(`Browser script ${rel} is not a valid classic script: ${err.message}`);
  }
}
const indexHtmlPath = join(webDir, 'index.html');
if (existsSync(indexHtmlPath)) {
  const html = readFileSync(indexHtmlPath, 'utf-8');
  if (/<script\b[^>]*\btype\s*=\s*["']?module\b/i.test(html)) {
    fail('sidecars/usage_hud/web/index.html must not load scripts with type="module"');
  }
}

// 2. Validate plugin.json.
const pluginJsonPath = join(ROOT, 'plugin.json');
let pluginMeta = null;
try {
  pluginMeta = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
} catch (err) {
  fail(`Invalid plugin.json: ${err.message}`);
}

if (pluginMeta && typeof pluginMeta === 'object') {
  for (const key of Object.keys(pluginMeta)) {
    if (!ALLOWED_PLUGIN_KEYS.has(key)) {
      fail(`Unknown top-level field in plugin.json: "${key}"`);
    }
  }
  if (typeof pluginMeta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginMeta.name)) {
    fail(`plugin.json "name" must be lowercase kebab-case, got: ${JSON.stringify(pluginMeta.name)}`);
  }
  if (typeof pluginMeta.description !== 'string' || !pluginMeta.description.trim()) {
    fail('plugin.json "description" must be a non-empty string');
  }
  if (pluginMeta.logo !== undefined) {
    if (typeof pluginMeta.logo !== 'string' || pluginMeta.logo.startsWith('/') || pluginMeta.logo.includes('://')) {
      fail(`plugin.json "logo" must be a relative path, got: ${JSON.stringify(pluginMeta.logo)}`);
    } else {
      if (!ALLOWED_LOGO_EXTS.has(extname(pluginMeta.logo).toLowerCase())) {
        fail(`plugin.json "logo" has unsupported extension: ${pluginMeta.logo}`);
      }
      if (!existsSync(join(ROOT, pluginMeta.logo))) {
        fail(`plugin.json "logo" target not found: ${pluginMeta.logo}`);
      }
    }
  }
  if (pluginMeta.suggestedPrompts !== undefined) {
    if (!Array.isArray(pluginMeta.suggestedPrompts) || pluginMeta.suggestedPrompts.length > 3) {
      fail('plugin.json "suggestedPrompts" must be an array of at most 3 strings');
    } else if (pluginMeta.suggestedPrompts.some((p) => typeof p !== 'string' || !p.trim())) {
      fail('plugin.json "suggestedPrompts" entries must be non-empty strings');
    }
  }
}

// 3. Validate sidecar.json and sidecar files.
const sidecarDir = join(ROOT, 'sidecars', 'usage_hud');
const sidecarJsonPath = join(sidecarDir, 'sidecar.json');
let sidecarMeta = null;
try {
  sidecarMeta = JSON.parse(readFileSync(sidecarJsonPath, 'utf-8'));
} catch (err) {
  fail(`Invalid sidecar.json: ${err.message}`);
}

if (sidecarMeta && typeof sidecarMeta === 'object') {
  if (sidecarMeta.command !== 'node') {
    fail(`sidecar.json "command" expected "node", got: ${JSON.stringify(sidecarMeta.command)}`);
  }
  const entry = Array.isArray(sidecarMeta.args) ? sidecarMeta.args[0] : null;
  if (!entry || !existsSync(join(sidecarDir, entry))) {
    fail(`sidecar.json entrypoint not found: ${entry}`);
  }
  if (sidecarMeta.has_web_ui !== true) {
    fail('sidecar.json "has_web_ui" must be true');
  }
  const views = sidecarMeta.ui_config?.views;
  if (!Array.isArray(views) || !views.some((v) => v?.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE')) {
    fail('sidecar.json must declare a SIDECAR_UI_ENTRYPOINT_AUX_PANE view');
  }
}

for (const asset of ['index.html', 'app.js', 'format.js', 'styles.css', 'scrollbars.css']) {
  const full = join(sidecarDir, 'web', asset);
  if (!existsSync(full)) {
    fail(`Missing web asset: ${relative(ROOT, full)}`);
  }
}

// 4. Validate SKILL.md frontmatter.
const skillPath = join(ROOT, 'skills', 'usage-hud', 'SKILL.md');
if (!existsSync(skillPath)) {
  fail('Missing skills/usage-hud/SKILL.md');
} else {
  const skillText = readFileSync(skillPath, 'utf-8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillText);
  if (!fm) {
    fail('skills/usage-hud/SKILL.md is missing YAML frontmatter');
  } else {
    if (!/^name:\s*usage-hud\s*$/m.test(fm[1])) {
      fail('skills/usage-hud/SKILL.md frontmatter must declare "name: usage-hud"');
    }
    if (!/^description:\s*\S+/m.test(fm[1])) {
      fail('skills/usage-hud/SKILL.md frontmatter must declare a non-empty "description"');
    }
  }
}

// 5. Validate logo.svg dimensions.
const logoPath = join(ROOT, 'assets', 'logo.svg');
if (existsSync(logoPath)) {
  const svg = readFileSync(logoPath, 'utf-8');
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!vb || vb[1] !== vb[2] || Number(vb[1]) < 128) {
    fail('assets/logo.svg must have a square viewBox of at least 128x128');
  }
}

if (errors.length) {
  console.error('Check failed:\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}

console.log(`Check passed (${jsFiles.length} JS/MJS files, manifests, assets, and skill verified).`);
