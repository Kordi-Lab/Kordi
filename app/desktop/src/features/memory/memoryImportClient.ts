import { useEffect } from 'react';

import { digestRunRoute } from '@/features/digest/digestMacRuns';
import { invokeDesktop, type DesktopChatMessageRoute } from '@/lib/desktop';

import type { AgentInstructionFile, MemoryImporter } from './memoryImport';

/** Each provider's fast model, as the server's digest `FAST_MODELS`. */
const FAST_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5.6-luna',
  'openai-codex': 'gpt-5.6-luna',
  google: 'gemini-2.5-flash',
  'google-gemini': 'gemini-2.5-flash',
};

/**
 * The route an import runs with, as a digest run on this Mac: the chat route's provider, account
 * and model at low thinking, with the provider's fast model as the fallback.
 */
export function memoryImportRoute(route: DesktopChatMessageRoute | null | undefined) {
  if (!route?.model?.trim()) return { route: null, fallbackModel: null };
  return digestRunRoute(route, { model: route.model, provider: route.authProvider, thinking: 'low', fastModels: FAST_MODELS });
}

let importRoute: DesktopChatMessageRoute | null = null;

/** Keeps the route `nativeMemoryImporter` runs with on this Mac's chat route. */
export function useMemoryImportRoute(route: DesktopChatMessageRoute | null) {
  useEffect(() => { importRoute = route; }, [route]);
}

/** Discovery, the picker and the import turn run in the native shell, with this Mac's chat route. */
export const nativeMemoryImporter: MemoryImporter = {
  discover: () => invokeDesktop<AgentInstructionFile[]>('desktop_memory_import_discover'),
  choose: () => invokeDesktop<AgentInstructionFile[]>('desktop_memory_import_choose'),
  extract: (file, existingMemories) => invokeDesktop<string>('desktop_memory_import_extract', {
    path: file.path,
    existingMemories,
    ...memoryImportRoute(importRoute),
  }),
};

const DAY = 86_400_000;

/** Sample files of two apps, a chosen one, and fixed replies, for previews; it reads nothing on this Mac. */
export function createPreviewMemoryImporter(options: { now?: () => number; latencyMs?: number } = {}): MemoryImporter {
  const now = options.now ?? Date.now;
  const latencyMs = options.latencyMs ?? 600;
  const files: AgentInstructionFile[] = [
    {
      path: '/sample/.claude/CLAUDE.md',
      root: null,
      projectName: 'Home',
      fileName: '.claude/CLAUDE.md',
      source: 'Claude Code',
      size: 1_200,
      modifiedAt: now() - 9 * DAY,
    },
    {
      path: '/sample/Projects/launch-site/AGENTS.md',
      root: '/sample/Projects/launch-site',
      projectName: 'launch-site',
      fileName: 'AGENTS.md',
      source: 'Project file',
      size: 4_300,
      modifiedAt: now() - 2 * DAY,
    },
  ];
  const chosen: AgentInstructionFile = {
    path: '/sample/Notes/writing.md',
    root: '/sample/Notes',
    projectName: 'Notes',
    fileName: 'writing.md',
    source: 'Chosen files',
    size: 2_100,
    modifiedAt: now() - 4 * DAY,
  };
  const replies: Record<string, unknown> = {
    [chosen.path]: { memories: [
      { text: 'Keep release notes to five bullets.', category: 'hcp-custom:task_lessons', scope: 'project', file: chosen.path },
    ] },
    [files[1].path]: { memories: [
      { text: 'Run the image size check before every site build.', category: 'hcp-custom:task_lessons', scope: 'project', file: files[1].path },
      { text: 'Use pnpm for every script in this repository.', category: 'hcp-custom:task_lessons', scope: 'project', file: files[1].path },
    ] },
    [files[0].path]: { memories: [] },
  };
  const wait = () => new Promise<void>((resolve) => { setTimeout(resolve, latencyMs); });
  return {
    discover() {
      return Promise.resolve(files.map((file) => ({ ...file })));
    },
    choose() {
      return Promise.resolve([{ ...chosen }, { ...files[1] }]);
    },
    async extract(file) {
      await wait();
      return JSON.stringify(replies[file.path] ?? { memories: [] });
    },
  };
}
