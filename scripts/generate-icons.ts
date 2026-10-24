// Rasterize our existing geometric shelf mark; no remote artwork or runtime dependency.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const label = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([size, label, data, crc]);
}
const lines = [[12, 12, 12, 36], [12, 36, 37, 36], [20, 12, 20, 29], [27, 15, 27, 29], [34, 10, 34, 29]] as const;
function mark(x: number, y: number) {
  return lines.some(([ax, ay, bx, by]) => {
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return (x - ax - t * (bx - ax)) ** 2 + (y - ay - t * (by - ay)) ** 2 <= 2.25;
  });
}
const root = new URL("../web/public/icons/", import.meta.url); mkdirSync(root, { recursive: true });
for (const [name, size, scale] of [["icon-192", 192, 1], ["icon-512", 512, 1], ["maskable-512", 512, 0.8], ["apple-180", 180, 1]] as const) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let coverage = 0;
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
      if (mark(((x + (dx + 0.5) / 4) / size * 48 - 24) / scale + 24, ((y + (dy + 0.5) / 4) / size * 48 - 24) / scale + 24)) coverage += 1 / 16;
    }
    for (const [channel, background, foreground] of [[0, 32, 234], [1, 60, 216], [2, 53, 164]] as const) raw[y * (size * 3 + 1) + 1 + x * 3 + channel] = Math.round(background + (foreground - background) * coverage);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  writeFileSync(new URL(`${name}.png`, root), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
