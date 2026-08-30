import type { CloudAuthClient } from '@/features/cloud/authClient';
import {
  readExpressiveMediaLibrary,
  waitForExpressiveMediaLibrarySync,
  writeExpressiveMediaLibrary,
} from './expressiveMediaLibrary';

type ExpressiveMediaDeletionOptions = {
  accountId?: string | null;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  token?: string | null;
  client?: Pick<CloudAuthClient, 'deleteExpressiveMedia'>;
};

export async function deleteExpressiveMediaLibraryItem(
  itemId: string,
  options: ExpressiveMediaDeletionOptions = {},
) {
  const accountId = options.accountId?.trim();
  await waitForExpressiveMediaLibrarySync(accountId);
  const items = readExpressiveMediaLibrary(options.storage, accountId);
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) return items;
  const remoteId = item.cloudItemId ?? item.attachmentId;
  if (remoteId) {
    if (!options.token || !options.client) {
      throw new Error('Sign in again before deleting this saved media.');
    }
    await options.client.deleteExpressiveMedia(options.token, remoteId);
  }
  const next = items.filter((candidate) => candidate.id !== itemId);
  writeExpressiveMediaLibrary(next, options.storage, accountId);
  return next;
}
