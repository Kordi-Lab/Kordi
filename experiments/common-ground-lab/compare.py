"""Compare embedding models from precomputed vectors (see bench_embed.py).

  uv run compare.py BENCH_DIR [--cards gold|llm] [--verify llm] [--multilingual FILE]

Each model's similarity scale is different, so cutoffs are tuned per model on
the same grid before comparing. With --verify llm, every model also runs the
full pipeline at equal LLM budgets: the soft floor is set so the number of
candidate topic pairs sent to the judge is the same for every model.
"""
from __future__ import annotations

import argparse
import itertools
import json
from dataclasses import replace
from pathlib import Path

import numpy as np

import lab
from cg import llm
from cg.algorithm import Params, TopicSpace, _greedy_pairs, _weighted, card_topics
from cg.embed import _normalize

ROOT = Path(__file__).resolve().parent


class FileEmbedder:
    def __init__(self, path: Path):
        self.name = path.stem.removeprefix("vectors-")
        self.vectors = json.loads(path.read_text())

    def embed(self, texts):
        return _normalize(np.array([self.vectors[t] for t in texts], dtype=np.float32))


def space_for(embedder, cards) -> TopicSpace:
    space = TopicSpace(embedder)
    space.add([t for card in cards.values() for t in card_topics(card)])
    return space


def candidates(space, cards, floor) -> int:
    """Distinct topic pairs above the floor across all person pairs (judge workload)."""
    seen = set()
    for a, b in itertools.combinations(sorted(cards), 2):
        A, B = cards[a], cards[b]
        wa, wb = _weighted(A), _weighted(B)
        ta, tb = [t for t, _ in wa], [t for t, _ in wb]
        for i, j, _ in _greedy_pairs(space.sim(ta, tb), floor):
            seen.add(("shared", ta[i], tb[j]))
        for give, need in ((A.get("can_help", []), B.get("looking_for", [])), (B.get("can_help", []), A.get("looking_for", []))):
            for i, j, _ in _greedy_pairs(space.sim(give, need), floor):
                seen.add(("complement", give[i], need[j]))
    return len(seen)


def floor_for_budget(space, cards, budget) -> float:
    lo, hi = 0.0, 1.0
    for _ in range(18):
        mid = (lo + hi) / 2
        if candidates(space, cards, mid) > budget:
            lo = mid
        else:
            hi = mid
    return hi


def quantiles(space, cards):
    topics = sorted({t for c in cards.values() for t in card_topics(c)})
    sim = space.sim(topics, topics)
    vals = sim[np.triu_indices(len(topics), 1)]
    return lambda q: float(np.quantile(vals, q))


def tune_embeddings_only(personas, pairs, rooms, cards, space):
    q = quantiles(space, cards)
    best = None
    for fq, sq, cq, kq in itertools.product([0.90, 0.95, 0.97], [0.985, 0.99, 0.995], [0.97, 0.98, 0.99], [0.97, 0.98, 0.99]):
        floor, st, ct, kt = q(fq), q(sq), q(cq), q(kq)
        if not floor < min(st, ct):
            continue
        p = replace(Params(), soft_floor=floor, shared_threshold=st, complement_threshold=ct, cluster_threshold=kt)
        r = lab.evaluate(personas, pairs, rooms, cards, space, p)
        obj = r["auc_any_vs_none"] + r["hit_at_3"] + r["room_jaccard"] - 0.02 * r["top3_intrusions"]
        if best is None or obj > best[0]:
            best = (obj, p, r)
    return best


