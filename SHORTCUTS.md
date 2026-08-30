# Siri, widgets and one-tap shortcuts

The dashboard exposes a few plain endpoints so the house can be reached without
opening a browser — from Siri, a Home Screen widget, the Lock Screen, or a Back
Tap on the back of the phone.

Everything here works only on the home Wi-Fi. The hub is LAN-only, so this is
not remote control.

## One address for everything: `/do`

**Open `/do` in a browser for the live version of this section.** It lists every
room, every circuit, what each one is wired to and therefore which of the
actions below it will actually accept — read off the running house rather than
written down here, so it cannot go stale. `curl` and Shortcuts still get the
JSON they always did.

A cue is the right shape for "good night". It is the wrong shape for "just the
fan", or "a bit dimmer" — you do not want a saved cue for every circuit at every
level. So every circuit in the house also has a plain address you can type from
memory:

```
/do/<room>/<circuit>/<action>
```

```
http://192.168.1.3:3000/do/ashu/fan/on
http://192.168.1.3:3000/do/ashu/cobs/down
http://192.168.1.3:3000/do/ashu/cobs/40
http://192.168.1.3:3000/do/living/main-curtain/open
http://192.168.1.3:3000/do/master/off          ← the whole room
http://192.168.1.3:3000/do/house/off           ← the whole house
http://192.168.1.3:3000/do/house/acs/off       ← every AC, and nothing else
http://192.168.1.3:3000/do/cue/movie-night
```

**Rooms and circuits are the names on screen**, lowercased with hyphens, and any
**unambiguous prefix** works — `/do/ashu/foot/off` finds Ashu Room's Foot Light.
Three collective names exist in every room: `all`, `lights` and `cobs`.

**A room can answer to a second name.** `config.room_aliases` maps a spoken name
onto a room, so Harshit Room also answers to `kanu`:

```
http://192.168.1.3:3000/do/kanu-room/lights/off
http://192.168.1.3:3000/do/kanu/lights/off      ← a prefix, as usual
```

It is a way **in** only. Every reply, the board, the family guide and the history
log keep the hub's own name, so *"kanu room ki light band kar do"* is answered
with *"The lights in Harshit Room are now off."* One room is never two names in
the record. An alias that would shadow a real room's name is ignored rather than
honoured — it would make that room ambiguous and refuse every command to it.

### The whole house takes a kind

`house` is a room meaning all of them, and it carries a circuit word like any
other room. Four kinds reach across the house:

| | |
|---|---|
| `/do/house/lights/off` | every light — the fans and the ACs keep running |
| `/do/house/fans/off` | every fan |
| `/do/house/curtains/close` | every curtain (`open`, `close` or `stop` only) |
| `/do/house/acs/off` | every air conditioner, the relay one included |
| `/do/house/all/off` | everything except the curtains, which is what `/do/house/off` has always meant |

**A word it cannot honour is a 404, not the whole house.** `/do/house/cobs/off`
and `/do/house/anything/off` refuse and name the four kinds. That is worth
knowing because it did not always: the house address used to read the room and
**throw the circuit word away**, so every one of those switched off all
eighty-eight circuits and reported success. If a shortcut of yours relied on
that, it was not doing what it said.

### The actions

| | |
|---|---|
| `on` `off` `toggle` | The obvious ones. `toggle` reads the hub first, so it is never backwards |
| `0`–`100` | A brightness, e.g. `/do/ashu/cobs/35` |
| `up` `down` | 20% brighter or dimmer **than it is now** — press it again to go further |
| `warmth-0`–`warmth-100` | An exact colour, e.g. `/do/ashu/cobs/warmth-70`. `tune-70` works too |
| `warm` `cool` | Shorthand for `warmth-85` and `warmth-15` |
| `warmer` `cooler` | 15 points at a time, same idea as `up`/`down` |
| `open` `close` `stop` | Curtains only — they take nothing else |

