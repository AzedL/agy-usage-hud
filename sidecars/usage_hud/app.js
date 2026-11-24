/**
 * Usage HUD front end: L1 conversation, L2 turns, L3 steps.
 *
 * Every level is a block of numbers laid out in reading order. The only
 * coloured text is the wait duration, which is coloured by its own length.
 */
const root = document.getElementById('root');
const POLL_MS = 3000;

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '\u2014';
  return Math.round(n).toLocaleString('en-US');
}

function tok(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '\u2014';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function pct(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return '\u2014';
  return (x * 100).toFixed(1) + '%';
}

function tps(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return '\u2014';
  return x >= 100 ? x.toFixed(0) : x.toFixed(1);
}

/** Compact duration: 43s, 7.0m, 1.1h. */
function dur(ms) {
  if (ms === null || ms === undefined) return '\u2014';
  const s = ms / 1000;
  if (s < 1) return '<1s';
  if (s < 60) return s.toFixed(0) + 's';
  if (s < 3600) return (s / 60).toFixed(1) + 'm';
  return (s / 3600).toFixed(1) + 'h';
}

/** A wait is green under a minute, amber under five, red beyond. */
function ageClass(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 60000) return 'good';
  if (ms < 300000) return 'mid';
  return 'bad';
}

function clock(at) {
  if (!at) return '--:--';
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

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

/** The wait since the previous model call, coloured by its own length. */
function waitSpan(ms) {
  return el('span', 't ' + ageClass(ms), '+' + dur(ms));
}

/** "in 2382 \u00b7 cache 407.0k \u00b7 out 1055 \u00b7 210.4 tok/s" */
function usageText(input, cache, output, rate) {
  return 'in ' + tok(input) + ' \u00b7 cache ' + tok(cache) + ' \u00b7 out ' + tok(output) +
    (rate === null || rate === undefined ? '' : ' \u00b7 ' + tps(rate) + ' tok/s');
}

/**
 * A generation shorter than this cannot be told apart from the first-token
 * wait: five tokens in 30ms says nothing about sustained speed. Such a step
 * still shows its tokens, but no rate.
 */
const MIN_RATE_STREAM_MS = 200;

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
    grid.append(metric('tps', tps(s.tps) + ' tok/s'));
    grid.append(metric('total', tok(s.total)));
    grid.append(metric('hit', pct(s.hitRate)));
  }
  card.append(grid);

  if (!data.hasUsage) {
    const note = el('div', 'line2 dim', 'This conversation records no token usage.');
    note.style.marginTop = '6px';
    card.append(note);
  }

  const ctx = el('div', 'metric');
  ctx.style.marginTop = '8px';
  ctx.append(el('span', 'k', 'context'));
  ctx.append(el('span', 'v',
    (s.contextUsed === null ? '\u2014' : tok(s.contextUsed)) + ' / ' + tok(s.contextMax) +
    (s.contextRatio === null ? '' : '  ' + pct(s.contextRatio))));
  card.append(ctx);

  if (s.contextUsed !== null) card.append(contextBar(s.contextUsed, s.contextMax));

  if (s.contextSource !== 'gen_metadata') {
    const note = el('div', 'line2 dim', 'window: fallback ' + tok(s.contextMax));
    note.style.marginTop = '4px';
    card.append(note);
  }
  return card;
}

function hitClass(rate) {
  if (rate === null || rate === undefined) return '';
  if (rate >= 0.8) return 'good';
  if (rate >= 0.5) return 'mid';
  return 'bad';
}

/** Second line of a row: what the call cost, in tokens and throughput. */
function usageLine(text) {
  return el('div', 'line2', text);
}

/** The cache hit rate: its own column, on the right. */
function hitCell(rate) {
  return el('span', 'hit ' + hitClass(rate), rate === null ? '\u2014' : pct(rate));
}

