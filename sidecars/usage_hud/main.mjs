/**
 * Usage HUD sidecar backend.
 *
 * Read-only. Answers "how much did this conversation actually cost" for the
 * conversation the pane is open in:
 *   L1 conversation -> L2 turns -> L3 steps
 *
 * Data sources, all on this machine:
 *   <appData>/brain/<conv>/.system_generated/logs/transcript.jsonl
 *       every step; PLANNER_RESPONSE carries model, input_tokens,
 *       cache_read_tokens, output_tokens.
 *   <appData>/conversations/<conv>.db  (table gen_metadata)
 *       one protobuf per model call; carries max_context_tokens. Best effort:
 *       anything missing falls back to FALLBACK_CONTEXT_WINDOW.
 *
 * Transcript token semantics (verified against real data): input_tokens is the
 * part NOT served from cache, cache_read_tokens the cached part, so the prompt
 * actually sent is input + cache_read.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f][0-9a-f-]{7,}$/i;

/**
 * Denominator for "how full is the context". Every path that cannot obtain the
 * real max_context_tokens ends here, by design.
 */
const FALLBACK_CONTEXT_WINDOW = 512000;

// ---------------------------------------------------------------------------
// App data dirs. Under a language server the sidecar runs beneath one app data
// dir; standalone, every ~/.gemini/<product> that has a brain/ is used.
// ---------------------------------------------------------------------------

function safeReaddir(p) {
  try { return readdirSync(p); } catch { return []; }
}

function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(homedir(), '.gemini');
  return safeReaddir(root)
    .sort()
    .map((name) => join(root, name))
    .filter((c) => existsSync(join(c, 'brain')));
}

function appDataFor(conv) {
  return findAppDataDirs().find((d) => existsSync(join(d, 'brain', conv))) || null;
}

function transcriptPath(appData, conv) {
  return join(appData, 'brain', conv, '.system_generated', 'logs', 'transcript.jsonl');
}

function convDbPath(appData, conv) {
  return join(appData, 'conversations', conv + '.db');
}

// ---------------------------------------------------------------------------
// transcript.jsonl parsing.
// ---------------------------------------------------------------------------

/**
 * Reads the transcript. Returns null when the file is missing, and drops lines
 * that do not parse (a partially written last line is normal while the agent
 * is running).
 */
function readSteps(appData, conv) {
  const p = transcriptPath(appData, conv);
  let text;
  try { text = readFileSync(p, 'utf-8'); } catch { return null; }
  const steps = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let d;
    try { d = JSON.parse(s); } catch { continue; }
    if (!d || typeof d !== 'object') continue;
    steps.push(d);
  }
  steps.sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));
  return steps;
}

