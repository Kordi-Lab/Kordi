import type { Ref } from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';

export type NativeTitlebarActions = {
  windowTitle?: string;
  onToggleSessionPanel?: () => void;
  onToggleDetailPanel?: () => void;
};

export function NativeTitlebar({
  windowTitle = 'Kordi',
  leftWorkspaceWidth,
  collapseChatSessions,
  isDetailPanelCollapsed,
  onToggleSessionPanel,
  onToggleDetailPanel,
  titleHostRef,
  actionsHostRef,
}: NativeTitlebarActions & {
  titleHostRef?: Ref<HTMLDivElement>;
  actionsHostRef?: Ref<HTMLDivElement>;
  leftWorkspaceWidth: number;
  collapseChatSessions: boolean;
  isDetailPanelCollapsed: boolean;
}) {
  return (
    <header
      className="app-native-titlebar"
      style={{ gridTemplateColumns: `${Math.max(120, leftWorkspaceWidth)}px minmax(0, 1fr) auto` }}
      data-tauri-drag-region="true"
    >
      <div className="app-native-titlebar-navigation" data-tauri-drag-region="true">
        {onToggleSessionPanel && (
          <button type="button" onClick={onToggleSessionPanel} aria-label={collapseChatSessions ? 'Show sidebar' : 'Hide sidebar'} title={collapseChatSessions ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!collapseChatSessions}>
            <PanelLeft aria-hidden="true" />
          </button>
        )}
      </div>
      <div ref={titleHostRef} className="app-native-titlebar-title" data-tauri-drag-region="true">
        <span className="app-native-titlebar-fallback" title={windowTitle}>{windowTitle}</span>
      </div>
      <div className="app-native-titlebar-actions">
        <div ref={actionsHostRef} className="app-native-chat-actions-host" />
        {onToggleDetailPanel && (
          <button type="button" onClick={onToggleDetailPanel} aria-label={isDetailPanelCollapsed ? 'Show details' : 'Hide details'} title={isDetailPanelCollapsed ? 'Show details' : 'Hide details'} aria-expanded={!isDetailPanelCollapsed}>
            <PanelRight aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  );
}
