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
const SCHEDULES_PATH = path.join(__dirname, 'schedules.json');

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

/* ─────────────────────────────────────────────────────────────── schedules
 *
 * The hub's own scheduler is dead — addScheduledTrigger throws server-side on
 * every call, whatever you send it (see CLAUDE.md). This replaces it, and it
 * only works because the dashboard now runs on the hub itself: the one box in
 * the house that is always on and always on the LAN.
 *
 * There is one list for the whole house, held here and pushed to every browser
 * over SSE. A schedule is not per-phone and not per-user — two people looking
 * at the page see the same thing, and editing on one changes it on the other.
 *
 * A schedule fires a cue, or switches one circuit on or off. Both are things
 * the UI can already do by hand; this only decides when.
 */
let schedules = [];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* The hub stores every label in capitals; a schedule's sentence is read by a
   person, so it gets sentence case here rather than shouting. */
const sentence = (s) => String(s || '').trim().toLowerCase()
  .replace(/(^|\s)\S/g, (c) => c.toUpperCase());

function loadSchedules() {
  try {
    const raw = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));
    schedules = Array.isArray(raw) ? raw : [];
    console.log(`Loaded ${schedules.length} schedules from schedules.json`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('schedules.json unreadable, starting empty:', err.message);
    schedules = [];
  }
}

function saveSchedules() {
  try {
    fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2));
  } catch (err) {
    console.error('could not write schedules.json:', err.message);
  }
}

/** Local wall-clock day, as the string the fired-guard is keyed on. */
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

/** What a schedule points at, resolved now — null if it has gone missing. */
function scheduleTarget(sch) {
  if (sch.target?.kind === 'cue') {
    const scene = scenes.find(sc => sc.id === sch.target.id);
    return scene ? { kind: 'cue', scene, label: scene.name } : null;
  }
  if (sch.target?.kind === 'device') {
    const entry = devices.get(Number(sch.target.record_id));
    return entry ? { kind: 'device', entry, label: `${sentence(entry.record.device_name)} · ${sentence(entry.room)}` } : null;
  }
  return null;
}

/** The sentence a schedule reads as, used by the API and spoken back. */
function scheduleSays(sch) {
  const t = scheduleTarget(sch);
  const what = t ? t.label : 'something that no longer exists';
  const verb = sch.target?.kind === 'cue' ? 'run' : (sch.action === 'off' ? 'switch off' : 'switch on');
  const days = (sch.days || []).length === 7 ? 'every day'
    : (sch.days || []).length ? 'on ' + sch.days.map(d => DAY_NAMES[d]).join(', ')
      : 'never — no days chosen';
  return `${sch.at} · ${verb} ${what}, ${days}`;
}

const scheduleList = () => schedules.map(sch => ({
  ...sch,
  says: scheduleSays(sch),
  target_missing: !scheduleTarget(sch),
}));

/** Do the thing. Shared by the tick and by "run it now" in the UI. */
async function runSchedule(sch) {
  const t = scheduleTarget(sch);
  if (!t) throw new Error('what this schedule points at is gone');
  if (t.kind === 'cue') return fireCue(t.scene);
  return setRecords([t.entry.record], { on: sch.action !== 'off' });
}

/* A schedule fires at most once a day, and only near its time.
 *
 * `fired_on` is the date it last ran, so a restart at 07:05 does not re-run the
 * 07:00 schedule that already happened. The grace window is the other half: a
 * box that was off all morning must not come up at two in the afternoon and
 * fire everything it slept through — switching the house on hours late is worse
 * than not switching it at all. Within the window a genuine miss still runs,
 * which is the case worth catching (a restart, a slow read). */
const SCHEDULE_GRACE_MIN = 10;
let scheduleTimer = null;

async function tickSchedules() {
  if (!schedules.length) return;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = localDay(now);
  const weekday = now.getDay();

  for (const sch of schedules) {
    if (!sch.enabled) continue;
    if (!(sch.days || []).includes(weekday)) continue;
    if (sch.fired_on === today) continue;
    const at = minutesOf(sch.at);
    if (at == null) continue;
    const late = nowMin - at;
    if (late < 0 || late > SCHEDULE_GRACE_MIN) continue;

    sch.fired_on = today;
    saveSchedules();
    try {
      await runSchedule(sch);
      console.log(`schedule ${sch.id} fired: ${scheduleSays(sch)}`);
      stats.schedulesFired = (stats.schedulesFired || 0) + 1;
    } catch (err) {
      console.error(`schedule ${sch.id} failed:`, err.message);
      sch.last_error = err.message;
      saveSchedules();
    }
    pushSoon();
  }
}

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
/**
 * `at` is when the read finished; `taken` is when it connected — and those are
 * two to three seconds apart, because the hub sends its site_config that long
 * after the handshake and it describes the house **at connect time**.
 *
 * The difference is not academic. A read already in flight when you press a key
 * carries a picture from before you pressed it, and merging that picture puts
 * the light back on for the second or two until the next read. `taken` is what
 * every "does this snapshot know about my command?" test has to use.
 */
let hubSync = { at: 0, taken: 0, ok: false, error: 'not read yet' };
let reading = null;

// When we last commanded each circuit, so a read that predates the command can
// be told apart from one that reflects it.
const commandedAt = new Map();
const markCommanded = (recordId) => commandedAt.set(recordId, Date.now());

// Counters behind /api/health. This runs unattended on a box nobody looks at,
// so "is it still talking to the hub?" has to be answerable without reading logs.
const startedAt = Date.now();
const stats = {
  readsOk: 0, readsFailed: 0, consecutiveReadFailures: 0,
  commandsSent: 0, commandsFailed: 0, cuesFired: 0, schedulesFired: 0,
};

