import type { LucideIcon } from 'lucide-react';
import { ChevronLeft, ChevronRight, FileText, Globe, ListFilter, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import type { CompanionDocument } from './companionDocument';
import { CompanionDocumentPicker } from './CompanionDocumentPicker';
import { companionDocumentTabIds } from './companionTabsState';
import { documentFormatForPath } from './documentReaderModel';
import { DocumentTitleField } from './DocumentTitleField';
import { useDocumentTabScroll } from './useDocumentTabScroll';

export type CompanionTabItem = { id: string; title: string; icon: LucideIcon };

const NO_TOOL_TABS: CompanionTabItem[] = [];

/** Arrow keys select tabs; Delete/Backspace and middle click close; double click renames. */
export function CompanionDocumentTabs({ documents, activeId, titles, renames = {}, extraTabs = NO_TOOL_TABS, onActivate, onCloseTab, onHide }: {
  documents: CompanionDocument[];
  activeId: string | null;
  titles: Record<string, string>;
  extraTabs?: CompanionTabItem[];
  renames?: Partial<Record<string, (title: string) => void>>;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onHide: () => void;
}) {
  const items = useMemo<CompanionTabItem[]>(() => [...extraTabs, ...documents.map(({ artifact }) => ({
    id: artifact.id, title: titles[artifact.id] ?? artifact.name,
    icon: documentFormatForPath(artifact.path) === 'html' ? Globe : FileText,
  }))], [documents, extraTabs, titles]);
  const noun = extraTabs.length ? 'tabs' : 'documents';
  const pickerRef = useRef<HTMLButtonElement>(null);
  const focusActive = useRef(false);
  const pickerId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const activeIndex = items.findIndex(item => item.id === activeId);
  const { listRef, tabWidth, visibleCount, overflow, edges, reveal, move } = useDocumentTabScroll(activeIndex, items.length);
  const shortcutPrefix = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌥' : 'Alt+';

  const activate = useCallback((id: string) => {
    reveal(items.findIndex(item => item.id === id));
    onActivate(id);
  }, [items, onActivate, reveal]);
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) pickerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (focusActive.current) listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    focusActive.current = false;
  }, [activeId, items.length, listRef]);

  useEffect(() => {
    const handle = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !event.altKey || event.metaKey || event.ctrlKey || !/^Digit[1-9]$/.test(event.code)) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"], dialog, [role="dialog"], [role="alertdialog"]')) return;
      if (!listRef.current || listRef.current.closest('[inert], [aria-hidden="true"]')) return;
      const item = items[Number(event.code.slice(-1)) - 1];
      if (item) { event.preventDefault(); activate(item.id); }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [activate, items, listRef]);

  const close = (id: string) => {
    const tab = listRef.current?.querySelector(`[id="${companionDocumentTabIds(id).tab}"]`);
    if (tab?.parentElement?.contains(document.activeElement)) focusActive.current = true;
    onCloseTab(id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || (event.target as HTMLElement).getAttribute('role') !== 'tab') return;
    let next = activeIndex;
    if (event.key === 'ArrowRight') next = (activeIndex + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (activeIndex - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (activeId) { focusActive.current = true; onCloseTab(activeId); }
      return;
    } else return;
    event.preventDefault();
    if (items[next]) { focusActive.current = true; activate(items[next].id); }
  };

  return <header className="app-page-header app-chat-pane-header app-companion-overview-header app-document-tabs-header" data-kordi-window-drag="false">
    <button ref={pickerRef} type="button" aria-label={`All open ${noun}`} title={`Search ${items.length} open ${noun}`} aria-expanded={menuOpen} aria-haspopup="dialog" aria-controls={menuOpen ? pickerId : undefined} onClick={() => setMenuOpen(!menuOpen)}><ListFilter size={16} aria-hidden="true" /></button>
    <div className="app-document-strip-divider" aria-hidden="true" />
    {overflow ? <button type="button" className="app-document-scroll-tabs" aria-label="Previous tabs" title="Scroll tabs left" disabled={!edges.left} onClick={() => move(-1)}><ChevronLeft size={14} aria-hidden="true" /></button> : null}
    <div ref={listRef} className="app-document-tabs" role="tablist" aria-label={`Open ${noun}`} onKeyDown={onKeyDown}
      data-dense={tabWidth < 156} data-can-scroll-left={edges.left} data-can-scroll-right={edges.right}
      style={{ '--app-document-tab-width': `${tabWidth}px` } as CSSProperties}>
      {items.map(({ id, title, icon: Icon }, index) => {
        const active = id === activeId;
        const ids = companionDocumentTabIds(id);
        const rename = renames[id];
        return <div className="app-document-tab" key={id} data-active={active} role="presentation"
          onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
          onAuxClick={event => { if (event.button === 1) close(id); }}>
          {rename && renamingId === id ? <div role="tab" id={ids.tab} aria-selected={active} aria-controls={ids.panel}>
            <Icon aria-hidden="true" /><DocumentTitleField value={title} label="Title" className="app-document-tab-title-field" onSave={rename} onClose={() => setRenamingId(null)} />
          </div> : <button type="button" role="tab" id={ids.tab} aria-selected={active} aria-controls={ids.panel} aria-label={title}
            aria-keyshortcuts={index < 9 ? `Alt+${index + 1}` : undefined} tabIndex={active ? 0 : -1} title={title}
            onClick={() => activate(id)} onDoubleClick={rename ? () => setRenamingId(id) : undefined}>
            <Icon aria-hidden="true" /><span>{title}</span>{index < 9 ? <kbd aria-hidden="true">{shortcutPrefix}{index + 1}</kbd> : null}
          </button>}
          <button type="button" className="app-document-tab-close" aria-label={`Close ${title}`} title={`Close ${title}`} tabIndex={active ? 0 : -1}
            onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); close(id); }}><X aria-hidden="true" /></button>
        </div>;
      })}
    </div>
    {overflow ? <button type="button" className="app-document-scroll-tabs" aria-label="Next tabs" title="Scroll tabs right" disabled={!edges.right} onClick={() => move(1)}><ChevronRight size={14} aria-hidden="true" /></button> : null}
    {overflow ? <button type="button" className="app-document-hidden-count" aria-label={`Show all ${items.length} ${noun}`} title={`${items.length - visibleCount} more ${noun}`} aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>+{items.length - visibleCount}</button> : null}
    <button type="button" aria-label="Hide panel" title="Hide panel" onClick={onHide}><X size={16} aria-hidden="true" /></button>
    {menuOpen ? <CompanionDocumentPicker id={pickerId} items={items} noun={noun} activeId={activeId} triggerRef={pickerRef}
      onSelect={id => { activate(id); closeMenu(true); }} onClose={closeMenu} /> : null}
  </header>;
}
