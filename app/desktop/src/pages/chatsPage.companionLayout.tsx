import { Activity, lazy, Suspense, useContext, useLayoutEffect, type ReactNode, type Ref } from 'react';
import { NativeChatTitlebarContext } from '@/app/nativeChatTitlebarContext';
import { cn } from '@/lib/utils';
import { CompanionTitlebarContext } from './companionTitlebarContext';
import { ChatCompanionSplitDivider } from './chatsPage.companionWorkspace';
import type { CompanionView } from './chatsPage.companionToolbar';
import type { useChatCompanionLayout } from './useChatCompanionLayout';

const CompanionOverview = lazy(() => import('./chatsPage.companionOverview'));

type Props = {
  containerRef: Ref<HTMLDivElement>;
  layout: ReturnType<typeof useChatCompanionLayout>;
  view: CompanionView;
  accountId?: string;
  companionPane: ReactNode;
  children: ReactNode;
};

/** Own the split geometry and keep companion content alive through its exit. */
export function ChatCompanionLayout({ containerRef, layout, view, accountId, companionPane, children }: Props) {
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
        <CompanionTitlebarContext value={{ width: layout.panelWidth, side: layout.side, isVisible: layout.isVisible }}>
          <Activity mode={layout.isPresent && view === 'chat' ? 'visible' : 'hidden'}>
            {companionPane}
          </Activity>
          {layout.isPresent && view !== 'chat' ? <Suspense fallback={<aside className="app-companion-overview" role="status">Loading panel…</aside>}>
            <CompanionOverview accountId={accountId} view={view} onClose={() => layout.setFolded(true)} />
          </Suspense> : null}
        </CompanionTitlebarContext>
      </div>
    </div>
  </div>;
}
