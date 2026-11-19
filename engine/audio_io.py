"""Audio inputs for the speech engine: a microphone, this PC's own sound (loopback), or a file.

Every input delivers 16 kHz mono float32 frames of 512 samples (32 ms) into a queue. Inputs run on
their own threads and never block the engine; the engine watches them and reopens one that stops."""
import os
import queue
import threading
import time
import warnings

import numpy as np

RATE = 16000
FRAME = 512                      # 32 ms: the frame size the voice detector (Silero VAD) works with

warnings.filterwarnings("ignore", message=".*data discontinuity.*")

try:                             # soundcard uses COM; importing it on the main thread sets that up for the process
    import soundcard as _sc
except Exception as _e:          # pragma: no cover - reported when listing devices
    _sc = None
    _SC_ERROR = str(_e)
else:
    _SC_ERROR = ""


class Framer:
    """Cuts audio blocks of any length into FRAME-sized pieces."""

    def __init__(self):
        self.buf = np.zeros(0, np.float32)

    def push(self, x):
        self.buf = np.concatenate([self.buf, np.asarray(x, np.float32).reshape(-1)])
        n = len(self.buf) // FRAME
        if not n:
            return []
        out = self.buf[: n * FRAME].reshape(n, FRAME)
        self.buf = self.buf[n * FRAME:]
        return list(out)


# --------------------------------------------------------------------------------------------- devices
def list_devices():
    """Microphones and speakers (speakers can be listened to: "this PC's sound")."""
    mics, speakers, err = [], [], ""
    if _sc is not None:
        try:
            dm = _sc.default_microphone()
            dname = dm.name if dm else ""
            for m in _sc.all_microphones(include_loopback=False):
                mics.append({"name": m.name, "default": m.name == dname})
        except Exception as e:
            err = str(e)
        try:
            ds = _sc.default_speaker()
            dname = ds.name if ds else ""
            for s in _sc.all_speakers():
                speakers.append({"name": s.name, "default": s.name == dname})
        except Exception as e:
            err = err or str(e)
    if not mics:                                  # fall back to PortAudio's list
        try:
            import sounddevice as sd
            seen = set()
            for d in sd.query_devices():
                if d.get("max_input_channels", 0) > 0 and d["name"] not in seen and "mapper" not in d["name"].lower():
                    seen.add(d["name"])
                    mics.append({"name": d["name"], "default": False})
        except Exception as e:
            err = err or str(e)
    return {"mics": mics, "speakers": speakers, "error": err or _SC_ERROR}


def _find(devs, name):
    if not name:
        return None
    for d in devs:
        if d.name == name:
            return d
    low = name.lower()
    for d in devs:                                  # names can change a little ("2- Microphone (...)")
        if low in d.name.lower() or d.name.lower() in low:
            return d
    return None


# --------------------------------------------------------------------------------------------- inputs
class Input:
    kind = "mic"

    def __init__(self, out_q, emit):
        self.q = out_q
        self.emit = emit
        self.stop_flag = threading.Event()
        self.thread = None
        self.last_data = time.time()
        self.error = ""
        self.label = ""
        self.started = time.time()

    def start(self):
        self.started = self.last_data = time.time()
        self.thread = threading.Thread(target=self._safe_run, daemon=True, name=f"input-{self.kind}")
        self.thread.start()
        return self

    def stop(self):
        self.stop_flag.set()

    def _safe_run(self):
        try:
            self.run()
        except Exception as e:
            self.error = str(e) or e.__class__.__name__

    def running(self):
        return bool(self.thread and self.thread.is_alive()) and not self.error

    def put(self, frames):
        if frames:
            self.last_data = time.time()
            for f in frames:
                self.q.put(f)


