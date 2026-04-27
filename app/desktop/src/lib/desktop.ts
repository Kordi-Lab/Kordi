import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionState,
  CreateCanonicalDelegatedExchangeRequest,
  DesktopArtifactDirectory,
  DesktopArtifactPreview,
  DesktopAuthAttemptSnapshot,
  DesktopAuthState,
  DesktopBridgeCreateOutreachRequest,
  DesktopBridgeInvite,
  DesktopBridgeState,
  DesktopChatProjectSource,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  DesktopProjectSettings,
  OpenCanonicalSessionRequest,
  UpdateCanonicalPresenceRequest,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';

function isNativeDesktopShell() {
  if (typeof window === 'undefined') return false;
  return typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

function extractDesktopErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const candidates = [record.message, record.error, record.cause]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
    if (candidates.length > 0) {
      return candidates[0];
    }
    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }
  return 'Desktop command failed';
}

async function invokeDesktop<T>(command: string, args?: Record<string, unknown>) {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(extractDesktopErrorMessage(error));
  }
}

export async function openDesktopExternalUrl(url: string) {
  if (isNativeDesktopShell()) {
    return invokeDesktop<string>('desktop_open_external_url', { url });
  }

  return window.open(url, '_blank', 'noopener,noreferrer');
}

export async function readDesktopWorkspaceTextFile(path: string) {
  return invokeDesktop<string>('desktop_read_workspace_text_file', { path });
}

export async function writeDesktopWorkspaceTextFile(path: string, contents: string) {
  return invokeDesktop<string>('desktop_write_workspace_text_file', { path, contents });
}

export async function fetchDesktopAuthState() {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<DesktopAuthState>('desktop_auth_state');
}

export async function saveDesktopApiKey(provider: string, key: string) {
  return invokeDesktop<DesktopAuthState>('desktop_save_api_key', { provider, key });
}

export type DesktopLocalModelCommandResult = {
  command: string;
  statusCode?: number | null;
  stdout: string;
  stderr: string;
};

export type DesktopLmStudioCommandResult = DesktopLocalModelCommandResult;

export type DesktopOllamaCommandResult = DesktopLocalModelCommandResult;

export type DesktopLmStudioCatalogVariant = {
  id: string;
  name: string;
  url: string;
  size?: string | null;
};

export type DesktopLmStudioInstalledModel = {
  id: string;
  name: string;
  size?: string | null;
  path?: string | null;
  architecture?: string | null;
};

export type DesktopLmStudioEnvironment = {
  appPath?: string | null;
  appVersion?: string | null;
  homePath?: string | null;
  binPath?: string | null;
  cliPath?: string | null;
  cliVersion?: string | null;
  cliSource?: string | null;
  cliInShellPath: boolean;
  shellConfigPaths: string[];
  notes: string[];
};

export type DesktopLmStudioServerStatus = {
  running: boolean;
  detail: string;
};

export type DesktopLmStudioCatalogModel = {
  id: string;
  name: string;
  url: string;
  sizes: string[];
  updated?: string | null;
  variants: DesktopLmStudioCatalogVariant[];
};

export type DesktopOllamaCatalogVariant = {
  id: string;
  name: string;
  url: string;
  size?: string | null;
  context?: string | null;
  input?: string | null;
};

export type DesktopOllamaCatalogModel = {
  id: string;
  name: string;
  url: string;
  description?: string | null;
  sizes: string[];
  pulls?: string | null;
  tags?: string | null;
  variants: DesktopOllamaCatalogVariant[];
};

export type DesktopOllamaInstalledModel = {
  id: string;
  name: string;
  size?: string | null;
  family?: string | null;
  parameterSize?: string | null;
  quantization?: string | null;
  modifiedAt?: string | null;
};

export type DesktopOllamaEnvironment = {
  appPath?: string | null;
  appVersion?: string | null;
  cliPath?: string | null;
  cliVersion?: string | null;
  cliSource?: string | null;
  notes: string[];
};

export type DesktopOllamaServerStatus = {
  running: boolean;
  detail: string;
  version?: string | null;
};

