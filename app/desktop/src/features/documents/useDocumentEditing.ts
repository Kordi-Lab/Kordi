import { useCallback, useState } from 'react';

import { splitMarkdownBlocks } from './documentBlocks';

type DocumentTab = { name: string; source: string };

/** Replaces one block of a Markdown source by id; blocks keep their order and blank-line separation. */
export function replaceSourceBlock(source: string, blockId: string, next: string) {
  return splitMarkdownBlocks(source).map((block) => (block.id === blockId ? next : block.source)).join('\n\n');
}

/** Inserts a Markdown block after `afterBlockId`, or at the end. */
export function insertSourceBlock(source: string, afterBlockId: string | null, snippet: string) {
  const blocks = splitMarkdownBlocks(source).map((block) => ({ id: block.id, source: block.source }));
  const index = afterBlockId ? blocks.findIndex((block) => block.id === afterBlockId) : -1;
  const at = index >= 0 ? index + 1 : blocks.length;
  return [...blocks.slice(0, at).map((block) => block.source), snippet, ...blocks.slice(at).map((block) => block.source)].join('\n\n');
}

/**
 * Tabs and the local draft of a Mac-hosted file (tab 1), plus scratch tabs.
 * The draft of a local file is what **Upload to Kordi** sends.
 */
export function useDocumentEditing(initialSource: string) {
  const [baseSource, setBaseSource] = useState(initialSource);
  const [tabs, setTabs] = useState<DocumentTab[]>([{ name: 'Tab 1', source: initialSource }]);
  const [currentTab, setCurrentTab] = useState(0);
  const [showTabs, setShowTabs] = useState(false);

  if (baseSource !== initialSource) {
    setBaseSource(initialSource);
    setTabs((current) => [{ ...current[0], source: initialSource }, ...current.slice(1)]);
  }

  const updateCurrent = useCallback((update: (source: string) => string) => {
    setTabs((current) => current.map((tab, index) => (index === currentTab ? { ...tab, source: update(tab.source) } : tab)));
  }, [currentTab]);

  const newTab = useCallback(() => {
    setTabs((current) => [...current, { name: `Tab ${current.length + 1}`, source: '' }]);
    setCurrentTab(tabs.length);
  }, [tabs.length]);

  return {
    tabNames: tabs.map((tab) => tab.name),
    currentTab,
    currentSource: tabs[currentTab]?.source ?? '',
    draftSource: tabs[0]?.source ?? '',
    showTabs,
    setShowTabs,
    selectTab: setCurrentTab,
    newTab,
    replaceBlock: useCallback((blockId: string, next: string) => updateCurrent((source) => replaceSourceBlock(source, blockId, next)), [updateCurrent]),
    insertBlock: useCallback((afterBlockId: string | null, snippet: string) => updateCurrent((source) => insertSourceBlock(source, afterBlockId, snippet)), [updateCurrent]),
  };
}

export type DocumentEditing = ReturnType<typeof useDocumentEditing>;
