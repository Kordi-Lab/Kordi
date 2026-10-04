# Native iPhone header and settings proposal

Status: design prototype for review. This branch has not been merged or released.

The proposal follows the compact title capsules in the supplied Slack and Telegram iPhone references, and the density of Slack's preferences sheet. Captures use Kordi's actual SwiftUI screens with its offline sample fixtures.

## Conversation header

- Keep native back navigation in its own circular control.
- Place the title and secondary context in one tappable capsule. Group conversations use a number symbol; direct and agent conversations retain their appropriate status text.
- Open the existing conversation details from the title capsule.
- Group Ask Agent and the existing details action at the trailing edge.
- Extend the conversation wallpaper behind the status and navigation areas. There must be no tall white band or opaque full-width header behind the controls; the glass capsules and back control provide the chrome. Use native glass on iOS 26 and later, a material fallback on older versions, and an opaque control surface when Reduce Transparency is enabled.
- Preserve the transcript, composer, session actions, presence, and agent activity behavior.

## Settings

- Use one continuous system-background canvas with section dividers instead of separate cards.
- Keep a centered sheet title and a native close control on the leading side.
- Make the compact profile row the entry point for profile editing.
- Group settings into Notifications, Appearance, and Account.
- Show Color mode, Message display, and Chat theme with their current values directly in the root sheet.
- Keep rows at least 52 points high; use 17-point primary text, 13-point secondary text, restrained symbols, and short section labels.
- Keep selections connected to existing appearance and message-layout preferences.
- Keep device review notices and provider account counts visible.

## Preview

Open `index.html` through a local HTTP server to compare group, direct, and agent captures in light and dark appearances. The browser displays screenshots; the simulator runs the interactive prototype.

Build the `Kordi Beta` scheme for an iPhone simulator and launch with:

```text
--preview-data --preview-native-design
```

Back navigation returns to a preview menu with group, direct, agent, and Settings destinations. Focused initial states also accept `--preview-account`, `--preview-contact-chat`, or `--preview-native-agent` alongside the two arguments above.

## Validation and remaining work

The prototype builds successfully with the Beta configuration and uses offline fixtures. Light and dark captures are included. Production adoption still requires interactive navigation and keyboard checks, long-title and narrow-device checks, VoiceOver and accessibility text-size checks, Reduce Transparency verification, and validation of the material fallback on older supported iOS versions.
