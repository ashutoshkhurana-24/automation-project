#!/usr/bin/env node
/* Writes the family guide: one self-contained HTML file about speaking to the
 * house. Nothing about setting a phone up — that is done for them.
 *
 *   node tools/make-guide.js                        # against a local server
 *   node tools/make-guide.js http://192.168.1.3:3000
 *
 * The room tables are read from a *running* server rather than rebuilt from
 * devices.json, because `/do/<room>` already resolves each circuit's kind and
 * the actions it will accept by reading the dispatch. Deriving them a second
 * time here is how a guide starts quietly lying about the house — which is worse
 * than no guide, since the whole point is that nobody has to guess a name.
 *
 * Re-run it after a vendor visit, or after anything is renamed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const OUT = path.join(__dirname, '..', 'data', 'speaking-to-the-house.html');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(url + ' -> ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(url + ': ' + e.message)); }
      });
    }).on('error', reject);
  });
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A slug is hyphenated; a person says the words. "foot-light" -> "foot light".
    An acronym is lifted, because "ac" printed lower case reads as a word. */
const spoken = (slug) => String(slug).replace(/-/g, ' ')
  .replace(/\b(ac|tv|led)\b/g, (m) => m.toUpperCase());

/** cob 2 before cob 10, which the installer's own order does not manage. */
function naturally(a, b) {
  const key = (x) => x.replace(/\d+/g, (n) => n.padStart(6, '0'));
  return key(a).localeCompare(key(b));
}

/* Eleven rows reading "cob 1 … cob 11", every one of them identical, is the same
   problem as eleven identical clauses in a spoken answer: nobody reads to the
   end. A run of numbered siblings of one kind folds to a single row, which is
   also how anybody actually addresses them — by saying "cobs". */
function fold(circuits) {
  const out = [];
  const spent = new Set();
  for (const c of circuits) {
    if (spent.has(c.circuit)) continue;
    const m = c.circuit.match(/^(.*?)-(\d+)$/);
    if (!m) { out.push(c); continue; }
    const family = circuits.filter((x) => {
      const y = x.circuit.match(/^(.*?)-(\d+)$/);
      return y && y[1] === m[1] && x.kind === c.kind;
    }).sort((x, y) => naturally(x.circuit, y.circuit));
    for (const x of family) spent.add(x.circuit);
    if (family.length < 3) { out.push(...family); continue; }
    const first = family[0].circuit;
    const last = family[family.length - 1].circuit;
    out.push({
      circuit: first,
      label: spoken(first) + ' to ' + spoken(last),
      kind: c.kind,
      note: 'Say <b>' + spoken(m[1]) + 's</b> for all ' + family.length + '.',
    });
  }
  return out;
}

const words = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/* The kinds /do reports, in words a guide can use. The point of this column is
   to tell somebody what a name they have never heard of actually is — HANGING is
   a lamp, CURTAIN ROPE is a light while MAIN CURTAIN is a motor.

   English, like every other explanation here. Only the things you *say* are in
   Hinglish: an instruction is read, and reads better in one language. */
const KINDS = {
  'tunable light': 'Brightness and colour',
  'dimmable light': 'Brightness',
  switch: 'On / off only',
  curtain: 'Open, close, or stop halfway',
  'air conditioner · infrared': 'Infrared — on / off only',
  'projector · infrared': 'Infrared — on / off only',
  mixed: 'Everything in one go',
};

/* A deliberate order, because the alphabet put the air conditioner at the top of
   every room: its label is the longest and its caveat the least interesting
   thing about a bedroom. Lights first, motors and infrared last. */
const KIND_ORDER = [
  'Brightness and colour', 'Brightness', 'On / off only',
  'Open, close, or stop halfway', 'Infrared — on / off only', 'Everything in one go',
];

/** Falls back to the raw kind, so a kind nobody has seen before shows up as
    itself rather than as an empty column. Every kind the live house reports on
    2026-08-25 is listed above. */
function kindWords(kind) {
  return KINDS[kind] || kind;
}

/* Collective names exist in every room and are explained once, not seven times. */
const COLLECTIVE = new Set(['all', 'lights', 'cobs']);

/* The hub keeps a record for a television it can no longer speak for, and /do
   still addresses it deliberately. Offering it here would be the one thing this
   guide must not do: commanding it moves a row in a database, answers as though
   it worked, and the set carries on playing. The screens table is the truth. */