function readHubState() {
  if (reading) return reading;

  // The site_config describes the house as it stood when this socket opened,
  // not when the message arrives, so this is the moment the snapshot belongs to.
  const takenAt = Date.now();

  reading = new Promise((resolve) => {
    const ws = hubSocket();
    let settled = false;

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reading = null;
      hubSync = { at: Date.now(), taken: takenAt, ok, error: ok ? null : error };
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
        if (!entry) continue;
        // This picture cannot know about our last command to this circuit —
        // either it was taken first, or it was taken inside the hub's own
        // settling window, where a fresh connection still reports the previous
        // state. Merging it puts the light back on for a second or two until a
        // read that does know arrives, which is exactly the flicker you see
        // when you switch something on and straight off again.
        if (takenAt - (commandedAt.get(rec.record_id) || 0) < SETTLE_MS) continue;
        entry.record = { ...entry.record, ...rec };
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
  markCommanded(recordId);

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

/* 60ms was measured against five lamps and holds there. Eleven is a different
   animal: LIVING's ceiling dropped three of eleven on one run and none on the
   next, at the same spacing — so the loss is intermittent rather than a
   threshold, and no gap can be trusted to fix it. A wider one still helps, and
   the verify pass below catches what it misses. */
const gapFor = (n) => (n > 6 ? Math.max(BATCH_GAP_MS, 130) : BATCH_GAP_MS);

/* Colour is not brightness, and it is far slower to land.
 *
 * Measured 2026-08-15 on ASHU's five COBs by eye, because the hub cannot be
 * asked: it writes device_status_tunable into its own database whether or not
 * the lamp obeyed, so a read back says only what we told it. Counting lamps in
 * the room instead:
 *
 *     spacing   colour     brightness
 *      60ms     1 of 5      5 of 5
 *     300ms     1 of 5        —
 *     500ms     3 of 5        —
 *     800ms     5 of 5        —      (twice)
 *
 * So brightness at 60ms is fine and always was; colour at 60ms was changing a
 * single lamp and reporting five. That is the whole of "All COBs doesn't change
 * all COBs", and it is why a ceiling could end up burning two temperatures.
 *
 * 800ms is the vendor's own GRP_DELAY_T (BMS_host, DeviceGroup.models), which
 * we can now see they arrived at for the same reason. Every COB in this house
 * is on one module — device_id 19, all 36 of them — so there is nothing to be
 * gained by pacing per module; the queue is shared whatever the room. */
const TUNE_GAP_MS = Number(process.env.TUNE_GAP_MS || 800);

function sendBatchToHub(commands, gapMs) {
  if (!commands.length) return Promise.resolve(0);
  const gap = gapMs != null ? gapMs : gapFor(commands.length);

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
          markCommanded(recordId);
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
          await sleep(gap);
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
    synced_at: hubSync.taken || null,
    hub_ok: hubSync.ok,
    hub_error: hubSync.error,
    backdrop_v: backdropVersion(),
    /* There is one schedule list for the house, so it rides the same frame the
       devices do — edit on a phone and the laptop redraws without asking. */
    schedules: scheduleList(),
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
  /* The schedule list is part of what the page draws, so a change to it has to
     count as a change — otherwise editing one on a phone pushes nothing and the
     laptop keeps showing yesterday's list until something else moves. */
  parts.push('sch:' + schedules.map(s =>
    `${s.id}${s.at}${s.enabled ? 1 : 0}${(s.days || []).join('')}${s.action}${s.target?.id ?? s.target?.record_id}`).join(','));
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

/* A library of backdrops rather than one file over SSH.
 *
 * data/backdrops/ holds them; settings.backdrop names the one in use, and with
 * none named the original data/background.jpg still serves — so an install that
 * has never opened the picker behaves exactly as before. Photographs are
 * per-install and git-ignored, but build-bundle.sh packs data/, so a library
 * built on the Mac ships to the hub. */
const BACKDROP_DIR = path.join(__dirname, 'data', 'backdrops');
const SAFE_NAME = /^[a-zA-Z0-9._-]{1,64}\.(jpg|jpeg|png)$/;

function backdropList() {
  try {
    return fs.readdirSync(BACKDROP_DIR).filter((f) => SAFE_NAME.test(f)).sort();
  } catch { return []; }
}

function activeBackdrop() {
  const chosen = settings.backdrop;
  if (chosen && SAFE_NAME.test(chosen)) {
    const file = path.join(BACKDROP_DIR, chosen);
    if (fs.existsSync(file)) return file;
  }
  return fs.existsSync(BG_PATH) ? BG_PATH : null;
}

/* The backdrop is cached hard, so its version has to move when the picture
   does — and unlike ASSET_V this cannot be computed once at startup, because
   the whole point is changing it without a restart. */
function backdropVersion() {
  const file = activeBackdrop();
  if (!file) return 'none';
  try {
    const st = fs.statSync(file);
    return require('crypto').createHash('sha1')
      .update(`${path.basename(file)}:${st.size}:${Math.round(st.mtimeMs)}`)
      .digest('hex').slice(0, 8);
  } catch { return 'none'; }
}

/**
 * A fingerprint of the assets that are cached hard, used both as the service
 * worker's cache name and as `?v=` on the backdrop.
 *
 * These files are served with a long max-age, which is right — they change
 * about once a year. But it means replacing the photograph left every phone
 * showing the old one for a day, and an installed app showing it indefinitely,
 * because the service worker cache was named by hand and nobody remembers to
 * raise a 'v1'. Naming the cache after the bytes means changing them is the
 * bust. Computed once at startup, since a deploy restarts the service anyway.
 */
const ASSET_V = (() => {
  const parts = ['background.jpg', 'lens.png', 'icon-180.png', 'icon-192.png', 'icon-512.png'].map((f) => {
    try {
      const s = fs.statSync(path.join(__dirname, 'data', f));
      return `${f}:${s.size}:${Math.round(s.mtimeMs)}`;
    } catch { return `${f}:none`; }
  });
  return require('crypto').createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 8);
})();

app.get('/bg.jpg', (req, res) => {
  const file = activeBackdrop();
  if (!file) return res.status(404).end();
  // Revalidate every time. This file's contents change the moment someone
  // picks another backdrop, and a URL baked into the page at server start
  // cannot carry a version that knows about it — which is exactly how the page
  // ended up showing one photograph while measuring another. sendFile still
  // sets an ETag, so an unchanged picture costs a 304 and nothing more.
  res.type(file.endsWith('.png') ? 'png' : 'jpeg')
     .set('Cache-Control', 'no-cache').sendFile(file);
});

/* One of the library, by name, for the picker's thumbnails. */
app.get('/backdrops/:file', (req, res) => {
  if (!SAFE_NAME.test(req.params.file)) return res.status(400).end();
  const file = path.join(BACKDROP_DIR, req.params.file);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type(file.endsWith('.png') ? 'png' : 'jpeg')
     .set('Cache-Control', 'public, max-age=604800').sendFile(file);
});

app.get('/api/backdrops', (req, res) => {
  res.json({
    current: settings.backdrop || null,
    has_original: fs.existsSync(BG_PATH),
    version: backdropVersion(),
    items: backdropList().map((file) => {
      let kb = null;
      try { kb = Math.round(fs.statSync(path.join(BACKDROP_DIR, file)).size / 1024); } catch {}
      return { file, kb };
    }),
  });
});

app.post('/api/backdrops/choose', (req, res) => {
  const file = req.body?.file;
  // null means the one that was there before there was a picker.
  if (file !== null && !SAFE_NAME.test(String(file || ''))) {
    return res.status(400).json({ ok: false, error: 'No backdrop by that name' });
  }
  if (file !== null && !fs.existsSync(path.join(BACKDROP_DIR, file))) {
    return res.status(404).json({ ok: false, error: 'No backdrop by that name' });
  }
  settings.backdrop = file;
  saveSettings();
  pushSnapshot(true);            // every open browser changes its own picture
  res.json({ ok: true, current: settings.backdrop, version: backdropVersion() });
});

/* The browser resizes and re-encodes before sending, so this takes a finished
   JPEG and writes it. That keeps the box free of image libraries, which it has
   none of, and keeps a 4MB phone photograph off the wire. */
app.post('/api/backdrops/upload', express.raw({ type: ['image/jpeg', 'image/png'], limit: '8mb' }), (req, res) => {
  const name = String(req.query.name || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '');
  const file = SAFE_NAME.test(name) ? name : 'photo-' + Date.now() + '.jpg';
  if (!req.body || !req.body.length) return res.status(400).json({ ok: false, error: 'No image arrived' });
  try {
    fs.mkdirSync(BACKDROP_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKDROP_DIR, file), req.body);
    settings.backdrop = file;
    saveSettings();
    pushSnapshot(true);
    res.json({ ok: true, file, kb: Math.round(req.body.length / 1024), version: backdropVersion() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/backdrops/:file', (req, res) => {
  if (!SAFE_NAME.test(req.params.file)) return res.status(400).json({ ok: false, error: 'No such backdrop' });
  try { fs.unlinkSync(path.join(BACKDROP_DIR, req.params.file)); } catch { /* already gone */ }
  if (settings.backdrop === req.params.file) { settings.backdrop = null; saveSettings(); }
  pushSnapshot(true);
  res.json({ ok: true, current: settings.backdrop, version: backdropVersion() });
});

// The home-screen icon, and the manifest that makes this installable. Generated
// by tools/make-icon.js rather than checked in as an opaque binary.
/* The displacement map behind the refraction, generated by tools/make-lens.js. */
app.get('/lens.png', (req, res) => {
  const file = path.join(__dirname, 'data', 'lens.png');
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type('png').set('Cache-Control', 'public, max-age=604800').sendFile(file);
});

app.get('/icon-:size.png', (req, res) => {
  const file = path.join(__dirname, 'data', `icon-${req.params.size}.png`);
  if (!/^(180|192|512)$/.test(req.params.size) || !fs.existsSync(file)) return res.status(404).end();
  res.type('png').set('Cache-Control', 'public, max-age=604800').sendFile(file);
});

/**
 * A service worker, which Chrome insists on before it will offer to install the
 * app. It is written to be conservative about a dashboard: the shell and the
 * backdrop are cached so a cold open is instant, but anything under /api is
 * always fetched, because a cached reading of the house is a lie about the
 * house. The page itself is network-first so a deploy is picked up at once,
 * falling back to cache only when the hub is unreachable.
 */
const SW = `
const SHELL = 'neo-shell-${ASSET_V}';
const STATIC = ['/icon-180.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Never serve the house from a cache — a stale reading is worse than none.
  if (url.pathname.startsWith('/api/')) return;
  // Nor the backdrop, which is now something the user changes from the page.
  if (url.pathname === '/bg.jpg' || url.pathname.startsWith('/backdrops/')) return;

  if (url.pathname === '/') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
    return res;
  })));
});
`;

app.get('/sw.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(SW);
});

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: "Pravita's Apartment",
    short_name: 'The House',
    start_url: '/',
    display: 'standalone',
    background_color: '#12151a',
    theme_color: '#f3ede3',
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

/* Circuits whose colour was chosen by hand.
 *
 * Circadian fills in the colour of the hour as a lamp comes on, which is right
 * for a lamp with no opinion and wrong for one you have just set. The rule was
 * already "never re-tune a lit lamp" — but a lamp set while it is OFF was not
 * covered, and that is exactly what the group's warmth slider does. Worse, the
 * fill-in decides per lamp from the cache, so a partly stale cache overrode
 * some of a group and not others and left one ceiling burning two colours.
 *
 * So a colour asked for explicitly is remembered, and circadian leaves that
 * circuit alone until the next time a colour is asked for. */
const handTuned = new Map();

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
    synced_at: hubSync.taken,
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
    handTuned.set(recordId, Date.now());
    nudgeRefresh();
    res.json({ ok: true, record_id: recordId, tune: level });
  } catch (err) {
    console.error(`tune ${recordId} -> ${level} failed:`, err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * Several circuits set to the same thing, together.
 *
 * A room's COBs are one ceiling of light rather than five switches — eleven of
 * them in LIVING — and driving them one at a time is both slow and visibly
 * uneven, the room coming up in steps. So a group goes down one shared socket,
 * the way a cue does, which the hub takes without dropping any of it.
 *
 * The two channels are addressed independently on purpose: a warmth drag sends
 * colour only and must not rewrite brightness. When both are asked for, colour
 * goes first — under load a tune can bleed onto the main channel, and that way
 * the bleed costs colour rather than level.
 *
 * Like `/api/level` this does not confirm: the control is a slider, and a 5s
 * verdict per drag would be worse than the occasional lamp that misses, which
 * the next background read corrects anyway.
 */
const pct = (v) => (v != null && Number.isFinite(Number(v))
  ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null);

/** Sets a set of records to one brightness and/or one colour. Returns how many
 *  payloads reached the wire. Shared by the group tile and the /do addresses. */
async function setRecords(records, { on, level, tune }) {
  // A level wins over a bare on/off, which is simply full or nothing.
  const wantLevel = pct(level) != null ? pct(level)
    : typeof on === 'boolean' ? (on ? 100 : 0) : null;
  const wantTune = pct(tune);
  if (wantLevel == null && wantTune == null) throw new Error('Nothing to set — send on, level or tune');

  const canTune = (rec) => rec.is_tunable === 'true' && rec.channel_id_tunable != null;
  // A colour asked for goes to every tunable lamp. With none asked for, the
  // colour of the hour fills in — but only for lamps that are coming on, so a
  // brightness drag never re-tunes a lit lamp and fights a colour set by hand.
  if (wantTune != null) for (const rec of records) handTuned.set(rec.record_id, Date.now());

  const colour = wantTune != null ? wantTune
    : wantLevel > 0 && settings.circadian.on ? circadianTune() : null;
  const tunable = colour == null ? []
    : records.filter((rec) => canTune(rec) && (wantTune != null
        // Coming on with no colour named: the hour decides, unless this circuit
        // has been given one by hand, in which case that stands.
        || (decodeLevel(rec.device_status) === 0 && !handTuned.has(rec.record_id))));

  let sent = 0;
  if (colour != null && tunable.length) {
    sent += await sendBatchToHub(tunable.map((rec) => ({
      recordId: rec.record_id,
      fields: { channel_id: String(rec.channel_id_tunable), device_status: encodeLevel(colour) },
    })), TUNE_GAP_MS);
    if (wantLevel != null) await sleep(SCENE_SETTLE_MS);
  }
  if (wantLevel != null) {
    sent += await sendBatchToHub(records.map((rec) => ({
      recordId: rec.record_id,
      // A switch has no middle: anything above zero is simply on.
      fields: { device_status: encodeLevel(rec.is_dimmable === 'true' ? wantLevel : (wantLevel > 0 ? 100 : 0)) },
    })));
  }
  // A group command overrides any single-circuit verdict still in flight.
  const tokens = new Map();
  for (const rec of records) { const t = ++intentSeq; intents.set(rec.record_id, t); tokens.set(rec.record_id, t); }
  nudgeRefresh();

  // The hub drops the odd payload out of a large batch, intermittently — an
  // eleven-lamp ceiling lost three on one run and none on the next at the same
  // spacing. So the send is checked rather than trusted, once, in the
  // background: the caller has already had its answer and the slider is not
  // waiting on this.
  if (records.length > 1) {
    const sentAt = Date.now();
    setTimeout(() => verifyGroup(records, { wantLevel, colour, tokens, sentAt }).catch(() => {}), SETTLE_MS + 500);
  }
  return sent;
}

/** Resends only what did not take, and only where nothing newer has been asked. */
async function verifyGroup(records, { wantLevel, colour, tokens, sentAt }) {
  await readHubStateFresh();
  // A reading taken less than SETTLE_MS after the command still describes the
  // house before it. Judging a send by that would resend what already landed —
  // and, worse, could put a lamp back to a value the user has since moved off.
  if (hubSync.taken - sentAt < SETTLE_MS) {
    await sleep(800);
    await readHubStateFresh();
  }
  const missed = [];
  for (const rec0 of records) {
    const entry = devices.get(rec0.record_id);
    // Something newer owns this circuit now — a later drag, or a switch off.
    if (!entry || intents.get(rec0.record_id) !== tokens.get(rec0.record_id)) continue;
    const rec = entry.record;
    if (wantLevel != null) {
      const want = rec.is_dimmable === 'true' ? wantLevel : (wantLevel > 0 ? 100 : 0);
      if (decodeLevel(rec.device_status) !== want) {
        missed.push({ recordId: rec.record_id, fields: { device_status: encodeLevel(want) } });
        continue;
      }
    }
    /* Colour is deliberately not judged here. device_status_tunable is the
       hub's own note of what it was told, not a reading of the lamp — it said
       five of five while four lamps in the room had not moved. Checking it
       meant this pass always saw success and never resent, so the net that was
       supposed to catch a dropped colour had never once fired. With TUNE_GAP_MS
       the colour lands on the first send; claiming to verify it would only be
       a way of being wrong more confidently. */
  }
  if (!missed.length) return;
  console.log(`group: ${missed.length} of ${records.length} did not take — resending`);
  await sendBatchToHub(missed);
  nudgeRefresh();
}

app.post('/api/group', async (req, res) => {
  const ids = Array.isArray(req.body?.record_ids) ? req.body.record_ids.map(Number) : [];
  const known = [...new Set(ids)].filter((id) => devices.has(id));
  if (!known.length) {
    return res.status(400).json({ ok: false, error: 'record_ids must name devices this hub knows' });
  }

  try {
    const sent = await setRecords(known.map((id) => devices.get(id).record), req.body || {});
    res.json({ ok: true, sent, count: known.length });
  } catch (err) {
    console.error(`group of ${known.length} failed:`, err.message);
    res.status(err.message.startsWith('Nothing to set') ? 400 : 502).json({ ok: false, error: err.message });
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

  for (const { step } of order) if (step.tune != null) handTuned.set(step.record_id, Date.now());

  if (tunes.length) {
    await sendBatchToHub(tunes, TUNE_GAP_MS);
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

/** Which steps the hub has not actually taken.
 *
 *  Brightness only. device_status_tunable is what the hub was told rather than
 *  what the lamp did, so a colour judged by it is a coin toss dressed as a
 *  reading — see the note in verifyGroup. Colour rides on TUNE_GAP_MS landing
 *  first time instead. */
function outstanding(scene) {
  return scene.steps.filter((step) => {
    const t = stepTarget(step);
    if (!t) return false;
    return decodeLevel(t.rec.device_status) !== t.level;
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
  if (!hubSync.taken || Date.now() - hubSync.taken > 4000) {
    await readHubStateFresh().catch(() => {});
  }
  const { before, skipped } = captureBefore(scene.steps);
  undoable = before.length ? { name: scene.name, at: Date.now(), steps: before } : null;

  stats.cuesFired++;
  const result = await applyScene(scene);
  return { ...result, undoable: !!undoable, undo_skipped: skipped };
}

/* ── schedules: one shared list, edited from anywhere ───────────────────── */

/** Reads a schedule off a request body, or explains what is wrong with it. */
function readSchedule(body, base) {
  const at = String(body?.at ?? base?.at ?? '');
  if (minutesOf(at) == null) return { error: 'at must be a time like 07:30' };

  const days = body?.days === undefined ? (base?.days || [])
    : (Array.isArray(body.days) ? [...new Set(body.days.map(Number))].filter(d => d >= 0 && d <= 6).sort() : null);
  if (!days) return { error: 'days must be an array of 0 (Sunday) to 6' };
  if (!days.length) return { error: 'a schedule with no days would never run — pick at least one' };

  const target = body?.target ?? base?.target;
  if (target?.kind === 'cue') {
    if (!scenes.some(sc => sc.id === target.id)) return { error: `no cue with id ${target.id}` };
  } else if (target?.kind === 'device') {
    if (!devices.has(Number(target.record_id))) return { error: `no device with record_id ${target.record_id}` };
  } else {
    return { error: 'target must be {kind:"cue",id} or {kind:"device",record_id}' };
  }

  const action = String(body?.action ?? base?.action ?? 'on');
  if (!['on', 'off'].includes(action)) return { error: 'action must be on or off' };

  return {
    schedule: {
      at,
      days,
      target: target.kind === 'cue'
        ? { kind: 'cue', id: target.id }
        : { kind: 'device', record_id: Number(target.record_id) },
      action,
      enabled: body?.enabled === undefined ? (base?.enabled ?? true) : !!body.enabled,
    },
  };
}

app.get('/api/schedules', (req, res) => res.json({ ok: true, schedules: scheduleList() }));

app.post('/api/schedules', (req, res) => {
  const { error, schedule } = readSchedule(req.body || {}, null);
  if (error) return res.status(400).json({ ok: false, error });
  const sch = { id: 'sch_' + Math.random().toString(36).slice(2, 8), ...schedule, fired_on: null };
  schedules.push(sch);
  saveSchedules();
  pushSoon();
  res.json({ ok: true, schedule: { ...sch, says: scheduleSays(sch) } });
});

app.patch('/api/schedules/:id', (req, res) => {
  const sch = schedules.find(s => s.id === req.params.id);
  if (!sch) return res.status(404).json({ ok: false, error: 'No such schedule' });
  const { error, schedule } = readSchedule(req.body || {}, sch);
  if (error) return res.status(400).json({ ok: false, error });
  /* Changing when it runs clears the fired-guard, or moving a schedule later
     the same day would leave it unable to run until tomorrow. */
  const moved = schedule.at !== sch.at;
  Object.assign(sch, schedule);
  if (moved) sch.fired_on = null;
  delete sch.last_error;
  saveSchedules();
  pushSoon();
  res.json({ ok: true, schedule: { ...sch, says: scheduleSays(sch) } });
});

app.delete('/api/schedules/:id', (req, res) => {
  const i = schedules.findIndex(s => s.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, error: 'No such schedule' });
  const [gone] = schedules.splice(i, 1);
  saveSchedules();
  pushSoon();
  res.json({ ok: true, removed: gone.id });
});

/** Run one now, without waiting for its time — the way you check you meant it. */
app.post('/api/schedules/:id/run', async (req, res) => {
  const sch = schedules.find(s => s.id === req.params.id);
  if (!sch) return res.status(404).json({ ok: false, error: 'No such schedule' });
  try {
    await runSchedule(sch);
    res.json({ ok: true, spoken: `Ran ${scheduleSays(sch)}` });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/api/scenes/:id/apply', async (req, res) => {
  const scene = scenes.find(sc => sc.id === req.params.id);
  if (!scene) return res.status(404).json({ ok: false, error: 'No such scene' });
  try {
    const result = await fireCue(scene);
    res.json({ ok: true, scene: scene.name, ...result, synced_at: hubSync.taken });
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
    res.json({ ok: true, scene: snap.name, ...result, synced_at: hubSync.taken });
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
      synced_at: hubSync.taken,
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
      synced_at: hubSync.taken,
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

/* ======================================================================= /do
 *
 * One address for everything, so a shortcut is a URL you can type from memory:
 *
 *     /do/<room>/<circuit>/<action>          /do/ashu/fan/on
 *     /do/<room>/<action>                    /do/ashu/off          (the whole room)
 *     /do/cue/<id>                           /do/cue/movie-night
 *
 * Every part is a slug of the name the dashboard already shows, matched on a
 * unique prefix — `/do/ashu/foot/off` reaches ASHU ROOM's FOOT LIGHT. That
 * matters more than it sounds: a shortcut is built once and lives on a Home
 * Screen for years, so the address has to be guessable and must not move.
 *
 * GET works everywhere, because a widget, a Back Tap or a bookmark can only
 * manage a GET, and every reply carries `spoken` for Siri to read back.
 */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// How far one press of "down" moves things. A press should be worth pressing —
// 10% is invisible, 33% overshoots — and 20 divides the range evenly.
const STEP = 20;
const TUNE_STEP = 15;

const ACTIONS = ['on', 'off', 'toggle', 'up', 'down', 'warmer', 'cooler', 'warm', 'cool',
                 'open', 'close', 'stop', '0-100', 'warmth-0-100'];

// A bare number is a brightness, because that is what a number means to anyone
// typing one. Colour has to say so: `warmth-60`, and `tune-60` for the field
// name the hub itself uses.
const WARMTH = /^(?:warmth|tune)-(\d{1,3})$/;
const isAction = (word) => ACTIONS.includes(word) || /^\d{1,3}$/.test(word) || WARMTH.test(word);

/** Rooms as addresses, with `house` meaning all of them. */
function roomsIndex() {
  const out = new Map();
  for (const { room } of devices.values()) {
    const key = roomKey(room);
    // ASHU ROOM answers to `ashu-room`, and to `ashu` as a prefix.
    if (!out.has(slug(key))) out.set(slug(key), key);
  }
  return out;
}

/** Matches a slug exactly, then as a unique prefix. Ambiguity is an error, not a guess. */
function pick(want, candidates) {
  const exact = candidates.filter(c => c.slug === want);
  if (exact.length === 1) return { hit: exact[0] };
  const near = candidates.filter(c => c.slug.startsWith(want));
  if (near.length === 1) return { hit: near[0] };
  if (near.length > 1) return { ambiguous: near.map(c => c.slug) };
  return { none: true };
}

/** Every circuit of a room, plus the collective names worth having. */
function circuitsOf(roomName) {
  const here = [...devices.values()]
    .filter(({ room }) => roomKey(room) === roomName)
    .map(({ record }) => record);

  const isFan = (r) => r.isFan === 'true' || /\bFAN\b/i.test(String(r.device_name || ''));
  const isLight = (r) => (r.app_type || 'L') === 'L' && !isFan(r);

  const groups = [
    { slug: 'all', label: 'everything', records: here.filter(r => (r.app_type || '') !== 'C') },
    { slug: 'lights', label: 'the lights', records: here.filter(isLight) },
    { slug: 'cobs', label: 'the COBs', records: here.filter(r => /^COB\b/i.test(String(r.device_name || '').trim())) },
  ].filter(g => g.records.length > 1);          // a group of one is just the circuit

  // The hub writes one label with full stops in it — T.V — and `t-v` is not an
  // address anybody would guess, so the stops come out before slugging.
  const singles = here.map(rec => ({
    slug: slug(String(rec.device_name).replace(/\./g, '')),
    label: String(rec.device_name).trim().toLowerCase(), records: [rec],
  }));
  return [...groups, ...singles];
}

/** Where a set of circuits stands now, from the cache. */
const levelOf = (records) => Math.round(
  records.reduce((s, r) => s + decodeLevel(r.device_status), 0) / records.length);
const tuneOf = (records) => {
  const tunable = records.filter(r => r.is_tunable === 'true');
  return tunable.length
    ? Math.round(tunable.reduce((s, r) => s + decodeLevel(r.device_status_tunable), 0) / tunable.length)
    : null;
};

/**
 * Turns an action word into what to send.
 *
 * `up`/`down` are the ones worth having: "turn the brightness down" is a thing
 * you do repeatedly, and one shortcut you press three times beats three
 * shortcuts naming fixed levels. They read the current level from the cache,
 * so the reading has to be current — the caller refreshes first.
 */
function resolveAction(word, records) {
  if (/^\d{1,3}$/.test(word)) return { level: pct(word) };
  const warmth = word.match(WARMTH);
  if (warmth) return { tune: pct(warmth[1]) };
  const dims = records.some(r => r.is_dimmable === 'true');
  const now = levelOf(records);

  switch (word) {
    case 'on': return { on: true };
    case 'off': return { on: false };
    case 'toggle': return { on: !(now > 0) };
    // On a plain switch there is no middle, so up and down are simply on and off.
    case 'up': return dims ? { level: Math.min(100, (now || 0) + STEP) } : { on: true };
    case 'down': return dims ? { level: Math.max(0, now - STEP) } : { on: false };
    case 'warmer': return { tune: Math.min(100, (tuneOf(records) ?? 50) + TUNE_STEP) };
    case 'cooler': return { tune: Math.max(0, (tuneOf(records) ?? 50) - TUNE_STEP) };
    case 'warm': return { tune: 85 };
    case 'cool': return { tune: 15 };
    default: return null;
  }
}

/** What the reply says out loud. Kept short: Siri reads it aloud. */
function spokenFor(label, where, sent) {
  const place = where === 'HOUSE' ? '' : ' in ' + title_(where);
  if (sent.on === false) return label + place + ' off';
  // A compound command has to say both halves, or a command that did two
  // things reports one and sounds like it half worked.
  const did = [];
  if (sent.level != null) did.push('at ' + sent.level + '%');
  else if (sent.on === true) did.push('on');
  if (sent.tune != null) did.push('set to ' + warmthName(sent.tune));
  return did.length ? label + place + ' ' + did.join(' and ') : label + place + ' set';
}

// 0 is cool and 100 is warm on this hub, so the number is meaningless spoken
// aloud. Siri says the colour instead.
const warmthName = (t) =>
  t < 20 ? 'cool' : t < 42 ? 'soft white' : t < 64 ? 'neutral' : t < 84 ? 'warm' : 'candle';
const title_ = (s) => String(s).toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());

/** The whole map, so you can see every address you can type. */
app.get('/do', (req, res) => {
  const rooms = [...roomsIndex()].map(([sl, name]) => ({
    room: sl,
    circuits: circuitsOf(name).map(c => c.slug),
  }));
  res.json({
    shape: ['/do/<room>/<circuit>/<action>', '/do/<room>/<action>', '/do/cue/<id>'],
    actions: ACTIONS,
    rooms,
    cues: scenes.map(sc => sc.id),
    examples: ['/do/ashu/fan/on', '/do/ashu/cobs/down', '/do/ashu/cobs/warmth-70',
               '/do/living/main-curtain/open', '/do/master/off', '/do/house/off',
               '/do/cue/movie-night'],
  });
});

/** One room's addresses, with what each circuit is doing right now. */
app.get('/do/:room', (req, res, next) => {
  const want = slug(req.params.room);
  if (want === 'cue') return next();
  const found = pick(want, [...roomsIndex()].map(([sl, name]) => ({ slug: sl, name })));
  if (!found.hit) {
    return res.status(found.ambiguous ? 300 : 404).json({
      ok: false, error: found.ambiguous ? 'That could be more than one room' : 'No such room',
      known: found.ambiguous || [...roomsIndex().keys()],
    });
  }
  res.json({
    room: found.hit.slug,
    circuits: circuitsOf(found.hit.name).map(c => ({
      circuit: c.slug,
      level: levelOf(c.records),
      tune: tuneOf(c.records),
      circuits: c.records.length,
    })),
  });
});

app.all('/do/cue/:id', async (req, res) => {
  if (!keyOk(req)) return res.status(403).json({ ok: false, error: 'Wrong key' });
  const scene = scenes.find(sc => sc.id === req.params.id);
  if (!scene) return res.status(404).json({ ok: false, error: 'No such cue', known: scenes.map(sc => sc.id) });
  try {
    const result = await fireCue(scene);
    res.json({ ok: true, ...result, spoken: result.missed
      ? scene.name + ' set, but ' + result.missed + ' did not take' : scene.name + ' set' });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message, spoken: 'The hub did not answer' });
  }
});

// /do/<room>/<action> — the whole room, and the one you reach for at the door.
app.all('/do/:room/:action', (req, res) =>
  runAddress(req, res, req.params.room, 'all', req.params.action));

app.all('/do/:room/:circuit/:action', (req, res) =>
  runAddress(req, res, req.params.room, req.params.circuit, req.params.action));

/* Two things at once: `/do/ashu/cobs/40/warm`.
 *
 * Brightness and colour go down separate channels anyway, so setting both in
 * one address costs nothing and saves the thing you actually want — a lamp
 * that comes on at the level *and* the colour you meant, rather than at the
 * level and then, a second later, the colour. Both spellings work, because a
 * URL wants segments and the command bar wants spaces:
 *   /do/ashu/cobs/40/warm   and   /do/ashu/cobs/40+warm */
app.all('/do/:room/:circuit/:action/:also', (req, res) =>
  runAddress(req, res, req.params.room, req.params.circuit,
             req.params.action + '+' + req.params.also));

async function runAddress(req, res, roomWord, circuitWord, actionWord) {
  if (!keyOk(req)) return res.status(403).json({ ok: false, error: 'Wrong key' });
  // Split before slugging, not after: slug() turns every run of punctuation
  // into a hyphen, so a '+' joiner would be eaten and `40+warm` would arrive
  // as the single nonsense word `40-warm`.
  const words = String(actionWord).toLowerCase().split(/[+,]/).map(slug).filter(Boolean);
  const action = words.join('+');
  if (!words.length || words.length > 2 || !words.every(isAction)) {
    return res.status(404).json({ ok: false, error: 'No such action', known: ACTIONS,
      spoken: 'I do not know how to do that' });
  }

  // A room named `house` reaches the whole place.
  const wantRoom = slug(roomWord);
  const index = roomsIndex();
  let roomName = null;
  if (wantRoom === 'house' || wantRoom === 'everywhere') roomName = 'HOUSE';
  else {
    const found = pick(wantRoom, [...index].map(([sl, name]) => ({ slug: sl, name })));
    if (!found.hit) {
      return res.status(found.ambiguous ? 300 : 404).json({
        ok: false, error: found.ambiguous ? 'That could be more than one room' : 'No such room',
        known: found.ambiguous || [...index.keys()], spoken: 'I do not know that room' });
    }
    roomName = found.hit.name;
  }

  // A relative or toggling action is only as good as its reading of now.
  if (words.some(w => ['toggle', 'up', 'down', 'warmer', 'cooler'].includes(w))
      && (!hubSync.taken || Date.now() - hubSync.taken > 4000)) {
    await readHubStateFresh().catch(() => {});
  }

  let target;
  if (roomName === 'HOUSE') {
    const all = [...devices.values()].map(({ record }) => record);
    target = { slug: 'all', label: 'Everything',
      records: all.filter(r => (r.app_type || '') !== 'C') };
  } else {
    const found = pick(slug(circuitWord), circuitsOf(roomName));
    if (!found.hit) {
      return res.status(found.ambiguous ? 300 : 404).json({
        ok: false, error: found.ambiguous ? 'That could be more than one circuit' : 'No such circuit here',
        known: found.ambiguous || circuitsOf(roomName).map(c => c.slug),
        spoken: 'I cannot find that one' });
    }
    target = found.hit;
  }
  const label = target.label.charAt(0).toUpperCase() + target.label.slice(1);

  // A curtain reads its verb out of opr_param and ignores everything else, so
  // it takes a different road entirely — and it can only be told open, close
  // or stop, never a level.
  const curtains = target.records.filter(r => (r.app_type || '') === 'C');
  if (curtains.length) {
    if (words.length > 1 || !CURTAIN_VERB[action]) {
      return res.status(400).json({ ok: false, error: 'A curtain takes open, close or stop',
        spoken: 'A curtain only opens, closes or stops' });
    }
    try {
      for (const rec of curtains) await sendToHub(rec.record_id, {}, CURTAIN_VERB[action]);
      return res.json({ ok: true, room: roomName, circuit: target.slug, action,
        count: curtains.length, spoken: label + ' ' + (action === 'stop' ? 'stopped' : action) });
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message, spoken: 'The hub did not answer' });
    }
  }

  // Merged in the order they were typed, so the later word wins where they
  // disagree. `40+warm` is a level and a colour, which do not collide at all.
  let sent = null;
  for (const w of words) {
    const part = resolveAction(w, target.records);
    if (!part) { sent = null; break; }
    sent = { ...(sent || {}), ...part };
  }
  if (!sent) {
    return res.status(400).json({ ok: false, error: 'That action does not apply here',
      spoken: 'That does not apply here' });
  }
  // Only some lamps have a second channel. Asking the rest for a colour would
  // otherwise report a cheerful success having sent nothing at all.
  if (sent.tune != null && !target.records.some(r => r.is_tunable === 'true')) {
    return res.status(400).json({ ok: false, error: label + ' does not tune',
      spoken: label + ' cannot change colour' });
  }

  try {
    const wrote = await setRecords(target.records, sent);
    res.json({ ok: true, room: roomName === 'HOUSE' ? 'house' : slug(roomName),
      circuit: target.slug, action, count: target.records.length, sent: wrote,
      ...sent, spoken: spokenFor(label, roomName, sent) });
  } catch (err) {
    console.error(`do ${roomName}/${target.slug}/${action} failed:`, err.message);
    res.status(502).json({ ok: false, error: err.message, spoken: 'The hub did not answer' });
  }
}

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
  // Colour temperature applied as a tunable light switches on. Off by default
  // (the user's call, 2026-08-14): a lamp comes on at the colour it was left,
  // which is the least surprising thing a lamp can do. The switch stays on the
  // settings rail for anyone who wants the hour to decide.
  circadian: { on: false },
  // Which of data/backdrops/ is showing. null keeps the original file.
  backdrop: null,
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
      backdrop: typeof saved.backdrop === 'string' ? saved.backdrop : null,
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
  loadSchedules();
  readHubState().then((s) =>
    console.log(s.ok ? 'Live device status read from hub' : `Using snapshot status (${s.error})`));

  // One reader for the whole house, however many browsers are open. Keeps the
  // cache fresh enough that a page load never waits on the hub.
  setInterval(() => { if (!reading) readHubState(); }, REFRESH_MS);

  /* Every 20s is enough for minute precision and cheap enough to ignore. The
     tick is what replaces the hub's own scheduler, which is dead server-side —
     and it only works at all because this process now lives on the hub, the one
     machine in the house that is always awake. */
  scheduleTimer = setInterval(() => { tickSchedules().catch(() => {}); }, 20000);
  tickSchedules().catch(() => {});
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
<!-- No zoom. This is an app, not a document: a pinch on a board of switches
     is always an accident, and a mis-hit that leaves the page at 1.4x with the
     thumb bar off screen is worse than anything zoom buys here. iOS ignores
     user-scalable in Safari but honours it once the page is installed to the
     Home Screen, and the gesturestart handler below covers the rest. -->
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#f3ede3">
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
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500&family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    /* Paper over a photograph. The interface is warm white and ink; the only
       colour is a lamp's own, and the one coral the numbers are set in.
       Everything that measures or labels is monospaced and upper case, so the
       serif is reserved for the two places the house actually speaks. */
    /* Frosted, not opaque. The cards are warm white but you can see the
       photograph through them — which is the whole reason the backdrop is
       load-bearing. Alpha here, blur in --lens, and the two together are what
       make a card read as glass laid on a picture rather than paper over it. */
    /* Raised from .66/.72 when the cream veil came off the photograph. The
       contrast a pane needs has to be made in the pane; with a colourful
       picture behind it the fill genuinely does move the composite, which is
       not true over a flat field of the same luminance. */
    --paper:   rgba(253,250,245,.80);
    --paper-2: rgba(246,239,227,.84);
    --ink:     #2b2622;
    /* The ground under everything, and the colour ink is reversed out to.
       This went missing in the move to paper: --base was still referenced in
       six places and defined in none, so every var(--base) was invalid and
       fell back to inherited colour — which is how the primary button in the
       cue sheet ended up as ink on ink, and the checkmark in a picker was
       drawn in the same colour as the box behind it. Invisible rather than
       wrong, which is why it survived a sweep. */
    --base:    #f4efe6;
    --soft:    #6b635a;
    --faint:   #9a9187;
    --line:    rgba(43,38,34,.10);
    --line-up: rgba(43,38,34,.20);

    /* A lit circuit is warm paper, not a glow: the light is in the fill. */
    /* ── the colour of on ────────────────────────────────────────────────
       These were sand, haze and oatmeal: correct as *paper* colours and
       useless as a signal, because a lit tile mixed from them landed within a
       few levels of the unlit glass beside it. On has to contrast, not blend.
       Amber against cold glass is the contrast the house actually makes — and
       the hue still carries its meaning, so a lamp tuned to daylight glows
       blue and one at candle glows orange, side by side.
       --neutral covers the things that emit nothing at all (a fan, a curtain,
       a screen); it is a definite slate rather than a shade of the paper, or
       a fan that is running looks exactly like one that is not. */
    --warm:   #f2a233;
    --cool:   #7fb2e0;
    --neutral:#9fb0bd;
    --clay:   #c8553d;
    --accent: #e0574a;

    --pane:      rgba(253,250,245,.86);
    --pane-up:   rgba(253,250,245,.96);
    --edge:      rgba(43,38,34,.09);
    --edge-up:   rgba(43,38,34,.18);
    --lip:       rgba(255,255,255,.9);
    --lens: blur(22px) saturate(148%) brightness(1.08);
    --lens-up: blur(24px) saturate(152%) brightness(1.10);
    --sheen: none;
    --cast: 0 18px 40px -22px rgba(58,44,30,.42), 0 3px 10px -5px rgba(58,44,30,.18);
    --halo: none;

    --sans: "Hanken Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --display: "Instrument Serif", ui-serif, Georgia, serif;
    /* The utility voice: ids, states, counts, anything the house reports. */
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

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

  /* ── nothing here is prose, so nothing here selects ──────────────────────
     A tile is a switch whose face happens to carry words. Tapping one used to
     select the label, and the phone then drew its own selection handles over
     the page — the stray glyphs that appeared behind the panes — and a drag
     across the board smeared a selection instead of turning the page. The
     tap highlight goes with it: a grey rectangle flashing inside a rounded
     glass pane is the one thing the material cannot survive.
     Selection stays where it is genuinely wanted: real inputs, and the cue id
     you are meant to copy into Shortcuts. */
  button, .tile, .cue, .tab, .seg, .key, .pull, .step, .setting, .nudge,
  .glance, .quick, .plate, .legend, .group-label, .tile-name, .tile-read,
  .hero, .field-head, .warmth, .slider, .sheet-row, .pick {
    -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  }
  * { -webkit-tap-highlight-color: transparent; }
  input, textarea, [contenteditable] {
    -webkit-user-select: text; user-select: text;
  }
  .sheet-api { -webkit-user-select: all; user-select: all; }

  /* Glass needs something behind it to bend. A slow tonal shift across the room
     gives the panes depth without adding a single visible edge. */
  /* The photograph itself. Held still while the page scrolls, so the glass
     slides over it rather than dragging it along. */
  .lensdef { position: fixed; width: 0; height: 0; pointer-events: none; }

  .photo {
    position: fixed; inset: 0; z-index: 0; pointer-events: none;
    /* The photograph sits on top; the painted scene below it is what shows if
       there is no file yet, and it is built to be worth looking at on its own —
       a warm wash from a window, a lamp pool low and right, and soft vertical
       masses standing in for curtains and a doorway, so the glass always has
       structure to bend even before a picture is dropped in. */
    background-image:
      var(--shot),
      radial-gradient(58% 44% at 12% 6%,   rgba(196,216,238,.22) 0%, transparent 68%),
      radial-gradient(46% 40% at 88% 88%,  rgba(176,200,226,.18) 0%, transparent 66%),
      linear-gradient(102deg, transparent 10%, rgba(226,238,250,.05) 13%, transparent 17%),
      linear-gradient(96deg,  transparent 46%, rgba(226,238,250,.06) 52%, transparent 58%),
      linear-gradient(88deg,  transparent 78%, rgba(226,238,250,.04) 82%, transparent 86%),
      radial-gradient(120% 100% at 50% 50%, #26303b 0%, #161c24 62%, #0c1014 100%);
    background-size: cover, auto, auto, auto, auto, auto, auto;
    /* A wide screen sees only a horizontal band of this tall picture, so it
       is told which band: high in the frame is all warm rock, and the page
       then reads amber-on-amber. Half way down catches the meadow and the
       tree line, where a lamp is once again the warmest thing on screen.
       On a phone the crop is horizontal instead, so this changes nothing there. */
    background-position: center 52%;
    background-repeat: no-repeat;
    /* Brought forward deliberately. This sat at brightness .50 under a veil
       that reached .70 black at the top, which left about 15% of the picture
       showing there and under half of it through the middle — and a pane can
       only ever show what is behind it, so refracting near-black gave back
       near-black and every change to the glass looked like no change at all.
       The old note about the backdrop washing the page out was written when
       the panes were opaque paint; they are lenses now, and they need
       something to bend. */
/* Brightness is not a constant, because a photograph is not a constant:
       the fog measures 153 mean luminance, the glacier 171, an alpenglow
       ridge far less. The page sets --shot-dim from the picture itself, so
       any photograph — including one just taken on a phone — lands at a
       luminance the white type and the lamps can live with. */
    /* Saturation left alone. It was pulled down to .86 when the panes were
       opaque paint and every colour in the picture competed with them; the
       panes make their own contrast now, so desaturating the photograph only
       makes the page beige. The whole claim of the design is that the only
       colour is the light a lamp is making — but that is about the *chrome*
       being neutral, not about the photograph being drained. */
    filter: saturate(1.04) brightness(var(--shot-dim, 1)) contrast(1.02);
    /* A slight push in, and no more. The 1.30 here was for an earlier
       photograph with an apartment block at each edge — one of them drew a
       faint vertical line straight through the hero text — and on this picture
       all it did was crop away the greens and leave a wide screen looking at
       haze. Enough to lose the frame edges, not enough to lose the subject. */
    transform: scale(1.06);
  }
  /* A vignette and a floor-to-ceiling fade, so panes never sit on a hotspot. */
  .photo::after {
    content: ''; position: absolute; inset: 0;
    background:
      /* This was a sheet of cream laid over the whole picture, .42 at the top
         and never below .14 — which is the exact thing the light-mode attempt
         proved wrong and this file already records: **a white veil over the
         backdrop is frosting, not glass**. It drained the photograph to make
         ink readable, when the contrast ink needs has to be made *inside* the
         pane. The panes carry it now, so all that is left here is a vignette
         that keeps the corners from being the brightest thing on screen, and
         a small hold at the two edges where chrome actually sits. */
      linear-gradient(180deg,
        rgba(252,248,241,.20) 0%, rgba(252,248,241,.06) 12%,
        transparent 34%, transparent 72%,
        rgba(252,248,241,.08) 88%, rgba(252,248,241,.18) 100%),
      radial-gradient(140% 100% at 50% 42%, transparent 46%, rgba(30,26,22,.20) 100%);
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
      linear-gradient(180deg, rgba(255,252,246,.10) 0%, transparent 40%, rgba(120,96,64,.05) 100%);
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
    backdrop-filter: var(--lens);
    -webkit-backdrop-filter: var(--lens);
  }
  .seek-toggle svg { width: 16px; height: 16px; }
  .seek-toggle:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }

  /* The field's own styling lives further down, with the rest of the command
     bar. What used to be here was the pre-redesign version — a bordered box
     with its own backdrop-filter — and two parts of it were still landing:
     the filter, which lifted its own rectangle a shade brighter than the pill
     it sits in and drew a second box around the placeholder, and a :focus rule
     that put the background back the moment you clicked in. Its descendant
     svg rule also out-specified .seek-glyph and threw the search mark out of
     the flex row. Deleted rather than overridden: half-live dead CSS is worse than
     none. */

  /* Everything off is a big, irreversible thing, so it is held rather than tapped. */
  .main {
    position: relative; flex: 0 0 auto; padding: 10px 16px; cursor: pointer; overflow: hidden;
    display: flex; align-items: center; gap: 8px;
    background: var(--pane); border: 1px solid var(--edge); border-radius: 12px;
    backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
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
  /* The board leads and the column sits to its right. The room list that used
     to live there is gone on a wide screen: the bars in the hero card and the
     room cards under them are both navigation, and a third list of the same
     seven names was only ever a third chance to click the same thing. */
  .board { flex: 1; min-height: 0; display: grid; gap: clamp(18px, 2.2vw, 32px);
           grid-template-columns: 1fr clamp(230px, 21vw, 300px); }
  .field { order: 1; }
  .index { order: 2; }
  .index { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 26px;
           overflow-y: auto; scrollbar-width: thin;
           scrollbar-color: rgba(255,255,255,.16) transparent; }
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
    backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
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
  .field-head[hidden] { display: none; }
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
    backdrop-filter: var(--lens);
    -webkit-backdrop-filter: var(--lens);
    transition: color .18s, border-color .18s, background .18s, transform .18s;
  }
  .back[hidden] { display: none; }
  .back svg { width: 14px; height: 14px; }
  .back:hover { color: var(--ink); border-color: var(--edge-up); background: var(--pane-up); transform: translateX(-2px); }
  .back:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }
  .field-head h2 {
    margin: 0; font-size: clamp(24px, 3.6vh, 34px); font-weight: 400; text-shadow: var(--halo);
    letter-spacing: -.018em; line-height: 1.1;
  }
  .field-sub { margin: 5px 0 3px; font-size: 13px; color: var(--soft); text-shadow: var(--halo); }
  .field-sub b { color: var(--soft); font-weight: 500; }
  .cut {
    margin-left: auto; flex: 0 0 auto; padding: 9px 14px; cursor: pointer;
    background: var(--pane); border: 1px solid var(--edge); border-radius: 11px;
    backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
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
    grid-template-columns: repeat(auto-fill, minmax(206px, 1fr)); min-width: 0;
    grid-auto-rows: min-content;
    scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.14) transparent;
  }
  .tiles::-webkit-scrollbar { width: 8px; }
  .tiles::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 4px; }
  .tiles::-webkit-scrollbar-track { background: transparent; }
  /* The command row. It is not a search result, so it does not look like one:
     wider, warmer at the rim, and carrying the return key it answers to. */
  .cmd {
    grid-column: 1 / -1; display: flex; align-items: center; gap: 14px;
    width: 100%; padding: 14px 16px; margin-bottom: 4px; cursor: pointer;
    font: inherit; text-align: left; color: var(--ink);
    border: 1px solid color-mix(in oklab, var(--accent) 42%, var(--edge));
    border-radius: 15px; background: var(--pane);
    backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
    box-shadow: var(--cast);
    transition: border-color .2s, transform .16s, opacity .2s;
  }
  .cmd:hover { transform: translateY(-1px); border-color: var(--accent); }
  .cmd:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cmd.running { opacity: .55; }
  .cmd-says { flex: 1 1 auto; font-size: 14.5px; }
  .cmd-key {
    flex: 0 0 auto; padding: 3px 9px; border-radius: 7px;
    border: 1px solid var(--edge); color: var(--soft); font-size: 12px;
  }
  .cmd-bad { cursor: default; border-color: var(--edge); color: var(--faint); }
  .cmd-bad:hover { transform: none; border-color: var(--edge); }

  /* The next word, offered. One row, wrapping, led by what the row *is* —
     'room', 'circuit or action' — because a bare list of words does not say
     which slot it is filling. */
  .chips {
    grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    margin: 0 0 10px;
  }
  .chips-lead {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .07em;
    text-transform: uppercase; color: var(--faint); margin-right: 3px;
    white-space: nowrap; flex: 0 0 auto;
  }
  .chip-word {
    padding: 5px 10px; cursor: pointer; border-radius: 8px;
    font-family: var(--mono); font-size: 11px; letter-spacing: .03em; color: var(--soft);
    background: var(--paper-2); border: 1px solid var(--line);
    transition: color .18s, background .18s, border-color .18s,
                transform .24s cubic-bezier(.22,.94,.3,1);
  }
  .chip-word:hover { color: var(--ink); border-color: var(--line-up); background: var(--paper); }
  .chip-word:active { transform: scale(.93); transition-duration: .06s; }
  .chip-word:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* The picker shows the photographs at a size worth judging them at — a
     backdrop chosen from a postage stamp is chosen blind. */
  .bgsheet { max-width: 720px; }
  .bggrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
  .bgshot {
    position: relative; aspect-ratio: 16 / 10; cursor: pointer; overflow: hidden;
    padding: 0; border-radius: 14px; border: 1px solid var(--edge);
    background-size: cover; background-position: center; background-color: var(--paper-2);
    transition: border-color .2s, transform .16s;
  }
  .bgshot:hover { transform: translateY(-2px); }
  .bgshot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .bgshot.on { border-color: var(--accent); }
  .bgshot .tag {
    position: absolute; left: 8px; bottom: 8px; padding: 3px 8px; border-radius: 7px;
    font-size: 11.5px; color: var(--ink); background: rgba(250,246,239,.88);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  }
  .bgshot .drop {
    position: absolute; right: 6px; top: 6px; width: 24px; height: 24px; padding: 0;
    border-radius: 8px; border: 1px solid var(--edge); cursor: pointer;
    color: var(--soft); background: rgba(250,246,239,.88); font: inherit; font-size: 13px;
    opacity: 0; transition: opacity .18s, color .18s;
  }
  .bgshot:hover .drop, .bgshot .drop:focus-visible { opacity: 1; }
  .bgshot .drop:hover { color: var(--clay); }
  .bgadd { cursor: pointer; }

  /* A column that scrolls with no scrollbar and a hard edge looks like a
     column that ends there. These fade only on the side that actually has more
     to see, so the page never suggests movement that is not available. */
  .index[data-more], .tiles[data-more] {
    -webkit-mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 34px), transparent 100%);
    mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 34px), transparent 100%);
  }
  .index[data-less][data-more], .tiles[data-less][data-more] {
    -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 26px, #000 calc(100% - 34px), transparent 100%);
    mask-image: linear-gradient(180deg, transparent 0, #000 26px, #000 calc(100% - 34px), transparent 100%);
  }
  .index[data-less]:not([data-more]), .tiles[data-less]:not([data-more]) {
    -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 26px);
    mask-image: linear-gradient(180deg, transparent 0, #000 26px);
  }

  /* The same statement, sideways. The rooms, cues and settings rails scroll
     horizontally with the scrollbar hidden, so a chip sliced off at the right
     edge read as the end of the list rather than the middle of it — on a phone
     that is most of them. Same rule as the columns: fade only the side that
     actually has more behind it. */
  [data-more-x] {
    -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 30px), transparent 100%);
    mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 30px), transparent 100%);
  }
  [data-less-x][data-more-x] {
    -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 30px), transparent 100%);
    mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 30px), transparent 100%);
  }
  [data-less-x]:not([data-more-x]) {
    -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 22px);
    mask-image: linear-gradient(90deg, transparent 0, #000 22px);
  }

  /* ── the paper redesign ────────────────────────────────────────────────
     Cards are warm white with a hairline, not glass with a rim. A lit circuit
     fills with its own colour from the left, so brightness is a quantity you
     can see across the room rather than a glow. Everything that measures —
     ids, states, counts, room labels — is monospaced and upper case; the
     serif is kept for the two places the house speaks in sentences. */
  .mono, .idline, .state, .chip, .barlabel, .strip-label {
    font-family: var(--mono); text-transform: uppercase;
    letter-spacing: .07em; font-size: 10.5px; color: var(--faint);
  }

  /* the hero card: what the house is doing, said once */
  .saycard {
    grid-column: 1 / -1; padding: 20px 22px 16px; margin-bottom: 2px;
    background: var(--paper); border: 1px solid var(--line); border-radius: 22px;
    box-shadow: var(--cast);
    backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
  }
  .saycard .say {
    margin: 0; font-family: var(--display); font-weight: 400;
    font-size: clamp(26px, 3.4vw, 40px); line-height: 1.12; color: var(--ink);
    letter-spacing: -.005em;
  }
  .saycard .say b { font-weight: 400; font-style: italic; color: var(--accent); }

  /* one column per room: height for how much light, colour for how warm */
  .bars { display: flex; gap: clamp(6px, 1vw, 14px); margin-top: 14px; align-items: flex-end; }
  .barcol { flex: 1 1 0; min-width: 0; background: none; border: 0; padding: 0;
            cursor: pointer; font: inherit; text-align: left; }
  .barwell { height: 38px; display: flex; align-items: flex-end; }
  .bar {
    width: 100%; border-radius: 5px; background: var(--tint, var(--warm));
    min-height: 3px; transition: height .5s cubic-bezier(.3,.8,.3,1), background .5s;
  }
  .barcol:not(.on) .bar { background: var(--line-up); }
  .barlabel { display: block; margin-top: 7px; overflow: hidden; text-overflow: ellipsis;
              white-space: nowrap; }
  .barcol.on .barlabel { color: var(--soft); }

  /* a room, as a card that states its own reading */
  .tile[data-room] { display: flex; flex-direction: column; }
  .tile[data-room] .tile-body {
    position: static; align-items: stretch; justify-content: flex-start; gap: 0;
    padding: 15px 16px 14px; width: 100%; height: 100%; box-sizing: border-box;
  }
  /* Every card carries a wash, faint when dark and its own colour when lit, so
     the grid reads as paper with light soaked into it rather than a set of
     empty boxes. */
  .tile[data-room]::before {
    content: ''; position: absolute; inset: 0; z-index: 0; border-radius: inherit;
    background: linear-gradient(104deg, rgba(246,239,227,.5) 0%, rgba(255,255,255,0) 72%);
    pointer-events: none;
  }
  .tile[data-room] .tile-body, .tile[data-room] .tile-fill { z-index: 1; }
  .roomhead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  /* The button is the fixed thing here; the title is what gives. Without this
     'ALL COBS · 5 ON ONE MODULE' simply ran underneath it on a phone. */
  .roomhead .gangtitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .roomhead .gangsame { flex: 0 0 auto; }
  .roomname { font-family: var(--mono); text-transform: uppercase; letter-spacing: .06em;
              font-size: 12px; color: var(--ink); }
  /* All-off is pinned to the top-right corner of a room card, so the name has
     to end before it starts. Without this the two simply overlapped once the
     columns narrowed — a tablet showed PAREN[ALL OFF] — and a name that runs
     under a button is worse than one that admits it was cut. */
  .tile[data-room] .roomname {
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    /* Never the thing that gives. The card is a flex column, so when the tile
       was squeezed the name — having no intrinsic height to defend — was the
       item flexbox chose to crush to nothing, and a room card was left showing
       a percentage with no room attached to it. */
    flex: 0 0 auto;
  }
  /* Only when the chip is actually there. A dark room has no all-off to offer,
     so reserving the space anyway truncated names that had room to spare —
     LIV…, DIN…, MAS… with half the card empty beside them. */
  .tile[data-room]:has(.chip:not([hidden])) .roomname { padding-right: 46px; }
  .tile.hero-room:has(.chip:not([hidden])) .roomname { padding-right: 78px; }
  .chip {
    position: absolute; top: 13px; right: 13px; z-index: 3; cursor: pointer;
    padding: 4px 9px; border: 1px solid var(--line); border-radius: 999px;
    background: var(--paper); color: var(--soft);
    transition: color .18s, border-color .18s, background .18s;
  }
  .chip:hover { color: var(--ink); border-color: var(--line-up); }
  .chip[hidden] { display: none; }
  /* The reading sits under the name with air, not adrift at the foot of an
     empty card — a room card is a label and a number, and the reference reads
     as one block for that reason. */
  .big { font-family: var(--display); font-size: clamp(26px, 3.1vw, 36px); line-height: 1;
         color: var(--ink); margin-top: 18px; }
  .big.dark { color: var(--soft); }
  .sub { font-family: var(--mono); font-size: 10.5px; letter-spacing: .06em;
         text-transform: uppercase; color: var(--faint); margin-top: 5px; }

  /* a circuit: what it is, what it is doing, and the ring you press */
  .idline { display: block; margin-top: 3px; }
  .state { display: block; margin-top: auto; color: var(--soft); }
  .ring {
    position: absolute; top: 14px; right: 14px; width: 20px; height: 20px; z-index: 4;
    border-radius: 50%; border: 1.5px solid var(--line-up); background: transparent;
    cursor: pointer; padding: 0; transition: background .25s, border-color .25s, box-shadow .25s;
  }
  .tile.on .ring { background: var(--tint); border-color: var(--tint);
                   box-shadow: 0 0 0 4px color-mix(in oklab, var(--tint) 22%, transparent); }

  /* the strips: a control that says what it can and cannot know */
  .strip {
    position: relative; height: 46px; border-radius: 11px; overflow: hidden;
    border: 1px solid var(--line); background: var(--paper-2); cursor: pointer;
  }
  .strip + .strip { margin-top: 9px; }
  .strip-fill { position: absolute; inset: 0 auto 0 0; width: var(--at, 0%);
                background: var(--tint, var(--warm));
                transition: width .3s, background .4s, opacity .3s; }
  /* A dark lamp's warmth strip still shows the colour it is set to — that is
     what you are choosing while it is off — but at full strength a bank of
     unlit COBs was a wall of amber, which is precisely the signal that is
     supposed to mean something is burning. The *track* is what shouts, not
     the fill: the track carries the whole cool-to-warm scale whatever the
     lamp is doing, so it is the thing that has to stand down. */
  .tile:not(.on) .strip-fill { opacity: .30; }
  .tile:not(.on) .warmstrip { opacity: .38; }
  /* The label starts clear of where the knob rests. A dark lamp sits at 0, and
     that is most of the house most of the time, so the one position worth
     keeping uncluttered is the left end. Crossing the label mid-travel is
     unavoidable for a handle that runs the whole width — the label stands down
     while a drag is live instead. */
  .strip-label { position: absolute; left: 38px; top: 50%; transform: translateY(-50%);
                 z-index: 2; color: var(--ink); pointer-events: none;
                 transition: opacity .18s; }
  .strip.dragging .strip-label { opacity: .3; }
  /* A knob, not a hairline. This was a 2px rule the width of a pencil stroke:
     nothing to aim a thumb at, so a drag began by stabbing the track and the
     value jumped before the finger had hold of anything. It is a round handle
     now, light against the fill with a dark rim so it reads on the amber end
     and the cool end alike.
     The position is clamped rather than set straight to --at, because the strip
     clips its overflow to keep the fill inside those rounded ends — a knob at
     0% or 100% would be sliced in half by the very corner that makes the
     control look like a control. */
  .strip-hand {
    position: absolute; top: 50%; z-index: 2;
    left: clamp(13px, var(--at, 0%), calc(100% - 13px));
    width: 24px; height: 24px; margin-left: -12px; transform: translateY(-50%);
    border-radius: 50%; background: #fdfaf5;
    border: 1.5px solid color-mix(in oklab, var(--ink) 62%, transparent);
    box-shadow: 0 1px 3px rgba(43,38,34,.30), 0 4px 10px -4px rgba(43,38,34,.34);
    transition: transform .16s cubic-bezier(.22,.94,.3,1), border-color .2s;
  }
  .tile:not(.on) .strip-hand { border-color: color-mix(in oklab, var(--soft) 70%, transparent); }
  .strip input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0;
                 margin: 0; cursor: pointer; }

  /* the header, on paper */
  .plate {
    background: var(--paper); border: 1px solid var(--line); box-shadow: var(--cast);
    border-radius: 16px; padding: 10px 14px;
  }
  /* A rule after the name, the way a masthead sets a title off from what
     follows it. */
  .plate .stamp {
    padding-right: clamp(12px, 2vw, 22px); border-right: 1px solid var(--line);
  }
  .plate .stamp h1 {
    font-family: var(--display); font-weight: 400; font-size: 19px; letter-spacing: 0;
    color: var(--ink);
  }
  .plate .tally { font-family: var(--mono); font-size: 10.5px; letter-spacing: .06em;
                  text-transform: uppercase; color: var(--faint); }
  /* The field is the widest thing in the bar, because it is the fastest way to
     reach any of 88 circuits — and it takes commands as well as searches, so it
     had to stop looking like an afterthought bolted to the title. */
  /* ── the command bar ───────────────────────────────────────────────────
     It was bare text with a line of examples under it, clipped to an ellipsis
     mid-word — a control that looked like a caption and taught nothing. It is
     a pill now, and it teaches the grammar as you type instead of listing it:
     the rest of the word you are part-way through is drawn faintly under the
     caret, and Tab takes it. */
  .seek {
    position: relative;
    flex: 1 1 auto; min-width: 0; max-width: 520px;
    /* All-off used to hold the right end of the bar. With it gone the field
       centres in what is left rather than hanging off the title. */
    margin-left: clamp(10px, 1.6vw, 18px); margin-right: auto;
    display: flex; align-items: center; gap: 9px;
    padding: 8px 11px; height: auto;
    background: var(--paper-2); border: 1px solid var(--line); border-radius: 12px;
    transition: border-color .2s, background .2s, box-shadow .2s;
  }
  .seek:focus-within {
    border-color: var(--line-up); background: var(--paper);
    box-shadow: 0 0 0 3px rgba(43,38,34,.05);
  }
  .seek-glyph { flex: 0 0 auto; width: 15px; height: 15px; color: var(--faint); }
  .seek:focus-within .seek-glyph { color: var(--soft); }
  .seek-in { position: relative; display: flex; min-width: 0; flex: 1 1 auto; }
  .seek input {
    flex: 1 1 auto; min-width: 0; font-family: var(--sans); font-size: 14px; color: var(--ink);
    background: none; border: 0; outline: none; padding: 0;
    /* The field is the pill; the input inside it is only a caret and some
       glyphs. It was arriving with the generic input treatment still on it —
       its own radius and a white inner lip — which drew a second, brighter
       box around the text inside the one that is meant to be the control. */
    appearance: none; -webkit-appearance: none;
    border-radius: 0; box-shadow: none;
  }
  .seek input::placeholder { color: var(--faint); }
  .seek input::-webkit-search-cancel-button { display: none; }
  /* The completion sits under the caret. The typed half is invisible but keeps
     its width, so the suffix lands on the next glyph without any measuring. */
  .seek-ghost {
    position: absolute; inset: 0; pointer-events: none;
    font-family: var(--sans); font-size: 14px; line-height: inherit;
    white-space: pre; overflow: hidden;
  }
  .seek-ghost i { visibility: hidden; font-style: normal; }
  .seek-ghost b { color: var(--faint); font-weight: 400; }
  /* The shortcut, shown where the shortcut is used; it becomes the key that
     takes the completion once there is one to take. */
  /* Phone only: a wide screen closes the field with Escape or by clicking
     away, and the masthead has no room for a button that says so. */
  .seek-cancel { display: none; }
  .seek-key {
    flex: 0 0 auto; font-family: var(--mono); font-size: 10px; color: var(--faint);
    padding: 2px 6px; border: 1px solid var(--line); border-radius: 5px;
    transition: opacity .15s, color .15s, border-color .15s;
  }
  .seek:focus-within .seek-key { opacity: 0; }
  .seek:focus-within .seek-key.offer { opacity: 1; color: var(--soft); border-color: var(--line-up); }
  /* What the field is doing right now, under the pill rather than inside it —
     one short line, never the clipped list of examples it replaced. */
  .seek-hint {
    position: absolute; left: 12px; top: calc(100% + 5px); z-index: 5;
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .06em;
    text-transform: uppercase; color: var(--faint); white-space: nowrap;
  }
  .seek-hint[hidden] { display: none; }

  /* All-off lives at the far right, on its own, away from the field — it is
     the one destructive control on the page and should never be a neighbour
     of the thing you type into. */
  .main {
    position: fixed; z-index: 40; left: 14px; bottom: 14px; margin: 0;
    font-family: var(--mono); text-transform: uppercase;
    letter-spacing: .08em; font-size: 10.5px;
    background: var(--paper); border: 1px solid var(--line-up); color: var(--ink);
    backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
    box-shadow: var(--cast); opacity: .78;
    transition: opacity .25s, color .18s, background .18s, border-color .18s,
                transform .24s cubic-bezier(.22,.94,.3,1);
  }
  .main:hover:not(:disabled), .main:focus-visible { opacity: 1; }
  .main:active:not(:disabled) { transform: scale(.96); transition-duration: .06s; }
  /* Nothing is on: it is there, but it has nothing to say. */
  .main:disabled { color: var(--faint); border-color: var(--line); opacity: .42; }
  /* the cue list, on paper */
  .cue { background: var(--paper); border: 1px solid var(--line); box-shadow: none;
         backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens); }
  .cue-name { font-family: var(--sans); }
  .cue-note { font-family: var(--mono); text-transform: uppercase; letter-spacing: .05em;
              font-size: 10px; color: var(--faint); }
  .legend { font-family: var(--mono); text-transform: uppercase; letter-spacing: .1em;
            font-size: 10px; color: var(--faint); }
  .tab { font-family: var(--mono); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
  .field-head h2 { font-family: var(--display); font-weight: 400; }
  .field-sub, .nudge { font-family: var(--mono); font-size: 10.5px; letter-spacing: .05em;
                       text-transform: uppercase; }
  /* In a narrow column an alert cannot be a row: the sentence stacks, then the
     two answers sit under it side by side. */
  /* In a narrow column an alert cannot be a row: the sentence runs full width
     and the two answers sit under it. */
  .nudges .nudge {
    display: block; background: var(--paper); border-color: var(--line);
    padding: 12px 13px; text-transform: none;
  }
  .nudges .nudge .pip { display: inline-block; vertical-align: middle; margin-right: 7px; }
  .nudges .nudge .said { display: inline; line-height: 1.5; font-family: var(--mono); font-size: 10.5px; }
  .nudges .nudge button {
    display: inline-block; margin: 10px 6px 0 0;
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .07em;
    text-transform: uppercase; padding: 5px 10px;
  }

  /* All COBs: the room's ceiling as one control. It leads the board, so it is
     the one card that states a number in the display face. */
  .tile.gang { grid-column: 1 / -1; }
  .gangbody { gap: 4px; }
  .gangtitle { letter-spacing: .08em; }
  .gangsame {
    cursor: pointer; font-family: var(--mono); text-transform: uppercase;
    letter-spacing: .07em; font-size: 10px; color: var(--ink);
    background: var(--paper); border: 1px solid var(--line-up); border-radius: 999px;
    padding: 5px 11px; transition: background .18s, border-color .18s;
  }
  .gangsame:hover { background: var(--paper-2); border-color: var(--ink); }
  .tile.gang .big { font-size: clamp(30px, 4vw, 44px); margin-top: 6px; }
  .big:empty { display: none; }
  .tile.gang .controls { position: static; margin-top: 14px; }
  /* A normal tile reserves the foot of its face for strips that are pinned
     there absolutely. This card stacks instead, so that reservation is an
     empty 70px band between the title and the controls — which is exactly
     what made the ceiling card twice the size it needed on a phone. */
  .tile.gang .tile-body,
  .tile.gang.dims .tile-body,
  .tile.gang.tunes .tile-body,
  .tile.gang.dims.tunes .tile-body { position: static; padding-bottom: 0; }
  /* The ceiling card carries two strips under its reading, so it sizes to its
     contents rather than to the tile grid's row height. */
  .tile.gang { display: flex; flex-direction: column; padding: 15px 16px 14px;
               height: auto; min-height: var(--tile-h); overflow: visible; }
  .tile.gang .tile-fill { border-radius: inherit; }

  /* ── the backdrop dock ──────────────────────────────────────────────
     The backdrop is half the design, so it wanted to be one click away — but
     three thumbnails in the masthead put a picture-picker beside the thing
     that reports the house, which is a setting sitting where a status should
     be. It lives in the bottom-right corner instead, as one small square of
     the picture that is showing: still one click, and no longer competing.
     The rest of the library slides out of it on hover, so the quick swap
     survives without the row being permanently on screen.
     Fixed, so where it sits in the markup does not matter. */
  .shots {
    position: fixed; right: 14px; bottom: 14px; z-index: 40;
    display: flex; align-items: center; gap: 0;
    padding: 5px; border-radius: 13px; opacity: .6;
    background: transparent; border: 1px solid rgba(253,250,245,.28);
    transition: opacity .25s, gap .28s cubic-bezier(.2,.9,.3,1),
                background .25s, border-color .25s, box-shadow .25s;
  }
  .shots:hover, .shots:focus-within {
    opacity: 1; gap: 5px;
    background: var(--paper); border-color: var(--line); box-shadow: var(--cast);
    backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
  }
  .shot-mini {
    width: 30px; height: 22px; padding: 0; cursor: pointer; border-radius: 6px;
    border: 1px solid var(--line); background-size: cover; background-position: center;
    transition: border-color .18s, transform .16s,
                width .28s cubic-bezier(.2,.9,.3,1), opacity .2s;
  }
  .shot-mini:hover { transform: translateY(-1px); border-color: var(--line-up); }
  .shot-mini.on { border-color: var(--ink); order: -1; }
  .shot-more {
    width: 30px; height: 22px; padding: 0; cursor: pointer; border-radius: 6px;
    border: 1px dashed var(--line-up); background: none; color: var(--faint);
    font-family: var(--mono); font-size: 11px; line-height: 1;
    transition: width .28s cubic-bezier(.2,.9,.3,1), opacity .2s;
  }
  /* Collapsed: only the picture you are looking at. */
  .shots .shot-mini:not(.on), .shots .shot-more {
    width: 0; opacity: 0; border-width: 0; overflow: hidden;
  }
  .shots:hover .shot-mini:not(.on), .shots:focus-within .shot-mini:not(.on) {
    width: 30px; opacity: 1; border-width: 1px;
  }
  .shots:hover .shot-more, .shots:focus-within .shot-more { width: 30px; opacity: 1; }
  @media (max-width: 860px) { .shots { display: none; } }

  /* the thumb bar, as the reference has it: the one held control, then the
     three sleep timers that are otherwise two taps into a sheet */
  /* The say card carries the house on every screen now, so the phone's older
     glance card was the same thing said twice, one above the other. */
  button.glance { display: none; }

  @media (max-width: 860px) {
    /* On the house: the held control, a way in to search, and the timer sheet
       for a scoped one. In a room: that room's switch and the three durations
       you would actually pick, because a sleep timer is a bedroom thing and
       has no business on the house board. */
    nav.quick { grid-template-columns: 1.4fr 1fr 1fr; gap: 6px; }
    nav.quick.in-room { grid-template-columns: 1.5fr 1fr 1fr 1fr; }
    nav.quick .qmin { display: none; }
    nav.quick.in-room .qmin { display: flex; }
    nav.quick.in-room #qtimer, nav.quick.in-room #qfind { display: none; }
    nav.quick .qmin {
      align-items: center; justify-content: center;
      font-family: var(--mono); font-size: 10.5px; letter-spacing: .06em;
      text-transform: uppercase; color: var(--soft);
      background: var(--paper); border: 1px solid var(--line); border-radius: 12px;
    }
    nav.quick .qmin.on { color: var(--ink); border-color: var(--ink); }
    nav.quick #qoff span { font-family: var(--mono); font-size: 10.5px; letter-spacing: .06em;
                        text-transform: uppercase; }
  }
  @media (min-width: 861px) { nav.quick .qmin { display: none !important; } }

  /* the column's smaller voices */
  .headpct { margin-left: auto; margin-right: 14px; align-self: center; font-family: var(--display);
             font-size: clamp(20px, 2.4vw, 28px); color: var(--ink); }
  .roomsay { margin: 0; font-family: var(--display); font-size: 17px; line-height: 1.3;
             color: var(--ink); }
  .roomnote { margin: 8px 0 0; font-family: var(--mono); font-size: 9.5px; letter-spacing: .05em;
              text-transform: uppercase; color: var(--faint); line-height: 1.6; }
  .blindnote { display: block; margin-top: 6px; font-family: var(--mono); font-size: 9px;
               letter-spacing: .05em; text-transform: uppercase; color: var(--faint);
               line-height: 1.5; }
  #secsync .roomnote { margin-top: 0; }

  @media (max-width: 860px) {
    /* A phone reads a list, not a grid. Seven rooms as wide rows put the name,
       the reading and the switch on one line each — the two-column cards had
       the name wrapping over a chip that was wrapping under it. */
    .tiles.as-house { grid-template-columns: minmax(0, 1fr); gap: 8px; }
    .tiles.as-house .tile[data-room] { height: auto; min-height: 0; }
    .tiles.as-house .tile[data-room] .tile-body {
      display: grid; grid-template-columns: 1fr auto; align-items: center;
      gap: 0 12px; padding: 13px 96px 13px 15px;
    }
    .tiles.as-house .roomname { grid-column: 1; grid-row: 1; }
    .tiles.as-house .sub { grid-column: 1; grid-row: 2; margin-top: 3px; }
    .tiles.as-house .big { grid-column: 2; grid-row: 1 / 3; margin-top: 0; font-size: 27px; }
    .tiles.as-house .chip { top: 50%; transform: translateY(-50%); }

    /* Inside a room, the board is what you came for: it goes above the rooms
       and cues rather than under them, and the heading disappears because the
       status line already says where you are and how lit it is. */
    .field.in-room { order: 0; }
    .field.in-room .field-head { display: none; }

    /* These were ink laid straight on a photograph, which is unreadable however
       small the type is. They are panels now, like everything else. And what a
       room is doing goes above its board rather than under it — it is the
       first thing worth knowing when you walk in, not a footnote. */
    #secroom, #sectimer, #secsync, #sechouse {
      background: var(--paper); border: 1px solid var(--line); border-radius: 16px;
      padding: 13px 15px; box-shadow: var(--cast);
      backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
    }
    #secroom .legend, #sectimer .legend, #sechouse .legend { margin-bottom: 6px; }
    #secsync .roomnote, #sectimer .roomnote { color: var(--soft); }
    #sechouse .settings-row { margin-top: 2px; }

    /* The individual COBs were hidden here to keep the phone board short.
       That was the wrong trade: it left the room with no way to touch one
       lamp at all, and the reason a room has both controls is that sometimes
       one lamp *is* the point. They come back; the ceiling card is what gets
       smaller instead. */
    .tiles .tile.gang {
      min-height: 0; padding: 12px 14px 12px;
    }
    .tiles .tile.gang .big { font-size: 30px; margin-top: 2px; }
    .tiles .tile.gang .controls { margin-top: 10px; }

    /* A circuit that dims needs room for its strips under its name, or they
       come up over it — the card was sized for a name and a word. */
    .tiles .tile.dims, .tiles .tile.tunes { height: auto; min-height: 0; }
    /* Once the strips stack under the face instead of being pinned to it, the
       space that was reserved for them is a hole. A tunable lamp reserved 70px
       and then put its strips below that, which is why one COB was taller than
       the card that drives all five. */
    .tiles .tile.dims .tile-body, .tiles .tile.tunes .tile-body,
    .tiles .tile.dims.tunes .tile-body {
      position: static; padding-bottom: 0;
    }
    .tiles .tile.dims .controls, .tiles .tile.tunes .controls {
      position: static; margin: 12px 0 0; padding: 0;
    }
    .tiles .tile.dims, .tiles .tile.tunes { padding: 14px 15px 14px; }

    /* Inside a room the id is detail for a screen with room to spare. The name
       and what it is doing are the whole card on a phone. */
    .idline { display: none; }
    .blindnote { font-size: 8.5px; }
  }

  .thinbar { display: none; }
  @media (max-width: 860px) {
    /* It carries the notch inset itself and sticks to the top edge — the bar it
       replaced did both, and without them an iPhone hides this line under the
       status bar where it cannot be reached. */
    .thinbar {
      position: sticky; top: 0; z-index: 30;
      display: flex; align-items: center; gap: 10px; flex: 0 0 auto;
      margin: 0 -16px 12px;
      /* The notch inset alone leaves the line sitting *on* the status bar —
         technically clear of it, visually crowded into it, which is what
         reads as cut off. The extra 16px is breathing room, not clearance,
         and the max() gives the same room on a phone with no notch. */
      padding: max(calc(26px + env(safe-area-inset-top)), 26px) 16px 12px;
      font-family: var(--mono); font-size: 10.5px;
      letter-spacing: .07em; text-transform: uppercase; color: var(--soft);
      background: color-mix(in oklab, var(--paper) 88%, transparent);
      backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
      border-bottom: 1px solid var(--line);
    }
    .thinbar #thinmid { flex: 1; text-align: center; font-family: var(--display);
                        font-size: 15px; letter-spacing: .02em; text-transform: none;
                        color: var(--ink); }
    .thinbar #thinright { color: var(--faint); }
    .thinbar #thinleft { cursor: pointer; }
    /* The card it replaces: on a phone the bar held a title and a search icon,
       and the title is what the status line now says. */
    header.plate { display: none; }
  }

  .group-label { grid-column: 1 / -1; font-size: 12.5px; color: var(--soft); margin: 16px 0 -4px;
                 text-shadow: var(--halo); }
  .group-label:first-child { margin-top: 0; }
  /* Over a photograph, faint ink on nothing is not a message. */
  .empty {
    grid-column: 1 / -1; font-size: 13.5px; color: var(--soft);
    padding: 16px 18px; border-radius: 14px;
    background: var(--paper); border: 1px solid var(--line);
    backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
  }

  /* ── the tile ────────────────────────────────────────────────────────── */
  /* Glass. The light a circuit is making rises softly from the foot of its own
     tile, in that light's own colour temperature — and nothing else has colour. */
  .tile {
    --tint: var(--warm);
    --lit: 0;                 /* how bright this circuit really is, 0 → 1 */
    position: relative; height: var(--tile-h); overflow: hidden; isolation: isolate;
    /* The floor has to follow the height, not fight it. A flat 132px here made
       fitTiles' shrinking a no-op below that — which is why a short screen (a
       tablet in landscape, a laptop at 768) still had to scroll for the last
       two rooms however far --tile-h was wound down. */
    min-height: min(132px, var(--tile-h, 132px));
    border-radius: 20px; border: 1px solid var(--line); background: var(--paper);
    backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
    box-shadow: inset 1.4px 1.4px 0 -.4px rgba(255,255,255,.34),
                inset -1px -1.4px 0 -.4px rgba(255,255,255,.15),
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
      border-radius: inherit; padding: 2px; pointer-events: none;
      background: var(--rim);
      backdrop-filter: brightness(1.5) saturate(1.8);
      -webkit-backdrop-filter: brightness(1.5) saturate(1.8);
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
  /* ── a circuit that is on ────────────────────────────────────────────
     On paper, over a bright photograph, the difference between a lit tile and
     a dark one had come down to a slightly warmer border and a wash across the
     face — true to the palette and far too quiet to read across a room, which
     is the one job this state has. It says it four ways now, all of them the
     lamp's own colour rather than a decoration: the pane itself takes a tint,
     the edge takes more of it, the card throws a halo the way a lamp throws
     light, and the state line goes to ink while a dark one stays grey. */
  /* ── on is categorical; how much is a second question ────────────────
     Every part of this used to be scaled by --lit from zero, so a room with
     one lamp at 7% — which is what this house is most evenings — got 0.6% of
     a tint and read as dark. Brightness is a *modifier* now, not the whole
     signal: everything below starts at a floor you can see across a room and
     climbs from there. The paper token is deliberately not used for the pane:
     it is 80% opaque, so mixing a tint into it lost most of the tint to the
     photograph behind. The lit pane is solid. */
  /* The pane carries less of the tint than it used to. At 62–86% a lit amber
     card was a slab of paint: harsh to look at, and it took the secondary text
     down with it — measured 1.65:1 on the reading under a room name, against
     the 4.5 it needs. The signal does not live in the flood. It lives in the
     edge and the two halos below, which are untouched, so a lit card still
     reads as lit from across the room while its own words stay readable. */
  .tile.on {
    background: color-mix(in oklab, var(--tint) calc(42% + var(--lit) * 18%), #fdfaf5);
    border-color: color-mix(in oklab, var(--tint) 92%, var(--line));
    box-shadow:
      0 0 0 1px color-mix(in oklab, var(--tint) calc(34% + var(--lit) * 26%), transparent),
      0 8px 26px -8px color-mix(in oklab, var(--tint) calc(40% + var(--lit) * 34%), transparent),
      0 22px 52px -18px color-mix(in oklab, var(--tint) calc(24% + var(--lit) * 26%), transparent),
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
    /* Warmth spreading across the paper from the left, to the level the
       circuit is actually at. On a dark page light rose from the floor; on
       paper it reads as ink soaking in, and the quantity is legible at a
       glance across a room. */
    /* The stops move with the level, but the *first* one does not: a circuit
       that is on is unmistakably warm at its leading edge whatever it is set
       to, and the level decides how far that warmth carries across the face. */
    background: linear-gradient(104deg,
      color-mix(in oklab, var(--tint) 100%, transparent) 0%,
      color-mix(in oklab, var(--tint) 86%, transparent) calc(18% + var(--fill) * 40%),
      color-mix(in oklab, var(--tint) 52%, transparent) calc(40% + var(--fill) * 42%),
      color-mix(in oklab, var(--tint) 18%, transparent) calc(68% + var(--fill) * 32%));
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
  /* A lit circuit's reading is ink, not grey. This rule used to say --soft and
     sat *after* the one that said ink, so the state line quietly lost — the
     same half-live-CSS trap as the search field and --base before it. */
  .tile.on .tile-read, .tile.on .state { color: var(--ink); font-weight: 500; }
  /* Everything secondary on a lit card was still drawn in the greys that were
     chosen against paper, and on a tinted pane they disappeared — the reading
     under a room name measured 1.65:1 and the corner button 3.14:1. Tied to the
     lamp's own colour rather than set to flat black, so a lit card still reads
     as one object. */
  .tile.on .sub { color: color-mix(in oklab, var(--ink) 76%, var(--tint)); }
  .tile.on .big.dark { color: color-mix(in oklab, var(--ink) 76%, var(--tint)); }
  .tile.on .chip {
    color: color-mix(in oklab, var(--ink) 82%, var(--tint));
    background: color-mix(in oklab, #fdfaf5 72%, var(--tint));
    border-color: color-mix(in oklab, var(--ink) 34%, transparent);
  }
  .tile.on .chip:hover { color: var(--ink); border-color: color-mix(in oklab, var(--ink) 58%, transparent); }
  .tile:not(.on) .state, .tile:not(.on) .tile-read { color: var(--faint); }

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
  /* The face has to end where the strips begin. These reservations were
     guessed and were both short: one strip is 46px sitting 12px off the foot,
     and two are 46 + 9 + 46 on top of that — so a tunable tile reserved 70px
     for 101px of controls and its state line spent its life half-hidden behind
     the brightness strip. Nobody noticed while the line read '45%'; it became
     obvious the moment it read 'ON · 45% · CANDLE'. */
  .tile.dims .tile-body { padding-bottom: 62px; }
  .tile.tunes .tile-body { padding-bottom: 62px; }
  .tile.dims.tunes .tile-body { padding-bottom: 117px; }

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
    transition: transform .16s cubic-bezier(.22,.94,.3,1), background .2s;
  }
  .slider::-moz-range-thumb { width: 11px; height: 11px; border-radius: 50%; background: var(--ink); border: 0;
    transition: transform .16s cubic-bezier(.22,.94,.3,1), background .2s; }

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
  .timerstop { margin-top: 9px; width: 100%; }

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
    padding: 22px; background: rgba(28,24,20,.32);
    backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    animation: fade .22s ease both;
  }
  .scrim[hidden] { display: none; }
  @keyframes fade { from { opacity: 0; } }
  /* Opaque, for the same reason the sleep timer is: this is a panel you read
     and type into, and it was still wearing the dark translucent skin from
     before the paper palette — a whole room board legible straight through a
     cue's own list of rooms. Glass is for chrome you look past. */
  .sheet {
    width: min(540px, 100%); max-height: min(680px, 88vh); display: flex; flex-direction: column;
    border-radius: 24px; border: 1px solid var(--line); background: #fbf7f0;
    box-shadow: 0 40px 80px -26px rgba(24,20,16,.55);
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
  /* ── schedules ───────────────────────────────────────────────────────
     A schedule row leads with the time, because that is what you scan for.
     What it does sits under it in the same voice a cue note uses. */
  .sched {
    position: relative; display: grid; grid-template-columns: auto 1fr auto;
    align-items: center; gap: 0 12px; width: 100%; text-align: left;
    padding: 11px 12px; margin-bottom: 7px; cursor: pointer;
    border: 1px solid var(--line); border-radius: 13px;
    background: var(--paper); color: inherit; font: inherit;
    transition: border-color .18s, background .18s, transform .18s;
  }
  .sched:hover { border-color: var(--line-up); background: var(--paper-2); }
  .sched:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 3px; }
  .sched-when { font-family: var(--mono); font-size: 15px; color: var(--ink); letter-spacing: -.01em; }
  .sched-what { grid-column: 2; font-size: 12.5px; color: var(--ink);
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sched-days { grid-column: 2; font-family: var(--mono); font-size: 10px; letter-spacing: .08em;
                text-transform: uppercase; color: var(--faint); margin-top: 2px; }
  /* The dot is the only thing saying whether this will happen at all, so it is
     a switch you can press rather than a light you can only read. */
  .sched-on {
    grid-row: 1 / 3; grid-column: 3; width: 30px; height: 30px; flex: none;
    border-radius: 50%; border: 1px solid var(--line); background: var(--paper-2);
    cursor: pointer; display: grid; place-items: center; padding: 0;
  }
  .sched-on i { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); }
  .sched.live .sched-on { border-color: color-mix(in oklab, var(--warm) 60%, var(--line)); }
  .sched.live .sched-on i { background: var(--warm); box-shadow: 0 0 8px var(--warm); }
  .sched.gone { border-style: dashed; }
  .sched.gone .sched-what { color: var(--clay); }
  .sched-empty { font-size: 12.5px; color: var(--faint); padding: 4px 2px 10px; }

  .sched-field { padding: 14px 0 4px; border-bottom: 1px solid var(--edge); }
  .sched-field:last-child { border-bottom: 0; }
  .sched-lab { display: block; font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em;
               text-transform: uppercase; color: var(--faint); margin-bottom: 9px; }
  .sched-time {
    font-family: var(--mono); font-size: 30px; letter-spacing: -.01em;
    color: var(--ink); background: none; border: 0; padding: 0; margin-bottom: 8px;
    appearance: none; -webkit-appearance: none;
  }
  .sched-time:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 3px; border-radius: 6px; }
  .days { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .day {
    width: 38px; height: 38px; border-radius: 50%; cursor: pointer; padding: 0;
    border: 1px solid var(--line); background: var(--paper); color: var(--soft);
    font-family: var(--mono); font-size: 11px; letter-spacing: .02em;
    transition: background .18s, color .18s, border-color .18s;
  }
  .day[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: var(--base, #fdfaf5); }
  .day:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }
  /* [hidden] is display:none from the UA sheet, and any display of our own
     beats it — so a row told to hide stayed on screen. */
  .daypresets, .seg-row { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 10px; }
  .daypresets[hidden], .seg-row[hidden] { display: none; }
  /* A segmented control has to say which segment is chosen. .seg had a hover
     and a focus ring and nothing at all for selected, so the pair read as two
     equal buttons and the answer was invisible. */
  .seg[aria-pressed="true"] {
    background: var(--ink); border-color: var(--ink);
    color: var(--base, #fdfaf5); font-weight: 500;
  }
  .seg[aria-pressed="true"]:hover { background: #443b34; border-color: #443b34; color: var(--base, #fdfaf5); }
  .sched-pick {
    width: 100%; margin-bottom: 10px; padding: 10px 12px; cursor: pointer;
    font: inherit; font-size: 13.5px; color: var(--ink);
    border: 1px solid var(--line); border-radius: 11px; background: var(--paper);
  }
  .sched-pick:focus-visible { outline: 2px solid var(--edge-up); outline-offset: 2px; }

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
  .sheet-btn.go:hover { color: var(--base); background: #443b34; border-color: #443b34; }
  .sheet-btn.danger { margin-left: auto; }
  .sheet-btn.danger:hover, .sheet-btn.danger.armed { color: var(--clay); border-color: var(--clay); }

  /* ── messages ────────────────────────────────────────────────────────── */
  .note {
    position: fixed; left: 50%; bottom: 26px; z-index: 60;
    transform: translate(-50%, 180%); visibility: hidden; opacity: 0;
    max-width: min(92vw, 440px); padding: 13px 18px;
    /* Opaque, like the sheet and the sleep timer: this is a sentence you have
       about three seconds to read, over whatever the photograph happens to be
       doing under it. */
    background: #fbf7f0; border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 24px 50px -20px rgba(24,20,16,.5);
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

  /* ══ it should behave like a thing, not a page ═════════════════════════
     What separates an app from a web page is almost entirely the hundred
     milliseconds after a finger lands. A real control moves under the press,
     takes longer coming back than it took going down, arrives rather than
     appears, and never shows a browser artefact. None of that is default, and
     every one of them is cheap. */

  /* No 300ms wait for a second tap, and no pinch-zoom starting from a
     mis-hit. A page you can accidentally zoom never feels installed. */
  body, button, .tile, .cue, .barcol, .setting, .pick { touch-action: manipulation; }
  /* A drag along a slider belongs to the slider. Without this the phone
     claims it as a scroll the moment it wanders a few pixels off-axis. */
  .slider, .strip { touch-action: none; }
  /* Momentum inside the boards, and no rubber-band handing the gesture to
     the page behind once a list hits its end. */
  #stack, .sheet-body, .rail, .cues, .settings-row {
    -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
  }

  /* ── the press ───────────────────────────────────────────────────────
     Down in 60ms, back in 240 on a curve that overshoots slightly. The
     asymmetry is the whole trick: symmetrical motion reads as an animation,
     asymmetrical motion reads as weight.
     The transitions are restated in full rather than added to, because
     transition is a shorthand and a second declaration would silently drop
     the colour fades these controls already had. */
  .seg, .step, .mins button, .scopes button, .sheet-btn, .note-do, .chip {
    transition: color .18s, background .18s, border-color .18s, filter .16s,
                transform .24s cubic-bezier(.22,.94,.3,1);
  }
  .pull { transition: color .18s, background .18s,
                      transform .24s cubic-bezier(.22,.94,.3,1); }
  .key  { transition: background .2s,
                      transform .24s cubic-bezier(.22,.94,.3,1); }
  .quick button { transition: color .18s, background .18s, border-color .18s,
                              transform .24s cubic-bezier(.22,.94,.3,1); }
  .barcol { transition: transform .24s cubic-bezier(.22,.94,.3,1); }

  .seg:active, .step:active:not(:disabled), .pull:active, .sheet-btn:active,
  .note-do:active, .mins button:active, .scopes button:active,
  .quick button:active:not(:disabled), .chip:active, .key:active:not(:disabled) {
    transform: scale(.93); transition-duration: .06s;
  }
  .tab:active, .cue:active, .barcol:active, .setting:active, .pick:active {
    transform: scale(.972); transition-duration: .06s;
  }
  /* A tile is pressed by its face. Its key and its sliders are their own
     controls sitting on top, and the pane must stay still under them or a
     brightness drag would shrink the thing being dragged. */
  @supports selector(:has(*)) {
    .tile:has(.tile-body:active, .gangbody:active) { transform: scale(.982); }
  }

  /* A range thumb that does not answer the finger is the clearest tell that
     this is an <input>. It swells while held, like a control being gripped. */
  .slider:active::-webkit-slider-thumb { transform: scale(1.5); }
  .slider:active::-moz-range-thumb { transform: scale(1.5); }

  /* The strips are the sliders you actually touch — the range input inside is
     invisible — and their fill carried a 300ms width transition, so the light
     arrived a third of a second after the finger. Nothing gives a page away
     faster than a control the hand can outrun. While a strip is being dragged
     it is driven directly, and the handle thickens so the grip is visible. */
  .strip.dragging .strip-fill { transition: background .4s; }
  .strip.dragging .strip-hand {
    transform: translateY(-50%) scale(1.14);
    border-color: var(--ink);
    box-shadow: 0 2px 5px rgba(43,38,34,.34), 0 7px 16px -5px rgba(43,38,34,.42);
  }
  .strip.dragging { border-color: var(--line-up, var(--edge-up)); }

  /* ── arriving ────────────────────────────────────────────────────────
     A board that replaces itself all at once is a page load. Dealt in, one
     card every 26ms, it is a screen being built — and the direction says
     which way you moved through the house: forward slides in from the right,
     back from the left, the way every navigation stack on a phone does. */
  #stack.push > * { animation: dealt-r .38s cubic-bezier(.2,.86,.28,1) both; }
  #stack.pop  > * { animation: dealt-l .38s cubic-bezier(.2,.86,.28,1) both; }
  @keyframes dealt-r { from { opacity: 0; transform: translate3d(26px, 0, 0); } }
  @keyframes dealt-l { from { opacity: 0; transform: translate3d(-26px, 0, 0); } }
  #stack.dealt > .enter { animation: rise .42s cubic-bezier(.2,.86,.28,1) both; }

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
  button.glance { display: none; }

  @media (max-width: 860px) {
    .glance {
      display: block; width: 100%; text-align: left; cursor: pointer;
      margin-bottom: 14px; padding: 14px 14px 10px; border-radius: 18px;
      background: var(--pane); background-image: var(--sheen);
      border: 1px solid var(--edge); box-shadow: var(--cast);
      backdrop-filter: var(--lens);
      -webkit-backdrop-filter: var(--lens);
      font: inherit; color: var(--ink);
    }
    .glance-say { display: block; font-size: 15px; line-height: 1.35; color: var(--soft); }
    .glance-say b { color: var(--ink); font-weight: 500; }
    .glance-say i { font-style: normal; color: var(--accent); font-weight: 500; }
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
    backdrop-filter: var(--lens);
    -webkit-backdrop-filter: var(--lens);
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
  /* ── the sleep timer ─────────────────────────────────────────────────
     This was still wearing the old dark palette *and* it was translucent, so
     the room names behind it read straight through its own room names — two
     lists of the same words on top of each other. A panel you make a choice
     in has to be opaque; glass is for chrome you look past, not for a dialog
     you look at. It gets a veil behind it as well, so the board recedes and
     the panel is plainly the thing in front. */
  .timerpop {
    position: fixed; z-index: 46; right: 18px; bottom: 18px;
    width: min(330px, calc(100vw - 36px));
    padding: 15px; border-radius: 18px;
    background: #fbf7f0; border: 1px solid var(--line);
    box-shadow: 0 30px 60px -22px rgba(24,20,16,.5), var(--cast);
    animation: pop-in .26s cubic-bezier(.2,.9,.3,1) both;
  }
  @keyframes pop-in { from { opacity: 0; transform: translateY(10px) scale(.97); } }
  .timerpop[hidden] { display: none; }
  .popveil {
    position: fixed; inset: 0; z-index: 44;
    background: rgba(28,24,20,.28);
    backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
    animation: fade .2s ease both;
  }
  .popveil[hidden] { display: none; }
  .timerpop h3 { margin: 0 0 2px; font-size: 13px; font-weight: 500; color: var(--ink); }
  .timerpop p { margin: 0 0 11px; font-size: 12px; color: var(--faint); }
  .scopes { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 11px; }
  .scopes button {
    font: inherit; font-size: 12px; color: var(--soft); cursor: pointer;
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
      /* 104px of it was clearance for a pill that floated over the page. The
         masthead is in the page now, so that space was just a hole above it. */
      padding-top: clamp(16px, 2.2vh, 26px); padding-bottom: 104px;
      gap: 0;
    }

    /* ── the top pill ─────────────────────────────────────────────────────
       The bar used to be a solid strip across the top while everything below
       it floated, which made it read as furniture rather than as part of the
       same material. It is now a pane like any other, hanging in the middle. */
    /* A masthead, not a floating pill. The reference runs it the full width of
       the page with the name at one end and all-off at the other; a centred
       pill left the two ends of the bar hanging in the middle of the screen. */
    .plate {
      /* Sticky rather than static: it stays at the top of the window when the
         page moves, which is what it did as a floating pill and the one thing
         worth keeping from that. */
      position: sticky; top: 0; transform: none; z-index: 40; width: 100%; max-width: none;
      margin-bottom: 16px;
      padding-top: 10px; padding-right: 14px; padding-bottom: 10px; padding-left: 20px;
      border-radius: 16px; gap: 18px;
      background: var(--pane); background-image: var(--sheen);
      border: 1px solid var(--edge);
      backdrop-filter: var(--lens);
      -webkit-backdrop-filter: var(--lens);
      box-shadow: var(--cast);
    }
    /* The plate is a floating pill over the page, so its height is not its own
       business — let the line inside it wrap and the pill grows until its
       bottom edge lies across the hero and the field heading, reading as a
       faint straight line drawn through the text. The phone layout has clamped
       this since it was built; the desktop one never did. */
    #secrooms { display: none; }        /* the board is the room list now */
    .plate .stamp h1 { font-size: 14px; white-space: nowrap; }
    .plate .tally { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .plate .seek { flex: 0 0 260px; margin-left: 0; }

    /* ── the board ────────────────────────────────────────────────────────
       A hero column that says what the house is doing, and the field beside it. */
    /* No align-items:start here. The page itself does not scroll on a wide
       screen — the tile grid scrolls inside a window sized by the viewport —
       and starting the items collapses .field to its content, so the grid grew
       past the window and the overflow was clipped rather than scrollable.
       A room has fourteen circuits and would simply lose the last of them. */
    /* Board first, column second — the room list that used to justify a left
       rail is gone, so the side is for cues and alerts and nothing else. */
    .board { display: grid; grid-template-columns: 1fr minmax(240px, 310px); gap: 30px; min-height: 0; }
    .field { order: 1; }
    .index { order: 2; }
    .index { min-height: 0; display: flex; flex-direction: column; }

    /* the house, stated */
    .hero { display: block; margin-bottom: 26px; }
    .hero .greet { margin: 0; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--soft);
                   text-shadow: var(--halo); }
    .hero .say {
      margin: 12px 0 0; font-family: var(--display); font-weight: 400;
      letter-spacing: -.012em; line-height: 1.02;
      font-size: clamp(44px, 5vw, 74px); color: var(--ink); text-shadow: var(--halo);
    }
    .hero .say b { font-weight: 400; color: var(--accent); font-style: italic; }
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
      backdrop-filter: var(--lens);
      -webkit-backdrop-filter: var(--lens);
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

    /* An advisory is one short sentence and two small answers to it. Run the
       full width of the field it put most of a thousand pixels between the
       thing being said and the buttons that answer it, and the eye had to
       travel the whole way to act on a nine-word observation. It stays a
       plain list — the deck was tried and rejected — but a row is now only as
       wide as the sentence needs, so the answer sits beside the question. */
    .nudge { max-width: 620px; }

    /* ── the bento ────────────────────────────────────────────────────────
       Room cards are not a uniform grid here. There is width to spare, so the
       room with the most light in it takes a double square and the rest fall in
       around it — the board then reads at a glance the way the house does. */
    /* The cue list is as long as you have made it, and the column it sits in
       already scrolls — so it must not scroll too. It used to carry its own
       max-height and overflow, which made two scrollers stacked inside each
       other: a wheel over the cues turned the inner list, then the outer
       column, and the inner one cut off mid-card with no fade, because the
       fade is drawn from data-more and only .index is watched for it. The
       column is the one scroller; the cue list simply runs its natural height
       inside it. */
    #seccues #cues { padding-right: 4px; }
    #sechouse { margin-top: 14px; }

    .field .tiles { grid-template-columns: repeat(4, 1fr); gap: 16px; }
    .tile.hero-room { grid-column: span 2; grid-row: span 2; height: auto;
                      min-height: calc(var(--tile-h) * 2 + clamp(12px, 1.4vw, 18px)); }
    .tile.hero-room .tile-name { font-size: 22px; }
    .tile.hero-room .tile-read { font-size: 13.5px; }
  }

  /* Driven by fitTiles when it has had to wind the tiles below the height a
     three-line card needs. Measured rather than assumed from the viewport: the
     same 92px tile can come from a short screen or from a houseful of alerts,
     and both want the same card. */
  .tiles.squeezed .tile[data-room]:not(.hero-room) .sub { display: none; }
  .tiles.squeezed .tile[data-room]:not(.hero-room) .big {
    margin-top: 4px; font-size: clamp(19px, 2.1vw, 26px);
  }

  /* ── a short screen ──────────────────────────────────────────────────────
     A tablet in landscape is a wide screen with half the height, and the board
     is laid out for height. Shrinking the tiles alone runs out at the 78px
     floor — below that a room card stops being readable — so what gives first
     is the chrome around them: the sentence, the room bars and the gaps.
     Measured at 1024x600, where the board overflowed by 44px with the tiles
     already on the floor. */
  @media (min-width: 861px) and (max-height: 720px) {
    .saycard { padding: 13px 18px 11px; border-radius: 18px; }
    .saycard .say { font-size: clamp(21px, 2.5vw, 28px); }
    .bars { margin-top: 9px; gap: clamp(5px, .8vw, 10px); }
    .barwell { height: 24px; }
    .barlabel { margin-top: 4px; font-size: 9px; }
    .field .tiles { gap: 12px; }
    .shell { padding-top: 12px; padding-bottom: 88px; gap: 14px; }
    .tile.hero-room .big { font-size: clamp(24px, 2.6vw, 32px); }
  }

  @media (max-width: 860px) {
    html, body { height: auto; overflow: visible; overscroll-behavior: auto; }
    /* A board sliding in from 26px to the right must not widen the document
       for the two frames it is in flight. Clip rather than hidden, which
       would make the body a scroll container and break the sticky status
       line above it. */
    html, body { overflow-x: clip; }
    body { display: block; min-height: 100%; padding-top: 0; }
    /* Clear the thumb bar so the last tile is never trapped under it. */
    /* Clearance for the floating pill: its own height, the gap it hangs on,
       and the home indicator under it. Sized flush to the edge before, it left
       the last room trapped behind the bar. */
    .shell { display: block; max-width: none;
             padding: 0 16px calc(112px + env(safe-area-inset-bottom)); }
    .hero { display: none; }

    /* ── the thumb bar ───────────────────────────────────────────────────
       The three things done most often, sitting where a thumb already is
       rather than at the top of a page you have to reach across. */
    /* A pill that floats, not a strip bolted to the bottom edge. It is the
       same glass as everything else, so it should sit on the picture the same
       way the cards do — and the home indicator gets its own clearance under
       it rather than a bar drawn through it. */
    .quick {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
      position: fixed; left: 12px; right: 12px; z-index: 45;
      bottom: calc(10px + env(safe-area-inset-bottom));
      padding: 6px; border-radius: 22px;
      background: var(--paper); border: 1px solid var(--line);
      box-shadow: var(--cast);
      backdrop-filter: var(--lens);
      -webkit-backdrop-filter: var(--lens);
    }
    .quick button { border-radius: 17px; }
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
    /* Clear of the thumb bar, which it was landing on top of. */
    .note { bottom: calc(88px + env(safe-area-inset-bottom)); }

    /* ── the sheet, as a phone does sheets ───────────────────────────────
       A dialog floating in the middle of a phone screen is a web page's idea
       of a dialog. Every app on the device does the same thing instead: the
       panel comes up from the bottom edge, keeps its top corners round and
       loses its bottom ones because there is no bottom, wears a grab handle,
       and can be thrown back down. The handle is not decoration — it is the
       only thing that says the drag is available. */
    .scrim { place-items: end stretch; padding: 0; }
    .sheet {
      width: 100%; max-height: 92dvh;
      border-radius: 24px 24px 0 0; border-bottom: 0;
      padding-bottom: env(safe-area-inset-bottom);
      animation: sheet-up .36s cubic-bezier(.2,.9,.28,1) both;
      transform: translateY(var(--drag, 0px));
    }
    @keyframes sheet-up { from { transform: translateY(100%); } }
    /* While a finger is on it the sheet is driven directly, not animated. */
    .scrim.gripped .sheet { animation: none; transition: none; }
    .scrim.settling .sheet { animation: none; transition: transform .3s cubic-bezier(.2,.9,.28,1); }
    .scrim.closing { animation: fade .24s ease reverse both; }
    .scrim.closing .sheet { animation: none; transition: transform .26s cubic-bezier(.4,0,.7,.2); }

    .sheet-head { padding-top: 28px; position: relative; touch-action: none; }
    .sheet-head input, .sheet-head button { touch-action: auto; }
    .sheet-head::before {
      content: ''; position: absolute; top: 11px; left: 50%; transform: translateX(-50%);
      width: 40px; height: 4px; border-radius: 2px; background: var(--line-up, var(--edge-up));
    }

    /* The thumb bar already carries all-off and find, so the top bar drops both
       rather than saying everything twice. */
    .plate .seek-toggle, #main { display: none; }
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
    /* Both rails stay above the house, because a cue put below it is not
       reachable: the board is 555px on the house view and 1938px in a room,
       so the rail landed at y=1080 and y=2505 — you would scroll the whole
       house to fire Good Night. What pays for that space is the two legends.
       "Rooms" over a row of room names and "Cues" over a row of cue names
       label what is already legible, and cost 22px each on the one screen
       with none to spare. The settings keep theirs: they sit below the house
       and their chips are sentences rather than names. */
    .board { display: flex; flex-direction: column; }
    .index { display: contents; }
    #secrooms { order: 1; }
    #seccues  { order: 2; }
    #secleft  { order: 3; }
    .field    { order: 4; }
    /* What a room is doing belongs above its board: it is the first thing
       worth knowing when you walk in, not a footnote under fourteen cards. */
    #secroom  { order: -1; }
    #secsched { order: 5; margin-top: 4px; }
    #sectimer { order: 6; }
    #secsync  { order: 7; }
    #sechouse { order: 8; margin-top: 4px; }
    #secrooms .legend, #seccues .legend { display: none; }

    /* Schedules stay a list rather than becoming a sideways rail. A row is a
       time, a sentence, the days it runs and a switch — squeezed into a chip
       none of that survives, and it is not something you fire in passing the
       way you fire a cue. It sits under the house, where you go looking for it
       rather than meeting it on the way to the lights. */
    #secsched > div:not(.legend) { display: block; overflow: visible; }

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
      backdrop-filter: var(--lens); -webkit-backdrop-filter: var(--lens);
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
    /* Scoped to the masthead. Unscoped it also hid the field once it had been
       moved into the search layer, which is the one place it must be. */
    .plate .seek { display: none; order: 4; flex: 1 1 100%; margin-left: 0; }
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
    /* "+ Create a cue" is a sibling of the rail rather than a member of it, so
       it dropped onto a line of its own under the chips and cost another 50px
       on the screen that has none. It joins the rail as the chip at the end. */
    #seccues { display: flex; align-items: center; gap: 8px; }
    #seccues #cues { flex: 1 1 auto; min-width: 0; }
    /* Pinned beside a rail that fades at its right edge, the full label read as
       though it were sitting on top of a half-erased chip. At the end of a row
       of named cues the plus needs no sentence. The label stays in the
       accessibility tree — font-size does not remove it — so it is still
       announced as "Create a cue". */
    /* Scoped to the cue rail. The schedules list is not a rail — a lone plus
       floating under it says nothing about what it adds. */
    #seccues .newcue {
      flex: 0 0 auto; width: auto; margin-top: 0; padding: 0;
      min-width: 40px; height: 38px; border-radius: 999px;
      font-size: 0; display: grid; place-items: center;
    }
    #seccues .newcue::before { content: '+'; font-size: 19px; line-height: 1; }
    #secsched .newcue { width: 100%; margin-top: 2px; padding: 11px 13px; font-size: 13px; }

    /* ── the field, on a phone ───────────────────────────────────────────
       Find was a dead button here. The status line replaced the masthead and
       took the masthead's display:none with it, but the search field
       lives inside that masthead — so tapping Find switched the board to
       Search and gave you nothing to type into. The masthead comes back when
       and only when you are searching, carrying the field and nothing else. */
    /* ── search, as a mode ───────────────────────────────────────────────
       It docks at the bottom, where the thumb and the keyboard already are —
       typing at the top of a phone means reaching across the screen to a
       field the keyboard is about to cover. But a docked field alone was the
       wrong half of the idea: the board behind it still scrolled and still
       took taps, the results sat under the keyboard, and there was no way out
       but emptying the field. So the whole screen becomes the search while it
       is open, in one flex column — results, then the next word, then the
       field — which means no offset anywhere is computed by hand. */
    .seeklayer {
      position: fixed; inset: 0; z-index: 46;
      display: flex; flex-direction: column;
      padding: calc(10px + env(safe-area-inset-top)) 12px
               calc(10px + env(safe-area-inset-bottom) + var(--kb, 0px));
      gap: 8px;
      background: color-mix(in oklab, var(--base) 82%, transparent);
      backdrop-filter: blur(22px) saturate(130%); -webkit-backdrop-filter: blur(22px) saturate(130%);
      animation: fade .18s ease both;
      transition: padding-bottom .18s ease;
    }
    .seeklayer[hidden] { display: none; }
    /* The results own everything left over, and scroll inside it. */
    .seek-results {
      flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px;
      align-content: start; padding: 2px 2px 4px;
    }
    .seek-foot { flex: 0 0 auto; }
    .seek-foot .chips { margin: 0; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
    .seek-foot .chips::-webkit-scrollbar { display: none; }
    .seek-foot .chips .chip-word { flex: 0 0 auto; }
    /* The field is a child of the layer while the layer is open — moved there
       rather than positioned over it, so the column does the arithmetic. */
    .seeklayer .seek {
      display: flex; flex: 0 0 auto; max-width: none; margin: 0;
      padding: 11px 14px; border-radius: 18px;
      background: #fbf7f0; border: 1px solid var(--line); box-shadow: var(--cast);
    }
    .seeklayer .seek input { font-size: 16px; }   /* under 16 and iOS zooms the field */
    .seeklayer .seek-ghost { font-size: 16px; }
    .seeklayer .seek-key { display: none; }
    .seek-cancel {
      flex: 0 0 auto; display: block; padding: 5px 10px; cursor: pointer;
      font-family: var(--mono); font-size: 10px; letter-spacing: .07em;
      text-transform: uppercase; color: var(--soft);
      background: var(--paper-2); border: 1px solid var(--line); border-radius: 8px;
    }
    .seek-cancel:active { transform: scale(.93); }
    /* Above the pill, not inside it: static, it joined the pill's flex row and
       squeezed the input to nothing — a search field with no room for text. */
    .seeklayer .seek-hint {
      top: auto; bottom: calc(100% + 7px); left: 6px; right: auto;
    }
    /* Nothing of the old masthead treatment is wanted now. */
    header.plate.searching { display: none; }
    .quick { transition: opacity .16s ease; }
    body.seeking .quick { display: none; }

    /* ── one COB, compact ────────────────────────────────────────────────
       A tunable circuit spans the row so its two strips are wide enough to
       aim at — right for a lamp you set by hand, wrong five times over for a
       ceiling, where the individual lamps are the exception and the card
       above them is the usual control. Five full-width cards pushed the rest
       of the room off the screen.
       So a COB member turns its strips on their side: two vertical rails down
       the right of a small square. Same controls, a quarter of the space, and
       a rail is arguably the more natural shape for brightness anyway — up is
       more.
       The rails are the same horizontal input rotated a quarter turn, not a
       vertical range input: writing-mode on a range is recent and
       appearance:slider-vertical is deprecated, while a rotation is
       hit-tested in the element's own coordinates by every engine, so the
       drag lands exactly where it should. Rotating leaves the unrotated box
       in flow, which is why each rail is placed absolutely instead. */
    .tiles .tile.cobmember {
      grid-column: span 1; height: 132px; min-height: 0;
    }
    .tiles .tile.cobmember .tile-body {
      position: absolute; inset: 0; padding: 13px 74px 13px 13px;
    }
    /* The rails have to widen with the handle: a 23px knob inside a 27px rail
       was clipped on both sides and back to being hard to catch, which is the
       whole reason the handle grew. */
    .tiles .tile.cobmember .controls {
      position: absolute; top: 14px; bottom: 14px; right: 10px; left: auto;
      width: 76px; display: block; padding: 0; margin: 0;
      --vrail: 104px;                     /* the tile's height, less the insets */
    }
    .tiles .tile.cobmember .strip {
      position: absolute; top: 0; left: 0; margin: 0;
      width: var(--vrail); height: 34px; border-radius: 11px;
      transform-origin: 0 0; transform: rotate(-90deg) translateX(-100%);
    }
    .tiles .tile.cobmember .strip:nth-of-type(2) { left: 42px; }
    /* Living's COBs dim but do not tune, so they get one rail — which then has
       to sit where the second one would, against the right edge, or the card
       reads as a control with a piece missing. */
    .tiles .tile.cobmember .strip:only-of-type { left: 42px; }
    /* The key cannot stay in the top-right corner — the rails are there now.
       It goes to the foot of the left column, under the reading. */
    .tiles .tile.cobmember .ring {
      top: auto; bottom: 13px; left: 14px; right: auto; width: 22px; height: 22px;
    }
    .tiles .tile.cobmember .tile-body { padding-bottom: 46px; }
    /* No room for a word on a 27px rail, so the warmth one says which it is
       by wearing the scale it sets. */
    .tiles .tile.cobmember .strip-label { display: none; }
    .tiles .tile.cobmember .warmstrip {
      background: linear-gradient(90deg, var(--cool), #f3e3c4 46%, var(--warm));
    }
    /* Scoped to a lit lamp. Unscoped it beat the rule that dims a dark lamp's
       warmth rail, so a bank of five unlit COBs was a wall of amber — the one
       signal that is supposed to mean something is burning. */
    .tiles .tile.cobmember.on .warmstrip .strip-fill { opacity: .82; }

    /* the field is now just more page, not a scrolling window */
    .field { display: block; }
    .tiles { display: grid; overflow: visible; padding: 0; }
    .field-head { margin-bottom: 10px; }
    .field-head h2 { font-size: 21px; }
    .field-sub { margin-top: 3px; font-size: 12px; }
  }

  @media (max-width: 560px) {
    .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
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

  /* ── refraction ────────────────────────────────────────────────────────
     Last in the sheet on purpose: every pane declares its own backdrop-filter,
     so this has to come after all of them to win. Chrome resolves url() inside
     a backdrop-filter and bends the picture through the edge of each pane;
     Safari cannot, throws this declaration away, and keeps the plain lens. */
  .tile, .cue, .tab, .plate, .sheet, .timerpop, .saycard,
  .quick button, .nudge, .back, .cut, .rail {
    backdrop-filter: url("#lens") var(--lens);
  }
</style>
</head>
<body>
<!-- The lens. feDisplacementMap moves each pixel of the backdrop by the red
     and green channels of the map: flat grey through the middle leaves the
     picture where it is, and the ramp around the edge bends it, which is what
     a thick curved pane actually does to what is behind it. Blur and
     brightness alone can never say this. -->
<svg class="lensdef" aria-hidden="true" focusable="false">
  <filter id="lens" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feImage href="/lens.png?v=${ASSET_V}" preserveAspectRatio="none" result="map"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="58"
                       xChannelSelector="R" yChannelSelector="G"/>
  </filter>
</svg>
<div class="photo"></div>
<div class="spill"></div>

<div class="shell">
  <!-- The phone's masthead is a status line, not a card: the time, and what the
       house consists of. On a room it becomes the way back, the room, and its
       reading. Both are one row of 11px type, which is all a phone can spare. -->
  <div class="thinbar" id="thinbar">
    <span id="thinleft"></span><span id="thinmid"></span><span id="thinright"></span>
  </div>

  <header class="plate">
    <div class="stamp">
      <h1>Pravita's Apartment</h1>
      <p class="tally" id="tally"></p>
    </div>
    <button class="seek-toggle" id="seektoggle" type="button" aria-expanded="false" aria-label="Find a circuit">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
    </button>
    <label class="seek" id="seekpill">
      <svg class="seek-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <span class="seek-in">
        <!-- The completion, drawn under the caret: what you have typed is
             transparent but still takes its width, so the rest lines up with
             the real glyphs without measuring anything. -->
        <span class="seek-ghost" id="seekghost" aria-hidden="true"><i></i><b></b></span>
        <input type="search" id="seek" placeholder="Search, or say what to do" autocomplete="off"
               autocapitalize="off" autocorrect="off" spellcheck="false"
               aria-label="Search, or type a command"
               aria-describedby="seekhint" role="combobox" aria-expanded="false" aria-autocomplete="list">
      </span>
      <kbd class="seek-key" id="seekkey">/</kbd>
      <button class="seek-cancel" id="seekcancel" type="button" aria-label="Close search">Done</button>
      <span class="seek-hint" id="seekhint" hidden></span>
    </label>
  </header>

  <main class="board">
    <aside class="index">
      <div class="index-sec" id="secrooms">
        <div class="legend">Rooms</div>
        <div id="tabs"></div>
      </div>
      <div class="index-sec" id="secroom" hidden>
        <div class="legend">What this room is doing</div>
        <p class="roomsay" id="roomsay"></p>
        <p class="roomnote" id="roomnote"></p>
      </div>
      <div class="index-sec" id="secleft">
        <div class="legend">Left on</div>
        <div class="nudges" id="nudges"></div>
      </div>
      <div class="index-sec" id="seccues">
        <div class="legend">Cues</div>
        <div id="cues"></div>
        <button class="newcue" id="newcue" type="button">+ Create a cue</button>
      </div>
      <div class="index-sec" id="secsched">
        <div class="legend">Schedules</div>
        <div id="schedlist"></div>
        <button class="newcue" id="newsched" type="button">+ Add a schedule</button>
      </div>
      <div class="index-sec" id="sectimer">
        <div class="legend">Sleep</div>
        <p class="roomnote" id="timerstate">No timer running</p>
        <!-- Setting a timer took one tap from the thumb bar; calling it off
             took finding the timer sheet, and inside a room on a phone the
             sheet is not even in the bar. Something that switches the lights
             off while you are in bed has to be one tap to stop. -->
        <button class="pull timerstop" id="timerstop" type="button" hidden>Cancel it</button>
      </div>
      <div class="index-sec" id="secsync">
        <p class="roomnote" id="syncline"></p>
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
        <button class="setting" id="setbg" type="button">
          <span class="dot on"></span>
          <span>Change the backdrop</span>
        </button>
        </div>
      </div>
    </aside>

    <section class="field">
      <button class="glance" id="glance" type="button" aria-label="The house at a glance">
        <span class="glance-say" id="glancesay"></span>
        <span class="glance-bars" id="glancebars"></span>
      </button>
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
        <span class="headpct" id="headpct"></span>
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
  <!-- The three durations you actually pick, where your thumb already is. The
       timer sheet is still there for choosing a room or a single circuit. -->
  <button type="button" class="qmin" data-min="15">15 min</button>
  <button type="button" class="qmin" data-min="30">30 min</button>
  <button type="button" class="qmin" data-min="60">60 min</button>
</nav>

<div class="popveil" id="popveil" hidden></div>
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

<div class="scrim" id="bgscrim" hidden>
  <div class="sheet bgsheet" role="dialog" aria-modal="true" aria-labelledby="bgtitle">
    <div class="sheet-head">
      <div class="sheet-eyebrow">Backdrop</div>
      <h2 class="sheet-name" id="bgtitle">The picture behind the glass</h2>
      <p class="sheet-facts">Everything on this page is glass, so what is behind it is
        half the design. Pick one, or add a photograph of your own.</p>
    </div>
    <div class="sheet-body"><div class="bggrid" id="bggrid"></div></div>
    <div class="sheet-foot">
      <label class="pull bgadd">
        Add a photograph
        <input type="file" id="bgfile" accept="image/jpeg,image/png" hidden>
      </label>
      <button class="pull" type="button" id="bgdone">Done</button>
    </div>
  </div>
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

<!-- ── a schedule, opened up ─────────────────────────────────────────────
     Its own sheet rather than a mode of the cue one: a cue is a list of
     circuits and a schedule is a time, a set of days and one thing to do, and
     folding them together would make both harder to read. Same furniture
     though — head, body, foot — so it behaves like everything else here. -->
<div class="scrim" id="schedscrim" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="schedtitle">
    <div class="sheet-head" id="schedhead">
      <div class="sheet-eyebrow">Schedule</div>
      <p class="sheet-name" id="schedtitle">New schedule</p>
      <p class="sheet-facts" id="schedsays"></p>
    </div>
    <div class="sheet-body">
      <div class="sched-field">
        <label class="sched-lab" for="schedat">At</label>
        <input class="sched-time" id="schedat" type="time" step="60" value="07:30">
      </div>

      <div class="sched-field">
        <span class="sched-lab">On these days</span>
        <div class="days" id="scheddays"></div>
        <div class="daypresets">
          <button class="seg" type="button" data-preset="every">Every day</button>
          <button class="seg" type="button" data-preset="week">Weekdays</button>
          <button class="seg" type="button" data-preset="end">Weekend</button>
        </div>
      </div>

      <div class="sched-field">
        <span class="sched-lab">What it does</span>
        <div class="seg-row" id="schedkind">
          <button class="seg" type="button" data-kind="cue">Run a cue</button>
          <button class="seg" type="button" data-kind="device">Switch a circuit</button>
        </div>
        <select class="sched-pick" id="schedtarget" aria-label="What to schedule"></select>
        <div class="seg-row" id="schedaction" hidden>
          <button class="seg" type="button" data-action="on">On</button>
          <button class="seg" type="button" data-action="off">Off</button>
        </div>
      </div>
    </div>
    <div class="sheet-foot">
      <button class="sheet-btn go" id="schedsave" type="button">Save</button>
      <button class="sheet-btn" id="schedrun" type="button">Run it now</button>
      <button class="sheet-btn" id="schedcancel" type="button">Close</button>
      <button class="sheet-btn danger" id="scheddelete" type="button" hidden>Delete</button>
    </div>
  </div>
</div>

<!-- ── the search surface, on a phone ────────────────────────────────────
     Search is a mode, not a bar. A field floating over a live board leaves
     everything ambiguous: what is behind it still scrolls and still takes
     taps, the results sit under the keyboard, and there is no way out except
     emptying the field. This owns the screen while it is open — results
     scrolling in their own region, the next word above the field, the field
     above the keyboard, and Done to leave. The board underneath is not
     redrawn at all, so leaving puts you back exactly where you were. -->
<div class="seeklayer" id="seeklayer" hidden>
  <div class="seek-results tiles" id="seekresults"></div>
  <div class="seek-foot" id="seekfoot"></div>
</div>

<!-- Outside the header on purpose: the masthead carries a backdrop-filter,
     and a backdrop-filter makes an element the containing block for any fixed
     descendant — so docked in there it pinned itself to the header's corner
     rather than the window's. -->
<!-- All-off and the backdrop picker book-end the foot of the window: the one
     destructive control as far from the masthead as it can get, and as far
     from the picker as the window is wide. It was in the top-right corner,
     which is where a masthead should be reporting the house rather than
     offering to switch it off — and where a mis-hit is nearest the things you
     reach for most. Outside the header for the same reason the dock is: a
     backdrop-filter makes an element the containing block for fixed children. -->
<button class="main" id="main" type="button" disabled aria-describedby="tally">
  <i id="mainfill"></i><span id="mainword">Hold · all off</span><em id="maincount"></em>
</button>

<div class="shots" id="shots" aria-label="Backdrop"></div>

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

const state = { devices: [], view: 'house', room: null, q: '', sync: null, schedules: [] };
const el = (s) => document.querySelector(s);
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const rooms = () => [...new Set(state.devices.map(d => d.room))];
const rooms_ = rooms;
// A curtain reports nothing back, so it is never counted as lit.
const lit = (list) => list.filter(d => d.status && !d.is_curtain);
const inRoom = (room) => state.devices.filter(d => d.room === room);
// COB 1…COB 11 are the same fitting repeated around a ceiling, which is why
// they are the one set of circuits worth driving as one.
const isCob = (d) => /^COB\\b/i.test(d.name);
const cobsIn = (room) => inRoom(room).filter(isCob);
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
/* The colour a lamp at this temperature is making.
 *
 * This used to be one straight mix from cool to warm, which sounds right and
 * looks wrong: the two ends are near-complementary, so every value in the
 * middle — where most lamps in this house actually sit — came out as mud, and
 * a ceiling set to "warm white" rendered as oatmeal. Real light does not pass
 * through grey on its way from daylight to candlelight; it passes through a
 * warm white. So the scale has three stops, and chroma survives the middle. */
const LAMP_MID = '#ffedd2';
/* The neutral point sits at 38, not halfway. On this hub 0 is cool and 100 is
   warm, and real lamps live in the top half of that — 70 to 100 is where every
   fitting in the house actually sits. With the pivot at 50, the settings people
   use mapped to a fifth of the amber and every room card came out cream. 38
   also matches where warmthWord stops saying "soft white" and starts saying
   "neutral", so the colour and the word turn over together.
   The curve is there for the same reason: linear, most of the useful range is
   spent near the pale end. */
const LAMP_PIVOT = 38;
const lampColour = (t) => {
  const v = Math.max(0, Math.min(100, Number(t) || 0));
  const ramp = (x) => Math.round(100 * Math.pow(Math.max(0, Math.min(1, x)), 0.72));
  return v >= LAMP_PIVOT
    ? 'color-mix(in oklab, var(--warm) ' + ramp((v - LAMP_PIVOT) / (100 - LAMP_PIVOT)) + '%, ' + LAMP_MID + ')'
    : 'color-mix(in oklab, var(--cool) ' + ramp((LAMP_PIVOT - v) / LAMP_PIVOT) + '%, ' + LAMP_MID + ')';
};

const tintOf = (d) => {
  const kind = kindOf(d);
  if (kind !== 'light') return KINDS[kind].tint;
  if (!d.is_tunable) return 'var(--warm)';
  return lampColour(d.tune);
};
/* Colour temperature has no unit anybody reads off a scale — nobody has an
   opinion about 68. They have a strong opinion about candlelight. So the
   number is never the label: the strip says what the light *is*, and carries
   the number after it for anyone setting it by hand. Seven steps rather than
   five, because the strip changes its word as you drag and four bands over a
   hundred points means the label sits still for a quarter of the travel. */
const warmthWord = (t) =>
  t == null ? '' : t < 12 ? 'daylight' : t < 26 ? 'cool' : t < 40 ? 'soft white'
    : t < 56 ? 'neutral' : t < 70 ? 'warm white' : t < 86 ? 'amber' : 'candle';
// The same word, dressed for a strip label: CANDLE · 92
const warmthLabel = (t) => warmthWord(t).toUpperCase() + ' · ' + Math.round(t);

/* ───────────────────────────────────────────────────────── loading state */

async function load() {
  const snap = await fetch('/api/devices').then(r => r.json());
  state.devices = snap.devices.sort((a, b) =>
    KIND_ORDER.indexOf(kindOf(a)) - KIND_ORDER.indexOf(kindOf(b)) || natural(a.name, b.name));
  state.sync = snap;
  state.schedules = snap.schedules || [];
  drawIndex();
  drawField();
  readout();
  loadCues();
  drawSchedules();
}

// A circuit the user is touching owns its own state until the hub answers.
const inFlight = new Set();

// Which press owns each circuit. A verdict is worth listening to only if it
// answers the most recent press — see setDevice.
const clicks = new Map();
let clickSeq = 0;

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
  /* One list for the house: whoever edited it, every other browser redraws off
     the same frame the devices arrive in. Compared before redrawing so a push
     that carries no schedule change does not rebuild the list under a finger. */
  if (snap.schedules && JSON.stringify(snap.schedules) !== JSON.stringify(state.schedules)) {
    state.schedules = snap.schedules;
    drawSchedules();
  }
  if (snap.backdrop_v && snap.backdrop_v !== state.bgv) {
    // On first load the CSS already points at the right picture, but nothing
    // has measured it yet, so the dimming still has to be worked out.
    // Always, including the first snapshot: the stylesheet ships a plain
    // /bg.jpg, and only the live version tells us which picture that is.
    setShot(snap.backdrop_v);
    state.bgv = snap.backdrop_v;
  }
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
  for (const t of document.querySelectorAll('.tile[data-gang]')) paintGang(t);
  const cut = el('#cut');
  if (cut && state.view === 'room') cut.disabled = !lit(inRoom(state.room)).length;
  const sub = el('#fieldsub');
  if (sub) sub.innerHTML = fieldSub();
  const sync = el('#syncline');
  if (sync && state.sync) {
    const age = Math.max(0, Math.round((Date.now() - (state.sync.synced_at || 0)) / 1000));
    sync.textContent = 'Synced ' + (age < 60 ? age + 's' : Math.round(age / 60) + 'm') +
      ' ago · ' + state.devices.length + ' devices, ' + rooms().length + ' rooms';
  }
}

/* The phone's masthead: the time and what the house consists of, or — inside a
   room — the way back, the room, and its reading. */
function drawThin() {
  const tl = el('#thinleft'), tm = el('#thinmid'), tr = el('#thinright');
  if (!tl) return;
  if (state.view === 'room' && !state.q) {
    tl.textContent = '‹ HOUSE';
    tl.onclick = () => go('house');
    tm.textContent = title(state.room);
    const here = inRoom(state.room);
    tr.textContent = lit(here).length ? Math.round(output(here) * 100) + '%' : '';
  } else {
    const now = new Date();
    tl.textContent = String(now.getHours()).padStart(2, '0') + ':' +
                     String(now.getMinutes()).padStart(2, '0');
    tl.onclick = null;
    tm.textContent = '';
    tr.textContent = state.devices.length + ' devices · ' + rooms().length + ' rooms';
  }
}

/* Beside a room's board: what it is doing, and what of that is actually known.
   The second sentence is the one no other dashboard writes — half of what this
   hub reports is a reading and half is only what it last sent. */
function drawRoomSay() {
  const sec = el('#secroom');
  if (!sec) return;
  const inRoomView = state.view === 'room' && !state.q;
  sec.hidden = !inRoomView;
  if (!inRoomView) return;

  const items = inRoom(state.room);
  const on = lit(items);
  const cobs = cobsIn(state.room);
  const tunable = on.filter(d => d.is_tunable);
  const blind = items.filter(d => d.is_ac || d.is_curtain);

  el('#roomsay').textContent = on.length
    ? Math.round(output(items) * 100) + '% across ' + on.length +
      (on.length === 1 ? ' circuit' : ' circuits') +
      (cobs.length && lit(cobs).length ? ', ' + lit(cobs).length + ' of them COBs' : '') + '.'
    : 'Nothing is on in here.';

  const notes = [];
  if (tunable.length) notes.push('COLOUR IS ASKED FOR AND NEVER READ BACK');
  if (blind.length) notes.push(blind.length === 1
    ? '1 CIRCUIT REPORTS NOTHING BACK — AN AC IS INFRARED AND A CURTAIN HAS NO POSITION'
    : blind.length + ' CIRCUITS REPORT NOTHING BACK — AN AC IS INFRARED AND A CURTAIN HAS NO POSITION');
  el('#roomnote').textContent = notes.join(' · ');
}

/* The sentence moved onto the board, into sayCard(), so the side column can be
   what it should have been all along: rooms, cues and settings. */
function drawHero() { /* the board draws it now */ }

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
  root.setProperty('--lamp', lampColour(warmth));

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
  el('#mainword').textContent = on.length ? 'Hold · all off' : 'All dark';
  el('#maincount').textContent = on.length ? String(on.length) : '';
  m.setAttribute('aria-label', on.length
    ? 'Hold to switch off all ' + on.length + ' live circuits'
    : 'Nothing is on');

  // The thumb bar carries the same truth as the main button.
  const q = el('#qoff');
  if (q) {
    q.disabled = !on.length;
  // The label names what it will actually switch off from where you are.
  const inRoomView = state.view === 'room' && !state.q;
  const here = inRoomView ? lit(inRoom(state.room)) : on;
  el('#qoffword').textContent = here.length
    ? (inRoomView ? 'Room off · ' : 'All off · ') + here.length
    : (inRoomView ? 'Room dark' : 'All dark');
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

/* The colour a room is burning.
 *
 * Weighted by how much light each lamp is actually making, not a flat average
 * of their settings — a lamp at 5% has almost no say in what a room looks
 * like, and letting it vote equally with one at 80% put a room with a single
 * dim daylight COB somewhere near the middle of the scale, where the colour
 * goes to cream and the card stops reading as lit at all. */
function roomTint(on) {
  const tuned = on.filter(d => d.is_tunable && kindOf(d) === 'light');
  if (!tuned.length) return on.some(d => kindOf(d) === 'light') ? 'var(--warm)' : 'var(--neutral)';
  let sum = 0, weight = 0;
  for (const d of tuned) {
    const w = Math.max(0.08, (d.is_dimmable ? d.level : 100) / 100);
    sum += d.tune * w;
    weight += w;
  }
  return lampColour(weight ? sum / weight : 50);
}

/* Which way the next board should arrive from.
 *
 * Replacing a board's contents in place is a page load: everything is simply
 * different the next frame. A phone never does that — going into a room comes
 * from the right, coming back out from the left — and that direction is the
 * only thing telling you whether you went deeper or backed out. Set here
 * rather than in drawField(), because drawField also runs on every keystroke
 * of a search and on the fifteen-second refresh, and neither of those is a
 * move through the house. */
let navFrom = null;

function go(view, room) {
  // Going anywhere ends the search. Without this the layer stayed up over the
  // room you had just opened, and the thumb bar — hidden while seeking — never
  // came back, so all-off and the timer were simply gone.
  if (document.body.classList.contains('seeking')) openSeek(false);
  const same = state.view === view && state.room === (room || null);
  navFrom = same ? null : view === 'room' ? 'push' : 'pop';
  if (!same) tick_haptic(6);
  state.view = view;
  state.room = room || null;
  if (state.q) { state.q = ''; el('#seek').value = ''; resetSeek(); }
  drawField();
  for (const t of document.querySelectorAll('#tabs .tab')) {
    if (t.dataset.room) tabState(t, t.dataset.room); else houseTabState(t);
  }
}

/* ───────────────────────────────────────────────────────────── the field */

function fieldSub() {
  if (state.q) {
    const n = matches().length;
    const cmd = parseCommand(state.q);
    // Offering to run something and reporting nothing found are different
    // states, and saying both at once reads as a failure.
    if (cmd && !cmd.bad && !n) return 'Press ↵ to run it';
    return n + (n === 1 ? ' circuit matches' : ' circuits match');
  }
  const items = state.view === 'room' ? inRoom(state.room) : state.devices;
  const on = lit(items).length;
  if (on) return '<b>' + on + '</b> of ' + items.length + ' on';
  // A count of things that are off is not information anybody wants.
  return state.view === 'room' ? 'This room is dark' : 'The house is dark';
}

/* ─────────────────────────────────────────────────────── the command bar

   The server already speaks an address grammar — /do/ashu/cobs/down — and it
   is one word per segment, so what you type maps onto it directly. The field
   keeps searching as you type; when the words happen to form a command, a row
   appears offering to run it, and Enter does.

   Worth knowing: Enter does not clear the field, so pressing it again repeats
   the command. That is what makes 'ashu cobs down' worth typing — three
   presses and you are at a quarter brightness. */
let grammar = null;
const loadGrammar = () => fetch('/do').then(r => r.json()).then(g => { grammar = g; }).catch(() => {});

const ACTION_SAYS = {
  on: 'on', off: 'off', toggle: 'the other way', up: '20% brighter', down: '20% dimmer',
  warm: 'warm', cool: 'cool', warmer: 'a little warmer', cooler: 'a little cooler',
  open: 'open', close: 'closed', stop: 'stopped',
};

const isActionWord = (w) =>
  /^\\d{1,3}$/.test(w) || /^(warmth|tune)-\\d{1,3}$/.test(w) || !!ACTION_SAYS[w];

const saysFor = (w) => /^\\d{1,3}$/.test(w) ? 'to ' + Number(w) + '%'
  : /^(warmth|tune)-\\d{1,3}$/.test(w) ? 'to ' + warmthWord(Number(w.split('-')[1]))
  : ACTION_SAYS[w];

/* Read the line back to front.
 *
 * The grammar is room, then an optional circuit, then one or two actions —
 * and the only way to tell "ashu cobs 40" from "ashu 40 warm" is which of the
 * middle words is a circuit. So the actions are taken off the end first, and
 * whatever is left in the middle is the circuit. Two actions are allowed
 * because brightness and colour go down different channels and setting both
 * at once is the thing you actually want: a lamp that comes on at the level
 * *and* the colour you meant, not the level and then, a second later, the
 * colour. */
function parseCommand(q) {
  if (!grammar) return null;
  const w = q.trim().toLowerCase().split(/\\s+/).filter(Boolean);
  if (w.length < 2 || w.length > 4) return null;

  const acts = [];
  while (w.length > 1 && acts.length < 2 && isActionWord(w[w.length - 1])) acts.unshift(w.pop());
  if (!acts.length || w.length > 2) return null;

  const room = grammar.rooms.find(r => r.room.startsWith(w[0]));
  if (!room) return null;

  let circuit = null;
  if (w.length === 2) {
    const hits = room.circuits.filter(c => c.startsWith(w[1]));
    if (hits.length !== 1) {
      return { bad: hits.length
        ? 'That could be ' + hits.slice(0, 5).join(', ')
        : 'No circuit called ' + w[1] + ' in ' + title(room.room.replace('-', ' ')) };
    }
    circuit = hits[0];
  }

  const what = circuit ? title(circuit.replace(/-/g, ' ')) : 'Everything';
  const where = title(room.room.replace(/-/g, ' '));
  return {
    path: '/do/' + [room.room, circuit, acts.join('+')].filter(Boolean).join('/'),
    says: what + ' in ' + where + ' \u2014 ' + acts.map(saysFor).join(' and '),
  };
}

/* What can legally come next, given what has been typed so far.
 *
 * The grammar is one word per segment — room, then circuit, then action — so
 * knowing which segment the caret is in is enough to know the whole set of
 * valid next words. That set does two jobs: the first match is drawn under the
 * caret as a completion, and the whole list becomes the chips on the board.
 * Both mean the field can teach the grammar as it is used instead of printing
 * a line of examples nobody reads twice. */
const PLAIN_ACTIONS = ['on', 'off', 'toggle', 'up', 'down',
  'warm', 'cool', 'warmer', 'cooler', 'open', 'close', 'stop'];

function nextWords(q) {
  if (!grammar) return null;
  const low = q.toLowerCase();
  // A trailing space means the word before it is finished.
  const ended = /\\s$/.test(low) || low === '';
  const w = low.trim().split(/\\s+/).filter(Boolean);
  const partial = ended ? '' : (w[w.length - 1] || '');
  const done = ended ? w : w.slice(0, -1);

  let pool = null, what = '';
  if (done.length === 0) { pool = grammar.rooms.map(r => r.room); what = 'room'; }
  else {
    const room = grammar.rooms.find(r => r.room.startsWith(done[0]));
    if (!room) return null;
    const rest = done.slice(1);
    if (rest.length === 0) { pool = room.circuits.concat(PLAIN_ACTIONS); what = 'circuit or action'; }
    else if (rest.length === 1) { pool = PLAIN_ACTIONS; what = 'action'; }
    // A second action is allowed, but only after the first — 'and also' rather
    // than 'action', because by here it is plainly an addition.
    else if (rest.length === 2 && isActionWord(rest[1])) { pool = PLAIN_ACTIONS; what = 'and also'; }
    else return null;
  }
  return { partial, what, options: pool.filter(o => o.startsWith(partial) && o !== partial) };
}

async function runCommand(cmd) {
  const row = el('#cmdrow');
  if (row) row.classList.add('running');
  try {
    const body = await fetch(cmd.path).then(r => r.json());
    if (!body.ok) throw new Error(body.error || 'The hub did not answer');
    tick_haptic(9);
    note(body.spoken + '.');
    setTimeout(() => sync(true), 900);
  } catch (err) {
    tick_haptic([12, 60, 12]);
    note(err.message + '.');
  } finally {
    if (row) row.classList.remove('running');
  }
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
  /* While the phone's search layer is up it is the only thing on screen, so
     the results go there and the board underneath is left exactly as it was —
     which is what makes Done put you back where you started rather than on a
     freshly drawn house. */
  if (onPhone() && document.body.classList.contains('seeking')) {
    const host = el('#seekresults');
    const foot = el('#seekfoot');
    host.innerHTML = '';
    foot.innerHTML = '';
    if (state.q.trim()) fillSearch(host);
    else {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'A room, a circuit, or a whole command — try ashu cobs 40 warm.';
      host.appendChild(p);
      const next = nextWords('');
      if (next) foot.appendChild(chipRow(next));
    }
    // The chips belong beside the field, not at the top of the results.
    const chips = host.querySelector('.chips');
    if (chips) foot.appendChild(chips);
    return;
  }

  const stack = el('#stack');
  stack.innerHTML = '';
  stack.scrollTop = 0;

  // The say card states the house in a sentence, so a heading saying the same
  // thing above it is a label on a label.
  const head = document.querySelector('.field-head');
  if (head) head.hidden = state.view === 'house' && !state.q;
  el('#fieldname').textContent =
    state.q ? (parseCommand(state.q) ? 'Command' : 'Search')
      : state.view === 'room' ? title(state.room) : 'The house';
  el('#fieldsub').innerHTML = fieldSub();
  // A room's heading carries its reading, so the number you came to see is at
  // the top of the screen rather than only inside a card.
  const pct = el('#headpct');
  if (pct) {
    const here = state.view === 'room' && !state.q ? inRoom(state.room) : null;
    pct.textContent = here && lit(here).length ? Math.round(output(here) * 100) + '%' : '';
  }

  const back = el('#back');
  back.hidden = state.view === 'house' && !state.q;
  back.querySelector('span').textContent = state.q ? 'Back to the house' : 'The house';

  const cut = el('#cut');
  cut.hidden = state.view !== 'room' || !!state.q;
  if (!cut.hidden) {
    cut.disabled = !lit(inRoom(state.room)).length;
    cut.onclick = () => {
      const on = lit(inRoom(state.room));
      switchOffMany(on, 'Switching off ' + on.length + ' in ' + title(state.room) + '.');
    };
  }

  drawThin();
  const inRoomView = state.view === 'room' && !state.q;
  const fieldEl = document.querySelector('.field');
  if (fieldEl) fieldEl.classList.toggle('in-room', inRoomView);
  const quick = el('#quick');
  if (quick) quick.classList.toggle('in-room', inRoomView);
  // A timer fired from a room means that room, not the whole house.
  for (const b of document.querySelectorAll('.qmin')) b.dataset.scope = inRoomView ? 'room' : 'house';
  drawRoomSay();
  stack.classList.toggle('as-house', state.view === 'house' && !state.q);
  const drawn = state.q ? fillSearch(stack)
    : state.view === 'room' ? fillRoom(stack, state.room)
    : fillHouse(stack);
  dealIn(stack);
  fitTiles();
  watchScroll();
  wheelToBoard();
  return drawn;
}

/* Deal the board in rather than switching it on.
 *
 * One card every 26ms, capped at ten so a fourteen-circuit room does not take
 * half a second to finish arriving, and sliding in from whichever side the
 * move came from. The cap matters more than the interval: an uncapped stagger
 * makes long rooms feel slower than short ones, which is backwards. */
function dealIn(stack) {
  stack.classList.remove('push', 'pop');
  if (!navFrom) return;
  const dir = navFrom;
  navFrom = null;
  void stack.offsetWidth;                 // restart the animation, do not resume it
  stack.classList.add(dir);
  let i = 0;
  for (const kid of stack.children) {
    kid.style.animationDelay = Math.min(i++, 10) * 26 + 'ms';
  }
}

// The house is a board of rooms.
/* The house, said once and then drawn.
 *
 * The sentence is the only place the interface speaks, so it gets the serif and
 * the coral numerals. Under it, one column per room: height for how much light
 * is in it, colour for how warm that light is, and the whole row doubles as
 * navigation. It replaces a tally nobody reads with a shape you can take in
 * before you have read a word. */
function sayCard() {
  const card = document.createElement('div');
  card.className = 'saycard enter';
  card.innerHTML = '<p class="say" id="saysentence"></p><div class="bars" id="bars"></div>';

  const on = lit(state.devices).length;
  const rooms_lit = rooms().filter(r => lit(inRoom(r)).length).length;
  card.querySelector('.say').innerHTML = on
    ? '<b>' + on + '</b> lit, across <b>' + rooms_lit + '</b> ' + (rooms_lit === 1 ? 'room' : 'rooms')
    : 'The house is dark';

  const bars = card.querySelector('.bars');
  for (const room of rooms()) {
    const items = inRoom(room);
    const onHere = lit(items);
    const load = output(items);
    const col = document.createElement('button');
    col.type = 'button';
    col.className = 'barcol' + (onHere.length ? ' on' : '');
    col.innerHTML = '<span class="barwell"><span class="bar"></span></span>' +
                    '<span class="barlabel"></span>';
    col.style.setProperty('--tint', onHere.length ? roomTint(onHere) : 'var(--line-up)');
    col.querySelector('.bar').style.height =
      (onHere.length ? Math.max(14, Math.round(load * 100)) : 4) + '%';
    col.querySelector('.barlabel').textContent = title(room);
    col.setAttribute('aria-label', title(room) + ', ' +
      (onHere.length ? Math.round(load * 100) + ' per cent' : 'dark'));
    col.onclick = () => go('room', room);
    bars.appendChild(col);
  }
  return card;
}

function fillHouse(stack) {
  stack.appendChild(sayCard());
  // Whichever room is carrying the most light takes the big square. If the
  // house is dark nothing is promoted — a hero card for an empty room would be
  // a lie about where to look.
  const all = rooms();
  let hero = null, best = 0;
  for (const room of all) {
    const load = output(inRoom(room)) * lit(inRoom(room)).length;
    if (load > best) { best = load; hero = room; }
  }
  // The big one leads, and the rest follow in the order of how much light they
  // are carrying — so the cards arrive brightest first and the eye lands where
  // the light is before a single word has been read. The order is the
  // information; there is no stagger for its own sake.
  const byLight = (a, b) => output(inRoom(b)) - output(inRoom(a));
  const order = hero
    ? [hero, ...all.filter(r => r !== hero).sort(byLight)]
    : all;
  order.forEach((room, i) => {
    const tile = roomTile(room, room === hero);
    tile.style.animationDelay = (i * 42) + 'ms';
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
    // The COBs lead the lights, on one control — they are a ceiling, not five
    // switches. Their own tiles stay below it for the times one lamp is the point.
    const cobs = kind === 'light' ? group.filter(isCob) : [];
    if (cobs.length > 1) stack.appendChild(cobTile(room, cobs));
    /* Whatever is on comes first. Walking into a room, the question is never
       "where is the bed spot" — it is "what is burning", and the answer was
       scattered through fourteen cards in installer order. A stable sort, so
       within the lit half and within the dark half everything keeps the order
       it had. */
    const byLit = [...group].sort((a, b) => (b.status ? 1 : 0) - (a.status ? 1 : 0));
    byLit.forEach(d => {
      stack.appendChild(circuitTile(d, cobs.length > 1 && isCob(d)));
    });
  }
}

/* The next word, offered rather than described — one row, led by which slot
   it fills, because a bare list of words does not say what it is a list of. */
function chipRow(next) {
  const chips = document.createElement('div');
  chips.className = 'chips';
  const lead = document.createElement('span');
  lead.className = 'chips-lead';
  lead.textContent = next.what;
  chips.appendChild(lead);
  for (const word of next.options.slice(0, 14)) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'chip-word';
    c.textContent = word;
    c.onclick = () => takeWord(word);
    chips.appendChild(c);
  }
  return chips;
}

function fillSearch(stack) {
  const cmd = parseCommand(state.q);
  if (cmd) {
    const row = document.createElement(cmd.bad ? 'div' : 'button');
    row.id = 'cmdrow';
    row.className = 'cmd' + (cmd.bad ? ' cmd-bad' : '');
    if (!cmd.bad) { row.type = 'button'; row.onclick = () => runCommand(cmd); }
    row.innerHTML = '<span class="cmd-says"></span>' +
      (cmd.bad ? '' : '<span class="cmd-key">↵</span>');
    row.querySelector('.cmd-says').textContent = cmd.bad || cmd.says;
    stack.appendChild(row);
  }

  /* The next word, offered rather than described. A command bar whose grammar
     you have to remember is a command line, and this one is meant to be usable
     by someone who has not read SHORTCUTS.md. */
  const next = nextWords(state.q);
  if (next && next.options.length) stack.appendChild(chipRow(next));

  const found = matches();
  if (!found.length) {
    if (cmd && !cmd.bad) return;          // the command is the answer
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

function roomTile(room, hero) {
  const tile = document.createElement('div');
  // The hero class has to be on before the first paint, not after: the chip's
  // label depends on it, and adding it afterwards left the big card saying the
  // short form until the next refresh happened to redraw it.
  tile.className = 'tile enter' + (hero ? ' hero-room' : '');
  tile.dataset.room = room;
  tile.innerHTML =
    '<span class="tile-fill"></span>' +
    '<button class="tile-body" type="button">' +
      '<span class="roomname"></span><span class="big"></span><span class="sub"></span>' +
    '</button>' +
    '<button class="chip" type="button"></button>';
  tile.querySelector('.roomname').textContent = title(room);
  tile.querySelector('.tile-body').onclick = () => go('room', room);
  tile.querySelector('.chip').onclick = (e) => {
    e.stopPropagation();
    const on = lit(inRoom(room));
    if (!on.length) return;
    switchOffMany(on, 'Switching off ' + on.length + ' in ' + title(room) + '.');
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
  // The reading a room deserves is the light in it, not a tally of switches.
  const pct = Math.round(output(items) * 100);
  // A dark room states nothing and offers nothing: no reading, and no chip,
  // because there is nothing there to switch off. Saying "dark" twice — once
  // as a word and once as a disabled button — was noise on six of seven cards.
  tile.querySelector('.big').textContent = on.length ? pct + '%' : '';
  tile.querySelector('.sub').textContent = on.length + ' of ' + items.length + ' lit';
  const chip = tile.querySelector('.chip');
  chip.hidden = !on.length;
  // The hero has the width for two words; a card in a four-column board on a
  // tablet does not, and 'ALL OFF' there left three letters of the room name.
  // On a room card 'off' can only mean this room, so the short form loses
  // nothing. The label read aloud stays the long one.
  chip.textContent = tile.classList.contains('hero-room') ? 'ALL OFF' : 'OFF';
  chip.setAttribute('role', 'button');
  chip.setAttribute('aria-label', 'Turn off everything in ' + title(room));
  tile.querySelector('.tile-body').setAttribute('aria-label',
    'Open ' + title(room) + ', ' + (on.length ? pct + ' per cent, ' + on.length + ' of ' + items.length + ' lit' : 'dark'));
}

/* ──────────────────────────────────────────────────── a circuit's tile */

function circuitTile(d, compact) {
  const kind = kindOf(d);
  const tile = document.createElement('div');
  // Width follows what the circuit can actually do: two sliders need room, a
  // plain switch does not.
  const roomy = d.is_tunable || d.is_ac || d.is_curtain;
  // The compact flag has to be on before the first paint: the reading depends
  // on it, and adding the class afterwards left the card showing the long form
  // until something happened to redraw it.
  tile.className = 'tile enter ' + kind + (d.is_dimmable ? ' dims' : '') + (d.is_tunable ? ' tunes' : '')
    + (roomy ? ' wide' : '') + (d.is_dimmable && !d.is_tunable ? ' tall' : '')
    + (compact ? ' cobmember' : '');
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
  body.innerHTML = '<span class="roomname"></span><span class="idline"></span><span class="state"></span>';
  body.querySelector('.roomname').textContent = pretty(d.name).toUpperCase();
  body.querySelector('.idline').textContent = idLine(d);
  tile.appendChild(body);

  // A curtain is two momentary relays with nothing to report, so it has no key.
  if (!d.is_curtain) {
    const ring = document.createElement('button');
    ring.type = 'button';
    ring.className = 'ring';
    ring.onclick = (e) => { e.stopPropagation(); setDevice(d, !d.status); };
    tile.appendChild(ring);
  }

  if (d.is_dimmable || d.is_tunable) {
    const controls = document.createElement('div');
    controls.className = 'controls';
    if (d.is_dimmable) controls.appendChild(slider(d, 'level'));
    if (d.is_tunable) controls.appendChild(slider(d, 'tune'));
    tile.appendChild(controls);
  }

  // The one circuit class that has to say why its reading is not a reading.
  if (d.is_ac) {
    const note_ = document.createElement('span');
    note_.className = 'blindnote';
    note_.textContent = 'IR IS ONE-WAY — THE REMOTE IS INVISIBLE TO US';
    body.appendChild(note_);
  }

  if (d.is_curtain) tile.appendChild(curtainPulls(d));
  if (d.is_ac) tile.appendChild(climateDrawer(d));

  paintTile(tile, d);
  return tile;
}

/* A strip rather than a track. The colour one carries its value in the label,
   since warmth has no unit anybody reads off a scale. */
function stripLabel(d, key) {
  return key === 'level' ? 'BRIGHTNESS' : warmthLabel(d.tune);
}

function slider(d, key) {
  const wrap = document.createElement('label');
  wrap.className = 'strip ' + (key === 'level' ? 'dimstrip' : 'warmstrip');
  wrap.innerHTML = '<span class="strip-fill"></span><span class="strip-hand"></span>' +
                   '<span class="strip-label"></span>';
  wrap.querySelector('.strip-label').textContent = stripLabel(d, key);
  wrap.style.setProperty('--at', d[key] + '%');

  const input = document.createElement('input');
  input.type = 'range';
  input.className = key === 'level' ? 'slider dim' : 'slider warm';
  input.min = 0; input.max = 100; input.step = 1;
  input.value = d[key];
  input.dataset.key = key;
  input.setAttribute('aria-label', pretty(d.name) +
    (key === 'level' ? ' brightness' : ' warmth, 0 cool to 100 warm'));
  wrap.appendChild(input);

  input.addEventListener('input', () => {
    const v = Number(input.value);
    d[key] = v;
    if (key === 'level') d.status = v > 0;
    wrap.style.setProperty('--at', v + '%');
    wrap.querySelector('.strip-label').textContent = stripLabel(d, key);
    paintTile(input.closest('.tile'), d);
    if (key === 'level') tick();
    queueSlider(d, key);
  });
  // A keyboard press or a released drag is the final word.
  input.addEventListener('change', () => queueSlider(d, key, true));
  return wrap;
}

/* ─────────────────────────────────────── the COBs of a room, as one control */

/* Every room here has COBs — five in Ashu, eleven in Living — and they are one
   ceiling of light that is nearly always wanted at one setting. This tile is
   that setting: one key, one brightness, one warmth, all of them together down
   a single socket. The individual tiles stay below it, so nothing is lost. */
function cobTile(room, members) {
  const dims = members.every(d => d.is_dimmable);
  const tunes = members.every(d => d.is_tunable);
  const tile = document.createElement('div');
  tile.className = 'tile enter light gang' + (dims ? ' dims' : '') + (tunes ? ' tunes' : '')
    + (tunes ? ' wide' : dims ? ' tall' : '');
  tile.dataset.gang = room;
  tile.title = 'All ' + members.length + ' COB circuits in ' + title(room) + ', together';

  const fill = document.createElement('span');
  fill.className = 'tile-fill';
  tile.appendChild(fill);

  const body = document.createElement('div');
  body.className = 'tile-body gangbody';
  body.innerHTML =
    '<span class="roomhead"><span class="roomname gangtitle"></span>' +
      '<button class="chip gangsame" type="button"></button></span>' +
    '<span class="big gangbig"></span>';
  body.querySelector('.gangtitle').textContent =
    'ALL COBS · ' + members.length + ' ON ONE MODULE';
  body.querySelector('.gangsame').onclick = () => setGang(tile);
  tile.appendChild(body);

  if (dims || tunes) {
    const controls = document.createElement('div');
    controls.className = 'controls';
    if (dims) controls.appendChild(gangSlider(tile, 'level'));
    if (tunes) controls.appendChild(gangSlider(tile, 'tune'));
    tile.appendChild(controls);
  }

  paintGang(tile);
  return tile;
}

/* What the set reads as.
 *
 * Brightness is averaged over the lamps that are ON, not over all of them.
 * Four dark lamps and one at full is a ceiling set to 100 with most of it
 * switched off — it is not a ceiling at 20%, and showing 20 meant a single
 * nudge of the slider slammed every lamp down to a fifth. Colour averages over
 * everything, because a lamp keeps its colour while it is off. */
function gangMean(members, key) {
  const pool = key === 'level' ? members.filter(d => d.status) : members;
  if (!pool.length) return 0;
  return Math.round(pool.reduce((s, d) => s + (d[key] || 0), 0) / pool.length);
}

function gangRead(members) {
  const on = lit(members);
  if (!on.length) return 'all ' + members.length + ' off';
  if (on.length < members.length) return on.length + ' of ' + members.length + ' on';
  const level = members.every(d => d.is_dimmable) ? gangMean(members, 'level') + '%' : 'on';
  return members.every(d => d.is_tunable)
    ? level + ' · ' + warmthWord(gangMean(members, 'tune')) : level;
}

function paintGang(tile) {
  const members = cobsIn(tile.dataset.gang);
  if (!members.length) return;
  const on = lit(members);
  const load = output(members);
  tile.style.setProperty('--tint', on.length ? roomTint(on) : 'var(--warm)');
  tile.classList.toggle('on', on.length > 0);
  tile.style.setProperty('--lit', load.toFixed(3));
  tile.querySelector('.tile-fill').style.setProperty('--fill', load.toFixed(3));
  // A drag owns these sliders until the hub has answered — the same rule the
  // single tiles follow, or a repaint would jump the handle under the finger.
  const busy = members.some(d => inFlight.has(d.record_id));
  for (const input of tile.querySelectorAll('.slider')) {
    if (busy || input === document.activeElement) continue;
    const k = input.dataset.key;
    const v = gangMean(members, k);
    input.value = v;
    const strip = input.closest('.strip');
    if (strip) {
      strip.style.setProperty('--at', v + '%');
      strip.querySelector('.strip-label').textContent = k === 'level' ? 'BRIGHTNESS' : warmthLabel(v);
    }
  }

  const allOn = members.every(d => d.status);
  const big = tile.querySelector('.gangbig');
  if (big) big.textContent = on.length ? gangMean(members, 'level') + '%' : '';
  const same = tile.querySelector('.gangsame');
  if (same) {
    // The button says what pressing it will do, which changes with the state:
    // a ceiling half on wants levelling, a ceiling fully on wants putting out.
    same.textContent = allOn ? 'ALL OFF'
      : on.length ? (onPhone() ? 'ALL THE SAME' : 'MAKE THEM ALL THE SAME')
      : 'ALL ON';
    same.setAttribute('aria-label', same.textContent.toLowerCase() + ', ' + members.length + ' COBs');
  }
}

function gangSlider(tile, key) {
  const wrap = document.createElement('label');
  wrap.className = 'strip ' + (key === 'level' ? 'dimstrip' : 'warmstrip');
  wrap.innerHTML = '<span class="strip-fill"></span><span class="strip-hand"></span>' +
                   '<span class="strip-label"></span>';

  const input = document.createElement('input');
  input.type = 'range';
  input.className = key === 'level' ? 'slider dim' : 'slider warm';
  input.min = 0; input.max = 100; input.step = 1;
  input.dataset.key = key;
  const start = gangMean(cobsIn(tile.dataset.gang), key);
  input.value = start;
  wrap.style.setProperty('--at', start + '%');
  wrap.querySelector('.strip-label').textContent =
    key === 'level' ? 'BRIGHTNESS' : warmthLabel(start);
  wrap.appendChild(input);
  input.setAttribute('aria-label',
    'All COBs ' + (key === 'level' ? 'brightness' : 'warmth, 0 cool to 100 warm'));

  input.addEventListener('input', () => {
    const v = Number(input.value);
    for (const d of cobsIn(tile.dataset.gang)) {
      d[key] = v;
      if (key === 'level') d.status = v > 0;
      paint(d);                                  // the room's own tiles follow
    }
    wrap.style.setProperty('--at', v + '%');
    wrap.querySelector('.strip-label').textContent = key === 'level' ? 'BRIGHTNESS' : warmthLabel(v);
    if (key === 'level') tick();
    paintGang(tile);
    queueGang(tile, key);
  });
  input.addEventListener('change', () => queueGang(tile, key, true));
  return wrap;
}

/* ────────────────────────────────────────────────── drawing one circuit */

/* On the compact COB tile the rails already show brightness and colour, and
   the face is 74px narrower to make room for them — so the full reading wraps
   to four lines and buries the name. The card says the short version and lets
   the rails say the rest. */
const shortState = (d) => !d.status ? 'OFF' : d.is_dimmable ? 'ON · ' + d.level + '%' : 'ON';

function paintTile(tile, d) {
  if (!tile) return;
  tile.style.setProperty('--tint', tintOf(d));
  tile.classList.toggle('on', d.status);
  const level = d.status ? (d.is_dimmable ? Math.max(d.level, 8) : 100) : 0;
  // How much light this circuit is making drives the glow, not just the fill.
  tile.style.setProperty('--lit', (level / 100).toFixed(3));
  tile.querySelector('.tile-fill').style.setProperty('--fill', (level / 100).toFixed(3));
  const st = tile.querySelector('.state');
  if (st) st.textContent = tile.classList.contains('cobmember') ? shortState(d) : stateWord(d);

  for (const input of tile.querySelectorAll('.slider')) {
    if (input === document.activeElement) continue;   // never fight the hand on the slider
    const k = input.dataset.key;
    input.value = d[k];
    const strip = input.closest('.strip');
    if (strip) {
      strip.style.setProperty('--at', d[k] + '%');
      strip.querySelector('.strip-label').textContent = stripLabel(d, k);
    }
  }

  const ring = tile.querySelector('.ring');
  if (ring) {
    ring.setAttribute('aria-pressed', String(d.status));
    ring.setAttribute('aria-label', (d.status ? 'Turn off ' : 'Turn on ') + pretty(d.name));
  }
  const body = tile.querySelector('button.tile-body');
  if (body) {
    body.setAttribute('aria-pressed', String(d.status));
    body.setAttribute('aria-label', pretty(d.name) + ', ' + title(d.room) + ', ' + readWord(d));
  }
}

/* What a circuit is, in the hub's own terms — the id is the thing you would
   quote to an electrician, so it is shown rather than hidden in a tooltip. */
function idLine(d) {
  const kind = d.is_curtain ? 'CURTAIN' : d.is_ac ? 'AIR CON'
    : kindOf(d) === 'screen' ? 'SCREEN' : d.is_fan ? 'FAN'
    : d.is_dimmable ? 'DIMMER' : 'SWITCH';
  return kind + ' #' + d.record_id;
}

/* What it is doing, in one word where one word is honest. An air conditioner
   gets a longer one because a shorter one would be a lie. */
function stateWord(d) {
  if (d.is_curtain) return 'NO READING';
  // An air conditioner is infrared and cannot be read back, so this one stays
  // hedged however much plainer 'ON' would be. Saying 'ON' about a unit the
  // hub cannot hear would be the dashboard inventing a fact.
  if (d.is_ac) return (d.status ? 'HUB SENT ON' : 'HUB SENT OFF');
  if (!d.status) return 'OFF';
  // Everything that is genuinely on says so first, in the same word, whatever
  // it is. A fan used to say TURNING and a lamp used to say 40% — both true,
  // neither of them the thing you are scanning the board for, which is simply
  // which circuits are awake.
  if (d.is_fan) return 'ON';
  if (d.is_dimmable) return 'ON · ' + d.level + '%' + (d.is_tunable ? ' · ' + warmthWord(d.tune).toUpperCase() : '');
  return 'ON';
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
  // A verdict takes about five seconds to come back, which is long enough to
  // press the key again — and when it lands it must not write the value it was
  // asking about. Switch a lamp on and straight off and the first reply would
  // otherwise arrive last, turning it back on for a second. So each press takes
  // a token, and a press that is no longer the latest says nothing at all.
  const token = ++clickSeq;
  clicks.set(d.record_id, token);
  const mine = () => clicks.get(d.record_id) === token;

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

    // A newer press owns this circuit now; this verdict is about a state the
    // user has already moved on from, so it stays quiet.
    if (!mine()) return;

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
    if (!mine()) return;                           // a newer press owns the tile
    d.status = was;
    d.level = wasLevel;                            // put it back
    refuse(d);
    note(pretty(d.name) + ' — ' + err.message + '. Nothing changed.');
  } finally {
    // Only the latest press may release the circuit, or an older reply would
    // hand it back to the poll while a newer command is still in the air.
    if (mine()) inFlight.delete(d.record_id);
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

/* ────────────────────────────────────── switching a room's COBs together */

/* The key makes them all the same, which is the only thing "all" can mean.
 *
 * It used to switch off whenever any single lamp was lit, so pressing All COBs
 * on a ceiling with one lamp on put that one out — the opposite of what the
 * control appears to offer. Now anything short of all-on turns them all on, and
 * only a ceiling that is already fully lit switches off. Coming on, they match
 * the brightest lamp already burning rather than jumping to full, so pressing
 * it with one lamp at 40% gives you five at 40%. */
async function setGang(tile) {
  const members = cobsIn(tile.dataset.gang);
  const next = !members.every(d => d.status);
  const level = next
    ? Math.max(100 * 0, ...members.filter(d => d.status).map(d => (d.is_dimmable ? d.level : 100)), 0) || 100
    : 0;
  const was = members.map(d => ({ d, status: d.status, level: d.level }));

  for (const d of members) {
    d.status = next;
    if (d.is_dimmable) d.level = next ? level : 0;
    paint(d);
    inFlight.add(d.record_id);
    markCommanded(d.record_id);
  }
  paintGang(tile);
  tick();

  try {
    const res = await fetch('/api/group', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next
        ? { record_ids: members.map(d => d.record_id), on: true, level }
        : { record_ids: members.map(d => d.record_id), on: false }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || 'Hub did not respond');
    tick_haptic(9);
  } catch (err) {
    for (const { d, status, level } of was) { d.status = status; d.level = level; paint(d); }
    paintGang(tile);
    tick();
    tick_haptic([12, 60, 12]);
    note('The COBs did not move — ' + err.message);
  } finally {
    // The group is not confirmed, so let the next hub read speak for it.
    setTimeout(() => { members.forEach(d => inFlight.delete(d.record_id)); }, 4000);
  }
}

/* A group send is not one command but one per member, so a drag across an
   eleven-lamp ceiling puts eleven payloads on the wire every time the debounce
   fires — and the next batch starts before the last has finished. They then
   land interleaved, and a lamp can end on a value from the middle of the drag
   rather than the one your finger stopped at. Which looks exactly like the
   group failing to move all of them.
   So only one batch is ever in flight per group, and the value the hand
   finished on is always the last thing sent. */
const gangSending = new Map();

function queueGang(tile, key, now) {
  const id = 'gang:' + tile.dataset.gang + ':' + key;
  for (const d of cobsIn(tile.dataset.gang)) {
    inFlight.add(d.record_id);
    markCommanded(d.record_id);
  }
  clearTimeout(sliderTimers.get(id));
  // A little slower than a single circuit's 200ms: each fire costs one command
  // per lamp, so firing often is what floods the hub in the first place.
  sliderTimers.set(id, setTimeout(() => sendGang(tile, key), now ? 0 : 320));
}

async function sendGang(tile, key) {
  const members = cobsIn(tile.dataset.gang);
  if (!members.length) return;

  const id = 'gang:' + tile.dataset.gang + ':' + key;
  if (gangSending.get(id)) { gangSending.set(id, 'again'); return; }
  gangSending.set(id, true);

  const value = gangMean(members, key);
  const body = { record_ids: members.map(d => d.record_id) };
  if (key === 'level') { body.level = value; body.on = value > 0; } else { body.tune = value; }

  try {
    const res = await fetch('/api/group', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || 'Hub did not respond');
  } catch (err) {
    note('All COBs — ' + err.message + '. The setting may not have changed.');
  } finally {
    const queued = gangSending.get(id) === 'again';
    gangSending.delete(id);
    // Something moved while we were sending: send where it ended up, so the
    // last write is the value the hand finished on.
    if (queued) return sendGang(tile, key);
    setTimeout(() => { members.forEach(d => inFlight.delete(d.record_id)); }, 4000);
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
  /* The cue list is drawn after watchScroll has already measured, and it is
     the thing that decides how far the column runs — so both the column and
     the rail have to be re-read here or neither draws its fade on load. */
  markScrollX(host);
  markScroll(document.querySelector('.index'));
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

/* ─────────────────────────────────────────────────────────── schedules
 *
 * One list for the whole house. Nothing here is per-browser: the server holds
 * it, every change goes back over the same endpoints, and the snapshot pushes
 * the result to whoever else is looking.
 */

const DAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* Which days, said the way a person would: the two everyday cases get their
   own words because "Mon, Tue, Wed, Thu, Fri" is a list you have to parse. */
function daysWord(days) {
  const d = [...(days || [])].sort();
  if (d.length === 7) return 'Every day';
  if (d.length === 5 && d.join() === '1,2,3,4,5') return 'Weekdays';
  if (d.length === 2 && d.join() === '0,6') return 'Weekends';
  if (!d.length) return 'No days — never runs';
  return d.map(i => DAY_FULL[i].slice(0, 3)).join(' · ');
}

/* 07:30 in the clock the house keeps. Kept as typed rather than reformatted —
   the field is a real time input and the server stores exactly this. */
const schedTime = (at) => at;

function drawSchedules() {
  const host = el('#schedlist');
  if (!host) return;
  host.innerHTML = '';
  if (!state.schedules.length) {
    const p = document.createElement('p');
    p.className = 'sched-empty';
    p.textContent = 'Nothing scheduled. The house does what you tell it, when you tell it.';
    host.appendChild(p);
    return;
  }
  const order = [...state.schedules].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const sch of order) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sched' + (sch.enabled ? ' live' : '') + (sch.target_missing ? ' gone' : '');
    row.onclick = (e) => { if (!e.target.closest('.sched-on')) openSchedSheet(sch); };

    const when = document.createElement('span');
    when.className = 'sched-when';
    when.textContent = schedTime(sch.at);

    const what = document.createElement('span');
    what.className = 'sched-what';
    what.textContent = schedWhat(sch);

    const days = document.createElement('span');
    days.className = 'sched-days';
    days.textContent = daysWord(sch.days) + (sch.enabled ? '' : ' · paused');

    /* The dot is a switch, not a lamp: pausing a schedule is the thing you do
       most often and it should not cost opening the sheet. */
    const dot = document.createElement('span');
    dot.className = 'sched-on';
    dot.setAttribute('role', 'button');
    dot.tabIndex = 0;
    dot.setAttribute('aria-pressed', String(!!sch.enabled));
    dot.setAttribute('aria-label', (sch.enabled ? 'Pause' : 'Resume') + ' this schedule');
    dot.innerHTML = '<i></i>';
    const flip = async (ev) => {
      ev.stopPropagation();
      await saveSchedule(sch.id, { enabled: !sch.enabled });
    };
    dot.onclick = flip;
    dot.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); flip(ev); } };

    row.append(when, what, days, dot);
    host.appendChild(row);
  }
}

/** What a schedule does, in the page's own words rather than the server's. */
function schedWhat(sch) {
  if (sch.target_missing) return 'What this pointed at is gone';
  if (sch.target?.kind === 'cue') {
    const cue = cues.find(c => c.id === sch.target.id);
    return 'Run ' + (cue ? cue.name : sch.target.id);
  }
  const d = state.devices.find(x => x.record_id === Number(sch.target?.record_id));
  const where = d ? pretty(d.name) + ' · ' + title(d.room) : 'a circuit';
  return (sch.action === 'off' ? 'Switch off ' : 'Switch on ') + where;
}

/* ── the schedule sheet ───────────────────────────────────────────────── */

let schedDraft = null;          // the schedule being edited, or a new one
let schedEditing = null;        // its id, or null when it is new

function blankSchedule() {
  return { at: '07:30', days: [1, 2, 3, 4, 5], target: null, action: 'on', enabled: true };
}

function openSchedSheet(sch) {
  schedEditing = sch ? sch.id : null;
  schedDraft = sch
    ? { at: sch.at, days: [...(sch.days || [])], target: { ...sch.target }, action: sch.action, enabled: sch.enabled }
    : blankSchedule();
  el('#schedtitle').textContent = sch ? 'Edit schedule' : 'New schedule';
  el('#scheddelete').hidden = !sch;
  el('#schedrun').hidden = !sch;
  el('#schedscrim').hidden = false;
  drawSchedSheet();
}

function closeSchedSheet() {
  hideScrim(el('#schedscrim'), () => { schedDraft = null; schedEditing = null; });
}

/** Fills the sheet from the draft. Called on open and after every change. */
function drawSchedSheet() {
  if (!schedDraft) return;
  el('#schedat').value = schedDraft.at;

  const days = el('#scheddays');
  days.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day';
    b.textContent = DAY_SHORT[i];
    b.setAttribute('aria-label', DAY_FULL[i]);
    b.setAttribute('aria-pressed', String(schedDraft.days.includes(i)));
    b.onclick = () => {
      schedDraft.days = schedDraft.days.includes(i)
        ? schedDraft.days.filter(x => x !== i) : [...schedDraft.days, i].sort();
      drawSchedSheet();
    };
    days.appendChild(b);
  }

  const kind = schedDraft.target?.kind || 'cue';
  for (const b of el('#schedkind').querySelectorAll('.seg')) {
    b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
    b.classList.toggle('on', b.dataset.kind === kind);
  }

  /* A cue already says on or off per circuit, so asking again would be a
     question with no meaning. Only a bare circuit needs the answer. */
  el('#schedaction').hidden = kind !== 'device';
  for (const b of el('#schedaction').querySelectorAll('.seg')) {
    const isOn = b.dataset.action === (schedDraft.action || 'on');
    b.setAttribute('aria-pressed', String(isOn));
    b.classList.toggle('on', isOn);
  }

  const pick = el('#schedtarget');
  pick.innerHTML = '';
  if (kind === 'cue') {
    if (!cues.length) {
      pick.appendChild(new Option('No cues yet — make one first', ''));
    }
    for (const c of cues) {
      const o = new Option(c.name, c.id);
      o.selected = schedDraft.target?.id === c.id;
      pick.appendChild(o);
    }
  } else {
    const byRoom = {};
    for (const d of state.devices) (byRoom[d.room] = byRoom[d.room] || []).push(d);
    for (const room of Object.keys(byRoom).sort()) {
      const g = document.createElement('optgroup');
      g.label = title(room);
      for (const d of byRoom[room].slice().sort((a, b) => natural(a.name, b.name))) {
        const o = new Option(pretty(d.name), String(d.record_id));
        o.selected = Number(schedDraft.target?.record_id) === d.record_id;
        g.appendChild(o);
      }
      pick.appendChild(g);
    }
  }
  syncSchedTarget();
  el('#schedsays').textContent = schedPreview();
}

/** Reads the picker back into the draft, so the draft is always the truth. */
function syncSchedTarget() {
  const pick = el('#schedtarget');
  const kind = schedDraft.target?.kind || 'cue';
  const v = pick.value;
  if (!v) { schedDraft.target = null; return; }
  schedDraft.target = kind === 'cue' ? { kind: 'cue', id: v } : { kind: 'device', record_id: Number(v) };
}

/** The sentence under the title, so you can read back what you just built. */
function schedPreview() {
  if (!schedDraft.target) return 'Pick something for it to do.';
  if (!schedDraft.days.length) return 'Pick at least one day, or it will never run.';
  const what = schedDraft.target.kind === 'cue'
    ? 'run ' + (cues.find(c => c.id === schedDraft.target.id)?.name || 'a cue')
    : (schedDraft.action === 'off' ? 'switch off ' : 'switch on ') +
      (() => { const d = state.devices.find(x => x.record_id === Number(schedDraft.target.record_id));
               return d ? pretty(d.name) + ' in ' + title(d.room) : 'a circuit'; })();
  return 'At ' + schedDraft.at + ', ' + what + '. ' + daysWord(schedDraft.days) + '.';
}

/** Create or update, then let the pushed snapshot redraw every open browser. */
async function saveSchedule(id, patch) {
  const url = id ? '/api/schedules/' + id : '/api/schedules';
  const res = await fetch(url, {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) { note(body.error || 'That schedule did not save'); return null; }
  /* The SSE frame will bring this round to every other browser; this one does
     not wait for it, so the list under your hand redraws at once. */
  const list = await fetch('/api/schedules').then(r => r.json()).catch(() => null);
  if (list?.ok) { state.schedules = list.schedules; drawSchedules(); }
  return body.schedule;
}

el('#newsched').onclick = () => openSchedSheet(null);
el('#schedcancel').onclick = closeSchedSheet;
el('#schedscrim').addEventListener('click', (e) => { if (e.target === el('#schedscrim')) closeSchedSheet(); });

el('#schedat').oninput = () => {
  if (!schedDraft) return;
  schedDraft.at = el('#schedat').value;
  el('#schedsays').textContent = schedPreview();
};
el('#schedtarget').onchange = () => {
  if (!schedDraft) return;
  syncSchedTarget();
  el('#schedsays').textContent = schedPreview();
};

for (const b of el('#schedkind').querySelectorAll('.seg')) {
  b.onclick = () => {
    if ((schedDraft.target?.kind || 'cue') === b.dataset.kind) return;
    schedDraft.target = b.dataset.kind === 'cue' ? { kind: 'cue', id: null } : { kind: 'device', record_id: null };
    drawSchedSheet();
  };
}
for (const b of el('#schedaction').querySelectorAll('.seg')) {
  b.onclick = () => { schedDraft.action = b.dataset.action; drawSchedSheet(); };
}
for (const b of el('.daypresets').querySelectorAll('.seg')) {
  b.onclick = () => {
    schedDraft.days = b.dataset.preset === 'every' ? [0, 1, 2, 3, 4, 5, 6]
      : b.dataset.preset === 'week' ? [1, 2, 3, 4, 5] : [0, 6];
    drawSchedSheet();
  };
}

el('#schedsave').onclick = async () => {
  if (!schedDraft.target || (!schedDraft.target.id && !schedDraft.target.record_id)) {
    return note('Pick what this schedule should do.');
  }
  if (!schedDraft.days.length) return note('Pick at least one day.');
  const saved = await saveSchedule(schedEditing, {
    at: schedDraft.at, days: schedDraft.days, target: schedDraft.target,
    action: schedDraft.action, enabled: schedDraft.enabled,
  });
  if (saved) { closeSchedSheet(); note('Saved · ' + saved.says); }
};

el('#schedrun').onclick = async () => {
  if (!schedEditing) return;
  const res = await fetch('/api/schedules/' + schedEditing + '/run', { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  note(body.ok ? body.spoken : (body.error || 'That did not run'));
};

/* Delete arms first. A schedule is a sentence someone wrote; losing it to a
   mis-tap is worse than the extra press, and this is the same two-step the cue
   sheet already uses. */
el('#scheddelete').onclick = async (e) => {
  const b = e.currentTarget;
  if (!b.classList.contains('armed')) {
    b.classList.add('armed');
    b.textContent = 'Delete for good?';
    setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Delete'; }, 4000);
    return;
  }
  await fetch('/api/schedules/' + schedEditing, { method: 'DELETE' });
  const list = await fetch('/api/schedules').then(r => r.json()).catch(() => null);
  if (list?.ok) { state.schedules = list.schedules; drawSchedules(); }
  b.classList.remove('armed');
  b.textContent = 'Delete';
  closeSchedSheet();
};

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

/* ── dismissing a sheet ───────────────────────────────────────────────────
   On a phone the sheet comes up from the bottom edge, so it has to go back
   down the same way; snapping it out of existence is the one remaining thing
   that gives the whole page away as a document. On a wide screen the fade it
   already had is right, so this costs nothing there. */
const onPhone = () => window.matchMedia('(max-width: 860px)').matches;

function hideScrim(scrim, after) {
  const done = () => {
    scrim.hidden = true;
    scrim.classList.remove('gripped', 'settling', 'closing');
    const sheet = scrim.querySelector('.sheet');
    if (sheet) sheet.style.removeProperty('--drag');
    if (after) after();
  };
  const sheet = scrim.querySelector('.sheet');
  if (!onPhone() || !sheet) return done();
  scrim.classList.remove('gripped', 'settling');
  scrim.classList.add('closing');
  sheet.style.setProperty('--drag', Math.ceil(sheet.getBoundingClientRect().height) + 'px');
  setTimeout(done, 260);
}

function closeSheet() {
  hideScrim(el('#scrim'));
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
    ? lampColour(st.tune)
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
        lampColour(st.tune));
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
  return { brightness, colour: lampColour(warmth) };
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

/* In a room, the one held control switches off that room rather than the
   house — it is the thing you want at the door, and switching off the whole
   house from inside a bedroom is never what the thumb meant. */
function allOff() {
  const inRoomView = state.view === 'room' && !state.q;
  const on = lit(inRoomView ? inRoom(state.room) : state.devices);
  switchOffMany(on, inRoomView
    ? 'Switching off ' + on.length + ' in ' + title(state.room) + '.'
    : on.length + (on.length === 1 ? ' circuit' : ' circuits') + ' switching off.');
}

/**
 * Switching several circuits off at once.
 *
 * This used to be one setDevice call per circuit, fired at once, which is the one
 * thing this hub cannot take: a separate socket per command, all opened in the
 * same millisecond. Measured on a five-circuit room — the tiles go off, then
 * every confirmation comes back refused and puts them ALL back on for about
 * seven seconds, before a later read finds they had landed after all. The room
 * appears to switch itself back on.
 *
 * So it goes down one shared socket, the way a cue does, and takes one verdict
 * instead of five. Air conditioners still go one at a time, because an IR unit
 * needs its command string rather than a bare record.
 */
async function switchOffMany(devs, saying) {
  if (!devs.length) return;
  const was = devs.map(d => ({ d, status: d.status, level: d.level }));
  for (const d of devs) {
    d.status = false;
    if (d.is_dimmable) d.level = 0;
    paint(d);
    inFlight.add(d.record_id);
    markCommanded(d.record_id);
  }
  tick();
  note(saying);

  const acs = devs.filter(d => d.is_ac);
  const rest = devs.filter(d => !d.is_ac);
  try {
    const calls = [];
    if (rest.length) calls.push(fetch('/api/group', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_ids: rest.map(d => d.record_id), on: false }),
    }));
    for (const ac of acs) calls.push(fetch('/api/ac', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_id: ac.record_id, power: false }),
    }));
    const res = await Promise.all(calls);
    if (res.some(r => !r.ok)) throw new Error('The hub refused part of that');
    tick_haptic(9);
  } catch (err) {
    for (const { d, status, level } of was) { d.status = status; d.level = level; paint(d); }
    tick();
    tick_haptic([12, 60, 12]);
    note('Nothing switched off — ' + err.message);
  } finally {
    // No per-circuit verdict here; the next read speaks for all of them.
    setTimeout(() => { for (const d of devs) inFlight.delete(d.record_id); }, 4500);
  }
}

/* ───────────────────────────────────────────────── the picture behind it */

const setShot = (v) => {
  document.documentElement.style.setProperty('--shot', "url('/bg.jpg?v=" + v + "')");
  fitShot(v);
};

/* What the backdrop should be dimmed to.
 *
 * Every photograph needs its own number, and getting it wrong is what makes
 * the page look washed out or dead — so the picture is measured rather than
 * guessed.
 *
 * It used to measure the *mean*, which was right while a cream veil sat over
 * the whole picture and the only question was overall level. With the veil
 * gone the question changed: legibility now depends on how bright the
 * brightest large areas get, because that is where ink on a pane runs out of
 * contrast. A mean is the wrong instrument for that — this photograph is half
 * dark pine, so its mean sits low and the mean-based rule brightened it to the
 * clamp, pushing the limestone and the sky *up* exactly where the header and
 * the cards sit. So it measures the bright end instead: the 88th percentile,
 * held near a level ink survives. A dark picture with a small bright sky is
 * then left alone rather than lifted. */
const SHOT_BRIGHT = 196;          // where the top of the picture should land

function fitShot(v) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = Math.max(1, Math.round(120 * img.height / img.width));
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    // A 256-bucket histogram is enough, and cheaper than sorting the pixels.
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      hist[Math.min(255, Math.round(l))]++;
      n++;
    }
    let seen = 0, p88 = 255;
    for (let l = 0; l < 256; l++) {
      seen += hist[l];
      if (seen >= n * 0.88) { p88 = l; break; }
    }
    const dim = Math.max(0.55, Math.min(1.12, SHOT_BRIGHT / Math.max(1, p88)));
    document.documentElement.style.setProperty('--shot-dim', dim.toFixed(3));
  };
  img.src = '/bg.jpg?v=' + v;
}

async function drawBackdrops() {
  const grid = el('#bggrid');
  grid.innerHTML = '';
  let lib;
  try { lib = await fetch('/api/backdrops').then(r => r.json()); }
  catch { grid.innerHTML = '<p class="empty">The backdrops could not be read.</p>'; return; }

  const shot = (file, label, on) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bgshot' + (on ? ' on' : '');
    b.style.backgroundImage = "url('" + (file ? '/backdrops/' + file : '/bg.jpg?v=' + lib.version) + "')";
    b.setAttribute('aria-label', on ? label + ', showing now' : 'Use ' + label);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = on ? label + ' · showing' : label;
    b.appendChild(tag);
    b.onclick = async () => {
      const r = await fetch('/api/backdrops/choose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      }).then(x => x.json()).catch(() => null);
      if (!r || !r.ok) return note('That backdrop could not be set.');
      setShot(r.version);
      drawBackdrops();
    };
    if (file) {
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'drop';
      drop.textContent = '×';
      drop.setAttribute('aria-label', 'Remove ' + label);
      drop.onclick = async (e) => {
        e.stopPropagation();
        const r = await fetch('/api/backdrops/' + file, { method: 'DELETE' })
          .then(x => x.json()).catch(() => null);
        if (r && r.ok) { setShot(r.version); drawBackdrops(); }
      };
      b.appendChild(drop);
    }
    return b;
  };

  if (lib.has_original) grid.appendChild(shot(null, 'The one it came with', !lib.current));
  for (const it of lib.items) {
    grid.appendChild(shot(it.file, it.file.replace(/\.(jpg|jpeg|png)$/i, '') +
      (it.kb ? ' · ' + it.kb + 'KB' : ''), lib.current === it.file));
  }
  if (!lib.has_original && !lib.items.length) {
    grid.innerHTML = '<p class="empty">No photographs yet. Add one below.</p>';
  }
}

/* The photograph is resized and re-encoded here, in the browser, before it is
   sent. The hub has no image libraries — that is why the icon and the lens map
   are hand-rolled PNG encoders — and a 4MB phone picture would otherwise be
   pushed to every device that opens the page. A canvas does it for nothing.
   3200px at .93 to match the built-in library, which is re-encoded with
   sips at 3200px and formatOptions 99. It was 2600 at .82, which was visibly
   worse than everything it sat beside in the picker — the whole page is
   glass over this picture, so its artefacts are magnified rather than hidden.
   The endpoint takes 8MB and a phone photograph lands near 2. */
function shrinkPhoto(file, max) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? res(b) : rej(new Error('The image could not be read'))), 'image/jpeg', 0.93);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => rej(new Error('That file is not an image this browser can open'));
    img.src = URL.createObjectURL(file);
  });
}

