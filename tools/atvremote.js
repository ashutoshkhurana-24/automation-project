'use strict';
/* ── Android TV Remote v2 ─────────────────────────────────────────────────
 *
 * A client for the protocol Google's own remote app speaks: TLS on two ports,
 * 6467 to pair and 6466 to drive. Written for the media player in HOME THEATRE
 * — an **XstreamIPTV2-SM** (Sercomm, model ASD6101SR) on Ethernet — and, like
 * every other protocol in this project, measured against the hardware rather
 * than taken from a document.
 *
 * **Why this and not ADB.** ADB was the first choice and is not available: the
 * box has developer options but both USB and wireless debugging are disabled
 * and cannot be enabled on it. Measured before giving up — port 5555 refuses,
 * no `_adb-tls-connect` / `_adb-tls-pairing` / `_adb` on mDNS, and a full sweep
 * of all 65535 ports found only 53, 6466, 6467, 8008, 8009 and 9000. So there
 * is no ADB to reach. Do not re-try that route.
 *
 * What is left is better anyway, for the reason this file's parent already
 * gives about the televisions: **this protocol answers.** The box pushes its
 * own volume, mute, power state and the package name of whatever app is in the
 * foreground, whoever caused the change — so a media player's state here is a
 * reading, not a belief, and it must not be polled.
 *
 * **Google Cast (8008/8009) is open too and is not enough.** It launches apps
 * and reports what is playing, but it carries no directional pad — and for an
 * IPTV box the pad is the whole point, since everything worth doing happens
 * inside an app's own grid. It is a launcher, not a remote.
 *
 * **Pairing is a person**, exactly as it is for the LG sets: the first
 * connection puts a six-character code on the screen and somebody has to read
 * it out. Note the screen here is whatever the box is plugged into — through
 * the receiver's MPLAY input to the projector — so pairing needs the projector
 * on, which the televisions never did.
 *
 * No new dependency. Protobuf is hand-rolled below, which sounds worse than it
 * is: this protocol uses four wire features (varint, length-delimited, nested
 * message, bool) and the whole encoder is about forty lines. The precedent is
 * the PNG encoder in make-icon.js and the Denon parser in server.js — a small
 * hand-written codec beats a dependency the hub has to be taught to install.
 */

const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/* ── the smallest protobuf that will do ───────────────────────────────────
 * Wire types used: 0 (varint: int32, bool, enum) and 2 (length-delimited:
 * string, bytes, nested message). Nothing here needs the other three. */

function varint(n) {
  const out = [];
  let v = Number(n);
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}
const tag = (field, wire) => varint((field << 3) | wire);
const pbInt = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const pbBool = (field, b) => Buffer.concat([tag(field, 0), varint(b ? 1 : 0)]);
function pbLen(field, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
}
const pbMsg = pbLen;
const pbStr = pbLen;

/** Read a varint at `pos`. Returns [value, nextPos]. */
function readVarint(buf, pos) {
  let result = 0, shift = 0, p = pos;
  for (;;) {
    if (p >= buf.length) return [null, pos];
    const b = buf[p++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result, p];
}

/* Decodes one message into { field: [values] }. A length-delimited field comes
   back as a Buffer, which the caller re-decodes if it knows it is nested — the
   wire format cannot tell a nested message from a string, so only the caller's
   knowledge of the schema can. */
function decode(buf) {
  const out = {};
  let p = 0;
  const put = (f, v) => { (out[f] = out[f] || []).push(v); };
  while (p < buf.length) {
    const [key, p1] = readVarint(buf, p);
    if (key == null) break;
    p = p1;
    const field = key >>> 3, wire = key & 7;
    if (wire === 0) {
      const [v, p2] = readVarint(buf, p);
      if (v == null) break;
      p = p2; put(field, v);
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, p);
      if (len == null || p2 + len > buf.length) break;
      put(field, buf.slice(p2, p2 + len));
      p = p2 + len;
    } else if (wire === 5) { p += 4; }
    else if (wire === 1) { p += 8; }
    else break;   // group wire types: not used by this protocol
  }
  return out;
}
const one = (m, f) => (m[f] && m[f].length ? m[f][0] : undefined);

/* ── framing ──────────────────────────────────────────────────────────────
 * Every message on both ports is prefixed with its length as a varint. A TLS
 * record boundary is not a message boundary, so the reader buffers and only
 * hands over whole messages. */
function framer(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const [len, pos] = readVarint(buf, 0);
      if (len == null || buf.length < pos + len) return;
      const body = buf.slice(pos, pos + len);
      buf = buf.slice(pos + len);
      onMessage(body);
    }
  };
}
const frame = (body) => Buffer.concat([varint(body.length), body]);

