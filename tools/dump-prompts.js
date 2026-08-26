#!/usr/bin/env node
/* Write down exactly what this house sends to the models.
 *
 * Read from a running server rather than reconstructed, for the reason
 * `tools/model-bench.py` records at the top of itself: its prompt was a
 * reconstruction, it was one sentence short, and that difference produced a
 * false negative loud enough to have changed which model reads the house. A
 * second derivation of a prompt is worth less than no copy at all.
 *
 *   npm start &                       # or point it at the hub
 *   node tools/dump-prompts.js
 *   node tools/dump-prompts.js http://192.168.1.3:3000
 *
 * Writes docs/prompts.md. Re-run it after anything that changes the house — a
 * room renamed, a circuit added, a cue created — because all three prompts are
 * built from the live house and this file is the one copy that cannot rebuild
 * itself.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const base = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const key = process.env.SHORTCUT_KEY ? '?key=' + encodeURIComponent(process.env.SHORTCUT_KEY) : '';
const out = path.join(__dirname, '..', 'docs', 'prompts.md');

const fence = (s) => '```\n' + String(s).replace(/```/g, '`​``') + '\n```';

(async () => {
  let data;
  try {
    const r = await fetch(base + '/api/say/prompt' + key);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (err) {
    console.error('failed: ' + err.message);
    console.error('Is a server running?  node tools/dump-prompts.js ' + base);
    process.exit(1);
  }

  /* Local, not toISOString(). The house is IST and this is usually run late:
     UTC would date a 3am dump to the previous day, which is the same trap the
     history log sets and which CLAUDE.md already records. */
  const d = new Date();
  const today = d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
  const m = data.models || {};
  /* houseShape() carries two entries that are not rooms — the cue list and the
     aliases — so counting the separators would overstate it by two. */
  const rooms = String(data.house_shape || '').split('|')
    .filter((x) => x && !x.startsWith('cues:') && !x.startsWith('alias:')).length;

  const doc = [
    '# What the house sends to the models',
    '',
    'Everything below is the **real** text, read from a running server at',
    '`GET /api/say/prompt` rather than copied out of the source — all three are',
    'built from the live house, so a hand-written copy drifts the moment a room is',
    'renamed. Regenerate with `node tools/dump-prompts.js`.',
    '',
    '_Taken ' + today + ', from a house of ' + rooms + ' rooms. All three are' +
      ' generated, so this is a snapshot: if a room has been renamed or a circuit' +
      ' added since, regenerate rather than trusting it._',
    '',
    '| Job | Model |',
    '|---|---|',
    '| Understanding a sentence | `' + (m.understanding || '?') + '` |',
    '| Turning a recording into words | `' + (m.transcription || '?') + '` |',
    '| Hearing a recording directly | `' + (m.audio || '?') + '` |',
    '',
    '---',
    '',
    '## 1. The system prompt',
    '',
    'Sent as `instructions` on every text call to `/v1/responses`, and as the',
    'system message on the audio call. The room list is generated, which is why',
    'this is the half that cannot be written by hand.',
    '',
    fence(data.prompt),
    '',
    '## 2. The tools',
    '',
    'Rooms are a closed list because the set is small and known. A circuit is not,',
    'because which exist depends on the room and a flat schema has no way to say',
    'that — so every room’s circuits go in the prompt above instead, and the',
    'validator is `pick()` inside `runAddress`. A circuit the model invents is',
    'refused by the same code that refuses a mistyped URL.',
    '',
    fence(JSON.stringify(data.tools, null, 2)),
    '',
    '## 3. The transcription hint',
    '',
    'Sent as `prompt` on every call to `/v1/audio/transcriptions`. It is doing more',
    'work than it looks: asked without it, the same clip comes back in Devanagari,',
    'which matches no room slug and would send every sentence to the model.',
    'Romanisation is demanded here rather than through the `language` parameter,',
    'which names the language and not the alphabet.',
    '',
    fence(data.transcript_prompt),
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, doc);
  console.log('wrote ' + path.relative(path.join(__dirname, '..'), out) +
    '  (' + doc.length + ' bytes)');
  console.log('  ' + (m.understanding || '?') + ' / ' + (m.transcription || '?') +
    ' / ' + (m.audio || '?'));
})();
