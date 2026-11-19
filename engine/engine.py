"""
Arabic Church Assistant speech engine.

Turns live speech into text, for as long as the service lasts. By default on this computer with Cohere Transcribe
Arabic (Arabic, Egyptian and other dialects, and English, also mixed in one sentence; no internet). Instead it can
use Google's speech recognition through a hidden Chrome (free, online; live.py), ElevenLabs Scribe Live (paid,
online; live.py) or Deepgram (paid, online, a sentence at a time; cloud.py).

The app starts it and talks to it:
  stdin  : one JSON command per line   {"cmd": "listen", "on": true}
  stdout : one JSON event per line     {"ev": "final", "text": "..."}
  stderr : log lines (Settings -> Speech engine -> log)

By hand, for testing:
  python\\python engine.py --file sermon.mp3        transcribe a recording (prints the text)
  python\\python engine.py --list-devices           show the microphones and speakers
"""
import argparse
import json
import os
import queue
import sys
import threading
import time
import traceback

os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTHONWARNINGS", "ignore")

import warnings  # noqa: E402

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402

import audio_io  # noqa: E402
from asr import Segmenter, Transcriber, VoiceDetector, find_model, latin_share, two_languages  # noqa: E402

VERSION = "3.4.1"
START = time.time()
LIVE_NAMES = ("google", "elevenlabs", "soniox")   # services sent the sound as it is heard (live.py); the others get whole sentences


# --------------------------------------------------------------------------------------------- talking to the app
class Out:
    def __init__(self, json_mode):
        self.json_mode = json_mode
        self.lock = threading.Lock()

    def __call__(self, obj):
        if not self.json_mode:
            ev = obj.get("ev")
            if ev == "final":
                print(f"[{obj.get('lang')} {obj.get('ms')}ms] {obj.get('text')}", flush=True)
            elif ev in ("status", "warn", "input") and obj.get("message"):
                print("--", obj["message"], flush=True)
            return
        data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        with self.lock:
            try:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            except Exception:
                os._exit(0)             # the app is gone


