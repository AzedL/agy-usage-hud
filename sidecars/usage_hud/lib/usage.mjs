/**
 * Pure usage aggregation and snapshot assembly for Usage HUD.
 *
 * Separates domain calculations (turn grouping, per-call primary/fallback
 * timing joins, completion-based wait intervals, source-isolated streaming
 * throughput, context fullness & alignment) from filesystem/SQLite/RPC I/O so
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

function allocateFromSource(plannerSteps, source, assigned) {
  if (!source) return;
  const consumed = new Set();

  // Pass 1: exact step_index matches.
  if (source.byStepIndex instanceof Map) {
    for (const d of plannerSteps) {
      if (assigned.has(d) || typeof d.step_index !== 'number') continue;
      const entry = source.byStepIndex.get(d.step_index);
      if (entry && !consumed.has(entry)) {
        assigned.set(d, entry);
        consumed.add(entry);
      }
    }
  }

  // Pass 2: truncated-second queue fallback for remaining unmatched steps.
  if (source.bySecond instanceof Map) {
    for (const d of plannerSteps) {
      if (assigned.has(d)) continue;
      const at = ms(d.created_at);
      if (at === null) continue;
      const queue = source.bySecond.get(Math.floor(at / 1000));
      if (!Array.isArray(queue)) continue;
      const entry = queue.find((candidate) => candidate && !consumed.has(candidate));
      if (entry) {
        assigned.set(d, entry);
        consumed.add(entry);
      }
    }
  }
}

/**
 * Allocates timing entries to planner steps across primary (Language Server)
 * and optional per-call fallback (SQLite `steps`) sources. Within each source,
 * exact `byStepIndex` matches run before `bySecond` fallback using a single
 * shared `consumed` Set so no timing record can ever be consumed twice.
 *
 * @param {Array<{ steps: Array<Record<string, unknown>> }>} visibleTurns
 * @param {{ byStepIndex?: Map<number, object>, bySecond?: Map<number, object[]> } | null} timings
 * @param {{ byStepIndex?: Map<number, object>, bySecond?: Map<number, object[]> } | null} [fallbackTimings]
 * @returns {Map<object, object>}
 */
export function assignTimings(visibleTurns, timings, fallbackTimings = null) {
  const assigned = new Map();
  if (!timings && !fallbackTimings) return assigned;

  const plannerSteps = [];
  for (const t of visibleTurns) {
    for (const d of t.steps) {
      if (isPlanner(d)) plannerSteps.push(d);
    }
  }

  allocateFromSource(plannerSteps, timings, assigned);
  allocateFromSource(plannerSteps, fallbackTimings, assigned);
  return assigned;
}

/**
 * Estimates a planner call's completion timestamp.
 * When timing is available:
 *  - LS (`generator`): `created_at + ttftMs + streamMs`
 *  - SQLite (`steps`): `created_at + streamMs` (equals `viewableAt`)
 * Without timing, falls back to `created_at`.
 */
function estimateStepEnd(at, timing) {
  if (at === null) return null;
  if (!timing) return { endAt: at, basis: 'created_at' };
  const elapsed = (timing.ttftMs ?? 0) + (timing.streamMs ?? 0);
  return { endAt: at + Math.max(0, elapsed), basis: 'completion' };
}

/**
 * Aggregates raw turns into L2 turn summaries and L3 model call rows.
 * Implicit leading turns that contain no planner calls are excluded so turn
 * totals, `#n` labels, and rendered rows stay consistent.
 *
 * Weighted turn TPS never mixes true streaming timings (`generator`) with
 * coarse SQLite timings (`steps`): whenever any `generator` step has streamed
 * output, turn TPS is computed exclusively from `generator` steps.
 *
 * @param {ReturnType<typeof buildTurns>} turns
 * @param {{ byStepIndex?: Map<number, object>, bySecond?: Map<number, object[]> } | null} timings
 * @param {{ byStepIndex?: Map<number, object>, bySecond?: Map<number, object[]> } | null} [fallbackTimings]
 */
