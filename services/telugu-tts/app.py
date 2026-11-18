"""Self-hosted native-language TTS for FreeLingo's bilingual voice tutor.

Engines (TTS_ENGINE):
- parler (default, GPU recommended): ai4bharat/indic-parler-tts, Apache-2.0. One voice
  reads native-script narration with embedded English phrases naturally, so the backend
  sends whole mixed-language sentences here (mixed_script=true).
- mms (CPU fallback): facebook/mms-tts-tel, CC-BY-NC 4.0 (non-commercial). Native script
  only; the backend then routes English phrases to its main TTS (mixed_script=false).

POST /v1/audio/speech {"input": "...", "language": "te"} -> audio/wav (mono, 16-bit PCM)
  language (optional, default te) picks the parler speaker: te, hi, kn, ta, ml, or.
GET  /health -> {"status", "engine", "model", "device", "mixed_script"}
"""

from __future__ import annotations

import io
import logging
import os
import threading
import time
import wave
from contextlib import asynccontextmanager

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from transformers import AutoTokenizer

ENGINE = os.getenv("TTS_ENGINE", "parler").strip().lower()
_DEFAULT_MODELS = {"parler": "ai4bharat/indic-parler-tts", "mms": "facebook/mms-tts-tel"}
MODEL_ID = os.getenv("TTS_MODEL_ID") or _DEFAULT_MODELS.get(ENGINE, "")
# Indic Parler-TTS picks the voice from a natural-language description. Named speakers keep
# the voice consistent across sentences; each language uses one of its recommended speakers.
_VOICE_STYLE = (
    "speaks in a warm, friendly and expressive voice at a moderate pace, "
    "pronouncing English words clearly. The recording is of very high quality, with the "
    "speaker's voice sounding clear and very close up."
)
DEFAULT_LANGUAGE = "te"
_SPEAKERS = {
    "te": "Lalitha",
    "hi": "Divya",
    "kn": "Anu",
    "ta": "Jaya",
    "ml": "Anjali",
    "or": "Debjani",
}
# TTS_VOICE_DESCRIPTION keeps overriding the Telugu voice; TTS_VOICE_DESCRIPTION_<LANG>
# (for example TTS_VOICE_DESCRIPTION_HI) overrides another language.
def _description_env(lang: str) -> str:
    if lang == DEFAULT_LANGUAGE:
        return "TTS_VOICE_DESCRIPTION"
    return f"TTS_VOICE_DESCRIPTION_{lang.upper()}"


VOICE_DESCRIPTIONS = {
    lang: os.getenv(_description_env(lang), f"{speaker} {_VOICE_STYLE}")
    for lang, speaker in _SPEAKERS.items()
}
SEED = int(os.getenv("TTS_SEED", "42"))
# Optional torch.compile with a static KV cache (Parler-TTS's documented speed-up; mode
# "reduce-overhead" uses CUDA graphs). Inputs are padded to fixed bucket lengths so each
# shape is compiled once at startup. Any compile failure falls back to eager generation.
COMPILE = os.getenv("TTS_COMPILE", "0").strip().lower() in ("1", "true", "yes")
COMPILE_MODE = os.getenv("TTS_COMPILE_MODE", "reduce-overhead").strip()
_PROMPT_BUCKET = 64  # prompt token lengths are padded up to a multiple of this
_WARMUP_BUCKETS = (64, 128)  # covers short tutor sentences; longer ones compile on demand
TORCH_THREADS = int(os.getenv("TORCH_THREADS", "4"))
DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"


def _model_dtype() -> torch.dtype:
    """bfloat16 halves VRAM on Ampere+ GPUs; T5 encoders can overflow in float16."""
    requested = os.getenv("TTS_DTYPE", "auto").strip().lower()
    if requested == "float32" or DEVICE == "cpu":
        return torch.float32
    if requested in ("auto", "bfloat16") and torch.cuda.is_bf16_supported():
        return torch.bfloat16
    return torch.float16 if requested == "float16" else torch.float32


DTYPE = _model_dtype()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("native-tts")


