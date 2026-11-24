/**
 * Minimal, BigInt-safe protobuf wire-format walker for Antigravity local
 * SQLite metadata blobs.
 *
 * Uses BigInt for varint decoding so 64-bit integers and high-bit values never
 * suffer from JavaScript's 32-bit signed bitwise truncation. Supports prefix
 * allowlists so arbitrary length-delimited string/bytes fields are not blindly
 * recursed into as submessages.
 */

/** Field paths inside gen_metadata.data blobs. */
export const MAX_CONTEXT_PATH = '/1/9/10/4';
export const ESTIMATED_USED_PATH = '/1/9/10/1';
export const GEN_METADATA_PREFIXES = new Set(['', '/1', '/1/9', '/1/9/10']);

/** Field paths inside planner steps.metadata blobs. */
export const STEP_CREATED = '/1/1';
export const STEP_CREATED_NANO = '/1/2';
export const STEP_VIEWABLE = '/6/1';
export const STEP_VIEWABLE_NANO = '/6/2';
export const STEP_THINKING = '/9/9';
export const STEP_RESPONSE = '/9/10';
export const STEP_METADATA_PREFIXES = new Set(['', '/1', '/6', '/9']);

const MAX_PROTO_FIELD_NUMBER = 536870911; // 2^29 - 1
const UNGUIDED_MAX_FIELD_NUMBER = 20000;
const SIGN_BIT_64 = 1n << 63n;
const MASK_64 = (1n << 64n) - 1n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Decodes an unsigned up-to-64-bit protobuf base-128 varint starting at `offset`.
 * Returns `[valueBigInt, nextOffset]`, or `null` if truncated or overlong.
 *
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {[bigint, number] | null}
 */
export function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    if (shift === 63n) {
      // 10th byte may only carry bit 63 (0x01) and must terminate (no continuation bit).
      if ((byte & 0x80) !== 0 || byte > 0x01) return null;
      value |= BigInt(byte) << 63n;
      return [value & MASK_64, i];
    }
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, i];
    shift += 7n;
  }
  return null;
}

/**
 * Interprets a 64-bit unsigned varint as signed two's-complement int64 and
 * converts it to a JS Number when safely representable.
 *
 * @param {bigint} u64
 * @returns {number | null}
 */
export function varintToSafeNumber(u64) {
  const signed = (u64 & SIGN_BIT_64) !== 0n ? u64 - (1n << 64n) : u64;
  if (signed > MAX_SAFE_BIGINT || signed < MIN_SAFE_BIGINT) return null;
  return Number(signed);
}

/**
 * Walks a protobuf binary buffer and collects varint fields keyed by slash-separated
 * field path (e.g. `"/1/9/10/4"`).
 *
 * When `allowedPrefixes` is provided, only length-delimited (`wire === 2`) fields
 * whose path is in `allowedPrefixes` are recursively traversed, preventing
 * false-positive parses of UTF-8 strings or opaque byte payloads.
 *
 * @param {Uint8Array} buf
 * @param {{ allowedPrefixes?: Set<string> | null, maxDepth?: number }} [options]
 * @returns {Map<string, number>}
 */
export function walkVarints(buf, options = {}) {
  const { allowedPrefixes = null, maxDepth = 10 } = options;
  const maxField = allowedPrefixes ? MAX_PROTO_FIELD_NUMBER : UNGUIDED_MAX_FIELD_NUMBER;
  const out = new Map();

  function visit(slice, path, depth) {
    let i = 0;
    while (i < slice.length) {
      const tag = readVarint(slice, i);
      if (!tag) return;
      const [rawTag, afterTag] = tag;
      i = afterTag;

      const fieldBig = rawTag >> 3n;
      const wire = Number(rawTag & 7n);
      if (fieldBig <= 0n || fieldBig > BigInt(maxField)) return;
      const field = Number(fieldBig);
      const fieldPath = path + '/' + field;

      if (wire === 0) {
        const v = readVarint(slice, i);
        if (!v) return;
        i = v[1];
        const num = varintToSafeNumber(v[0]);
        if (num !== null) out.set(fieldPath, num);
      } else if (wire === 2) {
        const len = readVarint(slice, i);
        if (!len) return;
        i = len[1];
        const size = varintToSafeNumber(len[0]);
        if (size === null || size < 0 || i + size > slice.length) return;
        const child = slice.subarray(i, i + size);
        i += size;
        const shouldRecurse =
          depth < maxDepth &&
          size > 1 &&
          (!allowedPrefixes || allowedPrefixes.has(fieldPath));
        if (shouldRecurse) visit(child, fieldPath, depth + 1);
      } else if (wire === 5) {
        if (i + 4 > slice.length) return;
        i += 4;
      } else if (wire === 1) {
        if (i + 8 > slice.length) return;
        i += 8;
      } else {
        return;
      }
    }
  }

  visit(buf, '', 0);
  return out;
}
