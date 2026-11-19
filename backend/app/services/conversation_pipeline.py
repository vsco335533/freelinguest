from __future__ import annotations

import asyncio
import json
import time
import unicodedata
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.core.app_logger import get_logger
from app.models.user import User
from app.services.language_helpers import (
    get_iso639,
    get_language_name,
    get_native_language_code,
    get_native_language_name,
)
from app.services.learning_analytics import record_lingu_practice
from app.services.llm_adapter import (
    LLMError,
    LLMStream,
    LLMStreamReset,
    LLMTimeoutError,
    LLMToolResultEvent,
    LLMUnavailableError,
)
from app.services.memory_service import (
    build_memory_context,
    build_save_user_memory_tool,
    execute_save_user_memory,
    get_user_memories,
)
from app.services.conversation_learning import (
    LearningState,
    TutorReply,
    NATIVE_PHASE_MAX_STAGE,
    NATIVE_PHASE_SECONDS,
    is_latin_script_text,
    is_repetition_loop,
    load_learning_state,
    normalize_cefr,
    parse_assessment_json,
    parse_tutor_reply,
    save_learning_state,
    split_speech_segments,
)
from app.services.prompts.common import get_language_prompt_overlay
from app.services.story_audio import (
    STORY_NATIVE_INTRO,
    STORY_NATIVE_LINES,
    cached_audio,
    schedule_prepare,
)
from app.services.story_service import (
    StorySession,
    get_paragraph_questions,
    get_paragraph_translation,
    save_story_session,
)
from app.services.prompts.tutor import (
    build_conversation_assessment_messages,
    build_conversation_system_prompt,
)
from app.services.quota_service import record_session_seconds
from app.utils.db import db_session

if TYPE_CHECKING:
    from fastapi import WebSocket

logger = get_logger(__name__)

STORY_CONTINUE_LINE = "Let's continue to the next paragraph."
STORY_FINISHED_LINE = "Well done! We have finished the story. Now you can take the story test."

TTS_MAX_RETRIES = 1
TTS_RETRY_DELAY_SECONDS = 0.2

WARNING_ADVANCE_SECONDS = 60  # How many seconds before timeout to send the warning


def _build_conversation_system_prompt(
    *,
    student_name: str,
    cefr_level: str,
    native_language: str,
    target_language_name: str,
    user_context: str,
    memory_context: str,
    language_prompt_overlay: str = "",
    memory_tools_enabled: bool = True,
    lesson_practice_context: str = "",
    bilingual_mode: bool = False,
    exposure_stage: int = 1,
    target_exposure_percent: int = 10,
    learning_context: str = "",
    conversation_phase: str = "native",
    transition_now: bool = False,
    story_context: str = "",
) -> str:
    return build_conversation_system_prompt(
        student_name=student_name,
        cefr_level=cefr_level,
        native_language=native_language,
        target_language_name=target_language_name,
        user_context=user_context,
        memory_context=memory_context,
        language_prompt_overlay=language_prompt_overlay,
        memory_tools_enabled=memory_tools_enabled,
        lesson_practice_context=lesson_practice_context,
        bilingual_mode=bilingual_mode,
        exposure_stage=exposure_stage,
        target_exposure_percent=target_exposure_percent,
        learning_context=learning_context,
        conversation_phase=conversation_phase,
        transition_now=transition_now,
        story_context=story_context,
    )


def _resolve_bilingual_enabled(
    setting: str, cefr_level: str, native_language: str, target_language: str
) -> bool:
    """Adaptive bilingual tutoring needs a native language different from the learned one.

    "on" enables it at every level, "auto" for plan levels A1-B2, "off" never.
    Once enabled, the exposure stage decides how much native support a reply carries.
    """
    if setting == "off":
        return False
    if get_native_language_code(native_language) == get_iso639(target_language):
        return False
    return setting == "on" or normalize_cefr(cefr_level) in {"A1", "A2", "B1", "B2"}


# Bilingual STT: the target language is used only when detected with this confidence.
# Lower than 0.5 because learners' accented English is often detected with low confidence;
# a wrong native-language decision writes their English in native script.
TARGET_LANGUAGE_MIN_CONFIDENCE = 0.45
# No initial prompt is sent: Whisper copies prompt text into the transcript when the
# audio is unclear. The explicit recognition language already keeps the native script.
# Whisper has no Odia model. Odia speech is recognised as Bengali (the closest
# supported language: same Eastern Indo-Aryan family, parallel Unicode script) and
# the Bengali-script output is converted letter by letter to Odia script.
_STT_RECOGNITION_FALLBACKS: dict[str, str] = {"or": "bn"}
_BRAHMIC_BLOCK_START: dict[str, int] = {"bn": 0x0980, "or": 0x0B00}
_BRAHMIC_SPECIAL: dict[tuple[str, str], dict[str, str]] = {
    # Bengali khanda ta has no Odia letter; Odia writes it as ta + virama.
    ("bn", "or"): {"ৎ": "ତ୍", "য়": "ୟ"},
}


def _convert_brahmic_script(text: str, source: str, target: str) -> str:
    """Map letters between ISCII-aligned Indic Unicode blocks (e.g. Bengali to Odia)."""
    if source == target or source not in _BRAHMIC_BLOCK_START:
        return text
    for old, new in _BRAHMIC_SPECIAL.get((source, target), {}).items():
        text = text.replace(old, new)
    src, dst = _BRAHMIC_BLOCK_START[source], _BRAHMIC_BLOCK_START[target]
    out: list[str] = []
    for char in text:
        offset = ord(char) - src
        if 0 <= offset < 0x80:
            mapped = chr(dst + offset)
            if unicodedata.category(mapped) != "Cn":
                out.append(mapped)
                continue
        out.append(char)
    return "".join(out)


def _is_non_latin_language(iso_code: str) -> bool:
    return iso_code in {"te", "hi", "ta", "ml", "kn", "or", "ru", "ja", "ko", "zh"}


