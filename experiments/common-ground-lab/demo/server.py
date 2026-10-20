"""Common ground demo server: one tester plus 20 simulated researchers.

  ANTHROPIC_API_KEY=... uv run demo/server.py [--port 18190] [--embed-url http://127.0.0.1:18090]

Embeddings come from the self-hosted Qwen3-Embedding-0.6B service (embed_server.py,
reached through a tunnel). The LLM builds the tester's card, checks candidate
topic pairs, and writes match explanations. Simulated people use cards the LLM
distilled from their fictional memories (lab cache). See demo/API.md.
"""
from __future__ import annotations

import argparse
import glob
import os
import hashlib
import itertools
import json
import random
import re
import sys
import threading
import time
from dataclasses import replace
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import numpy as np

LAB = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(LAB))

from cg import llm  # noqa: E402
from demo import links, profile  # noqa: E402
from demo.github_device import GitHubDevice  # noqa: E402
from cg.algorithm import Params, TopicSpace, card_topics, cluster_room, match, percentile_scores, suggestion  # noqa: E402
from cg.embed import _normalize  # noqa: E402

SIMULATED = ["p01", "p02", "p03", "p04", "p05", "p06", "p07", "p09", "p10", "p11",
             "p13", "p14", "p15", "p17", "p18", "p19", "p21", "p22", "p23", "p26"]
ME = "me"
CARD_KEYS = ("working_on", "interests", "can_help", "looking_for")
ARRIVAL_SECONDS = 0.7
# Trades: a skill one person offers against anything the other works on,
# is interested in, or looks for. Candidates above the floor go to the judge.
TRADE_FLOOR = 0.42
TRADE_CANDIDATES = 8
TRADES_PER_SIDE = 3
STATE = LAB / "demo" / ".state"

# Agent instruction and memory files on this Mac that the card import may read.
# Instruction files first, so they always fit in the character budget.
AGENT_GLOBS = [
    "~/.claude/CLAUDE.md",
    "~/AGENTS.md",
    "~/.codex/AGENTS.md",
    "~/.codex/instructions/*.md",
    "~/.claude/projects/*/memory/*.md",
]
PER_FILE_CHARS = 2500
TOTAL_CHARS = 40000

REDACTIONS = [
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), "[email]"),
    (re.compile(r"\bhttps?://\S+"), "[link]"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[ip]"),
    (re.compile(r"\b(?:sk|ghp|gho|xox[bp]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b"), "[secret]"),
    (re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "[id]"),
    (re.compile(r"(?:~|/Users|/home|/private|/var)/[^\s`'\")]+"), "[path]"),
    (re.compile(r"\b[a-z][a-z0-9-]{2,}-(?:gcp|prod|dev|app|vm)[a-z0-9-]*\b"), "[host]"),
]


def redact(text: str) -> str:
    for pattern, repl in REDACTIONS:
        text = pattern.sub(repl, text)
    return text


def agent_files() -> list[Path]:
    files = []
    for g in AGENT_GLOBS:
        found = sorted(Path(p) for p in glob.glob(os.path.expanduser(g)))
        files += [f for f in found if f.is_file() and f.name != "MEMORY.md"]
    return files


def agent_label(path: Path) -> str:
    home = str(Path.home())
    s = str(path).replace(home, "~")
    return re.sub(r"projects/[^/]+/", "projects/…/", s)


class RemoteEmbedder:
    def __init__(self, url: str):
        self.client = httpx.Client(base_url=url, timeout=120)
        self.cache: dict[str, list[float]] = {}

    def embed(self, texts: list[str]) -> np.ndarray:
        missing = [t for t in dict.fromkeys(texts) if t not in self.cache]
        for start in range(0, len(missing), 128):
            chunk = missing[start:start + 128]
            r = self.client.post("/embed", json={"texts": chunk})
            r.raise_for_status()
            for t, v in zip(chunk, r.json()["vectors"]):
                self.cache[t] = v
        return _normalize(np.array([self.cache[t] for t in texts], dtype=np.float32))