/* Three backdrops in the bar, plus a way into the rest. */
async function drawShots() {
  const host = el('#shots');
  if (!host) return;
  let lib;
  try { lib = await fetch('/api/backdrops').then(r => r.json()); } catch { return; }
  host.innerHTML = '';
  const all = (lib.has_original ? [{ file: null, label: 'the original' }] : [])
    .concat(lib.items.map(i => ({ file: i.file, label: i.file })));
  // All of them, not the first three: the dock is collapsed to the current
  // picture anyway, and a swap you cannot reach is not a swap.
  for (const it of all.slice(0, 6)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'shot-mini' + ((lib.current || null) === it.file ? ' on' : '');
    b.style.backgroundImage = "url('" + (it.file ? '/backdrops/' + it.file : '/bg.jpg?v=' + lib.version) + "')";
    b.setAttribute('aria-label', 'Use ' + it.label + ' as the backdrop');
    b.onclick = async () => {
      const r = await fetch('/api/backdrops/choose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: it.file }),
      }).then(x => x.json()).catch(() => null);
      if (r && r.ok) { setShot(r.version); drawShots(); }
    };
    host.appendChild(b);
  }
  {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'shot-more';
    more.textContent = all.length > 6 ? '+' : '\u22ef';
    more.setAttribute('aria-label', 'All backdrops');
    more.onclick = () => { el('#bgscrim').hidden = false; drawBackdrops(); };
    host.appendChild(more);
  }
}
drawShots();

