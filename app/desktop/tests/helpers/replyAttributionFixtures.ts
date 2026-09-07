import type { DesktopChatTurnSnapshot,Message } from "../../src/kordi-app/types";

export function turn(overrides: Partial<DesktopChatTurnSnapshot> = {}): DesktopChatTurnSnapshot {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: '',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Done',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
    error: null,
    ...overrides,
  };
}

export function humanRequest(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg:request',
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '@AliceKordi review the copy and call out confusing parts.',
    time: '10:00',
    ...overrides,
  };
}
