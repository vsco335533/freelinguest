"""Cache native-language translations of story paragraphs.

Revision ID: 0064_story_translations
Revises: 0063_stories
"""

import sqlalchemy as sa

from alembic import op

# alembic_version.version_num is VARCHAR(32): revision ids must stay within 32 characters.
revision = "0064_story_translations"
down_revision = "0063_stories"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("story_paragraphs", sa.Column("translations", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("story_paragraphs", "translations")
