"""Fault drills for the speech engine (engine/engine.py): what it does when things go wrong in the middle of a service.
They use a fake speech model, so they need no graphics card, no microphone and no internet, and take about a minute.

    npm run test:engine          (or: engine\\python\\python.exe test\\engine_faults.py [name ...])

    loading   sentences heard while the model is (re)loading are kept, not thrown away
    worker    the transcribing thread survives a bad sentence, and is started again if it ever ends
    race      the model changed in the middle of a sentence (fallback to this PC, back to the chosen service)
    silent    a muted sound-desk feed is reported, and the report goes away when the sound is back (takes 45 s)
    service   a paid service that refuses (no key, out of credit) hands over to the model on this PC
    retry     a model that fails to load is tried again
    record    the sound recording of a service, and where each sentence is in it
    interp    an interpreter (English and Arabic by turns) is noticed, and when he stops
    pick      which of the model's two answers (asked for Arabic, asked for English) is kept
    soniox    the Soniox live service: sentences, a dropped stream, a refused key, an empty balance (a stand-in server)
"""
import argparse
import os
import queue
import sys
import threading
import time

import numpy as np

import tempfile  # noqa: E402

# what the drills print has arrows and Arabic in it, which Windows refuses to print when the output goes to a file or pipe
for _out in (sys.stdout, sys.stderr):
    _out.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.join(HERE, "..", "engine")
sys.path.insert(0, ENG)
os.chdir(ENG)
import audio_io  # noqa: E402
import engine  # noqa: E402

engine.log = lambda *p: LOG.append(" ".join(str(x) for x in p))
LOG = []
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + ("   " + str(detail) if detail else ""), flush=True)


class FakeModel:
    device, gpu_name, speed, describe, label = "cuda", "fake", 0.0, "fake card", "fake"

    def __init__(self, delay=0.01, fail=None):
        self.delay, self.fail, self.n = delay, fail, 0

    def transcribe(self, audio, mode, final=True):
        self.n += 1
        if self.fail:
            self.fail(self.n)
        time.sleep(self.delay)
        return ("نص %d" % self.n, "ar", 0.0, self.delay)


def new_engine(provider="local", **kw):
    events = []
    args = argparse.Namespace(device=None, provider=provider, model=None, managed=True, file=None, fast=False, quiet=False,
                              language="auto", list_devices=False)
    for k, v in kw.items():
        setattr(args, k, v)
    e = engine.Engine(events.append, args)
    return e, events


def sentence(e, sid, secs=3):
    e.schedule(("final", sid, np.zeros(16000 * secs, np.float32), time.time()))


def finals(events):
    return [ev["seg"] for ev in events if ev.get("ev") == "final"]


# ------------------------------------------------------------------------------------------------------------
def t_loading():
    """Sentences that end while the model is loading are kept (and marked late), not thrown away."""
    e, events = new_engine()
    e.start_worker()
    for sid in range(1, 6):
        sentence(e, sid)
        time.sleep(1.0)                                  # (a real load takes 10-30 s)
    waiting = len(e.finals)
    e.asr = FakeModel()
    sentence(e, 6)
    time.sleep(1.0)
    got = finals(events)
    late = [ev["seg"] for ev in events if ev.get("ev") == "final" and ev.get("late")]
    check("kept while loading: all 6 sentences transcribed", got == [1, 2, 3, 4, 5, 6], f"waiting={waiting} got={got}")
    check("… the ones that waited more than 3 s are marked late", late and 6 not in late and 1 in late, f"late={late}")
    # too old to be of use (40 s): dropped
    e2, ev2 = new_engine()
    e2.start_worker()
    e2.finals.append((1, np.zeros(16000, np.float32), time.time() - 60, time.time() - 50, True))
    sentence(e2, 2)
    time.sleep(0.5)
    e2.asr = FakeModel()
    e2.wake.set()
    time.sleep(0.6)
    check("a sentence that waited more than 40 s is dropped, the fresh one kept", finals(ev2) == [2], finals(ev2))


