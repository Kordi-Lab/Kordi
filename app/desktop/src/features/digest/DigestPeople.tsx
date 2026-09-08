import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { MarkdownContent } from '@/kordi-app/components/markdown';
import type { DigestItem, DigestSource } from './types';

export function DigestPeople({ item, sources, accountId, onSource, showMessages = false }: {
  item: Pick<DigestItem, 'sourceIds' | 'ownerAccountId'>;
  sources: DigestSource[];
  accountId: string;
  onSource?: (ids: string[]) => void;
  showMessages?: boolean;
}) {
  const related = sources.filter(source => item.sourceIds.includes(source.id));
  const authorKey = (source: DigestSource) => `${source.senderAccountId}:${source.isAgent ? source.agentId ?? source.senderName : 'human'}`;
  const authors = [...new Map(related.map(source => [authorKey(source), source])).values()];
  const ownerSource = sources.find(source => source.senderAccountId === item.ownerAccountId && !source.isAgent)
    ?? sources.find(source => source.senderAccountId === item.ownerAccountId);
  const ownerName = (ownerSource?.isAgent ? ownerSource.agentOwnerName : ownerSource?.senderName) ?? 'Contact';
  const name = (id: string, fallback: string, agent = false) => !agent && id === accountId ? 'You' : fallback;
  return <div className="digest-attribution">
    <div className="digest-people" aria-label="Related people">
      {item.ownerAccountId && !authors.some(source => !source.isAgent && source.senderAccountId === item.ownerAccountId) && <span className="digest-person">
        <IdentityAvatar kind="human" seed={item.ownerAccountId} imageUrl={ownerSource?.senderAvatarUrl} isSelf={item.ownerAccountId === accountId} name={name(item.ownerAccountId, ownerName)} className="digest-person-avatar"/>
        <span>@{name(item.ownerAccountId, ownerName)}</span>
      </span>}
      {authors.map(source => {
        const label = name(source.senderAccountId, source.senderName, source.isAgent);
        const owner = source.senderAccountId === accountId ? 'You' : source.agentOwnerName ?? 'Unknown owner';
        const content = <><IdentityAvatar kind={source.isAgent ? 'agent' : 'human'} seed={source.isAgent ? source.agentId ?? source.senderAccountId : source.senderAccountId} imageUrl={source.isAgent ? source.agentAvatarUrl : source.senderAvatarUrl} isSelf={!source.isAgent && source.senderAccountId === accountId} name={label} className="digest-person-avatar"/><span>@{label}{source.isAgent && <span className="digest-agent-owner">Owner · {owner}</span>}</span></>;
        return onSource ? <button className="digest-person" key={authorKey(source)} aria-label={`Messages from ${label}${source.isAgent ? `, owned by ${owner}` : ''}`} onClick={() => onSource(related.filter(message => authorKey(message) === authorKey(source)).map(message => message.id))}>{content}</button> : <span className="digest-person" key={authorKey(source)}>{content}</span>;
      })}
    </div>
    {showMessages && related.length > 0 && <details className="digest-source-messages" open>
      <summary>Source messages · {related.length}</summary>
      {related.map(source => <article key={source.id}><p>@{name(source.senderAccountId, source.senderName, source.isAgent)} · {source.sessionTitle}</p><blockquote><MarkdownContent text={source.text} tone="inherit" className="whitespace-normal" copySurface="message" preserveLineBreaks /></blockquote></article>)}
    </details>}
  </div>;
}
