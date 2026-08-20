import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { recoverCloudAttachmentPreview } from '@/features/cloud/cloudAttachments';
import { loadSession } from '@/features/cloud/session';
import type { MessageAttachment } from '../types';

const RECOVERY_RETRY_DELAY_MS = 30_000;
const recoveredPreviewUrls = new Map<string, string>();
const recoveryPromises = new Map<string, Promise<string | null>>();
const retryAfterByAttachmentId = new Map<string, number>();

export function recoverableAttachmentId(attachment: MessageAttachment) {
  return attachment.attachmentId?.trim() || null;
}

export function recoveredAttachmentPreviewUrl(attachmentId: string | null) {
  return attachmentId ? recoveredPreviewUrls.get(attachmentId) ?? null : null;
}

type RecoveryDependencies = {
  loadCloudSession?: () => Promise<{ token: string } | null>;
  recoverPreview?: typeof recoverCloudAttachmentPreview;
  now?: () => number;
  retryDelayMs?: number;
};

export function clearAttachmentPreviewRecoveryStateForTests() {
  recoveredPreviewUrls.clear();
  recoveryPromises.clear();
  retryAfterByAttachmentId.clear();
}

export async function recoverAttachmentPreviewOnce(
  attachment: MessageAttachment,
  dependencies: RecoveryDependencies = {},
) {
  const attachmentId = recoverableAttachmentId(attachment);
  if (!attachmentId) return null;
  const cached = recoveredPreviewUrls.get(attachmentId);
  if (cached) return cached;
  const now = dependencies.now ?? Date.now;
  if ((retryAfterByAttachmentId.get(attachmentId) ?? 0) > now()) return null;
  retryAfterByAttachmentId.delete(attachmentId);
  const existing = recoveryPromises.get(attachmentId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const session = await (dependencies.loadCloudSession ?? loadSession)();
      if (!session?.token) return null;
      const previewUrl = await (dependencies.recoverPreview ?? recoverCloudAttachmentPreview)({
        token: session.token,
        client: defaultCloudAuthClient(),
        attachment: {
          attachmentId,
          name: attachment.name,
          kind: attachment.kind,
          mimeType: attachment.mimeType ?? null,
          sizeBytes: attachment.sizeBytes ?? null,
          previewUrl: attachment.previewUrl ?? null,
        },
      });
      if (previewUrl) {
        recoveredPreviewUrls.set(attachmentId, previewUrl);
        retryAfterByAttachmentId.delete(attachmentId);
      } else {
        retryAfterByAttachmentId.set(
          attachmentId,
          now() + Math.max(0, dependencies.retryDelayMs ?? RECOVERY_RETRY_DELAY_MS),
        );
      }
      return previewUrl;
    } catch {
      retryAfterByAttachmentId.set(
        attachmentId,
        now() + Math.max(0, dependencies.retryDelayMs ?? RECOVERY_RETRY_DELAY_MS),
      );
      return null;
    } finally {
      recoveryPromises.delete(attachmentId);
    }
  })();
  recoveryPromises.set(attachmentId, promise);
  return promise;
}
