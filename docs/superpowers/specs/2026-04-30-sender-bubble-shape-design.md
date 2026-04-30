# Sender Message Bubble Shape Design

## Context

Issue #181 asks for a design-first redesign of human chat message bubble shape. The current outgoing and peer human bubbles are very pill-like (`rounded-[20px]` with a small flattened avatar-side corner). The user reviewed the visual companion and selected **A2 — Clean squared soft-tail**.

## Selected Direction

Use a **soft messenger tail** with **slightly squared edges**:

- Human message bubbles should read as chat bubbles, not generic cards.
- Main corners should be less pill-like than today: visually around `17px` radius.
- Avatar-side lower corner should remain tighter, visually around `5px`, to form the base of the tail.
- Add the WhatsApp-style bottom-corner tail toward the avatar for outgoing and peer human bubbles, mirrored by side: a compact same-baseline nub after a mostly vertical side edge, not a long swoosh or side flap.
- Render the visible bubble as one seamless vector path, not a rectangular bubble plus a separate patched-on tail.
- Keep the design dense and stable for Kordi’s technical chat UI while adding enough inner spacing that text, timestamp, and delivery checks do not feel crowded.
- De-emphasize timestamp/check metadata so it supports the message instead of competing with it.
- Use a restrained, natural entrance/content-settle motion that respects reduced-motion preferences.

## Scope

Apply this shape consistently to:

- outgoing human transcript messages
- peer human transcript messages
- queued outgoing message bubbles in the chat page

Do not change:

- agent messages
- tool timeline cards
- system/action/edit messages
- mention styling
- inline timestamp/check layout
- avatar placement
- attachment rendering

## Architecture

Replace scattered Tailwind radius utilities with semantic shape classes so future shape tuning is centralized. Transcript and queued-message components should reference the same shape constants. A shared bubble backdrop component renders a single SVG path behind content, with CSS variables controlling fill, stroke, shadow, and motion per theme/state.

## Acceptance Criteria

- Outgoing human bubbles use the A2 clean squared soft-tail shape.
- Peer human bubbles mirror the same shape on the left side.
- Queued outgoing bubbles use the same outgoing shape language.
- The tail is seamlessly integrated into one continuous filled/stroked shape with no stitched pseudo-tail pieces.
- The tail remains compact at the lower corner for both short and tall messages and stays on the bubble baseline instead of extending below the bubble.
- Agent/tool/system bubbles are unchanged.
- Existing text, mention, delivery glyph, and attachment content remains intact.
- Timestamp/check metadata is visually quieter and spaced away from the message text.
- Appearance motion is subtle, transform/opacity-based, and disabled for reduced-motion users.
- Tests lock the selected semantic classes and seamless shape layer so hardcoded old rounded utilities and patched pseudo-tails do not return.
