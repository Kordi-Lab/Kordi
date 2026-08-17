import { useEffect, useState } from 'react';

import type { ProviderMediaSelection } from './expressiveMediaLibrary';
import {
  clearPublicStickerSearch,
  loadPublicMemeTemplates,
  normalizePublicStickerQuery,
  type PublicMemeTemplate,
} from './publicMemeTemplates';

type PublicMemeGridProps = {
  query: string;
  isDisabled: boolean;
  onSelect: (selection: ProviderMediaSelection) => void;
};

export default function PublicMemeGrid({
  query,
  isDisabled,
  onSelect,
}: PublicMemeGridProps) {
  const normalizedQuery = normalizePublicStickerQuery(query);
  const [debouncedQuery, setDebouncedQuery] = useState(normalizedQuery);
  const [requestState, setRequestState] = useState<{
    query: string;
    results: PublicMemeTemplate[];
    error: string | null;
  } | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(normalizedQuery), 350);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery]);

  useEffect(() => {
    let cancelled = false;
    void loadPublicMemeTemplates(debouncedQuery).then(
      (results) => {
        if (!cancelled) setRequestState({ query: debouncedQuery, results, error: null });
      },
      (reason: unknown) => {
        if (cancelled) return;
        setRequestState({
          query: debouncedQuery,
          results: [],
          error: reason instanceof Error ? reason.message : 'Unable to load public stickers.',
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, retryToken]);

  const currentState = requestState?.query === debouncedQuery ? requestState : null;
  if (!currentState) {
    return <div className="app-expressive-picker-provider-state" role="status">Searching public stickers…</div>;
  }

  if (currentState.error) {
    return (
      <div className="app-expressive-picker-provider-state" role="alert">
        <strong>Public stickers could not be loaded.</strong>
        <span>{currentState.error}</span>
        <button
          type="button"
          onClick={() => {
            clearPublicStickerSearch(debouncedQuery);
            setRequestState(null);
            setRetryToken((value) => value + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="app-expressive-picker-public-memes">
      {currentState.results.length > 0 ? (
        <div className="app-expressive-picker-media-grid" role="list" aria-label="Public stickers">
          {currentState.results.map((template) => (
            <button
              key={template.id}
              type="button"
              className="app-expressive-picker-media app-expressive-picker-public-meme"
              disabled={isDisabled}
              onClick={() => onSelect({
                providerMediaId: `wikimedia-sticker:${template.id}`,
                mediaKind: 'sticker',
                title: template.name,
                mediaUrl: template.imageUrl,
              })}
              role="listitem"
              aria-label={`Send ${template.name}`}
              title={`Send ${template.name} · ${template.license}`}
            >
              <img src={template.previewUrl} alt="" loading="lazy" decoding="async" draggable={false} />
            </button>
          ))}
        </div>
      ) : (
        <div className="app-expressive-picker-provider-state" role="status">
          No public stickers match your search.
        </div>
      )}
      <a
        className="app-expressive-picker-provider-attribution"
        href="https://commons.wikimedia.org/"
        target="_blank"
        rel="noreferrer"
      >
        Public-domain and CC0 results from Wikimedia Commons
      </a>
    </div>
  );
}
