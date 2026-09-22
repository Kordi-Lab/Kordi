# Projects in Agent Chat

Projects stay in Agent Chat. The composer selects a local workspace, and the sidebar groups sessions under collapsible project folders. Unassigned chats appear in a flat Recents section without a folder icon or project indentation. The session context menu moves a chat between projects or back to Recents using No project. Changing a project's session binding updates its execution directory; running tasks must stop before their directory changes.

Add project opens a local-folder or GitHub import dialog. Local folders use the native folder picker, with a manual path fallback. GitHub accepts repository URLs or owner/repository, and lists accessible repositories using the user's authenticated GitHub CLI. Public HTTPS cloning works with Git alone; private repositories use existing Git credentials or GitHub CLI authentication. Missing authentication has an actionable error and does not disable URL entry. Credentials never pass through the renderer.

GitHub clones use a newly reserved directory under the selected parent (KordiProjects by default). Existing directories are never overwritten. Completed clones are reused if opening the session needs a retry. Explicit empty project sessions remain discoverable across restarts.

## Local review

Run the desktop Vite development server using the repository's isolated development settings, then open `/tests/visual/chatProjectWorkspace.html`. The preview uses the real sidebar, conversation, project picker and import dialog with synthetic data and an injected import API. It neither reads files nor clones repositories. `?theme=dark` selects dark appearance.

## Validation

- Project grouping, fork ancestry, empty sessions and chat routing regression tests.
- Project action tests for draft preservation, background assignments and new sessions.
- Import tests for validated repository inputs and retrying session activation without cloning twice.
- Browser tests for grouping, moving sessions, local/GitHub import, keyboard use and both appearances.
- Native tests for execution-directory persistence, empty project projection, paths with spaces and existing-directory protection.
- iOS UI coverage opens the composer picker, moves a session, detaches it to Recents, and verifies collapse and expansion.

## iPhone and Mac

iPhone uses the same Projects and Recents structure with Dynamic Type and native sheets. The project chip sits below the composer. Long-press a session to move it; a project folder's plus button creates a session in that workspace. Local folder selection opens the system picker on the connected Mac. GitHub discovery uses that Mac's signed-in GitHub CLI, and cloning stays on the Mac.

Project discovery is account-scoped and publishes opaque IDs, names and session membership. Filesystem roots and credentials remain on the Mac. Commands are claimed once by the addressed device; membership is published before a successful acknowledgement. Offline devices remain discoverable, with actions disabled. Project tasks cannot fall back to cloud execution or another Mac's filesystem. Changing projects is blocked while a task is active.

The cloud server must include migration 100 and the project routes. Validate backend changes in an allocated development stack; the existing shared backend is not sufficient until it contains this revision. Build iOS with Kordi Beta and the task's explicit loopback API origin. `--preview-data --preview-agent-page --preview-projects` renders synthetic visual review data without importing real files.
