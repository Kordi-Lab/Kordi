import { createContext } from 'react';

/** Native window slots keep chat controls on the same row as its title. */
export const NativeChatTitlebarContext = createContext<{
  title: HTMLDivElement | null;
  actions: HTMLDivElement | null;
} | null>(null);
