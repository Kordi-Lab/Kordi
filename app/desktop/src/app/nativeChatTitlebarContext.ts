import { createContext } from 'react';

export type NativeCompanionTitlebarLayout = {
  gridColumns: string;
  side: 'left' | 'right';
  motionDuration: number;
};

/** Native window slots keep chat controls on the same row as its title. */
export const NativeChatTitlebarContext = createContext<{
  title: HTMLDivElement | null;
  actions: HTMLDivElement | null;
  companion?: HTMLDivElement | null;
  setCompanionLayout?: (layout: NativeCompanionTitlebarLayout | null) => void;
} | null>(null);
