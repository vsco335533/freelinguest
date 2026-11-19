"""Learner endpoints for story-based conversation and story tests."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_active_study_plan, get_current_user
from app.core.limiter import limiter
from app.models.story import StoryTestAttempt
from app.models.study_plan import StudyPlan
from app.models.user import User
from app.schemas.stories import (
    StoryDetail,
    StoryList,
    StorySummary,
    StoryTest,
    StoryTestQuestion,
    StoryTestResult,
    StoryTestResultItem,
    StoryTestSubmit,
)
from app.services.language_helpers import (
    get_iso639,
    get_language_name,
    get_native_language_code,
    get_native_language_name,
)
from app.services.llm_adapter import LLMError, llm_adapter
from app.services.story_audio import schedule_prepare_story
from app.services.story_service import (
    PARAGRAPH_SECONDS,
    PASS_SCORE,
    STATE_LOCKED,
    STATE_PASSED,
    STATE_TEST_READY,
    StoryView,
    create_test_attempt,
    story_names,
    translation_key,
    get_story_view,
    list_story_views,
    public_questions,
    submit_test_attempt,
)

router = APIRouter(prefix="/api/stories", tags=["stories"])


def _summary(view: StoryView) -> dict:
    progress = view.progress
    return {
        "id": view.story.id,
        "title": view.story.title,
        "cefr_level": view.story.cefr_level,
        "paragraph_count": len(view.story.paragraphs),
        "state": view.state,
        "current_paragraph": progress.current_paragraph if progress else 0,
        "best_score": progress.best_score if progress else None,
    }


@router.get("", response_model=StoryList)
@limiter.limit("60/minute")
async def list_stories(
    request: Request,
    plan: StudyPlan = Depends(get_active_study_plan),
    db: AsyncSession = Depends(get_db),
) -> StoryList:
    level, views = await list_story_views(db, plan)
    await db.commit()
    return StoryList(
        level=level.cefr_level,
        pass_score=PASS_SCORE,
        paragraph_minutes=PARAGRAPH_SECONDS // 60,
        stories=[StorySummary(**_summary(v)) for v in views],
    )


async def _open_view(db: AsyncSession, plan: StudyPlan, story_id: int) -> StoryView:
    view = await get_story_view(db, plan, story_id)
    await db.commit()
    if view is None:
        raise HTTPException(status_code=404, detail="Story not found")
    if view.state == STATE_LOCKED:
        raise HTTPException(status_code=403, detail="story_locked")
    return view


@router.get("/{story_id}", response_model=StoryDetail)
@limiter.limit("60/minute")
async def get_story(
    request: Request,
    story_id: int,
    plan: StudyPlan = Depends(get_active_study_plan),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StoryDetail:
    view = await _open_view(db, plan, story_id)
    paragraphs = [p.text for p in view.story.paragraphs]
    seconds = 0
    if view.state in (STATE_PASSED, STATE_TEST_READY):
        reached = len(paragraphs)
    else:
        current = view.progress.current_paragraph if view.progress else 0
        reached = min(current, len(paragraphs) - 1) + 1
        seconds = view.progress.paragraph_seconds if view.progress else 0
    native = get_native_language_code(current_user.native_language)
    bilingual = native != get_iso639(plan.target_language)
    reached_rows = view.story.paragraphs[:reached]
    key = translation_key(native)
    translations = (
        [(p.translations or {}).get(key) for p in reached_rows]
        if bilingual
        else [None] * len(reached_rows)
    )
    # Prepare the whole story's speech and translations now, starting with the paragraph the
    # session opens with, so every reading plays without waiting or gaps.
    start_index = 0 if view.state == STATE_PASSED else reached - 1
    native_tts = getattr(request.app.state, "native_tts_service", None)
    tts = getattr(request.app.state, "tts_service", None)
    if tts is not None and 0 <= start_index < len(view.story.paragraphs):
        names = story_names(paragraphs)
        llm = llm_adapter.with_reasoning_effort(settings.OLLAMA_CONVERSATION_REASONING_EFFORT)
        voice_tts = native_tts if native_tts and native_tts.supports(native) else None
        schedule_prepare_story(
            [
                {
                    "paragraph_id": row.id,
                    "text": row.text,
                    "names": names,
                    "target_language": plan.target_language,
                    "native_code": native,
                    "native_name": get_native_language_name(current_user.native_language),
                    "voice": "",
                    "llm": llm,
                    "tts": tts,
                    "native_tts": voice_tts,
                    "translate": bilingual,
                }
                for row in view.story.paragraphs[start_index:]
            ]
        )
    return StoryDetail(
        **_summary(view),
        paragraphs=paragraphs[:reached],
        locked_lengths=[len(p) for p in paragraphs[reached:]],
        native_language=native,
        translations=translations,
        study_plan_id=plan.id,
        paragraph_seconds=seconds,
        required_seconds=PARAGRAPH_SECONDS,
    )


@router.post("/{story_id}/test", response_model=StoryTest)
@limiter.limit("10/minute")
async def start_story_test(
    request: Request,
    story_id: int,
    plan: StudyPlan = Depends(get_active_study_plan),
    db: AsyncSession = Depends(get_db),
) -> StoryTest:
    view = await _open_view(db, plan, story_id)
    if view.state not in (STATE_TEST_READY, STATE_PASSED):
        raise HTTPException(status_code=409, detail="story_not_finished")
    try:
        attempt = await create_test_attempt(
            db, plan, view.story, llm_adapter, get_language_name(plan.target_language)
        )
    except LLMError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="story_test_generation_failed"
        ) from None
    return StoryTest(
        attempt_id=attempt.id,
        story_id=story_id,
        pass_score=PASS_SCORE,
        questions=[StoryTestQuestion(**q) for q in public_questions(attempt.questions)],
    )


@router.post("/{story_id}/test/{attempt_id}", response_model=StoryTestResult)
@limiter.limit("10/minute")
async def submit_story_test(
    request: Request,
    story_id: int,
    attempt_id: int,
    data: StoryTestSubmit,
    plan: StudyPlan = Depends(get_active_study_plan),
    db: AsyncSession = Depends(get_db),
) -> StoryTestResult:
    attempt = await db.get(StoryTestAttempt, attempt_id)
    if (
        attempt is None
        or attempt.story_id != story_id
        or attempt.study_plan_id != plan.id
        or attempt.user_id != plan.user_id
    ):
        raise HTTPException(status_code=404, detail="Test not found")
    if attempt.submitted_at is not None:
        raise HTTPException(status_code=409, detail="test_already_submitted")
    outcome = await submit_test_attempt(
        db, plan, attempt, data.answers, llm_adapter, get_language_name(plan.target_language)
    )
    return StoryTestResult(
        score=outcome.score,
        passed=outcome.passed,
        pass_score=PASS_SCORE,
        level=outcome.level,
        level_up=outcome.level_up,
        next_story_id=outcome.next_story_id,
        results=[StoryTestResultItem(**r) for r in outcome.results],
    )
