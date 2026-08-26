"""What does gpt-transcribe actually listen to?

The model page says it takes "unstructured context, keyword hints, and multiple
language hints" — three things, where only one of them is the `prompt` this
project sends. So the question is not how to word the prompt but which field
carries the hint.
"""
import json, mimetypes, os, urllib.request, urllib.error
KEY = open('/home/abneo/dashboard/data/openai-key').read().strip()
URL = "https://api.openai.com/v1/audio/transcriptions"
CLIP = "/tmp/c1.m4a"          # "ashu ka fan chalu karo"

def post(model, extra):
    b = '----f'; body = b''
    def f(n, v):
        return ('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (b, n, v)).encode()
    body += f('model', model)
    for k, v in extra.items():
        body += f(k, v)
    d = open(CLIP, 'rb').read()
    ct = mimetypes.guess_type(CLIP)[0] or 'application/octet-stream'
    body += ('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\nContent-Type: %s\r\n\r\n'
             % (b, os.path.basename(CLIP), ct)).encode()
    body += d + ('\r\n--%s--\r\n' % b).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Authorization": "Bearer " + KEY,
        "Content-Type": "multipart/form-data; boundary=" + b})
    try:
        return json.load(urllib.request.urlopen(req, timeout=60)).get("text", "").strip()
    except urllib.error.HTTPError as e:
        return "ERR " + e.read().decode()[:150].replace("\n", " ")

LATIN = ('Short home-automation commands in Hinglish. Write them in romanised Latin '
         'script only, never Devanagari. Room names: Ashu Room, Master Room, Living.')
KW = 'Ashu Room,Master Room,Living,Dining,cobs,chalu karo,band karo,khol do,fan,ac'

TRIALS = [
    ("nothing",                {}),
    ("prompt",                 {"prompt": LATIN}),
    ("language=en",            {"language": "en"}),
    ("languages=en",           {"languages": "en"}),
    ("languages=[en]",         {"languages": '["en"]'}),
    ("languages=en,hi",        {"languages": "en,hi"}),
    ("keywords",               {"keywords": KW}),
    ("keywords=[...]",         {"keywords": json.dumps(KW.split(","))}),
    ("context",                {"context": LATIN}),
    ("keywords+languages=en",  {"keywords": KW, "languages": "en"}),
    ("prompt+languages=[en]",  {"prompt": LATIN, "languages": '["en"]'}),
]

for name, extra in TRIALS:
    print("  %-24s %s" % (name, post("gpt-transcribe", extra)[:92]))