class ConversationPipeline:
    """
    Orchestrates STT → LLM → TTS streaming with barge-in and session timeout.
    """

    def __init__(
        self,
        llm: object,
        tts: object,
        stt: object,
        cefr_level: str = "B1",
        native_language: str = "es",
        target_language: str = "en-GB",
        student_name: str = "Student",
        max_duration: int = 1800,
        inactivity_timeout: int = 180,
        initial_context: list[dict] | None = None,
        user_id: int | None = None,
        conversation_id: int | None = None,
        bio: str | None = None,
        learning_goals: str | None = None,
        memories: list | None = None,
        voice: str = "",
        study_plan_id: int | None = None,
        lesson_practice_context: str = "",
        user_agent: str = "",
        # Callers pass the user's persisted setting (DB default "auto").
        bilingual_mode_setting: str = "off",
        native_tts: object | None = None,
        story: StorySession | None = None,
    ) -> None:
        self.llm = llm
        self.tts = tts
        self.stt = stt
        self._voice = voice
        self._target_iso = get_iso639(target_language)
        self._stt_language = self._target_iso
        self._target_language = target_language
        self._native_language_code = get_native_language_code(native_language)
        self._native_language_name = get_native_language_name(native_language)
        self._bilingual_mode_setting = bilingual_mode_setting
        self._bilingual_enabled = _resolve_bilingual_enabled(
            bilingual_mode_setting, cefr_level, native_language, target_language
        )
        # Adaptive tutoring state; replaced by the persisted per-plan state in run().
        self._plan_cefr = normalize_cefr(cefr_level)
        self._learning = LearningState.fresh(self._plan_cefr)
        self._learning_lock = asyncio.Lock()
        self._assessment_task: asyncio.Task | None = None
        self._pending_progress_note: tuple[str, str] | None = None
        self._last_turn_end = time.monotonic()
        # Native voice for native-script narration (None: speak Latin-script text only).
        self._native_tts = (
            native_tts
            if native_tts is not None
            and self._bilingual_enabled
            and getattr(native_tts, "supports", lambda _c: False)(self._native_language_code)
            else None
        )
        # Per-session conversation phase: native teaching first, then target practice.
        self._session_active_seconds = 0.0
        self._phase_switched = False
        self._transition_pending = False
        self._user_id = user_id
        self._conversation_id = conversation_id
        self._study_plan_id = study_plan_id
        self._user_agent = user_agent
        self._transcript_lock = asyncio.Lock()
        # Build user context section
        _ctx_parts: list[str] = []
        if learning_goals:
            try:
                import json as _json  # noqa: PLC0415

                goals = _json.loads(learning_goals)
                if isinstance(goals, list) and goals:
                    _ctx_parts.append(f"Learning goals: {', '.join(goals)}")
            except (ValueError, TypeError):
                pass
        if bio and bio.strip():
            _ctx_parts.append(f"About the student: {bio.strip()}")
        user_context = (
            ("\nStudent context:\n" + "\n".join(f"- {p}" for p in _ctx_parts) + "\n")
            if _ctx_parts
            else ""
        )
        self._memory_context = build_memory_context(memories or [])
        target_language_name = get_language_name(target_language)
        language_prompt_overlay = get_language_prompt_overlay(target_language)
        self._prompt_args = {
            "student_name": student_name,
            "cefr_level": cefr_level,
            "native_language": self._native_language_name,
            "target_language_name": target_language_name,
            "user_context": user_context,
            "language_prompt_overlay": language_prompt_overlay,
            "lesson_practice_context": lesson_practice_context,
            "story_context": story.prompt_context() if story else "",
        }
        # Story-based conversation: one paragraph at a time, PARAGRAPH_SECONDS each.
        self._story = story
        self._story_mark = time.monotonic()
        self._story_finished = False
        self._memory_tools_available = True
        self.system_prompt = self._build_prompt(memory_tools_enabled=True)
        self.max_duration = max_duration
        self.inactivity_timeout = inactivity_timeout
        self._redis: object | None = None  # injected after construction
        self._recorded = False
        self._freemium_voice = False
        self._memory_tools_available = True

        self.current_task: asyncio.Task | None = None
        # Pre-populate history from optional chat context
        if initial_context:
            self.history: list[dict] = [
                {"role": m["role"], "content": m["content"]}
                for m in initial_context
                if isinstance(m, dict)
                and m.get("role") in ("user", "assistant")
                and isinstance(m.get("content"), str)
                and m["content"].strip()
            ][-10:]
        else:
            self.history = []
        self._session_start = time.monotonic()
        self._last_activity = time.monotonic()
        self._timer_tasks: list[asyncio.Task] = []
        self._pending_saves: list[asyncio.Task] = []
        self._inactivity_warning_sent = False
        self._send_lock = asyncio.Lock()
        self._turn_id = 0
        self._client_close_reason: str | None = None

    @staticmethod
    def _fmt_exc(exc: Exception) -> str:
        return f"{type(exc).__name__}: {exc}"

    @staticmethod
    def _task_state(task: asyncio.Task | None) -> str:
        if task is None:
            return "none"
        if task.cancelled():
            return "cancelled"
        if task.done():
            if task.exception() is not None:
                return "done:error"
            return "done"
        return "running"

    async def _send_json(self, ws: WebSocket, data: dict) -> None:
        async with self._send_lock:
            await ws.send_json(data)

    def _next_turn_id(self) -> int:
        self._turn_id += 1
        return self._turn_id

    async def _send_status(self, ws: WebSocket, turn_id: int, value: str) -> None:
        await self._send_json(ws, {"type": "status", "value": value, "turn_id": turn_id})

    async def _send_memory_updated(self, ws: WebSocket, turn_id: int) -> None:
        send_task = asyncio.create_task(
            self._send_json(ws, {"type": "memory_updated", "turn_id": turn_id})
        )
        try:
            await asyncio.shield(send_task)
        except asyncio.CancelledError:
            try:
                await send_task
            except Exception as exc:
                logger.debug(
                    "[pipeline] Memory update notification failed during cancellation: %s",
                    self._fmt_exc(exc),
                )
            raise

    @staticmethod
    def _extract_speech_text(raw_text: str) -> str:
        return ConversationPipeline._clean_sentence(raw_text).strip()

    @staticmethod
    def _stream_text(chunk: object) -> str:
        if isinstance(chunk, str):
            return chunk
        choices = getattr(chunk, "choices", None)
        if not choices:
            return ""
        return getattr(getattr(choices[0], "delta", None), "content", None) or ""

    def _build_prompt(self, *, memory_tools_enabled: bool) -> str:
        args = dict(self._prompt_args)
        learning_context = ""
        if self._bilingual_enabled:
            # The adaptive tutor talks at its own evolving estimate, not the plan level.
            args["cefr_level"] = self._learning.estimated_cefr
            learning_context = self._learning.prompt_context()
        return _build_conversation_system_prompt(
            **args,
            memory_context=self._memory_context,
            memory_tools_enabled=memory_tools_enabled,
            bilingual_mode=self._bilingual_enabled,
            exposure_stage=self._learning.exposure_stage,
            target_exposure_percent=self._learning.target_percent,
            learning_context=learning_context,
            conversation_phase=self._conversation_phase(),
            transition_now=self._transition_pending,
        )

    async def _refresh_memory_prompt(self) -> None:
        self.system_prompt = self._build_prompt(memory_tools_enabled=self._memory_tools_available)
        if self._user_id is None:
            return
        try:
            async with db_session() as db:
                memories = await get_user_memories(db, self._user_id)
                user = await db.get(User, self._user_id)
                if user is not None:
                    self._native_language_code = get_native_language_code(user.native_language)
                    self._native_language_name = get_native_language_name(user.native_language)
                    self._prompt_args["native_language"] = self._native_language_name
            self._memory_context = build_memory_context(memories)
            self.system_prompt = self._build_prompt(
                memory_tools_enabled=self._memory_tools_available
            )
        except Exception:
            logger.exception("[pipeline] Failed to refresh global memory context")

    # --- Adaptive bilingual tutoring ------------------------------------------

    async def _stt_text(self, audio_bytes: bytes, language: str, **options: object) -> str:
        text = await self.stt.transcribe(
            audio_bytes, "audio.wav", "audio/wav", language=language, **options
        )
        return (text or "").strip()

    async def _detect_spoken_language(self, audio_bytes: bytes) -> tuple[str, float | None]:
        """Pick the explicit recognition language for one bilingual utterance.

        The native language is primary: the target language is chosen only when the
        STT service confidently detects it. Any other or uncertain detection (Whisper
        often labels Telugu as Kannada, Tamil or Hindi) stays native.
        """
        detect = getattr(self.stt, "detect_language", None)
        if detect is None:
            return self._native_language_code, None
        try:
            code, confidence = await detect(audio_bytes, "audio.wav", "audio/wav")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "[pipeline] Language detection failed; using %s: %s",
                self._native_language_code,
                self._fmt_exc(exc),
            )
            return self._native_language_code, None
        if code == self._target_iso and (
            confidence is None or confidence >= TARGET_LANGUAGE_MIN_CONFIDENCE
        ):
            return self._target_iso, confidence
        return self._native_language_code, confidence

    async def _transcribe_user_input(self, audio_bytes: bytes) -> tuple[str, str]:
        """Return (transcript, spoken_language_iso) for one finished utterance.

        Classic mode transcribes once in the target language. Bilingual mode detects
        the spoken language (native first), then transcribes ONCE in that explicit
        language in transcribe mode. The transcript is the learner's original words:
        it is never translated, romanized or rewritten afterwards.
        """
        if not self._bilingual_enabled:
            return await self._stt_text(audio_bytes, self._stt_language), self._target_iso
        language, confidence = await self._detect_spoken_language(audio_bytes)
        recognition = _STT_RECOGNITION_FALLBACKS.get(language, language)
        transcript = await self._stt_text(audio_bytes, recognition, vad_filter=True)
        transcript = _convert_brahmic_script(transcript, recognition, language)
        if (
            language == self._native_language_code
            and not self._native_is_latin()
            and transcript
            and is_latin_script_text(transcript)
        ):
            logger.warning(
                "[pipeline] %s transcript came back in Latin script: %r",
                language,
                transcript,
            )
        logger.info(
            "[pipeline] Spoken language=%s (detect confidence=%s) transcript=%r",
            language,
            confidence,
            transcript,
        )
        return transcript, language

    def _native_is_latin(self) -> bool:
        return not _is_non_latin_language(self._native_language_code)

    @staticmethod
    async def _close_llm_stream(llm_stream: object) -> None:
        close = getattr(llm_stream, "aclose", None)
        if close is None:
            return
        try:
            await close()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("[pipeline] Could not close the LLM stream: %s", exc)

    def _parse_reply(self, text: str) -> TutorReply:
        return parse_tutor_reply(text)

    def _conversation_phase(self) -> str:
        """Native teaching for the first active minutes, then target-language practice.

        Learners already past the early exposure stages start in practice directly.
        """
        if self._learning.exposure_stage > NATIVE_PHASE_MAX_STAGE or self._phase_switched:
            return "practice"
        return "native"

    def _advance_session_time(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_turn_end
        self._last_turn_end = now
        self._learning.add_active_seconds(elapsed)
        self._session_active_seconds += max(0.0, min(elapsed, 120.0))
        if (
            not self._phase_switched
            and self._learning.exposure_stage <= NATIVE_PHASE_MAX_STAGE
            and self._session_active_seconds >= NATIVE_PHASE_SECONDS
        ):
            self._phase_switched = True
            self._transition_pending = True
            logger.info(
                "[pipeline] Native phase complete after %.0fs; next reply invites %s answers",
                self._session_active_seconds,
                self._target_iso,
            )

    def _user_transcript_payload(self, turn_id: int, transcript: str, spoken_iso: str) -> dict:
        """The learner's original transcript, exactly as recognised."""
        said_native = spoken_iso == self._native_language_code
        return {
            "type": "transcript",
            "role": "user",
            "text": transcript,
            "final": True,
            "turn_id": turn_id,
            "text_native": transcript if said_native else "",
            "text_target": "" if said_native else transcript,
            "native_language": self._native_language_code,
            "target_language": self._target_iso,
        }

    def _assistant_bilingual_payload(self, turn_id: int, reply: TutorReply) -> tuple[str, dict]:
        """Return (speech text, transcript payload) for one natural mixed-language reply."""
        text = reply.spoken
        if self._pending_progress_note:
            note_native, note_target = self._pending_progress_note
            self._pending_progress_note = None
            note = note_native if self._conversation_phase() == "native" else note_target
            text = " ".join(p for p in (note or note_native or note_target, text) if p)
        payload = {
            "type": "transcript",
            "role": "assistant",
            "text": text,
            "final": True,
            "turn_id": turn_id,
            "text_native": text,
            "native_language": self._native_language_code,
            "target_language": self._target_iso,
        }
        return text, payload

    def _update_learning(self, reply: TutorReply, heard: str, heard_iso: str) -> None:
        # The recognised spoken language decides whether this was a target-language
        # attempt; the model's CHECK line only judges correctness.
        attempted = heard_iso == self._target_iso
        correct = bool(reply.correct) if attempted else False
        if attempted is not None:
            delta = self._learning.record_performance(attempted, bool(correct))
            if delta:
                logger.info(
                    "[pipeline] Exposure stage %s -> stage=%s (%s%% target) user=%s",
                    "advanced" if delta > 0 else "eased",
                    self._learning.exposure_stage,
                    self._learning.target_percent,
                    self._user_id,
                )
        self._learning.add_vocabulary(reply.vocabulary)
        self._learning.add_mistake(reply.mistake)
        self._learning.add_encouragement(reply.encourage)
        self._learning.add_utterance(heard, heard_iso)
        self._advance_session_time()

    async def _load_learning_state(self) -> None:
        if not self._bilingual_enabled or self._study_plan_id is None:
            return
        try:
            async with db_session() as db:
                self._learning = await load_learning_state(
                    db, self._study_plan_id, self._plan_cefr
                )
            logger.info(
                "[pipeline] Learning state loaded: plan=%s cefr=%s stage=%s",
                self._study_plan_id,
                self._learning.estimated_cefr,
                self._learning.exposure_stage,
            )
        except Exception:
            logger.exception("[pipeline] Failed to load learning state; using defaults")
        self.system_prompt = self._build_prompt(memory_tools_enabled=self._memory_tools_available)

    async def _save_learning_state(self) -> None:
        if (
            not self._bilingual_enabled
            or self._study_plan_id is None
            or self._user_id is None
        ):
            return
        try:
            async with self._learning_lock, db_session() as db:
                await save_learning_state(db, self._user_id, self._study_plan_id, self._learning)
        except Exception as exc:
            logger.warning("[pipeline] Failed to save learning state: %s", self._fmt_exc(exc))

    def _maybe_start_assessment(self) -> None:
        if not self._bilingual_enabled or not self._learning.assessment_due():
            return
        if self._assessment_task is not None and not self._assessment_task.done():
            return
        self._assessment_task = asyncio.create_task(self._run_assessment())

    async def _run_assessment(self) -> None:
        """Periodic (every 15 active minutes) proficiency check, off the turn path."""
        messages = build_conversation_assessment_messages(
            native_language=self._native_language_name,
            target_language_name=str(self._prompt_args["target_language_name"]),
            current_cefr=self._learning.estimated_cefr,
            plan_cefr=self._plan_cefr,
            utterances=self._learning.recent_utterances,
            known_mistakes=self._learning.common_mistakes,
        )
        try:
            raw = await self.llm.chat(messages, stream=False)
            result = parse_assessment_json(raw if isinstance(raw, str) else "")
            if result is None:
                raise ValueError("assessment reply contained no JSON object")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("[pipeline] Conversation assessment failed: %s", self._fmt_exc(exc))
            self._learning.defer_assessment()
            return
        outcome = self._learning.apply_assessment(result, self._plan_cefr)
        logger.info(
            "[pipeline] Conversation assessment: user=%s plan=%s cefr %s -> %s suggest_test=%s",
            self._user_id,
            self._study_plan_id,
            outcome.previous_cefr,
            outcome.estimated_cefr,
            outcome.suggest_level_test,
        )
        if outcome.message_native or outcome.message_target:
            self._pending_progress_note = (outcome.message_native, outcome.message_target)
        self.system_prompt = self._build_prompt(memory_tools_enabled=self._memory_tools_available)
        await self._save_learning_state()

    async def _safe_send_bytes(self, ws: WebSocket, data: bytes) -> bool:
        try:
            async with self._send_lock:
                await ws.send_bytes(data)
            return True
        except RuntimeError as exc:
            logger.debug("[pipeline] Socket closed while sending audio: %s", exc)
            return False
        except Exception as exc:
            logger.debug("[pipeline] Audio send failed: %s", self._fmt_exc(exc))
            return False

    async def _close_ws(self, ws: WebSocket, code: int = 1000) -> None:
        logger.debug("[pipeline] Closing websocket with code=%s", code)
        async with self._send_lock:
            await ws.close(code=code)

    async def _synthesize_chunk(self, text: str, *, native: bool = False) -> bytes:
        attempts = TTS_MAX_RETRIES + 1
        trace_id = uuid.uuid4().hex[:10]
        logger.info(
            "[pipeline] TTS request scheduling — trace=%s len=%d attempts=%d",
            trace_id,
            len(text),
            attempts,
        )
        for attempt in range(1, attempts + 1):
            try:
                logger.debug(
                    "[pipeline] TTS request start: len=%d chars, attempt=%d/%d",
                    len(text),
                    attempt,
                    attempts,
                )
                if native and self._native_tts is not None:
                    audio = await self._native_tts.synthesize(
                        text, language=self._native_language_code
                    )
                else:
                    audio = await self.tts.synthesize(
                        text, self._voice or None, self._target_language
                    )
                if not audio:
                    raise RuntimeError("TTS returned empty audio payload")
                return audio
            except TimeoutError:
                if attempt >= attempts:
                    logger.warning(
                        "[pipeline] TTS request timed out (%d/%d attempts)",
                        attempt,
                        attempts,
                    )
                    raise
                logger.warning(
                    "[pipeline] TTS request timed out (%d/%d); retrying",
                    attempt,
                    attempts,
                )
                await asyncio.sleep(TTS_RETRY_DELAY_SECONDS * attempt)
            except asyncio.CancelledError:
                logger.warning(
                    "[pipeline] TTS request cancelled: trace=%s len=%d attempt=%d",
                    trace_id,
                    len(text),
                    attempt,
                )
                raise
            except GeneratorExit:
                logger.warning(
                    "[pipeline] TTS request interrupted by GeneratorExit: trace=%s len=%d attempt=%d",
                    trace_id,
                    len(text),
                    attempt,
                )
                raise
            except Exception as exc:
                if attempt >= attempts:
                    raise
                logger.warning(
                    "[pipeline] TTS request failed (%d/%d): %s",
                    attempt,
                    attempts,
                    exc,
                )
                await asyncio.sleep(TTS_RETRY_DELAY_SECONDS * attempt)

    @staticmethod
    def _split_tts_sentences(text: str) -> list[str]:
        """Split on full stops while preserving decimals and ellipses for speech.

        The danda (।) is the full stop of Hindi and Odia replies.
        """
        chunks: list[str] = []
        start = 0
        for idx, char in enumerate(text):
            if char not in (".", "।"):
                continue
            if char == "." and (
                (idx > 0 and text[idx - 1] == ".") or (idx + 1 < len(text) and text[idx + 1] == ".")
            ):
                continue
            if (
                char == "."
                and idx > 0
                and idx + 1 < len(text)
                and text[idx - 1].isdecimal()
                and text[idx + 1].isdecimal()
            ):
                continue
            sentence = text[start : idx + 1].strip()
            if sentence:
                chunks.append(sentence)
            start = idx + 1

        tail = text[start:].strip()
        if tail:
            chunks.append(tail)

        return [chunk for chunk in chunks if any(char.isalnum() for char in chunk)]

    def _speech_units(self, text: str) -> list[tuple[str, bool]]:
        """Return ordered (text, use_native_voice) units for synthesis.

        A mixed-script native voice reads every whole sentence, so one consistent voice
        carries the native narration and the embedded target-language phrases.
        Otherwise mixed replies are split per script: native runs go to the native voice
        when configured (or are shown but not spoken), and Latin-script runs (the
        target-language phrases) go to the main TTS provider.
        """
        units: list[tuple[str, bool]] = []
        if self._native_tts is not None and getattr(self._native_tts, "mixed_script", False):
            return [(sentence, True) for sentence in self._split_tts_sentences(text)]
        mixed = self._bilingual_enabled and not self._native_is_latin()
        for sentence in self._split_tts_sentences(text):
            if not mixed:
                units.append((sentence, False))
                continue
            for segment, latin in split_speech_segments(sentence):
                if latin:
                    units.append((segment, False))
                elif self._native_tts is not None:
                    units.append((segment, True))
        return units

    async def _synthesize_and_send_response(
        self,
        ws: WebSocket,
        *,
        text: str,
        turn_id: int,
        transcript_payload: dict,
        transcript_first: bool = False,
    ) -> tuple[int, int, bool, bool]:
        """Synthesize ordered sentence chunks and send the transcript after first audio.

        With ``transcript_first`` the text is published before any synthesis, so a slow
        voice (e.g. a GPU native-language model) never leaves the learner waiting on an
        empty reply; audio chunks follow as each sentence is ready.
        """
        chunks_sent = 0
        audio_bytes_sent = 0
        transcript_sent = False
        send_aborted = False
        if transcript_first:
            await self._send_json(ws, transcript_payload)
            transcript_sent = True

        for idx, (sentence, native) in enumerate(self._speech_units(text), start=1):
            try:
                audio = await self._synthesize_chunk(sentence, native=native)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "[pipeline] TTS sentence failed after retry: turn_id=%s sentence=%s error=%s",
                    turn_id,
                    idx,
                    self._fmt_exc(exc),
                )
                continue

            send_ok = await self._safe_send_bytes(ws, audio)
            if not send_ok:
                logger.warning(
                    "[pipeline] Audio send failed and remaining chunks are being aborted: turn_id=%s",
                    turn_id,
                )
                send_aborted = True
                break

            chunks_sent += 1
            audio_bytes_sent += len(audio)

            if not transcript_sent:
                await self._send_json(ws, transcript_payload)
                transcript_sent = True

        if chunks_sent == 0 and not transcript_sent and not send_aborted:
            logger.warning(
                "[pipeline] No TTS audio produced; publishing text-only transcript: turn_id=%s",
                turn_id,
            )
            await self._send_json(ws, transcript_payload)
            transcript_sent = True

        return chunks_sent, audio_bytes_sent, transcript_sent, send_aborted

    @staticmethod
    def _clean_sentence(raw_sentence: str) -> str:
        """Normalize visible assistant text before synthesis."""
        return raw_sentence.strip()

    async def _greet(
        self, ws: WebSocket, *, trigger_text: str | None = None, turn_id: int | None = None
    ) -> None:
        """Generate and stream an opening greeting (or a story question) from the assistant."""
        if turn_id is None:
            turn_id = self._next_turn_id()
        trigger = {
            "role": "user",
            "content": trigger_text
            or "[Session started. Greet the student warmly and naturally — one or two sentences max — and invite them to speak.]",
        }
        greeting_prompt = self._build_prompt(memory_tools_enabled=False)
        messages = [{"role": "system", "content": greeting_prompt}] + self.history[-20:] + [trigger]

        try:
            full_response = ""
            llm_stream = await self.llm.chat(messages, stream=True)
            async for chunk in llm_stream:
                token = self._stream_text(chunk)
                full_response += token
            clean_full_response = self._extract_speech_text(full_response)
            if not clean_full_response:
                return
            await self._send_status(ws, turn_id, "thinking")

            if self._bilingual_enabled:
                tts_text, transcript_payload = self._assistant_bilingual_payload(
                    turn_id, self._parse_reply(clean_full_response)
                )
                assistant_combined = transcript_payload["text"]
            else:
                tts_text = assistant_combined = clean_full_response
                transcript_payload = {
                    "type": "transcript",
                    "role": "assistant",
                    "text": clean_full_response,
                    "final": True,
                    "turn_id": turn_id,
                }
            (
                chunks_sent,
                _audio_bytes,
                transcript_sent,
                send_aborted,
            ) = await self._synthesize_and_send_response(
                ws,
                text=tts_text,
                turn_id=turn_id,
                transcript_payload=transcript_payload,
                transcript_first=self._bilingual_enabled,
            )
            if send_aborted or not transcript_sent:
                return

            self.history.append({"role": "assistant", "content": assistant_combined})
            self._remember_story_questions(assistant_combined)
            self._pending_saves.append(
                asyncio.create_task(self._save_message("assistant", assistant_combined))
            )
            await self._send_status(ws, turn_id, "listening")
            await self._send_json(ws, {"type": "turn_complete", "turn_id": turn_id})
        except asyncio.CancelledError:
            logger.warning(
                "[pipeline] Greeting cancelled for turn_id=%s",
                turn_id,
            )
            raise
        except Exception as exc:
            logger.error("[pipeline] Greeting failed: %s", exc)
        finally:
            self._reset_inactivity()

    # --- Story-based conversation -----------------------------------------------

    async def _speak_target(self, ws: WebSocket, text: str) -> int:
        """Speak target-language text with the main voice; returns the chunks sent."""
        return await self._speak_story(ws, text, native=False)

    async def _speak_story(self, ws: WebSocket, text: str, *, native: bool) -> int:
        """Speak story text without gaps: every sentence is ready before the first is sent.

        Story speech is normally prepared in advance (disk cache), so this is instant; if it
        is not, the learner hears one short pause before the reading instead of pauses
        between its sentences.
        """
        chunks = [
            audio
            for sentence in self._split_tts_sentences(text)
            if (audio := await self._story_sentence_audio(sentence, native=native))
        ]
        sent = 0
        for audio in chunks:
            if not await self._safe_send_bytes(ws, audio):
                break
            sent += 1
        return sent

    async def _story_sentence_audio(self, sentence: str, *, native: bool) -> bytes:
        """Prepared (cached) story speech, falling back to live synthesis."""
        audio = await cached_audio(
            sentence,
            native=native,
            language=self._native_language_code if native else self._target_language,
            voice="" if native else self._voice,
            tts=self.tts,
            native_tts=self._native_tts,
        )
        if audio:
            return audio
        try:
            return await self._synthesize_chunk(sentence, native=native)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("[pipeline] Story speech failed: %s", self._fmt_exc(exc))
            return b""

    def _schedule_story_prepare(self, index: int) -> None:
        """Prepare a paragraph's speech and translation in the background."""
        story = self._story
        if story is None or not 0 <= index < story.total or index >= len(story.paragraph_ids):
            return
        schedule_prepare(
            paragraph_id=story.paragraph_ids[index],
            text=story.paragraphs[index],
            names=story.names,
            target_language=self._target_language,
            native_code=self._native_language_code,
            native_name=self._native_language_name,
            voice=self._voice,
            llm=self.llm,
            tts=self.tts,
            native_tts=self._native_tts,
            translate=self._story_translation_wanted(),
        )

    async def _speak_native(self, ws: WebSocket, text: str) -> None:
        """Speak native-language text with the native voice, without gaps."""
        await self._speak_story(ws, text, native=True)

    def _story_translation_wanted(self) -> bool:
        """Bilingual learners also get each paragraph in their native language."""
        return self._bilingual_enabled and self._native_language_code != self._target_iso

    async def _story_translation(self, story: StorySession, index: int) -> str | None:
        if index in story.translations:
            return story.translations[index]
        if index >= len(story.paragraph_ids):
            return None
        try:
            text = await get_paragraph_translation(
                story.paragraph_ids[index],
                self._native_language_code,
                self._native_language_name,
                self.llm,
                story.names,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("[pipeline] Story translation failed: %s", self._fmt_exc(exc))
            return None
        if text:
            story.translations[index] = text
        return text

    async def _say_story_line(self, ws: WebSocket, turn_id: int, line: str, english: str) -> None:
        """Say a story linking line: in the native language first for bilingual learners."""
        native = (
            STORY_NATIVE_LINES.get(line, {}).get(self._native_language_code)
            if self._story_translation_wanted()
            else None
        )
        text = f"{native} {english}" if native else english
        await self._send_json(
            ws,
            {
                "type": "transcript",
                "role": "assistant",
                "text": text,
                "final": True,
                "turn_id": turn_id,
            },
        )
        if native and self._native_tts is not None:
            await self._speak_native(ws, text)  # one voice reads both languages
        else:
            await self._speak_target(ws, english)
        self.history.append({"role": "assistant", "content": text})

    async def _load_story_questions(self, story: StorySession, index: int) -> None:
        """Make the paragraph's prepared question ideas available to the prompt."""
        if story.questions.get(index) or index >= len(story.paragraph_ids):
            return
        try:
            questions = await asyncio.wait_for(
                get_paragraph_questions(story.paragraph_ids[index], self.llm), timeout=25
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("[pipeline] Story questions unavailable: %s", self._fmt_exc(exc))
            return
        if questions:
            story.questions[index] = questions

    def _remember_story_questions(self, reply: str) -> None:
        """Track the questions asked about this paragraph so none is asked twice."""
        story = self._story
        if story is None or not reply:
            return
        story.remember_questions(reply)
        self._prompt_args["story_context"] = story.prompt_context()

    def _story_question_trigger(self, story: StorySession) -> str:
        """Instruction for the first question about a newly read paragraph."""
        where = f"Paragraph {story.index + 1} of {story.total}"
        paragraph = story.current_text
        if self._story_translation_wanted():
            native = self._native_language_name
            target = get_language_name(self._target_language)
            return (
                f"[{where} of the story was just read aloud in {target} and then in {native}. "
                f"Write REPLY in {native}, keeping the {target} sentence and words you teach in "
                f"{target}: react warmly in {native} in one short sentence, teach ONE key "
                f"{target} sentence from this paragraph with its {native} meaning, then ask ONE "
                f"simple question in {native} about THIS paragraph only. Do not ask about "
                f'earlier paragraphs. The paragraph: "{paragraph}"]'
            )
        return (
            f"[{where} of the story was just read aloud. React warmly in one short sentence and "
            "ask ONE simple question about THIS paragraph only, not earlier ones. "
            f'The paragraph: "{paragraph}"]'
        )

    async def _present_story_paragraph(
        self, ws: WebSocket, *, turn_id: int, continuing: bool
    ) -> None:
        """Show and read the current paragraph, then ask a first question about it."""
        story = self._story
        if story is None:
            return
        # Usually already prepared (story page, previous paragraph); otherwise this starts
        # the translation and native audio while the English paragraph is being read.
        self._schedule_story_prepare(story.index)
        translation_task = (
            asyncio.create_task(self._story_translation(story, story.index))
            if self._story_translation_wanted()
            else None
        )
        try:
            await self._send_status(ws, turn_id, "thinking")
            if continuing:
                await self._say_story_line(ws, turn_id, "continue", STORY_CONTINUE_LINE)
            await self._send_json(ws, story.payload())
            await self._speak_target(ws, story.current_text)
            if translation_task is not None:
                translation = await translation_task
                if translation:
                    await self._send_json(
                        ws,
                        {
                            "type": "story_translation",
                            "story_id": story.story_id,
                            "index": story.index,
                            "language": self._native_language_code,
                            "text": translation,
                        },
                    )
                    if self._native_tts is not None:
                        intro = STORY_NATIVE_INTRO.get(self._native_language_code)
                        # Introduction and reading are sent together, with no gaps.
                        spoken = " ".join(p for p in (intro, translation) if p)
                        await self._speak_native(ws, spoken)
            await self._load_story_questions(story, story.index)
            self._prompt_args["story_context"] = story.prompt_context()
            # Prepare the next paragraph while this one is discussed.
            self._schedule_story_prepare(story.index + 1)
            self.system_prompt = self._build_prompt(
                memory_tools_enabled=self._memory_tools_available
            )
            self._story_mark = time.monotonic()
            await self._greet(
                ws,
                turn_id=turn_id,
                trigger_text=self._story_question_trigger(story),
            )
        finally:
            if translation_task is not None and not translation_task.done():
                translation_task.cancel()
            task = asyncio.current_task()
            if task is None or not task.cancelling():
                # Always close the turn so the learner's microphone reopens.
                await self._send_status(ws, turn_id, "listening")
                await self._send_json(ws, {"type": "turn_complete", "turn_id": turn_id})
            self._story_mark = time.monotonic()

    async def _advance_story_if_due(self, ws: WebSocket, turn_id: int) -> bool:
        """Count this turn's time; move to the next paragraph after PARAGRAPH_SECONDS.

        Returns True when the story took over the end of the turn.
        """
        story = self._story
        if story is None or self._story_finished:
            return False
        now = time.monotonic()
        story.add_turn_seconds(now - self._story_mark)
        self._story_mark = now
        if not story.paragraph_done():
            self._pending_saves.append(asyncio.create_task(save_story_session(story)))
            await self._send_json(ws, story.progress_payload())
            return False
        if story.is_last:
            self._story_finished = True
            await save_story_session(story, completed=True)
            await self._say_story_line(ws, turn_id, "finished", STORY_FINISHED_LINE)
            await self._send_json(
                ws, {"type": "story_complete", "story_id": story.story_id, "replay": story.replay}
            )
            await self._send_status(ws, turn_id, "listening")
            await self._send_json(ws, {"type": "turn_complete", "turn_id": turn_id})
            return True
        story.advance()
        await save_story_session(story)
        await self._present_story_paragraph(ws, turn_id=turn_id, continuing=True)
        return True

    async def run(self, ws: WebSocket) -> None:
        """Main loop: starts timeout watchers then handles incoming messages."""
        logger.info("[pipeline] Conversation loop starting")
        self._timer_tasks = [
            asyncio.create_task(self._max_duration_watcher(ws)),
            asyncio.create_task(self._inactivity_watcher(ws)),
        ]
        await self._load_learning_state()
        self._last_turn_end = time.monotonic()
        if self._story is not None:
            self.current_task = asyncio.create_task(
                self._present_story_paragraph(ws, turn_id=self._next_turn_id(), continuing=False)
            )
        else:
            self.current_task = asyncio.create_task(self._greet(ws))
        try:
            while True:
                try:
                    data = await ws.receive()
                except RuntimeError:
                    # Client disconnected — ws.receive() raises RuntimeError after disconnect
                    logger.info("[pipeline] ws.receive raised RuntimeError — disconnect")
                    break
                except Exception as exc:
                    logger.error("[pipeline] ws.receive failed: %s", self._fmt_exc(exc))
                    break
                if data.get("type") == "websocket.disconnect":
                    logger.info("[pipeline] websocket.disconnect event received")
                    break
                if "bytes" in data:
                    await self.handle_audio(data["bytes"], ws)
                elif "text" in data:
                    msg = json.loads(data["text"])
                    if msg.get("type") == "client_event":
                        if msg.get("event") == "session_close_request":
                            self._client_close_reason = msg.get("reason", "manual")
                            logger.info(
                                "[pipeline] Client requested session close: reason=%s",
                                self._client_close_reason,
                            )
                            break
                        logger.debug("[pipeline] Received unknown client_event: %s", msg)
                        continue
                    if msg.get("type") == "interrupt":
                        await self.cancel_current()
                        await self._send_json(ws, {"type": "interrupted"})
        finally:
            logger.info(
                "[pipeline] Conversation loop ending: current_task=%s",
                self._task_state(self.current_task),
            )
            logger.info(
                "[pipeline] Session close reason=%s",
                self._client_close_reason or "peer_disconnect/unknown",
            )
            await self.cancel_current()
            for t in self._timer_tasks:
                t.cancel()

    def _reset_inactivity(self) -> None:
        self._last_activity = time.monotonic()
        self._inactivity_warning_sent = False

    async def handle_audio(self, audio_bytes: bytes, ws: WebSocket) -> None:
        if self._story_finished:
            # The story is over: the conversation ends and the learner moves on to the test.
            logger.info("[pipeline] Ignoring audio after the story finished")
            return
        self._reset_inactivity()
        logger.debug(
            "[pipeline] Audio chunk received (%d bytes); current_task=%s",
            len(audio_bytes),
            self._task_state(self.current_task),
        )
        # Barge-in: cancel ongoing response if a new audio chunk arrives
        if self.current_task and not self.current_task.done():
            logger.info(
                "[pipeline] Barge-in requested: canceling active turn before STT",
            )
            await self.cancel_current()
            logger.info("[pipeline] Barge-in: previous turn cancelled")
            await self._send_json(ws, {"type": "barge_in"})
        self.current_task = asyncio.create_task(self._process(audio_bytes, ws))

    async def _process(self, audio_bytes: bytes, ws: WebSocket) -> None:
        # Turns are serialized by handle_audio. Only this turn owns additions
        # beyond the snapshot; a cancelled greeting never owns initial context.
        history_start = len(self.history)
        try:
            await self._process_turn(audio_bytes, ws)
        finally:
            if len(self.history) > history_start and self.history[-1]["role"] == "user":
                self.history.pop()
            self._reset_inactivity()

    async def _process_turn(self, audio_bytes: bytes, ws: WebSocket) -> None:
        turn_t0 = time.perf_counter()
        turn_id = self._next_turn_id()
        stt_ms: float | None = None
        llm_ms: float | None = None
        tts_send_ms: float | None = None
        tts_bytes: int = 0
        tts_chunks_sent = 0
        assistant_transcript_sent = False
        send_aborted = False

        # 1. STT
        try:
            await self._send_status(ws, turn_id, "transcribing")
            stt_t0 = time.perf_counter()
            transcript, spoken_iso = await self._transcribe_user_input(audio_bytes)
            stt_ms = (time.perf_counter() - stt_t0) * 1000
            logger.info("[pipeline] STT result: lang=%s text=%r", spoken_iso, transcript)
        except Exception as exc:
            # Timeouts from httpx have empty messages; always log the exception type.
            logger.error("[pipeline] STT failed: %s", self._fmt_exc(exc))
            logger.info(
                "pipeline_turn_metrics",
                stage="stt_failed",
                stt_ms=round(stt_ms, 1) if stt_ms is not None else None,
                llm_ms=None,
                tts_send_ms=None,
                tts_chunks_sent=0,
                tts_audio_bytes=0,
                turn_total_ms=round((time.perf_counter() - turn_t0) * 1000, 1),
            )
            await self._send_json(
                ws,
                {
                    "type": "error",
                    "code": "stt_failed",
                    "message": str(exc),
                    "turn_id": turn_id,
                },
            )
            return

        user_text_for_llm = transcript.strip()
        if not user_text_for_llm:
            logger.info("[pipeline] Empty STT result - ignoring audio chunk")
            await self._send_status(ws, turn_id, "listening")
            return

        # The learner sees their finalized original transcript before the tutor replies;
        # the same verbatim text is sent to the LLM and saved.
        if self._bilingual_enabled:
            user_payload = self._user_transcript_payload(turn_id, user_text_for_llm, spoken_iso)
        else:
            user_payload = {
                "type": "transcript",
                "role": "user",
                "text": user_text_for_llm,
                "final": True,
                "turn_id": turn_id,
            }
        await self._send_json(ws, user_payload)

        # 2. Streaming LLM
        self.history.append({"role": "user", "content": user_text_for_llm})
        # NOTE: user message is intentionally saved *after* a successful turn
        # (alongside the assistant reply) so no orphan rows are written on
        # LLM failures or barge-in cancellations.
        await self._refresh_memory_prompt()
        transition_in_prompt = self._transition_pending
        messages = [{"role": "system", "content": self.system_prompt}] + self.history[-20:]

        full_response = ""
        clean_full_response = ""
        assistant_combined = ""
        reply: TutorReply | None = None
        memory_updated = False
        llm_stream = None
        try:
            await self._send_status(ws, turn_id, "thinking")

            llm_t0 = time.perf_counter()

            async def execute_memory_tool(call):
                if self._user_id is None:
                    raise RuntimeError("Memory tool requires an authenticated user")
                async with db_session() as db_mem:
                    return await execute_save_user_memory(
                        db_mem,
                        self._user_id,
                        call,
                        "voice",
                        study_plan_id=self._study_plan_id,
                    )

            memory_kwargs = {}
            if self._memory_tools_available:
                fallback_messages = [
                    {
                        "role": "system",
                        "content": self._build_prompt(memory_tools_enabled=False),
                    }
                ] + self.history[-20:]
                memory_kwargs = {
                    "tools": [
                        build_save_user_memory_tool(str(self._prompt_args["native_language"]))
                    ],
                    "tool_executor": execute_memory_tool,
                    "fallback_messages": fallback_messages,
                }
            llm_stream = await self.llm.chat(messages, stream=True, **memory_kwargs)
            stopped_loop = False
            try:
                async for chunk in llm_stream:
                    if isinstance(chunk, LLMToolResultEvent):
                        memory_updated = memory_updated or chunk.result.content.get("saved") is True
                        continue
                    if isinstance(chunk, LLMStreamReset):
                        full_response = ""
                        continue
                    token = self._stream_text(chunk)
                    full_response += token
                    if (
                        self._bilingual_enabled
                        and any(mark in token for mark in ".!?।")
                        and is_repetition_loop(full_response)
                    ):
                        stopped_loop = True
                        break
                if stopped_loop:
                    # A looping reply would otherwise run until the token limit.
                    logger.warning(
                        "[pipeline] Stopped a repeating LLM reply: turn_id=%s chars=%d",
                        turn_id,
                        len(full_response),
                    )
                    await self._close_llm_stream(llm_stream)
            finally:
                memory_updated = memory_updated or any(
                    result.content.get("saved") is True
                    for result in getattr(llm_stream, "tool_results", [])
                )
                if memory_updated:
                    await self._send_memory_updated(ws, turn_id)
            llm_ms = (time.perf_counter() - llm_t0) * 1000

            clean_full_response = self._extract_speech_text(full_response)
            if clean_full_response:
                if self._bilingual_enabled:
                    reply = self._parse_reply(clean_full_response)
                    tts_text, transcript_payload = self._assistant_bilingual_payload(
                        turn_id, reply
                    )
                    assistant_combined = transcript_payload["text"]
                else:
                    tts_text = assistant_combined = clean_full_response
                    transcript_payload = {
                        "type": "transcript",
                        "role": "assistant",
                        "text": clean_full_response,
                        "final": True,
                        "turn_id": turn_id,
                    }
                tts_send_t0 = time.perf_counter()
                (
                    tts_chunks_sent,
                    tts_bytes,
                    assistant_transcript_sent,
                    send_aborted,
                ) = await self._synthesize_and_send_response(
                    ws,
                    text=tts_text,
                    turn_id=turn_id,
                    transcript_payload=transcript_payload,
                    transcript_first=self._bilingual_enabled,
                )
                tts_send_ms = (time.perf_counter() - tts_send_t0) * 1000
                if send_aborted or not assistant_transcript_sent:
                    logger.warning(
                        "[pipeline] No assistant audio was sent and turn is being aborted: turn_id=%s",
                        turn_id,
                    )
                    await self._send_json(
                        ws,
                        {
                            "type": "error",
                            "code": "tts_failed",
                            "message": "Failed to synthesize assistant audio.",
                            "turn_id": turn_id,
                        },
                    )
                    return
            else:
                logger.warning(
                    "[pipeline] Skipping TTS synthesis because assistant text is empty after cleaning"
                )
                await self._send_status(ws, turn_id, "listening")
                await self._send_json(ws, {"type": "turn_complete", "turn_id": turn_id})
                return

            completed_at = datetime.now(UTC).replace(tzinfo=None)

        except asyncio.CancelledError:
            logger.warning(
                "[pipeline] Turn cancelled before completion: turn_id=%s",
                turn_id,
            )
            raise
        except (LLMTimeoutError, LLMUnavailableError, LLMError) as exc:
            logger.error("[pipeline] LLM failed: %s", exc)
            logger.info(
                "pipeline_turn_metrics",
                stage="llm_failed",
                stt_ms=round(stt_ms, 1) if stt_ms is not None else None,
                llm_ms=round(llm_ms, 1) if llm_ms is not None else None,
                tts_send_ms=round(tts_send_ms, 1) if tts_send_ms is not None else None,
                tts_chunks_sent=tts_chunks_sent,
                tts_audio_bytes=tts_bytes,
                turn_total_ms=round((time.perf_counter() - turn_t0) * 1000, 1),
            )
            await self._send_json(
                ws,
                {
                    "type": "error",
                    "code": "llm_failed",
                    "message": str(exc),
                    "turn_id": turn_id,
                },
            )
            return
        except Exception as exc:
            logger.error("[pipeline] TTS failed: %s", exc)
            logger.info(
                "pipeline_turn_metrics",
                stage="tts_failed",
                stt_ms=round(stt_ms, 1) if stt_ms is not None else None,
                llm_ms=round(llm_ms, 1) if llm_ms is not None else None,
                tts_send_ms=round(tts_send_ms, 1) if tts_send_ms is not None else None,
                tts_chunks_sent=tts_chunks_sent,
                tts_audio_bytes=tts_bytes,
                turn_total_ms=round((time.perf_counter() - turn_t0) * 1000, 1),
            )
            await self._send_json(
                ws,
                {
                    "type": "error",
                    "code": "tts_failed",
                    "message": str(exc),
                    "turn_id": turn_id,
                },
            )
            return
        finally:
            if llm_stream is not None:
                if getattr(llm_stream, "tools_unsupported", False):
                    self._memory_tools_available = False
                self._pending_saves.append(asyncio.create_task(self._save_usage(llm_stream)))

        assistant_for_history = assistant_combined or clean_full_response
        self.history.append({"role": "assistant", "content": assistant_for_history})
        user_saved_text = user_text_for_llm
        # Persist both sides of the turn together - only reached on success.
        self._pending_saves.append(
            asyncio.create_task(
                self._save_turn(
                    user_saved_text,
                    assistant_for_history,
                    completed_at=completed_at,
                )
            )
        )
        if self._bilingual_enabled and reply is not None:
            if transition_in_prompt:
                self._transition_pending = False
            self._update_learning(reply, user_text_for_llm, spoken_iso)
            self._pending_saves.append(asyncio.create_task(self._save_learning_state()))
            self._maybe_start_assessment()

        self._remember_story_questions(assistant_for_history)
        if self._story is not None and await self._advance_story_if_due(ws, turn_id):
            logger.info("[pipeline] Story moved on after turn_id=%s", turn_id)
            return

        logger.info("[pipeline] Turn complete - assistant: %r", assistant_for_history[:120])
        logger.info(
            "pipeline_turn_metrics",
            stage="ok",
            stt_ms=round(stt_ms, 1) if stt_ms is not None else None,
            llm_ms=round(llm_ms, 1) if llm_ms is not None else None,
            tts_send_ms=round(tts_send_ms, 1) if tts_send_ms is not None else None,
            tts_chunks_sent=tts_chunks_sent,
            tts_audio_bytes=tts_bytes,
            turn_total_ms=round((time.perf_counter() - turn_t0) * 1000, 1),
        )
        await self._send_status(ws, turn_id, "listening")

        await self._send_json(ws, {"type": "turn_complete", "turn_id": turn_id})

    async def _save_usage(self, stream: object) -> None:
        """Persists token usage from an LLMStream to the DB.

        Completely defensive — silently ignores any error, including:
        - stream not being an LLMStream instance
        - provider not returning usage (all fields None)
        - DB connectivity issues
        """
        if self._user_id is None:
            return
        try:
            if not isinstance(stream, LLMStream):
                return
            if stream.prompt_tokens is None and stream.completion_tokens is None:
                return
            # Lazy import to avoid circular imports
            from app.models.llm_usage import LLMUsage  # noqa: PLC0415

            async with db_session() as db:
                db.add(
                    LLMUsage(
                        user_id=self._user_id,
                        source="conversation",
                        prompt_tokens=stream.prompt_tokens,
                        completion_tokens=stream.completion_tokens,
                        total_tokens=stream.total_tokens,
                        study_plan_id=self._study_plan_id,
                    )
                )
                await db.commit()
        except Exception:
            logger.debug("[pipeline] Failed to save token usage — ignored")

    async def _save_turn(
        self, user_text: str, assistant_text: str, *, completed_at: datetime
    ) -> None:
        # Preserve transcript order even when background DB writes overlap turns.
        async with self._transcript_lock:
            response_id = await self._save_message(
                "assistant", assistant_text, user_text=user_text, completed_at=completed_at
            )
        if response_id is not None:
            await record_lingu_practice(response_id, user_agent=self._user_agent)

    async def _save_message(
        self,
        role: str,
        content: str,
        *,
        user_text: str | None = None,
        completed_at: datetime | None = None,
    ) -> int | None:
        """Persists a conversation transcript message to chat_history.

        Completely defensive — silently ignores any error.
        The save is sent to the background via asyncio.create_task so it never
        blocks the voice pipeline.
        """
        if self._user_id is None or self._conversation_id is None:
            return
        try:
            from sqlalchemy import update  # noqa: PLC0415

            from app.models.chat_history import ChatHistory  # noqa: PLC0415
            from app.models.conversation import Conversation  # noqa: PLC0415
            from app.services.progress_rewards import reward_conversation  # noqa: PLC0415

            completed_at = completed_at or datetime.now(UTC).replace(tzinfo=None)
            async with db_session() as db:
                reply_to_id = None
                if user_text is not None:
                    user_message = ChatHistory(
                        user_id=self._user_id,
                        conversation_id=self._conversation_id,
                        role="user",
                        content=user_text,
                        study_plan_id=self._study_plan_id,
                        target_language=self._target_language,
                        modality="voice",
                        created_at=completed_at,
                    )
                    db.add(user_message)
                    await db.flush()
                    reply_to_id = user_message.id
                message = ChatHistory(
                    user_id=self._user_id,
                    conversation_id=self._conversation_id,
                    role=role,
                    content=content,
                    study_plan_id=self._study_plan_id,
                    target_language=self._target_language,
                    modality="voice",
                    reply_to_id=reply_to_id,
                    created_at=completed_at,
                )
                db.add(message)
                await db.execute(
                    update(Conversation)
                    .where(Conversation.id == self._conversation_id)
                    .values(updated_at=completed_at)
                )
                if role == "assistant":
                    await db.flush()
                    await reward_conversation(db, message.id)
                await db.commit()
                response_id = message.id
            return response_id
        except Exception:
            logger.debug("[pipeline] Failed to save message — ignored")

    async def cancel_current(self) -> None:
        if self.current_task and not self.current_task.done():
            logger.debug(
                "[pipeline] cancel_current: cancelling task state=%s",
                self._task_state(self.current_task),
            )
            self.current_task.cancel()
            try:
                await self.current_task
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                logger.debug("[pipeline] cancel_current await failed: %s", self._fmt_exc(exc))

    async def cleanup(self) -> None:
        # Record actual session duration once, best-effort
        if not self._recorded:
            self._recorded = True
            elapsed = int(time.monotonic() - self._session_start)
            if self._redis is not None and self._user_id is not None and elapsed > 0:
                try:
                    await record_session_seconds(self._redis, self._user_id, elapsed)
                except Exception:
                    logger.debug("[pipeline] Failed to record session seconds — ignored")
                if self._freemium_voice:
                    try:
                        from app.services.freemium_service import record_voice_usage

                        await record_voice_usage(self._redis, self._user_id, elapsed)
                    except Exception:
                        logger.debug("[pipeline] Failed to record freemium voice seconds — ignored")
        await self.cancel_current()
        for t in self._timer_tasks:
            t.cancel()
        if self._assessment_task is not None and not self._assessment_task.done():
            self._assessment_task.cancel()
            try:
                await self._assessment_task
            except asyncio.CancelledError, Exception:  # noqa: BLE001
                pass
        # Wait for any in-flight DB saves (transcripts, token usage) so they
        # are not silently cancelled when the event loop shuts down the task.
        if self._pending_saves:
            await asyncio.gather(*self._pending_saves, return_exceptions=True)
        logger.debug("[pipeline] Cleanup complete")

    # --- Timeout watchers ---

    async def _max_duration_watcher(self, ws: WebSocket) -> None:
        """Closes session after max_duration seconds, with a 60s warning."""
        warn_at = self.max_duration - WARNING_ADVANCE_SECONDS
        if warn_at > 0:
            await asyncio.sleep(warn_at)
            logger.info(
                "[pipeline] Max duration warning — %ss remaining",
                WARNING_ADVANCE_SECONDS,
            )
            await self._send_json(
                ws,
                {
                    "type": "session_warning",
                    "reason": "max_duration",
                    "remaining_seconds": WARNING_ADVANCE_SECONDS,
                },
            )
            await asyncio.sleep(WARNING_ADVANCE_SECONDS)
        else:
            await asyncio.sleep(self.max_duration)
        logger.info("[pipeline] Session ended by max_duration")
        await self._send_json(ws, {"type": "session_end", "reason": "max_duration"})
        await self._close_ws(ws, code=1000)

    async def _inactivity_watcher(self, ws: WebSocket) -> None:
        """Closes session if user is silent for inactivity_timeout seconds."""
        while True:
            await asyncio.sleep(5)  # check every 5 seconds
            if self.current_task is not None and not self.current_task.done():
                continue
            elapsed = time.monotonic() - self._last_activity
            remaining = self.inactivity_timeout - elapsed

            if 0 < remaining <= WARNING_ADVANCE_SECONDS and not self._inactivity_warning_sent:
                self._inactivity_warning_sent = True
                logger.info("[pipeline] Inactivity warning — %ds remaining", int(remaining))
                await self._send_json(
                    ws,
                    {
                        "type": "session_warning",
                        "reason": "inactivity",
                        "remaining_seconds": int(remaining),
                    },
                )

            if elapsed >= self.inactivity_timeout:
                logger.info("[pipeline] Session ended by inactivity (elapsed %.0fs)", elapsed)
                await self._send_json(ws, {"type": "session_end", "reason": "inactivity"})
                await self._close_ws(ws, code=1000)
                return



