#!/usr/bin/env node
/* Exercises houseReading() without a house.
 *
 * Lifts the pure functions straight out of server.js by line range and stubs
 * only the two things that are not pure: the `devices` map, which comes from the
 * real data/devices.json so the room and circuit names are the installer's own,
 * and the television and receiver links, which are faked here so a set can be
 * forced on or off without touching one.
 *
 * One eval, not several: separate eval() calls get separate scopes, so a `const`
 * declared in the first is invisible to the second. That cost an hour once.
 *
 * Run: node tools/say-reading-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const rawSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/* Block comments blanked before anything else, line numbers preserved.
 *
 * The bracket matching below cannot survive prose: this file's comments are full
 * of apostrophes — "the installer's own" — and one of those opens a string the
 * matcher then never closes, so it swallowed the rest of houseReading and left
 * its body at the top level. Blanking the comments and keeping the newlines is
 * cheaper than teaching the matcher English. */
const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');

/* Takes a whole statement from its first line, by matching brackets. Works for
   `function f() {}` and for a multi-line `const f = () => {}` alike, which is
   why it counts parens as well as braces and stops only when both are level. */
function lift(startLine) {
  const out = [];
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  for (let i = startLine - 1; i < src.length; i++) {
    const line = src[i];
    out.push(line);
    let inStr = null;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (inStr) { if (ch === '\\') k++; else if (ch === inStr) inStr = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '/' && line[k + 1] === '/') break;            // trailing comment
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

/* Looked up by name, not by line number. Hardcoding the numbers worked exactly
   once: adding thirty lines inside houseReading pushed liveCircuits down, the
   old number landed in the middle of another function's body, and the failure
   arrived as "on is not defined" from a line nobody had written. */
function lineOf(name) {
  const re = new RegExp('^(?:function|const|let|var)\\s+' + name + '\\b');
  const i = src.findIndex((l) => re.test(l));
  if (i < 0) throw new Error('cannot find a top-level ' + name + ' in server.js');
  return i + 1;
}

const WANT = ['roomKey', 'decodeLevel', 'isPrjRecord', 'shadowedByTv', 'isCurtainRecord',
  'isAcRecord', 'groupsIn', 'slug', 'roomsIndex', 'pick', 'HINDI_FAN', 'HINDI_CURTAIN',
  'hindiCircuits', 'circuitsOf', 'levelOf',
  'tuneOf', 'warmthName', 'title_', 'directlyRead', 'tvReading', 'avrReading',
  'readingOf', 'houseReading', 'liveCircuits'].map(lineOf);

const preamble = `
  const devices = __devices;
  var ROOM_RENAMES = {};
  let KIND_OVERRIDES = {};
  const GROUPS = __groups;
  var TV_READY = true;
  var AVR_READY = true;
  const tvs = __tvs;
  const avrs = __avrs;
  const tvList = () => [...tvs.values()].map((t) => t.snapshot());
`;

// ---------------------------------------------------------------- the house

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'devices.json'), 'utf8'));
const res = raw.payload.response;
const roomOf = new Map();
for (const area of res.areas || []) {
  for (const dept of area.departments || []) {
    for (const sub of dept.sub_area || []) {
      const room = String(sub.name || '').trim();
      for (const id of String(sub.area_devices || '').split(',')) {
        if (id.trim()) roomOf.set(Number(id), room);
      }
    }
  }
}
const __devices = new Map();
for (const record of res.devices || []) {
  __devices.set(record.record_id, { room: roomOf.get(record.record_id) || 'OTHER', record });
}

/* The install's own declared groups, built the way applyConfig() builds them —
   otherwise the folding below has nothing but the synthetic `lights` group to
   work with and the test would pass without exercising it. */
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const __groups = (cfg.groups || [])
  .filter((g) => g && g.room && Array.isArray(g.record_ids) && g.record_ids.length > 1)
  .map((g) => ({
    room: String(g.room).trim().toUpperCase(),
    label: g.label || 'All',
    slug: g.slug || String(g.label || 'all').replace(/^all\s+/i, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    record_ids: g.record_ids.map(Number).filter(Number.isFinite),
  }));

// ------------------------------------------------------- the fake screens

function fakeTv(room, state) {
  return {
    room,
    snapshot: () => ({
      record_id: 'tv-' + room, name: 'TV', room: room.toUpperCase(),
      is_tv: true, is_avr: false,
      tv_volume: state.volume ?? 12, tv_muted: !!state.muted,
      tv_app: state.app || '', tv_apps: state.apps || [],
      status: !!state.on, level: 0, tune: 0,
    }),
  };
}

function fakeAvr(room, state) {
  return {
    room,
    snapshot: () => ({
      record_id: 'avr-' + room, name: 'AVR', room: room.toUpperCase(),
      is_tv: false, is_avr: true,
      avr_online: state.online !== false, avr_volume: state.volume ?? 45,
      avr_muted: !!state.muted, avr_input: state.input || 'GAME',
      avr_sources: state.sources || [{ code: 'GAME', name: 'PS5' }],
      status: state.online !== false && !!state.on,
    }),
  };
}

// ------------------------------------------------------------------- run

function build(tvSpecs, avrSpecs) {
  const __tvs = new Map(tvSpecs.map((s, i) => ['tv' + i, fakeTv(s.room, s)]));
  const __avrs = new Map(avrSpecs.map((s, i) => ['avr' + i, fakeAvr(s.room, s)]));
  const body = preamble + WANT.map(lift).join('\n\n')
    + '\n; return { houseReading, liveCircuits, directlyRead, circuitsOf, roomsIndex };';
  // eslint-disable-next-line no-new-func
  return new Function('__devices', '__tvs', '__avrs', '__groups', body)(__devices, __tvs, __avrs, __groups);
}

let fails = 0;
const check = (label, got, must) => {
  const ok = must.every((m) => (m[0] === '!' ? !got.includes(m.slice(1)) : got.includes(m)));
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label);
  console.log('         ' + got);
  if (!ok) console.log('         wanted: ' + must.join(' & '));
};