A bare number is always **brightness**, because that is what a number means to
anyone typing one. Colour has to say so — hence `warmth-70`. The two are sent
down separate channels, so setting one never disturbs the other, and asking a
lamp with no second channel for a colour is an error rather than a quiet
success: `/do/ashu/foot-light/warm` → *"Foot light cannot change colour"*.

On this hub **0 is cool and 100 is warm**, which is the opposite of the
kelvin-based scales elsewhere. `spoken` says the colour rather than the number,
since "sixty-one" means nothing read aloud.

`up` and `down` are the ones worth building shortcuts for. One shortcut you press
three times beats three shortcuts naming fixed levels, and it is the natural
thing to say to Siri: *"dim the COBs"*.

### Finding the address you want

`GET /do` lists every room, every circuit and every action. `GET /do/<room>`
lists one room with what each circuit is doing right now:

```bash
curl -s http://192.168.1.3:3000/do/ashu
```

```json
{"room":"ashu-room","circuits":[
  {"circuit":"cobs","level":60,"tune":61,"circuits":5},
  {"circuit":"fan","level":100,"tune":null,"circuits":1}, …]}
```

Mistype one and the error tells you what was valid — that list is the point of
the error, since a wrong URL in Shortcuts is otherwise silent.

## The endpoints

| | |
|---|---|
| `GET/POST /do/:room/:circuit/:action` | One circuit, or a group of them |
| `GET/POST /do/:room/:action` | Everything in a room |
| `GET/POST /do/cue/:id` | Run a cue |
| `GET /do` · `GET /do/:room` | What can be addressed, and its state |
| `GET/POST /api/cue/:id/fire` | Run a cue (the older address, still live) |
| `GET/POST /api/house/off` | Switch off everything that is on |
| `GET /api/cues` | List the cues, with their ids |

They answer to `GET` as well as `POST` because a widget or a bookmark can only
manage a `GET`. Each reply carries a `spoken` field — a sentence rather than a
count — which is what Siri should read back.

One caveat that is not the API's fault: an **air conditioner is infrared**, so
`/do/ashu/ac/on` blasts the code and the hub never hears back. The reply says
what was sent, not what the unit is doing.

## Cue ids — the naming convention

Every cue has an **api id**, shown in small type on its card in the dashboard and
in its edit sheet. That id is the cue's address, and it is what every shortcut,
widget and cron line uses:

```
http://192.168.1.3:3000/api/cue/<api id>/fire
```

The id is made from the name once, lowercased with spaces as hyphens —
`Good Night · Ashu` becomes `ashu-good-night` — and then **it never changes**.
Renaming a cue keeps its id, so a shortcut you built months ago keeps working.
Cue names are unique, case-insensitively, so an id is never ambiguous.

Read them off the cards, or list them all:

```bash
curl -s http://192.168.1.3:3000/api/cues
```

```json
{"cues":[{"id":"ashu-good-night","name":"Good Night · Ashu","circuits":11}, …]}
```

The dashboard now runs on the hub itself at **`192.168.1.3:3000`**, so these work
with the Mac shut. (Older recipes pointing at the Mac's address still work while
it is awake, but the hub is the stable one — it cannot move.)

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

## Speaking to the house

`POST /api/say` takes a sentence and answers with a sentence. The phone does the
listening and the talking — both free, both on-device — and the hub does the
understanding.

**The shortcut is three actions.** No API key on the phone, no JSON to unpick.

| | Action | Settings |
|---|---|---|
| 1 | **Record Audio** | Stop Recording: whichever suits you — *After a set duration* is one tap, *On Tap* lets a long sentence finish |
| 2 | **Get Contents of URL** | `http://100.x.y.z:3000/api/hear?who=ashu` · Method **POST** · Header `Content-Type: audio/m4a` · Request Body **File**: *Recorded Audio* |
| 3 | **Speak Text** | *Get Dictionary Value* `spoken` from *Contents of URL* |

