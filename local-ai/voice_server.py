"""Local female voices for the learner's base and target languages (soft, clean, clear).

Run: python voice_server.py   (listens on 127.0.0.1:8890; see DEPLOYMENT.md)

POST /v1/audio/speech {"input": str, "language": "te" | "te-IN" ...} -> audio/mpeg
GET  /  -> health, loaded voices

Every base language is spoken by a female voice:
  - Indian languages: AI4Bharat Indic-TTS (FastPitch + HiFi-GAN, "female" speaker, MIT)
  - es / fr / it / pt / en / ja: Kokoro female voices (proxied to the Kokoro container)
  - pl / ru / sv / de / nl / zh: Piper female voices
  - ko / tr / ro / da / fi / hr: Supertonic 3 (Supertone, OpenRAIL), female voice F1;
    it speaks single words clearly, which matters for flashcards and lesson vocabulary.
Everything runs on CPU so it never competes with Ollama/Whisper for GPU memory.
"""

import asyncio
import io
import json
import os
import re
import subprocess
import tempfile
import threading
import wave
from collections import OrderedDict

import httpx
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

torch.set_num_threads(int(os.environ.get("TTS_THREADS", "4")))
LOCAL_AI_HOME = os.path.expanduser(os.environ.get("LOCAL_AI_HOME", "~/linguest"))
MODELS = os.environ.get("TTS_MODEL_DIR", os.path.join(LOCAL_AI_HOME, "models"))
KOKORO_URL = os.environ.get("KOKORO_URL", "http://localhost:8880")
MAX_LOADED = int(os.environ.get("TTS_MAX_LOADED", "4"))
PRELOAD = [c for c in os.environ.get("TTS_PRELOAD", "te").split(",") if c]
SPEAKING_RATE = float(os.environ.get("TTS_SPEAKING_RATE", "0.9"))  # < 1 = slower, clearer
SUPERTONIC_DIR = os.environ.get("SUPERTONIC_MODEL_DIR", os.path.join(MODELS, "supertonic3"))

# Soft, clean finish for every voice: trim rumble and hiss, tame harsh 3-5 kHz,
# light denoise, 120 ms padding, loudness matched to the English (Kokoro) voice.
SOFT_FILTER = os.environ.get(
    "TTS_AUDIO_FILTER",
    "highpass=f=70,lowpass=f=7500,equalizer=f=4000:t=q:w=1.2:g=-4,"
    "afftdn=nr=8:nf=-45,adelay=120:all=1,apad=pad_dur=0.12,"
    "loudnorm=I=-23:TP=-2:LRA=7",
)


def _female_shift(formant: float, pitch: float) -> str:
    """Male -> female conversion: raise formants (smaller vocal tract), then pitch."""
    return (
        f"asetrate=SR*{formant},aresample=SR,atempo={1 / formant:.4f},"
        f"rubberband=pitch={pitch}:formant=preserved"
    )


# language -> (engine, voice, extra ffmpeg filter before the soft finish)
VOICES: dict[str, tuple[str, str, str]] = {
    "te": ("indic", "te", ""),
    "hi": ("indic", "hi", ""),
    "ta": ("indic", "ta", ""),
    "kn": ("indic", "kn", ""),
    "ml": ("indic", "ml", ""),
    "or": ("indic", "or", ""),
    "es": ("kokoro", "ef_dora", ""),
    "fr": ("kokoro", "ff_siwis", ""),
    "it": ("kokoro", "if_sara", ""),
    "pt": ("kokoro", "pf_dora", ""),
    "en": ("kokoro", "bf_emma", ""),
    "ja": ("kokoro", "jf_alpha", ""),
    "zh": ("piper", "zh_CN-huayan-medium", ""),  # Kokoro on CPU is too slow for long Chinese
    "ko": ("supertonic", "F1", ""),
    "pl": ("piper", "pl_PL-gosia-medium", ""),
    "ru": ("piper", "ru_RU-irina-medium", ""),
    "sv": ("piper", "sv_SE-lisa-medium", ""),
    "de": ("piper", "de_DE-kerstin-medium", ""),
    "nl": ("piper", "nl_BE-nathalie-medium", ""),
    "tr": ("supertonic", "F1", ""),
    "ro": ("supertonic", "F1", ""),
    "da": ("supertonic", "F1", ""),
    "fi": ("supertonic", "F1", ""),
    "hr": ("supertonic", "F1", ""),
}

