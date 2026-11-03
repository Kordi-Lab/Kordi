export type Edition = 'app' | 'research';
export type DeploymentEnvironment = 'staging' | 'production';

export interface ExpectedTarget {
  readonly edition: Edition;
  readonly environment: DeploymentEnvironment;
  readonly backendOrigin: string;
}

export interface BackendConfiguration {
  readonly schemaVersion: 1;
  readonly edition: Edition;
  readonly environment: DeploymentEnvironment;
  readonly backend: Readonly<{ origin: string }>;
}

export const CONFIGURATION_SCHEMA_VERSION: 1;
export class ConfigurationError extends Error {}
export function validateBackendConfiguration(value: unknown, expected: ExpectedTarget): BackendConfiguration;
export function parseBackendConfiguration(text: string, expected: ExpectedTarget): BackendConfiguration;
export function legacyBackendEnvironment(value: unknown, expected: ExpectedTarget): Readonly<{
  VITE_KORDI_CLOUD_API_BASE: string;
  KORDI_CLOUD_API_BASE: string;
}>;
