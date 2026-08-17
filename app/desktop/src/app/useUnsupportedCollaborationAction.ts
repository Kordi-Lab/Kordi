import { useCallback } from 'react';

export function useUnsupportedCollaborationAction(
  setDesktopChatError: (message: string) => void,
) {
  return useCallback((..._args: unknown[]) => {
    const message = 'This connection action is unavailable.';
    setDesktopChatError(message);
    return Promise.reject(new Error(message));
  }, [setDesktopChatError]);
}
