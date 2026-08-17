import { useEffect, useState } from 'react';

import type { ProviderMediaSelection } from './expressiveMediaLibrary';
import {
  clearPublicGifSearch,
  loadPublicGifs,
  normalizePublicGifQuery,
  type PublicGifResult,
} from './publicGifSearch';

type PublicGifGridProps = {
  query: string;
  isDisabled: boolean;
  onSelect: (selection: ProviderMediaSelection) => void;
};

type PublicGifRequestState = {
  query: string;
  results: PublicGifResult[];
  error: string | null;
};

export default function PublicGifGrid({ query, isDisabled, onSelect }: PublicGifGridProps) {
  const normalizedQuery = normalizePublicGifQuery(query);
  const [debouncedQuery, setDebouncedQuery] = useState(normalizedQuery);
  const [requestState, setRequestState] = useState<PublicGifRequestState | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(normalizedQuery), 350);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery]);

  useEffect(() => {
    let cancelled = false;
    void loadPublicGifs(debouncedQuery).then(
      (results) => {
        if (!cancelled) setRequestState({ query: debouncedQuery, results, error: null });
      },
      (reason: unknown) => {
        if (cancelled) return;
        setRequestState({
          query: debouncedQuery,
          results: [],
          error: reason instanceof Error ? reason.message : 'Unable to load public GIFs.',
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, retryToken]);

  const currentState = requestState?.query === debouncedQuery ? requestState : null;
  if (!currentState) {
    return <div className="app-expressive-picker-provider-state" role="status">Searching public GIFs…</div>;
  }

  if (currentState.error) {
    return (
      <div className="app-expressive-picker-provider-state" role="alert">
        <strong>Public GIFs could not be loaded.</strong>
        <span>{currentState.error}</span>
        <button
          type="button"
          onClick={() => {
            clearPublicGifSearch(debouncedQuery);
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
    <div className="app-expressive-picker-public-gifs">
      {currentState.results.length > 0 ? (
        <div className="app-expressive-picker-media-grid" role="list" aria-label="Public GIFs">
          {currentState.results.map((result) => (
            <button
              key={result.id}
              type="button"
              className="app-expressive-picker-media app-expressive-picker-public-media"
              disabled={isDisabled}
              onClick={() => onSelect({
                providerMediaId: `wikimedia:${result.id}`,
                mediaKind: 'gif',
                title: result.title,
                mediaUrl: result.mediaUrl,
              })}
              role="listitem"
              aria-label={`Send ${result.title}`}
              title={`Send ${result.title} · ${result.license}`}
            >
              <img src={result.previewUrl} alt="" loading="lazy" decoding="async" draggable={false} />
              <span>GIF</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="app-expressive-picker-provider-state" role="status">
          No public-domain GIFs match. Try another search.
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
