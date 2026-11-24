import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const formatSource = readFileSync(
  join(__dirname, '..', 'sidecars', 'usage_hud', 'web', 'format.js'),
  'utf-8',
);
const sandbox = { globalThis: {} };
sandbox.globalThis = sandbox;
vm.runInNewContext(formatSource, sandbox);

const {
  ageClass,
  clock,
  contrast,
  dur,
  fmt,
  hitClass,
  luminance,
  parseRgb,
  pct,
  stepCountLabel,
  stepRate,
  tok,
  tps,
  usageText,
} = sandbox.UsageHudFormat;

describe('frontend formatting helpers', () => {
  it('formats token counts cleanly across unit boundaries', () => {
    assert.equal(tok(null), '\u2014');
    assert.equal(tok(0), '0');
    assert.equal(tok(9_999), '9999');
    assert.equal(tok(10_000), '10.0k');
    assert.equal(tok(999_949), '999.9k');
    assert.equal(tok(999_950), '1.00M');
    assert.equal(tok(999_995_000), '1.00B');
    assert.equal(tok(-12_500), '-12.5k');
  });

  it('formats durations without emitting 60s or 60.0m', () => {
    assert.equal(dur(null), '\u2014');
    assert.equal(dur(500), '<1s');
    assert.equal(dur(43_000), '43s');
    assert.equal(dur(59_499), '59s');
    assert.equal(dur(59_500), '1.0m');
    assert.equal(dur(3_596_999), '59.9m');
    assert.equal(dur(3_597_000), '1.0h');
  });

  it('formats integers, percentages, rates, and step counts', () => {
    assert.equal(fmt(12345), '12,345');
    assert.equal(pct(0.8543), '85.4%');
    assert.equal(tps(123.4), '123');
    assert.equal(tps(45.67), '45.7');
    assert.equal(stepCountLabel(0), '0 steps');
    assert.equal(stepCountLabel(1), '1 step');
    assert.equal(stepCountLabel(24), '24 steps');
    assert.equal(usageText(100, 20_000, 500, 150), 'in 100 \u00b7 cache 20.0k \u00b7 out 500 \u00b7 150 tok/s');
    assert.equal(
      usageText(100, 20_000, 500, 45, { estimatedRate: true }),
      'in 100 \u00b7 cache 20.0k \u00b7 out 500 \u00b7 ~45.0 tok/s',
    );
    assert.equal(usageText(100, 20_000, 500, null), 'in 100 \u00b7 cache 20.0k \u00b7 out 500');
  });

  it('formats 24-hour clock strings consistently', () => {
    assert.equal(clock(null), '--:--');
    const c = clock(new Date(2026, 10, 24, 17, 23, 0).getTime());
    assert.match(c, /^\d{2}:\d{2}$/);
    assert.equal(c, '17:23');
  });

  it('classifies wait age, cache hit rate, and step rate thresholds', () => {
    assert.equal(ageClass(10_000), 'good');
    assert.equal(ageClass(120_000), 'mid');
    assert.equal(ageClass(300_000), 'bad');

    assert.equal(hitClass(0.8), 'good');
    assert.equal(hitClass(0.5), 'mid');
    assert.equal(hitClass(0.49), 'bad');

    assert.equal(stepRate({ rate: 200, streamMs: 199 }), null);
    assert.equal(stepRate({ rate: 200, streamMs: 200 }), 200);
  });

  it('parses rgb/rgba and computes WCAG luminance and contrast', () => {
    const black = parseRgb('rgb(0, 0, 0)');
    const white = parseRgb('rgba(255, 255, 255, 1)');
    assert.deepEqual({ ...black }, { r: 0, g: 0, b: 0, a: 1 });
    assert.equal(luminance(black), 0);
    assert.equal(luminance(white), 1);
    assert.equal(contrast(white, black), 21);
  });
});
