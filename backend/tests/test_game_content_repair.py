"""Generated game candidates are repaired or trimmed before strict validation."""

import pytest
from pydantic import ValidationError

from app.schemas.games import (
    DetectiveContent,
    DetectiveReview,
    SentenceOrderContent,
    VocabularyPairsContent,
)


def draft(i: int, **overrides) -> dict:
    return {
        "correct_sentence": f"She goes to school on day {i}.",
        "answer": "goes",
        "mistake": "go",
        "wrong_options": ["going", "gone", "goed"],
        "explanation": "With she, the present simple takes -s.",
        "source_id": "grammar:present-simple",
        **overrides,
    }


def test_detective_draft_builds_the_full_challenge():
    content = DetectiveContent.model_validate({"challenges": [draft(i) for i in range(5)]})
    challenge = content.challenges[0]
    assert challenge.sentence == "She go to school on day 0."
    assert "".join(challenge.fragments) == challenge.sentence
    assert challenge.fragments[challenge.error_index] == "go "
    assert challenge.options[challenge.correct_index] == "goes "
    assert len({o.strip() for o in challenge.options}) == 3
    assert "go" not in {o.strip() for o in challenge.options}
    assert challenge.corrected_sentence == "She goes to school on day 0."


def test_detective_draft_skips_unusable_items_and_keeps_five():
    items = [
        draft(0, mistake="goes", wrong_options=["goes", "go"]),  # too few wrong forms
        draft(1, answer="walks"),  # answer not in the sentence
        draft(2, answer="have", mistake="have got", correct_sentence="I have a pen 2."),
        *[draft(i) for i in range(3, 9)],
    ]
    content = DetectiveContent.model_validate({"challenges": items})
    assert [c.sentence for c in content.challenges] == [
        f"She go to school on day {i}." for i in range(3, 8)
    ]


def test_detective_draft_uses_wrong_options_when_mistake_repeats_answer():
    items = [draft(i, mistake="goes") for i in range(5)]
    content = DetectiveContent.model_validate({"challenges": items})
    assert content.challenges[0].fragments[content.challenges[0].error_index] == "going "


def test_detective_draft_without_spaces():
    items = [
        draft(
            i,
            correct_sentence=f"私は{i}時に学校へ行きます。",
            answer="へ",
            mistake="を",
            wrong_options=["が", "の", "で"],
        )
        for i in range(5)
    ]
    challenge = DetectiveContent.model_validate({"challenges": items}).challenges[0]
    assert challenge.fragments[challenge.error_index] == "を"
    assert challenge.corrected_sentence == "私は0時に学校へ行きます。"


def test_detective_rebuilds_broken_fragments_from_both_sentences():
    item = {
        "sentence": "She go to school.",
        "fragments": ["She go to school"],
        "error_index": 3,
        "options": ["goes", "going", "gone"],
        "correct_index": 0,
        "corrected_sentence": "She goes to school.",
        "explanation": "With she, the present simple takes -s.",
        "source_id": "grammar:present-simple",
    }
    items = [
        {
            **item,
            "sentence": f"She go to school {i}.",
            "corrected_sentence": f"She goes to school {i}.",
        }
        for i in range(5)
    ]
    challenge = DetectiveContent.model_validate({"challenges": items}).challenges[0]
    assert challenge.fragments == ["She ", "go ", "to ", "school ", "0."]
    assert challenge.options[challenge.correct_index] == "goes "


def test_too_few_usable_detective_items_still_fail():
    with pytest.raises(ValidationError):
        DetectiveContent.model_validate({"challenges": [draft(i) for i in range(4)]})


def order(i: int, **overrides) -> dict:
    return {
        "sentence": f"I often walk to school {i}.",
        "clue": "Say that you often walk to school.",
        "fragments": ["I", "often", "walk", f"to school {i}"],
        "separator": " ",
        "accepted_orders": [[0, 1, 2, 3], [0, 2, 1, 3], [3, 0, 1, 2]],
        "explanation": "Frequency adverbs usually go before the main verb.",
        "source_id": "grammar:adverbs",
        **overrides,
    }


def test_sentence_order_reattaches_final_punctuation_and_keeps_alternatives():
    content = SentenceOrderContent.model_validate({"challenges": [order(i) for i in range(5)]})
    challenge = content.challenges[0]
    assert challenge.fragments == ["I", "often", "walk", "to school 0."]
    # The order that would move the final fragment away from the end is dropped.
    assert challenge.accepted_orders == [[0, 1, 2, 3], [0, 2, 1, 3]]


def test_sentence_order_falls_back_to_words():
    items = [order(i, fragments=["I", "walk"], accepted_orders=[[0, 1]]) for i in range(5)]
    challenge = SentenceOrderContent.model_validate({"challenges": items}).challenges[0]
    assert challenge.fragments == ["I", "often", "walk", "to", "school", "0."]
    assert challenge.accepted_orders == [[0, 1, 2, 3, 4, 5]]


def test_vocabulary_pairs_drop_duplicates_and_extras():
    pairs = [
        {
            "term": f"word{i}",
            "meaning": f"meaning {i}",
            "sentence": f"An example {i}.",
            "translation": f"A translation {i}.",
            "source_id": "vocabulary:set",
        }
        for i in range(6)
    ]
    content = VocabularyPairsContent.model_validate({"challenges": [pairs[0], *pairs]})
    assert [c.term for c in content.challenges] == [f"word{i}" for i in range(5)]


@pytest.mark.parametrize(
    ("data", "valid"),
    [
        ({"valid": True, "reason": "fine"}, True),
        ({"is_valid": "false", "explanation": "ambiguous"}, False),
        ({"review": {"approved": True, "reasons": ["clear", "natural"]}}, True),
    ],
)
def test_review_reads_common_shapes(data, valid):
    assert DetectiveReview.model_validate(data).valid is valid


def test_review_without_verdict_is_not_approved():
    with pytest.raises(ValidationError):
        DetectiveReview.model_validate({"reason": "looks good"})
