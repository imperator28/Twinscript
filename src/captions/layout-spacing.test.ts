import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Asserted against the stylesheet itself, because jsdom does not apply author
// stylesheets: a rendered-component test can confirm both button rows exist and
// still not notice that they are drawn on top of each other. Spacing bugs in this
// file are therefore invisible to every other test in the suite, and this one has
// already shipped once - the setup card's "Go to the checklist" sat flush against
// the reset pair, reading as one lopsided three-button block that had wrapped.
const CSS = readFileSync(join(__dirname, 'captions.css'), 'utf8');

/** The declaration block of the first rule whose selector list contains `selector`. */
function blockContaining(selector: string): string {
  const index = CSS.indexOf(selector);
  expect(index, `no rule mentions ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', index);
  return CSS.slice(open + 1, CSS.indexOf('}', open));
}

const SPACE = Object.fromEntries(
  [...CSS.matchAll(/(--space-\d+)\s*:\s*(\d+)px\s*;/g)].map(([, name, value]) => [
    name,
    Number(value),
  ]),
) as Record<string, number>;

/** Resolve a `var(--space-N)` margin to pixels. */
function pixels(declaration: string): number {
  const named = declaration.match(/var\((--space-\d+)\)/);
  if (named) {
    const value = SPACE[named[1]];
    expect(value, `${named[1]} is not defined in the space scale`).toBeGreaterThan(0);
    return value;
  }
  const literal = declaration.match(/(\d+)px/);
  return literal ? Number(literal[1]) : 0;
}

describe('button row spacing', () => {
  it('separates one button row from the next', () => {
    // ControlApp's setup card renders two sibling `.button-row`s on purpose:
    // navigation must not sit in the same group as two destructive resets. That
    // only works if the groups are visibly apart.
    const block = blockContaining('.button-row + .button-row');
    expect(block).toMatch(/margin-top/);
    expect(pixels(block)).toBeGreaterThan(0);
  });

  it('spaces groups further apart than the buttons inside a group', () => {
    // The failure this pins is subtle: with row-to-row spacing equal to the
    // row's own `gap`, two groups of buttons look exactly like one group that
    // wrapped, so the grouping carries no meaning.
    const groupGap = pixels(blockContaining('.button-row {'));
    const betweenGroups = pixels(blockContaining('.button-row + .button-row'));
    expect(groupGap).toBeGreaterThan(0);
    expect(betweenGroups).toBeGreaterThan(groupGap);
  });

  it('gives a button row the same clearance whatever follows it', () => {
    // One value for "after a button row", so text and another row do not drift
    // apart as the file grows.
    const rule = blockContaining('.button-row + .field-note');
    expect(rule).toMatch(/margin-top/);
    expect(pixels(rule)).toBe(pixels(blockContaining('.button-row + .button-row')));
  });
});
