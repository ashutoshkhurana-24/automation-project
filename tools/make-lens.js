// Draw the displacement map that makes a pane refract.
//
// Blur and brightness can only ever say "there is something behind this".
// Refraction is what says "this is a solid, curved piece of glass": light
// passing through the thick edge is bent, so the picture behind the rim is
// displaced and compressed, exactly the way the reference shot looks.
//
// feDisplacementMap reads two channels of an image and moves each pixel of the
// backdrop by them: red drives x, green drives y, and 128 means "do not move".
// So this writes a map that is flat grey through the middle — the face of the
// pane leaves the picture where it is — and ramps toward the edges, where the
// glass curves and the light bends.
//
//   node tools/make-lens.js        -> data/lens.png
//
// Written by hand for the same reason as the icon: the box has no image
// libraries, and a generated asset nobody can regenerate is worse than forty
// lines of encoder.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'data', 'lens.png');
const SIZE = 320;
// How wide the bevel is, as a fraction of the pane. Thick glass has a wide
// one; too wide and the whole face swims, which reads as a bug rather than
// as a material.
const EDGE = 0.16;

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

const clamp01 = (v) => Math.max(0, Math.min(1, v));
// Smooth in and out, so the bevel has no hard line where it begins.
const ease = (t) => { const x = clamp01(t); return x * x * (3 - 2 * x); };

function pixel(u, v) {
  // How far into the bevel this pixel is, from each side.
  const left = ease((EDGE - u) / EDGE);
  const right = ease((u - (1 - EDGE)) / EDGE);
  const top = ease((EDGE - v) / EDGE);
  const bottom = ease((v - (1 - EDGE)) / EDGE);

  // Positive red samples from further right, so the left edge pulls the
  // picture outward and the right edge pulls it back — the compression you
  // see through the curve of a thick pane.
  const dx = left - right;
  const dy = top - bottom;

  return [
    Math.round(128 + dx * 127),
    Math.round(128 + dy * 127),
    128,
  ];
}

const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0;                                    // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b] = pixel(x / (SIZE - 1), y / (SIZE - 1));
    raw[o++] = r; raw[o++] = g; raw[o++] = b;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 2;                          // 8-bit, truecolour
fs.writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`wrote data/lens.png (${fs.statSync(OUT).size} bytes, ${SIZE}px, bevel ${EDGE * 100}%)`);
