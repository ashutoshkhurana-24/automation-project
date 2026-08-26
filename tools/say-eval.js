#!/usr/bin/env node
/* Does the house *understand* a sentence — and does it understand it for free?
 *
 * `say-speech-review.js` checks the wording of replies. Nothing checked the
 * other half, which is the half that switches things on: what address a
 * sentence resolves to, and whether it got there on the free grammar path or
 * had to pay a model call.
 *
 * That second question is the whole economics of /api/say. Measured on the
 * live hub: a spoken command resolved by `speechWords()` answers in ~0.9s and
 * costs nothing, while the same sentence through the model takes ~4.3s. So a
 * word missing from SAY_FILLER is not a tidiness problem, it is a four-fold
 * slowdown on every sentence that contains it.
 *
 * Offline and free by default: it lifts the parser out of server.js and runs it
 * against this house's own rooms and circuits. Nothing is sent, nothing is
 * switched, and no key is needed — so it can be run on every edit.
 *
 *   node tools/say-eval.js              # the free path only
 *   node tools/say-eval.js --verbose    # show every case
 *
 * A case marked `model` is not a failure. It is a sentence we have decided the
 * grammar should not try to resolve — anything ambiguous, anything naming a
 * kind across the house, and every question. Those must reach the model, and
 * the eval asserts they are *not* resolved locally, which is the direction that
 * matters: a wrong local resolution switches the wrong thing in silence.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const rawSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
/* Block comments blanked rather than dropped, keeping the line count, so an
   apostrophe inside one cannot open a string that never closes — the same trap
   say-speech-review.js records. */
const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');

function lift(name) {
  const re = new RegExp('^(?:function|const|let|var)\\s+' + name + '\\b');
  const start = src.findIndex((l) => re.test(l));
  if (start < 0) throw new Error('cannot find a top-level ' + name + ' in server.js');
  const out = [];
  let brace = 0, paren = 0, bracket = 0;
  for (let i = start; i < src.length; i++) {
    const line = src[i];
    out.push(line);
    let inStr = null;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (inStr) { if (ch === '\\') k++; else if (ch === inStr) inStr = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '/' && line[k + 1] === '/') break;
      if (ch === '{') brace++; else if (ch === '}') brace--;
      else if (ch === '(') paren++; else if (ch === ')') paren--;
      else if (ch === '[') bracket++; else if (ch === ']') bracket--;
    }
    if (brace <= 0 && paren <= 0 && bracket <= 0) {
      const t = line.replace(/\/\/.*$/, '').trim();
      if (t.endsWith('}') || t.endsWith(';') || t.endsWith(')')) break;
    }
  }
  return out.join('\n');
}

/* The house the parser resolves against, built from the same two files the
   server reads. Only the *shapes* speechWords touches are needed — a room's
   slug and key, and a circuit's slug — so the fixture is small; but it is this
   house's real names, not invented ones, which is the point. */
function house() {
  const file = JSON.parse(fs.readFileSync(path.join(root, 'data', 'devices.json'), 'utf8'));
  const res = (file.payload && file.payload.response) || file.response || file;
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch { /* defaults */ }

  const byId = new Map();
  for (const d of res.devices || []) byId.set(String(d.record_id), d);

  /* Two shapes this file already records as traps, both hit while writing this:
     `area_devices` is a **comma-separated string**, not an array — iterating it
     walks character by character and finds no rooms at all — and the room's name
     is in `name`, not `sub_area_name`. It also carries trailing spaces. */
  const byRoom = new Map();
  for (const area of res.areas || []) {
    for (const dept of area.departments || []) {
      for (const sub of dept.sub_area || []) {
        const room = String(sub.name || '').trim().toUpperCase();
        if (!room) continue;
        const ids = String(sub.area_devices || '').split(',').map((x) => x.trim()).filter(Boolean);
        const recs = ids.map((id) => byId.get(id)).filter(Boolean);
        if (!recs.length) continue;
        byRoom.set(room, (byRoom.get(room) || []).concat(recs));
      }
    }
  }
  /* The console can rename a room, and the grammar resolves the new name — so
     the fixture has to apply the same map or every renamed room reads as absent. */
  for (const [from, to] of Object.entries(config.room_renames || {})) {
    const key = String(from).trim().toUpperCase();
    if (byRoom.has(key)) {
      const recs = byRoom.get(key);
      byRoom.delete(key);
      byRoom.set(String(to).trim().toUpperCase(), recs);
    }
  }
  return { byRoom, config };
}

