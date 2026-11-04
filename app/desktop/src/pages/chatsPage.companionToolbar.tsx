import { CalendarDays, PanelRightClose, PanelRightOpen, MessageSquare, Newspaper } from 'lucide-react';

export type CompanionView = 'chat' | 'digest' | 'calendar' | 'document';
export type CompanionToolbarProps = {
  view: CompanionView;
  isOpen: boolean;
  canOpenChat: boolean;
  hasChat: boolean;
  /** Keeps the fold control available while a document is open. */
  hasDocument?: boolean;
  hasTabs?: boolean;
  onToggle?: () => void;
  onSelect: (view: CompanionView) => void;
  onHide: () => void;
};

const views = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'digest', label: 'Digest', icon: Newspaper },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
] as const;

export function CompanionToolbar(props: CompanionToolbarProps) {
  return <div className="app-companion-toolbar" role="group" aria-label="Companion panel" data-kordi-window-drag="false">
    {views.map(({ id, label, icon: Icon }) => {
      const selected = props.isOpen && props.view === id;
      return <button
        key={id} type="button" aria-label={label}
        title={`Open ${label} tab`}
        aria-pressed={selected}
        disabled={id === 'chat' && !props.canOpenChat && !props.hasChat}
        onClick={event => {
          // A double click must not immediately undo the first toggle.
          if (event.detail > 1) return;
          props.onSelect(id);
        }}
      ><Icon aria-hidden="true" /></button>;
    })}
    {props.hasTabs || props.hasDocument || props.hasChat || props.isOpen ? <button type="button"
      aria-label={props.isOpen ? 'Fold pane' : 'Expand pane'} title={props.isOpen ? 'Fold pane' : 'Expand pane'}
      aria-expanded={props.isOpen} onClick={event => {
        if (event.detail > 1) return;
        if (props.onToggle) props.onToggle();
        else if (props.isOpen) props.onHide();
        else props.onSelect(props.view);
      }}>{props.isOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}</button> : null}
  </div>;
}
