# Cloud hosted edition

- Added hosted Cloud Edition documentation covering launch commands, local tunnel setup, Cloud contact/direct chat routing, Cloud group sync, read receipts, agent mentions, and avatar determinism.
- Cloud Edition now uses `https://coordinar.io` as the product default; development testing should set `VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE>` or point at a self-hosted compatible Cloud server.
- Cloud direct chats and Cloud groups reuse the existing desktop Bridge-shaped chat UI/state instead of a separate Cloud chat overlay.
- Cloud groups sync through hidden `kordi-cloud-group:` controls while preserving separate child session ids and a shared group space id.
- Cloud group members can send group messages without being accepted direct contacts; 1:1 Cloud messages still require accepted contacts.
- Cloud group agent mentions route through Cloud group transport, not localhost Bridge outreach.
- Cloud generated avatars use stable `kordi-pixel-avatar://...` seeds so profile and group avatars match across instances.
