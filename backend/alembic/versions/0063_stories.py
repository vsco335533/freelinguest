"""Add story-based conversation: stories, paragraphs, per-plan progress, levels and tests.

Revision ID: 0063_stories
Revises: 0062_conversation_learning_state
"""

import sqlalchemy as sa

from alembic import op

revision = "0063_stories"
down_revision = "0062_conversation_learning_state"
branch_labels = None
depends_on = None


def _user_fk() -> sa.Column:
    return sa.Column(
        "user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )


def _plan_fk() -> sa.Column:
    return sa.Column(
        "study_plan_id",
        sa.Integer(),
        sa.ForeignKey("study_plans.id", ondelete="CASCADE"),
        nullable=False,
    )


def _story_fk() -> sa.Column:
    return sa.Column(
        "story_id", sa.Integer(), sa.ForeignKey("stories.id", ondelete="CASCADE"), nullable=False
    )


def upgrade() -> None:
    op.create_table(
        "stories",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("target_language", sa.String(length=10), nullable=False),
        sa.Column("cefr_level", sa.String(length=2), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_published", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_stories_target_language", "stories", ["target_language"])

    op.create_table(
        "story_paragraphs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        _story_fk(),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.UniqueConstraint("story_id", "position", name="uq_story_paragraph_position"),
    )
    op.create_index("ix_story_paragraphs_story_id", "story_paragraphs", ["story_id"])

    op.create_table(
        "story_progress",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        _user_fk(),
        _plan_fk(),
        _story_fk(),
        sa.Column("current_paragraph", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("paragraph_seconds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="in_progress"),
        sa.Column("best_score", sa.Integer(), nullable=True),
        sa.Column("test_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("passed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("study_plan_id", "story_id", name="uq_story_progress_plan_story"),
    )
    op.create_index("ix_story_progress_user_id", "story_progress", ["user_id"])
    op.create_index("ix_story_progress_study_plan_id", "story_progress", ["study_plan_id"])

    op.create_table(
        "story_levels",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        _user_fk(),
        _plan_fk(),
        sa.Column("cefr_level", sa.String(length=2), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("study_plan_id", name="uq_story_levels_plan"),
    )
    op.create_index("ix_story_levels_user_id", "story_levels", ["user_id"])

    op.create_table(
        "story_test_attempts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        _user_fk(),
        _plan_fk(),
        _story_fk(),
        sa.Column("questions", sa.JSON(), nullable=False),
        sa.Column("answers", sa.JSON(), nullable=True),
        sa.Column("results", sa.JSON(), nullable=True),
        sa.Column("score", sa.Integer(), nullable=True),
        sa.Column("passed", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("submitted_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_story_test_attempts_user_id", "story_test_attempts", ["user_id"])
    op.create_index("ix_story_test_attempts_story_id", "story_test_attempts", ["story_id"])


def downgrade() -> None:
    op.drop_index("ix_story_test_attempts_story_id", table_name="story_test_attempts")
    op.drop_index("ix_story_test_attempts_user_id", table_name="story_test_attempts")
    op.drop_table("story_test_attempts")
    op.drop_index("ix_story_levels_user_id", table_name="story_levels")
    op.drop_table("story_levels")
    op.drop_index("ix_story_progress_study_plan_id", table_name="story_progress")
    op.drop_index("ix_story_progress_user_id", table_name="story_progress")
    op.drop_table("story_progress")
    op.drop_index("ix_story_paragraphs_story_id", table_name="story_paragraphs")
    op.drop_table("story_paragraphs")
    op.drop_index("ix_stories_target_language", table_name="stories")
    op.drop_table("stories")
