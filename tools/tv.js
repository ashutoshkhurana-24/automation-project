// Drive an LG webOS television from the command line, over SSAP.
//
//   node tools/tv.js discover                 find the sets on this LAN
//   node tools/tv.js <ip> pair                accept the prompt on the screen
//   node tools/tv.js <ip> state               power, volume, input, app
//   node tools/tv.js <ip> watch               follow it live until ^C
//   node tools/tv.js <ip> toast "hello"       a line on the screen
//   node tools/tv.js <ip> vol 12 | mute on|off
//   node tools/tv.js <ip> inputs | input HDMI_1
//   node tools/tv.js <ip> apps   | launch netflix
//   node tools/tv.js <ip> youtube <url or id>   open that video in the app
//   node tools/tv.js <ip> off
//   node tools/tv.js wake <mac> [broadcast]   the only way to switch one on
//
// Everything but `discover` and `wake` needs a pairing key, which the first
// `pair` stores in data/tv-keys.json and every later run reuses.

const { WebosTV, wake, readKeys, discover } = require('./webos');

const argv = process.argv.slice(2);
const die = (m) => { console.error(m); process.exit(1); };

const val = (p, ...keys) => { for (const k of keys) if (p && p[k] != null) return p[k]; return undefined; };

async function state(tv) {
  const out = {};
  const tryIt = async (label, fn) => { try { out[label] = await fn(); } catch (e) { out[label] = { error: e.message }; } };
  await tryIt('power', () => tv.powerState());
  await tryIt('volume', () => tv.getVolume());
  await tryIt('app', () => tv.foreground());
  // Deliberately not swInfo(): it wants a permission the pairing manifest does
  // not ask for and answers 401, and widening the manifest would put the
  // pairing dialog back on the screen for a person to accept a second time.
  // Knowing the firmware build is not worth that.
  return out;
}

(async () => {
  if (!argv.length || argv[0] === 'discover') {
    const list = await discover(argv[1] ? Number(argv[1]) : 5000);
    if (!list.length) return die('No webOS sets answered. They are asleep, or on another subnet.');
    const keys = readKeys();
    for (const t of list) {
      console.log(t.ip.padEnd(16) + (t.name || t.model || 'LG webOS TV'));
      if (t.model && t.model !== t.name) console.log('  model'.padEnd(18) + t.model);
      for (const m of t.macs) console.log('  mac'.padEnd(18) + m + '   (wake with: node tools/tv.js wake ' + m + ')');
      if (t.natted) {
        console.log('  ! ' + t.macs.length + ' televisions answered from this one address, so it is a router');
        console.log('    doing NAT — they are on the far side of it and cannot be reached from here.');
        continue;
      }
      console.log('  paired'.padEnd(18) + (keys[t.ip] ? 'yes' : 'no — run: node tools/tv.js ' + t.ip + ' pair'));
    }
    return;
  }

  if (argv[0] === 'wake') {
    if (!argv[1]) return die('usage: node tools/tv.js wake <mac> [broadcast]');
    await wake(argv[1], argv[2]);
    console.log('Magic packet sent to ' + argv[1] + '. A set takes a few seconds, and only wakes if');
    console.log('"Mobile TV On" is enabled on it. Remember a broadcast does not cross subnets.');
    return;
  }

  const ip = argv[0];
  const cmd = argv[1] || 'state';
  const arg = argv.slice(2).join(' ');
  const tv = new WebosTV(ip);

  if (cmd === 'pair' && !readKeys()[ip]) {
    console.log('Look at the television: a prompt is about to appear.');
    console.log('Press Accept on the remote — this only ever happens once.\n');
  }

  try { await tv.connect(); } catch (e) { return die('Could not connect to ' + ip + ': ' + e.message); }
  if (tv.paired) console.log('Paired. The key is stored in data/tv-keys.json and will be reused.\n');

  try {
    switch (cmd) {
      case 'pair':
        console.log(JSON.stringify(await state(tv), null, 2));
        break;
      case 'state':
        console.log(JSON.stringify(await state(tv), null, 2));
        break;
      case 'watch': {
        console.log('Following ' + ip + '. Change something with the TV remote — ^C to stop.\n');
        const stamp = () => new Date().toTimeString().slice(0, 8);
        tv.subscribe('ssap://audio/getVolume', (p) =>
          console.log(stamp() + '  volume  ' + val(p, 'volume', 'volumeStatus') +
            (val(p, 'muted') != null ? '  muted=' + val(p, 'muted') : '')));
        tv.subscribe('ssap://com.webos.applicationManager/getForegroundAppInfo', (p) =>
          console.log(stamp() + '  app     ' + (p.appId || '(none)')));
        tv.subscribe('ssap://com.webos.service.tvpower/power/getPowerState', (p) =>
          console.log(stamp() + '  power   ' + (p.state || '?') + (p.processing ? ' (' + p.processing + ')' : '')));
        await new Promise(() => {});                      // until ^C
        break;
      }
      case 'toast':  console.log(await tv.toast(arg || 'Hello from the dashboard')); break;
      case 'vol':    console.log(await tv.setVolume(Number(arg))); break;
      case 'mute':   console.log(await tv.setMute(arg === 'on' || arg === 'true')); break;
      case 'inputs': {
        const r = await tv.inputs();
        for (const i of r.devices || []) console.log(i.id.padEnd(14) + (i.label || '') + (i.connected ? '' : '   (nothing plugged in)'));
        break;
      }
      case 'input':  console.log(await tv.switchInput(arg)); break;
      case 'apps': {
        const r = await tv.apps();
        for (const a of r.launchPoints || []) console.log(a.id.padEnd(40) + (a.title || ''));
        break;
      }
      case 'launch': console.log(await tv.launch(arg)); break;
      case 'youtube': console.log(await tv.youtube(arg)); break;
      case 'off':    console.log(await tv.off()); break;
      default: die('unknown command: ' + cmd);
    }
  } catch (e) {
    tv.close();
    return die('Failed: ' + e.message);
  }
  tv.close();
  process.exit(0);
})().catch((e) => die(e.stack || e.message));
