#!/usr/bin/env node
/**
 * Rasterise `assets/icon.svg` into the platform icon containers.
 *
 * The application shipped the upstream fork's icon - a black tile with a
 * stylised "P" - in `icon.ico`, `icon.png` and `icon.icns`, so the taskbar, the
 * installer and the macOS dock all showed a different product's brand than the
 * window they belonged to.
 *
 * The outputs are committed. This is a tool for regenerating them when the mark
 * changes, not a build step: nothing in `npm run build`, `package` or `make`
 * calls it, so a missing rasteriser can never break a release.
 *
 *   node scripts/generate-icons.mjs
 *
 * Both containers are assembled here rather than with a helper package. ICO and
 * ICNS are thin wrappers around PNG payloads on every OS this app supports, and
 * writing the two headers directly is smaller than the dependency would be.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'assets');
const source = join(assets, 'icon.svg');

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error(
    'This tool needs `sharp` to rasterise the SVG:\n' +
      '  npm install --no-save sharp\n' +
      'The committed icons under assets/ remain valid without it.',
  );
  process.exit(1);
}

/** Windows shell asks for these; anything missing gets scaled badly by the OS. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
/**
 * ICNS chunk types, each holding a plain PNG. The `ic1x` types are the modern
 * ones; the older `is32`/`il32` mask-and-bitmap pairs are not needed for any
 * macOS this app targets.
 */
const ICNS_TYPES = [
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
];

/**
 * Render at the exact pixel size rather than downscaling one large raster: the
 * SVG's strokes are thin, and a 16px icon resampled from 1024px turns them to
 * grey mush. `density` is what makes librsvg rasterise at the target size.
 */
async function png(size) {
  return sharp(source, { density: Math.ceil((72 * size) / 500) * 4 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  // Image data starts after the header and the whole directory.
  let offset = header.length + directory.length;
  for (const [index, { size, data }] of entries.entries()) {
    const at = index * 16;
    // 256 is stored as 0: the field is a single byte, so 256 does not fit.
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette count, 0 for truecolour
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  }
  return Buffer.concat([header, directory, ...entries.map((e) => e.data)]);
}

function buildIcns(chunks) {
  const body = Buffer.concat(
    chunks.map(({ type, data }) => {
      const head = Buffer.alloc(8);
      head.write(type, 0, 4, 'ascii');
      head.writeUInt32BE(data.length + 8, 4); // length includes the header
      return Buffer.concat([head, data]);
    }),
  );
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

mkdirSync(assets, { recursive: true });

// One render per distinct pixel size, reused across both containers.
const sizes = [...new Set([...ICO_SIZES, ...ICNS_TYPES.map(([, s]) => s), 512])];
const rendered = new Map();
for (const size of sizes.sort((a, b) => a - b)) rendered.set(size, await png(size));

writeFileSync(
  join(assets, 'icon.ico'),
  buildIco(ICO_SIZES.map((size) => ({ size, data: rendered.get(size) }))),
);
writeFileSync(
  join(assets, 'icon.icns'),
  buildIcns(ICNS_TYPES.map(([type, size]) => ({ type, data: rendered.get(size) }))),
);
// Linux and the Electron `icon` option want a plain raster.
writeFileSync(join(assets, 'icon.png'), rendered.get(512));

for (const name of ['icon.ico', 'icon.icns', 'icon.png']) {
  console.log(name);
}
