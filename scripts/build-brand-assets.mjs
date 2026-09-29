import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(new URL('./brand-tools/package.json', import.meta.url));
const sharp = require('sharp');
const { optimize } = require('svgo');
const opentype = require('opentype.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const records = [];
const sizes = [2048, 1024, 512, 256, 128, 64, 32];
const read = (path) => readFile(resolve(root, path));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const xml = (body, width = 1024, height = width, title = 'Useful Bot') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img"><title>${title}</title>${body}</svg>`;
const content = (svg) => svg.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title\b[^>]*>[\s\S]*?<\/title>/g, '');
const black = '<path fill="#000000" d="M0 0H1024V1024H0Z"/>';

async function output(path, data, properties = {}) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  await mkdir(dirname(resolve(root, path)), { recursive: true });
  await writeFile(resolve(root, path), bytes);
  records.push({ path, bytes: bytes.length, sha256: sha(bytes), ...properties });
}

function optimized(svg) {
  // SVGO parses XML before optimizing. Keep intentional animation/editing IDs.
  return optimize(svg, {
    multipass: true,
    floatPrecision: 3,
    plugins: [{ name: 'preset-default', params: { overrides: {
      cleanupIds: false, collapseGroups: false, mergePaths: false, inlineStyles: false,
      removeDesc: false, convertShapeToPath: false,
    } } }, 'removeDimensions'],
  }).data;
}

async function svgOutput(path, svg) {
  const result = optimized(svg);
  assert(!/<(?:image|foreignObject|script)\b|data:image|base64/i.test(result), `Non-vector content: ${path}`);
  await output(path, result + '\n', { kind: 'svg' });
  return result;
}

async function render(svg, width, height = width) {
  // Supersample SVG curves then use Lanczos3 at the intended display size.
  const enlarged = svg.replace('<svg ', `<svg width="${width * 3}" height="${height * 3}" `);
  return sharp(Buffer.from(enlarged)).resize(width, height, { fit: 'contain', kernel: 'lanczos3' }).png().toBuffer();
}

async function pngOutput(path, input, size, { height = size, opaque = false, background = '#000000', ...extra } = {}) {
  let image = sharp(input).resize(size, height, { fit: 'contain', kernel: 'lanczos3' }).toColourspace('srgb');
  image = opaque ? image.flatten({ background }).removeAlpha() : image.ensureAlpha();
  if (!opaque) {
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    // Remove faint Lanczos alpha ringing without changing the actual AA edge.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) data.fill(0, i, i + 4);
      else if (data[i + 3] > 247) data[i + 3] = 255;
    }
    image = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
  }
  const data = await image.withIccProfile('srgb').png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  await output(path, data, { kind: 'png', width: size, height, alpha: !opaque, ...extra });
  return data;
}

// DIB-backed ICO is supported by older favicon consumers as well as modern ones.
async function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const chunks = [];
  let offset = header.length;
  for (const [index, { data: png, size }] of images.entries()) {
    const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const maskStride = Math.ceil(size / 32) * 4;
    const dib = Buffer.alloc(40 + size * size * 4 + maskStride * size);
    dib.writeUInt32LE(40, 0); dib.writeInt32LE(size, 4); dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14); dib.writeUInt32LE(size * size * 4, 20);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = 40 + ((size - y - 1) * size + x) * 4;
      dib[to] = data[from + 2]; dib[to + 1] = data[from + 1];
      dib[to + 2] = data[from]; dib[to + 3] = data[from + 3];
      if (!data[from + 3]) dib[40 + size * size * 4 + (size - y - 1) * maskStride + (x >> 3)] |= 128 >> (x % 8);
    }
    const entry = 6 + index * 16;
    header[entry] = size; header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(dib.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    chunks.push(dib); offset += dib.length;
  }
  return Buffer.concat([header, ...chunks]);
}

