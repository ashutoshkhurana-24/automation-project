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

**`device_status_tunable` is a belief, not a reading — the same trap as IR, on every tunable lamp in the house.** The hub writes that field into its own database when it is told a colour, whether or not the lamp obeyed. So reading it back tells you what you asked for, not what happened: on 2026-08-15 it reported five of five COBs at the new colour while **four of the five had not moved**, which the room made obvious and the API never could. Two consequences, both learned the hard way:
- **Never measure a colour change by reading it back.** A whole sweep of gap timings was run this way and produced a confident, wrong answer (100% at every gap that mattered). The only instrument that works is a person looking at the ceiling — or, for "did the hub try", its own log (below).
- **Never let a verify pass judge colour.** `verifyGroup()` and `outstanding()` both used to, so they always saw success, never resent, and the safety net for a dropped colour had never once fired. They check brightness only now. Brightness is genuine feedback — the modules do report back, which is why a wall-switch change appears on the next read — so `device_status` can be trusted where `device_status_tunable` cannot.

**An IR device's state is a belief, not a reading.** Six of the seven ACs are `device_type: IR` (the exception is HOME THEATRE 496, `RL`, a real relay). IR is one-way: the hub blasts a code and never hears back, so `device_status` for those units is **only what the hub last sent**. Anyone using the AC's own remote is invisible to it, and the unit's real state can differ indefinitely. Never report an IR device's state as fact — it is "the hub last sent off", not "it is off". This is not a bug to fix; there is no feedback channel to read.

