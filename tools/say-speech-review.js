#!/usr/bin/env node
/* Every sentence /api/say can produce, as written and as the phone will say it.
 *
 * The point is review — the right-hand column read out loud, or read imagining it
 * read out loud, because that is the only test of whether a reply lands. What is
 * asserted here is the mechanical part: that no rule leaves a sentence without a
 * verb, that nothing survives which iOS `Speak Text` mangles (an em dash, a
 * capitalised acronym meant to be a word), that a plural subject gets a plural
 * verb, and that every sentence closes so the voice falls at the end.
 *
 * Run: node tools/say-speech-review.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const rawSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
/* Block comments are blanked rather than dropped, keeping the line count, so an
   apostrophe inside one ("the installer's own") cannot open a string that never
   closes — which is what the brace matcher below did the first time. */
const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');

function lift(name) {
  const re = new RegExp('^(?:function|const|let|var)\\s+' + name + '\\b');
  const start = src.findIndex((l) => re.test(l));
  if (start < 0) throw new Error('cannot find a top-level ' + name + ' in server.js');
  const out = [];
  let brace = 0;
  let paren = 0;
  let bracket = 0;
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

const body = ['SPEAK_PLURAL', 'SPEAK_READING', 'SPEAK_WHOLE', 'SPEAK_CLAUSE',
  'SPEAK_TIDY', 'be', 'speakable']
  .map(lift).join('\n\n') + '\n; return speakable;';
// eslint-disable-next-line no-new-func
const speakable = new Function(body)();

/* Grouped the way the code groups them, so a reviewer can tell a command
   confirmation from a reading from a refusal without reading server.js. */
const GROUPS = [
  ['A command, confirmed', [
    'Cob 1 in Ashu Room on',
    'Cob 1 in Ashu Room off',
    'Reading Light in Master Room at 40%',
    'Reading Light in Master Room at 40% and set to warm',
    'the COBs in Living set to candle',
    'the COBs in Living at 60%',
    'the lights in Dining set',
    'the lights on',
    'the lights at 60%',
    'everything in Ashu Room off',
    'Fan in Ashu Room on',
    'Fan in Ashu Room off',
    'AC in Parent Room on',
  ]],
  ['A curtain', [
    'Main Curtain open',
    'Main Curtain close',
    'Main Curtain stopped',
  ]],
  ['A scene', [
    'Movie Night set',
    'Movie Night cleared',
    'Movie Night was already out',
    'Movie Night set, but 2 did not take',
  ]],
  ['A screen, commanded', [
    'ashu TV waking up',
    'ashu TV off',
    'ashu TV at volume 12',
    'ashu TV louder',
    'ashu TV quieter',
    'ashu TV muted',
    'ashu TV unmuted',
    'Home Theatre AVR on, PS5 at 45',
    'Home Theatre AVR off',
    'Home Theatre AVR unchanged',
  ]],
  ['Cancel', [
    'Fan in Ashu Room is back as it was',
    'the COBs in Living are back as they were',
    'Movie Night is back as it was',
    'Movie Night is back as it was, but 2 did not take',
    'ashu TV volume is back to 12',
    'ashu TV is muted again',
    'ashu TV is unmuted again',
    'Closing Main Curtain again \u2014 it has no position to report, so this is not exactly where it was',
    'Opening Main Curtain again \u2014 it has no position to report, so this is not exactly where it was',
    'Main Curtain was only stopped, so there is nothing to reverse',
    'ashu TV can be switched back on, but not back to what you were watching, so I have left it alone',
    'You have not said anything I can cancel',
    'That was too long ago to put back safely',
  ]],
  ['A reading, one thing', [
    'In Ashu Room, Cob 1 is on',
    'In Ashu Room, Cob 1 is off',
    'In Ashu Room, Reading Light is at 40%',
    'In Ashu Room, Reading Light is at 40%, warm',
    'In Living, the COBs are on',
    'In Living, the COBs are at 60%',
    'In Ashu Room, Main Curtain has no position to report \u2014 a curtain tells the hub nothing',
    'In Parent Room, the hub last sent AC on, and cannot check',
  ]],
  ['A reading, a screen', [
    'In Ashu Room, TV is off',
    'In Ashu Room, TV is on, volume 12',
    'In Ashu Room, TV is on, showing YouTube, volume 12',
    'In Ashu Room, TV is on, showing Netflix, muted',
    'In Home Theatre, AVR is in standby',
    'In Home Theatre, AVR is on, playing PS5 at 45',
    'In Home Theatre, AVR is on, playing PS5 at 45, muted',
    'In Home Theatre, AVR is not answering \u2014 off at the wall, or unplugged',
  ]],
  ['A reading, a whole room', [
    'In Living, the COBs are on and TV is on, volume 12',
    'In Ashu Room, Reading Light is at 40%, Foot Light is on and the hub last sent AC on, which it cannot check',
    'Nothing is on in Ashu Room',
    'Nothing is on in Ashu Room \u2014 though the infrared units cannot be checked',
  ]],
  ['A reading, the whole house', [
    'On now: 5 in Parent Room, 11 in Living, 4 in Dining',
    'On now: 5 in Parent Room. Also on: TV in Living',
    'On now: TV in Living, AVR in Home Theatre',
    'Nothing is on anywhere \u2014 though the air conditioners and the projector cannot be checked',
  ]],
  ['Refused, or misheard', [
    'Done',
    'That did not work',
    'I did not catch that',
    'I did not understand that',
    'I do not know that room',
    'I do not know that scene',
    'I do not know how to do that',
    'I cannot find that one',
    'I cannot find that one in Ashu Room',
    'In Living that could be all or ac \u2014 which one?',
    'A curtain only opens, closes or stops',
    'That does not apply here',
    'Foot Light cannot change colour',
    'ashu TV takes one thing at a time',
    'ashu TV takes on, off, a volume, up, down, mute or unmute',
    'AVR did not answer \u2014 the receiver is not answering',
    'The hub did not answer',
    'The model did not answer in time',
    'I could not reach the model',
    'The model refused that',
    'No model key is set on the hub',
  ]],
];

/* iOS says these letter by letter, which is what anybody wants for them. Any
   other run of capitals is a word it will spell out by mistake. */
const SPELLED_ON_PURPOSE = /^(?:AC|TV|LED|HDMI|PS5|I)$/;

/* Two replies are deliberately not sentences and must not be marked as broken:
   the whole-house summary is a list, which is exactly why it is readable at all
   when eleven rooms are lit, and a bare acknowledgement is a whole utterance. */
const NOT_A_SENTENCE = /^(?:On now:|Also on:|Done\b)/;

/* Enough of a verb to carry a clause. The fragments this pass exists to fix all
   end in a bare state word — "Cob 1 in Ashu Room off" — with nothing before it. */
const HAS_VERB = new RegExp('\\b(?:is|are|was|were|has|have|had|may|can|could'
  + "|can't|didn't|doesn't|don't|isn't|couldn't|wasn't"
  + '|refused|reached|sent|showing|playing|opening|closing|waking|stopped'
  + '|know|find|open|close|stop|apply|change|catch|work|understand|does|do|take)\\b', 'i');

function faults(said) {
  const bad = [];
  if (/\u2014/.test(said)) bad.push('em dash — the voice pauses for an unguessable time');
  if (!/[.?!]$/.test(said)) bad.push('no full stop — the voice will not fall at the end');
  if (!/^[A-Z]/.test(said)) bad.push('does not open with a capital');
  if (/\b(?:is|are)\s+(?:is|are)\b/.test(said)) bad.push('doubled verb');
  /* The same fault with a word wedged in the middle: "Ashu TV is back is at
     volume 12", which is what a whole-sentence rule does when it is handed a
     sentence that already had a verb. One word only, so "the AC is on and TV is
     off" is left alone. */
  if (/\b(?:is|are)\s+\w+\s+(?:is|are)\b/.test(said)) bad.push('a rule inserted a second verb');
  if (/\bAVR\b/i.test(said)) bad.push('AVR — say "receiver"');
  for (const w of said.match(/\b[A-Z][A-Z0-9]+\b/g) || []) {
    if (!SPELLED_ON_PURPOSE.test(w)) bad.push(w + ' — iOS will spell this out');
  }
  // An acronym in lower case is read as a word: "ac" becomes "ack".
  for (const w of said.match(/\b(?:ac|tv|avr|led)\b/g) || []) {
    bad.push('"' + w + '" in lower case — the voice will read it as a word');
  }
  // Plural subject, singular verb. "the cobs is on" is the classic.
  if (/\bthe\s+\S*s\s+is\b/.test(said)) bad.push('plural subject with "is"');
  if (!NOT_A_SENTENCE.test(said) && !HAS_VERB.test(said)) {
    bad.push('no verb — reads as a caption, not a sentence');
  }
  return bad;
}

let broken = 0;
let unchanged = 0;
for (const [title, lines] of GROUPS) {
  console.log('\n\u2500\u2500 ' + title + ' ' + '\u2500'.repeat(Math.max(0, 58 - title.length)));
  for (const en of lines) {
    const said = speakable(en);
    const bad = faults(said);
    if (bad.length) broken++;
    if (said === en) unchanged++;
    console.log('  ' + (bad.length ? '!' : said === en ? '=' : ' ') + ' ' + en);
    console.log('      \u2192 ' + said);
    for (const b of bad) console.log('        ! ' + b);
  }
}

console.log('\n' + '\u2500'.repeat(62));
console.log('  !  something the phone will read badly');
console.log('  =  unchanged — fine only if it already reads as a sentence');
console.log('\n  ' + broken + ' to fix, ' + unchanged + ' unchanged\n');
process.exit(broken ? 1 : 0);
