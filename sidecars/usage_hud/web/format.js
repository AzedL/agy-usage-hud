/**
 * Pure formatting and colour-contrast helpers shared by the Usage HUD frontend
 * and Node unit tests.
 *
 * Written as a classic script (attaching to `globalThis.UsageHudFormat`) rather
 * than an ES module so it loads reliably inside sandboxed sidecar iframes
 * without CORS module-fetch restrictions.
 */
(function (global) {
  'use strict';

  function fmt(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '\u2014';
    return Math.round(n).toLocaleString('en-US');
  }

  /**
   * Compact token formatter with clean unit boundaries (never emits `1000.0k`
   * or `1000.00M`).
   */
  function tok(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '\u2014';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    if (abs >= 999_995_000) return sign + (abs / 1e9).toFixed(2) + 'B';
    if (abs >= 999_950) return sign + (abs / 1e6).toFixed(2) + 'M';
    if (abs >= 1e4) return sign + (abs / 1e3).toFixed(1) + 'k';
    return sign + String(Math.round(abs));
  }

  function pct(x) {
    if (x === null || x === undefined || Number.isNaN(x)) return '\u2014';
    return (x * 100).toFixed(1) + '%';
  }

  function tps(x) {
    if (x === null || x === undefined || Number.isNaN(x)) return '\u2014';
    return x >= 100 ? x.toFixed(0) : x.toFixed(1);
  }

  /**
   * Compact duration formatter: `<1s`, `43s`, `7.0m`, `1.1h`.
   * Promotes values right before rounding boundaries so `59.6s` becomes `1.0m`
   * (never `60s`) and `59.96m` becomes `1.0h` (never `60.0m`).
   */
  function dur(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return '\u2014';
    const s = Math.max(0, ms) / 1000;
    if (s < 1) return '<1s';
    if (s < 59.5) return s.toFixed(0) + 's';
    const m = s / 60;
    if (m < 59.95) return m.toFixed(1) + 'm';
    return (s / 3600).toFixed(1) + 'h';
  }

  /** Wait age colour band: green < 1m, amber < 5m, red >= 5m. */
  function ageClass(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
    if (ms < 60_000) return 'good';
    if (ms < 300_000) return 'mid';
    return 'bad';
  }

  /** Cache hit rate colour band: green >= 80%, amber >= 50%, red < 50%. */
  function hitClass(rate) {
    if (rate === null || rate === undefined || Number.isNaN(rate)) return '';
    if (rate >= 0.8) return 'good';
    if (rate >= 0.5) return 'mid';
    return 'bad';
  }

  /** Compact 24-hour clock string (`17:23`) regardless of OS 12h locale. */
  function clock(at) {
    if (!at) return '--:--';
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return '--:--';
    const raw = d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return raw.startsWith('24:') ? '00:' + raw.slice(3) : raw;
  }

  function stepCountLabel(count) {
    const n = Number.isFinite(count) ? count : 0;
    return n === 1 ? '1 step' : `${n} steps`;
  }

  /**
   * Formats `"in 2382 · cache 407.0k · out 1055 · 210.4 tok/s"` (or
   * `"· ~45.0 tok/s"` when `estimatedRate` is true for SQLite-derived timings).
   */
  function usageText(input, cache, output, rate, { estimatedRate = false } = {}) {
    const ratePrefix = estimatedRate ? '~' : '';
    return (
      'in ' +
      tok(input) +
      ' \u00b7 cache ' +
      tok(cache) +
      ' \u00b7 out ' +
      tok(output) +
      (rate === null || rate === undefined ? '' : ' \u00b7 ' + ratePrefix + tps(rate) + ' tok/s')
    );
  }

  /** Parses `rgb(...)` / `rgba(...)` computed colour strings. */
  function parseRgb(value) {
    const m = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!m) return null;
    const parts = m[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  /** WCAG 2.1 relative luminance for an sRGB colour. */
  function luminance({ r, g, b }) {
    const f = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  /** WCAG 2.1 contrast ratio between two RGB colours. */
  function contrast(a, b) {
    const l1 = luminance(a);
    const l2 = luminance(b);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  }

  global.UsageHudFormat = {
    fmt,
    tok,
    pct,
    tps,
    dur,
    ageClass,
    hitClass,
    clock,
    stepCountLabel,
    usageText,
    parseRgb,
    luminance,
    contrast,
  };
})(globalThis);
