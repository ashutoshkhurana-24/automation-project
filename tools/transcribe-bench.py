"""Which model should turn the recording into words.

Scored on the thing that actually matters here, which is not "was it a good
transcript" but **did it come back in a shape the house can use**: romanised
Latin, the house's own names spelled as the grammar spells them, and spoken
numbers as digits. A perfect Devanagari transcript is worth nothing downstream.
"""
import json, mimetypes, os, re, subprocess, sys, time, urllib.request, urllib.error

KEY = open('/home/abneo/dashboard/data/openai-key').read().strip()
URL = "https://api.openai.com/v1/audio/transcriptions"

# The vocabulary hint the server sends, in the same shape.
PROMPT = ('Short home-automation commands, in Hinglish or English, spoken by an '
          'Indian speaker. Write them in romanised Latin script only — never in Devanagari '
          'or Urdu script. Spoken numbers are written as digits: chalees is 40, bees is 20, '
          'saath is 60, sattar is 70, forty is 40, sixty is 60. '
          'Room names: Ashu Room, Master Room, Living, Dining, Parent Room, Harshit Room, '
          'Kanu Room, Home Theatre. '
          'Things in them: ac, bed spot, ceiling rope, cob 1, cob 2, cob 3, cob 4, cob 5, '
          'cobs, curtain rope, fan, foot light, hanging, main curtain, profile, projector, '
          'sheer curtain, tv. '
          'Words that may be spoken: on, off, up, down, warm, cool, warmer, cooler, open, '
          'close, stop, volume, mute, unmute, cancel, wapas, pankha, parda, chalu karo, '
          'band karo, khol do, kya chalu hai.')

CLIPS = [
    ("/tmp/c1.m4a",   "ashu ka fan chalu karo"),
    ("/tmp/c2.m4a",   "master room ke cobs full kar do"),
    ("/tmp/c3.m4a",   "ashu room ka ac chalu karo"),
    ("/tmp/q1.m4a",   "master room mein kya on hai"),
    ("/tmp/a1.wav",   "ashu room ka fan chalu rakho"),
    ("/tmp/hard.wav", "living room ka main curtain khol do aur dining ke cobs thoda kam kar do"),
]

DEVANAGARI = re.compile(r'[ऀ-ॿ؀-ۿ]')
words = lambda t: [w for w in re.split(r'[^a-z0-9]+', t.lower()) if w]

def post(path, model, prompt):
    boundary = '----bench'
    body = b''
    def field(name, value):
        return ('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n'
                % (boundary, name, value)).encode()
    body += field('model', model)
    if prompt:
        body += field('prompt', prompt)
    data = open(path, 'rb').read()
    ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
    body += ('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\n'
             'Content-Type: %s\r\n\r\n' % (boundary, os.path.basename(path), ctype)).encode()
    body += data + ('\r\n--%s--\r\n' % boundary).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Authorization": "Bearer " + KEY,
        "Content-Type": "multipart/form-data; boundary=" + boundary})
    t = time.time()
    try:
        r = json.load(urllib.request.urlopen(req, timeout=60))
        return r.get("text", ""), time.time() - t, None
    except urllib.error.HTTPError as e:
        return "", time.time() - t, e.read().decode()[:90].replace("\n", " ")

for model in (sys.argv[1:] or ["gpt-4o-transcribe"]):
    hits = tot = exact = 0
    bad_script = 0
    times = []
    lines = []
    for path, want in CLIPS:
        got, dt, err = post(path, model, PROMPT)
        times.append(dt)
        if err:
            lines.append("      %-14s ERROR %s" % (os.path.basename(path), err))
            tot += len(words(want))
            continue
        if DEVANAGARI.search(got):
            bad_script += 1
        w_want, w_got = words(want), set(words(got))
        hit = sum(1 for w in w_want if w in w_got)
        hits += hit; tot += len(w_want)
        if words(got) == w_want:
            exact += 1
        lines.append("      %-14s %2d/%-2d  %s" % (os.path.basename(path), hit, len(w_want), got.strip()[:74]))
    times.sort()
    print("%-24s recall %3d/%-3d (%d%%)  exact %d/%d  non-latin %d  median %.2fs"
          % (model, hits, tot, round(100 * hits / max(tot, 1)), exact, len(CLIPS), bad_script,
             times[len(times) // 2]))
    for l in lines:
        print(l)
    print()
