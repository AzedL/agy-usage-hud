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
    assert.equal(snap.model, 'gemini-4-neon');
  });
});