el('#setbg').onclick = () => { el('#bgscrim').hidden = false; drawBackdrops(); };
el('#bgdone').onclick = () => hideScrim(el('#bgscrim'));
el('#bgscrim').addEventListener('click', (e) => { if (e.target === el('#bgscrim')) hideScrim(el('#bgscrim')); });

el('#bgfile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  note('Preparing ' + file.name + '…');
  try {
    const blob = await shrinkPhoto(file, 3200);
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) + '.jpg';
    const r = await fetch('/api/backdrops/upload?name=' + encodeURIComponent(name), {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob,
    }).then(x => x.json());
    if (!r.ok) throw new Error(r.error || 'The hub would not take it');
    setShot(r.version);
    drawBackdrops();
    note(name.replace('.jpg', '') + ' is now the backdrop · ' + r.kb + 'KB');
  } catch (err) {
    note(err.message + '.');
  }
});

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

/* ── the field ────────────────────────────────────────────────────────────
   Three things happen on every keystroke: the rest of the word you are typing
   is drawn under the caret, the line under the pill says what pressing Enter
   will do, and the board redraws. The completion is the part that matters —
   typing 'ashu', Tab, 'co', Tab gets you to 'ashu cobs' without knowing
   any of the names, which is the difference between a command bar and a
   command line. */
