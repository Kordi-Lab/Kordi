"""Common ground lab: evaluate card distillation, pair matching, and rooms.

  uv run lab.py eval                 # full report (gold cards, both embedders)
  uv run lab.py eval --cards llm     # distill cards from memories first (needs a key)
  uv run lab.py eval --verify llm    # LLM confirms each candidate topic pair (needs a key)
  uv run lab.py match p01 p02        # one pair, with topic pairs and explanation
  uv run lab.py room r1 --viewer p01 # what one person sees in a room
  uv run lab.py tune                 # threshold sweep (small data: read with care)
"""
from __future__ import annotations

import argparse
import itertools
import json
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np

from cg import llm
from cg.algorithm import Params, TopicSpace, card_topics, cluster_room, match, percentile_scores, suggestion
from cg.embed import CACHE_DIR, make_embedder

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures" / "personas.json"
OUT = ROOT / "out"
LABEL_VALUE = {"none": 0, "weak": 1, "strong": 2}


def load():
    data = json.loads(FIXTURES.read_text())
    return {p["id"]: p for p in data["personas"]}, data["pairs"], data["rooms"]


def get_cards(personas: dict, mode: str, model: str) -> dict[str, dict]:
    if mode == "gold":
        return {pid: p["card"] for pid, p in personas.items()}
    CACHE_DIR.mkdir(exist_ok=True)
    cache_path = CACHE_DIR / f"cards-{model}.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    if all(pid in cache for pid in personas):
        return cache
    if not llm.available():
        raise SystemExit("--cards llm needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)")
    client = llm.LLM(model)
    for pid, p in personas.items():
        if pid not in cache:
            print(f"distilling {pid} {p['name']}…", flush=True)
            cache[pid] = client.distill(p["memories"])
            cache_path.write_text(json.dumps(cache, indent=2))
    return cache


def make_judge(args):
    if args.verify != "llm":
        return None
    if not llm.available():
        raise SystemExit("--verify llm needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)")
    CACHE_DIR.mkdir(exist_ok=True)
    return llm.Judge(llm.LLM(args.model), CACHE_DIR / f"verdicts-{args.model}.json")


def build_space(embedder_name: str, cards: dict[str, dict]) -> TopicSpace:
    space = TopicSpace(make_embedder(embedder_name))
    space.add([t for card in cards.values() for t in card_topics(card)])
    return space


# ---------- metrics ----------

def auc(pos: list[float], neg: list[float]) -> float:
    if not pos or not neg:
        return float("nan")
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def spearman(x: list[float], y: list[float]) -> float:
    rx, ry = np.argsort(np.argsort(x)), np.argsort(np.argsort(y))
    return float(np.corrcoef(rx, ry)[0, 1])


def with_judge(judge, fn):
    """Run once to queue unknown topic pairs, ask the judge, then run for real."""
    result = fn()
    if judge and judge.pending:
        print(f"checking {len(judge.pending)} topic pairs with the LLM…", flush=True)
        judge.resolve()
        result = fn()
    return result


def evaluate(personas, pairs, rooms, cards, space, params: Params, judge=None) -> dict:
    raw = {(p["a"], p["b"]): match(space, cards[p["a"]], cards[p["b"]], params, judge) for p in pairs}
    by_label = {k: [raw[(p["a"], p["b"])].raw for p in pairs if p["label"] == k] for k in LABEL_VALUE}

    kinds = {}
    for p in pairs:
        m = raw[(p["a"], p["b"])]
        found = bool(m.pairs)
        expected = p["label"] != "none"
        k = kinds.setdefault(p["kind"], {"n": 0, "correct": 0})
        k["n"] += 1
        k["correct"] += int(found == expected) if p["label"] != "weak" else int(found)

    # Ranking: does each person's top 3 contain a strong partner, and how many labeled "none" sneak in?
    ids = sorted(personas)
    all_raw = {}
    for a, b in itertools.combinations(ids, 2):
        all_raw[(a, b)] = all_raw[(b, a)] = match(space, cards[a], cards[b], params, judge).raw
    gold = {}
    for p in pairs:
        gold[(p["a"], p["b"])] = gold[(p["b"], p["a"])] = p["label"]
    hits, eligible, intrusions = 0, 0, 0
    for a in ids:
        top = sorted((b for b in ids if b != a), key=lambda b: -all_raw[(a, b)])[:3]
        if any(gold.get((a, b)) == "strong" for b in ids if b != a):
            eligible += 1
            hits += int(any(gold.get((a, b)) == "strong" for b in top))
        intrusions += sum(1 for b in top if gold.get((a, b)) == "none" and all_raw[(a, b)] > 0)

    room_scores = []
    for room in rooms:
        found = cluster_room(space, {pid: cards[pid] for pid in room["members"]}, params)
        for exp in room["expected_clusters"]:
            want = set(exp["members"])
            best = max((len(want & c.people) / len(want | c.people) for c in found), default=0.0)
            room_scores.append(best)

    return {
        "auc_strong_vs_none": auc(by_label["strong"], by_label["none"]),
        "auc_any_vs_none": auc(by_label["strong"] + by_label["weak"], by_label["none"]),
        "spearman": spearman([raw[(p["a"], p["b"])].raw for p in pairs], [LABEL_VALUE[p["label"]] for p in pairs]),
        "kinds": kinds,
        "hit_at_3": hits / max(1, eligible),
        "top3_intrusions": intrusions,
        "room_jaccard": float(np.mean(room_scores)) if room_scores else float("nan"),
        "raw": raw,
        "judge": judge,
    }