export async function setDesktopLocalProviderPort(provider: string, port: number, model?: string | null) {
  return invokeDesktop<DesktopAuthState>('desktop_set_local_provider_port', { provider, port, model });
}

export async function fetchLmStudioCatalogModelsDesktop() {
  return invokeDesktop<DesktopLmStudioCatalogModel[]>('desktop_lm_studio_catalog_models');
}

export async function fetchLmStudioEnvironmentDesktop() {
  return invokeDesktop<DesktopLmStudioEnvironment>('desktop_lm_studio_environment');
}

export async function fetchLmStudioLoadedModelIdsDesktop(baseUrl: string) {
  return invokeDesktop<string[]>('desktop_lm_studio_loaded_model_ids', { baseUrl });
}

export async function fetchLmStudioServerStatusDesktop() {
  return invokeDesktop<DesktopLmStudioServerStatus>('desktop_lm_studio_server_status');
}

export async function startLmStudioServerDesktop(port?: number | null) {
  return invokeDesktop<DesktopLmStudioCommandResult>('desktop_lm_studio_start_server', { port });
}

export async function stopLmStudioServerDesktop() {
  return invokeDesktop<DesktopLmStudioCommandResult>('desktop_lm_studio_stop_server');
}

export async function fetchLmStudioInstalledModelsDesktop() {
  return invokeDesktop<DesktopLmStudioInstalledModel[]>('desktop_lm_studio_installed_models');
}

export async function openLmStudioAppDesktop() {
  return invokeDesktop<DesktopLmStudioCommandResult>('desktop_lm_studio_open_app');
}

export async function repairLmStudioCliPathDesktop() {
  return invokeDesktop<DesktopLmStudioCommandResult>('desktop_lm_studio_repair_cli_path');
}

export async function installLmStudioDesktop() {
  return invokeDesktop<DesktopLmStudioCommandResult>('desktop_lm_studio_install');
}

export async function getLmStudioModelDesktop(model: string) {
  return invokeDesktop<DesktopLmStudioCommandResult>('desktop_lm_studio_get_model', { model });
}

export async function loadLmStudioModelDesktop(model: string) {
  return invokeDesktop<DesktopLmStudioCommandResult>('desktop_lm_studio_load_model', { model });
}

export async function stopLmStudioModelDesktop(model: string) {
  return invokeDesktop<DesktopLmStudioCommandResult>('desktop_lm_studio_stop_model', { model });
}

export async function fetchOllamaEnvironmentDesktop() {
  return invokeDesktop<DesktopOllamaEnvironment>('desktop_ollama_environment');
}

export async function fetchOllamaServerStatusDesktop(baseUrl: string) {
  return invokeDesktop<DesktopOllamaServerStatus>('desktop_ollama_server_status', { baseUrl });
}

export async function startOllamaServerDesktop(port?: number | null) {
  return invokeDesktop<DesktopOllamaCommandResult>('desktop_ollama_start_server', { port });
}

export async function openOllamaAppDesktop() {
  return invokeDesktop<DesktopOllamaCommandResult>('desktop_ollama_open_app');
}

export async function fetchOllamaCatalogModelsDesktop() {
  return invokeDesktop<DesktopOllamaCatalogModel[]>('desktop_ollama_catalog_models');
}

export async function fetchOllamaCatalogVariantsDesktop(model: string) {
  return invokeDesktop<DesktopOllamaCatalogVariant[]>('desktop_ollama_catalog_variants', { model });
}

export async function fetchOllamaInstalledModelsDesktop(baseUrl: string) {
  return invokeDesktop<DesktopOllamaInstalledModel[]>('desktop_ollama_installed_models', { baseUrl });
}

export async function fetchOllamaRunningModelIdsDesktop(baseUrl: string) {
  return invokeDesktop<string[]>('desktop_ollama_running_model_ids', { baseUrl });
}

export async function pullOllamaModelDesktop(baseUrl: string, model: string) {
  return invokeDesktop<DesktopOllamaCommandResult>('desktop_ollama_pull_model', { baseUrl, model });
}

export async function loadOllamaModelDesktop(baseUrl: string, model: string) {
  return invokeDesktop<DesktopOllamaCommandResult>('desktop_ollama_load_model', { baseUrl, model });
}

