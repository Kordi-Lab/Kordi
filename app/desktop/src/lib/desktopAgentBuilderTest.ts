import { invokeDesktop, type DesktopAgentBuilderStatus } from './desktop';

export async function testDesktopAgentBuilderDraft(draftId: string, expectedFingerprint: string, lease?: { runId: string; claimId: string }) {
  return invokeDesktop<DesktopAgentBuilderStatus>('desktop_agent_builder_test', { draftId, expectedFingerprint, ...lease });
}
