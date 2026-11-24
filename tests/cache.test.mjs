import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTimingComplete, SnapshotCache } from '../sidecars/usage_hud/lib/cache.mjs';

function makePayload({ meteredSteps, generatorMatchedSteps, hasUsage = true, timingSource = 'generator' }) {
  return {
    hasUsage,
    summary: {
      meteredSteps,
      generatorMatchedSteps,
      timingSource,
    },
  };
}

describe('SnapshotCache completeness and retry policy', () => {
  it('treats partial generator timing (99/100) as incomplete even when timingSource is generator', () => {
    const partial = makePayload({ meteredSteps: 100, generatorMatchedSteps: 99, timingSource: 'generator' });
    assert.equal(isTimingComplete(partial, true), false);
    assert.equal(isTimingComplete(partial, false), true);

    const complete = makePayload({ meteredSteps: 100, generatorMatchedSteps: 100, timingSource: 'generator' });
    assert.equal(isTimingComplete(complete, true), true);
  });

  it('retries partial LS snapshots with backoff, then probes at steadyRetryMs until LS catches up', () => {
    const cache = new SnapshotCache({
      maxEntries: 4,
      retryDelaysMs: [3000, 6000],
      steadyRetryMs: 300_000,
    });
    const sig = 'b1|100:50|0|0';
    const partial = makePayload({ meteredSteps: 10, generatorMatchedSteps: 9 });
    const complete = makePayload({ meteredSteps: 10, generatorMatchedSteps: 10 });

    cache.set('conv-1', sig, partial, { hasLs: true, now: 1000 });

    // Within first backoff window (3000ms) -> cache hit
    assert.equal(cache.get('conv-1', sig, { hasLs: true, now: 3500 }), partial);
    // Past first backoff window -> cache miss to re-query LS
    assert.equal(cache.get('conv-1', sig, { hasLs: true, now: 4000 }), null);

    // Still partial after first retry -> retry counter advances to 1 (6000ms window)
    cache.set('conv-1', sig, partial, { hasLs: true, now: 4000 });
    assert.equal(cache.get('conv-1', sig, { hasLs: true, now: 9500 }), partial);
    assert.equal(cache.get('conv-1', sig, { hasLs: true, now: 10000 }), null);

    // Still partial after fast backoff exhausted -> settles to steadyRetryMs (5 min), NOT locked forever
    cache.set('conv-1', sig, partial, { hasLs: true, now: 10000 });
    assert.equal(cache.get('conv-1', sig, { hasLs: true, now: 309_999 }), partial);
    assert.equal(cache.get('conv-1', sig, { hasLs: true, now: 310_000 }), null);

    // LS recovers on steady probe -> complete locks in indefinitely for the same sig
    cache.set('conv-1', sig, complete, { hasLs: true, now: 310_000 });
    assert.equal(cache.get('conv-1', sig, { hasLs: true, now: 9_999_999 }), complete);

    // Disk signature changes -> cache misses immediately
    const sig2 = 'b1|200:80|0|0';
    assert.equal(cache.get('conv-1', sig2, { hasLs: true, now: 10_000_000 }), null);
  });

  it('evicts oldest entry when exceeding maxEntries', () => {
    const cache = new SnapshotCache({ maxEntries: 2 });
    const p1 = makePayload({ meteredSteps: 1, generatorMatchedSteps: 1 });
    const p2 = makePayload({ meteredSteps: 2, generatorMatchedSteps: 2 });
    const p3 = makePayload({ meteredSteps: 3, generatorMatchedSteps: 3 });

    cache.set('c1', 's1', p1, { hasLs: true, now: 1 });
    cache.set('c2', 's2', p2, { hasLs: true, now: 2 });
    cache.set('c3', 's3', p3, { hasLs: true, now: 3 });

    assert.equal(cache.get('c1', 's1', { hasLs: true, now: 4 }), null);
    assert.equal(cache.get('c2', 's2', { hasLs: true, now: 4 }), p2);
    assert.equal(cache.get('c3', 's3', { hasLs: true, now: 4 }), p3);
  });
});
