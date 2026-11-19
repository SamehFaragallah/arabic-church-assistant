"""Voice detection (Silero VAD), sentence cutting, and speech-to-text (Cohere Transcribe Arabic)."""
import os
import re
import time

import numpy as np

from audio_io import FRAME, RATE

HERE = os.path.dirname(os.path.abspath(__file__))
FRAME_S = FRAME / RATE


# --------------------------------------------------------------------------------------------- voice detection
class VoiceDetector:
    """Silero VAD (MIT licence): the chance that a 32 ms frame contains speech. Unlike a loudness threshold
    it isn't fooled by music, the PA system's hum or the room getting louder."""

    def __init__(self, path=None):
        import onnxruntime
        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 4
        self.sess = onnxruntime.InferenceSession(path or os.path.join(HERE, "silero_vad.onnx"),
                                                 providers=["CPUExecutionProvider"], sess_options=opts)
        self.reset()

    def reset(self):
        self.h = np.zeros((1, 1, 128), np.float32)
        self.c = np.zeros((1, 1, 128), np.float32)
        self.ctx = np.zeros(64, np.float32)

    def __call__(self, frame):
        x = np.concatenate([self.ctx, frame]).reshape(1, -1).astype(np.float32)
        out, self.h, self.c = self.sess.run(None, {"input": x, "h": self.h, "c": self.c})
        self.ctx = frame[-64:]
        return float(np.asarray(out).reshape(-1)[0])


# --------------------------------------------------------------------------------------------- sentence cutting
class Segmenter:
    """Collects the frames of one stretch of speech. Gives:
       ("partial", id, audio) every ~0.7 s while someone speaks (live preview), and
       ("final", id, audio)   after a short pause, or after max_len seconds without one — then it cuts at
                               the quietest moment of the last few seconds, between two words."""

    def __init__(self, pause=0.5, max_len=15.0, sensitivity=0.5, partial_every=0.7):
        self.configure(pause, max_len, sensitivity, partial_every)
        self.seg_id = 0
        self.reset()

    def configure(self, pause=None, max_len=None, sensitivity=None, partial_every=None):
        if pause is not None:
            self.end_frames = max(6, int(round(float(pause) / FRAME_S)))
        if max_len is not None:
            self.max_frames = int(float(max_len) / FRAME_S)
        if sensitivity is not None:
            s = min(0.9, max(0.1, float(sensitivity)))
            self.start_p = 1.0 - s            # sensitivity 0.5 -> starts at 0.5
            self.cont_p = max(0.15, self.start_p - 0.15)
        if partial_every is not None:
            self.partial_frames = max(10, int(float(partial_every) / FRAME_S))

    def reset(self):
        self.frames, self.probs = [], []
        self.pre = []
        self.in_speech = False
        self.silence = 0
        self.speech = 0
        self.since_partial = 0
        self.started_at = 0.0

    PRE = 10        # 0.32 s kept from before the speech starts
    POST = 6        # 0.19 s kept after it ends
    MIN_SPEECH = 8  # shorter sounds are coughs and clicks

    def feed(self, frame, prob, now):
        out = []
        if not self.in_speech:
            self.pre.append(frame)
            if len(self.pre) > self.PRE:
                self.pre.pop(0)
            if prob >= self.start_p:
                self.in_speech = True
                self.seg_id += 1
                self.frames = list(self.pre)
                self.probs = [0.0] * (len(self.frames) - 1) + [prob]
                self.pre = []
                self.speech, self.silence, self.since_partial = 1, 0, 0
                self.started_at = now - len(self.frames) * FRAME_S
            return out
        self.frames.append(frame)
        self.probs.append(prob)
        self.since_partial += 1
        if prob >= self.cont_p:
            self.silence = 0
            self.speech += 1
        else:
            self.silence += 1
        if self.silence >= self.end_frames:
            keep = len(self.frames) - self.silence + self.POST
            if self.speech >= self.MIN_SPEECH:
                out.append(("final", self.seg_id, np.concatenate(self.frames[:keep]), self.started_at))
            tail = self.frames[-self.PRE:]
            self.reset()
            self.pre = tail
            return out
        if len(self.frames) >= self.max_frames:
            # no pause for a long time: cut at the quietest moment of the last 4 seconds
            look = min(len(self.frames) - 1, int(4.0 / FRAME_S))
            lo = max(int(3.0 / FRAME_S), len(self.frames) - look)
            win = np.convolve(np.array(self.probs[lo:]), np.ones(5) / 5, mode="same")
            cut = lo + int(np.argmin(win)) + 1
            out.append(("final", self.seg_id, np.concatenate(self.frames[:cut]), self.started_at))
            rest, rest_p = self.frames[cut:], self.probs[cut:]
            self.seg_id += 1
            self.started_at = self.started_at + cut * FRAME_S
            self.frames, self.probs = rest, rest_p
            self.speech = sum(1 for p in rest_p if p >= self.cont_p)
            self.since_partial = 0
            return out
        if self.since_partial >= self.partial_frames and self.speech >= 12:
            self.since_partial = 0
            out.append(("partial", self.seg_id, np.concatenate(self.frames), self.started_at))
        return out

    def flush(self, now):
        out = []
        if self.in_speech and self.speech >= self.MIN_SPEECH:
            out.append(("final", self.seg_id, np.concatenate(self.frames), self.started_at))
        self.reset()
        return out


