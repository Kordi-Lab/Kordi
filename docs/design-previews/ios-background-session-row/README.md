# Background session row proposal

Static browser preview for issue #1938: on iPhone the background session row under an
agent reply wraps its second line ("Background session" spills onto a third line). The
page shows four 393px iPhone-width panels side by side with sample data. It loads no
network resources and changes nothing outside the page.

Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/ios-background-session-row
python3 -m http.server 8701 --bind 127.0.0.1
# open http://127.0.0.1:8701/
```

Query parameters (kept in sync with the controls): `theme=light|dark`,
`status=sync|running|done|stopping`, `title=short|long`, `agent=short|long`.

- Current: today's layout; line 2 wraps at the ~232pt text column.
- Option A (recommended): drop "Background session"; line 2 is `Name · ● Status`, one line, ellipsis.
- Option B: drop "Background session"; name on the left (truncates), status pinned right.
- Option C: Mac parity; `Name · Background session` truncates on one line, status pinned right.

Option B was chosen by the owner on 2026-10-20.

Line 1 (title + "Open ›") is unchanged in all options, and the accessibility label keeps
"background session" in all of them. Geometry follows `BackgroundAgentSessionList` and
`BackgroundAgentSessionRow` in `app/ios/Kordi/Features/Conversation/MessageBubble.swift`.
