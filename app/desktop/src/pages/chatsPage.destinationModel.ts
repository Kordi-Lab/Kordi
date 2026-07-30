import type { ComponentType } from 'react';
import {
  CheckCircle2,
  FolderOpen,
  Info,
  MessageSquare,
} from 'lucide-react';

import type { DetailTab } from '@/kordi-app/types';

export type ChatDestination = 'messages' | 'info' | 'artifacts' | 'tasks';
export type ChatDetailDestination = Exclude<ChatDestination, 'messages'>;

export const CHAT_DESTINATIONS: ReadonlyArray<{
  id: ChatDestination;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { id: 'messages', label: 'Messages', icon: MessageSquare },
  { id: 'info', label: 'Info', icon: Info },
  { id: 'artifacts', label: 'Artifacts', icon: FolderOpen },
  { id: 'tasks', label: 'Tasks', icon: CheckCircle2 },
];

export const CHAT_DETAIL_TABS: ReadonlyArray<{
  id: DetailTab;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = CHAT_DESTINATIONS
  .filter(
    (
      destination,
    ): destination is (typeof CHAT_DESTINATIONS)[number] & {
      id: ChatDetailDestination;
    } => destination.id !== 'messages',
  )
  .map(({ id, label, icon }) => ({ id, label, icon }));

export function detailDestinationFromTab(
  tab: DetailTab,
): ChatDetailDestination {
  return tab === 'artifacts' || tab === 'tasks' ? tab : 'info';
}
