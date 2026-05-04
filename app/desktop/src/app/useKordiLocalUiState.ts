import { useEffect, useState } from 'react';

import { readStoredComposerAttachments, writeStoredComposerAttachments } from '@/features/chat/composerAttachments';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { contactRequests, projects, settingsSections } from '@/kordi-app/data';
import type { ChatSort, ComposerScope, ComposerSelectorType, ContactClass, EditFilePreview, ResolvedThemeMode, ThemeMode } from '@/kordi-app/types';

function getSystemThemeMode(): ResolvedThemeMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function useKordiLocalUiState() {
  const [activeContactGroup, setActiveContactGroup] = useState<ContactClass>('my-agents');
  const [activeContactId, setActiveContactId] = useState('my-core-agent');
  const [isContactRequestsOpen, setIsContactRequestsOpen] = useState(false);
  const [activeContactRequestId, setActiveContactRequestId] = useState(contactRequests[0]?.id ?? '');
  const [contactOverlayMode, setContactOverlayMode] = useState<'contact' | 'request' | null>(null);
  const [contactSearch, setContactSearch] = useState('');
  const [expandedContactGroups, setExpandedContactGroups] = useState<Record<ContactClass, boolean>>({
    'my-agents': true,
    'other-users-agents': false,
    'other-users': false,
  });

  const [activeAgentId, setActiveAgentId] = useState('');
  const [isAgentOverlayOpen, setIsAgentOverlayOpen] = useState(false);

  const [projectWorkspaces, setProjectWorkspaces] = useState(projects);
  const [projectSearch, setProjectSearch] = useState('');
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({
    [projects[0]?.id ?? '']: true,
  });

  const [activeSettingsSectionId, setActiveSettingsSectionId] = useState<(typeof settingsSections)[number]['id']>('general');
  const [activeSourcePreview, setActiveSourcePreview] = useState<EditFilePreview | null>(null);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark');
  const [systemThemeMode, setSystemThemeMode] = useState<ResolvedThemeMode>(() => getSystemThemeMode());
  const resolvedThemeMode: ResolvedThemeMode = themeMode === 'auto' ? systemThemeMode : themeMode;

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
  const [composerDrafts, setComposerDrafts] = useState<Record<ComposerScope, string>>({
    chat: '',
    project: '',
  });
  const [openComposerSelector, setOpenComposerSelector] = useState<{ scope: ComposerScope; type: ComposerSelectorType } | null>(null);
  const [chatSlashMenuIndex, setChatSlashMenuIndex] = useState(0);
  const [chatComposerAttachments, setChatComposerAttachments] = useState<AttachmentItem[]>(() => readStoredComposerAttachments());

  useEffect(() => {
    writeStoredComposerAttachments(chatComposerAttachments);
  }, [chatComposerAttachments]);

  const [chatSort, setChatSort] = useState<ChatSort>('latest');
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
      chatComposerAttachments,
      setChatComposerAttachments,
    },
    chatsUi: {
      chatSort,
      setChatSort,
      chatSearch,
      setChatSearch,
    },
  };
}
