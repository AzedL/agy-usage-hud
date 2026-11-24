/**
 * Usage HUD sidecar HTTP entrypoint.
 *
 * Read-only Antigravity sidecar serving the web UI (`web/`) and `/api/usage`
 * for the open conversation. Uses a stat-signature cache with bounded
 * partial-timing retries and in-flight request deduplication to avoid repeated
 * full-transcript reads, SQLite scans, and `GetCascadeTrajectory` RPCs when a
 * conversation is idle.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { SnapshotCache } from './lib/cache.mjs';
import {
  appDataFor,
  conversationStatSignature,
  findAppDataDirs,
  ID_RE,
  loadMetricsData,
  readSteps,
} from './lib/sources.mjs';
import { buildSnapshot, hasUnmatchedPlannerSteps } from './lib/usage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, 'web');

/** Files whose modification time stamps the running build for live reloads. */
const WATCHED_FILES = [
  'main.mjs',
  'lib/cache.mjs',
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

const snapshotCache = new SnapshotCache({ maxEntries: 16 });
/** @type {Map<string, Promise<object>>} */
const inFlight = new Map();

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
  const hasLs = Boolean(process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN);
  const cached = snapshotCache.get(conv, sig, { hasLs });
  if (cached) return cached;

  const steps = readSteps(appData, conv);
  if (!steps) {
    return { conversationId: conv, build, error: 'no-transcript' };
  }

  const { meta, timings, fallbackTimings } = await loadMetricsData(appData, conv, {
    needsFallback: (lsTimings) => hasUnmatchedPlannerSteps(steps, lsTimings),
  });
  const payload = buildSnapshot({ conv, build, steps, timings, fallbackTimings, meta });
  snapshotCache.set(conv, sig, payload, { hasLs });
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
