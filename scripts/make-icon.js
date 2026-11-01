'use strict';
/**
 * make-icon.js — generate the Windows app icon with zero external deps.
 *
 * Draws the ShiftSense mark — the Shift key itself: a deep blue keycap
 * tile (gradient anchored on the product accent rgb(0,92,209)) with a
 * bold white ⇧ arrow over its base bar and a soft inner highlight along
 * the top edge, like light catching a key. Analytic pixel coverage at 4x
 * supersampling, PNGs encoded with Node's built-in zlib, and a
 * PNG-compressed multi-size .ico (valid per the Windows icon spec, Vista+).
 *
 * Outputs:
 *   build/icon.png     — 512x512 master PNG
 *   build/icon.ico     — 256/128/64/48/32/24/16 entries
 *   renderer/icon.png  — 128x128, the icon the app actually loads at
 *                        runtime for the window and system tray
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
// Background: rounded square keycap, vertical two-stop gradient through
// the product accent rgb(0,92,209): brighter blue at the top edge,
// deepening below, so the tile reads as the brand color at any size.
// Foreground: bold shift arrow (head + shaft) over its base bar,
// near-white for maximum contrast against the blue.
const BG_TOP = [44, 123, 224], BG_MID = [0, 92, 209], BG_BOT = [0, 58, 138];
const FG = [250, 251, 253];
const ARROW = [ // unit-space polygon for the ⇧ arrow
  [0.50, 0.16], [0.78, 0.45], [0.625, 0.45], [0.625, 0.66],
  [0.375, 0.66], [0.375, 0.45], [0.22, 0.45],
];
function bgColor(v) {
  // v is unit-space; normalize across the tile (0.02..0.98) so the accent
  // sits at the tile's vertical middle, behind the arrow.
  const t = Math.min(1, Math.max(0, (v - 0.02) / 0.96));
  const [a, b, k] = t < 0.5 ? [BG_TOP, BG_MID, t * 2] : [BG_MID, BG_BOT, (t - 0.5) * 2];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
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
  return inRoundRect(u, v, 0.295, 0.75, 0.705, 0.84, 0.032); // base bar
}
function isBackground(u, v) {
  return inRoundRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.20);
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
          let [cr, cg, cb] = bgColor(v);
          // Soft inner highlight: a sheen along the top inner edge of the
          // keycap, strongest at the edge and gone by v=0.32. Background
          // only — the glyph stays flat near-white.
          const sheen = Math.pow(Math.max(0, 1 - (v - 0.02) / 0.30), 2) * 0.15;
          cr += (255 - cr) * sheen; cg += (255 - cg) * sheen; cb += (255 - cb) * sheen;
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
  const root = path.join(__dirname, '..');
  const buildDir = path.join(root, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const pngs = {};
  for (const s of sizes) pngs[s] = render(s);
  fs.writeFileSync(path.join(buildDir, 'icon.png'), render(512));
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildICO(pngs));
  // The runtime icon (window + system tray) comes from the same artwork:
  // reuse the ICO's 128px render so every surface shows the identical mark.
  const trayPath = path.join(root, 'renderer', 'icon.png');
  fs.writeFileSync(trayPath, pngs[128]);
  const icoKB = (fs.statSync(path.join(buildDir, 'icon.ico')).size / 1024).toFixed(1);
  const pngKB = (fs.statSync(path.join(buildDir, 'icon.png')).size / 1024).toFixed(1);
  const trayKB = (fs.statSync(trayPath).size / 1024).toFixed(1);
  console.log(`build/icon.png (512x512, ${pngKB} KB), build/icon.ico (${sizes.join('/')}px, ${icoKB} KB) and renderer/icon.png (128x128, ${trayKB} KB) written`);
}
if (require.main === module) main();
module.exports = { render, buildICO, encodePNG };
