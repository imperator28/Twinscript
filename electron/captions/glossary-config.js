const ACTIVE_TERM_LIMIT = 40;
const STORED_TERM_LIMIT = 500;
const PROTECTED_TOKEN_LIMIT = 80;

const CORE_PRODUCT_DEVELOPMENT_TOKENS = Object.freeze([
  'T0',
  'T1',
  'T2',
  'T3',
  'EVT',
  'DVT',
  'PVT',
  'MP',
  'NPI',
  'PRD',
  'BOM',
  'CMF',
  'SKU',
  'DFM',
  'DFA',
  'DFMEA',
  'PFMEA',
  'ECO',
  'ECN',
  'FAI',
  'CTQ',
  'APQP',
  'PPAP',
  'IQC',
  'IPQC',
  'OQC',
  'SOP',
  'WI',
  'RFQ',
  'MOQ',
  'PO',
]);

function term(en, zh, aliases = [], priority = 3, doNotTranslate = false) {
  return { en, zh, aliases, priority, doNotTranslate };
}

const LEGACY_GLOSSARY_CONFIGURATIONS = Object.freeze([
  {
    schemaVersion: 1,
    id: 'mechanical-product-design',
    name: 'Mechanical & Product Design',
    description:
      'CAD, drawing review, GD&T, fits, fasteners, interfaces, and product-development decisions.',
    regions: [],
    domains: ['mechanical design', 'product design', 'drawing review'],
    protectedTokens: [],
    terms: [
      term('boss', '凸台', [], 5),
      term('rib', '加强筋', [], 5),
      term('fillet', '圆角', [], 4),
      term('chamfer', '倒角', [], 4),
      term('draft angle', '拔模斜度', ['出模斜度'], 5),
      term('wall thickness', '壁厚', [], 5),
      term('undercut', '倒扣', [], 5),
      term('datum', '基准', [], 5),
      term('flatness', '平面度', [], 5),
      term('perpendicularity', '垂直度', [], 5),
      term('parallelism', '平行度', [], 5),
      term('position tolerance', '位置度', [], 5),
      term('profile tolerance', '轮廓度', [], 5),
      term('runout', '跳动', [], 4),
      term('concentricity', '同轴度', [], 4),
      term('tolerance stack-up', '公差叠加', ['尺寸链'], 5),
      term('clearance fit', '间隙配合', [], 5),
      term('interference fit', '过盈配合', [], 5),
      term('transition fit', '过渡配合', [], 4),
      term('press fit', '压入配合', [], 4),
      term('threaded insert', '螺纹嵌件', [], 4),
      term('heat-set insert', '热熔螺母', ['热熔嵌件'], 4),
      term('captive screw', '防脱螺钉', [], 3),
      term('snap fit', '卡扣配合', ['卡扣'], 5),
      term('parting line', '分型线', [], 4),
      term('sealing surface', '密封面', [], 4),
      term('O-ring groove', 'O 形圈槽', [], 4),
      term('surface roughness', '表面粗糙度', [], 5),
      term('cosmetic surface', '外观面', ['A级面'], 5),
      term('reference dimension', '参考尺寸', [], 4),
      term('critical dimension', '关键尺寸', [], 5),
      term('nominal dimension', '公称尺寸', [], 3),
      term('exploded view', '爆炸图', [], 3),
      term('section view', '剖视图', [], 3),
      term('design freeze', '设计冻结', [], 5),
      term('interface control drawing', '接口控制图', [], 4),
    ],
  },
  {
    schemaVersion: 1,
    id: 'manufacturing-dfm',
    name: 'Manufacturing & DFM',
    description:
      'Machining, forming, moulding, joining, process constraints, defects, yield, and cycle-time discussions.',
    regions: [],
    domains: ['manufacturing', 'DFM', 'process engineering'],
    protectedTokens: [],
    terms: [
      term('CNC machining', '数控加工', [], 5),
      term('milling', '铣削', [], 4),
      term('turning', '车削', [], 4),
      term('grinding', '磨削', [], 3),
      term('wire EDM', '线切割电火花加工', ['线切割', '慢走丝'], 4),
      term('sinker EDM', '成形电火花加工', ['放电加工'], 4),
      term('sheet-metal bending', '钣金折弯', [], 5),
      term('stamping', '冲压', [], 5),
      term('die casting', '压铸', [], 5),
      term('injection moulding', '注塑成型', ['注塑'], 5),
      term('extrusion', '挤出成型', ['挤压成型'], 4),
      term('laser cutting', '激光切割', [], 4),
      term('welding', '焊接', [], 4),
      term('brazing', '钎焊', [], 3),
      term('adhesive bonding', '胶粘连接', ['粘接'], 3),
      term('ultrasonic welding', '超声波焊接', [], 4),
      term('insert moulding', '嵌件注塑', [], 4),
      term('overmoulding', '包胶注塑', ['二次包胶'], 4),
      term('gate', '浇口', ['入水口'], 5),
      term('sprue', '主流道', ['水口料'], 4),
      term('runner', '流道', [], 4),
      term('ejector pin', '顶针', [], 4),
      term('sink mark', '缩痕', ['缩水'], 5),
      term('weld line', '熔接痕', ['夹水线'], 5),
      term('short shot', '缺胶', ['充填不足'], 5),
      term('warpage', '翘曲', ['变形'], 5),
      term('mould shrinkage', '成型收缩率', ['缩水率'], 5),
      term('flash', '飞边', ['批锋', '披锋'], 5),
      term('burr', '毛刺', ['批锋'], 5),
      term('tool access', '刀具可达性', ['加工避空'], 4),
      term('clamping surface', '装夹面', [], 4),
      term('cycle time', '生产周期', ['成型周期'], 5),
      term('takt time', '节拍时间', ['生产节拍'], 5),
      term('first-pass yield', '一次通过率', ['直通率'], 5),
      term('scrap rate', '报废率', [], 4),
      term('process capability', '过程能力', [], 5),
    ],
  },
  {
    schemaVersion: 1,
    id: 'manufacturing-quality',
    name: 'Manufacturing Engineering & Quality',
    description:
      'Production readiness, fixtures, inspection, quality systems, corrective action, and line improvement.',
    regions: [],
    domains: ['manufacturing engineering', 'quality', 'NPI'],
    protectedTokens: [],
    terms: [
      term('process flow', '工艺流程', [], 5),
      term('work instruction', '作业指导书', ['作业说明'], 5),
      term('assembly fixture', '装配夹具', ['装配治具'], 5),
      term('inspection fixture', '检具', ['检测治具'], 5),
      term('error proofing', '防错', ['防呆'], 5),
      term('first article inspection', '首件检验', ['首件确认'], 5),
      term('control plan', '控制计划', [], 5),
      term('inspection plan', '检验计划', [], 4),
      term('incoming quality control', '来料质量控制', ['来料检验'], 5),
      term('in-process quality control', '制程质量控制', ['过程检验'], 5),
      term('outgoing quality control', '出货质量控制', ['出货检验'], 5),
      term('nonconformance report', '不合格报告', ['不符合项报告'], 5),
      term('corrective action', '纠正措施', [], 5),
      term('preventive action', '预防措施', [], 4),
      term('root cause analysis', '根本原因分析', [], 5),
      term('5 Whys', '五个为什么分析', ['五问法'], 4),
      term('fishbone diagram', '鱼骨图', ['因果图'], 3),
      term('8D report', '8D 报告', [], 5),
      term('gauge R&R', '量具重复性和再现性', [], 5),
      term('measurement system analysis', '测量系统分析', [], 5),
      term('sampling plan', '抽样方案', [], 4),
      term('acceptable quality limit', '接收质量限', ['允收质量限'], 4),
      term('rework', '返工', [], 5),
      term('scrap', '报废', [], 5),
      term('deviation', '偏差许可', ['偏差放行'], 4),
      term('concession', '让步接收', ['特采'], 4),
      term('traceability', '可追溯性', [], 5),
      term('lot number', '批次号', [], 4),
      term('serial number', '序列号', [], 4),
      term('pilot run', '试产', ['小批量试产'], 5),
      term('line balancing', '生产线平衡', [], 4),
      term('bottleneck', '瓶颈工序', [], 4),
      term('standard work', '标准作业', [], 4),
      term('changeover', '换线', ['转产'], 4),
      term('golden sample', '标准样品', ['金样'], 5),
      term('limit sample', '限度样品', ['限度样板'], 5),
      term('go/no-go gauge', '通止规', [], 4),
    ],
  },
  {
    schemaVersion: 1,
    id: 'south-china-tooling',
    name: 'South China Tooling & Supplier Meetings',
    description:
      'Injection-mould tooling, trial builds, supplier timing, and Guangdong–Shenzhen–Dongguan shop-floor language.',
    regions: ['Guangdong', 'Shenzhen', 'Dongguan'],
    domains: ['tooling', 'injection moulding', 'supplier'],
    protectedTokens: [],
    terms: [
      term('injection-moulded part', '注塑件', ['啤件', '啤塑件'], 5),
      term('flash', '飞边', ['批锋', '披锋'], 5),
      term('slide / slider', '滑块', ['行位'], 5),
      term('wedge block', '楔紧块', ['铲鸡'], 4),
      term('EDM electrode', '电火花电极', ['铜公', '铜工'], 5),
      term('mould polishing', '模具抛光', ['省模'], 5),
      term('mould spotting and fitting', '合模研配', ['飞模', '配模'], 5),
      term('injection moulding machine', '注塑机', ['啤机'], 5),
      term('sprue and runner', '主流道和流道', ['水口'], 5),
      term('mould insert', '模具镶件', ['镶件'], 4),
      term('cavity insert', '前模仁', ['前模芯'], 4),
      term('core insert', '后模仁', ['后模芯'], 4),
      term('ejector pin', '顶针', ['顶杆'], 5),
      term('lifter', '斜顶', [], 5),
      term('hot runner', '热流道', ['热咀'], 5),
      term('cold runner', '冷流道', [], 4),
      term('gate', '浇口', ['入水口'], 5),
      term('submarine gate', '潜伏式浇口', ['潜水口', '潜水'], 5),
      term('pin gate', '点浇口', ['细水口'], 4),
      term('direct gate', '直浇口', ['大水口'], 4),
      term('mould trial', '试模', ['试啤'], 5),
      term('mould modification', '改模', [], 5),
      term('mould repair', '修模', ['执模'], 4),
      term('mould texture', '模具蚀纹', ['晒纹', '咬花'], 4),
      term('draft angle', '拔模斜度', ['出模斜度'], 5),
      term('part sticking', '粘模', ['粘前模', '粘后模'], 4),
      term('drag mark', '拉伤', ['拖花'], 4),
      term('burn mark', '烧焦', ['烧胶'], 4),
      term('silver streak', '银纹', ['水花'], 4),
      term('sink mark', '缩痕', ['缩水'], 5),
      term('weld line', '熔接痕', ['夹水线'], 5),
      term('short shot', '缺胶', ['走胶不齐'], 5),
      term('warpage', '翘曲', ['变形'], 5),
      term('colour difference', '色差', [], 4),
      term('black speck', '黑点', [], 4),
      term('lead time', '交期', ['货期'], 5),
      term('mass production', '量产', ['大货'], 5),
      term('pilot run', '试产', ['小批量试产'], 5),
    ],
  },
]);

