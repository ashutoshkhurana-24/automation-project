// Draw the home-screen icon: one downlight, and the cone it throws.
//
// Five wrong turns got here, and all of them are worth keeping.
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
// on a home screen, and at 60px four small panes are four smudges.
//
// One glass pane, which is what stood here until now, fixed the grid and had
// two faults of its own. **Its silhouette was the mask's silhouette**: a
// rounded square drawn inside the rounded square iOS crops to, which reads as
// a rendering fault rather than as a design — and on Android, where the 512 is
// declared `any maskable`, only the middle 80% *circle* is guaranteed, so the
// pane's four corners were being cut off by the very shape they echoed. And it
// was pale light on a pale room, so at 60px there was no dark for the light to
// be light against: a near-white square that vanished on a pale wallpaper. The
// app's own dark theme already knew this — after seven the pane stays dark and
// the light comes *out* of it.
//
// So: the room is dark, the object is not a rectangle, and the only colour is
// the light. A fitting under the roof, the cone it throws down through cold
// air, and the pool where that lands.
//
// The house came last and it is the room, not a badge. Asked for a home logo,
// the cheap answer is a pentagon laid over the picture, which is the most
// templated shape on a phone and would have been a second object competing
// with the lamp. Instead the outline *is* the room the light was already in —
// one polygon, giving both the line to draw and the interior to keep the light
// inside, so the beam stops at the walls and the pool sits on the floor. Its
// weight is even and its brightness is not: it reads how much light has landed
// where it passes, so it fades under the eaves and burns at the feet. A line
// of uniform strength is a logo pasted over a photograph. Nothing else is
// drawn — no door, no windows, no chimney, no type: each survives at 512 and
// is a smudge at 60, and none of them is what the app is about.
//
// The one detail that makes it *this* house rather than any lamp: the beam
// crosses the house's own colour scale as it falls. Cool white at the fitting,
// through the warm white at LAMP_PIVOT, to amber in the pool — the same three
// stops, the same 38 pivot and the same x^0.72 ramp as lampColour() in
// server.js, for the same reason recorded there. A straight cool-to-warm mix
// is mud; real light passes through a warm white on its way to candlelight.
// Amber therefore owns the wide bottom two thirds and the cool is a thin
// accent at the source, which is also true of the house: every fitting in it
// lives in the top half of the tune range. The outline reads its colour off
// that same ramp, so the roof is cool and the floor is amber and the whole
// picture is lit by one lamp rather than by three that happen to agree.
//
// Two things that are not decoration. The light is summed in **linear** space
// and encoded to sRGB once at the end, because adding glows in gamma space
// blows the core out and flattens the falloff — this is the difference between
// a beam and a white wedge. And the output is **dithered** by less than one
// level: a dark, low-contrast gradient across 512px bands visibly in 8 bits,
// and the noise that removes the banding reads as air, which a beam wants.
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

const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/* ── light arithmetic ────────────────────────────────────────────────────────
 * Everything between here and the encoder is in linear light. Two glows added
 * in sRGB do not make the brightness their sum, which is why a naively stacked
 * bloom always ends up as a flat white patch with a hard shoulder. */
const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const l2s = (v) => {
  v = Math.max(0, Math.min(1, v));
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
};
const lin = (h) => [1, 3, 5].map((i) => s2l(parseInt(h.slice(i, i + 2), 16)));
const mix3 = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * Math.max(0, Math.min(1, t)));

// The house's own colours, taken from server.js rather than re-chosen: --warm,
// --cool and LAMP_MID are what a lamp here is making, and this is a picture of
// one of them.
const COOL = lin('#7fb2e0');
const MID = lin('#ffedd2');
const WARM = lin('#f2a233');
const CORE = lin('#fffaf1');          // the lens itself, the one thing that clips
const NIGHT = lin('#0d131b');         // the room: cold, and never pure black, or
const NIGHT_DEEP = lin('#05070b');    // the mask edge disappears on a dark wallpaper

const LAMP_PIVOT = 0.38;
// lampColour(), in linear and on 0..1. Same pivot, same x^0.72 ramp.
const lamp = (t) => {
  const v = Math.max(0, Math.min(1, t));
  const ramp = (x) => Math.max(0, Math.min(1, x)) ** 0.72;
  return v >= LAMP_PIVOT
    ? mix3(MID, WARM, ramp((v - LAMP_PIVOT) / (1 - LAMP_PIVOT)))
    : mix3(MID, COOL, ramp((LAMP_PIVOT - v) / LAMP_PIVOT));
};

/* ── the house, the fitting, and what it throws ────────────────────────
 * Everything that carries meaning stays inside the middle 80% circle Android
 * may crop to, which is what sets the house's width and how low its feet sit.
 * No door, no windows, no chimney: each one is a detail that survives at 512
 * and is a smudge at 60, and none of them is what the app is about. */
const HOUSE = [
  [0.500, 0.215],                     // apex
  [0.775, 0.455],                     // right eave
  [0.775, 0.765],                     // right foot
  [0.225, 0.765],                     // left foot
  [0.225, 0.455],                     // left eave
];
const WALL = 0.0105;                  // half the outline's weight

const SRC = { x: 0.5, y: 0.325, r: 0.036 };
const SPREAD = 0.455;                 // tan of the half angle, about 24°
const THROW = 0.440;                  // the fitting to the floor, exactly
const FLOOR = SRC.y + THROW;

