# Developing Kordi for iPhone

This guide covers the native SwiftUI app in `app/ios`. The app targets iOS 17 and later, mirrors Kordi's macOS conversation semantics, and has separately installable Beta and production identities.

Before any backend-connected development or operator validation, select the correct path in [Development environment isolation](development-environments.md). Network-free previews remain the preferred path for isolated interface work.

## Product boundary

Kordi for iPhone is a client, not an agent runtime:

```text
iPhone app
  -> Kordi hosted API
    -> account, contacts, messages, groups, read state, and sync
    -> connected macOS runtime or hosted runner for agent execution
```

The phone never runs a model. It can choose a session route, submit an agent request, and display the synchronized result. The `Kordi` production scheme connects to `https://kordi.ai` over HTTPS. The `Kordi Beta` scheme connects only to the isolated loopback development API.

## Requirements

- macOS capable of running the selected iOS simulator
- Full Xcode 26 or newer, with an iOS simulator runtime installed
- XcodeGen 2.46 or newer
- An Apple Development team only for physical-device or archive builds
- A dedicated Kordi test account for bounded production checks

Install XcodeGen with Homebrew:

```bash
brew install xcodegen
```

### Select the correct Xcode

Prefer `DEVELOPER_DIR` for repository commands because it does not change the whole machine:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -version
xcrun simctl list devices available
```

For a beta installation:

```bash
export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
```

If `/Applications/Xcode.app/Contents/Developer` is reported as invalid, the app is not installed at that path. Check the actual name in `/Applications`; do not create a fake directory or bypass Xcode's toolchain selection.

Run Xcode's first-launch setup once after installing or updating it:

```bash
sudo "$DEVELOPER_DIR/usr/bin/xcodebuild" -runFirstLaunch
```

## Generate and open the project

`app/ios/project.yml` owns targets, deployment versions, resources, bundle IDs, and build numbers.

```bash
cd app/ios
xcodegen generate
open Kordi.xcodeproj
```

Commit both `project.yml` and the regenerated `Kordi.xcodeproj/project.pbxproj` when project settings change. Never commit `xcuserdata`, `.xcuserstate`, DerivedData, archives, or local signing material.

## Choose Beta or production

| Scheme | Purpose | Installed name | Bundle identifier | API origin | OAuth callback | Icon |
| --- | --- | --- | --- | --- | --- | --- |
| `Kordi Beta` | Isolated backend development | Kordi Beta | `ai.kordi.ios.beta` | `http://127.0.0.1:17081` | `kordi-beta://oauth/callback` | Gray |
| `Kordi` | Production and App Store release | Kordi | `ai.kordi.ios` | `https://kordi.ai` | `kordi://oauth/callback` | Color |

The independent bundle identifiers isolate Keychain sessions, UserDefaults, local database stores, caches, and app installation state. The app checks the bundle identifier, distribution channel, API origin, and callback scheme together during startup; a crossed configuration fails before it can send a request.

For backend development, start the isolated backend or its approved tunnel and select `Kordi Beta`. Do not change the `Kordi` scheme to point at development, and do not point `Kordi Beta` at production. The Beta loopback route is intended for the iOS Simulator; a physical iPhone cannot reach the Mac through the phone's own `127.0.0.1`.

## Run in the simulator

For deterministic network-free UI work, either scheme can use preview arguments. For backend-connected development, use `Kordi Beta`.

In Xcode:

1. Select `Kordi Beta` for isolated backend work or `Kordi` for a bounded production check.
2. Choose an installed iPhone simulator.
3. Add `--preview-data` under Scheme > Run > Arguments for deterministic mock data.
4. Run the app.

Command-line build and test from the repository root:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild \
  -project app/ios/Kordi.xcodeproj \
  -scheme Kordi \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath .build/ios \
  test