function cleanString(value, maxLength) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeProtectedToken(value) {
  return cleanString(value, 32).replace(/[,;=]/g, '').trim();
}

function mergeStrings(lists, { maxCount, maxLength, sanitizer }) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const raw of Array.isArray(list) ? list : []) {
      const value = sanitizer
        ? sanitizer(raw)
        : cleanString(raw, maxLength);
      const key = value.toLocaleLowerCase('en-US');
      if (!value || seen.has(key)) continue;
      seen.add(key);
      merged.push(value);
      if (merged.length >= maxCount) return merged;
    }
  }
  return merged;
}

function mergeProtectedTokens(...lists) {
  return mergeStrings(lists, {
    maxCount: PROTECTED_TOKEN_LIMIT,
    maxLength: 32,
    sanitizer: sanitizeProtectedToken,
  });
}

function mergeAliases(...lists) {
  return mergeStrings(lists, { maxCount: 10, maxLength: 120 });
}

function sanitizeTerm(raw) {
  const en = cleanString(raw?.en, 120);
  const zh = cleanString(raw?.zh, 120);
  if (!en || !zh) return null;
  const aliases = [];
  const seenAliases = new Set();
  for (const rawAlias of Array.isArray(raw.aliases) ? raw.aliases : []) {
    const alias = cleanString(rawAlias, 120);
    const key = alias.toLocaleLowerCase();
    if (!alias || seenAliases.has(key)) continue;
    seenAliases.add(key);
    aliases.push(alias);
    if (aliases.length >= 10) break;
  }
  const rawPriority = Number(raw.priority);
  const priority = Number.isInteger(rawPriority)
    ? Math.max(1, Math.min(5, rawPriority))
    : 3;
  return {
    en,
    zh,
    aliases,
    doNotTranslate: Boolean(raw.doNotTranslate),
    priority,
  };
}

