"""Which model should read the house's spoken commands.

Runs the same tool-calling task /api/say runs, against this house's own rooms
and circuits, over several candidate models — scoring what each one resolves to,
how long it took, and what it cost. Nothing is switched: only the model is
asked, and its answer is compared, never executed.

    node tools/... no — python3 tools/model-bench.py gpt-5.6-luna gpt-4o-mini

Run it **on the hub**, which is where the key is.

READ THIS BEFORE BELIEVING A RESULT. The prompt below is a *reconstruction* of
sayPrompt(), built from /do so that nothing has to be added to the server for a
benchmark. It is close but not identical, and on 2026-08-27 that difference
produced a false negative loud enough to have changed a model: gpt-5.6-luna
answered "ashu ka ac chal raha hai" — a question — with `control ac on` in two
runs of four, which reads as the model turning a question into a command. The
production prompt carries one more sentence ("Do not answer the question
yourself — call `look`"), and against the real endpoint the same sentence
answered correctly **eight times out of eight**.

So this ranks models against each other. It does not measure production. Confirm
anything that would change a model against /api/say itself, choosing a sentence
that cannot disturb the house — the AC already on, a room already dark.

The endpoint matters too: gpt-5.6-luna cannot use tools on /v1/chat/completions
at all ("Function tools with reasoning_effort are not supported"), so this
speaks /v1/responses, which is what server.js speaks.
"""
import json, sys, time, urllib.request, urllib.error

KEY = open('/home/abneo/dashboard/data/openai-key').read().strip()
BASE = 'http://127.0.0.1:3000'

def get(path):
    return json.load(urllib.request.urlopen(BASE + path, timeout=20))

# The prompt the server builds, reconstructed from the same facts it uses: every
# room, every circuit and what each one is. Rebuilt here rather than exported so
# nothing has to be added to the server for a benchmark; it is faithful enough
# that a comparison *between* models holds, which is the question being asked.
grammar = get('/do')
rooms_desc = []
for r in grammar['rooms']:
    # 'house' is an address, not a room with a listing — /do/house is a 404.
    if r['room'] == 'house':
        continue
    detail = get('/do/' + r['room'])
    cs = ', '.join(c['circuit'] + ' (' + c['kind'] + ')' for c in detail['circuits'])
    rooms_desc.append('  ' + r['room'] + ': ' + cs)
cues = [c['id'] for c in get('/api/cues').get('cues', [])]

PROMPT = '\n'.join([
    'You turn a spoken command into exactly one tool call for a home in India.',
    '',
    'The speaker uses Hinglish — Hindi written in Latin script, mixed with English.',
    'Room and circuit names are always English, because they are the installer’s',
    'own labels. Read the Hindi for the verb and the English for the thing.',
    'Examples: "living room ki light band kar do" = the lights in living, off.',
    '"ashu ka fan chalu karo" = the fan in ashu, on. "sab band karo" = house, all, off.',
    '"cobs thoda kam karo" = that room’s cobs, down. "garam" or "peela" means warm.',
    '',
    'Rooms and what is wired in each:',
    '\n'.join(rooms_desc),
    '',
    'Saved scenes: ' + (', '.join(cues) if cues else '(none)'),
    '',
    'Rules. Pick the circuit whose slug best matches what was said; use "all" for a',
    'whole room and room "house" for the entire home. A curtain takes only open,',
    'close or stop — "band karo" on a curtain means close, not off. Only a tunable',
    'light takes warmth.',
    '',
    'A television or receiver takes on, off, toggle, up, down, mute, unmute, or a',
    'number — which is its volume, not a brightness.',
    '',
    'It cannot be sent an app, a channel or a source. When the request names one,',
    'do not call a tool at all. Answer in one sentence that only power and volume',
    'are wired and the app has to be picked on the board.',
    '',
    'A question is not a command: "kya chalu hai", "what is on", "is the fan',
    'running" all want `look`, never `control`.',
    '',
    'If the request is neither a command nor a question about this house, do not',
    'call a tool: reply with one short sentence saying you can only control and',
    'report on this house.',
])

