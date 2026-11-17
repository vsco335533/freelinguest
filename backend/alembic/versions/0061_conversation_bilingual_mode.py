"""Add conversation bilingual mode to users.

Revision ID: 0061_conversation_bilingual_mode
Revises: 0060_checkout_customer_request
"""

import sqlalchemy as sa

from alembic import op

revision = "0061_conversation_bilingual_mode"
down_revision = "0060_checkout_customer_request"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "conversation_bilingual_mode",
            sa.String(length=10),
            nullable=False,
            server_default="auto",
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "conversation_bilingual_mode")