def distill_metrics(personas, cards, space) -> dict:
    """Topic recall against the gold card, and leakage of sensitive memories."""
    recalls, leaks = [], []
    for pid, p in personas.items():
        gold = p["card"]["working_on"] + p["card"]["interests"]
        got = card_topics(cards[pid])
        space.add(gold + got + p["sensitive"])
        sim = space.sim(gold, got)
        recalls.append(float((sim.max(axis=1) >= 0.80).mean()) if got else 0.0)
        if got and p["sensitive"]:
            s = space.sim(p["sensitive"], got)
            for i, j in zip(*np.where(s >= 0.75)):
                leaks.append((pid, p["sensitive"][i], got[j], float(s[i, j])))
    return {"topic_recall": float(np.mean(recalls)), "leaks": leaks}


# ---------- commands ----------

def fmt(x: float) -> str:
    return "n/a" if x != x else f"{x:.2f}"


def top_pairs(m, n: int = 3):
    """The app shows at most three reasons: the closest topic pairs."""
    return sorted(m.pairs, key=lambda t: -t.similarity)[:n]


def cmd_eval(args):
    personas, pairs, rooms = load()
    cards = get_cards(personas, args.cards, args.model)
    params = Params()
    lines = [
        "# Common ground lab report",
        "",
        f"{len(personas)} personas, {len(pairs)} labeled pairs, {len(rooms)} rooms. Cards: `{args.cards}`.",
        "",
        "Parameters: " + ", ".join(f"`{k}={v}`" for k, v in asdict(params).items()),
        "",
        "## Matching",
        "",
        "| Embedder | AUC strong vs none | AUC any vs none | Spearman | Top-3 has a strong partner | Labeled-none in top 3 | Room cluster Jaccard |",
        "|---|---|---|---|---|---|---|",
    ]
    judge = make_judge(args)
    results = {}
    variants = [("lexical", None), ("semantic", None)] + ([("semantic + LLM check", judge)] if judge else [])
    for name, j in variants:
        space = build_space(name.split()[0], cards)
        r = with_judge(j, lambda: evaluate(personas, pairs, rooms, cards, space, params, j))
        results[name] = (r, space)
        lines.append(
            f"| {name} | {fmt(r['auc_strong_vs_none'])} | {fmt(r['auc_any_vs_none'])} | {fmt(r['spearman'])} | "
            f"{fmt(r['hit_at_3'])} | {r['top3_intrusions']} | {fmt(r['room_jaccard'])} |"
        )

    names = list(results)
    lines += ["", "### By pair kind (share handled correctly)", "", "| Kind | " + " | ".join(names) + " |", "|---" * (len(names) + 1) + "|"]
    kinds = sorted(set().union(*(results[n][0]["kinds"] for n in names)))
    for k in kinds:
        cells = []
        for name in names:
            v = results[name][0]["kinds"].get(k)
            cells.append(f"{v['correct']}/{v['n']}" if v else "-")
        lines.append(f"| {k} | " + " | ".join(cells) + " |")

    best = names[-1]
    r, space = results[best]
    lines += ["", f"Errors and examples below use: {best}."]
    misses = []
    for p in pairs:
        m = r["raw"][(p["a"], p["b"])]
        expected = p["label"] != "none"
        if bool(m.pairs) != expected:
            what = "missed" if expected else "false match"
            via = "; ".join(f"{t.a} ~ {t.b} ({t.similarity:.2f})" for t in m.pairs) or "no topic pair"
            misses.append(f"- {what} `{p['a']}`–`{p['b']}` ({p['label']}, {p['kind']}): {p['why']} — {via}")
    lines += ["", "### Semantic errors", ""] + (misses or ["None."])

    if args.cards == "llm":
        d = distill_metrics(personas, cards, space)
        lines += ["", "## Card distillation", "", f"Topic recall vs gold: {fmt(d['topic_recall'])}", "",
                  f"Possible sensitive leaks: {len(d['leaks'])}"]
        lines += [f"- `{pid}` memory “{s}” ~ card “{c}” ({v:.2f})" for pid, s, c, v in d["leaks"]]

    explainer = llm.LLM(args.model) if args.explain == "llm" else None
    lines += ["", "## Example explanations", ""]
    strong = [p for p in pairs if p["label"] == "strong"][:4]
    for p in strong:
        a, b = personas[p["a"]], personas[p["b"]]
        m = r["raw"][(p["a"], p["b"])]
        e = explainer.explain(a["name"], b["name"], top_pairs(m)) if explainer and m.pairs else llm.template_explain(a["name"], b["name"], top_pairs(m))
        lines.append(f"**{a['name']} × {b['name']}** (raw {m.raw:.2f})")
        lines += [f"- {x['why']}" for x in e["reasons"]] + [f"- Next: {e['next_step']}", ""]

    lines += [f"## Rooms ({best})", ""]
    for room in rooms:
        lines += room_lines(personas, cards, space, room, room["members"][0], params, results[best][0].get("judge"))

    OUT.mkdir(exist_ok=True)
    (OUT / "report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nWrote {OUT / 'report.md'}")


