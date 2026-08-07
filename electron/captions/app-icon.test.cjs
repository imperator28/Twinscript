// The window icon: where it is found, and whether the committed files are the
// mark this app actually ships.
//
// Both halves failed before. `assets/icon.ico|png|icns` held the upstream fork's
// icon - a black tile with a stylised "P" - so the installer, the dock and the
// packaged taskbar showed another product's brand. And the caption entry point
// never passed `icon` to BrowserWindow at all, so development and Linux got
// Electron's own default. Neither is visible from any test that only checks the
// app starts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { appIconPath } = require('./app-icon');

const REPO = path.join(__dirname, '..', '..');
const ASSETS = path.join(REPO, 'assets');

test('finds the icon beside the app once packaged', () => {
  // assets/ ships via extraResource, NOT in the asar, so the packaged path is
  // resourcesPath-relative and cannot be reached from __dirname.
  const resolved = appIconPath({
    platform: 'win32',
    isPackaged: true,
    resourcesPath: 'C:\\App\\resources',
    exists: () => true,
  });
  assert.equal(resolved, path.join('C:\\App\\resources', 'assets', 'icon.ico'));
});

test('finds the icon in the repo during development', () => {
  const resolved = appIconPath({
    platform: 'win32',
    isPackaged: false,
    moduleDirectory: path.join(REPO, 'dist-electron', 'captions'),
    exists: () => true,
  });
  assert.equal(resolved, path.join(REPO, 'assets', 'icon.ico'));
});

test('asks for the ico on Windows and the png elsewhere', () => {
  const forPlatform = (platform) =>
    path.basename(
      appIconPath({ platform, isPackaged: true, resourcesPath: '/r', exists: () => true }),
    );
  // Windows needs the multi-size container; handing it one 512px PNG makes the
  // shell downscale once for every context it draws.
  assert.equal(forPlatform('win32'), 'icon.ico');
  assert.equal(forPlatform('linux'), 'icon.png');
  assert.equal(forPlatform('darwin'), 'icon.png');
});

test('returns nothing when the icon is missing, rather than a bad path', () => {
  // Electron handed a nonexistent icon falls back to its own default silently -
  // indistinguishable from never setting one. The caller omits the option instead,
  // so "no icon" is a decision the code made rather than one it stumbled into.
  assert.equal(
    appIconPath({ platform: 'win32', isPackaged: true, resourcesPath: '/r', exists: () => false }),
    '',
  );
  assert.equal(
    appIconPath({ platform: 'win32', isPackaged: true, resourcesPath: '', exists: () => true }),
    '',
  );
});

test('the real icon files exist where the resolver looks for them', () => {
  for (const name of ['icon.ico', 'icon.png', 'icon.icns', 'icon.svg']) {
    assert.ok(
      fs.existsSync(path.join(ASSETS, name)),
      `assets/${name} is missing`,
    );
  }
  // The development path is the one this repo can actually verify.
  assert.equal(
    appIconPath({
      platform: 'win32',
      isPackaged: false,
      moduleDirectory: path.join(REPO, 'dist-electron', 'captions'),
    }),
    path.join(ASSETS, 'icon.ico'),
  );
});

test('the ico carries every size the Windows shell asks for', () => {
  const ico = fs.readFileSync(path.join(ASSETS, 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'reserved field');
  assert.equal(ico.readUInt16LE(2), 1, 'type must be 1 (icon)');
  const count = ico.readUInt16LE(4);

  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    // 0 in the width byte means 256 - the field is one byte wide.
    sizes.push(ico.readUInt8(at) === 0 ? 256 : ico.readUInt8(at));
    const length = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    assert.ok(offset + length <= ico.length, `entry ${i} runs past the file`);
    // Every payload is a PNG, which is what the generator writes.
    assert.equal(
      ico.subarray(offset, offset + 8).toString('hex'),
      '89504e470d0a1a0a',
      `entry ${i} is not a PNG`,
    );
  }
  // 16 for the title bar, 32/48 for the taskbar at common DPI scalings, 256 for
  // large-icon views. A container missing these makes Windows rescale a
  // neighbouring size, which is what a blurry taskbar icon usually is.
  for (const size of [16, 24, 32, 48, 256]) {
    assert.ok(sizes.includes(size), `ico has no ${size}px entry (has ${sizes.join(', ')})`);
  }
});

test('the icns is a well-formed container', () => {
  const icns = fs.readFileSync(path.join(ASSETS, 'icon.icns'));
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length, 'declared length must match');
  const types = [];
  let at = 8;
  while (at < icns.length) {
    const type = icns.subarray(at, at + 4).toString('ascii');
    const length = icns.readUInt32BE(at + 4);
    assert.ok(length >= 8 && at + length <= icns.length, `chunk ${type} is malformed`);
    types.push(type);
    at += length;
  }
  // The retina and large types macOS actually reads today.
  for (const type of ['ic07', 'ic08', 'ic09', 'ic10']) {
    assert.ok(types.includes(type), `icns has no ${type} chunk`);
  }
});

test('the icon art is the same mark the app renders in its own UI', () => {
  // This is the assertion that would have caught the inherited icon: the file
  // being a valid ICO says nothing about whose logo is inside it. The source SVG
  // and the React component must describe the same artwork, so replacing one
  // without the other fails here.
  const svg = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
  const component = fs.readFileSync(
    path.join(REPO, 'src', 'captions', 'TwinscriptLogo.tsx'),
    'utf8',
  );

  // The white plate and its corner radius.
  assert.match(svg, /width="500" height="500" rx="111\.26"/);
  assert.match(component, /width="500" height="500" rx="111\.26"/);
  // The brand gradient.
  for (const stop of ['#3f51ff', '#82e0ff']) {
    assert.ok(svg.includes(stop), `icon.svg is missing gradient stop ${stop}`);
    assert.ok(component.includes(stop), `the component is missing stop ${stop}`);
  }
  // Every drawn path in the icon must appear in the component, verbatim.
  const paths = [...svg.matchAll(/ d="(M[^"]+)"/g)].map((match) => match[1]);
  assert.ok(paths.length >= 4, 'expected the four mark paths in icon.svg');
  for (const drawn of paths) {
    assert.ok(
      component.includes(drawn),
      `a path in icon.svg is not in TwinscriptLogo.tsx: ${drawn.slice(0, 48)}…`,
    );
  }
});