class LiveInput(Input):
    """A microphone (or, with loopback=True, a speaker = everything this PC plays)."""

    def __init__(self, name, loopback, out_q, emit):
        super().__init__(out_q, emit)
        self.name = name or ""
        self.loopback = loopback
        self.kind = "loopback" if loopback else "mic"

    def run(self):
        if self.loopback:
            return self._run_soundcard()
        try:
            return self._run_portaudio()
        except Exception as e:                       # some microphones only open one way: try the other
            if _sc is None or self.stop_flag.is_set():
                raise
            self.emit({"ev": "log", "message": f"PortAudio could not open the microphone ({e}); trying WASAPI directly."})
            return self._run_soundcard()

    def _run_soundcard(self):
        if self.loopback:
            dev = _find(_sc.all_speakers(), self.name) or _sc.default_speaker()
            mic = _sc.get_microphone(id=str(dev.name), include_loopback=True)
            self.label = dev.name
        else:
            mic = _find(_sc.all_microphones(include_loopback=False), self.name) or _sc.default_microphone()
            self.label = mic.name
        framer = Framer()
        with mic.recorder(samplerate=RATE, channels=1, blocksize=FRAME * 2) as rec:
            while not self.stop_flag.is_set():
                data = rec.record(numframes=FRAME)
                if data is None or not len(data):
                    time.sleep(0.005)
                    continue
                x = data[:, 0] if data.ndim > 1 else data
                self.put(framer.push(x))

    def _pick_portaudio(self, sd):
        """(device index, extra settings, name) for the chosen microphone. WASAPI first (full names; Windows
        converts the sample rate), then MME (names cut at 31 letters), then the Windows default."""
        apis = sd.query_hostapis()
        devs = sd.query_devices()
        name = self.name.strip()
        order = ("Windows WASAPI", "MME", "Windows DirectSound")
        if name:
            for api in order:
                for i, d in enumerate(devs):
                    if d.get("max_input_channels", 0) <= 0 or apis[d["hostapi"]]["name"] != api:
                        continue
                    if d["name"] == name or (len(d["name"]) >= 28 and name.startswith(d["name"])):
                        return i, api, d["name"]
            self.emit({"ev": "warn", "message": f"The microphone “{name}” isn't connected. Using the Windows default microphone until it is back."})
            self.fallback = True
        try:
            i = sd.default.device[0]
            return (i if i is not None and i >= 0 else None), "", "Windows default microphone"
        except Exception:
            return None, "", "Windows default microphone"

    def _run_portaudio(self):
        import sounddevice as sd
        framer = Framer()
        dev, api, label = self._pick_portaudio(sd)
        self.label = label

        def cb(indata, frames, t, status):
            self.put(framer.push(indata[:, 0].copy()))

        attempts = []
        if api == "Windows WASAPI":
            try:
                attempts.append(dict(extra_settings=sd.WasapiSettings(auto_convert=True)))
            except TypeError:
                pass
        attempts.append({})
        last = None
        for extra in attempts:
            try:
                stream = sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=FRAME, device=dev, callback=cb, **extra)
                break
            except Exception as e:
                last, stream = e, None
        if stream is None:
            if dev is not None and api == "Windows WASAPI":     # last try: the same microphone through MME
                for i, d in enumerate(sd.query_devices()):
                    if d.get("max_input_channels", 0) > 0 and sd.query_hostapis(d["hostapi"])["name"] == "MME" and label.startswith(d["name"]):
                        stream = sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=FRAME, device=i, callback=cb)
                        break
            if stream is None:
                raise last or RuntimeError("could not open the microphone")
        with stream:
            while not self.stop_flag.is_set():
                time.sleep(0.1)


class FileInput(Input):
    """Plays an audio or video file (so the operator hears it) and feeds its sound to the engine."""
    kind = "file"

    def __init__(self, path, out_q, emit, play=True, realtime=True, start_at=0.0):
        super().__init__(out_q, emit)
        self.path = path
        self.play = play
        self.realtime = realtime or play
        self.label = os.path.basename(path)
        self.paused = threading.Event()
        self.seek_to = start_at if start_at else None
        self.lock = threading.Lock()
        self.position = 0.0
        self.duration = 0.0
        self.finished = False

    def control(self, action, t=None):
        if action == "pause":
            self.paused.set()
        elif action == "resume":
            self.paused.clear()
        elif action == "seek" and t is not None:
            with self.lock:
                self.seek_to = max(0.0, float(t))
        elif action == "stop":
            self.stop_flag.set()
        self._report(force=True)

    def _report(self, force=False, state=None):
        now = time.time()
        if not force and now - getattr(self, "_last_report", 0) < 0.25:
            return
        self._last_report = now
        st = state or ("paused" if self.paused.is_set() else "playing")
        self.emit({"ev": "file", "state": st, "t": round(self.position, 2), "dur": round(self.duration, 2), "name": self.label})

    def run(self):
        import av
        container = av.open(self.path)
        try:
            streams = container.streams.audio
            if not streams:
                raise RuntimeError("That file has no sound in it.")
            stream = streams[0]
            if container.duration:
                self.duration = container.duration / 1_000_000
            elif stream.duration and stream.time_base:
                self.duration = float(stream.duration * stream.time_base)
            out = None
            if self.play:
                try:
                    import sounddevice as sd
                    out = sd.OutputStream(samplerate=48000, channels=2, dtype="float32", latency="low")
                    out.start()
                except Exception as e:
                    out = None
                    self.emit({"ev": "warn", "message": f"Couldn't play the file's sound on the speakers ({e}). It is still being listened to."})
            framer = Framer()
            new_rs = lambda: (av.AudioResampler(format="flt", layout="mono", rate=RATE),
                              av.AudioResampler(format="flt", layout="stereo", rate=48000) if out else None)
            asr_rs, play_rs = new_rs()
            t0_wall, t0_media = time.time(), None
            while not self.stop_flag.is_set():
                with self.lock:
                    seek, self.seek_to = self.seek_to, None
                if seek is not None:
                    container.seek(int(seek * 1_000_000), any_frame=False, backward=True)
                    asr_rs, play_rs = new_rs()
                    framer = Framer()
                    t0_media = None
                    self.position = seek
                    self.emit({"ev": "file-seek", "t": seek})
                decoded_any = False
                for frame in container.decode(stream):
                    decoded_any = True
                    if self.stop_flag.is_set() or self.seek_to is not None:
                        break
                    while self.paused.is_set() and not self.stop_flag.is_set() and self.seek_to is None:
                        self._report()
                        time.sleep(0.05)
                        t0_media = None
                    if frame.time is not None:
                        self.position = float(frame.time)
                    for x in asr_rs.resample(frame):
                        self.put(framer.push(x.to_ndarray().reshape(-1)))
                    if out is not None:
                        for y in play_rs.resample(frame):
                            out.write(np.ascontiguousarray(y.to_ndarray().reshape(-1, 2)))   # blocks: keeps real time
                    elif self.realtime:
                        if t0_media is None:
                            t0_wall, t0_media = time.time(), self.position
                        ahead = (self.position - t0_media) - (time.time() - t0_wall)
                        if ahead > 0.02:
                            time.sleep(min(ahead, 0.5))
                    self._report()
                if self.seek_to is not None and not self.stop_flag.is_set():
                    continue
                if not decoded_any or not self.stop_flag.is_set():
                    break
            for x in asr_rs.resample(None):
                self.put(framer.push(x.to_ndarray().reshape(-1)))
            if framer.buf.size:
                self.put([np.pad(framer.buf, (0, FRAME - framer.buf.size))])
            # a little silence so the last sentence is finished off
            self.put([np.zeros(FRAME, np.float32)] * 40)
            if out is not None:
                try:
                    out.stop()
                    out.close()
                except Exception:
                    pass
        finally:
            container.close()
        self.finished = True
        self._report(force=True, state="stopped" if self.stop_flag.is_set() else "ended")


