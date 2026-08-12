import { invokeDesktop } from './desktop';

export async function reconcileCanonicalMessageMirror(
  preferredMessageId: string,
  duplicateMessageId: string,
) {
  return invokeDesktop<boolean>('desktop_canonical_reconcile_message_mirror', {
    preferredMessageId,
    duplicateMessageId,
  });
}