const seekEl = el('#seek');
const ghostEl = el('#seekghost');
let completion = null;              // the word the caret is part-way through

function drawGhost() {
  const q = seekEl.value;
  const next = nextWords(q);
  const at = seekEl.selectionStart === q.length;   // never complete mid-string
  completion = at && next && next.partial && next.options.length ? next.options[0] : null;
  ghostEl.querySelector('i').textContent = completion ? q : '';
  ghostEl.querySelector('b').textContent = completion ? completion.slice(next.partial.length) : '';
  const key = el('#seekkey');
  key.classList.toggle('offer', !!completion);
  key.textContent = completion ? 'tab' : '/';
}

function takeWord(word) {
  const q = seekEl.value;
  const cut = /\\s$/.test(q) ? q : q.replace(/[^\\s]*$/, '');
  seekEl.value = cut + word + ' ';
  seekEl.focus();
  state.q = seekEl.value;
  drawGhost();
  drawSeekHint();
  drawField();
}

// Both the completion and the line under the pill describe the text in the
// field, so anything that empties the field has to clear them too.
function resetSeek() { drawGhost(); drawSeekHint(); }

function drawSeekHint() {
  const hint = el('#seekhint');
  if (!hint) return;
  const q = state.q.trim();
  const cmd = q ? parseCommand(state.q) : null;
  const n = q ? matches().length : 0;
  // A half-typed command is not a failed search, and telling someone their
  // room name matches nothing when they are two words into a valid command is
  // the field arguing with them. Say what it is waiting for instead.
  const next = q ? nextWords(state.q) : null;
  const words = cmd && !cmd.bad ? '↵ runs it'
    : cmd && cmd.bad ? cmd.bad.toLowerCase()
    : q && n ? n + (n === 1 ? ' match · ↵ switches it' : ' matches')
    : next && next.options.length
      ? (next.what === 'and also' ? 'and also · tab completes'
                                  : 'now a ' + next.what + ' · tab completes')
    : q ? 'nothing by that name'
    : '';
  hint.textContent = words;
  hint.hidden = !words;
  seekEl.setAttribute('aria-expanded', String(!!q));
}

