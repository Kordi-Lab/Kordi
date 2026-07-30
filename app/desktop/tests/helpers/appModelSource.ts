import { readFileSync } from 'node:fs';

const APP_MODEL_SOURCE_FILES = [
  '../../src/app/useKordiAppModel.ts',
  '../../src/app/useKordiAppFoundation.ts',
  '../../src/app/useKordiWorkspaceState.ts',
  '../../src/app/useKordiAppActions.ts',
  '../../src/app/useKordiAppRuntimeActions.ts',
  '../../src/app/useKordiAppMutationActions.ts',
  '../../src/app/useKordiAppShellComposition.ts',
] as const;

export function readKordiAppModelImplementationSource(): string {
  return APP_MODEL_SOURCE_FILES
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');
}