# --------------------------------------------------------------------------------------------- text clean-up
# Phrases speech models invent on silence, music or applause (YouTube subtitles they were trained on).
HALLUCINATIONS = ("نانسي قنقر", "اشتركوا في القناة", "اشترك في القناة", "شكرا للمشاهدة", "شكراً للمشاهدة",
                  "لا تنسوا الاشتراك", "ترجمة نانسي", "thank you for watching", "thanks for watching", "please subscribe",
                  "like and subscribe", "subtitles by", "amara.org")
_LATIN = re.compile(r"[A-Za-z]")
_ARABIC = re.compile(r"[؀-ۿ]")


def latin_share(text):
    lat, ar = len(_LATIN.findall(text)), len(_ARABIC.findall(text))
    return lat / max(1, lat + ar)


# with an interpreter: how sure the model must be of an answer for it to be kept beside the other language's
BOTH_MIN = -0.30


# asked for Arabic, the model is this unsure or worse: it may have been English
UNSURE = -0.20
_AR_WORD = re.compile(r"[\u0621-\u064A]{2,}")


def two_languages(text):
    """A sentence of English and a sentence of Arabic in one text (a pastor and, straight after, his interpreter).
    (Letters only: «فـو غـــد himself is with you» is not Arabic and English, it is English written badly.
     And sentences: "For the Bid's, خلق Allah السماوات والأرض" changes script word by word, which is one Arabic
     sentence written badly.)"""
    ar = _AR_WORD.findall(text)
    if not (len(_LATIN.findall(text)) >= 12 and len(ar) >= 2 and sum(len(w) for w in ar) >= 8):
        return False
    runs, last = 0, ""
    for w in text.split():
        lat, arb = bool(_LATIN.search(w)), bool(_ARABIC.search(w))
        if lat and arb:
            return False                      # one word in both scripts
        k = "l" if lat else "a" if arb else ""
        if k and k != last:
            runs, last = runs + 1, k
    return runs <= 3


def looped(text):
    """The model went round in circles: one phrase written over and over ("I'm not sure." eight times) is most of
    the text. Such an answer is not what was said, however sure the model is of it."""
    w = (text or "").split()
    return len(w) >= 8 and len(clean_text(text).split()) * 2 <= len(w)


# the model's own marks for silence / noise / music ("@@@فراغ", "@@@ضوضاء") and for speech it could not make out
# ("###", "غير_واضح")
NONSPEECH = re.compile(r"@@@\S*|#{2,}|غير[_ ]واضح")


