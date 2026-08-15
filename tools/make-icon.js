// Draw the home-screen icon: one pane, with light rising through it.
//
// Three wrong turns got here, and all of them are worth keeping.
//
// A soft amber blob on paper said "warm light", which is true and is also what
// half the lamp apps on a phone say, and a gaussian keeps nothing at the size
// an icon is actually read.
//
// Four flat opaque squares were legible and unmistakably this app — and
// completely solid, which is the one thing the interface is not. An icon made
// of stickers describes a different product than a page made of glass.
//
// Four *glass* squares fixed the material and kept the real problem: a grid.
// A 2x2 reads as a launcher, a folder, an app-picker — the most generic shape
// on a home screen, and at 60px four small panes are four smudges. The board
// is what the app shows; it is not what the app is *about*.
//
// So: one pane, big enough to be a shape rather than a texture, with light
// rising inside it and blooming past its edges into a cold room. That is the
// whole design in a single object — the glow is one gradient and never a box,
// the rim catches light only where a lamp is on, and the only colour anywhere
// is the light itself.
//
// Written by hand because the box has no image libraries. A PNG is a few
// chunks and a zlib stream, and a generated asset nobody can regenerate is
// worse than sixty lines of encoder.
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
      const [r, g, b] = pixel(x / (size - 1), y / (size - 1), 1 / size);
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
const mix = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Signed distance to a rounded rectangle: negative inside, positive outside,
// and in units of the icon's width, so one pixel is 1/size everywhere. This is
// what lets the edges be antialiased without supersampling the whole square.
function rrect(u, v, x0, y0, x1, y1, rad) {
  const hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
  const px = Math.abs(u - (x0 + hw)) - (hw - rad);
  const py = Math.abs(v - (y0 + hh)) - (hh - rad);
  const outside = Math.hypot(Math.max(px, 0), Math.max(py, 0));
  return outside + Math.min(Math.max(px, py), 0) - rad;
}

// ── the pane ───────────────────────────────────────────────────────────────
// One rounded square, held slightly above centre so the light it throws has
// somewhere to fall. The margin keeps it inside the squircle iOS masks it to.
const M = 0.175;
const RAD = 0.20;
const PANE = { x0: M, y0: M - 0.015, x1: 1 - M, y1: 1 - M - 0.015 };
const H = PANE.y1 - PANE.y0;

// How far up the pane the light reaches. Not full: a lamp at its level, which
// is what every tile in the app draws.
const FILL = 0.62;

function board(u, v, px) {
  // ── the room ────────────────────────────────────────────────────────────
  // Cold, and unevenly so — glass shows nothing over a flat field. Light from
  // somewhere off the top-left, depth in the far corner.
  const dawn = Math.exp(-((u + 0.18) ** 2 + (v + 0.14) ** 2) / 0.40);
  const deep = Math.exp(-((u - 1.05) ** 2 + (v - 1.12) ** 2) / 0.44);
  let r = 223 - 54 * deep + 24 * dawn;
  let g = 230 - 44 * deep + 22 * dawn;
  let b = 239 - 17 * deep + 15 * dawn;

  // ── the light in the air ────────────────────────────────────────────────
  // Thrown before the glass is drawn, and reaching well past the pane, because
  // a lamp lights the room it is in. Two falloffs: a wide wash and a tighter
  // one at the source, since a single blur radius never reads as light.
  const lx = (PANE.x0 + PANE.x1) / 2;
  const ly = PANE.y1 - H * FILL * 0.42;
  const d2 = (u - lx) ** 2 + (v - ly) ** 2;
  const wide = Math.exp(-d2 / 0.115);
  const near = Math.exp(-d2 / 0.028);
  r += 30 * wide + 20 * near;
  g += 9 * wide + 4 * near;
  b -= 46 * wide + 40 * near;

  const aa = px * 1.1;
  const d = rrect(u, v, PANE.x0, PANE.y0, PANE.x1, PANE.y1, RAD);
  const inside = 1 - smooth(-aa, aa, d);

  // A whisper of shadow outside the pane, so it floats rather than sits.
  const cast = smooth(0.045, 0, d) * (1 - inside);
  r *= 1 - 0.07 * cast; g *= 1 - 0.07 * cast; b *= 1 - 0.055 * cast;

  if (inside > 0.001) {
    // The glass: a veil that lifts what is behind it toward white and keeps
    // its colour. Frosted, never painted.
    let pr = mix(r, 253, 0.24), pg = mix(g, 251, 0.24), pb = mix(b, 247, 0.24);

    // The light rising to its level. One gradient, never a box — the edge
    // where a fill meets a bloom is a seam, and this is why there is no fill.
    // Rises: full at the foot, gone by the level it reaches. Written the
    // wrong way round first, which hung the light from the ceiling.
    const up = smooth(PANE.y1 - H * FILL, PANE.y1 + H * 0.05, v);
    pr = mix(pr, 247, up * 0.94);
    pg = mix(pg, 191, up * 0.94);
    pb = mix(pb, 96, up * 0.94);

    // The specular rim: bright at the top-left, almost gone across the middle,
    // returning at the foot. This is the single thing that makes a pane read
    // as glass rather than as a rounded rectangle, and the app uses it for
    // exactly the same job.
    const t = ((u - PANE.x0) + (v - PANE.y0)) / (2 * H);
    const sheen = 0.95 * (1 - smooth(0, 0.44, t)) + 0.50 * smooth(0.60, 1, t) + 0.12;
    const edge = smooth(-aa, -aa - 0.013, d) * sheen;
    pr = mix(pr, 255, edge); pg = mix(pg, 247, edge); pb = mix(pb, 222, edge);

    r = mix(r, pr, inside); g = mix(g, pg, inside); b = mix(b, pb, inside);
  }

  return [clamp(r), clamp(g), clamp(b)];
}

for (const size of [180, 192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, board));
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)} (${fs.statSync(file).size} bytes)`);
}
