import { useCallback, useState } from 'react';

import { splitMarkdownBlocks } from './documentBlocks';
import { appendMarkdownBlock, DOCUMENT_INSERT_SNIPPETS, type DocumentInsertTool } from './documentReaderModel';

export type DocumentBlockStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight';
export type DocumentFormatAction = DocumentBlockStyle | 'heading' | 'list' | 'link';

type DocumentTab = { name: string; source: string };

const BLOCK_STYLES = new Set<DocumentFormatAction>(['bold', 'italic', 'underline', 'strike', 'code', 'highlight']);
const LIST_PREFIX = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

function cycleHeading(source: string) {
  const match = /^(#{1,6})\s+/.exec(source);
  if (!match) return `## ${source}`;
  const rest = source.slice(match[0].length);
  return match[1].length >= 3 ? rest : `${match[1]}# ${rest}`;
}

function toggleList(source: string) {
  const lines = source.split('\n');
  return lines.every((line) => !line.trim() || LIST_PREFIX.test(line))
    ? lines.map((line) => line.replace(LIST_PREFIX, '$1')).join('\n')
    : lines.map((line) => (line.trim() ? `- ${line}` : line)).join('\n');
}

function addLink(source: string, selection: string) {
  const target = selection.trim();
  if (target && source.includes(target)) return source.replace(target, `[${target}](https://)`);
  return `[${source}](https://)`;
}

/**
 * Local drafts of a Mac-hosted document: tabs, inserted blocks, and formatting.
 * Nothing here is saved to the file or the server.
 */
export function useDocumentEditing(initialSource: string) {
  const [baseSource, setBaseSource] = useState(initialSource);
  const [tabs, setTabs] = useState<DocumentTab[]>([{ name: 'Tab 1', source: initialSource }]);
  const [currentTab, setCurrentTab] = useState(0);
  const [showTabs, setShowTabs] = useState(false);
  const [styles, setStyles] = useState<Record<string, DocumentBlockStyle[]>>({});

  if (baseSource !== initialSource) {
    setBaseSource(initialSource);
    setTabs((current) => [{ ...current[0], source: initialSource }, ...current.slice(1)]);
  }

  const currentSource = tabs[currentTab]?.source ?? '';

  const newTab = useCallback(() => {
    setTabs((current) => [...current, { name: `Tab ${current.length + 1}`, source: '' }]);
    setCurrentTab(tabs.length);
  }, [tabs.length]);

  const updateCurrentSource = useCallback((update: (source: string) => string) => {
    setTabs((current) => current.map((tab, index) => (index === currentTab ? { ...tab, source: update(tab.source) } : tab)));
  }, [currentTab]);

  const insert = useCallback((tool: DocumentInsertTool) => {
    updateCurrentSource((source) => appendMarkdownBlock(source, DOCUMENT_INSERT_SNIPPETS[tool]));
  }, [updateCurrentSource]);

  const blockStyles = useCallback((blockId: string) => styles[`${currentTab}:${blockId}`] ?? [], [currentTab, styles]);

  const format = useCallback((blockId: string, action: DocumentFormatAction, selection = '') => {
    if (BLOCK_STYLES.has(action)) {
      const key = `${currentTab}:${blockId}`;
      const style = action as DocumentBlockStyle;
      setStyles((current) => {
        const active = current[key] ?? [];
        return { ...current, [key]: active.includes(style) ? active.filter((entry) => entry !== style) : [...active, style] };
      });
      return;
    }
    updateCurrentSource((source) => splitMarkdownBlocks(source).map((block) => {
      if (block.id !== blockId) return block.source;
      if (action === 'heading') return cycleHeading(block.source);
      if (action === 'list') return toggleList(block.source);
      return addLink(block.source, selection);
    }).join('\n\n'));
  }, [currentTab, updateCurrentSource]);

  return {
    tabNames: tabs.map((tab) => tab.name),
    currentTab,
    currentSource,
    showTabs,
    setShowTabs,
    selectTab: setCurrentTab,
    newTab,
    insert,
    format,
    blockStyles,
  };
}

export type DocumentEditing = ReturnType<typeof useDocumentEditing>;
