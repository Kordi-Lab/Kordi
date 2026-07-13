# Beta.6 Ad-Hoc Acceptance Preview Design

**Status:** Approved for implementation on 2026-07-13

## Goal

Deliver Kordi Desktop `0.0.1-beta.6` to invited external macOS arm64 testers through the existing in-app updater without requiring an Apple Developer ID certificate or notarization during this preview stage.

Each tester installs an acceptance-only `0.0.1-beta.5.1` bootstrap DMG once, approves its first launch through macOS **System Settings > Privacy & Security > Open Anyway**, and then confirms the beta.6 update inside Kordi. Kordi must download the update through `coordinar.io`, verify the Tauri updater signature, install it, and attempt to relaunch automatically.

This is an explicit non-production preview. The normal `beta` channel, stable manual-download pointer, existing beta users, and production Developer ID verification remain unchanged.

## Terminology and trust model

The preview is described to testers as **ad-hoc signed**, not Apple-signed or notarized. Tauri uses the macOS pseudo-identity `-`, which creates a code signature without an Apple signing identity. This is preferable to a completely unsigned arm64 bundle because macOS requires executable code to carry a valid code signature, but it does not make the app pass normal Gatekeeper distribution checks.

Two independent trust mechanisms remain distinct:

- The ad-hoc macOS signature lets macOS validate bundle integrity after the user explicitly approves the app.
- The existing Tauri minisign key verifies that an updater archive was produced by Kordi's release process and was not changed in transit or storage.

The preview does not disable Gatekeeper, remove quarantine attributes, change global macOS security settings, install a custom root certificate, or claim to bypass Apple security. Testers use only Apple's per-app **Open Anyway** flow.

## Version and channel decisions

The release sequence is fixed:

```text
0.0.1-beta.5.1  manual acceptance bootstrap, ad-hoc signed
        |
        v
0.0.1-beta.6    acceptance updater target, ad-hoc signed
        |
        v
0.0.1-beta.7    future Developer ID-signed and notarized public release
```

The beta.5.1 bootstrap is distributed directly to invited testers and is never promoted through a channel. It embeds only the acceptance updater endpoint.

Beta.6 is published only to `desktop/channels/acceptance/latest.json`. Its app bundle also embeds only the acceptance updater endpoint, so preview clients cannot accidentally begin following the normal beta channel.

Beta.6 immutable MinIO objects are permanently the ad-hoc preview bytes. They must never be replaced with signed bytes or promoted to `desktop/channels/beta/latest.json`. A later public release therefore uses beta.7. Beta.7 is first published to acceptance so beta.6 preview clients can upgrade. The beta.7 bundle embeds the normal beta endpoint; after that update, preview clients automatically rejoin the production beta channel. Only then is the acceptance pointer cleared and beta.7 promoted to beta.

No `V0.0.1.beta6` production tag or public GitHub prerelease is created for this preview. Release evidence records the exact commit and artifact hashes without representing the build as an official notarized release.

## Build configuration

The normal Tauri configurations remain production-safe and continue to use the public beta updater endpoint.

Two small acceptance overlays make the non-production differences explicit:

- A beta.6 acceptance overlay sets `bundle.macOS.signingIdentity` to `-` and changes the sole updater endpoint to `https://coordinar.io/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}`.
- A beta.5.1 bootstrap overlay makes the same changes and overrides the app version to `0.0.1-beta.5.1`.