**Why the recording rather than iOS dictation.** `Dictate Text` is on-device and
monolingual: it has no notion of a code-mixed sentence, and no way to be told that
this house contains a cob, an Ashu or a parda. The hub sends the audio to a
transcriber along with the house's own vocabulary, which is the part no on-device
dictation can do.

Measured against synthesised Indian-accented Hinglish — five commands, scored on
word recall:

| | no vocabulary | with the house's |
|---|---|---|
| `gpt-4o-mini-transcribe` | 7/30 | 13/30 |
| `whisper-1` | 12/30 | 22/30 |
| **`gpt-4o-transcribe`** | 4/30 | **25/30** |

Two things matter more than those numbers. **The failure is script, not accuracy**:
asked cold, every model returned Devanagari or Urdu — *"आशू रूम का फैन चालू करो"*
is a perfect transcript and useless here, because the grammar matches `ashu`
against a room slug. And **spoken numbers have to be asked for as digits**, or
"forty" comes back as **41** — which is the error worth paying an endpoint to
avoid. Both are in the prompt.

The upshot is that it can be *faster* than dictation was, not slower: a clean
`ashu cobs 40 warm` lands on the free grammar path and never reaches the model at
all. Roughly ₹0.03 a command, and about a second of transcription.

`who` is a query parameter here rather than a body field, because the body is the
audio. It is a fixed piece of text you type once per phone — `ashu`, `mum`, `dad` —
and exists only so **cancel** puts back what *that* phone said. Leave it off and
those phones share one cancel slot.

**`/api/say` is unchanged**, so a typed or dictated shortcut still works exactly as
before. Anything that speaks — a transcript, a typed line, the command bar — meets
the same grammar, the same cancel gate, the same two Hindi nouns and the same
speech pass, because both endpoints go through one function.

The **tailnet** address rather than `192.168.1.3` so the same shortcut works at
home and away — your iPhone is already a node on it. On the home Wi-Fi either
address is fine.

**Triggering it without a wake word.** Settings → Accessibility → Touch → **Back
Tap** → *Double Tap* → your shortcut. On a 15 Pro or later the **Action Button**
is better: tactile, no misfires, and it works from the Lock Screen. Triple tap is
noticeably less prone to firing in a pocket than double.

This is deliberately **not** Siri: the shortcut hands over raw audio with no
intent-matching in front of it, so "turn off the lights" cannot be captured by
HomeKit and a shortcut name never has to be recognised. It also means the phone is
doing nothing but recording and speaking — every judgement about what was said
happens on the hub, where the house's own names are.

### What you can say

Hinglish is the expected case. Room and circuit names stay English, because they
are the installer's own labels.

```
living room ki light band kar do
ashu ka fan chalu karo
sab band karo
cobs thoda kam karo
ashu ki cob peeli kar do
main curtain band karo
ashu ka TV band kar do
theatre ka AVR thoda tez karo
movie night laga do
```

Terse English works too, and never leaves the box — `living off`,
`ashu cobs 40`, `master warmth-70` are the same grammar the dashboard's own
command bar takes, so they resolve on the hub in about 200ms with no model call
and no cost. Everything else goes to the model, which is what reads the Hindi.

### One kind, across the whole house

*"Saare AC band kardo"* switches off every air conditioner and leaves the lights
alone. Four kinds work this way — the lights, the fans, the curtains and the air
conditioners — and each touches only its own kind:

```
saare AC band kardo
saare pankhe band karo
turn off all the lights
saare parde band kar do
sab band kar do            ← this one really is the whole house
```

**It will not answer a kind with the whole house.** That is not a nicety: the
sentence at the top of that list once switched off every light in the house at
half past seven in the evening, because the address behind it read the room and
discarded the word `acs`. Both halves are fixed — the address honours the kind,
and a kind it does not know is refused rather than widened. `cobs` and `tv` are
deliberately refused house-wide, because a cob is a room's business.

### Two Hindi nouns that work

`pankha` and `parda` resolve, so *"ashu ka pankha band karo"* and *"living ka
parda khol do"* are addresses rather than sentences the model has to interpret.

