import hashlib
import json
import time

import httpx
import openai

from app.core.app_logger import get_logger
from app.services.prompts.speech import build_speech_instructions

logger = get_logger(__name__)


# Female British voice used for en-GB when the configured voice is American.
BRITISH_KOKORO_VOICE = "bf_emma"


def _speech_timeout(text: str, base: float) -> float:
    """Local voices run on CPU: long listening texts need more than a reply does."""
    return min(900.0, base + len(text) * 0.2)


class KokoroTTSService:
    def __init__(
        self, base_url: str, voice: str, multilingual: NativeTTSService | None = None
    ) -> None:
        self.base_url = base_url
        self.voice = voice
        # Kokoro's configured voice only speaks English; other target languages
        # (German, Russian, Japanese, ...) are routed to a native voice for that
        # language when a multilingual voice service is configured.
        self.multilingual = multilingual

    async def health(self) -> None:
        """Raise if Kokoro is unreachable."""
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{self.base_url}/v1/models", timeout=5.0)
            r.raise_for_status()

    async def synthesize(
        self, text: str, voice: str | None = None, language: str | None = None
    ) -> bytes:
        """Return MP3 audio for ``text`` spoken in ``language``.

        English uses Kokoro with the configured voice (British voice for en-GB
        unless one is chosen). Other languages use the multilingual service when
        available, falling back to Kokoro if it fails.
        """
        base = (language or "").split("-")[0].lower()
        if self.multilingual is not None and base and base != "en":
            try:
                return await self.multilingual.synthesize(text, language or base)
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                # Only when the voice service is down: an English voice reading
                # another language is poor, and after a timeout it would be slow too.
                logger.warning(
                    "multilingual_tts_failed_falling_back_to_kokoro",
                    language=language,
                    error=str(exc),
                )
        if not voice and (language or "").lower() == "en-gb" and self.voice.startswith("a"):
            voice = BRITISH_KOKORO_VOICE
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url}/v1/audio/speech",
                json={
                    "model": "kokoro",
                    "input": text,
                    "voice": voice or self.voice,
                    "response_format": "mp3",
                },
                timeout=_speech_timeout(text, 30.0),
            )
            response.raise_for_status()
            return response.content


class NativeTTSService:
    """Local multilingual voice (MMS-TTS server) for the learner's base language.

    Kokoro voices only cover a few languages, so base-language help (e.g. Telugu)
    is spoken by this service instead of being skipped. Returns MP3 like Kokoro.
    """

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    async def health(self) -> None:
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{self.base_url}/", timeout=5.0)
            r.raise_for_status()

    async def synthesize(self, text: str, language: str) -> bytes:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url}/v1/audio/speech",
                json={"input": text, "language": language},
                timeout=_speech_timeout(text, 60.0),
            )
            response.raise_for_status()
            return response.content


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
