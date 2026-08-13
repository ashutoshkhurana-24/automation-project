/**
 * Pravita's Apartment — local web dashboard for a Neo Console Hub (single file).
 *
 *   npm install && npm start   ->  http://localhost:3000
 *
 * Device data is loaded on startup from data/devices.json (preferred:
 * it carries the full hub records + room grouping) and falls back to
 * data/neo_console_devices.csv.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');

const HUB_IP = process.env.HUB_IP || '192.168.1.3';
const HUB_PORT = process.env.HUB_PORT || '8090';
const HUB_URL = `ws://${HUB_IP}:${HUB_PORT}/bms/1/0/A/`;
const PORT = process.env.PORT || 3000;

const JSON_PATH = path.join(__dirname, 'data', 'devices.json');
const CSV_PATH = path.join(__dirname, 'data', 'neo_console_devices.csv');
const SCENES_PATH = path.join(__dirname, 'scenes.json');
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const STATE_PATH = path.join(__dirname, 'state.json');

// ---------------------------------------------------------------- device data

/** @type {Map<number, {room: string, record: object}>} */
const devices = new Map();

function loadFromJson() {
  const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const res = raw.payload.response;

  // record_id -> room name, via areas > departments > sub_area.area_devices
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

  for (const record of res.devices || []) {
    devices.set(record.record_id, {
      room: roomOf.get(record.record_id) || 'OTHER',
      record,
    });
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function loadFromCsv() {
  const lines = fs.readFileSync(CSV_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = parseCsvLine(lines[0]);
  const col = (row, name) => row[head.indexOf(name)];

  for (const line of lines.slice(1)) {
    const row = parseCsvLine(line);
    const id = Number(col(row, 'Record ID'));
    if (!id) continue;
    devices.set(id, {
      room: String(col(row, 'Room / Area') || 'OTHER').trim(),
      record: {
        record_id: id,
        device_name: col(row, 'Device Name'),
        device_type: col(row, 'Device Type'),
        app_type: col(row, 'App Type'),
        device_id: col(row, 'Device ID'),
        channel_id: col(row, 'Channel ID'),
        channel_id_tunable: col(row, 'Tunable Channel ID'),
        device_status: col(row, 'Device Status (Boolean)') === 'TRUE' ? 'true' : 'false',
        is_dimmable: col(row, 'Is Dimmable (Boolean)') === 'TRUE' ? 'true' : 'false',
        is_tunable: col(row, 'Is Tunable (Boolean)') === 'TRUE' ? 'true' : 'false',
        isFan: col(row, 'Is Fan (Boolean)') === 'TRUE' ? 'true' : 'false',
      },
    });
  }
}

function loadDevices() {
  if (fs.existsSync(JSON_PATH)) {
    try {
      loadFromJson();
      if (devices.size) return console.log(`Loaded ${devices.size} devices from devices.json`);
    } catch (err) {
      console.error('devices.json unreadable, falling back to CSV:', err.message);
      devices.clear();
    }
  }
  loadFromCsv();
  console.log(`Loaded ${devices.size} devices from neo_console_devices.csv`);
}

loadDevices();

// Rooms in a stable order, normalised for display.
function roomKey(room) {
  return room.trim().toUpperCase();
}

/**
 * Both brightness and colour temperature ride the same encoding: "false" is 0,
 * "true" is 100, anything between is a percentage as a string. Verified against
 * the hub — sending "0" comes back as "false", "100" comes back as "true".
 */
const encodeLevel = (n) => (n <= 0 ? 'false' : n >= 100 ? 'true' : String(Math.round(n)));

function decodeLevel(v) {
  if (v === 'true') return 100;
  if (v === 'false' || v === '' || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function deviceList() {
  return [...devices.values()].map(({ room, record }) => ({
    record_id: record.record_id,
    name: String(record.device_name || '').trim(),
    room: roomKey(room),
    app_type: record.app_type || 'L',
    device_type: record.device_type || '',
    device_id: String(record.device_id || ''),
    channel_id: String(record.channel_id || ''),
    is_dimmable: record.is_dimmable === 'true',
    is_tunable: record.is_tunable === 'true',
    is_fan: record.isFan === 'true' || /\bFAN\b/i.test(String(record.device_name || '')),
    // A curtain is two momentary relays, not a switch, and the hub keeps no
    // state for it — device_status stays "false" whatever you send.
    is_curtain: (record.app_type || '') === 'C',
    // Only the IR units take mode, fan speed and a temperature; the Home
    // Theatre one is relay-wired and really is just a switch.
    is_ac: (record.app_type || '') === 'AC' && record.device_type === 'IR',
    ac_temp: Number(record.ac_temp) || null,
    channel_open: String(record.channel_open || ''),
    channel_close: String(record.channel_close || ''),
    // A dimmed light reports its percentage here, so on/off is "above zero".
    status: decodeLevel(record.device_status) > 0,
    level: decodeLevel(record.device_status),
    tune: decodeLevel(record.device_status_tunable),
  }));
}

// -------------------------------------------------------------------------- scenes

/**
 * A scene is a set of devices with the state each should be in. Steps carry
 * { record_id, on, level?, tune? }; level and tune are only meaningful on
 * devices that actually dim or tune.
 *
 * Seeded on first run from the devices this installation actually has.
 */
const SEED_SCENES = [
  { id: 'movie-night', name: 'Movie Night', note: 'Home Theatre, low and warm',
    steps: [
      { record_id: 474, on: true, level: 10 }, { record_id: 475, on: true, level: 10 },
      { record_id: 476, on: true, level: 10 }, { record_id: 477, on: true, level: 10 },
      { record_id: 479, on: false }, { record_id: 480, on: false },
      { record_id: 481, on: false }, { record_id: 482, on: false },
      { record_id: 478, on: false }, { record_id: 483, on: false },
      { record_id: 512, on: true },
    ] },
  { id: 'dinner', name: 'Dinner', note: 'Dining bright, living room soft',
    steps: [
      { record_id: 499, on: true, level: 75 }, { record_id: 500, on: true, level: 75 },
      { record_id: 501, on: true, level: 75 }, { record_id: 502, on: true, level: 75 },
      { record_id: 503, on: true },
      { record_id: 485, on: true, level: 35 }, { record_id: 486, on: true, level: 35 },
      { record_id: 487, on: true, level: 35 }, { record_id: 488, on: true, level: 35 },
    ] },
  { id: 'morning', name: 'Morning', note: 'Curtains open, living room full',
    steps: [
      { record_id: 497, on: true }, { record_id: 498, on: true },
      { record_id: 485, on: true, level: 100 }, { record_id: 486, on: true, level: 100 },
      { record_id: 487, on: true, level: 100 }, { record_id: 488, on: true, level: 100 },
      { record_id: 489, on: true, level: 100 }, { record_id: 490, on: true, level: 100 },
      { record_id: 499, on: true, level: 60 }, { record_id: 500, on: true, level: 60 },
    ] },
  // Good Night is per bedroom — you go to bed one room at a time. Every room
  // keeps its foot light as a night light, except Ashu's, which goes fully dark.
  { id: 'ashu-good-night', name: 'Good Night · Ashu', note: 'Ashu Room, fully dark',
    steps: [449, 450, 451, 452, 453, 454, 455, 456, 459, 460, 461]
      .map(record_id => ({ record_id, on: false })) },
  { id: 'master-good-night', name: 'Good Night · Master', note: 'Master Room, foot light on',
    steps: [...[463, 464, 465, 466, 467, 468, 469, 470, 471, 472].map(record_id => ({ record_id, on: false })),
            { record_id: 473, on: true }] },
  { id: 'harshit-good-night', name: 'Good Night · Harshit', note: 'Harshit Room, foot light on',
    steps: [...[440, 441, 442, 443, 444, 445, 446].map(record_id => ({ record_id, on: false })),
            { record_id: 447, on: true }] },
  { id: 'parent-good-night', name: 'Good Night · Parent', note: 'Parent Room, foot light on',
    steps: [...[429, 431, 432, 433, 434, 435, 436, 437].map(record_id => ({ record_id, on: false })),
            { record_id: 438, on: true }] },
  { id: 'focus', name: 'Focus', note: 'Ashu Room, full and cool',
    steps: [
      { record_id: 449, on: true, level: 100, tune: 0 }, { record_id: 450, on: true, level: 100, tune: 0 },
      { record_id: 451, on: true, level: 100, tune: 0 }, { record_id: 452, on: true, level: 100, tune: 0 },
      { record_id: 453, on: true, level: 100, tune: 0 },
      { record_id: 455, on: false }, { record_id: 460, on: false }, { record_id: 461, on: false },
    ] },
  { id: 'wind-down', name: 'Wind Down', note: 'Ashu Room, dim and warm',
    steps: [
      { record_id: 449, on: true, level: 20, tune: 100 }, { record_id: 450, on: true, level: 20, tune: 100 },
      { record_id: 451, on: true, level: 20, tune: 100 }, { record_id: 452, on: false },
      { record_id: 453, on: false },
      { record_id: 455, on: false }, { record_id: 459, on: false }, { record_id: 460, on: false },
      { record_id: 461, on: true },
    ] },
];

let scenes = [];

function loadScenes() {
  try {
    scenes = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
    console.log(`Loaded ${scenes.length} scenes from scenes.json`);
    return;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('scenes.json unreadable, reseeding:', err.message);
  }
  // Keep only the steps whose devices this hub actually has.
  scenes = SEED_SCENES.map((sc) => ({ ...sc, steps: sc.steps.filter(st => devices.has(st.record_id)) }))
    .filter(sc => sc.steps.length);
  saveScenes();
  console.log(`Seeded ${scenes.length} scenes`);
}

function saveScenes() {
  try {
    fs.writeFileSync(SCENES_PATH, JSON.stringify(scenes, null, 2));
  } catch (err) {
    console.error('could not write scenes.json:', err.message);
  }
}

const sceneList = () => scenes.map(sc => ({ ...sc, devices: sc.steps.length }));

// -------------------------------------------------------------------- hub call

function hubSocket() {
  return new WebSocket(HUB_URL, {
    handshakeTimeout: 5000,
    perMessageDeflate: true,
    headers: {
      // No Origin header — the hub answers HTTP 500 to the handshake if one is sent.
      Host: `${HUB_IP}:${HUB_PORT}`,
      'User-Agent': 'Dart/3.10 (dart:io)',
      'Accept-Encoding': 'gzip',
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * The hub pushes one site_config per connection, carrying live status for every
 * device. It sends nothing in response to a control command and does not push
 * changes to an idle socket, so a fresh connection is the only way to read
 * truth — including changes made at a wall switch or from the phone app.
 * Takes ~3s. Concurrent callers share one read.
 */
let hubSync = { at: 0, ok: false, error: 'not read yet' };
let reading = null;

// Counters behind /api/health. This runs unattended on a box nobody looks at,
// so "is it still talking to the hub?" has to be answerable without reading logs.
const startedAt = Date.now();
const stats = {
  readsOk: 0, readsFailed: 0, consecutiveReadFailures: 0,
  commandsSent: 0, commandsFailed: 0, cuesFired: 0,
};

function readHubState() {
  if (reading) return reading;

  reading = new Promise((resolve) => {
    const ws = hubSocket();
    let settled = false;

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reading = null;
      hubSync = { at: Date.now(), ok, error: ok ? null : error };
      if (ok) { stats.readsOk++; stats.consecutiveReadFailures = 0; }
      else { stats.readsFailed++; stats.consecutiveReadFailures++; }
      if (!ok) console.error('hub state read failed:', error);
      try { ws.close(); } catch { /* already gone */ }
      resolve(hubSync);
    };

    const timer = setTimeout(() => {
      finish(false, 'Timed out waiting for site_config');
      ws.terminate();
    }, 9000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.payload?.type !== 'site_config') return;

      for (const rec of msg.payload.response.devices || []) {
        const entry = devices.get(rec.record_id);
        if (entry) entry.record = { ...entry.record, ...rec };
      }
      finish(true);
      trackLit();
      // Anyone watching hears about it immediately — including a wall switch.
      pushSnapshot();
    });

    ws.on('error', (err) => finish(false, err.message));
    ws.on('close', () => finish(false, 'Hub closed before sending state'));
  });

  return reading;
}

/** A read guaranteed to have started after this call — used to confirm commands. */
async function readHubStateFresh() {
  if (reading) await reading;
  return readHubState();
}

/**
 * Opens a short-lived socket, sends one command, closes after 500ms. Resolves
 * once the payload is on the wire; rejects on connect/send failure.
 *
 * `fields` overrides the hub's own record. Brightness overrides device_status.
 * Colour temperature is a separate channel: address channel_id_tunable and put
 * the level in device_status — the hub then stores it as device_status_tunable.
 */
function sendToHub(recordId, fields, param) {
  const entry = devices.get(recordId);
  if (!entry) return Promise.reject(new Error(`Unknown record_id ${recordId}`));

  // Echo the hub's own record back with the overrides applied — the hub rejects
  // partial records for some device types.
  const payload = {
    opr: 'service',
    opr_type: 'service_opr',
    opr_param: param || '',
    record: { ...entry.record, record_id: recordId, ...fields },
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };

    const ws = hubSocket();

    ws.on('open', () => {
      ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          stats.commandsFailed++;
          done(err);
          ws.terminate();
          return;
        }
        stats.commandsSent++;
        // Keep the cache plausible until the next hub read replaces it.
        if (fields.channel_id && fields.channel_id === String(entry.record.channel_id_tunable)) {
          entry.record.device_status_tunable = fields.device_status;
        } else if (fields.device_status !== undefined) {
          entry.record.device_status = fields.device_status;
        }
        pushSoon();
        done();
        setTimeout(() => ws.close(), 500);
      });
    });

    ws.on('error', (err) => { done(err); ws.terminate(); });
    ws.on('close', () => done(new Error('Hub closed the connection before the payload was sent')));
  });
}

/**
 * Sends many commands down ONE socket, the way the vendor's app fires a scene.
 *
 * A socket per command means a scene of eleven lights is eleven handshakes, and
 * the hub drops commands under that churn — which is why single sends have to be
 * spaced ~260ms apart, and why a room used to light one lamp at a time. Through
 * a single connection the same commands can follow each other closely, so the
 * room moves as one.
 *
 * `commands` is [{ recordId, fields, param }] in the order they should reach the
 * hub. Resolves with how many made it onto the wire.
 */
const BATCH_GAP_MS = Number(process.env.BATCH_GAP_MS || 60);

function sendBatchToHub(commands) {
  if (!commands.length) return Promise.resolve(0);

  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = 0;
    const done = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(sent);
    };

    const ws = hubSocket();

    ws.on('open', async () => {
      try {
        for (const { recordId, fields, param } of commands) {
          const entry = devices.get(recordId);
          if (!entry) continue;
          // Echo the hub's own record back, exactly as a single send does.
          const payload = {
            opr: 'service',
            opr_type: 'service_opr',
            opr_param: param || '',
            record: { ...entry.record, record_id: recordId, ...fields },
          };
          await new Promise((ok, fail) =>
            ws.send(JSON.stringify(payload), (err) => (err ? fail(err) : ok())));
          sent++;
          stats.commandsSent++;
          // Keep the cache plausible until the next hub read replaces it.
          if (fields.channel_id && fields.channel_id === String(entry.record.channel_id_tunable)) {
            entry.record.device_status_tunable = fields.device_status;
          } else if (fields.device_status !== undefined) {
            entry.record.device_status = fields.device_status;
          }
          await sleep(BATCH_GAP_MS);
        }
        pushSoon();
        done();
        setTimeout(() => ws.close(), 500);
      } catch (err) {
        stats.commandsFailed++;
        done(err);
        ws.terminate();
      }
    });

    ws.on('error', (err) => { done(err); ws.terminate(); });
    ws.on('close', () => done(new Error('Hub closed the connection before the batch was sent')));
  });
}

// ------------------------------------------------------------------------ http

const app = express();
app.use(express.json());

const REFRESH_MS = 15000;
const SETTLE_MS = 3200;

function snapshot() {
  return {
    devices: deviceList(),
    synced_at: hubSync.at || null,
    hub_ok: hubSync.ok,
    hub_error: hubSync.error,
  };
}

/* --------------------------------------------------------------- live push */

// Browsers used to poll every 10s, so the page could sit ten seconds behind the
// house and two phones could disagree. The server already learns the truth every
// REFRESH_MS, so it pushes instead — including changes made at a wall switch,
// which now appear as soon as the reader sees them.
const sseClients = new Set();

/** A fingerprint of what the page actually renders, so we only push on change. */
function stateSignature() {
  const parts = [];
  for (const { record } of devices.values()) {
    parts.push(record.record_id + ':' + record.device_status + ':' +
      (record.device_status_tunable ?? '') + ':' + (record.ac_temp ?? ''));
  }
  return parts.join('|');
}
let lastSignature = '';

function pushSnapshot(force) {
  if (!sseClients.size) return;
  const sig = stateSignature();
  if (!force && sig === lastSignature) return;
  lastSignature = sig;
  const frame = 'event: devices\ndata: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

// Our own commands update the cache optimistically; this lets the other phones
// in the house see that at once instead of waiting for the next read. Coalesced,
// so a cue of eleven lights costs one frame rather than eleven.
let pushTimer = null;
function pushSoon() {
  if (pushTimer || !sseClients.size) return;
  pushTimer = setTimeout(() => { pushTimer = null; pushSnapshot(); }, 250);
}

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write('event: devices\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
  sseClients.add(res);

  // Without traffic an idle proxy or phone radio will drop this; a comment line
  // is the cheapest thing that counts as traffic.
  const beat = setInterval(() => {
    try { res.write(': beat\n\n'); } catch { /* cleaned up on close */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(beat);
    sseClients.delete(res);
  });
});

/**
 * Is this thing still working? Answers without touching the hub, so a watchdog
 * can call it every minute for free.
 *
 * Unhealthy (503) means the background reader has stopped getting through: the
 * process can be alive and serving pages while the house has become unreachable,
 * which is exactly the failure systemd cannot see. deploy/watchdog.sh restarts
 * the service on a 503.
 */
/**
 * The backdrop photograph. Everything on this page is glass, and glass over a
 * flat field is just a tinted box — the picture is what the panes bend, so it
 * is load-bearing rather than decoration. Drop a file at data/background.jpg
 * and the whole app sits on it; with no file the page falls back to the painted
 * gradient and still works.
 */
const BG_PATH = path.join(__dirname, 'data', 'background.jpg');
app.get('/bg.jpg', (req, res) => {
  if (!fs.existsSync(BG_PATH)) return res.status(404).end();
  res.type('jpeg').set('Cache-Control', 'public, max-age=86400').sendFile(BG_PATH);
});

// The home-screen icon, and the manifest that makes this installable. Generated
// by tools/make-icon.js rather than checked in as an opaque binary.
app.get('/icon-:size.png', (req, res) => {
  const file = path.join(__dirname, 'data', `icon-${req.params.size}.png`);
  if (!/^(180|192|512)$/.test(req.params.size) || !fs.existsSync(file)) return res.status(404).end();
  res.type('png').set('Cache-Control', 'public, max-age=604800').sendFile(file);
});

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: "Pravita's Apartment",
    short_name: 'The House',
    start_url: '/',
    display: 'standalone',
    background_color: '#12151a',
    theme_color: '#12151a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
});

app.get('/api/health', (req, res) => {
  const now = Date.now();
  const age = hubSync.at ? now - hubSync.at : null;
  // Three missed refreshes in a row, or no successful read yet, counts as down.
  const stale = age == null || age > REFRESH_MS * 3;
  const healthy = hubSync.ok && !stale;
  const reads = stats.readsOk + stats.readsFailed;

  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    uptime_s: Math.round((now - startedAt) / 1000),
    hub: {
      ok: hubSync.ok,
      last_read_age_s: age == null ? null : Math.round(age / 1000),
      last_error: hubSync.error,
      reads_ok: stats.readsOk,
      reads_failed: stats.readsFailed,
      success_rate: reads ? Number((stats.readsOk / reads).toFixed(3)) : null,
      consecutive_failures: stats.consecutiveReadFailures,
      stale,
    },
    commands: { sent: stats.commandsSent, failed: stats.commandsFailed },
    cues_fired: stats.cuesFired,
    devices: devices.size,
    scenes: scenes.length,
    clients: sseClients.size,
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
    node: process.version,
  });
});

app.get('/api/devices', async (req, res) => {
  // ?refresh=1 waits for truth; a normal read serves the last snapshot at once
  // and re-reads in the background if it has gone stale.
  // The background reader keeps this current; ?refresh=1 forces a read now.
  if (req.query.refresh) await readHubStateFresh();
  res.json(snapshot());
});

// Latest intent per device, so a quick second click invalidates the first verdict.
const intents = new Map();
let intentSeq = 0;