**They resolve by kind, never by name**, and that is the whole design. Aliasing
`parda` to the word "curtain" would be matched as a prefix, and in LIVING the only
circuit *starting* with it is CURTAIN ROPE — **a light**, sitting beside two
motors that are not. So the words select on `app_type`, which means:

| | |
|---|---|
| a room with one | it just works |
| a room with two (Living) | *"There is more than one curtain in Living. Say main curtain or sheer curtain."* |
| a room with none (Ashu) | *"There is no curtain in Ashu Room."* — rather than the rope |

**Only these two.** Every other Hindi noun stays out, deliberately: a table of
them is a table of guesses, and a guess that happens to resolve switches something
on in a room somebody is sitting in. `batti` does not work; `light` and `cob` do.

**The model translates them on its own, and had to be stopped.** Measured on the
live house before the guard was in place: *"Ashu ka parda khol do"* came back as
circuit `curtain-rope` and **switched a light on**, and *"Living ka parda khol
do"* picked one of the two curtains and opened it rather than asking. So where the
sentence carries one of the two words, the model's choice of circuit is discarded
and the word is passed through — leaving one authority for them on every road,
including `/do/<room>/parda/open` and the reading path.

### Asking, not just telling

Questions work as well as commands, and the reply is a reading rather than a
guess:

```
living room mein kya chalu hai
kya sab band hai
ashu ka fan chal raha hai
ashu ka TV chal raha hai
theatre mein kya baj raha hai
what is on
```

**What comes back depends on what the hardware can honestly say**, which is the
one thing worth knowing about these answers:

| you ask about | you get | because |
|---|---|---|
| a lamp, a fan, a relay | *"Ashu Room mein Cob 1 40% par hai, warm"* | the module reports back, so this is a reading |
| a television | *"Ashu Room mein TV on hai, YouTube chal raha hai, volume 12"* | the set answers for itself over SSAP |
| the receiver | *"Home Theatre mein AVR on hai, PS5 chal raha hai, 45 par"* | it states its own volume and source |
| an infrared air conditioner or the projector | *"hub ne AC on bheja tha, check nahi kar sakta"* | infrared is one-way — this is the hub's own note, not a reading |
| a curtain | *"Main Curtain ki position pata nahi chalti"* | a curtain tells the hub nothing, ever |

A room with nothing on says so *and* mentions that the infrared units cannot be
checked, because "nothing is on" would otherwise be a stronger claim than the
house can support.

Where a whole group is on at one level it is named as a group — *"Living mein
COBs on hain"* rather than eleven separate clauses, which took about fifteen
seconds to read out and nobody listened past the third.

**The reply is English, whatever the request was written in**, because the phone
has to read it out and iOS `Speak Text` cannot say Hinglish — it was built,
tested against the voice and rejected on exactly that. Hinglish *input* is
untouched and is still the expected case.

