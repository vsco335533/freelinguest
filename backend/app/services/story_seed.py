"""Load the built-in story library into the database.

Run inside the backend container:

    python -m app.services.story_seed            # load as published stories
    python -m app.services.story_seed --draft    # load as unpublished drafts

Stories that already exist (same title and language) are skipped, so the command is safe
to run more than once. Admins can edit, unpublish or delete them afterwards.
"""

from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.data.stories import STORY_LIBRARY
from app.models.story import Story, StoryParagraph

DEFAULT_LANGUAGE = "en-GB"


async def seed_stories(
    db: AsyncSession, *, language: str = DEFAULT_LANGUAGE, publish: bool = True
) -> tuple[int, int]:
    """Insert library stories that are missing. Returns (created, skipped)."""
    existing = {
        title
        for (title,) in (
            await db.execute(select(Story.title).where(Story.target_language == language))
        ).all()
    }
    created = skipped = 0
    for level, stories in STORY_LIBRARY.items():
        for position, story in enumerate(stories):
            if story["title"] in existing:
                skipped += 1
                continue
            db.add(
                Story(
                    title=story["title"],
                    target_language=language,
                    cefr_level=level,
                    position=position,
                    is_published=publish,
                    paragraphs=[
                        StoryParagraph(position=i, text=text)
                        for i, text in enumerate(story["paragraphs"])
                    ],
                )
            )
            created += 1
    await db.commit()
    return created, skipped


async def _main(publish: bool) -> None:
    from app.core.database import AsyncSessionLocal  # noqa: PLC0415

    async with AsyncSessionLocal() as db:
        created, skipped = await seed_stories(db, publish=publish)
    state = "published" if publish else "draft"
    print(f"Stories created: {created} ({state}); already present: {skipped}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Load the built-in story library.")
    parser.add_argument("--draft", action="store_true", help="load stories unpublished")
    asyncio.run(_main(publish=not parser.parse_args().draft))
