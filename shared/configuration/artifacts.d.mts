import type { ExpectedTarget } from './backend.mjs';

export function backendConfigurationArtifacts(value: unknown, expected: ExpectedTarget): Readonly<{
  'backend.json': string;
  'desktop.env': string;
  'runner.env': string;
  'manifest.json': string;
}>;
