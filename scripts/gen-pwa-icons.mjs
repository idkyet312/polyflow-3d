// Generates the PWA PNG icons (192, 512, maskable-512) with no image deps —
// builds raw RGBA pixel buffers and encodes them as PNG via Node's zlib.
// Art: dark radial background + a stylised green cannabis leaf + "$" glint,
// matching the Drug Tycoon theme. Run: node scripts/gen-pwa-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// --- tiny PNG encoder (truecolor + alpha, 8-bit) -------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  // Filtered scanlines (filter 0 = none) prefixed per row.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- simple software drawing into an RGBA buffer -------------------------
function makeIcon(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  // Background: radial dark blue→near-black (with safe padding if maskable).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (x - cx) / cx, dy = (y - cy) / cy;
      const r = Math.min(1, Math.hypot(dx, dy));
      // #13203a center → #070b18 edge
      buf[i + 0] = Math.round(0x13 + (0x07 - 0x13) * r);
      buf[i + 1] = Math.round(0x20 + (0x0b - 0x20) * r);
      buf[i + 2] = Math.round(0x3a + (0x18 - 0x3a) * r);
      buf[i + 3] = 255;
    }
  }
  // Leaf: 7 blades radiating up from a base point, drawn as filled triangles.
  const baseY = cy + size * 0.22;
  const scale = (maskable ? 0.42 : 0.52) * size;   // smaller for maskable safe zone
  const blades = 7;
  const green = [0x3f, 0xc6, 0x5f];
  for (let b = 0; b < blades; b++) {
    const k = b - (blades - 1) / 2;
    const ang = -Math.PI / 2 + k * 0.42;            // fan upward
    const len = scale * (1 - Math.abs(k) * 0.14);
    const tipX = cx + Math.cos(ang) * len;
    const tipY = baseY + Math.sin(ang) * len;
    const halfW = scale * 0.085 * (1 - Math.abs(k) * 0.12);
    const px = Math.cos(ang + Math.PI / 2), py = Math.sin(ang + Math.PI / 2);
    // Triangle: base-left, base-right, tip.
    fillTri(buf, size,
      cx - px * halfW, baseY - py * halfW,
      cx + px * halfW, baseY + py * halfW,
      tipX, tipY, green);
  }
  // Stalk.
  fillTri(buf, size, cx - 3, baseY, cx + 3, baseY, cx, baseY + scale * 0.22, [0x2f, 0x7d, 0x34]);
  return buf;
}

function fillTri(buf, size, x0, y0, x1, y1, x2, y2, col) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-6) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w0 = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area;
      const w1 = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 >= -0.01 && w1 >= -0.01 && w2 >= -0.01) {
        const i = (y * size + x) * 4;
        buf[i + 0] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 255;
      }
    }
  }
}

for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]) {
  const png = encodePng(size, size, makeIcon(size, maskable));
  writeFileSync(join(OUT, name), png);
  console.log('wrote', name, png.length, 'bytes');
}
