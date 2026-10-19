"""Embed the benchmark texts with OpenAI-compatible embedding APIs.

Writes vectors-<slug>.json and adds to stats.json in the same format as
bench_embed.py, so compare.py treats API and self-hosted models alike.

  OPENAI_API_KEY=... OPENAI_BASE_URL=https://.../v1 uv run bench_api.py texts.json out_dir [model ...]
"""
from __future__ import annotations

import json
import os
import statistics
import sys
import time
from pathlib import Path

import httpx

MODELS = {
    "openai-3-large": "text-embedding-3-large",
    "openai-3-small": "text-embedding-3-small",
    "doubao-large": "doubao-embedding-large-text-240915",
}


def embed(client: httpx.Client, model: str, texts: list[str]) -> list[list[float]]:
    r = client.post("/embeddings", json={"model": model, "input": texts})
    r.raise_for_status()
    data = sorted(r.json()["data"], key=lambda d: d["index"])
    return [d["embedding"] for d in data]


def run(client, slug: str, texts: list[str], out_dir: Path) -> dict:
    model = MODELS[slug]
    embed(client, model, texts[:2])  # warm up the connection
    singles = []
    for text in texts[:20]:
        t = time.perf_counter()
        embed(client, model, [text])
        singles.append(time.perf_counter() - t)
    t = time.perf_counter()
    vectors = []
    for start in range(0, len(texts), 100):
        vectors += embed(client, model, texts[start:start + 100])
    batch_s = time.perf_counter() - t
    (out_dir / f"vectors-{slug}.json").write_text(json.dumps(dict(zip(texts, vectors))))
    stats = {
        "model": model,
        "dims": len(vectors[0]),
        "load_seconds": 0,
        "single_topic_ms_median": round(1000 * statistics.median(singles), 1),
        "single_topic_ms_p90": round(1000 * sorted(singles)[int(0.9 * len(singles)) - 1], 1),
        "topics_per_second_batch": round(len(texts) / batch_s, 1),
        "peak_rss_gb": 0,
        "threads": "api",
    }
    print(slug, stats, flush=True)
    return stats


def main():
    texts = json.loads(Path(sys.argv[1]).read_text())
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    client = httpx.Client(
        base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
        timeout=60,
    )
    stats_path = out_dir / "stats.json"
    stats = json.loads(stats_path.read_text()) if stats_path.exists() else {}
    for slug in sys.argv[3:] or list(MODELS):
        stats[slug] = run(client, slug, texts, out_dir)
        stats_path.write_text(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