Consequences worth remembering: the left-on advisory for an AC can only catch one switched on *through the hub* — an AC started by its remote will never nudge, which is exactly the case you would most want caught. It can also nudge for a unit someone has since switched off by remote. The advisory is still worth having (forgetting the dashboard's own AC is the common case) but it is not a guarantee, and any UI wording must not imply certainty.

**The step path could not command an IR air conditioner, and said it did (found 2026-08-21, fixed everywhere 2026-08-24 — kept here because it is the proof of the trap).** `acCommand()` was called from `/api/ac` and nowhere else, so everything going through `setRecords`/`sendSteps` sent an AC a bare record with a `device_status` and no command string. Proven by asking the hub what it tried. `GET /do/ashu/ac/off`:

```
Sending Operation on   on channel id           <- no device, no channel
```

against `POST /api/ac {power:false}` on the same unit:

```
Sending Operation on 193 on channel id 10
```

and the `/do` reply was `{"ok":true,"count":1,"sent":1,"spoken":"Ac in Ashu Room off"}`. So it is dropped silently and reported as a success — the worst shape a bug can have here, because the hub also files the `device_status` it was handed, so the dashboard then *shows* the AC off while it runs on. Worth knowing the channel differs per verb — on is `channel id 11`, off is `channel id 10` on this unit — so the hub resolves the channel from the command string, which is exactly what a bare record fails to give it.

**Every road reaches an air conditioner now (schedules 2026-08-22, the rest 2026-08-24).** `fireTargets()` — which both `runSchedule` and `runScheduleOff` go through — now sorts an IR air conditioner out of the batch and sends it with `acPower()`, one at a time like the curtains, because each is its own socket. `itemIsAc()` is the test: `app_type` `AC` **and** `device_type` `IR`, so HOME THEATRE 496 stays on the `setRecords` path, which is right for it — it really is a relay. Proven on ASHU with the hub's own log, choosing a case that could not disturb the room (the AC already on, COB 1 already at 100%): one line for `device id 19 · channel 24` through the batch and one for `on 193 · channel id 11`, where before there was `on   on channel id` with no device and no channel. The off direction needs no separate proof — `acPower(entry, false)` is the identical call `/api/ac {power:false}` makes, logged at `channel id 10` the same evening. The auto-close (`off_after`) rides the same runner, so that works now too.

**The projector works now, and it is a remote rather than a switch (2026-08-22).** Record 512, HOME THEATRE, `app_type: PRJ`, `device_type: IR` — the one screen the hub itself drives. The record carries **twenty-two named keys and the code for each key is the record's own field**: `on` is 168, `off` 169, `menu` 177, through `sigSource` `computer` `video` `focusAdd/Red` `picAdd/Red` `up/down/left/right` `confirm` `quit` `volAdd/Red` `mute` `auto` `pause` `mcd`. That is exactly what `Device/areaComps.projIrMap` builds, so those names are the hub's spelling and not ours.

**An AVR would work the same way, and this house has none (2026-08-22).** Asked whether the vendor's code carries IR for an audio-video receiver: it does, in three places, and the payload is **identical to the projector's** — so if one is ever fitted, `prjCommand`'s shape works unchanged and only the key names differ.

**It does have one, and it is on the network rather than the hub (2026-08-22).** A **Denon AVR-X1700H** in HOME THEATRE, on Wi-Fi, MAC `00:06:78:aa:3a:9e`. **Its address is a DHCP lease and it has already moved once** — `192.168.1.34` on 2026-08-22, `192.168.1.6` on 2026-08-23 — which presents as "the AVR does not work" with a perfectly healthy dashboard: `avr_online: false`, an empty source list, and `No route to host` from the box. `config.receivers[].host` is the only place that address lives and `/setup` has no field for it, so it is a hand edit plus a restart. Find it again by sweeping the LAN for **port 23** (one host answers) rather than by looking for a Denon MAC prefix — this unit's `00:06:78` is Fujitsu-registered, not D&M, so the obvious grep finds nothing. The hub has never heard of it — `devices_tbl` holds no AVR row and its twenty stored scenes reference only L, AC and PRJ — so the IR path above is not how it is driven. It is spoken to directly, the way the televisions are, and **it is the best-behaved device in the house**.

Denon's telnet protocol on port 23, one `\r`-terminated ASCII line per message, `?` making it a query. Three properties, all measured:
- **At least five concurrent sessions**, all answering, so a persistent socket does not lock the HEOS app out of somebody's phone. Older Denons allow exactly one — re-check before assuming this is polite on other hardware.
- **It broadcasts.** A change on any session is reported on all of them, proven by holding one socket idle and querying from a second, which the first heard. So it reports what its own remote does: caught live on the deployed hub, where the card read `SOUND ON · PS5 · 53.5` after somebody changed source and volume by hand. With the televisions, the second thing here whose state is a reading rather than a belief. Do not poll it.
- **It answers in standby, which is the whole answer to "is power-on unreliable on Wi-Fi".** It is not. An LG needs a Wake-on-LAN *broadcast* because its NIC dies with the panel, and that is what makes waking one over Wi-Fi a coin toss. This unit kept port 23 open at +3s, +5s and +8s after `PWSTANDBY`, answered `PWSTANDBY` when asked, and came straight back on `PWON` with volume, input, mute and mode all identical. No broadcast, no magic packet, power confirmed rather than assumed. It depends on the unit's Network Control being "Always On", which it already is; one set to "Off in Standby" would behave like a television.

**HTTP is a dead end for state.** The legacy `/goform/` endpoints are **403** on this firmware (nginx, Gen 0002); only `Deviceinfo.xml` answers, and on port **8080** rather than 80. That is enough to identify the model and nothing else.

Four things worth keeping:
- **Sources are discovered, never hard-coded.** `SSFUN ?` gives code → the owner's own label and `SSSOD ?` says which are in use. On this unit `GAME` is called **PS5**, which no built-in table could know. Parse on the *first* space: a code can contain a slash (`SAT/CBL`, whose label is `CBL/SAT`) but never a space, and the terminating `SSFUN END` has its space before the word, so check END first or you get a source called END. `TUNER` and `NET` appear only in `SSSOD`, being built in rather than renameable.
- **`MVUP`/`MVDOWN` move in half steps.** `MV40` → `MV405` is 40.5, not 405. Dropping the third digit was tried and it silently misreports the unit — pressing louder took it 40 → 40.5 and the dashboard went on saying 40, which reads as a dead button. The half is kept; the dashboard's own ± sends an absolute whole number instead, so the buttons and the slider agree about what a step is.
- **`volume_max` is a safety ceiling, not a preference.** The unit reports `MVMAX 98` and 98 is deafening; a slider that reaches it is one slipped thumb from damaged speakers. Default 70, raise it in config deliberately. (Testing the clamp by asking for 95 *set it to 70* and made the room briefly loud — clamp with a number you would not mind hearing.)
- **A reply must wait for the value, not for a fixed interval.** A flat 500ms settle had the endpoint answering with the *previous* input — ask for TV and it said BD, ask for BD and it said TV. This unit takes about a second to change input and report `SI<new>`. `avrSettle()` polls our own copy until it matches or two seconds pass. A reply that claims to be a reading and is one command stale is worse than none, because answering is the entire point of this device.

**And the projector and the receiver draw as one card.** `config.cinemas` declares the pairing — declared rather than guessed, for the same reason the ceiling groups are: "the screen and the sound in this room" is knowledge about the room, and inferring it from two devices sharing one would be wrong the first time a house has a television and a soundbar in the same place. Its members do not also appear on their own; a receiver with no cinema declared gets its own **Sound** category, since `kindOf` had no case for `AVR` and it was falling all the way through to `light`.

The reading is **two halves that are never merged**, and that is the point of the card: the receiver states its volume, source and mute as fact, while the screen half keeps the projector's `HUB SENT` hedge. A single combined "ON" would quietly promote the guess to a fact. The panel says it once in prose — the fact big, the qualification small — after a first attempt stacked three paragraphs of caveat above the controls, which is the display-serif mistake this file already recorded for the projector.

Three UI decisions worth keeping, all of them from getting it wrong first:
- **The key means "make them both on".** It was `!some(on)`, so with the receiver already on and the projector dark, pressing the cinema key **put the music out instead of starting the film** — the exact bug this file records for All COBs, reproduced. It is `!every(on)` now: anything short of both-on turns both on, and only a fully running cinema switches off.
- **Each machine's power lives in its own section**, not in the foot. Four power buttons down there all looked alike and said nothing about which was which — and the receiver had no power control at all, which is half of "each controllable on its own".
- **The projector's own speaker block is hidden when a receiver is present.** Two blocks headed Sound is worse than not offering the one nobody would use.
- And the source chips are a **grid**, not a growing flex row: ten of them left `NET` stretched alone across the full width, reading as the most important source in the house — the same stranding the projector's word rows hit.

Two traps of my own, both caught only because something reported them out loud: `paint` is **`paint(d)`**, one tile from its device, not the whole-board repaint the name suggests; and a receiver has to be **merged explicitly in `applySnapshot`** like a television, or its volume and source silently never update — which this file already warns about for anything beyond status/level/tune.

**Getting into a strange hub is written up in `deploy/HUB-ACCESS.md`** — the GRUB `init=/bin/bash` route used here on 2026-08-12, what blocks it (LUKS, a BIOS password), and the checks that prove the vendor's app survived.

- `Device/areaComps.py:avrIrMap` — `device_id_ir` plus twenty keys: `power mute left up ok down right fback play fforward last stop next format pause title sk menu back`. No `device_id`, exactly like the projector.
- `avrRelayIrMap` (`device_type: RLIR`) — the same twenty plus `device_id` and `channel_id`: a relay for power with IR for the rest.
- `BMS_host/device_operations.py` builds `"IR_OPR " + device_id_ir + " " + code` and calls the same `ac_panel_opr.ir_opr`, with a `time.sleep(0.3)` before it. The live path needs no special case at all — `operations.py` sends **any** `device_type == 'IR'` record to `ir_opr`, and only an AC gets its command string rewritten.

**The important part is a trap: an IR record's key names are slots, not meanings.** The projector's happen to be literal — `on` really is power on, proven by firing it. An AVR's are not:

| scene operation | field it actually sends |
|---|---|
| on | `power` |
| **off** | **`sk`** |
| mute | `mute` |
| **DVD input** | **`play`** |
| **GAME input** | **`fforward`** |
| **MEDIA PLAYER input** | **`last`** |

So the installer programs whatever codes a given unit needs into whichever slots the generic remote layout provides, and `play` sends the DVD-input command. **Never infer what an IR key does from its name** — read the dispatch, or press it and look. The same caution applies to any future PRJ on a different unit.

Two more things worth having written down:
- **`PRJ` + `RLIR` is unimplemented in the hub itself**: both branches log `"Projector RLIR: Not Completed"` with the `ir_opr` call commented out. A relay+IR projector cannot be driven by this firmware at all, whatever we send.
- **The registry disagrees with the records.** `BMS_host/config.py` lists the eight appliance kinds — `AC TV CT MP STB PRJ AVR` (plus lights) — but a curtain's actual `app_type` is **`C`**, not the `CT` the registry names. Trust the records, not the registry.

Confirmed from the hub's own `devices_tbl` that nothing here uses it: `L/RL` 74, `AC/IR` 6, `C/RL` 5, `AC/RL` 1, `PRJ/IR` 1, `TV/LIP` 1. No AVR, no STB, no MP.

The payload is **`IR_OPR <device_id_ir> <code>`**, and it was not inferred. `BMS_host/ac_panel_opr.py:ir_opr` splits its argument on spaces and reads device and channel out of positions 1 and 2, and `get_opr_from_params` (the AC-only rewrite) returns `"IR "+device_id+" "+channel_id` — so position 0 is a label the hub ignores. The exact string came from **the hub's own journal, which logs every payload it receives and therefore is a packet capture of the vendor app**: `'opr_param': 'IR_OPR 195 168'` twenty-three times, `195 169` four, `195 177` twice. Nothing varies between keys but the code, which is why there was nothing further to learn from sniffing the app.

Two traps, both the same shape as the air conditioners:
- **`device_id_ir`, not `device_id`.** A projector record has no `device_id` at all, so `acCommand()`'s shape cannot be reused.
- **`operations.py` rewrites the command string only for `app_type == 'AC'`.** A PRJ record's `opr_param` goes to `ir_opr` untouched, so `setRecords` handed it the empty string: proven live beside the vendor's own line, `IR PARAMETER ISSS ` with nothing after it against `IR PARAMETER ISSS IR_OPR 195 168`. And it answered **`confirmed: true`** — the hub files the `device_status` it is given, so the read-back agreed and the board showed the projector on while it sat dark.

`splitProjectors()` pulls them out of both bulk paths — `setRecords` (which is what makes `/do`, the group tile and `switchOffMany` all reach it) and `sendSteps` (cues and sleep timers). **Unlike the air conditioners, cues were fixed too**, with the user's say-so: exactly one cue carries a projector step, it is `on` in a cue called Movie Night, it is fired by hand rather than at 3am, and no schedule names it — so "every existing cue would start commanding one at whatever hour it fires" simply does not apply. Verified end to end with a throwaway projector-only cue set to **off**, which could not disturb the room: `sent: 1, missed: 0`, hub log `195 / 169`.

**PJLink is a dead end here, and it was worth checking.** `operations.py` has an `IP` + `PRJ` branch calling `BMS_host/projector.py:PJLinkProjector` — real bidirectional control, with `get_power`, lamp hours and errors, which would have made this the one hub device whose state is a reading. It is unused on this installation: our record is `IR` with no `ip` field, and a **full sweep of 192.168.1.0/24 from the hub found port 4352 closed on all 254 hosts**, along with nothing on 3629 (Epson), 41794 (Crestron) or the other ten projector ports. The only unidentified web devices are a D-Link at `.9` and the door intercom at `.13` (a Vue app on lighttpd — "Villa", "Apartment", SIP). Being cabled to Ethernet does not make it network-controllable, and a cold projector would answer nothing anyway, so this is not proof it never could — only that IR is what works today.

**Its reading is hedged harder than an air conditioner's**, and for a stronger reason: `projIrMap` gives the record **no `device_status` field at all**, so the only reason there is one to read is that we wrote it. The tile says `HUB SENT ON` / `HUB SENT OFF` and the panel's headline says "The hub last sent off", with the caveat under it in labelling type — **not** in the display serif, where four lines of qualification made the footnote the loudest thing on the panel.

The panel borrows the television's `.tvblock` / `.tvrow` / `.tvkey` / `.tvpad` classes outright, because it is the same object and two sets of rules for one shape is how they drift. Three differences worth keeping: there is **no volume strip** (a strip shows a level and this machine has none — only keys that nudge one we cannot see, which is exactly why the television has a strip and this does not); keys the record does not carry are **hidden at draw time**, and a block whose every key has gone hides its legend too, so another install's shorter remote draws itself; and a word row is `.tvrow.words`, a **2×2 grid on a phone**, because four across at 375px leaves 46px of text box in a 74px key — "Computer" overflowed its own button and "Focus +" wrapped to two lines, and letting it wrap freely stranded "Freeze" and "Auto" alone across the full width where a lone wide key reads as the most important thing in the row.

One bug of my own worth recording: **`paint` is `paint(d)` and repaints one tile from its device — it is not the whole-board repaint the name suggests**, and calling it bare throws on `d.record_id`. Caught only because the panel reports a failed press out loud; the tile would otherwise have silently never updated.

**And the other three roads were finished on 2026-08-24, on the user's report that a cue could not toggle one.** A cue step, `/do/<room>/ac/<action>` and a `device:` sleep timer all went through `sendSteps` or `setRecords`, which handed the hub a bare record and got the silent drop above. Both now split an IR air conditioner out and send it with `acPower()`, the same way each already split the projector, keyed on a new record-level `isAcRecord()` that `itemIsAc()` also delegates to — one definition of "this is an infrared AC" rather than three.

**The reason this had been deferred was checked rather than assumed, and it had evaporated.** The argument against was that fixing `sendSteps` would make *every existing cue carrying an AC step* start commanding one, first showing up at whatever hour that cue fires. Counted against the live house before touching it: **none of the nine cues carries an AC step** — records 506–511 appear in not one of them — so nothing that already exists changed behaviour, only what somebody builds from here. Re-count before assuming this still holds.

Proven on ASHU at 00:25, choosing the one case that cannot disturb a bedroom after midnight — the AC already on, so sending `on` changes nothing in the room while the hub's log still says what it received. `/do/ashu/ac/on` and an AC-only cue each logged `on 193 on channel id 11`. Then a mixed cue (AC + fan + two COBs) to prove the split does not break the batch: `sent: 4, missed: 0`, and four separate lines — `on 193 · channel 11` for the AC beside `device id 62 · channel 12` and `device id 19 · channels 24, 33` for the rest. The off direction needs no separate proof for the same reason it did not in `fireTargets`: `stepTarget()` gives `level 0` for `on: false`, so it is the identical `acPower(entry, false)` already logged at `channel id 10`.

One consequence worth keeping: **`outstanding()` cannot judge an air conditioner and does not need to.** It compares the hub's `device_status` to the step's level, and `acPower` writes that status while the hub files it too — so an AC step always reads as satisfied. That is a belief, not a reading, exactly as everywhere else with IR. It errs toward not resending, which is the safe direction, and a resent `on` or `off` is absolute rather than a toggle so it would be harmless anyway.

**Reading state.** The hub pushes one `site_config` per connection carrying live status for every device. It sends **nothing** in reply to a command and does not push changes to an idle socket, so a fresh connection is the only way to learn the truth — including changes made at a wall switch or in the phone app.

**But a read serves the hub's own record, not the hardware — and once they disagreed (2026-08-25, cause never established).** Ashu's fan was running while the hub reported record 448 `"false"`; the hub had been switched off about two hours earlier, for an unrelated reason, with the fan already on. It took a person noticing and correcting it.

**Do not write down a mechanism for that, because three were proposed and all three were wrong.** "The hub never listens" is wrong — there is a listener, below. "An operation triggers a reconciliation" is wrong — `GetAllSTatus1` only pushes the database to browsers, and the correction coincided with a human intervening, so the counts prove nothing. "The record is not persisted across a restart" is wrong — `device_status` lives inside the `device_object` JSON blob on `devices_tbl` and **the DB and the live `site_config` agree exactly**, checked with both fans on. A fourth possibility is simply that 448 was genuinely off and the fan being heard was **462, which is filed under Master Room** and sits one channel away on module 62 — the same mislabelling this file records for the niche light. Unresolved.

What is worth keeping is the consequence, which holds however it happened: **a reading here is the hub's belief, and nothing in the system can currently check it against the hardware.** So `look` in `/api/say` can say "Fan is off" about a fan you can hear, the monthly report would lose those hours, and the left-on advisory never fires for a circuit the hub thinks is already off. **Commands are unaffected** — `off` is absolute rather than a toggle, so `/do/ashu/fan/off` stops it regardless of what the hub believed.

**The read path is real, and it is UDP 6000.** `BMS_host/device_operations.py:device_listener()` runs a thread doing `select` + `recvfrom(4096)` on the socket from `socket_manager.get_udp_socket()` — bound `0.0.0.0:6000`, the same port the hub broadcasts commands to — and queues every packet for six `main_update` workers, which merge `device_status` per `(device_id, channel_id)`. `BMS_host/startup.py` starts it.

Two dead ends checked so they are not checked again. **`BMS_host/socket_host.py` on TCP 10102 is a hardcoded demo stub** — `client_sender()` returns a literal string of thirty invented air conditioners (`L2.001 ON 16C 17C High Cool OK`) to anything that connects, parses nothing, and has nothing connected to it. It is the unidentified listener in this box's port list. And **`GetAllSTatus1()` in `Device/views.py` does not poll anything** — it reads `user_site_config()` and pushes it to connected browsers, so `GetAllSTatus...` in the journal means "the database was sent to the phones", not "the hardware was asked". No serial path: no `pyserial`, and `/dev/ttyS0-4` are the motherboard's own UARTs.

**The bus is HDL Buspro, and it is on the broadcast domain (2026-08-25).** `BMS_host/relay_code.py` opens every packet with `\xFF\xFF\xFF\xFF` + **`SMARTCLOUD`** + `\xAA\xAA`, HDL's UDP signature, and carries **`GET_STATUS = \x0b\x01\xFE\xFF\xFE\x00\x33\x01`** beside `OPERATION`, `IR_OPERATION`, `SCENE_CONTROL` and two AC-panel codes. Everything goes to `255.255.255.255:6000`, so any host on the LAN hears it — proven from the Mac, having transmitted nothing, with a socket bound to udp/6000 using `reuseAddr`.

```
c0a801c8 534d415254434c4f5544 aaaa 11 0101 8058 da44 ffff 1a081912 0a1ee48e
└src IP  └SMARTCLOUD          └hdr └len└src └type└op   └bcast└clock, 30s tick
```

**A passive listener was designed and then abandoned, and the reason is the useful part: at idle the bus is silent.** Four minutes of capture yielded **eleven packets, one opcode, one source** — a 30-second clock tick from a gateway at **`192.168.1.200`** (which answers no HTTP and holds no ARP entry from the Mac, and which nothing in this project had noticed before). No status announcements at all. And the wall switches here are **smart switches that fire preset groups through the vendor's app**, so the hub *originates* essentially every change rather than overhearing it — which is why its record is usually right, and why a passive observer would have almost nothing to observe. Do not build one expecting it to catch wall-switch activity.

**`GET_STATUS` works, and `pollHardware()` in `server.js` is it (2026-08-25).** Broadcasting `HEADER + GET_STATUS + <module id> + crc` makes a module report its channels; the vendor's own `device_listener()` catches the replies and its workers save them, so nothing here parses a byte and there is no second copy of the house's state. Called forced at startup — a restart being when the hub's record is least trustworthy — before `look` answers a question, and on demand at `POST /api/poll`, which reads, polls, reads again and names every circuit whose value moved.

Four things measured, and one still open:

- **It must be sent from the hub.** Six queries from the Mac drew nothing; three from the hub drew `Receieved status of : 61` and `Saving status of relay: 61`. Either the modules answer only the controller they know or a Wi-Fi broadcast does not reach the bus. Do not try it from a laptop.
- **Only two of the four modules answer.** 61 gave 21 replies and 62 gave 22, while **19 and 195 gave none**, retested individually. Module 19 is **all thirty-six COBs**, so the poll covers the fans, switches and curtain relays and leaves every ceiling lamp unverified. A dimmer module probably wants a different opcode — that is a guess, not a finding.
- **Do not bind udp/6000.** `socket_manager.find_and_kill_process` kills whatever holds it. Sending from an ephemeral port sidesteps this and the reply still lands where it is wanted.
- **The CRC is CRC-16/CCITT (XModem), init 0**, over everything after the SMARTCLOUD header and before the checksum. Verified against a captured frame *before* transmitting, which is why it worked first time.
- **Still unproven: that a reply overwrites a *wrong* value.** Every test found the hub already in agreement, including one run against a deliberate desync that had resolved itself by the time it was polled. So the poll is proven to be answered and saved, and is **not** proven to correct. Do not describe it as a fix until something has watched it happen.

**Timing, measured against this hub.** A `site_config` arrives ~1.5–3s after connecting, and snapshots state at connect time. A read starting too soon after a command still reports the *previous* state; `SETTLE_MS = 3200` is that measurement plus margin. Do not lower it without re-measuring.

Re-measured 2026-08-13 (tune changes on ASHU COB 1, read connecting at increasing delays): stale at 1001 / 1502 / 2001 / **2401** ms, new state at **2800** / 3201 ms. So the boundary is between 2.4s and 2.8s — *higher* than the original ~2.3s estimate, leaving `SETTLE_MS = 3200` only ~400ms of headroom. **It is already near-optimal; lowering it breaks confirmation.** Perceived latency was addressed with live push instead (below), not by shaving this.

**Commanding many devices at once.** One socket per command means a cue of eleven lights is eleven handshakes, and the hub drops most of them — this is what the ~200ms spacing between *single* sends is for. A whole cue therefore goes down **one shared socket** (`sendBatchToHub`), commands spaced `BATCH_GAP_MS` (60ms) apart on the wire, which the hub takes without dropping. Measured: firing 5 lights this way missed 0 with zero retries, twice, in both directions; simply firing the old per-command sends *concurrently* missed 100% (every cue logged a full retry pass). The fix is the shared connection, not concurrency.

**Colour needs 800ms between commands. Brightness does not.** The one gap was applied to both, and colour was quietly changing a single lamp. Measured 2026-08-15 on ASHU's five COBs, counted by eye because the hub cannot be asked (above):

| spacing | colour landed | brightness landed |
|---|---|---|
| 60ms (`BATCH_GAP_MS`) | **1 of 5** | **5 of 5** |
| 300ms | 1 of 5 | — |
| 500ms | 3 of 5 | — |
| 800ms | **5 of 5** (twice) | — |

So brightness at 60ms was always fine, and `TUNE_GAP_MS = 800` now paces colour batches — `sendBatchToHub(commands, gapMs)` takes the gap, and both colour senders (`setRecords`, `sendSteps`) pass it. This is exactly the vendor's own `GRP_DELAY_T = 0.8` against `GRP_DELAY_D = 0.2` (`DeviceGroup/models.py`); they clearly hit the same wall. **This was the real "All COBs doesn't change all COBs"**, and the reason a ceiling could end up burning two temperatures. The cost is unavoidable: five COBs take 3.2s of wire time to re-colour, seven take 5.6s, and since the hub reports nothing back about colour there is no way to send fast and repair afterwards. Do not shave it — 500ms already loses two lamps.

**Every COB in the house is on one module: `device_id` 19, all 36 of them.** So pacing per module would buy nothing — the queue is shared no matter which room. Worth re-checking with `device_id` after any vendor visit, because if a later fitting lands on a second module, batches split across the two need not wait for each other.

**Eleven is not five, and the loss is intermittent.** Re-measured 2026-08-14 on LIVING's eleven COBs: at the 60ms spacing that is flawless for five, one run dropped **three of eleven** and the next dropped none, with nothing changed between them. So there is no gap that can be trusted — `gapFor()` widens to 130ms above six commands, which helps and is not a guarantee. What makes it reliable is checking: `setRecords()` schedules `verifyGroup()` in the background, which re-reads and resends **only** the members that did not take. Two rules keep that safe — it skips any record whose `intents` token has changed (something newer owns it), and it refuses to judge a reading taken less than `SETTLE_MS` after its own command, since that reading describes the house before it and acting on it would undo a newer instruction. The caller never waits for any of this.

**The hub does accept a group command — but batching is still the right call.** An earlier note here said there was no evidence of one, reasoning from the Android client, which indeed carries no group-command payload (its only group code is HTTP management, and `vgroup_opr` is *create a merged virtual device*, not "command this group"). Reading the hub's own Python on 2026-08-15 settled it: `BMS_host/operations.py:142` handles `opr_type: 'group_opr'`, taking `{group_id, group_status_dimmable, group_status_tunable?, tuned?}`, resolving membership from its own database and calling `device_operations.update_lights_parallel()`. **The lesson is the general one in this file — read the source on the box rather than reason from the client.**

Still, do not switch to it:
- It is **not atomic**. `update_lights_parallel` submits one `relay_opr` per device to a thread pool with `time.sleep(GRP_DELAY_D|GRP_DELAY_T)` between submissions — the same one-command-per-lamp loop we already run, just paced on the hub.
- The installer's groups **do not match ours**. `site_config` carries `group_devices` per group: Parent, Ashu, Master, Home Theatre and Dining match our All COBs exactly, but **LIVING's group holds 8 of our 11 COBs** and Harshit's single COB is in no group at all. Driving Living by `group_id` would silently skip COB 9, 10 and 11 — precisely the bug the group tile exists to avoid.
- `tuned = bool(record['tuned'])` in Python makes the **string** `"false"` truthy, so a mistyped flag turns a brightness command into a colour one.

Batching gets the same result, on membership we control.

**`relay_opr` broadcasts UDP and never hears back.** `device_operations.py` ends every command with `urls.s.sendto(udp_pack_new, ('255.255.255.255', 6000))` — one fire-and-forget broadcast per lamp, no ACK, no retry. That is the whole reason spacing matters at all, and why nothing about colour can be confirmed.

**The hub's own log says what it tried, which separates our bugs from its.** The vendor app runs as `tistron_backend.service`, `abneo` is in `adm`, so no sudo is needed:

```bash
ssh abneo@192.168.1.3 "journalctl -u tistron_backend --since '5 min ago' --no-pager | grep 'Sending Operation'"
```

Each line names device id, channel and value. When five commands appear there and one lamp moves, the fault is downstream of the hub — which is exactly how the colour timing above was pinned down.

## Making it somebody else's house too (2026-08-22, in progress)

The target is **another installation of the same vendor's controller** — an Abneo/Tistron hub, a different house. Everything in the protocol sections above transfers as-is; nothing here attempts a different brand, because every line of that protocol was measured against this hardware and there is no way to write, let alone test, a driver for a box nobody has.

**The split is: this house is data, the protocol is code.** `config.json` (git-ignored, per-install; `config.example.json` is the committed shape) holds the house's name, its hub address and port, its televisions, and its groups. An **environment variable still wins over the file**, because that is how a second instance is run against the same hub for testing (`PORT=3111 HUB_IP=... npm start`), and every measurement in this file was taken that way. A missing or unparsable config is not fatal — it means the defaults, and the house comes up as "The House" with no televisions and no group tiles, which is exactly what a fresh box should look like before setup runs.

**Groups are declared, not guessed, and that was the real blocker.** The ceiling tile keyed off `isCob = /^COB\b/i.test(d.name)` — a regex on the device *name*, used in eleven places. It is correct here and wrong everywhere else: another installer typed SPOT, or DOWNLIGHT, or nothing consistent, and a name is free text rather than a fact about the wiring. So membership is a list of `record_ids` in `config.groups`, set by hand from the console — **not** auto-detected, which was the user's call and the right one: a heuristic that guesses which fittings belong together would be wrong occasionally and silently, and the person installing it knows the answer.

Two things that keep the old addresses working. Each group carries a **slug**, defaulting to its label with a leading "all" stripped — so `All COBs` still answers to `/do/<room>/cobs`, which is what every shortcut and every line of `SHORTCUTS.md` already says. And the groups ride the **snapshot**, so the page gets them on first load and on every push, and the console can change one without a reload. One group per room for now, which is what a ceiling is.

**The seed cues left the code.** They were a literal list of `record_id`s, and record 449 is a different lamp on a different hub — seeding them on a foreign install would invent cues nobody wrote out of whatever those numbers happened to hit. They live in `data/seed-scenes.json`, per-install and git-ignored; absent is the normal case, and an install with no cues gets the empty state that invites making one.

**`deploy/push.sh` places `config.json` only when the box has none.** It copies `server.js` and nothing else by design, but `server.js` now *reads* the config, and a box without one loses every television and every group tile. Per-install means the console edits it in place, so pushing over it would put one house's settings on another: placed if missing, never touched if present.

**Node, not Bun**, and the reason is other people's hardware: Bun's ordinary Linux build wants AVX2, and the same desktop model that runs this hub shipped with a Pentium G3220 that lacks it. The standalone Node tarball runs on anything x86-64 with old glibc and is already proven here. On top of that the one dependency is `ws` with `perMessageDeflate`, which is the single most fragile thing in the system — this hub's handshake fails *silently* when it is wrong. Bun would buy nothing: one file, one dependency, and the bottleneck is a 1.5–3s hub round trip.

**`tools/setup.js` is a dry run until `--apply`**, because the first question against a strange house is "what would this do" and the second is "what did it find". It reports the counts, then **what cannot be done** — an IR air conditioner is one-way, colour temperature cannot be read back at all, a curtain reports no position — and then its own two guesses, which is the part that matters: fans are found by the word FAN because this hub's `isFan` flag says false for all four of its actual fans, and an unknown `app_type` falls through to `light`. Its screen sweep falls back to the ARP table for a MAC (a set advertises one on only some of its SSDP records), says whether the prefix means power-on will work, flags the NAT case, and cross-references config so an already-mapped set names its room. It never invents a mapping.

Three bugs came out of dry-running it, all of the same kind — **assuming a shape instead of reading the one server.js already reads**. `area_devices` is a comma-separated string, not an array, so iterating it walked character by character and called all 88 circuits homeless; the room's name is in `name`, not `sub_area_name`; and `is_tunable` is genuinely true for 17 circuits, not the 36 that carry a `device_status_tunable` field. When writing a second reader of this hub, copy the first one's parsing rather than inferring it from a sample.

**The console is `/setup`, its own plain page.** The dashboard is a board you glance at; this is a form you sit at once, and a settings screen inside the thing being configured is reachable by accident on a wall panel. Groups and kinds take effect at once — `applyConfig()` rebuilds them and `pushSoon()` carries them out — while a name, an address or a screen needs a restart, and the reply says which rather than leaving somebody wondering why nothing changed.

Four traps it hit, worth keeping: **`applyConfig()` ran before `KIND_OVERRIDES` was declared** (a `let` reached early is a startup ReferenceError, and `node --check` cannot see it — twice in one session, so those declarations now sit together); **the hub's room names are inconsistently cased**, ASHU ROOM beside Master Room, and `/api/setup` reported the raw name while groups hold the `roomKey`, so two rooms showed as having no group; **saving groups replaces the whole array**, so the page sends every room every time; and **the port field showed the *effective* port**, which for a test instance is an environment override, so pressing Save would have written 3111 into the house's config — the fields now show what is configured and the overrides are reported beside them.

**The Restart button does not exit cleanly, and that is deliberate.** A clean exit only comes back under `Restart=always`; a unit written `Restart=on-failure` reads it as "it meant to stop" and would take the dashboard down and leave it down, from a button labelled Restart. So it asks systemd properly first — `sudo -n systemctl restart`, the one command permitted without a password here, which `push.sh` already relies on — and only if that is unavailable does it exit **non-zero**, which `on-failure` will restart. Proven live: the process start stamp moved and the page came back.

**A mistake worth not repeating: re-running `install.sh` on this hub created a second service.** The system unit at `/etc/systemd/system/neo-dashboard.service` is the one that has always run the house, and it is root-owned; `install.sh` needs an interactive `sudo` to write there, could not get one, and silently took its **user-service** fallback — enabling a second copy that fought the first for port 3000 and, being freshly written `Restart=always`, retried forever. Removed with `systemctl --user disable`. The template is still `Restart=always`, which is right for a fresh install through `bootstrap.sh`; **this hub's own unit is still `on-failure` and cannot be changed without the password**, which is exactly why the restart endpoint does not rely on it. Do not re-run `install.sh` here to change the unit — edit `/etc/systemd/system/` with a real sudo, or leave it.

`deploy/bootstrap.sh` is the fresh-install path: Node into `/opt/nodejs` if the box has none new enough (**leaving the system node alone** — the vendor's app depends on it here), then dependencies, then setup, then the service. A dry run until `--go`. All three Node tarball URLs were checked to resolve rather than assumed. One bug: `"${ARRAY[@]}"` with `set -u` and an empty array is an unbound variable on bash 3.2, which macOS ships and the hub's bash 5 would have forgiven — so it would have shipped unnoticed. `deploy/FRESH-INSTALL.md` walks it, and is straight about what cannot be automated: which screen is in which room needs somebody watching one come on, and pairing needs a person at the set.

## Architecture

**Device data** loads at startup from `data/devices.json` (the full hub records plus room grouping via `areas → departments → sub_area.area_devices`), falling back to a CSV parser over `data/neo_console_devices.csv`. Records live in a `Map` keyed by `record_id`; hub reads merge over them, so the map is the single source of truth that `deviceList()` projects for the API.

**New devices are not picked up on their own.** The merge in `readHubState()` is `if (entry)` — a `record_id` the map does not already hold is silently dropped, so a light the installer fits later is invisible no matter how many times the hub is read. After any vendor visit run `node tools/discover.js` (rewrites `data/devices.json` and prints what changed) and restart. This is not hypothetical: on 2026-08-13 the hub had 88 devices to our 87 — record 519 `HANGING` in Parent Room, lit at the time and absent from the dashboard entirely.

**A read carries a picture of the past, and merging it blindly undoes your command.** The `site_config` describes the house **as it stood when the socket opened**, and it arrives 1.5–3s later — so a read already in flight when you press a key knows nothing about that key. Worse, a read that connects *within* `SETTLE_MS` of a command still reports the previous state, because that is exactly what `SETTLE_MS` measures. Merging either one puts the light back to where it was for a second or two, then corrects itself on the next read. Symptom: switch a circuit on, wait a second, switch it off — it shows off, then **on again for ~1s**, then off. Fixed by stamping each read with `takenAt` (connect time, exposed to browsers as `synced_at`, distinct from `hubSync.at` which stays completion time for health), keeping a server-side `commandedAt` per record in `sendToHub`/`sendBatchToHub`, and **skipping the merge for any record whose command is newer than `takenAt - SETTLE_MS`**. The optimistic write the sender already makes then stands until a read that genuinely knows arrives. A wall-switch change is untouched by this (no command, so nothing to skip) — verified by commanding the hub directly, behind the dashboard's back, and watching it appear on the next read.

**Freshness** is one background reader for the whole house: `readHubState()` every `REFRESH_MS` (15s), with concurrent callers sharing one in-flight read. `/api/devices` serves that cache instantly and never blocks on the hub; `?refresh=1` forces a read.

**Live push.** Browsers no longer poll on a timer — `GET /api/stream` is an SSE channel that pushes a full snapshot whenever the house actually moves, so a wall-switch change appears as soon as the reader sees it and two phones never disagree. `pushSnapshot()` compares a `stateSignature()` and sends nothing when nothing changed; `pushSoon()` (250ms debounce) fires after our own commands so a cue of eleven lights costs one frame. The page keeps the 10s poll purely as a fallback and **skips it while the stream is live** (`streamLive`). A 25s heartbeat comment keeps idle proxies and phone radios from dropping the connection.

**Health has a face on the desktop, and only there.** A hollow ring beside the masthead title, polled once a minute, invisible until something is wrong — then coral and slowly breathing, with a click opening an opaque panel of figures: the hub's read age and success rate, each television's link, commands sent and failed, cues fired, browsers watching, uptime and memory. Desktop only on purpose: it is something you go looking for at a keyboard, not something to carry on a phone board. It reads the endpoint's **status code** as the verdict rather than re-deriving one, so the page and the watchdog can never disagree about whether the house is healthy. `/api/health` also reports each TV link now (`connected`, `on`, address, consecutive failures), because a set that is switched off looks identical from the board to one whose link has broken.

It rides the **title** line rather than the tally: the tally is a long sentence that already fills its width, so a dot placed after it simply wrapped onto a line of its own.

**Health.** `GET /api/health` answers without touching the hub (cheap enough to poll every minute) and returns **503** when the background reader has stopped getting through — the failure systemd cannot see, since the process is alive and still serving pages. It carries uptime, hub read success rate, consecutive failures, command counts, cues fired, SSE client count and RSS. `deploy/watchdog.sh` (cron, every 5 min) restarts the service after **two consecutive** 503s, so one slow read is not a restart.

**Confirmation.** `/api/toggle` sends, waits `SETTLE_MS`, re-reads, and reports `confirmed: true|false` — roughly a 5s response, absorbed by an optimistic UI whose pending shimmer clears after 900ms. A per-record intent token means a quick second click invalidates the first verdict. `/api/level` and `/api/tune` deliberately skip this (sliders fire continuously); they return at once and schedule a delayed read.

**`/do` is the address grammar for everything outside the browser.** `/do/<room>/<circuit>/<action>`, plus `/do/<room>/<action>` for a whole room and `/do/cue/<id>`. Rooms and circuits are slugs of the names the dashboard shows, matched on a **unique prefix** (`/do/ashu/foot/off`), with `all`, `lights` and `cobs` as collective names in every room. Actions: `on` `off` `toggle`, a bare `0`–`100`, `up`/`down` (±20 from where it is now), `warmth-<0-100>` (or `tune-<n>`) with `warm`/`cool`/`warmer`/`cooler` on top of it, and `open`/`close`/`stop` for curtains. **A bare number is always brightness** — colour has to name itself, or `/do/ashu/cobs/70` would be a coin toss between two channels. Asking an untunable circuit for a colour is a 400, not a quiet success sending nothing. Everything answers to GET, every reply carries `spoken`, and `GET /do` and `GET /do/<room>` enumerate what exists — an error names the valid options, because a mistyped URL in Shortcuts is otherwise silent. A cue was the wrong shape for "just the fan" or "a bit dimmer"; this is the right one. Both roads meet at `setRecords()`, which the group tile also uses, so the two-channel and circadian rules hold everywhere. **Relative and toggling actions re-read the hub first if the cache is over 4s old** — a `toggle` computed from a stale reading is backwards, which is worse than slow.

**A room's COBs are one control.** Every room has COB 1…n — five in ASHU, eleven in LIVING — the same fitting repeated around a ceiling, and they are nearly always wanted at one setting. `POST /api/group {record_ids, on?, level?, tune?}` sets them together down one shared socket (`sendBatchToHub`), and the room's board leads its Lights section with an **All COBs** tile carrying one key and one slider per channel. The individual tiles stay below it — the group is the usual case, not the only one.

**The key means "make them all the same".** It used to switch off whenever *any* member was lit, so pressing All COBs on a ceiling with one lamp on put that one out — the opposite of what a control called "all" appears to offer. Now anything short of all-on turns them all on, and only a fully lit ceiling switches off; coming on they match the brightest lamp already burning rather than jumping to full, so one lamp at 40% gives five at 40%. Its **brightness reading averages only the lit members**, because four dark lamps and one at full is a ceiling set to 100 with most of it switched off, not a ceiling at 20% — and showing 20 meant one nudge of the slider slammed every lamp down to a fifth. Colour still averages over all of them, since a lamp keeps its colour while it is off.

Two things that endpoint does deliberately, both learned elsewhere in this file: the **two channels are addressed independently**, so a warmth drag sends colour only and never rewrites brightness (going through `sendSteps` would have coupled them and blasted every COB to 100% on a tune); and **circadian fills in only for lamps that are currently off**, so a brightness drag cannot re-tune a lit lamp and fight a colour set by hand. Like `/api/level` it does not confirm — a 5s verdict per drag is worse than a missed lamp the next read corrects. The frontend keeps every member in `inFlight` while a drag is live, and `paintGang()` skips its own sliders while any member is there, or a repaint would jump the handle under the finger.

**A television can be in a cue and on a schedule, and there is one rule about it: a set that is already on belongs to whoever is watching it.** A cue step or schedule that would put a video, an app or a volume on the screen is applied **only if the set is off when it fires**; if somebody is watching, all of it is skipped and only a `toast` is delivered — a message is the one thing that can be said to somebody mid-programme without taking the room away from them. **Off is deliberately not guarded**: a bedtime cue that cannot switch the television off is not a bedtime cue. The guard is against hijacking, not against being switched off.

Consequences that follow from it, all deliberate: a screen step is **never retried** (`outstanding()` only reads hub records, so it cannot see one — and resending a launch is precisely the hijack the rule prevents), and it is **never undone** (`captureBefore` skips it, one step further than the curtain exclusion: we could record that a set was on, but not *what it was showing*, so switching it back on to its default app is a second interruption dressed as an undo). Both `runSchedule` and `applyScene` go through the same `runTvStep`, so the rule cannot hold in one place and not the other — which matters more for a schedule, since nobody is at the dashboard when one fires. `applyScene` starts the screens and the hub batch **together**, because a set taking nine seconds to wake must not hold up the lamps.

**A screen's id is a string and the hub's is a number, and that difference is load-bearing.** `Number('tv-living')` is `NaN`, so every place that resolved a step or a target by coercing to a number silently dropped screens: `cleanSteps` (they never saved), `scheduleTarget`, `readSchedule`, and `noteFor` — which did not drop them but *threw*, reading `.room` off an undefined hub entry. `isTvStep()` is the guard, and it has to come **before** the coercion in each of them.

**Four bugs the cue flow had on a phone, and one hazard worth knowing.**
- **Dismissing a sheet by flicking it did not run its closer.** `sheetDrag` ended in `if (g.scrim.id === 'scrim') closeSheet(); else hideScrim(g.scrim)`, and two of these sheets *borrow* a node — the cue list and the schedule list each live in the sidebar on a wide screen and are moved into a sheet on a phone. So flicking the Cues sheet away hid it with the list still inside: the cue rail on the house view was **empty, and stayed empty**, until you opened and closed the sheet properly. `dismissSheet()` names how each scrim is put away, and Escape goes through it too.
- **A cue opened from the Cues sheet appeared behind it.** Every `.scrim` is `z-index: 50`, so stacking falls to document order, and `#cuescrim` is declared later than `#scrim` — tapping a cue's pencil looked as though it did nothing at all. Fixed by having the launcher give way (`openSheet` closes it), so there is one bottom sheet at a time, which also avoids two draggable sheets fighting over the same handle.
- **The editor's sliders were 18px tall with 136px of track** — a line, not a target. The board's own strips are given 26px on a phone for exactly this reason. 30px and 168px now, with a bigger thumb, and the labels give up the width.
- **Its text fields were 14px, so iOS zooms the page on focus.** Already written down for the search field; the television's link and message fields were the same trap.

**The hazard: `build-bundle.sh` packs `scenes.json`.** Editing a cue in a local test server rewrites the Mac's copy, and a full bundle deploy would then overwrite the hub's — the house's real cues — with whatever testing left behind. Deploying `server.js` alone (which is what every deploy in this file has done) is safe; a bundle deploy needs the Mac's `scenes.json` checked against the hub's first. Compare with `stat` on both: the hub's file should be older than any local testing.

**Cue building is a checklist, and the settings open in place.** One row (`circuitRow`) serves both the cue's own list and the room's circuits, and it has two hit targets: a **tick that means "in this cue"** — unticking takes it out, which is what a checklist means and what anyone tries first — and the rest of the row, which opens that circuit's settings underneath without going anywhere. Tapping a circuit that is not in the cue yet adds it *and* opens it, which is the fast path for building one from nothing.

**This replaced a worse design of mine, and the reason it was worse is worth keeping.** The first attempt made picking a circuit *navigate* to a screen holding its settings, with a "Remove from cue" button at the foot. It was defensible on paper — one editor, reached from both lists — and wrong in the hand: adding eight lights was eight round trips, taking one out again meant going in to find a button, and **the tick became something you could not untick**, which is the one thing a checkbox promises. Two lessons: a control that looks like a checklist must behave like one, and *navigation is a cost paid per item* — fine once, ruinous eight times. There is no remove button now; having both is how the tick came to mean nothing.

Schedules get the same rooms → circuit picker instead of a ninety-item dropdown (`schedPick`), and both sheets draw the same rows so the house is not named two different ways.

**A schedule names several circuits, not one (2026-08-22).** `target` is `{kind:'device', record_ids:[...]}`; `targetIds()` reads either shape so one saved with a single `record_id` still loads and still edits. The picker is a **checklist** for the same reason the cue editor is: tapping toggles and the sheet stays open, so five circuits is five taps rather than five round trips through the form, and Done carries the count. A tick that cannot be unticked is the one thing a tick promises.

`fireTargets()` is where the three kinds part company, and it is why this is not a loop: **plain circuits go in one `setRecords` call** — one shared socket with verify-and-resend behind it, because this file's own measurements say a socket per command fired together is dropped most of the time, and a schedule for five lamps must not be five sends; a **curtain** needs its verb in `opr_param` and two of them go one after the other; a **screen** goes through `runTvStep`, so the rule about not taking a set off whoever is watching holds here too — which matters more for a schedule than anywhere else, nobody being at the dashboard when it fires. Screens and the batch start together, as `applyScene` does.

Four decisions worth keeping:
- **Open/close only when every circuit chosen is a curtain.** Mixed with a lamp the pair is on/off, and each curtain in the selection still closes on off — which is what the runner does per circuit anyway.
- **A screen is scheduled on its own.** Its extras — an app, a link, a volume — belong to one set and cannot be read across a list, so the server refuses the mix and the picker replaces the selection rather than offering it.
- **Brightness and warmth are offered when *any* chosen circuit can take them**, and the sliders are sized off the first circuit that actually can — key them on the first circuit *chosen* and picking a plain switch then a dimmer hides the slider the dimmer needs. They also survive a circuit being added, unlike the old single-pick behaviour that cleared them on every change: adding a fourth lamp to a schedule set at 30% means at 30%.
- **An unknown id fails the whole save, but a circuit that disappears later is dropped.** Those are different things: saving something that quietly does less than it says is a bug, while a schedule for four lamps should still run when the installer takes one away.

The trap this hit: **`#schedsave`'s own guard still asked for `target.record_id`**, so every multi-circuit schedule was refused with "Pick what this schedule should do" while the server was perfectly willing. Proven end to end afterwards on three of ASHU's COBs that were already on at 100%, so the room could not change: the hub's log showed all three commanded in the same second, `device id 19` channels 24, 6 and 7.

**The picker was a checklist that did not look like one, and the scrollbar was the tell (2026-08-22).** Three complaints, one root each:

- **It said nothing about what was chosen.** A chosen row got the word `chosen` in 13px grey at the far end and its name a shade lighter — the whole of the feedback, for the one question the screen exists to answer. It draws a tick now, using the `.pick .box` rule that had been written for exactly this and **never once used**. Same shape as the cue editor's `rowbox`, so a chosen circuit is not spelled two ways in two sheets.
- **The room list could not show it either**, so stepping out of one room to pick from another lost sight of the first room's ticks completely — the head said four and nothing said where they were. Each room now reads `2 of 6 chosen`.
- **The scrollbar on a list with nothing to scroll was the leftover form.** `#schedcircuit` is `.sched-pick.pickbtn { display: flex }`, and **`[hidden]` is `display:none` from the UA sheet, the weakest origin there is** — so the dead "Choose circuits" button stayed on screen *inside the picker that replaced it*, still reading "Choose circuits" while you were choosing them. With its label that is 96px, and DINING's six circuits are 397px in a 422px body: exactly enough to overflow a sheet with room to spare. Measured 519/422 before, 382/382 after.

**That trap had been patched eleven times, one element at a time** — `.chip`, `.seg-row`, `.whatsnext`, `.seeklayer`, `.scrim`, `.timerpop` and six more each carry their own `[hidden] { display: none }`, two with a comment saying precisely this. There is one `[hidden] { display: none !important }` now. It is safe because no rule in the sheet ever wants a hidden element shown (all eleven only reinforce it) and the only two inline `style.display` writes target `#sheethead`/`#sheetfoot`, which carry no `hidden`. Audit it with *"for every element carrying `hidden`, is its computed display none"* — that returns empty now, and returned exactly one before.

**The head and foot belong to whichever job the sheet is doing.** Picking, the head drops the name field and counts what is chosen, and the foot is one `Done` — because the count has to live **outside** the scrolling list or the answer to "have I got them all" is visible only while you happen to be looking at the right row, and a `Done` sitting *above* fourteen circuits means scrolling back up to leave. Save is gone from the foot while picking: it must not be offered from inside a half-made selection. The cue sheet solves the same problem by hiding its head and foot outright (`style.display`), which is right for it — it has no running count to show.

Three more found while driving it, all of them fixed:
- **The sentence under the title was a stale lie.** The early return skipped `schedPreview()`, so a fresh device schedule sat there reading `At 07:30, run Movie Night. Weekdays.` — a cue it had nothing to do with.
- **Choosing a screen silently discarded every other pick.** The rule is right (a screen is scheduled on its own) but the count dropped from three to one with nothing on screen accounting for it. It says so now.
- **`schedPreview()` threw on a circuit the installer had removed.** It took `deviceOf(schedIds(target)[0])`, and a schedule naming one live circuit and one dead one gave `undefined`, so `pretty(d.name)` threw and the sentence came out blank. It reads `many[0]` — the already-resolved list — which is the same circuit whenever every id resolves. Proven by writing a stale id straight into `schedules.json`, since the server refuses to save one.

**And the kind word at the end of each row is load-bearing, which a first pass got backwards.** The slot the word `chosen` vacated now says what a circuit *is* — `tunable`, `dimmable`, `curtain`, `screen` — because picking blind from a list of names, nothing else tells you whether HANGING is a lamp. It is dropped only when the name already **is** the word (`AC · ac` is daft), never when it merely contains it: LIVING holds CURTAIN ROPE, MAIN CURTAIN and SHEER CURTAIN, and **the rope is a light while the other two are motors** (`app_type` `L` against `C`), so suppressing on a substring blanked all three — in exactly the room where getting it wrong picks on/off instead of open/close.

**Two instrument notes, both already in this file and both re-earned.** `getComputedStyle` through a devtools eval reported the toast as `opacity: 0`, `visibility: hidden` and 13px below the viewport while **a screenshot showed it plainly on screen** — long enough to nearly write up a global "notifications are broken". And a picker row matching `/curtain/i` on its *text* looked like the curtain-verb rule had broken, until the API said `is_curtain: false`: the row matched on the name, not the kind.

**An air conditioner in a schedule works now**, and it is the one kind that needs `acPower()` rather than a record — see the protocol note above for the proof and for what is still broken elsewhere.

**A curtain does not go on and off.** The step editor had `['On', true], ['Off', false]` written into it rather than taken from the circuit, so a cue that closed a curtain read as switching it off — and `stepWord` said "off" for everything. `onOffWords(d)` and `stepWord(st, d)` take the vocabulary from the circuit now: open/close for a curtain, and for a screen what it will actually put on.

**Two traps in the shared step editor.** `stepSlider` reached for `.sheet-step` to update the row's summary as the value moved, and on its own screen there is no such ancestor — it threw on the first drag until it was guarded. And its save callback takes a redraw flag: choosing an app has to clear the link field beside it, while a slider must never rebuild the control the finger is holding.

**The refraction had quietly put sheets back into the glass.** This file's own rule is that sheets and popovers stay opaque — a panel you read and type into has to be a panel — but the later refraction rule listed `.sheet` and `.timerpop` among the things it bends the backdrop through, and the result was a schedule's fields with the room board legible straight through them. Fixed by removing them from that selector rather than out-specifying it, because the intent is that the rule does not apply to them.

**Cues are built, not snapshotted.** "Save this as a cue" used to record every circuit in every lit room, which is almost never the cue anyone meant. **Create a cue** now opens the same sheet the editor uses, on a draft held in the browser: pick rooms, pick circuits, set each one, then `POST /api/scenes {name, steps}`. A circuit added to a cue defaults to **on** — a cue is a list of things to light, and most lamps are off when you sit down to build one. `recapture: true` still asks for the old snapshot deliberately.

**A cue's id is its address and never changes.** `apiId()` derives it from the name once; renaming only touches the name, so a shortcut built months ago keeps firing. Names are unique case-insensitively (`nameTaken()`, enforced on create *and* rename), which keeps ids unambiguous. The id is shown in small type on the cue card and in its sheet, because it is what you type into Shortcuts and cron — see `SHORTCUTS.md`.

**Automations** are three deliberately timid things, all in `server.js` and all switchable from the page. Settings persist in `settings.json`, watch state in `state.json` (both git-ignored, per-install).
- **Circadian colour** — `circadianTune()` interpolates `DAY_COLOUR` (0 cool … 100 warm on this hub: cool by day, warmest overnight) and is applied **only as a tunable light comes on**, before the brightness so a bleed costs colour not level. It never re-tunes a lit lamp, so it cannot fight a colour set by hand. **Nor a colour set on an unlit one**, which was the gap: the group's warmth slider is most often used while the ceiling is off, and switching it on then overwrote that colour — deciding *per lamp* from the cache, so a partly stale cache overrode some of a group and not others and left one ceiling burning two temperatures. That was the real "All COBs doesn't change all COBs". Any explicit tune — `/api/tune`, `/api/group`, `/do .../warmth-n`, a cue step naming a colour — now records the circuit in `handTuned`, and circadian skips it until a colour is asked for again. Verified: warmth 20 set while off then switched on gives 20 across all five, and a server with no hand-tune memory still gets a consistent circadian 70. The map is in memory, so a restart lets the hour take over again. In cues it fills in only for steps carrying no `tune` of their own, and deliberately is *not* added to the step, so `outstanding()` never treats an ignored colour as a missed step and resends.
- **Left-on advisories** — `trackLit()` records an off→on edge per circuit after each read; `nudgeList()` reports anything past its threshold (AC 4h, fan 8h, light 6h). **It never switches anything off** — the user chose nudge-only, because the house must not kill a room someone is quietly sitting in. Dismissing stores the current `on_since`, so the nudge returns only after the circuit has genuinely been off and on again. `lit_since` is persisted so a restart (or the watchdog) does not reset every timer and hide a real all-nighter.
- **Sleep goes through `applyScene`, because sending once is not enough.** This is the bug that made "Sleep now did not work": fired on ASHU ROOM it sent five circuits and **two of the five stayed on** — the same intermittent batch loss this file already records for cues, which is exactly why cues verify and resend. A cue that drops a lamp is a cue you press again; a sleep timer that drops one leaves it burning all night with nobody awake to notice, so it was the last thing that should have been firing and forgetting. `runSleep()` is shared by the timer and by now, so neither can drift from the other, and the reply says `missed` rather than reporting the number it sent. Re-fired after the fix: 2 sent, 2 off, 0 missed, fan still running.
- **An air conditioner switches itself off** — `POST /api/ac {record_id, off_after}` in minutes, `0` to cancel, and it rides in the *same request* as the power on because they are one intention ("on, and off again in an hour"); two calls can half-fail and leave the machine running with nobody expecting it to. It is accepted on its own too, since deciding twenty minutes later is the normal case. One pending off per unit — asking for a second replaces the first — and switching the AC off through the dashboard cancels it, which is a safety point rather than tidiness: this is infrared, so a stale off fired an hour later lands on whatever the unit is doing then, including one somebody has since started with its own remote. It fires through `acPower()`, shared with the endpoint so the two cannot drift, for the reason in the protocol section above: **a step could not do it at all.**
  **These timers persist across a restart (2026-08-25), reversing the 2026-08-22 decision.** They were originally built to persist, on the argument that `watchdog.sh` restarts the service after two failed health checks and so would evaporate an auto-off at exactly the moment it was doing its job; the user's call then was that it must not have a memory at all. The user asked for it back — *"timer should remain even after a restart"* — so the original argument is the operative one and both kinds are in `state.json` again.

  **Three things make it safe, and each is the answer to a way it can go wrong.**

  **A moment that passed while the process was down is dropped, past a five-minute grace.** The user chose the grace window over always-firing and over never-firing-late. It covers the case that prompted this — a watchdog restart is a fifteen-second outage, so the timer is still in the future and simply resumes — while an outage that spans the moment by half an hour does not fire an `off` into a room that has moved on. That matters most for an air conditioner: infrared is one-way, the hub cannot see the unit, and a late `off` lands on whatever is running then, including one somebody restarted by remote. `TIMER_GRACE_MS` is its own constant rather than borrowing `UNDO_WINDOW_MS`, so changing one cannot silently change the other. A drop says so in the log.

  **`at` is absolute, so a restored timer keeps the moment it was set for** rather than restarting its countdown. Verified on the hub: 2700s before a real `systemctl restart`, 2668s after.

  **The restore waits for the first hub read, and that is not a nicety.** `loadState()` runs before it, and `sleepSteps()` picks its circuits by which ones are *on* — so a due-now timer armed at that point would compute its set from `devices.json` and switch off whatever the file happened to say. `loadState()` only stashes; `restoreTimers()` is called inside the boot chain after the read lands.

  Two smaller traps: `saveState()` lives inside `armTimer()` so every road that arms one persists it without remembering to, and **cancelling has to write too** or the next restart brings it back — which is exactly what happened the last time these were persisted. The restored ids advance `timerSeq` before the drop test, so an id is never reused across a restart.
  **In the UI it is a fourth row on the AC card that exists only while the machine runs**, and it is a `select`: half-hour steps to seven hours is fourteen choices, which is what a dropdown is for — chips were tried at 1H/2H/3H and fourteen of them would be four cramped lines. The wording is the schedules' own `offAfterWord`, so 90 reads as "1.5 hours" in both places rather than in two dialects. **Default is No timer, always** — an auto-off is asked for, never something that happens to a machine because it was switched on. 16px, because under that iOS zooms the page on focus, which this file has now recorded three times.

  **The control shows the duration that was asked for, not the time left**, or it would drift out of the option list within a minute and fall blank on a timer running perfectly well — which is why `minutes` is carried on the timer and through `timerView`. The countdown goes in the caption instead.

  **That a timer is set is said four ways, because one set by accident and never noticed is the failure worth designing out**: the card's own reading carries it (`HUB SENT ON · OFF IN 30M`, so it is visible from the board without opening anything), the caption counts down in the accent colour, the select and its border go armed, and a toast names the unit and the delay. The bar's Sleep button shows the count too, since these share the one list of pending timers — deliberate, being the one place to see and cancel everything, and `DELETE /api/timers/:id` had to learn to `saveState()` for it: without that, cancelling an AC timer there dropped it from memory only and the next restart brought it back.

  The row appears when the unit comes on and goes when it goes off, so the options arrive exactly when they are wanted with nothing to dismiss. The card grows by 46px for it (`.tile.climate.on`) and the body's bottom reservation grows by exactly the same amount: this drawer is absolutely positioned at the foot, so getting that wrong drops the name onto the controls, the trap this file already records for the tunable tiles.

  Proven end to end on ASHU. Switched on at 19:31:55, armed 30 minutes at 19:32:45, reported firing at **20:02:45** — thirty minutes from *arming*, not from switch-on, which is both what anyone means by it and the only honest choice available, an IR unit having no way to say how long it has really been running. A separate one-minute run: on at 19:22 (`channel id 11` in the hub's log), off at 19:24 (`channel id 10`), tile back to `HUB SENT OFF`, row gone, unit left as found.
- **Sleep timers** — `POST /api/timers {minutes, scope}`, cancelled by `DELETE /api/timers/:id`. **`minutes: 0` means now**, and it is the same endpoint on purpose: going to sleep this second is the same act as going to sleep in an hour, minus the waiting, so it shares the scope grammar and — through `runSleep()` — the exact set of circuits, rather than being a second path that can drift. The panel calls it **Sleep now** and it is **held, not tapped** (`holdToFire`, the same 850ms as all-off, which was factored out of `wireQuickOff` rather than copied): it is the one control there that acts immediately instead of promising something later. It sits apart from the row of durations, because reading "now" as one of a list of delays is exactly how it would be pressed by mistake. The bar's own quick durations are 15/30/45/60 — four of them, so a room's bar needs a fifth grid column and `white-space: nowrap` at 9.5px, or "45 MIN" breaks after the number and makes the whole bar two lines tall. The glyph is a **crescent moon**, not a stopwatch: this is about going to bed, not about measuring time. **Cancelling has to be as cheap as setting**: setting one was a tap in the thumb bar, calling it off meant finding the timer sheet — and inside a room on a phone the sheet is not even in the bar. `#timerstop` in the Sleep panel cancels every running timer in one tap.  where scope is `house`, `room:NAME` or `device:ID`; fires through the same `sendSteps()` as a cue. `sleepSteps()` switches off **lights and screens only — the fan and the AC keep running**, because the point is to fall asleep, not to be woken at 2am by a room gone still and warm. A scope naming one `device:ID` is honoured as asked. Proven end to end on ASHU ROOM: fan and foot light on, one-minute timer, light off and fan still running. **They survive a restart (2026-08-25)** — see the persistence note above, including the five-minute grace that stops a timer firing into a house that has moved on.

**`GET /do` is a reference page in a browser and the same JSON everywhere else (2026-08-24).** The JSON was right for the things that call it and a poor way to *learn* it: it listed the action words without saying which circuit takes which, gave slugs with no hint what they are wired to, and said nothing about the endpoints that are not `/do`. So a browser gets a page — the four shapes, every action with what it needs, every room's circuits with what each one is and which actions it will accept, the cues, and a table of the `/api/...` endpoints — and everything else gets exactly the bytes it got before, verified by diffing against a build from before the change.

Four things worth keeping:
- **The Accept test has to insist on an explicit `text/html`.** `req.accepts('html')` matches the `*/*` that curl and Shortcuts send, so it would have served a page to every shortcut in the house. `?json=1` forces the JSON in a browser, which is how you read the shape the command bar consumes.
- **`rooms[].circuits` stays an array of slugs.** `loadGrammar()` fetches this very address and `nextWords()` does `room.circuits.concat(PLAIN_ACTIONS)`, so enriching it in place would have broken the field. The per-circuit detail went into `/do/<room>` instead, which has no consumer.
- **`circuitKind()` and `actionsFor()` read the dispatch rather than restating it.** Any curtain in the target forces the curtain verbs on the *whole* address, and the warmth family is the only other gated set — a bare number is accepted everywhere because on a switch it simply means on. Restating that from memory is how a reference starts lying.
- **A table fits by crushing its widest column, not by overflowing.** At 375px the shapes table gave a 248px address beside a 73px description — one word per line. The floor goes on the columns holding a *sentence* (`td.what { min-width: 210px }`), not on the table: a column of short tokens wraps fine, and forcing every table wider would make each room scroll sideways for nothing. Sections carry `overflow-x: auto` so a table scrolls inside itself and the document never does — measured, since all eleven overflowed before.

**Two traps of the tooling, both mine.** The page is built by string concatenation rather than one template literal, and `deploy/push.sh` extracts every script tag in `server.js` and `node --check`s it — which only works when the source between the tags is nothing but the script, so the page's own JS is kept in its own template literal. Then the *comment* explaining that contained a literal script tag, which the extractor matched on and choked over. **Do not write the tag name in a comment in this file.**

**And building it surfaced three things the API had never said out loud**, each now on the page: a bare number on an air conditioner means *on* and says nothing about degrees, so `/do/ashu/ac/24` is not 24°C; a room's `tv` circuit can be the hub's own `app_type: TV` record rather than the set, and commanding it moves only what the hub believes (the board hides it, `/do` does not); and LIVING's `curtain-rope` is a light while the two motors beside it are curtains, so the kind column is the only way to know which verbs each takes.

**The search field is also a command bar.** `/do` is one word per segment, so what you type maps straight onto it: `ashu cobs 40`, `living off`, `master warmth-70`. `parseCommand()` matches the first word to a room and the last to an action, resolves the middle against that room's circuits on a unique prefix, and offers a row that Enter runs. **Enter deliberately does not clear the field**, so pressing it again repeats the command — which is the whole point of `ashu cobs down`. The grammar itself is fetched once from `GET /do`, so the UI can never drift from what the server accepts. Searching is unchanged; a query that is not a command still just searches.

**Switching several circuits off goes down one socket.** "Turn room off", a room card's key and all-off used to be `on.forEach(d => setDevice(d, false))` — a separate socket per command, all opened at once, which is precisely what this hub drops. Measured on a five-circuit room: the tiles go off, then **every confirmation comes back refused and puts them all back on for about seven seconds** before a later read finds they had landed. `switchOffMany()` sends them through `/api/group` instead — one shared socket, one verdict — with air conditioners still going one at a time, since an IR unit needs its command string rather than a bare record.

**The tiles take whatever room is left above them.** On a wide screen the board is a fixed column that does not scroll with the page, so the header pill, the field heading and every left-on alert come straight out of the tiles' height — four alerts is most of a row. `fitTiles()` measures what is actually left and sets `--tile-h` so two rows still fit, between 104 and 182px — and then, **on the house view only, shrinks further until the whole board is on screen** (floor 78px). Seven rooms with the lit one taking a double square needs three rows on a four-column grid, so the landing page scrolled and Home Theatre and Dining fell off the bottom; a board you have to scroll is not a board you can read at a glance. It shrinks by measurement rather than calculation, because the hero spans two rows, tiles differ in height and the column count comes from `auto-fill`. The hero's `min-height` is derived from `--tile-h` for the same reason — pinned at 340px it made the board unshrinkable. A *room's* board is deliberately left alone: fourteen circuits will never fit, and squeezing them to pretend otherwise would be worse. It has to be *measured* rather than calculated, because an alert is dismissed by removing its row with nothing redrawn — a `ResizeObserver` on `#nudges`, `.field-head`, `.plate` and `#timerrunning` is what notices. The tiles themselves are deliberately not observed, or setting their height would wake the observer again. Measured at 1280×820: 0 alerts → 182px, 4 → 129px, 6 → 104px, and back to 182 when they are dismissed.

**Two things stopped that shrinking from working on a short screen, and both were silent.** `.tile` carried a flat `min-height: 132px`, so winding `--tile-h` below 132 changed nothing — a tablet in landscape (1024×768) still scrolled for the last two rooms however far the loop ran. And the loop was bounded by a **step count** (`i < 10` at 8px a go), so a board starting at the 182px ceiling stopped dead at 102 and never reached the 78px floor it was allowed. The floor is now `min(132px, var(--tile-h))` and the loop is bounded by the floor.

**Below 78px a room card stops being readable, so the chrome gives instead.** `@media (min-width: 861px) and (max-height: 720px)` trims the sentence, the room bars, the gaps and the shell padding — measured at 1024×600, where the board still overflowed by 44px with the tiles already on the floor. And `fitTiles()` adds `.squeezed` to the board below 96px, which drops each room card's "1 of 11 lit" line and keeps the name and the number; that is keyed to the **measured tile height**, not the viewport, because the same 92px tile can come from a short screen or from a houseful of alerts. **The room name must never be the thing that gives** — it has no intrinsic height to defend, so in a squeezed flex column it was the item flexbox crushed to zero, leaving a card showing a percentage with no room attached to it (`flex: 0 0 auto`). All-off on a room card also shortens to `OFF` off the hero, because `ALL OFF` in a four-column board left three letters of the room name. **Stacking the alerts into a deck was tried and rejected (2026-08-14) — they stay a plain list.**

**Frontend** is vanilla DOM inside the `HTML` template literal, sharing a `state.devices` array with the server's projection. Key invariant: `inFlight` holds devices the user is currently touching, and polls must skip them — otherwise a hub read yanks a slider out from under a finger. `paint()` likewise skips a dial that is `document.activeElement`.

**On a wide screen the chrome lifts off the page.** The top bar is a floating pill rather than a strip, rooms leave the sidebar for a second pill pinned along the bottom, and the left column becomes a hero that *says* what the house is doing in display type — "13 lit, across 3 rooms" — instead of reporting it. The room cards are a four-column bento where whichever room carries the most light takes a double square and leads the board; if the house is dark nothing is promoted, since a hero card for an empty room is a lie about where to look. All of it is scoped to `@media (min-width: 861px)`, so the phone layout is untouched by it. The cue list scrolls inside its own column, because it is as long as the user has made it and the room pill is pinned to the window.

**Quality 99 costs almost nothing; 100 costs 3.5×.** Measured on the 4000×6000 source at 3200px: q90 1.65MB, q95 1.78, q97 1.79, **q99 1.90**, q100 6.19. So the library is encoded at 99 — but only from the *original* file. Re-encoding an already-encoded backdrop adds artefacts for +6% size, so the three older ones were left alone rather than run through `sips` a second time. Browser-side uploads match at 3200px / canvas .93 (was 2600 / .82, visibly worse than everything it sat beside in the picker — the page is glass over this picture, so its artefacts are magnified rather than hidden).

**The home-screen icon is generated, not committed as a binary.** `node tools/make-icon.js` writes `data/icon-{180,192,512}.png` — **a house, lit from inside by one downlight**. Five wrong turns got there and all five are worth keeping: a soft amber blob (says "warm light", so does half the App Store, and a gaussian keeps nothing at icon size); four flat opaque squares (legible and unmistakably this app, and completely solid — which is the one thing the interface is not); four *glass* squares, which fixed the material and kept the real problem, **the grid** — a 2×2 reads as a launcher or a folder, the most generic shape on a home screen, and at 60px four small panes are four smudges; and then **one glass pane**, which stood for a week and had two faults of its own. **Its silhouette was the mask's silhouette** — a rounded square drawn inside the rounded square iOS crops to, which reads as a rendering fault rather than as a design, and since the 512 is declared `any maskable` only the middle 80% *circle* is guaranteed, so the pane's four corners were being cut off by the very shape they echoed. And it was **pale light on a pale room**: at 60px there was no dark for the light to be light against, and it vanished on a pale wallpaper. The app's own dark theme already knew that — after seven the pane stays dark and the light comes *out* of it, which is why the icon commits to the dark palette even though the dashboard has two.

So: a cold dark room, a recessed fitting under the roof, the cone it throws, and the pool where that lands. **The house is the room, not a badge** — asked for a home logo, a pentagon laid over the picture would have been a second object competing with the lamp, so the outline *is* the room the light was already in. One polygon SDF gives both the line to draw and the interior to hold the light, so the beam stops at the walls and the pool sits on the floor. Its weight is even and **its brightness is not**: it reads how much light has landed where it passes, fading under the eaves and burning at the feet, because a line of uniform strength is a logo pasted over a photograph. Nothing else is drawn — no door, no windows, no chimney, no type: each of those survives at 512 and is a smudge at 60.

Five things to know if it is ever redrawn. **The beam crosses the house's own colour scale as it falls** — the same three stops, the same 38 pivot and the same `x^0.72` ramp as `lampColour()`, cool white at the fitting through warm white to amber in the pool; the outline reads its colour off that same ramp, so the whole picture is lit by one lamp rather than by three that happen to agree. **The light is summed in linear space** and encoded to sRGB once at the end, because adding glows in gamma space blows the core out and flattens the falloff — the difference between a beam and a white wedge. **The output is dithered** by two thirds of a level, since a dark low-contrast gradient bands visibly in 8 bits, and the noise that removes the banding reads as air. **Keep everything inside the middle 80% circle** (the feet sit at radius .382 of a .40 budget) — that, not taste, is what sets the house's width and how low it stands. And **the pool wants to be narrower than it looks like it should**: run it the width of the cone's base and it stops being a pool and becomes a horizon, which four passes in a row drew. Built using a small hand-written PNG encoder, because the box has no image libraries and an icon nobody can regenerate is worse than one that takes forty lines. `/manifest.webmanifest` and the `apple-touch-icon` link make it installable on both phones, and the manifest's `background_color` is the icon's own night (`#0d131b`) so the splash screen is the same room.

**Redrawing it does not reach the hub through `push.sh`**, which copies `server.js` and nothing else. The generator has no dependencies, so the route is to copy it and run it on the box — regenerating there rather than shipping three PNGs, and `ASSET_V` being a hash of the icon bytes means the new files are their own cache bust for anything that has the app installed:

```bash
scp tools/make-icon.js abneo@192.168.1.3:~/dashboard/tools/
ssh abneo@192.168.1.3 "cd ~/dashboard && /opt/nodejs/bin/node tools/make-icon.js && sudo -n systemctl restart neo-dashboard"
```

The install directory is `~/dashboard` (it is in `deploy/README-DEPLOY.md`; the service is `neo-dashboard`, which is not the directory name and was guessed wrong once). Worth knowing that the PNGs the hub writes are a few hundred bytes different from the Mac's for the same source — same picture, different zlib or a last-place difference in `Math.sin` under the dither — so do not read a size mismatch as a failed copy.

**The phone is read at a glance and steered by thumb.** A card at the top of the field carries the whole house — what is lit said in words, over a row where every room is a column of its own light, height for how much and colour for how warm — and tapping a column goes there, so it summarises and navigates at once. A horizontal drag across the board moves room to room like turning pages; it deliberately ignores gestures that begin on an `input`, `.slider`, `.seg`, `.pull`, `.key` or `.warmth`, or every attempt to dim a lamp would fling you into the next room. `tick_haptic()` ticks when the hub *confirms* — a different feel from the tap that asked — and stutters when a command is refused. **Android honours `navigator.vibrate`; iOS Safari has no vibration API at all, so on an iPhone it is a deliberate no-op.**

**On a phone** the three things done most often live in a fixed **thumb bar** at the bottom (`.quick`: all-off, sleep timer, find) rather than at the top of a page you have to reach across — and because it carries them, the top bar drops its duplicate all-off and search icon on mobile. All-off is *held*, not tapped, in both places. The settings ride as one horizontal rail so they cannot push the house itself below the fold, and `.shell` keeps 104px of bottom padding so the last tile is never trapped under the bar.

Because the frontend is inside a JS template literal: `${...}` interpolates at server start (used for `HUB_IP`), backticks and `\` in the page source must be escaped, and regex literals in page code need doubled backslashes.

## The doorbell tablet, and making the page cheap (2026-08-20)

The wall-mounted doorbell tablet runs `the-house.apk` — a **Capacitor shell whose WebView points at `http://192.168.1.3:3000`** (`android-app/capacitor.config.json`), so it is a window onto the dashboard and nothing more. "Slow on the tablet" is therefore always a question about the page, never about the wrapper. Note the shell only permits its configured origin, so you **cannot** point it at a test server to A/B — Capacitor blocks the navigation silently.

**The emulator is a usable instrument, and it is already set up.** `~/Library/Android/sdk`, one AVD named `house`: **WebView 113.0.5672.136**, `hw.gpu.enabled = no` (software rendering), 412×842 CSS px. That WebView version is the same one the `color-mix(in oklab)` and `mask-composite` notes in this file were measured against. It reaches the real hub on the LAN, and WebView debugging is on, so CDP works:

```bash
adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof com.ashutosh.thehouse)
curl -s http://localhost:9333/json/list          # then drive Runtime.evaluate over the ws
```

Two lessons about measuring it. **`dumpsys gfxinfo` plus `adb shell input swipe` is too noisy to A/B** — identical runs gave 27ms and 133ms medians, because the page state, the SSE pushes and the host load all drift. An in-page `requestAnimationFrame` sampler that scrolls a fixed distance is repeatable to 0.1ms. And **the CSSOM is not a reliable witness through a devtools eval**: it reported zero `.photo` rules parsed and claimed `!important` overrides had no effect, both false. A screenshot settled every question the CSSOM confused.

**The obvious suspect was wrong, and testing it took two minutes.** Killing every `backdrop-filter` made scrolling *worse* — 42ms against 27ms — because the blur is what earns each pane its own cached compositing layer. There are 40 blurred elements on the house view and 65 on a room board, and on WebView 113 they are not what costs. **Do not "optimise" the glass away on a hunch.**

**What was actually wrong: nothing this box served was compressed, and the page was `no-store`.** So the tablet re-downloaded *and re-parsed* 358KB of HTML on every walk-up, and `/api/devices` sent 29KB every time the house moved. Measured: the page 365,794 → 100,564 bytes, `/api/devices` 30,084 → 2,161. The page is a constant built once at startup, so it is gzipped once and tagged over its own bytes; `no-cache` still makes the browser ask every time — a deploy can never be missed — but an unchanged app answers **304 with no body**. It is compressed on first request rather than at load because `HTML` is declared at the foot of the file and touching it earlier is a use-before-initialisation.

**Only `res.json` is wrapped, and that is what keeps it safe.** `/api/stream` writes its own frames with `res.write`, so it cannot be caught by the wrapper and buffered — which is precisely how compression middleware normally breaks server-sent events. Verified still streaming: first byte 11ms, no `Content-Encoding`. Bodies under 1KB are left alone, since a gzip header is bigger than a health check.

**Plain and fast (`.lite` on `<html>`) is the mode for hardware that cannot afford the material, and it is chosen by a media query — never by timing.** `(hover: none) and (min-width: 861px)` is a panel bolted to a wall: a phone has no pointer but is narrow, and anything with a mouse has a real GPU. That is the same combination the refraction and the rim filter already use, so plain mode agrees with the rest of the sheet instead of guessing. Low `navigator.deviceMemory` turns it on too, for a weak phone.

**A frame-timing probe was tried first and got it wrong on the one device it was written for — do not re-add one.** It sampled after `load()` resolved, which is a finished, static board, and an idle page runs at 60fps on anything: it read 16.7ms and declared a panel that visibly drags to be fast. The comment above it said measuring a still screen would prove nothing, which is exactly what it did. Worse, it *stored* that verdict, so the mistake was permanent and the fix had to bump the key to `neo-lite2` to be ignored. Two rules came out of it: **only a person's choice is persisted** — an automatic verdict is recomputed every load, so being wrong costs nothing and needs no clearing — and Settings, or `?lite=1` / `?lite=0`, overrides either way, which on a locked tablet is the only control that can reach it.

Also worth knowing: **`navigator.deviceMemory` is `undefined` on Android WebView 113**, measured on the emulator. So on the doorbell tablet the memory signal never fires and the media query is doing all the work.

What it removes is compositing only — 65 blurred elements to 3 on a room board, the rim's second filter, the two halos, the photograph and the full-screen filter over it, and the animation. Every colour, reading and control stays exactly where it is, and **a lit circuit still glows in its own colour temperature, because that is a gradient in the pane and gradients are free**. Three things worth knowing if it is ever edited:
- **The panes must go opaque as the blur comes off** (`--paper` and `--paper-2` lose their alpha), or the contrast that was being made *inside* each pane is simply lost — this file's oldest rule about glass, applied in reverse.
- **It must not fall back to the painted scene** under `.photo`. That was built for the dark palette this design used to have; under paper ink the hero sentence came out charcoal on charcoal. Plain mode is **one flat pale colour**, which is also the cheapest background there is — no 3200px decode on a tablet with 1GB, no seven-layer gradient stack, no filter recomputed as the board moves.
- **Five rules name their own blur instead of taking `--lens`** (`.scrim`, `.popveil`, `.seeklayer`, `.bgshot .tag`, `.index-sec`), so clearing the token does not reach them and they need naming explicitly. Found by asking the live page which elements still had a filter, not by reading the sheet.

**`fitTiles()` bisects rather than stepping, because every probe forces a full board layout.** It writes `--tile-h` and then reads `scrollHeight`, and that read is a synchronous layout of the whole board — so the old 8px walk from the 182px ceiling cost **fourteen full layouts at 1024×600**, which is the size a doorbell panel actually is, and the device that runs this loop at all is by definition the wide one. Six now, landing on the same height, because the fit is monotonic in tile height: a shorter tile never makes a taller board. Still bounded by the floor and not by a step count — an earlier version was capped at ten steps and so stopped at 102px, never reaching the 78px it was allowed.

**The server side of this is finished; measure the device, not the hub.** From the Mac the hub answers the full compressed page in **25–33ms** and a revalidation in **9–12ms**. Emulator cold-start numbers (TTFB 550–1200ms across identical runs) are NAT and host-load noise and **cannot** be compared across sessions — do not read an improvement or a regression into them. What can be verified deterministically is in the headers: 304 with no body on an unchanged page, `Content-Encoding: gzip`, zero external requests.

**The rim's `brightness(1.5) saturate(1.8)` was gated on width alone.** The refraction directly below it insists on `(hover: hover)` for exactly this reason, and this rule never got the same guard — so a wall tablet in landscape, being over 861px with no pointer, was handed **a second backdrop-filter on every tile, cue, tab and sheet**: the most expensive thing on the page, twice, on the weakest hardware that runs it. A mouse means a real GPU; a touch screen this wide means a panel bolted to a wall.

**The three faces are served from the box** (`data/fonts/`, `GET /fonts/:file`), not from `fonts.googleapis.com`. That was 749ms of blocking fetch on the emulator before text settled, paid again on every walk-up, for an external dependency that on a house network can simply be absent; locally the slowest face is 88ms and the page makes **no external requests at all**. Only `latin` and `latin-ext` are kept — the interface is English, and `unicode-range` means a browser fetches five files and stops. **Hanken Grotesk is a variable font served as one file for both weights** (the 400 and 500 downloads were byte-identical), so it is one file declared with a weight *range*, which saved 54KB of 189KB. Fonts are immutable by filename, so they are held for a year and the service worker precaches the five the page starts with; the route matches the name against a pattern rather than joining a request path.

## Design language

**It has to behave like a thing, not a page.** What separates an app from a web page is almost entirely the hundred milliseconds after a finger lands, and none of it is default. Every control presses down in 60ms and comes back in 240 — the asymmetry is the whole trick, symmetrical motion reads as an animation and asymmetrical motion reads as weight. Boards are *dealt* in, one card every 26ms capped at ten, sliding from the right when you go into a room and from the left when you come back, because that direction is the only thing telling you whether you went deeper or backed out. The sheets come up from the bottom edge on a phone, wear a grab handle, and can be dragged or flicked back down (`sheetDrag()`, past 110px or 0.55px/ms). `touch-action: manipulation` kills the 300ms double-tap wait; `overscroll-behavior: contain` stops a list handing its rubber-band to the page behind. **The strips are driven directly while held** — `.strip.dragging` drops the fill's 300ms width transition, because nothing gives a page away faster than a control the hand can outrun.

**A strip is dragged by hand; the range input inside it is only the value.** The native `input[type=range]` is `pointer-events: none` now and a delegated pointerdown/move/up on `.strip` sets `.value` and dispatches `input`/`change`, so every listener downstream is unchanged. Three things made this necessary. `.strip-hand` sits on `z-index: 2`, *above* the invisible input, and had pointer events — so a drag begun on the handle, which is where a thumb naturally lands, was swallowed by a span: the slider did not move and the gesture fell through to the board behind it. Pointer capture then removes the browser's gesture arbitration, which is the rest of the "not responsive" feeling. And a COB member's rail is the same control rotated a quarter turn, so the drag is read along whichever axis is longer (`rect.height > rect.width`), with zero at the foot — `rotate(-90deg) translateX(-100%)` maps local x=0 to the bottom of the screen.

**The sideways swipe between rooms was removed (2026-08-20).** A board is mostly sliders, and however carefully the gesture excluded them (`input, .slider, .seg, .pull, .key, .warmth` — note it never listed `.strip` or `.strip-hand`) it kept claiming drags meant for a lamp. Being thrown into another room while a light is half set is a far worse failure than a missing shortcut. The say-card's columns and the back button are how you move between rooms. Do not re-add it.

**An outside-click handler must not judge by a node the click may have destroyed (2026-08-22).** The sleep panel closed itself the moment you picked a room in it. `pickScope()` calls `drawScopes()`, which does `host.innerHTML = ''` — so the button you clicked is **detached before the click finishes bubbling**, and the document-level closer asking `timerpop.contains(e.target)` got `false` and read it as a click on the page outside. Measured on the live page: the same button reports `inPanel: true, connected: true` before its own click and `inPanel: false, connected: false` after it. The guard is `if (!e.target.isConnected) return` — a target that has left the document came from something that just re-rendered, which is never the world outside the panel. It shows up on the landing page because that is where the scope list offers every room; inside a room the scope is already the room you are in, so there is nothing to pick. Worth knowing this was the only instance: the health popover rebuilds `#hbrows` on open and on the minute, never from a click inside itself.

**Two things that must stay opaque: sheets and popovers.** Glass is for chrome you look *past*. A panel you read and type into has to be a panel — the cue sheet, the sleep timer and the toast were all still wearing the dark translucent skin from before the paper palette, so a whole room board read straight through a cue's own list of rooms. They are `#fbf7f0` with a real shadow, and the timer gets a veil behind it as well.

**`--base` was referenced in six places and defined in none.** A casualty of the move to paper: every `var(--base)` was invalid and fell back to inherited colour, so the primary button in the cue sheet was ink on ink and a picker's checkmark was drawn in the colour of the box behind it. *Invisible* rather than wrong, which is why it survived a full sweep. There is a token-audit one-liner in the session log; run something like it after any palette change.

**A tile reserves the foot of its face for strips pinned there absolutely.** The gang card and the phone's dimmable tiles stack instead, so that reservation becomes an empty 70px band — which is what made the ceiling card twice the size it needed and one COB taller than the card driving all five. Anything that sets `.controls { position: static }` must also zero `padding-bottom` on `.tile-body`, and needs enough specificity to beat `.tile.dims.tunes .tile-body`.

**A body taken out of absolute positioning must stay *positioned*.** The mobile rules that let a tile's strips stack under its face set `.tile-body { position: static }` — and a static box has no `z-index`, so the body fell *underneath* the positioned `.tile-fill` and every word was read through the tile's own tint. Invisible for months behind a pale amber wash; obvious the instant a television put a blue one there. They are `position: relative; z-index: 2` now, which is identical in flow and keeps the stacking. Third time this family of bug has appeared, so: **any rule that changes a `.tile-body` off `absolute` must say `relative`, never `static`.**

**And the COB member is the exception to that stacking rule, which it lost on specificity.** `.tiles .tile.dims.tunes .tile-body { position: static }` carries one class more than `.tiles .tile.cobmember .tile-body`, so it beat the rule that pins a member's body absolutely beside its two rails. Both symptoms were silent and neither looked like a CSS bug: a `static` body has no `z-index`, so it fell *below* the positioned `.tile-fill` and every word on a lit COB was read through an amber gradient — that is what "the text on the COBs is not black" actually was, not a colour at all; and losing the absolute box meant 82px of rail clearance came out of a 135px in-flow card, leaving 40px for `ON · 70%` to wrap inside. Fixed with `:not(.cobmember)` on the stacking rule rather than by out-specifying it, because the intent is that the rule does not apply.

**Colour temperature names itself.** Nobody has an opinion about 68; everybody has one about candlelight. The warmth strip reads `AMBER · 81`, never a bare number — `warmthWord()` in seven bands (daylight, cool, soft white, neutral, warm white, amber, candle), because four bands over a hundred points leaves the label sitting still for a quarter of the drag.

**The photograph is allowed to be a photograph.** It used to sit under a sheet of cream (`.photo::after`, .42 at the top and never below .14) with `saturate(.86)` over it — which is the exact thing the light-mode attempt proved wrong and this file already recorded: *a white veil over the backdrop is frosting, not glass*. It drained every picture to make ink readable, when the contrast ink needs has to be made **inside the pane**. So the veil is gone (a vignette and a small hold at the two edges where chrome sits is all that remains), saturation is back at 1.04, and `--paper` went .66 → .80 to carry its own contrast. "The only colour is light" is a rule about the **chrome** being neutral — it was never a reason to drain the picture.

**`fitShot()` measures the bright end, not the mean.** A mean was right while the veil covered everything and the only question was overall level. Without it, legibility depends on how bright the *brightest large areas* get — and this photograph is half dark pine, so its mean sat low and the mean rule brightened it to the 1.32 clamp, pushing the limestone and sky **up** exactly where the header and cards sit. It reads the 88th percentile off a 256-bucket histogram and lands it near 196 (clamped .55–1.12), so a dark picture with a small bright sky is left alone rather than lifted. Also worth knowing: `transform: scale(1.30)` on `.photo` was for an older picture with buildings at its edges, and on any other shot it just crops the subject away — it is 1.06 now.

**The backdrop picker lives in the bottom-right corner, not the masthead.** Three thumbnails beside the line that reports the house is a *setting* sitting where a *status* should be. It is one small square of the picture that is showing, at .6 opacity, and the library slides out of it on hover — so the quick swap survives without the row being permanently on screen. It must be a child of `<body>`, **not of the header**: `.plate` carries a `backdrop-filter`, and a backdrop-filter makes an element the containing block for any `position: fixed` descendant, so docked inside it the dock pinned itself to the header's corner instead of the window's.

**The command bar teaches the grammar instead of printing it.** It was bare text under a line of examples clipped mid-word to an ellipsis — a control that looked like a caption. It is a pill now, and `nextWords()` drives three things off the same set: the rest of the word you are part-way through is drawn faintly under the caret (Tab or → takes it, and the `/` badge becomes a `tab` badge when there is something to take), the valid next words appear as chips on the board, and the line under the pill says what Enter will do. Enter runs a command, or — with exactly one search match — switches that one; any other count and it does nothing rather than guess. **Find was a dead button on the phone**: the status line replaced the masthead and took `header.plate { display: none }` with it, but the field lives inside that masthead, so tapping Find switched the board to Search and gave you nothing to type into. `.plate.searching` brings the masthead back carrying the field and nothing else.

**On a phone an individual COB turns its strips on their side.** A tunable circuit spans the row so its two strips are aimable — right once, wrong five times over on a ceiling. A `.cobmember` is a small square with two vertical rails down its right edge and its key moved to the foot of the left column. The rails are **the same horizontal `input[type=range]` rotated a quarter turn**, not a vertical range: `writing-mode` on a range is recent and `appearance: slider-vertical` is deprecated, while a rotation is hit-tested in the element's own coordinates by every engine. A rotated element keeps its *unrotated* box in flow, so each rail is placed absolutely and `--vrail` has to equal the controls' height by hand (104px inside a 132px tile).

**Brightness and colour in one command.** They go down separate channels anyway, so setting both at once costs nothing and gets the thing you actually want — a lamp that comes on at the level *and* the colour you meant, not the level and then, a second later, the colour. `/do/ashu/cobs/40/warm`, `/do/ashu/cobs/40+warm`, or `ashu cobs 40 warm` in the field. Two actions maximum, merged left to right. Two traps: `slug()` turns any run of punctuation into a hyphen, so the `+` has to be **split before slugging** or `40+warm` arrives as the single word `40-warm`; and the field reads the line **back to front** — actions are taken off the end first and whatever is left in the middle is the circuit, which is the only way to tell `ashu cobs 40` from `ashu 40 warm`.

**The phone's thumb bar keeps its shape and changes its fourth button.** All-off, Sleep, Plans, then **Find** on the house view and **Cues** in a room — because what you are looking for could be anywhere, but standing in a room the thing you reach for is a picture of it you already saved. The quick sleep durations used to live here, replacing the other three buttons whenever you were in a room; they are gone, because a fifth column made a duration easier to reach than the room's own cues, and every one of them is in the sleep panel one tap further in.

**Cues are a grid of light in named groups, not a list (2026-08-22).** A column one card per row is fine at four cues and a scrolling errand at fifteen, and the names are a poor index on their own, since a library tends to be variations on one another. Three things replaced it, and each answers a different half of "hard to get to the one I want":

- **The card is the light it makes.** `cuePreview()` was already averaging a cue's brightness and colour temperature to fill a 2px swatch; given the whole card those two numbers turn the library into something read by looking — the dark warm one is the film cue and the bright cool one is the desk cue, whatever either has been named. It borrows `.tile-fill` outright rather than defining its own gradient, so a cue and a circuit glow from one definition and cannot drift apart between the two themes. This is the light-first rule already in this file, applied to the one surface that had been left out of it.
- **Groups come off the steps, never the name.** A name is free text and means whatever somebody typed; the steps are the one part of a cue that cannot lie about where it acts. So: `Recent`, then the room you are standing in, then `Several rooms`, then `One room`. **Only in a room does a room lead** — on the house view no room is the subject, so promoting some cues would be inventing a preference. Every cue appears exactly once; in a grid this small the same card twice reads as two cues.
- **`Recent` is the whole of the personalisation, and it is per browser.** There are no accounts in this house, so the device *is* the person: a phone belongs to one of us and the wall panel belongs to everybody. `localStorage`, deliberately — `settings.json` would make every browser share one history, which is the opposite of what is wanted. Written by `fire()` before the hub is asked, since what somebody reached for is worth remembering whether or not every circuit in it took, and by `runCommand()` too, or typing a cue's name and tapping its card would build two different histories.

**One pooled `One room` group rather than a heading per room, and the reason is worth keeping.** Grouping by every room sounds tidier and measured worse: most rooms own one cue, so it drew a heading above a single card with half an empty row beside it — *more* scrolling than the flat list it replaced. Pooled, the cards sit shoulder to shoulder, sorted by room so they still cluster, and each card's note names its room. That note is the general rule here: **a card says whatever its heading is not saying** — the room where the heading names none, otherwise what the cue does. Saying both is how the old list came to carry a line nobody read.

**Inside a room, that room's cues and nothing else.** The grouped library belongs to the house view, where no room is the subject; offered *inside* one it is mostly a list of other people's rooms, which is the thing that made a cue hard to get to in the first place. A cue counts as this room's if it touches it at all, so one spanning the house appears in both places.

**And on a phone the landing page carries no cues at all (2026-08-22).** It had a shortcut row of the two this device last fired. The user's call is that it goes: standing outside every room the useful cue is a *guess*, and the row was costing a band above the board the app was opened to show — while inside a room it is not a guess, because the room names the cues. So `.index:not(.in-room) #seccues { display: none }` on a phone, and the section stays in a room. Desktop keeps the whole library in its column on both views: it has a column, and the column is not in front of anything.

**Which cost the landing page its only tap to a cue, so the thumb bar went to five there.** All off, Sleep, Plans, **Find and Cues** — the house view is the one place that wants both, since what you are looking for could be anywhere *and* the cue you want should not be a name you have to remember typing. In a room Find gives way and the bar is four, because there the room is the search. Measured at 375px: `1.35fr 1fr 1fr 1fr 1fr` gives 97px to All off and 55px to the rest, nothing wrapping and nothing clipped. This is not the fifth column the sleep durations were refused for — that one put a duration in front of the room's own cues; this one *is* the cues.

The row that remains in a room is three cells — two cues and a door — and the door says what it opens: `All cues` where it opens the library, `More` with a count where it opens the rest of one room. It must not say "all cues" when the sheet behind it holds one room. Editing and creating live in the sheet, so the row carries no pencil and no plus: at 110px a pencil sits on top of the name, and a fourth cell made every card narrower than its own name.

**Three bugs came out of the same root: the node has two homes that now draw different things.** For years both homes drew the same list, so moving the node was enough. It is not any more.
- **`closeCues()` put the node back without redrawing it**, so dismissing the sheet — by the button or by flicking it, both go through `dismissSheet` — left the *whole library* sitting on the house board where a three-cell row belongs.
- **`go()` never redrew the cues either**, so walking into a room kept the previous room's grouping until some unrelated event came round.
- **`go()` never reset the scroll**, so a new board opened at whatever depth the last one was scrolled to — which, with a tall cue section at the foot, landed you at the very bottom of it. Boards are dealt in as a new screen; arriving mid-page reads as a page that failed to change.

**And the field reaches a cue by name** (`movie`, `foc`), which is the second path into a library that is mostly browsed: when you know the name, type it. Tried **after** the room grammar and only on a unique match, so a cue can never shadow `ashu cobs 40` — and `good` matching four cues offers nothing rather than guessing.

**Revealing a control with `display` can silently retype its layout.** The thumb bar's fourth button is Cues in a room and Find on the house view, done with `nav.quick #qcues { display: none }` and `nav.quick.in-room #qcues { display: flex }`. But `.quick button` is `display: grid` — that grid is what stacks each glyph over its word — and an **id selector beats a class**, so the rule that revealed the button also replaced its grid with a flex row, and Cues alone drew its icon *beside* its label. `#qfind` looked right only because nothing ever sets a display on it: it simply inherits the grid. It is `display: grid` in that rule now. The general form is worth keeping: when a rule exists only to show or hide something, it has to name the display the element already had, or it is quietly restyling it.

**A list that moves into a sheet inherits the rail rules made for its other home.** The cue list is one node with two homes, like the schedules list and the search field, and it reads the home it is in (`host.parentElement.id === 'cuebody'`) to decide whether to draw the library or the shortcut row. The trap this records is now historical for cues and still live for the room tabs: the rule that made a rail work — `.tab, .cue { width: auto; flex: 0 0 auto }` — was **unscoped**, so it followed the list into the sheet and shrink-wrapped every card to the width of its own name (116–193px inside a 325px row). It names only `.tab` now, cues being a grid in both homes. Worth keeping the instrument note: the CSSOM was no help, and the answer came from setting an inline width and watching 193px become 325px.

**The thumb bar's held control named the wrong scope for up to five seconds.** `readout()` writes that label and was never called on navigation — only by `load()`, a hub push, and a five-second interval — so standing on the house board it still said "Room off · 9". The *action* was always right, because `allOff()` reads `state.view` when it fires; only the label lied, which on the one destructive control in the bar is the worst place for it. `go()` calls `readout()` now.

**A control that silently ignores a tap is broken, however deliberate the guard.** Sleep now is held rather than tapped — it acts there and then, and shares `holdToFire()` with all-off so there is one implementation of "do not do this by accident" — but labelled just "Sleep now" it looked like a tap, and a tap does nothing at all. It says **Hold · sleep now**, the same idiom as the desktop's "Hold · all off".

**On a phone, search is a mode — not a bar floating over a live board.** A docked field alone was the wrong half of the idea: the board behind it still scrolled and still took taps, the results sat under the keyboard, and there was no way out but emptying the field. `#seeklayer` owns the screen while it is open, as **one flex column — results, then the chips, then the field** — so no offset anywhere is computed by hand. The field is *moved* into the layer (`seekPill`, one node with two homes) rather than positioned over it. Four rules that keep it honest: **the board underneath is never redrawn**, so Done puts you back exactly where you were; **`go()` closes the mode**, or the layer stayed up over the room you had just opened and the thumb bar — hidden while seeking — never came back; **blur must not close it on a phone**, because tapping a chip, scrolling results and dismissing the keyboard all blur the field; and `.plate .seek { display: none }` has to stay **scoped to the masthead**, or it hides the field in the one place it must appear.

**On a phone the command bar docks at the bottom.** Typing at the top of a phone means reaching across the screen to a field the keyboard is about to cover — every search on the device puts the field at the foot. It takes the thumb bar's place (`body.seeking`), the chips stack above it in one scrolling line, and `--kb` comes from `visualViewport`: a fixed element is pinned to the *layout* viewport, which does not shrink for the keyboard, so without it iOS hides the field under the keyboard it just raised. Also needs `top: auto` — the masthead is `sticky; top: 0` on a wide screen, and a fixed box with **both** top and bottom set stretches to fill the window instead of sizing to content (this drew a full-screen white sheet over the page). Under 16px the field makes iOS zoom on focus, so it is 16px there.

**Zoom is off.** A pinch on a board of switches is always an accident. `maximum-scale=1, user-scalable=no` (which iOS honours once installed to the Home Screen, though not in a Safari tab) plus refusing `gesturestart`/`gesturechange`/`gestureend`, which is what actually holds in Safari. `touch-action: manipulation` already handled double-tap.

**All-off and the backdrop picker book-end the foot of the window.** The one destructive control was in the top-right of the masthead — where a masthead should be reporting the house, not offering to switch it off, and where a mis-hit is nearest the things you reach for most. Both are `position: fixed` and therefore both must be children of `<body>`: `.plate` carries a `backdrop-filter`, which makes it the containing block for fixed descendants.

**An input is not the control it sits in.** The search field arrived with the generic input treatment still on it — its own `border-radius` and a white inner lip from `box-shadow` — which drew a second, brighter box around the text inside the pill that is meant to *be* the control. `appearance: none` plus zeroing radius and shadow.

**The colour of on is amber, and it has to contrast.** `--warm`, `--cool` and `--neutral` were sand, haze and oatmeal — correct as *paper* colours and useless as a signal, because a lit tile mixed from them landed within a few levels of the unlit glass beside it. They are `#f2a233`, `#7fb2e0` and `#9fb0bd` now, and a lit pane mixes them at 62–86%. The hue still carries its meaning: a lamp tuned to daylight glows blue and one at candle glows orange, side by side. `--neutral` covers the things that emit nothing (fan, curtain, screen) and is a definite slate rather than a shade of the paper, or a running fan looked exactly like a stopped one.

**A straight cool→warm mix is mud, so `lampColour()` has three stops.** The two ends are near-complementary, so every value in the middle — where most lamps actually sit — came out grey, and a ceiling set to "warm white" rendered as oatmeal. Real light does not pass through grey on its way from daylight to candlelight; it passes through a warm white (`LAMP_MID`). **The neutral point is at 38, not 50**: on this hub 0 is cool and 100 is warm, and every fitting in the house lives in the top half, so a 50 pivot spent most of the useful range on cream. 38 is also where `warmthWord` stops saying "soft white", so the colour and the word turn over together. The ramp is `x^0.72` for the same reason. `roomTint()` weights by **output, not setting** — a lamp at 5% has almost no say in what a room looks like, and letting it vote equally put a room with one dim daylight COB in the middle of the scale, where the colour goes to cream and the card stops reading as lit.

**A dark lamp's warmth strip must stand down.** The *track* carries the whole cool-to-warm scale whatever the lamp is doing, so at full strength a bank of five unlit COBs was a wall of amber — the exact signal that is supposed to mean something is burning (`.tile:not(.on) .warmstrip { opacity: .38 }`).

**On is categorical; how much is a second question.** The first attempt at making a lit circuit obvious scaled every signal — tint, edge, halo — by `--lit` **from zero**, so a room with one lamp at 7%, which is what this house is most evenings, got 0.6% of a tint and read as dark. Brightness is a *modifier* now: each signal starts at a floor you can see across a room and climbs from there, and the fill gradient's first stop is fixed at full tint while the level decides only how far that warmth carries across the face. Two things that were quietly cancelling it out: `.tile.on` mixed its tint into `--paper`, which is **80% opaque**, so most of the tint was lost to the photograph behind — a lit pane is solid now, and that is the point at which a pane stops being a window and becomes a source. And `.tile.on .tile-read { color: var(--soft) }` sat *after* the rule setting it to ink, so the reading silently lost — the same half-live-CSS trap as `--base` and the search field.

**A circuit that is on has to say so, in that word, and look it.** Three things, all asked for at once and all the same complaint. The reading now leads with `ON` whatever the class — a fan said `TURNING` and a lamp said `40%`, both true, neither the thing you are scanning a board for. (`ON · 40% · AMBER` for a dimmable tunable; a compact COB card says just `ON · 40%`, since its rails already show both and the long form wrapped to four lines.) **The air conditioner keeps its hedge** — `HUB SENT ON` — because it is infrared and saying `ON` about a unit the hub cannot hear would be the dashboard inventing a fact. The lit state says itself four ways, all in the lamp's own colour: the pane takes a tint, the edge takes more of it, the card throws a halo, and the reading goes to ink while a dark one stays grey. And **whatever is on sorts first within its kind** — walking into a room the question is never "where is the bed spot", it is "what is burning", and the answer was scattered through fourteen cards in installer order. A stable sort, so each half keeps its order.

**A tile's foot reservation must match the controls that sit there.** `.tile.dims.tunes .tile-body` reserved 70px for 101px of strips (46 + 9 + 46, sitting 12px off the foot), so a tunable card's reading spent its life half-hidden behind the brightness strip. Nobody noticed while it read `45%`; it became obvious the moment it read `ON · 45% · CANDLE`. Now 117px, and 62px for one strip.

**The individual COBs are not optional.** They were hidden on the phone once to keep the board short; that left a room with no way to touch one lamp at all, which is the case the two-control design exists for. The ceiling card gets smaller instead.


**The interface is neutral; the only colour is light.** Chrome — panes, rims, type, sheen, the thumb bar — is a cool near-black and white glass. It used to be espresso and amber, which was the identity of an earlier design and, laid over a cold photograph, read as a tint spread across everything. Warm now means one thing only: a lamp is on and that is its actual colour temperature. A room lit cool glows cool and a room lit warm glows warm, side by side, because that is data rather than decoration.

**The glow is one gradient, never a box.** `.tile-fill` fills the whole face and its stops are driven by a `--fill` custom property, so light rises to the level and fades out. It used to be an element with a `height` plus a separate bloom layered above it, and where the two met there was a seam — a hard horizontal line across a part-lit card. Nothing about that was fixable by softening either layer; the edge was structural, and the fix was to stop having two.

Devices are classed as light / fan / curtain / climate / screen, and each class gets a control shaped like the object — a rocker that throws, a rotor that turns, curtain panels that part, a cold wash, a lit screen — with its own emission colour. Controls are strictly honest about what the hub can do: only genuinely dimmable and tunable lights get sliders. The palette is committed to dark; the whole design rests on devices emitting light.

**The backdrop is a photograph, and it is load-bearing.** `GET /bg.jpg` serves `data/background.jpg` if the file exists; with no file it 404s and `.photo` falls back to a painted scene built from gradients — a window wash, a lamp pool, soft vertical masses — so the page always has structure for the glass to bend and never looks broken. The photo is held `fixed` and pushed well back (`brightness(.62) saturate(.78)`) with a vignette over it, because white type has to stay legible over any picture and the lamps must stay the brightest thing on screen. `data/background.jpg` is git-ignored: it is personal and per-install, but `build-bundle.sh` packs `data/`, so it does ship to the hub.

The photograph in use (2026-08-15) is a Dolomites peak framed by pine branches, re-encoded with `sips -Z 3200 -s formatOptions 99`. Its dark foliage drags the mean luminance down, so `fitShot()` clamps `--shot-dim` at its 1.32 ceiling — worth knowing if it ever reads washed out, since the fix would be to measure the bright end rather than the mean. It replaced a Dolomites morning — blue sky over pine forest and pale limestone, chosen by the user (2026-08-14), replacing an alpenglow shot of the same range. **It is a bright daylight picture on a page whose whole claim is that *the only colour is the light a lamp is making*, so it is pushed back harder than a dusk photograph needed**: `saturate(.46) brightness(.40)`, cropped `center 38%` so the smooth sky and haze sit behind the chrome rather than the high-detail forest. The pale sky still lands where the header does, so the top of the scrim is held hardest (.74), and the fade keeps a .10 floor in the middle rather than reaching transparent, easing through nine stops to avoid a visible band.

**Dark mode (2026-08-21) is a palette, not a second design — and the hub's clock decides when.** Every rule in the sheet was already written against tokens (544 references against 15 hard-coded colours, all of which were tokenised first: `--sheet`, `--field`, `--paper-solid`, `--paper-2-solid`, `--ground`), so `.dark body` swaps values and nothing else moves. It triggers **past 19:00 and until 06:00**, which are the hours `DAY_COLOUR` already turns on rather than a second pair invented for the theme.

**The hub's hour is the authority, not the browser's.** A phone in another timezone, or the Mac abroad, must still show the house as the house is: it is half nine in the hall or it is not, and that is not a property of who is looking. The server sends **minutes since midnight**, not an epoch — an epoch says nothing about which hour it is in Kolkata — and the page counts forward from it. `/api/automations` is already polled once a minute, which is what carries the board across 19:00 while nothing else in the house moves. Only a person's choice is stored, the rule plain mode learned: an hour is recomputed for free, and a stored verdict about what time it is is wrong within the hour. `#setdark` cycles follow-the-house → always on → always off, and `?dark=1/0/auto` reaches a tablet with no console.

**Two things hold in both themes, and one thing genuinely differs.** The contrast is still made *inside* the pane — a dark sheet over the photograph would be frosting exactly as the cream one was — and the only colour is still light: `--warm`, `--cool` and `--neutral` do not move at all, because they are what a lamp is making. The coral goes back up to `#ff6f61`, which is what it was before being darkened to survive on paper.

What differs is **a lit pane, and it cannot be an inversion.** On paper a lit card is pigment: pale amber with dark ink, more pigment the more light the lamp makes. Inverted literally that floods the card with bright amber and puts white ink on it — the worst contrast on the board at exactly the brightness you most want to read. So after seven the pane stays dark and the light comes *out* of it, which is what this file has always said the signal is: the fill, the lit rim and the two halos. Measured across every lit room, the fill's leading stop gives **3.57:1 at 38%, 4.29 at 30%, 4.95 at 24%** on the 12px labels — so it is 24%, the brightest a glow can be and still be read, with the pane keeping its 13% because a card has to read as lit even at low brightness.

Also measured rather than chosen: `--faint` at `#6f7681` is 3.87:1 on an unlit pane and is `#7d848e` (4.70); and **`--paper` is `.86` in dark against `.80` on paper**, because a 72%-opaque dark pane over the *bright* part of the photograph came up far enough that white type on it was the dimmest thing on the board. `SHOT_BRIGHT` is 196 on paper and **88** after seven — legibility runs the other way in the two themes.

**A dark pane is flat now, and the ombre was never the pane (2026-08-21).** The user asked for a single dark background on the tiles rather than a grey-black ombre, and the obvious suspect — `--paper` at `.86` over a photograph — was the smaller half of it. The real cause was `.tile[data-room]::before`, a fixed 104° wash of `rgba(246,239,227,.5)` fading out by 72%: a cream sheen on paper, and after seven a pale film laid diagonally across a dark card. Every unlit room card carried its own diagonal and no two matched, because the angle is fixed while each card sits somewhere different behind it. It is `background: none` in dark, not re-tinted — the ask was one flat colour, and a card is already told apart from the ground by its rim.

Two things worth keeping about it. **It only ever showed on the unlit cards**, since a lit one already mixes its tint into the opaque `--base`, so the dark half of the board was the glassy half — exactly backwards. And **the lit signal is untouched**: that is `.tile-fill`, which has its own dark stops and is what a lit card actually glows with. Verified by asking the page rather than reading the sheet: on a room board, all nine unlit tiles report no gradient at all — no background image, no `::before`, no fill — while the lit ones still report theirs.

`--paper` and `--paper-2` went fully opaque in the same pass (`var(--paper-solid)` / `var(--paper-2-solid)`, the move plain mode already makes). That is the residual: with the wash gone but the pane at `.86`, a card over the bright part of a photograph still showed a faint lighter smudge — measured by injecting the fix into the live hub, which is running a bright backdrop, and looking. Since the backdrop is a swappable library, `.86` cannot promise a flat card for the *next* photograph either. The picture is untouched and still carries the page, the gutters and the header's surround; it is the panes that stopped being windows. **And the blur behind those panes came off with it**, since a `backdrop-filter` under an opaque wall is work nothing can see: 50 blurred elements on the house view fell to **9** at 1280px and 22 to **1** at 375px, with the nine survivors being exactly the ones that need it. It is a per-selector list, **not** a blanket clearing of `--lens`, which was tried first and is wrong — `.plate` sits at `.78` and a room `.tab` has *no background at all*, so the blur alone is what makes it a control, and clearing the token showed sharp photograph through both. Specificity does the work: every one of the 28 rules setting the lens is a bare class or id, so a single `.dark <sel>` beats all of them wherever they sit, media queries included.

Two things about measuring it. Alpha is **viewport-dependent** — `.plate` takes `--paper` on a phone and `--pane` on a wide screen, so it is opaque at 375px and translucent at 1280 — so the list has to hold only what is opaque at *both*. And the audit has to be phrased as **"for every element that is blurred, is its background opaque?"**, never "is anything in my list translucent?": the second phrasing reported the thumb bar as a regression and had it wrongly removed, when on a phone those buttons carry no `backdrop-filter` at all and so had no blur to lose. The gain does **not** reach the doorbell tablet, which is in plain mode with the lens already cleared — which is the only reason this is safe to do at all, since the one measurement this file holds says removing `backdrop-filter` from WebView 113 made scrolling *worse*. No frame number was obtainable here: a hidden automation tab pauses `requestAnimationFrame`.

The general rule this is the third instance of: **a value chosen as a fraction of white cannot be carried into the dark palette by swapping a token, because the token is not what is wrong with it.** The specular lip, the lit border and now this wash.

**Three things that were tuned against paper and did not survive being inverted, all of them edges.** They presented as "the borders are too prominent, and there is a weird halo on mobile":
- **The specular lip is hard-coded white** — `.tile` carries `inset … rgba(255,255,255,.34)`. On paper that is a sheen along the top-left; on a dark pane it is a drawn white line around every card, lit or not. `.08` / `.035` after seven.
- **A lit card's border was 92% of the tint.** Against pale paper that reads as pigment at the edge; against a dark surround it is a bright amber wire. 34%.
- **The halos were three, at .60 and .74 alpha.** Two now, at roughly a fifth. That combination — a solid amber ring plus a near blur strong enough to read as a separate object around the card — is what the halo on mobile was: a room row is the full width of the phone, so neighbouring cards' glows meet. The glow is still the signal; it is light again rather than a ring.
- And `--rim` / `--rim-lit` are softer in dark for the same reason: `.52` white is light catching an edge on paper and a stroke on glass.

The general rule: **anything whose value was chosen as a fraction of white, or as a large fraction of the tint, has to be re-chosen for the dark palette** — those are the declarations a token swap cannot carry, because the token is not what is wrong with them.

**Text colour in dark mode: no literal was wrong, three *derived* colours were.** Every text colour here already goes through a token — there is not one hard-coded `color:` in the sheet — so the failures were all places where the token was overridden or mixed for the paper palette:
- **`.tiles .tile.cobmember { --ink: #000 }` was top level**, not inside the phone block, so it applied at every width. Black on a pale amber COB card is deliberate and right; black on a *dark* amber one measured **1.87:1 on a strip label and 2.94 on the name** — on the most numerous card in the house. It is `--ink-cob` / `--soft-cob` / `--faint-cob` now, stated by each theme: black on paper, the board's own ink after seven. 2.94 → 5.98.
- **`.idline` keeps `--faint`, which is measured against the *unlit* pane.** On a lit one it is 1.89:1. A dimmed ink (`--ink` 62% into the tint) is 4.90.
- **The strip's fill is the one element that is brighter in the dark theme**, since it stands for light. A near-white label on it is 1.76:1 — and it cannot simply go dark, because the label sits at the left and the fill grows from the left, so below about a third it would be dark ink on a near-black track.

**That last one is worth the detail, because tuning one number could not fix it.** The label needs the fill dark; the fill needs to be light enough to be told from the track. Swept together: amber is fine at 52% (label 4.72, boundary 3.15) and nothing else is — a pale candle tint is 2.95:1 against the track at 44% and only 4.07:1 under the label at 52%. **There is no alpha that satisfies both for every lamp colour**, so the two jobs are split: the body of the fill stays dim at 40% (label 5.6–6.5 across every tint) and the level is marked by a **full-strength 2.5px bar at the fill's leading edge** (7.9–10.3 against the track), which carries no text. At 0% the fill has no width so the bar is absent, which is correct.

**And `theme-color` cannot follow a stylesheet.** It paints the browser's own bar and the area behind the notch, and it was `#f3ede3` in both themes — a cream strip above a dark board. It also cannot be a `prefers-color-scheme` variant, because the theme here follows the hub's clock; `applyTheme()` sets the meta tag.

**Two instrument notes.** A general contrast sweep over every text element **over-reports badly here**, because this design paints `.tile-fill` and `.strip-fill` as *siblings* behind the text: walking ancestor backgrounds misses the amber entirely and reported 77 failures at 1.23–1.9:1 for elements that are perfectly legible. Composite the fill explicitly, or measure nothing. And `getComputedStyle` through a devtools eval lied about `.photo` twice — once about its `filter`, once about its `background-color` — both times a screenshot settled it.

**A light version was built and rejected (2026-08-14) — do not re-propose it.** The user asked for light mode, and it was done properly: the signal moved from glow to pigment (a lit tile taking its lamp's colour into the pane), lamp colours darkened to hold on paper, 27 warm-white control washes inverted to ink, the rim re-read as a cast shadow rather than a specular highlight. Then a second pass rebuilt it as true liquid glass — veil off, fill at .15, a `--lens` backdrop-filter making each pane's contrast locally, a refracting rim ring. The user rejected both and asked to return to dark. Two things worth keeping from the attempt: **glass over a high-detail photograph is unreadable however it is tuned** — a lens wants smooth gradients to bend, which is why the crop favours sky over forest — and **a white veil over the backdrop is frosting, not glass**; the contrast a pane needs must be made inside the pane.

**The backdrop is a library, not a file.** `data/backdrops/` holds the photographs and `settings.backdrop` names the one showing; with none named, the original `data/background.jpg` still serves, so an install that never opens the picker behaves exactly as before. `GET /api/backdrops` lists them, `POST /api/backdrops/choose` switches, `POST /api/backdrops/upload` takes one, `DELETE /api/backdrops/:file` removes it. The page drives the picture through a `--shot` custom property rather than a fixed url, and `backdrop_v` rides in the snapshot, so **choosing one repaints every open browser over SSE without a restart**. Uploads are **resized and re-encoded in the browser** before they are sent (canvas, 2600px, q0.82) — the box has no image libraries, which is why the icon and the lens map are hand-rolled PNG encoders, and a 4MB phone photograph would otherwise be pushed to every device that opens the page.

**Each photograph dims itself.** Every backdrop swapped in has needed its own brightness — the fog at .76, the glacier at .56 for the same result — and getting it wrong is what made the page look washed out or dead. `fitShot()` measures the picture's mean luminance off a canvas and sets `--shot-dim` to land it at `SHOT_TARGET` (116, the value the fog was approved at), so any photograph behaves, including one uploaded from a phone thirty seconds earlier. Measured: fog → .76, glacier → .68, a dark Patagonian shot → 1.0 (no dimming at all).

**The photograph and the icons are cached hard, so replacing one needs a bust.** `ASSET_V` is a sha1 of their size and mtime, used both as the service worker's cache name and as `?v=` on `/bg.jpg`. Before this, `/bg.jpg` carried `max-age=86400` and the worker's cache was named `neo-shell-v1` by hand — so a new photograph took a day to reach a browser and never reached an installed app at all. Naming the cache after the bytes makes changing them the bust. Computed once at startup, which is fine because a deploy restarts the service.

**The number in the display type has its own colour, `--accent` (`#ff6f61`, coral).** It used to borrow `--warm`, which is the colour a lamp is making — so "12 lit" was drawn in the same ink as the light itself and the page said two things in one colour. Coral rather than amber, deliberately off the lamp palette: the lamps are warm-yellow and the backdrop is cold, so a yellow accent said the same thing twice, while coral is the complement of a blue-grey photograph and carries at a glance. Used in `.hero .say b` (set italic in the display serif) and the phone's `.glance-say i`, and nowhere else.

**Two faces, each with one job.** `--display` is Instrument Serif and is used only for the hero sentence — the one place the dashboard talks rather than reports. Everything that labels or measures stays in Hanken Grotesk (`--sans`). Both come from Google Fonts, so both fall back to a system stack if the box is offline.

**The glass is an iOS notification, and the blur depends on the photograph.** `--lens` runs a heavy `blur(30px)` now, which was wrong over the pine forest — it destroyed the only thing worth seeing — and is right over fog, where there is no detail to destroy and the material simply takes the colour of the weather behind it. The tint darkens (`brightness(.72)`) rather than lifting, because white type has to sit on a pale picture. **Blur is the transparency control, not the fill**: the fill is nearly the colour of the backdrop, so its alpha moves the composite by about two RGB levels and cannot be seen.

**Glass over a photograph is a different material** from glass over a flat field: *less* blur (22px, not 38) so the picture stays readable through the pane, more saturation, and a genuinely dark tint (`--pane` is now `rgba(28,20,14,.46)`, not a near-transparent warm film) or text sits on whatever the photo happens to be doing.

**A category is a box, and it takes only the columns it needs.** The kinds ran as full-width bands under a label, so a room's one air conditioner claimed a whole row and left three quarters of it empty — three times over at the foot of every room, since Fans, Climate and Screens each hold one or two circuits. `fillRoom()` builds a `.cat` section per kind now and sets `--span` from what it holds: a wide tile counts two columns, a plain one counts one, and a ceiling card counts the whole board (its `grid-column: 1 / -1` spans whatever grid it is given). The inner `.cat-tiles` grid takes that same count, so a wide tile inside a two-column category still spans it exactly. Measured on ASHU ROOM at 1440×900: the board went 1973px to 1420px, and Fans + Climate + Screens (1 + 2 + 1) now share one row — which is what "there's space for the TV beside the climate" was pointing at. Every room checked for clipping, wrapping and overflow; none. On a phone a `.cat` still spans everything, so the reading order there is unchanged.

**A heading laid straight onto the photograph is not a heading.** `.group-label` was 12.5px of `--soft` with a `text-shadow`, which over pale limestone was invisible — and *which picture is showing* must not decide whether a label can be read. `.cat-head` (and the search view's room labels, same rule) is a small mono pill in `--paper-2` with the pane border and `--lens` behind it: it makes its own contrast, exactly as this file already says a pane must. Same argument as the veil: the contrast has to be made *inside* the thing, not borrowed from the backdrop.

**A dimmer's number goes to the corner, the word rides the name, and the wiring address is gone (2026-08-22).** A lit tunable COB card carried three stacked text lines — `COB 1`, `DIMMER #449`, `ON · 70% · AMBER` — squeezed above 101px of strips, and the warmth word was already on its own strip saying `AMBER · 81`. So: the level is a `.tile-num` in the corner in the same `--display` numerals as the ceiling card's `70%` above it, `.headline` puts the name and `ON` on one line, and the reading for a dimmable circuit is that one word and nothing else. `shortState()` existed only to shorten that reading and is gone.

That left two lines, and **the second one has now gone too — `.idline` is removed everywhere.** It was the line coming down on top of the strips on a wide screen, and it was never for the person at the board: this file's own comment beside `tile.title` says the wiring address is for whoever is chasing a circuit rather than whoever is turning on a lamp, which is why it was already in the tooltip *and* already hidden on a phone. Deleting it only made the rule consistent. `idLine()` went with it, being its only caller.

**Removing it moved the name, because `.tile-body` is `justify-content: flex-end`.** The body's text sits just above the strips reserved at its foot — which was right while the wiring address was the bottom line and the name rode above it. Take the address away and the name inherits that slot: measured at **3px of overlap** with the first strip. So above 860px a dimmable card's body is `flex-start`, putting the name at the top beside its level (19px against the number's 13px) with 24px of clear air to the first strip. **Only above 860px**: on a phone the address was already hidden so nothing moved, and the number sits at the card's *top-left* there, which is exactly where the name would have collided with it.

**Worth recording how this was got wrong first.** Asked to remove "the dimmer number that overlaps the sliders", the corner *level* was removed instead — the one number on that card that anybody actually reads, and the one that was not overlapping anything. The lesson is narrow and practical: on a card carrying two numbers, "the number" is ambiguous, and the cheap way to settle it is to say which element is going before cutting it. The level is back, restored by reverting rather than by retyping.

Three things it needs to keep working. The number is absolute, so nothing reserves the corner for it — `.headline` carries `padding-right: 80px`, the same trick as a room card's name ending before its all-off button, and `flex-wrap: wrap` is the safety valve so a long name drops the state to its own line rather than being cut. On a phone a compact COB's corner belongs to the rails, so there the number takes the **top of the left column**, and the name and state stack (`COB 1 · ON` wants ~82px in a 72px face and the name was the shrinkable half — it read `COB…`). And `paintTile` decides the reading from *whether the tile has a number*, not from a class — so anything given a `.tile-num` automatically stops saying its level twice.

**Bento sizes mean something.** A circuit takes the room its controls need — a tunable lamp spans the row so its two sliders are usable, a dimmable one is taller, a plain switch stays a small square. Room cards deliberately stay uniform: making the lit ones wide was tried and a phone screen then held one and a half rooms instead of four.

**Liquid glass, and why it needs the backdrop.** The panes read as glass because of three things together, not the blur alone: a heavy `backdrop-filter` (blur 38 / saturate 142), a **specular rim** — a 1px gradient laid in the border box and masked out of the middle with `mask-composite: exclude`, bright at the top-left and almost gone across the middle — and a backdrop worth bending. That last one is the part that is easy to lose: glass over a flat field shows nothing, so `.spill` carries structured warmth *and* the house's own light (`--glow`, `--lamp`, set from how much is lit and how warm it is). Raising the backdrop too far washes the page out and unlit rooms stop receding — the first attempt at this added `brightness(1.06)` and had to come straight back out.

**The rim is a signal, not a decoration.** Only a lit tile, the room you are in, or a chosen control gets the bright rim (`--rim-lit`); everything else sits at low opacity. That is lifted from the reference, where exactly one row is highlighted and the rest have none, and here it does double duty — it is also how the page says a lamp is on, so the light-first design survives the glass. A lit tile then throws **two** halos, a tight one hugging the pane and a wide one on the page, because a single blur radius never looks like a lamp.

Two CSS traps already hit here: shorthand `padding` on `.tools` silently wiped `.wrap`'s side padding, and a `-100vw` full-bleed trick widened the document into a horizontal scroll. Prefer longhands and a full-width wrapper.

## Working against the live hub

Changing a device physically switches something in someone's home. Prefer a light in `ASHU ROOM` (the user's own room), restore what you changed, and report what you touched. **Check the hour before touching anything** — bedrooms at midnight are not test rigs, and a colour command can bleed onto the main channel and light a room. Read hub state directly for verification rather than trusting the dashboard's own view:

```bash
node -e 'const W=require("ws");const ws=new W("ws://192.168.1.3:8090/bms/1/0/A/",{perMessageDeflate:true,headers:{Host:"192.168.1.3:8090","User-Agent":"Dart/3.10 (dart:io)","Accept-Encoding":"gzip","Cache-Control":"no-cache"}});ws.on("message",m=>{const j=JSON.parse(m);if(j.payload?.type!=="site_config")return;console.log(j.payload.response.devices.filter(d=>d.device_status!=="false").map(d=>d.record_id+" "+d.device_name.trim()+" "+d.device_status).join("\n")||"nothing on");process.exit(0)})'
```

The hub is only reachable from the same LAN; `EHOSTUNREACH` means the machine is off that network, not that the code is broken.

**Do not probe a refusal with a prefix of a real name (2026-08-25).** Testing that
`/api/say` returns refusals rather than acting, `ashu a off` was chosen on the
assumption that a single letter would be ambiguous. In Living it is — "all or ac"
— but **ASHU ROOM has no second `a` circuit, so `a` uniquely prefix-matched the
collective name `all` and switched the whole room off**, at 17:19, in somebody's
bedroom. Restored inside a minute (the fan, record 448, was the only thing on;
found from `data/history/`'s last `snap` entry, which is what that log is for) and
verified against the hub directly.

The lesson is narrow: a refusal probe must use a string that **cannot match
anything** — `widget`, not `a`. The unique-prefix matcher is doing exactly what it
is designed to do, and every room has a different set of names for it to be unique
against, so "this prefix is ambiguous" is a property of one room and not of the
grammar. The general form is the one already in this file about `/do`: an address
that resolves does the thing.

**Do not restore what you did not do (2026-08-25, the user's instruction).** People
are living in the house and switching things on and off while you work, so a
"baseline" recorded two minutes ago is not a fact about the house — it is a fact
about the past. Restoring to it fights the household: on 2026-08-25 a test switched
all eleven Living cobs on, and the tidy-up then switched ten of them off again to
match an earlier reading, which would have put out anything somebody had turned on
in between.

The rule is narrow. **Undo only inside the same action you took**, where you know
the before-state because you just read it and nothing else has intervened — the
cancel slot is exactly this, and it is why it captures immediately before the
write. Past that, **report what you touched and leave it**. A sentence saying "I
switched Living's cobs on and have left them on" is worth more than a restore that
might be wrong, because the person reading it knows what they wanted and you do not.

**And prefer a no-op to begin with.** The good tests in this file are the ones that
changed nothing: a fan already running, a room already dark, a curtain told to
`stop`. Choose those first, and choose the user's own room when something must move.

**A read is not a measurement.** Brightness reads back honestly, so `device_status` can verify a level. Colour does not (see `device_status_tunable` above), so anything about colour has to be counted by eye, and the person at the other end of the conversation is the instrument. When measuring timing this way:
- **Interleave the conditions, never run them in blocks.** Both dashboards poll every 15s and a trial takes seconds, so block-running one gap at a time lets a burst of interference land entirely on one condition — which is how a flat truth acquires a shape. A blocked sweep produced a clean-looking curve with a trough in it that a shuffled re-run did not reproduce.
- **Re-baseline between trials**, so a count is read against a known starting state rather than a mixed one.
- **Restore and verify at the end**, and say what was touched.

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
- **UNBLOCKED — OptiPlex login obtained (2026-08-12).** Reset via GRUB: edited the kernel line to `... rw init=/bin/bash`, `mount -o remount,rw /`, `passwd abneo` (user set + recorded a new password), `usermod -aG sudo abneo` (abneo now has sudo), then `exec /sbin/init` to boot normally. Verified: `sudo whoami` → root, normal boot came up clean, and the **vendor app is intact** — `:8090` (Django), `:22` (ssh), `:21` (ftp) all listening, and `getversion` answers (a localhost curl returns a Django *DisallowedHost* debug page because ALLOWED_HOSTS only lists the `192.168.1.3` host — that's the app *working*, not broken; hit it with `-H "Host: 192.168.1.3:8090"` for clean JSON). **Node:** the system had only Ubuntu's ancient `nodejs` v10.19 (too old; something pre-existing depends on it, so DO NOT replace it). Installed **Node v18.20.4 standalone at `/opt/nodejs`** (untarred the linux-x64 tarball there, `--strip-components=1`), leaving system node untouched. `deploy/install.sh` now auto-detects `/opt/nodejs/bin/node`. Remaining: at home, `ssh abneo@192.168.1.3`, copy the bundle over, run `bash deploy/install.sh`, add cron for the 11pm cue, point phone shortcuts at `192.168.1.3:<port>`. The whole hosting saga (tablet sleep-kills, router/AP dead ends, cloud/WireGuard) is moot now that the always-on box itself hosts it.
- **Remote-host-via-WireGuard avenue (explored, parked mid-decision).** Idea: a free always-on cloud VM (Oracle "Always Free", ARM — our pure-JS app runs on it) runs `server.js` + cron and reaches the hub through a WireGuard tunnel home; gives unattended schedules *and* remote control, no Pi, no OptiPlex login. Home connection has a **public IP (`171.x`, not CGNAT)**, which is good. **Blocker found:** the user's router is a **TP-Link Archer currently in Access Point mode**, where TP-Link disables the VPN/WireGuard server (no NAT/routing in AP mode) — so the tunnel can't terminate on the Archer as-is. Open question to resume on: what device is upstream of the Archer (the real internet gateway holding the `171.x` IP), and can *it* do WireGuard? Options if not: put the Archer back in router mode, or run a WG client on an always-on LAN device (which loops back to needing the OptiPlex login). Router model number was not yet captured.
- **Door tablet — the strongest host lead so far (2026-08-10), parked to resume at the device.** The wall-mounted video-doorbell Android tablet is the best always-on candidate found: always powered, always home, on the LAN, and *already a proven hub client* (the lighting vendor installed their abneo APK on it). Earlier it was dismissed as a locked kiosk with no dev settings — but it turns out to have the **Google Play Store**, so installing software is possible without ADB or a kiosk escape. Route to a host: it needs a Node runtime, so either **Termux + Node** (use the **F-Droid/GitHub** build, not the Play Store one — Termux's own GitHub warns the Play Store version is feature-limited to satisfy Play policy, and the missing piece is almost certainly the package manager's download-and-execute, i.e. `pkg install nodejs` won't work there; the F-Droid build needs enabling "install unknown apps" once, then reuse `server.js` + the `deploy/neo-fire.sh` cron verbatim) or **UserLAnd** (a Debian proot env straight from the Play Store — no sideload, installs Node *inside* the guest via `apt`, which sidesteps the Play policy issue; slightly fiddlier). Key advantage over the iPhone: the tablet is **permanently plugged in**, so Android's Doze background-killing barely applies and a small Node process stays alive — scheduling is actually reliable. Caveat: it also runs the door intercom, so keep our footprint tiny and be ready to pull it if the intercom misbehaves (lower risk than it sounds, since the device is already an automation panel). Next step when resuming: sit at the tablet, pick Termux vs UserLAnd, install Node, run `server.js`, wire cron, make it auto-start after reboot. A Termux-flavoured setup script (the Android analogue of `deploy/install.sh`) is not yet written.
- **Native iOS app — considered, parked.** A native app *could* speak the hub protocol directly (custom WS headers, no `Origin`), unlike the browser PWA which needs `server.js` as a translator. But it cannot do unattended scheduling (iOS background limits), so it does not remove the always-on-host requirement; and once that host runs `server.js`, the existing PWA + Shortcuts already cover phone control. Verdict: an iOS app would be polish, not a solution — revisit only after the host is up.

Security notes (LAN-only, but real): the hub's HTTP API is unauthenticated, FTP (vsftpd) is open on 21, and Django debug mode leaks stack traces to anything on the Wi-Fi.

## The televisions (LG webOS, SSAP — client written and proven 2026-08-20)

Two **LG webOS QNED82BXA** sets, both reachable on the LAN and both controllable. They are *not* on the vendor hub — the hub knows exactly one screen, record 512 `PROJECTOR`, `device_type: IR`. So these are the first devices the dashboard would speak to directly.

| | MAC | Name | Address when last seen |
|---|---|---|---|
| TV 1 | `d0:cd:bf:a0:fc:cb` | Ashu's Room | `192.168.1.8` |
| Harshit | `60:95:f8:1d:11:da` | Harshit Room (QNED82BXA) | `192.168.1.18` |
| Living | `8c:77:79:5f:dc:64` | webOS TV QNED70BLA | `192.168.1.28` |
| Master | `d0:cd:bf:91:00:26` | Master Room (QNED82BXA) | `192.168.1.30` |

**All five are now accounted for, and `60:95:f8:1d:11:da` was Harshit's** — the MAC this file carried as "TV 2, unnamed" and guessed at twice. Switched on, it named itself at the same `192.168.1.18` it had been seen at all along, which is the only identification method that has ever worked here. Two wrong guesses about it are recorded above and below; both were reasoning from MAC ranges rather than asking the set.

| room | driven by | interface | power-on | its other interface |
|---|---|---|---|---|
| Ashu | `d0:cd:bf:a0:fc:cb` | wired | reliable | Wi-Fi `60:95:f8:1d:0e:c8` |
| Master | `d0:cd:bf:91:00:26` | wired | reliable | Wi-Fi `8c:77:79:7c:7a:50` |
| Parent | `60:95:f8:1d:08:ba` | Wi-Fi | unreliable | wired `D0:CD:BF:A0:FC:DC` |
| Harshit | `60:95:f8:1d:11:da` | Wi-Fi | unreliable | wired `D0:CD:BF:A0:FC:D7` |
| Living | `8c:77:79:5f:dc:64` | Wi-Fi | unreliable | — |

The three QNED82BXA sets carry consecutive wired MACs in the same `D0:CD:BF:A0:FC:xx` block, so they came from one batch — which is exactly why guessing between them by MAC kept failing. **Cabling any of the three Wi-Fi sets would make its power-on reliable and orphan its pairing key in the same move**, since keys are filed by MAC; the wired addresses are here so that trade can be made deliberately.

**The Living set is a QNED70BLA, not a QNED82BXA** (added 2026-08-20), and its MAC is outside the `60:95:f8` range the other two share — so **`60:95:f8:1d:11:da` is still unaccounted for**; it is not this set, as had been assumed. It announced itself over SSDP with its model number rather than a room name, so the only way to place it was to switch it on with somebody standing in front of it. LIVING has no hub screen record, so `shadowedByTv()` has nothing to hide. It was also first seen sitting on `com.webos.app.home` where Ashu and Parent were on `com.webos.app.livetv` — but the Master set (a QNED82BXA, the same model as Ashu) reported `home` too, so that is **just what a set happens to be showing**, not a property of the model. A `home` reading is not a launch that failed, on any of them.

**Keys are per-install and the hub keeps its own file, so a set paired from the Mac has to have its key carried over** — and `data/tv-keys.json` must be *merged*, never blindly overwritten, because a key lost is a pairing prompt somebody has to walk to the television to accept. Check the shared entries match before copying.

**The MAC is the identity; the address is not.** Both sets are on DHCP and both moved subnets during the network work below — so `data/tv-keys.json` files pairing keys **under the MAC**, resolved from the ARP table. It was keyed by address first, and a lease renewal silently orphaned a key that had cost somebody a walk to the television to press Accept.

The client is `tools/webos.js` (library) with `tools/tv.js` as its command line. It needs nothing beyond the bundled `ws`.

**A television answers, which nothing else in this house does.** SSAP has real subscriptions — volume, mute, power state, current input, current app all push when they change, *however* they were changed. Proven end to end: subscribed, set volume 14→15→14, and every change came back as a push. This is the first device class here whose reading is a reading and not a belief — unlike the IR air conditioners and unlike `device_status_tunable`. Do not poll it.

**Three things that had to be found by experiment. Each one presents as something other than what it is:**

- **A 2024-era set speaks only `wss` on 3001 and resets a plain `ws` on 3000** — with no HTTP status, so it arrives as a bare `ECONNRESET` and reads like a network fault. Older sets are the other way round, so the client tries secure first and falls back. The certificate is self-signed by the television and cannot be verified; `rejectUnauthorized: false` is not laziness, there is nothing to verify against.
- **LG has blacklisted the public "LG Remote App" certificate** that every open-source client sends: `403 Pairing rejected: blacklisted certificate detected`. It has *not* started requiring a valid one — sending the same manifest with the `signatures` block simply **left out** is accepted and raises the prompt. Four manifest shapes were tried; canonical refused, unsigned passed. **There is no signature in `MANIFEST` on purpose — do not helpfully add one back.**
- **Pairing is a person.** The first connection puts a dialog on the screen and waits for someone to press Accept; the set then returns a client-key good forever, stored in `data/tv-keys.json` (git-ignored — it is a credential, and per-install). The manifest's permission lists are deliberately wider than what is used today, because the set grants exactly what was asked for *at pairing time* and widening it later means making a person accept a second time. `swInfo()` is the one call outside that grant and answers `401`; it is left out of `state()` rather than paid for with a re-pair.

**On is not SSAP.** The network chip dies with the screen, so nothing is listening. Off is `ssap://system/turnOff`; on is a Wake-on-LAN magic packet to the MAC — both sets advertise `WAKEUP: MAC=...;Timeout=60` in their DIAL reply, which is LG saying it supports this, though it still needs "Mobile TV On" enabled on the set.

Coincidence worth knowing so it does not confuse a log: **the TVs' SSAP port is 3000, the same number the dashboard listens on.** Different hosts, no conflict.

**The full power cycle is proven from the hub (2026-08-20, on the Ashu Room set with the user watching).** `off` over SSAP, then a magic packet to bring it back: it answered ping **within five seconds** and reported `state: Active` with its volume preserved. So on and off both work, on one flat network, with no help from anything but `ws` and a UDP socket.

**The television on the board: a small tile, and a panel behind it.** The tile carries only what anyone reaches for — the key and a volume strip — and its face opens a sheet holding the rest: the arrow pad, the set's own app list, and somewhere to paste a YouTube link. The tile's reading deliberately omits the volume, because the strip beside it already shows that; it says `ON · LIVE TV`, and adds `· MUTED` only because a strip cannot show mute. `POST /api/tv/:id` takes `on`, `volume`, `step`, `mute`, `button`, `app` and `youtube`.

**The set serves its own app icons, so none are drawn or guessed** — real brand art, one PNG of about 5KB per app, named in `launchPoints[].icon`. Two reasons the browser cannot load them directly: they sit behind the television's **self-signed certificate on :3001**, and the dashboard is plain http, so it would be mixed content even if the certificate were good. `GET /api/tv/:id/icon/:appId` proxies the bytes with `rejectUnauthorized: false` and caches them **by icon URL, not by app id** — the URL carries a content hash, so an app that updates changes it and the stale bytes fall out of use by themselves. The app list is also kept when the set sleeps, because it changes when somebody installs something rather than when the television goes off; dropping it made every icon in the panel vanish with the screen. Icons are drawn over the app's name rather than alone: about half of these twenty-five are LG's own housekeeping and their icons say nothing.

**The app row is ordered by `TV_APP_ORDER`, by id.** The set's own launcher order puts its housekeeping first — Apps, then LG Channels — so Netflix and YouTube started half off the edge of a scrolling row. The list names the things anyone opens, then the rest of the real services, and LG's furniture keeps whatever order the television gave it (a **stable** sort, so nothing unnamed is reordered arbitrarily). By id rather than title, because titles carry marketing and change with locale, and an id this set lacks is simply skipped — so the same list suits the second television. Chip captions are cut at the first dash or colon (`appLabel`), since "Spotify - Music and Podcasts" wrapped to three lines and said nothing the icon had not; the full name stays in the tooltip.

**The app list is cached in `data/tv-apps.json`, keyed by MAC.** It is re-read from the set on every successful connection, so the file is never the source of truth — only a stand-in for the gap between the process starting and a television next answering. Without it, a set in standby drew a panel with no apps and no icons, which looks broken rather than asleep. It can only remember what it has seen once: a set that has never connected since the file appeared still shows an empty row.

Icon bytes are cached by the URL's **path**, not the whole URL. The path carries a content hash so it identifies the bytes, while the host is the set's address — which moves on DHCP, and a list restored from disk carries whatever address the set had last time. Keying on the path means a television that has moved reuses bytes already fetched, and the request goes to where it lives now (`fetchIcon` rewrites the host from the live address).

**Words on the screen are the one thing a television can do that nothing else here can.** `POST /api/tv/:id {toast}` puts a line on one set; `POST /api/tv/say {message}` puts it on every set that is on, and **names the ones that were off in `missed`** rather than skipping them silently — a message that reached nobody must not look like one that reached everybody. Declared before `/api/tv/:id` so `say` is not read as a set's id. Neither wakes a sleeping television: a toast lasts a few seconds, and switching a screen on to show one nobody asked for is worse than not saying it.

**A television will not serve two dozen HTTPS requests at once, so the icon proxy queues.** Asked for all 23 of one set's icons together — exactly what opening the panel does — it answered **10 and refused 13, inside half a second**: a connection limit, not a timeout, so no amount of patience helped. Requests chain one behind another and identical ones share a single fetch; cold, all 23 then resolve in 1.5s and are cached for good. The page also retries an icon three times before hiding it, because the chips are only rebuilt when the app *list* changes — so one transient failure used to hide that icon for as long as the panel stayed open. This showed on the Parent Room set first because it has fewer cached icons, not because it is on Wi-Fi.

The remote's own glyphs are hand-drawn inline SVG in `ICONS` — 24×24, `currentColor`, 1.7 round, the same hand as the search and power glyphs already on the page. Play is the only filled shape, because a triangle outline reads as a stray arrow at that size. The mute key shows **what the set is doing** (a crossed-out speaker means muted now), with the action in its `aria-label`.

**The television's tile is a bezel around a screen.** Every other tile on the board reports a level; this is the only one that can show *what it is doing*, so it does: a 16:9 dark panel inside the card carrying the running app's own art, straight from the proxy that already serves the remote panel. From across the room you see not only that the set is on but that it is on YouTube. Off, that panel is inert and empty — no glow, no picture, the one dead pane on a lit board, which is exactly what a switched-off television is. The volume is a **26px bar rather than a lamp's 46px slab**, borrowing the shape of a set's own volume overlay, and it carries no label: a lamp needs one to tell brightness from warmth, a television has one bar and the tile already says what it is. The wiring address is dropped too — a set has no channel to chase, and `SCREEN #tv-parent` was our own synthetic id leaking onto the face.

**The screen is sized by `aspect-ratio`, and its card had to be told to be full width.** Sized by flex it collapsed to a 34px letterbox on a phone, where the tile grows to fit its contents and there is no spare height to hand out. Worse, `.tile-body` is a `<button>` — **and a button shrink-wraps to its contents the moment it stops being absolutely positioned**, which is what the mobile rules do. Every other tile got away with that because its name is wide enough to fill the card, but a screen asking for `width: 100%` contributes nothing to an intrinsic width, so the card sized itself to the word "TV" and came out two thirds too narrow. Those rules now say `width: 100%` as well as `position: relative`.

**Its lit state is cool, not amber, and it drifts.** Everything else on the board is a lamp and shows warm light rising through glass; a television makes pictures, so a lit set takes `--cool` and two soft washes cross its face over 21s — far slower than anything else here moves, so it reads as a screen alight rather than as an animation. Off, it is completely inert: the one dead pane on a lit board, which is what a switched-off television is.

**The hub has its own `T.V` record and it is the same set.** Record 517, `device_type: LIP`, `app_type: TV`, ASHU ROOM. Left in, the board carried two tiles called TV in one room — one that reads live and one that can only report what it was last told, with nothing on either face saying which to believe. `shadowedByTv()` hides a hub screen record while a television in the same room is driven directly, matched on room and `app_type` rather than on the id so the second set needs no code. Worth knowing that a name with a dot in it — `T.V` — does not match a search for `tv`, which is why that record was missed for hours.

**`applySnapshot()` merges `status`, `level` and `tune` and nothing else.** It was written for hub circuits, and it *skips the record entirely* when those three match — so a television whose volume or running app had changed was dropped, the page kept the volume it had at load, and Unmute computed from that stale copy and sent Mute a second time. Televisions are merged first, on their own fields, and deliberately skip the settle-time guard: that guard exists because a hub read describes the house seconds ago, whereas a set pushes its own changes as they happen. **Anything added to the device projection that is not `status`/`level`/`tune` has to be merged here explicitly or it will silently never update.**

**A scrim's grid column must be `minmax(0, 1fr)`, not the implicit `auto`.** An `auto` grid column is sized to its item's *max-content*, so a sheet containing anything that scrolls sideways widens the column — and the sheet's own `width: min(540px, 100%)` then resolves that `100%` against the blown-up column instead of the window. The television's app row (25 nowrap buttons behind `overflow-x: auto`) took the sheet to **2956px on a 375px phone** and pushed half the panel off screen. Same family as the `-100vw` full-bleed trick that once widened the whole document. Related: `margin: 0 auto` on a flex item cancels the cross-axis stretch, so the arrow pad shrank to its own min-content until it was given `width: 100%` as well.

**The top-level `permissions` array is the one that is granted; `signed.permissions` is decorative.** Asking the set what it can do (`ssap://api/getServiceList`) returns 16 services — `api audio config externalpq media.controls media.viewer pairing settings system system.launcher system.notifications timer tv user webapp weeCustom` — but several calls answer `401 insufficient permissions`, and every one of them maps to a permission that is present in `MANIFEST.signed.permissions` and **absent from the top-level list**: `listLaunchPoints`/`listApps` want `READ_INSTALLED_APPS`, `getCurrentSWInformation` wants `READ_UPDATE_INFO`, picture settings want `WRITE_SETTINGS`, and the pointer-input socket (the remote-button channel) wants `CONTROL_MOUSE_AND_KEYBOARD`. Widening the top-level list would unlock them — at the cost of **making somebody accept the pairing prompt again**, since a set grants exactly what was asked for at pairing time. Weigh that before adding one.

**What this particular set is:** a 55QNED82BXA. All three HDMI inputs report `connected: false`, so input switching has nothing to switch to. `getChannelList` returns **0 channels** while `getCurrentChannel` answers with channel 110 on `channelModeName: "IP"` — it is watching IPTV rather than an aerial, so there is a current channel but no list to enumerate. Sound output is `tv_speaker` with no dedicated speaker connected.

**A particular YouTube video can be put on the screen, and it is `params.contentTarget` that does it — nothing else.** `ssap://system.launcher/launch` with `{id: 'youtube.leanback.v4', params: {contentTarget: 'https://www.youtube.com/tv?v=<11-char id>'}}`. It works on an app that is already open, so nothing needs closing or bouncing through Live TV first.

**"Opening YouTube always lands on one particular old video" is not ours — closed 2026-08-22.** Worth writing down so nobody re-opens it. The app chip sends `{app: id}` to `/api/tv/:id`, which is `launchApp` → `ssap://system.launcher/launch` with `{ id }` and **no params at all**, so there is nothing on our side that could carry a video. What settled it was the one test the dashboard cannot run: **the set's own remote does exactly the same thing.** So it is YouTube's own resume state — a video left unfinished stays the resume point while everything watched to the end does not — and the fix is in the app (finish it, or drop it from Continue watching), not in any code here.

Two things that went wrong while chasing it, both instrument errors of the kind this file keeps collecting. `mediaId` was read as naming the video (see above; it names a session). And `close` → `launch` with a `contentTarget` played **nothing** on two attempts while a bare launch after a close autoplayed **something** — which looks like it contradicts the `contentTarget` finding above, and does not: those runs were made blind, with nobody watching the screen, so they establish nothing either way. The original finding was made with a person looking. **Do not "correct" a measurement taken with eyes on the screen using one taken without.**

**Four calls answer `returnValue: true` and three of them are wrong**, which cost two evenings:
- **`contentId`** looks like the obvious field and is purely an app launcher — it opens YouTube on its home screen. This was written up here as the answer on the strength of a person saying "it worked", when what had worked was the browser below. **A `true` from this hardware means "accepted", never "it happened"** — the same lesson as `device_status_tunable`, learned again the same way.
- **`system.launcher/open`** with a watch URL opens the television's **web browser**, where the video does play. That false positive is what made the wrong answer look right.
- **DIAL** — `POST http://<tv>:<port>/apps/YouTube` with `v=<id>` — is a flat **403 without an `Origin` header** and a **200 with `Origin: https://www.youtube.com`** (a LAN origin is refused). It then reports the app `running` and still shows the home screen: real casting continues over YouTube's cloud Lounge API, which is not reachable this way. Its endpoint is also on a **per-boot port**, so it would have to be rediscovered by SSDP every time.

**`ssap://com.webos.media/getForegroundAppInfo` is the instrument that settled it, and it is the only honest one on this set.** Empty while an app sits on its own home screen; one entry with `playState` and a **`mediaId` once something is really playing**. That id is a *session* handle, not a content id: it is a fresh opaque string every time playback starts and it does **not** identify the video. So it answers "did a new media session begin", which is exactly what `playYoutube` needs and all it asks; it cannot answer "which video is on". Nothing in our permission grant can. Misreading it as a video id cost a wrong diagnosis on 2026-08-22 — two different ids were read as two different videos when they were two sessions of an unknown one. Everything before it depended on asking a person to look at the screen, which burned several rounds and produced one confidently wrong conclusion. `playYoutube()` reads it either side of the launch and returns **`confirmed`**, and the panel says so when a video does not start — because an accepted launch that shows a home screen used to look identical to one that worked.

`POST /api/tv/:id {youtube}` takes a link in any of the usual shapes or a bare id, and **wakes a sleeping set and waits for it** before launching, because "put this on the television" has to mean it whatever the set is doing.

**The MAC prefix says which interface it is, and therefore whether power-on will work.** Asking the Master set for its own interfaces settled what had only been inferred from prefixes before: its `wiredInfo` MAC is `D0:CD:BF:91:00:26` — the very address ARP knows it by, so it is on **Ethernet** — while its idle Wi-Fi radio is `8C:77:79:7C:7A:50`. So on this hardware:

| prefix | interface | power-on |
|---|---|---|
| `d0:cd:bf` | wired | reliable — woke in under five seconds, twice |
| `60:95:f8`, `8c:77:79` | Wi-Fi | Wake-on-Wireless, the unreliable half |

Which places all five without further guessing — see the table above. Harshit's set then confirmed the rule from the other direction: the MAC we drive it by is its own `wifiInfo`, and its idle wired interface is in the `d0:cd:bf` block, exactly as the rule predicts.

**Control works over Wi-Fi; switching a set *on* effectively wants Ethernet.** `network()` asks the set which interfaces it has, and the MAC that matches what ARP knows is the live one. The Ashu Room set answers `wiredInfo: D0:CD:BF:A0:FC:CB` — the very MAC we drive it by — so **it is on Ethernet, and that is why its power-on is flawless**: wired Wake-on-LAN woke it in under five seconds, twice. Its idle Wi-Fi radio is `60:95:f8:1d:0e:c8`.

Which settles the other two sets: `60:95:f8:1d:11:da` and `60:95:f8:1d:08:ba` sit in that same `60:95:f8` range one or two digits from the Ashu set's *Wi-Fi* MAC, so both are on **Wi-Fi**. That is exactly why a magic packet to `…11:da` woke its radio and not its panel — Wake-on-Wireless-LAN is the unreliable half of this. Everything else (off, volume, apps, the remote, a YouTube link) is indifferent to the medium.

Consequence worth knowing before moving a set to a cable: **keys are filed by MAC, and the MAC changes with the interface.** Plugging a Wi-Fi-paired television into Ethernet orphans its key and costs another pairing prompt. Filing by the set's serial or UUID would fix that if it ever becomes a nuisance.

**Wake-on-LAN does not always wake the panel, and a set can serve SSAP with the screen off.** Measured on `60:95:f8:1d:11:da`: fully dark to begin with (no ping, both ports shut), then after a magic packet it answered ping, accepted TCP, completed the WebSocket handshake **and raised a pairing prompt** — which nobody could accept, because no picture had appeared. So "handshake completes" does not mean "the screen is on", and the only calls that can tell you are `getPowerState` and `getForegroundAppInfo`, both of which need pairing first. Chicken and egg on an unpaired set: the way in is to switch it on with its own remote.

**Report the secure port's error, never the fallback's.** `connect()` tries `wss:3001` then `ws:3000`, and it used to surface whichever failed last — so a set that had raised a prompt and waited ninety seconds for somebody to accept was reported as `ECONNRESET`, which reads like a flat refusal and sent the diagnosis the wrong way. It only falls back now when the secure port never opened at all (`this.spoke`).

**Off comes in two shapes and only one of them looks like it.** A cold set answers nothing — no ping, both ports shut, network chip genuinely down, which is why Wake-on-LAN is the only way back. A set in **standby with its network chip awake** *accepts* TCP on 3000 and 3001 and then never completes the WebSocket handshake; this one does that after a `turnOff` it had been woken into. Both are off. What matters is that **a failed connection is a trustworthy reading of "off"** — unlike every IR device here, a television that is on always answers — so the dashboard reports an unreachable set as off rather than as an error, and both shapes land in the same place. The address is only forgotten after three failures in a row, or a set left off costs a five-second SSDP sweep every retry against a lease that was never wrong.

Worth knowing when it comes back: it boots into whatever it opens by default — `com.webos.app.livetv` here — not into the app that was running when it was switched off. Waking a set does not restore what was on it.

### The house network, and the boundary that hid the televisions (2026-08-20)

Worth keeping because it cost an evening and every symptom pointed somewhere else. The house had **two networks**, and the hub was on the far side of a NAT from everything else:

```
internet ── Airtel AOT5222ZY 192.168.1.1 ──┬── OptiPlex hub 192.168.1.3
                                           └── TP-Link Archer C80
                                                 WAN 192.168.1.31
                                                 LAN 192.168.0.1 ──┬── Mac, phones
                                                                   └── both televisions
```

The Archer was in **Router mode**, NATing `192.168.0.0/24` out of its WAN. So the hub could not reach the televisions and never could — **you cannot route into a NAT from outside**, and no static route on the hub can change that. Three false trails, all worth recognising again:

- *It looks like a missing route.* The hub had internet and the Mac reached the hub, so only one direction was broken. Adding `192.168.0.0/24 via 192.168.1.31` changed nothing, because that address is the Archer's **WAN port**, which drops everything inbound.
- *The MACs give it away.* `192.168.0.1` is `e4:fa:c4:97:7a:df` and `192.168.1.31` is `…:e0` — consecutive, so one device with two interfaces. That is a router straddling both, not two boxes.
- *The decisive evidence was accidental*, and now the tool reports it deliberately: SSDP discovery run from the hub had **both televisions answering from the single address `192.168.1.31`**, which only happens through NAT. `ipconfig getpacket` on the Mac then confirmed the Archer was leasing addresses and naming itself router and DNS — which an access point does not do.

**Resolved by putting the Archer into Access Point mode**, giving one flat `192.168.1.0/24`. AP mode keeps its Wi-Fi — same SSID, same coverage — it only stops it routing, so nothing else in the house noticed beyond taking a new address. Before doing it, `192.168.1.3` was reserved for the hub's MAC `f8:bc:12:a8:5f:8a` on the Airtel router (**Network Setting → LAN → Static DHCP, maximum 8 entries**), because that address is a DHCP lease and everything — every phone's vendor app, the doorbell tablet, Shortcuts, the dashboard — is pinned to it.

Two things this leaves worth knowing: the tailnet was never a path (the hub runs Tailscale at `100.83.127.114` but advertises no routes and has `RouteAll: false`), and reserving the two televisions on that router would be sensible if their addresses moving ever becomes a nuisance — though keying by MAC already makes it harmless.

## Working on this remotely, over Tailscale (2026-08-21)

**The hub is already a tailnet node and always has been: `100.83.127.114`, `abneo`, online.** What was broken was only the *Mac* — `tailscale status` said `Logged out` / `NeedsLogin`, which is the whole reason the tailnet address did not answer. `tailscale login` on the Mac is the entire setup; nothing on the hub needs touching, because `sshd` binds `0.0.0.0:22` and the dashboard binds `*:3000` already. Also on that tailnet: the iPhone, and an Android node named `rk3566-u` — an RK3566 is the usual wall-panel SoC, so that is very likely the doorbell tablet.

**Edit on the Mac, run on the hub. That is the decision the user took (2026-08-21), and the rest of this section is why.** The code has to run where the hardware is; the tunnel's job is to carry SSH and a browser, not device traffic. **The subnet route below was explicitly considered and rejected — do not re-propose it** unless somebody specifically wants a fast local restart loop while working on television code.

```bash
bash deploy/push.sh 100.83.127.114
```

`deploy/push.sh` is the deploy path now, for home as well as away — the two `scp` lines it replaces pinned the LAN address, which is the one thing that cannot work from away. It copies **`server.js` and nothing else** (so the `scenes.json` hazard below cannot arise), runs the backtick audit `node --check` cannot do, verifies the page actually came up, and **rolls back to the previous `server.js` if it did not** — which is what makes deploying from a café reasonable at all, since a broken startup otherwise leaves the house with no dashboard, nobody near the box, and the watchdog restarting the wreck every five minutes. Both paths are tested: forcing the verification to fail rolled back and left the service active on 200.

**The hub's WebSocket ignores the `Host` header, so `ALLOWED_HOSTS` does not gate it.** Worth knowing because it is the opposite of the HTTP API, where a wrong `Host` gets the DisallowedHost debug page this file already records. Tested against the live hub by connecting to `192.168.1.3:8090` while claiming `Host: 100.83.127.114:8090`: handshake fine, full `site_config`, 88 devices — identical to the baseline. So `HUB_IP=100.83.127.114` genuinely works from off-LAN, and a remote dev server can drive every light in the house.

**The televisions are the part that does not simply follow, and it splits three ways.** Saying "TVs will not work over Tailscale" is wrong — most of the surface is ordinary TCP:

| what | transport | crosses a tunnel? |
|---|---|---|
| off, volume, mute, apps, YouTube, toasts, remote buttons | TCP `wss://ip:3001` | **yes** |
| the app-icon proxy | TCP HTTPS to the set | **yes** |
| finding a set's address | SSDP multicast + ARP | no |
| power **on** | Wake-on-LAN, UDP broadcast | no |

So control needs a *route*, and discovery needs replacing. Neither is exotic:

- **The route.** The hub is not a subnet router yet — measured `net.ipv4.ip_forward = 0`. It is `sysctl -w net.ipv4.ip_forward=1` plus `sudo tailscale set --advertise-routes=192.168.1.0/24`, an approval in the admin console, and `--accept-routes` on the Mac. Use `tailscale set`, **not** `tailscale up --reset`, which would clobber the hub's working config. The catch is that accepting `192.168.1.0/24` collides with any café or hotel LAN on that very common prefix.
- **Discovery: `TV_ORACLE`.** `/api/health` already publishes every set's live address, so the hub is an address oracle and `find()` asks it when its own SSDP sweep comes up empty. `TV_ORACLE=http://100.83.127.114:3000 npm start`. It is **half of a setup and useless alone** — an address is only worth having if it is routable, so without the subnet route above it hands back a perfectly correct address that nothing can reach. Since that route was rejected, this is built and inert: it costs nothing where it is not switched on, and it is the half that would be tedious to work out again.
- **Power-on has no fix of this kind.** A magic packet is a broadcast; the hub's `bc_forwarding = 0`, so a directed broadcast to `192.168.1.255` dies there too. `wake(mac, broadcast)` in `tools/webos.js` does take a target address, so unicast is a one-argument change — but it only lands while the router still holds an ARP entry for a *sleeping* set, which is exactly why WoL is a broadcast in the first place. The reliable route is to ask the hub, which is on the LAN: `curl -X POST http://100.83.127.114:3000/api/tv/tv-ashu -d '{"on":true}'`. Note that this last point is what makes the whole subnet-route exercise poor value — once power-on goes through the hub anyway, so should the rest.

**A cold set is invisible to everything, which is worth knowing before diagnosing any of the above.** Measured with all five off: zero answers to an 8s SSDP sweep *from the Mac, on the LAN*, TCP 3001 timing out to all four known addresses, and no ping from either machine. So "SSDP found nothing" is not evidence of a network fault — check whether the house is simply dark first. It also means a cold house yields no addresses to anybody and needs none: power-on is a broadcast to the MAC and wants no address, and the set answers SSDP as soon as it is up.

**And `connected: true` in `/api/health` is not a live reading.** All five sets were cold and silent to ping from both machines while the hub still reported four of them `connected: true` — a TCP socket to a set that has powered off stays open from the sender's side until a write fails. `on` was correctly `false` throughout, so the board was right and only the diagnostic field was stale. Worth remembering, since the point of that field is to tell a broken link from a switched-off set.

## Curtains (solved 2026-08-13)

**A curtain is the one device class that ignores `device_status` entirely — the hub reads the verb out of `opr_param`.** Sending a curtain record with `device_status` set does nothing at all, silently, which is why curtains never worked. From the vendor's own source on the box (`/home/abneo/abneo_controller/BMS_host/`), `operations.py` dispatches `device_type == 'RL'` + `app_type == 'C'` to `curtain_opr.curtain_relay_opr(record, opr_param)`, and that function acts on exactly four strings:

| `opr_param` | Effect |
|---|---|
| `curtain_opr_o` | pulse the `channel_open` relay on |
| `curtain_opr_c` | pulse the `channel_close` relay on |
| `curtain_opr_s` | release **both** relays — stop |
| `curtain_opr_tis` | positional, `is_tis` motors only |

Anything else falls through every branch. Verified on LIVING MAIN CURTAIN (497): open ran it fully open, close-then-stop halted it midway.

Both earlier leads were wrong and are closed: `channel_id_open`/`channel_id_close` is the *device-registration* spelling, never a command; and `tis_motor`/`curtain_opr_tis` needs `is_tis: True`, while **all five curtains here are `is_tis: False`** — two-relay pulse motors with no position to report.

**Stop works mid-travel**, so position is reachable by timing rather than by any positional command: run the motor for a measured fraction of its full travel, then stop. That is the only route to a position slider on this hardware — the hub will never report where a curtain is, so any position we show is dead reckoning and will drift if someone uses a wall switch.

**The lesson worth keeping:** the hub's Python is readable at `/home/abneo/abneo_controller/`. Reading it beats guessing payloads against a controller that answers nothing — this was solved in minutes there after three wrong guesses against the wire.

Full design notes and tiered idea list: `~/.claude/plans/glowing-honking-treehouse.md`.

## Speaking to the house — `/api/say` (2026-08-25)

**`runAddress()` is the executor and `/api/say` does not reimplement it.** A sentence comes in, a sentence goes out; between them the endpoint turns the words into a `/do` address and hands them over, so unique-prefix matching, ambiguity-as-error, the stale-cache re-read before a relative action, the curtain verb path and the refusal to tune an untunable lamp are all inherited rather than restated. Two paths reach it: `speechWords()`, a filler-stripping grammar that resolves two to four words of terse English on the hub for nothing, and the model, which is what reads the Hinglish.

**Every reply is HTTP 200, whatever happened.** Shortcuts' "Get Contents of URL" treats a non-2xx as an error and never reads the body, so a 400 would arrive on the phone as silence — the house sounding broken when it merely misheard. `grabResponse()` is a shim that captures what `runAddress` would have sent, and the verdict rides in `ok` and `spoken`. A shim rather than a refactor, because `runAddress` is the path every shortcut and cron line in this house already goes through.

**Hinglish input is the model's job, not a vocabulary in the code.** The alternative — a hand-written Hindi verb table — fails silently and switches the wrong circuit; the model gets a generated prompt listing every room and what is wired in it, and returns a tool call whose room and circuit are then validated by the same `pick()` that refuses a mistyped URL. So a circuit the model invents is a refusal, not a cheerful success.

### The television gap in `look`, and what it dragged in

**`circuitsOf()` cannot see a television, because a television is not in `devices`.** The sets and the receiver are driven directly, over SSAP and Denon's control port, and live in their own maps. So the first version of `look` answered "Living room mein kya chalu hai" without mentioning the television — which is the worst possible omission, these being *the only things in the house whose state is a genuine reading rather than a belief*. `directlyRead(room)` returns them shaped like circuits (slug, label) so `pick()` works on them unchanged, but carrying their own link and their own sentence, since neither the level arithmetic nor the wording in `readingOf()` applies to a screen.

**The hub keeps a stale record of a television it can no longer speak for**, and a spoken answer must not read both out. Record 517 "T.V" in ASHU ROOM is the same set now driven over SSAP; the board already hides it (`shadowedByTv`) because two tiles called TV in one room can disagree with nothing on the face saying which to believe. `liveCircuits()` applies the same filter for the reading path. It is **not** applied inside `circuitsOf()`, because `/do` still addresses 517 deliberately — the filter belongs to the reader, not the address grammar.

**Commanding a screen had to come with it, or the feature would lie.** Once `look` can say the television is on, "TV band karo" is the next sentence anybody says — and without `screenCommand()` it resolves to the shadowed record, moves a row in the hub's database, and answers "Done" while the set plays on. A confident lie is the one outcome worth spending code to avoid. Only the verbs both link classes already implement (on, off, toggle, a volume, up, down, mute, unmute); apps, sources and YouTube stay on `/api/tv` and `/api/avr`, where a request has somewhere to put a name. The check sits in `/api/say`'s `run()`, which is the one point both the grammar path and the model path pass through.

The two classes differ in what they hand back and the code respects it: a `TvLink` method already returns `{ok, spoken}` (written for `/do` and Siri), while an `AvrLink` method returns a bare promise and **rejects** when nothing is listening — so the receiver's reply is built here with the same `avrSettle` and `avrSpoken` that `/api/avr` uses. Waiting for the unit to confirm rather than for a fixed interval is the whole reason its answers can be called readings.

**Eleven clauses is not an answer.** Read one circuit at a time, Living came back as eleven consecutive "Cob 3 is on" clauses — about fifteen seconds of speech, and nobody is still listening by the fourth. Where a whole group is on at one level the group's own label says it: *"the COBs are on"*. Only groups whose label is already a plural noun phrase, because `readingOf()` puts a plural verb after a multi-record group and `all` is labelled "everything" — which would come out as "everything are on". Largest group first, so eleven cobs fold into `the lights` rather than being said twice, and three is the floor: folding a pair loses both names to save no time at all.

### Replies in Hinglish were built, tested against the phone and removed — do not re-propose

The whole rewriter existed and worked: sixteen fixed sentences, twenty-five
whole-sentence rules, fourteen clause rules, gender-free throughout, behind
`config.reply_language`. **iOS `Speak Text` cannot say it.** The user tested it on
the phone and that was the end of it — the endpoint's entire value is that a
sentence comes back *spoken*, so a reply the voice mangles is worth less than a
plainer one it reads cleanly. Removed rather than left behind a flag, which is
what was done with light mode for the same reason: dead rules nobody will ever
switch on are a maintenance cost pretending to be an option. `SAY_LANG` and
`config.reply_language` went with it.

**Hinglish input is untouched and is still the expected case.** The asymmetry is
the point: the speaker reads Hinglish perfectly and the phone does not speak it,
so the two halves of the conversation are not in the same language, and there is
no reason they should be.

### The reply is reworded for the voice, at the same one boundary

`speakable()` replaced `hinglish()` at exactly the same seam — the `say()` wrapper
in `/api/say`, with the original kept as `said`. That the swap was a swap rather
than a rewrite is the argument for having put the translation in one place to
begin with: `spokenFor`, `readingOf` and `/do` never moved, and every cron line
and shortcut in the house still gets the words it was written against.

Four things measured against the voice rather than guessed, each of them
something it does badly otherwise:

- **A verb.** "Foot light in Ashu Room off" is a caption; read aloud it is three
  unrelated words. Confirmations get one, and agreement is decided once in `be()`
  from the *label* — `spokenFor` says "the lights" for a group of one, so "the
  lights is now on" is what counting records would have produced.
- **Lower case for an acronym meant as a word.** iOS spells a capitalised one out,
  so "the COBs" arrives as "the C O B s". `AC`, `TV` and `LED` are *wanted*
  spelled and stay upper case — and are **lifted** when they arrive lower case
  from a slug, since "ac" is read as "ack".
- **No em dash.** It reads as a pause of unguessable length, and what hangs off one
  in these sentences was always their wordiest half. Two short sentences instead.
- **Contractions**, which is the difference between speech and a manual.

**The same guard as before, for the same reason.** A reading can end in "at 40%"
or "muted" exactly as a confirmation does, so `SPEAK_READING` keeps readings away
from the whole-sentence rules — without it, "Reading Light is at 40%" becomes
"Reading Light is **is now** at 40%". This is the second transform to need that
gate, so treat it as a property of the shape rather than a quirk of one table.

**The receiver had to answer to "receiver".** The reply calls it one and the
record is named `AVR`; a device named one thing and spoken about as another has a
name nobody can guess. One alias in `screenCommand`.

`tools/say-speech-review.js` (was `hinglish-review.js`) prints all ninety
sentences and asserts the mechanical half: no em dash, no acronym the voice will
spell, a plural subject with a plural verb, a verb at all, and a closing stop.
Its two deliberate non-sentences — the whole-house list and a bare "Done." — are
named rather than allowed to weaken the check.

### The family guide is generated, never written by hand

`tools/make-guide.js` writes `data/speaking-to-the-house.html`: one
self-contained page for the people who live here, listing every circuit in every
room with what each can actually do. It reads a **running server** rather than
`devices.json`, because `/do/<room>` already resolves kind and permitted actions
from the dispatch — a second derivation is how a guide starts quietly lying, and
the whole point of it is that nobody has to guess between "foot light" and
"footlight".

Three decisions worth keeping. It **drops the hub's shadowed television record**,
which `/do` still addresses deliberately — offering it to somebody who cannot know
the difference is the one thing the page must not do, since commanding it moves a
database row, answers as though it worked, and the set plays on. It **folds
numbered siblings** (`cob 1 to cob 11`), the same reasoning as folding them in a
spoken answer. And its per-room honesty falls out of reading the live house:
HOME THEATRE's AC shows no infrared hedge because record 496 really is a relay,
while the other six carry it.

**The register follows the medium, and the page was rebuilt once to get it
right.** It shipped wholly in Hinglish, on the reasoning that Hinglish is what
gets spoken. The user's correction: *"Keep description an instruction as english,
only phrases, example, use cases in hinglish"* — and that is the better rule,
because an explanation is *read* and reads better in one language, while a phrase
is *said* and has to be exactly the thing you say. A reply is a third case again:
it is spoken by a phone that cannot say Hinglish, so it is English. Three media,
three answers, none of them a house style.

That split is now visible in the design rather than left to the reader: a thing to
say out loud is a **filled speech bubble**, a circuit name is an **outlined chip**.
One is a whole utterance, the other a word inside one, and they must never look
interchangeable.

Three things stay English inside the Hinglish phrases, each load-bearing: every
room and circuit name (the installer's labels, the only names the hub knows — the
page's loudest line is that *pankha* fails and *fan* works), the troubleshooting
table's left column (the exact English the phone says, which they have to match),
and the action words, which are the free grammar path.

**Every room is collapsed behind a `<details>`**, after the user said the page was
too long to scroll. The tension is real — a reference must not drop a name,
because a missing name is a name somebody has to guess — and `<details>` resolves
it without compromise: everything is still there, it just opens at a tap, natively,
with no script on the page. Seven stacked tables became seven rows. The per-room
hue is not decoration either: the family find their own room by its colour before
they read the word.

**Every example phrase in it was run against the live house before shipping**, and
that is the standard for this page: it must not teach a sentence nobody has seen
work. Fourteen of them, chosen so all but two were no-ops against the house as it
stood — the fan already on, the lights already off. The two that had to move
something were done on ASHU in daylight and restored, and the curtain shape was
proven with `rok do` (stop), which releases both relays and so cannot move a motor
in an occupied room. Testing is what found the one wording gap: saying `warm`
answers *"set to candle"*, because `warmthName` names the band rather than echoing
the word — correct, and confusing enough to need a line in the guide.

The `html-authoring` skill is mostly inapplicable here — it targets Snowflake's
sandboxed report renderer, so its `/libs/` paths would 404 in Safari and its
provenance block means nothing to a family guide. What transfers and was kept:
zero network requests (it is opened from Messages, possibly offline),
`color-scheme: light dark` with `light-dark()`, a fluid container, and every table
wrapped in `overflow-x: auto` so a table scrolls rather than the page.


### Two bugs the live house found, one of them serious (2026-08-25)

**Asking whether the fan was on switched it on.** `speechWords()` strips `is` and `the` as filler, so *"is the ashu fan on"* reduced to `[ashu, fan, on]` — an impeccable command, and the free grammar path ran it before the model ever saw the sentence. The same stripping turned *"what is on"* into a command addressed to a room called `what`, answered with "I do not know that room" while `SHORTCUTS.md` promised it worked. Both were found by typing documented examples at the live hub, not by reading the code.

**The fix is a gate, not a cleverer grammar.** `SAY_ASKS` is tested before anything else in `speechWords` and returns null on a question mark, an interrogative opening in either language, or the Hinglish shapes that ask without one (`chal raha`, `chalu hai`, `band hai`, `on hai`, `batao`). The grammar matches three words against an address and an address has no mood, so it cannot be taught the difference — questions are kept away from it instead. **It is deliberately generous**, because the two mistakes are not comparable: a command mistaken for a question goes to the model and still comes back right for a fraction of a paisa, while a question mistaken for a command switches something on in a room somebody is sitting in.

**"netflix laga do" switched the television on and said nothing about Netflix.** The prompt told the model that apps are not wired and to say so; handed a named app it reached for the nearest tool it had and called `control … on`. The reply — *"ashu tv on ho raha hai"* — was true and useless, which is the exact confident-lie shape `screenCommand` exists to prevent. Fixed in the prompt by naming the failure rather than only the capability: *do not call a tool at all, and in particular do not switch the screen on instead — coming on without the app is not what was asked, and the reply would not say so.* Three phrasings now decline. Worth remembering as a general rule for this prompt: **stating what a tool cannot do is not the same as forbidding the plausible substitute**, and the model will find the substitute.

### Cancel — one step back, per speaker (2026-08-25)

*"can you add a cancel command to undo the last spoken command?"* An undo already
existed and **only cues used it**: `undoable`, one global slot, replayed through
`applyScene`. The work was to capture at the spoken paths, add a phrase gate, and
keep the honesty straight where the hardware cannot support a real undo.

**Per speaker, not per house**, because several people talk to this place. A
shared slot means your "cancel" reverses whatever somebody *else* said last,
which is a worse failure than having no cancel — so `spokenBack` is a Map keyed
on `who` from the request body, bounded at 8 because that is user input, and LRU
by delete-then-set (a Map keeps a key at its original position when overwritten,
so without the delete the person who speaks most often is evicted first). A
shortcut that sends no `who` gets the anonymous slot and still works.

**`/do` deliberately leaves no cancel point.** `runAddress` and `screenCommand`
take an optional `remember` callback and only `/api/say` passes one. A cron line
firing at 07:15 is not something anybody is about to say "cancel" at, and
capturing for it would cost every one of those a hub read.

**Capture needs a fresh reading, and that is the same rule `fireCue` already
had.** `runAddress` re-read the hub only for relative actions (`toggle`, `up`);
that condition now also fires when `remember` is present. Undoing to a reading
that was already stale puts the room somewhere it never was.

**Where the hardware cannot support an undo, the reply says so** — the three
decisions the user made, and each is a limit rather than a shortfall:

| | what it does | why |
|---|---|---|
| curtains | reverses the verb, and states that it is *not exactly where it was* | no position is ever reported, so "put back" would be a claim it cannot support |
| screens | volume and mute only, exactly | those are read off the set. Power is refused **with the reason**: switching a television back on lands on the home screen, not on what was playing, so a "cancel" would interrupt you a second time |
| everything else | snapshot replayed through `applyScene` | brings verify-and-resend with it |

The screen-power case is stored as its own `screen-power` marker rather than not
stored at all, purely so cancel can explain *why* instead of claiming nothing was
said.

**Two wording bugs that only a live run finds, and one that mechanical checks
missed by design.** *"Ashu TV is back at volume 12"* came out as **"is back is at
volume 12"**: my sentence ended in the exact shape `SPEAK_WHOLE` reads as a screen
being *set* to a volume, so it inserted a second verb. The reply was reworded to
*"Ashu TV volume is back to 12"* and `say-speech-review.js` gained a check for a
verb re-inserted with one word wedged in the middle. And plural agreement has two
halves — fixing only the verb gives *"the cobs are back as it was"*.

**`applyScene`'s residual miss count is not safe to say out loud.** A dimmable
light *fades*, and a fade still in flight reads as a level that is not the one
asked for — measured live, one cancel in four claimed three lamps had missed when
a moment later all five sat at zero. In JSON on a dashboard that is a curiosity;
spoken aloud it cries wolf, and a reply nobody believes is worse than a shorter
one. So a non-zero count is re-checked after one more settle before it is spoken,
which costs nothing in the ordinary case because the ordinary case is zero. **The
spoken cue reply has the same flaw and still carries it** (*"set, but 2 did not
take"*) — left alone as out of scope, worth fixing if it is ever heard.

**The gate is matched before the grammar and long before the model**, so cancel
costs no network call, and it cannot shadow an address because nothing in this
house is named any of these words. `nahi` must be **doubled**: "nahi, fan band
karo" is a command with a correction in front of it, and swallowing it would be
the worst kind of bug — one that eats a sentence and answers as though it acted.

**Verified live**, on ASHU in the evening with the house restored afterwards:
a real reversal (cobs 40 → 0), per-phone isolation (mum's cancel refused ashu's
command), a refusal not clobbering the slot, cancel not becoming a new cancel
point, the curtain-`stop` refusal, and `/do` still leaving nothing behind. **Not
tested live and said so at the time:** an actual curtain reversal (it moves a
motor in an occupied room), screen volume (every set was off), and the five-minute
expiry — verified by reading only. A local instance on `PORT=3100` loads no
schedules, which makes it the safe way to test this.

**A caution repeated from earlier the same day**: a test phrase is not a probe.
`ashu fan on` during this work switched his fan on and I briefly attributed it to
the user before tracing it to my own leftover slot. Read the history before
blaming the household.

### pankha and parda, resolved by kind (2026-08-25)

*"parda and pankha won't work. Can we change that so that works too? Only these
two for now."* Two words, and the interesting part is that the obvious
implementation is the dangerous one.

**A synonym table would have switched on a light.** `parda` aliased to the word
"curtain" is matched by `pick()` as a prefix, and in LIVING the only circuit
*starting* with that word is **CURTAIN ROPE, which is `app_type` L** — a light
sitting between two motors that are not. This file already recorded that trap for
the schedule picker; it is the same one. So `hindiCircuits()` selects on **kind**:
`app_type === 'C'` for a curtain, and the fan test `circuitsOf()` already uses
(override first, because this hub's own `isFan` flag reads false for all four real
fans). Which gives the three honest outcomes rather than one lucky one — one match
works, two ask which, none says so.

`every` rather than `some` on a circuit's records, or the collective `all` — which
holds the fan among ten other things — would qualify as "the fan".

**Only these two, and that is a rule rather than a starting point.** A table of
Hindi nouns is a table of guesses, and a guess that happens to resolve switches
something on in a room somebody is sitting in. The user drew the same line
unprompted (*"we can skip batti"*).

**The model translates them itself, by name, and that had to be stopped — found
by testing, after it had already acted.** With the grammar path guarded and the
model path not, on the live house: *"Ashu ka parda khol do"* returned circuit
`curtain-rope` and **switched a light on in his room**, and *"Living ka parda khol
do"* picked one of the two curtains and **opened it at 19:15** instead of asking
which. Both restored — the curtain by the cancel feature built an hour earlier,
which is the first time that has been used in anger and is exactly what it is for,
though a curtain's prior position is unknowable and I said so.

The fix is that where the *sentence* carries one of the two words, the model's
choice of circuit is **discarded** and the word is passed through, so
`hindiCircuits()` is the single authority on every road — grammar, model, `/do`,
and `houseReading`. The general lesson is the one already in this file about the
prompt: **guarding the path you were thinking about is not guarding the feature**,
and the model will translate a noun for you whether or not you asked it to.

**A pre-existing bug fell out of it.** `/api/say` computed `ok: out.code < 400`,
so a **300 ambiguity was reported as success** — which is why *"ashu cob 1 on"*
earlier answered `ok: true` with "I can't find that": the ambiguous and
not-found branches share one sentence, and only the status code told them apart.
It is `< 300` now. Worth knowing a Shortcut branching on `ok` would have taken the
success path on a refusal.

### The guide's design follows the dashboard, and the rainbow was a mistake (2026-08-25)

*"I like call outs and playful design. But I would like if those elements and
general design looks similar to existing dashboard vibe."*

**The eight per-room hues had to go, and the reason is in this file.** The
dashboard's rule is *the interface is neutral; the only colour is light* — so
seven arbitrary room colours were speaking its language and saying something
untrue with it, and a room card there is deliberately uniform. Recognition comes
from the name and the count instead.

What replaced it is the dashboard's own vocabulary, token for token: `--ink`,
`--soft`, `--faint`, `--paper`, `--rim`, `--lip`, `--accent`, `--warm`; the paper
palette with the dark one after dark; a pane with the rim and the specular lip;
the mono `.cat-head` pill for a heading that makes its own contrast; the callouts
shaped like the left-on advisories, amber edge and warm ground; one line of
display serif with the one coral phrase, as the hero does; and the 60ms-down,
240-back press that this file calls the whole trick.

Two things it cannot inherit. **The display face is a system serif**, because
Instrument Serif is served from the hub and this page must make no network request
at all. And **the theme follows the phone rather than the hub's clock** — the
dashboard reads the hour off the hub precisely so a phone in another timezone
still shows the house as the house is, and a file opened from Messages has no hub
to ask.

### Hearing it, rather than being told what was said (2026-08-25)

*"I dont find iphone's diction to accurately recogonise hinglish speech or indian
accent, any alternative with my open ai api?"* `POST /api/hear` takes the audio,
transcribes it on the hub and feeds the words into the existing pipeline. The
Shortcut is Record Audio → this → Speak Text, and the key still never leaves the
box.

**The failure was script, not accuracy, and that is the finding worth keeping.**
Asked cold, every transcriber tested returned Devanagari or Urdu — *"आशू रूम का फैन
चालू करो"* is a perfect transcript and completely useless here, because the grammar
matches `ashu` against a room slug. Romanised Latin has to be demanded in the
prompt. It is asked for there rather than through the `language` parameter, which
names the language and not the alphabet: `hi` pushes toward Devanagari and `en`
toward dropping the Hindi words altogether.

**The vocabulary hint is worth more than the model choice**, and it is the thing
on-device dictation can never do — iOS has no way to be told this house contains a
cob, an Ashu or a parda. Measured on synthesised Indian-accented Hinglish, five
commands, word recall:

| | cold | with the house's names |
|---|---|---|
| `gpt-4o-mini-transcribe` | 7/30 | 13/30 |
| `whisper-1` | 12/30 | 22/30 |
| **`gpt-4o-transcribe`** | 4/30 | **25/30** |

**Spoken numbers must be asked for as digits.** Without that line "forty" came back
as **41** — a silent, plausible, wrong answer, which is the worst shape available.
With it, `chalees` and `sattar` arrive as 40 and 70. It is a bias and not a
guarantee: the same clip returned "sattar" on a later run and the model absorbed
it, which is the arrangement working as intended rather than a failure.

**The prompt is generated from the live house**, like the family guide and for the
same reason: a second copy of the room names is a second thing to drift. Cached for
a minute, because it walks every device and a held button can fire repeatedly.

**`answerSaid()` is now the one entry point** and `/api/say` is a four-line route on
top of it. That refactor is the point rather than tidiness: the grammar, the cancel
gate, the two Hindi nouns and the speech pass must not come to mean something
different depending on how the words arrived.

Four things worth knowing:

- **The audio is the raw request body, not a multipart form.** Shortcuts can send a
  file that way, and it saves this project a multipart parser and a dependency —
  `express.raw` is already there. Node 18 on the hub has `fetch`, `FormData` and
  `Blob` but **no global `File`**, so the upload to OpenAI uses a `Blob` with an
  explicit filename; OpenAI reads the extension, so that name is load-bearing.
- **`input: 'voice'`, never `via`.** `via` names the road the words took once they
  were words, and overwriting it hid the one measurement this endpoint exists for —
  a better transcript is one that lands on the free grammar path more often.
  Verified live: `ashu cobs sattar warm` → `via=model`, a clean `ashu cobs 40 warm`
  → grammar, and `cancel` → `via=cancel`.
- **`who` is a query parameter here**, because the body is the audio.
- **`gpt-4o-audio-preview` is not available on this key**, so the better
  architecture — one call, audio in, tool call out, no transcription step at all —
  is closed for now. Re-check it before building anything more elaborate.

**Tested end to end against the live house** with synthesised clips: a question
answered from a real reading, a Hinglish command that was a no-op by design, and a
spoken *cancel* that restored Ashu's cobs to 100% at tune 63 after a test command
moved them. The numbers above come from synthesised voices, so treat 25/30 as
directional — real speech has not been measured, and the honest place to do that is
a phone.

### The reply was slow, and the freshness read was mine (2026-08-25)

*"the 'spoken' part at the end takes a little while, whereas the actual action is
quick."* Both halves were true and they had different causes. Measured against the
live hub before touching anything:

| | before | after |
|---|---|---|
| a terse command, cache stale | 1450ms | **~200ms** |
| the same, cache warm | 180ms | 180ms |
| cancel, a real restore | 4759ms | **44ms** |
| Hinglish, via the model | ~2600ms | unchanged |
| a question | ~4100ms | unchanged, by choice |

**The first cause was a regression from the cancel work.** `runAddress` re-read the
hub only for relative actions, where a toggle computed from a stale reading is
backwards. Building cancel I widened that to fire whenever `remember` is present —
and `/api/say` always passes it — so every spoken command paid a 1.3s hub read so
that cancel's snapshot would be fresh. Since the background reader runs every 15s
and nobody speaks two commands four seconds apart, that was **the first command
every time**. Reverted. The trade now runs the other way and is the right way
round: an undo may restore a reading up to REFRESH_MS old, and in this house the
hub originates nearly every change, so its record is usually current.

**The second cause is the one the complaint actually describes.** `applyScene`
sends in about two hundred milliseconds and then spends SETTLE_MS twice reading the
house back and resending stragglers — so the lamps were already back while the
speaker waited three and a half seconds to hear about it. Cancel now answers on
send and lets verify-and-resend finish behind the reply, which is exactly what
`setRecords` has always done for an ordinary command. Nothing was given up but the
straggler count, and that count was already known to cry wolf one time in four.

**The general shape, worth keeping:** a spoken reply is a conversation and a
verification is not part of it. Anything that reads the house back belongs behind
the answer unless the answer is *about* the reading — which is why `look` still
pays its four seconds and was deliberately left alone.

One measurement artefact to expect: the first command within ~15s of a
`systemctl restart` can take tens of seconds, because startup awaits
`pollHardware(true)` and the first hub read. Seen once at 68s. It is not
representative — re-measure warm.

### A spoken cue answers on send too (2026-08-25)

`applyScene` now takes `{ verify: false }`: it awaits the send and finishes
verify-and-resend behind the caller. `fireCue` forwards the option, and the spoken
cue path passes it.

| | before | after |
|---|---|---|
| spoken cue | ~8.5s by arithmetic | **3.2s measured** |
| cancel | 4759ms | **131ms** |

**What is left is the model, and it is irreducible for a cue.** Measured on its
own, a Hinglish command through `askModel` is 2076ms; the cue's remaining 3.2s is
that plus `fireCue`'s freshness read and the send. A cue cannot use the free
grammar path — `speechWords` matches an address, and a cue is a name — so every
spoken cue is a model call by construction. Do not go looking for another 3
seconds in `applyScene`; they are not there any more.

**The dashboard still waits.** `applyScene(scene)` with no options is unchanged, so
`/do/cue/<id>`, cron and the schedules keep their verified counts — there the number
is displayed, and nobody is standing in a room waiting to be told.

**Cancel now awaits the send.** Fire-and-forget was a shade too eager: it answered
"back as it was" before the commands had left, which is a claim about something that
had not happened. 131ms with the send awaited is fast enough that there was never
anything to buy by skipping it.

**One bug this produced, worth the warning.** The fix was first written against a
factoring (`actOnCall`, with `via` in scope) that exists only in the stashed
audio-native branch — so `via` was written into a scope that has no such binding.
`node --check` passes a ReferenceError happily, and neither review tool exercises
the cue path. It was caught by grepping for the symbol and finding the function
absent. **After a stash or a revert, check that the code you are editing against is
the code that is deployed.**

Tested with a throwaway single-step cue whose one step was a fan that was already
on, so firing it changed nothing; created and deleted inside the same session, which
is the one shape of clean-up the restore rule above permits. `normal-mode` appeared
in the cue list while this was being measured — somebody in the house made it, and
it was left alone.

### Good night, addressed by whoever said it (2026-08-25)

Replaces three of the four Good Night cues. **A cue was the wrong shape for it**,
for the reason `/do` replaced "just the fan": a cue is one fixed list of records,
so good night needed a card per person and each card was a snapshot of a room's
wiring that went stale the moment somebody added a lamp — record 519 HANGING,
which this file records as having been invisible to the dashboard for a day, would
have been silently missing from one in exactly the same way.

Sleep already knows how to put a room to bed, and it is asked for **unchanged**:
lights off, **the fan and the air conditioner left running**. So good night is a
sleep whose scope comes from `who`, and it keeps the verify-and-resend a sleep has
to have — a cue that drops a lamp is one you press again, a lamp dropped at
bedtime burns all night with nobody awake to see it.

**The map is per-install config, not code, and that is not tidiness.** Hard-coded,
this family's names would have deployed to the second hub, where `MASTER ROOM` may
not exist — so the reply would have been a confident "Nothing was on in Master
Room" about a room that is not there. `config.goodnight` is `who` to room; absent,
good night says **"nobody has a good night set up here yet"**, which is what the
second hub now answers. Two names may share a room, as a couple does. It is read
once at startup, so a change needs a restart; `/api/setup` does
`Object.assign({}, config)` so the key survives a console save.

**Three honest refusals rather than a guess**, the same shape as `hindiCircuits`:
an unrecognised speaker is told **who is known** (built from the map, so it cannot
drift from what works), a `who` mapped to a room the hub lacks is told so, and an
empty map says the feature is not set up. Never a house-wide sleep — a guest phone
must not be able to darken a room somebody is sitting in. That was the user's call
to confirm and it is the conservative half of it.

**It is cancellable**, which matters more here than anywhere: this is the largest
thing anybody says to the house in one breath and the easiest to say into the wrong
phone. `captureBefore` drops curtains and screens on its own, which is right here
too, and the freshness read before the snapshot is worth paying — unlike on a terse
command, where widening it was the regression fixed earlier the same day.

**The reply never ends on the word "off", and that is load-bearing.** `SPEAK_WHOLE`
reads a sentence ending in on or off as a circuit being set and inserts a verb, so
"One light in Ashu Room is off" came back as **"is is now off"**. Putting the room
last sidesteps the whole family of rules rather than dodging one: *"Good night.
I've switched off 8 lights in Master Room."* Caught by `say-speech-review.js`,
which is exactly what it is for, and a Good night group was added to it.

Two other things the wording does deliberately. It **names what is still running**
("the fan is still running"), from the same `sleepKeeps` test that spared it —
lifted out of `sleepSteps` so there is one definition, because a reply that
disagrees with what was sent is worse than one that says nothing, and a fan that
went off with the lights is how you wake at two. And a **non-zero straggler count
is re-counted after a settle before it is spoken**, the same guard cancel has, for
the same measured reason: a fade still in flight reads as the wrong level.

**Two bugs worth keeping, both invisible to `node --check`.**
`sone?` is `son` plus an optional `e`, **not** `so` plus an optional `ne`, so the
Hinglish "so raha hoon" never matched — a quantifier binds to the character before
it. And `roomsIndex()` returns a **Map of slug to room key**, not a list of
objects, so `.some(r => roomKey(r.name) === room)` was silently always false and
would have refused every good night in the house. Both found by testing rather than
by reading, which is the pattern this file keeps recording.

**Tested live at 22:10**, so every deliberate case was a no-op: both refusals, both
dark rooms, and a Hinglish phrasing. `bhai` at 102ms warm, `ashu` 1359ms with the
freshness read.

**One unintended change, and it is the standing rule earning itself again.** A
second `bhai` run switched off COB 1 in Harshit Room — somebody had turned it on
between my check and my test, which is precisely what "a baseline recorded two
minutes ago is a fact about the past" means. Put back with `cancel` (100%, verified),
which is legitimate because it was **inside the same action**: the snapshot was
taken immediately before the write and nothing intervened. It also produced the one
test that could not be staged — good night and cancel end to end on a real lit
circuit. **Re-read the room immediately before each run, not once for the session.**

**A good night does not switch a television off**, because a directly-driven set is
not in `devices` and `sleepSteps` walks that map. That is sleep's existing behaviour
and "exactly as sleep" was the ask, so it is left alone and **the guide says so** in
as many words. Worth revisiting: bedtime is the one time somebody most wants the
screen off.

`parent-good-night` **was kept.** No `who` maps to PARENT ROOM, so deleting it would
have left that room with no good night at all, by voice or by cue — which the
per-person spec did not cover. The other three are gone from the hub and from
`data/seed-scenes.json`, with all four backed up to
`data/removed/good-night-cues.json` first.

### What the voice path keeps, and where it is said (2026-08-25)

Asked whether recordings are stored on the hub. **They are not, and this was
checked on the box rather than reasoned from the code alone.**

- **The audio never reaches disk.** `express.raw` hands the body in as a Buffer,
  `transcribe()` wraps it in `new Blob([buf])` and posts it. None of the nine
  `writeFileSync`/`appendFileSync` calls in `server.js` touch it; the buffer is
  freed with the request.
- **The transcript is not kept either.** No history JSONL holds a `heard` or
  `text` field — the events are `edge`, `cue`, `cancel`, `goodnight`, `tv`,
  `snap`, `sched`, `nudge`, `timer`, `verified`. The journal prints no transcript:
  `hear:` appears only on error paths, zero occurrences over two days.
- **The boundary is the API call, not the hub.** Everything else in this system is
  LAN-only; this one sends somebody's voice out of the house. Retention there is
  OpenAI's policy rather than ours, so check the current terms rather than
  trusting a summary, and Zero Data Retention is the thing to ask for.
- **Metadata is retained**, which is the honest qualification: who spoke and which
  circuits changed, e.g. `{"e":"goodnight","who":"bhai","room":"HARSHIT ROOM"}`.

**The endpoint writes no files, but testing it did.** Seventeen synthesised `.wav`
clips were left in `/tmp` on the hub by the transcription benchmarking earlier the
same evening, 20:04 to 21:23. Deleted. The only audio on the box now is the
vendor's own three `static/music/*.mp3`. Worth remembering as its own hazard: the
privacy property belongs to the running code and not to a session working on it.

**It is written into the monthly report's footer, not into a section of its own.**
`footerHtml()` is the report's honest half — where it comes from, what it cannot
see, coverage — and it renders in **every** view, house and each room. Somebody
reading a month of their own household is exactly the person entitled to know
whether what they said out loud was kept, so the paragraph goes where they are
already reading rather than behind a heading they might not open. Unconditional
prose, because it is true whether or not anybody spoke this month. Verified
rendering 8 times on the live report.

One distinction the paragraph makes deliberately, because it is the useful one and
it is exact: a **spoken** command sends a recording, a **typed Hinglish** command
sends the text, and a **short English** command typed into the dashboard
(`ashu cobs 40`) leaves the house not at all, because `speechWords` resolves it on
the hub for nothing. That is the free grammar path stated as a privacy property.

### How the house was told, in the monthly report (2026-08-25)

The user asked whether the voice feature could be told as a story in the report,
and chose two of the four offered: **how the house was told**, and the same split
**per room**. Bedtimes-per-person and a "what the house understood" quality
section were offered and not taken; both remain cheap to add, the first needing no
new logging at all because `goodnight` already carries `who`, `room` and a time.

**Logging is metadata only, and that was the user's explicit choice.** No
transcript is written, so the report footer's "neither the recording nor the words
are kept" stays literally true. A road is a fact about a circuit changing, not
about anything anybody said.

**`AsyncLocalStorage`, not an argument threaded down the send path.**
`markCommanded` has two callers but sits beneath `sendToHub`/`sendBatchToHub`,
reached from 17 and 6 places via `setRecords`, `sendSteps`, `acPower`, the curtain
verbs and the projector split — so plumbing a `via` parameter would have touched
two dozen call sites. A module-level "current road" is the obvious cheap
alternative and is **wrong**: two overlapping awaits, one variable, so the first
schedule firing while somebody spoke would misattribute both. Proven in isolation
that the context survives three awaits and does not leak between four concurrent
chains. One middleware sets it from `req.path`; `runSchedule`, `runScheduleOff` and
`runTimer` wrap themselves, because nothing unattended has a request to read.

**A spoken cue counts as `spoken`, not as `cue`.** The road is *how the person told
the house*, and they said a sentence. Only a cue fired as a cue is `cue`.

**The legacy `us` value is kept as its own bucket** rather than folded into `tap`.
Before this, `us` meant "any of our paths" including cues and schedules, so
reattributing 500 old edges to a road nobody recorded would have been a quiet lie
in a report whose whole footer is about not doing that. It is labelled *"the
dashboard, before roads were recorded"* and ages out on its own.

**Both sections have a floor** — 12 for the house, 6 for a room — because a split
of three switch-ons is noise presented as a finding. The room floor is lower
deliberately: eight switch-ons in one bedroom is a habit where eight across the
house is nothing.

Two implementation notes. `.roads` is its own class rather than reusing `.split`,
which styles exactly two bands by `first-child`/`last-child` and sets an opacity
that would fight an inline background. And the **last band takes the remainder**
rather than its own rounded percentage, because eight rounded numbers do not add
to 100 and a bar that stops at 97% looks broken.

**One bug, and it was mine: a text replacement swallowed `const room =
roomOf(c.room)`** because it sat between the two lines I was replacing. `node
--check` passed and `/report` returned 500 with `ReferenceError: room is not
defined`. Caught by booting a throwaway instance on `PORT=3121` and fetching the
page, which is the cheap check that should follow any edit to the report.

**What is verified and what is not.** The report renders live: 200, 488 events,
the house section and all seven room sections. `roadFor` is correct on nine paths
and the context does not leak. **But no road has yet been recorded end to end**,
because no command has gone through the new build — the log still holds only
legacy `us` and `elsewhere`, the latter being the household turning lights on by
switch while this was deployed. The first real command will show it, and the
honest way to check is to read `src` in the log rather than to command the house
for the sake of a test. ASHU ROOM was not used as a test surface this time because
the user had just lit it.

**The section is nearly empty today and that is expected.** History is 25 hours
old and much of it is this session's own testing, so the split reads as legacy
dashboard plus wall switch. It becomes a real picture over September.

### The guide became a page on the dashboard (2026-08-26)

*"put the guide on dashboard url /guide."* It is `GET /guide`, and the work was
deciding **where the builder lives**, not adding a route.

Three options, and the first two are worse for reasons this file already records.
Serving `data/speaking-to-the-house.html` off disk reintroduces exactly the
staleness the generator was written to avoid — it reads a running server because
"a second derivation is how a guide starts quietly lying", and a file on disk is a
third. Requiring `tools/make-guide.js` from server.js puts the page outside the
deploy contract: `push.sh` copies **server.js and nothing else** by construction,
so `/guide` would break on any box where somebody forgot a second copy — the trap
this file already records for the icon generator.

So the page builder moved **into server.js**, where `/do`'s reference page and
`/setup` already live, and `tools/make-guide.js` became a **thin client** that
fetches `/guide` and saves it. The file is still wanted: the guide is sent to the
family through Messages and has to open with no network at all. One definition,
two media, no copy step, and it cannot go stale.

**The move was verified by diffing its own output.** A mechanical move should
change nothing, and that is checkable: the page served by the moved code is
**byte-identical** to the file the tool wrote before it. Doing it that way is what
made the refactor safe to attempt at all — the guide embeds no live levels, only a
date, so the comparison is exact on the same day.

**Two bugs, and both are the same bug.** The rename regexes matched `roomBlock(`
and `esc(` — a name followed by a bracket — and missed the two places a function
is passed **by reference**: `rooms.map(roomBlock)` and `also.map(esc)`. `node
--check` passes a ReferenceError happily, so `/guide` answered 500 on the first
deploy. The general form, worth keeping because it will recur: **renaming by call
site misses every callback.** Grep `\.(map|sort|filter|forEach)\(\s*\w+\s*\)`
after any rename. Caught the second one that way rather than by another 500.

**A throwaway instance is the check that should have come first.**
`PORT=3121 node server.js` and one curl proved the page before the second deploy,
which is the same cheap check this file already prescribes after editing the
report — and it loads no schedules, so it cannot fire anything.

**The footer had to learn which medium it was in.** It read "built from the house
as it is today. Anything added or renamed after this will not be on this page" —
true of a saved file, and a quiet lie on a page rebuilt per request. `guidePage`
takes a `saved` flag and `tools/make-guide.js` asks for `/guide?saved=1`, so the
served page says it is built fresh and the file admits it can age. One sentence
apart, one builder.

**One reporting bug of my own, mentioned because it is the shape to watch.** The
new thin client counted rooms with `details class="room"` and said **eight** where
there are seven — the Screens block wears the same class. It counts a marker only
a room carries now. A tool that miscounts what it just wrote is a small lie in the
one place you look to check the thing worked.

### A room with two names (2026-08-26)

*"i want to give synonyms to harshit room as kanu room."* `config.room_aliases`
maps a spoken name onto a room — per-install, for the reason the groups, the
good-night map and the room renames are: a family's own name for a room is
knowledge about this house, and hard-coding it would deploy one household's
names to another.

**The design turns on one distinction: `roomsIndex()` was serving two jobs.**
It is the *resolution* list (what does this word mean) and the *enumeration* list
(what rooms are there), and those were the same list only because a room had one
name. Adding aliases to it would have drawn **Harshit Room twice in the family
guide**, twice on the reference page, and offered the model two enum values for
one room. So `roomTargets()` is the resolution list — the index plus aliases —
and `roomsIndex()` stays the enumeration one. Five sites resolve and take the
new list: `/do/<room>`, `runAddress`, `houseReading`, `screenCommand` and
`speechWords`. Everything that *enumerates* stays canonical.

**It is a way in only, which was the user's call after considering the
alternative.** The reply, the board, the guide and the log all keep the hub's own
name: *"kanu room ki light band kar do"* is answered with *"The lights in Harshit
Room are now off."* Echoing the spoken name was asked for and then withdrawn as
not worth the complexity, and the reason it is complex is worth recording — the
model answers from a **closed room enum**, so an echo cannot be sniffed out of
the text afterwards. It would need the alias as an enum value, and then the same
room arrives under two names in the reply and in the log. One room, one name in
the record.

**The alias has to reach five roads, and the transcriber is the one that is easy
to forget.** `/do` and the free grammar path come free from `roomTargets`. The
model needs it **in the prompt** rather than the enum. The command bar builds its
whole vocabulary from `GET /do`, so the rooms there carry an `aliases` array —
a new key, never a changed one, because `circuits` must stay an array of slugs
that `nextWords()` concatenates with the actions. And `transcriptPrompt()` needs
it most of all: *Kanu* is in no transcriber's vocabulary, and everything
downstream is moot if the audio comes back as "can you".

**Two ways an alias can do harm, both refused rather than honoured.** One that
shadows a real room's slug would make that room **ambiguous** — `pick()` finds
two candidates and refuses — so it would silently break every command to the room
it was meant to help; the house's own names always win. And one pointing at a
room this hub does not have is dropped rather than resolved to nothing, which
would answer "no such circuit here" for every address under it.

**`var`, beside `ROOM_RENAMES`, not `let`.** `applyConfig()` writes these before
much of the file has been evaluated, and this file already records hitting the
early-`let` ReferenceError twice in one session with `KIND_OVERRIDES`. Same
reason the alias is slugged **inline** rather than through `slug()`, which is a
const declared two thousand lines below and is not hoisted — the `GROUPS` block
makes the same concession with the same comment.

**One trap, and it is the one this file explicitly warns about.** The command bar
lives inside the page's template literal, and the comment I wrote for `matchRoom`
quoted a line of code **in backticks** — which ends the literal. `node --check`
caught it; `push.sh`'s backtick audit would have too. Do not write a backtick in
a comment inside that literal.

**Tested on every road**, with HARSHIT ROOM dark and re-read immediately before
each run rather than once for the session, so every `off` was a genuine no-op:
five `/do` forms, the per-room listing, the grammar path (`kanu lights off`,
0.1–1.2s, `via=grammar`), the Hinglish path, and two questions. Twelve room
prefixes were checked for ambiguity — `h` is still ambiguous between
`harshit-room` and `home-theatre`, which it was before. The transcriber
vocabulary is the one part **not verified live**, since checking it needs audio;
it is a one-line append and the alias is proven loaded by the `/do` grammar.

**One pre-existing inconsistency noticed and left alone.** The command bar picks
the *first* prefix match while the server refuses an ambiguous one, so typing
`h lights off` in the field builds an address the server answers 300 to. That
predates this work and is a real exception to the bar's own rule that it can
never offer a word the server would refuse.

**And a correction to the session before it:** the hub's config is
`~/dashboard/config.json`, **not** `~/dashboard/data/config.json`. An earlier read
of the wrong path returned nothing and was reported as "`kinds` is empty on the
hub" — which happened to be true, checked again against the real file, but the
evidence for it was a failed `cat`.

### One kind, everywhere — and the address that threw the word away (2026-08-26)

*"saare AC band kardo"* is the sentence, and answering it took two attempts
because the first one guarded the wrong layer. **It switched off every light in
the house, at half past seven in the evening, twice.** The road log is the only
reason the house could be put back exactly: `src: "spoken"` against the
household's own `elsewhere` separated my fifteen circuits from theirs.

**The fault was in the address, not in the model.** The `house` branch of
`runAddress` built `everything` and **never read the circuit word at all** — so
`/do/house/acs/off`, `/do/house/parda/close` and `/do/house/xyzzy/off` were one
address: all eighty-eight circuits, silently, reported as a success. The model
answering `house` + `acs` was a reasonable reading of the sentence; it was the
executor that widened it.

**The first guard checked `house` + `all` and never fired, which is what proved
it.** Its word test matched the sentence, the room was `house`, and it did not
trigger — so `circuit` was not `all`, so the model *had* named the kind and the
address had discarded it. **A guard on the voice road cannot fix a fault that
lives in the address**, and a guard that does not fire is indistinguishable from
no guard until something goes dark.

So `HOUSE_KINDS` gives the house four collective circuits — `lights`, `fans`,
`curtains`, `acs` — and **a word it cannot honour is a 404** naming the four,
never the whole house. `/do/house/all` is unchanged, which is what the
dashboard's all-off and `/do/house/off` have always used.

What is left on the voice road is smaller and is about the model only: if it
still answers `all` for a sentence that named a kind, the target is **narrowed**
to that kind. Narrowing can only ever do less than was asked, which is
recoverable; widening is the one answer that never is. `cobs` and `tv` are named
in the sentence test and *not* in `HOUSE_KINDS`, so those refuse — a cob is a
room's business, and "everything" is not a near-enough answer for it.

**Two questions that look like one, and conflating them said something untrue out
loud.** `isAcRecord` asks *how this is sent* — an IR unit needs the IR path, which
is why every bulk sender splits on it. A kind needs *what it is*. The house has
both: six IR units and HOME THEATRE 496, a relay on module 195. Asking the
routing question of "every air conditioner" did **six of the seven** and then
reported *"Every air conditioner is now off."* `isClimateRecord` is the second
question. Under-doing is the safe direction; claiming it was everything is not.

`isFanRecord` and `isLightRecord` were extracted in the same pass — the fan test
was spelled out three times, in `circuitsOf`, in `hindiCircuits` and in the new
kinds, with a comment at each apologising for it. They were one edit from
disagreeing about whether a circuit is a fan.

**Adding `house` to `GET /do`'s room list broke `tools/make-guide.js`**, which is
worth keeping as the shape of the hazard rather than the bug. The command bar
builds its vocabulary from that list precisely so the field cannot offer a word
the server would refuse, so the house belonged in it — but the guide **walks the
same list and fetches `/do/<room>` for each**, and there is no `/do/house`, so
one unguarded fetch would have thrown and taken the whole guide with it. It is
appended rather than prepended for a second reason: the bar matches a room by
prefix, and `house` ahead of `harshit-room` would quietly change what a typed
"h" means.

**Verified end to end, and honest about which:** the ACs (`saare AC band kardo`
and the English, `room=house circuit=acs`, seven sent, fifteen lit circuits
byte-identical before and after — every AC was already off, so it was a hardware
no-op) and the curtains (`saare parde rok do`, `stop`, which releases both relays
and so cannot move a motor). The four refusals change nothing and were run.
**`lights` and `fans` were not run end to end**, because the only way to do it is
to darken or still an occupied house; their resolution is proven offline against
the live device list — 70 lights, 4 fans, 5 curtains, 7 ACs, 86 circuits, no
overlap, nothing orphaned, screens in no kind — and the re-aim makes the
whole-house outcome unreachable for those sentences whatever the model answers.

**The multi-target path was finished in the same session** and tested on rooms
that were already dark, so it was a true no-op: two and three targets, correct
slugs, and `title_` given the hyphens stripped so the voice says "Harshit Room"
rather than one hyphenated word.

**One measurement note.** The log's timestamps are UTC and the house is IST, so
`13:54` in the JSONL is 19:24 in the room. I read it as eleven at night and wrote
that into a comment before the hub's own clock corrected it. Ask the box what
time it is.

### Making the voice path four times faster (2026-08-27)

Eight changes in one pass, all measured on the hub rather than over the tunnel. The baseline they were chosen against:

| | before | after |
|---|---|---|
| spoken command, free grammar | 0.93–1.08s | unchanged |
| **spoken command, model** | **4.31s** | **1.59–1.84s** |
| spoken command said again | 4.31s | **0.91s** |
| **question, whole house** | **4.31s** | **2.62s** |
| question said again | 4.31s | 1.74s |
| typed, grammar | 0.10–0.23s | unchanged |
| transcription alone | 0.79s | unchanged |
| bare OpenAI round trip from the hub | 0.89s | the floor for any of it |

**The free path is four times faster than the model path, and that ratio is the whole economics of `/api/say`.** Everything below is either "get more sentences onto it" or "make the model path cheaper".

**`gpt-audio` and `gpt-audio-mini` are on the key now, and the note above saying otherwise is out of date.** Measured: audio in, tool call out, **1.26–1.49s**, against 0.79s of transcription plus 2.6s of text model. It read `master room ke cobs full kar do` correctly and split `living ka main curtain khol do aur dining ke cobs thoda kam kar do` into two calls.

**It races the transcription rather than replacing it, and that is the design.** Both start the moment the request arrives. The transcript still lands first and still gets the free grammar path; the audio call is only there to have already finished when the grammar declines. Replacing would have cost two things worth keeping: `heard`, which is the only way to find out what the house thought you said, and the free path itself. The price is one discarded call whenever the grammar wins, and `audio_model: ""` turns it off.

**It accepts wav and mp3 only** — `m4a` is refused outright and calling an m4a "wav" is refused as *does not support the format you provided*. Shortcuts records m4a and this hub has no ffmpeg, so **the race is currently inert for the phone** and the serial path runs exactly as before. `toWav()` pipes through ffmpeg when it is there, detected once at startup, so `sudo apt install ffmpeg` is the whole of what turns it on. Piped rather than via a temp file deliberately: the endpoint's stated property is that the recording is never written down.

**A question was doing its hub work *after* the model answered, and it did not have to.** `look` polls the hardware and re-reads the hub, and neither depends on what the model says. Started beside the call instead, keyed on `SAY_ASKS` — the same test that keeps a question away from the command grammar, so it fires on exactly the sentences that can reach `look` and never on a command. 4.31s to 2.62s, no behaviour change.

**Three words were costing a fourfold slowdown each, and nothing had recorded it.** `kar`, `karo` and `thoda` survived the split, so `master cobs full kar do` (2.60s), `master ke cobs full karo` (3.08s) and `master cobs thoda tez karo` (2.95s) all paid a model call while `master cobs full` resolved locally in 0.95s. They are particles and filler now. Safe by the argument already in this file: nothing here is named any of them, the noun is untouched, and the worst outcome is a refusal from `pick()`.

**The verb tails had drifted, which is why they are now written once.** `chalu kar do` matched and `chalu kar dena` did not — the same command, 1.75s against 0.1s, decided by how somebody ended the sentence. `SAY_DO` is the one spelling and `hinglishVerb()` builds each rule from it.

**English puts the room last, and the grammar only understood room-first.** "turn on the fan in ashu" strips to `[on, fan, ashu]` and failed on `fan` not being a room. Tried only when the first word is not a room, so a normal sentence can never be reordered by accident, and the fallback is what it always was — the model.

**The model answers with a word where the grammar answers with a number.** `gpt-audio-mini` returned `action: "full"` on one run of three, and `/do/master/cobs/full` is `No such action` — so the sentence was understood and then refused on a word `SAY_NUMBER` already maps. The grammar path never hit this because it translates before the address sees it. `normalAction()` now sits at the top of `actOn`, so the screens and the hub circuits cannot disagree about what "full" means either.

**Repeated sentences are remembered, because a household says the same dozen things every night.** What is cached is the *resolution* and nothing else, which is safe because it does not depend on the state of the house: a relative action is still resolved against live readings inside `runAddress`, and `look` still recomputes its reading. Keyed on the words plus `houseShape()`, so a renamed room cannot be answered from a memory of the old one, and **punctuation is stripped from the key** — the identical clip came back as `chalu rakh ho.` once and `chalu rakh ho` the next, which is two sentences to a Map and one to a person. That is why the first repeat missed.

**`houseShape()` had to be given a TTL of its own**, or it defeated the thing it serves: it is the key for two caches, so it is computed several times per sentence, and computing it walks every room's circuits. Ten seconds, and `applyConfig()` clears it outright so a console save is not made to wait.

**The one number that mattered was not being recorded anywhere.** The history log carries `src` — voice, tap, schedule — but nothing said whether the words were resolved on the hub for nothing or paid a model call, which is the figure that decides whether any of this helped. `stats.said` counts every road, `/api/health` reports it, and the health panel says `N commands, X% free`. A `said` event goes to history carrying **the road, whether it came from a microphone, and whether it worked — and no transcript**, so the report footer's "neither the recording nor the words are kept" stays literally true.

**`tools/say-eval.js` is what makes all of the above safe to change.** `say-speech-review.js` checks the wording of replies; nothing checked whether a sentence is *understood*, or whether it got there free. It lifts the parser out of `server.js` with the same trick and runs it against this house's own rooms and circuits — offline, no key, nothing sent, so it can be run on every edit. 42 cases, 32 of which must resolve locally and 10 of which must **not**: every question, every kind-across-the-house sentence, every ambiguity. That direction is the one that matters, because a wrong local resolution switches the wrong thing in silence while falling through to the model only costs time.

It earned itself immediately: it caught that the new `SAY_DO`/`hinglishVerb` had to be lifted too, and four of my own expectations were wrong rather than the code — a room-first sentence returns the room **as it was said** (`pick()` resolves the prefix) while only a room-last one is canonicalised, and `light` reaches `lights` without the parser knowing about plurals.

**Two traps, both already in this file and both hit again.** Building the eval's fixture, `area_devices` is a comma-separated **string** and the room's name is in `name`, not `sub_area_name` — copied from the wrong guess first and found every room empty. And **`applyConfig()` runs at line 1551 while the three new caches were declared at 6853**: a `let` reached before its declaration is a startup `ReferenceError` that `node --check` cannot see. Third time. They are `var`, up beside `ROOM_ALIASES`, where the others already sit for this exact reason — caught only by booting.

**What was deliberately not changed.** The model timeout went 6s to 5s and no lower: a text call measured 2.6–3.3s at worst here, so the 3.5s that would suit the audio path would time out on the road that is still doing most of the work. And multi-target still runs sequentially — this file's own measurement about concurrent sockets holds whatever the model costs.

### direct lights and indirect lights (2026-08-25)

*"A lot of times the word cobs gets misheard."* It is not a word any transcriber
expects, and a wrong guess there addresses the wrong circuit. So the declared group
answers to **direct lights** as well, and the lights outside it to **indirect
lights** — ordinary English that dictation gets right first time, and a description
of what the fittings do rather than what they are called. `cobs` still works; this
adds names rather than replacing one.

**Membership comes from the declared group, never from the device name.** The
`/^COB\b/` regex on names is exactly what stopped the ceiling tile working in
anybody else's house, and inferring "this fitting is direct" from its label would
be that same mistake in a new coat.

**Both names, or neither — and that was a correctness bug caught in testing.**
"Indirect" is defined as the lights *outside* the group, so in a room with no group
it swallowed every light there including the downlights: HARSHIT ROOM has a single
ungrouped COB, and `harshit indirect lights off` would have switched off a
downlight while calling it indirect. A name that is wrong is worse than one that is
missing, so a room with no declared group is offered neither and answers with the
ordinary "I cannot find that". Six of seven rooms have both; Harshit has neither,
and its one COB is addressed as `cob 1`. Note a config group would **not** fix that
on its own: `GROUPS` filters `record_ids.length > 1`, so a one-lamp group is
dropped before `groupsIn` ever sees it.

**`speechWords` now accepts a two-word circuit**, which it had to for this to be
worth anything: it capped the circuit at one word, so `ashu direct lights on` was
four words and fell to the model — the whole point of the synonym being that it is
said out loud. The two words are joined with a hyphen, which is how those slugs are
already spelled, and **kept only if they resolve**: `ashu all lights off` joins to
`all-lights`, which is not a circuit, so it returns null and goes to the model
exactly as before rather than being refused. It resolves with the same `pick` that
`runAddress` uses, so the two cannot disagree.

That fixed a gap nobody had noticed: **every multi-word circuit name was paying a
model call.** Measured after, all on the free grammar path — `ashu direct lights
on` 426ms, `ashu indirect lights off` 496ms, `ashu direct on` 369ms (a unique
prefix, so the word "lights" is optional), and `ashu foot light off` now
`via=grammar` where it used to be `via=model`.

**`SPEAK_PLURAL` could not see these, and it would have said "the direct lights is
now on".** It was `/^the\s+\S*s\b/`, which tests only the *first* word after
"the" — fine for "the cobs" and "the lights", wrong for any two-word plural. Now
`/^the\s+.*s\b/`, and the `\b` is what keeps it honest: it still needs a word
that *ends* in s, so "the bed spot" and "the main curtain" stay singular. Checked
against ten real labels.

Kept out of the transcriber's vocabulary hint (`COLLECTIVE_SAY`) deliberately —
they are plain English that every model already gets right, which is the entire
reason they exist. `cobs` stays in the hint.

**Tested as no-ops throughout**, ASHU being lit at the time: the cobs were already
on at 100% and every indirect light already off, so both commands were verified to
resolve and change nothing, confirmed by reading the room back.
