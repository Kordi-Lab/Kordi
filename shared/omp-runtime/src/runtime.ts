import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStorage, ModelRegistry, SessionManager, createAgentSession, type AgentSession, type CustomTool, type ExtensionFactory } from '@oh-my-pi/pi-coding-agent';
import { buildModel } from '@oh-my-pi/pi-catalog/build';
import { ompCapabilityOptions } from './capabilities';
import { toKordiMessage, toOmpMessage } from './messages';
import { RuntimeError, type JsonObject, type RunRequest, type ToolResult } from './protocol';

export type RuntimeHost = {
  event(event: JsonObject): void;
  hook?(name: string, input: JsonObject): Promise<JsonObject>;
  tool(callId: string, name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult>;
};

/** One admitted Kordi turn. Kordi owns credentials, tool permissions, and persistence. */
export async function runTurn(request: RunRequest, host: RuntimeHost, signal: AbortSignal) {
  const agentDir = await mkdtemp(join(tmpdir(), 'kordi-omp-'));
  let authStorage: AuthStorage | undefined;
  let session: AgentSession | undefined;
  let terminalError: RuntimeError | undefined;
  let steps = 0;
  let toolCalls = 0;
  let providerFailed = false;
  let providerFailureCode = 'provider_error';
  const fail = (code: string, message: string) => {
    terminalError ??= new RuntimeError(code, message);
    if (session) void session.abort();
  };
  const abort = () => fail('cancelled', 'Run cancelled.');
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => fail('timeout', 'Run exceeded its time limit.'), request.limits.timeoutMs);
  try {
    host.event({ kind: 'status', status: 'starting' });
    if (signal.aborted) throw new RuntimeError('cancelled', 'Run cancelled.');
    authStorage = await AuthStorage.create(':memory:', {
      configValueResolver: async () => undefined,
      usageProviderResolver: () => undefined,
    });
    // A non-secret sentinel prevents upstream ambient environment key lookup for local no-auth routes.
    const credential = request.auth.kind === 'none' ? 'kordi-local-no-auth' : request.auth.credential!;
    authStorage.setRuntimeApiKey(request.model.provider, credential);
    const capabilityOptions = ompCapabilityOptions(request.capabilities ?? { ownerLocal: false, computer: false, browser: false }, request.tools.map(tool => tool.name));
    const settings = capabilityOptions.settings!;
    // Exact Kordi account/model selection must never silently fall back to ambient accounts/models.
    settings.set('retry.modelFallback', false);
    settings.set('retry.usageAwareFallback', false);
    settings.set('retry.waitForUsageReset', false);
    settings.set('compaction.idleEnabled', false);
    settings.set('compaction.handoffSaveToDisk', false);
    settings.set('compaction.methodOrder', ['handoff']);
    if (request.compaction) {
      settings.set('compaction.enabled', request.compaction.enabled);
      settings.set('compaction.reserveTokens', request.compaction.reserveTokens);
      settings.set('compaction.keepRecentTokens', request.compaction.keepRecentTokens);
      if (request.compaction.thresholdTokens !== undefined) settings.set('compaction.thresholdTokens', request.compaction.thresholdTokens);
    }
    settings.set('todo.enabled', false);
    const modelRegistry = new ModelRegistry(authStorage, join(agentDir, 'models.yml'), {
      ignoreLocalModelConfig: true, settings, cacheDbPath: join(agentDir, 'models.db'),
      fetch: async () => { throw new Error('Model discovery is disabled.'); },
    });
    const catalogModel = modelRegistry.find(request.model.provider, request.model.id);
    if (!catalogModel && (!request.model.api || !request.model.baseUrl)) {
      throw new RuntimeError('model_unavailable', 'The selected model needs an explicit provider transport and endpoint.');
    }
    const model: any = buildModel({
      name: request.model.id, reasoning: true, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
      ...catalogModel,
      ...Object.fromEntries(Object.entries(request.model).filter(([, value]) => value !== undefined)),
      headers: { ...catalogModel?.headers, ...request.auth.headers },
    } as any);
    modelRegistry.registerProvider(request.model.provider, {
      baseUrl: model.baseUrl, api: model.api, apiKey: 'kordi-selected-route', headers: model.headers, models: [model],
    }, 'kordi-selected-route');
    const sessionManager = SessionManager.inMemory(request.cwd);
    for (const message of request.messages) sessionManager.appendMessage(toOmpMessage(message, model.api, model));
    const initialEntryCount = sessionManager.getEntries().length;
    const customTools: CustomTool[] = request.tools.map(tool => ({
      name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
      // Visibility is explicit, and the Kordi host still applies its real permission policy.
      loadMode: 'essential',
      execute: async (callId, input, _onUpdate, _context, toolSignal) => {
        if (terminalError || signal.aborted) throw terminalError ?? new RuntimeError('cancelled', 'Run cancelled.');
        const result = await host.tool(callId, tool.name, input, toolSignal);
        return { content: result.content.map(block => toOmpMessage(block, model.api)) as any, details: result.details, isError: !result.ok };
      },
    }));
    const hookBridge: ExtensionFactory = api => {
      if (request.hooks?.includes('context') || request.prompt.trailingMessages?.length) api.on('context', async event => {
        try {
          const messages = event.messages.map(message => toKordiMessage(message));
          if (request.prompt.trailingMessages?.length) {
            // BeforeAgentStart custom context is already durable in Kordi. Keep
            // its position after this request without appending it a second time.
            const currentUser = messages.findLastIndex(message => message.role === 'user');
            if (currentUser < 0) throw new RuntimeError('hook_error', 'Current request context is unavailable.');
            messages.splice(currentUser + 1, 0, ...request.prompt.trailingMessages);
          }
          const input = { messages };
          const result = request.hooks?.includes('context') ? await host.hook?.('context', input) ?? input : input;
          if (!Array.isArray(result.messages)) throw new RuntimeError('hook_error', 'Invalid context hook result.');
          return { messages: result.messages.map((message: JsonObject) => toOmpMessage(message, model.api, model)) as any };
        } catch (error) { fail('hook_error', 'Context hook failed.'); throw error; }
      });
      if (request.hooks?.includes('before_provider_request')) api.on('before_provider_request', async event => {
        try {
          const input = { payload: event.payload };
          const result = await host.hook?.('before_provider_request', input) ?? input;
          if (!result.payload || typeof result.payload !== 'object' || Array.isArray(result.payload)) throw new RuntimeError('hook_error', 'Invalid provider hook result.');
          if (result.payload.model !== undefined && result.payload.model !== (event.payload as any)?.model) throw new RuntimeError('route_mismatch', 'A plugin cannot change the selected model.');
          return result.payload;
        } catch (error) { fail('hook_error', 'Provider hook failed.'); throw error; }
      });
    };
    const created = await createAgentSession({
      ...capabilityOptions, cwd: request.cwd, agentDir, authStorage, modelRegistry, model,
      rebindModelAfterDiscovery: false,
      getApiKey: async selectedModel => {
        if (selectedModel.provider !== request.model.provider || selectedModel.id !== request.model.id) throw new RuntimeError('route_mismatch', 'Provider selection changed during the run.');
        return credential;
      },
      systemPrompt: request.systemPrompt, sessionManager, customTools,
      thinkingLevel: (request.thinking === 'default' ? undefined : request.thinking) as any,
      providerSessionId: request.sessionId,
      preloadedExtensionPaths: [], preloadedCustomToolPaths: [], extensions: [],
      preloadedPreparedExtensions: request.hooks?.length || request.prompt.trailingMessages?.length ? [{ path: '<kordi-hooks>', resolvedPath: '<kordi-hooks>', factory: hookBridge, error: null }] : [],
      enableIrc: false, skipPythonPreflight: true,
      workspaceTree: { rootPath: request.cwd, rendered: '', truncated: false, totalLines: 0, agentsMdFiles: [] },
      hasUI: false, interactivePrompts: false,
      // Host tools enforce Kordi approvals. Built-in Eval is admitted only for owner-local capability.
      autoApprove: true,
    });
    session = created.session;
    session.subscribe(event => {
      if (terminalError) return;
      switch (event.type) {
        case 'turn_start':
          if (++steps > request.limits.maxSteps) return fail('step_limit', 'Run reached its model step limit.');
          host.event({ kind: 'turn_start', step: steps - 1 });
          host.event({ kind: 'status', status: 'running', step: steps });
          break;
        case 'turn_end': host.event({ kind: 'turn_end', step: steps - 1 }); break;
        case 'message_update': {
          const update = event.assistantMessageEvent;
          if (update.type === 'text_delta' || update.type === 'thinking_delta') host.event({ kind: update.type, delta: update.delta });
          break;
        }
        case 'message_end':
          // A host may continue after an explicitly configured provider failure.
          // Journal completed actions, never failed/partial assistant output.
          if (event.message.role !== 'assistant' || !['error', 'aborted'].includes(event.message.stopReason)) {
            host.event({ kind: 'message_end', message: toKordiMessage(event.message) });
          }
          if (event.message.role === 'assistant') {
            // Let the SDK complete its bounded retry policy before deciding the turn failed.
            providerFailed = event.message.stopReason === 'error';
            if (providerFailed) providerFailureCode = providerErrorCode(event.message);
            if (event.message.stopReason === 'aborted') fail('cancelled', 'Run cancelled.');
          }
          break;
        case 'tool_execution_start':
          if (++toolCalls > request.limits.maxToolCalls) return fail('tool_limit', 'Run reached its tool call limit.');
          host.event({ kind: 'tool_start', callId: event.toolCallId, name: event.toolName, input: event.args });
          break;
        case 'tool_execution_update':
          host.event({ kind: 'tool_update', callId: event.toolCallId, name: event.toolName, result: event.partialResult });
          break;
        case 'tool_execution_end':
          host.event({ kind: 'tool_end', callId: event.toolCallId, name: event.toolName, result: event.result, isError: event.isError ?? false });
          break;
        case 'auto_compaction_start': host.event({ kind: 'compaction', phase: 'start' }); break;
        case 'auto_compaction_end': host.event({ kind: 'compaction', phase: 'end', aborted: event.aborted }); break;
        case 'auto_retry_start': host.event({ kind: 'retry', phase: 'start', attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs }); break;
        case 'auto_retry_end': host.event({ kind: 'retry', phase: 'end', attempt: event.attempt, success: event.success }); break;
      }
    });
    if (terminalError || signal.aborted) throw terminalError ?? new RuntimeError('cancelled', 'Run cancelled.');
    if (request.prompt.resume) {
      await session.agent.continue();
      await session.waitForIdle();
    } else {
      await session.prompt(request.prompt.text, { images: request.prompt.images, expandPromptTemplates: false });
    }
    if (terminalError) throw terminalError;
    if (providerFailed) throw new RuntimeError(providerFailureCode, 'The selected provider could not complete this request.');
    const entries = sessionManager.getEntries();
    const newEntries = entries.slice(initialEntryCount);
    const messages = newEntries.filter((entry): entry is any => entry.type === 'message' && entry.message.role !== 'user').map(entry => toKordiMessage(entry.message));
    const lastAssistant = messages.findLast(message => message.role === 'assistant');
    const text = (lastAssistant?.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
    const compacted = newEntries.findLast((entry): entry is any => entry.type === 'compaction');
    const allMessageEntries = entries.filter(entry => entry.type === 'message');
    const checkpoint = compacted ? {
      summary: compacted.summary, shortSummary: compacted.shortSummary, tokensBefore: compacted.tokensBefore,
      firstKeptMessageIndex: allMessageEntries.findIndex(entry => entry.id === compacted.firstKeptEntryId),
    } : undefined;
    if (checkpoint && checkpoint.firstKeptMessageIndex < 0) throw new RuntimeError('checkpoint_error', 'Cannot preserve the compacted history boundary.');
    const firstKeptEntryId = checkpoint
      ? request.messageEntryIds?.[checkpoint.firstKeptMessageIndex] ??
        (checkpoint.firstKeptMessageIndex === request.messages.length ? request.prompt.entryId : undefined)
      : undefined;
    host.event({ kind: 'status', status: 'completed' });
    return { text, messages, contextMessages: session.messages.map(message => toKordiMessage(message)),
      checkpoint: checkpoint ? { ...checkpoint, firstKeptEntryId } : undefined, usage: lastAssistant?.usage };
  } catch (error) {
    if (terminalError) throw terminalError;
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('runtime_error', 'The agent runtime could not complete this request.');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    await session?.dispose();
    authStorage?.close();
    await rm(agentDir, { recursive: true, force: true });
  }
}

/** Only fixed classifications leave the worker; provider bodies may contain credentials or conversation text. */
export function providerErrorCode(error: { errorStatus?: number; errorMessage?: string }) {
  const message = error.errorMessage ?? '';
  if (/account.?id|decode.*token|invalid.*jwt/i.test(message)) return 'provider_account_identity';
  if (/model.*(?:not found|not supported|does not exist|unavailable|not allowed)|unsupported.*model/i.test(message)) return 'provider_model_unavailable';
  if (/invalid.*(?:tool|schema)|(?:tool|schema).*invalid/i.test(message)) return 'provider_tool_schema';
  if (/unsupported.*(?:parameter|value)|unknown.*parameter|unrecognized.*parameter/i.test(message)) return 'provider_unsupported_parameter';
  if (/certificate|TLS|SSL/i.test(message)) return 'provider_tls';
  if (/fetch failed|unable to connect|connection refused|network|ENOTFOUND|ECONN/i.test(message)) return 'provider_connection';
  if (Number.isInteger(error.errorStatus) && error.errorStatus! >= 400 && error.errorStatus! <= 599) return `provider_http_${error.errorStatus}`;
  return 'provider_error';
}