app = FastAPI()
_loaded: "OrderedDict[str, object]" = OrderedDict()
_load_lock = threading.Lock()
_synth_lock = threading.Lock()  # Coqui/Piper models are not thread-safe


def _base(language: str) -> str:
    return (language or "").split("-")[0].split("_")[0].lower()


def _indic(lang: str):
    from TTS.utils.synthesizer import Synthesizer

    root = os.path.join(MODELS, "indictts", lang)
    fp = os.path.join(root, "fastpitch")
    # The released configs point at the authors' training paths; fix them up.
    cfg_path = os.path.join(fp, "config.json")
    cfg = open(cfg_path, encoding="utf-8").read()
    fixed = re.sub(r'"[^"]*fastpitch/speakers\.pth"', json.dumps(os.path.join(fp, "speakers.pth")), cfg)
    if fixed != cfg:
        open(cfg_path, "w", encoding="utf-8").write(fixed)
    synth = Synthesizer(
        tts_checkpoint=os.path.join(fp, "best_model.pth"),
        tts_config_path=cfg_path,
        tts_speakers_file=os.path.join(fp, "speakers.pth"),
        vocoder_checkpoint=os.path.join(root, "hifigan", "best_model.pth"),
        vocoder_config=os.path.join(root, "hifigan", "config.json"),
        use_cuda=False,
    )
    if hasattr(synth.tts_model, "length_scale"):
        synth.tts_model.length_scale = 1 / SPEAKING_RATE  # slower = clearer
    return synth


def _piper(voice: str):
    from piper import PiperVoice

    return PiperVoice.load(os.path.join(MODELS, "piper", f"{voice}.onnx"))


def _mms(code: str):
    from transformers import AutoTokenizer, VitsModel

    name = f"facebook/mms-tts-{code}"
    model = VitsModel.from_pretrained(name).eval()
    model.speaking_rate = SPEAKING_RATE
    model.noise_scale = 0.4
    model.noise_scale_duration = 0.6
    return model, AutoTokenizer.from_pretrained(name)


def _supertonic(voice: str):
    from supertonic import TTS

    tts = TTS(model_dir=SUPERTONIC_DIR, auto_download=False,
              intra_op_num_threads=torch.get_num_threads())
    return tts, tts.get_voice_style(voice)


_uroman = None


def _romanize(text: str, lcode: str) -> str:
    global _uroman
    if _uroman is None:  # building the romanizer takes ~2 s; do it once
        import uroman as ur

        _uroman = ur.Uroman()
    return _uroman.romanize_string(text, lcode=lcode)


def _get(engine: str, voice: str):
    key = f"{engine}:{voice}"
    with _load_lock:
        if key in _loaded:
            _loaded.move_to_end(key)
            return _loaded[key]
        loader = {"indic": _indic, "piper": _piper, "mms": _mms, "supertonic": _supertonic}[engine]
        _loaded[key] = loader(voice)
        while len(_loaded) > MAX_LOADED:
            _loaded.popitem(last=False)
        return _loaded[key]


def _wav_bytes(samples: np.ndarray, rate: int) -> bytes:
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# Long text (listening exercises) is spoken in sentence groups of at most this
# many characters: some models fail or drift on very long inputs.
MAX_CHUNK_CHARS = int(os.environ.get("TTS_MAX_CHUNK_CHARS", "250"))
# Latin/Indic full stops need a following space (keeps "3.50" whole); CJK ones do not.
_SENTENCE_END = re.compile(r"(?<=[.!?।])\s+|(?<=[。！？])\s*|\n+")


def _chunks(text: str) -> list[str]:
    """Split text into sentence groups no longer than MAX_CHUNK_CHARS (when possible)."""
    groups: list[str] = []
    for sentence in (p.strip() for p in _SENTENCE_END.split(text)):
        if not sentence:
            continue
        if groups and len(groups[-1]) + len(sentence) + 1 <= MAX_CHUNK_CHARS:
            groups[-1] += " " + sentence
        else:
            groups.append(sentence)
    return groups or [text]


