import difflib
import re
import unicodedata
import zlib
from collections.abc import Callable
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError, model_validator

GameMode = Literal["review", "prepare", "free"]
GameType = Literal["detective", "sentence-order", "vocabulary-pairs"]


class VocabularyPairAnswer(BaseModel):
    step: Literal["match"]
    attempt: int = Field(strict=True, ge=0, le=24)
    challenge: int = Field(strict=True, ge=0, le=4)
    choice: int = Field(strict=True, ge=0, le=4)


class VocabularyPair(BaseModel):
    term: str = Field(min_length=1, max_length=200)
    meaning: str = Field(min_length=1, max_length=300)
    sentence: str = Field(min_length=3, max_length=500)
    translation: str = Field(min_length=3, max_length=500)
    source_id: str = Field(min_length=1, max_length=100)


def _normalized(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().casefold()


def _salvage_challenges(
    data: Any,
    model: type[BaseModel],
    keys: Callable[[BaseModel], tuple[str, ...]],
    rebuild: Callable[[dict], dict | None] | None = None,
) -> Any:
    """Keep the first five valid, distinct challenges of a generated candidate.

    Small local models often add an extra challenge, or get the mechanical structure
    (fragments, indices) of one challenge wrong while the language itself is fine. Each
    challenge is validated on its own; an invalid one is rebuilt from its sentences when
    possible and otherwise dropped. With fewer than five usable challenges the candidate is
    returned unchanged, so the normal validation error is reported and the request retried.
    """
    if not isinstance(data, dict) or not isinstance(data.get("challenges"), list):
        return data
    kept: list[BaseModel] = []
    seen: list[set[str]] = []
    for item in data["challenges"]:
        challenge = None
        try:
            challenge = model.model_validate(item)
        except ValidationError:
            repaired = rebuild(item) if rebuild and isinstance(item, dict) else None
            if repaired is not None:
                try:
                    challenge = model.model_validate(repaired)
                except ValidationError:
                    challenge = None
        if challenge is None:
            continue
        values = keys(challenge)
        if not seen:
            seen = [set() for _ in values]
        if any(value in seen[i] for i, value in enumerate(values)):
            continue
        for i, value in enumerate(values):
            seen[i].add(value)
        kept.append(challenge)
    if len(kept) < 5:
        return data
    return {**data, "challenges": kept[:5]}


class VocabularyPairsContent(BaseModel):
    challenges: list[VocabularyPair] = Field(min_length=5, max_length=5)

    @model_validator(mode="before")
    @classmethod
    def salvage(cls, data: Any) -> Any:
        return _salvage_challenges(
            data, VocabularyPair, lambda c: (_normalized(c.term), _normalized(c.meaning))
        )

    @model_validator(mode="after")
    def distinct_pairs(self) -> Self:
        for field in ("term", "meaning"):
            values = [
                unicodedata.normalize("NFKC", getattr(c, field)).strip().casefold()
                for c in self.challenges
            ]
            if any(not value for value in values) or len(set(values)) != 5:
                raise ValueError("Five distinct nonempty terms and meanings are required")
        return self


class GameCreate(BaseModel):
    request_id: UUID
    study_plan_id: int = Field(gt=0, le=2147483647)
    mode: GameMode


class GameAnswer(BaseModel):
    challenge: int = Field(ge=0, le=4)
    step: Literal["detect", "correct"]
    choice: int = Field(ge=0, le=19)


class SentenceOrderAnswer(BaseModel):
    challenge: int = Field(ge=0, le=4)
    step: Literal["order"]
    order: list[Annotated[int, Field(strict=True, ge=0, le=11)]] = Field(
        min_length=3, max_length=12
    )


class SentenceOrderChallenge(BaseModel):
    sentence: str = Field(min_length=3, max_length=500)
    clue: str = Field(min_length=3, max_length=500)
    fragments: list[str] = Field(min_length=3, max_length=12)
    separator: Literal["", " "]
    accepted_orders: list[list[Annotated[int, Field(strict=True, ge=0, le=11)]]] = Field(
        min_length=1, max_length=8
    )
    explanation: str = Field(min_length=10, max_length=1000)
    source_id: str = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_challenge(self) -> Self:
        if any(
            not part.strip() or part != part.strip() or len(part) > 200 for part in self.fragments
        ):
            raise ValueError("Fragments must be nonempty, bounded and have no boundary whitespace")
        if any(sorted(order) != list(range(len(self.fragments))) for order in self.accepted_orders):
            raise ValueError("Every solution must use each fragment exactly once")
        sentences = [
            self.separator.join(self.fragments[i] for i in order) for order in self.accepted_orders
        ]
        if sentences[0] != self.sentence:
            raise ValueError("The first solution must reconstruct the sentence exactly")
        if len(set(sentences)) != len(sentences):
            raise ValueError("Solutions must be textually distinct")
        if len(set(self.fragments)) < 2:
            raise ValueError("The challenge must admit an incorrect arrangement")
        return self


def _distinct_orders(fragments: list[str], orders: list[list[int]]) -> list[list[int]]:
    seen: set[str] = set()
    kept = []
    for order in orders:
        text = " ".join(fragments[i] for i in order)
        if text not in seen:
            seen.add(text)
            kept.append(order)
    return kept


def _repair_order_fragments(item: dict, sentence: str) -> dict | None:
    """Keep the model's phrase fragments when only whitespace or final punctuation is off.

    Final punctuation is attached to the fragment that ends the sentence; accepted orders that
    would move that fragment away from the end are dropped.
    """
    fragments, orders = item.get("fragments"), item.get("accepted_orders")
    if not isinstance(fragments, list) or not isinstance(orders, list):
        return None
    if not all(isinstance(f, str) and f.strip() for f in fragments):
        return None
    fragments = [f.strip() for f in fragments]
    size = len(fragments)
    valid = [
        o
        for o in orders
        if isinstance(o, list)
        and all(isinstance(i, int) and not isinstance(i, bool) for i in o)
        and sorted(o) == list(range(size))
    ]
    if not valid:
        return None
    first = valid[0]
    joined = " ".join(fragments[i] for i in first)
    if joined != sentence:
        rest = sentence[len(joined) :].strip() if sentence.startswith(joined) else ""
        if not rest or " " in rest or any(ch.isalnum() for ch in rest):
            return None
        last = first[-1]
        fragments[last] += rest
        valid = [o for o in valid if o[-1] == last]
    return {**item, "fragments": fragments, "accepted_orders": _distinct_orders(fragments, valid)}


def _rebuild_order_challenge(item: dict) -> dict | None:
    """Repair the fragments of a space-separated Sentence Order challenge.

    The sentence itself is authoritative. The model's phrase fragments and alternative orders
    are kept when they only miss spacing or final punctuation; otherwise the sentence is split
    into words and its own word order becomes the accepted solution.
    """
    sentence = item.get("sentence")
    if item.get("separator") != " " or not isinstance(sentence, str):
        return None
    sentence = " ".join(sentence.split())
    repaired = _repair_order_fragments({**item, "sentence": sentence}, sentence)
    if repaired is not None:
        try:
            return SentenceOrderChallenge.model_validate(repaired).model_dump()
        except ValidationError:
            pass
    words = sentence.split()
    if not 3 <= len(words) <= 12:
        return None
    return {
        **item,
        "sentence": " ".join(words),
        "fragments": words,
        "accepted_orders": [list(range(len(words)))],
    }


class SentenceOrderContent(BaseModel):
    challenges: list[SentenceOrderChallenge] = Field(min_length=5, max_length=5)

    @model_validator(mode="before")
    @classmethod
    def salvage(cls, data: Any) -> Any:
        return _salvage_challenges(
            data,
            SentenceOrderChallenge,
            lambda c: (_normalized(c.sentence),),
            _rebuild_order_challenge,
        )

    @model_validator(mode="after")
    def distinct_sentences(self) -> Self:
        if len({c.sentence.strip().casefold() for c in self.challenges}) != 5:
            raise ValueError("Five different sentences are required")
        return self


class DetectiveChallenge(BaseModel):
    sentence: str = Field(min_length=3, max_length=500)
    fragments: list[str] = Field(min_length=3, max_length=20)
    error_index: int = Field(ge=0, le=19)
    options: list[str] = Field(min_length=3, max_length=3)
    correct_index: int = Field(ge=0, le=2)
    corrected_sentence: str = Field(min_length=3, max_length=500)
    explanation: str = Field(min_length=10, max_length=1000)
    source_id: str = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_challenge(self) -> Self:
        if "".join(self.fragments) != self.sentence:
            raise ValueError("Fragments must concatenate exactly to the sentence")
        if any(not part.strip() or len(part) > 200 for part in self.fragments):
            raise ValueError("Each fragment must contain selectable text")
        if self.error_index >= len(self.fragments):
            raise ValueError("Invalid error index")
        normalized = [
            unicodedata.normalize("NFKC", item).strip().casefold() for item in self.options
        ]
        if any(not item or len(item) > 200 for item in normalized) or len(set(normalized)) != 3:
            raise ValueError("Options must be nonempty and distinct")
        original = self.fragments[self.error_index]
        if unicodedata.normalize("NFKC", original).strip().casefold() in normalized:
            raise ValueError("No option may repeat the erroneous fragment")
        corrected = list(self.fragments)
        corrected[self.error_index] = self.options[self.correct_index]
        if "".join(corrected) != self.corrected_sentence:
            raise ValueError("The correction must replace exactly one fragment")
        return self


_WORD_TOKEN = re.compile(r"\S+\s*")
_TRAILING_MARKS = re.compile(r"[^\w\s]*\s*$")


def _split_unspaced(text: str, size: int = 3) -> list[str]:
    """Split text without spaces (e.g. Japanese, Chinese) into short selectable pieces."""
    return [text[i : i + size] for i in range(0, len(text), size)]


def _only_adds_or_drops_words(first: str, second: str) -> bool:
    """True when one phrase is the other with whole words added (e.g. "few" / "a few")."""
    a, b = _normalized(first).split(), _normalized(second).split()
    short, long = (a, b) if len(a) <= len(b) else (b, a)
    return any(long[i : i + len(short)] == short for i in range(len(long) - len(short) + 1))


def _compile_detective_draft(item: dict) -> dict | None:
    """Build an Error Detective challenge from a correct sentence and one learner mistake.

    The draft names the tested word or phrase (``answer``) inside ``correct_sentence``, the
    learner ``mistake`` that replaces it and two more ``wrong_options``. The mistake becomes
    the selectable error fragment; the other words become the remaining fragments.
    """
    correct = item.get("correct_sentence")
    answer, mistake = item.get("answer"), item.get("mistake")
    wrong = item.get("wrong_options")
    if not (isinstance(correct, str) and isinstance(answer, str) and isinstance(wrong, list)):
        return None
    correct, answer = correct.strip(), answer.strip()
    if not answer:
        return None
    spaced = " " in correct
    pattern = (
        re.compile(rf"(?<!\w){re.escape(answer)}(?!\w)") if spaced else re.compile(re.escape(answer))
    )
    match = pattern.search(correct)
    if match is None or match.group() == correct:
        return None
    before, after = correct[: match.start()], correct[match.end() :]
    # Wrong forms: the mistake first, then the other wrong options, without repeats or the
    # answer itself. The first is shown in the sentence; the next two become distractors.
    wrong_forms: list[str] = []
    for option in [mistake, *wrong]:
        text = str(option or "").strip()
        if text and _normalized(text) not in {
            _normalized(answer),
            *(_normalized(w) for w in wrong_forms),
        }:
            wrong_forms.append(text)
    if len(wrong_forms) < 3:
        return None
    mistake, distractors = wrong_forms[0], wrong_forms[1:3]
    if spaced and _only_adds_or_drops_words(answer, mistake):
        return None  # e.g. "have" for "have got": a missing-word error, often still correct
    if spaced:
        # Spaces belong to the preceding fragment; the mistake keeps the space after it.
        gap = re.match(r"\s*", after).group()  # type: ignore[union-attr]
        head = _WORD_TOKEN.findall(before)
        tail = _WORD_TOKEN.findall(after[len(gap) :])
    else:
        gap, head, tail = "", _split_unspaced(before), _split_unspaced(after)
    fragments = [*head, mistake + gap, *tail]
    correct_index = zlib.crc32(correct.encode("utf-8")) % 3
    choices = distractors[:2]
    choices.insert(correct_index, answer)
    return {
        "sentence": "".join(fragments),
        "fragments": fragments,
        "error_index": len(head),
        "options": [choice + gap for choice in choices],
        "correct_index": correct_index,
        "corrected_sentence": before + answer + after,
        "explanation": item.get("explanation"),
        "source_id": item.get("source_id"),
    }


def _rebuild_detective_challenge(item: dict) -> dict | None:
    """Build a challenge from a draft, or rebuild its structure from its two sentences.

    Applies to space-separated sentences that differ in exactly one run of words. That run
    becomes the selectable error fragment, the corrected run becomes the right option, and two
    of the model's other options become the distractors.
    """
    if "correct_sentence" in item:
        return _compile_detective_draft(item)
    sentence, corrected = item.get("sentence"), item.get("corrected_sentence")
    options = item.get("options")
    if not (isinstance(sentence, str) and isinstance(corrected, str) and isinstance(options, list)):
        return None
    tokens = _WORD_TOKEN.findall(sentence.strip())
    fixed = _WORD_TOKEN.findall(corrected.strip())
    if len(tokens) < 2:
        return None
    matcher = difflib.SequenceMatcher(
        a=[t.strip() for t in tokens], b=[t.strip() for t in fixed], autojunk=False
    )
    changes = [op for op in matcher.get_opcodes() if op[0] != "equal"]
    if len(changes) != 1 or changes[0][0] != "replace":
        return None
    _, start, end, fixed_start, fixed_end = changes[0]
    error = "".join(tokens[start:end])
    right = "".join(fixed[fixed_start:fixed_end])
    tail = _TRAILING_MARKS.search(error).group()  # type: ignore[union-attr]
    marks = tail.strip()

    def core(text: str) -> str:
        text = str(text or "").strip()
        if marks and text.endswith(marks):
            text = text[: -len(marks)].rstrip()
        return text

    right_core, error_core = core(right), core(error)
    if not right_core or _normalized(right_core) == _normalized(error_core):
        return None
    distractors: list[str] = []
    for option in options:
        text = core(option)
        if text and _normalized(text) not in {
            _normalized(error_core),
            _normalized(right_core),
            *(_normalized(d) for d in distractors),
        }:
            distractors.append(text)
    if len(distractors) < 2:
        return None
    correct_index = zlib.crc32(sentence.encode("utf-8")) % 3
    choices = distractors[:2]
    choices.insert(correct_index, right_core)
    fragments = tokens[:start] + [error_core + tail] + tokens[end:]
    if len(fragments) < 3:
        return None
    return {
        **item,
        "sentence": "".join(fragments),
        "fragments": fragments,
        "error_index": start,
        "options": [choice + tail for choice in choices],
        "correct_index": correct_index,
        "corrected_sentence": "".join(tokens[:start] + [right_core + tail] + tokens[end:]),
    }


class DetectiveContent(BaseModel):
    challenges: list[DetectiveChallenge] = Field(min_length=5, max_length=5)

    @model_validator(mode="before")
    @classmethod
    def salvage(cls, data: Any) -> Any:
        return _salvage_challenges(
            data,
            DetectiveChallenge,
            lambda c: (_normalized(c.sentence),),
            _rebuild_detective_challenge,
        )

    @model_validator(mode="after")
    def distinct_sentences(self) -> Self:
        if len({c.sentence.strip().casefold() for c in self.challenges}) != 5:
            raise ValueError("Five different sentences are required")
        return self


_REVIEW_VERDICT_KEYS = ("valid", "is_valid", "isValid", "approved", "accepted", "accept", "pass")
_REVIEW_REASON_KEYS = ("reason", "reasons", "explanation", "feedback", "comment", "audit")


class DetectiveReview(BaseModel):
    valid: bool
    reason: str = Field(max_length=2000)

    @model_validator(mode="before")
    @classmethod
    def lenient_shape(cls, data: Any) -> Any:
        """Read common verdict shapes from smaller models; a missing verdict stays invalid."""
        if not isinstance(data, dict):
            return data
        if not any(key in data for key in _REVIEW_VERDICT_KEYS):
            nested = next(
                (
                    value
                    for value in data.values()
                    if isinstance(value, dict) and any(k in value for k in _REVIEW_VERDICT_KEYS)
                ),
                None,
            )
            if nested is None:
                return data
            data = nested
        verdict = next(data[key] for key in _REVIEW_VERDICT_KEYS if key in data)
        reason = next((data[key] for key in _REVIEW_REASON_KEYS if data.get(key)), "")
        if isinstance(reason, list):
            reason = "; ".join(str(item) for item in reason)
        return {"valid": verdict, "reason": str(reason)[:2000]}
