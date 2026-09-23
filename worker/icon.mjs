/**
 * The app icon, drawn from code: iOS wants PNG touch icons (it ignores SVG),
 * and a repository of generated binaries would drift from the mark on the
 * page. The mark — a dot under two arcs — is rendered with signed distances
 * (anti-aliased edges at any size) and encoded as PNG with the platform's own
 * CompressionStream, which the Worker runtime and Node both provide.
 */

const BACKGROUND = [0x12, 0x15, 0x13];
const GLOW = [0x2a, 0x22, 0x14];
const AMBER = [0xff, 0xb3, 0x47];

// The mark on the page's 32-unit grid: a dot and two arcs of one centre, each
// spanning about 44 degrees either side of straight up, drawn 2.4 units wide.
const CENTER = [16, 19.3];
const DOT = { x: 16, y: 19, r: 2.6 };
const ARCS = [{ r: 8, half: 0.76 }, { r: 13, half: 0.766 }];
const STROKE = 2.4;

function arcDistance(px, py, radius, half) {
  const dx = px - CENTER[0];
  const dy = py - CENTER[1];
  const angle = Math.atan2(dx, -dy);
  if (Math.abs(angle) <= half) return Math.abs(Math.hypot(dx, dy) - radius) - STROKE / 2;
  const side = angle > 0 ? 1 : -1;
  const ex = CENTER[0] + side * radius * Math.sin(half);
  const ey = CENTER[1] - radius * Math.cos(half);
  return Math.hypot(px - ex, py - ey) - STROKE / 2;
}

/** RGB pixels of the icon, `size` square. Maskable icons keep the mark in the safe zone. */
export function iconPixels(size, { maskable = false } = {}) {
  const pixels = new Uint8Array(size * size * 3);
  // The mark spans y 5.1..21.6 on the grid (centre 13.35): shift it down onto
  // the icon's centre. Maskable icons shrink it into the 80% safe circle.
  const unit = (size / 32) * (maskable ? 0.78 : 1.0);
  const offsetX = (size - 32 * unit) / 2;
  const offsetY = (size - 32 * unit) / 2 + (16 - 13.35) * unit;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const gx = (x + 0.5 - offsetX) / unit;
      const gy = (y + 0.5 - offsetY) / unit;
      const distances = [Math.hypot(gx - DOT.x, gy - DOT.y) - DOT.r, ...ARCS.map((arc) => arcDistance(gx, gy, arc.r, arc.half))];
      const nearest = Math.min(...distances) * unit;
      const ink = Math.max(0, Math.min(1, 0.5 - nearest));
      const glow = 0.9 * Math.exp(-(((gx - DOT.x) ** 2 + (gy - DOT.y + 2) ** 2) / 90));
      const index = (y * size + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const base = BACKGROUND[channel] + (GLOW[channel] - BACKGROUND[channel]) * glow;
        pixels[index + channel] = Math.round(base + (AMBER[channel] - base) * ink);
      }
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Encode opaque RGB pixels as a PNG file. */
export async function encodePng(width, height, rgb) {
  const rows = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    rows[y * (1 + width * 3)] = 0;
    rows.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", await zlib(rows)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const ICONS = Object.freeze({
  "/apple-touch-icon.png": { size: 180 },
  "/icon-192.png": { size: 192 },
  "/icon-512.png": { size: 512 },
  "/icon-maskable-512.png": { size: 512, maskable: true },
});

const rendered = new Map();

/** The PNG for one icon path, rendered once per isolate. */
export function iconPng(path) {
  const spec = ICONS[path];
  if (!spec) return null;
  if (!rendered.has(path)) rendered.set(path, encodePng(spec.size, spec.size, iconPixels(spec.size, spec)));
  return rendered.get(path);
}