console.log('\n\u2500\u2500 the shadowed hub record \u2500\u2500');
{
  const A = build([{ room: 'ASHU ROOM', on: false }], []);
  const withTv = A.liveCircuits('ASHU ROOM').map((c) => c.slug);
  const B = build([], []);            // no television paired
  const without = B.liveCircuits('ASHU ROOM').map((c) => c.slug);
  const gone = without.includes('tv') && !withTv.includes('tv');
  if (!gone) fails++;
  console.log((gone ? '  ok   ' : '  FAIL ')
    + 'record 517 "T.V" is hidden while a set is driven directly');
  console.log('         with a set:    ' + withTv.filter((s) => /tv/.test(s)).join(', ') + ' (from circuits)');
  console.log('         without a set: ' + without.filter((s) => /tv/.test(s)).join(', '));
  const direct = A.directlyRead('ASHU ROOM').map((d) => d.slug);
  console.log('         direct:        ' + direct.join(', '));
}

console.log('\n\u2500\u2500 one named screen \u2500\u2500');
{
  const A = build([{ room: 'ASHU ROOM', on: true, app: 'yt', apps: [{ id: 'yt', title: 'YouTube' }] }], []);
  check('tv on, showing something', A.houseReading('ashu', 'tv'),
    ['In Ashu Room', 'TV is on', 'YouTube']);
  const B = build([{ room: 'ASHU ROOM', on: false }], []);
  check('tv off', B.houseReading('ashu', 'tv'), ['TV is off']);
}

console.log('\n\u2500\u2500 the receiver \u2500\u2500');
{
  const A = build([], [{ room: 'HOME THEATRE', on: true, volume: 45 }]);
  check('playing', A.houseReading('home', 'avr'), ['AVR is on, playing PS5 at 45']);
  const B = build([], [{ room: 'HOME THEATRE', online: false }]);
  check('unplugged', B.houseReading('home', 'avr'), ['not answering']);
  const C = build([], [{ room: 'HOME THEATRE', on: false }]);
  check('standby', C.houseReading('home', 'avr'), ['in standby']);
}

console.log('\n\u2500\u2500 a whole room \u2500\u2500');
{
  const A = build([{ room: 'ASHU ROOM', on: true, app: 'nf', apps: [{ id: 'nf', title: 'Netflix' }] }], []);
  check('room summary names the set', A.houseReading('ashu', 'all'),
    ['In Ashu Room', 'TV is on', 'Netflix']);
  const B = build([{ room: 'ASHU ROOM', on: false }], []);
  check('room summary omits a set that is off', B.houseReading('ashu', 'all'), ['!TV is']);
}

console.log('\n\u2500\u2500 the whole house \u2500\u2500');
{
  const A = build([{ room: 'LIVING', on: true }, { room: 'ASHU ROOM', on: false }], []);
  check('a set that is on is named, not counted', A.houseReading('house', 'all'),
    ['TV in Living', '!TV in Ashu']);
  const B = build([], []);
  check('no screens at all', B.houseReading('house', 'all'), ['!Also on']);
}

console.log('\n\u2500\u2500 folding a whole group into its name \u2500\u2500');
{
  const A = build([], []);
  // "the COBs", not "the cobs" — the label is the installer's own, from
  // config.groups, and it is left cased the way they wrote it.
  check('eleven cobs become one clause', A.houseReading('living', 'all'),
    ['the COBs are on', '!Cob 3 is on']);
}

console.log('\n\u2500\u2500 lights and a screen together \u2500\u2500');
{
  /* Living has lamps on in the shipped snapshot, so this is the one case that
     exercises the join — the clause has to read "... and TV is on", not run the
     two together and not start with a stray "and". */
  const A = build([{ room: 'LIVING', on: true }], []);
  check('joined with and', A.houseReading('living', 'all'), [' and TV is on']);
  const B = build([{ room: 'LIVING', on: false }], []);
  check('no stray and when the set is off', B.houseReading('living', 'all'), ['!and TV']);
}

console.log('\n\u2500\u2500 unknown and ambiguous \u2500\u2500');
{
  const A = build([{ room: 'ASHU ROOM', on: true }], []);
  check('nonsense circuit', A.houseReading('ashu', 'kettle'), ['cannot find that one']);
  check('nonsense room', A.houseReading('atlantis', 'all'), ['do not know that room']);

  /* A prefix that two real circuits answer to. pick() refuses to guess, and the
     new branch says so out loud rather than claiming the name does not exist. */
  const living = A.circuitsOf('LIVING').map((c) => c.slug);
  const letters = {};
  for (const s of living) (letters[s[0]] = letters[s[0]] || []).push(s);
  const shared = Object.keys(letters).find((k) => letters[k].length > 1
    && !living.includes(k));
  if (!shared) {
    console.log('  skip  no ambiguous prefix in this house to test with');
  } else {
    check('ambiguity is named, not denied (prefix "' + shared + '")',
      A.houseReading('living', shared), ['could be', 'which one?']);
  }
}

console.log(fails ? '\n' + fails + ' FAILED\n' : '\nall passed\n');
process.exit(fails ? 1 : 0);
