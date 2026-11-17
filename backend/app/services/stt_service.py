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

    async def detect_language(
        self, audio_bytes: bytes, filename: str = "audio.wav", mime_type: str = "audio/wav"
    ) -> tuple[str | None, float | None]:
        """Return (ISO 639-1 code, confidence) detected by Whisper for the audio.

        Uses the webservice's POST /detect-language. Detection only chooses which
        explicit language the following transcription uses; it never transcribes.
        """
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url}/detect-language",
                files={"audio_file": (filename, audio_bytes, mime_type)},
                timeout=30.0,
            )
            response.raise_for_status()
            data = response.json()
        code = data.get("language_code") or data.get("detected_language")
        confidence = data.get("confidence")
        logger.info("[stt] Detected language=%r confidence=%r", code, confidence)
        return (
            code.strip().lower() if isinstance(code, str) else None,
            float(confidence) if isinstance(confidence, int | float) else None,
        )

    async def transcribe(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        mime_type: str = "audio/wav",
        *,
        language: str,
        prompt: str | None = None,
        vad_filter: bool = False,
    ) -> str:
        """Send audio to Whisper ASR and return the transcribed text.

        ``prompt`` (initial_prompt) biases spelling and script, e.g. a short
        native-script sentence keeps Telugu output in Telugu script instead of
        romanized text. ``vad_filter`` drops silence that otherwise causes
        hallucinated words.

        Compatible with onerahmet/openai-whisper-asr-webservice which exposes
        POST /asr?output=json&language=<code> (not the OpenAI /v1/audio/transcriptions path).
        """
        async with httpx.AsyncClient() as client:
            logger.debug(
                "[stt] POST /asr — %d bytes, filename=%s lang=%s",
                len(audio_bytes),
                filename,
                language,
            )
            params: dict[str, str] = {"output": "json", "language": language, "task": "transcribe"}
            if prompt:
                params["initial_prompt"] = prompt
            if vad_filter:
                params["vad_filter"] = "true"
            response = await client.post(
                f"{self.base_url}/asr",
                params=params,
                files={"audio_file": (filename, audio_bytes, mime_type)},
                timeout=60.0,
            )
            logger.debug("[stt] Response status: %s", response.status_code)
            response.raise_for_status()
            data = response.json()
            # Response: {"text": "...", ...}
            text = data.get("text", "").strip()
            logger.info("[stt] Transcribed: %r", text)
            return text


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
        language: str,
        prompt: str | None = None,
        vad_filter: bool = False,
    ) -> str:
        """Transcribe audio using OpenAI Whisper API (``vad_filter`` is not applicable)."""
        _ = vad_filter
        audio_file = (filename, io.BytesIO(audio_bytes), mime_type)
        extra = {"prompt": prompt} if prompt else {}
        response = await self._client.audio.transcriptions.create(
            model=self.model,
            file=audio_file,
            language=language,
            timeout=60.0,
            **extra,
        )
        text = response.text.strip()
        logger.info(
            "[stt-openai] Transcribed model=%s lang=%s: %r",
            self.model,
            language,
            text,
        )
        return text