/** The model's streaming rate; null when the window is too short to mean anything. */
function stepRate(st) {
  if (st.rate === null || st.rate === undefined) return null;
  if (st.streamMs !== null && st.streamMs !== undefined && st.streamMs < MIN_RATE_STREAM_MS) return null;
  return st.rate;
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

    mid.append(st.metered
      ? usageLine(usageText(st.input, st.cache, st.output, stepRate(st)))
      : usageLine('no usage'));
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
  line.append(el('span', 'num', turn.stepCount + 'steps'));
  // The first turn of the conversation has nothing before it.
  if (turn.gapBeforeMs !== null) line.append(waitSpan(turn.gapBeforeMs));
  mid.append(line);

  mid.append(turn.hasUsage
    ? usageLine(usageText(turn.input, turn.cache, turn.output, turn.tps))
    : usageLine('no usage'));
  row.append(mid, hitCell(turn.hasUsage ? turn.hitRate : null));

  if (!turn.steps.length) return [row];

  row.addEventListener('click', () => {
    expanded.set(turn.index, !open);
    render(state);
  });
  row.setAttribute('role', 'button');
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

  const ordered = [...data.turns].reverse();
  ordered.forEach((t, i) => {
    if (t.implicit && !t.steps.length) return;
    // The turn being watched is the newest one, so it starts open.
    const open = expanded.has(t.index) ? expanded.get(t.index) : i === 0;
    for (const node of renderTurn(t, open)) root.append(node);
  });

  if (!data.turns.length) root.append(el('div', 'empty', 'No turns recorded.'));
}

// ---------------------------------------------------------------------------

/** Open/closed state of a turn, set only by clicking it. */
const expanded = new Map();
let state = { conversationId: null, turns: [] };
let loadedBuild = null;

function usageUrl() {
  const conv = window.sidecar?.conversationId || '';
  return conv ? '/api/usage?conversationId=' + encodeURIComponent(conv) : '/api/usage';
}

async function poll() {
  try {
    const url = usageUrl();
    const res = window.sidecar?.fetch
      ? await window.sidecar.fetch(url, { method: 'GET' })
      : await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const next = await res.json();
    // A plugin update swaps the files under a running pane; pick it up rather
    // than sitting on the build that happened to load first.
    if (next.build) {
      if (loadedBuild === null) loadedBuild = next.build;
      else if (next.build !== loadedBuild) { location.reload(); return; }
    }
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      state = next;
      render(state);
    }
  } catch (err) {
    if (!state.error) {
      state = { ...state, error: 'internal', message: String(err?.message || err) };
      render(state);
    }
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

function applyTheme(vars) {
  if (!vars || typeof vars !== 'object') return;
  const target = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'string' && v.trim()) target.style.setProperty(k, v);
  }
  scheduleContrastCheck();
}

/**
 * A host token can be missing or reference a variable that exists only in the
 * host document, in which case the property falls back to its initial value
 * and the pane goes unreadable. Text that cannot be read is worse than text
 * that ignores the theme, so measure and repair.
 */
function parseRgb(value) {
  const m = /rgba?\(([^)]+)\)/.exec(value || '');
  if (!m) return null;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function luminance({ r, g, b }) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function opaqueBackground(node) {
  for (let n = node; n; n = n.parentElement) {
    const c = parseRgb(getComputedStyle(n).backgroundColor);
    if (c && c.a >= 0.5) return c;
  }
  return parseRgb(getComputedStyle(document.documentElement).backgroundColor)
    || { r: 7, g: 7, b: 8, a: 1 };
}

function ensureContrast() {
  const probe = document.querySelector('.head .title') || document.body;
  if (!probe) return;
  const bg = opaqueBackground(document.body);
  const fg = parseRgb(getComputedStyle(probe).color);
  if (!fg || contrast(fg, bg) < 4.5) {
    const light = luminance(bg) < 0.5;
    document.documentElement.style.setProperty(
      '--foreground', light ? 'rgb(232, 234, 237)' : 'rgb(29, 31, 33)');
    document.documentElement.style.setProperty(
      '--muted-foreground', light ? 'rgb(154, 160, 166)' : 'rgb(93, 103, 111)');
  }
}

let contrastTimer = null;
function scheduleContrastCheck() {
  clearTimeout(contrastTimer);
  contrastTimer = setTimeout(ensureContrast, 50);
}

window.addEventListener('message', (event) => {
  if (event.data?.type !== 'theme-change') return;
  applyTheme(event.data.payload?.cssVariables);
});

window.addEventListener('load', () => setTimeout(ensureContrast, 120));

// The pane owns its scrolling: #scroller is the only scroll container.
render({ conversationId: null, turns: [] });
poll();
