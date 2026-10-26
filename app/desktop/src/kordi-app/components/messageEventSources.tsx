import type { MessageEventSource } from '../types/message';
import { messageEventSourceProvider } from './messageEventSourceProviders';

/** The connector events an agent message is about, as chips under its bubble. */
export function MessageEventSourceChips({ sources }: { sources?: readonly MessageEventSource[] | null }) {
  if (!sources?.length) return null;
  return (
    <ul className="app-message-event-sources" aria-label="Sources">
      {sources.map((source) => {
        const { name, icon: Icon } = messageEventSourceProvider(source.provider);
        return (
          <li key={source.eventId} className="app-message-event-source" data-event-source-provider={source.provider} title={source.title ? `${name} · ${source.title}` : name}>
            <Icon className="app-message-event-source-icon" size={13} aria-hidden="true" />
            <span>{name}</span>
            {source.title ? <em>{source.title}</em> : null}
          </li>
        );
      })}
    </ul>
  );
}
