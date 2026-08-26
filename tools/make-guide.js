/*
 * Saves the family guide to a file: fetches GET /guide from a running dashboard
 * and writes data/speaking-to-the-house.html.
 *
 * The page itself is built by server.js, which is where it now lives — see the
 * "family guide" section there for why. This stays because the guide is sent to
 * the family through Messages and has to open with no network at all, and because
 * a file is the thing you can attach.
 *
 * It reads a running server rather than devices.json for the reason it always
 * did: /do already resolves what each circuit is and what it will take, and
 * deriving that a second time is how a guide starts quietly lying.
 *
 *   node tools/make-guide.js                       (a server on this machine)
 *   node tools/make-guide.js http://192.168.1.3:3000
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const OUT = path.join(__dirname, '..', 'data', 'speaking-to-the-house.html');

function fetchGuide(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { accept: 'text/html' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(url + ' answered ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

/* `?saved=1` asks for the footer that admits a file can go out of date. The page
   served to a browser is rebuilt per request and says so instead. */
fetchGuide(BASE + '/guide?saved=1').then((html) => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log('wrote ' + OUT + '  (' + (html.length / 1024).toFixed(0) + ' KB)');
  /* Counted off the page rather than reported by the builder, so this says what
     was actually written rather than what was meant to be — but counted on a
     marker only a room carries. `details class="room"` is also worn by the
     Screens block, which reported seven rooms as eight. */
  console.log((html.match(/the first word is enough/g) || []).length + ' rooms, '
    + (html.match(/<div class="grp">/g) || []).length + ' groups of circuits');
}).catch((err) => {
  console.error('failed: ' + err.message);
  console.error('Is a server running? node tools/make-guide.js http://192.168.1.3:3000');
  process.exit(1);
});
