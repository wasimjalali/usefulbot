# Useful Bot brand assets

The logo is the bot's head: the white circle face with black glasses, eyes and a smile, on black.

Primary background: black, `#000000`. Primary foreground: white, `#FFFFFF`. Face features use `#141413`; the tongue is `#FF8FA3`.

The old full-body mascot (body, raised arms, the ChatGPT raster source and the white-circle badge) was retired on 2026-09-29. Its sources and outputs are deleted; git history keeps them.

## Masters and provenance

Three hand-written SVGs in `source/` are the authority. Every raster is rendered from them. There is no raster source.

| Master | What it is |
| --- | --- |
| `source/useful-bot-head.svg` | The mark: the white head on a transparent 1024 artboard |
| `source/useful-bot-logo.svg` | The primary logo: the same head on a black 1024 square |
| `source/useful-bot-head-inverse.svg` | The inverse mark: the black head on a transparent 1024 artboard |
| `source/useful-bot-logo-inverse.svg` | The inverse logo: the black head on a white 1024 square |
| `source/useful-bot-app-icon-macos.svg` | The macOS app icon: the head on Apple's rounded tile, transparent outside it |

The head is the face from `source/avatar-face.svg` in its Original white (palette id `ink`). Its geometry is copied unchanged, in the face source's own units (circle centre 512, 420, radius 352, a 768-unit face box). Each master wraps it in one `<g id="face">` placement matrix. The logo drops the avatar's 10% hairline edge, because it always sits on black. The check fails if a master's glasses, eyes or placement drift from the face source, or if the head stops matching the avatar face silhouette.

`source/provenance.json` records the master hashes, the placements and the font. `asset-manifest.json` lists every generated path with dimensions, alpha, size and SHA-256. Generated files must be rebuilt from their sources, never edited.

## Inverse set

For white surfaces there's a black-head version. A plain recolor would turn the face into a black blob, so every colour flips: the head is `#000000`; the glasses, eyes and mouth are `#FFFFFF`; the eye highlights are `#000000`. The tongue stays `#FF8FA3`. Geometry and placement are identical, and the check asserts the inverse face is exactly the white face with those colours swapped.

## Safe area and alignment

The mark and logo match the first-run Welcome tile: a 76 pt face box in a 112 pt black tile. The 768-unit face box spans 19/28 of the artboard, so the circle's diameter is 62.2% of the width (636.95 of 1024) and it's centred at (512, 512). The placement matrix is `matrix(.904762 0 0 .904762 48.762 132)`. Every size in a family uses the same placement.

The macOS icon follows Apple's grid: a 1024 canvas with an 824 × 824 tile at (100, 100) and corner radius 185.4. The tile is a continuous-curvature rounded square (60% corner smoothing), not a plain rounded rectangle. The head keeps the Welcome proportion inside it: diameter 512.55, centred.

Favicons are tiny, so their head fills 84% of the square.

The head's radius is 31% of the width, inside the [W3C maskable safe circle](https://www.w3.org/TR/appmanifest/#icon-masks) (40%). So the maskable PWA icons are the full-bleed logo. The check still asserts the safe circle on them.

## Wordmark and lockups

The wordmark is Inter Semibold (600), with native kerning and -0.018em tracking. Inter is a licensed existing typeface, not a custom font.

Production wordmarks and lockups use outlined letters. Matching `source/*-text.svg` files keep editable text. Install `source/fonts/Inter-SemiBold.ttf` to edit them in a design tool. The source SVGs also reference the included WOFF2 for browser use. Inter 4.1 is redistributed under the SIL Open Font License 1.1; the license is in `source/fonts/LICENSE.txt`.

The horizontal lockup puts the head (70% of the height) left of the name, a quarter of the head apart, with the name's cap height centred on the head. The stacked lockup centres the name one cap height below the head. Wordmark fills are white and meant for black backgrounds.

## Use by surface

| Surface | File | Recommended display size |
| --- | --- | --- |
| Logo on black (default) | `svg/useful-bot-logo.svg` or `png/black/useful-bot-<size>.png` | 24 px or larger |
| Logo on white | `svg/useful-bot-logo-inverse.svg` or `png/white/useful-bot-<size>.png` | 24 px or larger |
| Mark on your own white surface | `svg/useful-bot-mark-inverse.svg` or `png/mark-inverse/useful-bot-<size>.png` | 24 px or larger |
| Lockups and wordmark on white | `svg/useful-bot-*-inverse.svg` (black head, black name) | Same as the white versions |
| Mark on your own black surface | `svg/useful-bot-mark.svg` or `png/mark/useful-bot-<size>.png` | 24 px or larger |
| Navbar | `svg/useful-bot-lockup-horizontal.svg` | 160 px wide or larger |
| Narrow spaces | `svg/useful-bot-lockup-stacked.svg` | 96 px wide or larger |
| Text signature | `svg/useful-bot-wordmark.svg` | 112 px wide or larger |
| macOS app | `app/macos/UsefulBot.icns`, `app/AppIcon.appiconset/` | System sizes |
| Square app pipeline (iOS) | `app/useful-bot-app-icon-1024.png` | Source asset; the platform applies its own mask |
| Social avatar | `social/avatar-1024.png`, `social/x-profile.png`, `social/linkedin-profile.png` | Platforms crop to a circle; the head stays whole |
| Link preview | `social/og-image.png` | 1200 × 630 |
| GitHub repository preview | `social/github-social-preview.png` | 1280 × 640 |

