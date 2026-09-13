import type { ReactNode } from 'react';

export function ChatPaneLayout({ children, hasHeader, activeSide }: {
  children: ReactNode;
  hasHeader: boolean;
  activeSide?: 'left' | 'right';
}) {
  return (
    <section
      className="app-chat-pane-layout min-h-0 min-w-0 flex-1 overflow-hidden bg-white/[0.025]"
      data-has-header={hasHeader}
      data-active-side={activeSide}
    >
      {children}
    </section>
  );
}
