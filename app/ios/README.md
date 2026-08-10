# Kordi for iPhone

Kordi for iPhone is the native SwiftUI companion to Kordi Desktop. It targets iOS 17 and later and connects to the canonical hosted service at `https://kordi.ai`.

The phone is a collaboration client, not an agent runtime. Agent requests execute through an available Kordi macOS runtime or Kordi Cloud; no model runs on the iPhone.

## Current capabilities

- Email/password sign-in and account creation
- Google and GitHub sign-in with `ASWebAuthenticationSession`
- Contact requests, direct chats, group spaces, and group sessions
- Agent-session timelines, forks, Cloud-or-Mac routing, and model selection
- Message history, unread counts, delivery/read state, Markdown, replies, forwarding, pinning, and message details
- Camera, photo-library, and file attachments with inline image rendering
- Profile, appearance, and provider-authentication settings synchronized through Kordi Cloud
- Offline history cache, ordered foreground sync, optimistic sends, and retryable failures

## Quick start

1. Install a full Xcode release that includes the iOS SDK used by the project. Xcode 26 or newer is required for the guarded iOS 26 APIs.
2. Install [XcodeGen](https://github.com/yonaskolb/XcodeGen) 2.46 or newer:

   ```bash
   brew install xcodegen
   ```

3. Select the installed Xcode for the current shell. This avoids changing the whole machine and also works with beta installations:

   ```bash
   export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
   # or: export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
   xcodebuild -version
   ```

4. Generate and open the project:

   ```bash
   cd app/ios
   xcodegen generate
   open Kordi.xcodeproj
   ```

`project.yml` is the source of truth. The generated `Kordi.xcodeproj` is committed so the app can be opened immediately, but it must be regenerated after target, signing, resource, or build-setting changes.

## Preview without production data

Add `--preview-data` to the Kordi scheme's launch arguments to open the complete mock chat flow without signing in or writing to production. More focused preview arguments are documented in [the iOS development guide](../../docs/ios-development.md#preview-data-and-ui-states).

Without a preview argument, the app uses a real Kordi account and the production service. Use a dedicated test account and never run destructive, load, or throwaway multi-account tests against production.

That client origin does not authorize product-server development. If an operator session will affect or restart the product server, follow the [required environment preflight](../../docs/hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug), work on the corresponding product-server machine, and run the first end-to-end test through `https://coordinar.io`, never `https://kordi.ai`.

## Build and test

From the repository root:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild \
  -project app/ios/Kordi.xcodeproj \
  -scheme Kordi \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath .build/ios \
  test
```

Choose another installed simulator from `xcrun simctl list devices available` when needed.

For project structure, production boundaries, physical-device setup, TestFlight, and troubleshooting, read [Developing Kordi for iPhone](../../docs/ios-development.md). The hosted API contract is recorded in [Kordi iOS cloud contract](../../docs/cloud-mobile-v1.md).
