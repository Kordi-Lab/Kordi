import { ChevronDown, ChevronRight, Code2, FileText, Image, ListChecks, PenLine, Plus, Table2 } from 'lucide-react';
import { useCallback, useRef, useState, type ComponentType } from 'react';

import { EDITING_LIVES_ON_HOST, type DocumentInsertTool } from './documentReaderModel';
import type { DocumentEditing } from './useDocumentEditing';
import { useOutsideDismiss } from './useOutsideDismiss';

const TOOLS: Array<{ tool: DocumentInsertTool; label: string; icon: ComponentType<{ className?: string }> } | 'separator'> = [
  { tool: 'draw', label: 'Draw', icon: PenLine },
  { tool: 'code', label: 'Code block', icon: Code2 },
  'separator',
  { tool: 'table', label: 'Table', icon: Table2 },
  { tool: 'image', label: 'Image', icon: Image },
  { tool: 'checklist', label: 'Checklist', icon: ListChecks },
];

const MORE_TOOLS: Array<{ tool: DocumentInsertTool; label: string }> = [
  { tool: 'heading', label: 'Heading' },
  { tool: 'quote', label: 'Quote' },
  { tool: 'rule', label: 'Divider' },
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

/** `Tab 1` dropdown and insert tools. Inserting only works on a Mac-hosted file. */
export function DocumentTabBar({ editing, canInsert }: { editing: DocumentEditing; canInsert: boolean }) {
  const [menu, setMenu] = useState<'tabs' | 'more' | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setMenu(null), []);
  useOutsideDismiss(barRef, menu !== null, close);
  const disabledTitle = canInsert ? undefined : EDITING_LIVES_ON_HOST;

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
      <span className="app-document-tabbar-separator" aria-hidden="true" />
      {TOOLS.map((entry, index) => (entry === 'separator'
        ? <span key={`separator-${index}`} className="app-document-tabbar-separator" aria-hidden="true" />
        : (
          <button
            key={entry.tool}
            type="button"
            className="app-document-tool"
            aria-label={entry.label}
            title={disabledTitle ?? entry.label}
            disabled={!canInsert}
            onClick={() => editing.insert(entry.tool)}
          >
            <entry.icon aria-hidden="true" />
          </button>
        )))}
      <button
        type="button"
        className="app-document-tool"
        aria-label="More blocks"
        title={disabledTitle ?? 'More blocks'}
        aria-haspopup="menu"
        aria-expanded={menu === 'more'}
        disabled={!canInsert}
        onClick={() => setMenu(menu === 'more' ? null : 'more')}
      >
        <Plus aria-hidden="true" />
        <ChevronDown className="app-document-caret" aria-hidden="true" />
      </button>

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
      {menu === 'more' ? (
        <div className="app-document-menu app-document-more-menu" role="menu">
          {MORE_TOOLS.map((entry) => (
            <button key={entry.tool} type="button" role="menuitem" className="app-document-menu-row" onClick={() => { editing.insert(entry.tool); close(); }}>
              <span className="app-document-menu-label">{entry.label}</span>
            </button>
          ))}
        </div>
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
