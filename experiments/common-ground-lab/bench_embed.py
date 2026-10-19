"""Embed a fixed list of texts with several models on CPU and record speed.

Runs on a plain CPU machine with no API keys. Writes one vectors file per
model plus stats.json; lab.py evaluates the vectors afterwards.

  python bench_embed.py texts.json out_dir [model ...]
"""
from __future__ import annotations

import json
import resource
import statistics
import sys
import time
from pathlib import Path

# A symmetric instruction: both sides of every comparison are research topics.
QWEN_PROMPT = "Instruct: Represent this research topic to find researchers working on related topics\nQuery: "

MODELS = {
    "bge-small": ("BAAI/bge-small-en-v1.5", None),
    "bge-m3": ("BAAI/bge-m3", None),
    "qwen3-0.6b": ("Qwen/Qwen3-Embedding-0.6B", QWEN_PROMPT),
    "qwen3-4b": ("Qwen/Qwen3-Embedding-4B", QWEN_PROMPT),
    "qwen3-8b": ("Qwen/Qwen3-Embedding-8B", QWEN_PROMPT),
}


def peak_rss_gb() -> float:
    # ru_maxrss is KiB on Linux
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024


def run(slug: str, texts: list[str], out_dir: Path) -> dict:
    import torch
    from sentence_transformers import SentenceTransformer

    torch.set_num_threads(torch.get_num_threads())
    name, prompt = MODELS[slug]
    started = time.perf_counter()
    # Load in float32: recent transformers keep the checkpoint's bfloat16,
    # which is emulated (slow) on CPUs without native bf16 support.
    model = SentenceTransformer(name, device="cpu", model_kwargs={"dtype": torch.float32})
    load_s = time.perf_counter() - started
    kwargs = {"prompt": prompt} if prompt else {}

    model.encode(texts[:8], normalize_embeddings=True, **kwargs)  # warm up
    singles = []
    for text in texts[:30]:
        t = time.perf_counter()
        model.encode([text], normalize_embeddings=True, **kwargs)
        singles.append(time.perf_counter() - t)

    t = time.perf_counter()
    vectors = model.encode(texts, batch_size=32, normalize_embeddings=True, **kwargs)
    batch_s = time.perf_counter() - t

    out = {text: [round(float(x), 6) for x in vec] for text, vec in zip(texts, vectors)}
    (out_dir / f"vectors-{slug}.json").write_text(json.dumps(out))
    stats = {
        "model": name,
        "dims": int(vectors.shape[1]),
        "load_seconds": round(load_s, 1),
        "single_topic_ms_median": round(1000 * statistics.median(singles), 1),
        "single_topic_ms_p90": round(1000 * sorted(singles)[int(0.9 * len(singles)) - 1], 1),
        "topics_per_second_batch": round(len(texts) / batch_s, 1),
        "peak_rss_gb": round(peak_rss_gb(), 1),
        "threads": torch.get_num_threads(),
    }
    print(slug, stats, flush=True)
    return stats


def main():
    texts = json.loads(Path(sys.argv[1]).read_text())
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    slugs = sys.argv[3:] or list(MODELS)
    stats_path = out_dir / "stats.json"
    stats = json.loads(stats_path.read_text()) if stats_path.exists() else {}
    for slug in slugs:
        stats[slug] = run(slug, texts, out_dir)
        stats_path.write_text(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
