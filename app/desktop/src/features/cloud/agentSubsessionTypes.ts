export type AgentSubsessionMessage = { id: string; role: 'user' | 'assistant'; text: string; timestampMs: number };
export type NativeAgentSubsession = {
  sessionId: string; parentSessionId: string; parentRequestId: string | null;
  title: string; status: string; messages: AgentSubsessionMessage[];
};
export type CloudAgentSubsession = Omit<NativeAgentSubsession, 'parentRequestId'> & {
  parentRequestId: string; ownerAccountId: string; agentId: string;
  ownerDisplayName: string; agentDisplayName: string; version: number; updatedAt: string;
};