function dedupeTerms(rawTerms) {
  const terms = [];
  const indexByKey = new Map();
  let duplicateCount = 0;
  let rejectedCount = 0;
  for (const raw of Array.isArray(rawTerms) ? rawTerms.slice(0, STORED_TERM_LIMIT) : []) {
    const next = sanitizeTerm(raw);
    if (!next) {
      rejectedCount += 1;
      continue;
    }
    const key = next.en.toLocaleLowerCase('en-US');
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, terms.length);
      terms.push(next);
      continue;
    }
    duplicateCount += 1;
    const existing = terms[existingIndex];
    terms[existingIndex] = {
      ...existing,
      ...next,
      aliases: mergeAliases(existing.aliases, next.aliases),
    };
  }
  return { terms, duplicateCount, rejectedCount };
}

function createUniversalConfiguration(configurations) {
  const terms = [];
  const indexByKey = new Map();
  for (const configuration of configurations) {
    for (const rawTerm of configuration.terms) {
      const next = sanitizeTerm(rawTerm);
      if (!next) continue;
      const key = `${next.en.toLocaleLowerCase('en-US')}\0${next.zh.toLocaleLowerCase()}`;
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, terms.length);
        terms.push(next);
        continue;
      }
      const existing = terms[existingIndex];
      const preferred = next.priority > existing.priority ? next : existing;
      terms[existingIndex] = {
        ...preferred,
        aliases: mergeAliases(existing.aliases, next.aliases),
        doNotTranslate: existing.doNotTranslate || next.doNotTranslate,
        priority: Math.max(existing.priority, next.priority),
      };
    }
  }
  return {
    schemaVersion: 1,
    id: 'universal-engineering',
    name: 'Universal engineering',
    description:
      'Mechanical design, manufacturing, quality, tooling, and supplier terminology.',
    regions: mergeStrings(
      configurations.map((configuration) => configuration.regions),
      { maxCount: 20, maxLength: 80 },
    ),
    domains: mergeStrings(
      configurations.map((configuration) => configuration.domains),
      { maxCount: 20, maxLength: 80 },
    ),
    protectedTokens: mergeProtectedTokens(
      ...configurations.map((configuration) => configuration.protectedTokens),
    ),
    terms: terms.slice(0, STORED_TERM_LIMIT),
  };
}

