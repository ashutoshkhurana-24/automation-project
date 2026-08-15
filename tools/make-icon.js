// Draw the home-screen icon: a warm lamp pooling on paper, which is the whole
// app in one square now that the interface is warm white rather than night. Written by hand because the box has no image
// libraries — a PNG is a few chunks and a zlib stream, and this keeps the icon
// reproducible instead of a binary nobody can regenerate.
//
//   node tools/make-icon.js        -> data/icon-180.png, icon-192.png, icon-512.png
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'data');

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;                                  // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x / (size - 1), y / (size - 1));
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;                        // 8-bit, truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Warm white paper, a lamp a little above centre, and the pool it throws below
// it — the same three ideas the cards are built on, in the same palette.
function lamp(u, v) {
  const cx = 0.5, cy = 0.42;
  const dx = u - cx, dy = v - cy;
  const d = Math.sqrt(dx * dx + dy * dy);

  // ground: warm white, easing very slightly at the corners
  const vig = 1 - 0.08 * Math.sqrt((u - .5) ** 2 + (v - .5) ** 2) * 1.4;
  let r = 253 * vig, g = 250 * vig, b = 245 * vig;

  // the pool the lamp throws downward
  // The pool: amber soaking into the paper rather than light thrown into dark,
  // so it subtracts blue instead of adding red.
  const pool = smooth(0.70, 0.0, Math.abs(u - cx) * 1.15) * smooth(1.06, 0.44, v) * 0.85;
  r -= 2 * pool; g -= 34 * pool; b -= 108 * pool;

  // the halo, two falloffs so it reads like light rather than a blurred disc
  const wide = Math.exp(-(d * d) / 0.040) * 0.85;
  const tight = Math.exp(-(d * d) / 0.0075);
  r -= 4 * wide * 0.5 + 2 * tight;
  g -= 40 * wide * 0.5 + 26 * tight;
  b -= 120 * wide * 0.5 + 96 * tight;

  // the source itself: the one saturated thing, the colour a lamp makes
  const core = smooth(0.10, 0.06, d);
  r = r * (1 - core) + 224 * core;
  g = g * (1 - core) + 180 * core;
  b = b * (1 - core) + 99 * core;

  return [clamp(r), clamp(g), clamp(b)];
}

for (const size of [180, 192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, lamp));
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)} (${fs.statSync(file).size} bytes)`);
}
