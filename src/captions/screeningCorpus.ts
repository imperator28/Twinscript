export type ScreeningLanguageClass = 'en' | 'zh' | 'mixed-between' | 'mixed-inline';

export interface ScreeningPrompt {
  id: string;
  sourceChannel: 'microphone' | 'system';
  languageClass: ScreeningLanguageClass;
  condition: string;
  sourceText: string;
  englishReference: string;
  chineseReference: string;
  protectedTokens: string[];
  critical: boolean;
  scripted: true;
}

type ScenarioVariant = {
  en: string;
  zh: string;
  termEn: string;
  termZh: string;
  protectedTokens: string[];
  critical?: boolean;
};

const CONDITIONS = [
  'Quiet room · normal pace',
  'Headset microphone · normal pace',
  'Meeting-compressed system audio',
  'Fast pace',
  'Long pause before the critical value',
  'Light background noise',
  'Natural regional accent',
  'Limited overlap at the beginning',
] as const;

const SCENARIOS: Array<{ id: string; variants: ScenarioVariant[] }> = [
  {
    id: 'tolerance',
    variants: [
      ['bracket', '支架', '±0.2 mm'],
      ['hinge pin', '铰链销', '±0.05 mm'],
      ['lens carrier', '镜头支架', '+0.10/−0.00 mm'],
      ['datum boss', '基准凸台', '±0.15 mm'],
    ].map(([partEn, partZh, value]) => ({
      en: `Hold the ${partEn} tolerance to ${value}.`,
      zh: `把${partZh}的公差控制在 ${value}。`,
      termEn: 'tolerance',
      termZh: '公差',
      protectedTokens: [value],
      critical: true,
    })),
  },
  {
    id: 'wall-thickness',
    variants: [
      ['battery door', '电池盖', '1.2 mm'],
      ['front housing', '前壳', '0.85 mm'],
      ['rib', '加强筋', '0.6 mm'],
      ['snap arm', '卡扣臂', '1.05 mm'],
    ].map(([partEn, partZh, value]) => ({
      en: `The ${partEn} wall thickness must remain at ${value}.`,
      zh: `${partZh}的壁厚必须保持在 ${value}。`,
      termEn: 'wall thickness',
      termZh: '壁厚',
      protectedTokens: [value],
      critical: true,
    })),
  },
  {
    id: 'schedule',
    variants: [
      ['DVT build', 'DVT 试产', 'September 14'],
      ['tooling release', '模具发布', 'October 3'],
      ['FAI review', '首件检验评审', 'November 18'],
      ['pilot run', '小批量试产', 'January 12'],
    ].map(([eventEn, eventZh, date]) => ({
      en: `Move the ${eventEn} to ${date}.`,
      zh: `把${eventZh}移到 ${date}。`,
      termEn: eventEn,
      termZh: eventZh,
      protectedTokens: [date, eventEn.split(' ')[0]],
      critical: true,
    })),
  },
  {
    id: 'part-number',
    variants: [
      ['upper cover', '上盖', 'MC-1047-B'],
      ['flex cable', '柔性排线', 'FPC-22A-091'],
      ['left hinge', '左铰链', 'HJ-8803-L'],
      ['seal', '密封圈', 'OR-17-2.4'],
    ].map(([partEn, partZh, partNumber]) => ({
      en: `Use part number ${partNumber} for the ${partEn}.`,
      zh: `${partZh}使用料号 ${partNumber}。`,
      termEn: 'part number',
      termZh: '料号',
      protectedTokens: [partNumber],
      critical: true,
    })),
  },
  {
    id: 'tool-revision',
    variants: [
      ['Tool 3', '三号模具', 'Rev C'],
      ['cavity insert', '型腔镶件', 'Rev D2'],
      ['checking fixture', '检具', 'Rev B7'],
      ['electrode drawing', '电极图', 'Rev E'],
    ].map(([itemEn, itemZh, revision]) => ({
      en: `Release ${revision} of the ${itemEn}.`,
      zh: `发布${itemZh}的 ${revision} 版本。`,
      termEn: 'revision',
      termZh: '版本',
      protectedTokens: [revision],
      critical: true,
    })),
  },
  {
    id: 'material',
    variants: [
      ['housing', '外壳', 'PC+ABS FR3010'],
      ['shaft', '轴', 'SUS304'],
      ['seal', '密封圈', '70A silicone'],
      ['heat spreader', '均热板', 'C1100 copper'],
    ].map(([partEn, partZh, material]) => ({
      en: `Specify ${material} for the ${partEn}.`,
      zh: `${partZh}指定使用 ${material}。`,
      termEn: 'material',
      termZh: '材料',
      protectedTokens: [material],
      critical: true,
    })),
  },
  {
    id: 'torque',
    variants: [
      ['M2 screw', 'M2 螺丝', '0.18 N·m'],
      ['hinge nut', '铰链螺母', '1.6 N·m'],
      ['terminal bolt', '端子螺栓', '3.5 N·m'],
      ['mounting screw', '安装螺丝', '0.42 N·m'],
    ].map(([partEn, partZh, value]) => ({
      en: `Set the ${partEn} torque to ${value}.`,
      zh: `把${partZh}的扭矩设为 ${value}。`,
      termEn: 'torque',
      termZh: '扭矩',
      protectedTokens: [value],
      critical: true,
    })),
  },
  {
    id: 'gap',
    variants: [
      ['display', '显示屏', '0.30 mm'],
      ['battery door', '电池盖', '0.20–0.35 mm'],
      ['hinge', '铰链', '0.15 mm maximum'],
      ['speaker mesh', '扬声器网罩', '0.10 mm'],
    ].map(([partEn, partZh, value]) => ({
      en: `Keep the ${partEn} assembly gap at ${value}.`,
      zh: `把${partZh}的装配间隙控制在 ${value}。`,
      termEn: 'assembly gap',
      termZh: '装配间隙',
      protectedTokens: [value],
      critical: true,
    })),
  },
  {
    id: 'temperature',
    variants: [
      ['adhesive cure', '胶水固化', '80 °C for 25 minutes'],
      ['thermal chamber', '温箱', '−20 °C for 2 hours'],
      ['reflow peak', '回流焊峰值', '245 °C'],
      ['battery test', '电池测试', '45 °C for 60 minutes'],
    ].map(([processEn, processZh, value]) => ({
      en: `Run the ${processEn} at ${value}.`,
      zh: `${processZh}按 ${value} 执行。`,
      termEn: processEn,
      termZh: processZh,
      protectedTokens: [value],
      critical: true,
    })),
  },
  {
    id: 'quantity',
    variants: [
      ['DVT units', 'DVT 样机', '240'],
      ['golden samples', '金样', '12'],
      ['pilot units', '试产样机', '1,500'],
      ['destructive-test units', '破坏性测试样机', '36'],
    ].map(([itemEn, itemZh, value]) => ({
      en: `Prepare ${value} ${itemEn}.`,
      zh: `准备 ${value} 台${itemZh}。`,
      termEn: itemEn,
      termZh: itemZh,
      protectedTokens: [value],
      critical: true,
    })),
  },
  {
    id: 'cost',
    variants: [
      ['tooling change', '改模', 'USD 8,750'],
      ['expedited freight', '加急运费', 'USD 1,280'],
      ['fixture', '检具', 'CNY 32,000'],
      ['laser texture', '激光纹理', 'USD 4,600'],
    ].map(([itemEn, itemZh, value]) => ({
      en: `The quoted ${itemEn} cost is ${value}.`,
      zh: `${itemZh}的报价是 ${value}。`,
      termEn: 'quoted cost',
      termZh: '报价',
      protectedTokens: [value],
      critical: true,
    })),
  },
  {
    id: 'quality',
    variants: [
      ['sink marks', '缩水', '3 of 80'],
      ['scratches', '划伤', '7 of 200'],
      ['flash', '飞边', '2.5%'],
      ['failed leak tests', '气密测试失败', '4 of 120'],
    ].map(([defectEn, defectZh, value]) => ({
      en: `The ${defectEn} result was ${value} samples.`,
      zh: `${defectZh}的结果是 ${value} 个样品。`,
      termEn: defectEn,
      termZh: defectZh,
      protectedTokens: [value],
      critical: true,
    })),
  },
  {
    id: 'finish',
    variants: [
      ['front bezel', '前框', 'Pantone 432 C'],
      ['button', '按键', 'VDI 27'],
      ['logo', '标志', '20% gloss'],
      ['rear cover', '后盖', 'MT-11010 texture'],
    ].map(([partEn, partZh, finish]) => ({
      en: `Apply ${finish} to the ${partEn}.`,
      zh: `${partZh}采用 ${finish}。`,
      termEn: 'surface finish',
      termZh: '表面处理',
      protectedTokens: [finish],
      critical: true,
    })),
  },
  {
    id: 'shipping',
    variants: [
      ['Shenzhen', '深圳', 'April 22', 'Los Angeles', '洛杉矶'],
      ['Suzhou', '苏州', 'May 6', 'Austin', '奥斯汀'],
      ['Dongguan', '东莞', 'June 17', 'Munich', '慕尼黑'],
      ['Xiamen', '厦门', 'August 9', 'Seattle', '西雅图'],
    ].map(([originEn, originZh, date, destinationEn, destinationZh]) => ({
      en: `Ship from ${originEn} on ${date} to ${destinationEn}.`,
      zh: `${date} 从${originZh}发货到${destinationZh}。`,
      termEn: 'ship',
      termZh: '发货',
      protectedTokens: [date, originEn, destinationEn],
      critical: true,
    })),
  },
  {
    id: 'change-request',
    variants: [
      ['ECO-2184', 'move the screw boss 1.5 mm', '把螺丝柱移动 1.5 mm'],
      ['ECO-2219', 'increase the draft angle to 1.0°', '把拔模角增加到 1.0°'],
      ['ECO-2291', 'remove two ribs', '删除两条加强筋'],
      ['ECO-2307', 'change the connector datum to B', '把连接器基准改为 B'],
    ].map(([eco, changeEn, changeZh]) => ({
      en: `${eco} requires us to ${changeEn}.`,
      zh: `${eco} 要求我们${changeZh}。`,
      termEn: 'engineering change',
      termZh: '工程变更',
      protectedTokens: [eco, ...(changeEn.match(/[0-9.]+(?:°| mm)?|datum [A-Z]/g) || [])],
      critical: true,
    })),
  },
  {
    id: 'discussion',
    variants: [
      ['review the stack-up before changing the tool', '改模前先评审尺寸链'],
      ['compare both concepts with the reliability team', '和可靠性团队比较两个方案'],
      ['wait for the supplier feedback before deciding', '等供应商反馈后再决定'],
      ['document the open issue in the meeting notes', '把未解决的问题记录在会议纪要中'],
    ].map(([actionEn, actionZh]) => ({
      en: `Let us ${actionEn}.`,
      zh: `我们先${actionZh}。`,
      termEn: 'review',
      termZh: '评审',
      protectedTokens: [],
      critical: false,
    })),
  },
];