const BUILTIN_GLOSSARY_CONFIGURATIONS = Object.freeze([
  Object.freeze(createUniversalConfiguration(LEGACY_GLOSSARY_CONFIGURATIONS)),
]);

function sanitizeConfiguration(raw, fallback = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Glossary configuration must be an object');
  }
  if (raw.schemaVersion !== undefined && Number(raw.schemaVersion) !== 1) {
    throw new Error('Glossary schemaVersion must be 1');
  }
  const id =
    cleanString(raw.id, 80)
      .toLocaleLowerCase('en-US')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') ||
    fallback.id ||
    'custom';
  const name = cleanString(raw.name, 80) || fallback.name || 'Imported glossary';
  const { terms, duplicateCount, rejectedCount } = dedupeTerms(raw.terms);
  return {
    configuration: {
      schemaVersion: 1,
      id,
      name,
      description: cleanString(raw.description, 240),
      regions: mergeStrings([raw.regions], { maxCount: 20, maxLength: 80 }),
      domains: mergeStrings([raw.domains], { maxCount: 20, maxLength: 80 }),
      protectedTokens: mergeProtectedTokens(raw.protectedTokens),
      terms,
    },
    duplicateCount,
    rejectedCount,
  };
}

function getBuiltinConfiguration() {
  return BUILTIN_GLOSSARY_CONFIGURATIONS[0];
}

