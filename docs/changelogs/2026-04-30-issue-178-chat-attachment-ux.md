# Issue #178 — Chat attachment paste and image-card polish

- Fixed duplicate first-paste image insertion by deduping clipboard files exposed through both `clipboardData.files` and `clipboardData.items` with a stable `name + size + type` identity.
- Persisted staged composer attachments across refresh/restart as durable Kordi-managed local copies, rehydrating metadata while dropping stale `blob:` preview URLs.
- Generated friendly timestamped screenshot names for generic clipboard image filenames such as `image.png` and `pi-clipboard-*.png`.
- Copied pasted local file paths into Kordi attachment storage so sent/staged attachments no longer depend on external temp/source files staying in place.
- Updated chat image attachments to render as quiet IM-style cards with hidden generic filename chrome, download/open actions, and a designed fallback for unavailable previews.
- Preserved local attachment `sizeBytes`, `mimeType`, and `localPath` through desktop runtime and transcript mapping so new image cards can show `size • format` metadata.
- Slightly increased image-card metadata contrast using bubble/theme-aware color mixing instead of low-contrast gray text.
