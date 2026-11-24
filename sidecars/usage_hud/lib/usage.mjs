/**
 * Pure usage aggregation and snapshot assembly for Usage HUD.
 *
 * Separates domain calculations (turn grouping, timing joins, weighted
 * streaming throughput, context fullness) from filesystem/SQLite/RPC I/O so
 * every metric rule can be tested deterministically.
 */

/**
 * Denominator for "how full is the context". Every path that cannot obtain the
 * real `max_context_tokens` falls back to this value by design.
 */
export const FALLBACK_CONTEXT_WINDOW = 512000;

/**
 * Minimum streaming duration (ms) required to report a meaningful `tok/s` rate.
 * Applied consistently across step (L3), turn (L2), and conversation (L1) levels.
 */
export const MIN_RATE_STREAM_MS = 200;

function ms(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function isPlanner(step) {
  return step?.type === 'PLANNER_RESPONSE';
}

/**
 * Older builds record `PLANNER_RESPONSE` without usage fields. Such steps still
 * count as steps; they simply contribute no tokens.
 */
export function hasTokens(step) {
  return typeof step?.input_tokens === 'number' && Number.isFinite(step.input_tokens);
}

export function hitRate(input, cache) {
  const total = input + cache;
  return total > 0 ? cache / total : null;
}

/**
 * Weighted rate: total streamed response tokens over total streaming time
 * (never an unweighted mean of per-step rates). Returns `null` below
 * `MIN_RATE_STREAM_MS` so ultra-short bursts never report noisy speeds.
 *
 * @param {number} output
 * @param {number} genMs
 * @returns {number | null}
 */
export function rateOf(output, genMs) {
  if (!(output > 0) || !(genMs >= MIN_RATE_STREAM_MS)) return null;
  return output / (genMs / 1000);
}

/**
 * Determines the streamed response token count for a timing record.
 *
 * Proto3 omits zero-valued fields in both binary and JSON representations. When
 * the timing source reports a thinking/response split (`hasSplit === true`) and
 * `response` is absent, the call emitted 0 visible response tokens (e.g.
 * thinking + tool call only) and must NOT fall back to `totalOutput` (which
 * includes thinking tokens).
 *
 * @param {{ response: number | null, hasSplit?: boolean }} timing
 * @param {number} totalOutput
 * @returns {number}
 */
export function effectiveStreamedOutput(timing, totalOutput) {
  if (typeof timing.response === 'number') return timing.response;
  if (timing.hasSplit) return 0;
  return totalOutput;
}

/**
 * Splits a sorted transcript into turns. A turn starts at each `USER_INPUT`
 * step; steps before the first `USER_INPUT` form an implicit turn 0 so nothing
 * from older logs is silently dropped.
 *
 * @param {Array<Record<string, unknown>>} steps
 */
export function buildTurns(steps) {
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

function matchTiming(timings, stepIndex, atMs, consumedByStep, cursorBySecond) {
  if (!timings) return undefined;

  if (
    timings.byStepIndex instanceof Map &&
    typeof stepIndex === 'number' &&
    timings.byStepIndex.has(stepIndex) &&
    !consumedByStep.has(stepIndex)
  ) {
    consumedByStep.add(stepIndex);
    return timings.byStepIndex.get(stepIndex);
  }

  if (atMs !== null && timings.bySecond instanceof Map) {
    const sec = Math.floor(atMs / 1000);
    const queue = timings.bySecond.get(sec);
    if (Array.isArray(queue)) {
      const idx = cursorBySecond.get(sec) ?? 0;
      if (idx < queue.length) {
        cursorBySecond.set(sec, idx + 1);
        return queue[idx];
      }
    }
  }

  return undefined;
}

/**
 * Aggregates raw turns into L2 turn summaries and L3 model call rows.
 * Implicit leading turns that contain no planner calls are excluded so turn
 * totals, `#n` labels, and rendered rows stay consistent.
 *
 * @param {ReturnType<typeof buildTurns>} turns
 * @param {{ byStepIndex?: Map<number, object>, bySecond?: Map<number, object[]> } | null} timings
 */
export function aggregateTurns(turns, timings) {
  const visibleTurns = turns.filter((t) => !(t.implicit && !t.steps.some(isPlanner)));
  const consumedByStep = new Set();
  const cursorBySecond = new Map();
  let prevPlannerEnd = null;

  return visibleTurns.map((t, visibleIdx) => {
    const planner = t.steps.filter(isPlanner);
    const metered = planner.filter(hasTokens);
    const input = metered.reduce((a, d) => a + (d.input_tokens || 0), 0);
    const cache = metered.reduce((a, d) => a + (d.cache_read_tokens || 0), 0);
    const output = metered.reduce((a, d) => a + (d.output_tokens || 0), 0);

    const start = ms(t.userInput?.created_at) ?? ms(t.steps[0]?.created_at);
    const end =
      ms(planner[planner.length - 1]?.created_at) ??
      ms(t.steps[t.steps.length - 1]?.created_at);
    const durationMs = start !== null && end !== null && end >= start ? end - start : null;
    const gapBeforeMs =
      prevPlannerEnd !== null && start !== null ? Math.max(0, start - prevPlannerEnd) : null;
    if (end !== null) prevPlannerEnd = end;

    const stepRows = [];
    let prevStepEnd = null;
    let turnStreamMs = 0;
    let turnStreamedOutput = 0;
    let turnThinking = 0;

    for (const d of t.steps) {
      if (!isPlanner(d)) continue;
      const isMetered = hasTokens(d);
      const c = isMetered ? d.cache_read_tokens || 0 : null;
      const i = isMetered ? d.input_tokens || 0 : null;
      const o = isMetered ? d.output_tokens || 0 : null;
      const at = ms(d.created_at);
      const timing = matchTiming(timings, d.step_index, at, consumedByStep, cursorBySecond);

      const streamedOutput =
        timing && isMetered ? effectiveStreamedOutput(timing, o) : null;
      const hasTimedOutput = Boolean(
        timing && isMetered && timing.streamMs > 0 && streamedOutput > 0,
      );

      if (hasTimedOutput) {
        turnStreamMs += timing.streamMs;
        turnStreamedOutput += streamedOutput;
      }
      if (timing && typeof timing.thinking === 'number' && timing.thinking > 0) {
        turnThinking += timing.thinking;
      }

      stepRows.push({
        // 1-based position inside the turn: what the pane labels "#n".
        index: stepRows.length + 1,
        stepIndex: d.step_index ?? null,
        model: typeof d.model === 'string' && d.model ? d.model : null,
        metered: isMetered,
        input: i,
        cache: c,
        output: o,
        prompt: isMetered ? i + c : null,
        hitRate: isMetered ? hitRate(i, c) : null,
        at,
        gapMs: at !== null && prevStepEnd !== null ? Math.max(0, at - prevStepEnd) : null,
        streamMs: timing ? timing.streamMs : null,
        ttftMs: timing ? timing.ttftMs : null,
        timingSource: timing ? timing.source : null,
        response: timing ? timing.response : null,
        thinking: timing ? timing.thinking : null,
        streamedOutput,
        rate: hasTimedOutput ? rateOf(streamedOutput, timing.streamMs) : null,
      });

      if (at !== null) prevStepEnd = at;
    }

    // The first step of a turn carries the turn's own wait since the previous turn.
    if (stepRows.length) stepRows[0].gapMs = gapBeforeMs;

    const turnTps = rateOf(turnStreamedOutput, turnStreamMs);

    return {
      index: visibleIdx,
      implicit: t.implicit,
      userInputAt: ms(t.userInput?.created_at),
      start,
      end,
      durationMs,
      streamMs: turnStreamMs > 0 ? turnStreamMs : null,
      streamedOutput: turnStreamedOutput,
      tps: turnTps,
      thinking: turnThinking,
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

/**
 * Rolls up L2 turns into the L1 conversation summary.
 *
 * @param {ReturnType<typeof aggregateTurns>} turns
 */
export function summarizeConversation(turns) {
  const input = turns.reduce((a, t) => a + t.input, 0);
  const cache = turns.reduce((a, t) => a + t.cache, 0);
  const output = turns.reduce((a, t) => a + t.output, 0);
  const plannerTurns = turns.filter((t) => t.stepCount > 0);
  const meteredSteps = turns.reduce((a, t) => a + t.meteredSteps, 0);
  const first = plannerTurns.find((t) => t.start !== null);
  const last = [...plannerTurns].reverse().find((t) => t.end !== null);
  const spanMs = first && last && last.end >= first.start ? last.end - first.start : null;

  let streamMs = 0;
  let streamedOutput = 0;
  let timedSteps = 0;
  let thinking = 0;
  let timingSource = null;

  for (const t of turns) {
    for (const s of t.steps) {
      if (typeof s.thinking === 'number' && s.thinking > 0) thinking += s.thinking;
      if (s.metered && s.streamMs > 0 && s.streamedOutput > 0) {
        streamMs += s.streamMs;
        streamedOutput += s.streamedOutput;
        timedSteps += 1;
        if (!timingSource && s.timingSource) timingSource = s.timingSource;
      }
    }
  }

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
    total: input + cache + output,
    hitRate: meteredSteps > 0 ? hitRate(input, cache) : null,
    spanMs,
    streamMs: streamMs > 0 ? streamMs : null,
    tps: conversationTps,
    timedSteps,
    thinking,
    response: streamedOutput,
    timingSource,
  };
}

/**
 * Builds the final `/api/usage` response payload from already-loaded inputs.
 *
 * @param {{
 *   conv: string,
 *   build: string,
 *   steps: Array<Record<string, unknown>>,
 *   timings: { byStepIndex?: Map<number, object>, bySecond?: Map<number, object[]> } | null,
 *   meta: { maxContextTokens: number, maxContextTokensSeen?: number[], estimatedTokensUsed?: number | null, source?: string } | null,
 * }} params
 */
export function buildSnapshot({ conv, build, steps, timings, meta }) {
  const turns = aggregateTurns(buildTurns(steps), timings);
  const summary = summarizeConversation(turns);

  let lastMeteredStep = null;
  let lastModel = null;
  for (let ti = turns.length - 1; ti >= 0; ti -= 1) {
    const turnSteps = turns[ti].steps;
    for (let si = turnSteps.length - 1; si >= 0; si -= 1) {
      const s = turnSteps[si];
      if (!lastModel && s.model) lastModel = s.model;
      if (!lastMeteredStep && s.metered) lastMeteredStep = s;
      if (lastModel && lastMeteredStep) break;
    }
    if (lastModel && lastMeteredStep) break;
  }

  const contextUsed = lastMeteredStep
    ? lastMeteredStep.prompt
    : (meta?.estimatedTokensUsed ?? null);
  const contextMax = meta?.maxContextTokens ?? FALLBACK_CONTEXT_WINDOW;

  return {
    conversationId: conv,
    build,
    model: lastMeteredStep?.model || lastModel || null,
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
