import { createContext, useContext } from 'react';
import { NativeChatTitlebarContext } from '@/app/nativeChatTitlebarContext';
import type { CompanionSide } from './chatsPage.model';

/** Share the panel's existing container-relative geometry with its native header. */
export const CompanionTitlebarContext = createContext<{
  width: string;
  side: CompanionSide;
  isVisible: boolean;
} | null>(null);

/** True when the panel title row is hosted on the native main-chat title row. */
export function useCompanionTitlebarPortal() {
  const native = useContext(NativeChatTitlebarContext);
  const panel = useContext(CompanionTitlebarContext);
  return Boolean(native?.companion && panel);
}
