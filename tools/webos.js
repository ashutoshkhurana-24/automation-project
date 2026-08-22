// An SSAP client for LG webOS televisions.
//
// SSAP is LG's own WebSocket protocol — the one the Magic Remote app speaks —
// and it lives on ws://<tv>:3000 (wss on 3001). That makes it the same shape as
// the hub protocol this project already speaks, so it needs nothing beyond the
// `ws` that is already bundled. That matters: the box has no reliable internet,
// which is why every other awkward thing here (the icon, the lens map) is
// hand-rolled rather than installed.
//
// Three things about these televisions that shape the whole design:
//
//   * A TV answers.  Unlike the IR air conditioners and unlike colour on the
//     COBs, SSAP has real subscriptions — volume, mute, power state, current
//     input and current app all push when they change, however they were
//     changed.  Someone using the remote is *visible*.  This is the first
//     device class in the house whose reading is a reading rather than a
//     belief, and the code should not throw that away by polling.
//
//   * You cannot switch one on over SSAP.  The network chip dies with the
//     screen, so there is nobody listening.  On is a Wake-on-LAN magic packet
//     to the TV's MAC; off is SSAP.  Both of this house's sets advertise
//     `WAKEUP: MAC=...;Timeout=60` in their DIAL reply, which is LG saying it
//     supports this — but it still needs "Mobile TV On" enabled on the set,
//     and a magic packet is a broadcast, so it does not cross subnets.
//
//   * They are fussy about transport.  A 2024-era set (QNED82BXA here) speaks
//     only wss on 3001 and resets a plain ws on 3000 without an HTTP status —
//     so the failure arrives as a bare ECONNRESET and reads like a network
//     fault rather than a refusal.  Older sets are the other way round.  The
//     certificate is self-signed by the television, so it cannot be verified.
//
//   * Pairing is a prompt on the screen.  The first connection puts a dialog in
//     front of whoever is watching and waits, sometimes a full minute, for
//     someone to press Accept on the remote.  The TV then hands back a
//     client-key which is good forever.  Store it; never make a person do that
//     twice.  Keys live in data/tv-keys.json, git-ignored, one per TV.
//
// Used as a library by the dashboard, and as a command line by tools/tv.js.

const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { execFile } = require('child_process');
const WebSocket = require('ws');

const KEYS = path.join(__dirname, '..', 'data', 'tv-keys.json');

// The manifest we register with, and the one thing here that had to be found by
// experiment rather than copied.
//
// Every open-source client sends the public "LG Remote App" manifest carrying
// LG's own test-signing certificate. This firmware refuses it outright:
//
//     403 Pairing rejected: blacklisted certificate detected
//
// LG has blocked that signature. What it has *not* done is require a valid one:
// sending the same manifest with the `signatures` block simply left out is
// accepted and puts the pairing prompt on the screen. Measured on the
// QNED82BXA, four manifest shapes tried — the canonical one is refused, the
// unsigned one passes. So there is no signature here on purpose; do not
// helpfully add one back.
//
// Do not trim the permission lists to what we happen to use today either. The
// set grants exactly what is asked for at pairing time, and adding one later
// means putting the dialog back on the screen for a person to accept twice.
const MANIFEST = {
  manifestVersion: 1,
  appVersion: '1.1',
  signed: {
    created: '20140509',
    appId: 'com.lge.test',
    vendorId: 'com.lge',
    localizedAppNames: { '': 'LG Remote App', 'ko-KR': '리모컨 앱', 'zxx-XX': 'ЛГ Rэмotэ AПП' },
    localizedVendorNames: { '': 'LG Electronics' },
    permissions: [
      'TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD',
      'READ_INSTALLED_APPS', 'READ_LGE_SDX', 'READ_NOTIFICATIONS', 'SEARCH',
      'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'CONTROL_POWER',
      'READ_CURRENT_CHANNEL', 'READ_RUNNING_APPS', 'READ_UPDATE_INFO',
      'UPDATE_FROM_REMOTE_APP', 'READ_LGE_TV_INPUT_EVENTS', 'READ_TV_CURRENT_TIME',
    ],
    serial: '2f930e2d2cfe083771f68e4fe7bb07',
  },
  /* This is the list that is actually granted. The one inside `signed` above is
     decorative — proven by asking the set what it could do and getting 401 on
     exactly the calls whose permission sat there and not here: the installed-app
     list, the firmware version, picture settings, and the pointer-input socket
     that carries the remote buttons.
     Asked for in one go on purpose. A set grants what was requested at pairing
     time and nothing more, so every later addition costs somebody a walk to the
     television to accept a prompt again. Better to ask once. */
  permissions: [
    'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED',
    'TEST_SECURE', 'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK',
    'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK',
    'CONTROL_INPUT_TV', 'CONTROL_POWER', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL',
    'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE', 'READ_RUNNING_APPS',
    'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE',
    'READ_COUNTRY_INFO',
    // the four that were answering 401, and the ones that ride alongside them
    'READ_INSTALLED_APPS', 'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_INPUT_TEXT',
    'READ_UPDATE_INFO', 'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT',
    'READ_NOTIFICATIONS', 'SEARCH', 'READ_TV_CURRENT_TIME',
    'READ_LGE_TV_INPUT_EVENTS', 'UPDATE_FROM_REMOTE_APP',
  ],
};

