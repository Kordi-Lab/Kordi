import type { CloudMessage } from './authClient';
import { buildCloudMessageIndex, type CloudMessageIndex, type CloudMessageIndexOptions } from './cloudMessageIndex';

// Own exactly one reusable index per account, never a chain of past snapshots.
export function createCloudMessageIndexer(
  accountId: string | null | undefined,
  options: Pick<CloudMessageIndexOptions, 'parseGroupControl'> = {},
) {
  let previousIndex: CloudMessageIndex | undefined;
  return (messages: Record<string, CloudMessage[]>) => {
    previousIndex = buildCloudMessageIndex(accountId, messages, { ...options, previousIndex });
    return previousIndex;
  };
}
