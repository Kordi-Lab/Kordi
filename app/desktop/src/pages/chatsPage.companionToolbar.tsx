import { CalendarDays, FileText, MessageSquare, Newspaper } from 'lucide-react';

export type CompanionView = 'chat' | 'digest' | 'calendar' | 'document';
export type CompanionToolbarProps = {
  view: CompanionView;
  isOpen: boolean;
  canOpenChat: boolean;
  hasChat: boolean;
  /** The Document button shows only while a document is open for this conversation. */
  hasDocument?: boolean;
  onSelect: (view: CompanionView) => void;
  onHide: () => void;
};

const views = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'digest', label: 'Digest', icon: Newspaper },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'document', label: 'Document', icon: FileText },
] as const;

export function CompanionToolbar(props: CompanionToolbarProps) {
  return <div className="app-companion-toolbar" role="group" aria-label="Companion panel" data-kordi-window-drag="false">
    {views.map(({ id, label, icon: Icon }) => {
      if (id === 'document' && !props.hasDocument) return null;
      const selected = props.isOpen && props.view === id;
      return <button
        key={id} type="button" aria-label={label}
        title={`${selected ? 'Hide' : 'Open'} ${label} panel`}
        aria-pressed={selected}
        disabled={id === 'chat' && !props.canOpenChat && !props.hasChat}
        onClick={event => {
          // A double click must not immediately undo the first toggle.
          if (event.detail > 1) return;
          if (selected) props.onHide();
          else props.onSelect(id);
        }}
      ><Icon aria-hidden="true" /></button>;
    })}
  </div>;
}
