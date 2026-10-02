# Desktop local data

This note records what Kordi Desktop keeps on the local machine, how those
copies are protected today, and why Kordi does not add its own encryption to
them yet. Keep it current when a new local store, cache, or permission rule is
added.

## What is stored where

### Cloud edition

`APP_DATA_DIR` is `~/Library/Application Support/<bundle id>` for the Cloud
bundle (`io.kordi.cloud`). Development profiles set their own `APP_DATA_DIR`
and a profile-specific bundle identifier. After sign-in, `KORDI_STORAGE_ROOT`
points at the active account directory, so each account has its own copies.

| Data | Location | Contents |
| --- | --- | --- |
| Account directory | `APP_DATA_DIR/accounts/<account hash>/` | One per account that signed in on this Mac. The name is a hash of the account id. |
| Canonical session database | `accounts/<account hash>/canonical-sessions.sqlite3`, plus `-wal` and `-shm` | Conversation and session metadata, message history, sync cursors, and the outgoing message queue. |
| Agent runtime session database | `accounts/<account hash>/sessions.db` | Local agent transcripts written by the agent runtime. |
| Agent artifacts | `accounts/<account hash>/artifacts/` | Files produced by local agent runs. |
| Remote image and link preview cache | `accounts/<account hash>/kordi/cache/remote-avatars-v1/` | Avatars and link preview images, 30-day expiry, 32 MB cap. |
| Animated emoji cache | `APP_DATA_DIR/cache/blob-emoji-v1/` | Shared emoji artwork; no account data. |
| Attachments | `APP_DATA_DIR/tmp/attachments/` | Files staged for sending, voice recordings, and downloaded attachments (`cloud/<account scope>/`). |
| Signed-out storage root | `APP_DATA_DIR/kordi/` | Used before an account is active. Development builds keep owner-only (`0600`) session files under `cloud-secrets/`. |
| WebKit website data | `~/Library/WebKit/<bundle id>/WebsiteData/` | IndexedDB `kordi-cloud-message-cache` (message cache, `cloudMessageCache.ts`) and `kordi-cloud-group-outbox-v1` (unsent group messages, `cloudGroupOutbox.ts`); `localStorage` preferences such as `kordi.link-previews.v1`. Recent WebKit versions place per-origin data under `Default/`. |
| WebKit network cache | `~/Library/Caches/<bundle id>/WebKit/NetworkCache/` | HTTP responses cached by the web view. |
| Session credentials | macOS Keychain (release builds) | The Cloud session token and the device key (`cloud_session::secret_store`). |

### Local edition

The local edition does not set `APP_DATA_DIR`.

| Data | Location |
| --- | --- |
| Settings, canonical session database, agent runtime `sessions.db`, extensions, and npm and git packages | `~/.kordi/` (or `KORDI_STORAGE_ROOT` when set) |
| Older agent resources | `~/.bb-agent/` |
| Attachments | `kordi-desktop-attachments/` in the system temporary directory (`$TMPDIR` on macOS, usually `/tmp` on Linux) |
| WebKit website data and network cache | As in the Cloud edition, under the local bundle identifier |

## Current protections

### Owner-only permissions (macOS and Linux)

`app/desktop/src-tauri/src/private_storage.rs` makes Kordi data directories
`0700` and the canonical SQLite files `0600`:

| When | What |
| --- | --- |
| Startup, after the stored account is activated | Existing `APP_DATA_DIR`, `KORDI_STORAGE_ROOT`, the preferred settings directory (`~/.kordi` or the account directory), the older `.bb-agent` directory, and the temporary attachment directory become `0700`. This pass is best effort: failures are logged once, without paths, and never block startup. |
| Cloud data directory setup | `APP_DATA_DIR` is created or tightened to `0700`. |
| Account activation | The account directory and its `kordi/` storage root become `0700`. |
| Opening the canonical database on a new connection | Its directory becomes `0700`. The database becomes `0600` before WAL mode is enabled, so SQLite creates `-wal` and `-shm` with the same mode; existing `-wal` and `-shm` files are tightened afterwards. |
| Attachment staging under `APP_DATA_DIR` | The attachment directory is created or tightened to `0700` (best effort). |
| Attachment staging in the system temporary directory | The directory must be a real directory (not a symlink) that this account owns, and it must be `0700` after the change. Changing a mode requires ownership, so a successful change proves it. Otherwise staging fails with "Attachment storage is not private." and nothing is written there. |

