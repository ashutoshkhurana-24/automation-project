#!/usr/bin/env node
'use strict';
/* ── the media player's app icons ─────────────────────────────────────────
 *
 * Fetches a brand icon for each app declared in config, into data/app-icons/,
 * where GET /app-icon/:file serves it.
 *
 * **Fetched rather than committed**, the same choice make-icon.js makes for the
 * home-screen icon: these are third-party brand art, they are per-install
 * (another house has other apps), and a binary in the repo is one nobody can
 * regenerate. They are also NOT hot-linked at render time — the page makes no
 * external requests at all, which is the rule that moved the three typefaces
 * onto the box, because on a house network an outside host can simply be absent
 * and a wall panel should not wait on one to draw a button.
 *
 * The source is each app's Play Store listing. A package can be given in config
 * as `play`; otherwise the name is matched against the short table below, which
 * is a convenience rather than a source of truth — an app it does not know is
 * reported and skipped, and its tile falls back to a drawn glyph.
 *
 *   node tools/fetch-app-icons.js            # fetch what config declares
 *   node tools/fetch-app-icons.js --list     # say what it would fetch
 *
 * This does not reach the hub through deploy/push.sh, which copies server.js
 * and nothing else. Copy this file over and run it there, the same route
 * make-icon.js takes:
 *
 *   scp tools/fetch-app-icons.js abneo@192.168.1.3:~/dashboard/tools/
 *   ssh abneo@192.168.1.3 "cd ~/dashboard && /opt/nodejs/bin/node tools/fetch-app-icons.js"
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'app-icons');

/* Play Store packages for the apps this house has. Not a discovery mechanism —
   the box cannot be asked what it has installed (see CLAUDE.md) — just a way to
   avoid typing a package into config for the obvious ones. */
const KNOWN = {
  youtube: 'com.google.android.youtube.tv',
  netflix: 'com.netflix.ninja',
  'prime-video': 'com.amazon.amazonvideo.livingroom',
  hotstar: 'in.startv.hotstar',
  jiohotstar: 'in.startv.hotstar',
  spotify: 'com.spotify.tv.android',
  jiocinema: 'com.jio.media.ondemand',
  sonyliv: 'com.sonyliv',
  zee5: 'com.graymatrix.did',
  'apple-tv': 'com.apple.atve.androidtv.appletv',
};

const slugOf = (a) => String(a.icon || a.name).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function apps() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch (e) { console.error('no config.json to read: ' + e.message); process.exit(1); }
  const out = [];
  for (const p of config.media_players || []) {
    for (const a of p.apps || []) {
      if (!a || !a.name) continue;
      const slug = slugOf(a);
      const pkg = a.play || KNOWN[slug];
      out.push({ name: a.name, slug, pkg });
    }
  }
  return out;
}

/* The listing page carries the icon on a googleusercontent host. Asked for at
   =s128: the tile draws at about 26px, so 128 covers a four-times screen and
   keeps each file to a couple of kilobytes. */
async function iconUrl(pkg) {
  const res = await fetch(
    'https://play.google.com/store/apps/details?id=' + encodeURIComponent(pkg) + '&hl=en&gl=IN',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('play store answered ' + res.status);
  const html = await res.text();
  const m = html.match(/https:\/\/play-lh\.googleusercontent\.com\/[A-Za-z0-9_=-]{20,}/);
  if (!m) throw new Error('no icon on the listing');
  return m[0].replace(/=s\d+(-\w+)?$/, '') + '=s128';
}

(async () => {
  const list = apps();
  if (!list.length) {
    console.log('no apps declared in config.media_players[].apps — nothing to fetch');
    return;
  }
  if (process.argv.includes('--list')) {
    for (const a of list) {
      console.log(a.slug.padEnd(14) + (a.pkg || '(no package known — pass "play" in config)'));
    }
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  let got = 0;
  for (const a of list) {
    if (!a.pkg) {
      console.log(a.slug.padEnd(14) + 'skipped — no package. Add "play": "<package>" to it in config.');
      continue;
    }
    try {
      const url = await iconUrl(a.pkg);
      const res = await fetch(url);
      if (!res.ok) throw new Error('icon answered ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      /* A PNG, or the tile would render whatever came back. Checked rather than
         trusted: the listing is scraped, so what it hands over is not a
         contract. */
      if (buf.length < 8 || buf[0] !== 0x89 || buf.toString('latin1', 1, 4) !== 'PNG') {
        throw new Error('that was not a PNG');
      }
      fs.writeFileSync(path.join(OUT, a.slug + '.png'), buf);
      console.log(a.slug.padEnd(14) + buf.length + ' bytes');
      got++;
    } catch (e) {
      console.log(a.slug.padEnd(14) + 'failed: ' + e.message);
    }
  }
  console.log('');
  console.log(got + ' of ' + list.length + ' fetched into data/app-icons/');
  console.log('Anything missing falls back to a drawn mark — nothing breaks.');
})();
