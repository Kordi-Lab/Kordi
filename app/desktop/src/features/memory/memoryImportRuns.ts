import type { CloudAuthClient } from '@/features/cloud/authClient';
import { hasHostedOnlyPrefix } from '@/features/cloud/routeAccountChoice';
import { claimRuntimeRoute, digestRunRoute, type DigestRunChoice } from '@/features/digest/digestMacRuns';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

import type { AgentInstructionFile } from './memoryImport';

// An import with a hosted account. A Mac receives a hosted account's
// credentials only for a run the server admitted, so an import first asks the
// server for one (`kind: memory_import`), keeps renewing it while files are
// read, and completes or releases it at the end. With a provider signed in on
// this Mac there is no run.

const RENEW_MS = 20_000;
export const MEMORY_IMPORT_LEASE_LOST = 'The import stopped. Try again.';

/** One import of several files: `extract` for each file, then `finish` once. */
export type MemoryImportRun = {
  extract(file: AgentInstructionFile, existingMemories: string[]): Promise<string>;
  /** Completes the run when `ok`, otherwise releases it. */
  finish(ok: boolean): Promise<void>;
};

type ImportClaim = {
  runId?: string;
  acquired?: boolean;
  message?: string;
  errorCode?: string;
  import?: DigestRunChoice | null;
};

/** What `desktop_memory_import_extract` receives for one file. */
export type MemoryImportExtractInput = {
  path: string;
  existingMemories: string[];
  route: DesktopChatMessageRoute | null;
  fallbackModel: string | null;
  runId?: string;
  claimId?: string;
};

export type MemoryImportRunDeps = {
  /** This Mac's chat route. */
  route: DesktopChatMessageRoute | null;
  /** The import route for a run without a claim (`memoryImportRoute`). */
  localRoute: (route: DesktopChatMessageRoute | null) => { route: DesktopChatMessageRoute | null; fallbackModel: string | null };
  session: () => Promise<{ token: string } | null>;
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>;
  invoke: (input: MemoryImportExtractInput) => Promise<string>;
};

/** Whether an import with `route` needs a run the server admitted. */
export function memoryImportNeedsRun(route: DesktopChatMessageRoute | null | undefined): boolean {
  return Boolean(route?.model?.trim()) && hasHostedOnlyPrefix(route?.authChoice);
}

/**
 * Starts one import. A local route reads each file directly. A hosted route
 * claims an import run first; a refused claim rejects with the server's line,
 * and a lost lease rejects every later file.
 */
export async function startMemoryImportRun(deps: MemoryImportRunDeps): Promise<MemoryImportRun> {
  const { route, client } = deps;
  if (!route || !memoryImportNeedsRun(route)) {
    const local = deps.localRoute(route);
    return {
      extract: (file, existingMemories) => deps.invoke({ path: file.path, existingMemories, ...local }),
      finish: () => Promise.resolve(),
    };
  }
  const session = await deps.session();
  if (!session?.token) throw new Error('Sign in to Kordi to import.');
  const { token } = session;
  const claimId = crypto.randomUUID();
  const claim = await client.desktopAgentExecution<ImportClaim>(token, 'tasks', {
    kind: 'memory_import', claimId, runtimeRoute: claimRuntimeRoute(route),
  });
  const runId = claim?.runId?.trim();
  if (!claim?.acquired || !runId) throw new Error(claim?.message?.trim() || 'The import could not start.');
  const chosen = claim.import ? digestRunRoute(route, claim.import) : deps.localRoute(route);
  const runPath = encodeURIComponent(runId);
  let lost = false;
  let finished = false;
  const timer = setInterval(() => {
    void client.desktopAgentExecution(token, `${runPath}/renew`, { claimId }).catch(() => { lost = true; });
  }, RENEW_MS);
  return {
    async extract(file, existingMemories) {
      if (lost) throw new Error(MEMORY_IMPORT_LEASE_LOST);
      const reply = await deps.invoke({ path: file.path, existingMemories, ...chosen, runId, claimId });
      if (lost) throw new Error(MEMORY_IMPORT_LEASE_LOST);
      return reply;
    },
    async finish(ok) {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      const action = ok && !lost ? 'complete' : 'release';
      await client.desktopAgentExecution(token, `${runPath}/${action}`, { claimId }).catch(() => undefined);
    },
  };
}
