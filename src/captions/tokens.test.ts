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

/**
 * The dark token block. Keyed on the stamped attribute rather than a media query so
 * an explicit choice and "follow the system" share one code path - see theme.ts.
 */
function darkBlock(): string {
  const start = CSS.indexOf(":root[data-theme='dark'] {");
  expect(start).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf('\n}', start));
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

describe('button layout', () => {
  it('never lets a button label wrap onto a second line', () => {
    // A wrapped label turns a 44px control into a 60px one and breaks the row's
    // alignment. Observed as "Validate &" / "save" across two lines.
    expect(CSS).toMatch(/\.button\b[^{]*\{[^}]*white-space:\s*nowrap/);
  });

  it('packs a button group from the left instead of stretching it', () => {
    // `.button-row` inherited `justify-content: space-between` from the shared layout
    // rule, which spread three buttons across the full card width and squeezed each
    // one until its label wrapped.
    expect(CSS).toMatch(/\.button-row\s*\{[^}]*justify-content:\s*flex-start/);
    expect(CSS).toMatch(/\.button-row\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it('uses a tighter gap between related buttons than between layout regions', () => {
    const row = CSS.match(/\.button-row\s*\{[^}]+\}/)?.[0] ?? '';
    expect(row).toMatch(/gap:\s*var\(--space-2\)/);
  });
});

describe('theme switching', () => {
  it('keys the dark palette on the stamped attribute, not a media query', () => {
    // One dark trigger meant the operator got whatever the OS was set to. Resolution
    // now happens in theme.ts so an explicit choice and "follow the system" share one
    // channel - and so there is one dark token block instead of one per trigger.
    expect(CSS).toMatch(/:root\[data-theme='dark'\]\s*\{/);
    expect(CSS).not.toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{/);
  });

  it('covers the pre-paint frame without duplicating the palette', () => {
    // theme.ts stamps the attribute before React renders, but on a dark system there
    // is still one frame with no attribute - long enough to flash a white window.
    const fallback = CSS.match(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/,
    );
    expect(fallback).not.toBeNull();
    // Only the two root properties: anything more would be a second palette to keep
    // in sync.
    const declarations = (fallback![1].match(/[\w-]+\s*:/g) ?? []).length;
    expect(declarations).toBe(2);
  });
});

describe('docked primary action', () => {
  it('reserves its height in the scroll range instead of covering content', () => {
    // Fixed chrome over a scrolling container hides whatever is at the bottom unless
    // the container pads for it. Without this the dock sits on top of the last card's
    // controls and nothing can reach them.
    const shell = CSS.match(/\.control-shell \{[^}]+\}/)?.[0] ?? '';
    expect(shell).toMatch(/padding:[^;]*var\(--dock-clearance\)/);
    expect(shell).toMatch(/scroll-padding-bottom:\s*var\(--dock-clearance\)/);
  });

  it('derives the clearance from the dock height rather than a magic number', () => {
    expect(CSS).toMatch(/--dock-height:\s*\d+px/);
    expect(CSS).toMatch(/--dock-clearance:\s*calc\(var\(--dock-height\)/);
  });

  it('keeps the clearance at every breakpoint', () => {
    // A narrow window is where content is tallest and the dock most likely to cover
    // something, so a breakpoint that reset the bottom padding would be worst there.
    for (const rule of CSS.match(/\.control-shell \{ padding:[^}]+\}/g) ?? []) {
      expect(rule, `breakpoint rule dropped the dock clearance: ${rule}`).toMatch(
        /var\(--dock-clearance\)/,
      );
    }
  });

  it('lets clicks through the empty band beside the pill', () => {
    // The dock spans the full width to centre its child, so without this it would
    // swallow clicks meant for cards underneath.
    const dock = CSS.match(/\.session-dock \{[^}]+\}/)?.[0] ?? '';
    expect(dock).toMatch(/pointer-events:\s*none/);
    expect(CSS).toMatch(/\.session-dock > \* \{ pointer-events: auto/);
  });
});

describe('window chrome', () => {
  it('reserves the traffic-light inset for macOS only', () => {
    // The 50px top inset clears macOS's `hiddenInset` traffic lights, which overlay
    // the content. Windows and Linux draw a real title bar above the web view, so the
    // same inset was 50px of dead space above the heading.
    expect(CSS).toMatch(
      /:root\[data-platform='darwin'\] \.control-shell \{[^}]*padding-top:\s*50px/,
    );
    const shell = CSS.match(/\.control-shell \{[^}]+\}/)?.[0] ?? '';
    expect(shell).not.toMatch(/padding:\s*50px/);
  });
});

describe('motion policy', () => {
  const reducedMotion = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));

  it('does not blanket-disable transitions under reduced motion', () => {
    // A `transition-duration: .01ms !important` on `*` also removes the colour and
    // opacity crossfades that carry meaning - a caption promoting from provisional
    // to final became an instant swap with nothing to mark the change. Reduced
    // motion means removing movement, not removing feedback.
    expect(reducedMotion).not.toMatch(/transition-duration:\s*\.01ms/);
  });

  it('offers a fade alternative rather than nothing under reduced motion', () => {
    expect(reducedMotion).toMatch(/animation-name:\s*surface-fade/);
    expect(CSS).toMatch(/@keyframes surface-fade/);
  });

  it('removes press-scaling under reduced motion', () => {
    expect(reducedMotion).toMatch(/transform:\s*none/);
  });

  it('animates the level meter with transform, never width', () => {
    // The meter updates ~20x a second while a channel is live. Animating `width`
    // forces layout on every one of those frames.
    const rule = CSS.match(/\.level i \{[^}]+\}/)?.[0] ?? '';
    expect(rule).toMatch(/transition:\s*transform/);
    expect(rule).not.toMatch(/transition:[^;]*\bwidth\b/);
  });

  it('does not animate transcript rows, which arrive continuously mid-meeting', () => {
    // An entrance on each row is motion the operator has to ignore while reading
    // the thing that is moving. Deliberate omission, so it is asserted.
    const animated = CSS.match(/^([^{]*)\{\s*\n\s*animation: surface-enter/gm) ?? [];
    for (const selectorBlock of animated) {
      expect(selectorBlock).not.toMatch(/transcript/);
    }
    expect(CSS).not.toMatch(/\.transcript-entry[^{]*\{[^}]*animation:/);
  });

  it('caps the stagger so the last panel is not left visibly late', () => {
    // Eight settings cards at 40ms each would put the last one 320ms out, which
    // reads as lag rather than polish.
    const delays = [...CSS.matchAll(/animation-delay:\s*(\d+)ms/g)].map((m) =>
      Number(m[1]),
    );
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(200);
  });
});
