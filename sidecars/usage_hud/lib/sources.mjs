/**
 * Local data source adapters for Usage HUD.
 *
 * All reads are strictly local and read-only:
 *  - App data directory discovery (env-driven with ~/.gemini/* fallback)
 *  - Compact conversation transcript (`transcript.jsonl`)
 *  - Conversation SQLite DB (`gen_metadata` and fallback `steps` timing)
 *  - Local Antigravity Language Server `GetCascadeTrajectory` RPC
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  ESTIMATED_USED_PATH,
  GEN_METADATA_PREFIXES,
  MAX_CONTEXT_PATH,
  STEP_CREATED,
  STEP_CREATED_NANO,
  STEP_METADATA_PREFIXES,
  STEP_RESPONSE,
  STEP_THINKING,
  STEP_VIEWABLE,
  STEP_VIEWABLE_NANO,
  walkVarints,
} from './protobuf.mjs';

export const ID_RE = /^[0-9a-f][0-9a-f-]{7,}$/i;
export const PLANNER_STEP_TYPE = 15;

let sqlitePromise = null;

/**
 * Lazily imports `node:sqlite` once and caches the result (or `null` on older
 * Node runtimes without built-in SQLite).
 */
async function getDatabaseSync() {
  if (sqlitePromise === null) {
    sqlitePromise = import('node:sqlite')
      .then((mod) => mod.DatabaseSync ?? null)
      .catch(() => null);
  }
  return sqlitePromise;
}

function safeReaddir(dirPath) {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function safeStatSignature(filePath) {
  try {
    const st = statSync(filePath);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return '0';
  }
}

/**
 * Discovers candidate Antigravity app data directories.
 *
 * When `ANTIGRAVITY_EXECUTABLE_DATA_DIR` is set, walks up to the owning app
 * data directory above `sidecar_data`. If that path does not match the expected
 * layout (or when running standalone), falls back to scanning `~/.gemini/*` for
 * product directories containing `brain/`.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {string[]}
 */
export function findAppDataDirs({ env = process.env, home = homedir() } = {}) {
  const dataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d).toLowerCase() !== 'sidecar_data') continue;
      const appData = dirname(d);
      if (existsSync(join(appData, 'brain'))) return [appData];
      break;
    }
  }
  const root = join(home, '.gemini');
  return safeReaddir(root)
    .sort()
    .map((name) => join(root, name))
    .filter((candidate) => existsSync(join(candidate, 'brain')));
}

export function transcriptPath(appData, conv) {
  return join(appData, 'brain', conv, '.system_generated', 'logs', 'transcript.jsonl');
}

export function convDbPath(appData, conv) {
  return join(appData, 'conversations', conv + '.db');
}

/**
 * Finds the app data directory that owns `conv` by checking either
 * `brain/<conv>` or `conversations/<conv>.db`.
 *
 * @param {string} conv
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, dirs?: string[] }} [options]
 * @returns {string | null}
 */
export function appDataFor(conv, options = {}) {
  const dirs = options.dirs ?? findAppDataDirs(options);
  return (
    dirs.find(
      (d) => existsSync(join(d, 'brain', conv)) || existsSync(convDbPath(d, conv)),
    ) || null
  );
}

/**
 * Builds a lightweight filesystem signature covering the transcript and SQLite
 * database (including WAL file) so unchanged polls can hit cache.
 *
 * @param {string} appData
 * @param {string} conv
 * @returns {string}
 */
export function conversationStatSignature(appData, conv) {
  const tPath = transcriptPath(appData, conv);
  const dbPath = convDbPath(appData, conv);
  return [
    safeStatSignature(tPath),
    safeStatSignature(dbPath),
    safeStatSignature(dbPath + '-wal'),
  ].join('|');
}

/**
 * Parses `transcript.jsonl` into sorted step objects. Returns `null` when the
 * file does not exist; skips blank or partially written JSON lines.
 *
 * @param {string} text
 * @returns {Array<Record<string, unknown>>}
 */
export function parseTranscriptText(text) {
  const steps = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    steps.push(parsed);
  }
  steps.sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));
  return steps;
}

/**
 * Reads and parses the transcript for `conv`, or returns `null` if absent.
 *
 * @param {string} appData
 * @param {string} conv
 * @returns {Array<Record<string, unknown>> | null}
 */
export function readSteps(appData, conv) {
  let text;
  try {
    text = readFileSync(transcriptPath(appData, conv), 'utf-8');
  } catch {
    return null;
  }
  return parseTranscriptText(text);
}

