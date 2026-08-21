# Hosting the dashboard on the hub (a Dell OptiPlex 3020)

The hub at `192.168.1.3` is a Dell OptiPlex 3020 — an ordinary x86-64 desktop PC
running Ubuntu 20.04, and the one device in the house that is always on and
always on the LAN. Running the dashboard here means it works with the Mac shut —
and, crucially, gives us **schedules**, which the hub's own scheduler cannot do
(its `addScheduledTrigger` endpoint is broken server-side — see `CLAUDE.md`).

We replace that dead scheduler with the box's own `cron`, calling our fire
endpoint. One service, one directory, a non-8090 port, nothing of the vendor's
touched.

## Prerequisite: a login on the box

You need to get onto the hub once. Its SSH user is **`abneo`** (leaked by the
vendor's Django debug page: `/home/abneo/...`), auth is `publickey,password`,
and our keys aren't authorised yet. Get in by either:

- asking the dealer/installer for the `abneo` password or to add your key, or
- physical access: at boot, GRUB → recovery root shell → set a password
  (`passwd abneo`) or append your `~/.ssh/id_ed25519_personal.pub` to
  `/home/abneo/.ssh/authorized_keys`.

Nothing below is possible until that first login exists. No password guessing.

## 1. Build the bundle (on the Mac)

```bash
./build-bundle.sh          # produces dashboard-nas-bundle.tar.gz
```

It packs `server.js`, `data/`, `scenes.json` (your cues), the bundled
`node_modules`, and this `deploy/` folder. `node_modules` is pure-JS, so it runs
on the hub even if the hub has no internet.

## 2. Copy it to the hub and unpack

```bash
scp dashboard-nas-bundle.tar.gz abneo@192.168.1.3:~/
ssh abneo@192.168.1.3
mkdir -p ~/dashboard && tar -xzf ~/dashboard-nas-bundle.tar.gz -C ~/dashboard
```

## 3. Install the service

```bash
cd ~/dashboard && bash deploy/install.sh
```

The installer finds Node (≥14), syntax-checks the app, writes the systemd unit
with this box's paths, and enables it. If `sudo` works it installs a
system service (starts on boot); if not, a per-user service with lingering.

Change the port if 3000 is taken:

```bash
PORT=8137 bash deploy/install.sh
```

Check it:

```bash
curl -s http://127.0.0.1:3000/api/cues     # should list your cues
journalctl -u neo-dashboard -f              # live logs (system service)
```

If Node is missing, `install.sh` prints how to get it — with internet via
NodeSource, without via a copied tarball for this box's CPU (`uname -m`).

## 4. Schedules — the whole point

Edit `abneo`'s crontab:

```bash
crontab -e
```

Add lines using the fire helper (absolute paths; cron has a bare PATH):

```cron
# min hour dom mon dow   command
   0   23   *   *   *     /home/abneo/dashboard/deploy/neo-fire.sh ashu-good-night
   0   23   *   *   1-5   /home/abneo/dashboard/deploy/neo-fire.sh master-good-night   # weekdays
  30    7   *   *   *     /home/abneo/dashboard/deploy/neo-fire.sh morning
   0    0   *   *   *     /home/abneo/dashboard/deploy/neo-fire.sh off                 # midnight all-off
```

If you set `SHORTCUT_KEY` in the unit, also export it for cron:
`SHORTCUT_KEY=... ` at the top of the crontab. List cue ids with
`curl -s http://127.0.0.1:3000/api/cues`.

Cron uses the **hub's** clock and timezone — check `timedatectl` once; if it's
not on IST the schedule times will be off.

## 4b. The watchdog

systemd restarts the service if it *crashes*. It cannot see the other failure:
the process alive and serving pages while its hub connection has died.
`/api/health` returns 503 in that case, and this catches it:

```cron
*/5 * * * * /home/abneo/dashboard/deploy/watchdog.sh
```

**It needs permission to restart the service, or it can detect a failure and
then do nothing about it.** As `abneo`, plain `systemctl restart` wants
interactive authentication and `sudo -n` wants a password, so grant exactly that
one command and nothing else:

```bash
echo 'abneo ALL=(root) NOPASSWD: /usr/bin/systemctl restart neo-dashboard, /bin/systemctl restart neo-dashboard' \
  | sudo tee /etc/sudoers.d/neo-dashboard >/dev/null \
  && sudo chmod 440 /etc/sudoers.d/neo-dashboard \
  && sudo visudo -c
```

The `visudo -c` at the end validates every sudoers file — don't skip it, a
malformed one can lock you out of `sudo`. Confirm it took with:

```bash
sudo -n systemctl restart neo-dashboard && echo "watchdog can restart"
```

It restarts only after two consecutive bad checks, so one slow read doesn't
bounce the service. Check health by hand any time:

```bash
curl -s http://192.168.1.3:3000/api/health
```

## 4c. When the installer adds or changes devices

The dashboard ignores any device it does not already know about, so a light
fitted later stays invisible until the device database is refreshed. On the hub:

```bash
cd ~/dashboard && node tools/discover.js && sudo systemctl restart neo-dashboard
```

It prints what it added or removed, and writes `data/devices.json` itself — do
not redirect it. Plain `node` is fine here (the tool is written to parse on the
box's old Node 10); the *service* runs on `/opt/nodejs`.

## 5. Point the phone at the hub

In your iPhone shortcuts, replace the Mac's address with the hub's:
`http://192.168.1.3:3000/...`. Now they work with the Mac shut. (See
`../SHORTCUTS.md` for the shortcut recipes themselves.)

## Updating later

Almost every change is `server.js` alone, so use the script:

```bash
bash deploy/push.sh
```

It syntax-checks on the Mac, copies `server.js` **and nothing else**, checks it
again on the hub, restarts, and then confirms the page really came up — rolling
back to the previous `server.js` if it did not. That last part matters when you
are deploying from away: a broken startup otherwise leaves the house with no
dashboard, nobody near the box, and a watchdog restarting the wreck for ever.

It also runs two checks `node --check` cannot do for you, both about the same
blind spot: the frontend lives inside a template literal, so the server parses
whatever nonsense is in there. The backtick audit catches a stray backtick that
stays syntactically valid and takes the page down at runtime — that has shipped
three times. And the page's own script is **extracted and parsed separately**,
with its `${...}` holes plugged, because a duplicate top-level declaration in
there is a SyntaxError that leaves the server parsing, the page serving 200, and
the whole app dead in the browser. Not hypothetical: a second `offAfterWord` got
past both `node --check` and a 200 on 2026-08-21, and the only symptom was a page
with no `window.state`. Verified to refuse, and to leave the hub's `server.js`
byte-identical when it does.

### From away

Pass the hub's tailnet address, or set `NEO_HOST`:

```bash
bash deploy/push.sh 100.83.127.114
```

Nothing else needs configuring — `sshd` and the dashboard both already bind all
interfaces. See the Tailscale section of `../CLAUDE.md` for what does and does
not reach the house over that tunnel (short version: lights yes, televisions
mostly, switching a television *on* no).

`NEO_PORT`, `NEO_DIR` and `NEO_SVC` override the port, directory and unit name.

### The whole bundle, when data/ or node_modules changed

```bash
scp dashboard-nas-bundle.tar.gz abneo@192.168.1.3:~/
ssh abneo@192.168.1.3 'tar -xzf ~/dashboard-nas-bundle.tar.gz -C ~/dashboard && sudo systemctl restart neo-dashboard'
```

**Check `scenes.json` first.** The bundle packs it, so this overwrites the
house's real cues with whatever local testing left behind — and editing a cue in
a local test server is enough to leave residue. Compare the two mtimes before
you do it; the hub's should be the newer one if anybody has edited cues there:

```bash
stat -f '%Sm local' scenes.json; ssh abneo@192.168.1.3 'stat -c "%y hub" ~/dashboard/scenes.json'
```

`push.sh` avoids the whole question by never copying it.

## Uninstalling — leaves the hub exactly as found

```bash
sudo systemctl disable --now neo-dashboard
sudo rm /etc/systemd/system/neo-dashboard.service && sudo systemctl daemon-reload
crontab -e        # delete the neo-fire.sh lines
rm -rf ~/dashboard ~/dashboard-nas-bundle.tar.gz
```