app.post('/api/toggle', async (req, res) => {
  const recordId = Number(req.body?.record_id);
  const status = req.body?.status;

  if (!Number.isInteger(recordId)) {
    return res.status(400).json({ ok: false, error: 'record_id must be an integer' });
  }
  if (typeof status !== 'boolean' && status !== 'true' && status !== 'false') {
    return res.status(400).json({ ok: false, error: 'status must be a boolean or "true"/"false"' });
  }
  const statusStr = String(status);
  const token = ++intentSeq;
  intents.set(recordId, token);

  try {
    // A tunable light coming on gets the colour of the hour first — before the
    // brightness, so a tune that bleeds onto the main channel costs colour
    // rather than level. Only on the way on, so it never fights a colour set
    // by hand while the light is already lit.
    const rec = devices.get(recordId)?.record;
    if (statusStr === 'true' && rec && wantsCircadian(rec)) {
      try {
        await sendToHub(recordId, {
          channel_id: String(rec.channel_id_tunable),
          device_status: encodeLevel(circadianTune()),
        });
        await sleep(SCENE_SETTLE_MS);
      } catch (err) { console.error(`circadian ${recordId} skipped:`, err.message); }
    }
    await sendToHub(recordId, { device_status: statusStr });
  } catch (err) {
    console.error(`toggle ${recordId} -> ${statusStr} failed:`, err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }

  // The hub snapshots its state when a client connects, so the read must start
  // well after the command lands. Measured against this hub: below ~2.3s the
  // read still reports the previous state.
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const sync = await readHubStateFresh();

  // A newer click for this device is already in flight — that one owns the verdict.
  if (intents.get(recordId) !== token) {
    return res.json({ ok: true, record_id: recordId, status: statusStr === 'true', confirmed: null });
  }

  // On/off is "above zero", never a string match: switching a dimmable light on
  // reads back as its level ("40"), not "true". Comparing the raw strings made
  // every dimmable light report itself as refused, and the page dutifully put
  // the tile back to off until the next hub read corrected it.
  const actual = devices.get(recordId).record.device_status;
  const actualOn = decodeLevel(actual) > 0;
  const wantOn = statusStr === 'true';
  const confirmed = sync.ok ? actualOn === wantOn : null;
  if (confirmed === false) {
    console.error(`toggle ${recordId} -> ${statusStr} not applied; hub reports ${actual}`);
  }

  res.json({
    ok: true,
    record_id: recordId,
    status: wantOn,
    actual: actualOn,
    level: decodeLevel(actual),
    confirmed,
    synced_at: hubSync.at,
  });
});

/**
 * Sliders fire continuously, so these do not run the ~6s confirmation that
 * on/off does — the level is visible on the slider itself, and a short delayed
 * read pulls the cache back in line.
 */
function nudgeRefresh() {
  setTimeout(() => { if (!reading) readHubState(); }, 3500);
}

function readLevel(req, res, key) {
  const recordId = Number(req.body?.record_id);
  const level = Number(req.body?.[key]);

  if (!Number.isInteger(recordId)) {
    res.status(400).json({ ok: false, error: 'record_id must be an integer' });
    return null;
  }
  if (!Number.isFinite(level) || level < 0 || level > 100) {
    res.status(400).json({ ok: false, error: key + ' must be a number from 0 to 100' });
    return null;
  }
  const entry = devices.get(recordId);
  if (!entry) {
    res.status(404).json({ ok: false, error: `Unknown record_id ${recordId}` });
    return null;
  }
  return { recordId, level: Math.round(level), entry };
}

app.post('/api/level', async (req, res) => {
  const req_ = readLevel(req, res, 'level');
  if (!req_) return;
  const { recordId, level, entry } = req_;

  if (entry.record.is_dimmable !== 'true') {
    return res.status(400).json({ ok: false, error: `${entry.record.device_name.trim()} does not dim` });
  }

  try {
    await sendToHub(recordId, { device_status: encodeLevel(level) });
    intents.set(recordId, ++intentSeq);   // a level overrides any pending on/off verdict
    nudgeRefresh();
    res.json({ ok: true, record_id: recordId, level, status: level > 0 });
  } catch (err) {
    console.error(`level ${recordId} -> ${level} failed:`, err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/api/tune', async (req, res) => {
  const req_ = readLevel(req, res, 'tune');
  if (!req_) return;
  const { recordId, level, entry } = req_;

  if (entry.record.is_tunable !== 'true') {
    return res.status(400).json({ ok: false, error: `${entry.record.device_name.trim()} does not tune` });
  }
  const tunableChannel = String(entry.record.channel_id_tunable || '');
  if (!tunableChannel) {
    return res.status(400).json({ ok: false, error: 'No tunable channel on this device' });
  }

  try {
    await sendToHub(recordId, { channel_id: tunableChannel, device_status: encodeLevel(level) });
    nudgeRefresh();
    res.json({ ok: true, record_id: recordId, tune: level });
  } catch (err) {
    console.error(`tune ${recordId} -> ${level} failed:`, err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * Curtains are driven by pulsing one of two relays. There is nothing to read
 * back afterwards, so unlike a light this cannot be confirmed — the response
 * says only that the command went out.
 */
/**
 * A curtain is the one device class that ignores `device_status` entirely: the
 * hub reads the verb out of `opr_param`. From its own source, BMS_host —
 * operations.py dispatches `app_type === 'C'` to curtain_opr.curtain_relay_opr(
 * record, opr_param), and that function only acts on these four strings:
 *
 *   curtain_opr_o    pulse the channel_open relay on
 *   curtain_opr_c    pulse the channel_close relay on
 *   curtain_opr_s    release both relays — stop, which we never had
 *   curtain_opr_tis  positional, but only for is_tis motors; ours are all False
 *
 * Anything else falls through every branch and the hub does nothing at all,
 * silently. That is why sending device_status here never moved a curtain: the
 * curtain path does not read the field we were setting.
 */
const CURTAIN_VERB = { open: 'curtain_opr_o', close: 'curtain_opr_c', stop: 'curtain_opr_s' };

app.post('/api/curtain', async (req, res) => {
  const recordId = Number(req.body?.record_id);
  const action = String(req.body?.action || '');

  if (!Number.isInteger(recordId)) {
    return res.status(400).json({ ok: false, error: 'record_id must be an integer' });
  }
  if (!CURTAIN_VERB[action]) {
    return res.status(400).json({ ok: false, error: 'action must be "open", "close" or "stop"' });
  }
  const entry = devices.get(recordId);
  if (!entry) return res.status(404).json({ ok: false, error: `Unknown record_id ${recordId}` });
  if (entry.record.app_type !== 'C') {
    return res.status(400).json({ ok: false, error: `${entry.record.device_name.trim()} is not a curtain` });
  }

  try {
    await sendToHub(recordId, {}, CURTAIN_VERB[action]);
    res.json({ ok: true, record_id: recordId, action });
  } catch (err) {
    console.error(`curtain ${recordId} ${action} failed:`, err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * An IR air conditioner is not a switch. The hub's own app puts a command
 * string in opr_param — "on 194.null", "cool 194.null", "fspeed 194.null m",
 * "temp 194.null 24" — alongside the usual record. Read out of the hub's
 * compiled web app; the record alone does nothing, which is why our on/off
 * never reached the unit.
 */
const AC_FAN = { auto: 'a', low: 'l', medium: 'm', high: 'h' };
const AC_SWING = { auto: 'a', '30': '3', '45': '4', '60': '6' };
const AC_MODES = ['cool', 'heat', 'dry', 'auto'];

function acCommand(record, verb, arg) {
  // IR records carry no channel_id, and the hub's own app renders that missing
  // value as the literal "null" — so "on 194.null", not "on 194.undefined".
  const channel = record.channel_id == null || record.channel_id === '' ? 'null' : record.channel_id;
  const target = `${record.device_id}.${channel}`;
  return arg == null ? `${verb} ${target}` : `${verb} ${target} ${arg}`;
}

app.post('/api/ac', async (req, res) => {
  const recordId = Number(req.body?.record_id);
  const { power, mode, fan, swing, temp } = req.body || {};

  if (!Number.isInteger(recordId)) {
    return res.status(400).json({ ok: false, error: 'record_id must be an integer' });
  }
  const entry = devices.get(recordId);
  if (!entry) return res.status(404).json({ ok: false, error: `Unknown record_id ${recordId}` });
  if (entry.record.app_type !== 'AC') {
    return res.status(400).json({ ok: false, error: `${entry.record.device_name.trim()} is not an air conditioner` });
  }
  // The Home Theatre unit is wired to a relay, so it really is a plain switch.
  if (entry.record.device_type !== 'IR') {
    return res.status(400).json({ ok: false, error: 'This one is a relay — use /api/toggle' });
  }

  const sent = [];
  try {
    if (power != null) {
      const on = power === true || power === 'true' || power === 'on';
      await sendToHub(recordId, { device_status: String(on) }, acCommand(entry.record, on ? 'on' : 'off'));
      sent.push(on ? 'on' : 'off');
      entry.record.device_status = String(on);
    }
    if (mode != null) {
      if (!AC_MODES.includes(mode)) {
        return res.status(400).json({ ok: false, error: 'mode must be one of ' + AC_MODES.join(', ') });
      }
      await sleep(SCENE_SETTLE_MS);
      await sendToHub(recordId, {}, acCommand(entry.record, mode));
      sent.push(mode);
    }
    if (fan != null) {
      if (!AC_FAN[fan]) return res.status(400).json({ ok: false, error: 'fan must be auto, low, medium or high' });
      await sleep(SCENE_SETTLE_MS);
      await sendToHub(recordId, {}, acCommand(entry.record, 'fspeed', AC_FAN[fan]));
      sent.push('fan ' + fan);
    }
    if (swing != null) {
      if (!AC_SWING[String(swing)]) {
        return res.status(400).json({ ok: false, error: 'swing must be auto, 30, 45 or 60' });
      }
      await sleep(SCENE_SETTLE_MS);
      await sendToHub(recordId, {}, acCommand(entry.record, 'swing', AC_SWING[String(swing)]));
      sent.push('swing ' + swing);
    }
    if (temp != null) {
      const t = Number(temp);
      if (!Number.isFinite(t) || t < 19 || t > 26) {
        return res.status(400).json({ ok: false, error: 'temp must be between 19 and 26' });
      }
      await sleep(SCENE_SETTLE_MS);
      await sendToHub(recordId, { ac_temp: String(t) }, acCommand(entry.record, 'temp', t));
      sent.push(t + '°');
      entry.record.ac_temp = String(t);
    }
    if (!sent.length) return res.status(400).json({ ok: false, error: 'Nothing to change' });
    res.json({ ok: true, record_id: recordId, sent });
  } catch (err) {
    console.error(`ac ${recordId} failed:`, err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

/* ------------------------------------------------------------------ scenes */

// Measured against this hub: separate connections made closer than ~200ms apart
// get dropped, so single sends stay spaced. A scene instead goes down one shared
// socket (sendBatchToHub), which the hub is happy to take quickly. Either way the
// result is verified and the misses retried once.
const SCENE_SETTLE_MS = 600;   // between two commands aimed at the same device
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function stepTarget(step) {
  const entry = devices.get(step.record_id);
  if (!entry) return null;
  const rec = entry.record;
  const dimmable = rec.is_dimmable === 'true';
  const level = step.on === false ? 0 : (dimmable && step.level != null ? step.level : 100);
  const tune = rec.is_tunable === 'true' && step.tune != null ? step.tune : null;
  return { entry, rec, level, tune };
}

/**
 * Fires a set of steps down one socket, so the room changes together.
 *
 * Colour temperature still goes before brightness. Both carry the level in
 * device_status, and under load a tune command can bleed onto the main channel —
 * observed once, a lamp left at 100% because that was its tune value. Sending
 * every brightness after every tune means that bleed costs colour, not level.
 */
async function sendSteps(list) {
  // Off first, so a scene never briefly lights the whole room.
  const order = [...list].sort((a, b) => (a.step.on === false ? 0 : 1) - (b.step.on === false ? 0 : 1));

  const tunes = order
    .filter(({ t }) => t.tune != null && t.level > 0)
    .map(({ step, t }) => ({
      recordId: step.record_id,
      fields: { channel_id: String(t.rec.channel_id_tunable), device_status: encodeLevel(t.tune) },
    }));

  // A cue step that names no colour gets the colour of the hour. The step's own
  // tune always wins, and because the step still carries no tune, `outstanding`
  // does not verify this one — a colour the hub ignores must not read as a
  // missed step and trigger a resend.
  for (const { step, t } of order) {
    if (t.tune == null && t.level > 0 && wantsCircadian(t.rec)) {
      tunes.push({
        recordId: step.record_id,
        fields: { channel_id: String(t.rec.channel_id_tunable), device_status: encodeLevel(circadianTune()) },
      });
    }
  }

  if (tunes.length) {
    await sendBatchToHub(tunes);
    await sleep(SCENE_SETTLE_MS);
  }

  return sendBatchToHub(order.map(({ step, t }) => ({
    recordId: step.record_id,
    fields: { device_status: encodeLevel(t.level) },
  })));
}

/** The steps of a scene paired with what they resolve to, skipping unknowns. */
const sceneTargets = (steps) =>
  steps.map((step) => ({ step, t: stepTarget(step) })).filter(({ t }) => t);

/** Which steps the hub has not actually taken. */
function outstanding(scene) {
  return scene.steps.filter((step) => {
    const t = stepTarget(step);
    if (!t) return false;
    if (decodeLevel(t.rec.device_status) !== t.level) return true;
    return t.tune != null && t.level > 0 && decodeLevel(t.rec.device_status_tunable) !== t.tune;
  });
}

async function applyScene(scene) {
  let sent = 0;
  try { sent = await sendSteps(sceneTargets(scene.steps)); }
  catch (err) { console.error(`scene ${scene.id} failed to send:`, err.message); }

  await sleep(SETTLE_MS);
  await readHubStateFresh();

  // One retry for whatever the hub did not take.
  const missed = outstanding(scene);
  if (missed.length) {
    console.log(`scene ${scene.id}: retrying ${missed.length}`);
    try { await sendSteps(sceneTargets(missed)); }
    catch (err) { console.error(`scene ${scene.id} retry failed:`, err.message); }
    await sleep(SETTLE_MS);
    await readHubStateFresh();
  }

  const still = outstanding(scene);
  return { sent, total: scene.steps.length, set: scene.steps.length - still.length, missed: still.length };
}

app.get('/api/scenes', (req, res) => res.json({ scenes: sceneList() }));

/* ------------------------------------------------------------------- undo */

// Long enough to catch a misclick, short enough that the house has probably not
// moved on without us. Past this the snapshot is discarded rather than trusted.
const UNDO_WINDOW_MS = 5 * 60 * 1000;
let undoable = null;

/**
 * How the circuits a cue is about to touch stand right now — a cue built to put
 * them back. Only those circuits: a cue that lights the Living room should undo
 * to the Living room as it was, not reach into rooms it never touched.
 *
 * Curtains are left out. The hub reports no position for them, so "before" is
 * unknowable and guessing would close a curtain that had been open.
 */
function captureBefore(steps) {
  const before = [];
  let skipped = 0;
  for (const step of steps) {
    const entry = devices.get(step.record_id);
    if (!entry) continue;
    if ((entry.record.app_type || '') === 'C') { skipped++; continue; }
    const level = decodeLevel(entry.record.device_status);
    const back = { record_id: step.record_id, on: level > 0 };
    if (entry.record.is_dimmable === 'true' && level > 0) back.level = level;
    if (entry.record.is_tunable === 'true' && level > 0) {
      back.tune = decodeLevel(entry.record.device_status_tunable);
    }
    before.push(back);
  }
  return { before, skipped };
}

/**
 * Firing a cue is the same work wherever the press came from — the dashboard,
 * a Home Screen widget, or Siri — so all of them come through here, and all of
 * them leave the same one step of undo behind.
 */
async function fireCue(scene) {
  // The snapshot is only worth keeping if it is current: a cached read can be
  // up to REFRESH_MS old, and undoing to a stale reading is worse than not
  // offering undo at all.
  if (!hubSync.at || Date.now() - hubSync.at > 4000) {
    await readHubStateFresh().catch(() => {});
  }
  const { before, skipped } = captureBefore(scene.steps);
  undoable = before.length ? { name: scene.name, at: Date.now(), steps: before } : null;

  stats.cuesFired++;
  const result = await applyScene(scene);
  return { ...result, undoable: !!undoable, undo_skipped: skipped };
}

app.post('/api/scenes/:id/apply', async (req, res) => {
  const scene = scenes.find(sc => sc.id === req.params.id);
  if (!scene) return res.status(404).json({ ok: false, error: 'No such scene' });
  try {
    const result = await fireCue(scene);
    res.json({ ok: true, scene: scene.name, ...result, synced_at: hubSync.at });
  } catch (err) {
    console.error(`scene ${scene.id} failed:`, err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * Put back whatever the last cue changed. This is a misclick escape hatch, not
 * a history: there is exactly one step back, and taking it clears it.
 */
app.post('/api/scenes/undo', async (req, res) => {
  if (!undoable) {
    return res.status(404).json({ ok: false, error: 'Nothing to undo' });
  }
  if (Date.now() - undoable.at > UNDO_WINDOW_MS) {
    undoable = null;
    return res.status(410).json({ ok: false, error: 'That was too long ago to undo safely' });
  }
  const snap = undoable;
  undoable = null;
  try {
    const result = await applyScene({ id: 'undo', name: 'Undo', steps: snap.steps });
    res.json({ ok: true, scene: snap.name, ...result, synced_at: hubSync.at });
  } catch (err) {
    console.error('undo failed:', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

/* ------------------------------------------------- shortcuts and voice */

/**
 * One-press endpoints for things outside the browser: an iOS Shortcut, a Home
 * Screen widget, Siri, a Back Tap. They answer to GET as well as POST, because
 * a widget or a bookmark can only manage a GET, and this server is LAN-only.
 *
 * Set SHORTCUT_KEY in the environment to require ?key=… — worth doing if the
 * Wi-Fi has guests on it, unnecessary otherwise.
 */
const SHORTCUT_KEY = process.env.SHORTCUT_KEY || '';
const keyOk = (req) => !SHORTCUT_KEY || req.query.key === SHORTCUT_KEY || req.get('x-key') === SHORTCUT_KEY;

app.all('/api/cue/:id/fire', async (req, res) => {
  if (!keyOk(req)) return res.status(403).json({ ok: false, error: 'Wrong key' });
  const scene = scenes.find(sc => sc.id === req.params.id);
  if (!scene) {
    return res.status(404).json({ ok: false, error: 'No such cue', known: scenes.map(sc => sc.id) });
  }
  try {
    const result = await fireCue(scene);
    // `spoken` is what Siri reads back, so it is a sentence rather than a count.
    res.json({
      ok: true, scene: scene.name, ...result,
      spoken: result.missed
        ? scene.name + ' set, but ' + result.missed + ' did not take'
        : scene.name + ' set',
      synced_at: hubSync.at,
    });
  } catch (err) {
    console.error(`cue ${scene.id} failed:`, err.message);
    res.status(502).json({ ok: false, error: err.message, spoken: 'The hub did not answer' });
  }
});

app.all('/api/house/off', async (req, res) => {
  if (!keyOk(req)) return res.status(403).json({ ok: false, error: 'Wrong key' });
  try {
    await readHubStateFresh().catch(() => {});
    // A curtain reports no state, so it is never "on" and never swept up here.
    const steps = [...devices.values()]
      .filter(({ record }) => (record.app_type || '') !== 'C' && decodeLevel(record.device_status) > 0)
      .map(({ record }) => ({ record_id: record.record_id, on: false }));

    if (!steps.length) {
      return res.json({ ok: true, set: 0, total: 0, spoken: 'Everything is already off' });
    }
    const result = await fireCue({ id: 'house-off', name: 'All off', steps });
    res.json({
      ok: true, ...result,
      spoken: result.missed
        ? result.set + ' off, but ' + result.missed + ' did not take'
        : 'Everything off',
      synced_at: hubSync.at,
    });
  } catch (err) {
    console.error('house off failed:', err.message);
    res.status(502).json({ ok: false, error: err.message, spoken: 'The hub did not answer' });
  }
});

/** The list a Shortcut needs in order to offer you a menu of cues. */
app.get('/api/cues', (req, res) => {
  res.json({ cues: scenes.map(sc => ({ id: sc.id, name: sc.name, circuits: sc.steps.length })) });
});

/**
 * Captures the house as it stands. Every device in a room that has something
 * on is recorded — so replaying the scene also switches off what should be off
 * — while rooms that are entirely dark are left out of it altogether.
 */
/**
 * A cue's id is its address: shortcuts, Siri and cron all reach it as
 * /api/cue/<id>/fire, so it is derived once from the name and then never
 * changes — renaming a cue must not break a shortcut someone already built.
 * Names are unique case-insensitively, which keeps ids unique and keeps the
 * spoken name unambiguous.
 */
function apiId(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let id = base || 'cue';
  for (let n = 2; scenes.some(sc => sc.id === id); n++) id = base + '-' + n;
  return id;
}

const nameTaken = (name, exceptId) => scenes.some(sc =>
  sc.id !== exceptId && sc.name.trim().toLowerCase() === String(name).trim().toLowerCase());

/** Steps as the caller asked for them, checked against the hub this house has. */
function cleanSteps(raw) {
  const clean = [];
  const seen = new Set();
  for (const step of Array.isArray(raw) ? raw : []) {
    const id = Number(step?.record_id);
    const entry = devices.get(id);
    if (!entry || seen.has(id)) continue;
    seen.add(id);
    const on = step.on !== false;
    const out = { record_id: id, on };
    if (on && entry.record.is_dimmable === 'true' && step.level != null) {
      out.level = Math.max(1, Math.min(100, Math.round(Number(step.level) || 0)));
    }
    if (on && entry.record.is_tunable === 'true' && step.tune != null) {
      out.tune = Math.max(0, Math.min(100, Math.round(Number(step.tune) || 0)));
    }
    clean.push(out);
  }
  return clean;
}

/** How a cue reads in one phrase: one room by name, or how many rooms. */
function noteFor(steps) {
  const rooms = [...new Set(steps.map(st => roomKey(devices.get(st.record_id).room).toLowerCase()))];
  return rooms.length === 1 ? rooms[0] : rooms.length + ' rooms';
}

app.post('/api/scenes', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'A cue needs a name' });
  if (name.length > 40) return res.status(400).json({ ok: false, error: 'Keep the name under 40 characters' });
  if (nameTaken(name)) {
    return res.status(409).json({ ok: false, error: 'There is already a cue called ' + name });
  }

  // Steps are chosen, not snapshotted. Recording whatever happened to be lit
  // swept in every circuit of every lit room, which is almost never the cue you
  // meant. `recapture: true` still asks for the old behaviour deliberately.
  let steps = cleanSteps(req.body?.steps);
  if (!steps.length && req.body?.recapture) {
    const all = [...devices.values()];
    const litRooms = new Set(all.filter(({ record }) => decodeLevel(record.device_status) > 0)
      .map(({ room }) => roomKey(room)));
    if (!litRooms.size) {
      return res.status(400).json({ ok: false, error: 'Nothing is on — set the house how you want it first' });
    }
    steps = all.filter(({ room }) => litRooms.has(roomKey(room))).map(({ record }) => {
      const level = decodeLevel(record.device_status);
      const step = { record_id: record.record_id, on: level > 0 };
      if (record.is_dimmable === 'true' && level > 0) step.level = level;
      if (record.is_tunable === 'true' && level > 0) step.tune = decodeLevel(record.device_status_tunable);
      return step;
    });
  }
  if (!steps.length) {
    return res.status(400).json({ ok: false, error: 'A cue needs at least one circuit' });
  }

  const scene = { id: apiId(name), name, note: noteFor(steps), steps };
  scenes.push(scene);
  saveScenes();
  res.json({ ok: true, scene: { ...scene, devices: steps.length } });
});

/**
 * Editing a scene is two different things: renaming it, and re-recording it.
 * Re-recording replaces its steps with the house as it stands right now, which
 * is the only practical way to adjust a scene — you set the room by hand until
 * it looks right, then tell the scene to remember that.
 */
app.patch('/api/scenes/:id', (req, res) => {
  const scene = scenes.find(sc => sc.id === req.params.id);
  if (!scene) return res.status(404).json({ ok: false, error: 'No such scene' });

  const { name, recapture, steps } = req.body || {};

  // Choosing the circuits by hand. Each step is checked against the devices this
  // hub actually has, and level/tune are only kept where the device can use them.
  if (steps != null) {
    if (!Array.isArray(steps)) {
      return res.status(400).json({ ok: false, error: 'steps must be a list' });
    }
    const clean = cleanSteps(steps);
    if (!clean.length) {
      return res.status(400).json({ ok: false, error: 'A cue needs at least one circuit' });
    }
    scene.steps = clean;
    scene.note = noteFor(clean);
  }

  if (name != null) {
    const next = String(name).trim();
    if (!next) return res.status(400).json({ ok: false, error: 'A scene needs a name' });
    if (next.length > 40) return res.status(400).json({ ok: false, error: 'Keep the name under 40 characters' });
    // The id stays as it was, so a shortcut built against this cue keeps working.
    if (nameTaken(next, scene.id)) {
      return res.status(409).json({ ok: false, error: 'There is already a cue called ' + next });
    }
    scene.name = next;
  }

  if (recapture) {
    const all = [...devices.values()];
    const litRooms = new Set(all.filter(({ record }) => decodeLevel(record.device_status) > 0)
      .map(({ room }) => roomKey(room)));
    if (!litRooms.size) {
      return res.status(400).json({ ok: false, error: 'Nothing is on — set the house how you want it first' });
    }
    scene.steps = all
      .filter(({ room }) => litRooms.has(roomKey(room)))
      .map(({ record }) => {
        const level = decodeLevel(record.device_status);
        const step = { record_id: record.record_id, on: level > 0 };
        if (record.is_dimmable === 'true' && level > 0) step.level = level;
        if (record.is_tunable === 'true' && level > 0) step.tune = decodeLevel(record.device_status_tunable);
        return step;
      });
    scene.note = noteFor(scene.steps);
  }

  if (name == null && !recapture && steps == null) {
    return res.status(400).json({ ok: false, error: 'Nothing to change' });
  }
  saveScenes();
  res.json({ ok: true, scene: { ...scene, devices: scene.steps.length } });
});

app.delete('/api/scenes/:id', (req, res) => {
  const i = scenes.findIndex(sc => sc.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, error: 'No such scene' });
  const [gone] = scenes.splice(i, 1);
  saveScenes();
  res.json({ ok: true, removed: gone.name });
});

// The page is the whole app, and it changes every time server.js does. Without
// this a browser applies heuristic caching and keeps serving the previous build.
/* ---------------------------------------------------------- automations */

/**
 * Three small things the house can now do for itself, since something is finally
 * awake to notice. All of them are deliberately timid: the nudges never touch a
 * device, and colour is only ever set as a light comes on, so nothing here can
 * override a decision someone made by hand.
 */
const DEFAULT_SETTINGS = {
  // Colour temperature applied as a tunable light switches on.
  circadian: { on: true },
  // Left-on watching. Advisory only — it reports, it never switches anything off.
  nudges: { on: true, ac_hours: 4, fan_hours: 8, light_hours: 6 },
};
let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    settings = {
      circadian: { ...DEFAULT_SETTINGS.circadian, ...(saved.circadian || {}) },
      nudges: { ...DEFAULT_SETTINGS.nudges, ...(saved.nudges || {}) },
    };
  } catch { /* first run: defaults are already in place */ }
}

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); }
  catch (err) { console.error('could not save settings:', err.message); }
}

/**
 * Where the colour of the day sits right now. On this hub 0 is cool and 100 is
 * warm: cool through the working day, warming from late afternoon, warmest
 * overnight. Interpolated between the points below so it never steps.
 */
const DAY_COLOUR = [[0, 100], [6, 100], [8, 55], [10, 30], [16, 32], [19, 65], [21, 85], [23, 100], [24, 100]];

function circadianTune(now = new Date()) {
  const h = now.getHours() + now.getMinutes() / 60;
  for (let i = 1; i < DAY_COLOUR.length; i++) {
    const [h0, v0] = DAY_COLOUR[i - 1];
    const [h1, v1] = DAY_COLOUR[i];
    if (h <= h1) return Math.round(v0 + (v1 - v0) * ((h - h0) / (h1 - h0 || 1)));
  }
  return 100;
}

/** Should this record get today's colour as it comes on? */
const wantsCircadian = (record) =>
  settings.circadian.on && record.is_tunable === 'true' && record.channel_id_tunable != null;

/* --------------------------------------------------- left on too long */

// When each circuit was last seen to come on. Persisted, so a restart (or the
// watchdog) does not reset every timer to zero and hide a genuine all-nighter.
const litSince = new Map();
// record_id -> the `since` that was dismissed, so a nudge stays gone until the
// circuit has actually been off and on again.
const dismissedNudges = new Map();

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    for (const [id, at] of Object.entries(saved.lit_since || {})) litSince.set(Number(id), at);
  } catch { /* first run */ }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ lit_since: Object.fromEntries(litSince) }, null, 2));
  } catch (err) { console.error('could not save state:', err.message); }
}

/** Called after every hub read: notice what came on and what went off. */
function trackLit() {
  let changed = false;
  for (const [id, { record }] of devices) {
    if ((record.app_type || '') === 'C') continue;       // a curtain has no "on"
    const on = decodeLevel(record.device_status) > 0;
    if (on && !litSince.has(id)) { litSince.set(id, Date.now()); changed = true; }
    else if (!on && litSince.has(id)) {
      litSince.delete(id);
      dismissedNudges.delete(id);                        // it can nudge again next time
      changed = true;
    }
  }
  if (changed) saveState();
}

function nudgeList() {
  if (!settings.nudges.on) return [];
  const now = Date.now();
  const out = [];
  for (const [id, since] of litSince) {
    const entry = devices.get(id);
    if (!entry) continue;
    const r = entry.record;
    const isAc = (r.app_type || '') === 'AC';
    const isFan = r.isFan === 'true' || /\bFAN\b/i.test(String(r.device_name || ''));
    const limit = isAc ? settings.nudges.ac_hours
      : isFan ? settings.nudges.fan_hours : settings.nudges.light_hours;
    const hours = (now - since) / 3600000;
    if (hours < limit) continue;
    if (dismissedNudges.get(id) === since) continue;
    out.push({
      record_id: id,
      name: String(r.device_name || '').trim(),
      room: roomKey(entry.room),
      kind: isAc ? 'ac' : isFan ? 'fan' : 'light',
      on_since: since,
      hours: Number(hours.toFixed(1)),
      limit_hours: limit,
    });
  }
  return out.sort((a, b) => b.hours - a.hours);
}

/* ------------------------------------------------------------- timers */

// "Everything off in 30 minutes" — the thing you want while reading in bed.
const timers = new Map();
let timerSeq = 0;

/**
 * The steps a sleep timer runs.
 *
 * Lights and screens go off; the fan and the AC keep running. A sleep timer is
 * for falling asleep, not for being woken at two in the morning by a room gone
 * still and warm — switching off the climate is the one thing it must not do.
 * Curtains are skipped as ever: they have no state to set.
 */
function sleepSteps(scope) {
  const all = [...devices.values()];
  const isOn = ({ record }) => decodeLevel(record.device_status) > 0
    && (record.app_type || '') !== 'C';
  const keepsRunning = ({ record }) => (record.app_type || '') === 'AC'
    || record.isFan === 'true' || /\bFAN\b/i.test(String(record.device_name || ''));
  const wanted = (d) => isOn(d) && !keepsRunning(d);

  if (scope === 'house') return all.filter(wanted).map(({ record }) => ({ record_id: record.record_id, on: false }));
  if (scope.startsWith('room:')) {
    const want = scope.slice(5).toLowerCase();
    return all.filter(d => wanted(d) && roomKey(d.room).toLowerCase() === want)
      .map(({ record }) => ({ record_id: record.record_id, on: false }));
  }
  if (scope.startsWith('device:')) {
    const id = Number(scope.slice(7));
    const entry = devices.get(id);
    return entry ? [{ record_id: id, on: false }] : [];   // named outright, so honour it
  }
  return [];
}

function timerView(t) {
  return { id: t.id, scope: t.scope, label: t.label, at: t.at, seconds_left: Math.max(0, Math.round((t.at - Date.now()) / 1000)) };
}

async function runTimer(id) {
  const t = timers.get(id);
  if (!t) return;
  timers.delete(id);
  const steps = sleepSteps(t.scope);
  console.log(`sleep timer ${t.label}: lights off, ${steps.length} circuits`);
  if (steps.length) {
    try { await sendSteps(sceneTargets(steps)); } catch (err) { console.error('timer failed:', err.message); }
    await readHubStateFresh().catch(() => {});
  }
  pushSnapshot(true);
}

function armTimer(t) {
  t.handle = setTimeout(() => runTimer(t.id), Math.max(0, t.at - Date.now()));
  timers.set(t.id, t);
}

app.get('/api/automations', (req, res) => {
  res.json({
    settings,
    nudges: nudgeList(),
    timers: [...timers.values()].map(timerView).sort((a, b) => a.at - b.at),
    colour_now: circadianTune(),
  });
});

app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  if (body.circadian && typeof body.circadian.on === 'boolean') settings.circadian.on = body.circadian.on;
  if (body.nudges) {
    if (typeof body.nudges.on === 'boolean') settings.nudges.on = body.nudges.on;
    for (const k of ['ac_hours', 'fan_hours', 'light_hours']) {
      const v = Number(body.nudges[k]);
      if (Number.isFinite(v) && v >= 0.5 && v <= 24) settings.nudges[k] = v;
    }
  }
  saveSettings();
  res.json({ ok: true, settings });
});

app.post('/api/nudges/:id/dismiss', (req, res) => {
  const id = Number(req.params.id);
  const since = litSince.get(id);
  if (since) dismissedNudges.set(id, since);
  res.json({ ok: true, nudges: nudgeList() });
});

app.post('/api/timers', (req, res) => {
  const minutes = Number(req.body?.minutes);
  const scope = String(req.body?.scope || 'house');
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) {
    return res.status(400).json({ ok: false, error: 'minutes must be between 1 and 720' });
  }
  if (!/^(house|room:.+|device:\d+)$/.test(scope)) {
    return res.status(400).json({ ok: false, error: 'scope must be house, room:NAME or device:ID' });
  }
  const label = scope === 'house' ? 'Everything'
    : scope.startsWith('room:') ? scope.slice(5)
      : (devices.get(Number(scope.slice(7)))?.record.device_name || 'Device').trim();
  const t = { id: 't' + (++timerSeq), scope, label, at: Date.now() + minutes * 60000 };
  armTimer(t);
  res.json({ ok: true, timer: timerView(t), spoken: `${label} lights off in ${minutes} minutes` });
});

app.delete('/api/timers/:id', (req, res) => {
  const t = timers.get(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: 'No such timer' });
  clearTimeout(t.handle);
  timers.delete(t.id);
  res.json({ ok: true });
});

app.get('/', (req, res) =>
  res.type('html').set('Cache-Control', 'no-store').send(HTML));

app.listen(PORT, () => {
  console.log(`Pravita's Apartment  ->  http://localhost:${PORT}`);
  console.log(`Hub                  ->  ${HUB_URL}`);
  loadScenes();
  loadSettings();
  loadState();
  readHubState().then((s) =>
    console.log(s.ok ? 'Live device status read from hub' : `Using snapshot status (${s.error})`));

  // One reader for the whole house, however many browsers are open. Keeps the
  // cache fresh enough that a page load never waits on the hub.
  setInterval(() => { if (!reading) readHubState(); }, REFRESH_MS);
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// --------------------------------------------------------------------- ui
//
// The apartment drawn as what it physically is: a distribution board. Every
// circuit is a bar — a breaker key on the left, its legend across the middle,
// its reading on the right — and the bar fills with the light that circuit is
// actually making, in that light's own colour temperature. The house is a
// board of rooms; a room is a board of circuits. One component, two scales.
const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#12151a">
<!-- Saved to a phone's home screen this opens without browser chrome, which is
     the only way the fixed, non-scrolling layout works properly on a phone. -->
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Pravita's">
<title>Pravita's Apartment</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    /* Warm charcoal, no blue anywhere in the greys. The interface is greyscale;
       the only colour on the page is the light a lamp is actually making. */
    --base:   #12151a;
    --raise:  #1b2027;
    --ink:    #f2f5f8;
    --soft:   #b6bec8;
    --faint:  #8a939e;      /* lifted: on the deeper base, the old value fell under 4:1 */

    /* Lamp colour, at full strength now: a tungsten bulb is genuinely amber.
       Cool stays a muted blue-grey — it is the contrast that carries meaning. */
    --warm:   #ffab42;
    /* The cool end of a tunable lamp, kept inside the warm family: pale
       champagne rather than blue-grey, which read as a hole in a bronze page.
       Warm against cool is still obvious — deep amber against pale gold. */
    --cool:   #cfe2f2;
    --neutral:#c9d3dd;      /* bronze: a fan or a curtain, lit but not glowing */
    --clay:   #e8705a;      /* the one alarming colour, used almost never */

    /* glass: a pane, lit along its top edge, with nothing glowing through it */
    --pane:      rgba(9,12,17,.34);
    --pane-up:   rgba(14,18,25,.46);
    --edge:      rgba(255,255,255,.13);
    --edge-up:   rgba(255,255,255,.24);
    --lip:       rgba(255,255,255,.13);
    --sheen: linear-gradient(152deg, rgba(255,255,255,.07) 0%, rgba(255,255,255,.018) 34%, transparent 62%);
    --cast: 0 14px 34px -20px rgba(0,0,0,.7);

    --sans: "Hanken Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;

    --tile-h: clamp(146px, 20vh, 182px);
    --lamp: var(--warm);
    --glow: 0;

    /* The specular edge that makes a pane read as glass rather than as a tinted
       box: bright where the light falls, almost gone across the middle, picking
       up again where the surface curves away. Uneven on purpose — an even
       border reads as a stroke, not as a lit edge. */
    --rim: linear-gradient(145deg,
      rgba(255,255,255,.52) 0%,
      rgba(255,255,255,.13) 20%,
      rgba(255,255,255,.03) 46%,
      rgba(255,255,255,.09) 72%,
      rgba(255,255,255,.34) 100%);
    --rim-lit: linear-gradient(145deg,
      rgba(255,252,246,.88) 0%,
      rgba(255,236,206,.28) 22%,
      rgba(255,236,206,.07) 50%,
      rgba(255,236,206,.22) 76%,
      rgba(255,246,230,.66) 100%);
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
  html { background: var(--base); }
  body {
    margin: 0; display: flex; flex-direction: column;
    /* clear of the notch and the home indicator when it runs full-screen */
    padding: env(safe-area-inset-top) env(safe-area-inset-right)
             env(safe-area-inset-bottom) env(safe-area-inset-left);
    background: var(--base); color: var(--ink);
    font: 400 15px/1.5 var(--sans); font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }

  /* Glass needs something behind it to bend. A slow tonal shift across the room
     gives the panes depth without adding a single visible edge. */
  /* The photograph itself. Held still while the page scrolls, so the glass
     slides over it rather than dragging it along. */
  .photo {
    position: fixed; inset: 0; z-index: 0; pointer-events: none;
    /* The photograph sits on top; the painted scene below it is what shows if
       there is no file yet, and it is built to be worth looking at on its own —
       a warm wash from a window, a lamp pool low and right, and soft vertical
       masses standing in for curtains and a doorway, so the glass always has
       structure to bend even before a picture is dropped in. */
    background-image:
      url('/bg.jpg'),
      radial-gradient(58% 44% at 12% 6%,   rgba(196,216,238,.22) 0%, transparent 68%),
      radial-gradient(46% 40% at 88% 88%,  rgba(176,200,226,.18) 0%, transparent 66%),
      linear-gradient(102deg, transparent 10%, rgba(226,238,250,.05) 13%, transparent 17%),
      linear-gradient(96deg,  transparent 46%, rgba(226,238,250,.06) 52%, transparent 58%),
      linear-gradient(88deg,  transparent 78%, rgba(226,238,250,.04) 82%, transparent 86%),
      radial-gradient(120% 100% at 50% 50%, #26303b 0%, #161c24 62%, #0c1014 100%);
    background-size: cover, auto, auto, auto, auto, auto, auto;
    background-position: center;
    background-repeat: no-repeat;
    /* Held well back: white type must stay legible over any photograph, and the
       lamps must remain the brightest thing on the screen. */
    filter: saturate(.66) brightness(.42) contrast(1.03);
    transform: scale(1.04);
  }
  /* A vignette and a floor-to-ceiling fade, so panes never sit on a hotspot. */
  .photo::after {
    content: ''; position: absolute; inset: 0;
    background:
      /* The sky and the snow are the brightest part of the picture and they sit
         exactly where the header does, so the top is held down hardest. */
      linear-gradient(180deg,
        rgba(10,8,6,.74) 0%,  rgba(10,8,6,.58) 12%, rgba(10,8,6,.40) 22%,
        rgba(10,8,6,.24) 32%, rgba(10,8,6,.10) 41%, transparent 50%,
        rgba(10,8,6,.14) 62%, rgba(10,8,6,.34) 80%, rgba(10,8,6,.60) 100%),
      radial-gradient(130% 86% at 50% 8%, transparent 34%, rgba(8,6,4,.52) 100%);
  }

  .spill {
    position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background:
      /* Standing warmth, well off-centre, so no two panes sit over the same
         tone — glass only reads as glass when what is behind it varies. */
      radial-gradient(74% 52% at 8% -14%,  rgba(214,230,246,.10) 0%, transparent 64%),
      radial-gradient(52% 42% at 96% 4%,   rgba(206,224,244,.06) 0%, transparent 62%),
      radial-gradient(46% 38% at 62% 30%,  rgba(220,234,248,.035) 0%, transparent 70%),
      /* The house's own light, rising from the foot of the room. This is the
         part that moves: brighter and warmer as more of the house comes on. */
      radial-gradient(120% 78% at 50% 124%,
        color-mix(in oklab, var(--lamp) calc(var(--glow) * 58%), transparent) 0%, transparent 74%),
      radial-gradient(70% 52% at 84% 112%,
        color-mix(in oklab, var(--lamp) calc(var(--glow) * 34%), transparent) 0%, transparent 66%),
      radial-gradient(58% 46% at 14% 104%,
        color-mix(in oklab, var(--lamp) calc(var(--glow) * 22%), transparent) 0%, transparent 64%),
      linear-gradient(180deg, rgba(244,248,252,.03) 0%, transparent 38%, rgba(0,0,0,.36) 100%);
    transition: background 1.2s ease;
  }

  .shell {
    position: relative; z-index: 1; flex: 1; min-height: 0;
    display: flex; flex-direction: column;
    width: 100%; max-width: 1320px; margin: 0 auto;
    padding: clamp(20px, 3.4vh, 40px) clamp(20px, 3.6vw, 52px) clamp(18px, 3vh, 34px);
    gap: clamp(18px, 2.6vh, 32px);
  }

  /* ── the top line ────────────────────────────────────────────────────── */
  .plate { flex: 0 0 auto; display: flex; align-items: center; gap: clamp(14px, 2.4vw, 26px); }
  .stamp { min-width: 0; }
  .stamp h1 {
    margin: 0; font-size: 15px; font-weight: 500; letter-spacing: -.005em; color: var(--ink);
  }
  .tally { margin: 3px 0 0; font-size: 12.5px; color: var(--faint); }
  .tally b { color: var(--soft); font-weight: 500; }
  .tally.stale b { color: var(--clay); }
  /* separators live on the parts, so a part can be hidden without stranding one */
  .tally .host::before, .tally .when::before { content: ' · '; }

  /* Only a phone gets this: search is a power feature and does not deserve a
     permanent row on a 375px screen. */
  .seek-toggle {
    display: none; flex: 0 0 auto; width: 38px; height: 38px; padding: 0; cursor: pointer;
    place-items: center; border-radius: 11px;
    background: var(--pane); border: 1px solid var(--edge); color: var(--soft);
    backdrop-filter: blur(22px) saturate(150%);
    -webkit-backdrop-filter: blur(22px) saturate(150%);
  }
  .seek-toggle svg { width: 16px; height: 16px; }
  .seek-toggle:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }

  .seek { position: relative; margin-left: auto; flex: 0 1 clamp(160px, 26vw, 290px); min-width: 0; }
  .seek input {
    width: 100%; padding: 10px 14px 10px 34px; color: var(--ink);
    background: var(--pane); border: 1px solid var(--edge); border-radius: 12px;
    backdrop-filter: blur(30px) saturate(125%); -webkit-backdrop-filter: blur(30px) saturate(125%);
    box-shadow: inset 0 1px 0 var(--lip);
    font: 400 13.5px/1 var(--sans); outline: none; transition: border-color .2s, background .2s;
  }
  .seek input::placeholder { color: var(--faint); }
  .seek input:focus { border-color: var(--edge-up); background: var(--pane-up); }
  .seek svg { position: absolute; left: 12px; top: 50%; width: 14px; height: 14px;
              margin-top: -7px; color: var(--faint); pointer-events: none; }

  /* Everything off is a big, irreversible thing, so it is held rather than tapped. */
  .main {
    position: relative; flex: 0 0 auto; padding: 10px 16px; cursor: pointer; overflow: hidden;
    display: flex; align-items: center; gap: 8px;
    background: var(--pane); border: 1px solid var(--edge); border-radius: 12px;
    backdrop-filter: blur(30px) saturate(125%); -webkit-backdrop-filter: blur(30px) saturate(125%);
    box-shadow: inset 0 1px 0 var(--lip);
    color: var(--soft); font: 500 13px/1 var(--sans);
    transition: color .2s, border-color .2s, background .2s;
    touch-action: none; -webkit-user-select: none; user-select: none;
  }
  .main:hover:not(:disabled) { color: var(--ink); background: var(--pane-up); }
  .main:disabled { opacity: .3; cursor: default; }
  .main:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 3px; }
  .main i { position: absolute; left: 0; top: 0; bottom: 0; width: 0%;
            background: var(--clay); opacity: .28; }
  .main.armed { color: var(--ink); border-color: color-mix(in oklab, var(--clay) 60%, var(--edge)); }
  .main span, .main em { position: relative; }
  .main em { font-style: normal; color: var(--faint); }

  /* ── rooms and cues down one side ────────────────────────────────────── */
  .board { flex: 1; min-height: 0; display: grid; gap: clamp(20px, 2.6vw, 44px);
           grid-template-columns: clamp(168px, 15vw, 212px) 1fr; }
  .index { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 26px;
           overflow-y: auto; scrollbar-width: none; }
  .index::-webkit-scrollbar { display: none; }
  .legend { font-size: 12px; color: var(--faint); margin-bottom: 8px; }
  .index-sec { min-width: 0; }

  .tab {
    position: relative; width: 100%; display: block; text-align: left; cursor: pointer;
    padding: 8px 12px; border-radius: 10px;
    background: none; border: 1px solid transparent; color: var(--soft);
    font: 400 14px/1.3 var(--sans); transition: color .18s, background .18s, border-color .18s;
  }
  .tab:hover { color: var(--ink); background: var(--pane); }
  .tab:focus-visible { outline: 2px solid var(--edge-up); outline-offset: -1px; }
  .tab.here { color: var(--ink); background: var(--pane); border-color: var(--edge); }
  .tab-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .tab-n { font-size: 12.5px; color: var(--faint); }
  .tab.awake .tab-n { color: var(--lamp); }
  /* the room's load, in the room's own light — the only colour in this column */
  .tab-load { display: none; }

  .cue-wrap { position: relative; margin-bottom: 6px; }
  .cue {
    position: relative; width: 100%; display: block; text-align: left; cursor: pointer;
    padding: 10px 34px 11px 12px; border-radius: 12px;
    background: var(--pane); border: 1px solid var(--edge); color: var(--ink);
    backdrop-filter: blur(26px) saturate(125%); -webkit-backdrop-filter: blur(26px) saturate(125%);
    box-shadow: inset 0 1px 0 var(--lip);
    font: 400 13.5px/1.3 var(--sans); transition: background .18s, border-color .18s, transform .16s;
  }
  .cue:hover { background: var(--pane-up); border-color: var(--edge-up); }
  .cue:active { transform: scale(.99); }
  .cue:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 3px; }
  .cue.firing { border-color: var(--edge-up); animation: breathe 1.4s ease-in-out infinite; }
  @keyframes breathe { 50% { opacity: .55; } }
  .cue-note {
    display: block; margin-top: 2px; font-size: 12px; color: var(--faint);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cue-swatch { display: block; height: 2px; margin-top: 9px; border-radius: 1px;
                background: rgba(255,255,255,.08); }
  .cue-swatch i { display: block; height: 100%; border-radius: 1px; opacity: .85; }
  .cue-edit {
    position: absolute; top: 9px; right: 9px; width: 22px; height: 22px; padding: 0;
    display: grid; place-items: center; cursor: pointer; opacity: 0;
    background: none; border: 0; border-radius: 6px; color: var(--faint);
    transition: opacity .18s, color .18s, background .18s;
  }
  .cue-edit svg { width: 13px; height: 13px; }
  .cue-wrap:hover .cue-edit, .cue-edit:focus-visible { opacity: 1; }
  .cue-edit:hover { color: var(--ink); background: rgba(255,255,255,.08); }
  .cue-edit:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 1px; }

  .newcue {
    width: 100%; padding: 9px 12px; cursor: pointer; text-align: left;
    background: none; border: 1px dashed var(--edge); border-radius: 12px;
    color: var(--faint); font: 400 13px/1.3 var(--sans); transition: color .18s, border-color .18s;
  }
  .newcue:hover { color: var(--ink); border-color: var(--edge-up); }
  .newcue:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 3px; }

  /* ── the field ───────────────────────────────────────────────────────── */
  .field { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .field-head { flex: 0 0 auto; display: flex; align-items: flex-end; gap: 16px; margin-bottom: 20px; }
  /* Going back deserves saying outright. The rail and a sideways swipe both do
     it, but neither is visible when you are looking at one room and wondering
     how to leave it. */
  .back {
    display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
    margin-bottom: 9px; padding-top: 6px; padding-right: 12px;
    padding-bottom: 6px; padding-left: 9px;
    font: inherit; font-size: 12.5px; color: var(--soft);
    background: var(--pane); border: 1px solid var(--edge); border-radius: 999px;
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    transition: color .18s, border-color .18s, background .18s, transform .18s;
  }
  .back[hidden] { display: none; }
  .back svg { width: 14px; height: 14px; }
  .back:hover { color: var(--ink); border-color: var(--edge-up); background: var(--pane-up); transform: translateX(-2px); }
  .back:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }
  .field-head h2 {
    margin: 0; font-size: clamp(24px, 3.6vh, 34px); font-weight: 400;
    letter-spacing: -.018em; line-height: 1.1;
  }
  .field-sub { margin: 5px 0 3px; font-size: 13px; color: var(--faint); }
  .field-sub b { color: var(--soft); font-weight: 500; }
  .cut {
    margin-left: auto; flex: 0 0 auto; padding: 9px 14px; cursor: pointer;
    background: var(--pane); border: 1px solid var(--edge); border-radius: 11px;
    backdrop-filter: blur(26px); -webkit-backdrop-filter: blur(26px);
    color: var(--soft); font: 400 13px/1 var(--sans); transition: color .18s, background .18s;
  }
  .cut:hover:not(:disabled) { color: var(--ink); background: var(--pane-up); }
  .cut:disabled { opacity: .28; cursor: default; }
  .cut:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 3px; }

  /* Rows are min-content so a tile keeps its height instead of being crushed
     to fit, which is what auto rows do inside a fixed-height box. */
  .tiles {
    flex: 1; min-height: 0; overflow-y: auto; padding: 2px 4px 8px 2px;
    display: grid; gap: clamp(12px, 1.4vw, 18px); align-content: start;
    grid-template-columns: repeat(auto-fill, minmax(206px, 1fr));
    grid-auto-rows: min-content;
    scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.14) transparent;
  }
  .tiles::-webkit-scrollbar { width: 8px; }
  .tiles::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 4px; }
  .tiles::-webkit-scrollbar-track { background: transparent; }
  .group-label { grid-column: 1 / -1; font-size: 12.5px; color: var(--faint); margin: 16px 0 -4px; }
  .group-label:first-child { margin-top: 0; }
  .empty { grid-column: 1 / -1; font-size: 13.5px; color: var(--faint); padding: 30px 2px; }

  /* ── the tile ────────────────────────────────────────────────────────── */
  /* Glass. The light a circuit is making rises softly from the foot of its own
     tile, in that light's own colour temperature — and nothing else has colour. */
  .tile {
    --tint: var(--warm);
    --lit: 0;                 /* how bright this circuit really is, 0 → 1 */
    position: relative; height: var(--tile-h); overflow: hidden; isolation: isolate;
    border-radius: 20px; border: 1px solid var(--edge); background: var(--pane);
    backdrop-filter: blur(30px) saturate(125%); -webkit-backdrop-filter: blur(30px) saturate(125%);
    box-shadow: inset 0 1px 0 var(--lip),
                inset 0 -18px 26px -26px rgba(0,0,0,.55),
                var(--cast);
    transition: border-color .25s, background .25s, transform .18s, box-shadow .3s;
  }
  /* ── the lit edge ──────────────────────────────────────────────────────
     A one-pixel gradient laid in the border box and masked out of the middle,
     so it draws only the rim. This is what separates a pane of glass from a
     rounded rectangle with a border: the edge catches light unevenly and the
     face stays clear. Guarded, because without mask-composite the mask does
     not cut and the gradient would flood the whole surface. */
  @supports (mask-composite: exclude) or (-webkit-mask-composite: xor) {
    .tile::after, .cue::after, .tab::after, .sheet::after,
    .timerpop::after, .quick button::after, .key::after {
      content: ''; position: absolute; inset: 0; z-index: 3;
      border-radius: inherit; padding: 1px; pointer-events: none;
      background: var(--rim);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask-composite: exclude;
      transition: background .45s ease, opacity .45s ease;
    }
    /* Only what is lit or chosen catches the light along its edge — in the
       reference exactly one row has a rim and the rest have none. Here that
       rule does double duty: it is also how the page says a lamp is on, so an
       unlit pane stays a quiet sheet of glass and recedes. */
    .tile::after { opacity: .3; }
    .tile.on::after { opacity: 1; background: var(--rim-lit); }
    .tab::after { opacity: 0; }
    .tab.here::after, .tab.awake::after { opacity: 1; }
    .tab.here::after { background: var(--rim-lit); }
    .cue::after { opacity: .38; }
    .cue:hover::after, .cue.firing::after { opacity: 1; }
    .key::after { opacity: 0; }
    .key.on::after { opacity: 1; background: var(--rim-lit); }
    .quick button::after { opacity: .4; }
    .quick button.on::after { opacity: 1; background: var(--rim-lit); }
  }

  .tile::before {
    content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none;
    border-radius: inherit; background: var(--sheen);
  }
  .tile:hover { transform: translateY(-2px); background: var(--pane-up); border-color: var(--edge-up); }
  /* A lit circuit throws light: the pane lifts, its edge catches the colour, and
     the tile casts a soft halo onto the surface behind it. Every part of that is
     scaled by --lit, so a lamp at 20% barely glows and one at 100% really does. */
  .tile.on {
    background: rgba(16,20,27,.34);
    border-color: color-mix(in oklab, var(--tint) calc(28% + var(--lit) * 42%), var(--edge));
    box-shadow:
      /* the lit edge itself */
      inset 0 1px 0 color-mix(in oklab, var(--tint) calc(var(--lit) * 42%), var(--glass-hi)),
      /* the pool of light standing in the bottom of the pane */
      inset 0 -44px 64px -32px color-mix(in oklab, var(--tint) calc(var(--lit) * 88%), transparent),
      /* a tight halo hugging the glass, then a wide one thrown onto the page —
         two falloffs rather than one, which is what a real lamp does and what
         a single blur radius can never look like */
      0 0 calc(10px + var(--lit) * 18px) calc(var(--lit) * -2px)
        color-mix(in oklab, var(--tint) calc(var(--lit) * 46%), transparent),
      0 0 calc(30px + var(--lit) * 78px) calc(var(--lit) * 2px)
        color-mix(in oklab, var(--tint) calc(var(--lit) * 30%), transparent),
      var(--cast);
  }
  /* ── bento ───────────────────────────────────────────────────────────
     Cards are not all one size, and the size is not arbitrary: a circuit takes
     the room its controls actually need. A tunable lamp carries two sliders and
     spans the row; a dimmable one is taller; a plain switch stays a small
     square. Room cards stay uniform — they are navigation, and making the lit
     ones wide meant a screen held one and a half rooms instead of four. */
  .tile.wide { grid-column: span 2; }
  .tile.tall { height: calc(var(--tile-h) + 58px); }

  .tile.busy { opacity: .5; }
  .tile.refused { border-color: var(--clay); }

  /* The light in a pane is one gradient across the whole face, not a box with
     a height. It used to be a sized element with a separate bloom layered above
     it, and where those two met there was a seam — a hard horizontal line
     straight across the card, most obvious on a room that was only part lit.
     Driving the stops from --fill instead means the light simply rises and
     fades out; there is no element edge left to show. */
  .tile-fill {
    --fill: 0;
    position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background: linear-gradient(0deg,
      color-mix(in oklab, var(--tint) 46%, transparent) 0%,
      color-mix(in oklab, var(--tint) 32%, transparent) calc(var(--fill) * 44%),
      color-mix(in oklab, var(--tint) 15%, transparent) calc(var(--fill) * 78%),
      color-mix(in oklab, var(--tint)  6%, transparent) calc(var(--fill) * 100% + 6%),
      transparent calc(var(--fill) * 100% + 34%));
    transition: background .55s cubic-bezier(.3,.8,.3,1);
  }
  .tile:not(.on) .tile-fill { background: none; }
  .tile:not(.on) .tile-fill::after { background: none; }

  .tile-body {
    position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column;
    justify-content: flex-end; gap: 3px; padding: 18px 18px 18px;
    background: none; border: 0; color: inherit; font: inherit; text-align: left;
  }
  button.tile-body { cursor: pointer; }
  button.tile-body:focus-visible { outline: 2px solid var(--edge-up); outline-offset: -5px; border-radius: 16px; }
  .tile-name {
    font: 400 15px/1.3 var(--sans); color: var(--soft); padding-right: 34px;
    transition: color .25s; overflow: hidden; text-overflow: ellipsis;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .tile.on .tile-name { color: var(--ink); }
  .tile-read { font-size: 13px; color: var(--faint); transition: color .25s; }
  .tile.on .tile-read { color: var(--soft); }

  /* the switch: a dot that takes the colour of its own lamp. No lever, no lens. */
  .key {
    position: absolute; z-index: 4; top: 14px; right: 14px; width: 34px; height: 34px;
    padding: 0; cursor: pointer; display: grid; place-items: center;
    background: none; border: 0; border-radius: 50%;
    transition: background .2s;
  }
  .key:hover { background: rgba(255,213,160,.06); }
  .key:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 0; }
  .key:disabled { opacity: .3; cursor: default; }
  .key i {
    display: block; width: 13px; height: 13px; border-radius: 50%;
    border: 1.5px solid rgba(255,213,160,.26); background: transparent;
    transition: background .22s, border-color .22s, box-shadow .22s;
  }
  .tile.on .key i {
    background: var(--tint); border-color: color-mix(in oklab, var(--tint) 70%, transparent);
    box-shadow:
      0 0 0 4px color-mix(in oklab, var(--tint) calc(10% + var(--lit) * 12%), transparent),
      0 0 calc(8px + var(--lit) * 16px) color-mix(in oklab, var(--tint) calc(var(--lit) * 85%), transparent);
  }

  /* Plain sliders along the foot of the tile: brightness, then warmth if the
     lamp has it. Dragging the whole tile was clever and nobody could find it. */
  .controls { position: absolute; z-index: 4; left: 18px; right: 18px; bottom: 12px; display: grid; gap: 7px; }
  .tile.dims .tile-body { padding-bottom: 42px; }
  .tile.tunes .tile-body { padding-bottom: 42px; }
  .tile.dims.tunes .tile-body { padding-bottom: 70px; }

  .slider {
    -webkit-appearance: none; appearance: none;
    width: 100%; height: 18px; margin: 0; padding: 0; background: none; cursor: pointer;
  }
  .slider:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 1px; border-radius: 4px; }
  .slider::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; }
  .slider::-moz-range-track { height: 3px; border-radius: 2px; }
  .slider::-webkit-slider-thumb {
    -webkit-appearance: none; width: 11px; height: 11px; margin-top: -4px; border-radius: 50%;
    background: var(--ink); border: 0;
  }
  .slider::-moz-range-thumb { width: 11px; height: 11px; border-radius: 50%; background: var(--ink); border: 0; }

  /* brightness fills to its level in the lamp's own colour */
  .slider.dim::-webkit-slider-runnable-track {
    background: linear-gradient(90deg, var(--tint) var(--pct), rgba(255,213,160,.14) var(--pct));
  }
  .slider.dim::-moz-range-track {
    background: linear-gradient(90deg, var(--tint) var(--pct), rgba(255,213,160,.14) var(--pct));
  }
  /* warmth is a scale, not a level: the whole track is the range it can burn */
  .slider.warm::-webkit-slider-runnable-track {
    background: linear-gradient(90deg, var(--cool), #f3e3c4 46%, var(--warm)); opacity: .35;
  }
  .slider.warm::-moz-range-track {
    background: linear-gradient(90deg, var(--cool), #f3e3c4 46%, var(--warm)); opacity: .35;
  }
  .tile.on .slider.warm::-webkit-slider-runnable-track { opacity: 1; }
  .tile.on .slider.warm::-moz-range-track { opacity: 1; }
  .tile:not(.on) .slider::-webkit-slider-thumb { background: var(--soft); }
  .tile:not(.on) .slider::-moz-range-thumb { background: var(--soft); }

  /* ── circuits that are not switches ──────────────────────────────────── */
  .drawer { position: absolute; z-index: 4; left: 18px; right: 18px; bottom: 16px; display: grid; gap: 7px; }
  .tile.curtain .tile-body { padding-bottom: 52px; }
  /* An air conditioner carries a temperature, a mode and a fan speed. That is
     three rows of controls, which a tile sized for a lamp cannot hold — without
     the extra height the name lands on top of them. */
  .tile.climate { height: calc(var(--tile-h) + 106px); }
  .tile.climate .tile-body { padding-bottom: 164px; }
  .pulls { display: flex; gap: 7px; }
  /* Stop is narrower and quieter: it is the exception, not a third destination. */
  .pull.halt { flex: 0 0 auto; padding-left: 12px; padding-right: 12px; color: var(--faint); }
  .pull.halt:hover { color: var(--ink); }
  .pull {
    flex: 1; padding: 8px 6px; cursor: pointer; border-radius: 9px;
    background: rgba(255,213,160,.05); border: 1px solid var(--edge);
    color: var(--soft); font: 400 12.5px/1 var(--sans); transition: color .18s, background .18s;
  }
  .pull:hover { color: var(--ink); background: rgba(255,213,160,.1); }
  .pull:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }
  .pull.working { color: var(--ink); border-color: var(--edge-up); }

  .degrees { display: flex; align-items: center; gap: 7px; }
  .degrees b { flex: 1; text-align: center; font-weight: 500; font-size: 14px; color: var(--ink); }
  .step {
    width: 28px; height: 26px; padding: 0; cursor: pointer; border-radius: 8px;
    background: rgba(255,213,160,.05); border: 1px solid var(--edge); color: var(--soft);
    font: 400 14px/1 var(--sans);
  }
  .step:hover:not(:disabled) { color: var(--ink); background: rgba(255,213,160,.1); }
  .step:disabled { opacity: .3; cursor: default; }
  .step:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }
  .seg-label { font-size: 11px; color: var(--faint); margin-bottom: 4px; }
  .segs { display: flex; gap: 5px; }
  .seg {
    flex: 1; padding: 6px 2px; cursor: pointer; border-radius: 8px;
    background: rgba(255,213,160,.05); border: 1px solid var(--edge);
    color: var(--soft); font: 400 11px/1 var(--sans);
  }
  .seg:hover { color: var(--ink); background: rgba(255,213,160,.1); }
  .seg:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }
  .seg.sent { color: var(--ink); border-color: var(--edge-up); background: rgba(255,213,160,.12); }
  /* chosen, but the unit has not been told yet — the command is still waiting */
  .pending { opacity: .5; }

  /* ── the sheet ───────────────────────────────────────────────────────── */
  .scrim {
    position: fixed; inset: 0; z-index: 50; display: grid; place-items: center;
    padding: 22px; background: rgba(16,12,9,.7);
    backdrop-filter: blur(14px) saturate(80%); -webkit-backdrop-filter: blur(14px) saturate(80%);
    animation: fade .22s ease both;
  }
  .scrim[hidden] { display: none; }
  @keyframes fade { from { opacity: 0; } }
  .sheet {
    width: min(540px, 100%); max-height: min(680px, 88vh); display: flex; flex-direction: column;
    border-radius: 24px; border: 1px solid var(--edge-up); background: rgba(70,60,51,.74);
    backdrop-filter: blur(50px) saturate(130%); -webkit-backdrop-filter: blur(50px) saturate(130%);
    box-shadow: inset 0 1px 0 var(--lip), 0 40px 80px -28px rgba(0,0,0,.75);
    animation: lift .3s cubic-bezier(.2,.8,.3,1) both;
  }
  @keyframes lift { from { opacity: 0; transform: translateY(12px) scale(.985); } }
  .sheet-head { padding: 22px 24px 18px; border-bottom: 1px solid var(--edge); }
  .sheet-eyebrow { font-size: 12px; color: var(--faint); }
  /* The cue's address for Siri and cron. Selectable, because it gets copied. */
  .sheet-api {
    margin: 8px 0 0; font-size: 11px; letter-spacing: .02em; color: var(--faint);
    font-family: var(--mono, ui-monospace, monospace); user-select: all;
  }
  .sheet-api::before { content: 'api id  '; opacity: .6; }
  .sheet-name {
    width: 100%; margin-top: 6px; padding: 6px 10px; color: var(--ink);
    background: none; border: 1px solid transparent; border-radius: 10px;
    font: 400 24px/1.2 var(--sans); letter-spacing: -.018em; outline: none;
    transition: border-color .18s, background .18s;
  }
  .sheet-name:hover { border-color: var(--edge); }
  .sheet-name:focus { border-color: var(--edge-up); background: rgba(255,213,160,.05); }
  .sheet-facts { margin: 10px 0 0; display: flex; flex-wrap: wrap; gap: 4px 18px;
                 font-size: 13px; color: var(--faint); }
  .sheet-facts b { color: var(--soft); font-weight: 500; }
  .sheet-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 24px 18px;
                scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.14) transparent; }
  .sheet-room { margin: 18px 0 4px; font-size: 12.5px; color: var(--faint); }
  .sheet-step { border-bottom: 1px solid rgba(255,213,160,.05); }
  .sheet-row {
    width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 0; cursor: pointer;
    background: none; border: 0; color: var(--soft); font: 400 14px/1.4 var(--sans); text-align: left;
  }
  .sheet-row:hover { color: var(--ink); }
  .sheet-row:focus-visible { outline: 2px solid var(--edge-up); outline-offset: -2px; border-radius: 8px; }
  .sheet-step .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;
                     border: 1.5px solid rgba(255,213,160,.2); }
  .sheet-step.lit .dot { background: var(--pip); border-color: transparent; }
  .sheet-step .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sheet-step.lit .what { color: var(--ink); }
  .sheet-step .to { font-size: 13px; color: var(--faint); }
  .sheet-step .chev { font-size: 10px; color: var(--faint); transition: transform .2s; }
  .sheet-step.open .chev { transform: rotate(180deg); }

  /* what one circuit will be set to, opened up */
  .step-edit { display: grid; gap: 12px; padding: 4px 0 16px 20px; }
  .step-edit[hidden] { display: none; }
  .onoff { display: flex; gap: 6px; }
  .onoff button {
    padding: 7px 16px; cursor: pointer; border-radius: 9px;
    background: rgba(255,213,160,.05); border: 1px solid var(--edge);
    color: var(--soft); font: 400 13px/1 var(--sans); transition: color .18s, background .18s;
  }
  .onoff button:hover { color: var(--ink); background: rgba(255,213,160,.1); }
  .onoff button:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }
  .onoff button.picked { background: var(--ink); border-color: var(--ink); color: var(--base); font-weight: 500; }
  .step-slider { display: flex; align-items: center; gap: 12px; }
  .step-slider span { flex: 0 0 74px; font-size: 13px; color: var(--faint); }
  .step-slider b { flex: 0 0 62px; text-align: right; font-weight: 400; font-size: 13px; color: var(--soft); }
  .step-slider input {
    -webkit-appearance: none; appearance: none; flex: 1; min-width: 0;
    height: 18px; margin: 0; background: none; cursor: pointer;
  }
  .step-slider input:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; border-radius: 4px; }
  .step-slider input::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: rgba(255,213,160,.12); }
  .step-slider input::-moz-range-track { height: 3px; border-radius: 2px; background: rgba(255,213,160,.12); }
  .step-slider.warm input::-webkit-slider-runnable-track {
    background: linear-gradient(90deg, var(--cool), #f3e3c4 46%, var(--warm)); }
  .step-slider.warm input::-moz-range-track {
    background: linear-gradient(90deg, var(--cool), #f3e3c4 46%, var(--warm)); }
  .step-slider input::-webkit-slider-thumb {
    -webkit-appearance: none; width: 13px; height: 13px; margin-top: -5px; border-radius: 50%;
    background: var(--ink); border: 0; }
  .step-slider input::-moz-range-thumb {
    width: 13px; height: 13px; border-radius: 50%; background: var(--ink); border: 0; }
  .step-drop {
    justify-self: start; padding: 6px 12px; cursor: pointer; border-radius: 8px;
    background: none; border: 1px solid var(--edge); color: var(--faint);
    font: 400 12.5px/1 var(--sans); transition: color .18s, border-color .18s;
  }
  .step-drop:hover { color: var(--clay); border-color: var(--clay); }
  .step-drop:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }

  /* choosing circuits: the room first, then the lights in it */
  .sheet-add {
    width: 100%; margin-top: 18px; padding: 11px; cursor: pointer; text-align: center;
    background: none; border: 1px dashed var(--edge); border-radius: 12px;
    color: var(--soft); font: 400 13.5px/1 var(--sans); transition: color .18s, border-color .18s;
  }
  .sheet-add:hover { color: var(--ink); border-color: var(--edge-up); }
  .sheet-add:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 3px; }
  .pick {
    width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 2px; cursor: pointer;
    background: none; border: 0; border-bottom: 1px solid rgba(255,213,160,.05);
    color: var(--soft); font: 400 14px/1.4 var(--sans); text-align: left;
  }
  .pick:hover { color: var(--ink); }
  .pick:focus-visible { outline: 2px solid var(--edge-up); outline-offset: -2px; border-radius: 8px; }
  .pick .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pick .count { font-size: 13px; color: var(--faint); }
  .pick .chev { font-size: 11px; color: var(--faint); }
  .pick .box {
    width: 18px; height: 18px; flex: 0 0 auto; border-radius: 5px;
    border: 1.5px solid rgba(255,213,160,.22); display: grid; place-items: center;
    transition: background .18s, border-color .18s;
  }
  .pick .box svg { width: 11px; height: 11px; color: var(--base); opacity: 0; }
  .pick.in .box { background: var(--ink); border-color: var(--ink); }
  .pick.in .box svg { opacity: 1; }
  .pick.in .what { color: var(--ink); }
  .sheet-back {
    display: inline-flex; align-items: center; gap: 7px; margin-bottom: 6px;
    padding: 6px 12px 6px 9px; cursor: pointer; border-radius: 9px;
    background: none; border: 1px solid var(--edge); color: var(--soft);
    font: 400 13px/1 var(--sans); transition: color .18s, background .18s;
  }
  .sheet-back:hover { color: var(--ink); background: rgba(255,213,160,.06); }
  .sheet-back:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }
  .sheet-back svg { width: 13px; height: 13px; }
  .sheet-foot { display: flex; flex-wrap: wrap; gap: 8px; padding: 16px 24px 20px;
                border-top: 1px solid var(--edge); }
  .sheet-btn {
    padding: 10px 15px; cursor: pointer; border-radius: 11px;
    background: rgba(255,213,160,.05); border: 1px solid var(--edge);
    color: var(--soft); font: 400 13px/1 var(--sans); transition: color .18s, background .18s;
  }
  .sheet-btn:hover { color: var(--ink); background: rgba(255,213,160,.1); }
  .sheet-btn:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 3px; }
  .sheet-btn.go { background: var(--ink); border-color: var(--ink); color: var(--base); font-weight: 500; }
  .sheet-btn.go:hover { color: var(--base); background: #fff; }
  .sheet-btn.danger { margin-left: auto; }
  .sheet-btn.danger:hover, .sheet-btn.danger.armed { color: var(--clay); border-color: var(--clay); }

  /* ── messages ────────────────────────────────────────────────────────── */
  .note {
    position: fixed; left: 50%; bottom: 26px; z-index: 60;
    transform: translate(-50%, 180%); visibility: hidden; opacity: 0;
    max-width: min(92vw, 440px); padding: 13px 18px;
    background: rgba(70,60,51,.78); border: 1px solid var(--edge-up); border-radius: 14px;
    backdrop-filter: blur(40px) saturate(130%); -webkit-backdrop-filter: blur(40px) saturate(130%);
    box-shadow: inset 0 1px 0 var(--lip), 0 24px 50px -20px rgba(0,0,0,.7);
    font-size: 13.5px; color: var(--ink);
    transition: transform .34s cubic-bezier(.2,.8,.3,1), opacity .22s, visibility .34s;
  }
  .note.show { transform: translate(-50%, 0); visibility: visible; opacity: 1; }
  .note { display: flex; align-items: center; gap: 16px; }
  .note-text { flex: 1; min-width: 0; }
  .note-do {
    flex: 0 0 auto; padding: 7px 14px; cursor: pointer; border-radius: 9px;
    background: var(--ink); border: 0; color: var(--base);
    font: 500 13px/1 var(--sans); transition: filter .16s;
  }
  .note-do:hover { filter: brightness(1.08); }
  .note-do:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }

  .enter { animation: rise .34s cubic-bezier(.2,.8,.3,1) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(5px); } }

  /* ── narrow ──────────────────────────────────────────────────────────── */
  /* ── the phone ───────────────────────────────────────────────────────── */
  /* A phone is not a narrow desktop. The whole page scrolls as one — a fixed
     shell with only the tile grid moving inside it feels broken on a touch
     screen — and the top bar stays put so the house is always one tap away. */
  /* ── the house at a glance ───────────────────────────────────────────
     A phone should not have to be scrolled to be read. One card carries the
     whole house: what is lit, said in words, over a row where every room is a
     column of its own light — height is how much, colour is how warm. Tapping
     a column goes there, so it is a summary and a way in at once. */
  .glance { display: none; }

  @media (max-width: 860px) {
    .glance {
      display: block; width: 100%; text-align: left; cursor: pointer;
      margin-bottom: 14px; padding: 14px 14px 10px; border-radius: 18px;
      background: var(--pane); background-image: var(--sheen);
      border: 1px solid var(--edge); box-shadow: var(--cast);
      backdrop-filter: blur(22px) saturate(150%);
      -webkit-backdrop-filter: blur(22px) saturate(150%);
      font: inherit; color: var(--ink);
    }
    .glance-say { display: block; font-size: 15px; line-height: 1.35; color: var(--soft); }
    .glance-say b { color: var(--ink); font-weight: 500; }
    .glance-say i { font-style: normal; color: var(--warm); font-weight: 500; }
    .glance-bars {
      display: flex; align-items: flex-end; gap: 5px; height: 46px; margin-top: 12px;
    }
    .glance-bar {
      flex: 1 1 0; min-width: 0; position: relative; height: 100%;
      background: none; border: 0; padding: 0; cursor: pointer;
    }
    /* the column of light: a floor line always, the lamp's own colour above it */
    .glance-bar i {
      position: absolute; left: 0; right: 0; bottom: 0; display: block;
      height: max(3px, calc(var(--load) * 100%)); border-radius: 3px;
      background: linear-gradient(0deg,
        color-mix(in oklab, var(--tint) 78%, transparent) 0%,
        color-mix(in oklab, var(--tint) 34%, transparent) 100%);
      box-shadow: 0 0 calc(var(--load) * 16px) color-mix(in oklab, var(--tint) calc(var(--load) * 55%), transparent);
      transition: height .5s cubic-bezier(.3,.8,.3,1), background .4s;
    }
    .glance-bar.dark i { background: rgba(255,255,255,.10); box-shadow: none; }
    .glance-bar.here i { outline: 1px solid var(--edge-up); outline-offset: 1px; }
    .glance-bar u {
      position: absolute; left: 0; right: 0; bottom: -14px; text-decoration: none;
      font-size: 9px; letter-spacing: .02em; color: var(--faint);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center;
    }
    .glance-bars { margin-bottom: 16px; }
  }

  /* ── advisories ────────────────────────────────────────────────────────
     Something has been on a long time. These never act by themselves — the
     house does not switch off a room someone may be sitting in — so they are
     written as observations rather than alarms. */
  .nudges { display: grid; gap: 8px; margin-bottom: 16px; }
  .nudge {
    display: flex; align-items: center; gap: 11px;
    padding-top: 10px; padding-right: 11px; padding-bottom: 10px; padding-left: 13px;
    border-radius: 13px; background: var(--pane); background-image: var(--sheen);
    border: 1px solid var(--edge);
    backdrop-filter: blur(14px) saturate(1.15);
    -webkit-backdrop-filter: blur(14px) saturate(1.15);
  }
  .nudge .pip { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--neutral); }
  .nudge.ac .pip { background: var(--clay); }
  .nudge .said { flex: 1 1 auto; min-width: 0; font-size: 13px; line-height: 1.35; color: var(--soft); }
  .nudge .said b { color: var(--ink); font-weight: 500; }
  .nudge .said i { font-style: normal; color: var(--faint); }
  .nudge button {
    flex: 0 0 auto; font: inherit; font-size: 12px; color: var(--soft); cursor: pointer;
    padding-top: 6px; padding-right: 10px; padding-bottom: 6px; padding-left: 10px;
    border-radius: 9px; background: var(--pane-up); border: 1px solid var(--edge);
  }
  .nudge button:hover { color: var(--ink); border-color: var(--edge-up); }

  /* ── sleep timer ───────────────────────────────────────────────────────
     The thing you want while already in bed, so it is reachable without
     going anywhere: a small panel, never a page. */
  .timerpop {
    position: fixed; z-index: 46; right: 18px; bottom: 18px;
    width: min(330px, calc(100vw - 36px));
    padding: 15px; border-radius: 16px;
    background: rgba(14,17,23,.92); border: 1px solid var(--edge-up);
    backdrop-filter: blur(22px) saturate(1.25);
    -webkit-backdrop-filter: blur(22px) saturate(1.25);
    box-shadow: var(--cast);
  }
  .timerpop[hidden] { display: none; }
  .timerpop h3 { margin: 0 0 2px; font-size: 13px; font-weight: 500; color: var(--ink); }
  .timerpop p { margin: 0 0 11px; font-size: 12px; color: var(--faint); }
  .scopes { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 11px; }
  .scopes button {
    font: inherit; font-size: 12px; color: var(--faint); cursor: pointer;
    padding-top: 7px; padding-right: 11px; padding-bottom: 7px; padding-left: 11px;
    border-radius: 9px; background: transparent; border: 1px solid var(--edge);
  }
  .scopes button.on { color: var(--ink); background: var(--pane-up); border-color: var(--edge-up); }
  .mins { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
  .mins button {
    font: inherit; font-size: 12.5px; color: var(--soft); cursor: pointer;
    padding-top: 10px; padding-bottom: 10px; border-radius: 10px;
    background: var(--pane); border: 1px solid var(--edge);
  }
  .mins button:hover { color: var(--ink); border-color: var(--edge-up); }
  .running { display: grid; gap: 6px; margin-top: 11px; }
  .running .row {
    display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--soft);
    padding-top: 8px; padding-right: 10px; padding-bottom: 8px; padding-left: 10px;
    border-radius: 10px; background: var(--pane); border: 1px solid var(--edge);
  }
  .running .row b { color: var(--ink); font-weight: 500; }
  .running .row button {
    margin-left: auto; font: inherit; font-size: 11.5px; color: var(--faint);
    background: none; border: 0; cursor: pointer; padding: 2px 4px;
  }
  .running .row button:hover { color: var(--clay); }

  /* A setting is a sentence you can switch off, not a control panel. */
  .setting {
    display: flex; align-items: center; gap: 9px; width: 100%;
    font: inherit; font-size: 12.5px; color: var(--soft); text-align: left; cursor: pointer;
    padding-top: 8px; padding-right: 10px; padding-bottom: 8px; padding-left: 10px;
    border-radius: 10px; background: transparent; border: 1px solid transparent;
  }
  .setting:hover { background: var(--pane); border-color: var(--edge); }
  .setting .dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--edge-up); }
  .setting.on .dot { background: var(--warm); box-shadow: 0 0 8px -1px var(--warm); }
  .setting .val { margin-left: auto; font-size: 11.5px; color: var(--faint); }

  /* The thumb bar is phone-only; a wide screen has the index down the left. */
  .quick { display: none; }

  /* ══ desktop ═══════════════════════════════════════════════════════════
     On a wide screen there is room to stop making a document and start making
     a room: the chrome lifts off the page into floating pills, the house gets
     stated in display type rather than a heading, and the rooms become a bento
     where the most lit one is the largest. Everything here is scoped to wide
     screens — the phone layout is deliberately untouched. */
  @media (min-width: 861px) {
    .shell {
      max-width: 1500px;
      padding-top: 104px; padding-bottom: 104px;
      gap: 0;
    }

    /* ── the top pill ─────────────────────────────────────────────────────
       The bar used to be a solid strip across the top while everything below
       it floated, which made it read as furniture rather than as part of the
       same material. It is now a pane like any other, hanging in the middle. */
    .plate {
      position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
      z-index: 40; width: auto; max-width: calc(100vw - 48px);
      padding-top: 10px; padding-right: 14px; padding-bottom: 10px; padding-left: 20px;
      border-radius: 22px; gap: 18px;
      background: var(--pane); background-image: var(--sheen);
      border: 1px solid var(--edge);
      backdrop-filter: blur(26px) saturate(150%);
      -webkit-backdrop-filter: blur(26px) saturate(150%);
      box-shadow: var(--cast);
    }
    .plate .stamp h1 { font-size: 14px; }
    .plate .seek { flex: 0 0 260px; margin-left: 0; }

    /* ── the board ────────────────────────────────────────────────────────
       A hero column that says what the house is doing, and the field beside it. */
    /* No align-items:start here. The page itself does not scroll on a wide
       screen — the tile grid scrolls inside a window sized by the viewport —
       and starting the items collapses .field to its content, so the grid grew
       past the window and the overflow was clipped rather than scrollable.
       A room has fourteen circuits and would simply lose the last of them. */
    .board { display: grid; grid-template-columns: minmax(230px, 300px) 1fr; gap: 34px; min-height: 0; }
    .index { min-height: 0; display: flex; flex-direction: column; }

    /* the house, stated */
    .hero { display: block; margin-bottom: 26px; }
    .hero .greet { margin: 0; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
    .hero .say {
      margin: 10px 0 0; font-weight: 300; letter-spacing: -.03em; line-height: .96;
      font-size: clamp(40px, 4.4vw, 66px); color: var(--ink);
    }
    .hero .say b { font-weight: 400; color: var(--warm); }
    .hero .say span { display: block; color: var(--soft); font-size: .42em; letter-spacing: -.01em;
                      margin-top: 14px; line-height: 1.4; font-weight: 400; }

    /* rooms leave the sidebar for a pill along the bottom, the way a room
       switcher sits under your hand rather than up in a list */
    #secrooms {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      z-index: 40; margin: 0; max-width: calc(100vw - 48px);
      padding-top: 8px; padding-right: 10px; padding-bottom: 8px; padding-left: 10px;
      border-radius: 22px;
      background: var(--pane); background-image: var(--sheen);
      border: 1px solid var(--edge);
      backdrop-filter: blur(26px) saturate(150%);
      -webkit-backdrop-filter: blur(26px) saturate(150%);
      box-shadow: var(--cast);
    }
    #secrooms .legend { display: none; }
    #secrooms #tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
    #secrooms #tabs::-webkit-scrollbar { display: none; }
    #secrooms .tab {
      width: auto; flex: 0 0 auto; margin: 0; white-space: nowrap;
      padding-top: 9px; padding-right: 15px; padding-bottom: 9px; padding-left: 15px;
      border-radius: 15px; background: transparent; border-color: transparent;
    }
    #secrooms .tab .tab-load { display: none; }
    #secrooms .tab.here { background: var(--pane-up); border-color: var(--edge-up); }

    /* ── the bento ────────────────────────────────────────────────────────
       Room cards are not a uniform grid here. There is width to spare, so the
       room with the most light in it takes a double square and the rest fall in
       around it — the board then reads at a glance the way the house does. */
    /* The cue list is as long as you have made it, and the room pill is pinned
       to the bottom of the window — so the column scrolls inside itself rather
       than running underneath. */
    #seccues #cues {
      max-height: calc(100vh - 500px); min-height: 110px;
      overflow-y: auto; scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,.14) transparent;
      padding-right: 4px;
    }
    #sechouse { margin-top: 14px; }

    .field .tiles { grid-template-columns: repeat(4, 1fr); gap: 16px; }
    .tile.hero-room { grid-column: span 2; grid-row: span 2; height: auto; min-height: 340px; }
    .tile.hero-room .tile-name { font-size: 22px; }
    .tile.hero-room .tile-read { font-size: 13.5px; }
  }

  @media (max-width: 860px) {
    html, body { height: auto; overflow: visible; overscroll-behavior: auto; }
    body { display: block; min-height: 100%; padding-top: 0; }
    /* Clear the thumb bar so the last tile is never trapped under it. */
    .shell { display: block; max-width: none; padding: 0 16px 104px; }
    .hero { display: none; }

    /* ── the thumb bar ───────────────────────────────────────────────────
       The three things done most often, sitting where a thumb already is
       rather than at the top of a page you have to reach across. */
    .quick {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 45;
      padding-top: 9px; padding-right: 14px; padding-left: 14px;
      padding-bottom: calc(9px + env(safe-area-inset-bottom));
      background: rgba(12,15,20,.82); border-top: 1px solid var(--edge);
      backdrop-filter: blur(22px) saturate(1.25);
      -webkit-backdrop-filter: blur(22px) saturate(1.25);
    }
    .quick button {
      display: grid; justify-items: center; gap: 4px;
      font: inherit; font-size: 12px; color: var(--soft); cursor: pointer;
      padding-top: 9px; padding-bottom: 9px;
      border-radius: 12px; background: var(--pane); border: 1px solid var(--edge);
    }
    .quick button svg { width: 17px; height: 17px; }
    .quick button:disabled { opacity: .4; }
    /* Holding all-off is the confirmation; the fill shows the hold landing. */
    .quick button.armed { color: var(--clay); border-color: var(--clay); }
    .quick button.on { color: var(--ink); border-color: var(--edge-up); background: var(--pane-up); }

    .timerpop { left: 12px; right: 12px; width: auto; bottom: calc(80px + env(safe-area-inset-bottom)); }

    /* The thumb bar already carries all-off and find, so the top bar drops both
       rather than saying everything twice. */
    .plate .seek-toggle, .plate #main { display: none; }
    .plate .seek { display: none; margin-left: auto; }
    .plate.searching .seek { display: block; }

    /* Settings ride as one short row, like the other rails, instead of a stack
       that pushes the house itself below the fold. */
    .settings-row { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; }
    .settings-row::-webkit-scrollbar { display: none; }
    .settings-row .setting {
      width: auto; flex: 0 0 auto; white-space: nowrap;
      background: var(--pane); border-color: var(--edge);
    }
    .settings-row .setting .val { margin-left: 6px; }
    /* On a phone the index is not a sidebar, it is furniture stacked on top of
       the thing you came for. Letting it display as contents makes its sections
       siblings of the house itself, so the rooms rail stays up top, the house
       follows immediately, and the settings — which are read once a month —
       drop below it instead of pushing it off the screen. */
    .board { display: flex; flex-direction: column; }
    .index { display: contents; }
    #secrooms { order: 1; }
    #seccues  { order: 2; }
    .field    { order: 3; }
    #sechouse { order: 4; margin-top: 4px; }

    /* A cue on a phone is a chip: the name is the whole target. The reading and
       the colour swatch are detail for a screen with room to spare. The name
       must not wrap, or the chip grows taller than the card it replaced. */
    #seccues .cue-note, #seccues .cue-swatch { display: none; }
    #seccues .cue {
      min-width: 0; white-space: nowrap;
      padding-top: 11px; padding-right: 32px; padding-bottom: 11px; padding-left: 13px;
    }
    #seccues .cue-name { font-size: 13px; }
    /* the pencil rides beside the name rather than above it on a one-line chip */
    #seccues .cue-edit { top: 50%; right: 5px; transform: translateY(-50%); }

    /* the bar carries the notch inset itself, so its glass reaches the top edge */
    .plate {
      position: sticky; top: 0; z-index: 20;
      margin: 0 -16px 18px; padding: calc(11px + env(safe-area-inset-top)) 16px 11px;
      gap: 12px; align-items: center;
      background: color-mix(in oklab, var(--base) 86%, transparent);
      backdrop-filter: blur(24px) saturate(140%); -webkit-backdrop-filter: blur(24px) saturate(140%);
      border-bottom: 1px solid var(--edge);
    }
    .stamp { flex: 1 1 auto; min-width: 0; }
    .stamp h1 { font-size: 14px; }
    .tally { margin-top: 1px; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* the count is already the heading below; the hub only matters when stale */
    .tally .count, .tally .host { display: none; }
    .tally .when::before { content: none; }
    .tally.stale .host { display: inline; }
    .tally.stale .host::before { content: none; }
    .tally.stale .when::before { content: ' · '; }

    .seek-toggle { display: grid; margin-left: auto; }
    .seek { display: none; order: 4; flex: 1 1 100%; margin-left: 0; }
    .plate.searching .seek { display: block; }
    .plate.searching { flex-wrap: wrap; }
    .main { margin-left: 0; padding: 9px 13px; }

    /* rooms and cues become sideways rails — stacked, they would eat the screen */
    .index-sec { min-width: 0; margin-bottom: 13px; }
    .legend { margin-bottom: 6px; font-size: 10.5px; }
    .index-sec > div:not(.legend) {
      display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none;
      padding-bottom: 2px; margin: 0 -16px; padding-left: 16px; padding-right: 16px;
    }
    .index-sec > div::-webkit-scrollbar { display: none; }
    /* A phone is not a small desktop: the rails carry more per screen, so the
       house itself starts near the top instead of below a stack of furniture. */
    .tab, .cue { width: auto; flex: 0 0 auto; min-width: 116px; margin-bottom: 0; }
    .tab { padding: 8px 12px; font-size: 13px; }
    .cue { padding: 9px 11px; }
    .cue-name { font-size: 13px; }
    .cue-edit { opacity: 1; }
    .newcue { width: auto; margin-top: 8px; padding: 8px 12px; font-size: 12.5px; }

    /* the field is now just more page, not a scrolling window */
    .field { display: block; }
    .tiles { display: grid; overflow: visible; padding: 0; }
    .field-head { margin-bottom: 10px; }
    .field-head h2 { font-size: 21px; }
    .field-sub { margin-top: 3px; font-size: 12px; }
  }

  @media (max-width: 560px) {
    .tiles { grid-template-columns: repeat(2, 1fr); gap: 9px; }
    /* a fingertip needs more than a mouse: a bigger switch, but not a taller
       tile — height here buys nothing and costs a whole row per screen */
    .tile { --tile-h: 132px; }
    .tile.climate { height: calc(var(--tile-h) + 112px); }
    .key { top: 8px; right: 8px; width: 38px; height: 38px; }
    .key i { width: 15px; height: 15px; }
    .tile-body { padding: 13px; }
    .tile-name { font-size: 13.5px; padding-right: 28px; }
    .tile-read { font-size: 11.5px; }
    .warmth, .drawer, .controls { left: 15px; right: 15px; }
    .slider { height: 26px; }                 /* a thicker grab area */
    .slider::-webkit-slider-thumb { width: 15px; height: 15px; margin-top: -6px; }
    .slider::-moz-range-thumb { width: 15px; height: 15px; }
    .cut { padding: 10px 14px; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition-duration: .01ms !important; }
  }