seekEl.addEventListener('input', () => {
  state.q = seekEl.value;
  drawGhost();
  drawSeekHint();
  drawField();
});
seekEl.addEventListener('keydown', (e) => {
  // Tab, or the right arrow at the end of the line, takes the completion —
  // the two keys every shell has trained people to try.
  if (completion && (e.key === 'Tab' || (e.key === 'ArrowRight' && seekEl.selectionStart === seekEl.value.length))) {
    e.preventDefault();
    takeWord(completion);
    return;
  }
  if (e.key !== 'Enter') return;
  const cmd = parseCommand(state.q);
  if (cmd && !cmd.bad) {
    e.preventDefault();
    runCommand(cmd);      // the field keeps its text, so Enter again repeats it
    return;
  }
  // No command, but exactly one circuit found: Enter is obviously meant to
  // switch that one. Any other count and Enter has no single right answer, so
  // it does nothing rather than guessing.
  const found = matches();
  if (state.q.trim() && found.length === 1) {
    e.preventDefault();
    setDevice(found[0], !found[0].status);
  }
});
loadGrammar();

// On a phone the search field is folded away behind its icon; opening it gives
// it the row it needs, and leaving it empty folds it back.
const seekToggle = el('#seektoggle');
const plate = el('.plate');
/* Opening and closing the search mode.
 *
 * On a phone the field is *moved* into the search layer rather than positioned
 * over it — one node with two homes — so the layer's flex column works out
 * every offset itself instead of the field, the chips and the hint each
 * carrying a hand-computed distance from the bottom edge. */