def log(*parts):
    msg = " ".join(str(p) for p in parts)
    try:
        sys.stderr.write(time.strftime("%H:%M:%S ") + msg + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def cuda_there():
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


# --------------------------------------------------------------------------------------------- the engine
class Engine:
    def __init__(self, out, args):
        self._out = out
        self.recorder = None
        self.args = args
        self.cfg = {"language": "auto", "pause": 0.5, "maxLen": 15.0, "sensitivity": 0.5, "device": args.device or "auto",
                    "provider": args.provider or "local", "keyterms": [], "record": ""}
        self.listening = False
        self.frames = queue.Queue(maxsize=2000)
        self.input = None
        self.want_input = {"kind": "mic", "name": ""}
        self.input_fail = 0
        self.input_retry_at = 0.0
        self.vad = VoiceDetector()
        self.seg = Segmenter()
        self.asr = None
        self.state = "loading"
        self.message = ""
        self.finals = []                # waiting to be transcribed, in order
        self.partial = None             # only the newest live preview is worth doing
        self.done_ids = set()
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.level = 0.0
        self.speech_p = 0.0
        self.last_level_emit = 0.0
        self.last_hb = 0.0
        self.behind_warned = False
        self.errors_in_row = 0
        self.said_in = []                     # the language of the last sentences: "en", "ar" or "both"
        self.interp = False                   # an interpreter is at work (the sentences keep changing language)
        self.asr_lock = threading.Lock()      # the live worker and spoken commands take turns with the model
        self.chosen = self.cfg["provider"]    # what the app asked for (a fallback to "local" ends when listening stops)
        self.worker_thread = None
        self.busy_since = 0.0                 # when the worker started the sentence it is on (0: it is waiting)
        self.busy_len = 0.0                   # … and how long that sentence is, in seconds
        self.load_tries = 0                   # failed tries to start the model or service (tried again after 30 s, 2 min, 5 min)
        self.last_sound = time.time()         # when the microphone last gave anything but digital silence
        self.last_loud = time.time()          # … and anything above -65 dB
        self.silent = False                   # "no sound is coming from the input" has been reported
        self.silence_reopened = 0.0
        self.recorder = None                  # the sound file of this stretch of listening (Settings -> keep a recording)

    # ---------------------------------------------------------------- status
    def status(self, state=None, message=None, **kw):
        if state:
            self.state = state
        if message is not None:
            self.message = message
            if message:
                log(message)
        ev = {"ev": "status", "state": self.state, "message": self.message, "listening": self.listening}
        asr = self.asr
        if asr:
            model = getattr(asr, "label", "") or (asr.p.label if hasattr(asr, "p") else "Cohere Transcribe Arabic")
            ev.update(device=asr.device, where=asr.describe, gpu=asr.gpu_name, model=model)
        ev.update(kw)
        self.out(ev)

    # ---------------------------------------------------------------- model
    def load_model(self):
        if self.cfg["provider"] in LIVE_NAMES:
            return self.load_live()
        if self.cfg["provider"] != "local":
            return self.load_cloud()
        path = find_model(self.args.model)
        if not path:
            self.status("no-model", "The speech model isn't on this PC yet. Settings → Listening → On this PC "
                                    "downloads it (or copy the engine\\models folder from another PC).")
            return
        try:
            self.status("loading", "Loading the speech model… (about 10–30 seconds)")
            self.asr = Transcriber(path, device=self.cfg["device"], log=log)
            self.seg.configure(partial_every=0.7 if self.asr.device == "cuda" else 1.5)
            self.load_tries = 0
            self.status("listening" if self.listening else "ready",
                        f"Ready — speech model running on the {self.asr.describe}.")
        except Exception as e:
            log(traceback.format_exc())
            if self.cfg["device"] != "cpu" and cuda_there():
                self.fresh_start(f"The graphics card could not be used ({e}).")      # (once; it does not come back)
                log("Trying again on the processor (CPU)…")
                try:
                    self.cfg["device"] = "cpu"
                    self.asr = Transcriber(path, device="cpu", log=log)
                    self.load_tries = 0
                    self.status("listening" if self.listening else "ready",
                                f"The graphics card could not be used ({e}). Running on the processor instead (slower).")
                    return
                except Exception as e2:
                    e = e2
            self.status("error", f"Could not load the speech model: {e}")
            self.retry_load()

    def fresh_start(self, why):
        """The graphics card failed. A clean start of the engine often cures that, so the engine stops here and the app
        starts it again, once: if the card fails again within ten minutes of that, the processor does the work instead."""
        try:
            last = float(os.environ.get("VF_GPU_RESTART_AT") or 0)
        except ValueError:
            last = 0.0
        if not self.args.managed or time.time() - last < 600:
            return
        self.out({"ev": "warn", "message": f"{why} Restarting the speech engine to try the graphics card once more…"})
        log(why, "Stopping, for the app to start the engine afresh.")
        self.close_recorder()
        time.sleep(0.3)
        os._exit(42)

    def retry_load(self):
        """The model or the service could not be started: it is tried again after 30 seconds, 2 minutes and 5 minutes."""
        delays = (30, 120, 300)
        if self.load_tries >= len(delays):
            return
        wait = delays[self.load_tries]
        self.load_tries += 1
        log(f"It will be tried again in {wait} s.")

        def again():
            if self.asr is None and self.state == "error":
                self.load_model()
        t = threading.Timer(wait, again)
        t.daemon = True
        t.start()

    def load_cloud(self):
        from cloud import CloudTranscriber, PROVIDERS
        name = self.cfg["provider"]
        try:
            self.asr = CloudTranscriber(name, os.environ.get("VF_STT_KEY", ""), self.cfg.get("keyterms"), log=log)
            self.seg.configure(max_len=10.0)          # each sentence is sent off: keep them short for speed
            self.load_tries = 0
            self.status("listening" if self.listening else "ready",
                        f"Ready — speech recognized by {PROVIDERS[name].label} (cloud, about ${PROVIDERS[name].price_per_hour:.2f} per hour).")
        except Exception as e:
            self.service_failed(e)

    def service_failed(self, e):
        """The online service could not be started. A lasting reason (no key, key refused, out of credit): the model on
        this PC takes over if it is installed. Anything else is tried again."""
        permanent = getattr(e, "permanent", False)
        if not permanent:
            log(traceback.format_exc())
        if permanent and self.fall_back_to_local(str(e), permanent=True):
            return
        self.status("error", str(e))
        if not permanent:
            self.retry_load()

    def load_live(self):
        """A service that is sent the sound as it is heard (live.py): Google through Chrome, ElevenLabs Realtime or Soniox."""
        name = self.cfg["provider"]
        try:
            from live import LIVE
            self.status("loading", f"Starting {LIVE[name].label}…")
            asr = LIVE[name](emit=self.out, log=log, ready=self.live_ready, trouble=self.live_trouble,
                             language=self.cfg["language"], sensitivity=self.cfg["sensitivity"], pause=self.cfg["pause"],
                             key=os.environ.get("VF_STT_KEY", ""), keyterms=self.cfg.get("keyterms"))
            self.asr = asr
            if self.listening:
                asr.set_listening(True)
        except Exception as e:
            self.service_failed(e)

    def live_ready(self, message):
        self.load_tries = 0
        self.status("listening" if self.listening else "ready", message)

    def live_trouble(self, message, permanent=False):
        if self.cfg["provider"] not in LIVE_NAMES:
            return                                   # it has already been replaced by the model on this PC
        if not self.fall_back_to_local(message, permanent=permanent) and permanent:
            self.status("error", message)

    def fall_back_to_local(self, why, permanent=False):
        """The online service keeps failing (no internet?): use the model on this PC if it is installed, until listening
        stops (then the chosen service is tried again: switch_back). permanent: the service refuses (key, credit), so
        it is not tried again until the engine is restarted (which a new key in Settings does). -> True if it switched."""
        why = str(why).strip()
        if why[-1:] not in ".?!":
            why += "."
        have = bool(find_model(self.args.model))
        if have:
            try:
                import torch  # noqa: F401  (the light install has no local model)
            except Exception:
                have = False
        if not have:
            if not permanent:
                self.out({"ev": "warn", "message": f"{why} Retrying…"})
            return False
        self.out({"ev": "warn", "message": f"{why} Using the speech model on this PC " + (
            "instead. (Settings → Listening has the service's key.)" if permanent
            else "for now; the chosen service is tried again when listening is stopped.")})
        with self.asr_lock:                           # (a sentence being sent to the service finishes first)
            self.cfg["provider"] = "local"
            if permanent:
                self.chosen = "local"
            old, self.asr = self.asr, None
        if getattr(old, "streaming", False):          # (not on this thread: it may be one of the service's own)
            threading.Thread(target=old.close, daemon=True).start()
        threading.Thread(target=self.load_model, daemon=True).start()
        return True

    def switch_back(self):
        """Listening stopped after a fallback to the model on this PC: go back to the service that was chosen."""
        def go():
            t0 = time.time()
            while self.finals and time.time() - t0 < 15:      # the last sentences are finished first
                time.sleep(0.2)
            if self.listening or self.cfg["provider"] == self.chosen or self.chosen not in LIVE_NAMES:
                return
            log(f"Listening stopped: going back to the chosen speech service ({self.chosen}).")
            with self.asr_lock:
                old, self.asr = self.asr, None
                self.cfg["provider"] = self.chosen
            try:
                if getattr(old, "device", "") == "cuda":
                    del old
                    import torch
                    torch.cuda.empty_cache()
            except Exception:
                pass
            self.load_model()
        threading.Thread(target=go, daemon=True, name="switch-back").start()

    @property
    def live(self):
        """The live service in use, if the chosen one is live (None while it starts)."""
        asr = self.asr
        return asr if self.cfg["provider"] in LIVE_NAMES and getattr(asr, "streaming", False) else None

    # ---------------------------------------------------------------- inputs
    def open_input(self):
        if self.input:
            self.input.stop()
            self.input = None
        w = self.want_input
        try:
            if w.get("kind") == "file":
                inp = audio_io.FileInput(w["path"], self.frames, self.out, play=w.get("play", True),
                                         realtime=w.get("realtime", True), start_at=w.get("t", 0))
            else:
                inp = audio_io.LiveInput(w.get("name", ""), w.get("kind") == "loopback", self.frames, self.out)
            self.input = inp.start()
            time.sleep(0.15)
            self.out({"ev": "input", "kind": inp.kind, "name": inp.label or w.get("name", ""), "ok": not inp.error,
                      "message": inp.error})
        except Exception as e:
            self.out({"ev": "input", "kind": w.get("kind"), "name": w.get("name", ""), "ok": False, "message": str(e)})
            log("Could not open the input:", e)

    def check_input(self, now):
        """Never stop listening: an input that died or went quiet is reopened."""
        inp = self.input
        if inp is None:
            if now >= self.input_retry_at:
                self.open_input()
            return
        if inp.kind == "file":
            if (inp.finished and self.frames.empty()) or inp.error:
                if inp.error:
                    self.out({"ev": "file", "state": "error", "message": inp.error, "name": inp.label})
                self.input = None
                self.want_input = dict(self.want_input.get("after") or {"kind": "mic", "name": ""})
                self.input_retry_at = now + 0.5
            return
        quiet = now - inp.last_data
        if inp.error or not inp.running() or quiet > 2.5:
            why = inp.error or ("no sound for a few seconds" if inp.running() else "it stopped")
            self.input_fail += 1
            log(f"Input '{inp.label or inp.kind}' problem ({why}); reopening (attempt {self.input_fail}).")
            if self.input_fail in (1, 3) or self.input_fail % 10 == 0:
                self.out({"ev": "warn", "message": f"The input stopped ({why}). Reconnecting…"})
            inp.stop()
            self.input = None
            self.input_retry_at = now + min(5.0, 0.3 * self.input_fail)
        elif getattr(inp, "fallback", False) and now - inp.started > 15:
            inp.stop()                       # using the default mic for now: see whether the chosen one is back
            self.input = None
            self.input_retry_at = now
        elif quiet < 0.5 and self.input_fail and now - inp.started > 5:
            self.input_fail = 0

    def check_silence(self, now):
        """A microphone that gives digital silence for 20 s, or next to nothing for a minute, while listening: the sound
        desk's feed is muted or unplugged, and the app would sit there "listening" to nothing. The input is opened
        afresh once (some drivers go quiet after a device change); if it stays silent, the app is told, until the
        sound is back."""
        inp = self.input
        if not self.listening or inp is None or inp.kind != "mic":
            self.last_sound = self.last_loud = now
            if self.silent:
                self.set_silent(False)
            return
        if now - self.last_sound <= 20 and now - self.last_loud <= 60:
            if self.silent and now - self.last_loud < 2:
                self.set_silent(False)
            return
        if now - self.silence_reopened > 300:
            self.silence_reopened = now
            self.last_sound = self.last_loud = now           # (the fresh input gets its 20 s / 60 s)
            log(f"No sound from '{inp.label or inp.kind}' for a while: opening it afresh.")
            inp.stop()
            self.input = None
            self.input_retry_at = now
        elif not self.silent:
            self.set_silent(True)

    def set_silent(self, on):
        self.silent = on
        inp = self.input
        name = (inp.label if inp else "") or self.want_input.get("name", "") or "the microphone"
        if on:
            msg = f"No sound is coming from “{name}”. Is the sound desk's feed to this PC muted or unplugged?"
            log(msg)
            self.out({"ev": "warn", "message": msg})
        else:
            log("Sound is coming from the input again.")
        self.out({"ev": "input", "kind": inp.kind if inp else "mic", "name": name, "ok": True, "silent": on, "message": ""})

    def pause(self):
        """The silence that ends a sentence. With an interpreter it is short (0.3 s at most), so that the pastor's
        sentence and the interpreter's fall into sentences of their own: the model writes one language at a time best."""
        p = float(self.cfg["pause"])
        return min(p, 0.3) if self.interp else p

    def note_language(self, text):
        """Notices an interpreter: of the last ten sentences, the language changed three times or more (a sentence
        holding both counts double). It is over when ten sentences in a row were in one language."""
        if len(text) < 8:
            return
        self.said_in.append("both" if two_languages(text) else "en" if latin_share(text) > 0.5 else "ar")
        del self.said_in[:-10]
        h = self.said_in
        changes = sum(1 for a, b in zip(h, h[1:]) if a != b) + h.count("both")
        on = changes >= 3 if not self.interp else not (len(h) >= 10 and changes == 0)
        if on != self.interp:
            self.interp = on
            self.seg.configure(pause=self.pause())
            log("English and Arabic by turns: an interpreter is at work. Sentences are now cut at shorter pauses and asked for in both languages."
                if on else "One language again: sentences are cut as usual.")
            self.out({"ev": "interp", "on": on})

    def out(self, ev):
        """Sends an event to the app. A finished sentence also says where it is in the recording, when there is one
        ("rec": the file, "at": seconds into it), so the sound of any line in the log can be found again."""
        if ev.get("ev") == "final" and ev.get("start") and "rec" not in ev:
            r = self.rec_at(ev["start"])
            if r:
                ev["rec"], ev["at"] = r
        self._out(ev)

    # ---------------------------------------------------------------- the recording
    def record(self, frame):
        """Keeps what is listened to as a sound file, when that is turned on (never a test recording being played)."""
        folder = self.cfg.get("record")
        inp = self.input
        if not folder or not self.listening or inp is None or inp.kind == "file":
            if self.recorder:
                self.close_recorder()
            return
        if self.recorder is None:
            try:
                self.recorder = audio_io.Recorder(folder, log)
                log("Recording what is listened to:", self.recorder.path)
                self.out({"ev": "recording", "file": self.recorder.name, "on": True, "began": round(self.recorder.began, 3)})
            except Exception as e:
                log("Could not start the recording:", e)
                self.cfg["record"] = ""
                return
        self.recorder.write(frame)

    def close_recorder(self):
        rec, self.recorder = self.recorder, None
        if rec:
            self.out({"ev": "recording", "file": rec.name, "on": False, "seconds": round(rec.pos, 1)})
            rec.close()

    def rec_at(self, started):
        """Where in the recording a sound that began at the time `started` is: (file name, seconds into it), or None.
        Worked out from how much sound the file holds now, so it stays right over a long service."""
        rec = self.recorder
        if rec is None or not started:
            return None
        return (rec.name, round(max(0.0, rec.pos - (time.time() - started)), 2))

    # ---------------------------------------------------------------- commands
    def command(self, c):
        cmd = c.get("cmd")
        if cmd == "listen":
            on = bool(c.get("on"))
            if on != self.listening:
                self.listening = on
                if not on:
                    for ev in self.seg.flush(time.time()):
                        self.schedule(ev)
                self.seg.reset()
                self.vad.reset()
                live = self.live
                if live:
                    live.set_listening(on)
                if not on and self.cfg["provider"] != self.chosen:
                    self.switch_back()
                if not on:
                    self.close_recorder()
            if self.asr:
                self.status("listening" if on else "ready")
        elif cmd == "config":
            for k in ("language", "pause", "maxLen", "sensitivity", "device", "keyterms", "record"):
                if k in c and c[k] is not None:
                    self.cfg[k] = c[k]
            self.seg.configure(pause=self.pause(), max_len=self.cfg["maxLen"] if self.cfg["provider"] == "local" else 10.0, sensitivity=self.cfg["sensitivity"])
            live = self.live
            if live:
                live.configure(language=self.cfg["language"], sensitivity=self.cfg["sensitivity"], pause=self.cfg["pause"],
                               keyterms=self.cfg.get("keyterms"))
            elif self.asr is not None and getattr(self.asr, "device", "") == "cloud":
                self.asr.keyterms = list(self.cfg.get("keyterms") or [])[:100]
        elif cmd == "input":
            spec = {k: c[k] for k in ("kind", "name", "path", "play", "realtime", "t") if k in c}
            if spec.get("kind") == "file":
                prev = self.want_input if self.want_input.get("kind") != "file" else self.want_input.get("after")
                spec["after"] = prev or {"kind": "mic", "name": ""}
            if spec != self.want_input or self.input is None or getattr(self.input, "fallback", False):
                self.want_input = spec
                self.input_fail = 0
                self.open_input()
        elif cmd == "file":
            if self.input is not None and self.input.kind == "file":
                self.input.control(c.get("action"), c.get("t"))
                if c.get("action") == "seek":
                    self.seg.reset()
        elif cmd == "transcribe":
            threading.Thread(target=self.transcribe_command, args=(c.get("id"), c.get("path")), daemon=True).start()
        elif cmd == "devices":
            self.out(dict(ev="devices", **audio_io.list_devices()))
        elif cmd == "quit":
            self.close_recorder()
            raise SystemExit(0)

    # ---------------------------------------------------------------- transcribing
    def schedule(self, ev):
        kind, sid, audio, started = ev
        job = (sid, audio, started, time.time(), self.asr is None)      # (… when it was heard, and whether a model was there)
        with self.lock:
            if kind == "final":
                self.finals.append(job)
                if self.partial and self.partial[0] == sid:
                    self.partial = None
            elif sid not in self.done_ids:
                self.partial = job
        self.wake.set()

    def start_worker(self):
        self.worker_thread = threading.Thread(target=self.worker, daemon=True, name="asr")
        self.worker_thread.start()

    def worker(self):
        """Turns the waiting sentences into text, one at a time, for as long as the engine runs. Nothing that goes wrong
        with one sentence may stop it (the main loop also starts it again if it ever ends)."""
        while True:
            self.wake.wait(0.2)
            self.wake.clear()
            try:
                self.work()
            except Exception:
                log("The transcribing thread hit a problem and carries on:\n" + traceback.format_exc())
                time.sleep(0.2)
            finally:
                self.busy_since = 0.0

    def work(self):
        while True:
            asr = self.asr                   # (this one, to the end of the sentence, whatever happens to self.asr meanwhile)
            now = time.time()
            with self.lock:
                if asr is None or getattr(asr, "streaming", False):
                    # No model at the moment (it is loading, or being changed): the sentences wait for it, 40 s at most.
                    while self.finals and now - self.finals[0][3] > 40:
                        self.finals.pop(0)
                    self.partial = None
                    return
                job, kind = None, None
                if self.finals:
                    job, kind = self.finals.pop(0), "final"
                elif self.partial:
                    job, kind = self.partial, "partial"
                    self.partial = None
                backlog = len(self.finals)
            if job is None:
                return
            sid, audio, started, queued, no_model = job
            cloud = asr.device == "cloud"
            if kind == "partial" and (sid in self.done_ids or backlog or cloud):
                continue                     # (a cloud service is paid per request: finished sentences only)
            dur = len(audio) / audio_io.RATE
            late = kind == "final" and no_model and time.time() - queued > 3      # it waited for a model to load
            self.busy_since, self.busy_len = time.time(), dur
            try:
                with self.asr_lock:
                    if self.asr is not asr:              # the model was changed while this sentence waited its turn
                        if kind == "final":
                            with self.lock:
                                self.finals.insert(0, job)
                        continue
                    more = {"both": True} if (self.interp and not cloud) else {}
                    text, lang, score, took = asr.transcribe(audio, self.cfg["language"], final=(kind == "final"), **more)
                self.errors_in_row = 0
            except Exception as e:
                self.errors_in_row += 1
                log("Could not transcribe a sentence:", e)
                if cloud:
                    switched = False
                    if getattr(e, "permanent", False):
                        switched = self.fall_back_to_local(str(e), permanent=True)
                        if not switched:
                            self.status("error", str(e))
                    elif self.errors_in_row >= 3:
                        self.errors_in_row = 0
                        switched = self.fall_back_to_local(str(e))
                    if switched and kind == "final":     # the model on this PC does this sentence
                        with self.lock:
                            self.finals.insert(0, job[:4] + (True,))
                    continue
                log(traceback.format_exc())
                if self.errors_in_row >= 3:
                    self.recover(e)
                continue
            finally:
                self.busy_since = 0.0
            if kind == "final":
                self.done_ids.add(sid)
                if len(self.done_ids) > 500:
                    self.done_ids = set(sorted(self.done_ids)[-200:])
                billed = round(asr.p.billed(dur), 2) if cloud else 0
                if not text and cloud:
                    self.out({"ev": "billed", "seconds": billed, "provider": self.cfg["provider"]})
                if text:
                    if not cloud:
                        self.note_language(text)
                    ev = {"ev": "final", "seg": sid, "text": text, "lang": lang, "start": round(started, 2),
                          "dur": round(dur, 2), "ms": int(took * 1000), "score": round(score, 3), "billed": billed,
                          "provider": self.cfg["provider"]}
                    if late:
                        ev["late"] = True                # heard a while ago: for the transcript, not for the screen
                    self.out(ev)
                if backlog >= 4 and not self.behind_warned:
                    self.behind_warned = True
                    self.out({"ev": "warn", "message": f"The speech model is {backlog} sentences behind — this PC is struggling to keep up."})
                elif backlog == 0:
                    self.behind_warned = False
            elif text:
                self.out({"ev": "partial", "seg": sid, "text": text, "lang": lang})

    def transcribe_command(self, cid, path):
        """A spoken command from the phone remote: a short recording, transcribed on its own."""
        try:
            if self.asr is None:
                raise RuntimeError("the speech model is still loading")
            import av
            c = av.open(path)
            rs = av.AudioResampler(format="flt", layout="mono", rate=audio_io.RATE)
            parts = [x.to_ndarray().reshape(-1) for fr in c.decode(c.streams.audio[0]) for x in rs.resample(fr)]
            parts += [x.to_ndarray().reshape(-1) for x in rs.resample(None)]
            c.close()
            audio = np.concatenate(parts).astype(np.float32)[: audio_io.RATE * 30] if parts else np.zeros(0, np.float32)
            if len(audio) < audio_io.RATE * 0.3:
                raise RuntimeError("the recording was empty")
            peak = float(np.abs(audio).max()) or 1.0
            audio = audio * min(10.0, 0.5 / peak)      # phone recordings can be quiet
            with self.asr_lock:
                asr = self.asr
                if asr is None:
                    raise RuntimeError("the speech model is still loading")
                text, lang, score, took = asr.transcribe(audio, self.cfg["language"], final=True)
            self.out({"ev": "command-text", "id": cid, "text": text, "lang": lang})
        except Exception as e:
            self.out({"ev": "command-text", "id": cid, "error": str(e)})

    def recover(self, err):
        """The graphics card failed several times in a row: a fresh start of the engine first (once), then the processor."""
        self.errors_in_row = 0
        asr = self.asr
        if asr is None:
            return
        try:
            asr.torch.cuda.empty_cache()
        except Exception:
            pass
        if asr.device == "cuda":
            self.fresh_start(f"The graphics card had a problem ({err}).")
            self.out({"ev": "warn", "message": f"The graphics card had a problem ({err}). Switching the speech model to the processor."})
            self.cfg["device"] = "cpu"
            with self.asr_lock:
                self.asr = None
            del asr
            self.load_model()

    # ---------------------------------------------------------------- main loop
    def first_commands(self, commands):
        """The app sends its settings (language, Bible-name hints, input, listening) the moment the engine starts. They
        are taken before the speech service is set up, so that it starts with them."""
        end, got = time.time() + 1.5, False
        while time.time() < end:
            try:
                c = commands.get(timeout=0.05)
            except queue.Empty:
                if got:
                    return
                continue
            got = True
            try:
                self.command(c)
            except SystemExit:
                raise
            except Exception as e:
                log("Bad command:", e)

    def run(self, commands, preload=False):
        if preload:                                  # testing a file by hand: load the model first
            self.load_model()
            if self.asr is None:
                return
            t0 = time.time()                         # (a live service: until it is connected)
            while self.state not in ("ready", "listening", "error") and time.time() - t0 < 40:
                time.sleep(0.1)
        else:
            if self.args.managed:
                self.first_commands(commands)
            threading.Thread(target=self.load_model, daemon=True, name="load-model").start()
        self.start_worker()
        self.out({"ev": "hello", "version": VERSION, "pid": os.getpid()})
        self.out(dict(ev="devices", **audio_io.list_devices()))
        if self.input is None:
            self.open_input()
        rms_acc, n_acc = 0.0, 0
        while True:
            now = time.time()
            try:
                while True:
                    self.command(commands.get_nowait())
            except queue.Empty:
                pass
            self.check_input(now)
            inp = self.input
            fast_file = inp is not None and inp.kind == "file" and not inp.realtime
            if fast_file and len(self.finals) >= 2:
                time.sleep(0.02)                         # testing a file at full speed: let the model catch up
                frame = None
            else:
                try:
                    frame = self.frames.get(timeout=0.05)
                except queue.Empty:
                    frame = None
            if frame is not None:
                power = float(np.mean(frame * frame))
                rms_acc += power
                n_acc += 1
                if power > 0:
                    self.last_sound = now
                    if power > 3.2e-7:                   # above -65 dB
                        self.last_loud = now
                self.record(frame)
                if self.listening:
                    p = self.vad(frame)
                    self.speech_p = max(p, self.speech_p * 0.8)
                    if self.cfg["provider"] in LIVE_NAMES:
                        live = self.live
                        if live:                         # (while it starts, the sound isn't kept for later)
                            live.feed(frame, p, now)
                    else:
                        for ev in self.seg.feed(frame, p, now):
                            self.schedule(ev)
                    if self.frames.qsize() > 600 and not fast_file:   # 20 s waiting: the PC is overloaded
                        log("Audio is piling up; skipping some to catch up.")
                        for _ in range(300):
                            self.frames.get_nowait()
            live = self.live
            if live:
                live.tick(now)
            self.check_silence(now)
            # the transcribing thread must be there, and must not sit on one sentence for ever
            busy = now - self.busy_since if self.busy_since else 0.0
            if not self.worker_thread.is_alive():
                log("The transcribing thread had stopped: starting it again.")
                self.out({"ev": "warn", "message": "The speech engine had a problem and put itself right."})
                self.start_worker()
            elif busy > max(90.0, 8 * self.busy_len) and self.args.managed:
                log(f"One sentence has taken {busy:.0f} s: the speech model is stuck. Stopping, for the app to start the engine afresh.")
                self.close_recorder()
                os._exit(43)
            if now - self.last_level_emit >= 0.1 and n_acc:
                rms = (rms_acc / n_acc) ** 0.5
                db = 20 * np.log10(rms) if rms > 1e-9 else -100.0
                self.out({"ev": "level", "db": round(float(db), 1), "speech": round(self.speech_p, 2)})
                rms_acc, n_acc, self.last_level_emit = 0.0, 0, now
                self.speech_p *= 0.5
            if now - self.last_hb >= 2.0:
                self.last_hb = now
                with self.lock:
                    backlog = len(self.finals)
                    oldest = now - self.finals[0][3] if self.finals else 0.0
                inp, asr = self.input, self.asr
                self.out({"ev": "hb", "uptime": int(now - START), "backlog": backlog, "listening": self.listening,
                          "input": inp.label if inp else "", "inputKind": inp.kind if inp else "",
                          "busy": round(busy, 1), "oldest": round(oldest, 1), "silent": self.silent,
                          "recording": bool(self.recorder),
                          "speed": round(asr.speed, 3) if asr and getattr(asr, "speed", None) is not None else None})


def read_commands(q):
    try:
        for line in sys.stdin.buffer:
            line = line.strip()
            if not line:
                continue
            try:
                q.put(json.loads(line.decode("utf-8")))
            except Exception as e:
                log("Bad command:", e)
    except Exception:
        pass
    # the app is gone: finish the recording properly, then stop (at once, if that takes more than a few seconds)
    log("The app closed; stopping the speech engine.")
    q.put({"cmd": "quit"})
    time.sleep(5)
    os._exit(0)


def main():
    ap = argparse.ArgumentParser(description="Arabic Church Assistant speech engine")
    ap.add_argument("--file", help="transcribe an audio/video file and print the text")
    ap.add_argument("--fast", action="store_true", help="with --file: as fast as possible, without playing it")
    ap.add_argument("--quiet", action="store_true", help="with --file: in real time, without playing it on the speakers")
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--model", help="folder of the speech model")
    ap.add_argument("--device", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--language", default="auto", choices=["auto", "ar", "en"])
    ap.add_argument("--provider", default="local", help="local; google (through Chrome, free); or a paid service: "
                                                        "elevenlabs | deepgram (key in VF_STT_KEY)")
    ap.add_argument("--managed", action="store_true", help="started by the app (JSON on stdin/stdout)")
    args = ap.parse_args()

    if args.list_devices:
        d = audio_io.list_devices()
        print("Microphones:")
        for m in d["mics"]:
            print("  ", m["name"], "(Windows default)" if m["default"] else "")
        print("Speakers (\"this PC's sound\"):")
        for s in d["speakers"]:
            print("  ", s["name"], "(Windows default)" if s["default"] else "")
        return

    out = Out(json_mode=args.managed)
    eng = Engine(out, args)
    eng.cfg["language"] = args.language
    commands = queue.Queue()
    if args.managed:
        threading.Thread(target=read_commands, args=(commands,), daemon=True, name="stdin").start()
    else:
        fast = args.fast and args.provider not in LIVE_NAMES     # a live service has to hear the sound in real time
        eng.want_input = ({"kind": "file", "path": args.file, "play": not (args.fast or args.quiet), "realtime": not fast}
                          if args.file else {"kind": "mic", "name": ""})
        eng.listening = True

        def stop_when_done():
            while True:
                time.sleep(0.5)
                inp = eng.input
                if args.file and (inp is None or inp.kind != "file") and eng.asr and not eng.finals and eng.frames.empty() and eng.want_input.get("kind") != "file":
                    if eng.live:                     # the last sentence: close it and wait for its text
                        eng.live.set_listening(False)
                        time.sleep(4)
                    time.sleep(1.5)
                    os._exit(0)
        threading.Thread(target=stop_when_done, daemon=True).start()
    try:
        eng.run(commands, preload=bool(args.file) and not args.managed)
    except SystemExit:
        pass
    except KeyboardInterrupt:
        pass
    os._exit(0)


if __name__ == "__main__":
    main()