</style>
</head>
<body>
<div class="photo"></div>
<div class="spill"></div>

<div class="shell">
  <header class="plate">
    <div class="stamp">
      <h1>Pravita's Apartment</h1>
      <p class="tally" id="tally"></p>
    </div>
    <button class="seek-toggle" id="seektoggle" type="button" aria-expanded="false" aria-label="Find a circuit">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
    </button>
    <label class="seek">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input type="search" id="seek" placeholder="Find a circuit" autocomplete="off" aria-label="Find a circuit">
    </label>
    <button class="main" id="main" type="button" disabled aria-describedby="tally">
      <i id="mainfill"></i><span id="mainword">All off</span><em id="maincount"></em>
    </button>
  </header>

  <main class="board">
    <aside class="index">
      <div class="hero" id="hero">
        <p class="greet" id="herogreet"></p>
        <p class="say" id="herosay"></p>
      </div>
      <div class="index-sec" id="secrooms">
        <div class="legend">Rooms</div>
        <div id="tabs"></div>
      </div>
      <div class="index-sec" id="seccues">
        <div class="legend">Cues</div>
        <div id="cues"></div>
        <button class="newcue" id="newcue" type="button">+ Create a cue</button>
      </div>
      <div class="index-sec" id="sechouse">
        <div class="legend">The house itself</div>
        <div class="settings-row">
        <button class="setting" id="setcirc" type="button" aria-pressed="true">
          <span class="dot"></span>
          <span>Colour follows the day</span>
          <span class="val" id="setcircval"></span>
        </button>
        <button class="setting" id="setnudge" type="button" aria-pressed="true">
          <span class="dot"></span>
          <span>Tell me what's been left on</span>
        </button>
        </div>
      </div>
    </aside>

    <section class="field">
      <button class="glance" id="glance" type="button" aria-label="The house at a glance">
        <span class="glance-say" id="glancesay"></span>
        <span class="glance-bars" id="glancebars"></span>
      </button>
      <div class="nudges" id="nudges"></div>
      <div class="field-head">
        <div>
          <button class="back" id="back" type="button" hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7"/>
            </svg>
            <span>The house</span>
          </button>
          <h2 id="fieldname"></h2>
          <p class="field-sub" id="fieldsub"></p>
        </div>
        <button class="cut" id="cut" type="button" hidden>Turn room off</button>
      </div>
      <div class="tiles" id="stack"></div>
    </section>
  </main>
