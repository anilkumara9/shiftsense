'use strict';
/**
 * make-icon.js — generate the Windows app icon with zero external deps.
 *
 * Draws the D Shift mark (dark rounded square + white ⇧ arrow, the same
 * double-shift glyph as the tray icon) by analytic pixel coverage at 4x
 * supersampling, encodes PNGs with Node's built-in zlib, and packs a
 * PNG-compressed multi-size .ico (valid per the Windows icon spec, Vista+).
 *
 * Outputs:
 *   build/icon.png  — 512x512 master PNG
 *   build/icon.ico  — 256/128/64/48/32/24/16 entries
 *
 * Run: node scripts/make-icon.js   (preflight checks the outputs exist;
 * regenerate any time the mark changes — the outputs are committed.)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- minimal PNG encoder (RGBA, filter-none rows) ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- the mark ---------- */
// Background: rounded square, vertical gradient #262a33 -> #14161a.
// Foreground: shift arrow (head + shaft) over a base bar, #eef1f5.
const BG_TOP = [38, 42, 51], BG_BOT = [20, 22, 26], FG = [238, 241, 245];
const ARROW = [ // unit-space polygon for the ⇧ arrow
  [0.50, 0.15], [0.79, 0.44], [0.63, 0.44], [0.63, 0.67],
  [0.37, 0.67], [0.37, 0.44], [0.21, 0.44],
];
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
}
function isForeground(u, v) {
  if (inPoly(u, v, ARROW)) return true;
  return inRoundRect(u, v, 0.29, 0.755, 0.71, 0.845, 0.03); // base bar
}
function isBackground(u, v) {
  return inRoundRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.21);
}
function render(size) {
  const SS = 4; // supersampling per axis
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (!isBackground(u, v)) continue;
          const t = v;
          let cr = BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t;
          let cg = BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t;
          let cb = BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t;
          if (isForeground(u, v)) { cr = FG[0]; cg = FG[1]; cb = FG[2]; }
          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const n = SS * SS, o = (y * size + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, out);
}

/* ---------- ICO packing (PNG-compressed entries) ---------- */
function buildICO(pngBySize) {
  const sizes = Object.keys(pngBySize).map(Number).sort((a, b) => b - a);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + sizes.length * 16;
  for (const s of sizes) {
    const png = pngBySize[s];
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; // 0 means 256
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...sizes.map(s => pngBySize[s])]);
}

function main() {
  const buildDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const pngs = {};
  for (const s of sizes) pngs[s] = render(s);
  fs.writeFileSync(path.join(buildDir, 'icon.png'), render(512));
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildICO(pngs));
  const icoKB = (fs.statSync(path.join(buildDir, 'icon.ico')).size / 1024).toFixed(1);
  const pngKB = (fs.statSync(path.join(buildDir, 'icon.png')).size / 1024).toFixed(1);
  console.log(`build/icon.png (512x512, ${pngKB} KB) and build/icon.ico (${sizes.join('/')}px, ${icoKB} KB) written`);
}
if (require.main === module) main();
module.exports = { render, buildICO, encodePNG };
