import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Contrast is checked against the stylesheet itself rather than a duplicated table,
// so a token edit cannot pass here while failing on screen.
//
// This exists because hand-picked dark-mode values do not inherit light-mode
// ratios, and the first draft of the dark theme shipped four failures - including
// white button labels at 2.72:1, because a colour lightened to be legible *as text
// on a dark surface* was then reused as a *background* for white text. A colour
// cannot do both, and only measurement says so.
const CSS = readFileSync(join(__dirname, 'captions.css'), 'utf8');

function tokensFrom(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[name] = value.toLowerCase();
  }
  return out;
}

/** The base `:root` block, up to its closing brace. */
function baseBlock(): string {
  const start = CSS.indexOf(':root {');
  expect(start).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf('\n}', start));
}

/** The `:root` block nested inside the prefers-color-scheme: dark media query. */
function darkBlock(): string {
  const media = CSS.indexOf('@media (prefers-color-scheme: dark)');
  expect(media).toBeGreaterThan(-1);
  const start = CSS.indexOf(':root {', media);
  return CSS.slice(start, CSS.indexOf('\n  }', start));
}

const relativeLuminance = (hex: string) => {
  const c = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string) => {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (light + 0.05) / (dark + 0.05);
};

// Foreground/background pairs the stylesheet actually renders together.
const PAIRS: Array<[label: string, fg: string, bg: string]> = [
  ['body text on a card', '--text', '--surface'],
  ['body text on the page', '--text', '--surface-sunken'],
  ['body text on a muted panel', '--text', '--surface-muted'],
  ['secondary text on a card', '--text-secondary', '--surface'],
  ['secondary text on a muted panel', '--text-secondary', '--surface-muted'],
  ['secondary text on an inset panel', '--text-secondary', '--surface-inset'],
  ['text-button label on a card', '--accent', '--surface'],
  ['primary button label', '--text-on-accent', '--accent'],
  ['stop button label', '--text-on-danger', '--danger'],
  ['quiet button label', '--text', '--surface-inset'],
  ['readiness blocker text', '--text', '--accent-quiet'],
  ['success pill text', '--success-text', '--success-surface'],
  ['warning notice text', '--warning-text', '--warning-surface'],
  ['danger warning text', '--danger-text', '--danger-surface'],
  ['info note text', '--info-text', '--info-surface'],
];

describe.each([
  ['light', baseBlock] as const,
  ['dark', darkBlock] as const,
])('%s theme', (theme, block) => {
  const tokens = tokensFrom(block());

  it('declares every colour token the pair table references', () => {
    const referenced = new Set(PAIRS.flatMap(([, fg, bg]) => [fg, bg]));
    for (const name of referenced) {
      expect(tokens[name], `${theme} theme is missing ${name}`).toBeDefined();
    }
  });

  it.each(PAIRS)('meets 4.5:1 for %s', (label, fg, bg) => {
    const ratio = contrast(tokens[fg], tokens[bg]);
    expect(
      ratio,
      `${label} in the ${theme} theme: ${tokens[fg]} on ${tokens[bg]} is ` +
        `${ratio.toFixed(2)}:1, below the 4.5:1 minimum for text`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps status borders distinguishable from their own surface', () => {
    // Borders are non-text, so 3:1 applies. A status block whose border vanishes
    // into its fill loses the shape that carries the meaning when colour alone
    // cannot be relied on.
    for (const kind of ['success', 'warning', 'danger', 'info']) {
      const ratio = contrast(tokens[`--${kind}-border`], tokens[`--${kind}-surface`]);
      expect(ratio, `${kind} border in the ${theme} theme`).toBeGreaterThanOrEqual(1.5);
    }
  });
});

describe('token hygiene', () => {
  it('has no non-ASCII bytes, which a PowerShell round-trip once mangled', () => {
    expect(/[^\x00-\x7F]/.test(CSS)).toBe(false);
  });

  it('defines a dark counterpart for every base colour token', () => {
    const base = Object.keys(tokensFrom(baseBlock()));
    const dark = tokensFrom(darkBlock());
    const missing = base.filter((name) => !(name in dark));
    expect(
      missing,
      'a base colour with no dark override renders a light value on a dark surface',
    ).toEqual([]);
  });

  it('does not reintroduce a third text level that cannot pass contrast', () => {
    expect(CSS).not.toMatch(/--text-tertiary/);
  });
});