const H = house();
const slugify = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* The collective names every room has, plus the declared groups, plus one entry
   per circuit — the same list circuitsOf() builds, reduced to the slugs. */
const CIRCUITS = new Map();
for (const [room, recs] of H.byRoom) {
  const slugs = new Set(['all', 'lights']);
  for (const g of (H.config.groups || [])) {
    if (String(g.room).toUpperCase() === room && (g.record_ids || []).length > 1) {
      slugs.add(slugify(String(g.label).replace(/^all\s+/i, '')));
      slugs.add('direct-lights');
      slugs.add('indirect-lights');
    }
  }
  for (const r of recs) slugs.add(slugify(String(r.device_name).replace(/\./g, '')));
  CIRCUITS.set(room, [...slugs].map((sl) => ({ slug: sl })));
}
const ROOMS = [...CIRCUITS.keys()].map((room) => ({ slug: slugify(room), key: room }));
for (const [alias, target] of Object.entries(H.config.room_aliases || {})) {
  const hit = ROOMS.find((r) => r.slug === slugify(target));
  if (hit) ROOMS.push({ slug: slugify(alias), key: hit.key });
}

const body = ['ACTIONS', 'WARMTH', 'isAction', 'pick', 'SAY_FILLER', 'SAY_PARTICLE',
  'SAY_NUMBER', 'SAY_DO', 'hinglishVerb', 'SAY_HINGLISH', 'SAY_ASKS', 'speechWords']
  .map(lift).join('\n\n')
  + '\n; return speechWords;';
// eslint-disable-next-line no-new-func
const speechWords = new Function('slug', 'roomTargets', 'circuitsOf', body)(
  slugify,
  () => ROOMS.map((r) => ({ slug: r.slug, name: r.key })),
  (key) => CIRCUITS.get(key) || [],
);

/* `want` is the address the free path must produce, or the string 'model' for a
   sentence it must decline. A case is written for the reason beside it, so a
   future edit that breaks one can tell whether the case or the code is wrong. */