export function aggregateTurns(turns, timings, fallbackTimings = null) {
  const visibleTurns = turns.filter((t) => !(t.implicit && !t.steps.some(isPlanner)));
  const timingByStep = assignTimings(visibleTurns, timings, fallbackTimings);

  let prevTurnEnd = null;
  let prevTurnEndBasis = null;

  return visibleTurns.map((t, visibleIdx) => {
    const planner = t.steps.filter(isPlanner);
    const metered = planner.filter(hasTokens);
    const input = metered.reduce((a, d) => a + (d.input_tokens || 0), 0);
    const cache = metered.reduce((a, d) => a + (d.cache_read_tokens || 0), 0);
    const output = metered.reduce((a, d) => a + (d.output_tokens || 0), 0);

    const start = ms(t.userInput?.created_at) ?? ms(t.steps[0]?.created_at);
    const gapBeforeMs =
      prevTurnEnd !== null && start !== null ? Math.max(0, start - prevTurnEnd) : null;
    const gapBeforeBasis = gapBeforeMs !== null ? prevTurnEndBasis : null;

    const stepRows = [];
    let prevStepEnd = null;
    let prevStepBasis = null;
    let lastPlannerEnd = null;
    let lastPlannerBasis = null;
    let genStreamMs = 0;
    let genStreamedOutput = 0;
    let stepsStreamMs = 0;
    let stepsStreamedOutput = 0;
    let turnThinking = 0;

    for (const d of t.steps) {
      if (!isPlanner(d)) continue;
      const isMetered = hasTokens(d);
      const c = isMetered ? d.cache_read_tokens || 0 : null;
      const i = isMetered ? d.input_tokens || 0 : null;
      const o = isMetered ? d.output_tokens || 0 : null;
      const at = ms(d.created_at);
      const timing = timingByStep.get(d);
      const completed = estimateStepEnd(at, timing);

      const streamedOutput =
        timing && isMetered ? effectiveStreamedOutput(timing, o) : null;
      const hasTimedOutput = Boolean(
        timing && isMetered && timing.streamMs > 0 && streamedOutput > 0,
      );

      if (hasTimedOutput) {
        if (timing.source === 'generator') {
          genStreamMs += timing.streamMs;
          genStreamedOutput += streamedOutput;
        } else {
          stepsStreamMs += timing.streamMs;
          stepsStreamedOutput += streamedOutput;
        }
      }
      if (timing && typeof timing.thinking === 'number' && timing.thinking > 0) {
        turnThinking += timing.thinking;
      }

      const gapMs =
        at !== null && prevStepEnd !== null ? Math.max(0, at - prevStepEnd) : null;

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
        endAt: completed ? completed.endAt : null,
        gapMs,
        gapBasis: gapMs !== null ? prevStepBasis : null,
        streamMs: timing ? timing.streamMs : null,
        ttftMs: timing ? timing.ttftMs : null,
        timingSource: timing ? timing.source : null,
        response: timing ? timing.response : null,
        thinking: timing ? timing.thinking : null,
        streamedOutput,
        rate: hasTimedOutput ? rateOf(streamedOutput, timing.streamMs) : null,
      });

      if (completed) {
        prevStepEnd = completed.endAt;
        prevStepBasis = completed.basis;
        lastPlannerEnd = completed.endAt;
        lastPlannerBasis = completed.basis;
      }
    }

    // The first step of a turn carries the turn's own wait since the previous turn.
    if (stepRows.length) {
      stepRows[0].gapMs = gapBeforeMs;
      stepRows[0].gapBasis = gapBeforeBasis;
    }

    const fallbackEnd = ms(t.steps[t.steps.length - 1]?.created_at);
    const end = lastPlannerEnd ?? fallbackEnd;
    const endBasis =
      lastPlannerEnd !== null ? lastPlannerBasis : fallbackEnd !== null ? 'created_at' : null;
    const durationMs = start !== null && end !== null && end >= start ? end - start : null;
    if (end !== null) {
      prevTurnEnd = end;
      prevTurnEndBasis = endBasis;
    }

    const useGenTps = genStreamMs > 0;
    const turnStreamMs = useGenTps ? genStreamMs : stepsStreamMs;
    const turnStreamedOutput = useGenTps ? genStreamedOutput : stepsStreamedOutput;
    const turnTps = rateOf(turnStreamedOutput, turnStreamMs);
    const tpsSource = turnTps !== null ? (useGenTps ? 'generator' : 'steps') : null;

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
      tpsSource,
      thinking: turnThinking,
      gapBeforeMs,
      gapBeforeBasis,
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
 * Keeps `generator` (true streaming) and `steps` (TTFT + streaming) separate
 * when computing conversation-level TPS.
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

  let genStreamMs = 0;
  let genStreamedOutput = 0;
  let genTimedSteps = 0;
  let stepsStreamMs = 0;
  let stepsStreamedOutput = 0;
  let stepsTimedSteps = 0;
  let matchedSteps = 0;
  let generatorMatchedSteps = 0;
  let stepsMatchedSteps = 0;
  let thinking = 0;

  for (const t of turns) {
    for (const s of t.steps) {
      if (typeof s.thinking === 'number' && s.thinking > 0) thinking += s.thinking;
      if (s.metered && s.timingSource) {
        matchedSteps += 1;
        if (s.timingSource === 'generator') generatorMatchedSteps += 1;
        else if (s.timingSource === 'steps') stepsMatchedSteps += 1;
      }
      if (s.metered && s.streamMs > 0 && s.streamedOutput > 0) {
        if (s.timingSource === 'generator') {
          genStreamMs += s.streamMs;
          genStreamedOutput += s.streamedOutput;
          genTimedSteps += 1;
        } else if (s.timingSource === 'steps') {
          stepsStreamMs += s.streamMs;
          stepsStreamedOutput += s.streamedOutput;
          stepsTimedSteps += 1;
        }
      }
    }
  }

  const useGenTps = genStreamMs > 0;
  const streamMs = useGenTps ? genStreamMs : stepsStreamMs;
  const streamedOutput = useGenTps ? genStreamedOutput : stepsStreamedOutput;
  const timedSteps = useGenTps ? genTimedSteps : stepsTimedSteps;
  const conversationTps = rateOf(streamedOutput, streamMs);
  const tpsSource = conversationTps !== null ? (useGenTps ? 'generator' : 'steps') : null;

  let timingSource = null;
  if (generatorMatchedSteps > 0 && stepsMatchedSteps > 0) timingSource = 'mixed';
  else if (generatorMatchedSteps > 0) timingSource = 'generator';
  else if (stepsMatchedSteps > 0) timingSource = 'steps';

  return {
    turns: turns.length,
    steps: turns.reduce((a, t) => a + t.stepCount, 0),
    meteredSteps,
    matchedSteps,
    generatorMatchedSteps,
    stepsMatchedSteps,
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
    tpsSource,
    timedSteps,
    thinking,
    response: streamedOutput,
    timingSource,
  };
}

