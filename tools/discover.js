// Refresh data/devices.json from the hub.
//
// Run this whenever the installer adds, removes or renames devices — the
// dashboard reads that file once at startup and ignores any record_id it does
// not already know, so a newly fitted light is invisible until you do.
//
//   node tools/discover.js && sudo systemctl restart neo-dashboard
//
// It writes the file itself rather than printing to stdout. Redirecting meant a
// half-finished run could truncate the only copy of the device database, and the
// hub sends site_config more than once per connection, so a naive redirect
// produced two concatenated objects and a file that would not parse at all.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const HUB_IP = process.env.HUB_IP || '192.168.1.3';
const PORT = process.env.HUB_PORT || '8090';
const OUT = path.join(__dirname, '..', 'data', 'devices.json');

const ws = new WebSocket(`ws://${HUB_IP}:${PORT}/bms/1/0/A/`, {
    handshakeTimeout: 5000,
    perMessageDeflate: true,
    headers: {
        'Host': `${HUB_IP}:${PORT}`,
        'User-Agent': 'Dart/3.10 (dart:io)',
        'Accept-Encoding': 'gzip',
        'Cache-Control': 'no-cache'
    }
});

const die = (msg) => { console.error(msg); process.exit(1); };
const timer = setTimeout(() => die('Timed out waiting for site_config.'), 20000);

ws.on('open', () => console.error(`Reading the device database from ${HUB_IP}...`));

let done = false;
ws.on('message', (data) => {
    if (done) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg?.payload?.type !== 'site_config') return;   // ping, live_link, imageMap_config

    done = true;
    clearTimeout(timer);

    const devices = msg.payload.response?.devices || [];
    const rooms = msg.payload.response?.areas?.[0]?.departments?.[0]?.sub_area || [];
    if (!devices.length || !rooms.length) die('site_config had no devices or no rooms — not overwriting.');

    // Report the change before making it, so a surprise is visible.
    let had = [];
    try { had = JSON.parse(fs.readFileSync(OUT, 'utf8')).payload.response.devices || []; } catch { /* first run */ }
    const before = new Set(had.map(d => d.record_id));
    const after = new Set(devices.map(d => d.record_id));
    const added = devices.filter(d => !before.has(d.record_id));
    const removed = had.filter(d => !after.has(d.record_id));

    fs.writeFileSync(OUT, JSON.stringify(msg, null, 2));

    console.error(`Wrote ${devices.length} devices across ${rooms.length} rooms to data/devices.json`);
    for (const d of added) console.error(`  + ${d.record_id} ${String(d.device_name || '').trim()}`);
    for (const d of removed) console.error(`  - ${d.record_id} ${String(d.device_name || '').trim()}`);
    if (!added.length && !removed.length) console.error('  (no devices added or removed)');
    console.error('Restart the dashboard for this to take effect.');

    ws.close();
    process.exit(0);
});

ws.on('error', (err) => die('Could not reach the hub: ' + err.message));