/* ── the client identity ──────────────────────────────────────────────────
 * A self-signed certificate. The box records its fingerprint when somebody
 * accepts the pairing code and recognises it on every connection afterwards, so
 * this file IS the pairing — losing it costs another walk to the screen. Kept
 * out of git for the same reason data/tv-keys.json is: it is a credential, and
 * it is per-install.
 *
 * Node cannot issue an X.509 certificate, so openssl does it. That is a real
 * dependency and it was checked on the hub rather than assumed: OpenSSL 1.1.1f
 * is present at /usr/bin/openssl. */
function newIdentity(commonName = 'atvremote') {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'atv-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '7300',
      '-subj', '/CN=' + commonName], { stdio: 'ignore' });
    return {
      key: fs.readFileSync(keyPath, 'utf8'),
      cert: fs.readFileSync(certPath, 'utf8'),
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

/* The RSA modulus and exponent as minimal big-endian bytes — no sign byte, no
   padding. This has to match what the box does on its side exactly or the
   pairing hash will not agree, and a wrong hash is reported only as a flat
   refusal with nothing to debug. A JWK export gives base64url of precisely
   these minimal forms, which is why it is read that way rather than by picking
   the DER apart. */
function rsaParts(pem) {
  const jwk = crypto.createPublicKey(pem).export({ format: 'jwk' });
  return {
    n: Buffer.from(jwk.n, 'base64url'),
    e: Buffer.from(jwk.e, 'base64url'),
  };
}

/* ── pairing (port 6467) ──────────────────────────────────────────────────
 *
 * Six exchanges, then the code appears and the seventh proves we were told it:
 *
 *   ->  PairingRequest        { service_name, client_name }
 *   <-  PairingRequestAck
 *   ->  PairingOption         { input_encodings: [hex, 6], preferred_role: input }
 *   <-  PairingOptionAck
 *   ->  PairingConfiguration  { encoding: [hex, 6], client_role: input }
 *   <-  PairingConfigurationAck      <-- the code appears on the screen here
 *   ->  PairingSecret         { secret: sha256(...) }
 *   <-  PairingSecretAck
 *
 * The secret is a SHA-256 over both public keys and the code, which is what
 * proves a person is looking at the screen rather than a stranger on the LAN
 * guessing: client modulus, client exponent, server modulus, server exponent,
 * then the last two of the code's three bytes. The **first** byte is a check
 * digit — it must equal the first byte of the digest, which is how a mistyped
 * code is caught here rather than by the box.
 */
const STATUS_OK = 200;
const ENCODING_HEX = 3;
const ROLE_INPUT = 1;

class Pairing {
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port || 6467;
    this.identity = opts.identity;
    this.clientName = opts.clientName || 'the-house';
    this.serviceName = opts.serviceName || 'atvremote';
    this.sock = null;
    this.step = 0;
    this.waiters = [];
  }

  /** Opens the socket and runs as far as the code appearing on screen. */
  begin() {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({
        host: this.host, port: this.port,
        key: this.identity.key, cert: this.identity.cert,
        rejectUnauthorized: false,   // the box signs its own; there is nothing to verify against
        timeout: 15000,
      }, () => {
        this.serverCert = sock.getPeerCertificate();
        this.send(Buffer.concat([
          pbInt(1, 2),                       // protocol_version
          pbInt(2, STATUS_OK),               // status
          pbMsg(10, Buffer.concat([          // pairing_request
            pbStr(1, this.serviceName),
            pbStr(2, this.clientName),
          ])),
        ]));
      });
      this.sock = sock;
      sock.on('data', framer((body) => this.absorb(body, resolve, reject)));
      sock.on('error', (e) => reject(e));
      sock.on('timeout', () => reject(new Error('the media player did not answer the pairing port')));
      sock.on('close', () => {
        if (this.step < 3) reject(new Error('the media player closed the pairing connection'));
      });
    });
  }

  send(body) { this.sock.write(frame(body)); }

  absorb(body, resolve, reject) {
    const m = decode(body);
    const status = one(m, 2);
    if (status !== undefined && status !== STATUS_OK) {
      return reject(new Error('the media player refused pairing (status ' + status + ')'));
    }
    if (m[11]) {                 // PairingRequestAck -> send the option
      this.step = 1;
      return this.send(Buffer.concat([
        pbInt(2, STATUS_OK),
        pbMsg(20, Buffer.concat([
          pbMsg(1, Buffer.concat([pbInt(1, ENCODING_HEX), pbInt(2, 6)])),  // input_encodings
          pbInt(3, ROLE_INPUT),                                            // preferred_role
        ])),
      ]));
    }
    if (m[21]) {                 // PairingOptionAck -> send the configuration
      this.step = 2;
      return this.send(Buffer.concat([
        pbInt(2, STATUS_OK),
        pbMsg(30, Buffer.concat([
          pbMsg(1, Buffer.concat([pbInt(1, ENCODING_HEX), pbInt(2, 6)])),  // encoding
          pbInt(2, ROLE_INPUT),                                            // client_role
        ])),
      ]));
    }
    if (m[31]) {                 // PairingConfigurationAck -> the code is on screen
      this.step = 3;
      return resolve();
    }
    if (m[41]) {                 // PairingSecretAck
      this.step = 4;
      const w = this.waiters.shift();
      if (w) w.resolve();
      return;
    }
  }

  /** The code somebody read off the screen. Six hex characters. */
  finish(code) {
    const clean = String(code).trim().replace(/\s+/g, '').toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(clean)) {
      throw new Error('the code is six characters, 0-9 and A-F — got "' + code + '"');
    }
    const codeBytes = Buffer.from(clean, 'hex');
    const mine = rsaParts(this.identity.cert);
    const theirs = rsaParts(this.serverCert.pubkey
      ? this.serverCert.pubkey
      : crypto.createPublicKey({ key: this.serverCert.raw, format: 'der', type: 'spki' }));

    const h = crypto.createHash('sha256');
    h.update(mine.n); h.update(mine.e);
    h.update(theirs.n); h.update(theirs.e);
    h.update(codeBytes.slice(1));            // the first byte is the check digit
    const digest = h.digest();
    if (digest[0] !== codeBytes[0]) {
      throw new Error('that code does not match — read it off the screen again');
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.send(Buffer.concat([
        pbInt(2, STATUS_OK),
        pbMsg(40, pbLen(1, digest)),          // pairing_secret
      ]));
      setTimeout(() => reject(new Error('the media player did not confirm the code')), 15000);
    });
  }

  close() { try { this.sock && this.sock.destroy(); } catch (_) {} }
}

