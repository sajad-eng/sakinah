// Build a proper multi-size Windows .ico (classic BMP/DIB entries + AND mask)
// from src/assets/icons/icon.png, so both NSIS and the exe's embedded icon are valid.
'use strict';

const fs = require('fs');
const path = require('path');

let PNG;
try {
  PNG = require('pngjs').PNG;
} catch {
  console.error('pngjs missing');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'assets', 'icons', 'icon.png');
const OUT = path.join(ROOT, 'build', 'icon.ico');

function boxResize(src, W, H) {
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy0 = Math.floor((y * src.height) / H);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * src.height) / H));
    for (let x = 0; x < W; x++) {
      const sx0 = Math.floor((x * src.width) / W);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * src.width) / W));
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
          const i = (sy * src.width + sx) * 4;
          const al = src.data[i + 3] / 255;
          wsum += 1;
          r += src.data[i] * al;
          g += src.data[i + 1] * al;
          b += src.data[i + 2] * al;
          a += al;
        }
      }
      const o = (y * W + x) * 4;
      if (a > 0) {
        out[o]     = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / wsum) * 255);
      }
    }
  }
  return { width: W, height: H, data: out };
}

function dibEntry(img) {
  const { width: W, height: H, data } = img;
  const pxSize = W * H * 4;
  const andRow = Math.ceil(W / 32) * 4; // mask rows padded to 32 bits
  const maskSize = andRow * H;
  const bi = Buffer.alloc(40);
  bi.writeUInt32LE(40, 0);            // biSize
  bi.writeInt32LE(W, 4);              // biWidth
  bi.writeInt32LE(H * 2, 8);          // biHeight (XOR + AND)
  bi.writeUInt16LE(1, 12);            // biPlanes
  bi.writeUInt16LE(32, 14);           // biBitCount
  bi.writeUInt32LE(0, 16);            // BI_RGB (bottom-up BGRA)
  bi.writeUInt32LE(pxSize + maskSize, 20);

  const px = Buffer.alloc(pxSize);
  for (let y = 0; y < H; y++) {
    const srcRow = H - 1 - y;         // bottom-up
    for (let x = 0; x < W; x++) {
      const s = (srcRow * W + x) * 4;
      const d = (y * W + x) * 4;
      px[d] = data[s + 2];            // B
      px[d + 1] = data[s + 1];        // G
      px[d + 2] = data[s];            // R
      px[d + 3] = data[s + 3];        // A
    }
  }
  const mask = Buffer.alloc(maskSize); // all opaque (alpha channel rules)
  return Buffer.concat([bi, px, mask]);
}

const png = PNG.sync.read(fs.readFileSync(SRC));
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = [];
for (const sz of SIZES) {
  if (sz > png.width) continue;
  const img = sz === png.width
    ? { width: png.width, height: png.height, data: png.data }
    : boxResize(png, sz, sz);
  entries.push({ size: sz, data: dibEntry(img) });
}

// ICONDIR
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);              // type: icon
dir.writeUInt16LE(entries.length, 4);

const catalogSize = 6 + 16 * entries.length;
const dirents = [];
let offset = catalogSize;
for (const e of entries) {
  const de = Buffer.alloc(16);
  de.writeUInt8(e.size >= 256 ? 0 : e.size, 0);
  de.writeUInt8(e.size >= 256 ? 0 : e.size, 1);
  de.writeUInt8(0, 2);               // colors
  de.writeUInt8(0, 3);               // reserved
  de.writeUInt16LE(1, 4);            // planes
  de.writeUInt16LE(32, 6);           // bitcount
  de.writeUInt32LE(e.data.length, 8);
  de.writeUInt32LE(offset, 12);
  offset += e.data.length;
  dirents.push(de);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([dir, ...dirents, ...entries.map((e) => e.data)]));
console.log(`icon.ico ok: ${entries.length} sizes (${SIZES.join(',')}), ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
