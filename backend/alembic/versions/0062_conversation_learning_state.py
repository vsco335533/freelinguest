"""Add adaptive conversation learning state per study plan.

Revision ID: 0062_conversation_learning_state
Revises: 0061_conversation_bilingual_mode
"""

import sqlalchemy as sa

from alembic import op

revision = "0062_conversation_learning_state"
down_revision = "0061_conversation_bilingual_mode"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "conversation_learning_states",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "study_plan_id",
            sa.Integer(),
            sa.ForeignKey("study_plans.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("estimated_cefr", sa.String(length=2), nullable=False),
        sa.Column("exposure_stage", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("active_seconds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_active_seconds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("recent_performance", sa.JSON(), nullable=False),
        sa.Column("recent_utterances", sa.JSON(), nullable=False),
        sa.Column("learned_vocabulary", sa.JSON(), nullable=False),
        sa.Column("common_mistakes", sa.JSON(), nullable=False),
        sa.Column("recent_encouragements", sa.JSON(), nullable=False),
        sa.Column("last_assessment", sa.JSON(), nullable=True),
        sa.Column("last_assessment_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint(
            "study_plan_id", name="uq_conversation_learning_states_study_plan"
        ),
    )
    op.create_index(
        "ix_conversation_learning_states_user_id",
        "conversation_learning_states",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_conversation_learning_states_user_id", table_name="conversation_learning_states"
    )
    op.drop_table("conversation_learning_states")
