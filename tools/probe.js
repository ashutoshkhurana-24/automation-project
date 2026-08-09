/**
 * Protocol probe for the things the hub gives no feedback on.
 *
 *   node probe.js curtain 483 open        # pulse a curtain's open/close relay
 *   node probe.js ac 511 A                # try one AC command shape
 *   node probe.js watch 511               # print what the hub stores for a device
 *
 * The AC variants exist because an IR air conditioner is not a switch: its
 * record carries a code table (on/off/cool/dry/fan, fan speeds, and a
 * temperature→code map) and we do not yet know which field the hub reads.
 * Run one variant, watch the actual unit, and note which one it responds to.
 *
 * Safe to delete once the AC question is settled.
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const HUB_IP = process.env.HUB_IP || '192.168.1.3';
const HUB_PORT = process.env.HUB_PORT || '8090';
const URL = `ws://${HUB_IP}:${HUB_PORT}/bms/1/0/A/`;
const OPTS = {
  handshakeTimeout: 5000,
  perMessageDeflate: true,
  headers: {
    Host: `${HUB_IP}:${HUB_PORT}`,
    'User-Agent': 'Dart/3.10 (dart:io)',
    'Accept-Encoding': 'gzip',
    'Cache-Control': 'no-cache',
  },
};

const devices = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'devices.json'), 'utf8')
).payload.response.devices;

const record = (id) => devices.find(d => d.record_id === id);

function send(rec, tag) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL, OPTS);
    ws.on('open', () => ws.send(JSON.stringify({
      opr: 'service', opr_type: 'service_opr', opr_param: '', record: rec,
    }), () => {
      console.log('sent ' + tag);
      console.log(JSON.stringify(rec, null, 1));
      setTimeout(() => { ws.close(); res(); }, 600);
    }));
    ws.on('error', rej);
  });
}

function watch(id) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL, OPTS);
    const timer = setTimeout(() => { ws.terminate(); rej(new Error('timed out')); }, 9000);
    ws.on('message', (m) => {
      try {
        const j = JSON.parse(m.toString());
        if (j.payload?.type !== 'site_config') return;
        clearTimeout(timer);
        ws.close();
        res(j.payload.response.devices.find(d => d.record_id === id));
      } catch { /* keep waiting */ }
    });
    ws.on('error', (e) => { clearTimeout(timer); rej(e); });
  });
}

const [kind, idArg, arg] = process.argv.slice(2);
const id = Number(idArg);

(async () => {
  const rec = record(id);
  if (!rec && kind !== 'watch') {
    console.error('No device with record_id ' + id);
    process.exit(1);
  }

  if (kind === 'watch') {
    console.log(JSON.stringify(await watch(id), null, 1));
    process.exit(0);
  }

  if (kind === 'curtain') {
    // A curtain is two relays (channel_open / channel_close) but the hub keeps
    // no state for it, so which shape drives it can only be settled by watching.
    const open = String(rec.channel_open);
    const close = String(rec.channel_close);
    const shapes = {
      // 1: pulse a single relay by addressing its channel
      open:  [{ ...rec, channel_id: open,  device_status: 'true' }],
      close: [{ ...rec, channel_id: close, device_status: 'true' }],
      stop:  [{ ...rec, channel_id: open,  device_status: 'false' },
              { ...rec, channel_id: close, device_status: 'false' }],
      // 2: no channel at all, just the record — how the app drives a relay light
      'plain-open':  [{ ...rec, device_status: 'true' }],
      'plain-close': [{ ...rec, device_status: 'false' }],
    };
    const steps = shapes[arg];
    if (!steps) {
      console.error('Curtain actions: ' + Object.keys(shapes).join(', '));
      process.exit(1);
    }
    for (const [i, step] of steps.entries()) {
      await send(step, `curtain ${id} ${arg}` + (steps.length > 1 ? ` (${i + 1}/${steps.length})` : ''));
      if (i < steps.length - 1) await new Promise(r => setTimeout(r, 700));
    }
    process.exit(0);
  }

  if (kind === 'ac') {
    // Each variant is a different guess at how an IR command is expressed.
    const variants = {
      A: { ...rec, device_status: 'true' },
      B: { ...rec, device_status: 'true', mode: rec.cool, fspeed: rec.medium, ac_temp: rec.ac_temp },
      C: { ...rec, device_status: String(rec.on) },
      D: { ...rec, device_status: 'true', ir_code: String(rec.on) },
      OFF_A: { ...rec, device_status: 'false' },
      OFF_C: { ...rec, device_status: String(rec.off) },
    };
    const v = variants[arg];
    if (!v) {
      console.error('Variants: ' + Object.keys(variants).join(', '));
      process.exit(1);
    }
    await send(v, `ac ${id} variant ${arg}`);
    await new Promise(r => setTimeout(r, 3400));
    const after = await watch(id);
    console.log('hub now stores: device_status=' + JSON.stringify(after.device_status) +
      ' ac_temp=' + JSON.stringify(after.ac_temp));
    process.exit(0);
  }

  console.error('Usage: node probe.js curtain <id> open|close | ac <id> A|B|C|D|OFF_A|OFF_C | watch <id>');
  process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });
