# Useful Bot asset report

## Deliverable

The logo is the bot's white circle head on black. It replaced the full-body mascot on 2026-09-29. Three hand-written SVG masters in `brand/source/` (the head, the logo and the macOS app icon) share one face geometry, copied unchanged from `brand/source/avatar-face.svg`. Every raster renders from them. No bitmap is embedded in an SVG and nothing is traced.

`brand/asset-manifest.json` is the machine-readable output inventory, with dimensions, alpha, byte sizes and SHA-256 hashes. `brand/source/provenance.json` records the master hashes, placements and the Inter font. `useful-bot-brand-assets.zip` packages the whole `brand/` folder. `brand/README.md` holds the usage rules.

## Outputs and dimensions

| Output | Dimensions / representations |
| --- | --- |
| Masters | Head, logo, macOS app icon and the two inverse masters, 1024 × 1024 viewBox |
| Mark, logo and app icon SVG exports | 1024 × 1024 viewBox |
| Wordmark | 740 × 170 viewBox |
| Horizontal lockup | 640 px tall viewBox, width fitted to the name |
| Stacked lockup | 1024 px wide viewBox, height fitted to the name |
| Editable text wordmark / lockups | Matching viewBoxes in `brand/source/*-text.svg` |
| Transparent and black PNGs | 2048, 1024, 512, 256, 128, 64 and 32 px |
| Inverse set (black head) | Mark and logo SVGs, inverse wordmark and lockups, `png/mark-inverse` and `png/white` at the same sizes |
| Favicon | SVG, DIB-backed ICO with 16/32/48 px, PNG at 16/32 px |
| Apple touch | 180 × 180 |
| PWA regular / maskable | Each at 192 × 192 and 512 × 512 |
| Square app masters | 1024 × 1024 and 2048 × 2048, opaque sRGB |
| macOS | Ten files in both `.iconset` and `.appiconset`, 16 to 1024 px; ICNS |
| iOS catalog copies | App icon 1024 PNG and the logo SVG in `useful-bot-badge.imageset` |
| Social avatars (default, X, LinkedIn) | Each 1024 × 1024 |
| Open Graph / GitHub preview | 1200 × 630 / 1280 × 640 |
| Motion | 1024 × 1024 SVG with a float and blink loop, and an HTML demo |
| Native motion layers | Five transparent 1024 × 1024 PNGs: head, mouth, glasses, eye-left, eye-right |
| Product bot avatars | 11 head-only SVGs (768-unit viewBox) and 256 × 256 PNGs |

## Removed with the old mascot

The seven supplied ChatGPT PNGs, the cleaned and positioned raster masters, the edge mask, the full-body vector master, the flat mark, the white-circle badge (SVGs, PNGs, the badge lockup and the badge social avatar) and the body and arm motion layers. Git history keeps them.

## Design decisions

The logo head sits at the Welcome tile's proportion (a 76 pt face box in a 112 pt tile, circle 62.2% of the width). The macOS icon uses Apple's 824 px tile at (100, 100) with a continuous-curvature corner of radius 185.4, and keeps the same proportion inside it. Favicons enlarge the head to 84% so it reads in a tab. The head's radius (31%) already sits inside the W3C maskable safe circle (40%), so the maskable PWA icons are the full-bleed logo.

The badge was dropped: the head is already a circle, so a circle outline around it added nothing.

## Commands

```sh
npm ci --prefix scripts/brand-tools
npm run brand:build
npm run brand:check
```

`brand:build` validates the masters, writes the output folders, runs the checks and packages `brand/`. Once dependencies are installed, regeneration is offline.

## Checks

`brand:check` verifies every registered output's hash, size, sRGB profile and alpha; that the head is centred at its expected extent in every primary, favicon and macOS PNG; that maskable art stays inside the safe circle; that each master keeps the avatar face's glasses and eyes and has no body or arms; that the mark's silhouette matches the avatar face placed the same way; that the native layers reassemble into the face; the ICO, ICNS, PWA manifest and both Xcode catalogs; and that no generated file under `brand/` is unregistered.

## Platform references

- [Apple asset catalog app icons](https://developer.apple.com/documentation/xcode/configuring-your-app-icon)
- [Apple Icon Composer](https://developer.apple.com/documentation/Xcode/creating-your-app-icon-using-icon-composer)
- [W3C maskable safe zone](https://www.w3.org/TR/appmanifest/#icon-masks)
- [Inter 4.1 source and license](https://github.com/rsms/inter/releases/tag/v4.1)
