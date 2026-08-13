# Pravita's Apartment

A local web dashboard for a Neo Console Hub — a home-automation controller on
the LAN driving 87 devices across 7 rooms. Lights, fans, curtains, ACs and
screens, with dimming, colour temperature, and saveable scenes ("cues").

It talks to the hub over a WebSocket protocol that was reverse-engineered by
probing, since the vendor publishes none. No cloud, no account — everything
stays on your network.

## Running it

```bash
npm install
npm start                 # http://localhost:3000
```

Then open `http://localhost:3000` on the same machine, or
`http://<this-machine's-LAN-ip>:3000` from a phone on the same Wi-Fi. See
[SHORTCUTS.md](SHORTCUTS.md) for Siri, Home Screen widgets, and one-tap cues.

The hub must be reachable on the LAN. Point elsewhere or exercise error paths
with environment variables:

```bash
PORT=3111 npm start            # a second instance on another port
HUB_IP=192.0.2.1 npm start     # an unreachable hub, to test error handling
```

## Layout

```
server.js        the entire application — server logic, then the whole
                 frontend inside one HTML template literal
scenes.json      your saved cues (auto-seeded on first run; git-ignored)
data/            the hub's device database + room grouping
tools/           standalone scripts for poking at the hub (see below)
CLAUDE.md        detailed notes on the hub protocol and architecture
SHORTCUTS.md     iOS Shortcuts / Siri / widget recipes
```

There is no build step, no framework, and no test suite. The only check is
`node --check server.js`. Verify changes by driving the real hub and loading
the page.

## tools/

Throwaway diagnostics, not part of the app — run directly with `node`:

- `probe.js` — pulse a curtain, try an AC command, or dump what the hub stores
  for one device.
- `discover.js` — refresh `data/devices.json` from the hub. Run it after the
  installer adds or renames anything, then restart; new devices are otherwise
  ignored. It prints what changed and writes the file itself — do not redirect.
- `connection-test.js` — confirm the WebSocket handshake works.
- `generate-csv.js` — regenerate `data/neo_console_devices.csv` from
  `data/devices.json`.

## A note on the hub

The protocol was worked out by observation and is easy to get subtly wrong —
it fails silently rather than with an error. Before changing anything about how
commands are sent, read the hub-protocol section of [CLAUDE.md](CLAUDE.md).
Changing a device switches something in a real home, so test against an unused
room and put back what you touch.
