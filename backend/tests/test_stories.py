from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services import conversation_pipeline as pipeline_module
from app.services.conversation_pipeline import (
    STORY_CONTINUE_LINE,
    STORY_FINISHED_LINE,
    ConversationPipeline,
)
from app.services.prompts.tutor import build_conversation_system_prompt
from app.services.story_service import (
    MAX_TURN_SECONDS,
    PARAGRAPH_SECONDS,
    GeneratedQuestion,
    StorySession,
    compute_story_states,
    fallback_short_grade,
    next_level,
    public_questions,
    should_raise_level,
    validate_quiz,
)


def _story(story_id: int, level: str, position: int = 0) -> SimpleNamespace:
    return SimpleNamespace(id=story_id, cefr_level=level, position=position)


def _states(stories, progress, level) -> dict[int, str]:
    return {v.story.id: v.state for v in compute_story_states(stories, progress, level)}


# --- Unlock rules --------------------------------------------------------------------


def test_stories_open_one_at_a_time_at_the_learner_level() -> None:
    stories = [_story(1, "A1", 0), _story(2, "A1", 1), _story(3, "A1", 2), _story(4, "A2")]
    assert _states(stories, {}, "A1") == {1: "available", 2: "locked", 3: "locked", 4: "locked"}


def test_passing_a_story_unlocks_the_next_one() -> None:
    stories = [_story(1, "A1", 0), _story(2, "A1", 1), _story(3, "A1", 2)]
    progress = {1: SimpleNamespace(status="passed")}
    assert _states(stories, progress, "A1") == {1: "passed", 2: "available", 3: "locked"}


def test_finished_but_untested_story_keeps_the_next_one_locked() -> None:
    stories = [_story(1, "A1", 0), _story(2, "A1", 1)]
    progress = {1: SimpleNamespace(status="test_ready")}
    assert _states(stories, progress, "A1") == {1: "test_ready", 2: "locked"}


def test_lower_levels_stay_open_and_started_stories_stay_open() -> None:
    stories = [_story(1, "A1"), _story(2, "A2", 0), _story(3, "A2", 1), _story(4, "B1")]
    progress = {4: SimpleNamespace(status="in_progress")}
    assert _states(stories, progress, "A2") == {
        1: "available",
        2: "available",
        3: "locked",
        4: "in_progress",
    }


def test_learner_without_stories_at_their_level_gets_the_lowest_higher_level() -> None:
    stories = [_story(1, "B1", 0), _story(2, "B1", 1), _story(3, "B2")]
    assert _states(stories, {}, "A1") == {1: "available", 2: "locked", 3: "locked"}


# --- Story grade -------------------------------------------------------------------


def test_level_rises_slowly() -> None:
    assert not should_raise_level([95, 90], stories_at_level=5)
    assert not should_raise_level([75, 80, 78], stories_at_level=5)  # average below 80
    assert should_raise_level([85, 80, 90], stories_at_level=5)
    assert should_raise_level([70, 72], stories_at_level=2)  # every story at the level passed
    assert not should_raise_level([], stories_at_level=0)


def test_next_level_stops_at_c2() -> None:
    assert next_level("A1") == "A2"
    assert next_level("C2") == "C2"


# --- Story test --------------------------------------------------------------------


def test_quiz_validation_keeps_only_answerable_questions() -> None:
    questions = [
        GeneratedQuestion(
            type="choice", question="Who?", options=["Tom", "Ann", "Bob", "Sue"], answer="Tom"
        ),
        GeneratedQuestion(type="choice", question="Where?", options=["a", "b"], answer="a"),
        GeneratedQuestion(type="choice", question="When?", options=["x", "y", "z"], answer="w"),
        GeneratedQuestion(type="short", question="Why?", answer="Because he was hungry"),
        GeneratedQuestion(type="essay", question="Discuss", answer="..."),
    ]
    valid = validate_quiz(questions)
    assert [q["question"] for q in valid] == ["Who?", "Why?"]
    public = public_questions(valid)
    assert all("answer" not in q for q in public)