def t_worker():
    """The transcribing thread survives errors in a sentence, and is started again if it ever ends."""
    e, events = new_engine()

    def boom(n):
        if n == 2:
            raise RuntimeError("one bad sentence")
    e.asr = FakeModel(fail=boom)
    e.start_worker()
    for sid in (1, 2, 3):
        sentence(e, sid)
    time.sleep(0.8)
    check("an error in one sentence does not stop the next", finals(events) == [1, 3] and e.worker_thread.is_alive(), finals(events))
    # a problem outside the sentence itself (e.g. a broken event) must not kill the thread either
    real_out = e.out
    hit = {"n": 0}

    def bad_out(ev):
        if ev.get("ev") == "final" and not hit["n"]:
            hit["n"] = 1
            raise ValueError("could not report")
        real_out(ev)
    e.out = bad_out
    sentence(e, 4)
    sentence(e, 5)
    time.sleep(1.0)
    check("a problem while reporting does not stop the thread", e.worker_thread.is_alive() and 5 in finals(events), finals(events))
    # the thread ended for good (something no code path should do): the main loop starts it again
    commands = queue.Queue()
    e.out = real_out
    e.want_input = {"kind": "file", "path": os.path.join(HERE, "nope.wav")}          # (no real input needed)
    e.open_input = lambda: None
    e.check_input = lambda now: None
    e.load_model = lambda: None                          # (the fake model stays)
    threading.Thread(target=lambda: e.run(commands), daemon=True).start()
    time.sleep(2.5)                                      # (the main loop is going)

    def die():
        raise SystemExit
    e.work = die
    e.wake.set()
    time.sleep(0.6)
    del e.work                                          # (back to the class's own)
    time.sleep(1.0)
    sentence(e, 6)
    time.sleep(1.0)
    warned = any(ev.get("ev") == "warn" and "put itself right" in ev.get("message", "") for ev in events)
    check("a thread that ended is started again by the main loop", e.worker_thread.is_alive() and 6 in finals(events) and warned, finals(events))
    hb = [ev for ev in events if ev.get("ev") == "hb"]
    check("the heartbeat reports busy / oldest / silent", hb and all(k in hb[-1] for k in ("busy", "oldest", "silent", "recording")), hb[-1] if hb else None)


def t_race():
    """Changing the model while a sentence is being done (fallback, going back to the chosen service) must not kill the thread."""
    e, events = new_engine()
    slow = FakeModel(delay=0.3)
    e.asr = slow
    e.start_worker()
    ok = True
    for round_ in range(6):
        sentence(e, 100 + round_)
        time.sleep(0.1)                                  # the worker is inside transcribe() now
        with e.asr_lock:                                 # (as switch_back and fall_back_to_local do)
            e.asr = None
        time.sleep(0.25)
        ok = ok and e.worker_thread.is_alive()
        e.asr = slow
        e.wake.set()
        time.sleep(0.5)
    check("the model is taken away mid-sentence 6 times: the thread lives and every sentence is reported",
          ok and e.worker_thread.is_alive() and len(finals(events)) == 6, finals(events))
    # the model was changed while a sentence waited its turn: it is done by the new one
    e.asr = FakeModel(delay=0.01)
    sentence(e, 200)
    time.sleep(0.5)
    check("a sentence scheduled after the change is done by the new model", 200 in finals(events), finals(events))


class ZeroMic(audio_io.Input):
    """A microphone that gives digital silence (a muted desk feed), then real sound when told."""
    kind, label = "mic", "Desk feed (test)"

    def __init__(self, q, emit):
        super().__init__(q, emit)
        self.loud = False

    def run(self):
        rng = np.random.default_rng(1)
        while not self.stop_flag.is_set():
            f = (rng.standard_normal(audio_io.FRAME) * 0.05).astype(np.float32) if self.loud else np.zeros(audio_io.FRAME, np.float32)
            self.put([f])
            time.sleep(audio_io.FRAME / audio_io.RATE)


