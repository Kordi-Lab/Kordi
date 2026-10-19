"""Topic embedders.

`semantic` is a small local sentence model (no API key, runs on CPU).
`lexical` hashes character trigrams; it is the baseline that shows why
wording-level matching is not enough (paraphrases, hard negatives).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache"


def _normalize(m: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(m, axis=1, keepdims=True)
    n[n == 0] = 1
    return m / n


class LexicalEmbedder:
    name = "lexical"

    def __init__(self, dims: int = 4096):
        self.dims = dims

    def embed(self, texts: list[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.dims), dtype=np.float32)
        for i, text in enumerate(texts):
            t = f"  {text.lower()}  "
            for j in range(len(t) - 2):
                h = int.from_bytes(hashlib.blake2b(t[j:j + 3].encode(), digest_size=4).digest(), "little")
                out[i, h % self.dims] += 1
        return _normalize(out)


class SemanticEmbedder:
    name = "semantic"
    model_name = "BAAI/bge-small-en-v1.5"

    def __init__(self):
        from fastembed import TextEmbedding

        self.model = TextEmbedding(self.model_name)
        CACHE_DIR.mkdir(exist_ok=True)
        self.cache_path = CACHE_DIR / "semantic.json"
        self.cache: dict[str, list[float]] = (
            json.loads(self.cache_path.read_text()) if self.cache_path.exists() else {}
        )

    def embed(self, texts: list[str]) -> np.ndarray:
        missing = [t for t in dict.fromkeys(texts) if t not in self.cache]
        if missing:
            for text, vec in zip(missing, self.model.embed(missing)):
                self.cache[text] = [float(x) for x in vec]
            self.cache_path.write_text(json.dumps(self.cache))
        return _normalize(np.array([self.cache[t] for t in texts], dtype=np.float32))


def make_embedder(name: str):
    if name == "lexical":
        return LexicalEmbedder()
    if name == "semantic":
        return SemanticEmbedder()
    raise SystemExit(f"unknown embedder: {name}")
