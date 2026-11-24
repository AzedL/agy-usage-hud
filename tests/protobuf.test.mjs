import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ESTIMATED_USED_PATH,
  GEN_METADATA_PREFIXES,
  MAX_CONTEXT_PATH,
  readVarint,
  STEP_CREATED,
  STEP_CREATED_NANO,
  STEP_METADATA_PREFIXES,
  STEP_RESPONSE,
  STEP_THINKING,
  STEP_VIEWABLE,
  STEP_VIEWABLE_NANO,
  varintToSafeNumber,
  walkVarints,
} from '../sidecars/usage_hud/lib/protobuf.mjs';

/** Helper to encode a BigInt varint for test fixtures. */
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

describe('protobuf varint decoding', () => {
  it('decodes values above 2^31 and 2^32 without 32-bit sign/shift overflow', () => {
    const overInt32 = 2_500_000_000n;
    const [decoded32, next32] = readVarint(encodeVarint(overInt32), 0);
    assert.equal(decoded32, overInt32);
    assert.equal(varintToSafeNumber(decoded32), 2_500_000_000);
    assert.equal(next32, 5);

    const overUint32 = 5_000_000_000_000n;
    const [decoded64] = readVarint(encodeVarint(overUint32), 0);
    assert.equal(decoded64, overUint32);
    assert.equal(varintToSafeNumber(decoded64), 5_000_000_000_000);
  });

  it('decodes 10-byte negative int64 varints cleanly', () => {
    const buf = encodeVarint(-42n);
    assert.equal(buf.length, 10);
    const [u64, next] = readVarint(buf, 0);
    assert.equal(next, 10);
    assert.equal(varintToSafeNumber(u64), -42);
  });

  it('rejects truncated or overlong varints', () => {
    assert.equal(readVarint(Buffer.from([0x80, 0x80]), 0), null);
    assert.equal(readVarint(Buffer.alloc(11, 0x80), 0), null);
    // 10th byte with invalid upper bits (> 0x01)
    assert.equal(
      readVarint(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02]), 0),
      null,
    );
  });
});

describe('walkVarints', () => {
  it('extracts gen_metadata max_context_tokens and estimated_tokens_used', () => {
    const ctxMsg = Buffer.concat([
      encodeVarintField(1, 123_456),
      encodeVarintField(4, 1_000_000),
    ]);
    const blob = encodeBytesField(1, encodeBytesField(9, encodeBytesField(10, ctxMsg)));

    const fields = walkVarints(blob, { allowedPrefixes: GEN_METADATA_PREFIXES });
    assert.equal(fields.get(MAX_CONTEXT_PATH), 1_000_000);
    assert.equal(fields.get(ESTIMATED_USED_PATH), 123_456);
  });

  it('extracts planner steps.metadata timestamps and token splits', () => {
    const created = Buffer.concat([encodeVarintField(1, 1_795_441_500), encodeVarintField(2, 250_000_000)]);
    const viewable = Buffer.concat([encodeVarintField(1, 1_795_441_502), encodeVarintField(2, 750_000_000)]);
    const usage = Buffer.concat([encodeVarintField(9, 420), encodeVarintField(10, 180)]);
    const blob = Buffer.concat([
      encodeBytesField(1, created),
      encodeBytesField(6, viewable),
      encodeBytesField(9, usage),
    ]);

    const fields = walkVarints(blob, { allowedPrefixes: STEP_METADATA_PREFIXES });
    assert.equal(fields.get(STEP_CREATED), 1_795_441_500);
    assert.equal(fields.get(STEP_CREATED_NANO), 250_000_000);
    assert.equal(fields.get(STEP_VIEWABLE), 1_795_441_502);
    assert.equal(fields.get(STEP_VIEWABLE_NANO), 750_000_000);
    assert.equal(fields.get(STEP_THINKING), 420);
    assert.equal(fields.get(STEP_RESPONSE), 180);
  });

  it('ignores non-allowlisted wire=2 string fields to avoid false positives', () => {
    // Field 2 holds arbitrary bytes that happen to look like valid protobuf varint field 1 = 99
    const fakeSubmsg = encodeVarintField(1, 99);
    const blob = Buffer.concat([
      encodeBytesField(2, fakeSubmsg),
      encodeBytesField(1, encodeBytesField(9, encodeBytesField(10, encodeVarintField(4, 256_000)))),
    ]);

    const guided = walkVarints(blob, { allowedPrefixes: GEN_METADATA_PREFIXES });
    assert.equal(guided.has('/2/1'), false);
    assert.equal(guided.get(MAX_CONTEXT_PATH), 256_000);
  });

  it('handles fixed32/fixed64 wire types and truncated payloads safely', () => {
    const fixed32 = Buffer.concat([encodeTag(3, 5), Buffer.from([1, 2, 3, 4])]);
    const fixed64 = Buffer.concat([encodeTag(4, 1), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]);
    const validAfter = encodeVarintField(5, 777);
    const truncatedTail = Buffer.concat([encodeTag(6, 2), encodeVarint(50), Buffer.from([1, 2])]);
    const blob = Buffer.concat([fixed32, fixed64, validAfter, truncatedTail]);

    const fields = walkVarints(blob);
    assert.equal(fields.get('/5'), 777);
  });
});
