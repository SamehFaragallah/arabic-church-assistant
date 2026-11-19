"""Live speech services: the sound is sent as it is heard, and the words come back while the pastor is still talking.

    google       Google's speech recognition, the one inside Chrome (free, online). The engine starts a hidden Chrome
                 (headless, with a profile of its own) on a page it serves itself (google.html) and passes it the sound
                 over a WebSocket on this PC.
    elevenlabs   ElevenLabs Scribe Realtime (paid, online), over their WebSocket API.
    soniox       Soniox real-time speech-to-text (paid, online), over their WebSocket API.

Church sound never goes quite silent, so neither service can tell by itself where a sentence ends. The engine's own voice
detector (Silero) finds the pauses, and that is where a sentence is closed off: Google gets a new recognition session,
ElevenLabs a commit, Soniox a request to confirm what it has heard (it also closes sentences by itself, where it hears
the speaker finish). All keep listening for as long as the service lasts and recover by themselves from a dropped
connection.

Every provider has the same shape as asr.Transcriber where the engine needs it (device, describe, speed, transcribe() for
the phone remote's spoken commands) plus: feed(frame, prob, now), set_listening(on), configure(...), tick(now), close().
"""
import base64
import collections
import json
import re
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

import numpy as np

from asr import clean_text, latin_share
from audio_io import FRAME, RATE

HERE = os.path.dirname(os.path.abspath(__file__))
FRAME_S = FRAME / RATE
DEBUG = os.environ.get("VF_GOOGLE_DEBUG") == "1"         # (log each sentence's two Google texts and the one kept)
NO_WINDOW = 0x08000000                       # CREATE_NO_WINDOW


class LiveError(Exception):
    def __init__(self, message, permanent=False):
        super().__init__(message)
        self.permanent = permanent


def pcm16(audio):
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


# --------------------------------------------------------------------------------------------- where to close a sentence
class Cutter:
    """Says when to close off what has been said so far: at a pause once min_len seconds have been said; after
    soft_after seconds a short dip between two words will do; after max_len seconds it closes anyway."""

    def __init__(self, min_len=4.0, pause=0.3, soft_after=15.0, soft_pause=0.15, max_len=18.0, sensitivity=0.5):
        self.min_f = int(min_len / FRAME_S)
        self.soft_f = int(soft_after / FRAME_S)
        self.max_f = int(max_len / FRAME_S)
        self.soft_pause_f = max(2, int(round(soft_pause / FRAME_S)))
        self.pause_f = max(3, int(round(pause / FRAME_S)))
        self.configure(sensitivity=sensitivity)
        self.reset()

    def configure(self, sensitivity=None, pause=None, min_len=None):
        if sensitivity is not None:
            s = min(0.9, max(0.1, float(sensitivity)))
            self.cont_p = max(0.15, (1.0 - s) - 0.15)       # as asr.Segmenter: speech goes on while above this
        if pause is not None:
            self.pause_f = max(3, int(round(float(pause) / FRAME_S)))
        if min_len is not None:
            self.min_f = int(float(min_len) / FRAME_S)

    def reset(self):
        self.age = 0          # frames since the first speech after the last cut
        self.speech = 0
        self.silence = 0

    def feed(self, prob):
        talking = prob >= self.cont_p
        if not self.speech and not talking:
            return False                                       # nothing said since the last cut: nothing to close
        self.age += 1
        if talking:
            self.speech += 1
            self.silence = 0
        else:
            self.silence += 1
        if self.speech < 8:                                    # under 0.25 s of speech: a cough or a click
            if self.silence >= self.pause_f:
                self.reset()                                   # (and the time since doesn't count)
            return False
        if ((self.age >= self.min_f and self.silence >= self.pause_f)
                or (self.age >= self.soft_f and self.silence >= self.soft_pause_f) or self.age >= self.max_f):
            self.reset()
            return True
        return False

    def paused(self):
        """Something was said, and then a pause long enough to end a sentence (however short the sentence is)."""
        return self.speech >= 8 and self.silence >= self.pause_f


# --------------------------------------------------------------------------------------------- shared by the providers
class Live:
    name = ""
    label = ""
    describe = ""
    price_per_hour = 0.0
    device = "cloud"
    gpu_name = ""
    streaming = True

    def __init__(self, emit, log, ready, trouble, language="auto"):
        self.emit, self.log, self.on_ready, self.on_trouble = emit, log, ready, trouble
        self.language = language
        self.speed = None
        self.listening = False
        self.closed = False
        self.seg = 0
        self.plock = threading.Lock()
        self._pending = None                   # newest live text not passed on yet (at most 5 a second)
        self._last_partial = ""
        self._last_partial_at = 0.0
        self.seg_from = time.time()            # when what is being said now began (roughly)

    # ---- text coming back
    def partial(self, text):
        with self.plock:
            self._pending = text or ""
        self.flush_partial(time.time())

    def flush_partial(self, now):
        with self.plock:
            if self._pending is None or now - self._last_partial_at < 0.2:
                return
            text, self._pending = clean_text(self._pending), None
            if text == self._last_partial:
                return
            self._last_partial, self._last_partial_at = text, now
        if text:
            self.emit({"ev": "partial", "seg": self.seg + 1, "text": text, "lang": "en" if latin_share(text) > 0.5 else "ar"})

    def final(self, text, ms=None, start=None):
        text = clean_text(text)
        now = time.time()
        with self.plock:
            self._pending, self._last_partial = None, ""
        if not text:
            return
        self.seg += 1
        start = self.seg_from if start is None else start
        self.emit({"ev": "final", "seg": self.seg, "text": text, "lang": "en" if latin_share(text) > 0.5 else "ar",
                   "start": round(start, 2), "dur": round(max(0.0, now - start), 2), "ms": ms, "score": 0.0,
                   "billed": 0, "provider": self.name})
        self.seg_from = now

    def tick(self, now):
        self.flush_partial(now)

    def configure(self, language=None, sensitivity=None, pause=None, keyterms=None):
        if language:
            self.language = language

    def close(self):
        self.closed = True


# --------------------------------------------------------------------------------------------- Google (through Chrome)
def find_chrome():
    """Google Chrome's chrome.exe: the app passes it in VF_CHROME; otherwise the usual places and the registry."""
    cands = [os.environ.get("VF_CHROME", "")]
    if sys.platform == "darwin":
        for base in ("/Applications", os.path.expanduser("~/Applications")):
            cands.append(os.path.join(base, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"))
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), os.environ.get("LOCALAPPDATA")):
        if base:
            cands.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    try:
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe") as k:
                    cands.append(str(winreg.QueryValue(k, None)).strip('"'))
            except OSError:
                pass
    except ImportError:
        pass
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


class _Job:
    """A Windows job object: whatever is put in it (Chrome and its helper processes) ends when this engine ends, even if
    the engine is killed. Without it a hidden Chrome could be left running."""

    def __init__(self):
        self.h = None
        if os.name != "nt":
            return
        try:
            import ctypes
            from ctypes import wintypes

            class Basic(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                            ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

            class Io(ctypes.Structure):
                _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                           "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

            class Extended(ctypes.Structure):
                _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", Io), ("ProcessMemoryLimit", ctypes.c_size_t),
                            ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                            ("PeakJobMemoryUsed", ctypes.c_size_t)]

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateJobObjectW.restype = wintypes.HANDLE
            k32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
            k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
            k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            nt = ctypes.WinDLL("ntdll")
            nt.NtResumeProcess.argtypes = [wintypes.HANDLE]
            h = k32.CreateJobObjectW(None, None)
            info = Extended()
            info.BasicLimitInformation.LimitFlags = 0x2000           # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if h and k32.SetInformationJobObject(h, 9, ctypes.byref(info), ctypes.sizeof(info)):   # 9: extended limits
                self.h, self.k32, self.nt = h, k32, nt
        except Exception:
            self.h = None

    def start(self, args):
        """Starts a program inside the job (suspended until it is in, so its first helper processes are in too)."""
        if os.name != "nt":
            # (a Mac has no job objects: a small watcher starts the program in a process group of its own, and ends that
            # group, the program's helpers too, when this engine ends, however it ends. kill_tree ends the group.)
            return subprocess.Popen([sys.executable, "-c", _WATCHER, str(os.getpid())] + list(args), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)
        flags = NO_WINDOW | (0x4 if self.h else 0)                   # 0x4: CREATE_SUSPENDED
        p = subprocess.Popen(args, creationflags=flags, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, close_fds=True)
        if self.h:
            try:
                self.k32.AssignProcessToJobObject(self.h, int(p._handle))
            finally:
                self.nt.NtResumeProcess(int(p._handle))
        return p