function mixedInline(variant: ScenarioVariant) {
  if (variant.termZh && variant.zh.includes(variant.termZh)) {
    return variant.zh.replace(variant.termZh, variant.termEn);
  }
  return `${variant.zh} Please confirm.`;
}

function makePrompt(
  scenarioId: string,
  variant: ScenarioVariant,
  variantIndex: number,
  languageClass: ScreeningLanguageClass,
  globalIndex: number,
): ScreeningPrompt {
  const id = `${scenarioId}-${variantIndex + 1}-${languageClass}`;
  const languageOffset = (
    ['en', 'zh', 'mixed-between', 'mixed-inline'] as const
  ).indexOf(languageClass);
  const sourceText =
    languageClass === 'en'
      ? variant.en
      : languageClass === 'zh'
        ? variant.zh
        : languageClass === 'mixed-between'
          ? `${variant.zh} Please confirm the same point in English.`
          : mixedInline(variant);
  return {
    id,
    sourceChannel:
      (Math.floor(globalIndex / 4) + languageOffset) % 2 === 0
        ? 'microphone'
        : 'system',
    languageClass,
    condition: CONDITIONS[globalIndex % CONDITIONS.length],
    sourceText,
    englishReference:
      languageClass === 'mixed-between'
        ? `${variant.en} Please confirm the same point in English.`
        : variant.en,
    chineseReference:
      languageClass === 'mixed-between'
        ? `${variant.zh} 请用英语确认同一点。`
        : variant.zh,
    protectedTokens: variant.protectedTokens,
    critical: Boolean(variant.critical),
    scripted: true,
  };
}

export const SCREENING_CORPUS: ScreeningPrompt[] = SCENARIOS.flatMap(
  (scenario, scenarioIndex) =>
    scenario.variants.flatMap((variant, variantIndex) =>
      (['en', 'zh', 'mixed-between', 'mixed-inline'] as const).map(
        (languageClass, languageIndex) =>
          makePrompt(
            scenario.id,
            variant,
            variantIndex,
            languageClass,
            scenarioIndex * 16 + variantIndex * 4 + languageIndex,
          ),
      ),
    ),
);

export const SCREENING_CORPUS_SUMMARY = Object.freeze({
  total: SCREENING_CORPUS.length,
  codeSwitch: SCREENING_CORPUS.filter((item) =>
    item.languageClass.startsWith('mixed'),
  ).length,
  critical: SCREENING_CORPUS.filter((item) => item.critical).length,
  microphone: SCREENING_CORPUS.filter(
    (item) => item.sourceChannel === 'microphone',
  ).length,
  system: SCREENING_CORPUS.filter((item) => item.sourceChannel === 'system')
    .length,
});