/* ── the remote session (port 6466) ───────────────────────────────────────
 *
 * Opens with a configure exchange, then stays open. Everything after that is
 * the box telling us things: whether it is awake, its volume and mute, and the
 * package name of whatever is in the foreground. We speak only to inject a key,
 * launch a link, or answer a ping.
 *
 * **The field numbers below were measured, and every one of my first guesses
 * was wrong.** They are not documented anywhere; the box was asked. Reading a
 * live session told us:
 *
 *   1   RemoteConfigure        both ways. Its reply named the box:
 *                              "XstreamIPTV2-SM" / "Sercomm" /
 *                              com.google.android.tv.remote.service 6.9
 *   2   RemoteSetActive        we send it; the box acks with an empty field 2
 *   8   RemotePingRequest      { counter, uptime_ms }, INBOUND every 6.507s
 *   9   RemotePingResponse     { counter } — see below, this one is load-bearing
 *  10   RemoteKeyInject        { key_code, direction } — outbound
 *  20   RemoteImeKeyInject     INBOUND, and the useful one: nested
 *                              { 1: { 12: "com.android.tv.settings" } } is the
 *                              package name of the foreground app
 *  40   RemoteStart            INBOUND { started } — the power state
 *  50   RemoteSetVolumeLevel   INBOUND, carries the device name, max and level
 *  90   RemoteAppLinkLaunchRequest  outbound
 *
 * **Answering the ping is not politeness, it is the session.** The first
 * listening run ignored those field-8 messages, took three of them at 6.5s
 * apart and was then hung up on. That failure looks exactly like a rejected
 * certificate or a wrong key code — a connection that opens, does nothing and
 * dies — so anyone debugging this later should check the pong before anything
 * else. The counter in field 2 is the box's own uptime in milliseconds, which
 * is a handy sanity check that you are talking to the machine you think.
 */
const KEYS = {
  up: 19, down: 20, left: 21, right: 22, ok: 23,
  back: 4, home: 3, menu: 82,
  play: 85, stop: 86, next: 87, previous: 88,
  rewind: 89, forward: 90,
  volup: 24, voldown: 25, mute: 164,
  power: 26, search: 84, info: 165, guide: 172,
};
/* A tap. START_LONG is 1 and END_LONG is 2; nothing here needs to hold a key. */
const DIRECTION_SHORT = 3;