def clean_text(text):
    text = NONSPEECH.sub(" ", text or "")
    text = " ".join(text.split())
    if not text or re.fullmatch(r"[(\[（][^()\[\]]*[)\]）][.!?]?", text):   # "(تأتأة)", "(Where)": a remark, not speech
        return ""
    low = text.lower()
    if any(h in low for h in HALLUCINATIONS):
        return ""
    text = re.sub(r"(.)\1{3,}", r"\1", text)                    # "يااااااا" -> "يا"
    words = text.split()
    out, i = [], 0
    while i < len(words):                                       # a phrase repeated 4+ times in a row is a loop
        done = False                                            # (a whole sentence of 6+ words: 3 times)
        for n in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12):
            unit = words[i:i + n]
            if len(unit) < n:
                break
            reps = 1
            while words[i + reps * n:i + (reps + 1) * n] == unit:
                reps += 1
            if reps >= (4 if n < 6 else 3):
                out.extend(unit)
                i += reps * n
                done = True
                break
        if not done:
            out.append(words[i])
            i += 1
    text = " ".join(out)
    if re.fullmatch(r"[\W_]*", text):
        return ""
    return text


# --------------------------------------------------------------------------------------------- speech-to-text
MODEL_NAME = "cohere-transcribe-arabic-07-2026"
MODEL_REPO = "CohereLabs/" + MODEL_NAME


def find_model(explicit=None):
    """The model folder: given on the command line, inside engine\\models, or in the Hugging Face cache."""
    cands = [explicit] if explicit else []
    cands.append(os.path.join(HERE, "models", MODEL_NAME))
    for c in cands:
        if c and os.path.isfile(os.path.join(c, "config.json")) and os.path.isfile(os.path.join(c, "model.safetensors")):
            return c
    try:
        from huggingface_hub import snapshot_download
        p = snapshot_download(MODEL_REPO, local_files_only=True)
        if os.path.isfile(os.path.join(p, "model.safetensors")):
            return p
    except Exception:
        pass
    return None


