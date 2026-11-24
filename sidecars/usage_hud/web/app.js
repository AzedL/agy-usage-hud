/**
 * Usage HUD frontend: L1 conversation summary, L2 turns, L3 model calls.
 *
 * Semantic colour is reserved for two signals: wait duration (green/amber/red
 * by age) and cache hit rate (green/amber/red by ratio).
 */
import {
  ageClass,
  clock,
  contrast,
  dur,
  fmt,
  hitClass,
  luminance,
  parseRgb,
  pct,
  stepCountLabel,
  stepRate,
  tok,
  tps,
  usageText,
} from './format.js';

const root = document.getElementById('root');
const scroller = document.getElementById('scroller');
const POLL_MS = 3000;

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function metric(k, v) {
  const wrap = el('div', 'metric');
  wrap.append(el('span', 'k', k), el('span', 'v', v));
  return wrap;
}

function contextBar(used, max) {
  const ratio = max > 0 ? Math.min(1, used / max) : 0;
  const bar = el('div', 'bar');
  if (ratio >= 0.95) bar.className = 'bar bad';
  else if (ratio >= 0.8) bar.className = 'bar warn';
  const fill = el('i');
  fill.style.width = (ratio * 100).toFixed(1) + '%';
  bar.append(fill);
  return bar;
}

/** Wait since the previous model call, coloured by its duration. */
function waitSpan(ms) {
  return el('span', 't ' + ageClass(ms), '+' + dur(ms));
}

function renderHead(data) {
  const head = el('div', 'head');
  head.append(el('span', 'title', 'Usage'));
  head.append(el('span', 'model', data.model || '\u2014'));
  return head;
}

function renderSummary(data) {
  const s = data.summary;
  const card = el('div', 'card');
  const grid = el('div', 'l1');

  grid.append(metric('turns', fmt(s.turns)));
  grid.append(metric('steps', fmt(s.steps)));

  if (data.hasUsage) {
    grid.append(metric('input', tok(s.input)));
    grid.append(metric('cache', tok(s.cache)));
    grid.append(metric('output', tok(s.output)));
    grid.append(metric('tps', s.tps === null || s.tps === undefined ? '\u2014' : tps(s.tps) + ' tok/s'));
    grid.append(metric('total', tok(s.total)));
    grid.append(metric('hit', pct(s.hitRate)));
  }
  card.append(grid);

  if (!data.hasUsage) {
    const note = el('div', 'card-note', 'This conversation records no token usage.');
    note.style.marginTop = '6px';
    card.append(note);
  }

  const ctx = el('div', 'metric');
  ctx.style.marginTop = '8px';
  ctx.append(el('span', 'k', 'context'));
  ctx.append(
    el(
      'span',
      'v',
      (s.contextUsed === null ? '\u2014' : tok(s.contextUsed)) +
        ' / ' +
        tok(s.contextMax) +
        (s.contextRatio === null ? '' : '  ' + pct(s.contextRatio)),
    ),
  );
  card.append(ctx);

  if (s.contextUsed !== null) card.append(contextBar(s.contextUsed, s.contextMax));

  if (s.contextSource !== 'gen_metadata') {
    const note = el('div', 'card-note', 'window: fallback ' + tok(s.contextMax));
    note.style.marginTop = '4px';
    card.append(note);
  }
  return card;
}

/** Second line of a row: what the call cost, in tokens and throughput. */
function usageLine(text) {
  return el('div', 'line2', text);
}

/** Cache hit rate: its own right-aligned column. */
function hitCell(rate) {
  const hasRate = rate !== null && rate !== undefined && !Number.isNaN(rate);
  return el('span', 'hit ' + hitClass(rate), hasRate ? pct(rate) : '\u2014');
}

/** "#24 gemini-4-neon-high 409.4k +43s" */
function renderSteps(turn) {
  const box = el('div', 'steps');
  for (const st of [...turn.steps].reverse()) {
    const row = el('div', 'row');
    row.append(el('span', 'lbl', '#' + st.index));

    const mid = el('div', 'mid');
    const line = el('div', 'line1');
    line.append(el('span', 'model', st.model || '\u2014'));
    if (st.prompt !== null) line.append(el('span', 'num', tok(st.prompt)));
    // The first step of the conversation has nothing before it.
    if (st.gapMs !== null) line.append(waitSpan(st.gapMs));
    mid.append(line);

    mid.append(
      st.metered
        ? usageLine(usageText(st.input, st.cache, st.output, stepRate(st)))
        : usageLine('no usage'),
    );
    row.append(mid, hitCell(st.hitRate));
    box.append(row);
  }
  return box;
}

