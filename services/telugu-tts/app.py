"""Self-hosted native-language TTS for FreeLingo's bilingual voice tutor.

Engines (TTS_ENGINE):
- parler (default, GPU recommended): ai4bharat/indic-parler-tts, Apache-2.0. One voice
  reads native-script narration with embedded English phrases naturally, so the backend
  sends whole mixed-language sentences here (mixed_script=true).
- mms (CPU fallback): facebook/mms-tts-tel, CC-BY-NC 4.0 (non-commercial). Native script
  only; the backend then routes English phrases to its main TTS (mixed_script=false).

POST /v1/audio/speech {"input": "..."} -> audio/wav (mono, 16-bit PCM)
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
# the voice consistent across sentences (Telugu speakers include Lalitha and Prakash).
VOICE_DESCRIPTION = os.getenv(
    "TTS_VOICE_DESCRIPTION",
    "Lalitha speaks in a warm, friendly and expressive voice at a moderate pace, "
    "pronouncing English words clearly. The recording is of very high quality, with the "
    "speaker's voice sounding clear and very close up.",
)
SEED = int(os.getenv("TTS_SEED", "42"))
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
        self.description = self.description_tokenizer(VOICE_DESCRIPTION, return_tensors="pt").to(
            DEVICE
        )

    def synthesize(self, text: str) -> np.ndarray:
        prompt = self.tokenizer(text, return_tensors="pt").to(DEVICE)
        torch.manual_seed(SEED)  # stable voice character across sentences
        generation = self.model.generate(
            input_ids=self.description.input_ids,
            attention_mask=self.description.attention_mask,
            prompt_input_ids=prompt.input_ids,
            prompt_attention_mask=prompt.attention_mask,
        )
        return generation.to(torch.float32).cpu().numpy().squeeze()


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

    def synthesize(self, text: str) -> np.ndarray:
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
    logger.info("Ready engine=%s mixed_script=%s", ENGINE, engine.mixed_script)
    yield


app = FastAPI(title="FreeLingo native TTS", lifespan=lifespan)


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=1000)


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
    started = time.perf_counter()
    with _lock, torch.no_grad():
        samples = engine.synthesize(text)
    elapsed = time.perf_counter() - started
    logger.info(
        "synth chars=%d audio_s=%.1f took_s=%.1f",
        len(text),
        len(samples) / engine.sampling_rate,
        elapsed,
    )
    return Response(content=_to_wav(samples, engine.sampling_rate), media_type="audio/wav")