// Signed distance to the house: negative indoors. One number gives both the
// outline to draw and the room to keep the light inside, which is the whole
// reason the house is a polygon here and not a pair of drawn strokes.
function sdPoly(u, v, poly) {
  let d = Infinity, s = 1;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const ex = bx - ax, ey = by - ay;
    const wx = u - ax, wy = v - ay;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const cx = wx - ex * t, cy = wy - ey * t;
    d = Math.min(d, cx * cx + cy * cy);
    const a = v >= ay, b = v < by, c = ex * wy > ey * wx;
    if (a === b && b === c) s = -s;    // a ray crossed an edge; flip the sign
  }
  return s * Math.sqrt(d);
}

// How warm the light is at this height: cool under the roof, amber at the
// feet. The beam, the pool and the outline all read their colour from here, so
// the house is lit by one lamp rather than by three that happen to agree.
const heat = (v) => 0.12 + 0.88 * Math.max(0, Math.min(1, (v - SRC.y) / THROW));

function board(u, v, px) {
  const aa = px * 1.2;

  // ── the night outside ─────────────────────────────────────────
  // Cold, and uneven on purpose — light needs a room to be in, and a flat field
  // gives it nothing to fall across.
  const corner = Math.hypot(u - 0.5, v - 0.5) / 0.707;
  let L = mix3(NIGHT, NIGHT_DEEP,
    Math.min(1, smooth(0.40, 1.10, corner) * 0.85 + smooth(0.42, 0.02, v) * 0.4
    + smooth(0.86, 1.06, v) * 0.55));

  const add = (col, amt) => { for (let i = 0; i < 3; i++) L[i] += col[i] * amt; };

  const sd = sdPoly(u, v, HOUSE);
  // Indoors, softly. Not a hard clip: a lit house shows at its edges, and a
  // beam cut off exactly at a wall reads as a stencil rather than as light.
  const indoors = 1 - smooth(-aa, 0.030, sd);

  // ── the cone ─────────────────────────────────────────────────
  // Nothing above the fitting: a recessed light does not wash its own ceiling,
  // and that is the whole difference between this and a floating orb.
  const dy = v - SRC.y;
  if (dy > 0) {
    const q = Math.abs(u - SRC.x) / (dy * SPREAD + 1e-6);
    // Across the cone: a gaussian, so the beam has a shape without having an
    // edge. Down it: a soft falloff that still leaves something to land.
    const lat = Math.exp(-2.9 * q * q);
    const axial = Math.exp(-((dy / (THROW * 1.05)) ** 1.55)) * smooth(0, 0.05, dy);
    add(lamp(heat(v)), lat * axial * 1.05 * indoors);
  }

  // ── the light in the air ─────────────────────────────────────
  // Deliberately *not* held indoors, and the only thing here that is not: this
  // is the halo a lit house has from the street, and it is what stops the
  // outline reading as a sticker laid on a flat night. Weak, and cool, because
  // the room outside is cold — warm it and the whole icon silts up into one
  // brown field with no cold left for the beam to be warm against.
  const gx = u - SRC.x, gy = v - (SRC.y + 0.15);
  add(lamp(0.18), Math.exp(-(gx * gx + gy * gy) / 0.20) * 0.026);
  add(lamp(0.30), Math.exp(-(gx * gx + gy * gy) / 0.045) * 0.045);

  // ── the pool ────────────────────────────────────────────────
  // Where the beam lands, on the floor of the house. Narrower than it wants to
  // be: run it the width of the cone's base and it stops being a pool and
  // becomes a horizon, which is what the first four passes all drew.
  const pu = (u - SRC.x) / 0.175, pv = (v - FLOOR) / 0.040;
  add(lamp(0.97), Math.exp(-1.8 * (pu * pu + pv * pv)) * 0.40 * indoors);
  add(lamp(0.90), Math.exp(-1.2 * (((u - SRC.x) / 0.26) ** 2
    + ((v - FLOOR) / 0.070) ** 2)) * 0.020);

  // ── the fitting ──────────────────────────────────────────
  // Its bezel first, a ring of shadow that gives the source an object to be,
  // then the glare around the lens, then the lens. The glare has to stay
  // tighter than the bezel or it washes the one detail that stops this reading
  // as a moon.
  const d = Math.hypot(u - SRC.x, v - SRC.y);
  const bezel = smooth(SRC.r * 2.2, SRC.r * 1.05, d) * smooth(SRC.r * 0.92, SRC.r * 1.12, d);
  for (let i = 0; i < 3; i++) L[i] *= 1 - 0.66 * bezel;

  add(lamp(0.30), Math.exp(-(d * d) / 0.00065) * 0.28);
  add(CORE, Math.exp(-(d * d) / 0.00020) * 0.55);
  add(CORE, 1.15 * (1 - smooth(SRC.r - aa, SRC.r + aa, d)));

  // ── the outline ──────────────────────────────────────────
  // Drawn last, and drawn in the light it stands in: its colour comes off the
  // same ramp the beam does, so the roof is cool and the feet are amber, and
  // its strength is read from how much light has already landed here. A line
  // of even weight all the way round is a logo pasted over a photograph; a
  // line that brightens where the lamp reaches it is part of the room.
  const local = Math.min(1, (L[0] + L[1] + L[2]) / 3 / 0.16);
  const stroke = 1 - smooth(WALL - aa, WALL + aa, Math.abs(sd));
  add(lamp(heat(v)), stroke * (0.15 + 0.68 * local));

  // ── out ──────────────────────────────────────────────────────
  // Dithered by two thirds of a level. Deterministic, so the file is stable.
  const n = (a, b) => {
    const s = Math.sin(u * a + v * b) * 43758.5453;
    return s - Math.floor(s);
  };
  const grain = (n(12.9898, 78.233) + n(39.3468, 11.135) - 1) * 0.66;
  return L.map((c) => Math.max(0, Math.min(255, Math.round(l2s(c) + grain))));
}

for (const size of [180, 192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, board));
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)} (${fs.statSync(file).size} bytes)`);
}
