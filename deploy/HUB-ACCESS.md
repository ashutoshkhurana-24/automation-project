# Getting into the hub on a new install

The vendor's controller is an ordinary desktop PC running Ubuntu, and the
dashboard has to run *on it* — so the first job at a new house is a login the
installer will not give you. The vendor here said outright they could not supply
the password, and no build of their phone app contains one (checked: it has no
SSH/SFTP client at all, so it cannot log into the OS even in principle).

This is a **local password reset on hardware the owner controls**, done with
physical access — the same procedure as any forgotten Linux password. Do it on
the owner's own box, with the owner present or having asked for it. It does not
touch the vendor's application or its data, and the steps at the end verify
exactly that.

---

## What you are dealing with

Confirm before you start, because two of these change the method:

| | This house | Why it matters |
|---|---|---|
| Machine | Dell OptiPlex 3020, x86-64 desktop | An ordinary PC. Keyboard and monitor is all you need. |
| OS | Ubuntu 20.04 | GRUB, systemd. |
| OS user | `abneo` | The vendor's app runs as this user, out of `/home/abneo/abneo_controller`. |
| Disk encryption | none | **If the disk is LUKS-encrypted this will not work** — you need the passphrase, and nobody has it. |
| BIOS/UEFI password | none set | **A BIOS password that locks boot options blocks GRUB editing.** Then it is a disk pull, or the dealer. |

You can often learn the user account without logging in: the vendor's Django app
runs with debug on, so any stack trace it leaks names its own paths. On this
house `/home/abneo/abneo_controller/...` gave up the username `abneo`.

---

## The method: GRUB → a root shell → `passwd`

Fifteen minutes, one reboot.

### 1. Get into GRUB

Reboot with a keyboard and monitor attached and hold **Shift** (BIOS boot) or tap
**Esc** (UEFI) as it starts. You want the boot menu with the Ubuntu entries.

If it flies straight past, you were too late — reboot and start holding earlier.

### 2. Edit the boot line

Highlight the normal Ubuntu entry and press **`e`** to edit it.

Find the long line starting `linux /boot/vmlinuz-...`. Go to the **end** of that
line and append:

```
rw init=/bin/bash
```

Then **Ctrl-X** (or F10) to boot it.

Two things about that line, both of which matter:

- **`init=/bin/bash`, not `single` or `recovery`.** The recovery options drop you
  at a prompt that asks for the **root** password — which nobody has, so it is a
  dead end. Replacing init skips all of that and hands you a root shell with no
  authentication, because nothing that authenticates has started yet.
- **`rw`.** Without it the root filesystem is mounted read-only and `passwd`
  fails to write. Belt and braces: run the remount in step 3 anyway.

### 3. Reset the password

You land at a bare `root@(none):/#` prompt. There is no networking, no services,
and no job control — that is expected.

```bash
mount -o remount,rw /
passwd abneo
```

Type the new password twice. **Write it down somewhere before you continue** —
you are about to reboot and there is no second chance to read it back.

Then give that account sudo, which it needs for `systemctl` later:

```bash
usermod -aG sudo abneo
```

Worth checking rather than assuming, since a wrong username silently "succeeds"
against nothing:

```bash
id abneo
ls /home
```

### 4. Boot normally

```bash
exec /sbin/init
```

That hands off to systemd and the machine comes up as usual. A hard power cycle
also works, but `exec /sbin/init` is cleaner — the filesystem is mounted
read-write and you would rather it be unmounted properly.

Do **not** just `reboot` from that shell; with no init running it may not do what
you expect.

---

## 5. Verify you did not break the vendor's app

This is the step people skip. Do it — the whole house runs on this box, and you
want to know now rather than when somebody's lights stop working.

```bash
ssh abneo@<hub-ip>
sudo whoami                     # -> root, so the sudo group took
systemctl is-active tistron_backend
ss -ltnp | grep -E ':(8090|22|21)\b'
```

You want the vendor's service active and `:8090` listening. Then ask the app
itself:

```bash
curl -s -H "Host: <hub-ip>:8090" http://127.0.0.1:8090/authenticate/getversion/
```

**A `DisallowedHost` debug page means the app is working, not broken.** Django's
`ALLOWED_HOSTS` lists only the hub's LAN address, so a plain `localhost` request
is refused by design — that is why the `Host:` header is there. With the header
you get clean JSON.

Also confirm from a phone that the vendor's own app still controls the lights. A
password reset cannot affect it, but a five-second check closes the question.

---

## 6. Then, and only then, install the dashboard

Two traps on this hardware, both already paid for once:

- **Leave the system `node` alone.** This box shipped Ubuntu's `nodejs` v10.19,
  which is far too old for the dashboard — but something pre-existing depends on
  it. Install a modern Node *alongside*, at `/opt/nodejs`:

  ```bash
  curl -fsSLO https://nodejs.org/dist/v18.20.4/node-v18.20.4-linux-x64.tar.xz
  sudo mkdir -p /opt/nodejs
  sudo tar -xJf node-v18.20.4-linux-x64.tar.xz -C /opt/nodejs --strip-components=1
  /opt/nodejs/bin/node -v
  ```

  `deploy/bootstrap.sh` does this for you and checks the CPU first — see the note
  in `CLAUDE.md` about why this is Node and not Bun.

- **Do not re-run `install.sh` on a box that already has the service.** If it
  cannot get an interactive sudo to write `/etc/systemd/system/`, it silently
  falls back to a *user* service — and you end up with two copies fighting over
  port 3000, the new one retrying forever. That happened here. Edit the unit in
  `/etc/systemd/system/` with a real sudo instead.

Then:

```bash
bash deploy/bootstrap.sh              # a dry run: says what it would do
bash deploy/bootstrap.sh --go         # actually install
```

and finish in a browser at `http://<hub-ip>:<port>/setup`.

---

## If GRUB is not available to you

- **USB live boot → chroot.** Boot any Ubuntu live USB, mount the root
  partition, `chroot` into it, `passwd abneo`. Slower but identical in effect,
  and it is the route when the GRUB menu is locked down.
- **BIOS password set.** Clear it with the mainboard jumper (an OptiPlex 3020 has
  one; the service manual names it) or pull the disk and reset the password from
  another machine.
- **Encrypted disk.** Stop — this needs the passphrase, and there is no way
  around it. Go back to the dealer.

## What this does not get you

The vendor's own `:8090` HTTP API has **no authentication at all** and never
did, so OS access is not what stands between anyone and the lights. What the
login buys is the ability to *run our own software on the box* — which is the
only reason to want it. Worth saying plainly to an owner who asks why you need
it.
