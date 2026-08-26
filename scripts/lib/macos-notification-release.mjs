export const MACOS_NOTIFICATION_BUNDLE_MARKERS = [
  'desktop_notification_permission_state',
  'desktop_request_notification_permission',
  'desktop_show_message_notification',
  'UNUserNotificationCenter',
];

export function assertMacOSNotificationBundleContract(run, appBundle) {
  for (const marker of MACOS_NOTIFICATION_BUNDLE_MARKERS) {
    const inspected = run('rg', [
      '--text', '--hidden', '--no-ignore', '--no-messages', '-l', '-F', marker, appBundle,
    ]);
    if (inspected?.status !== 0) {
      throw new Error(`Application bundle is missing native notification integration: ${marker}`);
    }
  }
}
