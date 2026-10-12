import { ChevronDown, ChevronRight, Code2, FileText, Image, ListChecks, Plus, Table2 } from 'lucide-react';
import { useCallback, useRef, useState, type ComponentType } from 'react';

import type { DocumentInsertTool } from './documentReaderModel';
import type { DocumentEditing } from './useDocumentEditing';
import { useOutsideDismiss } from './useOutsideDismiss';

const TOOLS: Array<{ tool: DocumentInsertTool; label: string; icon: ComponentType<{ className?: string }> } | 'separator'> = [
  { tool: 'code', label: 'Code block', icon: Code2 },
  'separator',
  { tool: 'table', label: 'Table', icon: Table2 },
  { tool: 'image', label: 'Image', icon: Image },
  { tool: 'checklist', label: 'Checklist', icon: ListChecks },
];

export function DocumentSwitch({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="app-document-switch"
      onClick={() => onChange(!checked)}
    />
  );
}

/** `Tab 1` dropdown, plus insert tools where the viewer can edit. Each tool adds a block after the current one. */
export function DocumentTabBar({ editing, canInsert, onInsert }: {
  editing: DocumentEditing;
  canInsert: boolean;
  onInsert: (tool: DocumentInsertTool, url?: string) => void;
}) {
  const [menu, setMenu] = useState<'tabs' | 'image' | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const barRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setMenu(null), []);
  useOutsideDismiss(barRef, menu !== null, close);

  return (
    <div className="app-document-tabbar" ref={barRef}>
      <button
        type="button"
        className="app-document-tab-current"
        aria-haspopup="menu"
        aria-expanded={menu === 'tabs'}
        onClick={() => setMenu(menu === 'tabs' ? null : 'tabs')}
      >
        <FileText aria-hidden="true" />
        {editing.tabNames[editing.currentTab]}
        <ChevronDown className="app-document-caret" aria-hidden="true" />
      </button>
      {canInsert ? (
        <>
          <span className="app-document-tabbar-separator" aria-hidden="true" />
          {TOOLS.map((entry, index) => (entry === 'separator'
            ? <span key={`separator-${index}`} className="app-document-tabbar-separator" aria-hidden="true" />
            : (
              <button
                key={entry.tool}
                type="button"
                className="app-document-tool"
                aria-label={entry.label}
                title={entry.label}
                aria-expanded={entry.tool === 'image' ? menu === 'image' : undefined}
                onClick={() => (entry.tool === 'image' ? setMenu(menu === 'image' ? null : 'image') : onInsert(entry.tool))}
              >
                <entry.icon aria-hidden="true" />
              </button>
            )))}
        </>
      ) : null}
      {menu === 'tabs' ? (
        <div className="app-document-menu app-document-tab-menu" role="menu">
          <div className="app-document-menu-row">
            <span className="app-document-menu-label">Show on page</span>
            <DocumentSwitch checked={editing.showTabs} label="Show tabs on page" onChange={editing.setShowTabs} />
          </div>
          <hr />
          {editing.tabNames.map((name, index) => (
            <button
              key={name}
              type="button"
              role="menuitemradio"
              aria-checked={index === editing.currentTab}
              className="app-document-menu-row"
              onClick={() => { editing.selectTab(index); close(); }}
            >
              <ChevronRight aria-hidden="true" />
              <span className="app-document-menu-label">{name}</span>
            </button>
          ))}
          <button type="button" role="menuitem" className="app-document-menu-row" onClick={() => { editing.newTab(); close(); }}>
            <Plus aria-hidden="true" />
            <span className="app-document-menu-label">New tab</span>
          </button>
        </div>
      ) : null}
      {menu === 'image' ? (
        <form
          className="app-document-menu app-document-image-form"
          onSubmit={(event) => { event.preventDefault(); if (imageUrl.trim()) { onInsert('image', imageUrl); setImageUrl(''); close(); } }}
        >
          <input autoFocus type="url" value={imageUrl} placeholder="https://" aria-label="Image URL" onChange={(event) => setImageUrl(event.target.value)} />
          <button type="submit" disabled={!imageUrl.trim()}>Add</button>
        </form>
      ) : null}
    </div>
  );
}

/** Tabs shown on the page when **Show on page** is on and there is more than one tab. */
export function DocumentTabStrip({ editing }: { editing: DocumentEditing }) {
  if (!editing.showTabs || editing.tabNames.length < 2) return null;
  return (
    <div className="app-document-tabstrip" role="tablist">
      {editing.tabNames.map((name, index) => (
        <button key={name} type="button" role="tab" aria-selected={index === editing.currentTab} onClick={() => editing.selectTab(index)}>
          {name}
        </button>
      ))}
    </div>
  );
}
