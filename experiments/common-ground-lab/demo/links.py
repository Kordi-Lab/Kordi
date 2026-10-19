"""Read the public pages a tester lists for their card.

Entries are separated by ";" or new lines. Each entry is either a link or
plain text. Links are read once, like a link preview, with small size and
time limits. Each item read becomes dated evidence (a repository, a paper, a
page) so every card topic can point back to where it came from and when. Sites that require sign-in or forbid automated reading
(LinkedIn, Google Scholar) are skipped with a reason, so the tester can
paste that text instead.
"""
from __future__ import annotations

import html
import ipaddress
import re
import socket
from dataclasses import dataclass, field
from urllib.parse import urlparse

import httpx

MAX_BYTES = 1_500_000
MAX_CHARS = 6000
HEADERS = {"User-Agent": "KordiCommonGroundDemo/0.1 (link preview for a user-provided page)"}

SKIP = {
    "linkedin.com": "LinkedIn needs sign-in. Paste your profile text instead.",
    "scholar.google.com": "Google Scholar blocks automated reading. Paste your paper titles instead.",
    "x.com": "X needs sign-in. Paste your bio instead.",
    "twitter.com": "X needs sign-in. Paste your bio instead.",
    "facebook.com": "Facebook needs sign-in.",
    "instagram.com": "Instagram needs sign-in.",
}


@dataclass
class Gathered:
    # Each item: {source, title, date (YYYY-MM-DD or None), url (or None), text}
    evidence: list[dict] = field(default_factory=list)
    used: list[str] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)


def item(source: str, title: str, date: str | None, url: str | None, text: str) -> dict:
    return {"source": source, "title": " ".join(title.split())[:140], "date": (date or None) and date[:10], "url": url, "text": text[:MAX_CHARS]}


def split_entries(raw: str) -> list[str]:
    return [e.strip() for e in re.split(r"[;\n]", raw) if e.strip()]


def as_url(entry: str) -> str | None:
    if re.match(r"^https?://", entry, re.I):
        return entry
    if " " not in entry and re.match(r"^[\w.-]+\.[a-z]{2,}(/\S*)?$", entry, re.I):
        return "https://" + entry
    return None


def host_of(url: str) -> str:
    host = urlparse(url).hostname or ""
    return host[4:] if host.startswith("www.") else host


def page_date(body: str) -> str | None:
    found = re.search(r'<meta[^>]+(?:property|name)=["\'](?:article:published_time|article:modified_time|date|dc\.date|citation_publication_date)["\'][^>]+content=["\'](\d{4}[-/]\d{2}(?:[-/]\d{2})?)', body, re.I)
    return found.group(1).replace("/", "-") if found else None


def page_text(body: str) -> str:
    title = re.search(r"<title[^>]*>(.*?)</title>", body, re.I | re.S)
    desc = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']', body, re.I | re.S)
    main = re.sub(r"<(script|style|noscript|svg|nav|footer|header)[^>]*>.*?</\1>", " ", body, flags=re.I | re.S)
    main = re.sub(r"<[^>]+>", " ", main)
    main = re.sub(r"\s+", " ", html.unescape(main)).strip()
    head = " — ".join(html.unescape(m.group(1)).strip() for m in (title, desc) if m)
    return (head + "\n" + main)[:MAX_CHARS]


def read_github(client: httpx.Client, user: str) -> list[dict]:
    profile = client.get(f"https://api.github.com/users/{user}").raise_for_status().json()
    repos = client.get(f"https://api.github.com/users/{user}/repos", params={"sort": "pushed", "per_page": 30}).raise_for_status().json()
    out = []
    bio = f"{profile.get('bio') or ''} {profile.get('company') or ''}".strip()
    if bio:
        out.append(item("GitHub", "Profile", None, profile.get("html_url"), bio))
    for r in repos:
        if r.get("fork"):
            continue
        topics = ", ".join(r.get("topics") or [])
        text = f"Repository {r['name']}: {r.get('description') or ''} {r.get('language') or ''} {topics}".strip()
        out.append(item("GitHub", r["name"], r.get("pushed_at") or r.get("created_at"), r.get("html_url"), text))
    return out


