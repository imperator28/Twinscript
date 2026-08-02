'use strict';

// Metrics for the W1 language-behaviour corpus run (scripts/run-w1-corpus.mjs).
//
// These sit alongside quality-signals.js rather than inside the runner so they
// are testable and so the definition of "a critical value was dropped" lives
// with the other quality primitives instead of in a one-off script.

const { classifyScript } = require('./caption-domain');

// Numbers, and numbers carrying a unit. A translation may reorder or reword
// freely, but a torque spec or a part count has to survive verbatim.
const VALUE_PATTERN =
  /[+-]?\d+(?:[.,]\d+)?\s?(?:%|mm|cm|kg|g|ml|nm|mpa|psi|hz|khz|mhz|°[cf]|°|in|ft|s|min|h|v|a|w)?/gi;

// Written out in one language, digits in the other: a Chinese rendering of
// "two" as 二 must still count as carrying the value 2.
const CJK_DIGITS = new Map([
  ['零', '0'], ['〇', '0'], ['一', '1'], ['二', '2'], ['两', '2'], ['三', '3'],
  ['四', '4'], ['五', '5'], ['六', '6'], ['七', '7'], ['八', '8'], ['九', '9'],
]);

// A comma between digits with exactly three digits following is a thousands
// separator and is dropped; "1,5" keeps its comma so a European decimal is not
// silently turned into fifteen. Anchored on digits rather than \b because the
// surrounding whitespace has already been removed, which glues the number to
// the next word and destroys the boundary.
const THOUSANDS_SEPARATOR = /(?<=\d),(?=\d{3}(?!\d))/g;

function normalizeValue(raw) {
  return String(raw)
    .replace(/\s+/g, '')
    .replace(THOUSANDS_SEPARATOR, '')
    .toLowerCase();
}

/** Distinct numeric/unit values a translation must carry across unchanged. */
function criticalValues(text) {
  const found = String(text || '').match(VALUE_PATTERN) || [];
  return [...new Set(found.map(normalizeValue).filter((v) => /\d/.test(v)))];
}

function searchable(text) {
  let flat = String(text || '').replace(/\s+/g, '').toLowerCase();
  for (const [han, digit] of CJK_DIGITS) flat = flat.split(han).join(digit);
  return flat.replace(THOUSANDS_SEPARATOR, '');
}

/**
 * Values present in `source` that do not appear in `translated`.
 *
 * Compares the bare number first: a unit may legitimately be localized or
 * dropped into surrounding words, but the digits may not change.
 */
function missingCriticalValues(source, translated) {
  const haystack = searchable(translated);
  if (!haystack) return criticalValues(source);
  return criticalValues(source).filter((value) => {
    if (haystack.includes(value)) return false;
    const bare = value.match(/[+-]?\d+(?:[.,]\d+)?/);
    return !(bare && haystack.includes(bare[0]));
  });
}

/**
 * Whether `text` is written for the wrong audience.
 *
 * Delegates to the same script classifier the live session uses, so the run
 * measures the product's own notion of wrong-audience rather than a second,
 * stricter one invented for the report.
 *
 * Known limitation, and the reason the report states it: the classifier
 * returns 'mixed' and 'unknown' as not-wrong. A reply that is mostly correct
 * with a stray clause in the other language, or one too short to classify,
 * will not be counted. The measured rate is therefore a floor, not a ceiling.
 */
function wrongAudienceLanguage(text, target) {
  const detected = classifyScript(text);
  if (detected === 'unknown' || detected === 'mixed') return false;
  return detected !== target;
}

/** Nearest-rank percentile; `null` for an empty sample. */
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

module.exports = {
  criticalValues,
  missingCriticalValues,
  wrongAudienceLanguage,
  percentile,
};
