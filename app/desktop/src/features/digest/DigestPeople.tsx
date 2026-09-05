import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { DigestItem, DigestSource } from './types';

export function DigestPeople({ item, sources, accountId, onSource, showMessages = false }: {
  item: Pick<DigestItem, 'sourceIds' | 'ownerAccountId'>;
  sources: DigestSource[];
  accountId: string;
  onSource?: (ids: string[]) => void;
  showMessages?: boolean;
}) {
  const related = sources.filter(source => item.sourceIds.includes(source.id));
  const authorKey = (source: DigestSource) => `${source.senderAccountId}:${source.isAgent ? source.senderName : 'human'}`;
  const authors = [...new Map(related.map(source => [authorKey(source), source])).values()];
  const name = (id: string, fallback: string, agent = false) => !agent && id === accountId ? 'You' : fallback;
  return <div className="digest-attribution">
    <div className="digest-people" aria-label="Related people">
      {item.ownerAccountId && !authors.some(source => !source.isAgent && source.senderAccountId === item.ownerAccountId) && <span className="digest-person">
        <IdentityAvatar kind="human" seed={item.ownerAccountId} isSelf={item.ownerAccountId === accountId} name={name(item.ownerAccountId, 'Contact')} className="digest-person-avatar"/>
        <span>@{name(item.ownerAccountId, sources.find(source => source.senderAccountId === item.ownerAccountId)?.senderName ?? 'Contact')}<small>Owner</small></span>
      </span>}
      {authors.map(source => {
        const label = name(source.senderAccountId, source.senderName, source.isAgent);
        const content = <><IdentityAvatar kind={source.isAgent ? 'agent' : 'human'} seed={source.senderAccountId} isSelf={!source.isAgent && source.senderAccountId === accountId} name={label} className="digest-person-avatar"/><span>@{label}<small>{!source.isAgent && source.senderAccountId === item.ownerAccountId ? 'Owner · Mentioned by' : 'Mentioned by'}</small></span></>;
        return onSource ? <button className="digest-person" key={authorKey(source)} aria-label={`Messages from ${label}`} onClick={() => onSource(related.filter(message => authorKey(message) === authorKey(source)).map(message => message.id))}>{content}</button> : <span className="digest-person" key={authorKey(source)}>{content}</span>;
      })}
    </div>
    {showMessages && related.length > 0 && <details className="digest-source-messages" open>
      <summary>Source messages · {related.length}</summary>
      {related.map(source => <article key={source.id}><p>@{name(source.senderAccountId, source.senderName, source.isAgent)} · {source.sessionTitle}</p><blockquote>{source.text}</blockquote></article>)}
    </details>}
  </div>;
}
