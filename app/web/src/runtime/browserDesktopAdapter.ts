import { clearCloudAttachmentLocalPathCache } from '@/features/cloud/cloudAttachmentLocalPathCache';
import { clearBrowserVoiceRecording, runBrowserVoiceCommand } from '@web/runtime/browserVoiceRecording';
import { CLOUD_SESSION_CHANGED_EVENT, CLOUD_SESSION_SIGNED_OUT_EVENT, loadSession } from '@/features/cloud/session';
import { clearBrowserCanonicalStorage, pruneBrowserCanonicalCloudMessages, runBrowserCanonicalCommand } from '@web/runtime/browserCanonicalStorage';
import { runBrowserChatSyncCommand } from '@web/runtime/browserChatSync';
import { clearBrowserAttachments, runBrowserAttachmentCommand } from '@web/runtime/browserAttachments';

let cleanupInstalled = false;
let attachmentScope: string | null = null;
let lastAccountId: string | undefined;
let generation = 0;

function clearBrowserAccountMedia() {
  clearBrowserVoiceRecording();
  clearBrowserAttachments();
  clearCloudAttachmentLocalPathCache();
}

function installCleanup() {
  if (cleanupInstalled || typeof window === 'undefined') return;
  cleanupInstalled = true;
  window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, () => {
    generation += 1;
    const accountId = lastAccountId;
    lastAccountId = undefined;
    attachmentScope = null;
    clearBrowserAccountMedia();
    void clearBrowserCanonicalStorage(accountId).catch(() => undefined);
  });
  window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, () => {
    generation += 1;
    attachmentScope = null;
    clearBrowserAccountMedia();
  });
}

/** Routes shared UI storage calls without exposing arbitrary native commands to the browser. */
export async function invokeBrowserDesktop<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  installCleanup();
  const started = generation;
  const session = await loadSession();
  if (!session || started !== generation) throw new Error('Sign in to Kordi to continue.');
  lastAccountId = session.accountId;
  const scope = JSON.stringify([session.accountId, session.organizationId ?? null]);
  const assertCurrent = async () => {
    const current = await loadSession();
    if (started !== generation || current?.accountId !== session.accountId || current?.organizationId !== session.organizationId) {
      throw new Error('The signed-in account changed. Refresh the conversation.');
    }
  };
  if (attachmentScope !== scope) { clearBrowserAccountMedia(); attachmentScope = scope; }
  let result: unknown;
  if (command.startsWith('desktop_canonical_')) {
    if (args.accountId && args.accountId !== session.accountId) throw new Error('The signed-in account changed. Refresh the conversation.');
    result = command === 'desktop_canonical_prune_missing_cloud_messages'
      ? await pruneBrowserCanonicalCloudMessages(session.accountId, session.organizationId)
      : await runBrowserCanonicalCommand(session.accountId, session.organizationId, command, args);
  } else if (command.startsWith('desktop_chat_sync_')) {
    result = await runBrowserChatSyncCommand(session.accountId, session.organizationId, command, args);
  } else if (command.startsWith('desktop_voice_record_') || command === 'desktop_voice_trim') {
    result = await runBrowserVoiceCommand(command, args, assertCurrent);
  } else if (command === 'desktop_save_attachment_as' || /^desktop_chat_(?:store_attachment|read_attachment|download_attachment|discard_attachment|cache_cloud_attachment|cached_cloud_attachment_path|download_cloud_attachment|attachment_stream_)/.test(command)) {
    result = await runBrowserAttachmentCommand(command, args, assertCurrent);
  } else {
    throw new Error('This feature requires the Kordi desktop app. Your cloud chats are available in the browser.');
  }
  await assertCurrent();
  return result as T;
}