def test_short_answer_fallback_grading_tolerates_small_mistakes() -> None:
    assert fallback_short_grade("he was hungry", "He was hungry.")
    assert fallback_short_grade("he was hungy", "He was hungry")
    assert not fallback_short_grade("", "He was hungry")
    assert not fallback_short_grade("the dog", "He was hungry")


# --- Story session timing ----------------------------------------------------------


def test_story_session_counts_capped_turn_time() -> None:
    session = StorySession(story_id=1, progress_id=1, title="T", paragraphs=["a", "b"])
    session.add_turn_seconds(MAX_TURN_SECONDS * 10)
    assert session.seconds == MAX_TURN_SECONDS
    session.seconds = PARAGRAPH_SECONDS
    assert session.paragraph_done()
    session.advance()
    assert (session.index, session.seconds, session.is_last) == (1, 0.0, True)


def test_story_prompt_keeps_the_conversation_on_the_story() -> None:
    session = StorySession(
        story_id=1, progress_id=1, title="The Lost Cat", paragraphs=["Mia lost her cat."]
    )
    prompt = build_conversation_system_prompt(
        student_name="Krishna",
        cefr_level="A1",
        native_language="Telugu",
        target_language_name="English (UK)",
        user_context="",
        memory_context="",
        memory_tools_enabled=False,
        story_context=session.prompt_context(),
    )
    assert "Talk ONLY about the current paragraph" in prompt
    assert "Never invent events" in prompt
    assert "Mia lost her cat." in prompt


# --- Pipeline story mode -----------------------------------------------------------


class FakeWS:
    def __init__(self) -> None:
        self.json: list[dict] = []
        self.bytes: list[bytes] = []

    async def send_json(self, data: dict) -> None:
        self.json.append(data)

    async def send_bytes(self, data: bytes) -> None:
        self.bytes.append(data)


def _story_pipeline(
    paragraphs: list[str], monkeypatch: pytest.MonkeyPatch, translation: str | None = None
):
    session = StorySession(
        story_id=7,
        progress_id=3,
        title="The Lost Cat",
        paragraphs=paragraphs,
        paragraph_ids=list(range(100, 100 + len(paragraphs))),
    )
    save = AsyncMock()
    monkeypatch.setattr(pipeline_module, "save_story_session", save)
    monkeypatch.setattr(
        pipeline_module, "get_paragraph_translation", AsyncMock(return_value=translation)
    )
    monkeypatch.setattr(pipeline_module, "cached_audio", AsyncMock(return_value=b"mp3"))
    monkeypatch.setattr(pipeline_module, "schedule_prepare", lambda **_kwargs: None)
    pipeline = ConversationPipeline(
        llm=AsyncMock(),
        tts=AsyncMock(),
        stt=AsyncMock(),
        cefr_level="A1",
        native_language="te",
        target_language="en-GB",
        bilingual_mode_setting="auto",
        story=session,
    )
    pipeline.tts.synthesize = AsyncMock(return_value=b"mp3")
    pipeline._greet = AsyncMock()
    return pipeline, session, save


@pytest.mark.asyncio
async def test_paragraph_stays_until_seven_minutes(monkeypatch: pytest.MonkeyPatch) -> None:
    pipeline, session, save = _story_pipeline(["one.", "two."], monkeypatch)
    pipeline._story_mark = time.monotonic() - 60

    assert not await pipeline._advance_story_if_due(FakeWS(), 1)
    assert session.index == 0
    assert 59 <= session.seconds <= 61


@pytest.mark.asyncio
async def test_after_seven_minutes_the_next_paragraph_is_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, session, save = _story_pipeline(["Mia lost her cat.", "She found it."], monkeypatch)
    session.seconds = PARAGRAPH_SECONDS - 5
    pipeline._story_mark = time.monotonic() - 30
    ws = FakeWS()

    assert await pipeline._advance_story_if_due(ws, 4)

    assert session.index == 1 and session.seconds == 0
    texts = [m.get("text") for m in ws.json if m.get("type") == "transcript"]
    # Bilingual (Telugu) learners hear the linking line in Telugu first, then in English.
    (line,) = texts
    assert line.startswith("సరే") and line.endswith(STORY_CONTINUE_LINE)
    (paragraph,) = [m for m in ws.json if m.get("type") == "story_paragraph"]
    assert (paragraph["index"], paragraph["text"]) == (1, "She found it.")
    assert ws.bytes  # the paragraph is read aloud
    assert "She found it." in pipeline._prompt_args["story_context"]
    pipeline._greet.assert_awaited_once()
    assert ws.json[-1] == {"type": "turn_complete", "turn_id": 4}


