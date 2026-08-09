# Siri, widgets and one-tap shortcuts

The dashboard exposes a few plain endpoints so the house can be reached without
opening a browser — from Siri, a Home Screen widget, the Lock Screen, or a Back
Tap on the back of the phone.

Everything here works only on the home Wi-Fi. The hub is LAN-only, so this is
not remote control.

## The endpoints

| | |
|---|---|
| `GET/POST /api/cue/:id/fire` | Run a cue |
| `GET/POST /api/house/off` | Switch off everything that is on |
| `GET /api/cues` | List the cues, with their ids |

They answer to `GET` as well as `POST` because a widget or a bookmark can only
manage a `GET`. Each reply carries a `spoken` field — a sentence rather than a
count — which is what Siri should read back.

Find your cue ids:

```bash
curl -s http://192.168.1.8:3000/api/cues
```

```json
{"cues":[{"id":"ashu-good-night","name":"Good Night · Ashu","circuits":11}, …]}
```

Replace `192.168.1.8` throughout with whatever `ipconfig getifaddr en0` prints
if the Mac's address has changed.

---

## "Hey Siri, good night"

1. Shortcuts app → **+** → **Add Action** → search **Get contents of URL**.
2. URL: `http://192.168.1.8:3000/api/cue/ashu-good-night/fire`
3. Method: **POST** (tap *Show More*).
4. Add a second action: **Get dictionary value**, key `spoken`, from the result
   of step 2.
5. Add a third action: **Speak text**, using that value. Now Siri tells you what
   actually happened rather than staying silent.
6. Rename the shortcut to the exact words you want to say — **Good night**.

Say *"Hey Siri, good night"*. The name of the shortcut **is** the phrase, so
name it something you would naturally say.

Worth making one per cue you use daily. Keep the names distinct — "Good night"
and "Goodnight Ashu" will be confused with each other.

---

## A Home Screen widget

Once a shortcut exists it can go on the Home Screen:

1. Long-press the Home Screen → **+** → **Shortcuts**.
2. Choose the 2×2 single-shortcut widget, or the 4×2 for four cues at once.
3. Long-press the widget → **Edit Widget** → pick the shortcut.

One tap, no app, no unlocking into a browser.

---

## All-off on the Lock Screen or a Back Tap

Make a shortcut called **All off** pointing at:

```
http://192.168.1.8:3000/api/house/off
```

Then either:

- **Lock Screen button** — Settings → Wallpaper → Customise → Lock Screen →
  tap a widget slot → Shortcuts → All off.
- **Back Tap** — Settings → Accessibility → Touch → Back Tap → Double Tap →
  scroll to Shortcuts → All off. Now two taps on the back of the phone switches
  off the house.

This is the one worth having on the Lock Screen: it is the thing you want at
midnight without unlocking anything.

---

## Fire a cue when you get home

The closest this house can get to knowing you have arrived, with no extra
hardware:

1. Shortcuts → **Automation** tab → **+** → **Wi-Fi**.
2. Network: your home network. **Run Immediately**, and turn off *Notify When
   Run* once you trust it.
3. Action: **Get contents of URL** → your cue's fire endpoint.

Because it is the phone noticing the Wi-Fi rather than the house noticing you,
it fires when you come within range — which is usually the right moment.

A matching "leaving" automation on *Wi-Fi disconnected* pointing at
`/api/house/off` is tempting, but be careful: it will also fire when your phone
drops to mobile data in a dead spot, or when you go to bed with Wi-Fi off.

---

## If you want a key

By default anything on the home Wi-Fi can call these. To require a secret:

```bash
SHORTCUT_KEY=some-long-random-string npm start
```

Then append `?key=some-long-random-string` to every URL above. Worth doing if
guests use your Wi-Fi; unnecessary otherwise.

---

## When it does not work

- **Nothing happens, no error.** The Mac is asleep or `npm start` is not
  running. The phone is only a screen — the Mac does the talking to the hub.
- **"Could not connect to server."** Check the Mac's address is still
  `192.168.1.8` — it is a DHCP lease and can change after a router reboot.
  Reserve it in the router if this keeps happening.
- **Works at home, not outside.** Correct and expected. The hub is only
  reachable on the home network.
