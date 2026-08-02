const MAX_GLOSSARY_ROWS = 16;
const MAX_GLOSSARY_PROMPT_CHARACTERS = 800;

function clean(value) {
  return String(value || '').trim();
}

function containsHan(value) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function sourceContains(sourceText, candidate) {
  const value = clean(candidate);
  if (!value) return false;
  const source = String(sourceText || '');
  return containsHan(value)
    ? source.includes(value)
    : source.toLocaleLowerCase('en-US').includes(
        value.toLocaleLowerCase('en-US'),
      );
}

function termMatches(sourceText, entry) {
  return [entry?.en, entry?.zh, ...(entry?.aliases || [])].some((candidate) =>
    sourceContains(sourceText, candidate),
  );
}

function termKey(entry) {
  return clean(entry?.en).toLocaleLowerCase('en-US');
}

function rowText(entry) {
  const suffix = entry.doNotTranslate ? ' [keep verbatim]' : '';
  return `${clean(entry.en)} = ${clean(entry.zh)}${suffix}`.trim();
}

function promptContent(glossary, protectedTokens) {
  const sections = [];
  if (glossary.length) {
    sections.push(`Terminology:\n${glossary.map(rowText).join('\n')}`);
  }
  if (protectedTokens.length) {
    sections.push(
      `Protected literal tokens (keep this exact canonical spelling in every language): ${protectedTokens.join(', ')}`,
    );
  }
  return sections.length ? `\n${sections.join('\n')}` : '';
}

function tokenPattern(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
    'iu',
  );
}

function detectedProtectedTokens(sourceText, protectedTokens) {
  const source = String(sourceText || '');
  const result = [];
  const seen = new Set();
  for (const value of protectedTokens || []) {
    const token = clean(value);
    const key = token.toLocaleLowerCase('en-US');
    if (!token || seen.has(key) || !tokenPattern(token).test(source)) continue;
    const proposed = [...result, token];
    if (
      promptContent([], proposed).length >
      MAX_GLOSSARY_PROMPT_CHARACTERS
    ) {
      break;
    }
    seen.add(key);
    result.push(token);
  }
  return result;
}

function compileGlossaryRequestContext({
  sourceText,
  glossary = [],
  customTerms = [],
  protectedTokens = [],
} = {}) {
  const customKeys = new Set((customTerms || []).map(termKey).filter(Boolean));
  const indexed = (glossary || [])
    .filter((entry) => clean(entry?.en) && clean(entry?.zh))
    .map((entry, index) => ({
      entry,
      index,
      custom: customKeys.has(termKey(entry)),
      matched: termMatches(sourceText, entry),
    }));

  const byPriority = (left, right) =>
    (Number(right.entry.priority) || 0) -
      (Number(left.entry.priority) || 0) ||
    left.index - right.index;
  const candidates = [
    ...indexed.filter((item) => item.matched && item.custom).sort(byPriority),
    ...indexed.filter((item) => item.matched && !item.custom).sort(byPriority),
    ...indexed.filter((item) => !item.matched).sort(byPriority),
  ];

  const detectedTokens = detectedProtectedTokens(sourceText, protectedTokens);
  const selected = [];
  const selectedKeys = new Set();
  for (const candidate of candidates) {
    if (selected.length >= MAX_GLOSSARY_ROWS) break;
    const key = termKey(candidate.entry);
    if (!key || selectedKeys.has(key)) continue;
    const proposed = [...selected, candidate.entry];
    if (
      promptContent(proposed, detectedTokens).length >
      MAX_GLOSSARY_PROMPT_CHARACTERS
    ) {
      continue;
    }
    selectedKeys.add(key);
    selected.push(candidate.entry);
  }

  const promptCharacters = promptContent(selected, detectedTokens).length;
  return {
    glossary: selected,
    protectedTokens: detectedTokens,
    metrics: {
      glossaryRows: selected.length,
      promptCharacters,
    },
  };
}

module.exports = {
  MAX_GLOSSARY_ROWS,
  MAX_GLOSSARY_PROMPT_CHARACTERS,
  compileGlossaryRequestContext,
  promptContent,
  sourceContains,
  termMatches,
};
