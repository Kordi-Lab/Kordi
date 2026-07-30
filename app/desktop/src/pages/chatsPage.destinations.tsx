import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { CHAT_DESTINATIONS } from '@/pages/chatsPage.destinationModel';
import type { ChatDestination } from '@/pages/chatsPage.destinationModel';

export function SessionDestinationTabs({
  scope,
  activeDestination,
  onSelect,
}: {
  scope: 'main' | 'companion';
  activeDestination: ChatDestination;
  onSelect: (destination: ChatDestination) => void;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTab = (index: number) => {
    const destinationCount = CHAT_DESTINATIONS.length;
    const normalizedIndex = (index + destinationCount) % destinationCount;
    onSelect(CHAT_DESTINATIONS[normalizedIndex].id);
    tabRefs.current[normalizedIndex]?.focus();
  };

  return (
    <nav
      className="app-chat-destination-tabs"
      aria-label={
        scope === 'main' ? 'Session destinations' : 'Ask Agent destinations'
      }
      data-chat-destination-tabs={scope}
      data-kordi-window-drag="false"
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="app-chat-destination-tab-list" role="tablist">
        {CHAT_DESTINATIONS.map((destination, index) => {
          const Icon = destination.icon;
          const active = destination.id === activeDestination;
          return (
            <button
              key={destination.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`chat-${scope}-${destination.id}-tab`}
              aria-controls={`chat-${scope}-${destination.id}-panel`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={cn(
                'app-chat-destination-tab',
                active && 'app-chat-destination-tab-active',
              )}
              data-chat-destination-tab={destination.id}
              onClick={() => onSelect(destination.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  focusTab(index + 1);
                } else if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  focusTab(index - 1);
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  focusTab(0);
                } else if (event.key === 'End') {
                  event.preventDefault();
                  focusTab(CHAT_DESTINATIONS.length - 1);
                }
              }}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{destination.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