function ms(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function isPlanner(d) {
  return d?.type === 'PLANNER_RESPONSE';
}

/**
 * Older builds store PLANNER_RESPONSE without usage fields. Such a step still
 * counts as a step; it just contributes no tokens.
 */
function hasTokens(d) {
  return typeof d?.input_tokens === 'number';
}

function hitRate(input, cache) {
  const total = input + cache;
  return total > 0 ? cache / total : null;
}

/**
 * Splits the transcript into turns. A turn starts at a USER_INPUT step; steps
 * before the first USER_INPUT (older builds store none) form an implicit turn
 * 0 so nothing is silently dropped.
 */
function buildTurns(steps) {
  const turns = [];
  let cur = { index: 0, implicit: true, steps: [] };
  let started = false;
  for (const d of steps) {
    if (d?.type === 'USER_INPUT') {
      if (started || cur.steps.length) turns.push(cur);
      cur = { index: turns.length, implicit: false, steps: [], userInput: d };
      started = true;
      continue;
    }
    cur.steps.push(d);
  }
  if (cur.steps.length || cur.userInput) turns.push(cur);
  return turns.map((t, i) => ({ ...t, index: i }));
}

/** Weighted rate: total output over total generation time, never a mean of rates. */
function rateOf(output, genMs) {
  if (!(output > 0) || !(genMs > 0)) return null;
  return output / (genMs / 1000);
}

function aggregateTurns(turns, timings) {
  let prevPlannerEnd = null;
  return turns.map((t) => {
    const planner = t.steps.filter(isPlanner);
    const metered = planner.filter(hasTokens);
    const input = metered.reduce((a, d) => a + (d.input_tokens || 0), 0);
    const cache = metered.reduce((a, d) => a + (d.cache_read_tokens || 0), 0);
    const output = metered.reduce((a, d) => a + (d.output_tokens || 0), 0);
    const start = ms(t.steps[0]?.created_at) ?? ms(t.userInput?.created_at);
    const end = ms(planner[planner.length - 1]?.created_at) ?? ms(t.steps[t.steps.length - 1]?.created_at);
    const durationMs = start !== null && end !== null && end >= start ? end - start : null;
    const gapBeforeMs = prevPlannerEnd !== null && start !== null ? Math.max(0, start - prevPlannerEnd) : null;
    if (end !== null) prevPlannerEnd = end;

    const stepRows = [];
    let prevStepEnd = null;
    for (const d of t.steps) {
      if (!isPlanner(d)) continue;
      const metered = hasTokens(d);
      const c = metered ? d.cache_read_tokens || 0 : null;
      const i = metered ? d.input_tokens || 0 : null;
      const o = metered ? d.output_tokens || 0 : null;
      const at = ms(d.created_at);
      const timing = (at !== null && timings) ? timings.get(Math.floor(at / 1000)) : undefined;
      stepRows.push({
        // 1-based position inside the turn: what the pane labels "#n".
        index: stepRows.length + 1,
        stepIndex: d.step_index ?? null,
        model: typeof d.model === 'string' && d.model ? d.model : null,
        metered,
        input: i,
        cache: c,
        output: o,
        prompt: metered ? i + c : null,
        hitRate: metered ? hitRate(i, c) : null,
        at,
        // Time since the previous model call; the first step borrows the
        // turn's own start, so only the very first step of the conversation
        // has no time at all.
        gapMs: at !== null && prevStepEnd !== null ? Math.max(0, at - prevStepEnd) : null,
        // Streaming time alone; the first-token wait is kept separate so it
        // never dilutes the rate.
        streamMs: timing ? timing.streamMs : null,
        ttftMs: timing ? timing.ttftMs : null,
        timingSource: timing ? timing.source : null,
        // Response tokens only: thinking happens before the first visible
        // token, so charging it to the streaming span is wrong either way.
        response: timing ? timing.response : null,
        thinking: timing ? timing.thinking : null,
        rate: timing && metered ? rateOf(timing.response ?? o, timing.streamMs) : null,
      });
      if (at !== null) prevStepEnd = at;
    }

    // The first step of a turn carries the turn's own wait: the pane shows the
    // same interval on the turn header and on its "#1" row, and only the very
    // first turn of the conversation has none.
    if (stepRows.length) stepRows[0].gapMs = gapBeforeMs;

    // Weighted: this turn's streamed output over its streaming time.
    const timed = stepRows.filter((s) => s.rate !== null);
    const streamMs = timed.reduce((a, s) => a + s.streamMs, 0);
    const streamedOutput = timed.reduce((a, s) => a + (s.response ?? s.output), 0);
    const turnTps = rateOf(streamedOutput, streamMs);

    return {
      index: t.index,
      implicit: t.implicit,
      userInputAt: ms(t.userInput?.created_at),
      start,
      end,
      durationMs,
      streamMs: streamMs > 0 ? streamMs : null,
      tps: turnTps,
      thinking: timed.reduce((a, s) => a + (s.thinking || 0), 0),
      gapBeforeMs,
      stepCount: stepRows.length,
      meteredSteps: metered.length,
      hasUsage: metered.length > 0,
      rawStepCount: t.steps.length,
      input,
      cache,
      output,
      promptTotal: input + cache,
      hitRate: hitRate(input, cache),
      steps: stepRows,
    };
  });
}

// ---------------------------------------------------------------------------
// gen_metadata: max_context_tokens. Everything here is optional; the caller
// keeps FALLBACK_CONTEXT_WINDOW when it returns null.
// ---------------------------------------------------------------------------

function readVarint(buf, i) {
  let value = 0;
  let shift = 0;
  while (i < buf.length) {
    const byte = buf[i++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, i];
    shift += 7;
    if (shift > 63) return null;
  }
  return null;
}

/** Depth-limited protobuf walk collecting varint fields keyed by field path. */
function walkVarints(buf, path = '', depth = 0, out = new Map()) {
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    if (!tag) return out;
    const [rawTag, afterTag] = tag;
    i = afterTag;
    const field = rawTag >> 3;
    const wire = rawTag & 7;
    if (!field || field > 20000) return out;
    if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) return out;
      i = v[1];
      out.set(path + '/' + field, v[0]);
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return out;
      i = len[1];
      const size = len[0];
      if (size < 0 || i + size > buf.length) return out;
      const child = buf.subarray(i, i + size);
      i += size;
      if (depth < 10 && size > 1) walkVarints(child, path + '/' + field, depth + 1, out);
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      return out;
    }
  }
  return out;
}

