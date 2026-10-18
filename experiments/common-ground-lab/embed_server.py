"""Loopback embedding service for Common ground (Qwen3-Embedding-0.6B on CPU).

  POST /embed   {"texts": ["...", ...]}  ->  {"model", "dims", "vectors": [[...], ...]}
  GET  /health                            ->  {"ok": true, "model": ...}

Vectors are unit length. Every text is embedded as a research topic with the
same instruction, so any two vectors can be compared with a dot product.
Binds to 127.0.0.1 only; reach it through an IAP tunnel.
"""
from __future__ import annotations

import json
import os
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from sentence_transformers import SentenceTransformer

MODEL = os.environ.get("EMBED_MODEL", "Qwen/Qwen3-Embedding-0.6B")
PROMPT = "Instruct: Represent this research topic to find researchers working on related topics\nQuery: "
PORT = int(os.environ.get("EMBED_PORT", "18090"))
MAX_TEXTS = 256
MAX_CHARS = 300

model = SentenceTransformer(MODEL, device="cpu", model_kwargs={"dtype": torch.float32})
lock = threading.Lock()
cache: OrderedDict[str, list[float]] = OrderedDict()


def embed(texts: list[str]) -> list[list[float]]:
    missing = [t for t in dict.fromkeys(texts) if t not in cache]
    if missing:
        with lock:
            vecs = model.encode(missing, batch_size=32, normalize_embeddings=True, prompt=PROMPT)
        for t, v in zip(missing, vecs):
            cache[t] = [round(float(x), 6) for x in v]
            if len(cache) > 50_000:
                cache.popitem(last=False)
    return [cache[t] for t in texts]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True, "model": MODEL})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            return self.reply(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            texts = body["texts"]
            if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                raise ValueError("texts must be a list of strings")
            if len(texts) > MAX_TEXTS:
                raise ValueError(f"at most {MAX_TEXTS} texts")
            texts = [t.strip()[:MAX_CHARS] for t in texts]
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            return self.reply(400, {"error": str(error)})
        vectors = embed(texts)
        self.reply(200, {"model": MODEL, "dims": len(vectors[0]) if vectors else 0, "vectors": vectors})


if __name__ == "__main__":
    embed(["warm up"])
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
