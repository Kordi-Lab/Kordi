import { createContext } from 'react';
import type { CompanionSide } from './chatsPage.model';

/** Share the panel's existing container-relative geometry with its native header. */
export const CompanionTitlebarContext = createContext<{
  width: string;
  side: CompanionSide;
  isVisible: boolean;
} | null>(null);