/**
 * Evaluates whether the context window denominator from `gen_metadata` can be
 * treated as aligned with the latest model call.
 */
function assessContextAlignment(meta, summary, distinctModels) {
  if (!meta) return { aligned: false, reason: 'fallback' };
  if (meta.lastRowHasMax === false) {
    return { aligned: false, reason: 'latest-row-missing-window' };
  }
  const metaRows = typeof meta.rows === 'number' ? meta.rows : null;
  const multipleModels = distinctModels.size > 1;
  const multipleWindows =
    Array.isArray(meta.maxContextTokensSeen) && meta.maxContextTokensSeen.length > 1;

  if (metaRows !== null && metaRows < summary.steps && (multipleModels || multipleWindows)) {
    return { aligned: false, reason: 'metadata-lag' };
  }
  return { aligned: true, reason: 'matched' };
}

/**
 * Builds the final `/api/usage` response payload from already-loaded inputs.
 *
 * @param {{
 *   conv: string,
 *   build: string,
 *   steps: Array<Record<string, unknown>>,
 *   timings: { byStepIndex?: Map<number, object>, bySecond?: Map<number, object[]> } | null,
 *   fallbackTimings?: { byStepIndex?: Map<number, object>, bySecond?: Map<number, object[]> } | null,
 *   meta: { maxContextTokens: number, maxContextTokensSeen?: number[], estimatedTokensUsed?: number | null, rows?: number, validRows?: number, lastRowHasMax?: boolean, source?: string } | null,
 * }} params
 */
export function buildSnapshot({ conv, build, steps, timings, fallbackTimings = null, meta }) {
  const turns = aggregateTurns(buildTurns(steps), timings, fallbackTimings);
  const summary = summarizeConversation(turns);

  let lastMeteredStep = null;
  let lastModel = null;
  const distinctModels = new Set();

  for (let ti = turns.length - 1; ti >= 0; ti -= 1) {
    const turnSteps = turns[ti].steps;
    for (let si = turnSteps.length - 1; si >= 0; si -= 1) {
      const s = turnSteps[si];
      if (s.model) {
        distinctModels.add(s.model);
        if (!lastModel) lastModel = s.model;
      }
      if (!lastMeteredStep && s.metered) lastMeteredStep = s;
    }
  }

  const contextUsed = lastMeteredStep
    ? lastMeteredStep.prompt
    : (meta?.estimatedTokensUsed ?? null);
  const contextMax = meta?.maxContextTokens ?? FALLBACK_CONTEXT_WINDOW;
  const alignment = assessContextAlignment(meta, summary, distinctModels);

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
      contextWindowAligned: alignment.aligned,
    },
    context: {
      maxContextTokens: contextMax,
      maxContextTokensSeen: meta?.maxContextTokensSeen ?? null,
      metaRows: meta?.rows ?? null,
      validRows: meta?.validRows ?? null,
      lastRowHasMax: meta?.lastRowHasMax ?? null,
      aligned: alignment.aligned,
      alignmentReason: alignment.reason,
      source: meta?.source ?? null,
    },
    turns,
  };
}
