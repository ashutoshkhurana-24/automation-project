# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file local dashboard (`server.js`) that controls a Neo Console Hub — a home automation controller on the LAN at `192.168.1.3:8090`, driving 87 devices across 7 rooms. Express serves an API and an HTML page; commands reach the hub over WebSocket.

There is no build step, no test suite, no linter, and no framework. `server.js` is the entire application: server logic, then the whole frontend inside a `HTML` template literal at the bottom.

## Commands

```bash
npm start                      # http://localhost:3000
PORT=3111 npm start            # a second instance, for testing without disturbing a running one
HUB_IP=192.0.2.1 npm start     # point at an unreachable address to exercise error paths
node --check server.js         # the only "build" — always run this after editing
```

There are no tests. Verify changes by driving the real hub (see below) and by loading the page.

## The hub protocol

This was reverse-engineered by probing, not from documentation. Getting it wrong fails silently, so keep to it.

**Connecting.** `ws://192.168.1.3:8090/bms/1/0/A/` with `perMessageDeflate: true` and exactly these headers: `Host`, `User-Agent: Dart/3.10 (dart:io)`, `Accept-Encoding: gzip`, `Cache-Control: no-cache`. **Never send an `Origin` header** — the hub rejects the handshake with HTTP 500.

**Commanding.** One short-lived socket per command: connect, send, close after 500ms. The payload echoes the hub's own device record with fields overridden — partial records are rejected for some device types:

```json
{"opr": "service", "opr_type": "service_opr", "opr_param": "",
 "record": { ...the hub's record..., "device_status": "true" }}
```

**Levels.** `device_status` is not a boolean. `"false"` = 0, `"true"` = 100, `"1"`–`"99"` = percent. Sending `"0"` reads back as `"false"`; `"100"` reads back as `"true"`. A bare level from off switches the light on at that level. So on/off is `decodeLevel(...) > 0`, never `=== 'true'` — that bug read a light dimmed to 40% as off.

**Colour temperature** lives in `device_status_tunable` but **cannot be written directly** — that field is silently ignored. Address the tunable channel instead: send `channel_id: <channel_id_tunable>` with the level in `device_status`. On this installation 0 is cool and 100 is warm.

**Reading state.** The hub pushes one `site_config` per connection carrying live status for every device. It sends **nothing** in reply to a command and does not push changes to an idle socket, so a fresh connection is the only way to learn the truth — including changes made at a wall switch or in the phone app.

**Timing, measured against this hub.** A `site_config` arrives ~1.5–3s after connecting, and snapshots state at connect time. A read starting under ~2.3s after a command still reports the *previous* state; `SETTLE_MS = 3200` is that measurement plus margin. Do not lower it without re-measuring.

## Architecture

**Device data** loads at startup from `data/devices.json` (the full hub records plus room grouping via `areas → departments → sub_area.area_devices`), falling back to a CSV parser over `data/neo_console_devices.csv`. Records live in a `Map` keyed by `record_id`; hub reads merge over them, so the map is the single source of truth that `deviceList()` projects for the API.

**Freshness** is one background reader for the whole house: `readHubState()` every `REFRESH_MS` (15s), with concurrent callers sharing one in-flight read. `/api/devices` serves that cache instantly and never blocks on the hub; `?refresh=1` forces a read. Browsers poll the cheap cached endpoint every 10s.

**Confirmation.** `/api/toggle` sends, waits `SETTLE_MS`, re-reads, and reports `confirmed: true|false` — roughly a 5s response, absorbed by an optimistic UI whose pending shimmer clears after 900ms. A per-record intent token means a quick second click invalidates the first verdict. `/api/level` and `/api/tune` deliberately skip this (sliders fire continuously); they return at once and schedule a delayed read.

**Frontend** is vanilla DOM inside the `HTML` template literal, sharing a `state.devices` array with the server's projection. Key invariant: `inFlight` holds devices the user is currently touching, and polls must skip them — otherwise a hub read yanks a slider out from under a finger. `paint()` likewise skips a dial that is `document.activeElement`.