ROOM_ENUM = [r['room'] for r in grammar['rooms']] + ['house']
# The Responses API takes a flat tool shape, and that is what server.js sends.
# gpt-5.6-luna cannot do tools on /v1/chat/completions at all — it answers
# "Function tools with reasoning_effort are not supported" — so the benchmark
# has to speak the same endpoint production does or it is measuring nothing.
TOOLS = [
    {"type": "function", "name": "control",
     "description": "Switch, dim or colour one circuit, a named group, a television, the receiver, or a whole room.",
     "parameters": {"type": "object", "properties": {
        "room": {"type": "string", "enum": ROOM_ENUM},
        "circuit": {"type": "string", "description": "A circuit or group slug from the list for that room. \"all\" for the whole room. With room \"house\": lights, fans, curtains or acs for one kind everywhere."},
        "action": {"type": "string", "description": "One of: " + ', '.join(grammar['actions']) + ". A bare 0-100 is brightness, or volume on a screen. warmth-0-100 is colour. Two may be joined with +."}},
        "required": ["room", "circuit", "action"], "additionalProperties": False}},
    {"type": "function", "name": "look",
     "description": "Answer a question about what is on right now.",
     "parameters": {"type": "object", "properties": {
        "room": {"type": "string"}, "circuit": {"type": "string"}}, "required": []}},
    {"type": "function", "name": "cue",
     "description": "Fire a saved scene.",
     "parameters": {"type": "object", "properties": {
        "id": {"type": "string"}, "action": {"type": "string"}}, "required": ["id"]}},
]

# [sentence, acceptable answers]. A list, because more than one reading is often
# defensible and marking a model wrong for a good answer would rank them badly.
# "-" means: no tool call at all, which is itself the right answer twice here.
CASES = [
    ("saare ac band kar do",              ["control house acs off"]),
    ("sab band karo",                     ["control house all off"]),
    ("master room ki light band kar do",  ["control master-room lights off", "control master-room all off"]),
    ("living ka main curtain khol do",    ["control living main-curtain open"]),
    ("ashu mein bed spot jala do",        ["control ashu-room bed-spot on"]),
    ("ashu ke cobs thoda garam kar do",   ["control ashu-room cobs warmer", "control ashu-room cobs warm"]),
    ("dining ke cobs aadhe kar do",       ["control dining cobs 50"]),
    ("harshit ka pankha band kar do",     ["control harshit-room fan off"]),
    ("ashu ke cobs poore kar do",         ["control ashu-room cobs 100"]),
    ("parent room ka ac chalu kar do",    ["control parent-room ac on"]),
    ("kya chalu hai",                     ["look"]),
    ("ashu room mein kya chalu hai",      ["look ashu-room", "look ashu-room all"]),
    ("is the ashu fan on",                ["look ashu-room fan"]),
    ("ashu ka ac chal raha hai",          ["look ashu-room ac"]),
    ("netflix laga do ashu tv par",       ["-"]),
    ("tell me a joke",                    ["-"]),
    ("living aur dining band kar do",     ["control living all off + control dining all off"]),
]

MODELS = sys.argv[1:] or ["gpt-5.6-luna"]

def ask(model, text, effort=True):
    body = {"model": model, "instructions": PROMPT,
            "input": [{"role": "user", "content": text}],
            "tools": TOOLS, "tool_choice": "auto"}
    if effort:
        body["reasoning"] = {"effort": "none"}
    req = urllib.request.Request(BASE_OPENAI, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    t = time.time()
    try:
        r = json.load(urllib.request.urlopen(req, timeout=45))
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        # Not every model takes a reasoning effort; drop it and ask again rather
        # than scoring the model zero for a parameter it never claimed.
        if effort and 'reasoning' in detail:
            return ask(model, text, effort=False)
        return None, time.time() - t, None, detail[:110].replace("\n", " ")
    dt = time.time() - t
    calls = []
    for item in r.get("output", []):
        if item.get("type") != "function_call":
            continue
        try: a = json.loads(item.get("arguments") or "{}")
        except Exception: a = {}
        if item.get("name") == "control":
            calls.append("control %s %s %s" % (a.get("room"), a.get("circuit"), a.get("action")))
        elif item.get("name") == "look":
            calls.append(("look %s %s" % (a.get("room", ""), a.get("circuit", ""))).strip())
        else:
            calls.append("cue %s" % a.get("id"))
    got = " + ".join(calls) if calls else "-"
    return got, dt, r.get("usage", {}), None

BASE_OPENAI = "https://api.openai.com/v1/responses"

print("prompt is %d characters\n" % len(PROMPT))
for model in MODELS:
    ok = 0; times = []; tin = 0; tout = 0; wrong = []
    for text, want in CASES:
        got, dt, usage, err = ask(model, text)
        if err:
            wrong.append((text, want[0], "HTTP " + err)); times.append(dt); continue
        times.append(dt)
        if usage:
            tin += usage.get("input_tokens", 0); tout += usage.get("output_tokens", 0)
        # a look with extra detail is still a look
        hit = any(got == w or (w == "look" and got.startswith("look")) for w in want)
        if hit: ok += 1
        else: wrong.append((text, " | ".join(want), got))
    times.sort()
    med = times[len(times) // 2]
    print("%-16s %2d/%-2d  median %.2fs  max %.2fs  tokens %d in / %d out"
          % (model, ok, len(CASES), med, times[-1], tin, tout))
    for w in wrong:
        print("      miss: %-34s want %-42s got %s" % (w[0][:34], w[1][:42], w[2]))
    print()
