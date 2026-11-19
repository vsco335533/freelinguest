"""Built-in English story library for story-based conversation (10 stories per level)."""

from app.data.stories import a1, a2, b1, b2, c1, c2

STORY_LIBRARY: dict[str, list[dict]] = {
    "A1": a1.STORIES,
    "A2": a2.STORIES,
    "B1": b1.STORIES,
    "B2": b2.STORIES,
    "C1": c1.STORIES,
    "C2": c2.STORIES,
}
