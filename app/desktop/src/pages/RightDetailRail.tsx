import type { ReactNode } from 'react';
import { Braces, X } from 'lucide-react';

import type { DetailTab, EditFilePreview } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

type RightDetailRailProps = {
  detailTabs: Array<{ id: DetailTab; label: string }>;
  activeDetailTab: DetailTab;
  onSelectDetailTab: (tab: DetailTab) => void;
  activeSourcePreview: EditFilePreview | null;
  onCloseSourcePreview: () => void;
  children: ReactNode;
};

export function RightDetailRail({
  detailTabs,
  activeDetailTab,
  onSelectDetailTab,
  activeSourcePreview,
  onCloseSourcePreview,
  children,
}: RightDetailRailProps) {
  return (
    <aside className="app-main-panel app-right-detail-rail min-w-0 text-white">
      <div className="flex h-full min-h-0 flex-col px-3 py-3">
        <div className="mb-3 shrink-0">
          <div className="app-detail-tab-list app-inspector-tabs w-full">
            {detailTabs.map((tab) => {
              const active = activeDetailTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onSelectDetailTab(tab.id)}
                  className={cn('app-detail-tab-button app-inspector-tab px-4', active ? 'app-inspector-tab-active' : '')}
                  title={tab.label}
                  aria-label={tab.label}
                >
                  <span className="truncate">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-1 pb-1">
          {activeSourcePreview ? (
            <div className="space-y-3">
              <div className="border-b border-[color:var(--app-divider)] pb-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Braces className="h-4 w-4 shrink-0 text-slate-300" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">
                    {activeSourcePreview.path.split('/').pop()}
                  </span>
                  <button
                    type="button"
                    onClick={onCloseSourcePreview}
                    className="app-icon-button grid h-6 w-6 place-items-center rounded-md p-0 text-slate-400 transition hover:text-white"
                    aria-label="Close source preview"
                    title="Close source preview"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-1 truncate text-[12px] text-slate-500">{activeSourcePreview.path}</div>
              </div>
              <div className="app-code-panel overflow-hidden rounded-[20px] shadow-[var(--app-shadow-soft)]">
                <div className="app-code-toolbar border-b border-white/10 px-4 py-2 text-[12px] text-slate-400">
                  Source preview
                </div>
                <div className="font-mono text-[12px] leading-7">
                  {(activeSourcePreview.sourceLines ?? []).map((line) => (
                    <div
                      key={`${activeSourcePreview.path}-${line.number}-${line.text}`}
                      className={cn(
                        'grid grid-cols-[56px_minmax(0,1fr)] px-4',
                        line.kind === 'add' ? 'bg-emerald-400/8' : '',
                      )}
                    >
                      <div className="select-none pr-3 text-right text-slate-500">{line.number}</div>
                      <code
                        className={cn(
                          'block min-w-0 overflow-hidden text-ellipsis whitespace-pre-wrap break-words',
                          line.kind === 'add' ? 'text-emerald-100' : 'text-slate-200',
                        )}
                      >
                        {line.text}
                      </code>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : children}
        </div>
      </div>
    </aside>
  );
}
