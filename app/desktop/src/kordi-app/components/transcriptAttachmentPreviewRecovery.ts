import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { CloudAttachmentPreviewQueue, recoverCloudAttachmentPreview } from '@/features/cloud/cloudAttachments';
import {
  acquireCloudAttachmentPreviewLease, cachedCloudAttachmentPreviewResource,
  retainCloudAttachmentPreviewResource, clearCloudAttachmentPreviewCache, cloudAttachmentPreviewCacheEpoch, subscribeCloudAttachmentPreviewReset,
} from '@/features/cloud/cloudAttachmentPreviewCache';
import { loadSession } from '@/features/cloud/session';
import type { MessageAttachment } from '../types';

const RECOVERY_RETRY_DELAY_MS = 30_000;
const recoveryQueue = new CloudAttachmentPreviewQueue(2);
type RecoveryTask = { epoch: number; controller: AbortController; users: number; pending: boolean; promise: Promise<string | null> };
const recoveryPromises = new Map<string, RecoveryTask>();
const retryAfterByAttachmentId = new Map<string, { epoch: number; until: number }>();
const recoveredCacheId = (id: string) => `recovered:${id}`;

function rememberRetry(id: string, until: number, epoch: number) {
  retryAfterByAttachmentId.delete(id);
  retryAfterByAttachmentId.set(id, { until, epoch });
  while (retryAfterByAttachmentId.size > 128) retryAfterByAttachmentId.delete(retryAfterByAttachmentId.keys().next().value!);
}

function previewMemoryCost(url: string, attachment: MessageAttachment) {
  const valid = (value?: number | null) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 960;
  const width = valid(attachment.widthPixels), height = valid(attachment.heightPixels);
  const scale = Math.min(1, 960 / Math.max(width, height));
  return url.length * 2 + Math.ceil(width * scale) * Math.ceil(height * scale) * 4;
}

export function recoverableAttachmentId(attachment: MessageAttachment) {
  return attachment.attachmentId?.trim() || null;
}

export function recoveredAttachmentPreviewUrl(attachmentId: string | null) {
  return attachmentId ? cachedCloudAttachmentPreviewResource(recoveredCacheId(attachmentId))?.previewUrl ?? null : null;
}

type RecoveryDependencies = {
  loadCloudSession?: () => Promise<{ token: string } | null>;
  recoverPreview?: typeof recoverCloudAttachmentPreview;
  now?: () => number;
  retryDelayMs?: number;
  signal?: AbortSignal;
};

const stopResetSubscription = subscribeCloudAttachmentPreviewReset(() => {
  for (const task of recoveryPromises.values()) task.controller.abort();
  recoveryQueue.clear();
  recoveryPromises.clear();
  retryAfterByAttachmentId.clear();
});
import.meta.hot?.dispose(stopResetSubscription);

export function clearAttachmentPreviewRecoveryStateForTests() { clearCloudAttachmentPreviewCache(); }

function subscribeRecovery(id: string, task: RecoveryTask, signal?: AbortSignal): Promise<string | null> {
  task.users += 1;
  return new Promise(resolve => {
    let finished = false;
    const complete = (value: string | null) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', aborted);
      task.users -= 1;
      if (task.users === 0 && task.pending) {
        task.controller.abort();
        if (recoveryPromises.get(id) === task) recoveryPromises.delete(id);
      }
      resolve(value);
    };
    const aborted = () => complete(null);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    else void task.promise.then(complete, () => complete(null));
  });
}

export async function recoverAttachmentPreviewOnce(attachment: MessageAttachment, dependencies: RecoveryDependencies = {}) {
  const attachmentId = recoverableAttachmentId(attachment);
  if (!attachmentId || dependencies.signal?.aborted) return null;
  const epoch = cloudAttachmentPreviewCacheEpoch();
  const cached = recoveredAttachmentPreviewUrl(attachmentId);
  if (cached) return cached;
  const now = dependencies.now ?? Date.now;
  const retry = retryAfterByAttachmentId.get(attachmentId);
  if (retry?.epoch === epoch && retry.until > now()) return null;
  retryAfterByAttachmentId.delete(attachmentId);
  const existing = recoveryPromises.get(attachmentId);
  if (existing?.epoch === epoch && !existing.controller.signal.aborted) return subscribeRecovery(attachmentId, existing, dependencies.signal);

  const task: RecoveryTask = { epoch, controller: new AbortController(), users: 0, pending: true, promise: Promise.resolve(null) };
  task.promise = recoveryQueue.run(async signal => {
    const session = await (dependencies.loadCloudSession ?? loadSession)();
    if (!session?.token || signal.aborted) return null;
    const previewUrl = await (dependencies.recoverPreview ?? recoverCloudAttachmentPreview)({
      token: session.token, client: defaultCloudAuthClient(), signal,
      attachment: { attachmentId, name: attachment.name, kind: attachment.kind,
        mimeType: attachment.mimeType ?? null, sizeBytes: attachment.sizeBytes ?? null, previewUrl: attachment.previewUrl ?? null },
    });
    if (signal.aborted || epoch !== cloudAttachmentPreviewCacheEpoch()) return null;
    if (previewUrl) {
      const resource = retainCloudAttachmentPreviewResource(recoveredCacheId(attachmentId), previewUrl, previewMemoryCost(previewUrl, attachment));
      acquireCloudAttachmentPreviewLease(resource).release();
      retryAfterByAttachmentId.delete(attachmentId);
    } else rememberRetry(attachmentId, now() + Math.max(0, dependencies.retryDelayMs ?? RECOVERY_RETRY_DELAY_MS), epoch);
    return previewUrl;
  }, task.controller.signal).catch(() => {
    if (!task.controller.signal.aborted && epoch === cloudAttachmentPreviewCacheEpoch()) rememberRetry(attachmentId, now() + Math.max(0, dependencies.retryDelayMs ?? RECOVERY_RETRY_DELAY_MS), epoch);
    return null;
  }).finally(() => {
    task.pending = false;
    if (recoveryPromises.get(attachmentId) === task) recoveryPromises.delete(attachmentId);
  });
  recoveryPromises.set(attachmentId, task);
  return subscribeRecovery(attachmentId, task, dependencies.signal);
}