_WATCHER = """
import os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
engine = int(sys.argv[1])
p = subprocess.Popen(sys.argv[2:], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
while p.poll() is None and os.getppid() == engine:
    time.sleep(0.5)
if p.poll() is None:
    os.killpg(0, signal.SIGTERM)
    for _ in range(20):
        if p.poll() is not None:
            break
        time.sleep(0.25)
    os.killpg(0, signal.SIGKILL)
sys.exit(p.returncode if p.returncode and p.returncode > 0 else 0)
"""


def _pid_alive(pid):
    """Is that process still running? (Windows; os.kill(pid, 0) would end it there.)"""
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except OSError:
            return True
        return True
    try:
        import ctypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = ctypes.c_void_p
        h = k32.OpenProcess(0x1000, False, pid)                  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ctypes.get_last_error() == 5                  # access denied: it exists
        code = ctypes.c_ulong()
        try:
            k32.GetExitCodeProcess(ctypes.c_void_p(h), ctypes.byref(code))
            return code.value == 259                             # STILL_ACTIVE
        finally:
            k32.CloseHandle(ctypes.c_void_p(h))
    except Exception:
        return True


def kill_tree(p):
    if p is None or p.poll() is not None:
        return
    if os.name != "nt":                          # (the watcher's process group: Chrome and its helpers)
        for sig, wait in ((signal.SIGTERM, 3.0), (signal.SIGKILL, 2.0)):
            try:
                os.killpg(p.pid, sig)
            except OSError:
                return
            try:
                p.wait(timeout=wait)
                return
            except subprocess.TimeoutExpired:
                pass
        return
    try:
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], creationflags=NO_WINDOW,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass


class GoogleSpeech(Live):
    """Google's speech recognition in a hidden Chrome. Free; needs internet and Google Chrome on this PC."""

    name = "google"
    label = "Google (Chrome)"
    describe = "Google (Chrome)"

    def __init__(self, emit, log, ready, trouble, language="auto", sensitivity=0.5, **_):
        super().__init__(emit, log, ready, trouble, language)
        self.chrome = find_chrome()
        if not self.chrome:
            raise LiveError("Google speech runs inside Google Chrome, which isn't on this PC. Install Chrome (google.com/chrome, "
                            "free), or choose another option in Settings → Listening → Speech recognition.", permanent=True)
        from websockets.sync.server import serve
        with open(os.path.join(HERE, "google.html"), encoding="utf-8") as f:
            self.html = f.read()
        # Google tends to close a sentence late on church sound; these are the settings tested on our sermon recordings
        self.cutter = Cutter(min_len=4.0, pause=0.3, soft_after=15.0, soft_pause=0.15, max_len=18.0, sensitivity=sensitivity)
        self.out = collections.deque()          # to the page: the sound (bytes) and commands (str)
        self.out_ready = threading.Event()
        self.conn = None
        self.connected = False
        self.last_hb = 0.0
        self.last_cut_at = 0.0
        self.waiters = {}                       # spoken commands waiting for their text
        self.failing_since = 0.0                # first network error since text last came back
        self.last_error_at = 0.0
        self.warned_at = 0.0
        self.refused = ""                       # the last refusal reported (reported once)
        self.fails = collections.deque()
        self.proc = None
        self.launches = 0
        self.launched_at = 0.0
        self.lost_at = 0.0                      # when the page's connection last dropped
        # Arabic + English: an Arabic and an English recognizer on the same sound; each sentence's two texts are kept until
        # both recognizers have finished it, and the one that makes sense is passed on
        self.dual = os.environ.get("VF_GOOGLE_DUAL", "1") != "0"
        self.sent_langs = ["ar-EG"]             # the languages the page was last told to listen in
        self.cands = {}                         # session -> {"texts": {lang: [...]}, "conf": {lang: x}, "ended": set(), "t": time}
        self.parts = {}                         # (session, lang) -> words still being said
        self.part_sid = None
        self.part_lang = "ar"                   # the language the words still being said are shown in
        self.last_lang = "ar"                   # the language of the last sentence passed on
        self.on_cands = None                    # (tests) every sentence's two texts and which one was kept
        self.decided = {}                       # session -> (language passed on "ar"/"en", Arabic text, English text)
        self.said_in = []                       # the languages of the last ten sentences (an interpreter at work?)
        self.interp = False
        self.job = _Job()
        self.server = serve(self._handler, "127.0.0.1", 0, process_request=self._http, compression=None, max_size=2 ** 23)
        self.port = self.server.socket.getsockname()[1]
        threading.Thread(target=self.server.serve_forever, daemon=True, name="google-page").start()
        threading.Thread(target=self._sender, daemon=True, name="google-send").start()
        self.profiles = os.path.join(os.environ.get("VF_DATA_DIR") or os.path.join(os.path.dirname(HERE), "data"), "chrome-speech")
        self._clean_profiles(keep_mine=False)
        self._launch()
        threading.Thread(target=self._watch, daemon=True, name="google-watch").start()

    # ---- language
    def _lang(self, mode=None):
        return "en-US" if (mode or self.language) == "en" else "ar-EG"

    def _langs(self):
        """Arabic + English (the usual setting): a recognizer for each. One language chosen in Settings: that one only."""
        return ["ar-EG", "en-US"] if (self.language not in ("ar", "en") and self.dual) else [self._lang()]

    def _listen_cmd(self, on):
        self.sent_langs = self._langs()
        return {"cmd": "listen", "on": on, "lang": self._lang(), "langs": self.sent_langs}

    def configure(self, language=None, sensitivity=None, pause=None, keyterms=None):
        changed = bool(language) and language != self.language
        super().configure(language=language)
        if sensitivity is not None:
            self.cutter.configure(sensitivity=sensitivity)
        if changed:
            self._send(self._listen_cmd(self.listening))
            if self.listening:
                self._send({"cmd": "cut"})               # the new language is used from the next session on

    # ---- Chrome
    def _launch(self):
        self.launches += 1
        prof = os.path.join(self.profiles, f"p{os.getpid()}-{self.launches}")
        # (without the "disable" lines below, a fresh profile made Chrome download about 120 MB of its own extras every
        # time: page-prediction models, Safe Browsing lists, spelling and password data. Speech does not need them.)
        args = [self.chrome, "--headless", f"--user-data-dir={prof}", "--no-first-run", "--no-default-browser-check",
                "--disable-extensions", "--disable-gpu", "--autoplay-policy=no-user-gesture-required",
                "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows", "--disable-component-update", "--disable-background-networking",
                "--safebrowsing-disable-auto-update", "--disable-client-side-phishing-detection", "--disable-sync",
                "--disable-default-apps", "--no-pings", "--disable-domain-reliability",
                "--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,"
                "OptimizationHints,Translate,MediaRouter",
                "--log-level=3", f"http://127.0.0.1:{self.port}/"]
        if sys.platform == "darwin":                 # (no question about the Mac's keychain for a fresh profile)
            args[1:1] = ["--use-mock-keychain"]
        self.launched_at = time.time()
        try:
            self.proc = self.job.start(args)
            self.log(f"Google speech: started Chrome (process {self.proc.pid}).")
        except Exception as e:
            self.proc = None
            self.log(f"Google speech: could not start Chrome: {e}")

    def _clean_profiles(self, keep_mine=True):
        """Each Chrome gets a fresh profile; the ones left from before are removed (not those of another engine that is
        still running)."""
        try:
            for d in os.listdir(self.profiles):
                if keep_mine and d == f"p{os.getpid()}-{self.launches}":
                    continue
                pid = d[1:].split("-")[0]
                if pid.isdigit() and int(pid) != os.getpid() and _pid_alive(int(pid)):
                    continue
                shutil.rmtree(os.path.join(self.profiles, d), ignore_errors=True)
        except OSError:
            pass

    def _watch(self):
        while not self.closed:
            time.sleep(1.0)
            now = time.time()
            p = self.proc
            if p is None or p.poll() is not None:
                why = "Chrome closed" + (f" (code {p.returncode})" if p is not None else "")
            elif not self.connected and now - max(self.launched_at, self.lost_at) > 20:
                why = "Chrome did not open the speech page"
            elif self.connected and now - self.last_hb > 30:
                why = "the speech page stopped answering"
            else:
                continue
            if self.closed:
                return
            while self.fails and now - self.fails[0] > 300:
                self.fails.popleft()
            self.fails.append(now)
            self.log(f"Google speech: {why}; starting Chrome again.")
            if len(self.fails) >= 4:
                self.on_trouble(f"Google speech keeps stopping ({why}).", False)
                time.sleep(20)
            kill_tree(self.proc)
            self.connected = False
            self._clean_profiles(keep_mine=False)
            if not self.closed:
                self._launch()

    # ---- the page: served on this PC only
    def _http(self, connection, request):
        path = request.path.split("?")[0]
        if path == "/ws":
            return None
        if path in ("/", "/index.html"):
            r = connection.respond(200, self.html)
            del r.headers["Content-Type"]
            r.headers["Content-Type"] = "text/html; charset=utf-8"
            r.headers["Cache-Control"] = "no-store"
            return r
        return connection.respond(404, "Not found")

    def _handler(self, conn):
        old, self.conn = self.conn, conn
        self.connected = False                   # until this page says it is ready
        if old is not None:
            try:
                old.close()
            except Exception:
                pass
        self.last_hb = time.time()
        try:
            for msg in conn:
                if isinstance(msg, str):
                    try:
                        self._on(json.loads(msg))
                    except Exception as e:
                        self.log("Google speech: bad message from the page:", e)
        except Exception:
            pass
        finally:
            if self.conn is conn:
                self.conn = None
                self.connected = False
                self.lost_at = time.time()

    def _on(self, m):
        ev = m.get("ev")
        self.last_hb = time.time()
        two = bool(m.get("lang")) and len(self.sent_langs) > 1
        if ev == "partial":
            self.failing_since = 0.0
            if two:
                self._dual_partial(m.get("session"), m["lang"], m.get("text", ""))
            else:
                self.partial(m.get("text", ""))
        elif ev == "final":
            self.failing_since = 0.0
            if two:
                sid = m.get("session")
                if sid in self.decided:
                    self._late(sid, m["lang"], m.get("text", ""))
                    return
                c = self._cand(sid)
                c["texts"].setdefault(m["lang"], []).append(m.get("text", ""))
                c["alts"].setdefault(m["lang"], []).extend(m.get("alts") or [])
                c["conf"][m["lang"]] = max(c["conf"].get(m["lang"], 0.0), float(m.get("conf") or 0.0))
            else:
                ms = int((time.time() - self.last_cut_at) * 1000) if time.time() - self.last_cut_at < 8 else None
                self.final(m.get("text", ""), ms=ms)
        elif ev == "ended":
            if two:
                if m.get("session") in self.decided:
                    return
                c = self._cand(m.get("session"))
                c.setdefault("ended_at", time.time())
                c["ended"].add(m["lang"])
                c["dur"] = max(c.get("dur", 0.0), float(m.get("dur") or 0) / 1000.0)
                if c["ended"] >= set(self.sent_langs):
                    self._decide(m.get("session"))
        elif ev == "ready":
            if not m.get("ok"):
                self.on_trouble("Google speech can't start in Chrome: " + (m.get("error") or "unknown problem"), True)
                return
            self.connected = True
            self.out.clear()
            self._send(self._listen_cmd(self.listening))
            self.on_ready("Ready — speech recognized by Google, through Chrome (free; needs internet).")
        elif ev == "once":
            w = self.waiters.get(m.get("id"))
            if w:
                w[1] = (m.get("text") or "", m.get("error") or "")
                w[0].set()
        elif ev == "error":
            self._error(m.get("error", ""), m.get("message", ""))
        elif ev == "log":
            self.log("Google speech:", m.get("message", ""))

    def _error(self, err, message):
        now = time.time()
        if err in ("not-allowed", "service-not-allowed", "language-not-supported"):
            if err != self.refused:                  # (the page keeps trying every 10 s; say it once)
                self.refused = err
                self.on_trouble(f"Google refused the speech recognition ({err}{': ' + message if message else ''}).", True)
            return
        self.log(f"Google speech: {err}{' — ' + message if message else ''}")
        if err in ("network", "start"):
            # a short drop is ridden out (the page tries again by itself); only an outage of 30 s or more counts
            if not self.failing_since or now - self.last_error_at > 60:
                self.failing_since = now
            self.last_error_at = now
            if now - self.failing_since >= 30 and now - self.warned_at > 120:
                self.warned_at = now
                self.on_trouble("Google speech isn't answering (is this PC online?).", False)

    # ---- two languages
    def _cand(self, sid):
        c = self.cands.get(sid)
        if c is None:
            c = self.cands[sid] = {"texts": {}, "alts": {}, "conf": {}, "ended": set(), "t": time.time()}
        return c

    def _dual_partial(self, sid, lang, text):
        if sid != self.part_sid:                  # a new sentence: shown in the last one's language until the other is ahead
            self.part_sid = sid
            self.parts = {}
            self.part_lang = self.last_lang
        self.parts[lang] = text
        ar, en = self.parts.get("ar-EG", ""), self.parts.get("en-US", "")
        self.part_lang = pick_partial(ar, en, self.part_lang)
        self.partial(en if self.part_lang == "en" else ar)

    def _decide(self, sid):
        c = self.cands.pop(sid, None)
        if c is None:
            return
        ar, en = " ".join(c["texts"].get("ar-EG", [])).strip(), " ".join(c["texts"].get("en-US", [])).strip()
        ca, ce = c["conf"].get("ar-EG", 0.0), c["conf"].get("en-US", 0.0)
        lang = pick_language(ar, ca, en, ce, dur=c.get("dur", 0.0))
        text = en if lang == "en" else ar
        if text and not is_command(text) and len(text.split()) <= 3:
            # a few words that aren't a command, when the other language's text or one of Google's other guesses is one:
            # it was the command, misheard
            for alt in [en, ar] + c["alts"].get("en-US", []) + c["alts"].get("ar-EG", []):
                if alt and is_command(alt):
                    text, lang = alt, ("en" if latin_share(alt) > 0.5 else "ar")
                    break
        if DEBUG:
            self.log(f"Google #{sid}: ar «{ar}» {ca:.2f} | en \"{en}\" {ce:.2f} | alts {c['alts']} | ended {sorted(c['ended'])} -> {lang}")
        self.decided[sid] = (lang, ar, en)
        while len(self.decided) > 50:
            self.decided.pop(next(iter(self.decided)))
        self._note_language(text, lang)
        if self.on_cands:
            self.on_cands({"session": sid, "ar": ar, "ar_conf": ca, "en": en, "en_conf": ce, "dur": c.get("dur", 0.0), "pick": lang, "t": time.time()})
        ms = int((time.time() - self.last_cut_at) * 1000) if time.time() - self.last_cut_at < 8 else None
        if text:
            self.last_lang = lang
        self.final(text, ms=ms)

    def _late(self, sid, lang, text):
        """Words of a sentence that was already passed on (one recognizer took more than 3 s to finish after the other).
        In the language that was kept, they go straight on. In the other language they are passed on too if they are
        the better text (Psalm 5:9 read in Arabic and then in English: the Arabic two words had gone on, and the English
        verse came after); otherwise they are dropped."""
        kept, ar, en = self.decided[sid]
        if not text:
            return
        if lang[:2] == kept:
            self.final(text)
            return
        ar2, en2 = (ar + " " + text, en) if lang == "ar-EG" else (ar, en + " " + text)
        if pick_language(ar2.strip(), 0.0, en2.strip(), 0.0) == lang[:2]:
            self.decided[sid] = (lang[:2], ar2, en2)
            self.final(text)
        elif DEBUG:
            self.log(f"Google #{sid}: late {lang} words dropped: {text}")

    def _note_language(self, text, lang):
        """An interpreter (English and Arabic by turns): as in the engine, of the last ten sentences the language changed
        three times or more; over when ten in a row were in one language. Then a sentence may be cut after 1.5 s instead
        of 4, so that the pastor's words and the interpreter's fall into sentences of their own and both are kept."""
        if len(text) < 8:
            return
        self.said_in = (self.said_in + [lang])[-10:]
        h = self.said_in
        changes = sum(1 for a, b in zip(h, h[1:]) if a != b)
        on = changes >= 3 if not self.interp else not (len(h) >= 10 and changes == 0)
        if on != self.interp:
            self.interp = on
            self.cutter.configure(min_len=1.5 if on else 4.0)
            self.log("English and Arabic by turns: an interpreter is at work. Sentences are now cut at shorter pauses."
                     if on else "One language again: sentences are cut as usual.")

    def tick(self, now):
        super().tick(now)
        for sid, c in list(self.cands.items()):
            # one recognizer finished 3 s ago and the other hasn't (the page ends them 2 s after a cut): decide without it.
            # (Counted from its end, not from the first words: an Arabic phrase at the start of a long English sentence
            # would otherwise cut the English off.)
            if (c["ended"] and now - c.get("ended_at", c["t"]) > 3.0) or now - c["t"] > 30.0:
                self._decide(sid)

    # ---- to the page
    def _send(self, item):
        if not isinstance(item, (bytes, str)):
            item = json.dumps(item)
        if len(self.out) > 600:                      # about 20 s piled up: the page is gone; keep the newest
            self.out.popleft()
        self.out.append(item)
        self.out_ready.set()

    def _sender(self):
        while not self.closed:
            self.out_ready.wait(1.0)
            self.out_ready.clear()
            while self.out:
                conn = self.conn
                if conn is None or not self.connected:
                    self.out.clear()                 # nobody to send to: when the page is back it is told what to do
                    break
                item = self.out.popleft()
                try:
                    conn.send(item)
                except Exception:
                    break

    # ---- from the engine
    def set_listening(self, on):
        on = bool(on)
        if on == self.listening:
            return
        self.listening = on
        self.cutter.reset()
        self.seg_from = time.time()
        self._send(self._listen_cmd(on))

    def feed(self, frame, prob, now):
        if not self.listening:
            return
        self._send(pcm16(frame))
        cut = self.cutter.feed(prob)
        # a spoken command ("Next", «اللي بعده») is acted on at the pause after it, not once 4 seconds have been said
        if not cut and self.cutter.paused() and self._command_said():
            self.cutter.reset()
            cut = True
        if cut:
            self.last_cut_at = now
            self._send({"cmd": "cut"})

    def _command_said(self):
        texts = [self._last_partial] + (list(self.parts.values()) if len(self.sent_langs) > 1 else [])
        return any(is_command(t) for t in texts if t)

    def transcribe(self, audio, mode="auto", final=True):
        """A spoken command from the phone remote: recognized by its own short session beside the live one; in Arabic and
        English at once when listening is in both, keeping the one that makes sense."""
        if not self.connected:
            raise RuntimeError("Google speech isn't ready yet")
        t0 = time.time()
        langs = [self._lang(mode)] if mode in ("ar", "en") else self._langs()
        pcm = base64.b64encode(pcm16(audio)).decode("ascii")
        waits = {}
        try:
            for lang in langs:
                cid = uuid.uuid4().hex
                waits[lang] = (cid, self.waiters.setdefault(cid, [threading.Event(), None]))
                self._send({"cmd": "once", "id": cid, "lang": lang, "pcm": pcm})
            limit = time.time() + len(audio) / RATE + 10
            for cid, w in waits.values():
                w[0].wait(max(0.1, limit - time.time()))
        finally:
            for cid, _ in waits.values():
                self.waiters.pop(cid, None)
        got = {lang: w[1] for lang, (cid, w) in waits.items() if w[1] is not None}
        if not got:
            raise RuntimeError("Google speech took too long")
        texts = {lang: clean_text(r[0]) for lang, r in got.items()}
        if len(texts) == 2:
            ar, en = texts.get("ar-EG", ""), texts.get("en-US", "")
            text = en if pick_language(ar, 0.0, en, 0.0) == "en" else ar
        else:
            text = next(iter(texts.values()))
        err = next((r[1] for r in got.values() if r[1]), "")
        if not text and err:
            raise RuntimeError("Google speech: " + err)
        return text, ("en" if latin_share(text) > 0.5 else "ar"), 0.0, time.time() - t0

    def close(self):
        super().close()
        kill_tree(self.proc)
        try:
            self.server.shutdown()
        except Exception:
            pass