function mergeTerms(baseTerms, customTerms) {
  const base = dedupeTerms(baseTerms).terms;
  const custom = dedupeTerms(customTerms).terms;
  const customByKey = new Map(
    custom.map((entry) => [entry.en.toLocaleLowerCase('en-US'), entry]),
  );
  const merged = [...custom];
  for (const entry of base) {
    const key = entry.en.toLocaleLowerCase('en-US');
    const override = customByKey.get(key);
    if (override) {
      const index = merged.indexOf(override);
      merged[index] = {
        ...override,
        aliases: mergeAliases(override.aliases, entry.aliases),
      };
    } else {
      merged.push(entry);
    }
  }
  const customCount = custom.length;
  return merged
    .map((entry, index) => ({ entry, index, custom: index < customCount }))
    .sort((a, b) => {
      if (a.custom !== b.custom) return a.custom ? -1 : 1;
      if (b.entry.priority !== a.entry.priority) {
        return b.entry.priority - a.entry.priority;
      }
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function compileGlossarySelection(configurationId, customRaw) {
  const base = getBuiltinConfiguration(configurationId);
  const custom = customRaw
    ? sanitizeConfiguration(customRaw, {
        id: 'custom-overrides',
        name: 'Custom overrides',
      }).configuration
    : null;
  const storedTerms = mergeTerms(base.terms, custom?.terms || []);
  return {
    glossaryConfigurationId: base.id,
    customGlossaryConfiguration: custom,
    glossary: storedTerms.slice(0, ACTIVE_TERM_LIMIT),
    protectedTokens: mergeProtectedTokens(
      CORE_PRODUCT_DEVELOPMENT_TOKENS,
      base.protectedTokens,
      custom?.protectedTokens,
    ),
    glossaryStoredCount: storedTerms.length,
  };
}

function listGlossaryConfigurations() {
  return BUILTIN_GLOSSARY_CONFIGURATIONS.map((config) => ({
    id: config.id,
    name: config.name,
    description: config.description,
    regions: [...config.regions],
    domains: [...config.domains],
    termCount: config.terms.length,
  }));
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function parseBoolean(value) {
  return ['true', '1', 'yes', 'y'].includes(
    String(value || '').trim().toLocaleLowerCase('en-US'),
  );
}

function parseDelimited(text, delimiter, fileName) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const firstNonEmpty = lines.findIndex((line) => line.trim());
  if (firstNonEmpty < 0) throw new Error('The glossary file is empty');
  const header = parseDelimitedLine(lines[firstNonEmpty], delimiter).map((cell) =>
    cleanString(cell, 80).toLocaleLowerCase('en-US'),
  );
  const enIndex = header.indexOf('en');
  const zhIndex = header.indexOf('zh');
  if (enIndex < 0 || zhIndex < 0) {
    throw new Error('The first row must contain en and zh columns');
  }
  const aliasesIndex = header.indexOf('aliases');
  const literalIndex = header.indexOf('donottranslate');
  const priorityIndex = header.indexOf('priority');
  const rows = [];
  const rejectedRows = [];
  for (let index = firstNonEmpty + 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const cells = parseDelimitedLine(lines[index], delimiter);
    const entry = sanitizeTerm({
      en: cells[enIndex],
      zh: cells[zhIndex],
      aliases:
        aliasesIndex >= 0
          ? String(cells[aliasesIndex] || '')
              .split('|')
              .map((value) => value.trim())
          : [],
      doNotTranslate:
        literalIndex >= 0 ? parseBoolean(cells[literalIndex]) : false,
      priority: priorityIndex >= 0 ? Number(cells[priorityIndex]) : 3,
    });
    if (entry) rows.push(entry);
    else rejectedRows.push(index + 1);
  }
  const parsed = sanitizeConfiguration(
    {
      schemaVersion: 1,
      id: fileName,
      name: fileName,
      description: 'Imported meeting glossary',
      terms: rows,
    },
    { id: 'imported', name: 'Imported glossary' },
  );
  return {
    configuration: parsed.configuration,
    duplicateCount: parsed.duplicateCount,
    rejectedRows,
  };
}

function parseTxt(text, fileName) {
  const terms = [];
  const rejectedRows = [];
  String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (!line.trim() || line.trim().startsWith('#')) return;
      const parts = line.split(/\s*(?:=|→)\s*/);
      const entry = sanitizeTerm({ en: parts[0], zh: parts.slice(1).join(' = ') });
      if (parts.length >= 2 && entry) terms.push(entry);
      else rejectedRows.push(index + 1);
    });
  if (!terms.length && rejectedRows.length) {
    throw new Error('No valid “English = 中文” rows were found');
  }
  const parsed = sanitizeConfiguration(
    {
      schemaVersion: 1,
      id: fileName,
      name: fileName,
      description: 'Imported meeting glossary',
      terms,
    },
    { id: 'imported', name: 'Imported glossary' },
  );
  return {
    configuration: parsed.configuration,
    duplicateCount: parsed.duplicateCount,
    rejectedRows,
  };
}

function parseGlossaryContent({ extension, text, fileName = 'Imported glossary' }) {
  const normalizedExtension = String(extension || '')
    .toLocaleLowerCase('en-US')
    .replace(/^\./, '');
  if (normalizedExtension === 'json') {
    let raw;
    try {
      raw = JSON.parse(String(text || ''));
    } catch {
      throw new Error('The JSON glossary could not be parsed');
    }
    const parsed = sanitizeConfiguration(raw, {
      id: fileName,
      name: fileName,
    });
    return {
      configuration: parsed.configuration,
      duplicateCount: parsed.duplicateCount,
      rejectedRows: [],
    };
  }
  if (normalizedExtension === 'csv') {
    return parseDelimited(text, ',', fileName);
  }
  if (normalizedExtension === 'tsv') {
    return parseDelimited(text, '\t', fileName);
  }
  if (normalizedExtension === 'txt') {
    return parseTxt(text, fileName);
  }
  throw new Error('Choose a .json, .csv, .tsv, or .txt glossary file');
}

function createPortableConfiguration(settings) {
  const compiled = compileGlossarySelection(
    settings?.glossaryConfigurationId,
    settings?.customGlossaryConfiguration,
  );
  const base = getBuiltinConfiguration(compiled.glossaryConfigurationId);
  const storedTerms = mergeTerms(
    base.terms,
    compiled.customGlossaryConfiguration?.terms || [],
  );
  return {
    schemaVersion: 1,
    id: `${base.id}-portable`,
    name: compiled.customGlossaryConfiguration
      ? `${base.name} + Custom overrides`
      : base.name,
    description: base.description,
    regions: [...base.regions],
    domains: [...base.domains],
    protectedTokens: compiled.protectedTokens,
    terms: storedTerms,
  };
}

module.exports = {
  ACTIVE_TERM_LIMIT,
  BUILTIN_GLOSSARY_CONFIGURATIONS,
  CORE_PRODUCT_DEVELOPMENT_TOKENS,
  PROTECTED_TOKEN_LIMIT,
  STORED_TERM_LIMIT,
  cleanString,
  compileGlossarySelection,
  createPortableConfiguration,
  dedupeTerms,
  getBuiltinConfiguration,
  listGlossaryConfigurations,
  mergeProtectedTokens,
  mergeTerms,
  parseDelimitedLine,
  parseGlossaryContent,
  sanitizeConfiguration,
  sanitizeProtectedToken,
  sanitizeTerm,
};
