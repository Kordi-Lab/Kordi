# Workspace color system

Keep Kordi's existing layout, system typography, control sizes, and native glass. Color should make navigation and conversation surfaces feel like one workspace.

The selected chat theme coordinates the whole shell. Quiet uses a restrained blue accent; Midnight uses lavender; Sand uses warm earth tones; Ocean uses teal. Light and dark appearances share the same hue and separate readable foregrounds.

Use the semantic tokens in `src/styles/theme-palette.css`. Existing shell, chat, control, and transient tokens map to that palette. Do not add unrelated gray selections, blue focus rings, or white composer fills in individual components.

- Title bar and sidebar: tinted translucent material. AppKit supplies the native backdrop; browser previews retain CSS blur.
- Chat: a quiet, solid canvas with an opaque background color so the native backing resolves correctly.
- Composer: a translucent raised surface, fine border, subtle highlight, and a visible accent focus ring.
- Menus and dialogs: nearly opaque tinted glass, readable text, and a shared selected state. Portaled surfaces receive their tokens on the body and explicit appearance markers.
- Accessibility: checked text pairs exceed 4.5:1 contrast. Reduced transparency and increased contrast use opaque surfaces.
- Layout: the sidebar column equals the navigation rail plus session panel width; no unused strip belongs between the list and chat.
- Projects: the section label and chevron fold the project list directly. Preserve individual folder expansion states, Pinned, and Recents; keep project creation beside the label.

Keep status colors, such as errors and availability, meaningful and separate from the theme accent.
