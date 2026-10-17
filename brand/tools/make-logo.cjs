// Generates the OpenPers brand SVGs into <repo>/brand. Wordmark glyphs are outlined from
// Atkinson Hyperlegible Next Bold (SIL OFL), so the files render identically without the font.
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');

// Run from the repository root:
//   npm install --no-save opentype.js@1.3.4 && node brand/tools/make-logo.cjs
const repo = path.resolve(__dirname, '../..');
const out = path.join(repo, 'brand');
fs.mkdirSync(out, { recursive: true });

const font = opentype.loadSync(path.join(repo, 'node_modules/@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-700-normal.woff'));

const C = {
  blue: '#2340C8',
  blueLight: '#3B5BEA',
  ink: '#16233F',
  inkDark: '#E7ECF6',
  blueOnDark: '#8EA3FF',
};

// ---- Mark: open ring ("O" of Open) with the head in its gap, on a 64×64 grid ----
const cx = 32, cy = 32, r = 16, stroke = 7;
const pt = (deg, rad = r) => [cx + rad * Math.cos((deg * Math.PI) / 180), cy + rad * Math.sin((deg * Math.PI) / 180)];
const gapFrom = -17, gapTo = -93; // ring runs clockwise from -17° round to -93°, leaving the top-right open
const [sx, sy] = pt(gapFrom);
const [ex, ey] = pt(gapTo);
const [hx, hy] = pt(-55);
const f = (n) => +n.toFixed(2);
const ringPath = `M${f(sx)} ${f(sy)}A${r} ${r} 0 1 1 ${f(ex)} ${f(ey)}`;

const glyphs = (fg) =>
  `<path d="${ringPath}" fill="none" stroke="${fg}" stroke-width="${stroke}" stroke-linecap="round"/>` +
  `<circle cx="${f(hx)}" cy="${f(hy)}" r="5.2" fill="${fg}"/>`;

const tile = (id) =>
  `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.blueLight}"/><stop offset="1" stop-color="${C.blue}"/></linearGradient></defs>` +
  `<rect width="64" height="64" rx="15" fill="url(#${id})"/>`;

const svg = (w, h, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;

// App icon / favicon: white mark on the blue tile.
const mark = svg(64, 64, tile('g') + glyphs('#fff'), 'OpenPers');
fs.writeFileSync(path.join(out, 'openpers-mark.svg'), mark);
fs.writeFileSync(path.join(out, 'openpers-mark-square.svg'), svg(64, 64, tile('g').replace('rx="15"', 'rx="0"') + glyphs('#fff'), 'OpenPers'));
// Mark without tile, in the brand blue (for light backgrounds) and as currentColor (for embedding).
fs.writeFileSync(path.join(out, 'openpers-mark-blue.svg'), svg(64, 64, glyphs(C.blue), 'OpenPers'));
fs.writeFileSync(path.join(out, 'openpers-mark-mono.svg'), svg(64, 64, glyphs('currentColor'), 'OpenPers'));

// ---- Wordmark: "Open" in ink, "Pers" in brand blue ----
function wordPaths(size, x, baseline, colors) {
  const tracking = -0.01 * size;
  let cursor = x;
  const parts = [];
  for (const [text, color] of colors) {
    let d = '';
    for (const ch of text) {
      const g = font.charToGlyph(ch);
      d += g.getPath(cursor, baseline, size).toPathData(2);
      cursor += (g.advanceWidth / font.unitsPerEm) * size + tracking;
    }
    parts.push(`<path d="${d}" fill="${color}"/>`);
  }
  return { body: parts.join(''), width: cursor - x };
}

function lockup(theme) {
  const size = 40;
  const capH = (font.tables.os2.sCapHeight / font.unitsPerEm) * size;
  const h = 64;
  const baseline = h / 2 + capH / 2;
  const text = wordPaths(size, 64 + 16, baseline, theme === 'dark' ? [['Open', C.inkDark], ['Pers', C.blueOnDark]] : [['Open', C.ink], ['Pers', C.blue]]);
  const w = Math.ceil(64 + 16 + text.width + 2);
  return svg(w, h, tile(`g-${theme}`) + glyphs('#fff') + text.body, 'OpenPers');
}
fs.writeFileSync(path.join(out, 'openpers-logo.svg'), lockup('light'));
fs.writeFileSync(path.join(out, 'openpers-logo-dark.svg'), lockup('dark'));

// ---- GitHub social preview (1280×640) ----
{
  const W = 1280, H = 640;
  const scale = 3.2;
  const size = 120;
  const capH = (font.tables.os2.sCapHeight / font.unitsPerEm) * size;
  const markSize = 64 * scale;
  const word = wordPaths(size, 0, 0, [['Open', C.inkDark], ['Pers', C.blueOnDark]]);
  const total = markSize + 56 + word.width;
  const x0 = (W - total) / 2;
  const yMid = 280;
  const taglineSize = 34;
  const tagline = wordPaths(taglineSize, 0, 0, [['Open-source HR software you host yourself', '#AAB6D3']]);
  const body =
    `<rect width="${W}" height="${H}" fill="#0E1525"/>` +
    // The open ring of the mark, large and faint, as background motif.
    `<g transform="translate(${W - 110} ${H - 30}) scale(9) translate(-32 -32)" opacity="0.6"><path d="${ringPath}" fill="none" stroke="#1F2C5C" stroke-width="${stroke}" stroke-linecap="round"/><circle cx="${f(hx)}" cy="${f(hy)}" r="5.2" fill="#1F2C5C"/></g>` +
    `<g transform="translate(${f(x0)} ${f(yMid - markSize / 2)}) scale(${scale})">${tile('gs')}${glyphs('#fff')}</g>` +
    `<g transform="translate(${f(x0 + markSize + 56)} ${f(yMid + capH / 2)})">${word.body}</g>` +
    `<g transform="translate(${f((W - tagline.width) / 2)} ${yMid + markSize / 2 + 90})">${tagline.body}</g>`;
  fs.writeFileSync(path.join(out, 'social-preview.svg'), svg(W, H, body, 'OpenPers – Open-source HR software you host yourself'));
}
console.log('written:', fs.readdirSync(out).join(', '));