/**
 * Parses a Go-style duration string (`"0.198405800s"`, `"1m2.5s"`, `"350ms"`)
 * into positive milliseconds, or `null` if unparseable / non-positive.
 *
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseDuration(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s) return null;
  let ms = 0;
  let seen = false;
  const re = /(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    seen = true;
    if (m[2] === 'h') ms += n * 3600000;
    else if (m[2] === 'm') ms += n * 60000;
    else if (m[2] === 's') ms += n * 1000;
    else if (m[2] === 'ms') ms += n;
    else if (m[2] === 'us' || m[2] === 'µs') ms += n / 1000;
    else if (m[2] === 'ns') ms += n / 1e6;
  }
  return seen && ms > 0 ? ms : null;
}

/**
 * Parses an optional integer field without coercing `null` or `""` to `0`.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseOptionalInt(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalizes `ANTIGRAVITY_LS_ADDRESS` to an origin URL without trailing slash.
 *
 * @param {string} addr
 * @returns {string}
 */
export function normalizeLsOrigin(addr) {
  const trimmed = addr.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return 'http://' + trimmed;
}

function appendBySecond(map, sec, entry) {
  const list = map.get(sec);
  if (list) list.push(entry);
  else map.set(sec, [entry]);
}

/**
 * Extracts per-model-call timing records from a `GetCascadeTrajectory` response.
 * Records are indexed by both `stepIndex` (for exact 1:1 joins) and truncated
 * creation second queue (collision-safe fallback).
 *
 * @param {unknown} body
 * @returns {{ byStepIndex: Map<number, object>, bySecond: Map<number, object[]>, source: 'generator' } | null}
 */
export function extractGeneratorTimings(body) {
  const steps = Array.isArray(body?.trajectory?.steps) ? body.trajectory.steps : [];
  const createdByIndex = new Map();
  for (const step of steps) {
    if (!String(step?.type || '').includes('PLANNER_RESPONSE')) continue;
    const idx = step?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
    const created = Date.parse(step?.metadata?.createdAt);
    if (Number.isInteger(idx) && Number.isFinite(created)) {
      createdByIndex.set(idx, created);
    }
  }

  const generators = Array.isArray(body?.trajectory?.generatorMetadata)
    ? body.trajectory.generatorMetadata
    : [];

  const byStepIndex = new Map();
  const bySecond = new Map();
  let count = 0;

  for (const g of generators) {
    const first = Array.isArray(g?.stepIndices) ? g.stepIndices[0] : null;
    const created = createdByIndex.get(first);
    if (created === undefined) continue;

    const chat = g?.chatModel || {};
    const streamMs = parseDuration(chat.streamingDuration);
    if (!(streamMs > 0)) continue;

    const usage = chat.usage || {};
    const response = parseOptionalInt(usage.responseOutputTokens);
    const thinking = parseOptionalInt(usage.thinkingOutputTokens);
    const entry = {
      streamMs,
      ttftMs: parseDuration(chat.timeToFirstToken),
      response,
      thinking,
      hasSplit: response !== null || thinking !== null,
      source: 'generator',
    };

    if (Number.isInteger(first) && !byStepIndex.has(first)) {
      byStepIndex.set(first, entry);
    }
    appendBySecond(bySecond, Math.floor(created / 1000), entry);
    count += 1;
  }

  return count > 0 ? { byStepIndex, bySecond, count, source: 'generator' } : null;
}

/**
 * Queries the local language server's `GetCascadeTrajectory` endpoint for
 * streaming durations and thinking/response token splits.
 *
 * @param {string} conv
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} [options]
 */
export async function loadGeneratorTimings(conv, { env = process.env, fetchImpl = fetch } = {}) {
  const addr = env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf || !conv) return null;

  let body;
  try {
    const url =
      normalizeLsOrigin(addr) +
      '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory';
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
      body: JSON.stringify({ cascadeId: conv }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }

  return extractGeneratorTimings(body);
}

/**
 * Reads `gen_metadata` (for context window size) and optionally fallback
 * planner `steps` timings from `conversations/<conv>.db` over a single
 * read-only SQLite connection.
 *
 * @param {string} appData
 * @param {string} conv
 * @param {{ includeStepTimings?: boolean }} [options]
 * @returns {Promise<{ meta: object | null, stepTimings: object | null }>}
 */
