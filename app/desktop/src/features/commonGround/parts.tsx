import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { cn } from '@/lib/utils';
import { topicTone } from './format';
import type { CgPerson } from './types';

type AvatarPerson = Pick<CgPerson, 'accountId' | 'name' | 'avatarUrl'>;

export function CgAvatar({ person, size, ring = false, isSelf = false }: { person: AvatarPerson; size: number; ring?: boolean; isSelf?: boolean }) {
  return (
    <span className={cn('cg-avatar', ring && 'is-ring')} style={{ width: size, height: size }}>
      <IdentityAvatar
        kind="human"
        seed={person.accountId}
        isSelf={isSelf}
        name={person.name}
        imageUrl={person.avatarUrl}
        cornerRadius="50%"
        className="h-full w-full"
      />
    </span>
  );
}

/** Up to nine people in a circle, like a group avatar. */
export function CgAvatarGrid({ people, size }: { people: AvatarPerson[]; size: number }) {
  const shown = people.slice(0, 9);
  const columns = shown.length <= 1 ? 1 : shown.length <= 4 ? 2 : 3;
  const gap = columns === 1 ? 0 : 2;
  const tile = (size - gap * (columns - 1)) / columns;
  return (
    <span
      className="cg-avatar-grid"
      style={{ width: size, height: size, gap, gridTemplateColumns: `repeat(${columns}, ${tile}px)`, gridAutoRows: `${tile}px` }}
      aria-hidden="true"
    >
      {shown.map((person) => <CgAvatar key={person.accountId} person={person} size={tile} />)}
    </span>
  );
}

export function CgBack({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="cg-back" onClick={onBack}>
      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      Back
    </button>
  );
}

export function CgHero({ avatar, title, line, children }: { avatar: ReactNode; title: string; line?: ReactNode; children?: ReactNode }) {
  return (
    <div className="cg-hero">
      {avatar}
      <h1>{title}</h1>
      {line ? <div className="cg-hero-line">{line}</div> : null}
      {children}
    </div>
  );
}

export function CgSection({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('cg-section', className)}>
      {title ? <h2 className="cg-section-title">{title}</h2> : null}
      {children}
    </section>
  );
}

export function CgGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('cg-group', className)}>{children}</div>;
}

export function CgRow({ lead, title, sub, trailing, onClick, label }: {
  lead?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  label?: string;
}) {
  const body = (
    <>
      {lead}
      <span className="cg-row-text">
        <span className="cg-row-title">{title}</span>
        {sub ? <span className="cg-row-sub">{sub}</span> : null}
      </span>
      {trailing}
    </>
  );
  return onClick
    ? <button type="button" className="cg-row is-button" onClick={onClick} aria-label={label}>{body}</button>
    : <div className="cg-row">{body}</div>;
}

export function CgButton({ children, onClick, disabled, quiet = false, danger = false, type = 'button', label }: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  quiet?: boolean;
  danger?: boolean;
  type?: 'button' | 'submit';
  label?: string;
}) {
  return (
    <button type={type} className={cn('cg-button', quiet && 'is-quiet', danger && 'is-danger')} onClick={onClick} disabled={disabled} aria-label={label}>
      {children}
    </button>
  );
}

export function CgPrimary({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="cg-primary" onClick={onClick} disabled={disabled}>{children}</button>;
}

export function CgSegmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="cg-seg" role="tablist" aria-label={label}>
      {options.map(([key, text]) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} className={cn(value === key && 'is-on')} onClick={() => onChange(key)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** The Kordi mark and one line, while the agent works. */
export function CgProgress({ line }: { line: string }) {
  return (
    <div className="cg-progress" role="status">
      <span className="cg-mark" aria-hidden="true"><i /><i /><i /></span>
      <span>{line}</span>
    </div>
  );
}

/** A rounded icon tile for a row, tinted with a `tone-*` colour. */
export function CgIcon({ children, tone = 'accent' }: { children: ReactNode; tone?: string }) {
  return <span className={cn('cg-icon', `tone-${tone}`)} aria-hidden="true">{children}</span>;
}

export function CgNotice({ text }: { text: string | null }) {
  return text ? <div className="cg-notice" role="alert">{text}</div> : null;
}

export function CgScore({ score }: { score: number | null | undefined }) {
  return typeof score === 'number' ? <span className="cg-trail">{score}%</span> : null;
}

export function CgTag({ topic, muted = false, onRemove, small = false }: { topic: string; muted?: boolean; onRemove?: () => void; small?: boolean }) {
  return (
    <span className={cn('cg-tag', `tone-${topicTone(topic)}`, muted && 'is-muted', small && 'is-small')}>
      <i aria-hidden="true" />
      <span className="cg-tag-text" title={topic}>{topic}</span>
      {onRemove ? <button type="button" className="cg-tag-x" onClick={onRemove} aria-label={`Remove ${topic}`}>×</button> : null}
    </span>
  );
}

export function CgTopicDot({ topic }: { topic: string }) {
  return <span className={cn('cg-topic-dot', `tone-${topicTone(topic)}`)} aria-hidden="true"><i /></span>;
}