const SHADOWED = /record, not the set/;

async function main() {
  const grammar = await get(BASE + '/do?json=1');
  const health = await get(BASE + '/api/health').catch(() => ({}));
  const devices = await get(BASE + '/api/devices').catch(() => ({}));

  const rooms = [];
  for (const r of grammar.rooms || []) {
    const detail = await get(BASE + '/do/' + r.room + '?json=1');
    rooms.push({ slug: r.room, circuits: detail.circuits || [] });
  }

  /* Screens are not hub circuits and so are not in /do's room lists at all.
     They are the only things here whose state is a real reading, which is worth
     a family member knowing: the house is certain about a television. */
  const list = (devices.devices || devices || []);
  const screens = (Array.isArray(list) ? list : [])
    .filter((d) => d.is_tv || d.is_avr)
    .map((d) => ({ name: d.name, room: d.room, avr: !!d.is_avr }));

  /* From the config rather than the API, which does not publish it. */
  let houseName = 'The house';
  try {
    houseName = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'config.json'), 'utf8')).house_name || houseName;
  } catch { /* an install with no config is "The house", same as the dashboard */ }
  const html = page(houseName, rooms, screens, health);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log('wrote ' + OUT + '  (' + (html.length / 1024).toFixed(0) + ' KB)');
  console.log(rooms.length + ' rooms, ' + screens.length + ' screens');
}

/* One collapsed block per room, rather than seven tables stacked down the page.
   Everything is still here — it is a reference, and a name left out is a name
   somebody has to guess — but a reference is scrolled *past* far more often than
   it is read, so it opens at a tap instead of costing forty rows of scroll.
   `<details>` does it natively, which keeps the page free of script.

   No hue per room, and that is a correction rather than a simplification: the
   dashboard's rule is that the interface is neutral and the only colour is
   light, so seven arbitrary room colours were speaking its language and saying
   something untrue with it. A room card there is uniform too. Recognition comes
   from the name and the count, and the amber is kept for the things you say. */
function roomBlock(room) {
  const named = fold(room.circuits
    .filter((c) => !COLLECTIVE.has(c.circuit) && !SHADOWED.test(c.kind))
    .sort((a, b) => naturally(a.circuit, b.circuit)));

  /* Grouped by what a thing can do, not listed one per row. Six lamps that all
     dim are one line about dimming, and the difference between MAIN CURTAIN and
     CURTAIN ROPE — a motor and a light — is what the grouping makes obvious. */
  const groups = new Map();
  for (const c of named) {
    const k = kindWords(c.kind);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }

  const body = [...groups]
    /* An unknown kind sorts to the end rather than to the front, which is where
       -1 from indexOf would put it. */
    .sort((a, b) => {
      const rank = (k) => (KIND_ORDER.indexOf(k) + 1 || KIND_ORDER.length + 1);
      return rank(a[0]) - rank(b[0]);
    })
    .map(([kind, list]) => {
      const names = list.map((c) => '<span class="name">'
        + esc(c.label || spoken(c.circuit)) + '</span>'
        // c.note is ours and carries <b>; c.label is escaped above.
        + (c.note ? '<span class="hint">' + c.note + '</span>' : '')).join('');
      return '      <div class="grp"><span class="cat-head">' + esc(kind) + '</span>\n'
        + '        <div class="names">' + names + '</div></div>';
    }).join('\n');

  const short = spoken(room.slug).split(' ')[0];
  return '    <details class="room">\n'
    + '      <summary><span class="rname">' + esc(words(spoken(room.slug)))
    + '</span><span class="n">' + named.length + '</span></summary>\n'
    + '      <p class="lead">Just say <b>' + esc(short)
    + '</b> — the first word is enough.</p>\n'
    + body + '\n    </details>';
}