_AR_LETTER = re.compile(r"[ء-ي]")
_EN_LETTER = re.compile(r"[A-Za-z]")
_NUMBER = re.compile(r"\d+")
_EN_COMMANDS = {"next", "next verse", "the next verse", "next one", "previous", "previous verse", "the previous verse",
                "go back", "back"}
# a reference said in English: a book of the Bible, then chapter and verse ("John 1:5", "1 Peter 3 7", "Psalm 23 verse 1")
_EN_REF = re.compile(r"\b(?:genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|"
                     r"esther|job|psalms?|proverbs|ecclesiastes|songs?|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|"
                     r"obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|"
                     r"corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|"
                     r"peter|jude|revelations?)\s+(?:chapter\s+)?\d+(?:\s*[:.]\s*|\s+verses?\s+|\s+)\d+", re.I)


_COMMANDS = {"next", "next verse", "the next verse", "next one", "previous", "previous verse", "the previous verse", "go back",
             "التالي", "التاليه", "السابق", "السابقه", "اللي بعده", "اللي بعدها", "اللي بعديه", "اللي بعديها", "اللي قبله",
             "اللي قبلها", "اللي قبليه", "اللي قبليها", "العدد اللي بعده", "العدد اللي قبله", "الايه اللي بعدها", "الايه اللي قبلها",
             "العدد التالي", "الايه التاليه", "العدد السابق", "الايه السابقه"}


# What Google writes for "next verse" when it mishears it, as all that was said (heard on 2026-11-18): "next word",
# "Nexus 1", and from its Arabic recognizer «اكس بوكس», «نكسبر»
_MISHEARD_NEXT = re.compile(r"(?:the )?next (?:verses|words?|first|birth|purse|worse|nurse)|nexus(?: (?:1|one|1st|first))?|"
                            r"(?:ال)?اكس بوكس|نكست(?: ?(?:فيرس|فرس|فيرز|بيرس))?|نكس ?(?:بر|فيرس|فرس|فيرز|بيرس)|نيكست(?: ?فيرس)?")


def is_command(text):
    """Is this all that was said a spoken command to move the screen ("Next.", «اللي بعده»)?"""
    t = re.sub(r"[\u064B-\u0652\u0640]", "", (text or "").lower())
    t = t.replace("ة", "ه").replace("ى", "ي").replace("أ", "ا").replace("إ", "ا").replace("آ", "ا")
    t = " ".join(re.sub(r"[^\w\s]", " ", t).split())
    return t in _COMMANDS or bool(_MISHEARD_NEXT.fullmatch(t))      # (or Google's way of mishearing "next verse")


def _said_ar(t):
    """About how much speech an Arabic text stands for, counted in English letters: Arabic is written without its short
    vowels, and a number in digits was said as a word or two."""
    if latin_share(t) > 0.5:
        return 0.0                              # the Arabic recognizer wrote English words itself ("let's"): English was said
    return 1.5 * len(_AR_LETTER.findall(t)) + 5.0 * len(_NUMBER.findall(t))


def _said_en(t):
    return float(len(_EN_LETTER.findall(t))) + 4.0 * len(_NUMBER.findall(t))