def t_silent():
    """A muted feed: the input is opened afresh once, then the app is told; and told again when the sound is back."""
    e, events = new_engine()
    e.asr = FakeModel()
    opened = []

    def open_input():
        if e.input:
            e.input.stop()
        e.input = ZeroMic(e.frames, e.out).start()
        opened.append(time.time())
    e.open_input = open_input
    e.load_model = lambda: None
    e.listening = True
    commands = queue.Queue()
    threading.Thread(target=lambda: e.run(commands), daemon=True).start()
    t0 = time.time()
    silent = lambda on: [ev for ev in events if ev.get("ev") == "input" and ev.get("silent") is on]
    while time.time() - t0 < 60 and not silent(True):
        time.sleep(0.5)
    took = time.time() - t0
    warned = [ev["message"] for ev in events if ev.get("ev") == "warn"]
    check("20 s of digital silence: the input is opened afresh once", len(opened) == 2, f"opened {len(opened)} times")
    check("still silent 20 s later: the app is told (about 40 s in all)", bool(silent(True)) and 35 < took < 50 and any("No sound" in w for w in warned), f"{took:.0f} s, {warned}")
    e.input.loud = True
    t1 = time.time()
    while time.time() - t1 < 6 and not silent(False):
        time.sleep(0.2)
    check("the sound comes back: the app is told within a few seconds", bool(silent(False)), f"{time.time() - t1:.1f} s")
    # not while listening is off, and not for "this PC's sound" (silence is normal there)
    e2, ev2 = new_engine()
    e2.listening = False
    e2.last_sound = e2.last_loud = time.time() - 500
    e2.input = ZeroMic(e2.frames, e2.out)
    e2.check_silence(time.time())
    check("no alarm while listening is off", not e2.silent and not ev2)


def t_service():
    """A paid service that refuses (no key / key refused / out of credit): the model on this PC takes over, if it is installed."""
    os.environ["VF_STT_KEY"] = ""
    real_find, real_T = engine.find_model, engine.Transcriber
    engine.find_model = lambda m=None: "fake-model-folder"
    engine.Transcriber = lambda path, device=None, log=None: FakeModel()
    try:
        for provider in ("elevenlabs", "deepgram"):
            e, events = new_engine(provider)
            e.load_model()
            t0 = time.time()
            while time.time() - t0 < 5 and not (e.asr and e.cfg["provider"] == "local"):
                time.sleep(0.1)
            warns = [ev["message"] for ev in events if ev.get("ev") == "warn"]
            check(f"{provider} without a key: the model on this PC takes over", e.cfg["provider"] == "local" and isinstance(e.asr, FakeModel) and e.chosen == "local"
                  and e.state == "ready", f"state={e.state} warn={warns}")
        # … and with no model installed, it says so plainly instead
        engine.find_model = lambda m=None: None
        e, events = new_engine("elevenlabs")
        e.load_model()
        time.sleep(0.5)
        check("no model on this PC: the key problem is reported as an error", e.state == "error" and e.asr is None, f"{e.state}: {e.message}")
    finally:
        engine.find_model, engine.Transcriber = real_find, real_T


def t_retry():
    """A model that fails to load is tried again (30 s, 2 min, 5 min)."""
    real_find, real_T, real_cuda, real_timer = engine.find_model, engine.Transcriber, engine.cuda_there, threading.Timer
    engine.find_model = lambda m=None: "fake-model-folder"
    engine.cuda_there = lambda: False
    tries = {"n": 0}

    def flaky(path, device=None, log=None):
        tries["n"] += 1
        if tries["n"] <= 2:
            raise RuntimeError("the disk was busy")
        return FakeModel()
    engine.Transcriber = flaky
    waits = []

    class FastTimer(real_timer):
        def __init__(self, wait, fn):
            waits.append(wait)
            super().__init__(0.2, fn)
    threading.Timer = FastTimer
    try:
        e, events = new_engine()
        e.load_model()
        time.sleep(1.5)
        check("a failed load is tried again after 30 s and then 2 minutes, and then it works", waits == [30, 120] and isinstance(e.asr, FakeModel) and e.state == "ready",
              f"waits={waits} state={e.state}")
        check("… and the count starts again after a success", e.load_tries == 0)
    finally:
        engine.find_model, engine.Transcriber, engine.cuda_there, threading.Timer = real_find, real_T, real_cuda, real_timer


