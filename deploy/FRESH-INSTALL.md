# Installing this on another hub

For **another installation of the same vendor's controller** — an Abneo/Tistron
hub on its own small Linux box, a different house. Every protocol detail in
`CLAUDE.md` was measured against that hardware and applies unchanged. A different
brand of hub is not in scope: none of the reverse engineering transfers, and
there would be no way to test it.

## What you need

* the hub's address on the LAN, and SSH to it
* a machine on the same network to run this from

## 1. Copy the app onto the hub

```bash
scp -r . <user>@<hub>:~/dashboard
ssh <user>@<hub>
cd ~/dashboard
```

## 2. Look before you touch anything

```bash
bash deploy/bootstrap.sh --hub <hub-address>
```

A dry run. It prints the Node it would install, the dependencies it would fetch,
and — the useful part — everything the hub says it has: rooms, lights with the
dimmable and tunable counts, fans, curtains, air conditioners split into infrared
and relay, and the screens. Then what **cannot** be done, which matters more:

* an infrared air conditioner is one-way, so its state is only what was last
  sent — somebody using its own remote is invisible
* colour temperature cannot be read back at all, on any lamp
* a curtain reports no position, ever

It also names its own guesses. Fans are found by the word FAN in the name because
the hub's `isFan` flag is unreliable, and an `app_type` this dashboard has never
seen is drawn as a light. Both are fixable in step 4.

## 3. Install

```bash
bash deploy/bootstrap.sh --hub <hub-address> --go
```

Installs Node into `/opt/nodejs` if the box has none new enough — **leaving the
system's own node alone**, because something on the box may depend on it (on the
hub this was written for, the vendor's app does) — then the two dependencies,
then writes `config.json` and `data/devices.json`, then one systemd service in
one directory on a port that is not the vendor's 8090. Nothing the vendor owns is
touched.

## 4. Tell it the things the hub does not know

Open `http://<hub>:3000/setup`.

| | |
|---|---|
| **This house** | its name, and the short one under the home-screen icon |
| **The hub** | address and port, and this dashboard's port |
| **What each circuit is** | every circuit, what the guessing decided **and why**. Correct the fans it missed and anything with an unknown type. |
| **Groups** | a run of identical fittings on one ceiling, driven as one tile. Pick a room, tick the circuits, name it. Nothing is detected automatically: which fittings belong together is something you know, and a guess would be wrong quietly. |
| **Screens** | scan, then map each MAC to a room |

Groups and kinds take effect at once. A name, an address or a screen needs the
Restart button, and the page says so rather than leaving you wondering.

### About the screens

Which set is in which room **cannot** be worked out from the network: the MACs
come in batches and a sleeping set will not answer. Switch one on, scan, and see
which address appears. Pairing puts a prompt on that screen which a person has to
accept, once per set — and the key is filed by MAC, so moving a set between Wi-Fi
and Ethernet costs another prompt.

The MAC prefix tells you something useful before you try it: a wired set wakes
reliably from a magic packet, a Wi-Fi one often will not. Everything else — off,
volume, apps, a YouTube link, a message on screen — works either way.

## 5. After the installer visits

Anything fitted, removed or renamed needs **Re-read the hub** in the console. An
ordinary read ignores a `record_id` the dashboard has never seen, so a new light
is invisible however many times the hub is read.

## Files that belong to one house

Per-install and git-ignored, so cloning this repo never carries somebody else's
house with it:

| file | what |
|---|---|
| `config.json` | name, hub, screens, groups, kind overrides |
| `data/devices.json` | the hub's device database |
| `data/seed-scenes.json` | first-run cues, if any |
| `data/tv-keys.json` | screen pairing keys — a credential |
| `data/background.jpg` | the backdrop photograph |
| `scenes.json`, `schedules.json`, `settings.json`, `state.json` | what you have made since |

`deploy/push.sh` copies `server.js` and nothing else, and places `config.json`
only when the box has none — so deploying an update can never overwrite a house's
own settings with another's.
