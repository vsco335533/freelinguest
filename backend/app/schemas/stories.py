from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from app.schemas.auth import SUPPORTED_TARGET_LANGUAGES
from app.services.conversation_learning import CEFR_LEVELS

MAX_PARAGRAPHS = 50
MAX_PARAGRAPH_CHARS = 3000


# --- Admin ----------------------------------------------------------------------------


class StoryUpsert(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    target_language: str = "en-GB"
    cefr_level: str = "A1"
    position: int = Field(default=0, ge=0, le=100_000)
    is_published: bool = False
    paragraphs: list[str] = Field(min_length=1, max_length=MAX_PARAGRAPHS)

    @field_validator("title")
    @classmethod
    def strip_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title is required")
        return v

    @field_validator("target_language")
    @classmethod
    def check_language(cls, v: str) -> str:
        if v not in SUPPORTED_TARGET_LANGUAGES:
            raise ValueError("unsupported target language")
        return v

    @field_validator("cefr_level")
    @classmethod
    def check_level(cls, v: str) -> str:
        v = v.strip().upper()
        if v not in CEFR_LEVELS:
            raise ValueError("cefr_level must be A1-C2")
        return v

    @field_validator("paragraphs")
    @classmethod
    def check_paragraphs(cls, v: list[str]) -> list[str]:
        cleaned = [p.strip() for p in v if p and p.strip()]
        if not cleaned:
            raise ValueError("at least one paragraph is required")
        if any(len(p) > MAX_PARAGRAPH_CHARS for p in cleaned):
            raise ValueError(f"paragraphs are limited to {MAX_PARAGRAPH_CHARS} characters")
        return cleaned


class AdminStory(BaseModel):
    id: int
    title: str
    target_language: str
    cefr_level: str
    position: int
    is_published: bool
    paragraphs: list[str]


class AdminStorySummary(BaseModel):
    id: int
    title: str
    target_language: str
    cefr_level: str
    position: int
    is_published: bool
    paragraph_count: int


# --- Learner ----------------------------------------------------------------------------


class StorySummary(BaseModel):
    id: int
    title: str
    cefr_level: str
    paragraph_count: int
    state: str
    current_paragraph: int
    best_score: int | None


class StoryList(BaseModel):
    level: str
    pass_score: int
    paragraph_minutes: int
    stories: list[StorySummary]


class StoryDetail(StorySummary):
    # Paragraphs the learner has reached so far (never the unread rest of the story).
    paragraphs: list[str]
    study_plan_id: int
    paragraph_seconds: int
    required_seconds: int
    # Character counts of the paragraphs not reached yet (their text is never sent early).
    locked_lengths: list[int]
    # Cached native-language translations of the reached paragraphs (None when not ready).
    native_language: str
    translations: list[str | None]


class StoryTestQuestion(BaseModel):
    index: int
    type: str
    question: str
    options: list[str]


class StoryTest(BaseModel):
    attempt_id: int
    story_id: int
    pass_score: int
    questions: list[StoryTestQuestion]


class StoryTestSubmit(BaseModel):
    answers: list[str] = Field(max_length=20)


class StoryTestResultItem(BaseModel):
    index: int
    your_answer: str
    correct_answer: str
    correct: bool
    feedback: str


class StoryTestResult(BaseModel):
    score: int
    passed: bool
    pass_score: int
    level: str
    level_up: bool
    next_story_id: int | None
    results: list[StoryTestResultItem]