Because the frontend is inside a JS template literal: `${...}` interpolates at server start (used for `HUB_IP`), backticks and `\` in the page source must be escaped, and regex literals in page code need doubled backslashes.

## Design language

Devices are classed as light / fan / curtain / climate / screen, and each class gets a control shaped like the object — a rocker that throws, a rotor that turns, curtain panels that part, a cold wash, a lit screen — with its own emission colour. Controls are strictly honest about what the hub can do: only genuinely dimmable and tunable lights get sliders. The palette is committed to dark; the whole design rests on devices emitting light.

Two CSS traps already hit here: shorthand `padding` on `.tools` silently wiped `.wrap`'s side padding, and a `-100vw` full-bleed trick widened the document into a horizontal scroll. Prefer longhands and a full-width wrapper.

## Working against the live hub

Changing a device physically switches something in someone's home. Prefer a light in `ASHU ROOM` (the user's own room), restore what you changed, and report what you touched. Read hub state directly for verification rather than trusting the dashboard's own view:

```bash
node -e 'const W=require("ws");const ws=new W("ws://192.168.1.3:8090/bms/1/0/A/",{perMessageDeflate:true,headers:{Host:"192.168.1.3:8090","User-Agent":"Dart/3.10 (dart:io)","Accept-Encoding":"gzip","Cache-Control":"no-cache"}});ws.on("message",m=>{const j=JSON.parse(m);if(j.payload?.type!=="site_config")return;console.log(j.payload.response.devices.filter(d=>d.device_status!=="false").map(d=>d.record_id+" "+d.device_name.trim()+" "+d.device_status).join("\n")||"nothing on");process.exit(0)})'
```

The hub is only reachable from the same LAN; `EHOSTUNREACH` means the machine is off that network, not that the code is broken.

## The hub's HTTP API (Django, alongside the WebSocket)

The hub also serves an HTTP API on the same `:8090`, separate from the WebSocket. It runs **Django with debug mode ON**, which is useful: a wrong request returns an HTML error page naming the exact field it wanted (`MultiValueDictKeyError … 'pk'`). Most write endpoints are `POST multipart/form-data` with a single field `data` holding a JSON string; a few (delete) want `pk`. No authentication on any of it.

Verified working, read-only:
- `GET /Scenes/getSceneName/` — 20 stored hub scenes (ids 187–208), full appliance lists with `operation`/`opr_value` per device.
- `GET /device/get_all_rooms/`, `/authenticate/getversion/`, `/tuya/lan/devices/`, `/tuya/tuya_devices/`.
- Room photos are served at `GET /static/image/<on_image_path>` — but the on/off pair per room is byte-identical placeholder art, not real photos.

Verified writable (tested with throwaway objects in ASHU ROOM / HOME THEATRE, then deleted; hub confirmed byte-identical to baseline afterward):
- `POST /Scenes/addScene/` `{data:[{scene_name,status:"E",floor:1,dept:1,area:[<subarea id>],isVirtual:false,image_id,delay:"",devices:[{app_type,app_type_name,delay:"",appliances:[{record_id,device_name,device_id,channel_id,device_type,app_type,operation,opr_value}]}]}]}`. Operations seen in real scenes: `true/false`, `dim`+level, `tun`+level. Returns `"Scene has be created"`, no id — re-GET to find it.
- `POST /Scenes/deleteScene/` `pk=<id>`. **A scene referenced by a trigger cannot be deleted** until the trigger is gone.
- `POST /triggerAction/deleteTrigger/` `pk=<id>`, `POST /triggerAction/updateEvent/` `data={id,…}` (returns "Invalid trigger id" for a non-existent id — the only non-destructive way to enumerate trigger ids, since the list endpoints are useless, below).

**The trigger/schedule engine is inert on this unit — do not build on it.** `POST /triggerAction/addTrigger/` returns "Trigger added successfully" and the trigger is assigned an id, but: it never appears in `getTriggerName`/`getScheduledTriggers` (both always return `[]`), and **it never fires** — proven by scheduling a HOME THEATRE light for a near time and confirming it stayed off minutes past. Tried `occurance:"D"` and `schedule_type:"Time"` shapes; accepted ones behave identically (stored, invisible, dead). So scene *creation* is usable (e.g. to mirror cues into the vendor app), but hub-side *scheduling* is not.

**`addScheduledTrigger` is a separate, *also-dead* endpoint — and now we know exactly why (2026-08-10).** The vendor client references a whole `ScheduledTriggers` family (`/triggerAction/addScheduledTrigger/`, `getScheduledTriggers`, `updateScheduledEvent`, `deleteScheduledTrigger` `pk=`) distinct from the plain `addTrigger` one, so it looked like we'd been writing to the wrong drawer. We hadn't — it is broken **server-side**. Debug mode leaked the source (`/home/abneo/abneo_controller/TriggerAction/views.py:236`): the view does `ScheduledTriggers.objects.create(name=…, isEnabled=…, condition_string=…)` and only *afterwards* assigns `trigger_instance.scene = scene_instance; .save()`. But the DB column `scheduled_triggers_tbl.scene_id` is `NOT NULL`, so the initial `create()` throws `IntegrityError: NOT NULL constraint failed: scheduled_triggers_tbl.scene_id` **every time, unconditionally** — the scene lookup (`Scenes.objects.get(id=int(trigger['scene']))`) even succeeds first; no client payload can fix a create-before-assign bug against that schema. Required body keys discovered en route (via debug KeyErrors): top-level `scene`, `name`, `isEnabled`, `condition_string`, `condition_object`, `trigger:{…}`. **Verdict: the hub cannot schedule anything via its HTTP API, by either endpoint. Do not keep trying payload shapes — the wall is in `views.py`, not in our request.** Confirmed on a throwaway ASHU ROOM scene (id 213), deleted after; hub back to 20 scenes, `getScheduledTriggers` still `[]`.

## The always-on host problem (open, deferred by the user)

Everything the dashboard automates needs something at home and awake to run it. The hub's own scheduler is inert (above); the Mac travels; the phone can't speak the hub protocol; the hub is LAN-only so no cloud. So schedules and history logging require an always-on box on the LAN.

State as of this session:
- **Phase 2 (Siri/shortcuts) is built and in `server.js`:** `GET/POST /api/cue/:id/fire`, `/api/house/off`, `GET /api/cues`, all routed through a shared `fireCue()` that leaves the same one-step undo as the UI. Each reply carries a `spoken` sentence for Siri. Optional `SHORTCUT_KEY` env → require `?key=`. Recipes in `SHORTCUTS.md`. **Not yet fired end-to-end** (switches off real rooms — do in daylight with the user).
- **Phase 1 (scheduler + history log) is blocked** on the host decision, not on code.
- **The hub *is* the always-on box.** It is a **Dell OptiPlex 3020** (a normal x86-64 desktop PC, not a NAS appliance) at `192.168.1.3`, running Ubuntu 20.04 — the only device in the house that is always on and always on the LAN. Being an ordinary desktop means a keyboard + monitor (or a USB boot stick) makes the GRUB-recovery login route straightforward. So "where do we host a scheduler" and "the box we're locked out of over SSH" are the *same machine*. But its own scheduler is dead (see the `addScheduledTrigger` bug above), so hosting on it still requires OS access to run *our* scheduler.
- **Decision:** user chose to host `server.js` on the vendor hub itself (it's Ubuntu 20.04 — `apt`/`systemd`, SSH on 22, FTP on 21). Blocked on getting an SSH login: keys from the Mac and common usernames both failed; no credentials are baked into the decompiled app; user to get them from the dealer or by physical reset later. **Lead (2026-08-10):** the Django debug leak shows the app runs as OS user **`abneo`** (`/home/abneo/abneo_controller/…`) — so the SSH *username* is almost certainly `abneo`; only the password/key is missing. Digging into the vendor app is now allowed (the user's earlier reticence was UX-taste, not a security worry) — but the app only ever speaks the hub's HTTP API, so it holds no OS/SSH/FTP credentials to find. If hosted there, keep everything in one directory + one systemd service on a non-8090 port, touch nothing of the vendor's. A Raspberry Pi remains the clean alternative and keeps the dashboard an independent observer (which is how the inert-scheduler bug was caught in the first place).

- **The Android APK is a dead end for the login — checked and closed (2026-08-10).** Unpacked `Tistron v1.15.03.26.apk` and searched everything: no SSH/SFTP/FTP client library exists (neither a Dart package like `dartssh2` nor a Java one like jsch/sshj), so the app *cannot* log into the OS — the lone `SFTP` string is an orphaned constant, not a client. The only bundled crypto is `assets/key.pem` + `assets/cert.pem`, a `CN=atvremote` pair for the **Android-TV Remote** protocol (controlling the TV/projector, not the hub). Incidental finds worth remembering: the app is wired to **Firebase** (Auth/Firestore/Realtime DB/FCM) with a `demo@abneo.com` demo login — so a cloud/notification path exists even though device *control* stays on LAN `:8090` (a privacy angle if ever relevant); and it doubles as an Android-TV remote (the real basis for the parked "projector remote" idea). Bottom line unchanged: **no build of the vendor app holds OS credentials — the OptiPlex login must come from the dealer or a physical GRUB-recovery reset.** Do not re-decompile the APK for this.

- **Vendor can't supply the OptiPlex password (2026-08-10).** So the login must be self-reset via physical access (GRUB single-user → `passwd abneo`, or a USB live-boot → chroot). It's the user's own hardware; resetting a local password doesn't touch the vendor's app or data. Still the simplest unblock — user is aware, deferred.
- **Remote-host-via-WireGuard avenue (explored, parked mid-decision).** Idea: a free always-on cloud VM (Oracle "Always Free", ARM — our pure-JS app runs on it) runs `server.js` + cron and reaches the hub through a WireGuard tunnel home; gives unattended schedules *and* remote control, no Pi, no OptiPlex login. Home connection has a **public IP (`171.x`, not CGNAT)**, which is good. **Blocker found:** the user's router is a **TP-Link Archer currently in Access Point mode**, where TP-Link disables the VPN/WireGuard server (no NAT/routing in AP mode) — so the tunnel can't terminate on the Archer as-is. Open question to resume on: what device is upstream of the Archer (the real internet gateway holding the `171.x` IP), and can *it* do WireGuard? Options if not: put the Archer back in router mode, or run a WG client on an always-on LAN device (which loops back to needing the OptiPlex login). Router model number was not yet captured.
- **Native iOS app — considered, parked.** A native app *could* speak the hub protocol directly (custom WS headers, no `Origin`), unlike the browser PWA which needs `server.js` as a translator. But it cannot do unattended scheduling (iOS background limits), so it does not remove the always-on-host requirement; and once that host runs `server.js`, the existing PWA + Shortcuts already cover phone control. Verdict: an iOS app would be polish, not a solution — revisit only after the host is up.

Security notes (LAN-only, but real): the hub's HTTP API is unauthenticated, FTP (vsftpd) is open on 21, and Django debug mode leaks stack traces to anything on the Wi-Fi.

## Curtains (still open)

Two untested leads from decompiling the vendor client, to try on **HOME THEATRE CURTAIN (483)** only:
1. The client *writes* `channel_id_open`/`channel_id_close` but *reads back* `channel_open`/`channel_close` — we have only ever used the read-back spelling. Try adding both.
2. `tis_motor` with `opr_value` 0–100 is a positional "move to X%" command — but it is a *scene* operation, not an `opr_param` string, so it must be tested via a throwaway hub scene.

Full design notes and tiered idea list: `~/.claude/plans/glowing-honking-treehouse.md`.
