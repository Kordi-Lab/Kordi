import { Check, Search } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';

import type { CompanionTabItem } from './CompanionDocumentTabs';

/** Full filenames remain searchable when the strip is crowded. */
export function CompanionDocumentPicker({ id, items, noun, activeId, triggerRef, onSelect, onClose }: {
  id: string;
  items: CompanionTabItem[];
  noun: 'tabs' | 'documents';
  activeId: string | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSelect: (id: string) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const filtered = items.filter(item => item.title.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    searchRef.current?.focus();
    const outside = (event: Event) => {
      if (!(event.target instanceof Node)) return;
      if (!ref.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onClose(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [onClose, triggerRef]);

  return <div ref={ref} id={id} className="app-document-menu" role="dialog" aria-label={noun === 'tabs' ? 'Find an open tab' : 'Find an open document'} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
    if (event.key === 'Enter' && event.target === searchRef.current && filtered[0]) {
      event.preventDefault();
      onSelect(filtered[0].id);
    }
  }}>
    <label className="app-document-tab-search"><Search size={15} aria-hidden="true" />
      <input ref={searchRef} aria-label={`Search open ${noun}`} placeholder={noun === 'tabs' ? 'Find a tab…' : 'Find a document…'} value={query} onChange={event => setQuery(event.target.value)} />
      <kbd aria-hidden="true">esc</kbd>
    </label>
    <div className="app-document-menu-caption">Open {noun} <span>{items.length}</span></div>
    <div role="menu" aria-label={`Open ${noun} list`}>
      {filtered.map(({ id, title, icon: Icon }) => <button type="button" role="menuitem" key={id} data-active={id === activeId} onClick={() => onSelect(id)}>
        <Icon size={15} aria-hidden="true" /><span>{title}</span>
        {id === activeId ? <Check size={14} aria-label="Active tab" /> : null}
      </button>)}
    </div>
    {!filtered.length ? <div className="app-document-no-results" role="status">No matching {noun}</div> : null}
  </div>;
}
