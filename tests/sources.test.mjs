import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  appDataFor,
  extractGeneratorTimings,
  findAppDataDirs,
  loadDbData,
  loadMetricsData,
  normalizeLsOrigin,
  parseDuration,
  parseOptionalInt,
  parseTranscriptText,
} from '../sidecars/usage_hud/lib/sources.mjs';

function encodeVarint(val) {
  let n = BigInt.asUintN(64, BigInt(val));
  const bytes = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    bytes.push(b);
  } while (n > 0n);
  return Buffer.from(bytes);
}

function encodeTag(field, wire) {
  return encodeVarint((BigInt(field) << 3n) | BigInt(wire));
}

function encodeVarintField(field, value) {
  return Buffer.concat([encodeTag(field, 0), encodeVarint(value)]);
}

function encodeBytesField(field, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([encodeTag(field, 2), encodeVarint(buf.length), buf]);
}

describe('sources utilities', () => {
  it('parses Go-style duration strings', () => {
    assert.equal(parseDuration('0.5s'), 500);
    assert.equal(parseDuration('1m2.5s'), 62_500);
    assert.equal(parseDuration('350ms'), 350);
    assert.equal(parseDuration('500us'), 0.5);
    assert.equal(parseDuration('500µs'), 0.5);
    assert.equal(parseDuration('2000000ns'), 2);
    assert.equal(parseDuration('0s'), null);
    assert.equal(parseDuration(''), null);
    assert.equal(parseDuration(null), null);
  });

  it('parses optional ints strictly without turning null/empty string into 0', () => {
    assert.equal(parseOptionalInt(0), 0);
    assert.equal(parseOptionalInt('42'), 42);
    assert.equal(parseOptionalInt(null), null);
    assert.equal(parseOptionalInt(undefined), null);
    assert.equal(parseOptionalInt(''), null);
    assert.equal(parseOptionalInt(true), null);
    assert.equal(parseOptionalInt('NaN'), null);
  });

  it('normalizes LS origin with or without scheme', () => {
    assert.equal(normalizeLsOrigin('localhost:5387'), 'http://localhost:5387');
    assert.equal(normalizeLsOrigin('http://127.0.0.1:5387/'), 'http://127.0.0.1:5387');
    assert.equal(normalizeLsOrigin('https://127.0.0.1:5387///'), 'https://127.0.0.1:5387');
  });

  it('parses transcript JSONL, sorts by step_index, and ignores partial trailing line', () => {
    const text = [
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE' }),
      '',
      JSON.stringify({ step_index: 0, type: 'USER_INPUT' }),
      '{"step_index": 3, "type": "PLANNER_',
    ].join('\n');
    const steps = parseTranscriptText(text);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].step_index, 0);
    assert.equal(steps[1].step_index, 2);
  });

  it('extracts generator timings with stepIndex and same-second queues', () => {
    const body = {
      trajectory: {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            metadata: {
              createdAt: '2026-11-24T10:00:10.100Z',
              sourceTrajectoryStepInfo: { stepIndex: 1 },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            metadata: {
              createdAt: '2026-11-24T10:00:10.700Z',
              sourceTrajectoryStepInfo: { stepIndex: 2 },
            },
          },
        ],
        generatorMetadata: [
          {
            stepIndices: [1],
            chatModel: {
              streamingDuration: '0.5s',
              timeToFirstToken: '0.2s',
              usage: { thinkingOutputTokens: 400 }, // responseOutputTokens omitted (0)
            },
          },
          {
            stepIndices: [2],
            chatModel: {
              streamingDuration: '1.0s',
              timeToFirstToken: '0.1s',
              usage: { responseOutputTokens: 250, thinkingOutputTokens: 50 },
            },
          },
        ],
      },
    };

    const timings = extractGeneratorTimings(body);
    assert.ok(timings);
    assert.equal(timings.byStepIndex.get(1).response, null);
    assert.equal(timings.byStepIndex.get(1).thinking, 400);
    assert.equal(timings.byStepIndex.get(1).hasSplit, true);
    assert.equal(timings.byStepIndex.get(2).response, 250);

    const sec = Math.floor(Date.parse('2026-11-24T10:00:10Z') / 1000);
    assert.equal(timings.bySecond.get(sec).length, 2);
  });
});