</div>

<nav class="quick" id="quick" aria-label="Quick actions">
  <button type="button" id="qoff" aria-label="Hold to switch everything off">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>
    </svg>
    <span id="qoffword">All off</span>
  </button>
  <button type="button" id="qtimer" aria-label="Sleep timer" aria-expanded="false">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M9 2h6"/>
    </svg>
    <span id="qtimerword">Timer</span>
  </button>
  <button type="button" id="qfind" aria-label="Find a circuit">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>
    </svg>
    <span>Find</span>
  </button>
</nav>

<div class="timerpop" id="timerpop" role="dialog" aria-label="Sleep timer" hidden>
  <h3>Sleep timer</h3>
  <p id="timerwhy">Lights off by themselves, later. The fan and AC keep running.</p>
  <div class="scopes" id="timerscopes"></div>
  <div class="mins" id="timermins">
    <button type="button" data-min="15">15 min</button>
    <button type="button" data-min="30">30 min</button>
    <button type="button" data-min="45">45 min</button>
    <button type="button" data-min="60">1 hour</button>
    <button type="button" data-min="90">1½ hours</button>
    <button type="button" data-min="120">2 hours</button>
  </div>
  <div class="running" id="timerrunning"></div>
</div>

<div class="scrim" id="scrim" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetname">
    <div class="sheet-head" id="sheethead">
      <div class="sheet-eyebrow" id="sheeteyebrow">Cue</div>
      <input class="sheet-name" id="sheetname" type="text" maxlength="40" aria-label="Cue name">
      <p class="sheet-facts" id="sheetfacts"></p>
      <p class="sheet-api" id="sheetapi" title="Use this in Shortcuts and cron"></p>
    </div>
    <div class="sheet-body" id="sheetbody"></div>
    <div class="sheet-foot" id="sheetfoot">
      <button class="sheet-btn go" id="sheetapply" type="button">Set this cue</button>
      <button class="sheet-btn" id="sheetrecapture" type="button">Update to the house now</button>
      <button class="sheet-btn" id="sheetclose" type="button">Close</button>
      <button class="sheet-btn danger" id="sheetdelete" type="button">Delete</button>
    </div>
  </div>