@pytest.mark.asyncio
async def test_last_paragraph_completes_the_story(monkeypatch: pytest.MonkeyPatch) -> None:
    pipeline, session, save = _story_pipeline(["Only paragraph."], monkeypatch)
    session.seconds = PARAGRAPH_SECONDS
    ws = FakeWS()

    assert await pipeline._advance_story_if_due(ws, 9)

    save.assert_awaited_with(session, completed=True)
    assert {"type": "story_complete", "story_id": 7, "replay": False} in ws.json
    assert any(STORY_FINISHED_LINE in (m.get("text") or "") for m in ws.json)
    # The story never advances again in this session.
    assert not await pipeline._advance_story_if_due(ws, 10)


# --- Built-in story library --------------------------------------------------------


def test_story_library_has_ten_stories_per_level() -> None:
    from app.data.stories import STORY_LIBRARY
    from app.schemas.stories import MAX_PARAGRAPH_CHARS
    from app.services.conversation_learning import CEFR_LEVELS

    assert list(STORY_LIBRARY) == list(CEFR_LEVELS)
    titles = [story["title"] for stories in STORY_LIBRARY.values() for story in stories]
    assert len(titles) == len(set(titles)) == 60
    for stories in STORY_LIBRARY.values():
        assert len(stories) == 10
        for story in stories:
            assert story["paragraphs"]
            assert all(0 < len(p) <= MAX_PARAGRAPH_CHARS for p in story["paragraphs"])


@pytest.mark.asyncio
async def test_seed_skips_stories_that_already_exist() -> None:
    from app.services.story_seed import seed_stories

    class FakeResult:
        def __init__(self, rows: list) -> None:
            self._rows = rows

        def all(self) -> list:
            return self._rows

    added: list = []
    db = SimpleNamespace(
        execute=AsyncMock(return_value=FakeResult([("The Lost Cat",)])),
        add=added.append,
        commit=AsyncMock(),
    )

    created, skipped = await seed_stories(db)

    assert (created, skipped) == (59, 1)
    assert all(s.is_published and s.target_language == "en-GB" for s in added)
    assert {s.cefr_level for s in added} == {"A1", "A2", "B1", "B2", "C1", "C2"}


