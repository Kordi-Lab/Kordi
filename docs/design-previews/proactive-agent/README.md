# Proactive agent design preview

Static, self-contained preview of the proactive agent feature described in `docs/development/proactive-agent.md`, with synthetic data only. It shows three surfaces: the Proactive row on the Factory Blueprint pane (Mac only), the offer card in the owner's chat with the agent (Mac and iPhone, including the push banner in the pending state), and the agent's threaded reply in the Lab sync group (Mac and iPhone). A Light/Dark toggle covers both platforms. Segmented controls and URL parameters stay in sync.

## States

- `surface=blueprint`: `state=off`, `state=on`, `state=menu` (Mac only)
- `surface=offer`: `state=pending`, `state=working`, `state=done`, `state=declined`, `state=expired`
- `surface=group`: `state=reply`
- `device=mac|ios`, `theme=light|dark`

## Serve

From this folder:

```
python3 -m http.server 8720 --bind 127.0.0.1
```

Examples:

- http://127.0.0.1:8720/?surface=blueprint&state=on&device=mac
- http://127.0.0.1:8720/?surface=offer&state=pending&device=ios
- http://127.0.0.1:8720/?surface=group&state=reply&device=ios&theme=dark