```

Replace the simulator name with one returned by `xcrun simctl list devices available`.

## Preview data and UI states

Launch arguments keep visual work deterministic and prevent accidental production writes.

| Argument | Surface |
| --- | --- |
| `--preview-launching` | Color Relay app launch state |
| `--preview-data` | Complete signed-in Contact chat flow |
| `--preview-agent-page` | Agents root tab (combine with preview data) |
| `--preview-login` | Email and social login |
| `--preview-signup` | Account creation |
| `--preview-contacts` | Contacts and requests |
| `--preview-new-chat` | New-chat sheet |
| `--preview-add-contact` | Add-contact search inside the new-chat sheet |
| `--preview-new-group` | New-group flow inside the new-chat sheet |
| `--preview-contact-chat` | Direct conversation |
| `--preview-bubble-width` | Message bubble width and delivery-state stress cases |
| `--preview-direct-call` | Active one-to-one voice call |
| `--preview-group-call` | Active group video chat |
| `--preview-media` | Full-screen image gallery with multiple preview images |
| `--preview-media-messages` | Borderless grouped image message in a direct conversation |
| `--preview-media-expanded` | Expanded grouped image message in a direct conversation |
| `--preview-media-separated` | The same selected images sent as separate messages |
| `--preview-photo-send` | One-page photo picker with grouped-message control |
| `--preview-group-chat` | Group conversation |
| `--preview-group-only` | Contact timeline containing only group spaces |
| `--preview-expanded-groups` | Group rows with their session list expanded |
| `--preview-group-management` | Group-management sheet |
| `--preview-group-invite` | Group-management sheet opened to invitations |
| `--preview-markdown` | Markdown-rich message transcript |
| `--preview-tool-failure` | Completed My Kordi turn with one diagnostic tool failure |
| `--preview-forward-message` | Forward-message destination picker |
| `--preview-message-details` | Message delivery/read details |
| `--preview-session-detail` | Info, Artifacts, and Tasks session sheet |
| `--preview-agent-model` | Agent model selection |
| `--preview-contact-model` | Session model selection in a contact chat |
| `--preview-syncing` | Active message-sync indicator and motion state |
| `--preview-account` | Account settings |
| `--preview-authentication` | Provider-authentication catalog |
| `--preview-authentication-detail` | Provider-authentication detail |
| `--preview-appearance` | Appearance settings |
| `--preview-profile` | Profile settings |

Focused arguments that require conversation fixtures should be combined with `--preview-data` unless their preview root installs data itself.

Set `KORDI_PREVIEW_LAUNCH_FLOW=1` in the simulator process environment to show Color Relay briefly before persisted preview data opens the full app. The loading-only `--preview-launching` state continues animating until the app is relaunched without that argument.

## Run on a physical iPhone

1. Connect the iPhone and trust the Mac.
2. Enable Developer Mode on the iPhone if Xcode requests it.
3. Open the project and select the `Kordi` target.
4. Under Signing & Capabilities, choose an Apple Development team. Signing is intentionally a local setting; the repository does not pin a contributor's team ID.
5. Select the connected iPhone as the run destination and run.

Command-line discovery:

```bash
xcrun devicectl list devices
```

For a signed command-line build, use the device identifier shown above and allow Xcode to update provisioning:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild \
  -project app/ios/Kordi.xcodeproj \
  -scheme Kordi \
  -destination 'id=<DEVICE_ID>' \
  -derivedDataPath .build/ios-device \
  -allowProvisioningUpdates \
  build
```

## Source map

```text
app/ios/
  Kordi/App/                 app lifecycle, root navigation, state orchestration
  Kordi/Core/API/            hosted API DTOs, codecs, projections, attachments
  Kordi/Core/Auth/           Keychain session and OAuth callback handling
  Kordi/Core/Models/         conversation, message, group, agent presentation models
  Kordi/Core/Persistence/    account-scoped message, wire, and route caches
  Kordi/Features/Auth/       login and signup
  Kordi/Features/Chats/      Contact/Agent timelines, groups, compose/new-chat flows
  Kordi/Features/Contacts/   contacts, requests, and Kordi ID lookup
  Kordi/Features/Conversation/ transcript, composer, actions, model and file surfaces
  Kordi/Features/Profile/    profile, appearance, and provider authentication
  Kordi/Features/Shared/     identity, brand mark, and sync status components
  KordiTests/                codec, projection, persistence, routing, and UI-logic tests
```

Keep network and projection logic outside SwiftUI view bodies so it remains independently testable. Lists must use stable IDs, and conversation screens should use lazy, windowed rendering for long histories.

## Data, security, and production safety

- Session tokens belong only in Keychain.
- Raw provider credentials must not be written to UserDefaults, SwiftData, logs, fixtures, screenshots, or crash text.
- Cached messages and sync cursors are account-scoped and cleared on sign-out.
- The phone must not announce desktop-runtime presence or claim that it can execute an agent locally.
- Preview mode must remain self-contained and network-free.
- Use dedicated test accounts for production smoke checks. Never run load, destructive, or throwaway multi-user tests against production.

The iPhone production origin is not a product-server development target. If an operator session will affect or restart the product server, follow the [required environment preflight](hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug), work on the corresponding product-server machine, and validate the deployed product through `https://kordi.ai`. Network-free preview mode remains the correct path for isolated iPhone UI work.

See [Kordi iOS cloud contract](cloud-mobile.md) for endpoints and projection rules.

## TestFlight

For a coordinated desktop and iOS release, use the
[standard dual-platform release runbook](development/dual-platform-release-runbook.md).
The standard operator order publishes macOS to `kordi.ai` and GitHub before
iOS archive/upload. Simulator and physical-device qualification belong to the
implementation PRs and must already be recorded on the merged candidate.

### Source and test preflight

1. Update `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `project.yml`.
2. Regenerate the project and require no unexpected diff:

   ```bash
   cd app/ios
   xcodegen generate
   git diff --exit-code -- project.yml Kordi.xcodeproj/project.pbxproj
   cd ../..
   ```

3. Confirm the production `Kordi` Release build settings identify the intended
   version/build, `ai.kordi.ios`, `https://kordi.ai`, production distribution,
   and production APNs. Never archive `Kordi Beta`.
4. Confirm the merged implementation/release PRs record the required CI,
   simulator, physical-device, and focused acceptance evidence. The standard
   release operation does not create or reuse a simulator. Missing evidence is
   a source-qualification failure: stop, fix/test/merge, and use a new
   candidate.
