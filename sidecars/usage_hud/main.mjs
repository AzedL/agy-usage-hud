/**
 * Usage HUD sidecar HTTP entrypoint.
 *
 * Read-only Antigravity sidecar serving the web UI (`web/`) and `/api/usage`
 * for the open conversation. Uses a stat-signature cache + in-flight request
 * deduplication to avoid repeated full-transcript reads, SQLite scans, and
 * `GetCascadeTrajectory` RPCs when a conversation is idle.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  appDataFor,
  conversationStatSignature,
  findAppDataDirs,
  ID_RE,
  loadMetricsData,
  readSteps,
} from './lib/sources.mjs';
import { buildSnapshot } from './lib/usage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, 'web');

const MAX_CACHE_ENTRIES = 16;
const LS_RETRY_TTL_MS = 5000;

/** Files whose modification time stamps the running build for live reloads. */
const WATCHED_FILES = [
  'main.mjs',
  'lib/protobuf.mjs',
  'lib/sources.mjs',
  'lib/usage.mjs',
  'web/index.html',
  'web/app.js',
  'web/format.js',
  'web/styles.css',
  'web/scrollbars.css',
];

/**
 * The auxiliary pane keeps its iframe alive across plugin updates, so every
 * response carries a stamp derived from asset mtimes; the page reloads itself
 * whenever the stamp moves.
 */
function buildStamp() {
  const stamps = [];
  for (const rel of WATCHED_FILES) {
    try {
      stamps.push(Math.round(statSync(join(__dirname, rel)).mtimeMs));
    } catch {
      /* missing file simply does not contribute */
    }
  }
  return stamps.join('-');
}

/** @type {Map<string, { sig: string, at: number, payload: object }>} */
const snapshotCache = new Map();
/** @type {Map<string, Promise<object>>} */
const inFlight = new Map();

function setCache(conv, entry) {
  if (snapshotCache.has(conv)) snapshotCache.delete(conv);
  snapshotCache.set(conv, entry);
  if (snapshotCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = snapshotCache.keys().next().value;
    snapshotCache.delete(oldestKey);
  }
}

async function computeSnapshot(conv, activeConversationId) {
  const build = buildStamp();
  if (!conv || !ID_RE.test(conv)) {
    return { conversationId: conv || null, build, error: 'no-conversation' };
  }

  const dirs = findAppDataDirs();
  const appData = appDataFor(conv, { dirs });
  if (!appData) {
    // A brand-new conversation opened in the host may not have created
    // brain/<conv> yet; report no-transcript rather than a confusing not-found.
    const isFreshActive = Boolean(
      dirs.length && activeConversationId && conv === activeConversationId,
    );
    return {
      conversationId: conv,
      build,
      error: isFreshActive ? 'no-transcript' : 'not-found',
    };
  }

  const sig = `${build}|${conversationStatSignature(appData, conv)}`;
  const cached = snapshotCache.get(conv);
  const hasLs = Boolean(process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN);
  if (cached && cached.sig === sig) {
    const missingGeneratorTiming =
      hasLs &&
      cached.payload?.hasUsage &&
      cached.payload?.summary?.timingSource !== 'generator';
    if (!missingGeneratorTiming || Date.now() - cached.at < LS_RETRY_TTL_MS) {
      return cached.payload;
    }
  }

  const steps = readSteps(appData, conv);
  if (!steps) {
    return { conversationId: conv, build, error: 'no-transcript' };
  }

  const { meta, timings } = await loadMetricsData(appData, conv);
  const payload = buildSnapshot({ conv, build, steps, timings, meta });
  setCache(conv, { sig, at: Date.now(), payload });
  return payload;
}

function getSnapshot(conv, activeConversationId) {
  const key = `${conv || ''}|${activeConversationId || ''}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = computeSnapshot(conv, activeConversationId).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const app = new SidecarApp();

app.page(
  '/',
  () =>
    new Response(readFileSync(join(WEB_DIR, 'index.html'), 'utf-8'), {
      contentType: 'text/html; charset=utf-8',
      headers: NO_STORE,
    }),
);

const STATIC_ASSETS = {
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/format.js': ['format.js', 'application/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/scrollbars.css': ['scrollbars.css', 'text/css; charset=utf-8'],
};

for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () =>
      new Response(readFileSync(join(WEB_DIR, file), 'utf-8'), {
        contentType,
        headers: NO_STORE,
      }),
    'GET',
  );
}

app.api(
  '/api/usage',
  async (data) => {
    const activeConv = app.config.conversationId || '';
    const conv = data.conversationId || activeConv;
    try {
      return await getSnapshot(conv, activeConv);
    } catch (err) {
      return {
        conversationId: conv || null,
        error: 'internal',
        message: String(err?.message ?? err),
      };
    }
  },
  'GET',
);

app.run();
