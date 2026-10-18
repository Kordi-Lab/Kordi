"""Turn cited card topics into a profile: latest interests, a timeline, and
the references behind each topic.

Recency uses ACT-R base-level activation (Anderson & Schooler 1991), the
cognitive model of how memory strength depends on how often and how recently
something came up:

    A = ln( sum_j  t_j ** -d )

where t_j is the age in months of each supporting item and d = 0.5. A topic
seen many times recently ranks above one seen once long ago, and old
evidence fades without vanishing. Items without a date count as current
(the person's own words, notes, a page read today).
"""
from __future__ import annotations

import math
from datetime import date

CARD_KEYS = ("working_on", "interests", "can_help", "looking_for")
DECAY = 0.5
LATEST = 6
RECENT_DAYS = 183
SNIPPET = 220


def age_months(day: str | None, today: date) -> float:
    if not day:
        return 0.0
    try:
        then = date.fromisoformat(day[:10])
    except ValueError:
        return 0.0
    return max((today - then).days, 0) / 30.4


def activation(dates: list[str | None], today: date) -> float:
    if not dates:
        return float("-inf")
    return math.log(sum((age_months(d, today) + 1.0) ** -DECAY for d in dates))


def period(day: str, today: date) -> tuple[str, str]:
    """(sort key, label): quarters for the last year, whole years before that."""
    q = (int(day[5:7]) - 1) // 3 + 1
    if (today - date.fromisoformat(day[:10])).days <= 365:
        return f"{day[:4]}-{q}", f"{day[:4]} Q{q}"
    return f"{day[:4]}-0", day[:4]


def evidence_view(evidence: list[dict]) -> dict:
    return {
        e["id"]: {
            "source": e["source"],
            "title": e["title"],
            "date": e.get("date"),
            "url": e.get("url"),
            "snippet": " ".join(e.get("text", "").split())[:SNIPPET],
        }
        for e in evidence
    }


def build(card: dict, evidence: list[dict], today: date) -> dict:
    """card: {key: [label]} plus "refs": {label: [evidence id]} and "earlier": [label]."""
    by_id = {e["id"]: e for e in evidence}
    refs = card.get("refs", {})
    hidden = set(card.get("hidden", []))
    labels = [t for k in CARD_KEYS for t in card.get(k, [])] + card.get("earlier", [])
    topics = {}
    for label in dict.fromkeys(labels):
        ids = [i for i in refs.get(label, []) if i in by_id]
        dated = sorted(by_id[i]["date"] for i in ids if by_id[i].get("date"))
        score = activation([by_id[i].get("date") for i in ids], today)
        topics[label] = {
            "refs": sorted(ids, key=lambda i: by_id[i].get("date") or "", reverse=True),
            "first_seen": dated[0] if dated else None,
            "last_seen": dated[-1] if dated else None,
            "score": round(score, 3) if ids else None,
        }

    current = [t for k in CARD_KEYS for t in card.get(k, []) if t not in hidden]
    ranked = sorted(dict.fromkeys(current), key=lambda t: topics[t]["score"] if topics[t]["score"] is not None else -9, reverse=True)
    cutoff = today.toordinal() - RECENT_DAYS

    def recent(t: str) -> bool:
        last = topics[t]["last_seen"]
        return last is None or date.fromisoformat(last).toordinal() >= cutoff

    latest = [t for t in ranked if recent(t)][:LATEST]

    # Each topic appears once, where it first came up, so the timeline reads
    # as how the person's work evolved rather than repeating long-lived topics.
    periods: dict[tuple[str, str], list[str]] = {}
    for label, info in sorted(topics.items(), key=lambda kv: kv[1]["first_seen"] or ""):
        if info["first_seen"]:
            periods.setdefault(period(info["first_seen"], today), []).append(label)
    timeline = [{"period": key[1], "topics": labels} for key, labels in sorted(periods.items(), reverse=True)]
    return {
        "latest": latest,
        "earlier": card.get("earlier", []),
        "timeline": timeline,
        "topics": topics,
        "evidence": evidence_view([by_id[i] for i in sorted({i for t in topics.values() for i in t["refs"]})]),
    }