function page(houseName, rooms, screens, health) {
  /* Every set here is named "TV", so the name on its own is unsayable — what a
     person says is the room and then the screen. The receiver answers to both
     "AVR" and "receiver", and the guide leads with the word the reply uses. */
  const screenRows = screens.map((s) => {
    const room = words(String(s.room || '').toLowerCase());
    const phrase = room + ' ' + (s.avr ? 'receiver' : 'TV');
    return '      <div class="grp"><span class="cat-head">'
      + (s.avr ? 'Home theatre sound' : 'Television') + '</span>\n'
      + '        <div class="names"><span class="name">' + esc(phrase) + '</span>'
      + (s.avr ? '<span class="hint">Also answers to <b>AVR</b>.</span>' : '')
      + '</div></div>';
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f3ede3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#12161b" media="(prefers-color-scheme: dark)">
<title>Talking to ${esc(houseName)}</title>
<style>
  /* The dashboard's own palette and tokens, same names, so the two read as one
     product. Paper by day and the dark theme after dark — the dashboard picks
     that off the hub's clock, which a shared file cannot do, so this one follows
     the phone. Every value here is the dashboard's, including the ones it had to
     re-choose for dark: a specular lip as a fraction of white, and a lit edge as
     a fraction of the tint, are the two things a token swap cannot carry. */
  :root {
    color-scheme: light dark;
    --ink:    light-dark(#1d2228, #e6eaee);
    --soft:   light-dark(#5c646d, #a6aeb8);
    --faint:  light-dark(#7d848e, #7d848e);
    --ground: light-dark(#f3ede3, #12161b);
    --paper:  light-dark(#fbf7f0, #1b2027);
    --paper-2:light-dark(#f6f1e8, #21262c);
    --line:   light-dark(#e3ddd3, #2a3037);
    --rim:    light-dark(rgba(0,0,0,.10), rgba(255,255,255,.10));
    --lip:    light-dark(rgba(255,255,255,.34), rgba(255,255,255,.08));
    --accent: #ff6f61;
    --warm:   #f2a233;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    /* Instrument Serif is served from the hub and this page must make no network
       request at all, so the display face is the nearest thing every phone has.
       It is used for exactly one line, as on the dashboard. */
    --display: ui-serif, "Iowan Old Style", Palatino, Georgia, serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--sans);
    max-width: 660px; width: 100%; margin: 0 auto;
    padding: 0 clamp(15px, 4vw, 24px) 60px;
    line-height: 1.55; font-size: 17px;
    color: var(--ink); background: var(--ground);
    -webkit-text-size-adjust: 100%;
  }

  /* The masthead is the dashboard's hero: it says what the thing is in display
     type, with the one coral phrase, rather than labelling itself. */
  header { padding: clamp(30px, 9vw, 52px) 0 22px; }
  h1 {
    font-family: var(--display); font-weight: 400;
    font-size: clamp(31px, 9vw, 44px); line-height: 1.1;
    margin: 0 0 10px; letter-spacing: -.01em;
  }
  h1 i { color: var(--accent); font-style: italic; }
  .sub { color: var(--soft); margin: 0; font-size: 16.5px; max-width: 33em; }
  .chip {
    display: inline-block; margin: 0 0 16px; font-family: var(--mono);
    font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase;
    padding: 4px 10px; border-radius: 999px;
    color: var(--faint); background: var(--paper-2);
    border: 1px solid var(--line);
  }

  h2 {
    font-size: clamp(19px, 5vw, 22px); margin: 38px 0 6px;
    letter-spacing: -.015em; font-weight: 650;
  }
  p { margin: 9px 0; }
  .lead { color: var(--soft); font-size: 15px; margin: 2px 0 12px; }
  b { font-weight: 650; }
  i { color: var(--soft); font-style: italic; }

  /* A thing to say out loud is drawn as speech: the amber a lamp makes, in the
     shape of a bubble. Amber because saying it is what lights the house — the
     dashboard reserves colour for light, and this is the page's version of that.
     It presses down like every control on the dashboard does: 60ms down, 240 back,
     the asymmetry being what reads as weight rather than as an animation. */
  .say {
    display: inline-block; margin: 3px 5px 3px 0;
    padding: 5px 13px 6px; border-radius: 15px 15px 15px 5px;
    background: light-dark(
      linear-gradient(150deg, #f7b04b, #ea8f22),
      linear-gradient(150deg, rgba(242,162,51,.30), rgba(242,162,51,.16)));
    color: light-dark(#241703, #f6cd8d);
    border: 1px solid light-dark(rgba(150,88,0,.28), rgba(242,162,51,.34));
    box-shadow: 0 1px 0 var(--lip) inset,
                0 2px 10px light-dark(rgba(190,110,10,.20), rgba(0,0,0,.30));
    font-weight: 600; font-size: 16px; line-height: 1.35;
    transition: transform .24s cubic-bezier(.2,.7,.3,1);
  }
  .say:active { transform: scale(.97); transition-duration: .06s; }
  .says { margin: 12px 0 4px; }

  /* A name is a word inside a sentence, never a whole one, so it is outlined
     where a phrase is filled. Neutral: it is a label, and labels are chrome. */
  .name {
    display: inline-block; margin: 3px 6px 3px 0; padding: 3px 10px 4px;
    border-radius: 999px; border: 1px solid var(--line);
    background: var(--paper-2); color: var(--ink);
    font-weight: 600; font-size: 15.5px; white-space: nowrap;
  }

  /* The dashboard's category pill, same idea and nearly the same rule: a heading
     makes its own contrast instead of borrowing it from whatever is behind. */
  .cat-head {
    display: inline-block; font-family: var(--mono);
    font-size: 10.5px; font-weight: 600; letter-spacing: .08em;
    text-transform: uppercase; color: var(--faint);
    padding: 3px 8px; border-radius: 6px;
    background: var(--paper-2); border: 1px solid var(--line);
  }

  ul { padding-left: 20px; margin: 9px 0; }
  li { margin: 7px 0; }

  /* A pane: the dashboard's tile, minus the blur there is no backdrop for here.
     The rim and the specular lip along the top are what make it a pane. */
  .card, .note, details.room {
    background: var(--paper); border: 1px solid var(--rim);
    border-radius: 14px;
    box-shadow: 0 1px 0 var(--lip) inset, 0 1px 3px light-dark(rgba(0,0,0,.04), rgba(0,0,0,.20));
  }
  .card { padding: 15px 17px; margin: 14px 0; }
  .card > :first-child, .note > :first-child { margin-top: 0; }
  .card > :last-child, .note > :last-child { margin-bottom: 0; }

  /* A callout is the dashboard's own advisory: an amber edge and a warm ground,
     the same shape the left-on nudges use. Amber means "read this", and it is
     the only place the page raises its voice. */
  .note {
    border-left: 3px solid var(--warm);
    background: light-dark(#fdf8ec, #201d15);
    border-radius: 0 13px 13px 0; padding: 13px 16px; margin: 15px 0; font-size: 15.5px;
  }
  .note .k {
    display: block; font-family: var(--mono);
    font-size: 10.5px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase;
    color: light-dark(#9a6b12, #d3a75a); margin: 0 0 6px;
  }

  /* One tap to open a room. The chevron replaces the default marker, which is
     small, grey and easy to miss on a phone. */
  details.room { margin: 8px 0; overflow: hidden; }
  details.room summary {
    cursor: pointer; list-style: none; padding: 13px 15px;
    display: flex; align-items: center; gap: 10px;
    -webkit-tap-highlight-color: transparent;
    transition: transform .24s cubic-bezier(.2,.7,.3,1);
  }
  details.room summary:active { transform: scale(.995); transition-duration: .06s; }
  details.room summary::-webkit-details-marker { display: none; }
  .rname { font-weight: 650; font-size: 17.5px; letter-spacing: -.01em; }
  details.room summary::after {
    content: ''; margin-left: auto; flex: 0 0 auto;
    width: 8px; height: 8px; margin-right: 3px;
    border-right: 2px solid var(--faint);
    border-bottom: 2px solid var(--faint);
    transform: rotate(45deg); transition: transform .2s ease;
  }
  details.room[open] summary::after { transform: rotate(-135deg); }
  details.room[open] summary { border-bottom: 1px solid var(--line); }
  details.room .n {
    font-family: var(--mono); font-size: 11.5px; font-weight: 600;
    font-variant-numeric: tabular-nums;
    padding: 2px 8px; border-radius: 999px;
    background: var(--paper-2); border: 1px solid var(--line); color: var(--faint);
  }
  details.room .lead, details.room .grp { padding: 0 15px; }
  details.room .lead { padding-top: 11px; }
  details.room > :last-child { padding-bottom: 13px; }
  .grp { margin: 11px 0; }
  .names { margin-top: 3px; }

  .table-wrap { overflow-x: auto; margin: 12px 0 4px; }
  table { border-collapse: collapse; width: 100%; font-size: 15.5px; }
  th, td { text-align: left; padding: 8px 12px 8px 0; vertical-align: top; }
  th {
    font-family: var(--mono);
    font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600;
    color: var(--faint); border-bottom: 1px solid var(--line); padding-bottom: 6px;
  }
  td { border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: 0; }
  td:first-child { font-weight: 600; min-width: 190px; }
  td:last-child, th:last-child { padding-right: 0; color: var(--soft); }
  .hint { font-size: 13.5px; color: var(--faint); display: block; margin: 3px 0 0; }

  footer {
    margin-top: 44px; padding-top: 16px; font-size: 13.5px;
    border-top: 1px solid var(--line); color: var(--faint);
  }
  img, svg { max-width: 100%; height: auto; }
</style>
</head>
<body>

<header>
  <span class="chip">${esc(houseName)}</span>
  <h1>Say what you want, and the house <i>does it</i>.</h1>
  <p class="sub">Press the button on your phone and speak normally. It answers out
  loud, and nothing you say can break anything.</p>
</header>

<main>

<h2>Say it like this</h2>
<p>Three things, in this order — <b>which room</b>, <b>what in it</b>, <b>what to
do</b>:</p>
<div class="says">
  <span class="say">Ashu room ka fan chalu karo</span>
  <span class="say">Master room ke cobs 40 kar do</span>
  <span class="say">Living ka main curtain khol do</span>
</div>
<p>Extra words in between are ignored, so there is no need to talk like a
machine. These do exactly the same thing:</p>
<div class="says">
  <span class="say">Zara ashu ka fan on kar dijiye</span>
  <span class="say">Ashu fan on</span>
</div>
<p class="lead">Short names work too — <b>ashu</b> becomes Ashu Room, <b>foot</b>
becomes foot light. If a short name fits two things, the house asks which one
instead of guessing.</p>

<div class="note">
<span class="k">Worth knowing</span>
<p><b>Say the names in English.</b> Hindi verbs are fine — <i>chalu karo</i>,
<i>band kar do</i>, <i>khol do</i> — but the name of the room and the thing should
be the English one listed below. Those are the installer's own labels, and they
are the names the house knows.</p>
<p><b>Two exceptions, because everybody says them:</b>
<span class="say">pankha</span> works for a fan and
<span class="say">parda</span> works for a curtain. So
<span class="say">Ashu ka pankha chalu karo</span> is fine. Anything else needs the
English word — <span class="say">batti</span> will not work,
<span class="say">light</span> or <span class="say">cob</span> will.</p>
<p>Where a room has two curtains it asks which, and where it has none it says so
rather than switching on something with a similar name.</p>
</div>

<h2>Dimming and colour</h2>
<ul>
  <li>A number is <b>brightness</b>, out of a hundred:
      <span class="say">Ashu cobs 40</span></li>
  <li><b>up</b> and <b>down</b> nudge it from where it is now:
      <span class="say">Ashu cobs down</span></li>
  <li>For colour, say the word — <b>warm</b>, <b>cool</b>, <b>warmer</b>,
      <b>cooler</b> — or both at once:
      <span class="say">Master cobs 40 warm</span></li>
</ul>
<p class="lead">Only the ceiling cobs and a few lamps change colour; ask a plain
light for colour and it says so rather than ignoring you. It names colours in its
own words, so asking for <b>warm</b> may be confirmed as <i>"set to candle"</i> —
that is the same thing, not a mistake.</p>

<h2>A whole room at once</h2>
<div class="says">
  <span class="say">Living off</span>
  <span class="say">Ashu lights off</span>
  <span class="say">Ashu cobs on</span>
</div>
<p class="lead">The first is everything in the room. The second is only the
lights, so a fan keeps running. The third is the whole ceiling together.</p>

<h2>You can ask, too</h2>
<p>The same button answers questions, and a question never switches anything on
or off by accident:</p>
<div class="says">
  <span class="say">Kya chalu hai?</span>
  <span class="say">Living mein kya chal raha hai?</span>
  <span class="say">Ashu ka pankha on hai?</span>
</div>
<div class="note">
<span class="k">Two things it cannot check</span>
<p>The air conditioners and the projector work over infrared, like an ordinary
remote: the house can send to them but never hear back. So it says <i>"the hub
last sent AC on, but can't check it"</i> — and if somebody used the AC's own
remote, the house does not know. A curtain never reports its position either.</p>
<p>Televisions and the home theatre sound are checked properly. If it says the TV
is on, it is on.</p>
</div>

<h2>Said it by mistake?</h2>
<p>Say any of these and your last command is put back:</p>
<div class="says">
  <span class="say">Cancel</span>
  <span class="say">Wapas karo</span>
  <span class="say">Nahi nahi</span>
  <span class="say">Galat</span>
  <span class="say">Pehle jaisa karo</span>
</div>
<p class="lead">Only <b>your</b> last command, not anybody else's — and only one
step back, within five minutes. After that it says <i>"that was too long ago to
put back safely"</i>, because the house has probably moved on.</p>
<div class="note">
<span class="k">Two it cannot put back perfectly</span>
<p><b>A curtain</b> does not report its position, so cancel sends the opposite
command: opened becomes closed. It tells you <i>"this isn't exactly where it
was"</i>. If the curtain had been half open, it will not go back to half open.</p>
<p><b>A television that was switched off.</b> Volume and mute go back exactly, but
switching a set back on lands it on the home screen rather than on whatever was
playing — so it leaves it alone and says why.</p>
</div>

<h2>What is in each room</h2>
<p class="lead">Tap a room. These are the names the house knows — say them just
as they are written.</p>
${rooms.map(roomBlock).join('\n')}
${screens.length ? `    <details class="room">
      <summary><span class="rname">Screens &amp; sound</span><span class="n">${screens.length}</span></summary>
      <p class="lead">Say <b>on</b>, <b>off</b>, a <b>volume</b>, <b>louder</b>,
      <b>quieter</b>, <b>mute</b> or <b>unmute</b> — for example
      <span class="say">Ashu TV ka volume 12 kar do</span></p>
${screenRows}
      <div class="grp"><span class="cat-head">Not wired up</span>
        <div class="names"><span class="hint">Apps, channels and inputs are not
        connected. Ask for <span class="say">Netflix laga do</span> and it says so
        plainly — it will not quietly switch the TV on and show the wrong thing.
        Pick the app on the TV itself.</span></div></div>
    </details>` : ''}

<h2>If something does not work</h2>
<p class="lead">The left column is the English the phone says back. Match what you
heard.</p>
<div class="table-wrap"><table>
  <thead><tr><th>It says</th><th>What to do</th></tr></thead>
  <tbody>
    <tr><td>I didn't catch that</td><td>It heard nothing at all. Hold the button a moment longer, then speak.</td></tr>
    <tr><td>I don't know that room</td><td>Check the room name above — try just the first word.</td></tr>
    <tr><td>I can't find that in&nbsp;&hellip;</td><td>It found the room but not the thing. Open that room above for the right name.</td></tr>
    <tr><td>&hellip; could be more than one</td><td>The short name fits two things. Say a little more of it.</td></tr>
    <tr><td>There is more than one curtain in&nbsp;&hellip;</td><td>Say which one — it names them for you.</td></tr>
    <tr><td>There is no fan in&nbsp;&hellip;</td><td>That room has none. Open it above to see what it does have.</td></tr>
    <tr><td>A curtain can only open, close or stop</td><td>A curtain has no on or off — open it, close it, or stop it halfway.</td></tr>
    <tr><td>&hellip; can't change colour</td><td>That one is a plain light. Give it a brightness, or just on.</td></tr>
    <tr><td>You haven't said anything I can cancel</td><td>Nothing to put back — either five minutes have passed, or that command came from a different phone.</td></tr>
    <tr><td>The hub didn't answer</td><td>The controller is not responding. Try once more, and tell Ashutosh if it keeps happening.</td></tr>
    <tr><td>Nothing at all</td><td>The phone has to be on the home Wi&#8209;Fi. None of this works from outside the house.</td></tr>
  </tbody>
</table></div>

<div class="card">
<p><b>You cannot break anything.</b> The worst that happens is a light going on or
off in some room, and saying the opposite puts it right. If you get it wrong,
<span class="say">cancel</span> is enough. Speak without worrying.</p>
</div>

</main>

<footer>
${esc(houseName)} &middot; ${new Date().toISOString().slice(0, 10)} — built from the
house as it is today. Anything added or renamed after this will not be on this page.
</footer>

</body>
</html>
`;
}

main().catch((err) => {
  console.error('failed: ' + err.message);
  console.error('Is a server running? node tools/make-guide.js http://192.168.1.3:3000');
  process.exit(1);
});