const CASES = [
  ['English, plain', [
    ['ashu fan on', 'ashu/fan/on'],
    ['ashu fan off', 'ashu/fan/off'],
    ['master cobs 40', 'master/cobs/40'],
    ['living off', 'living/all/off'],
    ['ashu cobs down', 'ashu/cobs/down'],
    ['ashu cobs 40 warm', 'ashu/cobs/40+warm'],
    /* English puts the room last. It comes back as the canonical slug rather
       than the prefix that was said, which is what the rest of the pipeline
       wants anyway. */
    ['turn on the fan in ashu', 'ashu-room/fan/on'],
    /* Singular, and left singular: pick() matches a unique prefix, so `light`
       reaches `lights` without this function having to know about plurals. */
    ['switch off the light in harshit room', 'harshit-room/light/off'],
    ['switch off master room', 'master/all/off'],
  ]],
  ['Multi-word circuit names', [
    ['ashu foot light off', 'ashu/foot-light/off'],
    ['living main curtain open', 'living/main-curtain/open'],
    ['ashu bed spot on', 'ashu/bed-spot/on'],
    ['ashu direct lights on', 'ashu/direct-lights/on'],
    ['ashu indirect lights off', 'ashu/indirect-lights/off'],
  ]],
  ['Hinglish verbs', [
    ['ashu ka fan chalu karo', 'ashu/fan/on'],
    ['ashu fan band kar do', 'ashu/fan/off'],
    ['living ka main curtain khol do', 'living/main-curtain/open'],
    ['master ke cobs tez karo', 'master/cobs/up'],
    ['master ke cobs dheema karo', 'master/cobs/down'],
    /* `parda` stays as it is said. hindiCircuits() resolves it downstream by
       kind, which is what keeps it off LIVING's CURTAIN ROPE — a light. Living
       has two motors, so it resolves to an ambiguity and a refusal, which is
       the correct outcome and not this function's business. */
    ['living ka parda rok do', 'living/parda/stop'],
  ]],
  /* Every one of these paid a model call before 2026-08-27, purely because a
     tail word survived the split. They are the reason SAY_PARTICLE grew. */
  /* Every way somebody ends a sentence. These drifted once — "chalu kar do"
     matched and "chalu kar dena" did not, for 1.75s against 0.1s. */
  /* The room comes back as it was said, because pick() resolves a prefix and
     nothing downstream needs it spelled out. Only the room-last cases above are
     canonical, since those have to be moved to the front to begin with. */
  ['However the sentence ends', [
    ['ashu ka ac chalu kar dena', 'ashu/ac/on'],
    ['ashu ka ac band kar dijiye', 'ashu/ac/off'],
    ['ashu ka fan chalu kro', 'ashu/fan/on'],
    ['ashu ke cobs kam kar dena', 'ashu/cobs/down'],
    ['living ka parda khol dena', 'living/parda/open'],
  ]],
  ['A value with a Hinglish tail', [
    ['master cobs full kar do', 'master/cobs/100'],
    ['master ke cobs full karo', 'master/cobs/100'],
    ['master cobs 100 kar do', 'master/cobs/100'],
    ['ashu ka fan on kar dena', 'ashu/fan/on'],
    ['master cobs thoda tez karo', 'master/cobs/up'],
    ['master ke cobs thoda kam kar do', 'master/cobs/down'],
    ['ashu cobs poora kar do', 'ashu/cobs/100'],
  ]],
  /* The direction that matters. A wrong local resolution switches the wrong
     circuit in silence; falling through to the model only costs time. */
  ['Must reach the model, never the grammar', [
    ['is the ashu fan on', 'model'],
    ['what is on', 'model'],
    ['kya chalu hai', 'model'],
    ['ashu room mein kya chalu hai', 'model'],
    ['ashu ka ac chal raha hai', 'model'],
    ['saare ac band kar do', 'model'],
    ['living aur dining band kar do', 'model'],
    ['netflix laga do', 'model'],
    ['ashu all lights off', 'model'],
    ['tell me a joke', 'model'],
  ]],
];

let pass = 0, fail = 0, local = 0, viaModel = 0;
const bad = [];
const verbose = process.argv.includes('--verbose');

for (const [group, cases] of CASES) {
  const lines = [];
  for (const [text, want] of cases) {
    const got = speechWords(text);
    const addr = got ? got.room + '/' + got.circuit + '/' + got.action : 'model';
    const ok = addr === want;
    if (ok) pass++; else { fail++; bad.push([text, want, addr]); }
    if (got) local++; else viaModel++;
    if (verbose || !ok) lines.push('    ' + (ok ? ' ' : '!') + ' ' + text.padEnd(34) + addr
      + (ok ? '' : '   want ' + want));
  }
  if (lines.length) { console.log('\n  ' + group); console.log(lines.join('\n')); }
}

const total = pass + fail;
console.log('\n  ' + pass + '/' + total + ' correct   '
  + local + ' on the free path, ' + viaModel + ' handed to the model');
if (fail) {
  console.log('\n  ' + fail + ' wrong:');
  for (const [text, want, got] of bad) console.log('    ' + text + '  want ' + want + '  got ' + got);
}
process.exit(fail ? 1 : 0);
