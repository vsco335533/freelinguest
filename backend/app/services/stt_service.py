import io

import httpx
import openai

from app.core.app_logger import get_logger

logger = get_logger(__name__)


class WhisperSTTService:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    async def health(self) -> None:
        """Raise if Whisper ASR is unreachable."""
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{self.base_url}/", timeout=5.0)
            r.raise_for_status()

    async def transcribe(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        mime_type: str = "audio/wav",
        *,
        language: str | None,
        allowed_languages: tuple[str, ...] | None = None,
    ) -> str:
        """Send audio to Whisper ASR and return the transcribed text.

        Compatible with onerahmet/openai-whisper-asr-webservice which exposes
        POST /asr?output=json&language=<code> (not the OpenAI /v1/audio/transcriptions path).

        ``language=None`` lets Whisper auto-detect. Auto-detection is unreliable
        for short utterances in low-resource languages (Telugu is often detected
        as Spanish), so when ``allowed_languages`` is given and the detected
        language is not one of them, the audio is transcribed again forced to
        ``allowed_languages[0]`` (the learner's base language). The allowed list is also sent
        to the server as ``languages`` so a server that supports it detects among
        them only and transcribes once.
        """
        async with httpx.AsyncClient() as client:
            data = await self._post(
                client,
                audio_bytes,
                filename,
                mime_type,
                language,
                allowed_languages if language is None else None,
            )
            detected = (data.get("language") or "").lower()
            if language is None and allowed_languages and detected not in allowed_languages:
                logger.info(
                    "[stt] Detected %r not in %s; re-transcribing as %r",
                    detected,
                    allowed_languages,
                    allowed_languages[0],
                )
                data = await self._post(
                    client, audio_bytes, filename, mime_type, allowed_languages[0]
                )
            text = data.get("text", "").strip()
            logger.info("[stt] Transcribed (%s): %r", data.get("language"), text)
            return text

    async def _post(
        self,
        client: httpx.AsyncClient,
        audio_bytes: bytes,
        filename: str,
        mime_type: str,
        language: str | None,
        allowed_languages: tuple[str, ...] | None = None,
    ) -> dict:
        logger.debug(
            "[stt] POST /asr — %d bytes, filename=%s lang=%s", len(audio_bytes), filename, language
        )
        response = await client.post(
            f"{self.base_url}/asr",
            # language=None -> omit it so Whisper auto-detects the spoken language.
            params={
                "output": "json",
                "task": "transcribe",
                **({"language": language} if language else {}),
                # Lets the local Whisper server restrict auto-detection to these
                # languages and transcribe in a single pass. Servers that ignore
                # it still work via the re-transcribe fallback in transcribe().
                **({"languages": ",".join(allowed_languages)} if allowed_languages else {}),
            },
            files={"audio_file": (filename, audio_bytes, mime_type)},
            timeout=60.0,
        )
        logger.debug("[stt] Response status: %s", response.status_code)
        response.raise_for_status()
        return response.json()


class OpenAISTTService:
    def __init__(self, api_key: str, model: str) -> None:
        self._client = openai.AsyncOpenAI(api_key=api_key)
        self.model = model

    async def health(self) -> None:
        """Raise if OpenAI STT is unreachable (lightweight models list call)."""
        await self._client.models.list()

    async def transcribe(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        mime_type: str = "audio/wav",
        *,
        language: str | None,
        allowed_languages: tuple[str, ...] | None = None,  # noqa: ARG002 - API parity
    ) -> str:
        """Transcribe audio using OpenAI Whisper API."""
        audio_file = (filename, io.BytesIO(audio_bytes), mime_type)
        response = await self._client.audio.transcriptions.create(
            model=self.model,
            file=audio_file,
            **({"language": language} if language else {}),
            timeout=60.0,
        )
        text = response.text.strip()
        logger.info(
            "[stt-openai] Transcribed model=%s lang=%s: %r",
            self.model,
            language,
            text,
        )
        return text
