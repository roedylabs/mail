# Branding

Icons, logo and social preview of Roedy Mail, for the README, release notes,
articles, package listings and links. They show the default logo of the app:
the mark in `#3a1b06` on an apricot plate in `#f5a06e`. Instances with their
own branding (Administration › Branding) draw their logo themselves; these
files are only about the project.

All files are generated, do not edit them by hand: change
[`scripts/branding/generate.mjs`](../../scripts/branding/generate.mjs) and run
`just branding` (needs `rsvg-convert` from librsvg). `pnpm test` checks that the
SVG files are up to date and that the mark matches the one in the web app.

## Files

| File | Use |
|---|---|
| `svg/icon.svg`, `png/icon-{16…1024}.png` | App icon: rounded plate with lower edge, transparent corners |
| `favicon.ico` | Favicon with 16, 32, 48 and 256 px |
| `png/apple-touch-icon.png` | 180 px, square up to the edge (iOS rounds the corners itself) |
| `svg/icon-square.svg` | Square plate without rounding, for places that apply their own mask |
| `svg/icon-maskable.svg`, `png/icon-maskable-{192,512}.png` | Web app manifest `purpose: maskable`: the mark stays inside the safe zone |
| `svg/icon-monochrome.svg`, `png/icon-monochrome-512.png` | One colour with the mark cut out, e.g. manifest `purpose: monochrome` |
| `svg/mark-on-light.svg`, `svg/mark-on-dark.svg`, `png/mark-on-*-512.png` | Mark without plate, for light or dark backgrounds |
| `svg/logo-on-light.svg`, `svg/logo-on-dark.svg`, `png/logo-on-*.png` | Icon with the wordmark, for light or dark backgrounds (PNG at 2×) |
| `svg/social-light.svg`, `svg/social-dark.svg`, `png/social-*.png` | Social preview (Open Graph, GitHub) in 1200 × 630 |

## Guidelines

- Geometry: corners 35 % of the edge length, lower edge 7.5 % in the plate colour
  darkened by 8 %, mark 64 % of the plate, centred, no tilt.
- Wordmark: “Roedy Mail” in [Young Serif](../../crates/server/assets/fonts/OFL.txt)
  (SIL Open Font License), as paths in the SVG files; text `#2b221c` on light
  and `#f4ece2` on dark backgrounds (the `--fg` tokens of the app).
- Keep some space around the icon and logo, at least a quarter of the icon size.
  Do not recolour, rotate, stretch or add effects.
- Prefer the SVG files; use the PNG files where SVG is not accepted.
