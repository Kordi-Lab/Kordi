# Overlong Hotspot Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the four next #235 overlong hotspots with small behavior-preserving splits.

**Architecture:** Keep public APIs, Tauri command names, CSS selectors, and test names unchanged. Split by responsibility: chat-start routing tests, imported shell CSS layers, desktop runtime attachment helpers, and desktop Tauri chat attachment/artifact helpers.

**Tech Stack:** TypeScript React node:test, CSS imports, Rust/Tauri, cargo test.

---

### Task 1: Split chat-start routing tests from `chatRouting.test.tsx`

**Files:**
- Create: `app/desktop/tests/chatStartRouting.test.tsx`
- Modify: `app/desktop/tests/chatRouting.test.tsx`

- [ ] **Step 1: Capture baseline test names**

Run:
```bash
cd /Users/shuyang/kordi-worktrees/issue-235-maintainability-boundaries
rg "^test\\(" app/desktop/tests/chatRouting.test.tsx -n
```
Expected: test names include `sidebar shell forwards chat create and group management handlers` through `bridge Chat starts an agent session instead of selecting an existing same-node person conversation` at the top of `chatRouting.test.tsx`.

- [ ] **Step 2: Move the chat-start test helpers and tests**

Create `app/desktop/tests/chatStartRouting.test.tsx` containing:
```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleMainContentSlot } from '../src/app/assembleMainContentSlot';
import { assembleSidebarSlot } from '../src/app/assembleSidebarSlot';

// Move directPersonConversation, directAgentConversation, baseSidebarArgs, baseShellArgs,
// and the first eight chat-start/sidebar tests from chatRouting.test.tsx unchanged.
```

Remove those moved helpers/tests from `app/desktop/tests/chatRouting.test.tsx`. Keep every moved test name unchanged.

- [ ] **Step 3: Verify desktop tests**

Run:
```bash
pnpm --dir app/desktop test:unit
```
Expected: all desktop unit tests pass, with the same moved test names reported from `chatStartRouting.test.tsx`.

- [ ] **Step 4: Commit**

Run:
```bash
git add app/desktop/tests/chatStartRouting.test.tsx app/desktop/tests/chatRouting.test.tsx
git commit -m "Split chat start routing tests"
```

### Task 2: Split `shell.css` into imported responsibility layers

**Files:**
- Create: `app/desktop/src/styles/shell-bubbles.css`
- Create: `app/desktop/src/styles/shell-popovers.css`
- Create: `app/desktop/src/styles/shell-transcript.css`
- Modify: `app/desktop/src/styles/shell.css`
- Modify: `app/desktop/src/index.css`
- Modify test CSS readers that directly read `shell.css`.

- [ ] **Step 1: Locate direct shell CSS readers**

Run:
```bash
rg "src/styles/shell.css|shellCss" app/desktop/tests -n
```
Expected: direct readers in markdown, message bubble, theme token, tool timeline, transcript mention, and workspace sidebar tests.

- [ ] **Step 2: Add a CSS test helper**

Create `app/desktop/tests/helpers/readDesktopStyles.ts`:
```ts
import { readFileSync } from 'node:fs';

const STYLE_FILES = [
  '../src/styles/shell.css',
  '../src/styles/shell-popovers.css',
  '../src/styles/shell-bubbles.css',
  '../src/styles/shell-transcript.css',
  '../src/styles/theme-tokens.css',
] as const;

export function readDesktopStyleCss() {
  return STYLE_FILES
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');
}
```

Update direct CSS tests to use `readDesktopStyleCss()` where they need shell selectors after the split.

- [ ] **Step 3: Move CSS selector groups without renaming selectors**

Move `.app-chat-create-*` and `.app-group-management-*` selectors to `shell-popovers.css`.
Move `.app-message-bubble-*`, `.app-human-bubble-*`, and bubble path selectors to `shell-bubbles.css`.
Move `.app-transcript-*`, markdown, mention, and tool timeline selectors to `shell-transcript.css`.
Keep remaining layout/shell/sidebar selectors in `shell.css`.

Add imports to `app/desktop/src/index.css`:
```css
@import './styles/shell.css';
@import './styles/shell-popovers.css';
@import './styles/shell-bubbles.css';
@import './styles/shell-transcript.css';
```

- [ ] **Step 4: Verify affected frontend tests**

Run:
```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop lint
```
Expected: all desktop unit tests and lint pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add app/desktop/src/styles app/desktop/src/index.css app/desktop/tests
git commit -m "Split shell CSS responsibility layers"
```

### Task 3: Extract desktop runtime attachment helpers

**Files:**
- Create: `agent/crates/cli/src/desktop_runtime/attachments.rs`
- Modify: `agent/crates/cli/src/desktop_runtime.rs`

- [ ] **Step 1: Add focused attachment helper tests**

In `agent/crates/cli/src/desktop_runtime/attachments.rs`, include tests for `attachment_metadata_from_path`, `attachment_summary_from_metadata`, and `expand_prompt_with_attachment_paths`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_expansion_quotes_paths_with_spaces() {
        let expanded = expand_prompt_with_attachment_paths("see these", &["/tmp/a b.png".to_string()]);
        assert!(expanded.contains("see these"));
        assert!(expanded.contains("@\"/tmp/a b.png\""));
    }
}
```