// The logo is the bot's circle head in Original white. Three hand-written masters
// share one face geometry (copied from avatar-face.svg) and differ only in placement.
const headSource = (await read('brand/source/useful-bot-head.svg')).toString();
const logoSource = (await read('brand/source/useful-bot-logo.svg')).toString();
const appSource = (await read('brand/source/useful-bot-app-icon-macos.svg')).toString();
for (const svg of [headSource, logoSource, appSource]) assert(/viewBox="0 0 1024 1024"/.test(svg), 'Masters must use the 1024 artboard');
// The face group's children, in face units (circle centre 512,420, radius 352).
const faceInner = headSource.match(/<g id="face"[^>]*>([\s\S]*)<\/g>\s*<\/svg>/)[1].trim();
for (const svg of [logoSource, appSource]) assert(svg.includes(faceInner), 'Masters must share one face geometry');
// Place the face so its circle has `diameter` and is centred on (cx, cy).
const FACE_DIAMETER = 704;
const face = (diameter, cx, cy, inner = faceInner) => {
  const s = diameter / FACE_DIAMETER;
  const m = [s, 0, 0, s, cx - s * 512, cy - s * 420].map(v => +v.toFixed(6));
  return `<g transform="matrix(${m.join(' ')})">${inner}</g>`;
};
// The Welcome tile: a 76 pt face box in a 112 pt tile. The 768-unit box is 19/28 of the tile.
const MARK_DIAMETER = 1024 * 19 / 28 * FACE_DIAMETER / 768;
const markScale = MARK_DIAMETER / FACE_DIAMETER;
const placed = (source, scale, cx = 512, cy = 512) => {
  const m = source.match(/<g id="face" transform="matrix\(([^)]+)\)"/)[1].split(/[\s,]+/).map(Number);
  const expected = [scale, 0, 0, scale, cx - scale * 512, cy - scale * 420];
  return m.every((value, index) => Math.abs(value - expected[index]) < .001);
};
assert(placed(headSource, markScale) && placed(logoSource, markScale), 'Mark or logo placement drifted from the Welcome tile');
assert(placed(appSource, 824 / 1024 * markScale), 'App icon head must keep the Welcome proportion inside the 824 tile');
const mark = await svgOutput('brand/svg/useful-bot-mark.svg', optimized(headSource));
const logo = await svgOutput('brand/svg/useful-bot-logo.svg', optimized(logoSource));
const appIcon = await svgOutput('brand/svg/useful-bot-app-icon-macos.svg', optimized(appSource));
// Inverse set for white surfaces: the same face with every colour flipped, so the
// glasses, eyes and mouth stay readable on a black head.
const invert = svg => svg.replace(/fill="#FFFFFF"(?=\/>)/, 'fill="#000000"').replaceAll('#141413', '#FFFFFF').replaceAll('stroke="#fff"', 'stroke="#000000"');
const headInverseSource = (await read('brand/source/useful-bot-head-inverse.svg')).toString();
const logoInverseSource = (await read('brand/source/useful-bot-logo-inverse.svg')).toString();
const faceInverseInner = invert(faceInner);
for (const svg of [headInverseSource, logoInverseSource]) {
  assert(svg.includes(faceInverseInner), 'Inverse masters must be the face with its colours flipped');
  assert(placed(svg, markScale), 'Inverse placement drifted from the Welcome tile');
}
const markInverse = await svgOutput('brand/svg/useful-bot-mark-inverse.svg', optimized(headInverseSource));
const logoInverse = await svgOutput('brand/svg/useful-bot-logo-inverse.svg', optimized(logoInverseSource));

