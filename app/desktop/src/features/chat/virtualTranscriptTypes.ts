import type {
  CSSProperties,
  ReactNode,
  RefObject,
  UIEvent,
} from 'react';

import type { TranscriptSelectionProps } from './transcriptSelection';
import type { TranscriptDisclosureDirection } from './transcriptStableDisclosure';
import type { VirtualTranscriptNavigationRequest } from './useVirtualTranscriptNavigation';

export type VirtualTranscriptProps<Item> = TranscriptSelectionProps & {
  items: readonly Item[];
  sessionKey: string;
  getItemKey: (item: Item, index: number) => string | number;
  renderItem: (item: Item, index: number) => ReactNode;
  scrollRef?: RefObject<HTMLDivElement | null>;
  scrollClassName?: string;
  scrollStyle?: CSSProperties;
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  onTailChange?: (isAtTail: boolean) => void;
  navigationRequest?: VirtualTranscriptNavigationRequest | null;
  findNavigationIndex?: (item: Item, messageId: string, index: number) => boolean;
  onNavigationReady?: (messageId: string) => void;
  onNavigationHandled?: (request: VirtualTranscriptNavigationRequest) => void;
  hasOlder?: boolean;
  onLoadOlder?: () => Promise<void> | void;
  emptyState?: ReactNode;
  tail?: ReactNode;
  tailKey?: string | number;
  unreadCount?: number;
  animateLatestAppend?: boolean;
  estimateSize?: (item: Item, index: number) => number;
  gap?: number;
};

export type StableDisclosureAnchor = {
  sessionKey: string;
  initialScrollTop: number;
  targetScrollTop: number;
  initialHeight: number;
  availableAbove: number;
  availableBelow: number;
  opening: boolean;
  direction: TranscriptDisclosureDirection | null;
  forcedDirection: TranscriptDisclosureDirection | null;
};
