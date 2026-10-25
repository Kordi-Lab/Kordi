import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type AgentStudioCompactPane = 'chat' | 'workspace';

const PANES: Array<{ pane: AgentStudioCompactPane; label: string }> = [
  { pane: 'chat', label: 'Chat' },
  { pane: 'workspace', label: 'Blueprint' },
];

/**
 * The Factory build body. Narrow windows show one pane at a time behind a Chat / Blueprint
 * switcher (styles/shell-factory-overlays.css); wide windows hide the switcher and show both.
 * Editing an existing agent opens on the Blueprint, creating one on the Chat.
 */
export function AgentStudioCompactBody({ children, initialPane = 'chat' }: {
  children: ReactNode;
  initialPane?: AgentStudioCompactPane;
}) {
  const [compactPane, setCompactPane] = useState<AgentStudioCompactPane>(initialPane);
  const [appliedInitialPane, setAppliedInitialPane] = useState(initialPane);
  // A new build target (creating vs editing) starts on its own default pane.
  if (appliedInitialPane !== initialPane) {
    setAppliedInitialPane(initialPane);
    setCompactPane(initialPane);
  }
  return (
    <>
      <div className="app-agent-studio-compact-switcher" role="tablist" aria-label="Build pane">
        {PANES.map(({ pane, label }) => (
          <button
            key={pane}
            type="button"
            role="tab"
            aria-selected={compactPane === pane}
            className={cn(compactPane === pane && 'is-active')}
            onClick={() => setCompactPane(pane)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="app-agent-studio-body" data-compact-pane={compactPane}>
        {children}
      </div>
    </>
  );
}
