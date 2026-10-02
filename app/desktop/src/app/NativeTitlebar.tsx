import type { CSSProperties, Ref } from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';
import type { NativeCompanionTitlebarLayout } from './nativeChatTitlebarContext';

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
  companionHostRef,
  companionLayout,
  detailRailWidth = 0,
}: NativeTitlebarActions & {
  titleHostRef?: Ref<HTMLDivElement>;
  actionsHostRef?: Ref<HTMLDivElement>;
  companionHostRef?: Ref<HTMLDivElement>;
  companionLayout?: NativeCompanionTitlebarLayout | null;
  detailRailWidth?: number;
  leftWorkspaceWidth: number;
  collapseChatSessions: boolean;
  isDetailPanelCollapsed: boolean;
}) {
  return (
    <header
      className="app-native-titlebar"
      style={{ '--app-native-sidebar-width': `${leftWorkspaceWidth}px` } as CSSProperties}
      data-tauri-drag-region="true"
    >
      <div className="app-native-titlebar-navigation" data-tauri-drag-region="true">
        {/* TODO: Add Back/Forward history controls before the sidebar toggle.
            Reserve space after the native traffic lights and increase the
            navigation track's minimum width so controls cannot overlap the
            title. Disable unavailable history directions and keep the short
            titlebar separator without a full-height folded-sidebar border. */}
        {onToggleSessionPanel && (
          <button type="button" onClick={onToggleSessionPanel} aria-label={collapseChatSessions ? 'Show sidebar' : 'Hide sidebar'} title={collapseChatSessions ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!collapseChatSessions}>
            <PanelLeft aria-hidden="true">
              {collapseChatSessions
                ? <path d="m14 9 3 3-3 3" />
                : <path d="M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" fill="currentColor" fillOpacity={0.18} stroke="none" />}
            </PanelLeft>
          </button>
        )}
      </div>
      <div className="app-native-titlebar-workspace" data-companion-side={companionLayout?.side}
        style={{ '--app-native-detail-width': `${detailRailWidth}px`,
          gridTemplateColumns: companionLayout?.gridColumns ?? 'minmax(0, 1fr)',
          transitionDuration: `${companionLayout?.motionDuration ?? 0}ms`,
        } as CSSProperties}>
        <div className="app-native-titlebar-main">
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
        </div>
        <div ref={companionHostRef} className="app-native-companion-titlebar-host" />
      </div>
    </header>
  );
}
