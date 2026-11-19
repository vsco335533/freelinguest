"""Voice-latency behaviour: early sentence cutting, no hidden thinking, no repeated replies."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services.conversation_pipeline import ConversationPipeline
from tests.test_llm_adapter import FakeOpenAIChunk, FakeUsage, _make_ollama_settings


@pytest.mark.parametrize(
    ("text", "expected", "rest"),
    [
        ("Hello! How are you? I am", ["Hello!", " How are you?"], " I am"),
        # A full stop inside [native help] or (romanization) never ends a sentence.
        ("Great. [చాలా బాగుంది. సరే.] Next", ["Great."], " [చాలా బాగుంది. సరే.] Next"),
        ("Ayyo (Ayyo. nenu.) Sorry. ", ["Ayyo (Ayyo. nenu.) Sorry."], " "),
        # Ellipses and decimals stay inside their sentence.
        ("Well... let's go. It costs 3.50 now", ["Well... let's go."], " It costs 3.50 now"),
        # Punctuation at the very end is not yet known to end the sentence.
        ("Nearly done.", [], "Nearly done."),
    ],
)
def test_take_complete_sentences(text, expected, rest):
    sentences, offset = ConversationPipeline._take_complete_sentences(text, 0)
    assert sentences == expected
    assert text[offset:] == rest


def test_take_complete_sentences_resumes_from_offset():
    text = "One. Two. Three"
    first, offset = ConversationPipeline._take_complete_sentences(text, 0)
    assert first == ["One.", " Two."]
    second, offset = ConversationPipeline._take_complete_sentences(text + ". Four", offset)
    assert second == [" Three."]


def _tool_chunk():
    function = SimpleNamespace(name="save_user_memory", arguments='{"content":"Likes cricket"}')
    tool_call = SimpleNamespace(index=0, id="call_1", function=function)
    delta = SimpleNamespace(content=None, tool_calls=[tool_call])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)], usage=None)


async def _run_tool_turn(monkeypatch, continuation_parts: list[str]) -> tuple[list[str], object]:
    _make_ollama_settings(monkeypatch)
    from app.services.llm_adapter import LLMAdapter, LLMTool, LLMToolResult, LLMToolResultEvent

    async def initial_stream():
        yield FakeOpenAIChunk("Cricket is great! ")
        yield FakeOpenAIChunk("Who is your favourite player?")
        yield _tool_chunk()
        yield FakeOpenAIChunk(None, usage=FakeUsage(10, 3))

    async def continuation_stream():
        for part in continuation_parts:
            yield FakeOpenAIChunk(part)

    async def executor(call):
        return LLMToolResult(call=call, content={"saved": True})

    adapter = LLMAdapter()
    with patch.object(
        adapter.client.chat.completions,
        "create",
        new_callable=AsyncMock,
        side_effect=[initial_stream(), continuation_stream()],
    ) as create:
        stream = await adapter.chat(
            [{"role": "user", "content": "I like cricket"}],
            stream=True,
            tools=[LLMTool("save_user_memory", "Save memory", {"type": "object"})],
            tool_executor=executor,
        )
        parts = [p async for p in stream if not isinstance(p, LLMToolResultEvent)]
    return parts, create


async def test_tool_continuation_repeating_reply_is_dropped(monkeypatch):
    parts, _ = await _run_tool_turn(
        monkeypatch, ["Cricket is ", "great! Who is your ", "favourite player?"]
    )
    assert "".join(parts) == "Cricket is great! Who is your favourite player?"


async def test_tool_continuation_keeps_new_text_after_repeat(monkeypatch):
    parts, _ = await _run_tool_turn(
        monkeypatch, ["Cricket is great! Who is your favourite player?", " I'll remember it."]
    )
    assert "".join(parts) == "Cricket is great! Who is your favourite player? I'll remember it."


async def test_tool_continuation_with_different_text_passes_through(monkeypatch):
    parts, _ = await _run_tool_turn(monkeypatch, ["Noted!"])
    assert "".join(parts) == "Cricket is great! Who is your favourite player?Noted!"


async def test_streamed_ollama_requests_disable_thinking(monkeypatch):
    _make_ollama_settings(monkeypatch)
    from app.services.llm_adapter import LLMAdapter

    async def stream():
        yield FakeOpenAIChunk("Hi")

    adapter = LLMAdapter()
    with patch.object(
        adapter.client.chat.completions, "create", new_callable=AsyncMock, return_value=stream()
    ) as create:
        await adapter.chat([{"role": "user", "content": "Hi"}], stream=True)
    assert create.call_args.kwargs["extra_body"] == {"reasoning_effort": "none"}


async def test_non_streamed_ollama_requests_keep_default_thinking(monkeypatch):
    _make_ollama_settings(monkeypatch)
    from app.services.llm_adapter import LLMAdapter

    message = SimpleNamespace(content="Hello")
    response = SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)
    adapter = LLMAdapter()
    with patch.object(
        adapter.client.chat.completions, "create", new_callable=AsyncMock, return_value=response
    ) as create:
        await adapter.chat([{"role": "user", "content": "Hi"}])
    assert "extra_body" not in create.call_args.kwargs


@pytest.mark.parametrize(
    ("text", "native", "expected"),
    [
        (
            "Cricket is great. [క్రికెట్ అద్భుతం.] Who is your favourite? [మీకు ఎవరు ఇష్టం?]",
            "te",
            [
                ("Cricket is great.", False),
                ("క్రికెట్ అద్భుతం.", True),
                ("Who is your favourite?", False),
                ("మీకు ఎవరు ఇష్టం?", True),
            ],
        ),
        # Loose base-language text is spoken natively; its romanization is dropped.
        (
            "అయ్యో, నేను చెప్పలేకపోయాను. (Ayyo, nenu cheppalekapoyanu.) Your name?",
            "te",
            [("అయ్యో, నేను చెప్పలేకపోయాను.", True), ("Your name?", False)],
        ),
        # Latin-script base languages are only split at [brackets].
        (
            "Great job! [¡Buen trabajo!] Next one.",
            "es",
            [("Great job!", False), ("¡Buen trabajo!", True), ("Next one.", False)],
        ),
    ],
)
def test_speech_parts_split_reply_between_voices(text, native, expected):
    from app.services.conversation_pipeline import _speech_parts

    assert _speech_parts(text, native, "en-GB") == expected


class _FakeMultilingual:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[tuple[str, str]] = []

    async def synthesize(self, text: str, language: str) -> bytes:
        self.calls.append((text, language))
        if self.error is not None:
            raise self.error
        return b"native-audio"


def _kokoro_post_recorder(monkeypatch) -> list[dict]:
    import httpx

    posted: list[dict] = []

    async def fake_post(self, url, json=None, timeout=None, **kwargs):
        posted.append({"json": json, "timeout": timeout})
        return httpx.Response(200, content=b"kokoro-audio", request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    return posted


async def test_target_languages_use_their_own_voice_not_kokoro(monkeypatch):
    from app.services.tts_service import KokoroTTSService

    posted = _kokoro_post_recorder(monkeypatch)
    native = _FakeMultilingual()
    service = KokoroTTSService("http://kokoro", "af_heart", multilingual=native)

    assert await service.synthesize("Guten Tag", language="de-DE") == b"native-audio"
    assert native.calls == [("Guten Tag", "de-DE")]
    assert posted == []


async def test_english_stays_on_kokoro_with_british_voice_for_en_gb(monkeypatch):
    from app.services.tts_service import KokoroTTSService

    posted = _kokoro_post_recorder(monkeypatch)
    native = _FakeMultilingual()
    service = KokoroTTSService("http://kokoro", "af_heart", multilingual=native)

    await service.synthesize("Hello", language="en-GB")
    await service.synthesize("Hello", language="en-US")
    assert [p["json"]["voice"] for p in posted] == ["bf_emma", "af_heart"]
    assert native.calls == []


async def test_falls_back_to_kokoro_only_when_voice_service_is_down(monkeypatch):
    import httpx

    from app.services.tts_service import KokoroTTSService

    posted = _kokoro_post_recorder(monkeypatch)
    down = KokoroTTSService(
        "http://kokoro", "af_heart", multilingual=_FakeMultilingual(httpx.ConnectError("down"))
    )
    assert await down.synthesize("Hola", language="es-ES") == b"kokoro-audio"

    slow = KokoroTTSService(
        "http://kokoro", "af_heart", multilingual=_FakeMultilingual(httpx.ReadTimeout("slow"))
    )
    with pytest.raises(httpx.ReadTimeout):
        await slow.synthesize("你好", language="zh-CN")
    assert len(posted) == 1


async def test_long_listening_text_gets_a_longer_timeout(monkeypatch):
    from app.services.tts_service import KokoroTTSService

    posted = _kokoro_post_recorder(monkeypatch)
    service = KokoroTTSService("http://kokoro", "af_heart")
    await service.synthesize("Hi", language="en-US")
    await service.synthesize("word " * 600, language="en-US")
    assert posted[0]["timeout"] < 31
    assert posted[1]["timeout"] >= 600
