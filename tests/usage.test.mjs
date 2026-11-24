import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregateTurns,
  buildSnapshot,
  buildTurns,
  effectiveStreamedOutput,
  FALLBACK_CONTEXT_WINDOW,
  MIN_RATE_STREAM_MS,
} from '../sidecars/usage_hud/lib/usage.mjs';

describe('effectiveStreamedOutput (proto3 omitted-zero split handling)', () => {
  it('returns 0 when source splits thinking/response and response is omitted (0)', () => {
    const timing = { response: null, thinking: 600, hasSplit: true };
    assert.equal(effectiveStreamedOutput(timing, 600), 0);
  });

  it('uses explicit response tokens when present', () => {
    const timing = { response: 120, thinking: 480, hasSplit: true };
    assert.equal(effectiveStreamedOutput(timing, 600), 120);
  });

  it('falls back to total output when source does not expose split fields', () => {
    const timing = { response: null, thinking: null, hasSplit: false };
    assert.equal(effectiveStreamedOutput(timing, 250), 250);
  });
});

describe('turn grouping and aggregation', () => {
  it('excludes implicit leading turns that contain no planner responses', () => {
    const steps = [
      { step_index: 0, type: 'SYSTEM_EVENT', created_at: '2026-11-24T10:00:00Z' },
      { step_index: 1, type: 'USER_INPUT', created_at: '2026-11-24T10:00:01Z' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T10:00:05Z',
        model: 'gemini-4-neon',
        input_tokens: 1000,
        cache_read_tokens: 9000,
        output_tokens: 200,
      },
    ];

    const snap = buildSnapshot({ conv: 'aaaa1111', build: '1', steps, timings: null, meta: null });
    assert.equal(snap.summary.turns, 1);
    assert.equal(snap.turns.length, 1);
    assert.equal(snap.turns[0].index, 0);
    assert.equal(snap.turns[0].start, Date.parse('2026-11-24T10:00:01Z'));
    assert.equal(snap.turns[0].durationMs, 4000);
  });

  it('consumes same-second timings in FIFO order without double-counting', () => {
    const ts = '2026-11-24T10:00:10Z';
    const sec = Math.floor(Date.parse(ts) / 1000);
    const steps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T10:00:09Z' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: ts,
        model: 'flash',
        input_tokens: 100,
        cache_read_tokens: 900,
        output_tokens: 100,
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: ts,
        model: 'flash',
        input_tokens: 100,
        cache_read_tokens: 1000,
        output_tokens: 300,
      },
    ];

    const timings = {
      byStepIndex: new Map(),
      bySecond: new Map([
        [
          sec,
          [
            { streamMs: 1000, ttftMs: 100, response: 100, thinking: null, hasSplit: true, source: 'generator' },
            { streamMs: 1000, ttftMs: 100, response: 300, thinking: null, hasSplit: true, source: 'generator' },
          ],
        ],
      ]),
    };

    const turns = aggregateTurns(buildTurns(steps), timings);
    assert.equal(turns[0].steps[0].rate, 100);
    assert.equal(turns[0].steps[1].rate, 300);
    // Weighted turn rate: (100 + 300) / 2s = 200 tok/s
    assert.equal(turns[0].tps, 200);
  });

  it('enforces MIN_RATE_STREAM_MS consistently across step, turn, and conversation', () => {
    assert.equal(MIN_RATE_STREAM_MS, 200);
    const steps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T10:00:00Z' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T10:00:01Z',
        model: 'fast',
        input_tokens: 500,
        cache_read_tokens: 500,
        output_tokens: 5,
      },
    ];

    const shortTimings = {
      byStepIndex: new Map([
        [1, { streamMs: 50, ttftMs: 100, response: 5, thinking: null, hasSplit: true, source: 'generator' }],
      ]),
      bySecond: new Map(),
    };

    const snapShort = buildSnapshot({ conv: 'aaaa1111', build: '1', steps, timings: shortTimings, meta: null });
    assert.equal(snapShort.turns[0].steps[0].rate, null);
    assert.equal(snapShort.turns[0].tps, null);
    assert.equal(snapShort.summary.tps, null);

    // Five 50ms steps = 250ms total -> individual step rates hidden, turn/conversation weighted rate shown
    const manySteps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T10:00:00Z' },
      ...Array.from({ length: 5 }, (_, idx) => ({
        step_index: idx + 1,
        type: 'PLANNER_RESPONSE',
        created_at: `2026-11-24T10:00:0${idx + 1}Z`,
        model: 'fast',
        input_tokens: 100,
        cache_read_tokens: 400,
        output_tokens: 10,
      })),
    ];
    const manyTimings = {
      byStepIndex: new Map(
        Array.from({ length: 5 }, (_, idx) => [
          idx + 1,
          { streamMs: 50, ttftMs: 80, response: 10, thinking: null, hasSplit: true, source: 'generator' },
        ]),
      ),
      bySecond: new Map(),
    };

    const snapMany = buildSnapshot({ conv: 'aaaa1111', build: '1', steps: manySteps, timings: manyTimings, meta: null });
    assert.ok(snapMany.turns[0].steps.every((s) => s.rate === null));
    assert.equal(snapMany.turns[0].tps, 200); // 50 tokens / 0.25s
    assert.equal(snapMany.summary.tps, 200);
  });

  it('finds last metered step across earlier turns when latest turn is unmetered', () => {
    const steps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T10:00:00Z' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T10:00:05Z',
        model: 'gemini-4-neon',
        input_tokens: 2000,
        cache_read_tokens: 18000,
        output_tokens: 500,
      },
      { step_index: 2, type: 'USER_INPUT', created_at: '2026-11-24T10:01:00Z' },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T10:01:02Z',
        model: 'gemini-4-neon',
      },
    ];

    const snap = buildSnapshot({ conv: 'aaaa1111', build: '1', steps, timings: null, meta: null });
    assert.equal(snap.summary.contextUsed, 20_000);
    assert.equal(snap.summary.contextMax, FALLBACK_CONTEXT_WINDOW);
    assert.equal(snap.summary.contextSource, 'fallback');
    assert.equal(snap.summary.contextWindowAligned, false);
    assert.equal(snap.context.alignmentReason, 'fallback');
    assert.equal(snap.model, 'gemini-4-neon');
  });

  it('never double-consumes a timing record across byStepIndex and bySecond indices', () => {
    const ts = '2026-11-24T10:00:10Z';
    const sec = Math.floor(Date.parse(ts) / 1000);
    const timingA = {
      streamMs: 1000,
      ttftMs: 100,
      response: 200,
      thinking: 50,
      hasSplit: true,
      source: 'generator',
    };

    // Case 1: Step 10 matches byStepIndex; Step 11 in the same second must NOT reuse timingA.
    const steps1 = [
      { step_index: 9, type: 'USER_INPUT', created_at: '2026-11-24T10:00:09Z' },
      {
        step_index: 10,
        type: 'PLANNER_RESPONSE',
        created_at: ts,
        model: 'flash',
        input_tokens: 100,
        cache_read_tokens: 900,
        output_tokens: 250,
      },
      {
        step_index: 11,
        type: 'PLANNER_RESPONSE',
        created_at: ts,
        model: 'flash',
        input_tokens: 100,
        cache_read_tokens: 900,
        output_tokens: 250,
      },
    ];
    const timings1 = {
      byStepIndex: new Map([[10, timingA]]),
      bySecond: new Map([[sec, [timingA]]]),
    };

    const snap1 = buildSnapshot({ conv: 'aaaa1111', build: '1', steps: steps1, timings: timings1, meta: null });
    assert.equal(snap1.turns[0].steps[0].rate, 200);
    assert.equal(snap1.turns[0].steps[1].rate, null);
    assert.equal(snap1.turns[0].steps[1].timingSource, null);
    assert.equal(snap1.summary.generatorMatchedSteps, 1);
    assert.equal(snap1.summary.meteredSteps, 2);

    // Case 2: Earlier unmatched step (step 10) must NOT steal timingB belonging to exact match step 11.
    const timingB = {
      streamMs: 1000,
      ttftMs: 100,
      response: 300,
      thinking: 0,
      hasSplit: true,
      source: 'generator',
    };
    const timings2 = {
      byStepIndex: new Map([[11, timingB]]),
      bySecond: new Map([[sec, [timingB]]]),
    };
    const snap2 = buildSnapshot({ conv: 'aaaa1111', build: '1', steps: steps1, timings: timings2, meta: null });
    assert.equal(snap2.turns[0].steps[0].timingSource, null);
    assert.equal(snap2.turns[0].steps[1].rate, 300);
  });

  it('computes wait durations from prior call completion time when timing is available', () => {
    const steps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T10:00:00Z' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T10:00:00Z',
        model: 'gemini-4-neon',
        input_tokens: 100,
        cache_read_tokens: 900,
        output_tokens: 100,
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T10:00:10Z',
        model: 'gemini-4-neon',
        input_tokens: 100,
        cache_read_tokens: 900,
        output_tokens: 100,
      },
      { step_index: 3, type: 'USER_INPUT', created_at: '2026-11-24T10:01:20Z' },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T10:01:21Z',
        model: 'gemini-4-neon',
        input_tokens: 100,
        cache_read_tokens: 900,
        output_tokens: 100,
      },
    ];

    // Step 1: 00:00 + 2s TTFT + 3s stream -> finishes at 00:05. Step 2 starts at 00:10 -> wait = 5s (not 10s).
    // Step 2: 00:10 + 4s TTFT + 6s stream -> finishes at 00:20. Turn 2 starts at 01:20 -> wait = 60s (not 70s).
    const timings = {
      byStepIndex: new Map([
        [1, { streamMs: 3000, ttftMs: 2000, response: 100, thinking: 0, hasSplit: true, source: 'generator' }],
        [2, { streamMs: 6000, ttftMs: 4000, response: 100, thinking: 0, hasSplit: true, source: 'generator' }],
      ]),
      bySecond: new Map(),
    };

    const snap = buildSnapshot({ conv: 'aaaa1111', build: '1', steps, timings, meta: null });
    assert.equal(snap.turns[0].steps[1].gapMs, 5000);
    assert.equal(snap.turns[0].steps[1].gapBasis, 'completion');
    assert.equal(snap.turns[1].gapBeforeMs, 60_000);
    assert.equal(snap.turns[1].gapBeforeBasis, 'completion');
    assert.equal(snap.turns[1].steps[0].gapMs, 60_000);
  });

  it('flags context window as unaligned when gen_metadata lags behind after a model switch', () => {
    const steps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T10:00:00Z' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T10:00:01Z',
        model: 'model-a',
        input_tokens: 1000,
        cache_read_tokens: 9000,
        output_tokens: 100,
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T10:00:05Z',
        model: 'model-b',
        input_tokens: 1000,
        cache_read_tokens: 399_000,
        output_tokens: 100,
      },
    ];

    const laggingMeta = {
      maxContextTokens: 409_600,
      maxContextTokensSeen: [409_600],
      estimatedTokensUsed: 10_000,
      rows: 1, // lags behind summary.steps (2)
      source: 'gen_metadata',
    };

    const snapLag = buildSnapshot({ conv: 'aaaa1111', build: '1', steps, timings: null, meta: laggingMeta });
    assert.equal(snapLag.summary.contextWindowAligned, false);
    assert.equal(snapLag.context.aligned, false);
    assert.equal(snapLag.context.alignmentReason, 'metadata-lag');

    const syncedMeta = { ...laggingMeta, maxContextTokens: 1_000_000, rows: 2 };
    const snapOk = buildSnapshot({ conv: 'aaaa1111', build: '1', steps, timings: null, meta: syncedMeta });
    assert.equal(snapOk.summary.contextWindowAligned, true);
    assert.equal(snapOk.context.aligned, true);
    assert.equal(snapOk.context.alignmentReason, 'matched');
  });
});
