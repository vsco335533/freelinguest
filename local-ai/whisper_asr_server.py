"""Local speech recognition (faster-whisper) for the backend's STT_PROVIDER=local.

POST /asr?languages=te,en (or language=te) with an audio file -> {"text", "language", "duration"}
Run: python whisper_asr_server.py   (listens on 127.0.0.1:9000; see DEPLOYMENT.md)
"""

import os
import tempfile
import uvicorn
from fastapi import FastAPI, File, UploadFile, Query
from faster_whisper import WhisperModel, decode_audio

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8_float16")

EN_MIN_PROB = float(os.environ.get("WHISPER_EN_MIN_PROB", "0.9"))
OTHER_MIN_PROB = float(os.environ.get("WHISPER_OTHER_MIN_PROB", "0.6"))
LOCAL_AI_HOME = os.path.expanduser(os.environ.get("LOCAL_AI_HOME", "~/linguest"))
# Saving recent recordings helps tune recognition but stores users' voices: off by default.
CLIP_DIR = os.environ.get("WHISPER_CLIP_DIR", os.path.join(LOCAL_AI_HOME, "logs", "asr_clips"))
CLIP_KEEP = int(os.environ.get("WHISPER_CLIP_KEEP", "0"))


def _save_clip(data: bytes, suffix: str) -> None:
    """Keep the most recent recordings locally for debugging recognition quality."""
    if CLIP_KEEP <= 0:
        return
    try:
        os.makedirs(CLIP_DIR, mode=0o700, exist_ok=True)
        import time
        with open(os.path.join(CLIP_DIR, f"{time.strftime('%Y%m%d-%H%M%S')}-{time.time_ns() % 10**6}{suffix}"), "wb") as f:
            f.write(data)
        clips = sorted(os.listdir(CLIP_DIR))
        for old in clips[:-CLIP_KEEP]:
            os.unlink(os.path.join(CLIP_DIR, old))
    except OSError:
        pass


app = FastAPI()
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)

# Language-specific Whisper fine-tunes (vasista22/whisper-<lang>-small, IIT Madras,
# converted to CTranslate2). The general model mangles real-world Telugu/Hindi/...
# speech; these transcribe it far better. Loaded on first use.
MODEL_DIR = os.environ.get("WHISPER_LANG_MODEL_DIR", os.path.join(LOCAL_AI_HOME, "models"))
LANG_MODELS = {"te": "telugu", "hi": "hindi", "ta": "tamil", "kn": "kannada", "gu": "gujarati"}
_lang_models: dict = {}


def _model_for(language: str | None):
    name = LANG_MODELS.get(language or "")
    path = os.path.join(MODEL_DIR, f"whisper-{name}-small-ct2") if name else ""
    if not path or not os.path.isdir(path):
        return model
    if language not in _lang_models:
        _lang_models[language] = WhisperModel(path, device=DEVICE, compute_type=COMPUTE_TYPE)
    return _lang_models[language]

@app.get("/")
async def health():
    return {"status": "ok", "model": MODEL_SIZE}

@app.post("/asr")
async def asr(
    audio_file: UploadFile = File(...),
    output: str = Query("json"),
    language: str | None = Query(None),
    task: str = Query("transcribe"),
    languages: str | None = Query(None),
):
    data = await audio_file.read()
    suffix = os.path.splitext(audio_file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        tmp = f.name
    try:
        audio = decode_audio(tmp, sampling_rate=16000)
        allowed = [c.strip().lower() for c in (languages or "").split(",") if c.strip()]
        if not language and allowed:
            # Auto-detect often hears Telugu as Hindi/Tamil, and Telugu's own score
            # is too low to compare against English. Keep the detected language if
            # it is one the learner speaks; otherwise it is a misdetection of the
            # base language (allowed[0]). Then transcribe once, not twice.
            detected, prob, _ = model.detect_language(audio)
            native = allowed[0]  # learner's base language; the rest are target languages
            # Whisper often fails to recognise base-language speech on real
            # microphones (Telugu scores ~0 and is labelled Hindi, Urdu, English,
            # even Indonesian), while target-language speech scores 0.94-1.0. So a
            # target language is only accepted when detection is confident;
            # everything else is treated as the base language.
            min_prob = EN_MIN_PROB if detected == "en" else OTHER_MIN_PROB
            if detected == native or (detected in allowed and prob >= min_prob):
                language = detected
            else:
                language = native
            print(f"[asr] detected={detected} p={prob:.2f} -> {language}", flush=True)
        _save_clip(data, suffix)
        segments, info = _model_for(language).transcribe(
            audio,
            language=language or None,
            task=task,
            # English is reliable with greedy decoding; other languages benefit from beam search.
            beam_size=1 if language == "en" else 5,
            # Skip silence/noise so Whisper doesn't invent text ("www.fema.org", "foreign").
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            # Stop one bad segment from feeding repetition loops into the next.
            condition_on_previous_text=False,
        )
        text = "".join(seg.text for seg in segments).strip()
        print(f"[asr] lang={info.language} text={text[:80]!r}", flush=True)
        return {"text": text, "language": info.language, "duration": info.duration}
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass

if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("WHISPER_HOST", "127.0.0.1"),
                port=int(os.environ.get("WHISPER_PORT", "9000")))