def t_record():
    """The recording: only while listening, never a test file, a file that plays back at the right length."""
    import av
    folder = tempfile.mkdtemp(prefix="vf-rec-test-")
    e, events = new_engine()
    e.asr = FakeModel()
    e.cfg["record"] = folder
    mic = ZeroMic(e.frames, e.out)
    mic.loud = True
    e.input = mic
    rng = np.random.default_rng(2)
    frame = lambda: (rng.standard_normal(audio_io.FRAME) * 0.05).astype(np.float32)
    e.listening = False
    for _ in range(30):
        e.record(frame())
    check("nothing is recorded while listening is off", e.recorder is None and not os.listdir(folder))
    e.listening = True
    n = int(4 * audio_io.RATE / audio_io.FRAME)
    for _ in range(n):
        e.record(frame())
    path = e.recorder.path
    # a sentence that began 1.5 s ago is 1.5 s before the end of what has been recorded (4 s)
    e.out({"ev": "final", "seg": 7, "text": "x", "start": time.time() - 1.5})
    f = [ev for ev in events if ev.get("ev") == "final"][-1]
    check("a sentence says where it is in the recording", f.get("rec") == os.path.basename(path) and abs(f.get("at", -9) - 2.5) < 0.3,
          f"{f.get('rec')} at {f.get('at')} s")
    e.command({"cmd": "listen", "on": False})
    check("listening off closes the file", e.recorder is None and os.path.exists(path))
    rec = [ev for ev in events if ev.get("ev") == "recording"]
    check("the app is told when a recording starts and stops", [r["on"] for r in rec] == [True, False] and rec[0]["file"] == os.path.basename(path)
          and abs(rec[1]["seconds"] - 4.0) < 0.2, str(rec))
    c = av.open(path)
    secs = sum(fr.samples for fr in c.decode(c.streams.audio[0])) / c.streams.audio[0].rate
    c.close()
    check("4 s of listening gave a 4 s recording that plays", abs(secs - 4.0) < 0.2, f"{secs:.2f} s, {os.path.getsize(path)} bytes")
    # a test recording being played is not recorded again
    e.listening = True
    mic.kind = "file"
    e.record(frame())
    check("a test recording is not recorded", e.recorder is None and len(os.listdir(folder)) == 1)
    mic.kind = "mic"
    e.cfg["record"] = ""
    e.record(frame())
    check("turned off in Settings: nothing is recorded", e.recorder is None and len(os.listdir(folder)) == 1)


def t_interp():
    """An interpreter (English and Arabic by turns) is noticed: shorter cuts, both languages asked for; and it ends."""
    e, events = new_engine()
    asked = []

    class Model(FakeModel):
        def transcribe(self, audio, mode, final=True, both=False):
            asked.append(both)
            return FakeModel.transcribe(self, audio, mode, final)
    e.asr = Model()
    e.start_worker()
    e.cfg["pause"] = 0.5
    en, ar = "Please open your Bibles to John chapter three.", "من فضلكم افتحوا الكتاب المقدس على انجيل يوحنا"
    for x in (ar, ar, ar):
        e.note_language(x)
    check("Arabic only: nothing changes", not e.interp and e.pause() == 0.5)
    for x in (en, ar, en, ar):
        e.note_language(x)
    check("English and Arabic by turns: an interpreter is noticed", e.interp and e.pause() <= 0.3 and e.seg.end_frames <= 10,
          f"pause {e.pause()} s, {e.seg.end_frames} frames")
    check("the app is told", [ev["on"] for ev in events if ev.get("ev") == "interp"] == [True])
    sentence(e, 1)
    time.sleep(0.5)
    check("each sentence is then asked for in both languages", asked[-1:] == [True], str(asked))
    e.said_in.clear()
    e.note_language(en + " " + ar)
    e.note_language(en + " " + ar)
    check("(one sentence holding both languages counts double)", e.interp)
    for _ in range(10):
        e.note_language(ar)
    check("ten sentences in one language: back to the usual cuts", not e.interp and e.pause() == 0.5 and e.seg.end_frames >= 15)