class Transcriber:
    """Cohere Transcribe Arabic: Arabic (MSA, Egyptian and other dialects) and English, also mixed."""

    def __init__(self, model_dir, device="auto", log=print):
        import torch
        from transformers import AutoProcessor, CohereAsrForConditionalGeneration
        self.torch = torch
        self.log = log
        cuda = device != "cpu" and torch.cuda.is_available()
        self.device = "cuda" if cuda else "cpu"
        self.gpu_name = torch.cuda.get_device_name(0) if cuda else ""
        if not cuda:
            torch.set_num_threads(max(2, min(16, (os.cpu_count() or 4) // 2)))
        self.processor = AutoProcessor.from_pretrained(model_dir)
        self.tok = self.processor.tokenizer
        dtypes = [torch.float16] if cuda else [torch.bfloat16, torch.float32]
        self.model = None
        for dt in dtypes:
            self.dtype = dt
            model = CohereAsrForConditionalGeneration.from_pretrained(model_dir, dtype=dt)
            self.model = model.to(self.device).eval()
            took = self._warm_up()
            # bfloat16 is fast only on processors made for it; otherwise float32 is quicker
            if cuda or dt != torch.bfloat16 or took < 0.6:
                break
            log(f"bfloat16 is slow on this processor ({took:.2f}s for the test); trying float32")
            del model, self.model
        self.speed = 0.0

    def _warm_up(self):
        a = (np.random.default_rng(1).standard_normal(RATE * 3) * 0.01).astype(np.float32)
        self._decode(a, "ar", beams=1)
        t0 = time.time()
        self._decode(a, "ar", beams=1)
        return time.time() - t0

    @property
    def describe(self):
        if self.device == "cuda":
            return f"graphics card ({self.gpu_name})"
        return "processor (CPU, " + ("bfloat16" if self.dtype == self.torch.bfloat16 else "float32") + ")"

    def _decode(self, audio, lang, beams=1):
        torch = self.torch
        inputs = self.processor(audio, sampling_rate=RATE, return_tensors="pt", language=lang, punctuation=True)
        inputs = inputs.to(self.device)
        inputs["input_features"] = inputs["input_features"].to(self.dtype)
        max_new = int(min(440, len(audio) / RATE * 12 + 16))
        with torch.inference_mode():
            o = self.model.generate(**inputs, max_new_tokens=max_new, num_beams=beams,
                                    output_scores=True, return_dict_in_generate=True)
        seq = o.sequences[0]
        if beams > 1 and getattr(o, "sequences_scores", None) is not None:
            score = float(o.sequences_scores[0])
        else:
            sc = self.model.compute_transition_scores(o.sequences, o.scores, normalize_logits=True)
            score = float(sc[0].float().mean()) if sc.numel() else -9.0
        return self.processor.decode(seq, skip_special_tokens=True).strip(), score

    def transcribe(self, audio, mode="auto", final=True, both=False):
        """mode: 'ar' (Arabic, English quotes still come out in English), 'en', or 'auto'.
        The model writes the language it is asked for. Asked for Arabic when English was spoken it usually writes the
        English anyway, but sometimes a few Arabic words it is unsure of («ما قمنا به يبدو» for "What he started, he will
        continue"). So in 'auto' it is asked for English too whenever its Arabic answer is English, or unsure, and
        the surer answer is kept.
        both: an interpreter is at work. The pastor's English and the interpreter's Arabic then run into each other
        and even overlap, so it is always asked for both, and when the answers are an English sentence and an Arabic
        one, both are kept (English first: "He needs us to cooperate with him. يريدنا أن نتعاون معه"). An answer it
        is unsure of is left out: asked for a language nobody spoke, it makes up a translation, and is unsure of it.
        An English answer that is not what was said never replaces the Arabic one, and is never put beside it: a
        loop, or one with fewer than half the Arabic answer's words ("What is this?" for a sound of four seconds).
        Nor are two sentences kept where the sound is too short to hold them both (a short sentence, and the
        model's own translation of it).
        Returns (text, lang, score, seconds)."""
        t0 = time.time()
        beams = 4 if (final and self.device == "cuda") else 1
        lang = "en" if mode == "en" else "ar"
        text, score = self._decode(audio, lang, beams)
        if mode == "auto" and lang == "ar" and len(audio) > RATE * 0.6 and (both or latin_share(text) > 0.5 or score < UNSURE):
            t2, s2 = self._decode(audio, "en", beams)
            a_en, e_en = latin_share(text) > 0.5, latin_share(t2) > 0.5
            a_two, e_two = two_languages(text), two_languages(t2)
            dur = len(audio) / RATE
            wa, we = len(clean_text(text).split()), len(clean_text(t2).split())
            # an English answer that is not what was said: a loop, or far too little beside the Arabic answer
            bad_e = (looped(t2) and not looped(text)) or (e_en and not a_en and we * 2 < wa)
            if both and (a_two or e_two):
                if e_two and not bad_e and (not a_two or s2 >= score):
                    text, score = t2, s2                          # the model wrote both by itself
            elif both and e_en and not a_en:
                keep_e = s2 >= BOTH_MIN and we >= 3 and not bad_e
                keep_a = score >= BOTH_MIN and wa >= 2
                # (is there room in the sound for both sentences? about 3 English or 2.3 Arabic words a second)
                room = dur >= 2.5 or we / 3.0 + wa / 2.3 <= dur * 1.15
                if keep_e and keep_a and room:
                    text, score = clean_text(t2) + " " + clean_text(text), min(score, s2)
                elif keep_e and keep_a:
                    if s2 > score:                                # one sentence, written twice: the surer answer
                        text, score = t2, s2
                elif (keep_e or s2 >= score + 0.1) and not bad_e:
                    text, score = t2, s2
            elif e_en and not bad_e and ((a_en and s2 >= score - 0.02) or (not a_en and s2 >= score + 0.1)):
                text, score = t2, s2                              # English: written the English way
        if latin_share(text) > 0.5:
            lang = "en"
        took = time.time() - t0
        self.speed = 0.8 * self.speed + 0.2 * (took / max(0.5, len(audio) / RATE)) if self.speed else took / max(0.5, len(audio) / RATE)
        return clean_text(text), lang, score, took
