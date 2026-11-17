"""Adaptive bilingual voice tutoring: learning state, reply parsing, phases, speech routing."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.conversation_learning import (
    ASSESSMENT_INTERVAL_SECONDS,
    MAX_ENCOURAGEMENTS,
    MAX_TURN_ACTIVE_SECONDS,
    NATIVE_PHASE_SECONDS,
    LearningState,
    initial_stage_for_cefr,
    normalize_cefr,
    parse_assessment_json,
    parse_tutor_reply,
    split_speech_segments,
    strip_quotes,
)
from app.services.conversation_pipeline import ConversationPipeline, _resolve_bilingual_enabled
from app.services.llm_adapter import LLMError
from app.services.prompts.tutor import (
    build_conversation_assessment_messages,
    build_conversation_system_prompt,
)

REPLY_TEXT = (
    "అవునా! మీకు క్రికెట్ ఆడటం చాలా ఇష్టం అన్నమాట. ఇంగ్లీషులో దీనిని "
    '"I like playing cricket very much" అంటాం. Like అంటే ఇష్టం. మీరు రోజూ క్రికెట్ ఆడతారా?'
)
TELUGU_REPLY = f"""\
HEARD: నాకు క్రికెట్ ఆడటం చాలా ఇష్టం
HEARD_LANG: native
MEANING: I like playing cricket very much.
CHECK: attempted=no correct=no
VOCAB: like = ఇష్టం; playing = ఆడటం
MISTAKE: none
ENCOURAGE: none
REPLY: {REPLY_TEXT}
"""


# --- Levels and stages ----------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [("b1", "B1"), (" C2 ", "C2"), ("A1+", "A1"), ("Z9", "A2"), (None, "A2")],
)
def test_normalize_cefr(value, expected) -> None:
    assert normalize_cefr(value) == expected


@pytest.mark.parametrize(
    ("level", "stage"), [("A1", 1), ("A2", 2), ("B1", 3), ("B2", 4), ("C1", 5), ("C2", 5)]
)
def test_initial_stage_follows_level(level, stage) -> None:
    state = LearningState.fresh(level)
    assert initial_stage_for_cefr(level) == stage
    assert state.exposure_stage == stage


def test_stage_needs_evidence_before_advancing() -> None:
    state = LearningState.fresh("A1")
    for _ in range(3):
        assert state.record_performance(attempted=True, acceptable=True) == 0
    assert state.exposure_stage == 1
    assert state.record_performance(attempted=True, acceptable=True) == 1
    assert state.exposure_stage == 2
    assert state.target_percent == 20
    assert state.recent_performance == []


def test_stage_advances_one_step_at_a_time_up_to_five() -> None:
    state = LearningState.fresh("A1")
    for _ in range(40):
        state.record_performance(attempted=True, acceptable=True)
    assert state.exposure_stage == 5
    assert state.target_percent == 90


def test_native_only_speaker_eases_back_but_never_below_stage_one() -> None:
    state = LearningState.fresh("B1")
    for _ in range(4):
        state.record_performance(attempted=False, acceptable=False)
    assert state.exposure_stage == 2
    for _ in range(20):
        state.record_performance(attempted=False, acceptable=False)
    assert state.exposure_stage == 1


def test_struggling_attempts_add_native_support() -> None:
    state = LearningState.fresh("B1")
    for _ in range(4):
        state.record_performance(attempted=True, acceptable=False)
    assert state.exposure_stage == 2


def test_mixed_performance_holds_stage() -> None:
    state = LearningState.fresh("A2")
    for ok in (True, False, True, False):
        state.record_performance(attempted=True, acceptable=ok)
    assert state.exposure_stage == 2


# --- Learner memory ---------------------------------------------------------------


def test_vocabulary_is_deduplicated_case_insensitively() -> None:
    state = LearningState.fresh("A1")
    state.add_vocabulary([{"term": "Love", "meaning": "చాలా ఇష్టం"}])
    state.add_vocabulary([{"term": "love", "meaning": "x"}, {"term": "play", "meaning": "ఆడు"}])
    assert [v["term"] for v in state.learned_vocabulary] == ["Love", "play"]


def test_encouragements_are_capped_and_listed_as_do_not_reuse() -> None:
    state = LearningState.fresh("A1")
    for i in range(MAX_ENCOURAGEMENTS + 3):
        state.add_encouragement(f"Great effort number {i}.")
    state.add_encouragement("none")
    assert len(state.recent_encouragements) == MAX_ENCOURAGEMENTS
    context = state.prompt_context()
    assert "do NOT reuse" in context
    assert f"Great effort number {MAX_ENCOURAGEMENTS + 2}." in context


def test_mistakes_ignore_none_and_move_repeats_to_end() -> None:
    state = LearningState.fresh("A1")
    state.add_mistake("past tense of go")
    state.add_mistake("none")
    state.add_mistake("articles")
    state.add_mistake("Past tense of go")
    assert state.common_mistakes == ["articles", "Past tense of go"]


def test_active_time_is_capped_per_turn_and_triggers_assessment() -> None:
    state = LearningState.fresh("A1")
    state.add_active_seconds(10_000)
    assert state.active_seconds == MAX_TURN_ACTIVE_SECONDS
    turns_needed = ASSESSMENT_INTERVAL_SECONDS // MAX_TURN_ACTIVE_SECONDS
    for _ in range(turns_needed - 1):
        state.add_active_seconds(MAX_TURN_ACTIVE_SECONDS)
    assert not state.assessment_due()
    state.add_active_seconds(MAX_TURN_ACTIVE_SECONDS)
    assert state.assessment_due()


# --- Periodic assessment -------------------------------------------------------------


def _with_utterances(state: LearningState, count: int) -> LearningState:
    for i in range(count):
        state.add_utterance(f"I went to school {i}", "en")
    return state


def test_assessment_moves_level_at_most_one_step() -> None:
    state = _with_utterances(LearningState.fresh("A1"), 6)
    state.active_seconds = ASSESSMENT_INTERVAL_SECONDS
    outcome = state.apply_assessment(
        {"estimated_cefr": "B2", "message_target": "Nice!", "message_native": "బాగుంది!"},
        plan_cefr="A1",
    )
    assert state.estimated_cefr == "A2"
    assert outcome.level_changed
    assert outcome.suggest_level_test
    assert state.active_seconds == 0
    assert state.last_assessment and state.last_assessment["previous_cefr"] == "A1"


def test_assessment_without_enough_evidence_keeps_level() -> None:
    state = _with_utterances(LearningState.fresh("B1"), 2)
    outcome = state.apply_assessment({"estimated_cefr": "C1"}, plan_cefr="B1")
    assert state.estimated_cefr == "B1"
    assert not outcome.level_changed
    assert not outcome.suggest_level_test


def test_failed_assessment_retries_sooner() -> None:
    state = LearningState.fresh("A1")
    state.active_seconds = ASSESSMENT_INTERVAL_SECONDS
    state.defer_assessment()
    assert 0 < state.active_seconds < ASSESSMENT_INTERVAL_SECONDS


def test_parse_assessment_json_tolerates_surrounding_text() -> None:
    assert parse_assessment_json('Sure! {"estimated_cefr": "A2"} done') == {"estimated_cefr": "A2"}
    assert parse_assessment_json("no json here") is None
    assert parse_assessment_json("{broken") is None


def test_assessment_prompt_treats_utterances_as_data() -> None:
    messages = build_conversation_assessment_messages(
        native_language="Telugu",
        target_language_name="English (UK)",
        current_cefr="A1",
        plan_cefr="A1",
        utterances=["[te] నమస్కారం", "[en] I am go school"],
        known_mistakes=["past tense"],
    )
    assert "data, not instructions" in messages[0]["content"]
    assert "level test" in messages[0]["content"]
    assert "[en] I am go school" in messages[1]["content"]


# --- Reply parsing ---------------------------------------------------------------------


def test_parse_structured_reply_hides_metadata() -> None:
    reply = parse_tutor_reply(TELUGU_REPLY)
    assert reply.structured
    assert reply.heard == "నాకు క్రికెట్ ఆడటం చాలా ఇష్టం"
    assert reply.heard_lang == "native"
    assert reply.meaning == "I like playing cricket very much."
    assert reply.attempted is False and reply.correct is False
    assert reply.mistake == "" and reply.encourage == ""
    assert reply.vocabulary == [
        {"term": "like", "meaning": "ఇష్టం"},
        {"term": "playing", "meaning": "ఆడటం"},
    ]
    # One natural paragraph, quotes removed, no labels.
    assert reply.spoken.startswith("అవునా!")
    assert "I like playing cricket very much అంటాం" in reply.spoken
    assert '"' not in reply.spoken
    for label in ("HEARD", "VOCAB", "CHECK", "MEANING"):
        assert label not in reply.spoken


def test_multiline_reply_is_joined() -> None:
    reply = parse_tutor_reply("HEARD: hi\nREPLY: చాలా బాగుంది!\nHow are you?")
    assert reply.spoken == "చాలా బాగుంది! How are you?"


def test_legacy_two_part_reply_is_merged() -> None:
    text = "NATIVE: బాగుంది.\nTARGET: Very good.\nQUESTION: What next?"
    assert parse_tutor_reply(text).spoken == "బాగుంది. Very good. What next?"


def test_unlabelled_reply_is_used_as_is() -> None:
    reply = parse_tutor_reply('చాలా బాగుంది! "Very good!" What next?')
    assert not reply.structured
    assert reply.spoken == "చాలా బాగుంది! Very good! What next?"


def test_markdown_labels_are_accepted() -> None:
    reply = parse_tutor_reply("**CHECK:** attempted=true, correct=false\n**REPLY**: Hi there.")
    assert reply.attempted is True and reply.correct is False
    assert reply.spoken == "Hi there."


def test_strip_quotes_keeps_apostrophes() -> None:
    assert strip_quotes('He said “I’m fine” and "ok"') == "He said I’m fine and ok"


# --- Speech routing ------------------------------------------------------------------------


def test_split_speech_segments_alternates_scripts() -> None:
    segments = split_speech_segments("ఇంగ్లీషులో దీనిని I like playing cricket అంటాం.")
    assert segments == [
        ("ఇంగ్లీషులో దీనిని", False),
        ("I like playing cricket", True),
        ("అంటాం.", False),
    ]


def test_split_speech_segments_keeps_numbers_with_current_run() -> None:
    assert split_speech_segments("I wake up at 6 am") == [("I wake up at 6 am", True)]


# --- Setting resolution and prompt -----------------------------------------------------


@pytest.mark.parametrize(
    ("setting", "cefr", "native", "target", "expected"),
    [
        ("auto", "A1", "te", "en-GB", True),
        ("auto", "B2", "te", "en-GB", True),
        ("auto", "C1", "te", "en-GB", False),
        ("on", "C2", "te", "en-GB", True),
        ("off", "A1", "te", "en-GB", False),
        ("on", "A1", "en", "en-GB", False),
        ("auto", "A1", "en-US", "en-GB", False),
    ],
)
def test_resolve_bilingual_enabled(setting, cefr, native, target, expected) -> None:
    assert _resolve_bilingual_enabled(setting, cefr, native, target) is expected


def _prompt(**overrides) -> str:
    args = {
        "student_name": "Krishna",
        "cefr_level": "A1",
        "native_language": "Telugu",
        "target_language_name": "English (UK)",
        "user_context": "",
        "memory_context": "",
        "memory_tools_enabled": False,
    }
    args.update(overrides)
    return build_conversation_system_prompt(**args)


def test_bilingual_prompt_asks_for_one_natural_reply() -> None:
    prompt = _prompt(bilingual_mode=True, exposure_stage=1, target_exposure_percent=10)
    assert "Telugu-speaking English (UK) tutor" in prompt
    assert "About 90% Telugu and 10% English (UK)" in prompt
    assert "Current phase: Telugu conversation" in prompt
    assert "ONE natural spoken paragraph" in prompt
    assert "REPLY: అవునా!" in prompt
    assert "ALWAYS respond in English (UK), regardless" not in prompt


def test_practice_phase_and_one_time_transition() -> None:
    prompt = _prompt(
        bilingual_mode=True,
        exposure_stage=2,
        target_exposure_percent=20,
        conversation_phase="practice",
        transition_now=True,
    )
    assert "Current phase: English (UK) practice" in prompt
    assert "In THIS reply only" in prompt
    assert "In THIS reply only" not in _prompt(bilingual_mode=True, conversation_phase="practice")


def test_bilingual_prompt_includes_learner_memory() -> None:
    prompt = _prompt(
        bilingual_mode=True, exposure_stage=4, target_exposure_percent=60, learning_context="MEMO"
    )
    assert "About 40% Telugu and 60% English (UK)" in prompt
    assert "MEMO" in prompt


def test_classic_prompt_unchanged_when_bilingual_off() -> None:
    prompt = _prompt(bilingual_mode=False)
    assert "ALWAYS respond in English (UK), regardless" in prompt
    assert "REPLY:" not in prompt


# --- Pipeline flow -----------------------------------------------------------------------

TELUGU_SPEECH = "నాకు క్రికెట్ ఆడటం చాలా ఇష్టం"


class FakeWS:
    def __init__(self) -> None:
        self.sent: list[tuple[str, object]] = []

    async def send_json(self, data: object) -> None:
        self.sent.append(("json", data))

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(("bytes", data))

    async def close(self, code: int = 1000) -> None:
        self.sent.append(("close", code))

    def json(self) -> list[dict]:
        return [m[1] for m in self.sent if m[0] == "json"]

    def transcripts(self, role: str) -> list[dict]:
        return [m for m in self.json() if m.get("type") == "transcript" and m.get("role") == role]

    def errors(self) -> list[dict]:
        return [m for m in self.json() if m.get("type") == "error"]


def _chunk(text: str) -> MagicMock:
    chunk = MagicMock()
    chunk.choices = [MagicMock()]
    chunk.choices[0].delta.content = text
    return chunk


def _native_tts(*, mixed_script: bool = False) -> MagicMock:
    native = MagicMock()
    native.mixed_script = mixed_script
    native.supports = MagicMock(side_effect=lambda code: code == "te")
    native.synthesize = AsyncMock(return_value=b"wav")
    return native


def _bilingual_pipeline(
    reply_text: str,
    *,
    native_tts: object | None = None,
    detected: tuple[str | None, float | None] = ("te", 0.93),
    transcripts: dict[str, str] | None = None,
):
    pipeline = ConversationPipeline(
        llm=AsyncMock(),
        tts=AsyncMock(),
        stt=AsyncMock(),
        cefr_level="A1",
        native_language="te",
        target_language="en-GB",
        bilingual_mode_setting="auto",
        native_tts=native_tts,
    )
    texts = transcripts or {"te": TELUGU_SPEECH, "en": "I went to school yesterday."}

    async def transcribe(_audio, _name, _mime, *, language, **_options):
        return texts[language]

    async def stream():
        yield _chunk(reply_text)

    pipeline.stt.detect_language = AsyncMock(return_value=detected)
    pipeline.stt.transcribe = AsyncMock(side_effect=transcribe)
    pipeline.llm.chat = AsyncMock(return_value=stream())
    pipeline.tts.synthesize = AsyncMock(return_value=b"mp3")
    return pipeline


@pytest.mark.asyncio
async def test_telugu_speech_is_transcribed_once_in_telugu_and_shown_verbatim() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY)
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    (call,) = pipeline.stt.transcribe.await_args_list
    assert call.kwargs["language"] == "te"
    assert call.kwargs["vad_filter"] is True
    assert "తెలుగు" in call.kwargs["prompt"]  # native-script prompt keeps Telugu script

    (user,) = ws.transcripts("user")
    assert user["text"] == user["text_native"] == TELUGU_SPEECH
    assert user["text_target"] == ""
    # The original transcript is shown before the tutor's reply.
    order = [m.get("role") for m in ws.json() if m.get("type") == "transcript"]
    assert order == ["user", "assistant"]

    # The LLM and history receive the same verbatim transcript.
    assert pipeline.llm.chat.await_args.args[0][-1]["content"] == TELUGU_SPEECH
    assert pipeline.history[0]["content"] == TELUGU_SPEECH
    assert pipeline._learning.recent_utterances == [f"[te] {TELUGU_SPEECH}"]
    assert pipeline._learning.recent_performance == [{"attempted": False, "acceptable": False}]


@pytest.mark.asyncio
async def test_confident_english_detection_transcribes_in_english() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY, detected=("en", 0.91))
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    (call,) = pipeline.stt.transcribe.await_args_list
    assert call.kwargs["language"] == "en"
    assert "prompt" not in call.kwargs
    (user,) = ws.transcripts("user")
    assert user["text_target"] == "I went to school yesterday."
    assert user["text_native"] == ""
    assert pipeline._learning.recent_performance[-1]["attempted"] is True


@pytest.mark.parametrize(
    "detected",
    [("en", 0.4), ("kn", 0.8), ("hi", 0.9), (None, None)],
)
@pytest.mark.asyncio
async def test_uncertain_or_other_detection_stays_telugu(detected) -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY, detected=detected)

    await pipeline._process(b"audio", FakeWS())

    (call,) = pipeline.stt.transcribe.await_args_list
    assert call.kwargs["language"] == "te"


@pytest.mark.asyncio
async def test_detection_failure_falls_back_to_telugu() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY)
    pipeline.stt.detect_language = AsyncMock(side_effect=RuntimeError("no endpoint"))
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    assert pipeline.stt.transcribe.await_args.kwargs["language"] == "te"
    assert not ws.errors()


@pytest.mark.asyncio
async def test_model_never_rewrites_the_displayed_transcript() -> None:
    reply = TELUGU_REPLY.replace(
        "HEARD: నాకు క్రికెట్ ఆడటం చాలా ఇష్టం", "HEARD: I like playing cricket"
    )
    pipeline = _bilingual_pipeline(reply)
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    (user,) = ws.transcripts("user")
    assert user["text"] == TELUGU_SPEECH


@pytest.mark.asyncio
async def test_user_transcript_is_shown_even_if_llm_fails() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY)
    pipeline.llm.chat = AsyncMock(side_effect=LLMError("down"))
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    (user,) = ws.transcripts("user")
    assert user["text"] == TELUGU_SPEECH
    assert [e["code"] for e in ws.errors()] == ["llm_failed"]


@pytest.mark.asyncio
async def test_stt_failure_reports_error_and_skips_llm() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY)
    pipeline.stt.transcribe = AsyncMock(side_effect=TimeoutError())
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    assert [e["code"] for e in ws.errors()] == ["stt_failed"]
    assert not ws.transcripts("user")
    pipeline.llm.chat.assert_not_called()


@pytest.mark.asyncio
async def test_empty_transcript_is_ignored() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY, transcripts={"te": "  ", "en": ""})
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    assert not ws.transcripts("user")
    pipeline.llm.chat.assert_not_called()


@pytest.mark.asyncio
async def test_bilingual_reply_is_one_natural_paragraph_with_native_voice() -> None:
    native = _native_tts()
    pipeline = _bilingual_pipeline(TELUGU_REPLY, native_tts=native)
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    (assistant,) = ws.transcripts("assistant")
    assert assistant["text"] == assistant["text_native"]
    assert assistant["text"].startswith("అవునా!")
    assert "HEARD" not in assistant["text"]
    native_spoken = " ".join(c.args[0] for c in native.synthesize.await_args_list)
    english_spoken = " ".join(c.args[0] for c in pipeline.tts.synthesize.await_args_list)
    assert "అవునా!" in native_spoken
    assert "I like playing cricket very much" in english_spoken
    assert "అవునా" not in english_spoken
    assert not ws.errors()
    assert [v["term"] for v in pipeline._learning.learned_vocabulary] == ["like", "playing"]


@pytest.mark.asyncio
async def test_mixed_script_voice_reads_whole_sentences_in_one_voice() -> None:
    native = _native_tts(mixed_script=True)
    pipeline = _bilingual_pipeline(TELUGU_REPLY, native_tts=native)
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    spoken = [c.args[0] for c in native.synthesize.await_args_list]
    assert "ఇంగ్లీషులో దీనిని I like playing cricket very much అంటాం." in spoken
    pipeline.tts.synthesize.assert_not_called()
    assert not ws.errors()


@pytest.mark.asyncio
async def test_without_native_voice_only_latin_phrases_are_spoken() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY)
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    spoken = [c.args[0] for c in pipeline.tts.synthesize.await_args_list]
    assert spoken and all("అ" not in s for s in spoken)
    assert ws.transcripts("assistant")[0]["text"].startswith("అవునా!")


@pytest.mark.asyncio
async def test_native_phase_switches_once_after_four_active_minutes() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY)
    assert pipeline._conversation_phase() == "native"
    pipeline._session_active_seconds = NATIVE_PHASE_SECONDS - 1
    pipeline._last_turn_end -= 30

    pipeline._advance_session_time()

    assert pipeline._conversation_phase() == "practice"
    assert pipeline._transition_pending
    assert "In THIS reply only" in pipeline._build_prompt(memory_tools_enabled=False)


@pytest.mark.asyncio
async def test_transition_instruction_is_cleared_after_delivery() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY)
    pipeline._phase_switched = True
    pipeline._transition_pending = True

    await pipeline._process(b"audio", FakeWS())

    assert not pipeline._transition_pending
    assert "In THIS reply only" not in pipeline._build_prompt(memory_tools_enabled=False)


def test_advanced_learners_start_in_practice_phase() -> None:
    pipeline = ConversationPipeline(
        llm=AsyncMock(),
        tts=AsyncMock(),
        stt=AsyncMock(),
        cefr_level="B2",
        native_language="te",
        target_language="en-GB",
        bilingual_mode_setting="auto",
    )
    assert pipeline._learning.exposure_stage == 4
    assert pipeline._conversation_phase() == "practice"


@pytest.mark.asyncio
async def test_progress_note_is_prepended_to_next_reply_once() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY)
    pipeline._pending_progress_note = ("మీరు బాగా మెరుగుపడుతున్నారు.", "You are improving.")
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    (assistant,) = ws.transcripts("assistant")
    assert assistant["text"].startswith("మీరు బాగా మెరుగుపడుతున్నారు. అవునా!")
    assert pipeline._pending_progress_note is None


@pytest.mark.asyncio
async def test_assessment_failure_defers_without_breaking_session() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY)
    pipeline.llm.chat = AsyncMock(return_value="not json")
    pipeline._learning.active_seconds = ASSESSMENT_INTERVAL_SECONDS

    await pipeline._run_assessment()

    assert pipeline._pending_progress_note is None
    assert 0 < pipeline._learning.active_seconds < ASSESSMENT_INTERVAL_SECONDS


@pytest.mark.asyncio
async def test_assessment_success_queues_progress_note() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY)
    _with_utterances(pipeline._learning, 6)
    pipeline.llm.chat = AsyncMock(
        return_value='{"estimated_cefr": "A2", "message_target": "Great progress!",'
        ' "message_native": "చాలా మంచి పురోగతి!", "recurring_mistakes": ["articles"]}'
    )

    await pipeline._run_assessment()

    assert pipeline._learning.estimated_cefr == "A2"
    assert pipeline._pending_progress_note == ("చాలా మంచి పురోగతి!", "Great progress!")
    assert "articles" in pipeline._learning.common_mistakes
    assert "Student level: A2" in pipeline.system_prompt


@pytest.mark.asyncio
async def test_classic_mode_still_uses_single_target_stt() -> None:
    pipeline = ConversationPipeline(
        llm=AsyncMock(),
        tts=AsyncMock(),
        stt=AsyncMock(),
        cefr_level="A1",
        native_language="te",
        target_language="en-GB",
        bilingual_mode_setting="off",
        native_tts=_native_tts(),
    )
    pipeline.stt.transcribe = AsyncMock(return_value="")

    await pipeline._process(b"audio", FakeWS())

    pipeline.stt.transcribe.assert_awaited_once_with(
        b"audio", "audio.wav", "audio/wav", language="en"
    )
    pipeline.stt.detect_language.assert_not_called()
    assert pipeline._native_tts is None


@pytest.mark.asyncio
async def test_bilingual_reply_text_is_published_before_any_audio() -> None:
    pipeline = _bilingual_pipeline(TELUGU_REPLY, native_tts=_native_tts(mixed_script=True))
    ws = FakeWS()

    await pipeline._process(b"audio", ws)

    kinds = [
        "assistant" if m[0] == "json" and m[1].get("role") == "assistant" else m[0]
        for m in ws.sent
        if m[0] == "bytes" or (m[0] == "json" and m[1].get("type") == "transcript")
    ]
    assert kinds.index("assistant") < kinds.index("bytes")
