import type { DesktopChatContextWindowStatus } from '../types';

function formatCompactTokenCount(value: number) {
  if (value < 1_000) return `${value}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

function deriveComposerContextPercent(status?: DesktopChatContextWindowStatus | null) {
  if (!status) return null;
  if (typeof status.usedTokens === 'number' && status.contextWindow > 0) {
    return Math.max(0, Math.min(100, (status.usedTokens / status.contextWindow) * 100));
  }
  if (typeof status.usedPercent === 'number') {
    return Math.max(0, Math.min(100, status.usedPercent));
  }
  return null;
}

function deriveComposerContextUsedTokens(status?: DesktopChatContextWindowStatus | null) {
  if (!status) return null;
  if (typeof status.usedTokens === 'number') {
    return Math.max(0, status.usedTokens);
  }
  if (typeof status.usedPercent === 'number' && status.contextWindow > 0) {
    return Math.round((status.usedPercent / 100) * status.contextWindow);
  }
  return null;
}

export function ComposerRuntimeStatus({
  contextStatus,
  cacheText,
}: {
  contextStatus?: DesktopChatContextWindowStatus | null;
  cacheText?: string | null;
}) {
  const contextPercent = deriveComposerContextPercent(contextStatus);
  const usedTokens = deriveComposerContextUsedTokens(contextStatus);
  const totalTokens = contextStatus?.contextWindow ?? 0;
  const usedPercentLabel = contextPercent === null ? '—' : `${Math.round(contextPercent)}%`;
  const leftPercentLabel = contextPercent === null ? '—' : `${Math.max(0, Math.round(100 - contextPercent))}%`;
  const thresholdPercent = contextStatus?.compactionThresholdPercent ?? 90;
  const isCompressionReady = contextPercent !== null && contextPercent >= thresholdPercent;
  const isNearCompression = contextPercent !== null && contextPercent >= Math.max(0, thresholdPercent - 10);
  const ringColor = isCompressionReady
    ? 'color-mix(in oklab, #f97316 88%, var(--utility-foreground))'
    : isNearCompression
      ? 'color-mix(in oklab, #facc15 82%, var(--utility-foreground))'
      : 'color-mix(in oklab, var(--utility-muted-text) 92%, transparent)';
  const ringStyle = contextPercent === null
    ? { background: 'color-mix(in oklab, var(--utility-muted-text) 20%, transparent)' }
    : {
        background: `conic-gradient(${ringColor} ${contextPercent * 3.6}deg, color-mix(in oklab, var(--utility-muted-text) 20%, transparent) 0deg)`,
      };

  if (!contextStatus) {
    return <div className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />;
  }

  return (
    <div className="flex shrink-0 items-center overflow-visible text-[11px] text-[color:var(--utility-muted-text)]">
      <div className="group relative shrink-0">
        <button
          type="button"
          className="app-button-quiet inline-flex h-[18px] w-[18px] items-center justify-center rounded-full p-0"
          aria-label="Context window"
        >
          <span className="relative h-3.5 w-3.5 shrink-0 rounded-full" style={ringStyle}>
            <span className="absolute inset-[2.15px] rounded-full bg-[color:var(--app-main-bg)]" />
            <span className="absolute inset-0 rounded-full ring-1 ring-[color:var(--app-divider)]" />
          </span>
        </button>
        <div className="app-transient-surface pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-2 w-[264px] -translate-x-1/2 rounded-[16px] border px-4 py-3 text-[12px] leading-[1.38] opacity-0 transition duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
          <div className="font-medium text-[color:var(--utility-foreground)]">Context window:</div>
          <div className="mt-1 text-[11px] text-[color:var(--utility-foreground)]">{usedPercentLabel} used ({leftPercentLabel} left)</div>
          <div className="mt-1 text-[11px] text-[color:var(--utility-foreground)]">
            {usedTokens === null ? '—' : formatCompactTokenCount(usedTokens)} / {formatCompactTokenCount(totalTokens)} tokens used
          </div>
          {contextStatus.autoCompaction ? (
            <div className="mt-3 space-y-1 text-[11px] text-[color:var(--utility-foreground)]">
              <div>Auto-compresses before Kordi responds once usage reaches {thresholdPercent}%.</div>
              {isCompressionReady ? (
                <div className="rounded-md border border-orange-400/35 bg-orange-400/10 px-2 py-1 text-orange-200">
                  Send your next message to compress this conversation first.
                </div>
              ) : isNearCompression ? (
                <div className="rounded-md border border-yellow-400/30 bg-yellow-400/10 px-2 py-1 text-yellow-100">
                  Near the compression threshold. Kordi will compress before a future response.
                </div>
              ) : (
                <div className="text-[color:var(--utility-muted-text)]">Plenty of context remains.</div>
              )}
            </div>
          ) : (
            <div className="mt-3 text-[11px] text-[color:var(--utility-foreground)]">Automatic compaction is off</div>
          )}
          {cacheText ? (
            <div className="mt-3 border-t border-[color:var(--app-divider)] pt-3 text-[11px] leading-[1.45] text-[color:var(--utility-muted-text)]">
              <div className="mb-1 font-medium text-[color:var(--utility-foreground)]">Cache hit rate:</div>
              <div>{cacheText}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
