// Set this dashboard up against a hub it has never seen.
//
//   node tools/setup.js                    # look, report, write nothing
//   node tools/setup.js --hub 192.168.1.9  # a hub at another address
//   node tools/setup.js --apply            # write data/devices.json + config.json
//   node tools/setup.js --apply --name "The Flat"
//   node tools/setup.js --no-screens       # skip the SSDP sweep
//
// A dry run by default, deliberately: this is the first thing anybody runs
// against a house it does not know, and the useful first answer is "here is what
// I can see and here is what I cannot drive" rather than a changed config.
//
// Written to parse on old Node as well. Ubuntu's packaged `nodejs` is v10 on
// this class of box and that is what a bare `node` may resolve to, so no
// optional chaining, no ??, no Object.fromEntries — the app itself needs a newer
// runtime, but the thing you run *before* the app is installed must not.

var fs = require('fs');
var path = require('path');
var WebSocket = require('ws');

var argv = process.argv.slice(2);
function flag(name) { return argv.indexOf(name) !== -1; }
function opt(name, fallback) {
  var i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

var ROOT = path.join(__dirname, '..');
var CONFIG_PATH = path.join(ROOT, 'config.json');
var DEVICES_PATH = path.join(ROOT, 'data', 'devices.json');

var existing = {};
try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { /* first run */ }

var HUB_IP = opt('--hub', process.env.HUB_IP || existing.hub_ip || '192.168.1.3');
var HUB_PORT = opt('--port', process.env.HUB_PORT || existing.hub_port || '8090');
var APPLY = flag('--apply');

// ── saying things ──────────────────────────────────────────────────────────
var out = [];
function say(s) { out.push(s === undefined ? '' : s); console.log(s === undefined ? '' : s); }
function head(s) { say(); say(s); say(new Array(s.length + 1).join('─')); }
function die(msg, hint) {
  console.error('\n' + msg);
  if (hint) console.error(hint);
  process.exit(1);
}

// ── step 1: can we reach the hub at all ────────────────────────────────────
say('Setting up against ' + HUB_IP + ':' + HUB_PORT + (APPLY ? '' : '   (dry run — nothing will be written)'));

/* The exact handshake, which is the one part of this that cannot be guessed:
   perMessageDeflate on, these four headers, and **no Origin** — the hub answers
   an Origin with HTTP 500 and no explanation. Kept identical to server.js and
   tools/discover.js on purpose; it took a long time to find. */
var ws = new WebSocket('ws://' + HUB_IP + ':' + HUB_PORT + '/bms/1/0/A/', {
  handshakeTimeout: 6000,
  perMessageDeflate: true,
  headers: {
    'Host': HUB_IP + ':' + HUB_PORT,
    'User-Agent': 'Dart/3.10 (dart:io)',
    'Accept-Encoding': 'gzip',
    'Cache-Control': 'no-cache'
  }
});

var timer = setTimeout(function () {
  die('The hub opened a socket but never sent its device list.',
      'It answers on this port, so something is listening — but it is not\n'
    + 'behaving like the controller this dashboard speaks to. Check the address.');
}, 25000);

ws.on('error', function (err) {
  die('Could not reach a hub at ' + HUB_IP + ':' + HUB_PORT + ' — ' + err.message,
      'Things worth checking, in order:\n'
    + '  * is this machine on the same network as the hub?\n'
    + '  * does the address answer at all:  ping ' + HUB_IP + '\n'
    + '  * EHOSTUNREACH means the wrong network, not broken code.');
});

var done = false;
ws.on('message', function (data) {
  if (done) return;
  var msg;
  try { msg = JSON.parse(data.toString()); } catch (e) { return; }
  if (!msg || !msg.payload || msg.payload.type !== 'site_config') return;  // ping, live_link, imageMap_config
  done = true;
  clearTimeout(timer);
  try { report(msg); } catch (e) {
    die('Read the hub, but could not make sense of it: ' + e.message);
  }
});

// ── step 2: what is in there ───────────────────────────────────────────────
function report(msg) {
  var response = msg.payload.response || {};
  var devices = response.devices || [];
  var area = (response.areas || [])[0] || {};
  var dept = (area.departments || [])[0] || {};
  var subAreas = dept.sub_area || [];

  if (!devices.length) die('The hub answered but listed no devices at all.');
  if (!subAreas.length) die('The hub listed devices but no rooms, so nothing could be grouped.');

  /* record_id -> room, read exactly the way server.js reads it.
     area_devices is a **comma-separated string**, not an array — "485,497,498".
     Iterating it as a list walks it character by character and quietly maps
     every device to nothing, which is how the first run of this tool reported
     all 88 circuits as homeless. The room's name is in `name`, and it arrives
     with a trailing space. */
  var roomOf = {};
  var rooms = [];
  for (var i = 0; i < subAreas.length; i++) {
    var sub = subAreas[i];
    var roomName = String(sub.name || '').trim().toUpperCase();
    if (!roomName) continue;
    if (rooms.indexOf(roomName) === -1) rooms.push(roomName);
    var ids = String(sub.area_devices || '').split(',');
    for (var j = 0; j < ids.length; j++) {
      if (ids[j].trim()) roomOf[String(Number(ids[j]))] = roomName;
    }
  }

  say('Reached the hub: ' + devices.length + ' devices across ' + rooms.length + ' rooms.');

  // ── the kinds, from the records rather than from the names ───────────────
  var kinds = { light: [], fan: [], curtain: [], climate: [], screen: [], unknown: [] };
  var dimmable = [], tunable = [], irAc = [], relayAc = [], fansByName = [];
  var unknownTypes = {};
  var homeless = [];

  for (var k = 0; k < devices.length; k++) {
    var d = devices[k];
    var appType = String(d.app_type || 'L');
    var devType = String(d.device_type || '');
    var name = String(d.device_name || '').trim();
    var room = roomOf[String(d.record_id)];
    if (!room) homeless.push(d.record_id + ' ' + name);

    var isFanFlag = d.isFan === 'true';
    var isFanName = /\bFAN\b/i.test(name);
    var kind;
    if (appType === 'C') kind = 'curtain';
    else if (appType === 'AC') kind = 'climate';
    else if (appType === 'TV' || appType === 'PRJ') kind = 'screen';
    else if (appType === 'L') kind = (isFanFlag || isFanName) ? 'fan' : 'light';
    else { kind = 'unknown'; unknownTypes[appType] = (unknownTypes[appType] || 0) + 1; }

    kinds[kind].push(d);
    if (kind === 'fan' && !isFanFlag && isFanName) fansByName.push(d.record_id + ' ' + name + ' · ' + (room || '?'));
    if (kind === 'light' && d.is_dimmable === 'true') dimmable.push(d);
    if (kind === 'light' && d.is_tunable === 'true') tunable.push(d);
    if (appType === 'AC') (devType === 'IR' ? irAc : relayAc).push(d);
  }

  head('What this hub has');
  say('  rooms                     ' + rooms.length + '   ' + rooms.join(', '));
  say('  lights                    ' + kinds.light.length);
  say('    of those, dimmable      ' + dimmable.length);
  say('    of those, tunable       ' + tunable.length);
  say('  fans                      ' + kinds.fan.length);
  say('  curtains                  ' + kinds.curtain.length);
  say('  air conditioners          ' + kinds.climate.length
      + '   (' + irAc.length + ' infrared, ' + relayAc.length + ' relay)');
  say('  screens the hub knows     ' + kinds.screen.length);
  if (kinds.unknown.length) say('  NOT RECOGNISED            ' + kinds.unknown.length);

  // ── what it can and cannot do, which is the useful half ─────────────────
  head('What can be driven');
  say('  on / off                  every circuit above');
  say('  brightness                ' + dimmable.length + ' circuits');
  say('  colour temperature        ' + tunable.length + ' circuits');
  say('  open / close / stop       ' + kinds.curtain.length + ' curtains');
  say('  temperature, mode, fan    ' + irAc.length + ' infrared air conditioners');

  head('What cannot');
  if (irAc.length) {
    say('  * The ' + irAc.length + ' infrared air conditioners are one-way. The hub blasts a');
    say('    code and never hears back, so their state is only what it last sent —');
    say('    somebody using the unit\'s own remote is invisible. The dashboard says');
    say('    HUB SENT ON rather than ON for exactly this reason.');
  }
  if (tunable.length) {
    say('  * Colour temperature cannot be read back. The hub files what it was');
    say('    told whether or not the lamp obeyed, so a colour can only be checked');
    say('    by looking at the ceiling. Brightness does report honestly.');
  }
  if (kinds.curtain.length) {
    say('  * A curtain reports no position, ever. Its two relays are momentary and');
    say('    the hub keeps no state, so the dashboard shows no position for one.');
  }
  if (kinds.screen.length) {
    say('  * The ' + kinds.screen.length + ' screen(s) the hub knows are infrared or one-way too, so the');
    say('    same caveat applies. An LG set found below is driven directly instead,');
    say('    and that one does answer honestly.');
  }

  // ── the two things that are guesses, said plainly ───────────────────────
  var needsAttention = false;
  if (fansByName.length || Object.keys(unknownTypes).length || homeless.length) {
    head('Worth a human eye');
    needsAttention = true;
  }
  if (fansByName.length) {
    say('  These are treated as fans because of the word FAN in the name — this');
    say('  hub\'s own isFan flag says false for them, so the name is all there is:');
    for (var f = 0; f < fansByName.length; f++) say('    ' + fansByName[f]);
    say('  A fan called something else will be drawn as a light. Fix in the console.');
    say();
  }
  var ut = Object.keys(unknownTypes);
  if (ut.length) {
    say('  app_type values this dashboard has never seen:');
    for (var u = 0; u < ut.length; u++) say('    ' + ut[u] + '   x' + unknownTypes[ut[u]]);
    say('  They will be drawn as lights, which may be wrong — a geyser or a gate');
    say('  would get a lamp\'s warm glow. Set the kind per circuit in the console.');
    say();
  }
  if (homeless.length) {
    say('  In no room, so they will not appear on any board:');
    for (var h = 0; h < Math.min(homeless.length, 10); h++) say('    ' + homeless[h]);
    if (homeless.length > 10) say('    ... and ' + (homeless.length - 10) + ' more');
    say();
  }

  head('Groups');
  say('  None are detected automatically, on purpose: which fittings belong to');
  say('  one ceiling is something you know and a name regex only guesses. Set');
  say('  them in the console — pick a room, tick the circuits, name it.');
  var kept = (existing.groups || []).length;
  if (kept) say('  ' + kept + ' already declared in config.json, kept as they are.');

  // ── step 3: the televisions, which the hub knows nothing about ──────────
  if (flag('--no-screens')) {
    finish(msg, rooms, null);
    return;
  }
  head('Looking for LG screens on the network');
  var webos;
  try { webos = require('./webos.js'); } catch (e) {
    say('  Skipped: could not load tools/webos.js on this Node (' + process.version + ').');
    say('  Re-run with a newer node, or pass --no-screens.');
    finish(msg, rooms, null);
    return;
  }
  webos.discover(6000).then(function (found) {
    if (!found || !found.length) {
      say('  None answered. That is not a fault: a set that is fully off is');
      say('  invisible to everything — no SSDP, no ping, both ports shut. Switch');
      say('  the sets on and run this again.');
    } else {
      /* A set answers several SSDP records and only some carry the MAC, so an
         empty list here is common rather than a failure — the address is in the
         ARP table either way, which is where the app itself looks. */
      var pending = found.map(function (t) {
        if (t.macs && t.macs.length) return Promise.resolve(t);
        return webos.macFor(t.ip).then(function (mac) {
          if (mac) { t.macs = [mac]; t.fromArp = true; }
          return t;
        }, function () { return t; });
      });
      return Promise.all(pending).then(function (sets) {
        var known = {};
        for (var e = 0; e < (existing.televisions || []).length; e++) {
          var tv = existing.televisions[e];
          known[String(tv.mac).toLowerCase()] = tv;
        }
        for (var i = 0; i < sets.length; i++) {
          var t = sets[i];
          say('  ' + (t.ip || '?') + '   ' + (t.name || t.model || 'an LG set'));
          if (t.natted) {
            say('      more than one set answered from this one address, which means');
            say('      a router replied for them — they are behind a NAT and nothing');
            say('      here can be talked to. Put that router in access-point mode.');
          }
          if (!t.macs || !t.macs.length) {
            say('      no MAC — it advertised none and the ARP table has no entry.');
            say('      Ping it once and run this again; without a MAC it cannot be');
            say('      paired or woken, both of which are keyed by MAC.');
            continue;
          }
          for (var m = 0; m < t.macs.length; m++) {
            var mac = String(t.macs[m]).toLowerCase();
            var wired = /^d0:cd:bf/.test(mac);
            var mapped = known[mac];
            say('      ' + mac
              + (t.fromArp ? ' (from ARP)' : '')
              + (wired ? '   wired, power-on reliable' : '   Wi-Fi, power-on unreliable')
              + (mapped ? '\n      already mapped to ' + mapped.room + ' as ' + mapped.id
                        : '\n      NOT mapped to a room yet'));
          }
        }
        say();
        say('  Which set is in which room cannot be worked out from this: the MACs');
        say('  come in batches and a sleeping set will not tell you. The only way');
        say('  is to switch one on with somebody standing in front of it, which is');
        say('  what the console walks you through. Pairing puts a prompt on the');
        say('  screen that a person has to accept, once, per set.');
        finish(msg, rooms, sets);
      });
    }
    finish(msg, rooms, found);
  }, function (err) {
    say('  The sweep failed: ' + err.message);
    finish(msg, rooms, null);
  });
}

// ── step 4: write, or say what would be written ────────────────────────────
function finish(msg, rooms, screens) {
  var proposed = {
    house_name: opt('--name', existing.house_name || 'The House'),
    hub_ip: HUB_IP,
    hub_port: String(HUB_PORT),
    port: existing.port || 3000,
    // Never invented here: a set has to be mapped to a room by a person, and a
    // group has to be picked by one. Whatever is already declared is kept.
    televisions: existing.televisions || [],
    groups: existing.groups || [],
    kinds: existing.kinds || {}
  };
  if (existing.house_short) proposed.house_short = existing.house_short;

  head(APPLY ? 'Writing' : 'What --apply would write');
  say('  config.json');
  say('    house_name   ' + proposed.house_name);
  say('    hub          ' + proposed.hub_ip + ':' + proposed.hub_port);
  say('    port         ' + proposed.port);
  say('    televisions  ' + proposed.televisions.length + ' (kept; map new ones in the console)');
  say('    groups       ' + proposed.groups.length + ' (kept; set these in the console)');
  say('    kinds        ' + Object.keys(proposed.kinds).length + ' overrides (kept)');
  say('  data/devices.json   ' + (msg.payload.response.devices || []).length + ' devices');

  if (!APPLY) {
    say();
    say('Nothing was written. Run again with --apply when this looks right.');
    process.exit(0);
  }

  fs.writeFileSync(DEVICES_PATH, JSON.stringify(msg, null, 2));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(proposed, null, 2) + '\n');
  say();
  say('Written. Next:');
  say('  1. bash deploy/install.sh        (or npm start, to try it here first)');
  say('  2. open the dashboard and go to /setup to name rooms, set groups,');
  say('     and map the screens to the rooms they are actually in.');
  process.exit(0);
}