def pick_language(ar, ar_conf, en, en_conf, dur=0.0):
    """Which of the two texts of one sentence to keep, "ar" or "en". Google's Arabic and English recognizers heard the same
    sound, and the one in the wrong language writes it as best it can in its own. English heard by the Arabic one comes out
    as a word or two («ماتش», «كيف») where the English one has the whole sentence; Arabic heard by the English one comes out
    as English words about as long as the Arabic ("Iowa Stephanie" for «ايوه اشتغل»), often with a high confidence, so the
    confidence does not tell them apart. So the English text is kept when it says much more than the Arabic one, and a
    short English command ("Next") is kept too, as the Arabic recognizer makes a word of it («جواب»)."""
    a, e = _said_ar(ar.strip()), _said_en(en.strip())
    if not e:
        return "ar"
    if not a:
        return "en"
    said = " ".join(re.sub(r"[^a-z0-9]+", " ", en.lower()).split())
    # (the Arabic recognizer makes a word or two of it: «جواب» for "next", «الاكس بوكس» for "next verse")
    if a < max(12.0, 2.0 * e) and (said in _EN_COMMANDS or _MISHEARD_NEXT.fullmatch(said)
                                   or re.fullmatch(r"(?:verse|chapter) \d+(?: verse \d+)?", said)):
        return "en"
    if _EN_REF.search(en) and len(_NUMBER.findall(ar)) < 2:     # a whole reference in English, not in the Arabic
        return "en"
    return "en" if a < 0.6 * e else "ar"


def pick_partial(ar, en, now="ar"):
    """While the words are still coming: which of the two to show. The language shown so far (at first the last sentence's)
    is kept until the other one is clearly ahead, so the words do not flicker between the two."""
    a, e = _said_ar(ar.strip()), _said_en(en.strip())
    if now == "en":
        return "ar" if (a and not e) or (a >= 15 and a > e) else "en"
    return "en" if (e >= 8 and not a) or (e >= 15 and a < 0.4 * e) else "ar"