export async function stopOllamaModelDesktop(baseUrl: string, model: string) {
  return invokeDesktop<DesktopOllamaCommandResult>('desktop_ollama_stop_model', { baseUrl, model });
}

export async function deleteOllamaModelDesktop(baseUrl: string, model: string) {
  return invokeDesktop<DesktopOllamaCommandResult>('desktop_ollama_delete_model', { baseUrl, model });
}

export async function logoutDesktopProvider(provider: string) {
  return invokeDesktop<DesktopAuthState>('desktop_logout', { provider });
}

export async function removeDesktopAuthProfile(provider: string, profileId: string) {
  return invokeDesktop<DesktopAuthState>('desktop_remove_auth_profile', { provider, profileId });
}

export async function setDesktopActiveAuthProfile(provider: string, profileId: string) {
  return invokeDesktop<DesktopAuthState>('desktop_set_active_auth_profile', { provider, profileId });
}

export async function setDesktopActiveAuthChoice(provider: string, choice: string) {
  return invokeDesktop<DesktopAuthState>('desktop_set_active_auth_choice', { provider, choice });
}

export async function startDesktopOAuthLogin(provider: string, authority?: string) {
  return invokeDesktop<DesktopAuthAttemptSnapshot>('desktop_start_oauth_login', { provider, authority });
}

export async function fetchDesktopAuthAttemptState(attemptId: string) {
  return invokeDesktop<DesktopAuthAttemptSnapshot>('desktop_auth_attempt_state', { attemptId });
}

export async function submitDesktopAuthManualInput(attemptId: string, value: string) {
  return invokeDesktop<DesktopAuthAttemptSnapshot>('desktop_submit_auth_manual_input', { attemptId, value });
}

export async function cancelDesktopAuthAttempt(attemptId: string) {
  return invokeDesktop<DesktopAuthAttemptSnapshot>('desktop_cancel_auth_attempt', { attemptId });
}

export async function fetchDesktopChatState(activeSessionId?: string) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<DesktopChatState>('desktop_chat_state', { activeSessionId });
}

export async function fetchDesktopBridgeState() {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_state');
}

export async function openDesktopBridgeConfigFolder() {
  return invokeDesktop<string>('desktop_bridge_open_config_folder');
}

export async function revealDesktopBridgeStorageFile(kind: 'config' | 'conversations' | 'legacy') {
  return invokeDesktop<string>('desktop_bridge_reveal_storage_file', { kind });
}

export async function exportDesktopBridgeHostsConfig() {
  return invokeDesktop<string>('desktop_bridge_export_hosts_config');
}

export async function importDesktopBridgeHostsConfig(raw: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_import_hosts_config', { raw });
}

export async function saveDesktopBridgeHost(serverUrl: string, displayName?: string, ownerName?: string, hostId?: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_save_bridge_host', { hostId, serverUrl, displayName, ownerName });
}

export async function removeDesktopBridgeHost(hostId: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_remove_bridge_host', { hostId });
}

export async function setDesktopActiveBridgeHost(hostId: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_set_active_bridge_host', { hostId });
}

export async function setDesktopBridgeDiscoveryMode(hostId: string, discoveryMode: 'off' | 'contacts' | 'open') {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_set_discovery_mode', { hostId, discoveryMode });
}

export async function createDesktopBridgeAgent(hostId: string, label?: string, runtime?: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_create_agent', { hostId, label, runtime });
}

export async function activateDesktopBridgeAgent(hostId: string, agentId: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_activate_agent', { hostId, agentId });
}

export async function renameDesktopBridgeAgent(hostId: string, agentId: string, label: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_rename_agent', { hostId, agentId, label });
}

export async function setDesktopBridgeDefaultAgent(hostId: string, agentId: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_set_default_agent', { hostId, agentId });
}

export async function startDesktopBridgeLocalServer(port?: number, displayName?: string, ownerName?: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_start_local_server', { port, displayName, ownerName });
}

export async function stopDesktopBridgeLocalServer() {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_stop_local_server');
}

export async function createDesktopBridgeProject(hostId: string, slug: string, displayName?: string, description?: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_create_project', { hostId, slug, displayName, description });
}

