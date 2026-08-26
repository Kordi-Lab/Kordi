import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function read(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('packaged macOS notifications use one native permission and presentation path', () => {
  const nativeClient = read('../src/features/notifications/nativeNotifications.ts');
  const settings = read('../src/features/notifications/NotificationSettingsPanel.tsx');
  const messageAttention = read('../src/features/notifications/useDesktopMessageAttention.ts');
  const backgroundCompletion = read('../src/features/chat/backgroundSessionNotifications.ts');
  const nativeRuntime = read('../src-tauri/src/message_notification.rs');
  const cargo = read('../src-tauri/Cargo.toml');

  for (const command of [
    'desktop_notification_permission_state',
    'desktop_request_notification_permission',
    'desktop_show_message_notification',
  ]) {
    assert.match(nativeClient, new RegExp(command));
    assert.match(nativeRuntime, new RegExp(command));
  }
  assert.match(settings, /nativeNotificationPermissionState/);
  assert.match(settings, /requestNativeNotificationPermission/);
  assert.match(settings, /addEventListener\('focus', refreshOnFocus\)/);
  assert.match(settings, /Allow notifications on this Mac/);
  assert.match(settings, /Allow banners and sounds/);
  assert.match(settings, /Open System Settings and allow notifications for Kordi/);
  assert.match(settings, /Allow notifications/);
  assert.doesNotMatch(settings, /Permission not requested/);
  assert.match(messageAttention, /showNativeNotification/);
  assert.match(backgroundCompletion, /showNativeNotification/);
  assert.match(cargo, /notify-rust = \{ version = "4\.18\.0", features = \["preview-macos-un"\] \}/);
  assert.doesNotMatch(settings, /@tauri-apps\/plugin-notification/);
  assert.doesNotMatch(cargo, /tauri-plugin-notification/);
});