const fontBytes = await read('brand/source/fonts/Inter-SemiBold.ttf');
const font = opentype.parse(fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength));
const glyphs = Array.from('Useful Bot', character => font.charToGlyph(character));
const advance = (index, size) => {
  const kerning = index + 1 < glyphs.length ? font.getKerningValue(glyphs[index], glyphs[index + 1]) : 0;
  return (glyphs[index].advanceWidth + kerning) * size / font.unitsPerEm - size * .018;
};
// Ink width of the name: advances up to the last glyph, plus that glyph's outline.
const wordWidth = size => glyphs.slice(0, -1).reduce((total, _, index) => total + advance(index, size), 0) + glyphs.at(-1).getBoundingBox().x2 * size / font.unitsPerEm;
const capHeight = size => font.tables.os2.sCapHeight * size / font.unitsPerEm;
function word(x, y, size, fill = '#FFFFFF') {
  // The fixed Latin name needs no contextual substitutions. Reading each glyph
  // avoids Inter's unsupported GSUB ccmp lookup in opentype.js, preserving its
  // actual outlines, advance widths and kerning pairs.
  const contours = [];
  let cursor = x;
  for (const [index, glyph] of glyphs.entries()) {
    contours.push(glyph.getPath(cursor, y, size).toPathData(3));
    cursor += advance(index, size);
  }
  return `<path fill="${fill}" d="${contours.join(' ')}"/>`;
}
const editableWord = (x, y, size, fill = '#FFFFFF') => `<text x="${x}" y="${y}" fill="${fill}" font-family="Inter, sans-serif" font-weight="600" font-size="${size}" letter-spacing="-.018em">Useful Bot</text>`;
const fontStyle = '<style>@font-face{font-family:Inter;src:url(fonts/Inter-SemiBold.woff2) format("woff2");font-weight:600;font-style:normal}</style>';
const r1 = v => Math.round(v * 10) / 10;
// Horizontal: the head is 0.7 of the height, the gap half the head's radius, and
// the name's cap height is centred on the head. Margins equal the vertical margin.
const lockupH = (() => {
  const height = 640, d = 448, size = 224, margin = (height - d) / 2, x = margin + d + d / 4;
  return ['useful-bot-lockup-horizontal', Math.ceil(x + wordWidth(size) + margin), height, face(d, margin + d / 2, height / 2), r1(x), r1(height / 2 + capHeight(size) / 2), size];
})();
// Stacked: the head above the centred name, one cap height apart.
const lockupS = (() => {
  const width = 1024, d = 600, size = 160, top = 112, baseline = top + d + capHeight(size) * 2;
  return ['useful-bot-lockup-stacked', width, Math.ceil(baseline + top), face(d, width / 2, top + d / 2), r1((width - wordWidth(size)) / 2), r1(baseline), size];
})();
const lockups = [
  ['useful-bot-wordmark', 740, 170, '', 12, 124, 136],
  lockupH,
  lockupS,
];
for (const [name, width, height, artwork, x, y, size] of lockups) {
  await svgOutput(`brand/svg/${name}.svg`, xml(artwork + word(x, y, size), width, height));
  await svgOutput(`brand/source/${name}-text.svg`, xml(fontStyle + artwork + editableWord(x, y, size), width, height));
  // Inverse: black name and black head, for white backgrounds.
  const inverseArt = invert(artwork);
  await svgOutput(`brand/svg/${name}-inverse.svg`, xml(inverseArt + word(x, y, size, '#000000'), width, height));
  await svgOutput(`brand/source/${name}-inverse-text.svg`, xml(fontStyle + inverseArt + editableWord(x, y, size, '#000000'), width, height));
}

// Rasters render straight from the vector masters.
for (const size of sizes) {
  await pngOutput(`brand/png/mark/useful-bot-${size}.png`, await render(mark, size), size, { family: 'primary' });
  await pngOutput(`brand/png/black/useful-bot-${size}.png`, await render(logo, size), size, { opaque: true, family: 'primary' });
  await pngOutput(`brand/png/mark-inverse/useful-bot-${size}.png`, await render(markInverse, size), size, { family: 'primary' });
  await pngOutput(`brand/png/white/useful-bot-${size}.png`, await render(logoInverse, size), size, { opaque: true, background: '#FFFFFF', family: 'primary-inverse' });
}

