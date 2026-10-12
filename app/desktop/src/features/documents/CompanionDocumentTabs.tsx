import { FileText, Globe, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';

import type { CompanionDocument } from './companionDocument';
import { companionDocumentTabIds } from './companionTabsState';
import { documentFormatForPath } from './documentReaderModel';

/**
 * The companion pane's strip of open documents, one tab each, like a browser's.
 * Arrow keys move between tabs, Enter activates, Delete or Backspace closes; a
 * middle click closes too.
 */
export function CompanionDocumentTabs({ documents, activeId, titles, onActivate, onCloseTab, onHide }: {
  documents: CompanionDocument[];
  activeId: string | null;
  /** Titles the readers resolved, by artifact id; the file name shows until then. */
  titles: Record<string, string>;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onHide: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const focusActive = useRef(false);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    active?.parentElement?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    // After a keyboard close, focus follows to the tab that took over.
    if (focusActive.current) active?.focus();
    focusActive.current = false;
  }, [activeId, documents.length]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const index = tabs.findIndex((tab) => tab === event.target);
    const id = documents[index]?.artifact.id;
    if (!id) return;
    const move = (next: number) => tabs[(next + tabs.length) % tabs.length]?.focus();
    if (event.key === 'ArrowRight') move(index + 1);
    else if (event.key === 'ArrowLeft') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(tabs.length - 1);
    else if (event.key === 'Enter') onActivate(id);
    else if (event.key === 'Delete' || event.key === 'Backspace') { focusActive.current = true; onCloseTab(id); }
    else return;
    event.preventDefault();
  };

  return (
    <header className="app-page-header app-chat-pane-header app-companion-overview-header app-document-tabs-header">
      <div ref={listRef} className="app-document-tabs" role="tablist" aria-label="Open documents" onKeyDown={onKeyDown}>
        {documents.map(({ artifact }) => {
          const active = artifact.id === activeId;
          const title = titles[artifact.id] ?? artifact.name;
          const ids = companionDocumentTabIds(artifact.id);
          const Icon = documentFormatForPath(artifact.path) === 'html' ? Globe : FileText;
          return (
            <div
              key={artifact.id}
              className="app-document-tab"
              role="presentation"
              data-active={active}
              // A middle press would start autoscroll; it closes the tab instead.
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
              onAuxClick={(event) => { if (event.button === 1) onCloseTab(artifact.id); }}
            >
              <button
                type="button"
                role="tab"
                id={ids.tab}
                aria-selected={active}
                aria-controls={ids.panel}
                tabIndex={active ? 0 : -1}
                title={title}
                onClick={() => onActivate(artifact.id)}
              >
                <Icon aria-hidden="true" />
                <span>{title}</span>
              </button>
              <button type="button" className="app-document-tab-close" aria-label={`Close ${title}`} title="Close" tabIndex={-1} onClick={() => onCloseTab(artifact.id)}>
                <X aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" aria-label="Hide panel" title="Hide panel" onClick={onHide}><X size={16} aria-hidden="true" /></button>
    </header>
  );
}