# --------------------------------------------------------------------------------------------- ElevenLabs (realtime)
class ElevenLabsLive(Live):
    """ElevenLabs Scribe v3 Live over their WebSocket API: the sound goes out in 0.13 s pieces as it is heard, the words
    come back about a second later (partial_transcript), and at each pause the engine commits the sentence
    (committed_transcript). $0.22 an hour of sound sent, plus $0.08 for the Bible-name hints."""

    name = "elevenlabs"
    label = "ElevenLabs Scribe (live)"
    describe = "ElevenLabs (live)"
    price_per_hour = 0.30
    URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
    MODELS = ["scribe_v3_live", "scribe_v2_realtime"]       # newest first; the second if the first is refused
    CHUNK = 4                                                # frames per message: 128 ms
    ORDINALS = ("الأول", "الثاني", "الثالث", "الأولى", "الثانية", "الثالثة")
    COMMON = {"العدد", "الخروج", "الأمثال", "الجامعة", "القضاة", "الرؤيا"}   # everyday words: a hint adds nothing
    PERMANENT = {
        "auth_error": "ElevenLabs did not accept the API key. Check it in Settings → Listening → Speech recognition.",
        "quota_exceeded": "The ElevenLabs account is out of credit. Add credit on their website, or switch to another option in Settings → Listening.",
        "unaccepted_terms": "ElevenLabs needs its Speech to Text terms accepted first: sign in at elevenlabs.io, open Speech to Text and accept them, then restart the speech engine.",
    }

    def __init__(self, emit, log, ready, trouble, language="auto", sensitivity=0.5, pause=0.5, key="", keyterms=None, **_):
        super().__init__(emit, log, ready, trouble, language)
        if not key:
            raise LiveError("No API key for ElevenLabs yet. Add it in Settings → Listening → Speech recognition.", permanent=True)
        self.key = key
        self.keyterms = self.pick_keyterms(keyterms)
        self.all_keyterms = list(keyterms or [])
        self.model = self.MODELS[0]
        # a sentence is committed at a pause once 4 s have been said; after 12 s a short dip will do; at 20 s anyway
        # (ElevenLabs commits by itself after about 36 s)
        self.cutter = Cutter(min_len=4.0, pause=pause, soft_after=12.0, soft_pause=0.15, max_len=20.0, sensitivity=sensitivity)
        self.frames = []
        self.out = collections.deque()          # ("audio", bytes) and ("commit", None), in order
        self.wake = threading.Event()
        self.batch = None                       # for the phone remote's spoken commands
        self.connected = False
        self.stopped = ""                       # why it gave up (a wrong key, no credit); tried again at the next listen
        self.reconnect = False                  # the language or the hints changed: a new connection
        self.unbilled = 0.0
        self.last_sent = 0.0
        self.committed_tail = ""
        self.sent = []                          # sound sent since the last commit
        self.unconfirmed = collections.deque()  # (time, sound) of each commit whose text hasn't come back yet
        self.fails = 0                          # failed connections since text last came back
        self.ready_msg = (f"Ready — speech recognized by ElevenLabs Scribe Live (cloud, about ${self.price_per_hour:.2f} an hour "
                          "while listening; words appear as they are spoken).")
        self._start()

    def _start(self):
        threading.Thread(target=self._run, daemon=True, name="elevenlabs-live").start()

    @classmethod
    def pick_keyterms(cls, terms):
        """Realtime takes at most 50 hints of at most 20 letters: the names of the books (without 'the first' etc.),
        rare words before common ones, and 'مزمور' (a psalm), then whatever else fits."""
        out = []
        for t in terms or []:
            t = " ".join(str(t).split())
            for o in cls.ORDINALS:
                if t.endswith(" " + o):
                    t = t[: -len(o) - 1]
            if not t or t in cls.COMMON or len(t) > 20 or t in out:
                continue
            out.append(t)
            if t == "المزامير" and "مزمور" not in out:
                out.append("مزمور")
        return out[:50]

    def configure(self, language=None, sensitivity=None, pause=None, keyterms=None):
        changed = bool(language) and language != self.language
        super().configure(language=language)
        if sensitivity is not None or pause is not None:
            self.cutter.configure(sensitivity=sensitivity, pause=pause)
        if keyterms is not None and self.pick_keyterms(keyterms) != self.keyterms:
            self.keyterms = self.pick_keyterms(keyterms)
            self.all_keyterms = list(keyterms)
            changed = True
        if changed:
            self.reconnect = True               # the language and the hints are fixed per connection: a new one

    # ---- the connection
    def _url(self):
        from urllib.parse import urlencode, quote
        q = [("model_id", self.model), ("audio_format", "pcm_16000"), ("commit_strategy", "manual")]
        if self.language in ("ar", "en"):
            q.append(("language_code", self.language))
        else:                                    # Arabic + English: either one, decided as it goes
            q += [("language_code", "ar"), ("secondary_languages", "en")]
        q += [("keyterms", k) for k in self.keyterms]
        return self.URL + "?" + urlencode(q, quote_via=quote)

    def _run(self):
        from websockets.sync.client import connect
        from websockets.exceptions import InvalidStatus
        checked = False
        while not self.closed and not self.stopped:
            if checked and not self.listening:
                self.wake.wait(0.5)
                self.wake.clear()
                continue
            ws = None
            try:
                self.reconnect = False              # the address below has the newest language and hints
                ws = connect(self._url(), additional_headers={"xi-api-key": self.key}, open_timeout=15, close_timeout=3,
                             compression=None, max_size=2 ** 22)
                msg = json.loads(ws.recv(timeout=15))
                if msg.get("message_type") != "session_started":
                    self._server_error(msg)
                    raise ConnectionError(msg.get("error") or msg.get("message_type"))
                self.connected = True
                if not checked:
                    checked = True
                    self.on_ready(self.ready_msg)
                    self.log(f"ElevenLabs: connected ({self.model}, {len(self.keyterms)} Bible-name hints).")
                if self.listening:
                    self._stream(ws)
            except InvalidStatus as e:
                code = e.response.status_code
                body = (e.response.body or b"").decode("utf-8", "replace")[:200]
                if code in (401, 403):
                    self._stop(self.PERMANENT["auth_error"])
                elif code == 402:
                    self._stop(self.PERMANENT["quota_exceeded"])
                else:
                    self._failed(f"ElevenLabs answered {code} {body}")
            except _Permanent as e:
                self._stop(str(e))
            except Exception as e:
                if not self.closed:
                    self._failed(f"{type(e).__name__}: {e}")
            finally:
                self.connected = False
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:
                        pass
                self._requeue()
                self._bill(force=True)

    def _requeue(self):
        """The connection dropped: the sound whose text hadn't come back goes again, first, on the next connection
        (otherwise the sentence being said when it dropped would be lost)."""
        items = []
        for _, sound in self.unconfirmed:
            if sound:
                items += [("audio", sound), ("commit", None)]
        if self.sent:
            items.append(("audio", b"".join(self.sent)))
        self.unconfirmed.clear()
        self.sent = []
        if items and self.listening and not self.closed and not self.stopped:
            self.out.extendleft(reversed(items))
            secs = sum(len(d) for k, d in items if k == "audio") / (2 * RATE)
            self.log(f"ElevenLabs: the connection dropped; the last {secs:.1f} s of sound go again on the new one.")

    def _failed(self, why):
        self.fails += 1
        self.log(f"ElevenLabs: {why} (attempt {self.fails}); connecting again.")
        if self.fails == 3:
            self.on_trouble(f"ElevenLabs is not answering ({why}).", False)
        time.sleep(min(10.0, 0.5 * 2 ** min(self.fails, 5)))

    def _stop(self, message):
        self.stopped = message
        self.on_trouble(message, True)

    def _sent_seconds(self):
        return sum(len(d) for d in self.sent) / (2 * RATE)

    def _stream(self, ws):
        """Sends the sound as it comes and passes on the text, until listening stops or the settings change (then the
        last sentence is committed and its text awaited)."""
        first = True
        while not self.closed:
            stopping = not self.listening or self.reconnect
            while self.out:
                kind, data = self.out.popleft()
                if kind == "audio":
                    # sound that piled up (connecting, or sent again after a drop) goes out in pieces of up to 1 s
                    while self.out and self.out[0][0] == "audio" and len(data) < 2 * RATE:
                        data += self.out.popleft()[1]
                    if len(data) > 2 * RATE:
                        self.out.appendleft(("audio", data[2 * RATE:]))
                        data = data[:2 * RATE]
                    m = {"message_type": "input_audio_chunk", "audio_base_64": base64.b64encode(data).decode("ascii"),
                         "commit": False, "sample_rate": RATE}
                    if first and self.committed_tail:
                        m["previous_text"] = self.committed_tail   # carrying on after a new connection
                    first = False
                    ws.send(json.dumps(m))
                    self.sent.append(data)
                    self.last_sent = time.time()
                    self.unbilled += len(data) / (2 * RATE)
                    if self.out and len(data) >= 2 * RATE:
                        self._receive(ws, 0.25)                    # catching up: let the answers in between
                elif self._sent_seconds() >= 0.3:                  # (a commit with almost no sound is refused)
                    self._send_commit(ws)
            if stopping:                                           # the last sentence: commit it and wait for its text
                if self._sent_seconds() >= 0.3:
                    self._send_commit(ws)
                end = time.time() + 4
                while self.unconfirmed and time.time() < end:
                    self._receive(ws, 0.1)
                self.unconfirmed.clear()
                self.sent = []
                return
            if self.listening and time.time() - self.last_sent > 3:      # no sound coming in: ElevenLabs closes after 15 s
                self.out.append(("audio", bytes(int(RATE * 0.1) * 2)))
                continue
            self._bill()
            self._receive(ws, 0.05)

    def _send_commit(self, ws):
        ws.send(json.dumps({"message_type": "input_audio_chunk", "audio_base_64": "", "commit": True, "sample_rate": RATE}))
        self.unconfirmed.append((time.time(), b"".join(self.sent)))
        self.sent = []

    def _receive(self, ws, timeout):
        try:
            raw = ws.recv(timeout=timeout)
        except TimeoutError:
            return
        msg = json.loads(raw)
        kind = msg.get("message_type")
        if kind == "partial_transcript":
            self.fails = 0                                         # text is coming back: the connection works
            self.partial(msg.get("text", ""))
        elif kind == "committed_transcript":
            self.fails = 0
            sent = self.unconfirmed.popleft()[0] if self.unconfirmed else None
            text = msg.get("text", "")
            self.final(text, ms=int((time.time() - sent) * 1000) if sent else None)
            if text.strip():
                self.committed_tail = text.strip()[-48:]
        elif kind in ("session_started", "committed_transcript_with_timestamps"):
            pass
        elif kind == "warning":
            self.log("ElevenLabs warning:", msg.get("warning", ""))
        else:
            self._server_error(msg)

    def _server_error(self, msg):
        kind, detail = msg.get("message_type", ""), str(msg.get("error", ""))[:200]
        if kind in self.PERMANENT:
            raise _Permanent(self.PERMANENT[kind])
        low = detail.lower()
        if kind == "invalid_request" and "model" in low and self.model != self.MODELS[-1]:
            self.log(f"ElevenLabs: {self.model} refused ({detail}); using {self.MODELS[-1]}.")
            self.model = self.MODELS[-1]
        elif kind in ("invalid_request", "input_error") and "keyterm" in low and self.keyterms:
            self.log(f"ElevenLabs would not take the Bible-name hints ({detail}); carrying on without them.")
            self.keyterms = []
        elif kind == "invalid_request":
            raise _Permanent(f"ElevenLabs refused the settings: {detail}")
        elif kind == "commit_throttled":
            self.log(f"ElevenLabs: a commit came too soon ({detail}).")
            return
        elif kind == "session_time_limit_exceeded":
            self.log("ElevenLabs: the session reached its time limit; starting a new one.")
            self.fails = -1                       # (straight away)
        raise ConnectionError(f"{kind}: {detail}")

    def _bill(self, force=False):
        if self.unbilled >= 30 or (force and self.unbilled > 0):
            self.emit({"ev": "billed", "seconds": round(self.unbilled, 2), "provider": self.name})
            self.unbilled = 0.0

    # ---- from the engine
    def set_listening(self, on):
        on = bool(on)
        if on == self.listening:
            return
        self.listening = on
        self.cutter.reset()
        if self.frames and not on:                # the last few hundredths of a second
            self.out.append(("audio", pcm16(np.concatenate(self.frames))))
        self.frames = []
        if on:
            self.out.clear()
            self.seg_from = time.time()
            if self.stopped and not self.closed:  # it gave up earlier (a wrong key, no credit): try again
                self.stopped = ""
                self._start()
        self.wake.set()

    def feed(self, frame, prob, now):
        if not self.listening:
            return
        self.frames.append(frame)
        cut = self.cutter.feed(prob)
        if len(self.frames) >= self.CHUNK or cut:
            self.out.append(("audio", pcm16(np.concatenate(self.frames))))
            self.frames = []
        if cut:
            self.out.append(("commit", None))
        while len(self.out) > 300:              # about 40 s piled up while the connection is down: keep the newest
            self.out.popleft()

    def transcribe(self, audio, mode="auto", final=True):
        """A spoken command from the phone remote: one short recording, sent whole (Scribe v3, not live)."""
        if self.batch is None:
            from cloud import CloudTranscriber
            self.batch = CloudTranscriber("elevenlabs", self.key, self.all_keyterms, log=self.log)
        return self.batch.transcribe(audio, mode, final)

    def close(self):
        super().close()
        self.listening = False
        self.wake.set()