/** "#8 17:23 24 steps +7.0m" */
function renderTurn(turn, open) {
  const row = el('div', 'row');
  row.append(el('span', 'lbl', '#' + (turn.index + 1)));

  const mid = el('div', 'mid');
  const line = el('div', 'line1');
  line.append(el('span', 'num', clock(turn.start)));
  line.append(el('span', 'num', stepCountLabel(turn.stepCount)));
  // The first turn of the conversation has nothing before it.
  if (turn.gapBeforeMs !== null) line.append(waitSpan(turn.gapBeforeMs));
  mid.append(line);

  mid.append(
    turn.hasUsage
      ? usageLine(usageText(turn.input, turn.cache, turn.output, turn.tps))
      : usageLine('no usage'),
  );
  row.append(mid, hitCell(turn.hasUsage ? turn.hitRate : null));

  if (!turn.steps.length) return [row];

  const toggle = () => {
    expanded.set(turn.index, !open);
    render(state);
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-expanded', String(open));

  return open ? [row, renderSteps(turn)] : [row];
}

function render(data) {
  root.replaceChildren();

  if (data.error) {
    root.append(renderHead({}));
    const map = {
      'no-conversation': 'No conversation in this pane.',
      'not-found': 'This conversation is not on this machine.',
      'no-transcript': 'No transcript yet \u2014 send a message first.',
      internal: 'Failed to read usage: ' + (data.message || 'unknown error'),
    };
    root.append(el('div', 'empty', map[data.error] || data.error));
    return;
  }

  root.append(renderHead(data));

  if (!data.summary) {
    root.append(el('div', 'empty', 'Loading\u2026'));
    return;
  }

  root.append(renderSummary(data));
  const title = el('div', 'section-title');
  title.append(el('span', null, 'turns'), el('span', null, data.summary.turns + ' total'));
  root.append(title);

  const visible = [...data.turns]
    .reverse()
    .filter((t) => !(t.implicit && !t.steps.length));

  visible.forEach((t, i) => {
    // The newest turn starts open so the user sees live steps immediately.
    const open = expanded.has(t.index) ? expanded.get(t.index) : i === 0;
    for (const node of renderTurn(t, open)) root.append(node);
  });

  if (!visible.length) root.append(el('div', 'empty', 'No turns recorded.'));
}

// ---------------------------------------------------------------------------
// Polling & live updates
// ---------------------------------------------------------------------------

/** Open/closed state of a turn, set only by user interaction. */
const expanded = new Map();
let state = { conversationId: null, turns: [] };
let lastStateJson = '';
let loadedBuild = null;
let pollTimer = null;
let pollInFlight = false;

function usageUrl() {
  const conv = window.sidecar?.conversationId || '';
  return conv ? '/api/usage?conversationId=' + encodeURIComponent(conv) : '/api/usage';
}

function schedulePoll(delayMs = POLL_MS) {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(poll, delayMs);
}

async function poll() {
  if (pollInFlight || document.hidden) return;
  pollInFlight = true;
  try {
    const url = usageUrl();
    const res = window.sidecar?.fetch
      ? await window.sidecar.fetch(url, { method: 'GET' })
      : await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const next = await res.json();

    // A plugin update swaps files beneath a running pane; reload cleanly.
    if (next.build) {
      if (loadedBuild === null) loadedBuild = next.build;
      else if (next.build !== loadedBuild) {
        location.reload();
        return;
      }
    }

    const nextJson = JSON.stringify(next);
    if (nextJson !== lastStateJson) {
      if (next.conversationId !== state.conversationId) {
        expanded.clear();
        if (scroller) scroller.scrollTop = 0;
      }
      state = next;
      lastStateJson = nextJson;
      render(state);
    }
  } catch (err) {
    const message = String(err?.message || err);
    if (state.error !== 'internal' || state.message !== message) {
      state = { ...state, error: 'internal', message };
      lastStateJson = JSON.stringify(state);
      render(state);
    }
  } finally {
    pollInFlight = false;
    schedulePoll(POLL_MS);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    pollTimer = null;
  } else {
    poll();
  }
});

// ---------------------------------------------------------------------------
// Theme synchronization & contrast repair
// ---------------------------------------------------------------------------

function applyTheme(vars) {
  if (!vars || typeof vars !== 'object') return;
  const target = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    if (k.startsWith('--') && typeof v === 'string' && v.trim()) {
      target.style.setProperty(k, v);
    }
  }
  scheduleContrastCheck();
}

function opaqueBackground(node) {
  for (let n = node; n; n = n.parentElement) {
    const c = parseRgb(getComputedStyle(n).backgroundColor);
    if (c && c.a >= 0.5) return c;
  }
  return (
    parseRgb(getComputedStyle(document.documentElement).backgroundColor) || {
      r: 7,
      g: 7,
      b: 8,
      a: 1,
    }
  );
}

/**
 * Repairs unreadable foreground tokens if a host theme variable fails to
 * resolve, and keeps `color-scheme` aligned with the active surface luminance.
 */
function ensureContrast() {
  const probe = document.querySelector('.head .title') || document.body;
  if (!probe) return;
  const bg = opaqueBackground(document.body);
  const isDarkBg = luminance(bg) < 0.5;
  document.documentElement.style.colorScheme = isDarkBg ? 'dark' : 'light';

  const fg = parseRgb(getComputedStyle(probe).color);
  if (!fg || contrast(fg, bg) < 4.5) {
    document.documentElement.style.setProperty(
      '--foreground',
      isDarkBg ? 'rgb(232, 234, 237)' : 'rgb(29, 31, 33)',
    );
    document.documentElement.style.setProperty(
      '--muted-foreground',
      isDarkBg ? 'rgb(154, 160, 166)' : 'rgb(93, 103, 111)',
    );
  }
}

let contrastTimer = null;
function scheduleContrastCheck() {
  clearTimeout(contrastTimer);
  contrastTimer = setTimeout(ensureContrast, 50);
}

window.addEventListener('message', (event) => {
  if (window.parent && window.parent !== window && event.source !== window.parent) return;
  if (event.data?.type !== 'theme-change') return;
  applyTheme(event.data.payload?.cssVariables);
});

window.addEventListener('load', () => setTimeout(ensureContrast, 120));

// Initial paint & first poll.
render(state);
poll();
