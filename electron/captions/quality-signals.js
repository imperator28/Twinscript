const { classifyScript } = require('./caption-domain');
const { diceSimilarity } = require('./transcript-coordinator');

function protectedTokens(text) {
  const values =
    String(text || '').match(
      /(?:±|[+-]?\d+(?:\.\d+)?(?:\s?%|\s?mm|\s?cm|\s?kg|\s?°[CF])?|[A-Z]{2,}[A-Z0-9-]*\d[A-Z0-9-]*)/g,
    ) || [];
  return [...new Set(values.map((value) => value.replace(/\s+/g, '').toUpperCase()))];
}

function missingProtectedTokens(source, target) {
  const targetFlat = String(target || '').replace(/\s+/g, '').toUpperCase();
  return protectedTokens(source).filter((token) => !targetFlat.includes(token));
}

function wrongLanguage(text, target) {
  const detected = classifyScript(text);
  if (detected === 'unknown' || detected === 'mixed') return false;
  return detected !== target;
}

function buildQualitySignals({ sourceText, english, chinese, fastPath }) {
  const sourceClass = classifyScript(sourceText);
  const sameLanguageText =
    sourceClass === 'en' ? english : sourceClass === 'zh' ? chinese : '';
  const fastPathSimilarity = sameLanguageText
    ? diceSimilarity(sourceText, sameLanguageText)
    : null;
  return {
    sourceClass,
    mixedSource: sourceClass === 'mixed',
    wrongAudienceLanguage: {
      en: wrongLanguage(english, 'en'),
      zh: wrongLanguage(chinese, 'zh'),
    },
    missingProtectedTokens: {
      en: missingProtectedTokens(sourceText, english),
      zh: missingProtectedTokens(sourceText, chinese),
    },
    fastPathDivergence:
      Boolean(fastPath) &&
      fastPathSimilarity !== null &&
      fastPathSimilarity < 0.72,
    fastPathSimilarity,
  };
}

module.exports = {
  buildQualitySignals,
  missingProtectedTokens,
  protectedTokens,
  wrongLanguage,
};