class Demo:
    def __init__(self, embed_url: str, model: str):
        data = json.loads((LAB / "fixtures" / "personas.json").read_text())
        personas = {p["id"]: p for p in data["personas"]}
        cards = json.loads((LAB / ".cache" / f"cards-{model}.json").read_text())
        self.people = {pid: {"id": pid, "name": personas[pid]["name"], "lab": personas[pid]["lab"]} for pid in SIMULATED}
        self.cards = {pid: cards[pid] for pid in SIMULATED}
        self.llm = llm.LLM(model)
        self.judge = llm.Judge(self.llm, LAB / ".cache" / f"verdicts-{model}.json")
        self.space = TopicSpace(RemoteEmbedder(embed_url))
        self.lock = threading.RLock()
        STATE.mkdir(exist_ok=True)
        self.state_path = STATE / "me.json"
        saved = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.my_card: dict | None = saved.get("card")
        self.evidence: list[dict] = saved.get("evidence", [])
        self.recent: list[str] = saved.get("recent", [])
        self.github: str = saved.get("github", "")
        self.github_device = GitHubDevice(self.set_github)
        self.rooms: dict[str, dict] = {}
        self.explanations: dict[str, dict] = {}
        self.params = Params(soft_floor=0.50, shared_threshold=0.70, complement_threshold=0.66)

    # ---------- state ----------

    def save(self):
        self.state_path.write_text(json.dumps({"card": self.my_card, "evidence": self.evidence, "recent": self.recent, "github": self.github}, indent=2))

    def set_github(self, login: str):
        with self.lock:
            self.github = login
            self.save()

    def github_view(self) -> dict:
        return self.github_device.view() | {"login": self.github}

    def github_start(self) -> dict:
        try:
            self.github_device.start()
        except RuntimeError as error:
            raise ApiError(400, str(error))
        return self.github_view()

    def github_disconnect(self) -> dict:
        self.github_device.cancel()
        self.set_github("")
        return self.github_view()

    def card_view(self) -> dict | None:
        if not self.my_card:
            return None
        view = {k: self.my_card.get(k, []) for k in CARD_KEYS} | {"hidden": self.my_card.get("hidden", [])}
        return view | {"profile": profile.build(self.my_card, self.evidence, date.today())}

    def shown_card(self) -> dict:
        hidden = set(self.my_card.get("hidden", []))
        return {k: [t for t in self.my_card.get(k, []) if t not in hidden] for k in CARD_KEYS}

    def person(self, pid: str) -> dict:
        return {"id": ME, "name": "You", "lab": ""} if pid == ME else self.people[pid]

    # ---------- scoring ----------

    def all_cards(self) -> dict[str, dict]:
        cards = dict(self.cards)
        if self.my_card:
            cards[ME] = self.shown_card()
        return cards

    def ensure_topics(self, cards):
        self.space.add([t for c in cards.values() for t in card_topics(c)])

    def run_judged(self, fn):
        with self.lock:
            result = fn()
            if self.judge.pending:
                print(f"checking {len(self.judge.pending)} topic pairs", flush=True)
                self.judge.resolve()
                result = fn()
            return result

    def pair(self, a: str, b: str):
        cards = self.all_cards()
        return match(self.space, cards[a], cards[b], self.params, self.judge)

    def trades(self, helper: str, seeker: str) -> list[dict]:
        """What `helper` can offer `seeker`, each with the topic it serves."""
        cards = self.all_cards()
        give = cards[helper].get("can_help", [])
        targets = list(dict.fromkeys(t for k in ("looking_for", "working_on", "interests") for t in cards[seeker].get(k, [])))
        self.space.add(give + targets)
        sims = self.space.sim(give, targets)
        ranked = sorted(((float(sims[i, j]), g, t) for i, g in enumerate(give) for j, t in enumerate(targets)), reverse=True)
        out, used = [], set()
        for s, g, t in ranked[:TRADE_CANDIDATES]:
            if s < TRADE_FLOOR or g in used:
                continue
            if self.judge("helps", g, t):
                out.append({"topic": g, "for": t})
                used.add(g)
        return out[:TRADES_PER_SIDE]

    def warm(self):
        """Embed and check every simulated pair once so rooms load quickly."""
        t = time.time()
        cards = self.all_cards()
        self.ensure_topics(cards)
        self.run_judged(lambda: [self.pair(a, b) for a, b in itertools.combinations(SIMULATED, 2)])
        print(f"warm in {time.time() - t:.1f}s", flush=True)

    def cluster_threshold(self, cards) -> float:
        topics = sorted({t for c in cards.values() for t in c.get("working_on", []) + c.get("interests", [])})
        sim = self.space.sim(topics, topics)
        return float(np.quantile(sim[np.triu_indices(len(topics), 1)], 0.985))

    # ---------- API ----------

    def sources(self) -> dict:
        return {"agents": [{"label": agent_label(f), "chars": min(f.stat().st_size, PER_FILE_CHARS)} for f in agent_files()]}

    def build_card(self, use_agents: bool, links_text: str, notes: str, device: list | None = None) -> dict:
        today = date.today().isoformat()
        evidence, used, skipped = [], [], []

        def add(source: str, title: str, day: str | None, url: str | None, text: str):
            evidence.append({"id": f"e{len(evidence) + 1}", "source": source, "title": title[:140],
                             "date": day, "url": url, "text": redact(text)})

        if use_agents:
            budget = TOTAL_CHARS
            for f in agent_files():
                if budget <= 0:
                    break
                text = redact(f.read_text(errors="ignore"))[:min(PER_FILE_CHARS, budget)]
                budget -= len(text)
                modified = datetime.fromtimestamp(f.stat().st_mtime).date().isoformat()
                add("Agent memory", agent_label(f), modified, None, text)
                used.append(agent_label(f))
        if links_text.strip():
            g = links.gather(links_text, today)
            for e in g.evidence:
                add(e["source"], e["title"], e["date"], e["url"], e["text"])
            used += g.used
            skipped += g.skipped
        for group in device or []:
            label = str(group.get("source", "device"))[:40]
            count = 0
            for entry in group.get("items", [])[:300]:
                title, day = (entry.get("title", ""), entry.get("date")) if isinstance(entry, dict) else (entry, None)
                title = " ".join(str(title).split())
                if title:
                    add(label, title, str(day)[:10] if day else None, None, title)
                    count += 1
            if count:
                used.append(label)
        if notes.strip():
            add("Notes", "Your notes", today, None, notes.strip()[:4000])
            used.append("Notes")
        if not evidence:
            reason = skipped[0]["reason"] if skipped else "choose at least one source"
            raise ApiError(400, reason)
        lines = []
        for e in evidence:
            head = f"{e['date'] or 'undated'} · {e['source']} · {e['title']}"
            body = e["text"] if e["text"] != e["title"] else ""
            lines.append(head + (f"\n{body}" if body else ""))
        result = self.llm.distill_profile(today, lines)
        card, refs = {}, {}
        for key in CARD_KEYS + ("earlier",):
            card[key] = []
            for topic in result.get(key, []):
                label = " ".join(topic["label"].split())[:60]
                if not label or label in refs:
                    continue
                card[key].append(label)
                refs[label] = [evidence[i]["id"] for i in topic["evidence"] if 0 <= i < len(evidence)]
        cited = {i for ids in refs.values() for i in ids}
        with self.lock:
            self.my_card = card | {"refs": refs, "hidden": []}
            # Keep only what the card cites, so the server never holds unused raw text.
            self.evidence = [e | {"text": e["text"][:600]} for e in evidence if e["id"] in cited]
            self.save()
        self.ensure_topics(self.all_cards())
        return {"card": self.card_view(), "used": used, "skipped": skipped}

    def set_card(self, body: dict) -> dict:
        """Replace the topic lists after the tester removed or added tags."""
        self.require_card()
        card = {}
        for key in CARD_KEYS:
            items = body.get(key, [])
            if not isinstance(items, list):
                raise ApiError(400, f"{key} must be a list")
            clean = []
            for item in items:
                text = " ".join(str(item).split())[:60]
                if text and text.lower() not in {c.lower() for c in clean}:
                    clean.append(text)
            card[key] = clean[:10]
        with self.lock:
            refs = dict(self.my_card.get("refs", {}))
            before = {t for key in CARD_KEYS for t in self.my_card.get(key, [])}
            # Only tags the tester typed get an "Added by you" reference; topics
            # from an older card without references stay undated.
            for label in (t for key in CARD_KEYS for t in card[key]):
                if label not in before and not refs.get(label):
                    eid = f"e{len(self.evidence) + 1}"
                    while any(e["id"] == eid for e in self.evidence):
                        eid = f"e{int(eid[1:]) + 1}"
                    self.evidence.append({"id": eid, "source": "Added by you", "title": label,
                                          "date": date.today().isoformat(), "url": None, "text": label})
                    refs[label] = [eid]
            self.my_card = card | {"earlier": self.my_card.get("earlier", []), "refs": refs, "hidden": []}
            self.save()
        self.ensure_topics(self.all_cards())
        return {"card": self.card_view()}

    def set_hidden(self, hidden: list[str]) -> dict:
        self.require_card()
        with self.lock:
            self.my_card["hidden"] = [h for h in hidden if isinstance(h, str)]
            self.save()
        return {"card": self.card_view()}

    def require_card(self):
        if not self.my_card:
            raise ApiError(409, "build your profile first")

    def join(self, code: str) -> dict:
        self.require_card()
        with self.lock:
            order = SIMULATED[:]
            random.Random(code).shuffle(order)
            self.rooms[code] = {"joined_at": time.time(), "order": order}
        return self.room(code)

    def members(self, code: str) -> list[str]:
        room = self.rooms.get(code)
        if not room:
            raise ApiError(404, "join the room first")
        arrived = int((time.time() - room["joined_at"]) / ARRIVAL_SECONDS) + 1
        return room["order"][:max(0, min(len(room["order"]), arrived))]

    def room(self, code: str) -> dict:
        return {"code": code, "members": [self.person(p) for p in self.members(code)]}

    def headline(self, m) -> str:
        if not m.pairs:
            return "Different area"
        best = max(m.pairs, key=lambda t: t.similarity)
        if best.kind == "shared":
            return best.b
        if best.kind == "b_helps_a":
            return f"Can help with {best.b.lower()}"
        return f"Needs your {best.a.lower()}"

    def results(self, code: str) -> dict:
        self.require_card()
        members = self.members(code)
        everyone = [ME] + members
        cards = self.all_cards()
        self.ensure_topics(cards)

        def compute():
            pairs = {}
            for a, b in itertools.combinations(everyone, 2):
                m = self.pair(a, b)
                pairs[(a, b)] = pairs[(b, a)] = m
            return pairs

        pairs = self.run_judged(compute)
        shown = percentile_scores({k: v.raw for k, v in pairs.items()})
        ranked = sorted(members, key=lambda b: -pairs[(ME, b)].raw)
        people = [{"person": self.person(b), "score": shown[(ME, b)], "headline": self.headline(pairs[(ME, b)])} for b in ranked]

        room_cards = {p: cards[p] for p in everyone}
        p = replace(self.params, cluster_threshold=self.cluster_threshold(room_cards))
        clusters = cluster_room(self.space, room_cards, p)
        topics = [{"label": c.label, "people": [self.person(x) for x in sorted(c.people, key=lambda x: (x != ME, x))]} for c in clusters]
        s = suggestion(clusters, ME)
        sug = {"label": s.label, "people": [self.person(x) for x in sorted(s.people, key=lambda x: (x != ME, x))]} if s else None
        with self.lock:
            self.rooms[code]["scores"] = {b: shown[(ME, b)] for b in members}
        return {"people": people, "topics": topics, "suggestion": sug}

    def score_for(self, pid: str) -> int:
        for room in self.rooms.values():
            if pid in room.get("scores", {}):
                return room["scores"][pid]
        everyone = [ME] + SIMULATED
        pairs = self.run_judged(lambda: {(a, b): self.pair(a, b).raw for a, b in itertools.combinations(everyone, 2)})
        both = pairs | {(b, a): v for (a, b), v in pairs.items()}
        return percentile_scores(both)[(ME, pid)]

    def match_detail(self, pid: str) -> dict:
        self.require_card()
        if pid not in self.people:
            raise ApiError(404, "unknown person")
        self.ensure_topics(self.all_cards())
        m = self.run_judged(lambda: self.pair(ME, pid))
        you_bring, they_bring = self.run_judged(lambda: (self.trades(ME, pid), self.trades(pid, ME)))
        top = sorted(m.pairs, key=lambda t: -t.similarity)[:3]
        key = hashlib.sha1(json.dumps([pid, [(t.a, t.b, t.kind) for t in top]]).encode()).hexdigest()
        if key not in self.explanations:
            self.explanations[key] = self.llm.explain("You", self.people[pid]["name"], top) if top else llm.template_explain("You", self.people[pid]["name"], top)
        e = self.explanations[key]
        whys = {r["pair"]: r["why"] for r in e["reasons"]}
        shared = [{"topic": t.a, "their_topic": t.b, "why": whys.get(i, "")} for i, t in enumerate(top)]
        with self.lock:
            self.recent = [pid] + [r for r in self.recent if r != pid]
            self.save()
        return {
            "person": self.person(pid),
            "score": self.score_for(pid),
            "shared": shared,
            "you_bring": you_bring,
            "they_bring": they_bring,
            "next_step": e["next_step"],
        }

    def tap(self) -> dict:
        self.require_card()
        self.ensure_topics(self.all_cards())
        raws = self.run_judged(lambda: {b: self.pair(ME, b).raw for b in SIMULATED})
        top = sorted(SIMULATED, key=lambda b: -raws[b])[:5]
        fresh = [b for b in top if b not in self.recent] or top
        return {"person": self.person(random.choice(fresh))}

    def recent_view(self) -> dict:
        if not self.my_card:
            return {"people": []}
        out = []
        for pid in self.recent:
            m = self.run_judged(lambda: self.pair(ME, pid))
            out.append({"person": self.person(pid), "score": self.score_for(pid), "headline": self.headline(m)})
        return {"people": out}


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def make_handler(demo: Demo):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}", flush=True)

        def cors(self):
            # The desktop preview page is served from a different loopback port.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.end_headers()

        def reply(self, status: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n)) if n else {}

        def route(self, method: str):
            parts = [p for p in self.path.split("?")[0].split("/") if p]
            b = self.body() if method in ("POST", "PUT") else {}
            match (method, parts):
                case ("GET", ["v1", "me"]):
                    return {"name": "You", "card": demo.card_view(), "github": demo.github}
                case ("GET", ["v1", "me", "sources"]):
                    return demo.sources()
                case ("POST", ["v1", "me", "card", "build"]):
                    return demo.build_card(bool(b.get("use_agents")), str(b.get("links", b.get("linkedin_text", ""))), str(b.get("notes", "")), b.get("device") if isinstance(b.get("device"), list) else None)
                case ("PUT", ["v1", "me", "card"]):
                    return demo.set_card(b)
                case ("PUT", ["v1", "me", "card", "hidden"]):
                    return demo.set_hidden(b.get("hidden", []))
                case ("POST", ["v1", "rooms", code, "join"]):
                    return demo.join(code)
                case ("GET", ["v1", "rooms", code]):
                    return demo.room(code)
                case ("POST", ["v1", "rooms", code, "results"]):
                    return demo.results(code)
                case ("GET", ["v1", "match", pid]):
                    return demo.match_detail(pid)
                case ("POST", ["v1", "tap"]):
                    return demo.tap()
                case ("POST", ["v1", "connect", "github"]):
                    return demo.github_start()
                case ("GET", ["v1", "connect", "github"]):
                    return demo.github_view()
                case ("DELETE", ["v1", "connect", "github"]):
                    return demo.github_disconnect()
                case ("GET", ["v1", "recent"]):
                    return demo.recent_view()
            raise ApiError(404, "not found")

        def handle_method(self, method: str):
            try:
                self.reply(200, self.route(method))
            except ApiError as e:
                self.reply(e.status, {"error": str(e)})
            except Exception as e:  # keep the demo up; show the error in the app
                print(f"error: {e!r}", flush=True)
                self.reply(500, {"error": "server error"})

        def do_GET(self):
            self.handle_method("GET")

        def do_POST(self):
            self.handle_method("POST")

        def do_PUT(self):
            self.handle_method("PUT")

        def do_DELETE(self):
            self.handle_method("DELETE")

    return Handler


def main():
    global STATE
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18190)
    ap.add_argument("--embed-url", default="http://127.0.0.1:18090")
    ap.add_argument("--model", default=llm.DEFAULT_MODEL)
    ap.add_argument("--state", type=Path, default=STATE, help="folder for the tester's saved card")
    args = ap.parse_args()
    STATE = args.state
    if not llm.available():
        raise SystemExit("set ANTHROPIC_API_KEY")
    demo = Demo(args.embed_url, args.model)
    demo.warm()
    print(f"Common ground demo on http://127.0.0.1:{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(demo)).serve_forever()


if __name__ == "__main__":
    main()
