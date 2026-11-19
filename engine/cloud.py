"""Cloud speech-to-text, one whole recording per request: Deepgram while listening, and ElevenLabs for the phone remote's
spoken commands (ElevenLabs listening is live, sent as it is heard: see live.py).

The app still listens and cuts the speech into sentences on this PC (voice detection is light). Each finished sentence is
sent to the service as a short audio file, and its text comes back in about a second. Only the Python standard library is
used for the web requests, so the light install (no PyTorch, no 4 GB model) is enough.

Every provider is a small class with the same shape:
    name, label            for messages
    price_per_hour         list price in USD (for the cost shown in Settings)
    request(wav, lang, keyterms) -> (url, headers, body)     one synchronous HTTPS request
    parse(json) -> text
"""
import io
import json
import time
import urllib.error
import urllib.request
import uuid
import wave

import numpy as np

from asr import clean_text, latin_share
from audio_io import RATE


def wav_bytes(audio):
    """16-bit PCM WAV, mono, 16 kHz: accepted by every service."""
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def multipart(fields, files):
    """fields: {name: str}; files: {name: (filename, bytes, content_type)} -> (body, content_type header)."""
    boundary = "----versefinder" + uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields.items():
        vals = v if isinstance(v, (list, tuple)) else [v]
        for one in vals:
            out.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{one}\r\n".encode("utf-8"))
    for k, (fname, data, ctype) in files.items():
        out.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fname}\"\r\nContent-Type: {ctype}\r\n\r\n".encode("utf-8"))
        out.write(data)
        out.write(b"\r\n")
    out.write(f"--{boundary}--\r\n".encode("utf-8"))
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


class CloudError(Exception):
    def __init__(self, message, permanent=False):
        super().__init__(message)
        self.permanent = permanent       # a wrong key or an unpaid account: retrying won't help


PROVIDERS = {}


def provider(cls):
    PROVIDERS[cls.name] = cls
    return cls


class CloudTranscriber:
    """Same interface as asr.Transcriber, but the work is done by a paid service."""

    device = "cloud"
    gpu_name = ""

    def __init__(self, provider_name, key, keyterms=None, log=print, timeout=20):
        if provider_name not in PROVIDERS:
            raise ValueError(f"Unknown speech service: {provider_name}")
        if not key:
            raise CloudError(f"No API key for {PROVIDERS[provider_name].label} yet. Add it in Settings → Listening.", permanent=True)
        self.p = PROVIDERS[provider_name]()
        self.key = key
        self.keyterms = list(keyterms or [])[:100]
        self.log = log
        self.timeout = timeout
        self.speed = 0.0
        self.billed_seconds = 0.0          # this session; the app adds it up per month
        self.failures = 0

    @property
    def describe(self):
        return f"{self.p.label} (cloud)"

    def _call(self, audio, lang):
        url, headers, body = self.p.request(wav_bytes(audio), lang, self.keyterms, self.key)
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                data = json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            if e.code in (401, 403):
                raise CloudError(f"{self.p.label} did not accept the API key. Check it in Settings → Listening → Speech recognition.", permanent=True)
            if e.code == 402:
                raise CloudError(f"The {self.p.label} account is out of credit. Add credit on their website, or switch to 'On this PC' in Settings.", permanent=True)
            low = detail.lower()
            if e.code in (400, 404, 422) and self.keyterms and "keyterm" in low:
                self.log(f"{self.p.label} would not take the Bible-name hints ({detail[:120]}); carrying on without them.")
                self.keyterms = []
                return self._call(audio, lang)
            if e.code in (400, 404, 422) and getattr(self.p, "fallback_model", None) and "model" in low:
                self.log(f"{self.p.label}: model {self.p.model} not available ({detail[:120]}); using {self.p.fallback_model}.")
                self.p.model, self.p.fallback_model = self.p.fallback_model, None
                return self._call(audio, lang)
            raise CloudError(f"{self.p.label} answered {e.code}: {detail or e.reason}")
        except urllib.error.URLError as e:
            raise CloudError(f"Could not reach {self.p.label}: {e.reason}. Is this PC online?")
        except TimeoutError:
            raise CloudError(f"{self.p.label} took too long to answer.")
        return self.p.parse(data)

    def transcribe(self, audio, mode="auto", final=True):
        """Returns (text, lang, score, seconds) like asr.Transcriber. Retries twice on a network hiccup."""
        t0 = time.time()
        lang = {"ar": "ar", "en": "en"}.get(mode, "auto")
        last = None
        for attempt in range(3):
            try:
                text = self._call(audio, lang)
                self.failures = 0
                break
            except CloudError as e:
                last = e
                if e.permanent:
                    raise
                time.sleep(0.4 * (attempt + 1))
        else:
            self.failures += 1
            raise last
        dur = len(audio) / RATE
        self.billed_seconds += self.p.billed(dur)
        took = time.time() - t0
        self.speed = 0.8 * self.speed + 0.2 * (took / max(0.5, dur)) if self.speed else took / max(0.5, dur)
        text = clean_text(text)
        return text, ("en" if latin_share(text) > 0.5 else "ar"), 0.0, took


class Provider:
    name = ""
    label = ""
    price_per_hour = 0.0
    min_seconds = 0.0                       # some services bill at least this much per request

    def billed(self, seconds):
        return max(seconds, self.min_seconds)

    def request(self, wav, lang, keyterms, key):
        raise NotImplementedError

    def parse(self, data):
        raise NotImplementedError


@provider
class ElevenLabs(Provider):
    """ElevenLabs Scribe v3 (whole recordings): the phone remote's spoken commands. $0.20 / hour + $0.05 for the keyterms."""
    name = "elevenlabs"
    label = "ElevenLabs Scribe"
    price_per_hour = 0.25
    model = "scribe_v3"
    fallback_model = "scribe_v2"

    def request(self, wav, lang, keyterms, key):
        fields = {"model_id": self.model, "tag_audio_events": "false", "timestamps_granularity": "none"}
        if lang in ("ar", "en"):
            fields["language_code"] = {"ar": "ara", "en": "eng"}[lang]
        if keyterms:
            fields["keyterms"] = list(keyterms)[:50]
        body, ctype = multipart(fields, {"file": ("sentence.wav", wav, "audio/wav")})
        return "https://api.elevenlabs.io/v1/speech-to-text", {"xi-api-key": key, "Content-Type": ctype}, body

    def parse(self, data):
        return data.get("text", "")


@provider
class Deepgram(Provider):
    """Deepgram Nova-3, Egyptian Arabic (ar-EG). ~$0.26 / hour; new accounts get $200 of free credit."""
    name = "deepgram"
    label = "Deepgram Nova-3"
    price_per_hour = 0.258

    def request(self, wav, lang, keyterms, key):
        from urllib.parse import urlencode
        params = [("model", "nova-3"), ("language", "en" if lang == "en" else ("multi" if lang == "auto" else "ar-EG")),
                  ("smart_format", "false"), ("punctuate", "true")]
        params += [("keyterm", k) for k in list(keyterms)[:50]]
        url = "https://api.deepgram.com/v1/listen?" + urlencode(params)
        return url, {"Authorization": "Token " + key, "Content-Type": "audio/wav"}, wav

    def parse(self, data):
        try:
            return data["results"]["channels"][0]["alternatives"][0]["transcript"]
        except (KeyError, IndexError, TypeError):
            return ""
