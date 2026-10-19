# Common ground lab

Offline harness for the Common ground algorithm, before any server or app work. It answers three questions on synthetic data:

1. Does a card distilled from memory capture the right topics without leaking private memories?
2. Do the right people rank highly for each other, including paraphrased topics and complementary needs, while look-alike topics stay apart?
3. In a room, do the topic clusters match the groups a person would expect?

All personas in `fixtures/personas.json` are fictional.

## Run

```sh
cd experiments/common-ground-lab
uv run lab.py eval                  # report in out/report.md
uv run lab.py match p01 p02         # one pair: topic pairs, score, explanation
uv run lab.py room r1 --viewer p03  # one person's room view
uv run lab.py tune                  # threshold sweep
```

The first run downloads a small local embedding model (about 130 MB). No API key is needed: cards come from the gold fixtures and explanations from templates. With `ANTHROPIC_API_KEY` set, `--cards llm` distills cards from the memories and `--explain llm` writes explanations with Claude.

## Algorithm

| Step | Method | LLM |
|---|---|---|
| Card | Memories → four lists of short topics (working on, interests, can help with, looking for). Private memories must stay off the card. | Yes, structured output |
| Pair score | Embed every topic. Shared ground: one-to-one topic pairs above a similarity threshold, weighted by field. Trade: can help ↔ looking for, both ways. `raw = 0.6·sat(overlap) + 0.4·sat(complement)`. | No |
| Shown score | Percentile of the pair's raw score within the room. | No |
| Room topics | Average-linkage clustering of all topics in the room; clusters spanning two or more people. The suggestion is the largest cluster with the viewer and two others. | No |
| Explanation | One line per matched topic pair and one next step. It can only cite pairs the matcher found. | Yes, structured output |

## Metrics

- **AUC** of the raw score, strong vs none and any vs none, over the labeled pairs.
- **By pair kind**: overlap, paraphrase and complement pairs should produce a topic pair; hard negatives (same words, different meaning) should not.
- **Top 3**: whether each person's top three includes a labeled strong partner, and how many labeled-none people appear there.
- **Room Jaccard**: best overlap between each expected cluster and a found cluster.
- **Card distillation** (LLM mode): recall of gold topics and possible leaks of sensitive memories.

The data set is small. Use `tune` to find a stable range, not one exact setting.
