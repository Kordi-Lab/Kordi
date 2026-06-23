# Kordi UI review preview URLs

These query params initialize UI review state without persisting theme changes or rewriting native/Tauri navigation.

Enable preview state with `kordi-preview=1` or `preview=ui`.

## Core paired theme URLs

- Chats, light: `/?kordi-preview=1&theme=light&view=chats`
- Chats, dark: `/?kordi-preview=1&theme=dark&view=chats`
- Chat tasks rail, light: `/?kordi-preview=1&theme=light&view=chats&detail=tasks`
- Chat artifacts rail, dark: `/?kordi-preview=1&theme=dark&view=chats&detail=artifacts`
- Contacts, light: `/?kordi-preview=1&theme=light&view=contacts&contactGroup=other-users`
- Contacts, dark: `/?kordi-preview=1&theme=dark&view=contacts&contactGroup=other-users-agents`
- Agents, light: `/?kordi-preview=1&theme=light&view=agents&agent=my-core-agent`
- Agents, dark: `/?kordi-preview=1&theme=dark&view=agents&agent=my-core-agent`
- Appearance settings, light: `/?kordi-preview=1&theme=light&view=settings&settings=appearance`
- Appearance settings, dark: `/?kordi-preview=1&theme=dark&view=settings&settings=appearance`

## Supported params

- `theme=light|dark`
- `view=` / `nav=`: `chats`, `contacts`, `agents`, `settings` plus legacy internal ids
- `detail=` / `tab=`: `info`, `context`, `artifacts`, `tasks`
- `session=` / `chat=`: initial chat/session id
- `contactGroup=`: `my-agents`, `other-users-agents`, `other-users`
- `contact=`: initial contact id
- `agent=`: initial agent id
- `settings=`: initial settings section id, if present in the current section list
