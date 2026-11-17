from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class ConversationLearningState(Base):
    """Adaptive voice-tutor state, isolated per study plan (one learned language)."""

    __tablename__ = "conversation_learning_states"
    __table_args__ = (
        UniqueConstraint("study_plan_id", name="uq_conversation_learning_states_study_plan"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    study_plan_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("study_plans.id", ondelete="CASCADE"), nullable=False
    )
    estimated_cefr: Mapped[str] = mapped_column(String(2), nullable=False)
    exposure_stage: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    active_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_active_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    recent_performance: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    recent_utterances: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    learned_vocabulary: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    common_mistakes: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    recent_encouragements: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    last_assessment: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    last_assessment_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )
