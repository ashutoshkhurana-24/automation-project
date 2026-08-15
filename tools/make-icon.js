// Draw the home-screen icon: the board, with one room lit — as glass.
//
// Two wrong turns got here, and both are worth keeping.
//
// The first icon was a soft amber blob on paper. It said "warm light", which
// is true and is also what half the lamp apps on a phone say, and a gaussian
// smudge loses everything it has at the size an icon is actually read.
//
// The second was four flat opaque squares. Legible, unmistakably this app —
// and completely solid, which is the one thing the interface is not. The page
// is panes of glass floating over a photograph; an icon made of stickers
// describes a different product.
//
// So: the same board, made of the same material. A cold atmosphere behind,
// panes that are barely there and take their colour from what is behind them,
// a specular rim that catches light along the top-left edge exactly as the
// tiles do, and one pane burning warm and bleeding into its neighbours. The
// shapes stay hard — that is what survives being shrunk to a fingernail — but
// nothing in it is opaque.
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
  // ── the atmosphere ──────────────────────────────────────────────────────
  // Glass shows nothing over a flat field, so the ground is weather: a cool
  // wash falling from the top-left, a deeper blue in the far corner, and the
  // house's own warmth rising from the foot. This is the backdrop the panes
  // are going to bend, in miniature.
  const dawn = Math.exp(-((u + 0.15) ** 2 + (v + 0.10) ** 2) / 0.42);
  const deep = Math.exp(-((u - 1.05) ** 2 + (v - 1.10) ** 2) / 0.46);
  let r = 224 - 52 * deep + 22 * dawn;
  let g = 231 - 42 * deep + 20 * dawn;
  let b = 239 - 16 * deep + 14 * dawn;

  // The lit pane throws light into the atmosphere before any glass is drawn,
  // which is what stops the panes reading as stickers laid on a gradient.
  const L = PANES[LIT];
  const lx = (L.x0 + L.x1) / 2, ly = (L.y0 + L.y1) / 2;
  const glow = Math.exp(-(((u - lx) ** 2 + (v - ly) ** 2)) / 0.085);
  const near = Math.exp(-(((u - lx) ** 2 + (v - ly) ** 2)) / 0.020);
  r += 34 * glow + 16 * near;
  g += 10 * glow + 2 * near;
  b -= 52 * glow + 34 * near;

  const aa = px * 1.1;           // roughly one pixel of feathering

  for (const p of PANES) {
    const d = rrect(u, v, p.x0, p.y0, p.x1, p.y1, RAD);
    const inside = 1 - smooth(-aa, aa, d);
    if (inside <= 0.001) continue;

    // ── the pane ──────────────────────────────────────────────────────────
    // A veil rather than a fill: it lifts what is behind it toward white and
    // keeps its colour, which is what a frosted pane does and what a painted
    // one cannot. The lit pane is the exception — light rising to a level,
    // the way a tile fills.
    let pr = mix(r, 253, 0.26), pg = mix(g, 251, 0.26), pb = mix(b, 247, 0.26);
    if (p.lit) {
      const up = smooth(p.y1 + CELL * 0.10, p.y0 + CELL * 0.34, v);
      pr = mix(pr, 246, up * 0.86);
      pg = mix(pg, 191, up * 0.86);
      pb = mix(pb, 98, up * 0.86);
    }

    // ── the specular rim ──────────────────────────────────────────────────
    // The thing that makes glass read as glass: a hairline that is bright at
    // the top-left, almost gone across the middle, and returns at the foot —
    // the same gradient the tiles lay in their border box. Lit panes catch it
    // warm and hold it all the way round; the rest barely catch it at all.
    const t = ((u - p.x0) / CELL + (v - p.y0) / CELL) / 2;          // 0 top-left → 1 bottom-right
    const sheen = 0.92 * (1 - smooth(0.0, 0.46, t)) + 0.42 * smooth(0.62, 1.0, t) + 0.10;
    const edge = smooth(-aa, -aa - 0.011, d) * sheen * (p.lit ? 1 : 0.55);
    if (p.lit) { pr = mix(pr, 255, edge); pg = mix(pg, 244, edge); pb = mix(pb, 214, edge); }
    else { pr = mix(pr, 255, edge * 0.9); pg = mix(pg, 255, edge * 0.9); pb = mix(pb, 255, edge * 0.9); }

    // A whisper of shadow just outside the pane, so it floats rather than sits.
    const cast = smooth(0.030, 0, d) * (1 - inside) * 0.5;
    r = mix(r, r * 0.93, cast); g = mix(g, g * 0.93, cast); b = mix(b, b * 0.94, cast);

    r = mix(r, pr, inside); g = mix(g, pg, inside); b = mix(b, pb, inside);
  }

  return [clamp(r), clamp(g), clamp(b)];
}

for (const size of [180, 192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, board));
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)} (${fs.statSync(file).size} bytes)`);
}