describe('filesystem discovery and SQLite integration', () => {
  it('discovers appData via env or ~/.gemini fallback and detects DB-only conversations', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-hud-test-'));
    try {
      const appData = join(tmp, '.gemini', 'antigravity');
      const sidecarData = join(appData, 'Sidecar_Data', 'agy-usage-hud');
      mkdirSync(join(appData, 'brain'), { recursive: true });
      mkdirSync(join(appData, 'conversations'), { recursive: true });
      mkdirSync(sidecarData, { recursive: true });

      const fromEnv = findAppDataDirs({
        env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: sidecarData },
        home: tmp,
      });
      assert.deepEqual(fromEnv, [appData]);

      // Non-standard env path falls back to scanning ~/.gemini/*
      const fromFallback = findAppDataDirs({
        env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: join(tmp, 'custom_dir') },
        home: tmp,
      });
      assert.deepEqual(fromFallback, [appData]);

      // Conversation with only .db (no brain/<conv> yet) is still recognized
      const convId = '12345678-aaaa-bbbb-cccc-1234567890ab';
      writeFileSync(join(appData, 'conversations', convId + '.db'), '');
      assert.equal(appDataFor(convId, { dirs: [appData] }), appData);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads gen_metadata and fallback steps timings from a single SQLite DB', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const tmp = mkdtempSync(join(tmpdir(), 'agy-hud-db-'));
    try {
      const conv = 'abcdef12-3456-7890-abcd-ef1234567890';
      mkdirSync(join(tmp, 'conversations'), { recursive: true });
      const dbPath = join(tmp, 'conversations', conv + '.db');

      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)');
      db.exec('CREATE TABLE steps (idx INTEGER, step_type INTEGER, metadata BLOB)');

      const genBlob = encodeBytesField(
        1,
        encodeBytesField(
          9,
          encodeBytesField(10, Buffer.concat([encodeVarintField(1, 32_000), encodeVarintField(4, 1_048_576)])),
        ),
      );
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, genBlob);

      const stepBlob = Buffer.concat([
        encodeBytesField(1, Buffer.concat([encodeVarintField(1, 1_795_441_600), encodeVarintField(2, 0)])),
        encodeBytesField(6, Buffer.concat([encodeVarintField(1, 1_795_441_601), encodeVarintField(2, 500_000_000)])),
        encodeBytesField(7, Buffer.concat([encodeVarintField(1, 1_795_441_603), encodeVarintField(2, 500_000_000)])),
        encodeBytesField(9, Buffer.concat([encodeVarintField(9, 100), encodeVarintField(10, 300)])),
      ]);
      db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(1, 15, stepBlob);

      // Step 2: lacks /7 (completedAt) -> TTFT only, must NOT populate streamMs or hasCompletion
      const ttftOnlyBlob = Buffer.concat([
        encodeBytesField(1, Buffer.concat([encodeVarintField(1, 1_795_441_610), encodeVarintField(2, 0)])),
        encodeBytesField(6, Buffer.concat([encodeVarintField(1, 1_795_441_612), encodeVarintField(2, 0)])),
        encodeBytesField(9, Buffer.concat([encodeVarintField(9, 50), encodeVarintField(10, 200)])),
      ]);
      db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(2, 15, ttftOnlyBlob);

      // Step 3: /7 equals /6 (0ms streaming) -> hasCompletion is true, streamMs stays null
      const zeroStreamBlob = Buffer.concat([
        encodeBytesField(1, Buffer.concat([encodeVarintField(1, 1_795_441_620), encodeVarintField(2, 0)])),
        encodeBytesField(6, Buffer.concat([encodeVarintField(1, 1_795_441_621), encodeVarintField(2, 0)])),
        encodeBytesField(7, Buffer.concat([encodeVarintField(1, 1_795_441_621), encodeVarintField(2, 0)])),
        encodeBytesField(9, Buffer.concat([encodeVarintField(9, 80)])),
      ]);
      db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(3, 15, zeroStreamBlob);
      db.close();

      const { meta, stepTimings } = await loadDbData(tmp, conv, { includeStepTimings: true });
      assert.equal(meta.maxContextTokens, 1_048_576);
      assert.equal(meta.estimatedTokensUsed, 32_000);
      assert.equal(meta.lastRowHasMax, true);
      assert.equal(meta.validRows, 1);
      assert.ok(stepTimings);
      assert.equal(stepTimings.byStepIndex.get(1).ttftMs, 1500);
      assert.equal(stepTimings.byStepIndex.get(1).streamMs, 2000);
      assert.equal(stepTimings.byStepIndex.get(1).hasCompletion, true);
      assert.equal(stepTimings.byStepIndex.get(1).response, 300);
      assert.equal(stepTimings.byStepIndex.get(1).thinking, 100);

      assert.equal(stepTimings.byStepIndex.get(2).ttftMs, 2000);
      assert.equal(stepTimings.byStepIndex.get(2).streamMs, null);
      assert.equal(stepTimings.byStepIndex.get(2).hasCompletion, false);

      assert.equal(stepTimings.byStepIndex.get(3).ttftMs, 1000);
      assert.equal(stepTimings.byStepIndex.get(3).streamMs, null);
      assert.equal(stepTimings.byStepIndex.get(3).hasCompletion, true);

      // Without LS env, loadMetricsData returns both meta and steps timings cleanly
      const metrics = await loadMetricsData(tmp, conv, { env: {} });
      assert.equal(metrics.meta.maxContextTokens, 1_048_576);
      assert.equal(metrics.timings.source, 'steps');
      assert.equal(metrics.fallbackTimings, null);

      // Partial LS coverage (1 timing < expectedSteps 2) also loads SQLite fallbackTimings
      const partialLsFetch = async () => ({
        ok: true,
        json: async () => ({
          trajectory: {
            steps: [
              {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                metadata: {
                  createdAt: '2026-11-24T10:00:10Z',
                  sourceTrajectoryStepInfo: { stepIndex: 1 },
                },
              },
            ],
            generatorMetadata: [
              {
                stepIndices: [1],
                chatModel: {
                  streamingDuration: '0.5s',
                  timeToFirstToken: '0.1s',
                  usage: { responseOutputTokens: 100 },
                },
              },
            ],
          },
        }),
      });
      const partialMetrics = await loadMetricsData(tmp, conv, {
        env: { ANTIGRAVITY_LS_ADDRESS: 'localhost:5387', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
        fetchImpl: partialLsFetch,
        needsFallback: () => true,
      });
      assert.equal(partialMetrics.timings.source, 'generator');
      assert.equal(partialMetrics.fallbackTimings.source, 'steps');

      // When needsFallback returns false (all steps matched LS), SQLite steps is skipped
      const completeMetrics = await loadMetricsData(tmp, conv, {
        env: { ANTIGRAVITY_LS_ADDRESS: 'localhost:5387', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
        fetchImpl: partialLsFetch,
        needsFallback: () => false,
      });
      assert.equal(completeMetrics.timings.source, 'generator');
      assert.equal(completeMetrics.fallbackTimings, null);

      // Adding a checkpoint step (step_type = 23) with /8 completion timestamp
      // provides checkpointTimings even when LS covers all planner steps.
      const dbCp = new DatabaseSync(dbPath);
      const checkpointBlob = Buffer.concat([
        encodeBytesField(1, Buffer.concat([encodeVarintField(1, 1_795_441_630), encodeVarintField(2, 200_000_000)])),
        encodeBytesField(8, Buffer.concat([encodeVarintField(1, 1_795_441_670), encodeVarintField(2, 700_000_000)])),
        encodeBytesField(9, Buffer.concat([encodeVarintField(9, 60), encodeVarintField(10, 3400)])),
      ]);
      dbCp.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(4, 23, checkpointBlob);
      dbCp.close();

      const { checkpointTimings } = await loadDbData(tmp, conv, { includeStepTimings: false });
      assert.ok(checkpointTimings);
      assert.equal(checkpointTimings.byStepIndex.get(4).durationMs, 40_500);
      assert.equal(checkpointTimings.byStepIndex.get(4).streamMs, null);
      assert.equal(checkpointTimings.byStepIndex.get(4).ttftMs, null);
      assert.equal(checkpointTimings.byStepIndex.get(4).hasCompletion, true);
      assert.equal(checkpointTimings.byStepIndex.get(4).stepKind, 'compact');
      assert.equal(checkpointTimings.byStepIndex.get(4).thinking, 60);
      assert.equal(checkpointTimings.byStepIndex.get(4).response, 3400);

      const completeWithCp = await loadMetricsData(tmp, conv, {
        env: { ANTIGRAVITY_LS_ADDRESS: 'localhost:5387', ANTIGRAVITY_CSRF_TOKEN: 'tok' },
        fetchImpl: partialLsFetch,
        needsFallback: () => false,
      });
      assert.equal(completeWithCp.timings.source, 'generator');
      assert.equal(completeWithCp.fallbackTimings.byStepIndex.get(4).durationMs, 40_500);

      // Adding a final gen_metadata row without max_context_tokens flips lastRowHasMax to false
      const db2 = new DatabaseSync(dbPath);
      db2.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, Buffer.from([]));
      db2.close();
      const { meta: meta2 } = await loadDbData(tmp, conv, { includeStepTimings: false });
      assert.equal(meta2.rows, 2);
      assert.equal(meta2.validRows, 1);
      assert.equal(meta2.lastRowHasMax, false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
