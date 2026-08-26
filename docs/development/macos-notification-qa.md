# Packaged macOS notification QA

Run this check on a packaged Kordi app. An unbundled Tauri development binary
cannot exercise the macOS `UNUserNotificationCenter` permission contract.

Use disposable macOS user accounts so each path starts without a stored Kordi
notification decision. Install the candidate in `/Applications` before testing.

## Allow path

1. Open Kordi Settings, then Notifications.
2. Confirm the system permission reads **Permission not requested**.
3. Select **Enable** and confirm macOS shows the Kordi notification prompt.
4. Allow notifications and confirm the setting changes to **Allowed by macOS**.
5. Background Kordi and receive a message from another test account.
6. Confirm one banner appears with the configured preview and sound preferences.
7. Select the banner and confirm Kordi opens the exact conversation.
8. Keep that conversation focused at its latest message and confirm a new message
   does not create a redundant banner.

## Deny and recovery path

1. Repeat the first two allow-path steps in another disposable macOS user account.
2. Select **Enable**, deny the macOS prompt, and confirm the setting reads
   **Blocked by macOS** without prompting again.
3. Select **Open System Settings**, allow Kordi notifications there, and return to
   Kordi.
4. Confirm the setting refreshes to **Allowed by macOS** when Kordi regains focus.

## Background session path

1. Hide Kordi while a background agent session is running.
2. Confirm completion produces a native banner through the same permission path.
3. Disable **Message notifications** and confirm another background completion
   does not notify.
4. Re-enable messages, disable **Notification sound**, and confirm completion is
   silent.

The desktop release publisher separately verifies that the native permission,
presentation, and `UNUserNotificationCenter` markers exist in the top-level app,
updater archive, and DMG copies before publication.