- [ ] **Step 2: Move attachment helper functions**

Move these functions from `desktop_runtime.rs` to `desktop_runtime/attachments.rs` and expose them as `pub(super)` where needed:
```rust
attachment_is_image
attachment_format_label_from_path
attachment_name_from_path
attachment_mime_type_from_path
attachment_metadata_from_path
attachment_summary_from_metadata
attachments_from_details
image_attachments_from_blocks
merge_attachment_metadata
quote_attachment_path
expand_prompt_with_attachment_paths
load_images_from_paths
```

Keep `append_attachment_context_message` in `desktop_runtime.rs` unless moving it requires unrelated session-store imports.

- [ ] **Step 3: Wire imports**

At the top of `desktop_runtime.rs`, add:
```rust
mod attachments;
use attachments::{
    attachment_metadata_from_path,
    attachment_summary_from_metadata,
    attachments_from_details,
    expand_prompt_with_attachment_paths,
    image_attachments_from_blocks,
    load_images_from_paths,
    merge_attachment_metadata,
};
```

- [ ] **Step 4: Verify Rust CLI tests**

Run:
```bash
cargo fmt --all -- --check
cargo test -p kordi-cli desktop_runtime --no-default-features
```
Expected: formatting check and desktop runtime tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add agent/crates/cli/src/desktop_runtime.rs agent/crates/cli/src/desktop_runtime/attachments.rs
git commit -m "Extract desktop runtime attachment helpers"
```

### Task 4: Extract desktop Tauri chat attachment and artifact helpers

**Files:**
- Create: `app/desktop/src-tauri/src/chat/attachments.rs`
- Create: `app/desktop/src-tauri/src/chat/artifacts.rs`
- Modify: `app/desktop/src-tauri/src/chat.rs`

- [ ] **Step 1: Add focused helper tests in new modules**

In `app/desktop/src-tauri/src/chat/attachments.rs`, include tests for `safe_attachment_name` and extension-derived metadata.
In `app/desktop/src-tauri/src/chat/artifacts.rs`, include tests for `normalize_path_lexically` and base-path containment.

- [ ] **Step 2: Move attachment storage helpers and command functions**

Move these from `chat.rs` to `chat/attachments.rs`:
```rust
attachment_storage_dir
attachment_extension
stored_attachment_kind
stored_attachment_mime_type
stored_attachment_format_label
safe_attachment_name
downloads_dir
unique_download_path
ensure_attachment_file_path
unique_attachment_path
stored_attachment_from_path
desktop_chat_store_attachment
desktop_chat_store_attachment_path
desktop_chat_download_attachment
```

Re-export command functions from `chat.rs`:
```rust
pub use attachments::{
    desktop_chat_download_attachment,
    desktop_chat_store_attachment,
    desktop_chat_store_attachment_path,
};
```

- [ ] **Step 3: Move artifact helpers and command functions**

Move these from `chat.rs` to `chat/artifacts.rs`:
```rust
artifact_base_path
project_root_is_set
normalize_path_lexically
ensure_artifact_path_within_base
resolve_artifact_preview_path
resolve_artifact_directory_path
artifact_file_kind
desktop_chat_artifact_preview
desktop_chat_artifact_directory
```

Re-export command functions from `chat.rs`:
```rust
pub use artifacts::{desktop_chat_artifact_directory, desktop_chat_artifact_preview};
```

- [ ] **Step 4: Verify desktop Rust tests**

Run:
```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop --no-default-features
```
Expected: formatting check and desktop Rust tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add app/desktop/src-tauri/src/chat.rs app/desktop/src-tauri/src/chat/attachments.rs app/desktop/src-tauri/src/chat/artifacts.rs
git commit -m "Extract desktop chat file helpers"
```

### Task 5: Update maintainability docs and PR validation

**Files:**
- Modify: `docs/development/maintainability-boundaries.md`

- [ ] **Step 1: Update completed slices**

Add bullets describing the chat routing test split, shell CSS split, desktop runtime attachment helper extraction, and desktop Tauri chat file helper extraction.

- [ ] **Step 2: Run final verification**

Run:
```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm test:scripts
pnpm maintainability:scan -- --min-lines 1000 --limit 12
cargo fmt --all -- --check
cargo test -p kordi-cli desktop_runtime --no-default-features
cargo test -p kordi-desktop --no-default-features
git diff --check
```
Expected: all commands pass; maintainability scan still reports remaining broad hotspots but reflects smaller split files.

- [ ] **Step 3: Commit docs**

Run:
```bash
git add docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-overlong-hotspot-cleanup.md
git commit -m "Document overlong hotspot cleanup slices"
```