def _samples(engine: str, model, voice: str, text: str, language: str) -> tuple[np.ndarray, int]:
    """Synthesize one chunk; return float32 samples and the sample rate."""
    if engine == "indic":
        return np.asarray(model.tts(text, speaker_name="female"), dtype=np.float32), model.output_sample_rate
    if engine == "piper":
        from piper import SynthesisConfig

        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            model.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=1 / SPEAKING_RATE))
        buf.seek(0)
        with wave.open(buf, "rb") as r:
            pcm = np.frombuffer(r.readframes(r.getnframes()), dtype=np.int16)
        return pcm.astype(np.float32) / 32768, model.config.sample_rate
    if engine == "supertonic":
        tts, style = model
        wav, _ = tts.synthesize(text, voice_style=style, lang=language, speed=0.95)
        return np.asarray(wav, dtype=np.float32).reshape(-1), tts.sample_rate
    mms_model, tokenizer = model
    if getattr(tokenizer, "is_uroman", False):
        text = _romanize(text, voice)
    inputs = tokenizer(text, return_tensors="pt")
    if inputs["input_ids"].shape[-1] == 0:
        raise ValueError("nothing speakable in input")
    with torch.no_grad():
        audio = mms_model(**inputs).waveform[0].numpy()
    return audio.astype(np.float32), mms_model.config.sampling_rate


def _raw_audio(engine: str, voice: str, text: str, language: str) -> tuple[bytes, int]:
    """Return (WAV bytes, sample rate) straight from the engine."""
    if engine == "kokoro":
        r = httpx.post(
            f"{KOKORO_URL}/v1/audio/speech",
            json={"model": "kokoro", "input": text, "voice": voice, "response_format": "wav",
                  "speed": SPEAKING_RATE},
            # Kokoro runs on CPU here: about 1 s per 10-20 characters of long text.
            timeout=min(900.0, 60.0 + len(text) * 0.2),
        )
        r.raise_for_status()
        return r.content, 24000
    model = _get(engine, voice)
    parts, rate = [], 16000
    with _synth_lock:
        for chunk in _chunks(text):
            if not any(c.isalnum() for c in chunk):
                continue
            audio, rate = _samples(engine, model, voice, chunk, language)
            if parts:
                parts.append(np.zeros(int(rate * 0.3), dtype=np.float32))  # pause between sentences
            parts.append(audio)
    if not parts:
        raise ValueError("nothing speakable in input")
    return _wav_bytes(np.concatenate(parts), rate), rate


def _synthesize(language: str, text: str) -> bytes:
    engine, voice, extra = VOICES[language]
    raw, rate = _raw_audio(engine, voice, text, language)
    with tempfile.NamedTemporaryFile(suffix=".wav") as src:
        src.write(raw)
        src.flush()
        if extra:
            # Voice conversion runs on its own: rubberband fails when later
            # filters (padding) pull more audio after the end of the stream.
            raw = subprocess.run(
                ["ffmpeg", "-loglevel", "error", "-i", src.name, "-af",
                 extra.replace("SR", str(rate)), "-f", "wav", "pipe:1"],
                capture_output=True, check=True,
            ).stdout
            src.seek(0)
            src.truncate()
            src.write(raw)
            src.flush()
        out = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", src.name, "-af", SOFT_FILTER,
             "-ar", "24000", "-ac", "1", "-f", "mp3", "-b:a", "96k", "pipe:1"],
            capture_output=True, check=True,
        )
    return out.stdout


class SpeechRequest(BaseModel):
    input: str
    language: str


@app.get("/")
async def health():
    return {"status": "ok", "loaded": list(_loaded), "languages": sorted(VOICES)}


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    language = _base(req.language)
    if language not in VOICES:
        raise HTTPException(404, f"no female voice for {req.language!r}")
    text = req.input.strip()
    if not any(c.isalnum() for c in text):
        raise HTTPException(422, "nothing speakable in input")
    try:
        data = await asyncio.to_thread(_synthesize, language, text)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return Response(content=data, media_type="audio/mpeg")


@app.on_event("startup")
async def _preload():
    for lang in PRELOAD:
        engine, voice, _ = VOICES.get(_base(lang), ("kokoro", "", ""))
        if engine != "kokoro":
            await asyncio.to_thread(_get, engine, voice)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TTS_PORT", "8890")))
