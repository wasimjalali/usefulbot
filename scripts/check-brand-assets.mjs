import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(new URL('./brand-tools/package.json', import.meta.url));
const sharp = require('sharp');
const { optimize } = require('svgo');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(resolve(root, path));
const manifest = JSON.parse(await read('brand/asset-manifest.json'));
const indexed = new Map(manifest.files.map(file => [file.path, file]));
assert.equal(indexed.size, manifest.files.length, 'Duplicate output paths');
const required = [
  'brand/README.md', 'brand/preview.html', 'brand/tokens.css', 'BRAND_ASSET_REPORT.md',
  'brand/motion/animation-demo.html', 'brand/motion/useful-bot-animated.svg',
  'brand/source/useful-bot-head.svg', 'brand/source/useful-bot-logo.svg', 'brand/source/useful-bot-app-icon-macos.svg',
  'brand/source/useful-bot-head-inverse.svg', 'brand/source/useful-bot-logo-inverse.svg',
  'brand/source/avatar-palette.json', 'brand/source/avatar-face.svg', 'brand/source/motion.json',
  'brand/source/fonts/Inter-SemiBold.ttf', 'brand/source/fonts/Inter-SemiBold.woff2', 'brand/source/fonts/LICENSE.txt',
  'brand/app/AppIcon.appiconset/Contents.json', 'brand/app/macos/UsefulBot.icns',
];
for (const name of ['mark', 'logo', 'app-icon-macos', 'wordmark', 'lockup-horizontal', 'lockup-stacked', 'mark-inverse', 'logo-inverse', 'wordmark-inverse', 'lockup-horizontal-inverse', 'lockup-stacked-inverse']) required.push(`brand/svg/useful-bot-${name}.svg`);
for (const group of ['mark', 'black', 'mark-inverse', 'white']) for (const size of [2048, 1024, 512, 256, 128, 64, 32]) required.push(`brand/png/${group}/useful-bot-${size}.png`);
const webFiles = ['favicon.svg', 'favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png', 'site.webmanifest'];
for (const file of webFiles) required.push(`public/${file}`);
for (const name of ['avatar-1024', 'og-image', 'github-social-preview', 'x-profile', 'linkedin-profile']) required.push(`brand/social/${name}.png`);
for (const size of [1024, 2048]) required.push(`brand/app/useful-bot-app-icon-${size}.png`);
for (const path of required) assert((await stat(resolve(root, path))).size > 0, `Missing/empty output: ${path}`);

function bounds(data, width, height, channels, opaque, light = false) {
  let left = width, top = height, right = -1, bottom = -1, count = 0, maxRadius = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    const visible = opaque ? (light ? Math.min(data[i], data[i + 1], data[i + 2]) < 223 : Math.max(data[i], data[i + 1], data[i + 2]) > 32) : data[i + channels - 1] > 32;
    if (!visible) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); count++;
    maxRadius = Math.max(maxRadius, Math.hypot((x + .5) / width - .5, (y + .5) / height - .5));
  }
  assert(count > 0, 'Empty artwork');
  return { left, top, right, bottom, count, maxRadius };
}