export async function createDesktopBridgeInvite(hostId: string, projectId: string, maxUses?: number) {
  return invokeDesktop<DesktopBridgeInvite>('desktop_bridge_create_invite', { hostId, projectId, maxUses });
}

export async function joinDesktopBridgeProject(hostId: string, projectId: string, inviteToken: string, agentRole?: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_join_project', { hostId, projectId, inviteToken, agentRole });
}

export async function addDesktopBridgeContact(hostId: string, peerNodeId: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_add_contact', { hostId, peerNodeId });
}

export async function removeDesktopBridgeContact(hostId: string, peerNodeId: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_remove_contact', { hostId, peerNodeId });
}

export async function openDesktopBridgeConversation(
  hostId: string,
  peerNodeId: string,
  peerDisplayName?: string,
  peerOwnerName?: string,
  peerRuntime?: string,
  projectId?: string,
  projectName?: string,
) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_open_conversation', { hostId, peerNodeId, peerDisplayName, peerOwnerName, peerRuntime, projectId, projectName });
}

export async function markDesktopBridgeConversationRead(conversationId: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_mark_conversation_read', { conversationId });
}

export async function sendDesktopBridgeMessage(conversationId: string, text: string) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_send_message', { conversationId, text });
}

export async function createDesktopBridgeOutreach(request: DesktopBridgeCreateOutreachRequest) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_create_outreach', { request });
}

export async function cancelDesktopBridgeOutreach(conversationId: string, requestId?: string | null) {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_cancel_outreach', { conversationId, requestId });
}

export async function sendDesktopBridgePresence(conversationId: string, kind: 'typing' | 'heartbeat') {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_send_presence', { conversationId, kind });
}

export async function pollDesktopBridgeMailbox() {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_poll_mailbox');
}

export async function fetchCanonicalSessionState() {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<CanonicalSessionState>('desktop_canonical_session_state');
}

export async function upsertCanonicalIdentity(request: UpsertCanonicalIdentityRequest) {
  return invokeDesktop<CanonicalSessionState>('desktop_canonical_upsert_identity', { request });
}

export async function openOrCreateCanonicalSession(request: OpenCanonicalSessionRequest) {
  return invokeDesktop<CanonicalSessionState>('desktop_canonical_open_or_create_session', { request });
}

export async function appendCanonicalMessage(request: AppendCanonicalMessageRequest) {
  return invokeDesktop<CanonicalSessionState>('desktop_canonical_append_message', { request });
}

export async function appendCanonicalMessageFast(request: AppendCanonicalMessageRequest) {
  return invokeDesktop<string>('desktop_canonical_append_message_fast', { request });
}

export async function createCanonicalDelegatedExchange(request: CreateCanonicalDelegatedExchangeRequest) {
  return invokeDesktop<CanonicalSessionState>('desktop_canonical_create_delegated_exchange', { request });
}

export async function updateCanonicalPresence(request: UpdateCanonicalPresenceRequest) {
  return invokeDesktop<CanonicalSessionState>('desktop_canonical_update_presence', { request });
}

export async function fetchDesktopProjectSettings(projectRoot?: string) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<DesktopProjectSettings>('desktop_project_settings', { projectRoot });
}

export async function saveDesktopProjectSettings(
  name: string,
  context: string,
  systemPrompt: string,
  sharedSources: DesktopChatProjectSource[],
  projectRoot?: string,
) {
  return invokeDesktop<DesktopProjectSettings>('desktop_save_project_settings', {
    projectRoot,
    name,
    context,
    systemPrompt,
    sharedSources,
  });
}

export async function createDesktopProjectFromFolder(folderPath: string, name?: string) {
  return invokeDesktop<DesktopProjectSettings>('desktop_project_create_from_folder', { folderPath, name });
}

export async function createDesktopProject(name: string, parentDir?: string) {
  return invokeDesktop<DesktopProjectSettings>('desktop_project_create_new', { name, parentDir });
}

export async function createDesktopChatSession() {
  return invokeDesktop<DesktopChatState>('desktop_chat_new_session');
}