/* Keys are filed under the television's MAC, not its address.
 *
 * They were filed under the address first, and DHCP moved every set in this
 * house twice in one evening — so a key earned by making somebody walk to the
 * television and press Accept was quietly orphaned by a lease renewal. The MAC
 * is the only identifier a television keeps. The address is looked up in the
 * ARP table, which is free and already populated by anything that has just
 * talked to the set; a machine that cannot resolve it falls back to filing
 * under the address, which is no worse than before. */
const readKeys = () => {
  try { return JSON.parse(fs.readFileSync(KEYS, 'utf8')); } catch (e) { return {}; }
};
const writeKeys = (all) => fs.writeFileSync(KEYS, JSON.stringify(all, null, 2) + '\n');

const MAC_RE = /([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i;
const norm = (m) => m.toLowerCase().split(':').map((b) => b.padStart(2, '0')).join(':');

function macFor(ip) {
  return new Promise((resolve) => {
    // `ip neigh` on the hub, `arp -n` on a Mac. Whichever is missing simply
    // errors and we fall through to the other.
    execFile('ip', ['neigh', 'show', ip], (e, out) => {
      const m = !e && out && MAC_RE.exec(out);
      if (m) return resolve(norm(m[1]));
      execFile('arp', ['-n', ip], (e2, out2) => {
        const m2 = !e2 && out2 && MAC_RE.exec(out2);
        resolve(m2 ? norm(m2[1]) : null);
      });
    });
  });
}

/* The reverse of macFor: which address does the kernel currently associate with
 * this MAC?
 *
 * SSDP is not enough on its own. A set sitting in its screensaver does not
 * answer an M-SEARCH at all — measured on a QNED70BLA, which was pingable, had
 * 3001 open and reported "Screen Saver", yet never appeared in a twelve-second
 * sweep. With discovery as the only route the dashboard could never find it,
 * so a configured television read as off for as long as it screensavered.
 *
 * The neighbour table needs no cooperation from the set: the box is on the same
 * LAN, so the kernel already holds the mapping from having talked to it. Both
 * forms are tried for the same reason macFor tries both.
 */
function ipForMac(mac) {
  const want = norm(String(mac || ''));
  if (!want) return Promise.resolve(null);
  const IP_RE = /(\d{1,3}(?:\.\d{1,3}){3})/;
  const scan = (out) => {
    for (const line of String(out || '').split('\n')) {
      const m = MAC_RE.exec(line);
      if (!m || norm(m[1]) !== want) continue;
      const ip = IP_RE.exec(line);
      /* FAILED and INCOMPLETE entries name an address the kernel could not
         reach, which is worse than no answer — it would be tried and time out
         on every retry. */
      if (ip && !/\b(FAILED|INCOMPLETE)\b/i.test(line)) return ip[1];
    }
    return null;
  };
  return new Promise((resolve) => {
    execFile('ip', ['neigh'], (e, out) => {
      const hit = !e && scan(out);
      if (hit) return resolve(hit);
      execFile('arp', ['-an'], (e2, out2) => resolve((!e2 && scan(out2)) || null));
    });
  });
}

class WebosTV {
  constructor(ip, opts) {
    this.ip = ip;
    this.opts = opts || {};
    this.ws = null;
    this.seq = 0;
    this.waiting = new Map();          // id -> {resolve, reject, keep}
    this.mac = this.opts.mac || null;
    this.key = this.opts.key || null;
    this.spoke = false;                  // did any port get as far as opening
  }

  // Find this set's key: by MAC where we can resolve one, and — for a store
  // written before keys were filed that way — under the address, which is then
  // migrated so it survives the next lease.
  async loadKey() {
    if (this.key) return this.key;
    const all = readKeys();
    if (!this.mac) this.mac = await macFor(this.ip);
    if (this.mac && all[this.mac]) return (this.key = all[this.mac]);
    if (all[this.ip]) {
      this.key = all[this.ip];
      if (this.mac) { all[this.mac] = this.key; delete all[this.ip]; writeKeys(all); }
      return this.key;
    }
    return null;
  }

  saveKey(key) {
    const all = readKeys();
    all[this.mac || this.ip] = key;
    writeKeys(all);
  }

  // Resolves once the set has accepted us. If there is no stored key this puts
  // a dialog on the screen and waits for a person, which is why the timeout is
  // generous and separate from the connect timeout.
  // Newer sets speak only wss on 3001 and reset a plain ws on 3000 — measured
  // on the QNED82BXA, which drops the connection without an HTTP status, so it
  // surfaces as a bare ECONNRESET and looks like a network fault rather than a
  // refusal. Older ones only speak the plain one. Try secure, then fall back.
  // The certificate is self-signed by the television, so it cannot be verified
  // and there is nothing to verify it against.
  async connect(pairTimeoutMs) {
    await this.loadKey();
    const wait = pairTimeoutMs || (this.key ? 12000 : 75000);
    try {
      return await this.dial('wss://' + this.ip + ':3001', { rejectUnauthorized: false }, wait);
    } catch (e) {
      /* Only fall back when the secure port failed at the transport level. If it
         opened, the set was talking to us and its answer is the real one — so
         reporting the plain port's failure instead actively misleads. That cost
         a wrong diagnosis: a set that had raised a pairing prompt and waited
         ninety seconds for somebody to accept it was reported as ECONNRESET,
         which reads like a refusal. */
      if (this.spoke) throw e;
      return this.dial('ws://' + this.ip + ':3000', {}, wait);
    }
  }

  dial(url, extra, wait) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, Object.assign({ handshakeTimeout: 6000 }, extra));
      this.ws = ws;

      const fail = (e) => { clearTimeout(timer); try { ws.terminate(); } catch (x) {} reject(e); };
      ws.on('unexpected-response', (rq, r) => fail(new Error(url + ' answered HTTP ' + r.statusCode)));
      const timer = setTimeout(() => fail(new Error(
        this.key ? 'the TV did not answer our key in time'
                 : 'nobody accepted the pairing prompt on the TV')), wait);

      ws.on('error', fail);
      ws.on('close', () => {
        for (const w of this.waiting.values()) w.reject(new Error('socket closed'));
        this.waiting.clear();
      });

      ws.on('open', () => {
        this.spoke = true;               // this port talks; do not try the other
        const payload = Object.assign(
          // Forcing sends no key on purpose: presenting the old one invites the
          // set to renew the grant it already made, and the whole point of a
          // forced pairing is to be granted the *wider* list above.
          { forcePairing: !!this.opts.force, pairingType: 'PROMPT', manifest: MANIFEST },
          this.key && !this.opts.force ? { 'client-key': this.key } : {});
        ws.send(JSON.stringify({ type: 'register', id: 'register_0', payload }));
      });

      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch (e) { return; }

        if (m.id === 'register_0') {
          // The set answers a register twice: once to say the prompt is up,
          // then again — possibly a minute later — once someone accepts.
          if (m.type === 'registered') {
            clearTimeout(timer);
            const k = m.payload && m.payload['client-key'];
            if (k && k !== this.key) { this.key = k; this.saveKey(k); this.paired = true; }
            return resolve(this);
          }
          if (m.type === 'error') return fail(new Error(m.error || 'registration refused'));
          return;                                       // "PROMPT is showing"
        }

        const w = this.waiting.get(m.id);
        if (!w) return;
        if (m.type === 'error') {
          this.waiting.delete(m.id);
          return w.reject(new Error(m.error || 'request failed'));
        }
        if (w.keep) return w.resolve(m.payload);        // a subscription frame
        this.waiting.delete(m.id);
        w.resolve(m.payload);
      });
    });
  }

  send(type, uri, payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
      const id = String(++this.seq);
      this.waiting.set(id, { resolve, reject, keep: type === 'subscribe' });
      this.ws.send(JSON.stringify({ id, type, uri, payload: payload || {} }));
      if (type !== 'subscribe') {
        setTimeout(() => {
          if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error('timed out: ' + uri)); }
        }, 8000);
      }
    });
  }

  request(uri, payload) { return this.send('request', uri, payload); }

  // The handler is called with every push, including the first one, so a caller
  // never has to read once and subscribe separately and reconcile the two.
  subscribe(uri, handler) {
    const id = String(++this.seq);
    this.waiting.set(id, { resolve: handler, reject: () => {}, keep: true });
    this.ws.send(JSON.stringify({ id, type: 'subscribe', uri, payload: {} }));
    return id;
  }

  /* Both sockets, not just the SSAP one. The remote's pointer socket is a
     second connection the set hands out, and closing only the first left it
     dangling on every reconnect — a television that goes off and on all day
     would leak one file descriptor per cycle, which is the kind of thing that
     takes a fortnight to become a crash. */
  close() {
    try { this._remote && this._remote.close(); } catch (e) {}
    this._remote = null;
    try { this.ws && this.ws.close(); } catch (e) {}
  }

  /* ── the things the dashboard would actually call ──────────────────── */

  off()                { return this.request('ssap://system/turnOff'); }
  getVolume()          { return this.request('ssap://audio/getVolume'); }
  setVolume(v)         { return this.request('ssap://audio/setVolume', { volume: Math.max(0, Math.min(100, Math.round(v))) }); }
  setMute(on)          { return this.request('ssap://audio/setMute', { mute: !!on }); }
  powerState()         { return this.request('ssap://com.webos.service.tvpower/power/getPowerState'); }
  foreground()         { return this.request('ssap://com.webos.applicationManager/getForegroundAppInfo'); }
  inputs()             { return this.request('ssap://tv/getExternalInputList'); }
  switchInput(id)      { return this.request('ssap://tv/switchInput', { inputId: id }); }
  apps()               { return this.request('ssap://com.webos.applicationManager/listLaunchPoints'); }
  launch(id)           { return this.request('ssap://system.launcher/launch', { id }); }
  toast(message)       { return this.request('ssap://system.notifications/createToast', { message }); }

  /* Open a particular video in the YouTube app.
   *
   * It is `params.contentTarget` carrying a leanback URL that does this, and
   * nothing else. Three plausible calls were tried and two of them are traps,
   * because all three answer returnValue true:
   *   - `contentId` launches the app and lands on its home screen. It looks
   *     like the obvious field and it is purely an app launcher.
   *   - `system.launcher/open` with a watch URL opens the television's *web
   *     browser*. The video does play, which is what made this look solved for
   *     a while — in the wrong application.
   *   - DIAL (`POST /apps/YouTube` with `v=<id>`) answers 200 once an Origin
   *     header is present, reports the app as running, and still shows the
   *     home screen: real casting goes on to YouTube's Lounge API, which is a
   *     cloud service, not this.
   * contentTarget also works on an app that is already open, so nothing needs
   * closing or bouncing through Live TV first. */
  youtube(video) {
    const id = youtubeId(video);
    if (!id) throw new Error('not a YouTube link or id: ' + video);
    return this.request('ssap://system.launcher/launch', {
      id: 'youtube.leanback.v4',
      params: { contentTarget: 'https://www.youtube.com/tv?v=' + id },
    });
  }

  /* What is actually playing — the one honest instrument on this set.
   *
   * Empty while an app sits on its own home screen; a single entry with
   * playState and a mediaId once something is really playing. That difference
   * is what finally separated "the app opened" from "the video is on", after
   * several rounds of asking a person to look at the screen. The mediaId
   * changes per video, so a deep-link can be *confirmed* rather than assumed. */
  async media() {
    const r = await this.request('ssap://com.webos.media/getForegroundAppInfo', {});
    return (r.foregroundAppInfo || [])[0] || null;
  }
  volumeUp()           { return this.request('ssap://audio/volumeUp'); }
  volumeDown()         { return this.request('ssap://audio/volumeDown'); }
  play()               { return this.request('ssap://media.controls/play'); }
  pause()              { return this.request('ssap://media.controls/pause'); }

  /* The remote buttons do not travel over SSAP at all. The set hands back the
     address of a *second* socket and the buttons go down that one as plain
     text, not JSON — a shape worth knowing before debugging it, because sending
     JSON there is accepted and does nothing.
     It also needs CONTROL_MOUSE_AND_KEYBOARD, which has to be in the top-level
     permission list at pairing time; without it the request for the address is
     a 401 and the whole channel looks absent rather than unauthorised. */
  async remote() {
    if (this._remote) return this._remote;
    const r = await this.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
    if (!r.socketPath) throw new Error('the set gave no remote socket');
    const ws = new WebSocket(r.socketPath, { rejectUnauthorized: false, handshakeTimeout: 6000 });
    await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); });
    ws.on('close', () => { this._remote = null; });
    const send = (s) => ws.send(s);
    return (this._remote = {
      button: (name) => send('type:button\nname:' + String(name).toUpperCase() + '\n\n'),
      click: () => send('type:click\n\n'),
      move: (dx, dy) => send('type:move\ndx:' + dx + '\ndy:' + dy + '\ndown:0\n\n'),
      scroll: (dx, dy) => send('type:scroll\ndx:' + dx + '\ndy:' + dy + '\n\n'),
      close: () => ws.close(),
    });
  }
  swInfo()             { return this.request('ssap://com.webos.service.update/getCurrentSWInformation'); }

  /* Which interface the set is actually using, which is the one fact that
     decides whether it can be switched on. It answers with a MAC per interface —
     wiredInfo, wifiInfo, p2pInfo — and the one that matches the address ARP
     knows is the live one.
     Two things about this call. The payload must be empty: `{category:'network'}`
     is refused with "could not validate json message against schema", which
     reads like the method is missing when it is only fussy. And it lives under
     a service that `getServiceList` does not mention at all, so the list is not
     the last word on what a set will answer. */
  network()            { return this.request('ssap://com.webos.service.connectionmanager/getinfo', {}); }
}