</div>

<div class="note" id="note" role="status" aria-live="polite"></div>

<script>
const HUB = '${HUB_IP}';

/* What a circuit is decides its colour and its vocabulary. A fan is on this
   board because it is a circuit, but it does not glow, so it is not drawn
   as light. */
const KINDS = {
  light:   { label: 'Lights',   tint: 'var(--warm)',    on: 'on',      off: 'off' },
  fan:     { label: 'Fans',     tint: 'var(--neutral)', on: 'on',      off: 'off' },
  curtain: { label: 'Curtains', tint: 'var(--neutral)', on: 'open',    off: 'closed' },
  climate: { label: 'Climate',  tint: 'var(--cool)',    on: 'cooling', off: 'off' },
  screen:  { label: 'Screens',  tint: 'var(--neutral)', on: 'on',      off: 'off' },
};
const KIND_ORDER = ['light', 'fan', 'curtain', 'climate', 'screen'];

const kindOf = (d) =>
  d.app_type === 'C' ? 'curtain' :
  d.app_type === 'AC' ? 'climate' :
  (d.app_type === 'TV' || d.app_type === 'PRJ') ? 'screen' :
  d.is_fan ? 'fan' : 'light';

const state = { devices: [], view: 'house', room: null, q: '', sync: null };
const el = (s) => document.querySelector(s);
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const rooms = () => [...new Set(state.devices.map(d => d.room))];
const rooms_ = rooms;
// A curtain reports nothing back, so it is never counted as lit.
const lit = (list) => list.filter(d => d.status && !d.is_curtain);
const inRoom = (room) => state.devices.filter(d => d.room === room);
const title = (s) => s.toLowerCase().replace(/(^|\\s)\\S/g, (c) => c.toUpperCase());

