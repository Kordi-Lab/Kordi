import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AuthPage } from '@/kordi-app/auth/AuthPage';
import { SettingsValueControl } from '@/kordi-app/components';
import { EditableIdentityAvatar } from '@/kordi-app/components/EditableIdentityAvatar';
import { useLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import type { SettingsSection } from '@/kordi-app/data/settings';
import type {
  DesktopAuthState,
  DesktopProjectSettings,
  EditFilePreview,
  ThemeMode,
} from '@/kordi-app/types';
import { cn } from '@/lib/utils';

type SettingsPageProps = {
  settingsRailWidth: number;
  settingsContentRef: MutableRefObject<HTMLDivElement | null>;
  activeSettingsSectionId: SettingsSection['id'];
  setActiveSettingsSectionId: Dispatch<SetStateAction<SettingsSection['id']>>;
  settingsSections: SettingsSection[];
  activeSettingsSection: SettingsSection;
  authSettingsLayoutWidth: number;
  isNativeShell: boolean;
  localProfileAvatarSeed?: string | null;
  desktopAuthState: DesktopAuthState | null;
  isDesktopAuthLoading: boolean;
  desktopAuthError: string | null;
  activeLoginProviderId: string | null;
  selectAuthProvider: (providerId: string) => void;
  openLoginFlow: (provider: any, mode: 'oauth' | 'api-key', options?: { authority?: string; requireAuthority?: boolean }) => void;
  refreshDesktopAuth: () => Promise<void>;
  handleSelectAuthChoice: (providerId: string, choice: string) => Promise<void>;
  handleRemoveAuthProfile: (providerId: string, profileId: string) => Promise<void>;
  handleLogoutProvider: (providerId: string) => Promise<void>;
  projectSettingsDraft: DesktopProjectSettings | null;
  isDesktopProjectSaving: boolean;
  desktopProjectError: string | null;
  handleSaveProjectSettings: () => Promise<void>;
  updateProjectSettingsDraft: (apply: (current: DesktopProjectSettings) => DesktopProjectSettings) => void;
  themeMode: ThemeMode;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;
};

export function SettingsPage({
  settingsRailWidth,
  settingsContentRef,
  activeSettingsSectionId,
  setActiveSettingsSectionId,
  settingsSections,
  activeSettingsSection,
  authSettingsLayoutWidth,
  isNativeShell,
  localProfileAvatarSeed,
  desktopAuthState,
  isDesktopAuthLoading,
  desktopAuthError,
  activeLoginProviderId,
  selectAuthProvider,
  openLoginFlow,
  refreshDesktopAuth,
  handleSelectAuthChoice,
  handleRemoveAuthProfile,
  handleLogoutProvider,
  projectSettingsDraft,
  isDesktopProjectSaving,
  desktopProjectError,
  handleSaveProjectSettings,
  updateProjectSettingsDraft,
  themeMode,
  setThemeMode,
}: SettingsPageProps) {
  const currentLocalProfileAvatarSeed = useLocalProfileAvatarSeed();
  const sectionGuide =
    activeSettingsSection.id === 'auth'
      ? 'Start with one provider. Save more later only if you want fallbacks, different billing, or separate accounts.'
      : activeSettingsSection.id === 'projects'
        ? 'Put reusable team context here so you do not have to repeat it in every project session.'
        : activeSettingsSection.id === 'configuration'
          ? 'These defaults apply before per-chat or per-project overrides, so choose the safest common starting point.'
          : activeSettingsSection.id === 'appearance'
            ? 'If the shell feels too heavy or too dense, start here before changing anything else.'
            : null;

  return (
    <div className="app-settings-page h-full" style={{ WebkitAppRegion: 'no-drag' as const }}>
      <div
        className="app-main-panel grid h-full w-full gap-0 overflow-hidden text-white"
        style={{ gridTemplateColumns: `${settingsRailWidth}px minmax(0, 1fr)`, WebkitAppRegion: 'no-drag' as const }}
      >
        <div className="app-session-panel p-2.5 shadow-[inset_-1px_0_0_var(--app-divider)]">
          <div className="space-y-1">
            {settingsSections.map((section) => {
              const Icon = section.icon;
              const active = activeSettingsSectionId === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSettingsSectionId(section.id)}
                  className={cn(
                    'app-settings-nav-item flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition',
                    active ? 'app-list-item-active text-white' : 'app-list-item text-slate-300 hover:text-white',
                  )}
                >
                  <div className={cn('grid h-7 w-7 place-items-center rounded-[10px] border', active ? 'border-white/15 bg-white/[0.05]' : 'border-transparent bg-transparent')}>
                    <Icon className={cn('h-3.5 w-3.5', active ? 'text-white' : 'text-slate-400')} />
                  </div>
                  <div className="text-[13px] font-medium leading-5">{section.label}</div>
                </button>
              );
            })}
          </div>
        </div>
        <ScrollArea className="app-main-panel relative z-10 block h-full w-full min-w-0 justify-self-stretch overflow-x-hidden pointer-events-auto">
          <div
            ref={settingsContentRef}
            className="block w-full min-w-0 max-w-none px-6 py-5"
            style={{ width: '100%', maxWidth: '100%', WebkitAppRegion: 'no-drag' as const }}
          >
            {activeSettingsSection.id !== 'auth' && (
              <div className="mb-5 space-y-3">
                <div>
                  <div className="text-[18px] font-semibold tracking-tight text-white">{activeSettingsSection.title}</div>
                  <div className="mt-2 max-w-2xl text-[13px] leading-5 text-slate-400">{activeSettingsSection.description}</div>
                </div>
                {sectionGuide ? (
                  <div className="app-surface-muted rounded-[18px] px-4 py-3 text-[12px] leading-5 text-slate-300">
                    {sectionGuide}
                  </div>
                ) : null}
              </div>
            )}
            {activeSettingsSection.id === 'auth' ? (
              <AuthPage
                variant="settings"
                layoutWidth={authSettingsLayoutWidth}
                isNativeShell={isNativeShell}
                authState={desktopAuthState}
                isLoading={isDesktopAuthLoading}
                error={desktopAuthError}
                selectedProviderId={activeLoginProviderId}
                onSelectProvider={selectAuthProvider}
                onOpenLogin={openLoginFlow}
                onRefresh={() => {
                  void refreshDesktopAuth();
                }}
                onSelectAuthChoice={(providerId, choice) => {
                  void handleSelectAuthChoice(providerId, choice);
                }}
                onRemoveAuthProfile={(providerId, profileId) => {
                  void handleRemoveAuthProfile(providerId, profileId);
                }}
                onLogoutProvider={(providerId) => {
                  void handleLogoutProvider(providerId);
                }}
              />
            ) : activeSettingsSection.id === 'personalization' ? (
              <div className="space-y-3.5">
                <div className="app-surface-muted app-settings-surface overflow-hidden rounded-[22px] p-[18px] shadow-none">
                  <div className="mb-3.5 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[15px] font-medium text-white">Profile avatar</div>
                      <div className="mt-1 max-w-2xl text-[13px] leading-5 text-slate-400">
                        Upload a custom image for your local human identity. If you reset it, Kordi falls back to the deterministic pixel avatar.
                      </div>
                    </div>
                  </div>
                  <EditableIdentityAvatar
                    kind="human"
                    seed={localProfileAvatarSeed || currentLocalProfileAvatarSeed}
                    name="Local profile"
                    label="Local profile"
                    className="h-16 w-16 border border-white/10"
                  />
                </div>

                <div className="app-surface-muted app-settings-surface overflow-hidden rounded-[22px] shadow-none">
                  {activeSettingsSection.items.map((item, index) => (
                    <div
                      key={item.label}
                      className={cn(
                        'grid items-center gap-3 px-5 py-3.5 md:grid-cols-[minmax(0,1fr)_minmax(208px,280px)]',
                        index > 0 ? 'border-t border-white/10' : '',
                      )}
                    >
                      <div>
                        <div className="text-[13px] font-medium text-white">{item.label}</div>
                        <div className="mt-1 text-[12px] leading-5 text-slate-400">{item.hint}</div>
                      </div>
                      <div className="flex justify-end">
                        <SettingsValueControl item={item} themeMode={themeMode} onSelectThemeMode={setThemeMode} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : activeSettingsSection.id === 'projects' ? (
              <div className="space-y-3.5">
                <div className="app-surface-muted app-settings-surface app-settings-memory-card overflow-hidden rounded-[22px] p-[18px] shadow-none">
                  <div className="mb-3.5 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[15px] font-medium text-white">Project memory</div>
                      <div className="mt-1 text-[13px] leading-5 text-slate-400">
                        Save the context every session in this project should inherit: project background, standing instructions, and trusted reference sources.
                      </div>
                    </div>
                    <Button
                      className="rounded-[14px] text-[12px]"
                      onClick={() => {
                        void handleSaveProjectSettings();
                      }}
                      disabled={!projectSettingsDraft || isDesktopProjectSaving}
                    >
                      {isDesktopProjectSaving ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                      {isDesktopProjectSaving ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                  {desktopProjectError ? (
                    <div className="mb-4 rounded-[16px] border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-100">
                      {desktopProjectError}
                    </div>
                  ) : null}
                  {projectSettingsDraft ? (
                    <div className="space-y-3.5">
                      <div>
                        <div className="mb-1.5 text-[12px] font-medium text-white">Project name</div>
                        <input
                          value={projectSettingsDraft.name}
                          onChange={(event) => updateProjectSettingsDraft((current) => ({ ...current, name: event.target.value }))}
                          className="app-input-shell app-settings-field w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
                          placeholder="Project name"
                        />
                      </div>
                      <div>
                        <div className="mb-1.5 text-[12px] font-medium text-white">Project background</div>
                        <textarea
                          rows={4}
                          value={projectSettingsDraft.context}
                          onChange={(event) => updateProjectSettingsDraft((current) => ({ ...current, context: event.target.value }))}
                          className="app-input-shell app-settings-field min-h-[104px] w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
                          placeholder="What everyone working in this project should know"
                        />
                      </div>
                      <div>
                        <div className="mb-1.5 text-[12px] font-medium text-white">Standing instruction</div>
                        <textarea
                          rows={4}
                          value={projectSettingsDraft.systemPrompt}
                          onChange={(event) => updateProjectSettingsDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
                          className="app-input-shell app-settings-field min-h-[104px] w-full rounded-[14px] px-3 py-2 text-[13px] text-white outline-none"
                          placeholder="A standing instruction Kordi should keep applying in this project"
                        />
                      </div>
                      <div>
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[12px] font-medium text-white">Reference sources</div>
                            <div className="mt-1 text-[11px] leading-5 text-slate-400">These links, docs, and files stay visible across sessions in the same project.</div>
                          </div>
                          <Button
                            variant="secondary"
                            className="rounded-[14px] text-[12px]"
                            onClick={() => updateProjectSettingsDraft((current) => ({
                              ...current,
                              sharedSources: [...current.sharedSources, { label: '', path: '', detail: '' }],
                            }))}
                          >
                            <Plus className="mr-2 h-4 w-4" /> Add source
                          </Button>
                        </div>
                        <div className="app-settings-source-list">
                          {projectSettingsDraft.sharedSources.map((source, index) => (
                            <div key={`${source.label}-${index}`} className="app-settings-source-row py-2.5">
                              <div className="mb-2 flex items-center justify-between gap-2">
                                <div className="text-[12px] font-medium text-white">Source {index + 1}</div>
                                <button
                                  type="button"
                                  onClick={() => updateProjectSettingsDraft((current) => ({
                                    ...current,
                                    sharedSources: current.sharedSources.filter((_, currentIndex) => currentIndex !== index),
                                  }))}
                                  className="app-icon-button grid h-6.5 w-6.5 place-items-center rounded-[10px] text-slate-400 transition hover:text-white"
                                  aria-label={`Remove source ${index + 1}`}
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                              <div className="grid gap-2">
                                <input
                                  value={source.label}
                                  onChange={(event) => updateProjectSettingsDraft((current) => ({
                                    ...current,
                                    sharedSources: current.sharedSources.map((entry, currentIndex) => currentIndex === index ? { ...entry, label: event.target.value } : entry),
                                  }))}
                                  className="app-input-shell app-settings-field w-full rounded-[13px] px-3 py-2 text-[12px] text-white outline-none"
                                  placeholder="Label"
                                />
                                <input
                                  value={source.path ?? ''}
                                  onChange={(event) => updateProjectSettingsDraft((current) => ({
                                    ...current,
                                    sharedSources: current.sharedSources.map((entry, currentIndex) => currentIndex === index ? { ...entry, path: event.target.value } : entry),
                                  }))}
                                  className="app-input-shell app-settings-field w-full rounded-[13px] px-3 py-2 text-[12px] text-white outline-none"
                                  placeholder="Path or URL"
                                />
                                <textarea
                                  rows={2}
                                  value={source.detail ?? ''}
                                  onChange={(event) => updateProjectSettingsDraft((current) => ({
                                    ...current,
                                    sharedSources: current.sharedSources.map((entry, currentIndex) => currentIndex === index ? { ...entry, detail: event.target.value } : entry),
                                  }))}
                                  className="app-input-shell app-settings-field w-full rounded-[13px] px-3 py-2 text-[12px] text-white outline-none"
                                  placeholder="Why this source matters"
                                />
                              </div>
                            </div>
                          ))}
                          {projectSettingsDraft.sharedSources.length === 0 ? (
                            <div className="app-inspector-empty py-3">
                              No reference sources added yet.
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-[18px] border border-white/10 bg-white/[0.03] px-4 py-3 text-[13px] text-slate-400">
                      {isNativeShell ? 'Loading project settings…' : 'Project settings are available in the native desktop build.'}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="app-surface-muted app-settings-surface overflow-hidden rounded-[22px] shadow-none">
                {activeSettingsSection.items.map((item, index) => (
                  <div
                    key={item.label}
                    className={cn(
                      'grid items-center gap-3 px-5 py-3.5 md:grid-cols-[minmax(0,1fr)_minmax(208px,280px)]',
                      index > 0 ? 'border-t border-white/10' : '',
                    )}
                  >
                    <div>
                      <div className="text-[13px] font-medium text-white">{item.label}</div>
                      <div className="mt-1 text-[12px] leading-5 text-slate-400">{item.hint}</div>
                    </div>
                    <div className="flex justify-end">
                      <SettingsValueControl item={item} themeMode={themeMode} onSelectThemeMode={setThemeMode} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