5. When calls, APNs, media, or relevant backend/client behavior changed,
   confirm the merged candidate already passed the [product call readiness and
   two-account acceptance test](call-hosting.md#required-two-account-acceptance-test),
   including voice, video, first remote frame, terminal state, and background
   CallKit answer.
6. Resolve packages into a task-owned DerivedData directory and scan downloaded
   binary frameworks for forbidden private build paths before archive.

### Apple account and capability preflight

Before archive creation:

- confirm the build number is unused in App Store Connect;
- load the production team privately from approved product configuration; do
  not infer it from a local provisioning profile;
- confirm the signed-in Xcode account belongs to that team;
- confirm App Group `group.ai.kordi.share` is assigned to both
  `ai.kordi.ios` and `ai.kordi.ios.share`;
- confirm the internal `Kordi Team` TestFlight group exists and is configured
  for all builds;
- confirm agreements and App Store Connect access are current.

Adding or changing an Apple capability invalidates affected profiles. Let the
production Xcode account regenerate them before export. The App Store Connect
API key may validate and upload without having cloud-managed certificate
permission, so do not use its ability to query builds as proof that it can
export a signed IPA.

### Archive and export

Archive with the signed-in production Xcode account:

```bash
export DEVELOPER_DIR="<XCODE_DEVELOPER_DIR>"
export KORDI_IOS_TEAM_ID="<PRIVATE_PRODUCTION_TEAM_ID>"

xcodebuild -quiet \
  -project app/ios/Kordi.xcodeproj \
  -scheme Kordi \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath /protected/Kordi.xcarchive \
  -derivedDataPath /protected/kordi-ios-archive-derived-data \
  -allowProvisioningUpdates \
  -hideShellScriptEnvironment \
  DEVELOPMENT_TEAM="$KORDI_IOS_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  archive
```

Export locally with an `ExportOptions.plist` using:

```text
method: app-store-connect
destination: export
signingStyle: automatic
teamID: the private production team
manageAppVersionAndBuildNumber: false
uploadSymbols: true
testFlightInternalTestingOnly: false
```

Use the signed-in Xcode account for export. Then inspect the exported IPA and
require:

- reviewed version/build on the app and share extension;
- production bundle IDs and product origin;
- production APNs;
- `group.ai.kordi.share` on both signed targets and provisioning profiles;
- the production team and `get-task-allow=false`;
- `ITSAppUsesNonExemptEncryption=false`;
- successful code-signature verification;
- no `/Users/`, `/private/tmp`, `/var/folders`, test hosts, credentials, local
  account data, or private identifiers in the extracted IPA or native binaries;
- a recorded byte size and SHA-256.

Third-party XCFrameworks are release inputs. If one contains a forbidden path,
rebuild or update it with source-path remapping in a reviewed source change and
use a new candidate. Do not make release-day binary string replacement the
normal path.

### Validate, upload, and verify TestFlight

Use the App Store Connect API key only after local IPA verification:

```bash
xcrun altool --validate-app /protected/Kordi.ipa \
  --api-key "<APP_STORE_KEY_ID>" \
  --api-issuer "<APP_STORE_ISSUER_ID>" \
  --p8-file-path /protected/AuthKey.p8 \
  --output-format json

xcrun altool --upload-package /protected/Kordi.ipa \
  --api-key "<APP_STORE_KEY_ID>" \
  --api-issuer "<APP_STORE_ISSUER_ID>" \
  --p8-file-path /protected/AuthKey.p8 \
  --wait \
  --output-format json
```

Do not report TestFlight complete until App Store Connect reports the reviewed
build as `VALID` and the build is visible to `Kordi Team`. Upload success alone
is not the final state. A macOS notarization key may not have App Store provider
or build-status access; use a dedicated App Store Connect key. When upload uses
the signed-in Xcode account, assign explicit UI verification ownership if no
status-capable API key is available. Credentials and team identifiers are
intentionally not stored in this repository.

## Troubleshooting

### Invalid developer directory

Use the real installed Xcode name:

```bash
ls -1 /Applications | rg '^Xcode.*\.app$'
export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
xcodebuild -version
```

### Simulator is missing

Install an iOS runtime in Xcode Settings > Components, then list available devices with `xcrun simctl list devices available`.

### Signing fails

Open Signing & Capabilities, select a team, and let Xcode create or update the development profile. A personal team may require a locally unique bundle identifier; do not commit that local identifier.

### OAuth returns to the browser

Confirm the selected app and backend agree on the return target: `kordi-beta://oauth/callback` for `Kordi Beta`, or `kordi://oauth/callback` for `Kordi`. GitHub and Google still use their full HTTP API callback URLs; the custom scheme is only the final handoff from Kordi Cloud back to the app.

### Both installed apps show the same data

Stop and verify the installed bundle identifiers. Beta must be `ai.kordi.ios.beta` and production must be `ai.kordi.ios`. Do not add shared Keychain access groups or shared app groups between them.

### Production data appears in a UI preview

Stop the app and add `--preview-data`. Preview fixtures must never depend on a saved Keychain session or a network request.
