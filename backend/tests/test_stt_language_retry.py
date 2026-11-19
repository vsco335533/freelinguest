"""Whisper auto-detect fallback: misdetected languages are re-transcribed as the base language."""

import httpx
import pytest

from app.services import stt_service
from app.services.stt_service import WhisperSTTService


def _patch_client(monkeypatch, responses: dict[str | None, dict], calls: list):
    def handler(request: httpx.Request) -> httpx.Response:
        lang = request.url.params.get("language")
        calls.append(lang)
        return httpx.Response(200, json=responses[lang])

    transport = httpx.MockTransport(handler)
    real = httpx.AsyncClient
    monkeypatch.setattr(stt_service.httpx, "AsyncClient", lambda *a, **k: real(transport=transport))


@pytest.mark.asyncio
async def test_misdetected_language_is_retranscribed_as_base_language(monkeypatch):
    calls: list = []
    _patch_client(
        monkeypatch,
        {
            None: {"text": "y en realidad", "language": "es"},
            "te": {"text": "నాకు అర్థం కాలేదు", "language": "te"},
        },
        calls,
    )
    text = await WhisperSTTService("http://stt").transcribe(
        b"audio", language=None, allowed_languages=("te", "en")
    )
    assert text == "నాకు అర్థం కాలేదు"
    assert calls == [None, "te"]


@pytest.mark.asyncio
async def test_allowed_detection_is_kept_without_retry(monkeypatch):
    calls: list = []
    _patch_client(monkeypatch, {None: {"text": "I like cricket.", "language": "en"}}, calls)
    text = await WhisperSTTService("http://stt").transcribe(
        b"audio", language=None, allowed_languages=("te", "en")
    )
    assert text == "I like cricket."
    assert calls == [None]


@pytest.mark.asyncio
async def test_forced_language_never_retries(monkeypatch):
    calls: list = []
    _patch_client(monkeypatch, {"en": {"text": "Hello.", "language": "en"}}, calls)
    assert await WhisperSTTService("http://stt").transcribe(b"audio", language="en") == "Hello."
    assert calls == ["en"]
