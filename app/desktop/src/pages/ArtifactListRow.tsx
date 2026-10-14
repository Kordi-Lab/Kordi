import { Braces, FileText, Globe2, type LucideIcon } from 'lucide-react';

import { documentShareApiForEnvironment } from '@/features/documents/documentShareApi';
import { documentDisplayName, useDocumentTitle, type DocumentTitleFetch } from '@/features/documents/documentTitles';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { ConversationParticipant, SessionArtifact } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

type FileBadge = { icon: LucideIcon; label: string; className: string };

function extensionOf(path: string) {
  const name = path.split('/').filter(Boolean).pop() ?? path;
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  return extension === 'markdown' ? 'md' : extension;
}

/** The colored file-type mark at the start of a row. */
function artifactFileBadge(artifact: Pick<SessionArtifact, 'kind' | 'path'>): FileBadge {
  const extension = extensionOf(artifact.path);
  if (extension === 'html' || extension === 'htm') return { icon: Globe2, label: 'HTML', className: 'bg-orange-500/15 text-orange-500' };
  if (extension === 'md' || extension === 'mdx') return { icon: FileText, label: 'Markdown', className: 'bg-sky-500/15 text-sky-500' };
  if (artifact.kind === 'code') return { icon: Braces, label: 'Code', className: 'bg-violet-500/15 text-violet-500' };
  return { icon: FileText, label: 'File', className: 'bg-slate-500/15 text-[color:var(--utility-muted-text)]' };
}

function isPerson(participant: ConversationParticipant) {
  return participant.kind !== 'agent';
}

function matchesAccount(participant: ConversationParticipant, accountId: string) {
  return participant.id === accountId || participant.humanId === accountId || participant.sourceIdentityId === accountId;
}

/** The creator first, then the other people of the conversation. */
function artifactPeople(artifact: Pick<SessionArtifact, 'createdByAccountId'>, participants: ConversationParticipant[]) {
  const people = participants.filter(isPerson);
  const accountId = artifact.createdByAccountId?.trim();
  const creator = accountId ? people.find((participant) => matchesAccount(participant, accountId)) ?? null : null;
  return { creator, others: creator ? people.filter((participant) => participant !== creator) : [] };
}

const fetchDocumentTitle: DocumentTitleFetch = (attachmentId) => documentShareApiForEnvironment().getDocument(attachmentId);

function PersonAvatar({ participant, className }: { participant: ConversationParticipant; className: string }) {
  const name = participant.publicName?.trim() || participant.name;
  return <IdentityAvatar kind="human" seed={participant.avatarKey ?? participant.humanId ?? participant.id} name={name} imageUrl={participant.profileImageUrl} className={className} />;
}

export function ArtifactListRow({ artifact, location, isActive, participants, onSelect, fetchTitle = fetchDocumentTitle }: {
  artifact: SessionArtifact;
  location: string;
  isActive: boolean;
  participants: ConversationParticipant[];
  onSelect: () => void;
  /** Asks the server for the title of a cloud document none of the readers reported yet. */
  fetchTitle?: DocumentTitleFetch;
}) {
  // A renamed cloud document shows its title; the file name stays in the tooltip.
  const title = useDocumentTitle(artifact.attachmentId, artifact.name, fetchTitle);
  const label = documentDisplayName(artifact.name, title);
  const badge = artifactFileBadge(artifact);
  const BadgeIcon = badge.icon;
  const { creator, others } = artifactPeople(artifact, participants);
  const creatorName = creator ? creator.publicName?.trim() || creator.name : null;
  // Inside a conversation the creator says more than "Shared in <group>".
  const meta = [location, creator ? null : artifact.summary, artifact.live ? 'Live' : artifact.timeLabel].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      data-artifact-file-row="true"
      aria-current={isActive ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'flex h-10 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left transition-colors',
        isActive ? 'bg-[color:var(--app-control-bg)]' : 'hover:bg-[color:var(--app-control-hover)]',
      )}
    >
      <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-md', badge.className)} title={badge.label}>
        <BadgeIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 shrink truncate text-[13px] font-medium leading-5 text-[color:var(--utility-foreground)]" title={label === artifact.name ? undefined : artifact.name}>{label}</span>
      {artifact.pinned ? <span className="shrink-0 rounded-md bg-amber-400/15 px-1.5 text-[10.5px] leading-4 text-amber-600">Pinned</span> : null}
      <span className="ml-auto flex min-w-0 shrink-[2] items-center gap-2 pl-3 text-[11.5px] leading-5 text-[color:var(--utility-muted-text)]">
        {creator && creatorName ? (
          <span className="flex min-w-0 items-center gap-1.5" data-artifact-creator="true" title={`Created by ${creatorName}`}>
            <PersonAvatar participant={creator} className="h-[18px] w-[18px] shrink-0" />
            <span className="truncate text-[color:var(--utility-foreground)]">{creatorName}</span>
          </span>
        ) : null}
        {others.length > 0 ? (
          <span className="flex shrink-0 items-center" data-artifact-participants="true" title={others.map((person) => person.publicName?.trim() || person.name).join(', ')}>
            {others.slice(0, 3).map((person, index) => (
              <PersonAvatar key={person.id} participant={person} className={cn('h-4 w-4 opacity-80 ring-2 ring-[color:var(--app-shell-bg,transparent)]', index > 0 && '-ml-1')} />
            ))}
            {others.length > 3 ? <span className="pl-1">+{others.length - 3}</span> : null}
          </span>
        ) : null}
        {meta ? <span className="truncate text-right">{meta}</span> : null}
      </span>
    </button>
  );
}
