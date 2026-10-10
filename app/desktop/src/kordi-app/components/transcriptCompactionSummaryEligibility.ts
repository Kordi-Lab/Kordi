import type { Message } from '../types';

const COMPACTION_DETAIL_PREFIX = 'Conversation compressed';
export function isCompactionSummaryMessage(msg: Message) {
  return msg.role === 'system' && msg.detail?.startsWith(COMPACTION_DETAIL_PREFIX);
}
