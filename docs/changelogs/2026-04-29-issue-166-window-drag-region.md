# Issue #166 — Desktop window drag region

- Added explicit Tauri `startDragging` handling for the native desktop shell top chrome so the window can be moved from a comfortable header/toolbar band instead of only the tiny native top strip.
- Preserved interactions by excluding buttons, inputs, resize handles, editable titles, and explicit no-drag regions from window dragging.
- Added regression coverage for the drag-target classifier and the required Tauri `core:window:allow-start-dragging` capability.
