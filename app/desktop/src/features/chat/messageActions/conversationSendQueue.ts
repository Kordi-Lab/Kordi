import { beginChatPerformanceSpan, finishChatPerformanceSpan } from '@/features/performance/chatPerformance';

/** Serialize delivery per conversation without locking the composer or optimistic rows. */
export class ConversationSendQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(conversationId: string, send: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(conversationId);
    const waitSpan = beginChatPerformanceSpan('cloud-send-queue-wait');
    const deliver = () => {
      finishChatPerformanceSpan(waitSpan, { resultClass: previous ? 'queued' : 'success' });
      return send();
    };
    const result = previous ? previous.then(deliver) : Promise.resolve().then(deliver);
    const settled = result.then(() => {}, () => {});
    this.tails.set(conversationId, settled);
    void settled.then(() => {
      if (this.tails.get(conversationId) === settled) this.tails.delete(conversationId);
    });
    return result;
  }
}