// The hub stores every label in capitals. Shouting them back is not calm, so
// they are set in sentence case — except the handful that really are acronyms.
const ACRONYMS = new Set(['COB', 'AC', 'TV', 'T.V', 'PRJ', 'LED', 'RGB', 'USB', 'CCT']);

// Labels the installer mistyped in the hub's own database. Corrected here for
// reading only — the hub keeps its spelling, so the vendor's app and ours still
// address the very same record. Search matches the correction too, or a circuit
// would be unfindable by the name the screen shows it under.
const MISSPELT = { 'CEILING ROPR': 'CEILING ROPE' };

const pretty = (s) => {
  const raw = String(s).trim();
  return (MISSPELT[raw.toUpperCase()] || raw).split(/\\s+/)
    .map(w => ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase()
            : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
};

// How much light a set of circuits is making, 0 → 1. A lamp at 20% counts as a
// fifth of a lamp, which is what the room actually looks like.
const output = (list) =>
  list.length ? list.reduce((s, d) => s + (d.status ? (d.is_dimmable ? d.level : 100) : 0), 0) / (list.length * 100) : 0;

/* 0 is cool and 100 is warm on this installation, so a lamp's colour is a
   mix between moonlight and sodium — and the bar burns that exact colour. */
const tintOf = (d) => {
  const kind = kindOf(d);
  if (kind !== 'light') return KINDS[kind].tint;
  if (!d.is_tunable) return 'var(--warm)';
  return 'color-mix(in oklab, var(--warm) ' + Math.round(d.tune) + '%, var(--cool))';
};
const warmthWord = (t) =>
  t == null ? '' : t < 20 ? 'cool' : t < 42 ? 'soft white' : t < 64 ? 'neutral' : t < 84 ? 'warm' : 'candle';

/* ───────────────────────────────────────────────────────── loading state */

async function load() {
  const snap = await fetch('/api/devices').then(r => r.json());
  state.devices = snap.devices.sort((a, b) =>
    KIND_ORDER.indexOf(kindOf(a)) - KIND_ORDER.indexOf(kindOf(b)) || natural(a.name, b.name));
  state.sync = snap;
  drawIndex();
  drawField();
  readout();
  loadCues();
}

// A circuit the user is touching owns its own state until the hub answers.
const inFlight = new Set();

/* A short tick when the hub actually confirms, so a lamp landing feels
   different from the tap that asked for it. Android honours this; iOS Safari
   has no vibration API at all, so on an iPhone it is simply a no-op — worth
   having anyway, and it costs nothing where it is unsupported. */
function tick_haptic(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* not permitted */ }
}

/**
 * When we last told the hub to change each circuit.
 *
 * The background reader snapshots the hub at the moment it connects, and that
 * takes a second or two to arrive. So a read that STARTED before your command
 * can land in the cache AFTER it, and the next poll would paint the state from
 * before you pressed anything — the card flicking back, then correcting itself
 * on the following read. A snapshot older than the command is simply ignored.
 */
const commandedAt = new Map();
const markCommanded = (id) => commandedAt.set(id, Date.now());

// Takes a snapshot from anywhere — a poll, or a frame pushed down the stream —
// and moves the screen to match it.
function applySnapshot(snap) {
  state.sync = snap;
  const fresh = new Map(snap.devices.map(d => [d.record_id, d]));
  let moved = false;
  for (const d of state.devices) {
    const now = fresh.get(d.record_id);
    if (!now || inFlight.has(d.record_id)) continue;
    // This snapshot was taken before we last commanded this circuit, so it
    // cannot know about that command. Wait for a read that does.
    if ((commandedAt.get(d.record_id) || 0) > (snap.synced_at || 0)) continue;
    if (now.status === d.status && now.level === d.level && now.tune === d.tune) continue;
    d.status = now.status;            // someone used a wall switch or the phone app
    d.level = now.level;
    d.tune = now.tune;
    paint(d);
    moved = true;
  }
  if (moved) tick();
  readout();
}

async function sync(force) {
  try {
    applySnapshot(await fetch('/api/devices' + (force ? '?refresh=1' : '')).then(r => r.json()));
  } catch { readout(); /* momentary; the next poll picks it up */ }
}

/* ─────────────────────────────────────────────── everything that changes */

// Called whenever state moved but the shape of the screen did not.
function tick() {
  readout();
  for (const tab of document.querySelectorAll('.tab[data-room]')) tabState(tab, tab.dataset.room);
  for (const t of document.querySelectorAll('.tile[data-room]')) roomTileState(t, t.dataset.room);
  const cut = el('#cut');
  if (cut && state.view === 'room') cut.disabled = !lit(inRoom(state.room)).length;
  const sub = el('#fieldsub');
  if (sub) sub.innerHTML = fieldSub();
}

/* The house, said out loud: the time of day, then what is actually lit. This is
   the one place the dashboard speaks rather than reports. */
function drawHero() {
  const greet = el('#herogreet');
  if (!greet) return;
  const h = new Date().getHours();
  greet.textContent = h < 5 ? 'Late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon'
    : h < 21 ? 'Good evening' : 'Good night';

  const on = lit(state.devices);
  const rooms = [...new Set(on.map(d => d.room))];
  const say = el('#herosay');
  if (!on.length) {
    say.innerHTML = 'The house is<br>dark.<span></span>';
    say.querySelector('span').textContent = state.devices.length + ' circuits, all off.';
    return;
  }
  say.innerHTML = '<b></b> lit<span></span>';
  say.querySelector('b').textContent = on.length;
  say.querySelector('span').textContent = rooms.length === 1
    ? 'in ' + title(rooms[0]) + '.'
    : 'across ' + rooms.length + ' rooms — ' + rooms.slice(0, 3).map(title).join(', ')
      + (rooms.length > 3 ? ' and more.' : '.');
}

/* The house in one card: what is lit, said plainly, over a row where each room
   is a column of its own light. Read at a glance, tapped to go there. */
function drawGlance() {
  const say = el('#glancesay');
  if (!say) return;
  const on = lit(state.devices);
  const rooms = [...new Set(on.map(d => d.room))];
  say.innerHTML = on.length
    ? '<i></i> lit <b></b>'
    : 'The house is <b>dark</b>';
  if (on.length) {
    say.querySelector('i').textContent = on.length;
    say.querySelector('b').textContent = rooms.length === 1
      ? 'in ' + title(rooms[0]) : 'across ' + rooms.length + ' rooms';
  }

  const bars = el('#glancebars');
  bars.innerHTML = '';
  for (const room of rooms_()) {
    const items = inRoom(room);
    const load = output(items);
    const alight = lit(items);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'glance-bar' + (alight.length ? '' : ' dark')
      + (state.view === 'room' && state.room === room ? ' here' : '');
    b.style.setProperty('--load', load.toFixed(3));
    b.style.setProperty('--tint', alight.length ? roomTint(alight) : 'var(--warm)');
    b.innerHTML = '<i></i><u></u>';
    // the first word is enough at this size, and the whole name is read aloud
    b.querySelector('u').textContent = title(room).split(' ')[0];
    b.setAttribute('aria-label', title(room) + ', '
      + (alight.length ? alight.length + ' of ' + items.length + ' on' : 'all off'));
    b.onclick = (e) => { e.stopPropagation(); go('room', room); };
    bars.appendChild(b);
  }
}

function readout() {
  const on = lit(state.devices);

  // The page carries the light the house is making, and its colour.
  const tuned = on.filter(d => d.is_tunable && kindOf(d) === 'light');
  const warmth = tuned.length ? tuned.reduce((s, d) => s + d.tune, 0) / tuned.length : 78;
  const root = document.documentElement.style;
  root.setProperty('--glow', Math.min(1, Math.sqrt(on.length / 9)).toFixed(3));
  root.setProperty('--lamp', 'color-mix(in oklab, var(--warm) ' + Math.round(warmth) + '%, var(--cool))');

  drawHero();
  drawGlance();

  const s = state.sync || {};
  let when = 'status unread';
  if (s.hub_ok && s.synced_at) {
    const secs = Math.max(0, Math.round((Date.now() - s.synced_at) / 1000));
    when = secs < 60 ? 'read ' + secs + 's ago' : 'read ' + Math.round(secs / 60) + 'm ago';
  } else if (s.hub_error) {
    when = 'hub unreachable — ' + s.hub_error;
  }
  const t = el('#tally');
  // Split into parts so a narrow screen can drop what it already says elsewhere:
  // the count is repeated in the heading below, and the hub address only matters
  // when something is wrong with it.
  t.innerHTML =
    '<span class="count"><b>' + on.length + '</b> of ' + state.devices.length + ' circuits live</span>' +
    '<span class="host">hub ' + HUB + '</span>' +
    '<span class="when">' + when + '</span>';
  t.classList.toggle('stale', !!s.hub_error);

  const m = el('#main');
  m.disabled = !on.length;
  el('#mainword').textContent = on.length ? 'All off' : 'All dark';
  el('#maincount').textContent = on.length ? String(on.length) : '';
  m.setAttribute('aria-label', on.length
    ? 'Hold to switch off all ' + on.length + ' live circuits'
    : 'Nothing is on');

  // The thumb bar carries the same truth as the main button.
  const q = el('#qoff');
  if (q) {
    q.disabled = !on.length;
    el('#qoffword').textContent = on.length ? 'All off · ' + on.length : 'All dark';
  }
}

/* ───────────────────────────────────────────────────────────── the index */

function drawIndex() {
  const host = el('#tabs');
  host.innerHTML = '';
  host.appendChild(tab('house', 'The house'));
  rooms().forEach(room => host.appendChild(tab('room', title(room), room)));
}

function tab(view, name, room) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tab';
  if (room) b.dataset.room = room;
  b.innerHTML = '<span class="tab-row"><span class="tab-name"></span><span class="tab-n"></span></span>' +
                '<span class="tab-load"><i></i></span>';
  b.querySelector('.tab-name').textContent = name;
  b.onclick = () => go(view, room);
  if (room) tabState(b, room);
  else houseTabState(b);
  return b;
}

function tabState(b, room) {
  const items = inRoom(room);
  const on = lit(items);
  b.classList.toggle('awake', on.length > 0);
  b.classList.toggle('here', state.view === 'room' && state.room === room);
  b.querySelector('.tab-n').textContent = on.length ? String(on.length) : '';
  const fill = b.querySelector('.tab-load i');
  fill.style.width = (output(items) * 100).toFixed(1) + '%';
  fill.style.setProperty('--tint', on.length ? roomTint(on) : 'rgba(255,213,160,.09)');
  b.setAttribute('aria-label', title(room) + ', ' +
    (on.length ? on.length + ' of ' + items.length + ' on' : 'all off'));
}

function houseTabState(b) {
  const on = lit(state.devices);
  b.classList.toggle('awake', on.length > 0);
  b.classList.toggle('here', state.view === 'house');
  b.querySelector('.tab-n').textContent = on.length ? String(on.length) : '';
  const fill = b.querySelector('.tab-load i');
  fill.style.width = (output(state.devices) * 100).toFixed(1) + '%';
  fill.style.setProperty('--tint', on.length ? roomTint(on) : 'rgba(255,213,160,.09)');
}

// The colour a room is burning: the average temperature of its lit lamps.
function roomTint(on) {
  const tuned = on.filter(d => d.is_tunable && kindOf(d) === 'light');
  if (!tuned.length) return on.some(d => kindOf(d) === 'light') ? 'var(--warm)' : 'var(--neutral)';
  const t = tuned.reduce((s, d) => s + d.tune, 0) / tuned.length;
  return 'color-mix(in oklab, var(--warm) ' + Math.round(t) + '%, var(--cool))';
}

function go(view, room) {
  state.view = view;
  state.room = room || null;
  if (state.q) { state.q = ''; el('#seek').value = ''; }
  drawField();
  for (const t of document.querySelectorAll('#tabs .tab')) {
    if (t.dataset.room) tabState(t, t.dataset.room); else houseTabState(t);
  }
}

/* ───────────────────────────────────────────────────────────── the field */

function fieldSub() {
  if (state.q) {
    const n = matches().length;
    return n + (n === 1 ? ' circuit matches' : ' circuits match');
  }
  const items = state.view === 'room' ? inRoom(state.room) : state.devices;
  const on = lit(items).length;
  return on ? '<b>' + on + '</b> of ' + items.length + ' on' : 'all ' + items.length + ' off';
}

const matches = () => {
  const q = state.q.trim().toLowerCase();
  // Match the label as shown as well as the hub's own, so a circuit is findable
  // by the spelling on screen and by the one the installer typed.
  return state.devices.filter(d => d.name.toLowerCase().includes(q)
    || pretty(d.name).toLowerCase().includes(q)
    || d.room.toLowerCase().includes(q));
};

function drawField() {
  const stack = el('#stack');
  stack.innerHTML = '';
  stack.scrollTop = 0;

  el('#fieldname').textContent =
    state.q ? 'Search' : state.view === 'room' ? title(state.room) : 'The house';
  el('#fieldsub').innerHTML = fieldSub();

  const back = el('#back');
  back.hidden = state.view === 'house' && !state.q;
  back.querySelector('span').textContent = state.q ? 'Back to the house' : 'The house';

  const cut = el('#cut');
  cut.hidden = state.view !== 'room' || !!state.q;
  if (!cut.hidden) {
    cut.disabled = !lit(inRoom(state.room)).length;
    cut.onclick = () => {
      const on = lit(inRoom(state.room));
      on.forEach(d => setDevice(d, false));
      note('Switching off ' + on.length + ' in ' + title(state.room) + '.');
    };
  }

  if (state.q) return fillSearch(stack);
  if (state.view === 'room') return fillRoom(stack, state.room);
  return fillHouse(stack);
}

// The house is a board of rooms.
function fillHouse(stack) {
  // Whichever room is carrying the most light takes the big square. If the
  // house is dark nothing is promoted — a hero card for an empty room would be
  // a lie about where to look.
  const all = rooms();
  let hero = null, best = 0;
  for (const room of all) {
    const load = output(inRoom(room)) * lit(inRoom(room)).length;
    if (load > best) { best = load; hero = room; }
  }
  // the big one leads, so the eye starts where the light is
  const order = hero ? [hero, ...all.filter(r => r !== hero)] : all;
  order.forEach(room => {
    const tile = roomTile(room);
    if (room === hero) tile.classList.add('hero-room');
    stack.appendChild(tile);
  });
}

// A room is a board of circuits, grouped by what they are.
function fillRoom(stack, room) {
  const items = inRoom(room);
  for (const kind of KIND_ORDER) {
    const group = items.filter(d => kindOf(d) === kind);
    if (!group.length) continue;
    const label = document.createElement('div');
    label.className = 'group-label';
    label.textContent = KINDS[kind].label;
    stack.appendChild(label);
    group.forEach(d => stack.appendChild(circuitTile(d)));
  }
}

function fillSearch(stack) {
  const found = matches();
  if (!found.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No circuit by that name. Try a room, or part of a label.';
    stack.appendChild(p);
    return;
  }
  let where = null;
  for (const d of found) {
    if (d.room !== where) {
      where = d.room;
      const label = document.createElement('div');
      label.className = 'group-label';
      label.textContent = title(where);
      stack.appendChild(label);
    }
    stack.appendChild(circuitTile(d));
  }
}