class Recorder:
    """Keeps what is listened to as a small sound file (16 kHz mono Opus in an .ogg, about 15 MB an hour), so that a
    missed or wrong verse can be checked afterwards against what was really said. One file for each stretch of
    listening, named by when it began. The writing happens on a thread of its own and never holds up listening: if the
    disk is slow, pieces of the recording are dropped, not of the speech."""

    def __init__(self, folder, log=print):
        import av  # noqa: F401  (fails here, not on the thread, if it is missing)
        os.makedirs(folder, exist_ok=True)
        self.began = time.time()
        self.path = os.path.join(folder, time.strftime("%Y-%m-%d_%H%M%S", time.localtime(self.began)) + ".ogg")
        self.name = os.path.basename(self.path)
        self.log = log
        self.q = queue.Queue(maxsize=1000)            # 32 seconds
        self.dropped = 0
        self.samples = 0                              # written so far: where in the file the newest sound is
        self.thread = threading.Thread(target=self._run, daemon=True, name="recorder")
        self.thread.start()

    @property
    def pos(self):
        """Seconds of sound in the file so far."""
        return self.samples / RATE

    def write(self, frame):
        try:
            self.q.put_nowait(frame)
            self.samples += len(frame)
        except queue.Full:
            self.dropped += 1

    def close(self):
        """Finishes the file (waits up to 3 s for what is still to be written)."""
        try:
            self.q.put(None, timeout=1)
        except queue.Full:
            pass
        self.thread.join(timeout=3)

    def _run(self):
        import av
        try:
            # (written to the disk as it goes, half a second at a time: whatever happens to the app or the PC, the
            #  recording is there up to that moment)
            out = av.open(self.path, "w", format="ogg", container_options={"flush_packets": "1", "page_duration": "500000"})
            st = out.add_stream("libopus", rate=RATE)
            st.bit_rate = 24000
            st.layout = "mono"
            fifo = av.AudioFifo()
            pts = 0
            while True:
                f = self.q.get()
                if f is None:
                    break
                pcm = (np.clip(f, -1.0, 1.0) * 32767).astype(np.int16).reshape(1, -1)
                fr = av.AudioFrame.from_ndarray(pcm, format="s16", layout="mono")
                fr.sample_rate = RATE
                fifo.write(fr)
                size = st.codec_context.frame_size or 320
                while fifo.samples >= size:
                    x = fifo.read(size)
                    x.pts = pts
                    pts += size
                    for pkt in st.encode(x):
                        out.mux(pkt)
            for pkt in st.encode(None):
                out.mux(pkt)
            out.close()
            if self.dropped:
                self.log(f"The recording has {self.dropped * FRAME / RATE:.0f} s missing (the disk was slow).")
        except Exception as e:
            self.log("The recording stopped:", e)