function checkSvg(svg, path) {
  optimize(svg, { plugins: [] }); // Strict XML parser, including malformed markup.
  assert(!/<(?:image|foreignObject|script|metadata)\b|data:image|base64|<!DOCTYPE|<!ENTITY|\bon\w+=/i.test(svg), `Unsafe/non-vector SVG: ${path}`);
  const viewBox = svg.match(/viewBox="([^"]+)"/);
  assert(viewBox, `No viewBox: ${path}`);
  const values = viewBox[1].trim().split(/[\s,]+/).map(Number);
  assert(values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0, `Invalid viewBox: ${path}`);
  assert(/<title\b/.test(svg), `No accessible title: ${path}`);
  assert(!/<svg\b[^>]*\b(?:width|height)=/.test(svg), `Fixed SVG dimensions: ${path}`);
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, `Duplicate IDs: ${path}`);
  for (const match of svg.matchAll(/url\(#([^)]+)\)/g)) assert(ids.includes(match[1]), `Broken gradient: ${path}`);
  for (const match of svg.matchAll(/<(?:radialGradient|linearGradient|clipPath|mask)\b[^>]*\bid="([^"]+)"/g)) assert(svg.includes(`url(#${match[1]})`), `Unused definition: ${path}`);
  assert(Buffer.byteLength(svg) < 60000, `SVG too large: ${path}`);
}

async function checkIco(bytes, path) {
  assert.equal(bytes.readUInt16LE(0), 0, path); assert.equal(bytes.readUInt16LE(2), 1, path);
  assert.equal(bytes.readUInt16LE(4), 3, path);
  let end = 54;
  for (const [index, size] of [16, 32, 48].entries()) {
    const e = 6 + index * 16;
    assert.equal(bytes[e], size); assert.equal(bytes[e + 1], size);
    assert.equal(bytes.readUInt16LE(e + 4), 1); assert.equal(bytes.readUInt16LE(e + 6), 32);
    const length = bytes.readUInt32LE(e + 8), offset = bytes.readUInt32LE(e + 12);
    assert.equal(offset, end); end += length; assert(end <= bytes.length);
    assert.equal(length, 40 + size * size * 4 + Math.ceil(size / 32) * 4 * size);
    assert.equal(bytes.readUInt32LE(offset), 40); assert.equal(bytes.readInt32LE(offset + 4), size);
    assert.equal(bytes.readInt32LE(offset + 8), size * 2);
    const expected = await sharp(await read('brand/favicon/favicon.svg')).resize(size, size).ensureAlpha().raw().toBuffer();
    let difference = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4, q = offset + 40 + ((size - y - 1) * size + x) * 4;
      for (let c = 0; c < 3; c++) difference += Math.abs(expected[p + c] - bytes[q + 2 - c]);
    }
    assert(difference / (size * size * 3) < 12, `ICO pixels corrupt: ${path}`);
  }
  assert.equal(end, bytes.length);
}

// The Welcome tile: a 76 pt face box in a 112 pt tile, so the 704-unit circle in a
// 768-unit face box spans 19/28 x 704/768 of the width.
const headRadius = 19 / 28 * 704 / 768 / 2;
let pngCount = 0, svgCount = 0;
for (const file of manifest.files) {
  assert(!file.path.startsWith('/') && !file.path.split('/').includes('..'), 'Unexpected output path');
  const bytes = await read(file.path);
  assert.equal(bytes.length, file.bytes, `File size drift: ${file.path}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `Regenerate changed output: ${file.path}`);
  if (file.kind === 'svg') { checkSvg(bytes.toString(), file.path); svgCount++; }
  if (file.kind === 'ico') await checkIco(bytes, file.path);
  if (file.kind !== 'png') continue;
  pngCount++;
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, file.width, file.path); assert.equal(metadata.height, file.height, file.path);
  assert.equal(metadata.space, 'srgb', file.path); assert(metadata.hasProfile, `No sRGB profile: ${file.path}`);
  assert.equal(metadata.hasAlpha, file.alpha, `Wrong alpha channel: ${file.path}`);
  assert(bytes.length < (file.width >= 1024 ? 5_000_000 : 1_000_000), `Oversized PNG: ${file.path}`);
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  if (file.alpha) {
    let partial = 0, opaque = 0;
    for (let i = 3; i < data.length; i += 4) { partial += data[i] > 0 && data[i] < 255; opaque += data[i] === 255; }
    assert(partial > 0 && opaque > 0, `No anti-aliasing or opaque art: ${file.path}`);
    for (const i of [3, (info.width - 1) * 4 + 3, (info.height - 1) * info.width * 4 + 3, data.length - 1]) assert.equal(data[i], 0, `Nontransparent corner: ${file.path}`);
  }
  const b = bounds(data, info.width, info.height, info.channels, !file.alpha, file.family === 'primary-inverse');
  assert(b.left > 0 && b.top > 0 && b.right < info.width - 1 && b.bottom < info.height - 1, `Clipped artwork: ${file.path}`);
  // Visible extents as fractions of the width: the head circle, or the macOS tile.
  const extent = { primary: headRadius, 'primary-inverse': headRadius, favicon: .42, macos: 412 / 1024 }[file.family];
  if (extent) {
    const tolerance = 2 / info.width;
    for (const [actual, expected] of [[b.left / info.width, .5 - extent], [b.top / info.height, .5 - extent], [(b.right + 1) / info.width, .5 + extent], [(b.bottom + 1) / info.height, .5 + extent]]) assert(Math.abs(actual - expected) < tolerance + .006, `Head alignment/distortion: ${file.path}`);
  }
  if (file.family === 'maskable') assert(b.maxRadius < .4, `Mascot outside PWA safe circle: ${file.path}`);
}

const masters = ['head', 'logo', 'app-icon-macos'].map(name => `brand/source/useful-bot-${name}.svg`);
const masterSources = await Promise.all(masters.map(async path => (await read(path)).toString()));
for (const [index, svg] of masterSources.entries()) {
  checkSvg(svg, masters[index]);
  for (const id of ['face', 'head', 'glasses', 'mouth', 'tongue', 'eye-left', 'eye-right', 'eye-highlight-left', 'eye-highlight-right']) assert(svg.includes(`id="${id}"`), `Missing editable group ${id}: ${masters[index]}`);
  assert(!/id="(?:body|arm-left|arm-right)"/.test(svg), `The retired full-body mascot is back: ${masters[index]}`);
  const colors = new Set(['#FFFFFF', '#000000', '#141413', '#FF8FA3']);
  for (const hex of svg.match(/#[A-Fa-f0-9]{6}\b/g)) assert(colors.has(hex.toUpperCase()), `Unexpected brand color: ${hex} in ${masters[index]}`);
}
// Inverse masters: the same face with every colour flipped (head black; glasses, eyes
// and mouth white; highlights black), so the face never turns into a black blob.
const inverseMasters = ['head-inverse', 'logo-inverse'].map(name => `brand/source/useful-bot-${name}.svg`);
const whiteFace = masterSources[0].match(/<g id="face"[^>]*>([\s\S]*)<\/g>\s*<\/svg>/)[1].trim();
const flipped = whiteFace.replace(/fill="#FFFFFF"(?=\/>)/, 'fill="#000000"').replaceAll('#141413', '#FFFFFF').replaceAll('stroke="#fff"', 'stroke="#000000"');
for (const path of inverseMasters) {
  const svg = (await read(path)).toString();
  checkSvg(svg, path);
  assert(svg.includes(flipped), `Inverse face must be the white face with its colours flipped: ${path}`);
  assert(!svg.includes('#141413') && /<circle[^>]*fill="#000000"/.test(svg), `Inverse head must be black with white features: ${path}`);
}
const animated = (await read('brand/motion/useful-bot-animated.svg')).toString();
assert(animated.includes('prefers-reduced-motion') && animated.includes('animation:none'), 'Reduced motion missing');

const provenance = JSON.parse(await read('brand/source/provenance.json'));
for (const master of Object.values(provenance.masters)) assert.equal(createHash('sha256').update(await read(master.path)).digest('hex'), master.sha256, `Master changed: rebuild assets (${master.path})`);
assert.equal(createHash('sha256').update(await read('brand/source/avatar-palette.json')).digest('hex'), provenance.avatarPaletteSha256, 'Avatar palette changed: rebuild assets');
assert.equal(createHash('sha256').update(await read('brand/source/avatar-face.svg')).digest('hex'), provenance.avatarFaceSha256, 'Avatar face changed: rebuild assets');
assert.equal(createHash('sha256').update(await read('brand/source/motion.json')).digest('hex'), provenance.motionTimingSha256, 'Motion timing changed: rebuild assets');
assert.equal(createHash('sha256').update(await read('brand/source/fonts/Inter-SemiBold.ttf')).digest('hex'), provenance.font.sha256, 'Font changed: rebuild assets');
const pwa = JSON.parse(await read('public/site.webmanifest'));
assert.equal(pwa.name, 'Useful Bot'); assert.equal(pwa.short_name, 'Useful Bot'); assert.equal(pwa.display, 'standalone');
assert.equal(pwa.theme_color, '#000000'); assert.equal(pwa.background_color, '#000000');
for (const purpose of ['any', 'maskable']) for (const size of [192, 512]) {
  const icon = pwa.icons.find(icon => icon.purpose === purpose && icon.sizes === `${size}x${size}`);
  assert(icon && icon.type === 'image/png'); assert(indexed.has(`public/${icon.src}`));
}
for (const name of webFiles) {
  const folder = name.startsWith('icon-') || name === 'site.webmanifest' ? 'pwa' : 'favicon';
  const expected = await read(`brand/${folder}/${name}`);
  assert((await read(`public/${name}`)).equals(expected), `Public copy differs: public/${name}`);
}
const app = JSON.parse(await read('brand/app/AppIcon.appiconset/Contents.json'));
assert.equal(app.images.length, 10);
for (const points of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
  const image = app.images.find(image => image.idiom === 'mac' && image.size === `${points}x${points}` && image.scale === `${scale}x`);
  assert(image, `Missing macOS ${points}pt @${scale}x`);
  const metadata = await sharp(await read(`brand/app/AppIcon.appiconset/${image.filename}`)).metadata();
  assert.equal(metadata.width, points * scale); assert.equal(metadata.height, points * scale);
}
const icns = await read('brand/app/macos/UsefulBot.icns');
assert.equal(icns.toString('ascii', 0, 4), 'icns'); assert.equal(icns.readUInt32BE(4), icns.length);
let offset = 8, chunks = 0;
while (offset < icns.length) {
  const length = icns.readUInt32BE(offset + 4); assert(length > 8 && offset + length <= icns.length);
  await sharp(icns.subarray(offset + 8, offset + length)).metadata(); offset += length; chunks++;
}
assert.equal(offset, icns.length); assert.equal(chunks, 11);

// The logo head must be the avatar face itself, only placed: render the face source
// with the viewBox that maps its circle onto the mark's, and compare silhouettes.
const faceSvg = (await read('brand/source/avatar-face.svg')).toString();
const markScale = headRadius * 2 * 1024 / 704;
const placedViewBox = `${-(512 - markScale * 512) / markScale} ${-(512 - markScale * 420) / markScale} ${1024 / markScale} ${1024 / markScale}`;
const placedFace = faceSvg.replace(/viewBox="[^"]+"/, `viewBox="${placedViewBox}"`);
const faceRender = await sharp(Buffer.from(placedFace.replace('<svg ', '<svg width="3072" height="3072" '))).resize(1024, 1024).ensureAlpha().raw().toBuffer();
const markRender = await sharp(await read('brand/svg/useful-bot-mark.svg')).resize(1024, 1024).ensureAlpha().raw().toBuffer();
let intersection = 0, union = 0;
for (let i = 3; i < faceRender.length; i += 4) {
  const f = faceRender[i] > 127, m = markRender[i] > 127; intersection += f && m; union += f || m;
}
assert(intersection / union > .99, `Logo head differs from the avatar face: ${intersection / union}`);

// Avatar tints must never alter eyes, glasses, highlights or geometry.
function eyeGeometry(svg) {
  const groups = {};
  optimize(svg, { plugins: [{ name: 'inspectImmutableFeatures', fn: () => ({ element: {
    enter(node) {
      if (['glasses', 'eye-left', 'eye-right'].includes(node.attributes.id)) groups[node.attributes.id] = JSON.stringify(node);
    },
  } }) }] });
  return groups;
}
const faceFeatures = eyeGeometry(faceSvg);
assert.equal(Object.keys(faceFeatures).length, 3);
for (const [index, svg] of masterSources.entries()) assert.deepEqual(eyeGeometry(svg), faceFeatures, `Logo changed eyes or glasses: ${masters[index]}`);
// Expected head silhouette: the source circle, untinted.
const headPixels = await sharp(Buffer.from(faceSvg)).resize(1024, 1024).ensureAlpha().raw().toBuffer();
const avatarPalette = JSON.parse(await read('brand/source/avatar-palette.json'));
assert.equal(Object.keys(avatarPalette).length, 40, '30 grid ids plus 10 legacy ids');
for (const color of Object.keys(avatarPalette)) {
  const svg = (await read(`brand/avatars/${color}.svg`)).toString();
  assert(svg.includes('viewBox="128 36 768 768"'), `Avatar crop/centering changed: ${color}`);
  assert(!/id="(?:body|arm-left|arm-right)"/.test(svg), `Avatar includes body or arms: ${color}`);
  assert.deepEqual(eyeGeometry(svg), faceFeatures, `Avatar changed eyes or glasses: ${color}`);
  const tinted = await sharp(Buffer.from(svg)).resize(1024, 1024).ensureAlpha().raw().toBuffer();
  for (let i = 3; i < tinted.length; i += 4) assert.equal(tinted[i], headPixels[i], `Avatar head silhouette/alpha changed: ${color}`);
}

// Reassembled native layers must look like the placed face, not a separate drawing.
const layers = ['head', 'mouth', 'glasses', 'eye-left', 'eye-right'];
const inputs = await Promise.all(layers.map(async part => ({ input: await read(`brand/motion/native/${part}.png`), left: 0, top: 0 })));
const assembled = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } }).composite(inputs).raw().toBuffer();
const expected = faceRender;
let error = 0;
for (let i = 0; i < assembled.length; i++) error += Math.abs(assembled[i] - expected[i]);
assert(error / assembled.length < .3, `Native layers differ from vector: ${error / assembled.length}`);
// Catch stale/unregistered generated files and incomplete source SVGs.
async function walk(folder) {
  for (const item of await readdir(resolve(root, folder), { withFileTypes: true })) {
    const path = `${folder}/${item.name}`;
    if (item.isDirectory()) await walk(path);
    else if (item.name.endsWith('.svg')) checkSvg((await read(path)).toString(), path);
    if (item.isFile() && /^brand\/(svg|png|app|favicon|pwa|social|avatars|motion\/native)\//.test(path)) assert(indexed.has(path), `Unregistered generated asset: ${path}`);
  }
}
await walk('brand');
console.log(`Brand checks passed: ${pngCount} PNGs, ${svgCount} SVG exports, ICO, ICNS, PWA and Xcode catalogs. Head agreement with the avatar face ${(intersection / union * 100).toFixed(2)}%.`);