class SonioxLive(Live):
    """Soniox real-time speech-to-text (stt-rt-v6) over their WebSocket API. The sound goes out as it is heard. The words
    come back as tokens: first as a guess that may still change, then confirmed, and a confirmed word never changes.
    A sentence is closed where Soniox hears the speaker finish (its endpoint detection: an "<end>" token), or at the
    pause the engine's own voice detector finds (then Soniox is asked to confirm what it has: "<fin>"), whichever
    comes first. About $0.12 an hour; the whole time a stream is open is charged, so it is open only while listening."""

    name = "soniox"
    label = "Soniox (live)"
    describe = "Soniox (live)"
    price_per_hour = 0.12
    URL = "wss://stt-rt.soniox.com/transcribe-websocket"
    MODEL = "stt-rt-v6"
    CHUNK = 3                                                # frames per message: 96 ms
    MAX_STREAM = 280 * 60                                    # Soniox ends a stream at 300 minutes: a new one before that
    COMMON = {"العدد", "الخروج", "الأمثال", "الجامعة", "القضاة", "الرؤيا"}   # everyday words: a hint adds nothing
    KEY_REFUSED = "Soniox did not accept the API key. Check it in Settings → Listening → Speech recognition."
    NO_CREDIT = ("The Soniox account is out of credit (or its monthly budget is used up). Add funds at console.soniox.com, "
                 "or switch to another option in Settings → Listening.")
    PERMANENT = {"unauthenticated": KEY_REFUSED, "permission_denied": KEY_REFUSED, "temp_api_key_session_expired": KEY_REFUSED,
                 "organization_balance_exhausted": NO_CREDIT, "organization_monthly_budget_exhausted": NO_CREDIT,
                 "project_monthly_budget_exhausted": NO_CREDIT}

    def __init__(self, emit, log, ready, trouble, language="auto", sensitivity=0.5, pause=0.5, key="", keyterms=None, **_):
        super().__init__(emit, log, ready, trouble, language)
        if not key:
            raise LiveError("No API key for Soniox yet. Add it in Settings → Listening → Speech recognition.", permanent=True)
        self.key = key
        self.url = os.environ.get("VF_SONIOX_URL") or self.URL       # (a stand-in server on this PC, for the drills)
        self.endpoints = os.environ.get("VF_SONIOX_ENDPOINTS", "1") != "0"
        self.terms = self.pick_terms(keyterms)
        self.use_terms, self.strict = True, True
        # the engine's own cut: at a pause once 4 s have been said; after 12 s a short dip will do; at 20 s anyway
        self.cutter = Cutter(min_len=4.0, pause=pause, soft_after=12.0, soft_pause=0.15, max_len=20.0, sensitivity=sensitivity)
        self.frames = []
        self.out = collections.deque()          # ("audio", bytes) and ("cut", None), in order
        self.wake = threading.Event()
        self.connected = False
        self.stopped = ""                       # why it gave up (a wrong key, no credit); tried again at the next listen
        self.reconnect = False                  # the language or the hints changed: a new stream
        self.unbilled = 0.0
        self.last_sent = 0.0
        self.fails = 0
        # the sentence being said: its confirmed words so far, and when its first and last confirmed words were said
        self.words, self.first_ms, self.last_ms = [], None, 0
        # this stream: the clock time of its first sound, how much sound has gone out, and the sound not confirmed yet
        self.t0, self.sent_ms, self.kept = 0.0, 0.0, collections.deque()
        self.asked_at, self.last_ask = 0.0, 0.0  # an answer to "confirm what you have" is awaited since; when it was last asked
        self.guess = ""                          # the words of the sentence that may still change
        self.finished = False
        self.ready_msg = (f"Ready — speech recognized by Soniox (cloud, about ${self.price_per_hour:.2f} an hour while "
                          "listening; words appear as they are spoken).")
        self._start()

    def _start(self):
        threading.Thread(target=self._run, daemon=True, name="soniox-live").start()

    @classmethod
    def pick_terms(cls, terms):
        """The names Soniox should expect and spell our way: the books of the Bible (and «مزمور»), then the titles of
        the hymns in the playlists. Short terms only; a long list is fine."""
        out = []
        for t in terms or []:
            t = " ".join(str(t).split())
            if not t or t in cls.COMMON or len(t) > 40 or t in out:
                continue
            out.append(t)
            if t == "المزامير" and "مزمور" not in out:
                out.append("مزمور")
        return out[:300]

    def configure(self, language=None, sensitivity=None, pause=None, keyterms=None):
        changed = bool(language) and language != self.language
        super().configure(language=language)
        if sensitivity is not None or pause is not None:
            self.cutter.configure(sensitivity=sensitivity, pause=pause)
        if keyterms is not None and self.pick_terms(keyterms) != self.terms:
            self.terms = self.pick_terms(keyterms)
            changed = True
        if changed:
            self.reconnect = True               # the language and the hints are fixed per stream: a new one

    # ---- the stream
    def _config(self, endpoints=None):
        one = self.language in ("ar", "en")
        c = {"model": self.MODEL, "audio_format": "pcm_s16le", "sample_rate": RATE, "num_channels": 1,
             "language_hints": [self.language] if one else ["ar", "en"], "enable_language_identification": True,
             "enable_endpoint_detection": self.endpoints if endpoints is None else endpoints, "client_reference_id": "arabic-church-assistant"}
        if self.strict:
            c["language_hints_strict"] = True    # Arabic and English only: no stray words in another alphabet
        if self.use_terms and self.terms:
            c["context"] = {"general": [{"key": "domain", "value": "Arabic church service"},
                                        {"key": "topic", "value": "sermon, Bible readings with book, chapter and verse, hymns"}],
                            "terms": self.terms}
        return c

    def _connect(self, config):
        from websockets.sync.client import connect
        ws = connect(self.url, additional_headers={"Authorization": "Bearer " + self.key}, open_timeout=15, close_timeout=3,
                     compression=None, max_size=2 ** 22)
        ws.send(json.dumps(config))
        return ws

    def _run(self):
        checked = False
        while not self.closed and not self.stopped:
            if checked and not self.listening:
                self.wake.wait(0.5)
                self.wake.clear()
                continue
            ws = None
            try:
                self.reconnect = False              # the settings sent below are the newest
                ws = self._connect(self._config())
                self.connected, self.finished = True, False
                self.t0, self.sent_ms, self.asked_at = 0.0, 0.0, 0.0
                self.kept.clear()
                # a wrong key, an empty balance or refused settings are answered within about a second
                self._receive(ws, 1.2 if not checked else 0.05)
                if not checked:
                    checked = True
                    self.on_ready(self.ready_msg)
                    hints = f"{len(self.terms)} names as hints" if (self.use_terms and self.terms) else "no name hints"
                    self.log(f"Soniox: connected ({self.MODEL}, {hints}).")
                if self.listening:
                    self._stream(ws)
                elif not self.closed:
                    ws.send("")                     # nothing to hear yet: the stream is ended (an open stream is charged)
            except _Permanent as e:
                self._stop(str(e))
            except Exception as e:
                if not self.closed:
                    self._failed(f"{type(e).__name__}: {e}")
            finally:
                self.connected = False
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:
                        pass
                self._requeue()
                self._bill(force=True)

    def _requeue(self):
        """The stream ended early: the sound whose words were not confirmed yet goes again, first, on the next stream
        (the words already confirmed for the sentence being said are kept, so it carries on where it was)."""
        sound = b"".join(d for _, d in self.kept)
        self.kept.clear()
        if sound and self.listening and not self.closed and not self.stopped:
            sound = sound[-60 * 2 * RATE:]
            self.out.appendleft(("audio", sound))
            self.log(f"Soniox: the stream ended early; the last {len(sound) / (2 * RATE):.1f} s of sound go again on the new one.")

    def _failed(self, why):
        self.fails += 1
        self.log(f"Soniox: {why} (attempt {self.fails}); connecting again.")
        if self.fails == 3:
            self.on_trouble(f"Soniox is not answering ({why}).", False)
        time.sleep(min(10.0, 0.5 * 2 ** min(self.fails, 5)))

    def _stop(self, message):
        self.stopped = message
        self.on_trouble(message, True)

    def _stream(self, ws):
        """Sends the sound as it comes and passes on the words, until listening stops or the settings change (then
        what was said last is confirmed first)."""
        while not self.closed and not self.finished:
            stopping = not self.listening or self.reconnect
            while self.out:
                kind, data = self.out.popleft()
                if kind == "audio":
                    # sound that piled up (connecting, or sent again after a drop) goes out in pieces of up to 1 s
                    while self.out and self.out[0][0] == "audio" and len(data) < 2 * RATE:
                        data += self.out.popleft()[1]
                    if len(data) > 2 * RATE:
                        self.out.appendleft(("audio", data[2 * RATE:]))
                        data = data[:2 * RATE]
                    if not self.t0:
                        self.t0 = time.time()
                    ws.send(data)
                    self.kept.append((self.sent_ms, data))
                    self.sent_ms += len(data) / (2 * RATE) * 1000.0
                    self.last_sent = time.time()
                    self.unbilled += len(data) / (2 * RATE)
                    if self.out and len(data) >= 2 * RATE:
                        self._receive(ws, 0.25)                    # catching up: let the answers in between
                else:
                    self._ask(ws)                                  # a pause: what was said so far is to be confirmed
            too_long = bool(self.t0) and time.time() - self.t0 > self.MAX_STREAM
            if stopping or too_long:
                self._ask(ws, force=True)
                end = time.time() + 3
                while self.asked_at and time.time() < end and not self.finished:
                    self._receive(ws, 0.1)
                self._close_sentence(None)                         # (whatever was confirmed, if the answer did not come)
                ws.send("")
                end = time.time() + 2
                while not self.finished and time.time() < end:
                    self._receive(ws, 0.1)
                self.kept.clear()
                return
            if self.listening and time.time() - self.last_sent > 8:      # no sound is coming in: the stream is kept open
                ws.send(json.dumps({"type": "keepalive"}))
                self.last_sent = time.time()
            self._bill()
            self._receive(ws, 0.05)

    def _ask(self, ws, force=False):
        """Asks Soniox to confirm everything heard so far (the answer ends with "<fin>"). Not more often than every
        2 s, and not when it has just closed the sentence itself."""
        now = time.time()
        if self.asked_at and now - self.asked_at < 5.0:
            return                                                 # the answer to the last request is still awaited
        if not self.sent_ms or (not force and (now - self.last_ask < 2.0 or not (self.words or self.guess.strip()))):
            return
        ws.send(json.dumps({"type": "finalize"}))
        self.asked_at = self.last_ask = now

    def _receive(self, ws, timeout):
        try:
            raw = ws.recv(timeout=timeout)
        except TimeoutError:
            return
        msg = json.loads(raw)
        if msg.get("error_code") or msg.get("error_type"):
            self._server_error(msg)
        guess = []
        for tok in msg.get("tokens") or []:
            text = tok.get("text", "")
            if text in ("<end>", "<fin>"):
                self._close_sentence(text)
            elif tok.get("is_final"):
                if not self.words:
                    self.first_ms = tok.get("start_ms")
                self.words.append(text)
                self.last_ms = tok.get("end_ms") or self.last_ms
            else:
                guess.append(text)
        if msg.get("tokens"):
            self.fails = 0                                         # words are coming back: the stream works
        # sound whose words are confirmed need not be kept for sending again
        done = msg.get("final_audio_proc_ms")
        if done is not None:
            while self.kept and self.kept[0][0] + len(self.kept[0][1]) / (2 * RATE) * 1000.0 <= done:
                self.kept.popleft()
        self.guess = "".join(guess)
        text = "".join(self.words) + self.guess
        if text.strip():
            self.partial(text)
        if msg.get("finished"):
            self.finished = True

    def _close_sentence(self, mark):
        if mark == "<fin>" or mark is None:
            self.asked_at = 0.0
        text = "".join(self.words)
        first, last = self.first_ms, self.last_ms
        self.words, self.first_ms = [], None
        if not text.strip():
            return
        start = self.t0 + first / 1000.0 if (self.t0 and first is not None) else None
        said = self.t0 + last / 1000.0 if (self.t0 and last) else None
        self.final(text, ms=int(max(0.0, time.time() - said) * 1000) if said else None, start=start)
        self.cutter.reset()                                        # (the engine's own count starts again from here)

    def _server_error(self, msg):
        kind, detail = str(msg.get("error_type") or msg.get("error_code") or ""), str(msg.get("error_message", ""))[:200]
        code = msg.get("error_code")
        if kind in self.PERMANENT or code in (401, 402, 403):
            raise _Permanent(self.PERMANENT.get(kind) or (self.NO_CREDIT if code == 402 else self.KEY_REFUSED))
        if kind in ("invalid_request", "model_not_available") or code == 400:
            if self.use_terms and self.terms:
                self.log(f"Soniox would not take the settings ({detail}); trying without the names as hints.")
                self.use_terms = False
            elif self.strict:
                self.log(f"Soniox would not take the settings ({detail}); trying without the language restriction.")
                self.strict = False
            else:
                raise _Permanent(f"Soniox refused the settings: {detail}")
        elif kind == "max_duration_reached":
            self.log("Soniox: the stream reached its time limit; starting a new one.")
            self.fails = -1                       # (straight away)
        elif kind in ("limit_exceeded", "max_concurrent_connections_reached") or code == 429:
            self.fails = max(self.fails, 4)       # the places held by dropped streams are freed within 20 s: wait
        raise ConnectionError(f"{kind}: {detail}")

    def _bill(self, force=False):
        if self.unbilled >= 30 or (force and self.unbilled > 0):
            self.emit({"ev": "billed", "seconds": round(self.unbilled, 2), "provider": self.name})
            self.unbilled = 0.0

    # ---- from the engine
    def set_listening(self, on):
        on = bool(on)
        if on == self.listening:
            return
        self.listening = on
        self.cutter.reset()
        if self.frames and not on:                # the last few hundredths of a second
            self.out.append(("audio", pcm16(np.concatenate(self.frames))))
        self.frames = []
        if on:
            self.out.clear()
            self.seg_from = time.time()
            if self.stopped and not self.closed:  # it gave up earlier (a wrong key, no credit): try again
                self.stopped = ""
                self._start()
        self.wake.set()

    def feed(self, frame, prob, now):
        if not self.listening:
            return
        self.frames.append(frame)
        cut = self.cutter.feed(prob)
        if len(self.frames) >= self.CHUNK or cut:
            self.out.append(("audio", pcm16(np.concatenate(self.frames))))
            self.frames = []
        if cut:
            self.out.append(("cut", None))
        while len(self.out) > 400:              # about 40 s piled up while the connection is down: keep the newest
            self.out.popleft()

    def transcribe(self, audio, mode="auto", final=True):
        """A spoken command from the phone remote: one short recording on a stream of its own.
        Returns (text, lang, score, seconds) like asr.Transcriber."""
        t0 = time.time()
        cfg = self._config(endpoints=False)
        if mode in ("ar", "en"):
            cfg["language_hints"] = [mode]
        ws = self._connect(cfg)
        words = []
        try:
            data = pcm16(audio)
            step = int(0.2 * RATE) * 2
            for i in range(0, len(data), step):                    # a little faster than it was spoken
                ws.send(data[i:i + step])
                time.sleep(0.04)
            ws.send("")
            end = time.time() + 15
            while time.time() < end:
                msg = json.loads(ws.recv(timeout=max(0.1, end - time.time())))
                if msg.get("error_code") or msg.get("error_type"):
                    raise LiveError(f"Soniox: {msg.get('error_type')}: {str(msg.get('error_message', ''))[:160]}",
                                    permanent=msg.get("error_code") in (401, 402, 403))
                words += [t.get("text", "") for t in msg.get("tokens") or [] if t.get("is_final") and t.get("text") not in ("<end>", "<fin>")]
                if msg.get("finished"):
                    break
        finally:
            try:
                ws.close()
            except Exception:
                pass
        self.emit({"ev": "billed", "seconds": round(len(audio) / RATE, 2), "provider": self.name})
        text = clean_text("".join(words))
        return text, ("en" if latin_share(text) > 0.5 else "ar"), 0.0, time.time() - t0

    def close(self):
        super().close()
        self.listening = False
        self.wake.set()


class _Permanent(Exception):
    pass


LIVE = {"google": GoogleSpeech, "elevenlabs": ElevenLabsLive, "soniox": SonioxLive}
