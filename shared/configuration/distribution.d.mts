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
  authentication?: {
    loginPage: LoginPageConfiguration;
    admission: 'existing' | 'verified-domain' | 'approved-testers';
    verifiedDomains: string[];
    approvedEmailsBinding: string;
    oauthBindings: Record<'googleClientId' | 'googleClientSecret' | 'githubClientId' | 'githubClientSecret', string>;
  };
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
    runner: { concurrency: number; pollMilliseconds: number; sandboxBackend: 'k8s' | 'fly' | 'render' };
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
  & { backendOrigin: string; loginPage?: LoginPageConfiguration };
export function validateDistributionConfiguration(value: unknown, expected: ExpectedTarget): DistributionConfiguration;
export function publicClientConfiguration(profile: DistributionConfiguration): PublicClientConfiguration;
export function publicDesktopConfiguration(profile: DistributionConfiguration): Pick<PublicClientConfiguration,
  'backendOrigin' | 'callbackScheme'> & { loginPage?: LoginPageConfiguration }
  & { updates: Pick<PublicClientConfiguration['updates'], 'enabled' | 'artifactName'> };

export interface LoginPageConfiguration { title: string; subtitle: string; signupTitle: string; signupSubtitle: string }
