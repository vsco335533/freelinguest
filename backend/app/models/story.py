"""Story-based conversation: admin-authored stories and per-plan learner progress."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class Story(Base):
    """A story written in one learned (target) language at one CEFR level."""

    __tablename__ = "stories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    target_language: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    cefr_level: Mapped[str] = mapped_column(String(2), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_published: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    paragraphs: Mapped[list[StoryParagraph]] = relationship(
        back_populates="story",
        cascade="all, delete-orphan",
        order_by="StoryParagraph.position",
        lazy="selectin",
    )


class StoryParagraph(Base):
    __tablename__ = "story_paragraphs"
    __table_args__ = (UniqueConstraint("story_id", "position", name="uq_story_paragraph_position"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    story_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("stories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    # Cached translations into learners' native languages: {"te": "...", "hi": "..."}.
    translations: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    story: Mapped[Story] = relationship(back_populates="paragraphs")


class StoryProgress(Base):
    """One learner's progress through one story, isolated per study plan."""

    __tablename__ = "story_progress"
    __table_args__ = (
        UniqueConstraint("study_plan_id", "story_id", name="uq_story_progress_plan_story"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    study_plan_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("study_plans.id", ondelete="CASCADE"), nullable=False, index=True
    )
    story_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("stories.id", ondelete="CASCADE"), nullable=False
    )
    # 0-based index of the paragraph being discussed.
    current_paragraph: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    paragraph_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # in_progress -> test_ready (all paragraphs discussed) -> passed (test >= pass mark)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="in_progress")
    best_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    test_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    passed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )


class StoryLevel(Base):
    """The learner's story grade for one study plan; it rises one level at a time."""

    __tablename__ = "story_levels"
    __table_args__ = (UniqueConstraint("study_plan_id", name="uq_story_levels_plan"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    study_plan_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("study_plans.id", ondelete="CASCADE"), nullable=False
    )
    cefr_level: Mapped[str] = mapped_column(String(2), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )


class StoryTestAttempt(Base):
    __tablename__ = "story_test_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    study_plan_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("study_plans.id", ondelete="CASCADE"), nullable=False
    )
    story_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("stories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Questions include the answer key; it is never sent to the client before submission.
    questions: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    answers: Mapped[list | None] = mapped_column(JSON, nullable=True)
    results: Mapped[list | None] = mapped_column(JSON, nullable=True)
    score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