def multilingual_top1(embedder, path: Path) -> float:
    pairs = json.loads(path.read_text())["pairs"]
    en = [e for e, _ in pairs]
    zh = [z for _, z in pairs]
    pool = sorted(set(en) | set(embedder.vectors) - set(zh))
    pool = [t for t in pool if t.isascii()]
    E, Z = embedder.embed(pool), embedder.embed(zh)
    hits = 0
    for k, z in enumerate(Z):
        hits += int(pool[int(np.argmax(E @ z))] == en[k])
    return hits / len(zh)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bench_dir", type=Path)
    ap.add_argument("--cards", choices=["gold", "llm"], default="llm")
    ap.add_argument("--verify", choices=["none", "llm"], default="none")
    ap.add_argument("--model", default=llm.DEFAULT_MODEL)
    ap.add_argument("--budgets", default="1000,2000")
    ap.add_argument("--multilingual", type=Path)
    args = ap.parse_args()

    personas, pairs, rooms = lab.load()
    cards = lab.get_cards(personas, args.cards, args.model)
    stats = json.loads((args.bench_dir / "stats.json").read_text())
    judge = lab.make_judge(argparse.Namespace(verify=args.verify, model=args.model))
    budgets = [int(b) for b in args.budgets.split(",")]

    lines = [
        "# Embedding model comparison",
        "",
        f"Cards: `{args.cards}`. CPU: {next(iter(stats.values()))['threads']} threads. Cutoffs tuned per model on the same quantile grid.",
        "",
        "## Speed and size (CPU)",
        "",
        "| Model | Dims | Load s | One topic ms (median / p90) | Topics/s batched | Peak RAM GB |",
        "|---|---|---|---|---|---|",
    ]
    for slug, s in stats.items():
        lines.append(f"| {slug} | {s['dims']} | {s['load_seconds']} | {s['single_topic_ms_median']} / {s['single_topic_ms_p90']} | {s['topics_per_second_batch']} | {s['peak_rss_gb']} |")

    lines += ["", "## Embeddings only (tuned)", "",
              "| Model | AUC strong vs none | AUC any vs none | Top-3 strong | None in top 3 | Room Jaccard | complement | hard_negative | overlap | paraphrase | Multilingual top-1 |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    spaces = {}
    for slug in stats:
        emb = FileEmbedder(args.bench_dir / f"vectors-{slug}.json")
        space = space_for(emb, cards)
        spaces[slug] = space
        _, p, r = tune_embeddings_only(personas, pairs, rooms, cards, space)
        k = r["kinds"]
        ml = lab.fmt(multilingual_top1(emb, args.multilingual)) if args.multilingual else "-"
        lines.append(
            f"| {slug} | {lab.fmt(r['auc_strong_vs_none'])} | {lab.fmt(r['auc_any_vs_none'])} | {lab.fmt(r['hit_at_3'])} | {r['top3_intrusions']} | {lab.fmt(r['room_jaccard'])} | "
            + " | ".join(f"{k[x]['correct']}/{k[x]['n']}" if x in k else "-" for x in ("complement", "hard_negative", "overlap", "paraphrase"))
            + f" | {ml} |"
        )
        print(lines[-1], flush=True)

    if judge:
        lines += ["", "## With the LLM check at equal budgets", "",
                  "Budget = distinct topic pairs the judge sees across all 435 person pairs.", "",
                  "| Model | Budget | Floor | AUC strong vs none | AUC any vs none | Top-3 strong | None in top 3 | complement | hard_negative | overlap |",
                  "|---|---|---|---|---|---|---|---|---|---|"]
        for slug, space in spaces.items():
            for budget in budgets:
                floor = floor_for_budget(space, cards, budget)
                p = replace(Params(), soft_floor=floor, shared_threshold=max(floor + 1e-3, Params().shared_threshold), complement_threshold=max(floor + 1e-3, Params().complement_threshold))
                r = lab.with_judge(judge, lambda: lab.evaluate(personas, pairs, rooms, cards, space, p, judge))
                k = r["kinds"]
                lines.append(
                    f"| {slug} | {budget} | {floor:.3f} | {lab.fmt(r['auc_strong_vs_none'])} | {lab.fmt(r['auc_any_vs_none'])} | {lab.fmt(r['hit_at_3'])} | {r['top3_intrusions']} | "
                    + " | ".join(f"{k[x]['correct']}/{k[x]['n']}" for x in ("complement", "hard_negative", "overlap")) + " |"
                )
                print(lines[-1], flush=True)

    out = ROOT / "out" / "embedding-comparison.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(lines) + "\n")
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
