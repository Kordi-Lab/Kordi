"""Card matching and room clustering.

Pair score (no LLM, deterministic):
  overlap    = one-to-one topic pairs above `shared_threshold`, weighted by
               field ("working on" counts more than "interests") and similarity
  complement = A.can_help vs B.looking_for and the reverse, above
               `complement_threshold`
  raw        = overlap_weight * sat(overlap) + complement_weight * sat(complement)
where sat(x) = 1 - exp(-x) so a second or third shared topic still helps, but
less than the first. In a room the shown score is the raw score's percentile
among that room's pairs.

Room topics: average-linkage clustering of every shareable topic in the room;
a cluster that spans two or more people becomes a room topic, and the largest
topic that includes the viewer and at least two others is the suggestion.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

FIELD_WEIGHTS = {"working_on": 1.0, "interests": 0.6}


@dataclass
class Params:
    shared_threshold: float = 0.80
    complement_threshold: float = 0.78
    overlap_weight: float = 0.6
    complement_weight: float = 0.4
    cluster_threshold: float = 0.74
    # Near misses between the floor and a threshold still count for ranking,
    # scaled by how close they are; only pairs above the threshold are shown.
    soft_floor: float = 0.62


@dataclass
class TopicPair:
    a: str
    b: str
    similarity: float
    kind: str  # "shared" | "a_helps_b" | "b_helps_a"


@dataclass
class Match:
    raw: float
    overlap: float
    complement: float
    pairs: list[TopicPair] = field(default_factory=list)


class TopicSpace:
    """Embeds each distinct topic once and serves cosine similarities."""

    def __init__(self, embedder):
        self.embedder = embedder
        self.index: dict[str, int] = {}
        self.vectors = np.zeros((0, 1), dtype=np.float32)

    def add(self, topics: list[str]) -> None:
        new = [t for t in dict.fromkeys(topics) if t not in self.index]
        if not new:
            return
        vecs = self.embedder.embed(new)
        start = len(self.index)
        for i, t in enumerate(new):
            self.index[t] = start + i
        self.vectors = vecs if self.vectors.shape[0] == 0 else np.vstack([self.vectors, vecs])

    def sim(self, a: list[str], b: list[str]) -> np.ndarray:
        if not a or not b:
            return np.zeros((len(a), len(b)), dtype=np.float32)
        va = self.vectors[[self.index[t] for t in a]]
        vb = self.vectors[[self.index[t] for t in b]]
        return va @ vb.T


def card_topics(card: dict) -> list[str]:
    return [t for key in ("working_on", "interests", "can_help", "looking_for") for t in card.get(key, [])]


def _greedy_pairs(sim: np.ndarray, threshold: float) -> list[tuple[int, int, float]]:
    """One-to-one pairs, best first, above the threshold."""
    taken_a, taken_b, out = set(), set(), []
    order = np.dstack(np.unravel_index(np.argsort(-sim, axis=None), sim.shape))[0] if sim.size else []
    for i, j in order:
        s = float(sim[i, j])
        if s < threshold:
            break
        if i in taken_a or j in taken_b:
            continue
        taken_a.add(i)
        taken_b.add(j)
        out.append((int(i), int(j), s))
    return out


def _weighted(card: dict) -> list[tuple[str, float]]:
    return [(t, w) for key, w in FIELD_WEIGHTS.items() for t in card.get(key, [])]


def match(space: TopicSpace, a: dict, b: dict, p: Params, judge=None) -> Match:
    """Score one pair. With a judge, every candidate topic pair above the soft
    floor is confirmed or rejected by it; confirmed pairs get full credit and
    are shown, rejected ones count for nothing. Without a judge, similarity
    alone decides (soft credit for near misses, shown above the threshold)."""
    pairs: list[TopicPair] = []

    def credit(s: float, threshold: float, verdict) -> float:
        if verdict is not None:
            return s if verdict else 0.0
        return s * min(1.0, (s - p.soft_floor) / (threshold - p.soft_floor))

    def ask(kind: str, x: str, y: str):
        return judge(kind, x, y) if judge else None

    wa, wb = _weighted(a), _weighted(b)
    sim = space.sim([t for t, _ in wa], [t for t, _ in wb])
    overlap = 0.0
    for i, j, s in _greedy_pairs(sim, p.soft_floor):
        verdict = ask("shared", wa[i][0], wb[j][0])
        overlap += min(wa[i][1], wb[j][1]) * credit(s, p.shared_threshold, verdict)
        if verdict or (verdict is None and s >= p.shared_threshold):
            pairs.append(TopicPair(wa[i][0], wb[j][0], s, "shared"))

    complement = 0.0
    for helper, seeker, kind in ((a, b, "a_helps_b"), (b, a, "b_helps_a")):
        give, need = helper.get("can_help", []), seeker.get("looking_for", [])
        for i, j, s in _greedy_pairs(space.sim(give, need), p.soft_floor):
            verdict = ask("complement", give[i], need[j])
            complement += credit(s, p.complement_threshold, verdict)
            if verdict or (verdict is None and s >= p.complement_threshold):
                pairs.append(TopicPair(give[i], need[j], s, kind) if kind == "a_helps_b" else TopicPair(need[j], give[i], s, kind))

    sat = lambda x: 1 - float(np.exp(-x))
    raw = p.overlap_weight * sat(overlap) + p.complement_weight * sat(complement)
    return Match(raw=raw, overlap=overlap, complement=complement, pairs=pairs)


def percentile_scores(raws: dict[tuple[str, str], float]) -> dict[tuple[str, str], int]:
    """Room-relative score shown in the app: share of room pairs below this one."""
    values = sorted(raws.values())
    n = len(values)
    out = {}
    for key, r in raws.items():
        below = sum(1 for v in values if v < r)
        out[key] = round(100 * below / max(1, n - 1)) if r > 0 else 0
    return out


@dataclass
class Cluster:
    label: str
    topics: list[tuple[str, str]]  # (person id, topic)
    people: set[str]


def cluster_room(space: TopicSpace, cards: dict[str, dict], p: Params) -> list[Cluster]:
    items = [(pid, t) for pid, card in cards.items() for t in dict.fromkeys(card.get("working_on", []) + card.get("interests", []))]
    if not items:
        return []
    space.add([t for _, t in items])
    sim = space.sim([t for _, t in items], [t for _, t in items])
    groups = [[i] for i in range(len(items))]

    def link(g1, g2):
        return float(sim[np.ix_(g1, g2)].mean())

    while True:
        best, pair = -1.0, None
        for x in range(len(groups)):
            for y in range(x + 1, len(groups)):
                s = link(groups[x], groups[y])
                if s > best:
                    best, pair = s, (x, y)
        if pair is None or best < p.cluster_threshold:
            break
        x, y = pair
        groups[x] = groups[x] + groups[y]
        del groups[y]

    clusters = []
    for g in groups:
        people = {items[i][0] for i in g}
        if len(people) < 2:
            continue
        centroid = sim[np.ix_(g, g)].mean(axis=1)
        label = items[g[int(np.argmax(centroid))]][1]
        clusters.append(Cluster(label=label, topics=[items[i] for i in g], people=people))
    return sorted(clusters, key=lambda c: (-len(c.people), c.label))


def suggestion(clusters: list[Cluster], viewer: str) -> Cluster | None:
    mine = [c for c in clusters if viewer in c.people]
    return next((c for c in mine if len(c.people) >= 3), mine[0] if mine else None)
