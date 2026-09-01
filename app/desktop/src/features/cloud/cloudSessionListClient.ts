export type CloudSessionVisibility = {
  hiddenSessionIds: string[];
  deletedSessionIds: string[];
  unreadSessionIds: string[];
  pinnedSessionIds: string[];
  mutedSessionIds: string[];
  pinnedGroupSpaceIds: string[];
};

type CloudSessionListRequest = <TResponse>(
  path: string,
  init: RequestInit,
  fallbackMessage: string,
) => Promise<TResponse>;

export class CloudSessionListClient {
  constructor(private readonly request: CloudSessionListRequest) {}

  async list(token: string): Promise<CloudSessionVisibility> {
    const response = await this.request<CloudSessionVisibility>(
      '/v1/cloud/sessions/visibility',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      'Could not load hidden cloud chats.',
    );
    return {
      hiddenSessionIds: response?.hiddenSessionIds ?? [],
      deletedSessionIds: response?.deletedSessionIds ?? [],
      unreadSessionIds: response?.unreadSessionIds ?? [],
      pinnedSessionIds: response?.pinnedSessionIds ?? [],
      mutedSessionIds: response?.mutedSessionIds ?? [],
      pinnedGroupSpaceIds: response?.pinnedGroupSpaceIds ?? [],
    };
  }

  setArchived(token: string, sessionId: string, archived: boolean): Promise<void> {
    return this.request<void>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}/hidden`,
      { method: archived ? 'PUT' : 'DELETE', headers: { authorization: `Bearer ${token}` } },
      archived ? 'Could not hide cloud chat.' : 'Could not unhide cloud chat.',
    );
  }

  delete(token: string, sessionId: string): Promise<void> {
    return this.request<void>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
      'Could not remove cloud chat.',
    );
  }

  setSessionPreference(
    token: string,
    sessionId: string,
    preference: 'pinned' | 'muted' | 'unread',
    enabled: boolean,
    fallbackMessage: string,
  ): Promise<void> {
    return this.request<void>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}/${preference}`,
      { method: enabled ? 'PUT' : 'DELETE', headers: { authorization: `Bearer ${token}` } },
      fallbackMessage,
    );
  }

  setGroupPinned(token: string, groupSpaceId: string, pinned: boolean): Promise<void> {
    return this.request<void>(
      `/v1/cloud/group-spaces/${encodeURIComponent(groupSpaceId)}/pinned`,
      { method: pinned ? 'PUT' : 'DELETE', headers: { authorization: `Bearer ${token}` } },
      pinned ? 'Could not pin cloud group.' : 'Could not unpin cloud group.',
    );
  }
}
