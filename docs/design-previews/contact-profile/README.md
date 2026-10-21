# Contact profile proposal

Static browser preview for issue #1945: a richer contact profile on Mac and iPhone. It uses synthetic people, loads nothing from the network, and changes nothing outside the page. Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/contact-profile
python3 -m http.server 8702 --bind 127.0.0.1
# open http://127.0.0.1:8702/
```

Query parameters (kept in sync with the controls): `platform=both|mac|ios`, `theme=light|dark`, `fit=window|full`, `page=profile|photos|files|links`, and `state`:

- `current`: today's pane, for comparison.
- `person-online`, `person-offline`, `person-new`: a person with the proposed layout.
- `common-ground`: a person whose common ground card is visible to you.
- `agent`: someone else's agent, with the owner row.
- `own-agent`: your own agent.
- `system`: the Kordi support contact.
- `chat-info`: the Info tab of a Mac person chat (Mac frame only): participants and the Shared with you rows, no repeated profile.

Layout, top to bottom: tinted header with a 96px avatar and online dot, name and one status line, equal action tiles (Message, Mute, Share, More), an info card (Kordi ID, About, Their agent, Contact since), a Shared with you card (Photos, Files, Links, Groups in common), common ground chips when visible, and Delete contact. Mac geometry follows `ContactDetailPane.tsx` and `ContactDetailParts.tsx` in `app/desktop/src/kordi-app/contacts/`; the iPhone sheet uses the flat Settings-sheet style.

Shared media pages: Photos, Files and Links rows open a page inside the same frame, with a macOS-style toolbar header on Mac (Back control, title, item count, aligned to the content column; a hairline only under the popover header) and the native nav bar on iPhone, items grouped by month (photos as a 3-column square grid, files and links as rows). `page` opens one directly; Escape or the chevron returns to the profile. Rows with a count of 0 do nothing.

Frames: the Mac contacts window, a Mac chat info popover (a compact 300px card over a faded chat, shown with `platform=both|mac`), and the iPhone sheet. Sub-page code lives in `shared-pages.js` and `shared-pages.css`.

Approved by the owner on 2026-10-20.