White on black is the default and the app's look. Use black on white only where the surface is white and can't change: documents, invoices, light web pages, print. Never put the white mark on white or the black mark on black. A checkerboard is an inspection aid only and is never baked into an asset.

## Web and favicon package

`favicon/` contains an SVG favicon, a real multi-image ICO (16, 32 and 48 px), 16/32 PNGs and a 180 px Apple touch icon. `pwa/` contains 192/512 regular and maskable PNGs and `site.webmanifest`.

```html
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon-16x16.png" type="image/png" sizes="16x16">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#000000">
```

The build copies these files to root `public/` for portability. This repository's web service is an API with no browser UI, so it takes no copy.

## macOS and iOS

`app/AppIcon.appiconset/Contents.json` has the ten macOS slots: 16, 32, 128, 256 and 512 points at 1x and 2x. `app/macos/UsefulBot.iconset/` is the matching iconutil input and `app/macos/UsefulBot.icns` goes into the bundle. `macos/build-app.sh` copies the ICNS to `Resources/AppIcon.icns` and packages the brand files the app reads (`png/mark/useful-bot-128.png`, `png/black/useful-bot-256.png`, `svg/useful-bot-wordmark.svg`, the face, palette, motion timing and `motion/native/`).

The build also writes the iOS catalog's copies: `AppIcon.appiconset/useful-bot-app-icon-1024.png` (the square logo) and `useful-bot-badge.imageset/useful-bot-badge.svg` (the logo SVG; the image set keeps its old name so the Swift code is unchanged).

Apple also supports [Icon Composer](https://developer.apple.com/documentation/Xcode/creating-your-app-icon-using-icon-composer) for layered icons. This package supplies static masters and the [asset catalog workflow](https://developer.apple.com/documentation/xcode/configuring-your-app-icon); it doesn't include a layered `.icon` document.

## Motion

`motion/useful-bot-animated.svg` floats the head 7 units and blinks in a 2.8-second loop, then returns to idle. It stops at the static pose under `prefers-reduced-motion: reduce`. `motion/animation-demo.html` plays or stops it; static is the default. Use a static mark for favicons, app icons, avatars and navigation.

`source/motion.json` is the shared timing authority for CSS and SwiftUI. Its `wave` and `squashX`/`squashY` tracks belonged to the retired mascot; they stay for the native decoder and drive nothing.

`motion/native/` holds five transparent 1024 px layers for the native launch and loading views: `head` (with the avatar's hairline edge, for light surfaces), `mouth`, `glasses`, `eye-left` and `eye-right`, in the mark's placement. The eye centres in that artboard are (384.378, 531.080) and (640.085, 531.080).

## Product avatar colors

The one exception to monochrome is bot avatars. `source/avatar-palette.json` defines Original plus ten bright head colors. Each `avatars/<id>.svg` and `avatars/<id>-256.png` is built from `source/avatar-face.svg` on a transparent background, with the head circle's fill as the tint. The macOS app draws its bot heads from `source/avatar-face.svg` too. Avatar SVGs use the square viewBox `128 36 768 768`.

These colors are not brand tokens. The logo is always the Original white head on black.

## Regeneration and inspection

From the repository root, with the project's Node 24 runtime:

```sh
npm ci --prefix scripts/brand-tools
npm run brand:build
npm run brand:check
```

The build optimizes SVGs with SVGO, renders PNGs with sharp and outlines Inter with opentype.js. Their exact versions and lockfile are in `scripts/brand-tools/`. ICO, ICNS and ZIP encoding use Node buffers, so no platform image tool is needed. The build also writes `useful-bot-brand-assets.zip` with the whole `brand/` folder.

The build writes and overwrites; it never deletes an output it no longer makes. When a file drops out of the system, delete it by hand. `brand:check` fails on stray files under `svg/`, `png/`, `app/`, `favicon/`, `pwa/`, `social/`, `avatars/` and `motion/native/`, but not in `source/` or the iOS catalogs, so check those two yourself.

Open `brand/preview.html` to see the system: the mark, the logo, the app icon at every size, favicons, lockups, the maskable preview and the rules.

## Naming and restrictions

`useful-bot-<size>.png` is square and named by raster pixels. `black` and `white` mean an opaque canvas of that colour; `mark` and `mark-inverse` are transparent. `-inverse` always means the black head. Editable sources live in `source/`; generated files live in their usage folders.

Never recolor the logo head (avatar tints are for bots only), stretch it, rotate it, crop into the circle, change the glasses, eyes or smile, add a body, outline or shadow, or place busy imagery behind it. Keep the aspect ratio and the clear space.

## Tagline and copy

Locked by the owner on 2026-10-06. Use each line verbatim in its place; don't write a new tagline or paraphrase one.

| Place | Copy |
| --- | --- |
| Social bios (X, LinkedIn, when the accounts exist), GitHub repo descriptions, README top line | Useful Bot is the free, open-source alternative to Grok Bot. Your own team of AI bots on your computer, on the AI plan you already pay for. |
| Website title, og:title | Useful Bot: a team of AI bots on your computer |
| Website meta description, og:description, JSON-LD | A free, open-source app that runs a team of AI bots on your computer, with the ChatGPT plan you already pay for, an API key or a local model. |
| Website hero | Pill "Available on macOS"; headline "Meet [logo] Useful Bot"; line "Your own team of AI bots on your computer. Use the ChatGPT plan you already pay for, an API key or a local model." |
| App welcome screen | Your own team of AI bots, on your computer. Use the AI plan you already pay for. |

Grok Bot is named only in the bio line. It stays off the website and out of the app. Never claim "no limits": the user's provider plan has its own limits.