class ParlerEngine:
    mixed_script = True

    def __init__(self) -> None:
        from parler_tts import ParlerTTSForConditionalGeneration  # noqa: PLC0415

        try:
            # PyTorch scaled-dot-product attention is faster than the eager default.
            model = ParlerTTSForConditionalGeneration.from_pretrained(
                MODEL_ID, torch_dtype=DTYPE, attn_implementation="sdpa"
            )
            logger.info("Using SDPA attention")
        except (TypeError, ValueError) as exc:
            logger.warning("SDPA attention unavailable (%s); using default attention", exc)
            model = ParlerTTSForConditionalGeneration.from_pretrained(MODEL_ID, torch_dtype=DTYPE)
        self.model = model.to(DEVICE).eval()
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
        self.description_tokenizer = AutoTokenizer.from_pretrained(
            self.model.config.text_encoder._name_or_path
        )
        self.sampling_rate = self.model.config.sampling_rate
        self.compiled = False
        # Static shapes for compiled generation: every description shares one padded length.
        longest = max(
            len(self.description_tokenizer(text).input_ids) for text in VOICE_DESCRIPTIONS.values()
        )
        self.description_length = _round_up(longest, 16)
        if COMPILE and DEVICE != "cpu":
            self._compile()
        self.descriptions = {
            lang: self._tokenize(self.description_tokenizer, text, self.description_length)
            for lang, text in VOICE_DESCRIPTIONS.items()
        }

    def _tokenize(self, tokenizer: object, text: str, length: int | None) -> object:
        if not self.compiled or length is None:
            return tokenizer(text, return_tensors="pt").to(DEVICE)
        return tokenizer(
            text, return_tensors="pt", padding="max_length", max_length=length
        ).to(DEVICE)

    def _prompt_length(self, text: str) -> int | None:
        if not self.compiled:
            return None
        return _round_up(len(self.tokenizer(text).input_ids), _PROMPT_BUCKET)

    def _generate(self, description: object, prompt: object) -> torch.Tensor:
        torch.manual_seed(SEED)  # stable voice character across sentences
        return self.model.generate(
            input_ids=description.input_ids,
            attention_mask=description.attention_mask,
            prompt_input_ids=prompt.input_ids,
            prompt_attention_mask=prompt.attention_mask,
        )

    def _compile(self) -> None:
        eager_forward = self.model.forward
        started = time.perf_counter()
        logger.info("Compiling (mode=%s); the first start can take several minutes", COMPILE_MODE)
        try:
            self.model.generation_config.cache_implementation = "static"
            self.model.forward = torch.compile(self.model.forward, mode=COMPILE_MODE)
            self.compiled = True
            description = self._tokenize(
                self.description_tokenizer,
                VOICE_DESCRIPTIONS[DEFAULT_LANGUAGE],
                self.description_length,
            )
            with torch.no_grad():
                for bucket in _WARMUP_BUCKETS:
                    prompt = self._tokenize(self.tokenizer, "నమస్కారం. Hello.", bucket)
                    for _ in range(2 if COMPILE_MODE == "reduce-overhead" else 1):
                        self._generate(description, prompt)
            logger.info("Compiled in %.0fs", time.perf_counter() - started)
        except Exception:
            logger.exception("Compilation failed; using eager generation")
            self.model.forward = eager_forward
            self.model.generation_config.cache_implementation = None
            self.compiled = False
            torch.cuda.empty_cache()

    def synthesize(self, text: str, language: str = DEFAULT_LANGUAGE) -> np.ndarray:
        description = self.descriptions.get(language) or self.descriptions[DEFAULT_LANGUAGE]
        prompt = self._tokenize(self.tokenizer, text, self._prompt_length(text))
        generation = self._generate(description, prompt)
        return generation.to(torch.float32).cpu().numpy().squeeze()


def _round_up(value: int, step: int) -> int:
    return max(step, -(-value // step) * step)


class MmsEngine:
    mixed_script = False

    def __init__(self) -> None:
        from transformers import VitsModel  # noqa: PLC0415

        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
        self.model = VitsModel.from_pretrained(MODEL_ID).to(DEVICE).eval()
        self.sampling_rate = self.model.config.sampling_rate
        self.romanizer = None
        if getattr(self.tokenizer, "is_uroman", False):
            from uroman import Uroman  # noqa: PLC0415

            self.romanizer = Uroman()

    def synthesize(self, text: str, language: str = DEFAULT_LANGUAGE) -> np.ndarray:
        _ = language  # one MMS checkpoint speaks one language (Telugu by default)
        if self.romanizer is not None:
            text = self.romanizer.romanize_string(text)
        inputs = self.tokenizer(text, return_tensors="pt").to(DEVICE)
        if inputs["input_ids"].shape[-1] == 0:
            raise HTTPException(status_code=422, detail="No speakable characters for this voice")
        return self.model(**inputs).waveform[0].cpu().numpy()


_ENGINES = {"parler": ParlerEngine, "mms": MmsEngine}
_lock = threading.Lock()
_state: dict[str, object] = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if ENGINE not in _ENGINES:
        raise RuntimeError(f"Unknown TTS_ENGINE={ENGINE!r}; use one of {sorted(_ENGINES)}")
    torch.set_num_threads(TORCH_THREADS)
    logger.info("Loading engine=%s model=%s device=%s dtype=%s", ENGINE, MODEL_ID, DEVICE, DTYPE)
    engine = _ENGINES[ENGINE]()
    with torch.no_grad():
        engine.synthesize("నమస్కారం. Hello.")  # warm up kernels before the first request
    _state["engine"] = engine
    logger.info(
        "Ready engine=%s mixed_script=%s compiled=%s",
        ENGINE,
        engine.mixed_script,
        getattr(engine, "compiled", False),
    )
    yield


app = FastAPI(title="FreeLingo native TTS", lifespan=lifespan)


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=1000)
    language: str = Field(default=DEFAULT_LANGUAGE, max_length=10)


@app.get("/health")
def health() -> dict:
    engine = _state.get("engine")
    return {
        "status": "ok" if engine is not None else "loading",
        "engine": ENGINE,
        "model": MODEL_ID,
        "device": DEVICE,
        "mixed_script": bool(getattr(engine, "mixed_script", False)),
    }


def _to_wav(samples: np.ndarray, rate: int) -> bytes:
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak > 1.0:
        samples = samples / peak
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()


@app.post("/v1/audio/speech")
def speech(request: SpeechRequest) -> Response:
    engine = _state.get("engine")
    if engine is None:
        raise HTTPException(status_code=503, detail="Voice model is still loading")
    text = request.input.strip()
    language = request.language.split("-")[0].lower()
    started = time.perf_counter()
    with _lock, torch.no_grad():
        samples = engine.synthesize(text, language)
    elapsed = time.perf_counter() - started
    logger.info(
        "synth lang=%s chars=%d audio_s=%.1f took_s=%.1f",
        language,
        len(text),
        len(samples) / engine.sampling_rate,
        elapsed,
    )
    return Response(content=_to_wav(samples, engine.sampling_rate), media_type="audio/wav")