/* ───────────────────────────────────────── a room, drawn as one circuit */

/* ────────────────────────────────── a room, drawn as one of its own tiles */

function roomTile(room) {
  const tile = document.createElement('div');
  tile.className = 'tile enter';
  tile.dataset.room = room;
  tile.innerHTML =
    '<span class="tile-fill"></span>' +
    '<button class="tile-body" type="button">' +
      '<span class="tile-name"></span>' +
      '<span class="tile-read"></span>' +
    '</button>' +
    '<button class="key" type="button"><i></i></button>';
  tile.querySelector('.tile-name').textContent = title(room);
  tile.querySelector('.tile-body').onclick = () => go('room', room);
  tile.querySelector('.key').onclick = () => {
    const on = lit(inRoom(room));
    on.forEach(d => setDevice(d, false));
    note('Switching off ' + on.length + ' in ' + title(room) + '.');
  };
  roomTileState(tile, room);
  return tile;
}

function roomTileState(tile, room) {
  const items = inRoom(room);
  const on = lit(items);
  tile.style.setProperty('--tint', on.length ? roomTint(on) : 'var(--warm)');
  tile.classList.toggle('on', on.length > 0);
  const load = output(items);
  // A room with one lamp on glows faintly; a room lit throughout glows properly.
  tile.style.setProperty('--lit', Math.min(1, Math.sqrt(load * 1.7)).toFixed(3));
  tile.querySelector('.tile-fill').style.setProperty('--fill', load.toFixed(3));
  tile.querySelector('.tile-read').textContent =
    on.length ? on.length + ' of ' + items.length + ' on' : 'all ' + items.length + ' off';
  const key = tile.querySelector('.key');
  key.disabled = !on.length;
  key.setAttribute('aria-label', 'Turn off everything in ' + title(room));
  tile.querySelector('.tile-body').setAttribute('aria-label',
    'Open ' + title(room) + ', ' + (on.length ? on.length + ' of ' + items.length + ' on' : 'all off'));
}

/* ──────────────────────────────────────────────────── a circuit's tile */

function circuitTile(d) {
  const kind = kindOf(d);
  const tile = document.createElement('div');
  // Width follows what the circuit can actually do: two sliders need room, a
  // plain switch does not.
  const roomy = d.is_tunable || d.is_ac || d.is_curtain;
  tile.className = 'tile enter ' + kind + (d.is_dimmable ? ' dims' : '') + (d.is_tunable ? ' tunes' : '')
    + (roomy ? ' wide' : '') + (d.is_dimmable && !d.is_tunable ? ' tall' : '');
  tile.dataset.id = d.record_id;
  // The wiring address is for whoever is chasing a circuit, not for whoever is
  // turning on a lamp, so it lives in the tooltip.
  tile.title = pretty(d.name) + ' · circuit ' +
    (d.channel_id && d.channel_id !== 'None' ? d.device_id + '.' + d.channel_id : (d.device_type || d.app_type));

  const fill = document.createElement('span');
  fill.className = 'tile-fill';
  tile.appendChild(fill);

  // The sliders sit at the foot of the tile now, so pressing the tile itself
  // simply switches the circuit — the same as everywhere else.
  const body = document.createElement(d.is_curtain ? 'div' : 'button');
  if (body.tagName === 'BUTTON') { body.type = 'button'; body.onclick = () => setDevice(d, !d.status); }
  body.className = 'tile-body';
  body.innerHTML = '<span class="tile-name"></span><span class="tile-read"></span>';
  body.querySelector('.tile-name').textContent = pretty(d.name);
  tile.appendChild(body);

  // A curtain is two momentary relays with nothing to report, so it has no key.
  if (!d.is_curtain) {
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'key';
    key.innerHTML = '<i></i>';
    key.onclick = () => setDevice(d, !d.status);
    tile.appendChild(key);
  }

  if (d.is_dimmable || d.is_tunable) {
    const controls = document.createElement('div');
    controls.className = 'controls';
    if (d.is_dimmable) controls.appendChild(slider(d, 'level'));
    if (d.is_tunable) controls.appendChild(slider(d, 'tune'));
    tile.appendChild(controls);
  }

  if (d.is_curtain) tile.appendChild(curtainPulls(d));
  if (d.is_ac) tile.appendChild(climateDrawer(d));

  paintTile(tile, d);
  return tile;
}

function slider(d, key) {
  const input = document.createElement('input');
  input.type = 'range';
  input.className = key === 'level' ? 'slider dim' : 'slider warm';
  if (key === 'level') input.style.setProperty('--pct', d.level + '%');
  input.min = 0; input.max = 100; input.step = 1;
  input.value = d[key];
  input.dataset.key = key;
  input.setAttribute('aria-label', pretty(d.name) +
    (key === 'level' ? ' brightness' : ' warmth, 0 cool to 100 warm'));

  input.addEventListener('input', () => {
    const v = Number(input.value);
    d[key] = v;
    if (key === 'level') { d.status = v > 0; input.style.setProperty('--pct', v + '%'); }
    paintTile(input.closest('.tile'), d);
    if (key === 'level') tick();
    queueSlider(d, key);
  });
  // A keyboard press or a released drag is the final word.
  input.addEventListener('change', () => queueSlider(d, key, true));
  return input;
}

/* ────────────────────────────────────────────────── drawing one circuit */

function paintTile(tile, d) {
  if (!tile) return;
  tile.style.setProperty('--tint', tintOf(d));
  tile.classList.toggle('on', d.status);
  const level = d.status ? (d.is_dimmable ? Math.max(d.level, 8) : 100) : 0;
  // How much light this circuit is making drives the glow, not just the fill.
  tile.style.setProperty('--lit', (level / 100).toFixed(3));
  tile.querySelector('.tile-fill').style.setProperty('--fill', (level / 100).toFixed(3));
  tile.querySelector('.tile-read').textContent = readWord(d);

  for (const input of tile.querySelectorAll('.slider')) {
    if (input === document.activeElement) continue;   // never fight the hand on the slider
    input.value = d[input.dataset.key];
    if (input.dataset.key === 'level') input.style.setProperty('--pct', d.level + '%');
  }

  const key = tile.querySelector('.key');
  if (key) {
    key.setAttribute('aria-pressed', String(d.status));
    key.setAttribute('aria-label', (d.status ? 'Turn off ' : 'Turn on ') + pretty(d.name));
  }
  const body = tile.querySelector('button.tile-body');
  if (body) {
    body.setAttribute('aria-pressed', String(d.status));
    body.setAttribute('aria-label', pretty(d.name) + ', ' + title(d.room) + ', ' + readWord(d));
  }
}

function readWord(d) {
  const spec = KINDS[kindOf(d)];
  if (d.is_curtain) return 'no reading';
  if (!d.status) return spec.off;
  // The warmth strip has no label of its own now, so the reading carries it.
  const level = d.is_dimmable ? d.level + '%' : spec.on;
  return d.is_tunable ? level + ' · ' + warmthWord(d.tune) : level;
}

const paint = (d) => {
  const tile = document.querySelector('.tile[data-id="' + d.record_id + '"]');
  paintTile(tile, d);
  return tile;
};

/* ──────────────────────────────────────────────────────────── switching */

async function setDevice(d, next) {
  const was = d.status;
  const wasLevel = d.level;
  d.status = next;                                 // optimistic: the key throws now
  if (d.is_dimmable) d.level = next ? 100 : 0;     // "true" means full, per the hub
  const bar = paint(d);
  if (bar) {
    bar.classList.add('busy');
    bar.classList.remove('refused');
    setTimeout(() => bar.classList.remove('busy'), 800);  // confirmation continues quietly
  }
  tick();
  inFlight.add(d.record_id);
  markCommanded(d.record_id);

  try {
    // An IR air conditioner needs the command string, not a bare record.
    const res = d.is_ac
      ? await fetch('/api/ac', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ record_id: d.record_id, power: next }) })
      : await fetch('/api/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ record_id: d.record_id, status: next }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || 'Hub did not respond');

    // The hub never acknowledges, so the server re-reads its state to check.
    if (body.confirmed === false) {
      d.status = body.actual;
      if (d.is_dimmable) d.level = body.level != null ? body.level : (body.actual ? 100 : 0);
      refuse(d);
      tick_haptic([12, 60, 12]);      // a stumble, not a tick — it did not take
      note(pretty(d.name) + ' — the hub did not apply that. It is still ' + readWord(d) + '.');
    } else {
      tick_haptic(9);                 // the hub confirmed: the lamp really moved
      d.status = next;
      // The hub decides what level "on" means for this lamp; take its word.
      if (d.is_dimmable && next && body.level != null && body.level > 0) d.level = body.level;
      paint(d);
      tick();
    }
    if (body.synced_at) {
      state.sync = Object.assign({}, state.sync, { synced_at: body.synced_at, hub_ok: true, hub_error: null });
      readout();
    }
  } catch (err) {
    d.status = was;
    d.level = wasLevel;                            // put it back
    refuse(d);
    note(pretty(d.name) + ' — ' + err.message + '. Nothing changed.');
  } finally {
    inFlight.delete(d.record_id);
  }
}

function refuse(d) {
  const bar = paint(d);
  if (bar) {
    bar.classList.remove('busy');
    bar.classList.add('refused');
    setTimeout(() => bar.classList.remove('refused'), 2400);
  }
  tick();
}

// Sliders fire continuously; send at most one command per circuit every 200ms,
// and always send the value the hand finished on.
const sliderTimers = new Map();

function queueSlider(d, key, now) {
  const id = d.record_id + ":" + key;
  inFlight.add(d.record_id);
  markCommanded(d.record_id);
  clearTimeout(sliderTimers.get(id));
  sliderTimers.set(id, setTimeout(() => sendSlider(d, key), now ? 0 : 200));
}

async function sendSlider(d, key) {
  try {
    const res = await fetch(key === 'level' ? '/api/level' : '/api/tune', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_id: d.record_id, [key]: d[key] }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || 'Hub did not respond');
  } catch (err) {
    note(pretty(d.name) + ' — ' + err.message + '. The setting may not have changed.');
  } finally {
    // Hold the poll off a moment longer so a slow hub read cannot yank a slider.
    setTimeout(() => inFlight.delete(d.record_id), 4000);
  }
}

/* ──────────────────────────────────── circuits that are not switches */

function curtainPulls(d) {
  const wrap = document.createElement('div');
  wrap.className = 'drawer';
  const pulls = document.createElement('div');
  pulls.className = 'pulls';
  // Stop is not a nicety on a curtain: it is a two-relay motor with no position
  // to report, so halting it partway is the only way to leave it anywhere other
  // than fully open or fully shut.
  const WORDS = { open: 'Open', stop: 'Stop', close: 'Close' };
  for (const action of ['open', 'stop', 'close']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pull' + (action === 'stop' ? ' halt' : '');
    b.textContent = WORDS[action];
    b.setAttribute('aria-label', WORDS[action] + ' ' + pretty(d.name));
    b.onclick = async () => {
      b.classList.add('working');
      try {
        const res = await fetch('/api/curtain', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ record_id: d.record_id, action }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) throw new Error(body.error || 'Hub did not respond');
      } catch (err) {
        note(pretty(d.name) + ' — ' + err.message + '.');
      } finally {
        setTimeout(() => b.classList.remove('working'), 900);
      }
    };
    pulls.appendChild(b);
  }
  wrap.appendChild(pulls);
  return wrap;
}

/* What an air conditioner starts at when nothing else is known. The hub stores a
   temperature but no mode or fan speed, so those are remembered per unit here. */
const AC_DEFAULTS = { temp: 24, mode: 'cool', fan: 'medium' };

/**
 * An IR command is a beep in someone's bedroom, so the unit hears the value you
 * finished on, not every value you passed through: stepping 18 → 24 sends one
 * "temp 24" after you stop, rather than six commands and six beeps.
 */
const AC_DELAY = 1300;
const acTimers = new Map();

function queueAc(d, key, read, marks) {
  const id = d.record_id + ':' + key;
  clearTimeout(acTimers.get(id));
  marks.forEach(m => m.classList.add('pending'));
  acTimers.set(id, setTimeout(async () => {
    acTimers.delete(id);
    await sendAc(d, { [key]: read() });
    marks.forEach(m => m.classList.remove('pending'));
  }, AC_DELAY));
}

function climateDrawer(d) {
  const wrap = document.createElement('div');
  wrap.className = 'drawer';

  if (d.ac_mode == null) d.ac_mode = AC_DEFAULTS.mode;
  if (d.ac_fan == null) d.ac_fan = AC_DEFAULTS.fan;

  const degrees = document.createElement('div');
  degrees.className = 'degrees';
  const down = stepButton('−', 'Lower the temperature');
  const value = document.createElement('b');
  const up = stepButton('+', 'Raise the temperature');
  let temp = d.ac_temp || AC_DEFAULTS.temp;
  const show = () => {
    value.textContent = temp + '°C';
    down.disabled = temp <= 19;
    up.disabled = temp >= 26;
  };
  const nudge = (by) => {
    temp = Math.max(19, Math.min(26, temp + by));
    d.ac_temp = temp;
    show();
    queueAc(d, 'temp', () => temp, [value]);
  };
  down.onclick = () => nudge(-1);
  up.onclick = () => nudge(1);
  show();
  degrees.append(down, value, up);

  wrap.appendChild(degrees);
  // The rows are captioned: nothing else says the second one is fan speed, and
  // "Fan auto" does not fit inside a button this narrow.
  wrap.appendChild(segRow(d, 'mode', ['cool', 'heat', 'dry', 'auto'], ['Cool', 'Heat', 'Dry', 'Auto'], 'Mode'));
  wrap.appendChild(segRow(d, 'fan', ['auto', 'low', 'medium', 'high'], ['Auto', 'Low', 'Med', 'High'], 'Fan'));
  return wrap;
}

function stepButton(glyph, what) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'step';
  b.textContent = glyph;
  b.setAttribute('aria-label', what);
  return b;
}

function segRow(d, key, values, labels, caption) {
  const group = document.createElement('div');
  const cap = document.createElement('div');
  cap.className = 'seg-label';
  cap.textContent = caption;
  group.appendChild(cap);

  const prop = key === 'mode' ? 'ac_mode' : 'ac_fan';
  const row = document.createElement('div');
  row.className = 'segs';
  values.forEach((v, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg' + (d[prop] === v ? ' sent' : '');   // the default shows as chosen
    b.textContent = labels[i];
    b.setAttribute('aria-label', pretty(d.name) + ' ' + key + ' ' + v);
    b.setAttribute('aria-pressed', String(d[prop] === v));
    b.onclick = () => {
      d[prop] = v;
      for (const other of row.children) {
        other.classList.remove('sent');
        other.setAttribute('aria-pressed', 'false');
      }
      b.classList.add('sent');
      b.setAttribute('aria-pressed', 'true');
      queueAc(d, key, () => d[prop], [b]);
    };
    row.appendChild(b);
  });
  group.appendChild(row);
  return group;
}

async function sendAc(d, body) {
  markCommanded(d.record_id);
  try {
    const res = await fetch('/api/ac', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_id: d.record_id, ...body }),
    });
    const out = await res.json().catch(() => ({}));
    if (!out.ok) throw new Error(out.error || 'Hub did not respond');
  } catch (err) {
    note(pretty(d.name) + ' — ' + err.message + '.');
  }
}

/* ───────────────────────────── cues: the whole house in one press */

let cues = [];
let firing = null;

async function loadCues() {
  try { cues = (await fetch('/api/scenes').then(r => r.json())).scenes || []; }
  catch { cues = []; }
  drawCues();
}

function drawCues() {
  const host = el('#cues');
  if (!host) return;
  host.innerHTML = '';
  if (!cues.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.style.padding = '4px 2px';
    p.textContent = 'No cues yet. Set a room the way you like it, then save it as one.';
    host.appendChild(p);
    return;
  }
  for (const cue of cues) {
    const wrap = document.createElement('div');
    wrap.className = 'cue-wrap';

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cue' + (firing === cue.id ? ' firing' : '');
    b.innerHTML = '<span class="cue-name"></span><span class="cue-note"></span>' +
                  '<span class="cue-swatch"><i></i></span>';
    b.querySelector('.cue-name').textContent = cue.name;
    b.querySelector('.cue-note').textContent = cueNote(cue);
    const look = cuePreview(cue);
    const fill = b.querySelector('.cue-swatch i');
    fill.style.width = look.brightness + '%';
    fill.style.background = look.colour;
    b.setAttribute('aria-label', 'Set ' + cue.name + ' — ' + cueNote(cue));
    b.onclick = () => fire(cue);
    wrap.appendChild(b);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'cue-edit';
    edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"/></svg>';
    edit.setAttribute('aria-label', 'Edit ' + cue.name);
    edit.onclick = () => openSheet(cue);
    wrap.appendChild(edit);

    host.appendChild(wrap);
  }
}

/**
 * What a cue does, in one line: how many circuits it lights, how many it puts
 * out, and where. The count alone never told you whether it was a bedtime cue
 * or a dinner one.
 */
function cueNote(cue) {
  const steps = cue.steps || [];
  const on = steps.filter(st => st.on !== false).length;
  const off = steps.length - on;
  const where = [...new Set(steps.map(st => {
    const d = state.devices.find(x => x.record_id === st.record_id);
    return d ? title(d.room) : null;
  }).filter(Boolean))];
  const place = where.length === 1 ? where[0] : where.length + ' rooms';
  const what = on ? on + ' on' + (off ? ', ' + off + ' off' : '') : 'all ' + off + ' off';
  return what + ' · ' + place;
}

/* ───────────────────────── the sheet: a cue opened up and edited */

let sheetCue = null;
let sheetView = 'steps';    // steps | rooms | circuits
let pickRoom = null;
let openStep = null;        // the one circuit whose controls are showing

const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
const CHEV_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

const deviceOf = (id) => state.devices.find(d => d.record_id === id);
const stepFor = (id) => (sheetCue?.steps || []).find(st => st.record_id === id);

/**
 * A new cue starts as a draft held here, not on the server: you pick the
 * circuits and set each one before it exists at all. Saving whatever happened
 * to be lit — the old "save this as a cue" — swept in every circuit of every
 * lit room, which is almost never the cue anyone meant.
 */
function newCue() {
  openSheet({ id: null, name: '', note: '', steps: [], devices: 0, draft: true });
  setTimeout(() => el('#sheetname').focus(), 60);
}

function openSheet(cue) {
  sheetCue = cue;
  sheetView = 'steps';
  pickRoom = null;
  openStep = null;
  el('#sheetname').value = cue.name;
  el('#scrim').hidden = false;
  drawSheet();
}

function closeSheet() {
  el('#scrim').hidden = true;
  sheetCue = null;
  openStep = null;
  const danger = el('#sheetdelete');
  danger.classList.remove('armed');
  danger.textContent = 'Delete';
}

function drawSheet() {
  if (!sheetCue) return;
  const look = cuePreview(sheetCue);
  const steps = sheetCue.steps || [];
  el('#sheetfacts').innerHTML =
    '<span><b>' + steps.length + '</b> circuits</span>' +
    '<span>' + cueNote(sheetCue) + '</span>' +
    '<span>average <b>' + look.brightness + '%</b></span>';

  // Only the step list can be applied or renamed; picking is its own moment.
  const picking = sheetView !== 'steps';
  el('#sheethead').style.display = picking ? 'none' : '';
  el('#sheetfoot').style.display = picking ? 'none' : '';

  // A draft has nothing to fire, re-record or delete yet — it can only be made.
  const draft = !!sheetCue.draft;
  el('#sheeteyebrow').textContent = draft ? 'New cue' : 'Cue';
  el('#sheetapply').textContent = draft ? 'Create this cue' : 'Set this cue';
  el('#sheetrecapture').hidden = draft;
  el('#sheetdelete').hidden = draft;
  el('#sheetapi').textContent = draft ? '' : sheetCue.id;
  el('#sheetapi').hidden = draft;

  const body = el('#sheetbody');
  body.innerHTML = '';
  if (sheetView === 'steps') return drawStepList(body);
  if (sheetView === 'rooms') return drawRoomPicker(body);
  return drawCircuitPicker(body);
}

