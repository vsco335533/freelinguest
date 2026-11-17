from __future__ import annotations

import asyncio
import json
import time
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
    load_learning_state,
    normalize_cefr,
    parse_assessment_json,
    parse_tutor_reply,
    save_learning_state,
    split_speech_segments,
)
from app.services.prompts.common import get_language_prompt_overlay
from app.services.prompts.tutor import (
    build_conversation_assessment_messages,
    build_conversation_system_prompt,
)
from app.services.quota_service import record_session_seconds
from app.utils.db import db_session

if TYPE_CHECKING:
    from fastapi import WebSocket

logger = get_logger(__name__)

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
        }
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

    async def _stt_text(self, audio_bytes: bytes, language: str) -> str:
        text = await self.stt.transcribe(audio_bytes, "audio.wav", "audio/wav", language=language)
        return (text or "").strip()

    async def _transcribe_user_input(self, audio_bytes: bytes) -> tuple[str, str]:
        """Return (native_text, target_text); native_text is empty unless bilingual.

        In bilingual mode the same audio is transcribed with explicit native and
        target recognition languages; the tutor model decides which transcript
        reflects what the learner actually said. Requests run one after another:
        the local Whisper service processes a single request at a time, so
        concurrent requests only queue and push the second past its timeout.
        The turn fails only when both recognitions fail.
        """
        if not self._bilingual_enabled:
            return "", await self._stt_text(audio_bytes, self._stt_language)
        texts: dict[str, str] = {}
        errors: dict[str, Exception] = {}
        for lang in (self._native_language_code, self._target_iso):
            t0 = time.perf_counter()
            try:
                texts[lang] = await self._stt_text(audio_bytes, lang)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                errors[lang] = exc
                logger.warning(
                    "[pipeline] STT failed for lang=%s after %.0fms: %s",
                    lang,
                    (time.perf_counter() - t0) * 1000,
                    self._fmt_exc(exc),
                )
        if len(errors) == 2:
            raise errors[self._target_iso]
        return texts.get(self._native_language_code, ""), texts.get(self._target_iso, "")

    def _bilingual_llm_input(self, native_text: str, target_text: str) -> str:
        if native_text and target_text and native_text != target_text:
            return (
                "[Two automatic transcripts of the same audio; one may be a misrecognition]\n"
                f"{self._native_language_name} transcript: {native_text}\n"
                f"{self._prompt_args['target_language_name']} transcript: {target_text}"
            )
        return native_text or target_text

    def _native_is_latin(self) -> bool:
        return not _is_non_latin_language(self._native_language_code)

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

    def _resolve_heard(
        self, reply: TutorReply, native_text: str, target_text: str
    ) -> tuple[str, str, str]:
        """Return (heard_text, heard_iso, target_meaning) for the learner's turn."""
        heard = reply.heard or target_text or native_text
        lang = reply.heard_lang
        if (
            not self._native_is_latin()
            and reply.attempted is False
            and heard
            and is_latin_script_text(heard)
            and native_text
            and not is_latin_script_text(native_text)
        ):
            # The model says the student did not speak the target language, yet picked
            # a Latin-script transcript (usually native speech transliterated by the
            # target-language STT pass): show the native-script transcript instead.
            heard = native_text
        if not self._native_is_latin() and heard and not is_latin_script_text(heard):
            # Native-script text is native speech whatever label the model chose.
            heard_iso = self._native_language_code
        elif lang in ("native", self._native_language_code):
            heard_iso = self._native_language_code
        elif lang in ("target", self._target_iso):
            heard_iso = self._target_iso
        elif not self._native_is_latin() and not is_latin_script_text(heard):
            heard_iso = self._native_language_code
        else:
            heard_iso = self._target_iso
        meaning = reply.meaning if heard_iso == self._native_language_code else heard
        return heard, heard_iso, meaning or heard

    def _user_transcript_payload(
        self, turn_id: int, heard: str, heard_iso: str, meaning: str
    ) -> dict:
        said_native = heard_iso == self._native_language_code
        return {
            "type": "transcript",
            "role": "user",
            "text": meaning if said_native else heard,
            "final": True,
            "turn_id": turn_id,
            "text_native": heard if said_native else "",
            "text_target": meaning if said_native else heard,
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
        attempted, correct = reply.attempted, reply.correct
        if attempted is None and self._native_is_latin() != (
            not _is_non_latin_language(self._target_iso)
        ):
            # Scripts differ, so the heard language is a reliable attempt signal.
            attempted, correct = heard_iso == self._target_iso, False
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
                    audio = await self._native_tts.synthesize(text)
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
        """Split on full stops while preserving decimals and ellipses for speech."""
        chunks: list[str] = []
        start = 0
        for idx, char in enumerate(text):
            if char != ".":
                continue
            if (idx > 0 and text[idx - 1] == ".") or (idx + 1 < len(text) and text[idx + 1] == "."):
                continue
            if (
                idx > 0
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
    ) -> tuple[int, int, bool, bool]:
        """Synthesize ordered sentence chunks and send the transcript after first audio."""
        chunks_sent = 0
        audio_bytes_sent = 0
        transcript_sent = False
        send_aborted = False

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

    async def _greet(self, ws: WebSocket) -> None:
        """Generate and stream an opening greeting from the assistant."""
        turn_id = self._next_turn_id()
        trigger = {
            "role": "user",
            "content": "[Session started. Greet the student warmly and naturally — one or two sentences max — and invite them to speak.]",
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
            )
            if send_aborted or not transcript_sent:
                return

            self.history.append({"role": "assistant", "content": assistant_combined})
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

    async def run(self, ws: WebSocket) -> None:
        """Main loop: starts timeout watchers then handles incoming messages."""
        logger.info("[pipeline] Conversation loop starting")
        self._timer_tasks = [
            asyncio.create_task(self._max_duration_watcher(ws)),
            asyncio.create_task(self._inactivity_watcher(ws)),
        ]
        await self._load_learning_state()
        self._last_turn_end = time.monotonic()
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
            native_stt, target_stt = await self._transcribe_user_input(audio_bytes)
            stt_ms = (time.perf_counter() - stt_t0) * 1000
            logger.info("[pipeline] STT result: native=%r target=%r", native_stt, target_stt)
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

        if self._bilingual_enabled:
            user_text_for_llm = self._bilingual_llm_input(native_stt, target_stt).strip()
        else:
            user_text_for_llm = target_stt.strip()
        if not user_text_for_llm:
            logger.info("[pipeline] Empty STT result - ignoring audio chunk")
            await self._send_status(ws, turn_id, "listening")
            return

        user_payload: dict = {
            "type": "transcript",
            "role": "user",
            "text": user_text_for_llm,
            "final": True,
            "turn_id": turn_id,
        }
        user_transcript_sent = False
        if self._bilingual_enabled:
            # Which transcript is right is only known once the tutor replies (HEARD);
            # keep a best-effort fallback in case the LLM step fails.
            heard, heard_iso, meaning = self._resolve_heard(TutorReply(), native_stt, target_stt)
            user_payload = self._user_transcript_payload(turn_id, heard, heard_iso, meaning)
        else:
            await self._send_json(ws, user_payload)
            user_transcript_sent = True

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
                    heard, heard_iso, meaning = self._resolve_heard(reply, native_stt, target_stt)
                    user_payload = self._user_transcript_payload(
                        turn_id, heard, heard_iso, meaning
                    )
                    await self._send_json(ws, user_payload)
                    user_transcript_sent = True
                    # Keep the model's context clean: what was said plus its meaning.
                    self.history[-1]["content"] = (
                        f"{heard}\n[{self._prompt_args['target_language_name']} meaning: {meaning}]"
                        if heard_iso == self._native_language_code and meaning != heard
                        else heard
                    )
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
                if not user_transcript_sent:
                    await self._send_json(ws, user_payload)
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
            if not user_transcript_sent:
                await self._send_json(ws, user_payload)
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
        if self._bilingual_enabled:
            # Preserve the original native transcript alongside its target meaning.
            parts = (user_payload.get("text_native"), user_payload.get("text_target"))
            user_saved_text = "\n".join(dict.fromkeys(t for t in parts if t)) or user_payload.get(
                "text", user_text_for_llm
            )
        else:
            user_saved_text = user_payload.get("text", user_text_for_llm)
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
            heard_text = user_payload.get("text_native") or user_payload.get("text_target", "")
            heard_iso = (
                self._native_language_code if user_payload.get("text_native") else self._target_iso
            )
            self._update_learning(reply, heard_text, heard_iso)
            self._pending_saves.append(asyncio.create_task(self._save_learning_state()))
            self._maybe_start_assessment()

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