Dedicated package scripts build the acceptance target and bootstrap. They still require `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, because updater archives remain cryptographically signed. They do not require an Apple certificate, Apple credentials, notarization credentials, or a local Developer ID identity.

The overlays preserve product name `Kordi`, identifier `io.kordi.cloud`, updater public key, sidecars, data locations, and bundle layout. Installing the bootstrap over beta.5 and beta.6 over the bootstrap therefore preserves account state, Keychain entries, canonical sessions, caches, and preferences.

Tests treat the following as configuration failures:

- an acceptance overlay points at the normal beta endpoint;
- an acceptance overlay omits ad-hoc signing;
- an acceptance overlay changes the product identifier or updater public key;
- a production configuration acquires the acceptance endpoint or ad-hoc signing identity;
- bootstrap or target versions differ from beta.5.1 and beta.6 respectively.

## Publisher safety boundary

The desktop publisher gains an explicit release profile with two allowed values:

- `production` remains the default and preserves every existing Developer ID, code-signing, Gatekeeper, version-parity, privacy, checksum, and updater-signature gate.
- `adhoc-preview` is accepted only when `--channel acceptance` is also present.

There is no implicit fallback from production to preview. Missing Developer ID or notarization material continues to fail the production path. Selecting `adhoc-preview` with `beta`, omitting the profile for an ad-hoc artifact, or providing an unknown profile fails before any MinIO read or write.

The ad-hoc verifier applies the same clean-worktree, exact-commit, bundle-layout, version, privacy, product-origin, archive-path, checksum, and Tauri minisign checks as production. It replaces only the Apple distribution checks with these requirements for the app bundle, updater archive, and DMG copy:

1. `codesign --verify --deep --strict` succeeds.
2. code-sign metadata reports an ad-hoc signature and no Developer ID authority or team identity.
3. the embedded updater endpoint is the exact acceptance endpoint.
4. the embedded app version equals the requested preview version.

Gatekeeper assessment is recorded as a diagnostic but is not allowed to make an ad-hoc artifact look production-ready. The publisher never mutates macOS security settings to obtain a passing result.

The release manifest notes identify the artifact as an ad-hoc external-test preview. Immutable objects, conditional channel-pointer writes, public GET/HEAD verification, rollback, redaction, and MinIO credentials behave exactly as in the existing publisher. The stable `/updates/releases/latest/Kordi.dmg` route is not changed because it follows only the beta channel.

## Tester enrollment and update flow

Enrollment is deliberately manual and opt-in:

1. The release operator sends the beta.5.1 bootstrap DMG directly to named testers. It is not listed on the website, normal updater, stable download URL, or a public GitHub release.
2. The tester drags Kordi to Applications and uses **Open Anyway** for the first launch.
3. Kordi quietly checks the acceptance endpoint and shows beta.6 as available.
4. The tester confirms once.
5. Tauri downloads the beta.6 archive from `coordinar.io`, verifies its minisign signature, installs it, and attempts to relaunch.
6. On relaunch, Kordi reports `0.0.1-beta.6` and continues following only acceptance.

Possession of the bootstrap is the enrollment mechanism; the acceptance endpoint is not an authorization boundary. Preview artifacts contain no credentials or private user data. Adding tester accounts, per-user updater tokens, or a general release-channel selector is outside this stage.

The update UI uses **verified update** rather than **signed update** so it accurately describes both preview and future production artifacts. On failure, it may offer only a product-origin immutable manual URL constructed from a strictly validated available version. It never opens a renderer-supplied host or arbitrary download URL.

## Failure handling and rollback

- If the clean-machine beta.5.1 to beta.6 test cannot install and relaunch without weakening macOS security, external invitations stop. The fallback is a separately reviewed manual DMG test, not a Gatekeeper bypass.
- A failed download, updater-signature check, extraction, installation, or relaunch leaves the last working app available and shows a retry action.
- A tampered archive is rejected by the embedded updater key before installation.
- A publisher validation or public verification failure occurs before pointer promotion or restores the exact prior acceptance pointer with its existing compare-and-swap rollback.
- Acceptance cleanup writes the strict unpublished tombstone and verifies HTTP 204. Immutable beta.6 objects remain for auditability. The live pointer is not cleared while external testers are enrolled unless the preview is being stopped or the exact validated beta.6 pointer is immediately restored as a rollback rehearsal.
- The beta channel is never part of preview rollback because this work cannot mutate it.
- If ad-hoc beta.6 has already been uploaded, beta.6 is never reused for different bytes. Any correction advances to a new beta number.

## Test strategy

All behavior changes follow red-green test-driven development.

### Configuration and build tests

- Acceptance and bootstrap overlays contain the exact endpoint, identity, identifier, public key, and version contracts.
- Production configurations remain free of acceptance and ad-hoc settings.
- Dedicated build scripts require updater-signing secrets but do not probe for Apple identities.
- Secret and local-path scans still pass for both app bundles and DMGs.

### Publisher tests

- `adhoc-preview` plus `acceptance` selects the ad-hoc verifier.
- Every other ad-hoc profile/channel combination fails before storage access.
- The production default still requires Developer ID and passing Gatekeeper assessment.
- The verifier accepts only valid ad-hoc signatures and rejects unsigned, malformed, Developer ID, wrong-version, wrong-endpoint, or differently identified bundles.
- Updater archive signature, immutable-object conflict, pointer-last promotion, public verification, rollback, redaction, and tamper tests run for the preview profile.
- Generated notes clearly label beta.6 as an ad-hoc preview.

### Desktop tests

- Update status text says `verified update` and does not imply Apple notarization.
- A valid beta version produces only a `coordinar.io` immutable manual fallback URL.
- Invalid or attacker-controlled version text produces no manual fallback link.
- Existing available, progress, install, retry, and relaunch contracts remain passing.

### Clean-machine acceptance

Before inviting external testers, use a disposable macOS arm64 user or machine with normal Gatekeeper settings:

1. Download the bootstrap through a browser so normal quarantine behavior is exercised.
2. Install it over a beta.5 test profile with seeded account, Keychain, session, cache, draft, and preference markers.
3. Approve only the bootstrap through **Open Anyway**.
4. Confirm beta.6 once and record updater manifest, archive hash, download progress, install completion, process exit, relaunch, and reported version.
5. Verify every seeded marker remains present.
6. Quit and relaunch beta.6 again to confirm it remains usable.
7. Verify beta.6 receives HTTP 204 from acceptance and the normal beta endpoint/pointer remains unchanged.
8. Tamper with a local archive copy and verify signature rejection without uploading it.
9. Rehearse cleanup by clearing acceptance and verifying HTTP 204, then restore the exact validated beta.6 pointer and re-verify its manifest before sending any external invitation.

Automatic relaunch is a release criterion, not an assumption. If macOS blocks the updated ad-hoc bundle and requires a second manual approval, record that result and return for design review before external rollout.

## Operational evidence

The preview record includes:

- source commit and clean-worktree status;
- bootstrap and target versions;
- app, DMG, updater archive, and signature SHA-256 values and sizes;
- ad-hoc code-sign verification output with sensitive identity text redacted;
- Tauri updater-signature verification;
- MinIO immutable object keys and acceptance pointer digest;
- public acceptance manifest and artifact GET/HEAD results;
- clean-machine install, preservation, and relaunch results;
- confirmation that beta pointer, stable DMG, production tag, and GitHub releases were not changed.

## Out of scope

- Disabling or bypassing macOS security controls.
- Publishing an ad-hoc artifact to all beta users.
- Reusing beta.6 for a later signed or notarized build.
- Creating an Apple certificate, notarization profile, or App Store Connect workflow.
- Per-tester authentication, entitlement management, or updater tokens.
- A user-facing release-channel selector.
- Windows, Linux, or macOS x86_64 preview artifacts.
- A public GitHub release or production `V0.0.1.beta6` tag.