export async function loadDbData(appData, conv, { includeStepTimings = false } = {}) {
  const dbPath = convDbPath(appData, conv);
  if (!existsSync(dbPath)) return { meta: null, stepTimings: null };

  const DatabaseSync = await getDatabaseSync();
  if (!DatabaseSync) return { meta: null, stepTimings: null };

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });

    let meta = null;
    try {
      const rows = db.prepare('select data from gen_metadata order by idx').all();
      const windows = [];
      const estimated = [];
      let lastRowHasMax = false;
      for (let rowIdx = 0; rowIdx < rows.length; rowIdx += 1) {
        const buf = rows[rowIdx]?.data;
        let rowHasMax = false;
        if (buf && typeof buf.length === 'number') {
          const fields = walkVarints(buf, { allowedPrefixes: GEN_METADATA_PREFIXES });
          const max = fields.get(MAX_CONTEXT_PATH);
          const used = fields.get(ESTIMATED_USED_PATH);
          if (typeof max === 'number' && max > 0) {
            windows.push(max);
            rowHasMax = true;
          }
          if (typeof used === 'number' && used >= 0) estimated.push(used);
        }
        if (rowIdx === rows.length - 1) lastRowHasMax = rowHasMax;
      }
      if (windows.length) {
        meta = {
          maxContextTokens: windows[windows.length - 1],
          maxContextTokensSeen: [...new Set(windows)].sort((a, b) => a - b),
          estimatedTokensUsed: estimated.length ? estimated[estimated.length - 1] : null,
          rows: rows.length,
          validRows: windows.length,
          lastRowHasMax,
          source: 'gen_metadata',
        };
      }
    } catch {
      meta = null;
    }

    let stepTimings = null;
    if (includeStepTimings) {
      try {
        const rows = db
          .prepare('select idx, metadata from steps where step_type = ? order by idx')
          .all(PLANNER_STEP_TYPE);
        const byStepIndex = new Map();
        const bySecond = new Map();
        let count = 0;

        for (const row of rows) {
          const buf = row?.metadata;
          if (!buf || typeof buf.length !== 'number') continue;
          const f = walkVarints(buf, { allowedPrefixes: STEP_METADATA_PREFIXES });
          const created = f.get(STEP_CREATED);
          const viewable = f.get(STEP_VIEWABLE);
          if (typeof created !== 'number' || typeof viewable !== 'number') continue;
          const genMs =
            (viewable - created) * 1000 +
            Math.round(((f.get(STEP_VIEWABLE_NANO) ?? 0) - (f.get(STEP_CREATED_NANO) ?? 0)) / 1e6);
          if (genMs <= 0) continue;

          const response = f.get(STEP_RESPONSE) ?? null;
          const thinking = f.get(STEP_THINKING) ?? null;
          const entry = {
            streamMs: genMs,
            ttftMs: null,
            response,
            thinking,
            hasSplit: response !== null || thinking !== null,
            source: 'steps',
          };
          if (Number.isInteger(row.idx) && !byStepIndex.has(row.idx)) {
            byStepIndex.set(row.idx, entry);
          }
          appendBySecond(bySecond, created, entry);
          count += 1;
        }
        if (count > 0) {
          stepTimings = { byStepIndex, bySecond, count, source: 'steps' };
        }
      } catch {
        stepTimings = null;
      }
    }

    return { meta, stepTimings };
  } catch {
    return { meta: null, stepTimings: null };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

/**
 * Loads timing and context metadata for `conv`.
 * Runs the language server RPC in parallel with `gen_metadata` when LS env vars
 * are present. If LS is unavailable OR `needsFallback(fromLs)` returns true
 * (indicating at least one planner step failed to match LS), also loads
 * fallback `steps` timings from SQLite so unmatched calls can fall back
 * individually without losing LS timings on matched calls.
 *
 * @param {string} appData
 * @param {string} conv
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   needsFallback?: (lsTimings: object) => boolean,
 * }} [options]
 */
export async function loadMetricsData(appData, conv, options = {}) {
  const env = options.env ?? process.env;
  const hasLs = Boolean(env.ANTIGRAVITY_LS_ADDRESS && env.ANTIGRAVITY_CSRF_TOKEN);

  if (!hasLs) {
    const { meta, stepTimings } = await loadDbData(appData, conv, { includeStepTimings: true });
    return { meta, timings: stepTimings, fallbackTimings: null };
  }

  const [fromLs, dbInitial] = await Promise.all([
    loadGeneratorTimings(conv, options),
    loadDbData(appData, conv, { includeStepTimings: false }),
  ]);

  const shouldLoadFallback =
    !fromLs || (typeof options.needsFallback === 'function' && options.needsFallback(fromLs));

  if (!shouldLoadFallback) {
    return { meta: dbInitial.meta, timings: fromLs, fallbackTimings: null };
  }

  const fallback = await loadDbData(appData, conv, { includeStepTimings: true });
  const meta = fallback.meta ?? dbInitial.meta;
  if (fromLs) {
    return { meta, timings: fromLs, fallbackTimings: fallback.stepTimings };
  }
  return { meta, timings: fallback.stepTimings, fallbackTimings: null };
}