const seekLayer = el('#seeklayer');
const seekPill = el('#seekpill');
const seekPillHome = seekPill.parentNode;

function openSeek(open) {
  const phone = onPhone();
  plate.classList.toggle('searching', open);
  // The thumb bar stands down while the field takes its place at the bottom.
  document.body.classList.toggle('seeking', open);
  seekToggle.setAttribute('aria-expanded', String(open));

  if (phone) {
    seekLayer.hidden = !open;
    if (open && seekPill.parentNode !== seekLayer) seekLayer.appendChild(seekPill);
    if (!open && seekPill.parentNode !== seekPillHome) seekPillHome.appendChild(seekPill);
  } else if (seekPill.parentNode !== seekPillHome) {
    // A rotation or a resize can leave the field in the layer on a screen that
    // no longer has one.
    seekPillHome.appendChild(seekPill);
    seekLayer.hidden = true;
  }

  if (open) {
    el('#seek').focus();
    // The layer starts empty; it is drawField that fills it, and opening the
    // mode is a change of what should be on screen just as typing is.
    drawField();
  } else {
    el('#seek').blur();
    state.q = '';
    el('#seek').value = '';
    resetSeek();
    drawField();
  }
}

/* Where the keyboard is.
 *
 * A fixed-position element is pinned to the layout viewport, which does not
 * shrink when a phone raises its keyboard — so a field docked to the bottom
 * edge ends up underneath the keyboard that was raised to type into it. The
 * visual viewport does shrink, and the difference between the two is exactly
 * how far the field has to lift. Nothing to do on a desktop, where the two
 * viewports agree. */
