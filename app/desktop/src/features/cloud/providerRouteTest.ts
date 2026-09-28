import type { CloudProviderRouteTestInput, CloudProviderRouteTestResult } from './cloudAgentRuntimeTypes';
import { createCloudProviderAuthApi } from './providerAuthClient';
import { loadSession } from './session';

export async function testCloudProviderRoute(input: CloudProviderRouteTestInput): Promise<CloudProviderRouteTestResult> {
  const session = await loadSession();
  if (!session) throw new Error('Sign in to Kordi before testing this route.');
  return createCloudProviderAuthApi().testProviderRoute(session.token, input);
}
