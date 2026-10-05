# Native iPhone header and settings proposal

Status: approved design implemented for review. This branch has not been merged or released.

The proposal follows the compact title capsules in the supplied Slack and Telegram iPhone references, and the density of Slack's preferences sheet. Captures use Kordi's actual SwiftUI screens with its offline sample fixtures.

## Conversation header

- Keep native back navigation in its own circular control.
- Center the title and secondary context in one tappable capsule on the screen centerline, without a number symbol beside group titles. Direct and agent conversations retain their appropriate status text.
- Open the existing conversation details from the title capsule.
- Group Ask Agent and the existing details action at the trailing edge.
- Extend the conversation wallpaper behind the status and navigation areas. There must be no tall white band or opaque full-width header behind the controls; the glass capsules and back control provide the chrome. Messages scroll behind the floating controls with a native soft blur around the top edge and no transcript clip. The blur fades smoothly into the conversation, without an opaque header band. Use native glass on iOS 26 and later, a material fallback on older versions, and an opaque control surface when Reduce Transparency is enabled.
- Preserve the transcript, composer, session actions, presence, and agent activity behavior.

## Threads message display and discussions

- Preview group, direct, and agent conversations in either Chat or Threads message display. Threads uses the existing compact, continuous transcript with sender names, timestamps, and reply links, beneath the same centered glass header.
- Keep Threads message display distinct from a focused discussion: it is a preference for the entire conversation, available in Settings under Message display.

- Show the parent message and its replies in the existing native discussion screen. Short threads begin beneath the title instead of leaving a large blank area above the messages.
- Use a centered glass title capsule with the conversation name and reply count.
- Continue the chat background behind the navigation controls.
- The focused thread preview uses the compact Threads message display preference.

## Threads long-press actions

- Present Threads actions in a native bottom sheet over the conversation, inspired by the supplied Slack reference.
- Place quick reactions and the full reaction picker first, followed by prominent Reply, Forward, and Pin buttons. Keep Kordi's existing actions and permission checks.
- Place Quote, Copy message, Share, and applicable attachment actions in compact rows. Expose editing, selection, deletion, and read receipts under More Actions.
- Keep the transcript in place behind the sheet. Complete sheet dismissal before quoting, opening a discussion, forwarding, pinning, or deleting, so drafts and subsequent presentations remain intact.
- Support native drag dismissal, accessibility escape, larger text, and light/dark appearances.

## Settings

- Use one continuous system-background canvas with section dividers instead of separate cards.
- Keep a centered sheet title and a native close control on the leading side.
- Make the compact profile row the entry point for profile editing.
- Group settings into Notifications, Appearance, and Account.
- Show Color mode, Message display, and Chat theme with their current values directly in the root sheet.
- Keep rows at least 48 points high; use 15-point primary text, 12-point secondary text, restrained symbols, and short section labels.
- Keep selections connected to existing appearance and message-layout preferences.
- Keep device review notices and provider account counts visible.

## Preview

Open `index.html` through a local HTTP server to compare group, direct, agent, discussion, and Threads action-sheet captures in light and dark appearances. Use the Chat / Threads switch to compare message displays for group, direct, and agent conversations; `?screen=group&layout=threads` opens the Slack-style group transcript directly, and `?screen=thread-actions` opens its long-press menu. Settings captures reflect the selected message display. The browser displays screenshots; the simulator runs the interactive prototype.

Build the `Kordi Beta` scheme for an iPhone simulator and launch with:

```text
--preview-data --preview-native-design
```

Back navigation returns to a preview menu with group, direct, agent, thread, and Settings destinations. Focused initial states also accept `--preview-account`, `--preview-contact-chat`, `--preview-native-agent`, or `--preview-native-thread` alongside the two arguments above.

For the complete app with the sample discussion, launch with `--preview-data --preview-native-samples`. The design menu remains available only in Debug builds.

## Validation and remaining work

The implementation uses the existing conversation, thread, and settings flows. The Beta build passes. Centering checks cover direct and agent titles with long context. Native UI checks pass for saved inline preferences, sheet dismissal, title-to-details navigation, discussion back navigation with draft and parent position preservation, and reachable settings at the largest accessibility text size. Seven additional native UI checks pass for Threads dates and preference persistence, quoting, selection, forwarding after sheet dismissal, reply navigation with draft preservation, delete confirmation with neighbor preservation, and the existing Chat discussion flow. All checks use offline sample data. Light and dark captures are included. Physical-iPhone review, long-title and narrow-device checks, VoiceOver review, Reduce Transparency verification, and validation of the material fallback on older supported iOS versions remain before release.
