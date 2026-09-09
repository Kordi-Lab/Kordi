import { Square } from 'lucide-react';
import { useBackgroundSessionControl } from '@/features/chat/useBackgroundSessionControl';
import { useAgentSubsession } from '@/features/cloud/useAgentSubsession';

export function BackgroundSessionStopButton({ control, title }: {
  control: ReturnType<typeof useBackgroundSessionControl>;
  title: string;
}) {
  if (!control.canStop) return null;
  return <span className="inline-flex shrink-0 flex-col items-end gap-1">
    <button
      type="button"
      className="app-button-quiet inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-[color:var(--utility-foreground)] disabled:cursor-wait disabled:opacity-60"
      aria-label={`${control.stopping ? 'Stopping' : 'Stop'} background agent session: ${title}`}
      disabled={control.stopping}
      onClick={(event) => { event.stopPropagation(); void control.stop(); }}
    >
      <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
      {control.stopping ? 'Stopping…' : 'Stop'}
    </button>
    {control.error ? <span role="alert" className="max-w-48 text-[11px] text-rose-500">{control.error}</span> : null}
  </span>;
}

export function BackgroundSessionHeaderControl({ sessionId, title }: { sessionId: string; title: string }) {
  const { snapshot, accountId } = useAgentSubsession(sessionId);
  const control = useBackgroundSessionControl(sessionId, snapshot, accountId);
  return <BackgroundSessionStopButton control={control} title={title} />;
}
