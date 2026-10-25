import { invokeDesktop } from '@/lib/desktop';

import type { AgentInstructionFile, MemoryImporter } from './memoryImport';

/** Discovery and the import turn run in the native shell, with this Mac's provider. */
export const nativeMemoryImporter: MemoryImporter = {
  discover: () => invokeDesktop<AgentInstructionFile[]>('desktop_memory_import_discover'),
  extract: (file, existingMemories) => invokeDesktop<string>('desktop_memory_import_extract', {
    path: file.path,
    existingMemories,
  }),
};

const DAY = 86_400_000;

/** Two sample files and fixed replies, for previews; it reads nothing on this Mac. */
export function createPreviewMemoryImporter(options: { now?: () => number; latencyMs?: number } = {}): MemoryImporter {
  const now = options.now ?? Date.now;
  const latencyMs = options.latencyMs ?? 600;
  const files: AgentInstructionFile[] = [
    {
      path: '/sample/Projects/launch-site/AGENTS.md',
      root: '/sample/Projects/launch-site',
      projectName: 'launch-site',
      fileName: 'AGENTS.md',
      size: 4_300,
      modifiedAt: now() - 2 * DAY,
    },
    {
      path: '/sample/.claude/CLAUDE.md',
      root: null,
      projectName: 'Home',
      fileName: '.claude/CLAUDE.md',
      size: 1_200,
      modifiedAt: now() - 9 * DAY,
    },
  ];
  const replies: Record<string, unknown> = {
    [files[0].path]: { memories: [
      { text: 'Run the image size check before every site build.', category: 'hcp-custom:task_lessons', scope: 'project', file: files[0].path },
      { text: 'Use pnpm for every script in this repository.', category: 'hcp-custom:task_lessons', scope: 'project', file: files[0].path },
    ] },
    [files[1].path]: { memories: [] },
  };
  const wait = () => new Promise<void>((resolve) => { setTimeout(resolve, latencyMs); });
  return {
    discover() {
      return Promise.resolve(files.map((file) => ({ ...file })));
    },
    async extract(file) {
      await wait();
      return JSON.stringify(replies[file.path] ?? { memories: [] });
    },
  };
}
