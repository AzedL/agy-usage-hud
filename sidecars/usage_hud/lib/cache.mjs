/**
 * Bounded LRU snapshot cache with partial-timing retry backoff.
 *
 * When the Antigravity Language Server is reachable, `GetCascadeTrajectory`
 * occasionally lags behind `transcript.jsonl` writes or recovers after a brief
 * restart/sleep. Tracking `generatorMatchedSteps < steps` ensures
 * partially timed snapshots converge once LS catches up: retries step through
 * fast backoff delays (`retryDelaysMs`) and then settle into a low-frequency
 * steady probe interval (`steadyRetryMs`, default 5 minutes) instead of
 * permanently locking incomplete data.
 */

export const DEFAULT_RETRY_DELAYS_MS = [3000, 6000, 12000, 30000];
export const DEFAULT_STEADY_RETRY_MS = 5 * 60 * 1000;

/**
 * Returns true when the snapshot's LS timing data covers every planner step
 * (or LS is not expected to supply timings). Matches the same planner-step
 * scope used by `hasUnmatchedPlannerSteps`.
 *
 * @param {Record<string, any> | null | undefined} payload
 * @param {boolean} hasLs
 * @returns {boolean}
 */
export function isTimingComplete(payload, hasLs) {
  if (!hasLs) return true;
  const totalSteps = payload?.summary?.steps ?? 0;
  if (totalSteps <= 0) return true;
  const matched = payload?.summary?.generatorMatchedSteps ?? 0;
  return matched >= totalSteps;
}

export class SnapshotCache {
  /**
   * @param {{ maxEntries?: number, retryDelaysMs?: number[], steadyRetryMs?: number }} [options]
   */
  constructor({
    maxEntries = 16,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    steadyRetryMs = DEFAULT_STEADY_RETRY_MS,
  } = {}) {
    this.maxEntries = maxEntries;
    this.retryDelaysMs = retryDelaysMs;
    this.steadyRetryMs = steadyRetryMs;
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

    const waitMs =
      entry.retries < this.retryDelaysMs.length
        ? this.retryDelaysMs[entry.retries]
        : this.steadyRetryMs;

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
      !complete && prev && prev.sig === sig
        ? Math.min(prev.retries + 1, this.retryDelaysMs.length)
        : 0;

    if (this.entries.has(conv)) this.entries.delete(conv);
    this.entries.set(conv, { sig, at: now, payload, retries });

    if (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }
}