Rules that every helper follows:

- It never changes the home directory, `/`, the system temporary directory
  itself, any of their ancestors, relative paths, or paths with fewer than
  three components.
- It never follows symbolic links. A user who moved a data directory elsewhere
  and left a symlink keeps the target's mode, and a directory that is replaced
  by a symlink while it is being checked is not changed.
- It changes directories, not their contents. The only file whose mode changes
  is the canonical database and its `-wal` and `-shm` files. Folders such as
  `~/.kordi` hold npm, git, and extension packages with executables, so their
  files keep their modes; a `0700` directory already keeps other accounts out
  of everything below it.
- On other platforms the permission changes are no-ops.

Where this matters:

- macOS home directories are `drwxr-x---` with the group `staff`, which
  includes every local user. Before this change, the local edition's
  `~/.kordi` was readable by those accounts.
- On Linux, the temporary attachment fallback is in a directory that every
  account can write to.
- `~/Library` and its `Application Support`, `Caches`, and `WebKit` folders are
  already `0700`, so for the Cloud edition and for WebKit storage this is
  defense in depth.

### Other protections

- **FileVault** encrypts the disk while the Mac is shut down. Turning it on is
  the user's choice; Kordi does not check or require it.
- **Session credentials** live in the macOS Keychain in release builds, not in
  these directories.
- Administrators and any process running as the same macOS account can read
  every local copy listed above.

## Link preview network path

Desktop link previews and preview images do not use the system
`LPMetadataProvider`. They use the same native request path as remote avatars
(`remote_image::request_public_remote_image`):

- Only public HTTPS URLs are requested. URLs with credentials, loopback,
  private, link-local, and `.localhost` or `.local` hosts are refused before
  any network access.
- DNS is resolved once, every resolved address must be public, and the
  connection is pinned to those addresses so a second lookup cannot point the
  request at a private address.
- Each redirect (at most three) is validated again.
- Preview HTML is capped at 256 KB with a 10-second timeout. Preview images are
  capped at 2 MB and use the remote image cache above.

**Configured proxies.** When a system or environment HTTP(S) proxy is
configured (see [Network proxy policy](../network-proxy-policy.md)), the
request is sent through that proxy and the proxy resolves the destination, so
address pinning does not apply. The configured proxy is trusted to enforce its
own destination policy, as `remote_image/client_pool.rs` notes. The local check
that resolved addresses are public still runs before the request. Kordi does
not bypass configured proxies, because that would break managed networks.

Which messages may load previews at all is controlled by the per-device
**Link previews** setting in Account settings, Privacy. Under the default
**From contacts** option, a contact is an account in the latest contacts list
the server returns for the signed-in account (`GET /v1/cloud/contacts`).
Realtime contact events and optimistic updates change what the Contacts screen
shows, but they never let a sender's links load previews.

## Why Kordi does not encrypt local copies yet

Encrypting only `canonical-sessions.sqlite3` (for example with SQLCipher) would
not change what a reader of this Mac's files can see, because plaintext copies
of the same messages also live in:

- the WebKit IndexedDB caches (`cloudMessageCache.ts`, `cloudGroupOutbox.ts`);
- the WebKit network cache;
- the agent runtime's `sessions.db`;
- the attachment directory and the remote image cache.

A complete design needs all of the following:

1. A per-installation key held in the macOS Keychain, reusing
   `cloud_session::secret_store`, including a plan for development builds that
   avoid Keychain prompts today.
2. `rusqlite` built with SQLCipher, and the signing and dependency impact of
   that build.
3. A crash-safe migration for each existing database: `sqlcipher_export` into
   a new file, open and verify it, then swap it in atomically, keeping the
   plaintext file until the encrypted copy has opened.
4. The same treatment for the agent runtime `sessions.db`.
5. A plan for WebKit storage: move the message cache and outbox out of
   IndexedDB into the native encrypted store (or stop persisting them), and
   keep API responses out of the WebKit network cache.
6. Encrypted attachment and image caches, or an explicit decision to keep them
   as regenerable plaintext.

Revisit this together with the end-to-end encryption work to encrypt local
history with keys protected by the Keychain or the Secure Enclave.

## Claim-register wording

Use this wording wherever Kordi describes local storage on the desktop:

> Local copies are readable by your macOS account and administrators; Kordi
> does not encrypt them.

The in-app text under Account settings, Privacy, "Messages on this Mac" says
the same in user terms and points to FileVault.
