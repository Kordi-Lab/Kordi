import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import { readStoredThemeMode, resolveThemeMode, writeStoredThemeMode } from '@/app/themePreference';
import type { KordiUrlPreviewState } from '@/app/urlPreviewState';
import { readStoredComposerAttachments, writeStoredComposerAttachments } from '@/features/chat/composerAttachments';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import {
  readStoredComposerDrafts,
  writeStoredComposerDrafts,
  type ComposerDraftState,
} from '@/features/chat/composerDrafts';
import { contactRequests, projects, settingsSections } from '@/kordi-app/data';
import type { ComposerQuoteState, ComposerScope, ComposerSelectorType, ContactClass, EditFilePreview, ResolvedThemeMode, ThemeMode } from '@/kordi-app/types';

function getSystemThemeMode(): ResolvedThemeMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

type SettingsSectionId = (typeof settingsSections)[number]['id'];

function previewSettingsSectionId(previewState?: KordiUrlPreviewState): SettingsSectionId {
  const previewId = previewState?.activeSettingsSectionId;
  return settingsSections.some((section) => section.id === previewId) ? previewId as SettingsSectionId : 'general';
}

export function useKordiLocalUiState(previewState?: KordiUrlPreviewState) {
  const [activeContactGroup, setActiveContactGroup] = useState<ContactClass>(() => previewState?.activeContactGroup ?? 'my-agents');
  const [activeContactId, setActiveContactId] = useState(() => previewState?.activeContactId ?? 'my-core-agent');
  const [isContactRequestsOpen, setIsContactRequestsOpen] = useState(false);
  const [activeContactRequestId, setActiveContactRequestId] = useState(contactRequests[0]?.id ?? '');
  const [contactOverlayMode, setContactOverlayMode] = useState<'contact' | 'request' | null>(null);
  const [contactSearch, setContactSearch] = useState('');
  const [expandedContactGroups, setExpandedContactGroups] = useState<Record<ContactClass, boolean>>({
    'my-agents': true,
    'other-users-agents': false,
    'other-users': false,
  });

  const [activeAgentId, setActiveAgentId] = useState(() => previewState?.activeAgentId ?? '');
  const [isAgentOverlayOpen, setIsAgentOverlayOpen] = useState(false);

  const [projectWorkspaces, setProjectWorkspaces] = useState(projects);
  const [projectSearch, setProjectSearch] = useState('');
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({
    [projects[0]?.id ?? '']: true,
  });

  const [activeSettingsSectionId, setActiveSettingsSectionId] = useState<SettingsSectionId>(() => previewSettingsSectionId(previewState));
  const [activeSourcePreview, setActiveSourcePreview] = useState<EditFilePreview | null>(null);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => previewState?.themeMode ?? readStoredThemeMode());
  const setThemeMode: Dispatch<SetStateAction<ThemeMode>> = useCallback((nextThemeModeOrUpdater) => {
    setThemeModeState((currentThemeMode) => {
      const nextThemeMode = typeof nextThemeModeOrUpdater === 'function'
        ? nextThemeModeOrUpdater(currentThemeMode)
        : nextThemeModeOrUpdater;
      writeStoredThemeMode(nextThemeMode);
      return nextThemeMode;
    });
  }, []);
  const [systemThemeMode, setSystemThemeMode] = useState<ResolvedThemeMode>(() => getSystemThemeMode());
  const resolvedThemeMode: ResolvedThemeMode = resolveThemeMode(themeMode, systemThemeMode);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const updateSystemThemeMode = () => {
      setSystemThemeMode(mediaQuery.matches ? 'light' : 'dark');
    };

    updateSystemThemeMode();
    mediaQuery.addEventListener('change', updateSystemThemeMode);
    return () => mediaQuery.removeEventListener('change', updateSystemThemeMode);
  }, []);

  const [desktopSessionRenameDraft, setDesktopSessionRenameDraft] = useState('');
  const [isEditingDesktopSessionTitle, setIsEditingDesktopSessionTitle] = useState(false);

  const [composerSelections, setComposerSelections] = useState<Record<ComposerScope, { mode: string; model: string; thinking: string }>>({
    chat: { mode: 'Send as Me', model: 'GPT-5.4', thinking: 'xhigh' },
    project: { mode: 'Post update', model: 'GPT-5.4', thinking: 'high' },
  });
  const [composerDrafts, setComposerDrafts] = useState<ComposerDraftState>(
    () => readStoredComposerDrafts(),
  );

  useEffect(() => {
    const handle = setTimeout(() => {
      writeStoredComposerDrafts(composerDrafts);
    }, 300);
    return () => clearTimeout(handle);
  }, [composerDrafts]);

  const [openComposerSelector, setOpenComposerSelector] = useState<{ scope: ComposerScope; type: ComposerSelectorType } | null>(null);
  const [chatSlashMenuIndex, setChatSlashMenuIndex] = useState(0);
  const [chatQuoteBySessionId, setChatQuoteBySessionId] = useState<Record<string, ComposerQuoteState | null>>({});
  const [chatComposerAttachments, setChatComposerAttachments] = useState<AttachmentItem[]>(() => readStoredComposerAttachments());

  useEffect(() => {
    writeStoredComposerAttachments(chatComposerAttachments);
  }, [chatComposerAttachments]);

  const [chatSearch, setChatSearch] = useState('');

  return {
    contactsUi: {
      activeContactGroup,
      setActiveContactGroup,
      activeContactId,
      setActiveContactId,
      isContactRequestsOpen,
      setIsContactRequestsOpen,
      activeContactRequestId,
      setActiveContactRequestId,
      contactOverlayMode,
      setContactOverlayMode,
      contactSearch,
      setContactSearch,
      expandedContactGroups,
      setExpandedContactGroups,
    },
    agentsUi: {
      activeAgentId,
      setActiveAgentId,
      isAgentOverlayOpen,
      setIsAgentOverlayOpen,
    },
    projectsUi: {
      projectWorkspaces,
      setProjectWorkspaces,
      projectSearch,
      setProjectSearch,
      expandedProjectIds,
      setExpandedProjectIds,
    },
    settingsUi: {
      activeSettingsSectionId,
      setActiveSettingsSectionId,
      activeSourcePreview,
      setActiveSourcePreview,
      activeArtifactId,
      setActiveArtifactId,
      themeMode,
      resolvedThemeMode,
      setThemeMode,
    },
    sessionUi: {
      desktopSessionRenameDraft,
      setDesktopSessionRenameDraft,
      isEditingDesktopSessionTitle,
      setIsEditingDesktopSessionTitle,
    },
    composerUi: {
      composerSelections,
      setComposerSelections,
      composerDrafts,
      setComposerDrafts,
      openComposerSelector,
      setOpenComposerSelector,
      chatSlashMenuIndex,
      setChatSlashMenuIndex,
      chatQuoteBySessionId,
      setChatQuoteBySessionId,
      chatComposerAttachments,
      setChatComposerAttachments,
    },
    chatsUi: {
      chatSearch,
      setChatSearch,
    },
  };
}
