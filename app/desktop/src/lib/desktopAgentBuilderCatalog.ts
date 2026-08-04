import {
  invokeDesktop,
  isNativeDesktopShell,
  type DesktopAgentBuilderOpenResult,
  type DesktopAgentBuilderSeed,
  type DesktopAgentBuilderStatus,
} from './desktop';

export type DesktopAgentBuilderSummary = {
  draftId: string;
  targetKey: string;
  sessionId: string;
  artifactKind: string;
  name: string;
  lifecycle: string;
  updatedAtMs: number;
  available: boolean;
};

export async function fetchDesktopAgentBuilderList() {
  if (!isNativeDesktopShell()) return [] as DesktopAgentBuilderSummary[];
  return invokeDesktop<DesktopAgentBuilderSummary[]>('desktop_agent_builder_list');
}

export async function resolveDesktopAgentBuilder(targetKey: string) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<DesktopAgentBuilderSummary | null>('desktop_agent_builder_resolve', { targetKey });
}

export async function openDesktopAgentBuilderSession(
  targetKey: string,
  sessionId: string,
  seed?: DesktopAgentBuilderSeed | null,
) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<DesktopAgentBuilderOpenResult>('desktop_agent_builder_open_session', {
    targetKey,
    sessionId,
    seed: seed ?? null,
  });
}

export async function recoverDesktopAgentBuilder(targetKey: string, seed: DesktopAgentBuilderSeed) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<DesktopAgentBuilderOpenResult>('desktop_agent_builder_recover', { targetKey, seed });
}

export async function retargetDesktopAgentBuilder(draftId: string, targetKey: string) {
  return invokeDesktop<DesktopAgentBuilderStatus>('desktop_agent_builder_retarget', { draftId, targetKey });
}