class RemoteSession {
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port || 6466;
    this.identity = opts.identity;
    this.sock = null;
    this.ready = false;
    this.onChange = opts.onChange || (() => {});
    /* What the box has told us. Every one of these is a reading — it pushes
       them whoever caused the change, including its own remote. */
    this.started = false;
    this.volume = null;
    this.volumeMax = null;
    this.muted = false;
    this.app = '';
    this.model = '';
    this.vendor = '';
    this.uptime = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve(this);
      };
      const sock = tls.connect({
        host: this.host, port: this.port,
        key: this.identity.key, cert: this.identity.cert,
        rejectUnauthorized: false,
        timeout: 0,
      }, () => {
        this.write(pbMsg(1, Buffer.concat([
          pbInt(1, 622),
          pbMsg(2, Buffer.concat([
            pbStr(1, 'the-house'),             // model
            pbStr(2, 'dashboard'),             // vendor
            pbInt(3, 1),
            pbStr(4, '1'),
            pbStr(5, 'com.ashutosh.thehouse'), // package
            pbStr(6, '1.0.0'),                 // app version
          ])),
        ])));
      });
      this.sock = sock;
      sock.on('data', framer((body) => this.absorb(body, done)));
      sock.on('error', (e) => { this.ready = false; done(e); this.onChange(); });
      sock.on('close', () => {
        this.ready = false;
        done(new Error('the media player closed the connection'));
        this.onChange();
      });
      setTimeout(() => done(new Error('the media player did not complete the handshake')), 15000);
    });
  }

  write(body) {
    if (!this.sock) throw new Error('the media player is not connected');
    this.sock.write(frame(body));
  }

  absorb(body, done) {
    const m = decode(body);
    let moved = false;

    if (m[1]) {                       // RemoteConfigure, with the box's own info
      const cfg = decode(m[1][0]);
      const info = cfg[2] ? decode(cfg[2][0]) : {};
      const s = (f) => (info[f] && info[f][0] ? info[f][0].toString('utf8') : '');
      this.model = s(1) || this.model;
      this.vendor = s(2) || this.vendor;
      /* Declare ourselves an active remote. Without this the box holds the
         connection open and ignores every key, which is indistinguishable from
         a wrong key code. */
      this.write(pbMsg(2, pbInt(1, 622)));
      moved = true;
    }
    if (m[2] && !this.ready) {        // RemoteSetActive ack — the session is live
      this.ready = true;
      if (done) done(null);
      moved = true;
    }
    if (m[8]) {                       // RemotePingRequest -> MUST answer or be dropped
      const ping = decode(m[8][0]);
      this.uptime = one(ping, 2) || this.uptime;
      this.write(pbMsg(9, pbInt(1, one(ping, 1) || 1)));
    }
    if (m[40]) {                      // RemoteStart { started }
      const st = decode(m[40][0]);
      const on = !!one(st, 1);
      if (on !== this.started) { this.started = on; moved = true; }
    }
    if (m[50]) {                      // RemoteSetVolumeLevel
      const v = decode(m[50][0]);
      const max = one(v, 6), lvl = one(v, 7), mute = one(v, 5);
      if (max !== undefined && max !== this.volumeMax) { this.volumeMax = max; moved = true; }
      if (lvl !== undefined && lvl !== this.volume) { this.volume = lvl; moved = true; }
      if (mute !== undefined && !!mute !== this.muted) { this.muted = !!mute; moved = true; }
    }
    if (m[20]) {                      // RemoteImeKeyInject — the foreground app
      const ime = decode(m[20][0]);
      if (ime[1]) {
        const appInfo = decode(ime[1][0]);
        const pkg = appInfo[12] && appInfo[12][0] ? appInfo[12][0].toString('utf8') : '';
        if (pkg && pkg !== this.app) { this.app = pkg; moved = true; }
      }
    }
    if (moved) this.onChange();
  }

  key(name) {
    const code = KEYS[name];
    if (code === undefined) throw new Error('no such key: ' + name);
    this.write(pbMsg(10, Buffer.concat([
      pbInt(1, code),
      pbInt(2, DIRECTION_SHORT),
    ])));
  }

  /** An app link — a deep link, or market://launch?id=<package> for a plain app. */
  launch(link) { this.write(pbMsg(90, pbStr(1, String(link)))); }

  close() { try { if (this.sock) this.sock.destroy(); } catch (_) {} }
}

/* ── the key file ─────────────────────────────────────────────────────────
 * Filed by MAC and not by address, the lesson data/tv-keys.json already
 * records: both are DHCP and a renewed lease silently orphans a pairing that
 * cost somebody a walk to the screen. Merged rather than overwritten for the
 * same reason. */
function readIdentities(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}
function writeIdentity(file, mac, identity) {
  const all = readIdentities(file);
  all[String(mac).toLowerCase()] = identity;
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  return all;
}

module.exports = {
  Pairing, RemoteSession, KEYS,
  newIdentity, readIdentities, writeIdentity, rsaParts,
  // exported for the tests, which check the codec without touching the hardware
  _pb: { varint, readVarint, decode, framer, frame, pbInt, pbStr, pbMsg, pbLen, pbBool, one },
};
