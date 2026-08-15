// Draw the home-screen icon: the board, with one room lit.
//
// The old icon was a soft amber blob on paper. It said "warm light", which is
// true but is also what half the lamp apps on a phone say, and a gaussian
// smudge loses everything it has at 60px — a home screen icon is read at the
// size of a fingernail, so it has to be built out of edges rather than out of
// falloff.
//
// This is the app's own picture of itself: a bento of panes with exactly one
// of them burning. That is literally what the page is, it survives being
// shrunk because the shapes are hard, and it carries the one rule the whole
// design rests on — the chrome is neutral and the only colour is the light a
// lamp is making.
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

// ── the board ──────────────────────────────────────────────────────────────
// Four panes. The one that is lit is top-left, the same corner the page puts
// its brightest room in.
const M = 0.135;                 // margin: keeps everything inside the squircle
const GAP = 0.052;
const CELL = (1 - 2 * M - GAP) / 2;
const RAD = 0.072;
const LIT = 0;                   // index of the burning pane

const PANES = [0, 1, 2, 3].map((i) => {
  const col = i % 2, row = (i - (i % 2)) / 2;
  const x0 = M + col * (CELL + GAP);
  const y0 = M + row * (CELL + GAP);
  return { x0, y0, x1: x0 + CELL, y1: y0 + CELL, lit: i === LIT };
});

function board(u, v, px) {
  // Ground: warm paper, a touch darker than the panes so they sit on it, with
  // the corners easing off.
  const vig = 1 - 0.10 * Math.hypot(u - 0.5, v - 0.5) * 1.5;
  let r = 235 * vig, g = 228 * vig, b = 215 * vig;

  // The lit pane throws light onto the board before anything is drawn over it,
  // which is what stops the icon reading as four flat stickers.
  const L = PANES[LIT];
  const lx = (L.x0 + L.x1) / 2, ly = (L.y0 + L.y1) / 2;
  const halo = Math.exp(-(((u - lx) ** 2 + (v - ly) ** 2)) / 0.075);
  r += 8 * halo; g -= 10 * halo; b -= 58 * halo;

  const aa = px * 1.1;           // roughly one pixel of feathering

  for (const p of PANES) {
    const d = rrect(u, v, p.x0, p.y0, p.x1, p.y1, RAD);
    const inside = 1 - smooth(-aa, aa, d);
    if (inside <= 0.001) continue;

    let pr, pg, pb;
    if (p.lit) {
      // The lamp, as the tiles draw it: light rising to its level rather than
      // a filled box. Warm at the foot, paper at the head.
      const up = smooth(p.y1 + CELL * 0.06, p.y0 + CELL * 0.30, v);
      pr = mix(250, 232, up); pg = mix(240, 173, up); pb = mix(224, 74, up);
    } else {
      pr = 252; pg = 249; pb = 244;
    }

    // A hairline rim, bright on the lit pane and barely there on the others —
    // the same signal the page uses to say a circuit is on.
    const rim = smooth(-aa, -aa - (p.lit ? 0.016 : 0.010), d);
    if (p.lit) { pr = mix(pr, 255, rim * 0.75); pg = mix(pg, 240, rim * 0.75); pb = mix(pb, 205, rim * 0.75); }
    else { pr = mix(pr, 232, rim * 0.5); pg = mix(pg, 227, rim * 0.5); pb = mix(pb, 218, rim * 0.5); }

    r = mix(r, pr, inside); g = mix(g, pg, inside); b = mix(b, pb, inside);
  }

  return [clamp(r), clamp(g), clamp(b)];
}

for (const size of [180, 192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, board));
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)} (${fs.statSync(file).size} bytes)`);
}