def read_openalex(client: httpx.Client, author_filter: str) -> list[dict]:
    """Papers with publication dates and OpenAlex's own topic label per paper."""
    data = client.get("https://api.openalex.org/works", params={
        "filter": author_filter, "sort": "publication_date:desc", "per_page": 50,
        "select": "id,doi,title,publication_date,primary_topic",
    }).raise_for_status().json()
    out = []
    for w in data.get("results", []):
        if not w.get("title"):
            continue
        topic = (w.get("primary_topic") or {}).get("display_name")
        text = f"Paper: {w['title']}" + (f" (topic: {topic})" if topic else "")
        out.append(item("Paper", w["title"], w.get("publication_date"), w.get("doi") or w.get("id"), text))
    return out


def read_orcid(client: httpx.Client, orcid: str) -> list[dict]:
    found = read_openalex(client, f"author.orcid:{orcid}")
    if found:
        return found
    data = client.get(f"https://pub.orcid.org/v3.0/{orcid}/works", headers={"Accept": "application/json"}).raise_for_status().json()
    out = []
    for group in data.get("group", []):
        summary = (group.get("work-summary") or [{}])[0]
        title = ((summary.get("title") or {}).get("title") or {}).get("value")
        year = ((summary.get("publication-date") or {}).get("year") or {}).get("value")
        if title:
            out.append(item("Paper", title, f"{year}-01-01" if year else None, None, f"Paper: {title}"))
    return out


def is_public(host: str) -> bool:
    """Only read pages on the public internet, never this machine or a private network."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    return all(ipaddress.ip_address(info[4][0]).is_global for info in infos)


def read_link(client: httpx.Client, url: str) -> list[dict]:
    host = host_of(url)
    if not is_public(urlparse(url).hostname or ""):
        raise ValueError("not a public address")
    path = [p for p in urlparse(url).path.split("/") if p]
    if host == "github.com" and len(path) == 1:
        return read_github(client, path[0])
    if host == "orcid.org" and path and re.match(r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$", path[-1]):
        return read_orcid(client, path[-1])
    if host == "openalex.org" and path and re.match(r"^A\d+$", path[-1], re.I):
        return read_openalex(client, f"author.id:{path[-1].upper()}")
    with client.stream("GET", url) as r:
        r.raise_for_status()
        kind = r.headers.get("content-type", "")
        if "html" not in kind and "text" not in kind:
            raise ValueError(f"unsupported content ({kind.split(';')[0] or 'unknown'})")
        body = b""
        for chunk in r.iter_bytes():
            body += chunk
            if len(body) > MAX_BYTES:
                break
    page = body.decode(r.encoding or "utf-8", errors="ignore")
    title = re.search(r"<title[^>]*>(.*?)</title>", page, re.I | re.S)
    modified = r.headers.get("last-modified")
    date = page_date(page)
    if not date and modified:
        from email.utils import parsedate_to_datetime
        try:
            date = parsedate_to_datetime(modified).date().isoformat()
        except (TypeError, ValueError):
            date = None
    name = html.unescape(title.group(1)).strip() if title else host
    return [item(host, name, date, url, page_text(page))]


def gather(raw: str, today: str) -> Gathered:
    out = Gathered()
    with httpx.Client(timeout=12, follow_redirects=True, headers=HEADERS) as client:
        for entry in split_entries(raw):
            url = as_url(entry)
            if not url:
                out.evidence.append(item("Your words", entry, today, None, entry))
                if "Text" not in out.used:
                    out.used.append("Text")
                continue
            host = host_of(url)
            reason = next((why for domain, why in SKIP.items() if host == domain or host.endswith("." + domain)), None)
            if reason:
                out.skipped.append({"source": host, "reason": reason})
                continue
            try:
                found = read_link(client, url)
            except ValueError as error:
                out.skipped.append({"source": host, "reason": f"Skipped: {error}."})
                continue
            except Exception as error:  # one bad link should not stop the others
                out.skipped.append({"source": host, "reason": f"Could not read the page ({type(error).__name__})."})
                continue
            found = [f for f in found if f["text"].strip()]
            if found:
                out.evidence += found
                out.used.append(host)
    return out