function drawStepList(body) {
  const steps = sheetCue.steps || [];
  const byRoom = new Map();
  for (const st of steps) {
    const d = deviceOf(st.record_id);
    const room = d ? title(d.room) : 'Not on this hub';
    if (!byRoom.has(room)) byRoom.set(room, []);
    byRoom.get(room).push({ st, d });
  }

  if (!steps.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'This cue has no circuits yet. Add some below.';
    body.appendChild(p);
  }

  for (const [room, list] of byRoom) {
    const h = document.createElement('div');
    h.className = 'sheet-room';
    h.textContent = room;
    body.appendChild(h);
    for (const { st, d } of list) body.appendChild(stepRow(st, d));
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'sheet-add';
  add.textContent = '+ Add or remove lights';
  add.onclick = () => { sheetView = 'rooms'; drawSheet(); };
  body.appendChild(add);
}

/** One circuit in the cue: what it will be set to, and — opened — how to change it. */
function stepRow(st, d) {
  const wrap = document.createElement('div');
  const lit = st.on !== false;
  const open = openStep === st.record_id;
  wrap.className = 'sheet-step' + (lit ? ' lit' : '') + (open ? ' open' : '');
  wrap.style.setProperty('--pip', lit && st.tune != null
    ? 'color-mix(in oklab, var(--warm) ' + Math.round(st.tune) + '%, var(--cool))'
    : 'var(--warm)');

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'sheet-row';
  head.innerHTML = '<span class="dot"></span><span class="what"></span>' +
                   '<span class="to"></span><span class="chev">▾</span>';
  head.querySelector('.what').textContent = d ? pretty(d.name) : 'Circuit ' + st.record_id;
  head.querySelector('.to').textContent = stepWord(st);
  head.setAttribute('aria-expanded', String(open));
  head.onclick = () => {
    openStep = open ? null : st.record_id;
    drawSheet();
  };
  wrap.appendChild(head);

  if (!open) return wrap;

  const edit = document.createElement('div');
  edit.className = 'step-edit';

  const onoff = document.createElement('div');
  onoff.className = 'onoff';
  for (const [word, want] of [['On', true], ['Off', false]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = word;
    b.className = (lit === want) ? 'picked' : '';
    b.setAttribute('aria-pressed', String(lit === want));
    b.onclick = () => {
      st.on = want;
      // Off carries no level or colour; on without one takes the lamp as it is.
      if (!want) { delete st.level; delete st.tune; }
      else if (d) {
        if (d.is_dimmable && st.level == null) st.level = d.level > 0 ? d.level : 100;
        if (d.is_tunable && st.tune == null) st.tune = d.tune;
      }
      saveSteps();
      drawSheet();
    };
    onoff.appendChild(b);
  }
  edit.appendChild(onoff);

  if (lit && d && d.is_dimmable) {
    edit.appendChild(stepSlider('Brightness', 'level', st, d, (v) => v + '%'));
  }
  if (lit && d && d.is_tunable) {
    edit.appendChild(stepSlider('Warmth', 'tune', st, d, warmthWord, true));
  }

  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'step-drop';
  drop.textContent = 'Remove from cue';
  drop.onclick = () => {
    sheetCue.steps = sheetCue.steps.filter(x => x !== st);
    openStep = null;
    saveSteps();
    drawSheet();
  };
  edit.appendChild(drop);

  wrap.appendChild(edit);
  return wrap;
}

function stepSlider(label, key, st, d, word, warm) {
  const row = document.createElement('label');
  row.className = 'step-slider' + (warm ? ' warm' : '');
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = key === 'level' ? 1 : 0;
  input.max = 100; input.step = 1;
  input.value = st[key] == null ? (key === 'level' ? 100 : d.tune) : st[key];
  const read = document.createElement('b');
  read.textContent = word(Number(input.value));
  input.addEventListener('input', () => {
    st[key] = Number(input.value);
    read.textContent = word(st[key]);
    // the dot and the summary follow the value as it moves
    const wrapEl = row.closest('.sheet-step');
    if (key === 'tune') {
      wrapEl.style.setProperty('--pip',
        'color-mix(in oklab, var(--warm) ' + st.tune + '%, var(--cool))');
    }
    wrapEl.querySelector('.to').textContent = stepWord(st);
    saveSteps();
  });
  row.append(name, input, read);
  return row;
}

/* Step one: which room. */
function drawRoomPicker(body) {
  body.appendChild(backButton('All circuits in this cue', () => { sheetView = 'steps'; drawSheet(); }));
  const h = document.createElement('div');
  h.className = 'sheet-room';
  h.textContent = 'Choose a room';
  body.appendChild(h);

  for (const room of rooms()) {
    const items = inRoom(room);
    const inCue = items.filter(d => stepFor(d.record_id)).length;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick';
    b.innerHTML = '<span class="what"></span><span class="count"></span><span class="chev">›</span>';
    b.querySelector('.what').textContent = title(room);
    b.querySelector('.count').textContent =
      inCue ? inCue + ' of ' + items.length + ' in this cue' : items.length + ' circuits';
    b.onclick = () => { pickRoom = room; sheetView = 'circuits'; drawSheet(); };
    body.appendChild(b);
  }
}

/* Step two: which lights in it. Ticking one adds it, unticking takes it out. */
function drawCircuitPicker(body) {
  body.appendChild(backButton('Rooms', () => { sheetView = 'rooms'; drawSheet(); }));
  const h = document.createElement('div');
  h.className = 'sheet-room';
  h.textContent = title(pickRoom);
  body.appendChild(h);

  for (const d of inRoom(pickRoom)) {
    const st = stepFor(d.record_id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick' + (st ? ' in' : '');
    b.innerHTML = '<span class="box">' + CHECK + '</span>' +
                  '<span class="what"></span><span class="count"></span>';
    b.querySelector('.what').textContent = pretty(d.name);
    b.querySelector('.count').textContent = st ? stepWord(st) : 'not in this cue';
    b.setAttribute('aria-pressed', String(!!st));
    b.onclick = () => {
      if (st) {
        sheetCue.steps = sheetCue.steps.filter(x => x !== st);
      } else {
        // A circuit added to a cue starts on. Almost every cue is a list of
        // things to light, and most lamps are off when you sit down to build
        // one — inheriting "off" meant adding eight lights and then opening
        // all eight to say what you plainly meant. A step that should be off
        // is the exception, and it is one tap away in the row below.
        const next = { record_id: d.record_id, on: true };
        if (d.is_dimmable) next.level = d.status && d.level > 0 ? d.level : 100;
        if (d.is_tunable) next.tune = d.tune;
        sheetCue.steps = [...(sheetCue.steps || []), next];
      }
      saveSteps();
      drawSheet();
    };
    body.appendChild(b);
  }
}

function backButton(label, go) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sheet-back';
  b.innerHTML = CHEV_LEFT + '<span></span>';
  b.querySelector('span').textContent = label;
  b.onclick = go;
  return b;
}

// What one step will do, in the same words the tiles use.
function stepWord(st) {
  if (st.on === false) return 'off';
  const level = st.level == null ? 'on' : st.level + '%';
  return st.tune == null ? level : level + ' · ' + warmthWord(st.tune);
}

/**
 * Edits save as they are made, the same way renaming does. Sliders fire
 * continuously, so writes are spaced and the last value always wins.
 */
let saveTimer = null;
function saveSteps() {
  if (!sheetCue) return;
  // A draft is not on the server yet, so its edits are simply kept in hand.
  if (sheetCue.draft) { sheetCue.devices = sheetCue.steps.length; drawSheet(); return; }
  clearTimeout(saveTimer);
  const cue = sheetCue;
  saveTimer = setTimeout(async () => {
    try {
      const body = await fetch('/api/scenes/' + encodeURIComponent(cue.id), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: cue.steps }),
      }).then(r => r.json());
      if (!body.ok) throw new Error(body.error || 'Could not save it');
      Object.assign(cue, body.scene);
      drawCues();
      if (sheetCue === cue) drawSheet();
    } catch (err) {
      note(err.message + '.');
    }
  }, 350);
}

async function createCue() {
  const cue = sheetCue;
  if (!cue) return;
  const name = el('#sheetname').value.trim();
  if (!name) { note('Give the cue a name first.'); el('#sheetname').focus(); return; }
  if (!cue.steps.length) { note('Add at least one circuit first.'); return; }
  try {
    const body = await fetch('/api/scenes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, steps: cue.steps }),
    }).then(r => r.json());
    if (!body.ok) throw new Error(body.error || 'Could not save it');
    closeSheet();
    // The id is what a shortcut will address, so say it once, here.
    note('Saved ' + body.scene.name + ' — ' + body.scene.devices + ' circuits · id ' + body.scene.id, true);
    loadCues();
  } catch (err) {
    note(err.message + '.');
  }
}

async function patchCue(patch, said) {
  if (!sheetCue) return;
  const cue = sheetCue;
  try {
    const body = await fetch('/api/scenes/' + encodeURIComponent(cue.id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(r => r.json());
    if (!body.ok) throw new Error(body.error || 'Could not save it');
    Object.assign(cue, body.scene);
    note(said);
    drawCues();
    if (sheetCue === cue) drawSheet();
  } catch (err) {
    note(err.message + '.');
  }
}

function wireSheet() {
  el('#scrim').addEventListener('click', (e) => { if (e.target === el('#scrim')) closeSheet(); });
  el('#sheetclose').onclick = closeSheet;
  el('#sheetapply').onclick = () => {
    if (sheetCue && sheetCue.draft) return createCue();
    const c = sheetCue; closeSheet(); fire(c);
  };
  el('#sheetrecapture').onclick = () =>
    patchCue({ recapture: true }, 'Updated to match the house as it is now.');

  const name = el('#sheetname');
  const rename = () => {
    if (!sheetCue || name.value.trim() === sheetCue.name) return;
    if (sheetCue.draft) { sheetCue.name = name.value.trim(); return; }
    patchCue({ name: name.value }, 'Renamed to ' + name.value.trim() + '.');
  };
  name.addEventListener('blur', rename);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
    if (e.key === 'Escape') { name.value = sheetCue ? sheetCue.name : ''; name.blur(); }
  });

  // Deleting takes two presses: the first arms it, the second does it.
  const danger = el('#sheetdelete');
  danger.onclick = () => {
    if (!danger.classList.contains('armed')) {
      danger.classList.add('armed');
      danger.textContent = 'Press again to delete';
      setTimeout(() => { danger.classList.remove('armed'); danger.textContent = 'Delete'; }, 4000);
      return;
    }
    const c = sheetCue;
    closeSheet();
    dropCue(c);
  };
}

/**
 * What a cue will look like, read off its own steps: how much light it leaves
 * on, averaged over every circuit it touches — not only the lit ones, or a
 * Good Night cue reads bright because its one lamp is a foot light.
 */
function cuePreview(cue) {
  const steps = cue.steps || [];
  if (!steps.length) return { brightness: 0, colour: 'rgba(255,213,160,.09)' };
  const brightness = Math.round(steps.reduce((sum, st) =>
    sum + (st.on === false ? 0 : (st.level == null ? 100 : st.level)), 0) / steps.length);
  const on = steps.filter(st => st.on !== false);
  if (!on.length) return { brightness: 0, colour: 'rgba(255,213,160,.09)' };
  const tuned = on.filter(st => st.tune != null);
  if (!tuned.length) return { brightness, colour: 'var(--warm)' };
  const warmth = Math.round(tuned.reduce((sum, st) => sum + st.tune, 0) / tuned.length);
  return { brightness, colour: 'color-mix(in oklab, var(--warm) ' + warmth + '%, var(--cool))' };
}

async function fire(cue) {
  if (firing) return;
  firing = cue.id;
  drawCues();
  note(cue.name + ' — setting ' + cue.devices + ' circuits…', true);
  try {
    const body = await fetch('/api/scenes/' + encodeURIComponent(cue.id) + '/apply', { method: 'POST' })
      .then(r => r.json());
    if (!body.ok) throw new Error(body.error || 'Hub did not respond');
    const said = body.missed
      ? cue.name + ' — ' + body.set + ' of ' + body.total + ' set. ' + body.missed + ' did not take.'
      : cue.name + ' — ' + body.set + ' circuits set.';
    // Misclicking a cue changes a whole room, so the way back is offered here
    // rather than left to you to reconstruct by hand.
    note(said, false, body.undoable ? { label: 'Undo', run: undoCue } : null);
  } catch (err) {
    note(cue.name + ' — ' + err.message + '.');
  } finally {
    firing = null;
    drawCues();
    await sync(true);          // the house moved; go and read what it actually did
    drawField();
  }
}

async function undoCue() {
  if (firing) return;
  firing = 'undo';
  drawCues();
  note('Putting it back…', true);
  try {
    const body = await fetch('/api/scenes/undo', { method: 'POST' }).then(r => r.json());
    if (!body.ok) throw new Error(body.error || 'Hub did not respond');
    note(body.missed
      ? 'Put back ' + body.set + ' of ' + body.total + ' circuits. ' + body.missed + ' did not take.'
      : 'Put back as it was before ' + body.scene + '.');
  } catch (err) {
    note(err.message + '.');
  } finally {
    firing = null;
    drawCues();
    await sync(true);
    drawField();
  }
}

async function dropCue(cue) {
  try {
    const body = await fetch('/api/scenes/' + encodeURIComponent(cue.id), { method: 'DELETE' })
      .then(r => r.json());
    if (!body.ok) throw new Error(body.error || 'Could not delete it');
    note('Deleted ' + body.removed + '.');
    loadCues();
  } catch (err) {
    note(err.message + '.');
  }
}

/* ─────────────────────── the main breaker: held down, not tapped */

const HOLD_MS = 850;
let holdFrom = 0, holdRaf = 0, armed = false;

function wireMain() {
  const main = el('#main');
  const fill = el('#mainfill');

  const stop = () => { cancelAnimationFrame(holdRaf); main.classList.remove('armed'); fill.style.width = '0%'; };
  const start = (e) => {
    if (main.disabled) return;
    e.preventDefault();
    holdFrom = performance.now();
    main.classList.add('armed');
    const step = (now) => {
      const p = Math.min(1, (now - holdFrom) / HOLD_MS);
      fill.style.width = (p * 100) + '%';
      if (p >= 1) { stop(); return allOff(); }
      holdRaf = requestAnimationFrame(step);
    };
    holdRaf = requestAnimationFrame(step);
  };

  main.addEventListener('pointerdown', start);
  main.addEventListener('pointerup', stop);
  main.addEventListener('pointerleave', stop);
  main.addEventListener('pointercancel', stop);
  // A keyboard cannot hold, so it arms on the first press and confirms on the second.
  main.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (armed) { armed = false; main.classList.remove('armed'); allOff(); return; }
    armed = true;
    main.classList.add('armed');
    note('Press again to switch off ' + lit(state.devices).length + ' circuits.');
    setTimeout(() => { armed = false; main.classList.remove('armed'); }, 4000);
  });
}

function allOff() {
  const on = lit(state.devices);
  on.forEach(d => setDevice(d, false));
  note(on.length + (on.length === 1 ? ' circuit' : ' circuits') + ' switching off.');
}

/* ──────────────────────────────────────────────────────────── messages */

let noteTimer;
/**
 * A message, and optionally one thing you can do about it. An action stays up
 * longer than a plain message — an undo you cannot reach is not an undo.
 */
function note(msg, hold, action) {
  const n = el('#note');
  n.innerHTML = '<span class="note-text"></span>';
  n.querySelector('.note-text').textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'note-do';
    b.textContent = action.label;
    b.onclick = () => { n.classList.remove('show'); action.run(); };
    n.appendChild(b);
  }
  n.classList.add('show');
  clearTimeout(noteTimer);
  if (!hold) noteTimer = setTimeout(() => n.classList.remove('show'), action ? 14000 : 4200);
}

/* ────────────────────────────────────────────────────────────── wiring */

el('#seek').addEventListener('input', (e) => { state.q = e.target.value; drawField(); });

// On a phone the search field is folded away behind its icon; opening it gives
// it the row it needs, and leaving it empty folds it back.
const seekToggle = el('#seektoggle');
const plate = el('.plate');
function openSeek(open) {
  plate.classList.toggle('searching', open);
  seekToggle.setAttribute('aria-expanded', String(open));
  if (open) el('#seek').focus();
}
seekToggle.addEventListener('click', () => openSeek(!plate.classList.contains('searching')));
el('#seek').addEventListener('blur', () => { if (!state.q.trim()) openSeek(false); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!el('#scrim').hidden) { closeSheet(); return; }
    if (state.q) { state.q = ''; el('#seek').value = ''; drawField(); openSeek(false); }
    else if (state.view === 'room') go('house');
  }
  // A slash puts the cursor in the search box, the way a console does.
  if (e.key === '/' && document.activeElement !== el('#seek')) { e.preventDefault(); el('#seek').focus(); }
});

wireMain();
wireSheet();
el('#newcue').onclick = newCue;

el('#back').onclick = () => {
  if (state.q) { state.q = ''; el('#seek').value = ''; openSeek(false); }
  go('house');
};

// The server pushes a snapshot the moment the house moves, so the page is live
// instead of up to ten seconds behind, and two phones never disagree. Polling
// stays as a fallback for when the stream cannot hold — and is skipped entirely
// while the stream is healthy.
let streamLive = false;
(function listen() {
  let es;
  try { es = new EventSource('/api/stream'); } catch { return; }
  es.addEventListener('devices', (e) => {
    streamLive = true;
    try { applySnapshot(JSON.parse(e.data)); } catch { /* ignore a torn frame */ }
  });
  es.addEventListener('error', () => { streamLive = false; });  // it retries itself
})();

/* ─────────────────────────────────────────────── what the house does itself */

const auto = { settings: null, nudges: [], timers: [], colour_now: null };
let timerScope = null;      // the room a new timer would act on

async function loadAuto() {
  try {
    const a = await fetch('/api/automations').then(r => r.json());
    Object.assign(auto, a);
    drawNudges();
    drawTimers();
    drawSettings();
  } catch { /* the next pass picks it up */ }
}

function drawNudges() {
  const host = el('#nudges');
  host.innerHTML = '';
  for (const n of auto.nudges) {
    const row = document.createElement('div');
    row.className = 'nudge' + (n.kind === 'ac' ? ' ac' : '');
    const hrs = n.hours >= 2 ? Math.round(n.hours) + ' hours' : n.hours + ' hours';
    row.innerHTML = '<span class="pip"></span><span class="said"></span>';
    row.querySelector('.said').innerHTML =
      '<b></b> <i>in</i> <b></b> <i>has been on ' + hrs + '</i>';
    const [what, where] = row.querySelectorAll('.said b');
    what.textContent = pretty(n.name);
    where.textContent = title(n.room);

    const off = document.createElement('button');
    off.type = 'button';
    off.textContent = 'Switch off';
    off.onclick = async () => {
      const d = state.devices.find(x => x.record_id === n.record_id);
      if (d) setDevice(d, false);
      row.remove();
    };
    const seen = document.createElement('button');
    seen.type = 'button';
    seen.textContent = 'Leave it';
    seen.onclick = async () => {
      row.remove();
      await fetch('/api/nudges/' + n.record_id + '/dismiss', { method: 'POST' }).catch(() => {});
    };
    row.append(off, seen);
    host.appendChild(row);
  }
}

function drawTimers() {
  const host = el('#timerrunning');
  host.innerHTML = '';
  for (const t of auto.timers) {
    const mins = Math.max(1, Math.round(t.seconds_left / 60));
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<span><b></b> in ' + mins + ' min</span>';
    row.querySelector('b').textContent = title(t.label);   // rooms read as they do everywhere else
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = 'Cancel';
    x.onclick = async () => {
      await fetch('/api/timers/' + t.id, { method: 'DELETE' }).catch(() => {});
      loadAuto();
    };
    row.appendChild(x);
    host.appendChild(row);
  }
  const on = auto.timers.length;
  el('#qtimerword').textContent = on ? on + ' set' : 'Timer';
  el('#qtimer').classList.toggle('on', !!on);
}

function drawSettings() {
  if (!auto.settings) return;
  const c = el('#setcirc');
  c.classList.toggle('on', auto.settings.circadian.on);
  c.setAttribute('aria-pressed', String(auto.settings.circadian.on));
  // Say what it is doing right now, so the setting is legible rather than abstract.
  el('#setcircval').textContent = auto.settings.circadian.on && auto.colour_now != null
    ? (auto.colour_now >= 70 ? 'warm now' : auto.colour_now <= 40 ? 'cool now' : 'mid')
    : '';
  const n = el('#setnudge');
  n.classList.toggle('on', auto.settings.nudges.on);
  n.setAttribute('aria-pressed', String(auto.settings.nudges.on));
}

async function saveSetting(patch) {
  try {
    const r = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(x => x.json());
    auto.settings = r.settings;
    drawSettings();
    loadAuto();
  } catch { note('Could not save that.'); }
}

el('#setcirc').onclick = () => saveSetting({ circadian: { on: !auto.settings.circadian.on } });
el('#setnudge').onclick = () => saveSetting({ nudges: { on: !auto.settings.nudges.on } });

/* the timer panel */
const timerpop = el('#timerpop');

// Rooms are named outright rather than offered as "this room": which room "this"
// meant depended on what you were looking at, which is exactly the wrong thing
// to be unsure of when you are setting something that acts while you sleep.
function drawScopes() {
  const host = el('#timerscopes');
  host.innerHTML = '';
  for (const room of rooms()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = title(room);
    b.classList.toggle('on', room === timerScope);
    b.onclick = () => pickScope(room);
    host.appendChild(b);
  }
}
function pickScope(room) {
  timerScope = room;
  drawScopes();
}
function openTimer(open) {
  timerpop.hidden = !open;
  el('#qtimer').setAttribute('aria-expanded', String(open));
  if (open) {
    // Start on the room being looked at — usually the one being gone to bed in.
    if (state.view === 'room' && state.room) timerScope = state.room;
    else if (!timerScope || !rooms().includes(timerScope)) timerScope = rooms()[0] || null;
    drawScopes();
    loadAuto();
  }
}
el('#timermins').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (!timerScope) return note('Pick a room first.');
  const scope = 'room:' + timerScope;
  try {
    const r = await fetch('/api/timers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: Number(b.dataset.min), scope }),
    }).then(x => x.json());
    if (r.ok) { note(r.spoken + '.'); openTimer(false); loadAuto(); }
    else note(r.error || 'Could not set that timer.');
  } catch { note('Could not set that timer.'); }
});

/* the thumb bar */
el('#qfind').onclick = () => { openSeek(true); el('#seek').focus(); };
el('#qtimer').onclick = () => openTimer(timerpop.hidden);
document.addEventListener('click', (e) => {
  if (timerpop.hidden) return;
  if (!timerpop.contains(e.target) && !el('#qtimer').contains(e.target)) openTimer(false);
});

// All-off is held, not tapped — the same gesture as the main button, because
// switching off the whole house should never be a stray thumb.
(function wireQuickOff() {
  const b = el('#qoff');
  let raf = 0, from = 0;
  const stop = () => { cancelAnimationFrame(raf); b.classList.remove('armed'); };
  b.addEventListener('pointerdown', (e) => {
    if (b.disabled) return;
    e.preventDefault();
    from = performance.now();
    b.classList.add('armed');
    const step = (now) => {
      if (now - from >= HOLD_MS) { stop(); return allOff(); }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, stop));
})();

setInterval(loadAuto, 60000);
loadAuto();

/* ── swipe between rooms ───────────────────────────────────────────────────
   One-handed, the rail is a reach. A horizontal drag across the board moves to
   the next room, the way pages turn. Anything that is itself a horizontal
   control — a brightness or colour slider above all — is left alone, or every
   attempt to dim a lamp would fling you into the next room instead. */
(function wireSwipe() {
  const board = el('#stack');
  if (!board) return;
  const order = () => ['house', ...rooms()];
  let x0 = 0, y0 = 0, live = false;

  board.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { live = false; return; }
    // never steal a gesture that belongs to a control
    if (e.target.closest('input, .slider, .seg, .pull, .key, .warmth')) { live = false; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; live = true;
  }, { passive: true });

  board.addEventListener('touchend', (e) => {
    if (!live) return;
    live = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    // decisively sideways, or it was a scroll that happened to drift
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    const list = order();
    const at = state.q ? 0 : list.indexOf(state.view === 'room' ? state.room : 'house');
    if (at < 0) return;
    const next = list[at + (dx < 0 ? 1 : -1)];
    if (!next) return;
    if (state.q) { state.q = ''; el('#seek').value = ''; }
    tick_haptic(6);
    next === 'house' ? go('house') : go('room', next);
  }, { passive: true });
})();

// Keep up with the house: poll while the tab is in view, re-read on return.
setInterval(() => { if (!document.hidden && !streamLive) sync(); }, 10000);
setInterval(readout, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });

load();
</script>
</body>
</html>`;
