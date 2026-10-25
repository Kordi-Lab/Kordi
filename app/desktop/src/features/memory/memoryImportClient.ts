import { useEffect } from 'react';

import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import { digestRunRoute } from '@/features/digest/digestMacRuns';
import { invokeDesktop, type DesktopChatMessageRoute } from '@/lib/desktop';

import type { AgentInstructionFile, MemoryImporter } from './memoryImport';
import { startMemoryImportRun, type MemoryImportExtractInput } from './memoryImportRuns';

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

const extractNative = (input: MemoryImportExtractInput) => invokeDesktop<string>('desktop_memory_import_extract', input);

/**
 * Discovery, the picker and the import turn run in the native shell, with this Mac's chat route.
 * A hosted account's import runs under a run the server admits (`startMemoryImportRun`).
 */
export const nativeMemoryImporter: MemoryImporter = {
  discover: () => invokeDesktop<AgentInstructionFile[]>('desktop_memory_import_discover'),
  choose: () => invokeDesktop<AgentInstructionFile[]>('desktop_memory_import_choose'),
  extract: (file, existingMemories) => extractNative({ path: file.path, existingMemories, ...memoryImportRoute(importRoute) }),
  start: () => startMemoryImportRun({
    route: importRoute,
    localRoute: memoryImportRoute,
    session: loadSession,
    client: defaultCloudAuthClient(),
    invoke: extractNative,
  }),
};

const DAY = 86_400_000;

const LAUNCH_SITE = '/sample/Projects/launch-site';
const DOCS_SITE = '/sample/Projects/docs-site';

function sampleFile(source: string, root: string | null, projectName: string, path: string, fileName: string, size: number, age: number, now: number): AgentInstructionFile {
  return { path, root, projectName, fileName, source, size, modifiedAt: now - age * DAY };
}

function sampleReply(file: string, ...texts: string[]) {
  return { memories: texts.map((text) => ({ text, category: 'hcp-custom:task_lessons', scope: 'project', file })) };
}

/** Sample files of two apps in two projects, a chosen one, and fixed replies, for previews; it reads nothing on this Mac. */
export function createPreviewMemoryImporter(options: { now?: () => number; latencyMs?: number } = {}): MemoryImporter {
  const now = options.now ?? Date.now;
  const latencyMs = options.latencyMs ?? 600;
  const at = now();
  const claude = (root: string, name: string, slug: string, file: string, size: number, age: number) =>
    sampleFile('Claude Code', root, name, `/sample/.claude/projects/${slug}/memory/${file}`, `memory/${file}`, size, age, at);
  const files: AgentInstructionFile[] = [
    claude(LAUNCH_SITE, 'launch-site', '-sample-Projects-launch-site', 'feedback-always-checkpoint.md', 1_100, 3),
    claude(LAUNCH_SITE, 'launch-site', '-sample-Projects-launch-site', 'project-image-budget.md', 800, 5),
    claude(LAUNCH_SITE, 'launch-site', '-sample-Projects-launch-site', 'reference-deploy-steps.md', 2_600, 12),
    claude(DOCS_SITE, 'docs-site', '-sample-Projects-docs-site', 'feedback-short-headings.md', 700, 6),
    claude(DOCS_SITE, 'docs-site', '-sample-Projects-docs-site', 'project-search-index.md', 1_900, 20),
    sampleFile('Claude Code', null, 'Home', '/sample/.claude/CLAUDE.md', '.claude/CLAUDE.md', 1_200, 9, at),
    sampleFile('Project file', LAUNCH_SITE, 'launch-site', `${LAUNCH_SITE}/AGENTS.md`, 'AGENTS.md', 4_300, 2, at),
    sampleFile('Project file', LAUNCH_SITE, 'launch-site', `${LAUNCH_SITE}/CLAUDE.md`, 'CLAUDE.md', 1_500, 7, at),
    sampleFile('Project file', DOCS_SITE, 'docs-site', `${DOCS_SITE}/AGENTS.md`, 'AGENTS.md', 3_200, 4, at),
  ];
  const chosen = sampleFile('Chosen files', '/sample/Notes', 'Notes', '/sample/Notes/writing.md', 'writing.md', 2_100, 4, at);
  const replies: Record<string, unknown> = {
    [chosen.path]: sampleReply(chosen.path, 'Keep release notes to five bullets.'),
    [files[0].path]: sampleReply(files[0].path, 'Commit a checkpoint before each large refactor.'),
    [files[3].path]: sampleReply(files[3].path, 'Keep docs headings under six words.'),
    [files[6].path]: sampleReply(files[6].path, 'Run the image size check before every site build.', 'Use pnpm for every script in this repository.'),
  };
  const wait = () => new Promise<void>((resolve) => { setTimeout(resolve, latencyMs); });
  return {
    discover() {
      return Promise.resolve(files.map((file) => ({ ...file })));
    },
    choose() {
      return Promise.resolve([{ ...chosen }, { ...files[6] }]);
    },
    async extract(file) {
      await wait();
      return JSON.stringify(replies[file.path] ?? { memories: [] });
    },
  };
}
