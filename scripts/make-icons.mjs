// 依存なしで拡張アイコン PNG を生成する(紫の角丸四角 + 白い吹き出し)
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const PURPLE = [145, 71, 255];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// 角丸四角の内側か
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function pixel(x, y, s) {
  const u = x / s, v = y / s; // 0..1
  if (!inRoundRect(u, v, 0, 0, 1, 1, 0.22)) return [0, 0, 0, 0];
  // 吹き出し本体
  const bubble = inRoundRect(u, v, 0.18, 0.22, 0.82, 0.66, 0.1);
  // 吹き出しの尻尾(左下の三角)
  const tail = u >= 0.26 && u <= 0.46 && v >= 0.6 && v <= 0.82 && (v - 0.6) <= (u - 0.26) * 1.1 && (v - 0.6) <= (0.46 - u) * 3;
  // 本文の 3 本線
  const lineY = [0.34, 0.44, 0.54];
  const lines = lineY.some((ly) => Math.abs(v - ly) < 0.032 && u > 0.28 && u < (ly === 0.54 ? 0.6 : 0.72));
  if ((bubble || tail) && !lines) return [...WHITE, 255];
  return [...PURPLE, 255];
}
mkdirSync('public', { recursive: true });
for (const size of [16, 48, 128]) writeFileSync(`public/icon${size}.png`, png(size, pixel));
console.log('icons written');
