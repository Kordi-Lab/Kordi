import type { BackendConfiguration, ExpectedTarget } from './backend.mjs';

export interface AgentPolicy {
  enabled: boolean;
  name: string;
  subtitle: string;
  ownerEmail: string;
  persona: string;
}
export interface DistributionConfiguration {
  schemaVersion: 1;
  routing: BackendConfiguration;
  clients: {
    displayName: string;
    callbackScheme: string;
    desktopIdentifier: string;
    iosIdentifier: string;
    iosShareIdentifier: string;
    appGroup: string;
    credentialService: string;
    desktopIcon: string;
    desktopIcns: string;
    iosIcon: string;
    updates: { enabled: boolean; publicKey: string; artifactName: string };
  };
  services: {
    model: { provider: 'openai' | 'openai-compatible' | 'vertex-ai'; baseURL: string; model: string };
    systemAgent: AgentPolicy;
    supportAgent: AgentPolicy;
    runner: { concurrency: number; pollMilliseconds: number; sandboxBackend: 'k8s' | 'fly' };
    connectorCallsPerHour: number;
  };
  resources: {
    provider: 'gcp' | 'external';
    cpuLimit: number;
    memoryMiB: number;
    sandboxCpuMillis: number;
    sandboxMemoryMiB: number;
    bindings: Record<'project' | 'region' | 'zone' | 'instance' | 'database' | 'objectStorage' | 'serviceIdentity', string>;
  };
  apple: {
    teamBinding: string;
    identityBinding: string;
    notaryProfileBinding: string;
    exportMethod: 'app-store-connect' | 'release-testing' | 'debugging';
  };
}
export type PublicClientConfiguration = Pick<DistributionConfiguration['routing'], 'edition' | 'environment'>
  & Omit<DistributionConfiguration['clients'], 'desktopIcon' | 'desktopIcns' | 'iosIcon'>
  & { backendOrigin: string };
export function validateDistributionConfiguration(value: unknown, expected: ExpectedTarget): DistributionConfiguration;
export function publicClientConfiguration(profile: DistributionConfiguration): PublicClientConfiguration;
export function publicDesktopConfiguration(profile: DistributionConfiguration): Pick<PublicClientConfiguration,
  'backendOrigin' | 'callbackScheme'>
  & { updates: Pick<PublicClientConfiguration['updates'], 'enabled' | 'artifactName'> };