// Tabs are tiny, so the favicon's head fills more of its black square (84% of the width).
const faviconSvg = xml(black + face(1024 * .84, 512, 512));
await svgOutput('brand/favicon/favicon.svg', faviconSvg);
const icoImages = [];
for (const size of [16, 32, 48]) {
  const data = await render(faviconSvg, size);
  icoImages.push({ data, size });
  if (size !== 48) await pngOutput(`brand/favicon/favicon-${size}x${size}.png`, data, size, { opaque: true, family: 'favicon' });
}
await output('brand/favicon/favicon.ico', await ico(icoImages), { kind: 'ico' });
await pngOutput('brand/favicon/apple-touch-icon.png', await render(logo, 180), 180, { opaque: true, family: 'primary' });
for (const size of [192, 512]) {
  await pngOutput(`brand/pwa/icon-${size}.png`, await render(logo, size), size, { opaque: true, family: 'primary' });
  // The primary placement already keeps the head (radius 31% of the width) inside the
  // W3C maskable safe circle (radius 40%), so the maskable icon is the full-bleed logo.
  await pngOutput(`brand/pwa/icon-maskable-${size}.png`, await render(logo, size), size, { opaque: true, family: 'maskable' });
}
const manifest = {
  name: 'Useful Bot', short_name: 'Useful Bot', id: '/', start_url: '/', scope: '/',
  display: 'standalone', theme_color: '#000000', background_color: '#000000',
  icons: [192, 512].flatMap(size => [
    { src: `icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' },
    { src: `icon-maskable-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'maskable' },
  ]),
};
await output('brand/pwa/site.webmanifest', JSON.stringify(manifest, null, 2) + '\n', { kind: 'manifest' });
// Root public is the portable handoff. The web service has no browser UI, so
// nothing is copied under web/.
for (const record of [...records].filter(r => /^brand\/(favicon|pwa)\//.test(r.path))) {
  const name = record.path.split('/').at(-1);
  await output(`public/${name}`, await read(record.path), { ...record, path: `public/${name}` });
}

// Square, opaque app masters for pipelines that apply their own mask (iOS).
for (const size of [1024, 2048]) await pngOutput(`brand/app/useful-bot-app-icon-${size}.png`, await render(logo, size), size, { opaque: true, family: 'primary' });
// The iOS target's catalog takes copies, so they can't drift from the masters.
await output('ios/UsefulBot/Resources/Assets.xcassets/AppIcon.appiconset/useful-bot-app-icon-1024.png', await read('brand/app/useful-bot-app-icon-1024.png'), { kind: 'png', width: 1024, height: 1024, alpha: false, family: 'primary' });
await output('ios/UsefulBot/Resources/Assets.xcassets/useful-bot-badge.imageset/useful-bot-badge.svg', logo + '\n', { kind: 'svg' });
// macOS draws its own icon silhouette: the app icon master carries the grid's rounded tile.
const macEntries = [];
for (const points of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
  const size = points * scale;
  const name = `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`;
  const png = await render(appIcon, size);
  await pngOutput(`brand/app/macos/UsefulBot.iconset/${name}`, png, size, { family: 'macos' });
  await pngOutput(`brand/app/AppIcon.appiconset/${name}`, png, size, { family: 'macos' });
  macEntries.push({ idiom: 'mac', size: `${points}x${points}`, scale: `${scale}x`, filename: name });
}
await output('brand/app/AppIcon.appiconset/Contents.json', JSON.stringify({ images: macEntries, info: { author: 'xcode', version: 1 } }, null, 2) + '\n', { kind: 'appiconset' });
// ICNS PNG chunks work cross-platform; iconutil is not a build dependency.
const icnsChunks = [];
for (const [type, name] of [['icp4', 'icon_16x16.png'], ['icp5', 'icon_32x32.png'], ['icp6', 'icon_32x32@2x.png'], ['ic07', 'icon_128x128.png'], ['ic08', 'icon_256x256.png'], ['ic09', 'icon_512x512.png'], ['ic10', 'icon_512x512@2x.png'], ['ic11', 'icon_16x16@2x.png'], ['ic12', 'icon_32x32@2x.png'], ['ic13', 'icon_128x128@2x.png'], ['ic14', 'icon_256x256@2x.png']]) {
  const png = await read(`brand/app/macos/UsefulBot.iconset/${name}`);
  const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(8 + png.length, 4);
  icnsChunks.push(header, png);
}
const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns');
icnsHeader.writeUInt32BE(8 + icnsChunks.reduce((total, chunk) => total + chunk.length, 0), 4);
await output('brand/app/macos/UsefulBot.icns', Buffer.concat([icnsHeader, ...icnsChunks]), { kind: 'icns' });

for (const name of ['avatar-1024', 'x-profile', 'linkedin-profile']) await pngOutput(`brand/social/${name}.png`, await render(logo, 1024), 1024, { opaque: true, family: 'primary' });
// Link previews: head and name as one centred group on black.
for (const [name, width, height] of [['og-image', 1200, 630], ['github-social-preview', 1280, 640]]) {
  const d = Math.round(height * .5), size = Math.round(d * .36), gap = d / 4;
  const left = (width - d - gap - wordWidth(size)) / 2;
  const art = xml(black.replace('V1024H0', `V${height}H0`).replace('H1024', `H${width}`) + face(d, left + d / 2, height / 2) + word(r1(left + d + gap), r1(height / 2 + capHeight(size) / 2), size), width, height);
  await pngOutput(`brand/social/${name}.png`, await render(art, width, height), width, { height, opaque: true });
}

// Both the browser and native animation consume the same timing source.
// The head floats and blinks. The wave and squash tracks belonged to the retired
// full-body mascot; they stay in motion.json for the native decoder but drive nothing.
const motion = JSON.parse(await read('brand/source/motion.json'));
assert(motion.duration > 0 && Number.isFinite(motion.duration), 'Invalid motion duration');
for (const key of ['float', 'blink']) {
  const track = motion[key];
  assert(track.length >= 2 && track[0][0] === 0 && track.at(-1)[0] === 100, `Incomplete motion track: ${key}`);
  for (const [index, frame] of track.entries()) assert(frame.length === 2 && frame.every(Number.isFinite) && (!index || frame[0] > track[index - 1][0]), `Invalid keyframe: ${key}`);
}
const keyframes = (name, track, transform) => `@keyframes ${name}{${track.map(([at, value]) => `${at}%{transform:${transform(value, at)}}`).join('')}}`;
const motionStyle = `<style>
  #float{animation:ub-float 2.8s ease-in-out infinite}
  #eye-left,#eye-right{animation:ub-blink 2.8s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
  ${keyframes('ub-float', motion.float, value => `translateY(${value}px)`)}
  ${keyframes('ub-blink', motion.blink, value => `scaleY(${value})`)}
  @media(prefers-reduced-motion:reduce){#float,#eye-left,#eye-right{animation:none;transform:none}}
</style>`.replaceAll('2.8s', `${motion.duration}s`);
// The float runs on a wrapper: a CSS transform would replace the placement matrix.
await svgOutput('brand/motion/useful-bot-animated.svg', xml(motionStyle + `<g id="float">${face(MARK_DIAMETER, 512, 512)}</g>`));

// Native layers: the avatar face (with its hairline edge, since the app shows them on
// light surfaces too) in the mark's placement, one group per layer.
const avatarFaceSource = (await read('brand/source/avatar-face.svg')).toString();
const faceGroup = id => {
  const open = avatarFaceSource.indexOf(`<g id="${id}">`);
  assert(open >= 0, `Face group missing: ${id}`);
  let depth = 0, at = open;
  const tags = /<\/?g\b[^>]*>/g;
  tags.lastIndex = open;
  for (let tag; (tag = tags.exec(avatarFaceSource));) {
    depth += tag[0].startsWith('</') ? -1 : tag[0].endsWith('/>') ? 0 : 1;
    if (!depth) { at = tag.index + tag[0].length; break; }
  }
  return avatarFaceSource.slice(open, at);
};
const motionLayers = { head: ['head'], mouth: ['mouth'], glasses: ['glasses'], 'eye-left': ['eye-left'], 'eye-right': ['eye-right'] };
for (const [part, groups] of Object.entries(motionLayers)) {
  const layer = xml(`<g transform="matrix(${markScale} 0 0 ${markScale} ${512 - markScale * 512} ${512 - markScale * 420})">${groups.map(faceGroup).join('')}</g>`);
  await pngOutput(`brand/motion/native/${part}.png`, await render(optimized(layer), 1024), 1024, { family: 'motion-layer', layer: part });
}

// Avatars come from the circle-head face source. The head circle's fill is the tint.
const avatarFace = (await read('brand/source/avatar-face.svg')).toString();
const palette = JSON.parse(await read('brand/source/avatar-palette.json'));
for (const [color, { fill }] of Object.entries(palette)) {
  assert(/^[a-z]+$/.test(color) && /^#[A-Fa-f0-9]{6}$/.test(fill), `Invalid avatar color: ${color}`);
  const avatar = optimize(avatarFace, { plugins: [{ name: 'tintAvatarHead', fn: () => ({ element: {
    enter(node, parent) {
      if (parent.attributes?.id === 'head' && node.attributes.fill) node.attributes.fill = fill;
    },
  } }) }] }).data;
  const vector = await svgOutput(`brand/avatars/${color}.svg`, avatar);
  await pngOutput(`brand/avatars/${color}-256.png`, await render(vector, 256), 256, { family: 'avatar', avatarColor: color });
}

await output('brand/source/provenance.json', JSON.stringify({
  masters: {
    head: { path: 'brand/source/useful-bot-head.svg', sha256: sha(await read('brand/source/useful-bot-head.svg')) },
    logo: { path: 'brand/source/useful-bot-logo.svg', sha256: sha(await read('brand/source/useful-bot-logo.svg')) },
    appIconMacos: { path: 'brand/source/useful-bot-app-icon-macos.svg', sha256: sha(await read('brand/source/useful-bot-app-icon-macos.svg')) },
  },
  headDiameter: { mark: +(MARK_DIAMETER / 1024).toFixed(4), favicon: .84, macosTile: +(MARK_DIAMETER / 1024).toFixed(4) },
  avatarPaletteSha256: sha(await read('brand/source/avatar-palette.json')),
  avatarFaceSha256: sha(await read('brand/source/avatar-face.svg')),
  motionTimingSha256: sha(await read('brand/source/motion.json')),
  note: 'Hand-written vector masters. The head reuses the avatar-face geometry unchanged, in Original white, without its hairline edge. Every raster renders from these SVGs. No raster source, AI enhancement or bitmap trace.',
  font: { family: 'Inter', weight: 600, version: '4.1', license: 'SIL OFL 1.1', source: 'https://github.com/rsms/inter/releases/tag/v4.1', sha256: sha(fontBytes) },
}, null, 2) + '\n', { kind: 'provenance' });
await writeFile(resolve(root, 'brand/asset-manifest.json'), JSON.stringify({ version: 1, files: records.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2) + '\n');
execFileSync(process.execPath, [resolve(root, 'scripts/check-brand-assets.mjs')], { cwd: root, stdio: 'inherit' });
// Build a fresh archive. Stable file order and timestamps make repeat builds byte-identical.
const archiveFiles = [];
async function collect(dir) {
  for (const entry of (await readdir(resolve(root, dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${dir}/${entry.name}`;
    assert(!entry.isSymbolicLink(), `Do not package symlinks: ${path}`);
    if (entry.isDirectory()) await collect(path); else archiveFiles.push(path);
  }
}
await collect('brand');
// ZIP STORE entries: PNG/font assets are already compressed. No platform zip dependency.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
const locals = [], central = []; let zipOffset = 0;
for (const path of archiveFiles) {
  const bytes = await read(path), name = Buffer.from(path), crc = crc32(bytes);
  const local = Buffer.alloc(30), entry = Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
  entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
  entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20);
  entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(zipOffset, 42);
  locals.push(local, name, bytes); central.push(entry, name); zipOffset += local.length + name.length + bytes.length;
}
const centralBytes = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(archiveFiles.length, 8); end.writeUInt16LE(archiveFiles.length, 10);
end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(zipOffset, 16);
await writeFile(resolve(root, 'useful-bot-brand-assets.zip'), Buffer.concat([...locals, centralBytes, end]));
console.log(`Built ${records.length} registered outputs. Packaged ${archiveFiles.length} brand files.`);