/** Field path of ContextWindowMetadata.max_context_tokens inside the blob. */
const MAX_CONTEXT_PATH = '/1/9/10/4';
/** Field path of ContextWindowMetadata.estimated_tokens_used. */
const ESTIMATED_USED_PATH = '/1/9/10/1';

async function loadContextMeta(appData, conv) {
  const dbPath = convDbPath(appData, conv);
  if (!existsSync(dbPath)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null; // older runtime: fall back to FALLBACK_CONTEXT_WINDOW
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('select data from gen_metadata order by idx').all();
    const windows = [];
    const estimated = [];
    for (const row of rows) {
      const buf = row?.data;
      if (!buf || typeof buf.length !== 'number') continue;
      const fields = walkVarints(buf);
      const max = fields.get(MAX_CONTEXT_PATH);
      const used = fields.get(ESTIMATED_USED_PATH);
      if (typeof max === 'number' && max > 0) windows.push(max);
      if (typeof used === 'number') estimated.push(used);
    }
    if (!windows.length) return null;
    return {
      maxContextTokens: windows[windows.length - 1],
      maxContextTokensSeen: [...new Set(windows)].sort((a, b) => a - b),
      estimatedTokensUsed: estimated.length ? estimated[estimated.length - 1] : null,
      rows: rows.length,
      source: 'gen_metadata',
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* nothing to do */ }
  }
}

// ---------------------------------------------------------------------------
// Streaming timing.
//
// Two sources, and only the second one is a real streaming rate:
//
//   steps table   createdAt -> viewableAt. Always present, but that window also
//                 contains the wait for the first token, so it under-reports a
//                 fast model badly (a 4.7s TTFT in front of 0.2s of actual
//                 streaming turns 300 tok/s into 25).
//   language server  generatorMetadata.streamingDuration, the time spent
//                 emitting tokens, with timeToFirstToken kept separate.
//
// The language server is asked first; the steps table is the fallback. This is
// read-only and uses the environment the sidecar is started with.
// ---------------------------------------------------------------------------

const PLANNER_STEP_TYPE = 15;
/** Field paths inside a planner step's metadata blob: /1 = createdAt,
 *  /6 = viewableAt, /9/3 = outputTokens, /9/9 = thinking, /9/10 = response. */
const STEP_CREATED = '/1/1';
const STEP_CREATED_NANO = '/1/2';
const STEP_VIEWABLE = '/6/1';
const STEP_VIEWABLE_NANO = '/6/2';
const STEP_OUTPUT = '/9/3';
const STEP_THINKING = '/9/9';
const STEP_RESPONSE = '/9/10';