@pytest.mark.asyncio
async def test_bilingual_learner_gets_the_paragraph_in_their_language(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, session, _save = _story_pipeline(
        ["Mia lost her cat.", "She found it."],
        monkeypatch,
        translation="మియా తన పిల్లిని పోగొట్టుకుంది.",
    )
    ws = FakeWS()

    await pipeline._present_story_paragraph(ws, turn_id=1, continuing=False)

    kinds = [m["type"] for m in ws.json if m["type"].startswith("story_")]
    assert kinds == ["story_paragraph", "story_translation"]
    (translation,) = [m for m in ws.json if m["type"] == "story_translation"]
    assert (translation["language"], translation["index"]) == ("te", 0)
    assert session.translations[0] == "మియా తన పిల్లిని పోగొట్టుకుంది."
    assert "current_paragraph_native_translation" in pipeline._prompt_args["story_context"]


def test_story_prompt_teaches_and_corrects() -> None:
    session = StorySession(story_id=1, progress_id=1, title="T", paragraphs=["Mia lost her cat."])
    common = {
        "student_name": "Krishna",
        "cefr_level": "A1",
        "target_language_name": "English (UK)",
        "user_context": "",
        "memory_context": "",
        "memory_tools_enabled": False,
        "story_context": session.prompt_context(),
    }
    classic = build_conversation_system_prompt(native_language="English", **common)
    assert "TEACH IN EVERY REPLY" in classic
    assert "say the correct full sentence" in classic
    bilingual = build_conversation_system_prompt(
        native_language="Telugu", bilingual_mode=True, **common
    )
    assert "When they answer in Telugu" in bilingual
    assert "explain the mistake in a few words in Telugu" in bilingual


# --- Names stay unchanged in translations ------------------------------------------


def test_story_names_finds_names_but_not_sentence_starts() -> None:
    from app.services.story_service import story_names

    paragraphs = [
        'Mia has a small grey cat. Her name is Coco. Every morning, Coco waits.',
        'She calls, "Coco! Coco!" Her neighbour, Mr Shah, helps her. But nobody finds it.',
    ]
    names = story_names(paragraphs)
    assert {"Coco", "Mr Shah"} <= set(names)
    assert not {"Every", "But", "She", "Her"} & set(names)
    assert names.index("Mr Shah") < names.index("Coco")  # longest first


def test_names_are_protected_and_restored() -> None:
    from app.services.story_service import protect_names, restore_names

    masked, mapping = protect_names('She calls, "Coco! Coco!" Mr Shah helps.', ["Mr Shah", "Coco"])
    assert "Coco" not in masked and "Shah" not in masked
    translated = masked.replace("She calls", "ఆమె పిలుస్తుంది")
    restored, complete = restore_names(translated, mapping)
    assert complete
    assert "Coco! Coco!" in restored and "Mr Shah" in restored


@pytest.mark.asyncio
async def test_translation_retries_when_a_name_token_is_lost() -> None:
    from app.services.story_service import _translate

    llm = AsyncMock()
    llm.chat = AsyncMock(side_effect=["కోటు! కోటు!", "[[N1]]! [[N1]]!"])

    text = await _translate("Coco! Coco!", ["Coco"], "Telugu", llm)

    assert text == "Coco! Coco!"
    assert llm.chat.await_count == 2


def test_first_story_question_is_asked_in_the_native_language(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, session, _save = _story_pipeline(["Mia lost her cat.", "She found it."], monkeypatch)
    session.index = 1

    trigger = pipeline._story_question_trigger(session)

    assert "Write REPLY in Telugu" in trigger
    assert "THIS paragraph only" in trigger
    assert '"She found it."' in trigger



# --- No repeated questions; nothing after the story ends ----------------------------


def test_asked_questions_are_remembered_and_reset_per_paragraph() -> None:
    session = StorySession(story_id=1, progress_id=1, title="T", paragraphs=["a.", "b."])
    session.questions[0] = ["Who is Mia?", "Where is Coco?"]
    session.remember_questions("Well done! Who is Mia? Great.")
    session.remember_questions("Who is Mia?")  # the same question is stored once

    assert session.asked == ["Who is Mia?"]
    context = session.prompt_context()
    assert "questions_already_asked" in context and "question_ideas" in context

    session.advance()
    assert session.asked == []


@pytest.mark.asyncio
async def test_audio_is_ignored_after_the_story_finished(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline, _session, _save = _story_pipeline(["Only paragraph."], monkeypatch)
    pipeline._story_finished = True

    await pipeline.handle_audio(b"audio", FakeWS())

    assert pipeline.current_task is None
    pipeline.stt.transcribe.assert_not_called()


def test_story_prompt_forbids_repeated_and_boring_questions() -> None:
    session = StorySession(story_id=1, progress_id=1, title="T", paragraphs=["Mia lost her cat."])
    prompt = build_conversation_system_prompt(
        student_name="Krishna",
        cefr_level="A1",
        native_language="Telugu",
        target_language_name="English (UK)",
        user_context="",
        memory_context="",
        memory_tools_enabled=False,
        bilingual_mode=True,
        story_context=session.prompt_context(),
    )
    assert "NEVER ask a question from questions_already_asked again" in prompt
    assert "Never ask whether they want to know what happens next" in prompt
    assert "Celebrate every attempt" in prompt
