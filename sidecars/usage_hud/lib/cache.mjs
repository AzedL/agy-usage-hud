/**
 * Bounded LRU snapshot cache with partial-timing retry backoff.
 *
 * When the Antigravity Language Server is reachable, `GetCascadeTrajectory`
 * occasionally lags behind `transcript.jsonl` writes by a few hundred
 * milliseconds. Tracking `generatorMatchedSteps < meteredSteps` (rather than
 * merely `timingSource !== 'generator'`) ensures partially timed snapshots
 * converge once LS catches up, while bounded exponential backoff avoids
 * hammering LS indefinitely on permanently partial historical conversations.
 */

export const DEFAULT_RETRY_DELAYS_MS = [3000, 6000, 12000, 30000];

/**
 * Returns true when the snapshot's LS timing data is complete (or LS is not
 * expected to supply timings).
 *
 * @param {Record<string, any> | null | undefined} payload
 * @param {boolean} hasLs
 * @returns {boolean}
 */
export function isTimingComplete(payload, hasLs) {
  if (!hasLs || !payload?.hasUsage) return true;
  const metered = payload.summary?.meteredSteps ?? 0;
  const matched = payload.summary?.generatorMatchedSteps ?? 0;
  return matched >= metered;
}

export class SnapshotCache {
  /**
   * @param {{ maxEntries?: number, retryDelaysMs?: number[] }} [options]
   */
  constructor({ maxEntries = 16, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS } = {}) {
    this.maxEntries = maxEntries;
    this.retryDelaysMs = retryDelaysMs;
    /** @type {Map<string, { sig: string, at: number, payload: object, retries: number }>} */
    this.entries = new Map();
  }

  /**
   * Returns the cached payload if valid for `(conv, sig)`, or `null` when a
   * fresh read/RPC should be performed.
   *
   * @param {string} conv
   * @param {string} sig
   * @param {{ hasLs: boolean, now?: number }} options
   * @returns {object | null}
   */
  get(conv, sig, { hasLs, now = Date.now() }) {
    const entry = this.entries.get(conv);
    if (!entry || entry.sig !== sig) return null;

    if (isTimingComplete(entry.payload, hasLs)) {
      return entry.payload;
    }

    if (entry.retries >= this.retryDelaysMs.length) {
      return entry.payload;
    }

    const waitMs = this.retryDelaysMs[entry.retries];
    if (now - entry.at < waitMs) {
      return entry.payload;
    }

    return null;
  }

  /**
   * Stores a computed snapshot and updates its retry counter.
   *
   * @param {string} conv
   * @param {string} sig
   * @param {object} payload
   * @param {{ hasLs: boolean, now?: number }} options
   */
  set(conv, sig, payload, { hasLs, now = Date.now() }) {
    const prev = this.entries.get(conv);
    const complete = isTimingComplete(payload, hasLs);
    const retries =
      !complete && prev && prev.sig === sig ? prev.retries + 1 : 0;

    if (this.entries.has(conv)) this.entries.delete(conv);
    this.entries.set(conv, { sig, at: now, payload, retries });

    if (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }
}