/** "0.198405800s" / "1m2.5s" / "350ms" -> milliseconds, or null. */
function parseDuration(text) {
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
 * Per-model-call timings from the language server, keyed by the same truncated
 * creation second the transcript carries so both sources join identically.
 * Returns null when the server cannot be reached, which is the normal case
 * outside the app.
 */
async function loadGeneratorTimings(conv) {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf || !conv) return null;
  let body;
  try {
    const res = await fetch(
      'http://' + addr + '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
        body: JSON.stringify({ cascadeId: conv }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }

  const steps = Array.isArray(body?.trajectory?.steps) ? body.trajectory.steps : [];
  const createdByIndex = new Map();
  for (const step of steps) {
    if (!String(step?.type || '').includes('PLANNER_RESPONSE')) continue;
    const idx = step?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
    const created = Date.parse(step?.metadata?.createdAt);
    if (Number.isInteger(idx) && Number.isFinite(created)) createdByIndex.set(idx, created);
  }

  const generators = body?.trajectory?.generatorMetadata;
  const list = Array.isArray(generators) ? generators : [];
  const bySecond = new Map();
  for (const g of list) {
    const first = Array.isArray(g?.stepIndices) ? g.stepIndices[0] : null;
    const created = createdByIndex.get(first);
    if (created === undefined) continue;
    const chat = g?.chatModel || {};
    const streamMs = parseDuration(chat.streamingDuration);
    if (!(streamMs > 0)) continue;
    const usage = chat.usage || {};
    bySecond.set(Math.floor(created / 1000), {
      streamMs,
      ttftMs: parseDuration(chat.timeToFirstToken),
      response: usage.responseOutputTokens === undefined ? null : Number(usage.responseOutputTokens),
      thinking: usage.thinkingOutputTokens === undefined ? null : Number(usage.thinkingOutputTokens),
      source: 'generator',
    });
  }
  return bySecond.size ? bySecond : null;
}

/**
 * Fallback timings from the conversation's own steps table. Same key, coarser
 * window: it includes the first-token wait.
 */
async function loadStepTimings(appData, conv) {
  const dbPath = convDbPath(appData, conv);
  if (!existsSync(dbPath)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('select metadata from steps where step_type = ? order by idx').all(PLANNER_STEP_TYPE);
    const bySecond = new Map();
    for (const row of rows) {
      const buf = row?.metadata;
      if (!buf || typeof buf.length !== 'number') continue;
      const f = walkVarints(buf);
      const created = f.get(STEP_CREATED);
      const viewable = f.get(STEP_VIEWABLE);
      if (typeof created !== 'number' || typeof viewable !== 'number') continue;
      const genMs = (viewable - created) * 1000
        + Math.round(((f.get(STEP_VIEWABLE_NANO) ?? 0) - (f.get(STEP_CREATED_NANO) ?? 0)) / 1e6);
      if (genMs <= 0) continue;
      bySecond.set(created, {
        streamMs: genMs,
        ttftMs: null,
        response: f.get(STEP_RESPONSE) ?? null,
        thinking: f.get(STEP_THINKING) ?? null,
        source: 'steps',
      });
    }
    return bySecond.size ? bySecond : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* nothing to do */ }
  }
}

async function loadTimings(appData, conv) {
  const fromLs = await loadGeneratorTimings(conv);
  if (fromLs) return fromLs;
  return loadStepTimings(appData, conv);
}

// ---------------------------------------------------------------------------
// Snapshot.
// ---------------------------------------------------------------------------

function summarizeConversation(turns) {
  const input = turns.reduce((a, t) => a + t.input, 0);
  const cache = turns.reduce((a, t) => a + t.cache, 0);
  const output = turns.reduce((a, t) => a + t.output, 0);
  const plannerTurns = turns.filter((t) => t.stepCount > 0);
  const meteredSteps = turns.reduce((a, t) => a + t.meteredSteps, 0);
  const first = plannerTurns.find((t) => t.start !== null);
  const last = [...plannerTurns].reverse().find((t) => t.end !== null);
  const spanMs = first && last && last.end >= first.start ? last.end - first.start : null;

  // Weighted like a turn, over every counted step in the conversation.
  const timed = [];
  for (const t of turns) {
    for (const s of t.steps) {
      if (s.rate !== null) timed.push(s);
    }
  }
  const streamMs = timed.reduce((a, s) => a + s.streamMs, 0);
  const streamedOutput = timed.reduce((a, s) => a + (s.response ?? s.output), 0);
  const conversationTps = rateOf(streamedOutput, streamMs);
  return {
    turns: turns.length,
    steps: turns.reduce((a, t) => a + t.stepCount, 0),
    meteredSteps,
    hasUsage: meteredSteps > 0,
    input,
    cache,
    output,
    promptTotal: input + cache,
    // Everything the model was charged for on the input side, plus what it
    // generated.
    total: input + cache + output,
    hitRate: meteredSteps > 0 ? hitRate(input, cache) : null,
    spanMs,
    streamMs: streamMs > 0 ? streamMs : null,
    tps: conversationTps,
    timedSteps: timed.length,
    thinking: timed.reduce((a, s) => a + (s.thinking || 0), 0),
    response: timed.reduce((a, s) => a + (s.response ?? s.output), 0),
    timingSource: timed.find((s) => s.timingSource)?.timingSource ?? null,
  };
}

async function snapshot(conv) {
  const build = buildStamp();
  if (!conv || !ID_RE.test(conv)) return { conversationId: conv || null, build, error: 'no-conversation' };
  const appData = appDataFor(conv);
  if (!appData) return { conversationId: conv, build, error: 'not-found' };

  const steps = readSteps(appData, conv);
  if (!steps) return { conversationId: conv, build, error: 'no-transcript' };

  const timings = await loadTimings(appData, conv);
  const turns = aggregateTurns(buildTurns(steps), timings);
  const summary = summarizeConversation(turns);

  const meta = await loadContextMeta(appData, conv);
  const lastMetered = [...steps].reverse().find(hasTokens);
  const lastTurn = [...turns].reverse().find((t) => t.stepCount > 0);
  const lastStep = lastTurn?.steps.filter((s) => s.metered).pop() ?? null;
  const contextUsed = lastStep ? lastStep.prompt : (meta?.estimatedTokensUsed ?? null);
  // Every fallback path ends here.
  const contextMax = meta?.maxContextTokens ?? FALLBACK_CONTEXT_WINDOW;

  return {
    conversationId: conv,
    build,
    model: lastMetered?.model ?? lastStep?.model ?? null,
    hasUsage: summary.hasUsage,
    summary: {
      ...summary,
      contextUsed,
      contextMax,
      contextRatio: contextUsed !== null && contextMax > 0 ? contextUsed / contextMax : null,
      contextSource: meta ? 'gen_metadata' : 'fallback',
    },
    context: {
      maxContextTokens: contextMax,
      maxContextTokensSeen: meta?.maxContextTokensSeen ?? null,
      source: meta?.source ?? null,
    },
    turns,
  };
}

// ---------------------------------------------------------------------------
// HTTP.
// ---------------------------------------------------------------------------

/**
 * The pane keeps its iframe alive across plugin updates, so a fixed page can
 * keep showing an old build indefinitely. Every asset read is stamped; the page
 * polls and reloads itself when the stamp moves.
 */
function buildStamp() {
  const stamps = [];
  for (const f of ['index.html', 'app.js', 'styles.css', 'main.mjs']) {
    try {
      stamps.push(Math.round(statSync(join(__dirname, f)).mtimeMs));
    } catch { /* a missing asset just does not contribute */ }
  }
  return stamps.join('-');
}

const app = new SidecarApp();

app.page('/', () => new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
  contentType: 'text/html',
  headers: { 'Cache-Control': 'no-store, max-age=0' },
}));
// no-store everywhere: a pane that keeps running while the plugin is updated
// must never mix an old index.html with a new app.js.
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
for (const [route, [file, type]] of Object.entries({
  '/app.js': ['app.js', 'application/javascript'],
  '/styles.css': ['styles.css', 'text/css'],
  '/scrollbars.css': ['scrollbars.css', 'text/css'],
})) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType: type, headers: NO_STORE }), 'GET');
}

app.api('/api/usage', async (data) => {
  const conv = data.conversationId || app.config.conversationId || '';
  try {
    return await snapshot(conv);
  } catch (err) {
    return { conversationId: conv || null, error: 'internal', message: String(err?.message ?? err) };
  }
}, 'GET');

app.run();