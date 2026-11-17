import hashlib
import io
import json
import re
import time
import wave

import httpx
import openai

from app.core.app_logger import get_logger
from app.services.prompts.speech import build_speech_instructions

logger = get_logger(__name__)


class KokoroTTSService:
    def __init__(self, base_url: str, voice: str) -> None:
        self.base_url = base_url
        self.voice = voice

    async def health(self) -> None:
        """Raise if Kokoro is unreachable."""
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{self.base_url}/v1/models", timeout=5.0)
            r.raise_for_status()

    async def synthesize(
        self, text: str, voice: str | None = None, language: str | None = None
    ) -> bytes:
        """Call Kokoro-FastAPI and return MP3 audio bytes."""
        _ = language  # Kokoro handles language via the voice model itself
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url}/v1/audio/speech",
                json={
                    "model": "kokoro",
                    "input": text,
                    "voice": voice or self.voice,
                    "response_format": "mp3",
                },
                timeout=30.0,
            )
            response.raise_for_status()
            return response.content


# Sentences end at . ! ? or the Indic danda (U+0964).
_SENTENCE_RE = re.compile(r"[^.!?।\n]+[.!?।]*")


def has_non_latin_letters(text: str) -> bool:
    return any(c.isalpha() and not (c.isascii() or "À" <= c <= "ɏ") for c in text)


def concat_wav(chunks: list[bytes]) -> bytes:
    """Join WAV clips that share the first clip's format into one WAV file."""
    params = None
    frames: list[bytes] = []
    for chunk in chunks:
        with wave.open(io.BytesIO(chunk), "rb") as clip:
            clip_params = (clip.getnchannels(), clip.getsampwidth(), clip.getframerate())
            if params is None:
                params = clip_params
            if clip_params != params:
                logger.warning("[tts-native] Skipping clip with mismatched WAV format")
                continue
            frames.append(clip.readframes(clip.getnframes()))
    if params is None:
        return b""
    out = io.BytesIO()
    with wave.open(out, "wb") as joined:
        joined.setnchannels(params[0])
        joined.setsampwidth(params[1])
        joined.setframerate(params[2])
        joined.writeframes(b"".join(frames))
    return out.getvalue()


class NativeTTSService:
    """Client for a self-hosted native-language voice (e.g. Indic Parler-TTS Telugu).

    With ``mixed_script`` the voice reads whole sentences, including embedded
    target-language phrases; otherwise the voice tutor routes Latin-script phrases
    to the main TTS provider. Returns WAV audio bytes.
    """

    def __init__(self, base_url: str, languages: list[str], *, mixed_script: bool = True) -> None:
        self.base_url = base_url.rstrip("/")
        self.languages = {code.strip().lower() for code in languages if code.strip()}
        self.mixed_script = mixed_script

    def supports(self, language_code: str) -> bool:
        return language_code.split("-")[0].lower() in self.languages

    async def health(self) -> None:
        """Raise if the native voice service is unreachable."""
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{self.base_url}/health", timeout=5.0)
            r.raise_for_status()

    async def synthesize(
        self, text: str, voice: str | None = None, language: str | None = None
    ) -> bytes:
        _ = voice, language  # one voice per service instance
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url}/v1/audio/speech",
                json={"input": text},
                timeout=60.0,
            )
            response.raise_for_status()
            return response.content

    def should_speak(self, text: str, native_language: str | None) -> bool:
        """Whether a read-aloud request should use this voice instead of the main TTS."""
        return (
            self.mixed_script
            and bool(native_language)
            and self.supports(native_language or "")
            and has_non_latin_letters(text)
        )

    async def synthesize_long(self, text: str) -> bytes:
        """Synthesize multi-sentence text sentence by sentence and join it as one WAV."""
        parts = [p.strip() for p in _SENTENCE_RE.findall(text) if any(c.isalnum() for c in p)]
        clips = [await self.synthesize(part) for part in parts]
        return concat_wav(clips)


class OpenAITTSService:
    def __init__(
        self,
        api_key: str,
        model: str,
        voice: str,
        speed: float = 1.0,
        timeout: float | None = None,
    ) -> None:
        self._client = openai.AsyncOpenAI(api_key=api_key)
        self.model = model
        self.voice = voice
        self.speed = speed
        self.timeout = timeout

    async def health(self) -> None:
        """Raise if OpenAI TTS is unreachable (lightweight models list call)."""
        await self._client.models.list()

    def get_instructions(self, language: str | None = None) -> str | None:
        if self.model == "gpt-4o-mini-tts" or self.model.startswith("gpt-4o-mini-tts-"):
            return build_speech_instructions(language)
        return None

    def get_cache_key(
        self, text: str, voice: str | None = None, language: str | None = None
    ) -> str:
        identity = {
            "text": text,
            "locale": language,
            "provider": "openai",
            "model": self.model,
            "voice": voice or self.voice,
            "speed": self.speed,
            "format": "mp3",
        }
        instructions = self.get_instructions(language)
        if instructions:
            identity["instructions"] = instructions
        return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()

    async def synthesize(
        self, text: str, voice: str | None = None, language: str | None = None
    ) -> bytes:
        """Call OpenAI TTS API and return MP3 audio bytes."""
        text = text.strip()
        if not text:
            logger.warning("[tts-openai] Empty text received for synthesis")
            return b""

        req_voice = (voice or self.voice).strip()
        input_len = len(text)
        start_t = time.perf_counter()
        logger.info(
            "[tts-openai] request_start model=%s voice=%s chars=%d",
            self.model,
            req_voice,
            input_len,
        )
        request_payload = {
            "model": self.model,
            "voice": req_voice,
            "input": text,
            "response_format": "mp3",
            "speed": self.speed,
        }
        instructions = self.get_instructions(language)
        if instructions:
            request_payload["instructions"] = instructions
        if self.timeout is not None:
            request_payload["timeout"] = self.timeout

        response = await self._client.audio.speech.create(**request_payload)
        audio = response.content
        if not audio:
            raise RuntimeError("OpenAI TTS returned empty audio payload")
        elapsed_ms = (time.perf_counter() - start_t) * 1000
        request_id = getattr(response, "request_id", None)
        if request_id is None:
            headers = getattr(response, "headers", None)
            if headers is not None:
                request_id = headers.get("x-request-id")
        logger.info(
            "[tts-openai] request_ok model=%s voice=%s chars=%d bytes=%d ms=%.1f request_id=%s",
            self.model,
            req_voice,
            input_len,
            len(audio),
            round(elapsed_ms, 1),
            request_id,
        )
        return audio
