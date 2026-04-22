import type { DesktopArtifactPreview, DesktopAuthAttemptSnapshot, DesktopAuthState, DesktopBridgeInvite, DesktopBridgeState, DesktopChatProjectSource, DesktopChatState, DesktopChatTurnSnapshot, DesktopProjectSettings } from '@/kordi-app/types';

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

export async function fetchDesktopAuthState() {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<DesktopAuthState>('desktop_auth_state');
}

export async function saveDesktopApiKey(provider: string, key: string) {
  return invokeDesktop<DesktopAuthState>('desktop_save_api_key', { provider, key });
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

export async function sendDesktopBridgePresence(conversationId: string, kind: 'typing' | 'heartbeat') {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_send_presence', { conversationId, kind });
}

export async function pollDesktopBridgeMailbox() {
  return invokeDesktop<DesktopBridgeState>('desktop_bridge_poll_mailbox');
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

export async function createDesktopChatSession() {
  return invokeDesktop<DesktopChatState>('desktop_chat_new_session');
}

export async function updateDesktopChatSessionConfig(sessionId: string, model?: string, thinking?: string) {
  return invokeDesktop<DesktopChatState>('desktop_chat_update_session_config', { sessionId, model, thinking });
}

export async function renameDesktopChatSession(sessionId: string, name: string) {
  return invokeDesktop<DesktopChatState>('desktop_chat_rename_session', { sessionId, name });
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

export async function fetchDesktopChatArtifactPreview(path: string) {
  return invokeDesktop<DesktopArtifactPreview>('desktop_chat_artifact_preview', { path });
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
