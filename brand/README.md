# OpenPers brand

The mark is an open ring – the **O** of *Open* – with a dot in its gap: a person stepping out of
the circle. Open source, built around people.

| File | Use |
|---|---|
| `openpers-mark.svg` | App icon, favicon, avatars – white mark on the blue tile |
| `openpers-mark-square.svg` | Square tile without rounded corners (iOS rounds it itself) |
| `openpers-mark-blue.svg` | Mark without tile on light backgrounds |
| `openpers-mark-mono.svg` | Single colour via `currentColor` (embedding, print, stamps) |
| `openpers-logo.svg` / `openpers-logo-dark.svg` | Mark + wordmark for light / dark backgrounds |
| `social-preview.svg` | GitHub social preview (1280 × 640) |
| `png/` | Raster exports: mark 512/1024 px, logos at 4×, social preview |

The wordmark uses **Atkinson Hyperlegible Next Bold** (SIL Open Font License), converted to
outlines – no font installation needed.

## Colours

| Token | Hex | Use |
|---|---|---|
| Blue | `#2340C8` | Tile, "Pers" on light backgrounds (gradient from `#3B5BEA`) |
| Ink | `#16233F` | "Open" on light backgrounds |
| Light ink | `#E7ECF6` | "Open" on dark backgrounds |
| Light blue | `#8EA3FF` | "Pers" on dark backgrounds |
| Night | `#0E1525` | Dark background |

## Usage

- Keep clear space of at least half the tile height around the logo.
- Do not stretch, rotate, recolour the ring separately from the dot, or close the ring.
- Minimum size: 16 px for the tile, 96 px width for the full logo.
- In the app, a company can upload its own logo (*Settings → Company*); the OpenPers mark is
  only the fallback.

## Regenerating

```bash
npm install --no-save opentype.js@1.3.4
node brand/tools/make-logo.cjs
CHROME="/path/to/chrome" bash brand/tools/export-png.sh
```

The logo files are part of the repository and licensed under the AGPL-3.0 like the code. The name
"OpenPers" and the logo identify this project – forks that change the software substantially
should use their own name and logo to avoid confusion.
