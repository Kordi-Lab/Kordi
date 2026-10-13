import type { CompanionDocument } from './companionDocument';

export const MAX_COMPANION_TABS = 12;

/** The documents open in one conversation's companion pane, in tab order. */
export type CompanionTabs = {
  documents: CompanionDocument[];
  activeId: string | null;
  /** Ids from least to most recently active. */
  recency: string[];
};

export const EMPTY_COMPANION_TABS: CompanionTabs = { documents: [], activeId: null, recency: [] };

function touch(recency: string[], id: string) {
  return [...recency.filter((entry) => entry !== id), id];
}

/** Activates the document's tab, adding it at the end when it is new. A full strip drops its least recently active tab. */
export function openCompanionTab(tabs: CompanionTabs, document: CompanionDocument): CompanionTabs {
  const id = document.artifact.id;
  if (tabs.documents.some((entry) => entry.artifact.id === id)) return activateCompanionTab(tabs, id);
  let { documents, recency } = tabs;
  if (documents.length >= MAX_COMPANION_TABS) {
    const evicted = recency[0] ?? documents[0].artifact.id;
    documents = documents.filter((entry) => entry.artifact.id !== evicted);
    recency = recency.filter((entry) => entry !== evicted);
  }
  return { documents: [...documents, document], activeId: id, recency: [...recency, id] };
}

export function activateCompanionTab(tabs: CompanionTabs, id: string): CompanionTabs {
  if (tabs.activeId === id || !tabs.documents.some((entry) => entry.artifact.id === id)) return tabs;
  return { ...tabs, activeId: id, recency: touch(tabs.recency, id) };
}

/** Closes a tab; closing the active one activates its right neighbor, else the left. */
export function closeCompanionTab(tabs: CompanionTabs, id: string): CompanionTabs {
  const index = tabs.documents.findIndex((entry) => entry.artifact.id === id);
  if (index < 0) return tabs;
  const documents = tabs.documents.filter((entry) => entry.artifact.id !== id);
  const recency = tabs.recency.filter((entry) => entry !== id);
  if (tabs.activeId !== id) return { documents, activeId: tabs.activeId, recency };
  const activeId = (tabs.documents[index + 1] ?? tabs.documents[index - 1])?.artifact.id ?? null;
  return { documents, activeId, recency: activeId ? touch(recency, activeId) : recency };
}

/** DOM ids that tie a tab to its panel. Artifact ids can hold spaces, which an id reference cannot. */
export function companionDocumentTabIds(artifactId: string) {
  const key = encodeURIComponent(artifactId);
  return { tab: `companion-document-tab-${key}`, panel: `companion-document-panel-${key}` };
}