def t_pick():
    """Asked for Arabic and for English, the model gives two answers: the one that was said is kept (17 Nov 2026)."""
    import asr

    def kept(ar, en, seconds, both=False):
        m = asr.Transcriber.__new__(asr.Transcriber)
        m.device, m.speed = "cuda", 0.0
        m._decode = lambda audio, lang, beams=1: ar if lang == "ar" else en
        return m.transcribe(np.zeros(int(seconds * audio_io.RATE), dtype=np.float32), "auto", True, both)[0]

    verse, mess = "في البدء خلق الله السماوات والأرض", "\"For the Bid's, خلق Allah السماوات والأرض\""
    check("Arabic said, the English answer is the same sentence in two scripts mixed: the Arabic answer stays",
          kept((verse, -0.09), (mess, -0.58), 2.6, both=True) == verse and not asr.two_languages(mess))
    said = "هو ده ايه دي؟ هو اعتقد لو لسه مغير مش هيغير لمدة عشر ثواني يعني مثلا"
    loop = "Oh, did I eat it? " + "I'm not sure. " * 8
    check("the English answer goes round in circles: it is never kept, alone or beside the Arabic",
          kept((said, -0.24), (loop, -0.24), 10.6, both=True) == said and kept((said, -0.24), (loop, -0.05), 10.6) == said, kept((said, -0.24), (loop, -0.24), 10.6, both=True))
    long_ar = "ما هذا؟ هو سمعنا واحنا موجودين نترجم الحاجات ولا دي وعملتها؟"
    check("three English words for four seconds of Arabic: the Arabic answer stays",
          kept((long_ar, -0.27), ("What is this?", -0.07), 3.9) == long_ar and kept((long_ar, -0.27), ("What is this?", -0.07), 3.9, both=True) == long_ar)
    check("a short sentence and the model's own translation of it are not both kept (no room in the sound for two)",
          kept(("لا، لا أعرف", -0.20), ("I don't know.", -0.25), 1.5, both=True) == "لا، لا أعرف")
    pair = kept(("يريدنا أن نتعاون معه", -0.15), ("He needs us to cooperate with him.", -0.12), 5.0, both=True)
    check("a pastor's sentence and his interpreter's, in a sound long enough for both: both are kept",
          pair == "He needs us to cooperate with him. يريدنا أن نتعاون معه", pair)
    check("English said, the Arabic answer unsure: written the English way",
          kept(("فالأرض كانت فاضية و الأرض كانت فاضية", -0.65), ("Now the earth was formless and the Spirit of God", -0.10), 2.9).startswith("Now the earth"))
    check("a sentence the model writes over and over is written once",
          asr.clean_text("I don't know what I'm talking about. " * 6) == "I don't know what I'm talking about." and asr.clean_text("يا رب ارحم يا رب ارحم يا رب ارحم") == "يا رب ارحم يا رب ارحم يا رب ارحم")
    check("the model's marks for speech it could not make out are left out", asr.clean_text("###حطله جوج... غير_واضح...") == "حطله جوج... ...", asr.clean_text("###حطله جوج... غير_واضح..."))