if (window.visualViewport) {
  const vv = window.visualViewport;
  const followKeyboard = () => {
    const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', Math.round(hidden) + 'px');
  };
  vv.addEventListener('resize', followKeyboard);
  vv.addEventListener('scroll', followKeyboard);
  followKeyboard();
}

/* Pinch does nothing. iOS Safari ignores user-scalable in a browser tab, but
 * it does raise gesture events first, so refusing them is the one thing that
 * actually holds — and it is a no-op everywhere else. */
for (const g of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(g, (e) => e.preventDefault(), { passive: false });
}
seekToggle.addEventListener('click', () => openSeek(!plate.classList.contains('searching')));
/* On a wide screen an empty field that has lost focus has nothing to say, so
   it folds away. On a phone it must not: tapping a chip, scrolling the results
   or dismissing the keyboard all blur the field, and having the whole mode
   vanish underneath any of those is exactly what made it feel broken. Done is
   the way out there. */
el('#seek').addEventListener('blur', () => {
  if (!onPhone() && !state.q.trim()) openSeek(false);
});
el('#seekcancel').onclick = () => openSeek(false);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!el('#scrim').hidden) { closeSheet(); return; }
    if (state.q) { state.q = ''; el('#seek').value = ''; resetSeek(); drawField(); openSeek(false); }
    else if (state.view === 'room') go('house');
  }
  // A slash puts the cursor in the search box, the way a console does.
  if (e.key === '/' && document.activeElement !== el('#seek')) { e.preventDefault(); el('#seek').focus(); }
});

wireMain();
wireSheet();
el('#newcue').onclick = newCue;

el('#back').onclick = () => {
  if (state.q) { state.q = ''; el('#seek').value = ''; resetSeek(); openSeek(false); }
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
  const sec = document.getElementById('secleft');
  if (sec) sec.hidden = !auto.nudges.length;
  fitTiles();          // the alerts have taken their space; the tiles take the rest
}

/* The tiles take whatever room is left above them.
 *
 * On a wide screen the board is a fixed column — it does not scroll with the
 * page — so everything stacked above the tiles comes straight out of their
 * height. An alert costs about 55px, the header pill another 65, and four
 * alerts on a forgetful evening is most of a row. Rather than let the grid
 * spill below the fold, the tiles measure what is actually left and size
 * themselves to it, so two rows fit whatever else is on screen.
 *
 * It has to be measured rather than calculated, because the things above are
 * not fixed: an alert is dismissed by removing its row, with nothing redrawn,
 * so a ResizeObserver is what notices. */
function fitTiles() {
  const root = document.documentElement;
  if (window.innerWidth < 861) { root.style.removeProperty('--tile-h'); return; }
  const tiles = el('#stack');
  if (!tiles) return;
  const top = tiles.getBoundingClientRect().top;
  const avail = window.innerHeight - top - 104;      // the room pill sits under it
  let h = Math.max(104, Math.min(182, Math.round((avail - 18) / 2)));
  root.style.setProperty('--tile-h', h + 'px');
  requestAnimationFrame(() => { markScroll(tiles); markScroll(document.querySelector('.index')); });

  /* The whole house has to be on the screen. Seven rooms with the lit one
     taking a double square needs three rows on a four-column grid, so the
     landing page scrolled and Home Theatre and Dining fell off the bottom —
     and a board you have to scroll is not a board you can read at a glance.
     Rather than compute it (the hero spans two rows, tiles differ in height,
     and the column count comes from auto-fill), it shrinks until it fits.
     A room's own board is left alone: fourteen circuits will never fit, and
     squeezing them to nothing to pretend otherwise would be worse. */
  if (state.view !== 'house' || state.q) return;
  // Bounded by the floor, not by a step count: at 8px a go, ten passes only
  // ever moved 80px, so a board starting at the 182px ceiling stopped at 102
  // and never reached the floor it was allowed.
  for (let i = 0; i < 60 && tiles.scrollHeight > tiles.clientHeight + 2 && h > 78; i++) {
    h = Math.max(78, h - 8);
    root.style.setProperty('--tile-h', h + 'px');
  }
  // Below this a room card cannot hold a name, a number and a tally, so it
  // drops the tally and keeps the two that matter.
  tiles.classList.toggle('squeezed', h < 96);
}

window.addEventListener('resize', () => {
  fitTiles();
  /* fitTiles leaves early on a phone, and rotating one is exactly when a rail
     changes from fitting to not. */
  for (const rail of document.querySelectorAll(RAILS)) markScrollX(rail);
});

/* Says, at the edge, whether a column has more to show. Without it the cue
   list simply looked as though it ended halfway through — the scrollbar was
   hidden, and a hard cut is indistinguishable from the end of the list. */
function markScroll(node) {
  if (!node) return;
  const more = node.scrollHeight - node.clientHeight - node.scrollTop > 4;
  const less = node.scrollTop > 4;
  more ? node.setAttribute('data-more', '') : node.removeAttribute('data-more');
  less ? node.setAttribute('data-less', '') : node.removeAttribute('data-less');
}

/* The same, sideways, for the rails that scroll across rather than down. */
function markScrollX(node) {
  if (!node) return;
  const more = node.scrollWidth - node.clientWidth - node.scrollLeft > 4;
  const less = node.scrollLeft > 4;
  more ? node.setAttribute('data-more-x', '') : node.removeAttribute('data-more-x');
  less ? node.setAttribute('data-less-x', '') : node.removeAttribute('data-less-x');
}

const RAILS = '#secrooms #tabs, #seccues #cues, .settings-row';

function watchScroll() {
  for (const sel of ['.index', '#stack']) {
    const node = document.querySelector(sel);
    if (!node || node.dataset.watched) continue;
    node.dataset.watched = '1';
    node.addEventListener('scroll', () => markScroll(node), { passive: true });
  }
  markScroll(document.querySelector('.index'));
  markScroll(el('#stack'));

  for (const rail of document.querySelectorAll(RAILS)) {
    if (!rail.dataset.watchedx) {
      rail.dataset.watchedx = '1';
      rail.addEventListener('scroll', () => markScrollX(rail), { passive: true });
    }
    markScrollX(rail);
  }
}

/* The board is a column with its own scrollbar, so a wheel over the heading or
   the gap between tiles did nothing at all — the page looked stuck. Anywhere
   in the field now turns the board. */
function wheelToBoard() {
  const field = document.querySelector('.field');
  if (!field || field.dataset.wheel) return;
  field.dataset.wheel = '1';
  field.addEventListener('wheel', (e) => {
    const stack = el('#stack');
    if (!stack || stack.contains(e.target)) return;      // it is already there
    if (stack.scrollHeight <= stack.clientHeight) return;
    stack.scrollTop += e.deltaY;
    markScroll(stack);
    e.preventDefault();
  }, { passive: false });
  field.addEventListener('wheel', () => markScroll(el('#stack')), { passive: true });
}
// Anything that can change height above the tiles is watched. The tiles
// themselves are not, or setting their height would wake the observer again.
if (window.ResizeObserver) {
  const watch = new ResizeObserver(() => fitTiles());
  for (const sel of ['#nudges', '.field-head', '.plate', '#timerrunning']) {
    const node = document.querySelector(sel);
    if (node) watch.observe(node);
  }
}

async function cancelTimers() {
  const running = auto.timers || [];
  if (!running.length) return;
  await Promise.all(running.map(t =>
    fetch('/api/timers/' + t.id, { method: 'DELETE' }).catch(() => {})));
  tick_haptic(9);
  note(running.length === 1 ? 'Timer cancelled.' : running.length + ' timers cancelled.');
  loadAuto();
}

function drawTimers() {
  const state_ = el('#timerstate');
  if (state_) {
    const t = (auto.timers || [])[0];
    state_.textContent = t
      ? Math.max(1, Math.round(t.seconds_left / 60)) + ' MIN LEFT · ' + (t.label || 'THE HOUSE').toUpperCase()
      : 'No timer running';
  }
  const stop = el('#timerstop');
  if (stop) {
    const n = (auto.timers || []).length;
    stop.hidden = !n;
    stop.textContent = n > 1 ? 'Cancel all ' + n : 'Cancel it';
  }
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
  el('#popveil').hidden = !open;
  el('#qtimer').setAttribute('aria-expanded', String(open));
  if (open) {
    tick_haptic(6);
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
for (const b of document.querySelectorAll('.qmin')) {
  b.onclick = async () => {
    const minutes = Number(b.dataset.min);
    b.classList.add('on');
    setTimeout(() => b.classList.remove('on'), 1200);
    const scope = b.dataset.scope === 'room' && state.room ? 'room:' + state.room : 'house';
    const r = await fetch('/api/timers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes, scope }),
    }).then(x => x.json()).catch(() => null);
    if (r && r.ok) { tick_haptic(9); note(r.spoken + '.'); loadAuto(); }
    else note('That timer could not be set.');
  };
}

el('#qtimer').onclick = () => openTimer(timerpop.hidden);
el('#timerstop').onclick = cancelTimers;
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

// Chrome will not offer to install without one of these. It only registers in a
// secure context, so on plain http over the LAN this is simply skipped.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* not fatal */ });
}

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
    if (state.q) { state.q = ''; el('#seek').value = ''; resetSeek(); }
    tick_haptic(6);
    next === 'house' ? go('house') : go('room', next);
  }, { passive: true });
})();

/* ── a strip knows when it is being held ───────────────────────────────────
   The visible slider is the strip; the range input inside it is invisible, so
   the input's own active state is not something CSS can reach from the strip
   in every engine. One delegated pair of listeners marks the strip instead —
   which drops the fill's 300ms width transition for the duration of the drag,
   so the light tracks the finger instead of chasing it, and thickens the
   handle so the grip is visible. Capturing, because the range input stops the
   event from bubbling in some browsers. */
/* ── a sheet you can throw back down ──────────────────────────────────────
   A panel that can only be dismissed by finding its Close button is a dialog;
   one that follows the thumb and can be flicked away is a sheet. Both the
   distance and the speed count, because the two gestures people actually make
   are a slow deliberate push and a quick flick, and a distance-only rule
   ignores the second one. */
(function sheetDrag() {
  let grip = null;
  document.addEventListener('pointerdown', (e) => {
    if (!onPhone() || !e.target.closest) return;
    const head = e.target.closest('.sheet-head');
    // The head carries the cue's name field and its buttons; those are
    // controls, not a handle.
    if (!head || e.target.closest('input, textarea, button, a')) return;
    const scrim = head.closest('.scrim');
    const sheet = head.closest('.sheet');
    if (!scrim || !sheet) return;
    grip = { scrim, sheet, from: e.clientY, y: 0, at: performance.now() };
    scrim.classList.add('gripped');
  });
  document.addEventListener('pointermove', (e) => {
    if (!grip) return;
    // Upward is resisted rather than refused: a sheet that stops dead reads
    // as broken, one that gives a quarter reads as attached to something.
    const raw = e.clientY - grip.from;
    grip.y = raw > 0 ? raw : raw / 4;
    grip.sheet.style.setProperty('--drag', grip.y + 'px');
  });
  const letGo = () => {
    if (!grip) return;
    const g = grip;
    grip = null;
    g.scrim.classList.remove('gripped');
    const flick = g.y / Math.max(1, performance.now() - g.at);   // px per ms
    if (g.y > 110 || flick > 0.55) {
      if (g.scrim.id === 'scrim') closeSheet(); else hideScrim(g.scrim);
      return;
    }
    g.scrim.classList.add('settling');
    g.sheet.style.setProperty('--drag', '0px');
    setTimeout(() => g.scrim.classList.remove('settling'), 320);
  };
  document.addEventListener('pointerup', letGo);
  document.addEventListener('pointercancel', letGo);
})();

const dropGrip = () => {
  for (const s of document.querySelectorAll('.strip.dragging')) s.classList.remove('dragging');
};
document.addEventListener('pointerdown', (e) => {
  const strip = e.target.closest && e.target.closest('.strip');
  if (strip) strip.classList.add('dragging');
}, true);
document.addEventListener('pointerup', dropGrip, true);
document.addEventListener('pointercancel', dropGrip, true);

// Keep up with the house: poll while the tab is in view, re-read on return.
setInterval(() => { if (!document.hidden && !streamLive) sync(); }, 10000);
setInterval(readout, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });

load();
</script>
</body>
</html>`;
