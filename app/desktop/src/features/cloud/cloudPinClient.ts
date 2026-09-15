import { mergePinHistory, type CloudPinHistoryEvent } from './cloudPinHistory';
import type { CloudSessionPin } from './cloudSessionPinTypes';

type PinRequest = <T>(path: string, init: RequestInit, fallback: string) => Promise<T>;

export class CloudPinClient {
  constructor(private readonly send: PinRequest) {}

  async getCloudPinHistory(token: string, sessionId: string, signal?: AbortSignal): Promise<CloudPinHistoryEvent[]> {
    let before: number | null = null;
    let history: CloudPinHistoryEvent[] = [];
    do {
      const query = before === null ? '' : `?before=${before}`;
      const page: { events: CloudPinHistoryEvent[]; nextBefore: number | null } = await this.send(
        `/v1/cloud/sessions/${encodeURIComponent(sessionId)}/pin-history${query}`,
        { method: 'GET', signal, headers: { authorization: `Bearer ${token}` } },
        'Could not load pin history.',
      );
      history = mergePinHistory(history, page.events);
      const previous = before;
      before = page.nextBefore;
      if (before !== null) {
        if (!Number.isSafeInteger(before) || before <= 0 || (previous !== null && before >= previous)) throw new Error('Invalid pin history cursor.');
      }
    } while (before !== null);
    return history;
  }

  async getState(token: string, sessionId: string, signal?: AbortSignal): Promise<CloudSessionPin> {
    const response = await this.send<{ pin: CloudSessionPin }>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}/pin`,
      { method: 'GET', signal, headers: { authorization: `Bearer ${token}` } },
      'Could not load pinned message.',
    );
    if (!response?.pin) throw new Error('Empty response from cloud server.');
    return response.pin;
  }

  async getCloudSessionPin(token: string, sessionId: string, signal?: AbortSignal): Promise<CloudSessionPin> {
    const [pin, history] = await Promise.all([
      this.getState(token, sessionId, signal),
      this.getCloudPinHistory(token, sessionId, signal).catch(() => undefined),
    ]);
    return history === undefined ? pin : { ...pin, history };
  }

  async updateCloudSessionPin(token: string, sessionId: string, input: { messageId: string | null; scope: 'private' | 'shared' }): Promise<CloudSessionPin> {
    const response = await this.send<{ pin: CloudSessionPin }>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}/pin`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messageId: input.messageId, scope: input.scope }),
      },
      'Could not update pinned message.',
    );
    if (!response?.pin) throw new Error('Empty response from cloud server.');
    const history = await this.getCloudPinHistory(token, sessionId).catch(() => undefined);
    return history === undefined ? response.pin : { ...response.pin, history };
  }

}
