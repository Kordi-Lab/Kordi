export type AgentSubsessionMessage = {
  id: string; role: 'user' | 'assistant'; text: string; timestampMs: number;
  senderAccountId?: string; senderDisplayName?: string; requestId?: string;
  requestState?: string | null; mentions?: import('@/kordi-app/types').MessageMention[];
  activity?: { tools?: import('@/kordi-app/types').DesktopChatToolSnapshot[] };
};
export type NativeAgentSubsession = {
  canResume?: boolean;
  sessionId: string; parentSessionId: string; parentRequestId: string | null;
  title: string; status: string; messages: AgentSubsessionMessage[];
  turnId?: string | null; activity?: { tools?: import('@/kordi-app/types').DesktopChatToolSnapshot[] };
};
export type CloudAgentSubsession = Omit<NativeAgentSubsession, 'parentRequestId'> & {
  parentRequestId: string; ownerAccountId: string; agentId: string;
  ownerDisplayName: string; agentDisplayName: string; version: number; updatedAt: string;
  hasFollowupExecution?: boolean;
  participants?: Array<{accountId:string;displayName:string}>;
};
