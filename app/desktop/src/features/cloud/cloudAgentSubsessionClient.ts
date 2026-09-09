import type { DesktopChatContextMessage } from '@/lib/desktop';
import type { CloudAgentSubsession, NativeAgentSubsession } from './agentSubsessionTypes';

type SubsessionRequest = <T>(path: string, init: RequestInit, fallbackMessage: string) => Promise<T>;

export class CloudAgentSubsessionClient {
  constructor(private readonly request: SubsessionRequest) {}
  listAgentSubsessionTasks(token: string, parentSessionId: string, after?: string): Promise<{sessions: import('./agentSubsessionTypes').AgentSubsessionTask[]; nextCursor: string | null}> {
    const query = new URLSearchParams({ parentSessionId, ...(after ? { after } : {}) });
    return this.request(`/v1/cloud/agent-subsessions?${query}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
    }, 'Could not load Agent threads.');
  }

  getAgentSubsession(token: string, id: string, includeMessages = false): Promise<CloudAgentSubsession> {
    return this.request(`/v1/cloud/agent-subsessions/${encodeURIComponent(id)}?includeMessages=${includeMessages}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
    }, 'Could not load this agent task.');
  }

  stopAgentSubsession(token: string, id: string, expectedStartedAtMs: number | null): Promise<CloudAgentSubsession> {
    return this.request(`/v1/cloud/agent-subsessions/${encodeURIComponent(id)}/stop`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedStartedAtMs }),
    }, 'Could not stop this task. Try again.');
  }

  putAgentSubsession(token: string, value: NativeAgentSubsession, expectedVersion: number): Promise<CloudAgentSubsession> {
    return this.request(`/v1/cloud/agent-subsessions/${encodeURIComponent(value.sessionId)}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentSessionId: value.parentSessionId, parentRequestId: value.parentRequestId,
        title: value.title, status: value.status, messages: value.messages, activity: value.activity, expectedVersion }),
    }, 'Could not synchronize this agent task.');
  }
  sendAgentSubsessionMessage(token: string, id: string, clientMessageId: string, text: string, mentions: unknown[]): Promise<CloudAgentSubsession> {
    return this.request(`/v1/cloud/agent-subsessions/${encodeURIComponent(id)}/messages`, { method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({clientMessageId,text,mentions}) }, 'Could not send this message.');
  }
  pendingAgentSubsessionMessages(token:string): Promise<Array<{runId:string;subsessionId:string;messageId:string;senderAccountId:string;text:string;contextMessages?:DesktopChatContextMessage[]}>> {
    return this.request('/v1/cloud/agent-subsessions/pending', {method:'GET',headers:{Authorization:`Bearer ${token}`}}, 'Could not load queued task messages.');
  }
}
