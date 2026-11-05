import { Activity, lazy, Suspense, useContext, useLayoutEffect, type ReactNode, type Ref } from 'react';
import { NativeChatTitlebarContext } from '@/app/nativeChatTitlebarContext';
import { cn } from '@/lib/utils';
import { CompanionTitlebarContext } from './companionTitlebarContext';
import { ChatCompanionSplitDivider } from './chatsPage.companionWorkspace';
import type { CompanionView } from './chatsPage.companionToolbar';
import type { useChatCompanionLayout } from './useChatCompanionLayout';
import { CompanionTitlebar } from './CompanionTitlebar';
import { companionDocumentTabIds } from '@/features/documents/companionTabsState';
import { companionViewTabId, type CompanionToolView } from './useCompanionPaneTabs';

const CompanionOverview = lazy(() => import('./chatsPage.companionOverview'));

type Props = {
  containerRef: Ref<HTMLDivElement>;
  layout: ReturnType<typeof useChatCompanionLayout>;
  view: CompanionView;
  accountId?: string;
  companionPane: ReactNode;
  /** Reader shown for the `document` view. */
  documentPane?: ReactNode;
  tabBar?: ReactNode;
  openedViews?: CompanionToolView[];
  children: ReactNode;
};

/** Own the split geometry and keep companion content alive through its exit. */
export function ChatCompanionLayout({ containerRef, layout, view, accountId, companionPane, documentPane, tabBar, openedViews, children }: Props) {
  const setTitlebarLayout = useContext(NativeChatTitlebarContext)?.setCompanionLayout;
  const { gridColumns, side, motionDuration } = layout;
  useLayoutEffect(() => {
    if (!setTitlebarLayout) return;
    setTitlebarLayout({ gridColumns, side, motionDuration });
    return () => setTitlebarLayout(null);
  }, [setTitlebarLayout, gridColumns, side, motionDuration]);

  return <div
    ref={containerRef}
    className={cn(
      'app-chat-split-workspace relative grid min-h-0 flex-1 overflow-hidden',
      layout.isDragging && 'ring-1 ring-sky-300/25',
      layout.dropPreviewSide === 'left' && 'bg-gradient-to-r from-sky-400/10 via-transparent to-transparent',
      layout.dropPreviewSide === 'right' && 'bg-gradient-to-l from-sky-400/10 via-transparent to-transparent',
    )}
    style={{ gridTemplateColumns: layout.gridColumns, transitionDuration: `${layout.motionDuration}ms` }}
    data-chat-companion-side={layout.side}
    data-chat-split-workspace="true"
    data-chat-companion-drop-preview={layout.dropPreviewSide ?? undefined}
    onDragOver={layout.onDragOver}
    onDrop={layout.onDrop}
    onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) layout.clearDropPreview();
    }}
  >
    {children}
    {layout.isPresent ? <ChatCompanionSplitDivider layoutModel={layout} /> : null}
    <div className="app-companion-panel-motion" data-open={layout.isVisible} data-side={layout.side}
      aria-hidden={!layout.isVisible} inert={!layout.isVisible}>
      <div className="app-companion-panel-surface" style={{ width: layout.panelWidth }}>
        <CompanionTitlebarContext value={{ width: layout.panelWidth, side: layout.side, isVisible: layout.isVisible, hasTabs: !!tabBar }}>
          {tabBar ? <CompanionTitlebar primary>{tabBar}</CompanionTitlebar> : null}
          <Activity mode={layout.isPresent && view === 'chat' ? 'visible' : 'hidden'}>
            <div className="app-companion-tab-content" role={tabBar ? 'tabpanel' : undefined}
              id={companionDocumentTabIds(companionViewTabId('chat')).panel}
              aria-labelledby={tabBar ? companionDocumentTabIds(companionViewTabId('chat')).tab : undefined}>
              {companionPane}
            </div>
          </Activity>
          {/* Activity disconnects effects and destroys Tiptap editors. Keep document sessions
              mounted while hidden so drafts, undo history, and collaboration survive. */}
          <div className="app-companion-tab-content" hidden={!layout.isPresent || view !== 'document'}>
            {documentPane}
          </div>
          {(['digest', 'calendar'] as const).filter(tool => openedViews ? openedViews.includes(tool) : view === tool).map(tool => {
            const ids = companionDocumentTabIds(companionViewTabId(tool));
            return <Activity key={tool} mode={layout.isPresent && view === tool ? 'visible' : 'hidden'}>
              <div className="app-companion-tab-content" role={tabBar ? 'tabpanel' : undefined} id={ids.panel} aria-labelledby={tabBar ? ids.tab : undefined}>
                <Suspense fallback={<aside className="app-companion-overview" role="status">Loading panel…</aside>}>
                  <CompanionOverview accountId={accountId} view={tool} showHeader={!tabBar} onClose={() => layout.setFolded(true)} />
                </Suspense>
              </div>
            </Activity>;
          })}
        </CompanionTitlebarContext>
      </div>
    </div>
  </div>;
}