class FakeSoniox:
    """A stand-in for Soniox's real-time WebSocket API on this PC. Every half second of sound it "hears" one word: sent
    first as a guess, then confirmed. mode: "ok", "endpoint" (it closes a sentence itself after four words),
    "drop" (the first stream is cut off after 2 s of sound), "no_credit", or "refuse_terms" (settings with hints refused)."""

    def __init__(self, mode="ok"):
        from websockets.sync.server import serve
        self.mode, self.streams, self.configs, self.auth, self.asks, self.ended, self.dropped = mode, [], [], [], 0, 0, 0
        self.server = serve(self.handle, "127.0.0.1", 0)
        self.url = "ws://127.0.0.1:%d" % self.server.socket.getsockname()[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def handle(self, ws):
        import json
        send = lambda m: ws.send(json.dumps(m))
        self.auth.append(ws.request.headers.get("Authorization"))
        try:
            cfg = json.loads(ws.recv())
            self.configs.append(cfg)
            if self.auth[-1] != "Bearer good-key":
                return send({"tokens": [], "error_code": 401, "error_type": "unauthenticated", "error_message": "Invalid API key."})
            if self.mode == "no_credit":
                return send({"tokens": [], "error_code": 402, "error_type": "organization_balance_exhausted", "error_message": "Organization balance exhausted."})
            if self.mode == "refuse_terms" and "context" in cfg:
                return send({"tokens": [], "error_code": 400, "error_type": "invalid_request", "error_message": "Invalid context."})
            got, said, open_words = 0, 0, []          # bytes of sound, words written, words of the sentence not closed
            self.streams.append(0)
            me = len(self.streams) - 1
            while True:
                m = ws.recv()
                if isinstance(m, bytes):
                    got += len(m)
                    self.streams[me] = got
                    if self.mode == "drop" and not self.dropped and got >= 2 * 32000:
                        self.dropped = 1
                        return ws.close()                                   # cut off in the middle of a sentence
                    while got >= (said + 1) * 16000:                        # a word for every half second
                        said += 1
                        toks = [{"text": " w%d" % said, "is_final": True, "start_ms": (said - 1) * 500, "end_ms": said * 500, "confidence": 0.9, "language": "ar"}]
                        open_words.append(said)
                        if self.mode == "endpoint" and len(open_words) == 4:
                            toks.append({"text": "<end>", "is_final": True})
                            open_words = []
                        toks.append({"text": " g%d" % (said + 1), "is_final": False})
                        send({"tokens": toks, "final_audio_proc_ms": said * 500, "total_audio_proc_ms": got // 32})
                elif m == "":
                    self.ended += 1
                    return send({"tokens": [], "final_audio_proc_ms": got // 32, "total_audio_proc_ms": got // 32, "finished": True})
                else:
                    kind = json.loads(m).get("type")
                    if kind == "finalize":
                        self.asks += 1
                        open_words = []
                        send({"tokens": [{"text": "<fin>", "is_final": True}], "final_audio_proc_ms": got // 32, "total_audio_proc_ms": got // 32})
        except Exception:
            pass

    def close(self):
        self.server.shutdown()


def t_soniox():
    """Soniox live: words as they are said, sentences closed by Soniox or at the engine's own pause, a stream that drops, a refused key, an empty balance."""
    import live

    def start(mode, key="good-key", keyterms=("حبقوق", "فيلبي", "المزامير", "العدد"), **kw):
        srv = FakeSoniox(mode)
        os.environ["VF_SONIOX_URL"] = srv.url
        ev, said = [], {"ready": [], "trouble": []}
        s = live.SonioxLive(emit=ev.append, log=lambda *a: LOG.append(" ".join(str(x) for x in a)), ready=said["ready"].append,
                            trouble=lambda m, permanent=False: said["trouble"].append((m, permanent)), key=key,
                            keyterms=list(keyterms), **kw)
        live_now.append(s)
        return srv, s, ev, said

    live_now = []

    def wait(cond, secs=6.0):
        end = time.time() + secs
        while time.time() < end and not cond():
            time.sleep(0.02)
            for x in live_now[-1:]:
                x.tick(time.time())               # (the engine does this several times a second: words held back go out)
        return cond()

    def speak(s, seconds, prob=0.9):
        frame = np.zeros(audio_io.FRAME, dtype=np.float32)
        for _ in range(int(seconds * audio_io.RATE / audio_io.FRAME)):
            s.feed(frame, prob, time.time())

    finals = lambda ev: [e["text"] for e in ev if e["ev"] == "final"]
    # ---- the usual case: the engine's own pause closes the sentence
    srv, s, ev, said = start("ok")
    check("it connects and says it is ready", wait(lambda: said["ready"]), LOG[-3:])
    c = srv.configs[0] if srv.configs else {}
    check("the key goes with the connection, not in the settings message", srv.auth[:1] == ["Bearer good-key"] and "api_key" not in c)
    check("it asks for Arabic and English, 16 kHz sound, sentence ends, and gives the Bible names as hints",
          c.get("model") == "stt-rt-v6" and c.get("audio_format") == "pcm_s16le" and c.get("sample_rate") == 16000 and c.get("language_hints") == ["ar", "en"]
          and c.get("language_hints_strict") is True and c.get("enable_endpoint_detection") is True
          and c.get("context", {}).get("terms") == ["حبقوق", "فيلبي", "المزامير", "مزمور"], c)
    check("no stream is left open while nothing is listened to (an open stream is charged)", wait(lambda: srv.ended == 1))
    s.set_listening(True)
    speak(s, 5.0)
    check("words appear while they are said", wait(lambda: any(e["ev"] == "partial" and "w3" in e["text"] for e in ev)), [e for e in ev][-2:])
    speak(s, 0.7, prob=0.0)                                                       # a pause
    check("a pause closes the sentence: Soniox is asked to confirm it", wait(lambda: finals(ev)) and srv.asks == 1, (finals(ev), srv.asks))
    first = finals(ev)[0] if finals(ev) else ""
    check("… with every word, in order, and none that was only a guess", first.split()[:3] == ["w1", "w2", "w3"] and "g" not in first, first)
    f = [e for e in ev if e["ev"] == "final"][0] if finals(ev) else {}
    check("the sentence says when it started and which service heard it", f.get("provider") == "soniox" and abs(f.get("start", 0) - time.time()) < 30 and f.get("seg") == 1, f)
    s.set_listening(False)
    check("stop listening: the stream is ended and what was sent is counted for the bill", wait(lambda: srv.ended == 2 and any(e["ev"] == "billed" for e in ev)),
          (srv.ended, [e for e in ev if e["ev"] == "billed"]))
    s.close(); srv.close()
    # ---- Soniox closes the sentence itself
    srv, s, ev, said = start("endpoint")
    wait(lambda: said["ready"])
    s.set_listening(True)
    speak(s, 3.0)
    check("Soniox hears the end of a sentence: it is closed at once, without being asked", wait(lambda: finals(ev)) and finals(ev)[0].split() == ["w1", "w2", "w3", "w4"] and srv.asks == 0, (finals(ev), srv.asks))
    s.close(); srv.close()
    # ---- the stream is cut off in the middle of a sentence
    srv, s, ev, said = start("drop")
    wait(lambda: said["ready"])
    s.set_listening(True)
    speak(s, 3.0)
    check("a dropped stream: a new one is opened by itself", wait(lambda: srv.dropped and len(srv.streams) >= 3 and srv.streams[2] > 0, 12), srv.streams)
    check("… and the sound whose words were not confirmed is sent again", any("go again" in x for x in LOG[-12:]), LOG[-4:])
    speak(s, 2.0); speak(s, 0.7, prob=0.0)
    check("… the sentence carries on and is closed as usual", wait(lambda: finals(ev), 8), finals(ev))
    check("no trouble is reported for one dropped stream", not said["trouble"], said["trouble"])
    s.close(); srv.close()
    # ---- refused: key, balance
    srv, s, ev, said = start("ok", key="wrong-key")
    check("a refused key: said plainly, and it does not keep trying", wait(lambda: said["trouble"]) and said["trouble"][0][1] is True and "API key" in said["trouble"][0][0], said["trouble"])
    s.close(); srv.close()
    srv, s, ev, said = start("no_credit")
    check("an empty balance: said plainly, with where to add funds", wait(lambda: said["trouble"]) and said["trouble"][0][1] is True and "out of credit" in said["trouble"][0][0]
          and "console.soniox.com" in said["trouble"][0][0], said["trouble"])
    n = len(srv.configs)
    time.sleep(1.5)
    check("… and it stops there (no connecting again and again)", len(srv.configs) == n, len(srv.configs))
    s.close(); srv.close()
    srv, s, ev, said = start("refuse_terms")
    check("settings refused with the name hints: it carries on without them", wait(lambda: said["ready"], 10) and "context" not in srv.configs[-1] and not said["trouble"], (said, len(srv.configs)))
    s.close(); srv.close()
    # ---- the hints switched off (Settings → Listening): no list is sent, so none is charged
    srv, s, ev, said = start("ok", keyterms=[])
    check("hints off: the settings message has no list of names", wait(lambda: said["ready"]) and srv.configs and "context" not in srv.configs[0], srv.configs[:1])
    text, lang, _, took = s.transcribe(np.zeros(int(1.6 * audio_io.RATE), dtype=np.float32))
    check("… nor does a spoken command from the phone", "context" not in srv.configs[-1] and text.split() == ["w1", "w2", "w3"], (srv.configs[-1:], text))
    s.close(); srv.close()
    # ---- a spoken command from the phone
    srv, s, ev, said = start("ok")
    wait(lambda: said["ready"])
    text, lang, _, took = s.transcribe(np.zeros(int(1.6 * audio_io.RATE), dtype=np.float32))
    check("a spoken command from the phone: one short recording on a stream of its own", text.split() == ["w1", "w2", "w3"], (text, lang))
    s.close(); srv.close()
    os.environ.pop("VF_SONIOX_URL", None)
    try:
        live.SonioxLive(emit=lambda e: 0, log=lambda *a: 0, ready=lambda m: 0, trouble=lambda *a: 0, key="")
        check("no key yet: it says where to put one", False)
    except live.LiveError as e:
        check("no key yet: it says where to put one", e.permanent and "Settings" in str(e), str(e))


def t_google():
    """Google heard each sentence in Arabic and in English at once: the text kept is the language that was spoken.
    (Both texts as Google wrote them, from recordings of 18 November.)"""
    import live
    said_ar = [("كده احنا هنجرب بتاع جوجل وهنشوف احنا", 0.88, "good afternoon Google where can I", 0.93),
               ("ايوه اشتغل طب يلا نقرا في ليمون 1 2", 0.89, "Iowa Stephanie", 0.95),
               ("حجي 1/5", 0.86, "actually what happens", 0.77),
               ("روح للي قبليها", 0.79, "Brooklyn Gabriel", 0.92),
               ("طب حجي 1 2", 0.90, "stop how's your day", 0.79),
               ("تمام ده اللي هو جوجل ده هو شغال حلو قوي وببلاش كمان", 0.90, "Kevin the lower Google that was a little girl", 0.97),
               ("هو بيشتغل العربي لكن شكله مش بيشتغل انجليزي", 0.87, "hi I will be still a lot of relaxing music", 0.97)]
    said_en = [("انا سكني", 0.85, "and the second year of King Darius on the first day of the sixth month", 0.97),
               ("بيس", 0.90, "and this is what the Lord Almighty says these people said the time has not yet come", 0.96),
               ("", 0.0, "now this is what the Lord Almighty says give careful thought to your ways", 0.94),
               ("جواب", 0.86, "next", 0.96),
               ("الاكس بوكس", 0.0, "next verse", 0.9),
               ("الاقصر", 0.59, "so that it looks like if we can get Google Voice working", 0.95),
               ("\u200flet's", 0.0, "let's read together John 1:5", 0.93),
               ("بس شويه جون 1", 0.0, "let's read John 1:5 together", 0.96)]
    for ar, ca, en, ce in said_ar:
        check(f"Arabic was said: «{ar}» is kept, not \"{en}\" (confidence {ce})", live.pick_language(ar, ca, en, ce) == "ar")
    for ar, ca, en, ce in said_en:
        check(f"English was said: \"{en}\" is kept, not «{ar}»", live.pick_language(ar, ca, en, ce) == "en")
    check("a spoken command is known, in either language, and nothing more than that",
          all(live.is_command(x) for x in ("Next.", "next verse", "The next verse.", "التالي", "اللي بعديها.", "العدد اللي بعده"))
          and not any(live.is_command(x) for x in ("next we will read", "اللي بعده جه", "Next Sunday", "")))
    c = live.Cutter(min_len=4.0, pause=0.3)
    for _ in range(20):
        c.feed(0.9)
    early = [c.feed(0.0) for _ in range(12)]
    check("a command's pause is seen before the usual 4 seconds (the engine then ends the sentence)", c.paused() and not any(early))
    check("only one recognizer heard anything: its text", live.pick_language("", 0, "John 3:16", 0.9) == "en" and live.pick_language("يوحنا 3 16", 0.9, "", 0) == "ar")
    check("while the words are still coming, the language shown so far stays until the other is clearly ahead",
          live.pick_partial("هاي", "the high", "ar") == "ar" and live.pick_partial("هاي", "the high priest next then the word", "ar") == "en"
          and live.pick_partial("يلا نقرا", "yellow", "en") == "en" and live.pick_partial("يلا نقرا مع بعض حجي واحد", "yellow not the mob", "en") == "ar")


TESTS = {"google": t_google, "soniox": t_soniox, "pick": t_pick, "interp": t_interp, "loading": t_loading, "worker": t_worker, "race": t_race, "silent": t_silent, "service": t_service, "retry": t_retry, "record": t_record}
if __name__ == "__main__":
    names = sys.argv[1:] or list(TESTS)
    for n in names:
        print(f"--- {n}: {TESTS[n].__doc__.strip()}", flush=True)
        try:
            TESTS[n]()
        except Exception as ex:
            import traceback
            check(n + " ran", False, traceback.format_exc())
    bad = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(bad)} passed, {len(bad)} failed", flush=True)
    sys.stdout.flush()
    os._exit(1 if bad else 0)
