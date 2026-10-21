# Contact profile proposal

Static browser preview for issue #1945: a richer contact profile on Mac and iPhone. It uses synthetic people, loads nothing from the network, and changes nothing outside the page. Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/contact-profile
python3 -m http.server 8702 --bind 127.0.0.1
# open http://127.0.0.1:8702/
```

Query parameters (kept in sync with the controls): `platform=both|mac|ios`, `theme=light|dark`, `height=window|full`, and `state`:

- `current`: today's pane, for comparison.
- `person-online`, `person-offline`, `person-new`: a person with the proposed layout.
- `common-ground`: a person whose common ground card is visible to you.
- `agent`: someone else's agent, with the owner row.
- `own-agent`: your own agent.
- `system`: the Kordi support contact.

Layout, top to bottom: tinted header with a 96px avatar and online dot, name and one status line, equal action tiles (Message, Mute, Share, More), an info card (Kordi ID, About, Their agent, Contact since), a Shared with you card (photos and files, links, documents, groups in common), common ground chips when visible, and Delete contact. Mac geometry follows `ContactDetailPane.tsx` and `ContactDetailParts.tsx` in `app/desktop/src/kordi-app/contacts/`; the iPhone sheet uses the flat Settings-sheet style.

Approved by the owner on 2026-10-20.
