import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { EditFilePreview } from '@/kordi-app/types';
import {
  detailDestinationFromTab,
  type ChatDestination,
  type ChatDetailDestination,
} from '@/pages/chatsPage.destinationModel';
import type { DetailTab } from '@/kordi-app/types';

type UseChatDestinationsInput = {
  main: {
    conversationId: string;
    activeDetailTab: DetailTab;
    isDetailPanelCollapsed: boolean;
    setActiveDetailTab: Dispatch<SetStateAction<DetailTab>>;
    setIsDetailPanelCollapsed: Dispatch<SetStateAction<boolean>>;
    onClearSourcePreview?: () => void;
  };
  companionConversationId: string | null;
};

type CompanionDestinationState = {
  conversationId: string;
  destination: ChatDestination;
  activeArtifactId: string | null;
  activeSourcePreview: EditFilePreview | null;
};

function initialCompanionState(
  conversationId: string,
): CompanionDestinationState {
  return {
    conversationId,
    destination: 'messages',
    activeArtifactId: null,
    activeSourcePreview: null,
  };
}

export function useChatDestinations({
  main,
  companionConversationId,
}: UseChatDestinationsInput) {
  const {
    conversationId,
    activeDetailTab,
    isDetailPanelCollapsed,
    setActiveDetailTab,
    setIsDetailPanelCollapsed,
    onClearSourcePreview,
  } = main;
  const companionKey = companionConversationId ?? '';
  const [companionState, setCompanionState] =
    useState<CompanionDestinationState>(
      () => initialCompanionState(companionKey),
    );
  const activeCompanionState = companionState.conversationId === companionKey
    ? companionState
    : initialCompanionState(companionKey);
  if (activeCompanionState !== companionState) {
    setCompanionState(activeCompanionState);
  }

  const mainDestination: ChatDestination = isDetailPanelCollapsed
    ? 'messages'
    : detailDestinationFromTab(activeDetailTab);
  const companionActiveDetailTab: ChatDetailDestination =
    activeCompanionState.destination === 'messages'
      ? 'info'
      : activeCompanionState.destination;

  const selectMain = useCallback((destination: ChatDestination) => {
    onClearSourcePreview?.();
    if (destination === 'messages') {
      setIsDetailPanelCollapsed(true);
      return;
    }
    setActiveDetailTab(destination);
    setIsDetailPanelCollapsed(false);
  }, [onClearSourcePreview, setActiveDetailTab, setIsDetailPanelCollapsed]);

  const setCompanionDestination: Dispatch<SetStateAction<ChatDestination>> =
    useCallback((next) => {
      setCompanionState((current) => {
        const baseline = current.conversationId === companionKey
          ? current
          : activeCompanionState;
        return {
          ...baseline,
          destination: typeof next === 'function'
            ? next(baseline.destination)
            : next,
        };
      });
    }, [activeCompanionState, companionKey]);
  const setCompanionActiveArtifactId: Dispatch<SetStateAction<string | null>> =
    useCallback((next) => {
      setCompanionState((current) => {
        const baseline = current.conversationId === companionKey
          ? current
          : activeCompanionState;
        return {
          ...baseline,
          activeArtifactId: typeof next === 'function'
            ? next(baseline.activeArtifactId)
            : next,
        };
      });
    }, [activeCompanionState, companionKey]);
  const setCompanionActiveSourcePreview: Dispatch<
    SetStateAction<EditFilePreview | null>
  > = useCallback((next) => {
    setCompanionState((current) => {
      const baseline = current.conversationId === companionKey
        ? current
        : activeCompanionState;
      return {
        ...baseline,
        activeSourcePreview: typeof next === 'function'
          ? next(baseline.activeSourcePreview)
          : next,
      };
    });
  }, [activeCompanionState, companionKey]);

  const showCompanionMessages = useCallback(() => {
    setCompanionState({
      conversationId: companionKey,
      destination: 'messages',
      activeArtifactId: activeCompanionState.activeArtifactId,
      activeSourcePreview: null,
    });
  }, [activeCompanionState.activeArtifactId, companionKey]);

  useLayoutEffect(() => {
    setIsDetailPanelCollapsed(true);
  }, [conversationId, setIsDetailPanelCollapsed]);

  useEffect(() => {
    if (!isDetailPanelCollapsed && activeDetailTab === 'context') {
      setActiveDetailTab('info');
    }
  }, [
    activeDetailTab,
    isDetailPanelCollapsed,
    setActiveDetailTab,
  ]);

  return {
    main: {
      value: mainDestination,
      select: selectMain,
    },
    companion: {
      value: activeCompanionState.destination,
      activeDetailTab: companionActiveDetailTab,
      setValue: setCompanionDestination,
      activeArtifactId: activeCompanionState.activeArtifactId,
      setActiveArtifactId: setCompanionActiveArtifactId,
      activeSourcePreview: activeCompanionState.activeSourcePreview,
      setActiveSourcePreview: setCompanionActiveSourcePreview,
      showMessages: showCompanionMessages,
    },
  };
}