export async function createDesktopProjectSession(projectRoot: string, title?: string) {
  return invokeDesktop<DesktopChatState>('desktop_chat_new_project_session', { projectRoot, title });
}

export async function prepareDesktopChatDraftSession() {
  return invokeDesktop<void>('desktop_chat_prepare_draft_session');
}

export async function updateDesktopChatSessionConfig(sessionId: string, model?: string, thinking?: string) {
  return invokeDesktop<DesktopChatState>('desktop_chat_update_session_config', { sessionId, model, thinking });
}

export async function renameDesktopChatSession(sessionId: string, name: string) {
  return invokeDesktop<DesktopChatState>('desktop_chat_rename_session', { sessionId, name });
}

export async function archiveDesktopChatSession(sessionId: string, activeSessionId?: string) {
  return invokeDesktop<DesktopChatState>('desktop_chat_archive_session', { sessionId, activeSessionId });
}

export async function deleteDesktopChatSessionForever(sessionId: string, activeSessionId?: string) {
  return invokeDesktop<DesktopChatState>('desktop_chat_delete_session_forever', { sessionId, activeSessionId });
}

export async function moveDesktopChatSessionToProject(sessionId: string, projectRoot: string) {
  return invokeDesktop<DesktopChatState>('desktop_chat_move_session_to_project', { sessionId, projectRoot });
}

export async function sendDesktopChatMessage(sessionId: string, text: string) {
  return invokeDesktop<DesktopChatState>('desktop_chat_send_message', { sessionId, text });
}

export async function storeDesktopChatAttachment(name: string, data: number[]) {
  return invokeDesktop<string>('desktop_chat_store_attachment', { name, data });
}

export async function startDesktopChatMessage(sessionId: string, text: string, attachmentPaths: string[] = []) {
  return invokeDesktop<DesktopChatTurnSnapshot>('desktop_chat_start_message', { sessionId, text, attachmentPaths });
}

export async function runDesktopChatSkillCommand(sessionId: string, text: string) {
  return invokeDesktop<string>('desktop_chat_run_skill_command', { sessionId, text });
}

export async function cancelDesktopChatTurn(turnId: string) {
  return invokeDesktop<DesktopChatTurnSnapshot>('desktop_chat_cancel_turn', { turnId });
}

export async function fetchDesktopChatTurnState(turnId: string) {
  return invokeDesktop<DesktopChatTurnSnapshot>('desktop_chat_turn_state', { turnId });
}

export async function fetchDesktopChatArtifactPreview(path: string, baseRoot?: string | null) {
  return invokeDesktop<DesktopArtifactPreview>('desktop_chat_artifact_preview', { path, baseRoot });
}

export async function fetchDesktopChatArtifactDirectory(path?: string | null, baseRoot?: string | null) {
  return invokeDesktop<DesktopArtifactDirectory>('desktop_chat_artifact_directory', { path, baseRoot });
}

export type OpenDesktopAuthPopupOptions = {
  authority?: string;
  requireAuthority?: boolean;
};

export async function openDesktopAuthPopup(
  provider: string,
  mode: 'oauth' | 'api-key',
  title?: string,
  options: OpenDesktopAuthPopupOptions = {},
) {
  const params = new URLSearchParams({
    authPopup: '1',
    provider,
    mode,
  });

  if (options.authority) params.set('authority', options.authority);
  if (options.requireAuthority) params.set('requireAuthority', '1');

  const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;

  if (isNativeDesktopShell()) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const label = 'auth-popup';
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.close();
    }

    const popup = new WebviewWindow(label, {
      url,
      title: title ?? 'Kordi Authentication',
      width: 560,
      height: mode === 'oauth' ? 760 : 680,
      center: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      focus: true,
    });

    return await new Promise<typeof popup>((resolve, reject) => {
      void popup.once('tauri://created', () => resolve(popup));
      void popup.once('tauri://error', (event) => {
        const message =
          typeof event.payload === 'string' && event.payload.trim().length > 0
            ? event.payload
            : 'Unable to create authentication window';
        reject(new Error(message));
      });
    });
  }

  return window.open(
    url,
    `kordi-auth-${provider}-${mode}`,
    'popup=yes,width=560,height=760,resizable=no,scrollbars=yes',
  );
}