def room_lines(personas, cards, space, room, viewer, params, judge=None) -> list[str]:
    members = room["members"]
    raws = {}
    for a, b in itertools.combinations(members, 2):
        raws[(a, b)] = raws[(b, a)] = match(space, cards[a], cards[b], params, judge).raw
    shown = percentile_scores(raws)
    clusters = cluster_room(space, {pid: cards[pid] for pid in members}, params)
    sug = suggestion(clusters, viewer)
    name = lambda pid: personas[pid]["name"]
    out = [f"### Room {room['id']} as {name(viewer)} ({len(members)} people)", ""]
    if sug:
        out.append(f"Suggested: **{sug.label}** with " + ", ".join(name(x) for x in sorted(sug.people) if x != viewer))
        out.append("")
    show = lambda b: f"{shown[(viewer, b)]}%" if raws[(viewer, b)] > 0 else "—"
    out.append("People: " + ", ".join(f"{name(b)} {show(b)}" for b in sorted((m for m in members if m != viewer), key=lambda b: -raws[(viewer, b)])))
    out.append("")
    out.append("Topics found: " + "; ".join(f"{c.label} ({len(c.people)})" for c in clusters))
    out.append("")
    out.append("Expected: " + "; ".join(f"{c['theme']} ({len(c['members'])})" for c in room["expected_clusters"]))
    out.append("")
    return out


def cmd_match(args):
    personas, _, _ = load()
    cards = get_cards(personas, args.cards, args.model)
    space = build_space(args.embedder, cards)
    a, b = personas[args.a], personas[args.b]
    judge = make_judge(args)
    m = with_judge(judge, lambda: match(space, cards[args.a], cards[args.b], Params(), judge))
    print(f"{a['name']} × {b['name']}  raw={m.raw:.3f}  overlap={m.overlap:.2f}  complement={m.complement:.2f}")
    for t in m.pairs:
        print(f"  [{t.kind}] {t.a}  ~  {t.b}  ({t.similarity:.2f})")
    e = llm.LLM(args.model).explain(a["name"], b["name"], top_pairs(m)) if args.explain == "llm" and m.pairs else llm.template_explain(a["name"], b["name"], top_pairs(m))
    print(json.dumps(e, indent=2))


def cmd_room(args):
    personas, _, rooms = load()
    cards = get_cards(personas, args.cards, args.model)
    space = build_space(args.embedder, cards)
    room = next(r for r in rooms if r["id"] == args.room)
    judge = make_judge(args)
    viewer = args.viewer or room["members"][0]
    print("\n".join(with_judge(judge, lambda: room_lines(personas, cards, space, room, viewer, Params(), judge))))


def cmd_tune(args):
    personas, pairs, rooms = load()
    cards = get_cards(personas, args.cards, args.model)
    space = build_space(args.embedder, cards)
    rows = []
    for st, ct, kt in itertools.product([0.72, 0.76, 0.80, 0.84, 0.88], [0.70, 0.74, 0.78, 0.82], [0.74, 0.78, 0.82, 0.86]):
        p = replace(Params(), shared_threshold=st, complement_threshold=ct, cluster_threshold=kt)
        r = evaluate(personas, pairs, rooms, cards, space, p)
        objective = r["auc_any_vs_none"] + r["hit_at_3"] + r["room_jaccard"] - 0.02 * r["top3_intrusions"]
        rows.append((objective, st, ct, kt, r))
    rows.sort(key=lambda x: -x[0])
    print("objective  shared  complement  cluster  auc_any  hit@3  intrusions  room_j")
    for obj, st, ct, kt, r in rows[:10]:
        print(f"{obj:8.3f}  {st:6.2f}  {ct:10.2f}  {kt:7.2f}  {r['auc_any_vs_none']:7.2f}  {r['hit_at_3']:5.2f}  {r['top3_intrusions']:10d}  {r['room_jaccard']:6.2f}")
    print("\n30 personas and ~60 pairs: treat the top rows as a range, not a setting.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cards", choices=["gold", "llm"], default="gold")
    ap.add_argument("--explain", choices=["template", "llm"], default="template")
    ap.add_argument("--model", default=llm.DEFAULT_MODEL)
    ap.add_argument("--verify", choices=["none", "llm"], default="none")
    ap.add_argument("--embedder", choices=["semantic", "lexical"], default="semantic")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("eval")
    m = sub.add_parser("match"); m.add_argument("a"); m.add_argument("b")
    r = sub.add_parser("room"); r.add_argument("room"); r.add_argument("--viewer")
    sub.add_parser("tune")
    args = ap.parse_args()
    {"eval": cmd_eval, "match": cmd_match, "room": cmd_room, "tune": cmd_tune}[args.cmd](args)


if __name__ == "__main__":
    main()
