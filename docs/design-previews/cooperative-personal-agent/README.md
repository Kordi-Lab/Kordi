# Cooperative and Personal agent design preview

Static preview for issue #2091, synthetic data only. Today's `Proactive` row becomes `Cooperative` (group watching, unchanged behavior). The new `Proactive` row lets an agent reach out to its owner. Agent Chats gets a `Personal agent` section at the top that lists each of the owner's agents with one always-online session, avatar and online dot; that session watches the connectors granted to the agent.

## States

- `surface=blueprint` (Mac only): `state=on`, `state=off`, `state=coop` (Cooperative menu), `state=pro` (Proactive menu)
- `surface=session`: `state=outreach`, `state=sent`, `state=off` (Proactive off, the owner asks)
- `surface=list`: `state=push`, `state=list`, `state=menu` (no Archive or Delete)
- `device=mac|ios`, `theme=light|dark`

## Serve

The page loads `../agent-bird-avatars/birds.js`, so serve the parent folder:

```
cd docs/design-previews
python3 -m http.server 8791 --bind 127.0.0.1
```

Open http://127.0.0.1:8791/cooperative-personal-agent/
