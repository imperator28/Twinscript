import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_LICENSE,
  APP_LICENSE_URL,
  APP_NAME,
  APP_VERSION,
  CREDITED_PACKAGES,
  CREDITS,
  SIGNATURE,
} from './aboutCredits';

// `__dirname`, not `import.meta.url`: under Vitest the module URL is an http URL
// that `readFileSync` cannot open.
const repoRoot = join(__dirname, '..', '..');
const pkg = JSON.parse(
  readFileSync(join(repoRoot, 'package.json'), 'utf8'),
) as {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const declared = { ...pkg.dependencies, ...pkg.devDependencies };

describe('about credits', () => {
  it('shows the version this build actually is', () => {
    // A stale version here ends up quoted in bug reports.
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('names the app the way package.json does', () => {
    expect(APP_NAME.toLowerCase()).toBe(pkg.name);
  });

  it('credits only packages that are still dependencies', () => {
    for (const name of CREDITED_PACKAGES) {
      expect(declared, `${name} is credited but not a dependency`).toHaveProperty(
        name,
      );
    }
  });

  it('mentions every credited package somewhere in the card', () => {
    // Guards the other direction: a package added to the list without a line to
    // appear on is credited nowhere.
    const prose = CREDITS.map((credit) => credit.body).join(' ').toLowerCase();
    const missing = CREDITED_PACKAGES.filter((name) => {
      const bare = name.replace(/-react$/, '');
      return !prose.includes(bare);
    });
    expect(missing).toEqual([]);
  });

  it('states the licence the repository actually ships', () => {
    const license = readFileSync(join(repoRoot, 'LICENSE'), 'utf8');
    expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(APP_LICENSE).toBe('AGPL-3.0');
    expect(APP_LICENSE_URL).toMatch(/^https:\/\/www\.gnu\.org\//);
  });

  it('does not credit OBS or any GPL-2.0 source for the virtual camera', () => {
    // The DirectShow filter is a clean-room implementation. Naming OBS here -
    // even as a courtesy - would assert a code lineage that does not exist and
    // that the licence would not permit.
    const all = [...CREDITS.map((c) => `${c.label} ${c.body}`), SIGNATURE]
      .join(' ')
      .toLowerCase();
    expect(all).not.toContain('obs');
    expect(all).not.toContain('gpl-2');
    const camera = CREDITS.find((credit) => /camera/i.test(credit.label));
    expect(camera?.body).toMatch(/independent|written for this app/i);
  });

  it('gives every credit a label and a sentence', () => {
    for (const credit of CREDITS) {
      expect(credit.label.trim()).not.toBe('');
      // Labels are `dt` cells, not prose - a sentence there breaks the column.
      expect(credit.label.length).toBeLessThanOrEqual(16);
      expect(credit.label.endsWith('.')).toBe(false);
      expect(credit.body.trim().endsWith('.')).toBe(true);
    }
  });

  it('ends with the designer credit', () => {
    expect(SIGNATURE).toMatch(/Jiyu$/);
  });
});
