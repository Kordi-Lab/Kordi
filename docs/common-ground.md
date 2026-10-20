# Common ground

Common ground helps people at an event find who to talk to. Your agent writes an interest card from sources you choose. People meet by **tapping phones** (one to one) or by entering the same **4-digit room code** (a whole room at once), and the agent shows what they share and what each can offer the other.

This document is the UX and UI design for iOS and macOS. It is tracked in [#1847](https://github.com/Kordi-Lab/Kordi/issues/1847). The interactive design preview is in `docs/design-previews/common-ground/`. The algorithm and its evaluation are in `experiments/common-ground-lab/`.

## Principles

- **Meeting first.** The feature is used standing in a hallway. Every screen has one primary action, reachable with a thumb, and nothing to read before acting.
- **Your card is yours.** Sources are opt-in, every topic shows where it came from, and you can edit, hide or delete any topic. Others see topics only, never references.
- **Common ground leads into Kordi.** A match becomes a contact request and a chat; a room becomes a group. Nothing lives only inside the feature.
- **Kordi look.** Use the existing session-detail and settings components, sentence-case headings, minimal copy (a title and at most one short line), circular avatars, and 8 pt rounded tags.

## Entry points

| Where | iOS | macOS |
|---|---|---|
| Primary | The Contacts toolbar icon beside **Add contact**: a hug glyph (two people and a small heart) in the same style as the other toolbar icons, with a red dot when a room invitation is waiting. No pinned row in the list. | A **Common ground** row with the same hug glyph, pinned at the top of the Contacts list. Selecting it opens Common ground in the Contacts detail area, the way selecting a contact opens their profile. No separate sidebar item. |
| Card and sources | **Settings › Common ground**: your card, sources, sharing on or off, delete card. | The card column on the page; the same settings in **Settings › Common ground**. |
| Deep links | `kordi://common-ground/room/<code>` and pairing QR codes open the app at the right step. | The same links open the page. |
| Availability | Shown only when the server reports the `commonGroundVersion` capability. | Same. |

## Flows

### 1. First run: build your profile

1. **Intro.** Your avatar, the title "Find your common ground", one line: "Your agent writes a card from sources you choose. Only people you meet see it." Primary button **Build my card**.
2. **Sources.** One screen, grouped. Every source is off until the person turns it on.
   - **Kordi**: Memory (the account's saved memories) and each connected connector (Gmail, Google Calendar, GitHub, Slack). A connector that is not connected shows **Connect**, which opens Settings › Connectors and returns here.
   - **On this iPhone** (iOS) / **On this Mac** (macOS): Calendar, Reminders. **Allow** shows the system prompt; the row then shows the count found and a switch.
   - **Agents on this Mac** (macOS only): instruction and memory files from local coding agents, redacted before use.
   - **Links**: URLs and text separated by `;` (homepage, ORCID, papers). Sites that need sign-in are skipped with a reason.
   - **Notes**: free text.
   - Primary button **Build profile**, enabled when at least one source is on.
3. **Building.** The Kordi mark and two steps ("Reading sources", "Writing your card"). Usually 10 to 30 seconds.
4. **Your card.** See [Card](#card). The first visit shows a single line under the title: "Remove anything you don't want to share."

### 2. Home

- Hero: your avatar and name.
- Actions, side by side: **Tap** (iOS) or **Pair** (macOS), and **Pair code**.
- **Your card**: the top topics as tags; tap to open the card.
- **Recent**: people you matched with, newest first, with match percentage and one-line reason. Tap to open the match.

### 3. Tap and pair (one to one)

- **iOS, supported iPhones**: "Hold near another iPhone." Two phones close together exchange pairing tokens over NearbyInteraction and MultipeerConnectivity, then both open the match.
- **QR code, every device**: a segmented control switches **Tap** and **QR**. QR shows your pairing code as a QR code with a short text code under it, and **Scan** opens the camera. On macOS the page shows your QR code and a field for the other person's short code (a Mac cannot scan).
- A pairing token is valid for 2 minutes and can be used once. Pairing makes each card visible to the other person.

### 4. Rooms (many people)

- **Pair code**: a 4-digit keypad. Everyone at the event enters the same code. The first person to enter a free code creates the room and may name it ("NeurIPS poster session"); others see the name when they join.
- **Lobby**: the room name and code, a live grid of members as they arrive, and **Find common ground** (enabled when at least two others are present). Tapping a member shows their card (topics only) right away, before matching. Members can leave at any time.
- **Results**:
  - **Suggested group**: the largest cluster that includes you and at least two others, as one card: the shared theme, the members' avatars, and **Start group**.
  - **Room topics**: themes several people share, each with the people in it.
  - **People**: everyone ranked by match with you, with percentage and a one-line reason. Tap opens the match.
- A room expires 24 hours after its last join. Codes are rate-limited per account and per device; a wrong or expired code shows "Room not found".

### 5. Match

- Hero: the two avatars overlapped, the match percentage, the other person's name and affiliation.
- Actions: **Add** (sends a contact request; becomes **Requested**, then **Message** once accepted), **Joint idea** (creates a shared document drafted from the shared topics), **Meet** (proposes a calendar event through the Kordi calendar), **Share** (shares the match summary).
- A segmented control: **Shared** (topics you both have, each with a short reason) and **Trade** (what you bring, what they bring, each with the topic it serves).
- When there is little in common: "No clear overlap yet" on Shared and "No clear trade yet" on Trade.

### 6. Start a group from a room

- **Start group** on the suggested group opens a confirmation sheet: group name (prefilled with the theme), the members with check marks, **Create**.
- The group is created with you and the members who are already contacts. Everyone else in the selection gets an in-app invitation in the room results ("Alex invited you to …", **Join**), backed by a group invite link, so no one is added without accepting.

## Card

- **Now**: up to six topics, ranked by how often and how recently they come up in your sources.
- **Working on**, **Interests**, **Can help with**, **Looking for**: tags with **×** to remove and **+ Add** to type one (up to 40 characters).
- **Timeline**: each topic at the time it first appeared (quarters for the last year, then years). Topics without recent evidence are muted.
- **References**: tapping a tag opens a sheet with the topic, first and last seen dates, and the sources behind it (source, date, title, snippet; a link when there is one). References are visible only to you.
- Footer: **Rebuild card**. In Settings: **Share my card** (off hides you from new rooms and pairings), **Delete card**.

## States

| State | Behavior |
|---|---|
| No card yet | Tap, Pair and Pair code open the first-run flow, then continue. |
| Building failed | The sources screen with a one-line error and **Try again**. |
| Source permission denied | The row shows "Access is off" and **Settings**. |
| Camera denied (QR scan) | "Camera access is off" and **Settings**; the short-code field stays available. |
| Alone in lobby | The member grid shows only you and "Waiting for others". |
| Room not found or expired | Inline error under the keypad; the code is cleared. |
| Too many attempts | "Try again in a minute." |
| Offline | Actions disabled with "You're offline" in the toast. |
| Sharing off | Tap, Pair and Pair code ask to turn sharing back on. |

## Privacy

- Sources are read only after the person turns them on. Device data is limited to titles and dates. Agent files are redacted (emails, links, paths, keys) before use.
- The card leaves out health, family, money, relationships, locations and similar personal topics.
- Others see your topics only after you share a room or a pairing with them, and never see references or hidden topics.
- Card building and matching run on Kordi's servers; source text is kept only as the short references your card cites.

## Server

### Actions

Routes under `/v1/cloud/common-ground/`. Every person returned in Common ground carries a `relationship` (contact, pending request either way, direct conversation).

- `POST people/:id/contact`: Add; sends a contact request, or accepts theirs when they asked first.
- `POST people/:id/chat`: Chat; finds or creates the direct conversation with a contact.
- `POST people/:id/meet`: Meet; proposes a plan card in the direct conversation with a contact.
- `POST rooms/:code/group`: Start group; adds your contacts and invites the other room members.
- `POST rooms/:code/invitations/:ref/join`: Join; accepts a room group invitation addressed to you.

## Platform layout

### iOS

- Screens use `SessionDetailBackground`, the round glass back button, and `CommonGroundSection` groups (14 pt radius) with settings rows.
- Actions use `SessionProfileActionButton` tiles; the primary button uses the dark capsule from sign-in.
- Avatars are `IdentityAvatar` clipped to circles; the room uses a grid of circles without a backing.
- Tags are 32 pt high, 8 pt radius, tinted by topic color, with a leading dot.
- References, start group and sources open as sheets with medium and large detents.

### macOS

- Opened from the pinned row in Contacts, it fills the Contacts detail area; two columns at widths above 980 pt: **left**, your card (Now, sections, timeline); **right**, Pair and Pair code, then Recent. Narrower windows stack the columns.
- Rooms and matches replace the right column; a back button returns. References and start group open as dialogs (`AppDialog`).
- Tailwind with the semantic tokens in `theme-palette.css`, `lucide-react` icons, `IdentityAvatar` and the circle grid avatar, settings rows from `settingsLayout`.

## Copy

Sentence case. A title and at most one short line per screen. Buttons are verbs: Build profile, Tap, Pair, Pair code, Find common ground, Start group, Add, Message, Joint idea, Meet, Share, Rebuild card.

## Decisions from review

- Common ground lives in Contacts on both platforms: on iOS the toolbar icon beside Add contact (no pinned row), on macOS a pinned row at the top of the Contacts list. It is not a tab or a sidebar item.
- **Meet** ships in the first version.
- People in a room can see each other's cards in the lobby, before **Find common ground**.
- Rooms expire 24 hours after the last join.