/* Anything a person is likely to paste. A bare id is passed straight through,
   so a caller that already has one does not have to know the URL shapes. */
function youtubeId(v) {
  const s = String(v || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = /(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/.exec(s);
  return m ? m[1] : null;
}

// On is not SSAP. A magic packet is six 0xFF bytes then the MAC sixteen times,
// sent to the broadcast address — which is precisely why it will not reach a
// television on another subnet, whatever routing is in place for TCP.
function wake(mac, broadcast) {
  return new Promise((resolve, reject) => {
    const bytes = mac.replace(/[^0-9a-f]/gi, '');
    if (bytes.length !== 12) return reject(new Error('not a MAC address: ' + mac));
    const addr = Buffer.from(bytes, 'hex');
    const pkt = Buffer.concat([Buffer.alloc(6, 0xff), Buffer.concat(new Array(16).fill(addr))]);
    const s = dgram.createSocket('udp4');
    s.once('error', (e) => { s.close(); reject(e); });
    s.bind(() => {
      s.setBroadcast(true);
      // Port 9 is the conventional one; LG also listens on 7. Send both rather
      // than find out at 11pm that the set wanted the other.
      let left = 2;
      const done = () => { if (--left === 0) { s.close(); resolve(); } };
      s.send(pkt, 9, broadcast || '255.255.255.255', done);
      s.send(pkt, 7, broadcast || '255.255.255.255', done);
    });
  });
}

/* Discovery is SSDP, and worth doing by M-SEARCH rather than by scanning: the
   reply carries the model, the friendly name and — in the DIAL record — the
   MAC, which is the one thing needed to switch the set back on and the one
   thing an IP scan cannot tell you. */
function discover(ms) {
  return new Promise((resolve) => {
    // Grouped by the address the reply came from, because that is the only
    // thing we could actually connect to. A television emits several SSDP
    // records and only some carry the MAC, so the MAC is collected across all
    // of them rather than used as the key.
    const byIp = new Map();
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', (m, r) => {
      const t = m.toString();
      if (!/lge|webos/i.test(t)) return;
      const tv = byIp.get(r.address) || { ip: r.address, macs: new Set() };
      const name = /^DLNADeviceName\.lge\.com:\s*(.+)$/mi.exec(t);
      const link = /^LGLINK-NAME\s*:\s*(.+)$/mi.exec(t);
      const mac = /^WAKEUP:\s*MAC=([0-9a-f:]+)/mi.exec(t);
      if (name && !tv.name) tv.name = decodeURIComponent(name[1].trim());
      if (link && !tv.model) tv.model = link[1].trim();
      if (mac) tv.macs.add(mac[1].trim().toLowerCase());
      byIp.set(r.address, tv);
    });
    s.bind(() => {
      const ask = (st) => s.send(Buffer.from(
        'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: '
        + st + '\r\n\r\n'), 1900, '239.255.255.250');
      ask('urn:lge:device:tv:1');
      ask('urn:dial-multiscreen-org:service:dial:1');
      ask('ssdp:all');
    });
    setTimeout(() => {
      s.close();
      resolve([...byIp.values()].map((t) => ({
        ip: t.ip, name: t.name, model: t.model,
        macs: [...t.macs],
        // More than one television answering from a single address means a
        // router replied for them: they are behind a NAT and nothing at that
        // address is a set we can talk to.
        natted: t.macs.size > 1,
      })));
    }, ms || 5000);
  });
}

module.exports = { WebosTV, wake, readKeys, macFor, ipForMac, discover, youtubeId, KEYS };
