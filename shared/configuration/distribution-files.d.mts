import type { ExpectedTarget } from './backend.mjs';
import type { DistributionConfiguration } from './distribution.mjs';
export interface DistributionSelection {
  profile: DistributionConfiguration;
  assets: Record<'desktopIcon' | 'desktopIcns' | 'iosIcon', Uint8Array>;
}
export function loadDistributionConfiguration(file: string, expected: ExpectedTarget): DistributionSelection;
export function distributionFromEnvironment(env?: Record<string, string | undefined>, options?: { required?: boolean }): DistributionSelection | null;
export function serviceEnvironment(profile: DistributionConfiguration, service: 'server' | 'runner'): Record<string, string>;
export function writeDistributionArtifacts(selection: DistributionSelection, directory: string): string;