It is also plain English rather than /do's, and reworded for the voice in one
pass: a full sentence rather than a caption (*"Foot light in Ashu Room is now
off"*), no em dashes, `COBs` lower-cased so it is not spelled out letter by
letter, `AVR` said as *receiver*, and contractions. `/do` keeps its own wording,
which every cron line and shortcut here was written against; the original travels
in the reply as `said` if you need to trace one.

It is honest about failure too: a room it does not know, a circuit that could be
two things, a colour asked of a lamp with no second channel, or a hub that did
not answer all come back as a sentence you can hear rather than as silence.

`node tools/say-speech-review.js` prints every sentence the endpoint can produce,
as written and as spoken, and fails on anything the voice reads badly.

### Taking one step back

Say **cancel** and the last thing *you* said is put back:

```
cancel            wapas karo        galat
undo              nahi nahi         ulta karo
never mind        pehle jaisa       put it back
```

Matched before the grammar and long before the model, so it costs no network
call and cannot be mistaken for an address — nothing in this house is named any
of these words. `nahi` has to be doubled, so "nahi, fan band karo" stays a
command with a correction in front of it rather than being swallowed.

**Per phone, not per house.** With `who` set, your cancel reverses your own last
command and nobody else's — several people speak to this place, and a shared slot
would mean the thing you undo is whatever somebody else said last.

**One step, and five minutes.** Cancel does not become a new cancel point, so a
second one says there is nothing left. Past five minutes the snapshot is
discarded rather than trusted: the house has probably moved on.

What it can and cannot put back, which is the whole of the honesty here:

| what you said | what cancel does |
|---|---|
| lights, fans, relays, a whole room, a cue | reads the levels before the write and restores them — *"the cobs in Living are back as they were"* |
| a curtain open or close | **reverses the verb** and says so: *"Closing Main Curtain again. It has no position to report, so this isn't exactly where it was."* |
| a curtain stop | refuses — stop has no opposite |
| a television or receiver volume, mute | exact, because a set reports its own state — *"Ashu TV volume is back to 12"* |
| a television on or off | **refuses, and explains why**: switching it back on lands on the home screen, not on what was playing |

Only what was *spoken*. `/do`, a cron line and the dashboard leave no cancel
point — a URL firing at 07:15 is not something anybody is about to say "cancel"
at, and capturing for them would cost every one of those a hub read.

A refusal or a question never overwrites the slot, so asking "what is on" between
the command and the cancel is safe.

### Saying it so it lands

You do not have to talk like a manual. But three habits make the difference
between a sentence that works every time and one that sometimes needs repeating.

**Name the room.** There is no notion of "this room" — the phone does not know
where you are standing, and neither does the hub. *"fan band karo"* has to be
guessed at; *"ashu ka fan band karo"* cannot be got wrong.

**Name the thing in English.** Verbs in Hindi, nouns in English — which is how
Hinglish already works, and it happens to match the house: `cobs`, `foot light`,
`main curtain` are the installer's own labels and the only names the hub knows.
Every one of them is listed in the family guide below, which is generated from the
house so it cannot drift.

**One thing per sentence.** *"ashu ki light aur fan band karo"* asks for two
switches and will get one. Say it twice; each takes about a second.

That is the whole of it. Beyond those, say it however you like — *please*,
*kindly*, *thoda*, *zara*, *kar do*, *kar dena* all land, and word order is
loose.

**What each phrasing costs.** Two to four words of terse English never leave the
box — they hit a grammar on the hub, resolve in about 200 ms, and cost nothing.
Everything else goes to the model, which is what reads the Hindi, and takes about
a second.

| you say | how it goes | note |
|---|---|---|
| `living off` | free | room + action |
| `ashu cobs 40` | free | room + circuit + level |
| `turn off the living lights` | free | *turn*, *the* are filler and drop out |
| `master warmth-70` | free | the hyphen matters — `warmth 70` is two words |
| `living room ki light band kar do` | model | too many words for the grammar |
| `ashu mein kya chalu hai` | model | every question goes to the model |

**Prefixes are enough, until they are not.** `ashu` finds ASHU ROOM and `cob`
finds the cobs, because a unique prefix matches. Where two things share one, the
hub says so rather than picking — ask Living for `a` and it answers *"Living mein
ye all ya ac ho sakta hai — kaunsa?"*. Give it one more letter.

**Numbers mean brightness**, or volume on a screen. `40` is 40% bright;
`warmth-40` is colour, where 0 is cool and 100 is warm. *garam*, *peela* and
*warm* all mean warm.

**A curtain only opens, closes or stops.** *"main curtain band karo"* closes it —
"band" on a curtain is understood as close, not off. It reports nothing back, so
there is never a position to ask for.

**A television takes power and volume, and nothing cleverer.** on, off, volume,
louder, quieter, mute. *"netflix laga do"* will tell you the app has to be picked
on the board — launching one needs a name in the request, which a spoken address
has nowhere to put.

**The receiver answers to *receiver* as well as to *AVR*.** Its record is named
AVR and the reply calls it a receiver, so it has to accept both — a device that
is named one thing and spoken about as another has a name nobody can guess.

**Questions never change anything.** *"kya chalu hai"*, *"AC chal raha hai"*,
*"TV band hai"* are all read as questions, and a question is never allowed near
the terse grammar — it always goes to the model, which is the half that knows the
difference. That guard is why *"is the ashu fan on"* answers instead of switching
the fan on, which is what it used to do. If you want something switched, use a
verb: *"band karo"*, not *"band hai"*.

### The guide for everybody else

**It is on the dashboard at `/guide`** — `http://192.168.1.3:3000/guide` — built
fresh on every request, so it is never out of date with the house. That is the
link to give anybody at home.

`data/speaking-to-the-house.html` is a single self-contained page to send to the
family: how to phrase things, every circuit in every room with what each one can
actually do, and what each refusal means. No setup instructions — their phones get
set up for them — and no network requests, so it opens from Messages or Files with
no Wi-Fi and adapts to a dark phone.

**English for everything explained, Hinglish for everything said.** The prose,
the headings and the troubleshooting advice are English, because an instruction is
*read* and reads better in one language. The only Hinglish on the page is the
phrases themselves — the things you actually say out loud — and they are drawn as
filled speech bubbles so they cannot be mistaken for prose. A circuit name is an
outlined chip instead, since a name is a word *inside* a sentence rather than a
whole one.

Three things stay English inside the phrases too, and each is load-bearing:

- **Every room and circuit name.** They are the installer's labels and the only
  names the hub knows, so this is the page's loudest line: *pankha* will not work,
  *fan* will. A guide that let somebody infer Hindi nouns would teach a command
  that fails.
- **The left column of the troubleshooting table**, which is the exact English the
  phone speaks. They have to match what they heard, word for word.
- **The action words** — `on`, `off`, `up`, `down`, `warm`, `cool`, a number —
  since those are the free grammar path.

**Every room is collapsed behind a `<details>`.** A reference is scrolled *past*
far more often than it is read, and seven stacked tables of eight rows each is the
version nobody scrolls to the end of. Nothing is left out — a name missing from
this page is a name somebody has to guess — it just opens at a tap, natively, with
no script on the page at all. Each room carries its own hue, which is doing real
work: the family find their own room by its colour before they read the word.

```bash
node tools/make-guide.js http://192.168.1.3:3000
```

It reads a **running** server rather than `devices.json`, because `/do/<room>`
already resolves each circuit's kind and the actions it will take by reading the
dispatch — deriving that a second time is how a guide starts quietly lying, which
is worse than no guide when the whole point is that nobody has to guess a name.
Re-run it after a vendor visit or a rename.

Two things it does deliberately. Eleven rows reading *cob 1 … cob 11* fold to one,
the same reasoning as folding them in a spoken answer: nobody reads to the end.
And it **drops the hub's shadowed television record**, which `/do` still addresses
on purpose — offering it to somebody who does not know the difference is the one
thing this page must not do, since commanding it moves a database row, answers as
though it worked, and the set carries on playing.

### Setting it up on the hub

The key lives in one file on the box, mode 600, and never on any phone:

```bash
ssh abneo@192.168.1.3
umask 077 && cat > ~/dashboard/data/openai-key    # paste the key, then Ctrl-D
sudo -n systemctl restart neo-dashboard
```

**Put a spend cap on that key.** This hub has FTP open on port 21 and an
unauthenticated vendor API on 8090, so a billing limit is the mitigation that
actually holds — not the file mode.

Optional, in `config.json`: `"openai_model": "gpt-5.6-luna"` is the default and
costs roughly 10–15p a month at household volumes, since the grammar catches the
common commands for nothing. `OPENAI_API_KEY` and `OPENAI_MODEL` in the
environment both win over the file, which is how a test instance runs without
touching the house's key.

With no key set the endpoint still works for the terse English commands and says
*"No model key is set on the hub"* for anything else.

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
