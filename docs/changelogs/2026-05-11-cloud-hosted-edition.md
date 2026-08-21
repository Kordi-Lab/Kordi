# Hosted API update

- Added hosted Kordi documentation covering launch commands, local tunnel setup, contact/direct chat routing, group sync, read receipts, agent mentions, and avatar determinism.
- Kordi uses `https://kordi.ai` as the product default; development testing should set `VITE_KORDI_CLOUD_API_BASE=<PUBLIC_TEST_CLOUD_API_BASE>` or point at a self-hosted compatible server.
- Direct chats and groups reuse the existing desktop Bridge-shaped chat UI/state instead of a separate chat overlay.
- Groups sync through hidden `kordi-cloud-group:` controls while preserving separate child session ids and a shared group space id.
- Group members can send group messages without being accepted direct contacts; 1:1 messages still require accepted contacts.
- Group agent mentions route through group transport, not localhost Bridge outreach.
- Generated avatars use stable `kordi-pixel-avatar://...` seeds so profile and group avatars match across instances.
