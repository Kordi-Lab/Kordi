"""LLM steps: distill a card from memories, and explain a match.

Both use structured outputs so the result is always valid JSON. The
explanation can only cite topic pairs the matcher already found, which keeps
it from inventing common ground. Runs only when Anthropic credentials are
available; the harness falls back to gold cards and templates otherwise.
"""
from __future__ import annotations

import json
import os

DEFAULT_MODEL = "claude-opus-5-5"

CARD_SCHEMA = {
    "type": "object",
    "properties": {
        key: {"type": "array", "items": {"type": "string"}}
        for key in ("working_on", "interests", "can_help", "looking_for")
    },
    "required": ["working_on", "interests", "can_help", "looking_for"],
    "additionalProperties": False,
}

DISTILL_SYSTEM = """You turn an assistant's private notes about a researcher into a public interest card that will be shown to strangers at an academic event.

Rules:
- Output short topic labels of 2 to 6 words. No sentences, no quotes from the notes.
- working_on: 2-3 current projects. interests: 2-4 broader research interests. can_help: 2-3 skills others could ask for. looking_for: 1-3 things they want from collaborators.
- Only research and professional topics. Leave out health, family, money, visas, relationships, conflicts, credentials, locations, and anything else personal, even if it appears often.
- Ignore errands and one-off chores.
- Prefer common research vocabulary so the same topic is worded similarly across people."""

_CITED = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {"label": {"type": "string"}, "evidence": {"type": "array", "items": {"type": "integer"}}},
        "required": ["label", "evidence"],
        "additionalProperties": False,
    },
}
PROFILE_KEYS = ("working_on", "interests", "can_help", "looking_for", "earlier")
PROFILE_SCHEMA = {
    "type": "object",
    "properties": {key: _CITED for key in PROFILE_KEYS},
    "required": list(PROFILE_KEYS),
    "additionalProperties": False,
}

PROFILE_SYSTEM = DISTILL_SYSTEM + """

You get numbered, dated evidence about the person (memory notes, repositories, papers, calendar and reminder titles, pages, their own words). Each topic must cite the evidence numbers that support it; cite every supporting item, not just one. Never cite evidence that does not support the topic.
Time matters. Today's date is given.
- working_on: only what recent evidence (about the last 6 months) supports. The person's own words and notes count as current.
- interests: lasting themes, ideally seen across several dates or sources.
- earlier: 0-4 topics that were clearly active in the past but have no recent evidence. Never repeat a topic from the other lists."""


EXPLAIN_SCHEMA = {
    "type": "object",
    "properties": {
        "reasons": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"pair": {"type": "integer"}, "why": {"type": "string"}},
                "required": ["pair", "why"],
                "additionalProperties": False,
            },
        },
        "next_step": {"type": "string"},
    },
    "required": ["reasons", "next_step"],
    "additionalProperties": False,
}

EXPLAIN_SYSTEM = """You explain why two researchers at an event should talk.
You get a numbered list of topic pairs the matcher found. Write one short reason (under 14 words) per pair, citing it by number, and one concrete next step (under 16 words).
Use only the given topics. Do not add facts about either person. Refer to people by name or "you", never by he, she, him, or her."""


JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "verdicts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"item": {"type": "integer"}, "yes": {"type": "boolean"}},
                "required": ["item", "yes"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["verdicts"],
    "additionalProperties": False,
}

JUDGE_SYSTEM = """You check candidate matches between two researchers' interest cards. Each item is one of:
- shared: two topic labels. Answer yes only if they are the same research area, so the two people would have a useful conversation about it. Shared words alone are not enough: "GPU memory" and "agent memory" are different.
- complement: a skill one person offers and a need the other has. Answer yes only if the skill directly serves the need.
- helps: a skill one person offers and the other person's project, interest, or need. Answer yes only if the skill would directly and concretely help that work, the kind of help worth a meeting. Loosely related fields are not enough.
Answer every item."""


class Judge:
    """Caches verdicts per topic pair. Unknown pairs are queued on the first
    pass (`judge(...)` returns None) and resolved in batches by `resolve()`."""

    def __init__(self, llm: "LLM", cache_path):
        self.llm = llm
        self.cache_path = cache_path
        self.cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
        self.pending: set[tuple[str, str, str]] = set()

    def __call__(self, kind: str, x: str, y: str):
        key = f"{kind}|{x}|{y}"
        if key in self.cache:
            return self.cache[key]
        self.pending.add((kind, x, y))
        return None

    def resolve(self, batch: int = 40) -> int:
        items = sorted(self.pending)
        for start in range(0, len(items), batch):
            chunk = items[start:start + batch]
            lines = "\n".join(f"{i}. {kind}: {x} | {y}" for i, (kind, x, y) in enumerate(chunk))
            result = self.llm._json(JUDGE_SYSTEM, lines, JUDGE_SCHEMA)
            for v in result["verdicts"]:
                if 0 <= v["item"] < len(chunk):
                    kind, x, y = chunk[v["item"]]
                    self.cache[f"{kind}|{x}|{y}"] = v["yes"]
            self.cache_path.write_text(json.dumps(self.cache, indent=1))
        self.pending.clear()
        return len(items)


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


class LLM:
    def __init__(self, model: str = DEFAULT_MODEL):
        import anthropic

        self.anthropic = anthropic
        self.client = anthropic.Anthropic()
        self.model = model

    def _json(self, system: str, user: str, schema: dict) -> dict:
        response = self.client.beta.messages.create(
            model=self.model,
            max_tokens=8000,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if response.stop_reason == "refusal":
            raise RuntimeError(f"refused: {response.stop_details}")
        text = next(b.text for b in response.content if b.type == "text")
        return json.loads(text)

    def distill(self, memories: list[str]) -> dict:
        notes = "\n".join(f"- {m}" for m in memories)
        return self._json(DISTILL_SYSTEM, f"Notes:\n{notes}", CARD_SCHEMA)

    def distill_profile(self, today: str, evidence: list[str]) -> dict:
        lines = "\n".join(f"[{i}] {line}" for i, line in enumerate(evidence))
        return self._json(PROFILE_SYSTEM, f"Today: {today}\n\nEvidence:\n{lines}", PROFILE_SCHEMA)

    def explain(self, name_a: str, name_b: str, pairs) -> dict:
        lines = "\n".join(f"{i}. {name_a}: {p.a} | {name_b}: {p.b} ({p.kind})" for i, p in enumerate(pairs))
        return self._json(EXPLAIN_SYSTEM, f"{name_a} and {name_b}\n{lines}", EXPLAIN_SCHEMA)


def template_explain(name_a: str, name_b: str, pairs) -> dict:
    reasons = []
    for i, p in enumerate(pairs):
        if p.kind == "shared":
            why = f"Both work on {p.a.lower()}"
        elif p.kind == "a_helps_b":
            why = f"{name_a} offers {p.a.lower()}; {name_b} needs it"
        else:
            why = f"{name_b} offers {p.b.lower()}; {name_a} needs it"
        reasons.append({"pair": i, "why": why})
    first = pairs[0].a.lower() if pairs else "your work"
    return {"reasons": reasons, "next_step": f"Meet for 15 minutes about {first}"}
