import type {
  DesktopChatMessage,
  Message,
} from '@/kordi-app/types';

export type UseDesktopChatStateArgs = {
  isNativeShell: boolean;
  mapDesktopMessages: (
    sessionId: string,
    messages: DesktopChatMessage[],
    sessionContext?: { metadata?: unknown },
  ) => Message[];
  refreshCanonicalSession?: (sessionId: string) => Promise<unknown>;
};
