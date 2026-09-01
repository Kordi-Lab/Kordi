import { ChevronDown } from 'lucide-react';

export function TranscriptLatestButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  const displayCount = count > 99 ? '99+' : count;
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-4 right-8 z-20 grid h-11 w-11 place-items-center rounded-full text-[color:var(--utility-foreground)] outline-none transition-transform duration-200 ease-out hover:scale-105 focus-visible:ring-2 focus-visible:ring-[color:var(--app-chat-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--app-main-bg)] active:scale-95"
      aria-label={count > 0
        ? `Go to latest message, ${count} new message${count === 1 ? '' : 's'}`
        : 'Go to latest message'}
      data-transcript-latest-button="true"
    >
      <span className="grid h-[38px] w-[38px] place-items-center rounded-full border border-[color:var(--app-divider)] bg-[color:var(--app-main-raised-bg)] shadow-[var(--app-shadow-soft)] backdrop-blur-xl">
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </span>
      {count > 0 ? (
        <span
          className="absolute -right-0.5 -top-0.5 grid min-h-5 min-w-5 place-items-center rounded-full bg-[color:var(--app-chat-accent)] px-1 text-[10px] font-bold leading-none text-[color:var(--app-chat-accent-text)]"
          data-new-message-count={count}
          aria-hidden="true"
        >
          {displayCount}
        </span>
      ) : null}
    </button>
  );
}
