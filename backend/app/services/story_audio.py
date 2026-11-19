"""Prepared audio for story-based conversation.

Story paragraphs are known in advance, so their speech (the English paragraph, and for
bilingual learners the native-language introduction and translation) is synthesized ahead
of time and cached on disk, sentence by sentence. Playback then sends ready audio without
gaps, and every later learner gets it instantly.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

from app.core.app_logger import get_logger
from app.core.config import settings
from app.services.story_service import get_paragraph_questions, get_paragraph_translation

logger = get_logger(__name__)

STORY_AUDIO_DIR = Path(settings.AUDIO_STORAGE_PATH) / "stories"

# Spoken before the native-language reading of a paragraph ("Now let's see it in ...").
STORY_NATIVE_INTRO: dict[str, str] = {
    "te": "ఇప్పుడు మనం దీన్ని తెలుగులో చూద్దాం.",
    "hi": "अब हम इसे हिंदी में देखते हैं।",
    "kn": "ಈಗ ನಾವು ಇದನ್ನು ಕನ್ನಡದಲ್ಲಿ ನೋಡೋಣ.",
    "ta": "இப்போது இதைத் தமிழில் பார்ப்போம்.",
    "ml": "ഇനി നമുക്ക് ഇത് മലയാളത്തിൽ നോക്കാം.",
    "or": "ଏବେ ଆମେ ଏହାକୁ ଓଡ଼ିଆରେ ଦେଖିବା।",
}

# Story linking lines said in the learner's native language before the English line.
STORY_NATIVE_LINES: dict[str, dict[str, str]] = {
    "continue": {
        "te": "సరే, ఇప్పుడు కథలో తర్వాతి పేరాకు వెళ్దాం.",
        "hi": "ठीक है, अब कहानी के अगले पैराग्राफ पर चलते हैं।",
        "kn": "ಸರಿ, ಈಗ ಕಥೆಯ ಮುಂದಿನ ಪ್ಯಾರಾಗೆ ಹೋಗೋಣ.",
        "ta": "சரி, இப்போது கதையின் அடுத்த பத்திக்குச் செல்வோம்.",
        "ml": "ശരി, ഇനി കഥയുടെ അടുത്ത ഖണ്ഡികയിലേക്ക് പോകാം.",
        "or": "ଠିକ ଅଛି, ଏବେ ଗଳ୍ପର ପରବର୍ତ୍ତୀ ଅନୁଚ୍ଛେଦକୁ ଯିବା।",
    },
    "finished": {
        "te": "చాలా బాగుంది! మనం కథ మొత్తం పూర్తి చేశాం. ఇప్పుడు మీరు కథ టెస్ట్ రాయవచ్చు.",
        "hi": "बहुत बढ़िया! हमने पूरी कहानी खत्म कर ली। अब आप कहानी का टेस्ट दे सकते हैं।",
        "kn": "ತುಂಬಾ ಚೆನ್ನಾಗಿದೆ! ನಾವು ಇಡೀ ಕಥೆಯನ್ನು ಮುಗಿಸಿದೆವು. ಈಗ ನೀವು ಕಥೆಯ ಪರೀಕ್ಷೆ ಬರೆಯಬಹುದು.",
        "ta": (
            "மிகவும் நன்று! நாம் முழு கதையையும் முடித்துவிட்டோம். "
            "இப்போது நீங்கள் கதைத் தேர்வை எழுதலாம்."
        ),
        "ml": "വളരെ നന്നായി! നമ്മൾ കഥ മുഴുവൻ പൂർത്തിയാക്കി. ഇനി നിങ്ങൾക്ക് കഥയുടെ ടെസ്റ്റ് എഴുതാം.",
        "or": "ବହୁତ ଭଲ! ଆମେ ପୂରା ଗଳ୍ପ ଶେଷ କଲୁ। ଏବେ ଆପଣ ଗଳ୍ପ ପରୀକ୍ଷା ଦେଇପାରିବେ।",
    },
}

_inflight: dict[str, asyncio.Task] = {}
_prepare_tasks: dict[tuple, asyncio.Task] = {}


def speech_sentences(text: str) -> list[str]:
    """The sentence chunks used for story speech (same rules as the voice tutor)."""
    from app.services.conversation_pipeline import ConversationPipeline  # noqa: PLC0415

    return ConversationPipeline._split_tts_sentences(text)


def _cache_file(native: bool, language: str, voice: str, sentence: str) -> Path:
    identity = json.dumps(["native" if native else "main", language, voice, sentence])
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return STORY_AUDIO_DIR / digest[:2] / f"{digest}.audio"


async def _synthesize(
    sentence: str, *, native: bool, language: str, voice: str, tts: object, native_tts: object
) -> bytes:
    if native:
        return await native_tts.synthesize(sentence, language=language)  # type: ignore[union-attr]
    return await tts.synthesize(sentence, voice or None, language)  # type: ignore[union-attr]


async def cached_audio(
    sentence: str,
    *,
    native: bool,
    language: str,
    voice: str = "",
    tts: object,
    native_tts: object | None,
) -> bytes:
    """Return audio for one sentence from the disk cache, synthesizing it once if needed.

    Concurrent requests for the same sentence share one synthesis. Returns b"" on failure.
    """
    if native and native_tts is None:
        return b""
    path = _cache_file(native, language, voice, sentence)
    key = str(path)
    task = _inflight.get(key)
    if task is None or task.done():
        task = asyncio.create_task(
            _load_or_synthesize(path, sentence, native, language, voice, tts, native_tts)
        )
        _inflight[key] = task
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("[story-audio] Speech failed: %s", exc)
        return b""
    finally:
        if task.done():
            _inflight.pop(key, None)


async def _load_or_synthesize(
    path: Path,
    sentence: str,
    native: bool,
    language: str,
    voice: str,
    tts: object,
    native_tts: object | None,
) -> bytes:
    try:
        return await asyncio.to_thread(path.read_bytes)
    except OSError:
        pass
    audio = await _synthesize(
        sentence, native=native, language=language, voice=voice, tts=tts, native_tts=native_tts
    )
    if audio:
        try:
            await asyncio.to_thread(_write, path, audio)
        except OSError as exc:
            logger.warning("[story-audio] Could not cache audio: %s", exc)
    return audio


def _write(path: Path, audio: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(audio)
    tmp.replace(path)


async def prepare_paragraph(
    *,
    paragraph_id: int,
    text: str,
    names: list[str],
    target_language: str,
    native_code: str,
    native_name: str,
    voice: str,
    llm: object,
    tts: object,
    native_tts: object | None,
    translate: bool,
) -> None:
    """Prepare everything spoken for one paragraph: English audio, translation, native audio.

    The English audio and the translation run in parallel; native audio follows the
    translation. Everything is cached, so the voice session only has to send it.
    """

    async def english() -> None:
        for sentence in speech_sentences(text):
            await cached_audio(
                sentence, native=False, language=target_language, voice=voice,
                tts=tts, native_tts=native_tts,
            )

    async def native() -> None:
        translation = await get_paragraph_translation(
            paragraph_id, native_code, native_name, llm, names
        )
        if not translation or native_tts is None:
            return
        spoken = " ".join(p for p in (STORY_NATIVE_INTRO.get(native_code), translation) if p)
        for sentence in speech_sentences(spoken):
            await cached_audio(
                sentence, native=True, language=native_code,
                tts=tts, native_tts=native_tts,
            )

    async def questions() -> None:
        await get_paragraph_questions(paragraph_id, llm)

    jobs = [english(), questions()] + ([native()] if translate else [])
    results = await asyncio.gather(*jobs, return_exceptions=True)
    for result in results:
        if isinstance(result, Exception):
            logger.warning("[story-audio] Preparing paragraph %s failed: %s", paragraph_id, result)


def schedule_prepare(**kwargs: object) -> asyncio.Task:
    """Start (or reuse) background preparation of one paragraph for one voice/language."""
    key = (
        kwargs["paragraph_id"],
        kwargs["native_code"] if kwargs.get("translate") else "",
        kwargs.get("voice", ""),
    )
    task = _prepare_tasks.get(key)
    if task is None or task.done():
        task = asyncio.create_task(prepare_paragraph(**kwargs))  # type: ignore[arg-type]
        _prepare_tasks[key] = task
        task.add_done_callback(lambda _t, k=key: _prepare_tasks.pop(k, None))
    return task


def schedule_prepare_story(paragraphs: list[dict]) -> asyncio.Task:
    """Prepare several paragraphs one after another (the current one first).

    Each item holds the keyword arguments of prepare_paragraph. Running them in order keeps
    the GPU voice free for the paragraph that is needed soonest.
    """

    async def run() -> None:
        for item in paragraphs:
            await schedule_prepare(**item)

    return asyncio.create_task(run())

