import { CompanionDocumentTabs } from '@/features/documents/CompanionDocumentTabs';
import { useCompanionDocumentLabels } from '@/features/documents/useCompanionDocumentLabels';
import type { CompanionDocumentTabsModel } from '@/features/documents/useCompanionDocument';
import { documentReaderHostForConversation } from '@/features/documents/documentReaderHost';
import { CompanionDocumentPane } from './chatsPage.companionDocument';
import type { CompanionView } from './chatsPage.companionToolbar';
import type { useCompanionPaneTabs } from './useCompanionPaneTabs';
import type { useChatCompanionLayout } from './useChatCompanionLayout';

/** Share document titles and rename actions between mounted readers and the unified strip. */
export function useCompanionPaneContent({ documents, tabs, layout, host, onSelect }: {
  documents: CompanionDocumentTabsModel;
  tabs: ReturnType<typeof useCompanionPaneTabs>;
  layout: ReturnType<typeof useChatCompanionLayout>;
  host: Parameters<typeof documentReaderHostForConversation>[0];
  onSelect: (view: CompanionView) => void;
}) {
  const labels = useCompanionDocumentLabels();
  const close = (id: string) => { if (tabs.close(id)) layout.setFolded(true); };
  const toggle = () => {
    if (!layout.isVisible && !tabs.hasTabs) onSelect('chat');
    else layout.setFolded(layout.isVisible);
  };
  return {
    toggle,
    tabBar: <CompanionDocumentTabs documents={documents.documents} extraTabs={tabs.items} activeId={tabs.activeId}
      titles={labels.titles} renames={labels.renames} onActivate={tabs.activate} onCloseTab={close} onHide={() => layout.setFolded(true)} />,
    documentPane: documents.document ? <CompanionDocumentPane tabs={documents} showTabs={false} labels={labels}
      onClose={() => { if (documents.activeId) close(documents.activeId); }} host={documentReaderHostForConversation(host)} /> : null,
  };
}
