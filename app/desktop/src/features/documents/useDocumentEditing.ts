import { useCallback, useState } from 'react';

type DocumentTab = { name: string; source: string };

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
    updateCurrentSource: updateCurrent,
  };
}

export type DocumentEditing = ReturnType<typeof useDocumentEditing>;
