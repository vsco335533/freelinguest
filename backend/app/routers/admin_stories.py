"""Admin management of stories for story-based conversation."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import require_admin
from app.core.limiter import limiter
from app.models.story import Story, StoryParagraph
from app.models.user import User
from app.schemas.stories import AdminStory, AdminStorySummary, StoryUpsert
from app.services.story_service import story_sort_key

router = APIRouter(prefix="/api/admin/stories", tags=["admin"])


def _full(story: Story) -> AdminStory:
    return AdminStory(
        id=story.id,
        title=story.title,
        target_language=story.target_language,
        cefr_level=story.cefr_level,
        position=story.position,
        is_published=story.is_published,
        paragraphs=[p.text for p in story.paragraphs],
    )


async def _get(db: AsyncSession, story_id: int) -> Story:
    story = await db.get(Story, story_id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    return story


@router.get("", response_model=list[AdminStorySummary])
@limiter.limit("60/minute")
async def list_admin_stories(
    request: Request,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[AdminStorySummary]:
    stories = (await db.execute(select(Story))).scalars().all()
    return [
        AdminStorySummary(
            id=s.id,
            title=s.title,
            target_language=s.target_language,
            cefr_level=s.cefr_level,
            position=s.position,
            is_published=s.is_published,
            paragraph_count=len(s.paragraphs),
        )
        for s in sorted(stories, key=lambda s: (s.target_language, *story_sort_key(s)))
    ]


@router.get("/{story_id}", response_model=AdminStory)
@limiter.limit("60/minute")
async def get_admin_story(
    request: Request,
    story_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminStory:
    return _full(await _get(db, story_id))


@router.post("", response_model=AdminStory, status_code=status.HTTP_201_CREATED)
@limiter.limit("30/minute")
async def create_story(
    request: Request,
    data: StoryUpsert,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminStory:
    story = Story(
        title=data.title,
        target_language=data.target_language,
        cefr_level=data.cefr_level,
        position=data.position,
        is_published=data.is_published,
        paragraphs=[StoryParagraph(position=i, text=t) for i, t in enumerate(data.paragraphs)],
    )
    db.add(story)
    await db.commit()
    await db.refresh(story, attribute_names=["paragraphs"])
    return _full(story)


@router.put("/{story_id}", response_model=AdminStory)
@limiter.limit("30/minute")
async def update_story(
    request: Request,
    story_id: int,
    data: StoryUpsert,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminStory:
    story = await _get(db, story_id)
    story.title = data.title
    story.target_language = data.target_language
    story.cefr_level = data.cefr_level
    story.position = data.position
    story.is_published = data.is_published
    # Replace paragraphs; flush the removal first so positions can be reused.
    story.paragraphs.clear()
    await db.flush()
    story.paragraphs.extend(
        StoryParagraph(position=i, text=t) for i, t in enumerate(data.paragraphs)
    )
    await db.commit()
    await db.refresh(story, attribute_names=["paragraphs"])
    return _full(story)


@router.delete("/{story_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("30/minute")
async def delete_story(
    request: Request,
    story_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> Response:
    await db.delete(await _get(db, story_id))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
