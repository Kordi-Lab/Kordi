import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Circle, Download, ExternalLink, PlayCircle, RefreshCw, Search, Server, Square, Terminal, Trash2 } from 'lucide-react';

import {
  deleteOllamaModelDesktop,
  fetchOllamaCatalogModelsDesktop,
  fetchOllamaCatalogVariantsDesktop,
  fetchOllamaEnvironmentDesktop,
  fetchOllamaInstalledModelsDesktop,
  fetchOllamaRunningModelIdsDesktop,
  fetchOllamaServerStatusDesktop,
  installOllamaDesktop,
  loadOllamaModelDesktop,
  openDesktopExternalUrl,
  openOllamaAppDesktop,
  pullOllamaModelDesktop,
  setDesktopLocalProviderPort,
  startOllamaServerDesktop,
  stopOllamaModelDesktop,
  type DesktopOllamaCatalogModel,
  type DesktopOllamaCatalogVariant,
  type DesktopOllamaCommandResult,
  type DesktopOllamaEnvironment,
  type DesktopOllamaInstalledModel,
  type DesktopOllamaServerStatus,
} from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { AuthActionButton, nonDragStyle } from './AuthDetailPrimitives';

type OllamaModelControlCenterProps = {
  endpoint: string;
  port: string;
  onRefreshAuth: () => void | Promise<void>;
  onSaved?: () => void;
  onEnterChat?: (preferredModelValue?: string) => void | Promise<void>;
};

type OllamaAction =
  | 'catalog'
  | 'install'
  | 'setup'
  | 'server-start'
  | `pull:${string}`
  | `load:${string}`
  | `stop:${string}`
  | `delete:${string}`;

const OLLAMA_DOCS_URL = 'https://docs.ollama.com';
const OLLAMA_OPENAI_DOCS_URL = 'https://docs.ollama.com/openai';
const OLLAMA_LIBRARY_URL = 'https://ollama.com/library';

const flatButtonShapeClass = '!h-8 !rounded-[10px] !px-3 shadow-none';
const ollamaPrimaryClass = `${flatButtonShapeClass} border border-emerald-300/24 bg-emerald-300/[0.09] text-emerald-50 hover:border-emerald-200/34 hover:bg-emerald-300/[0.13]`;
const ollamaNeutralClass = `${flatButtonShapeClass} border border-white/8 bg-white/[0.035] text-slate-200 hover:border-white/14 hover:bg-white/[0.06]`;
const ollamaStopClass = `${flatButtonShapeClass} border border-amber-300/18 bg-amber-300/[0.055] text-amber-50 hover:border-amber-200/26 hover:bg-amber-300/[0.08]`;
const ollamaDangerClass = `${flatButtonShapeClass} border border-rose-300/16 bg-rose-300/[0.055] text-rose-100 hover:border-rose-300/24 hover:bg-rose-300/[0.08]`;

function openHelpUrl(url: string) {
  void openDesktopExternalUrl(url).catch((error) => {
    console.error('Unable to open Ollama help URL', error);
  });
}

function resultSummary(result: DesktopOllamaCommandResult) {
  const output = result.stdout.trim() || result.stderr.trim();
  if (!output) return `${result.command} finished successfully.`;
  return output.split('\n').slice(-3).join(' ');
}

function compactPath(value?: string | null) {
  if (!value) return 'Not found';
  return value.replace(/^\/Users\/[^/]+/, '~');
}

function modelSizesLabel(model: DesktopOllamaCatalogModel) {
  if (model.sizes.length === 0) return model.tags ? `${model.tags} tags` : 'latest';
  if (model.sizes.length <= 5) return model.sizes.join(' · ');
  return `${model.sizes.slice(0, 5).join(' · ')} · +${model.sizes.length - 5}`;
}

function isEmbeddingModelId(value: string) {
  const lower = value.trim().toLowerCase();
  const modelPart = lower.includes('/') ? lower.split('/').pop() ?? lower : lower;
  return modelPart.includes('embedding')
    || modelPart.includes('embed-text')
    || modelPart.includes('-embed')
    || modelPart.startsWith('text-embedding')
    || modelPart.startsWith('embed-')
    || modelPart.startsWith('nomic-embed')
    || modelPart.startsWith('mxbai-embed')
    || modelPart.startsWith('all-minilm')
    || modelPart.startsWith('bge-')
    || modelPart.startsWith('bge_')
    || modelPart.startsWith('paraphrase-')
    || modelPart.startsWith('snowflake-arctic-embed');
}

function normalizeOllamaModelId(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes(':')) return trimmed;
  return `${trimmed}:latest`;
}

function familyMatchesQuery(model: DesktopOllamaCatalogModel, normalized: string) {
  if (!normalized) return true;
  return [model.name, model.id, model.description ?? '', model.sizes.join(' ')]
    .some((value) => value.toLowerCase().includes(normalized));
}

function variantMatchesQuery(variant: DesktopOllamaCatalogVariant, normalized: string) {
  if (!normalized) return true;
  return [variant.id, variant.size ?? '', variant.context ?? '', variant.input ?? '']
    .some((value) => value.toLowerCase().includes(normalized));
}

function modelMatchesQuery(model: DesktopOllamaCatalogModel, normalized: string) {
  return familyMatchesQuery(model, normalized) || model.variants.some((variant) => variantMatchesQuery(variant, normalized));
}

function RuntimeStatusPill({ running }: { running: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
      running
        ? 'border-emerald-300/22 bg-emerald-300/[0.08] text-emerald-100'
        : 'border-white/10 bg-white/[0.045] text-slate-300',
    )}
    >
      {running ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
      {running ? 'Server running' : 'Server stopped'}
    </span>
  );
}

function ReadinessStep({
  label,
  detail,
  complete,
  active,
}: {
  label: string;
  detail: string;
  complete: boolean;
  active: boolean;
}) {
  return (
    <div className={cn(
      'grid min-w-[10.5rem] flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-[16px] border px-3 py-2.5',
      complete
        ? 'border-emerald-300/18 bg-emerald-300/[0.055]'
        : active
          ? 'border-amber-300/18 bg-amber-300/[0.06]'
          : 'border-white/8 bg-white/[0.035]',
    )}
    >
      <span className={cn(
        'mt-0.5 grid h-5 w-5 place-items-center rounded-full border',
        complete
          ? 'border-emerald-300/25 bg-emerald-300/[0.12] text-emerald-100'
          : active
            ? 'border-amber-300/24 bg-amber-300/[0.1] text-amber-100'
            : 'border-white/10 bg-white/[0.045] text-slate-500',
      )}
      >
        {complete ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3 w-3" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-medium text-slate-100">{label}</span>
        <span className="mt-0.5 block text-[10.5px] leading-4 text-slate-500">{detail}</span>
      </span>
    </div>
  );
}

function RuntimeMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] border border-white/8 bg-white/[0.035] px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">{label}</div>
      <div className="mt-1 truncate font-mono text-[11px] text-slate-200">{value}</div>
    </div>
  );
}

export function OllamaModelControlCenter({
  endpoint,
  port,
  onRefreshAuth,
  onSaved,
  onEnterChat,
}: OllamaModelControlCenterProps) {
  const [query, setQuery] = useState('');
  const [exactModelDraft, setExactModelDraft] = useState('llama3.2');
  const [catalogModels, setCatalogModels] = useState<DesktopOllamaCatalogModel[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<DesktopOllamaEnvironment | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<DesktopOllamaServerStatus | null>(null);
  const [serverStatusError, setServerStatusError] = useState<string | null>(null);
  const [installedModels, setInstalledModels] = useState<DesktopOllamaInstalledModel[]>([]);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [runningModelIds, setRunningModelIds] = useState<Set<string>>(() => new Set());
  const [expandedFamilyIds, setExpandedFamilyIds] = useState<Set<string>>(() => new Set());
  const [loadingFamilyIds, setLoadingFamilyIds] = useState<Set<string>>(() => new Set());
  const [isInstalledSectionExpanded, setIsInstalledSectionExpanded] = useState(true);
  const [isCatalogSectionExpanded, setIsCatalogSectionExpanded] = useState(false);
  const [isSetupDetailsExpanded, setIsSetupDetailsExpanded] = useState(false);
  const [confirmDeleteModelId, setConfirmDeleteModelId] = useState<string | null>(null);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [activeAction, setActiveAction] = useState<OllamaAction | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const endpointConfigured = endpoint.trim().length > 0;
  const normalizedQuery = query.trim().toLowerCase();

  const installedIds = useMemo(() => new Set(installedModels.map((model) => model.id)), [installedModels]);
  const visibleModels = useMemo(() => (
    catalogModels.filter((model) => modelMatchesQuery(model, normalizedQuery))
  ), [catalogModels, normalizedQuery]);
  const visibleVariantCount = visibleModels.reduce((sum, model) => sum + model.variants.length, 0);

  const isModelRunning = (modelId: string) => runningModelIds.has(modelId) || runningModelIds.has(normalizeOllamaModelId(modelId));

  const refreshEnvironment = async () => {
    try {
      setSetupError(null);
      const snapshot = await fetchOllamaEnvironmentDesktop();
      setEnvironment(snapshot);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Unable to inspect Ollama setup.');
    }
  };

  const refreshServerStatus = async () => {
    try {
      setServerStatusError(null);
      const status = await fetchOllamaServerStatusDesktop(endpoint);
      setServerStatus(status);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to reach Ollama.';
      setServerStatus({ running: false, detail: message, version: null });
      setServerStatusError(message);
      return null;
    }
  };

  const refreshInstalledModels = async () => {
    try {
      setInstalledError(null);
      const models = await fetchOllamaInstalledModelsDesktop(endpoint);
      setInstalledModels(models);
      return models;
    } catch (error) {
      setInstalledError(error instanceof Error ? error.message : 'Unable to read installed Ollama models.');
      return [];
    }
  };

  const refreshRunningModels = async () => {
    try {
      const ids = await fetchOllamaRunningModelIdsDesktop(endpoint);
      const next = new Set(ids.map(normalizeOllamaModelId));
      setRunningModelIds(next);
      return next;
    } catch {
      const next = new Set<string>();
      setRunningModelIds(next);
      return next;
    }
  };

  const refreshCatalog = async () => {
    try {
      setActiveAction('catalog');
      setCatalogError(null);
      const models = await fetchOllamaCatalogModelsDesktop();
      setCatalogModels(models);
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : 'Unable to fetch Ollama library.');
    } finally {
      setActiveAction(null);
    }
  };

  useEffect(() => {
    void Promise.all([
      refreshEnvironment(),
      refreshServerStatus(),
      refreshInstalledModels(),
      refreshRunningModels(),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const runOllamaAction = async (
    action: OllamaAction,
    operation: () => Promise<DesktopOllamaCommandResult>,
    fallbackMessage: string,
    after?: () => void | Promise<void>,
  ) => {
    try {
      setActiveAction(action);
      setActionError(null);
      const result = await operation();
      setActionMessage(resultSummary(result) || fallbackMessage);
      await Promise.resolve(after?.());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setActiveAction(null);
    }
  };

  const startServer = async () => {
    await runOllamaAction(
      'server-start',
      () => startOllamaServerDesktop(Number(port)),
      'Starting Ollama',
      async () => {
        await refreshServerStatus();
        await refreshInstalledModels();
        await refreshRunningModels();
      },
    );
  };

  const openOllama = async () => {
    await runOllamaAction(
      'setup',
      openOllamaAppDesktop,
      'Opening Ollama',
      async () => {
        await refreshEnvironment();
        await refreshServerStatus();
      },
    );
  };

  const saveOllamaModelPreference = async (model: string) => {
    await setDesktopLocalProviderPort('ollama', Number(port), model);
    await Promise.resolve(onRefreshAuth());
  };

  const installOrUpdateOllama = async () => {
    if (!confirmInstall) {
      setConfirmInstall(true);
      setActionError(null);
      setActionMessage('Click Confirm install/update to run the official Ollama installer helper on this computer.');
      return;
    }

    setConfirmInstall(false);
    await runOllamaAction(
      'install',
      installOllamaDesktop,
      appReady ? 'Updating Ollama' : 'Installing Ollama',
      async () => {
        await refreshEnvironment();
        await refreshServerStatus();
        await refreshInstalledModels();
        await refreshRunningModels();
      },
    );
  };

  const pullModel = async (modelId: string) => {
    const model = normalizeOllamaModelId(modelId);
    if (isEmbeddingModelId(model)) {
      setActionError('Embedding models cannot be used for chat. Choose a chat model instead.');
      return;
    }
    await runOllamaAction(
      `pull:${model}`,
      () => pullOllamaModelDesktop(endpoint, model),
      `Pulling ${model}`,
      async () => {
        await refreshInstalledModels();
        await refreshRunningModels();
        setActionMessage(`Pulled ${model}. Run it to make it available in chat.`);
      },
    );
  };

  const toggleModelRuntime = async (modelId: string) => {
    const model = normalizeOllamaModelId(modelId);
    const latestRunningIds = await refreshRunningModels();
    if (latestRunningIds.has(model)) {
      await runOllamaAction(
        `stop:${model}`,
        () => stopOllamaModelDesktop(endpoint, model),
        `Stopping ${model}`,
        () => setRunningModelIds((current) => {
          const next = new Set(current);
          next.delete(model);
          return next;
        }),
      );
      return;
    }

    await runOllamaAction(
      `load:${model}`,
      () => loadOllamaModelDesktop(endpoint, model),
      `Running ${model}`,
      async () => {
        await saveOllamaModelPreference(model);
        setRunningModelIds((current) => new Set(current).add(model));
        setActionMessage(`Running and saved Ollama with ${model}.`);
      },
    );
  };

  const deleteInstalledModel = async (modelId: string) => {
    const model = normalizeOllamaModelId(modelId);
    if (confirmDeleteModelId !== model) {
      setConfirmDeleteModelId(model);
      setActionError(null);
      setActionMessage(`Click Remove again to stop ${model} if running, then delete it from Ollama.`);
      return;
    }

    setConfirmDeleteModelId(null);
    await runOllamaAction(
      `delete:${model}`,
      () => deleteOllamaModelDesktop(endpoint, model),
      `Removing ${model}`,
      async () => {
        await refreshInstalledModels();
        await refreshRunningModels();
      },
    );
  };

  const loadFamilyVariants = async (familyId: string) => {
    const family = catalogModels.find((model) => model.id === familyId);
    if (!family || family.variants.length > 0 || loadingFamilyIds.has(familyId)) return;

    try {
      setLoadingFamilyIds((current) => new Set(current).add(familyId));
      const variants = await fetchOllamaCatalogVariantsDesktop(familyId);
      setCatalogModels((current) => current.map((model) => (
        model.id === familyId ? { ...model, variants } : model
      )));
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : `Unable to fetch tags for ${familyId}.`);
    } finally {
      setLoadingFamilyIds((current) => {
        const next = new Set(current);
        next.delete(familyId);
        return next;
      });
    }
  };

  const toggleFamily = (familyId: string) => {
    setExpandedFamilyIds((current) => {
      const next = new Set(current);
      if (next.has(familyId)) next.delete(familyId);
      else next.add(familyId);
      return next;
    });
    void loadFamilyVariants(familyId);
  };

  const activeRunningModelId = installedModels.find((model) => isModelRunning(model.id))?.id
    ?? Array.from(runningModelIds)[0]
    ?? null;
  const firstInstalledModelId = installedModels[0]?.id ?? null;
  const appReady = Boolean(environment?.appPath || environment?.cliPath);
  const serverRunning = serverStatus?.running ?? false;
  const hasInstalledModels = installedModels.length > 0;
  const hasRunningModel = Boolean(activeRunningModelId);
  const catalogSummary = activeAction === 'catalog'
    ? 'Refreshing library…'
    : `${visibleModels.length} of ${catalogModels.length} families${visibleVariantCount ? ` · ${visibleVariantCount} tags loaded` : ''}`;

  const saveConnection = async (modelId?: string | null, enterChat = false) => {
    const model = normalizeOllamaModelId(modelId ?? activeRunningModelId ?? firstInstalledModelId ?? exactModelDraft);
    if (!model) {
      setActionError('Pull or run an Ollama chat model before saving.');
      return;
    }
    if (isEmbeddingModelId(model)) {
      setActionError('Embedding models cannot be used for chat. Choose a chat model instead.');
      return;
    }

    try {
      setActionError(null);
      await setDesktopLocalProviderPort('ollama', Number(port), model);
      await Promise.resolve(onRefreshAuth());
      onSaved?.();
      setActionMessage(`Saved Ollama with ${model}.`);
      if (enterChat) {
        await Promise.resolve(onEnterChat?.(`ollama/${model}`));
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to save Ollama.');
    }
  };

  const installActionLabel = confirmInstall ? 'Confirm install/update' : 'Install Ollama';
  const installActionDetail = confirmInstall
    ? 'Run the official installer helper after this second click.'
    : 'Download and install Ollama with the official bash installer.';
  const installButtonLabel = confirmInstall
    ? 'Confirm install/update'
    : appReady ? 'Update Ollama' : 'Install Ollama';

  const primaryActionLabel = !appReady
    ? installActionLabel
    : !serverRunning
      ? 'Start local server'
      : !hasInstalledModels
        ? 'Browse library'
        : !hasRunningModel && firstInstalledModelId
          ? 'Run installed model'
          : endpointConfigured
            ? 'Save & enter chat'
            : 'Save Ollama';

  const primaryActionDetail = !appReady
    ? installActionDetail
    : !serverRunning
      ? 'Open Ollama.app or start `ollama serve` in the background.'
      : !hasInstalledModels
        ? 'Pull a chat model from the Ollama library.'
        : !hasRunningModel && firstInstalledModelId
          ? `Load ${firstInstalledModelId} into memory.`
          : endpointConfigured
            ? `Use ${activeRunningModelId ?? firstInstalledModelId} in Kordi chat.`
            : 'Persist this local provider and model.';

  const runPrimaryAction = async () => {
    if (!appReady) {
      await installOrUpdateOllama();
      return;
    }
    if (!serverRunning) {
      await startServer();
      return;
    }
    if (!hasInstalledModels) {
      setIsCatalogSectionExpanded(true);
      if (catalogModels.length === 0) await refreshCatalog();
      return;
    }
    if (!hasRunningModel && firstInstalledModelId) {
      await toggleModelRuntime(firstInstalledModelId);
      return;
    }
    await saveConnection(activeRunningModelId ?? firstInstalledModelId, endpointConfigured);
  };

  const readinessSteps = [
    {
      label: 'App or CLI',
      detail: appReady ? 'Ollama resolved' : 'install app',
      complete: appReady,
      active: !appReady,
    },
    {
      label: 'Local server',
      detail: serverRunning ? 'API reachable' : 'start server',
      complete: serverRunning,
      active: appReady && !serverRunning,
    },
    {
      label: 'Installed model',
      detail: hasInstalledModels ? `${installedModels.length} chat models` : 'pull a model',
      complete: hasInstalledModels,
      active: appReady && serverRunning && !hasInstalledModels,
    },
    {
      label: 'Running model',
      detail: activeRunningModelId ?? 'load model',
      complete: hasRunningModel,
      active: appReady && serverRunning && hasInstalledModels && !hasRunningModel,
    },
  ];

  return (
    <div className="grid gap-3.5" style={nonDragStyle}>
      <div className="rounded-[24px] border border-white/8 bg-white/[0.045] p-4 shadow-none">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <RuntimeStatusPill running={serverRunning} />
              <span className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
                appReady
                  ? 'border-emerald-300/22 bg-emerald-300/[0.08] text-emerald-100'
                  : 'border-white/10 bg-white/[0.045] text-slate-300',
              )}
              >
                {appReady ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
                {appReady ? 'Installed' : 'Not installed'}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.045] px-2.5 py-1 text-[11px] text-slate-300">Ollama authentication</span>
            </div>
            <h3 className="mt-3 text-[17px] font-semibold tracking-tight text-white">One Ollama model, pulled locally, ready for Kordi chat.</h3>
            <p className="mt-1 max-w-[70ch] text-[12px] leading-5 text-slate-400">
              Kordi uses Ollama’s OpenAI-compatible endpoint for chat, while this panel uses Ollama’s native API for model pull, run, stop, and removal. Removing a model stops any running copy before deleting it from disk.
            </p>
          </div>
          <div className="flex min-w-[15rem] flex-col gap-2 rounded-[18px] border border-white/8 bg-black/10 p-3">
            <AuthActionButton
              className={ollamaPrimaryClass}
              onClick={() => void runPrimaryAction()}
              disabled={activeAction === 'server-start' || activeAction === 'install'}
            >
              {activeAction === 'server-start' || activeAction === 'install' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
              {activeAction === 'install' ? (appReady ? 'Updating…' : 'Installing…') : activeAction === 'server-start' ? 'Starting…' : primaryActionLabel}
            </AuthActionButton>
            <div className="text-[11px] leading-4 text-slate-500">{primaryActionDetail}</div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {readinessSteps.map((step) => <ReadinessStep key={step.label} {...step} />)}
        </div>
      </div>

      {(actionError || actionMessage) ? (
        <div className={cn(
          'rounded-[18px] border px-4 py-3 text-[12px] leading-5',
          actionError
            ? 'border-rose-300/20 bg-rose-300/[0.075] text-rose-50'
            : 'border-emerald-300/18 bg-emerald-300/[0.075] text-emerald-50',
        )}
        >
          {actionError ?? actionMessage}
        </div>
      ) : null}

      <div className="rounded-[22px] border border-white/8 bg-white/[0.04] p-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[13px] font-medium text-white">Runtime endpoint</div>
            <div className="mt-1 text-[11px] leading-5 text-slate-400">Ollama exposes OpenAI-compatible chat at <span className="font-mono text-slate-300">/v1/chat/completions</span>; native model controls use <span className="font-mono text-slate-300">/api/*</span>.</div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <AuthActionButton className={ollamaNeutralClass} onClick={() => void Promise.all([refreshServerStatus(), refreshInstalledModels(), refreshRunningModels()])}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </AuthActionButton>
            <AuthActionButton className={appReady ? ollamaNeutralClass : ollamaPrimaryClass} onClick={() => void installOrUpdateOllama()} disabled={activeAction === 'install'}>
              <Download className={cn('h-3.5 w-3.5', activeAction === 'install' && 'animate-pulse')} /> {activeAction === 'install' ? (appReady ? 'Updating…' : 'Installing…') : installButtonLabel}
            </AuthActionButton>
            <AuthActionButton className={ollamaNeutralClass} onClick={openOllama} disabled={activeAction === 'setup'}>
              <ExternalLink className="h-3.5 w-3.5" /> {activeAction === 'setup' ? 'Opening…' : 'Open app'}
            </AuthActionButton>
            <AuthActionButton className={ollamaNeutralClass} onClick={() => setIsSetupDetailsExpanded((value) => !value)}>
              {isSetupDetailsExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {isSetupDetailsExpanded ? 'Hide details' : 'Details'}
            </AuthActionButton>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <RuntimeMetric label="Endpoint" value={endpoint} />
          <RuntimeMetric label="Port" value={port} />
          <RuntimeMetric label="Server" value={serverStatus?.detail ?? 'Unknown'} />
          <RuntimeMetric label="Active model" value={activeRunningModelId ?? 'None'} />
        </div>

        {isSetupDetailsExpanded ? (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <RuntimeMetric label="App" value={compactPath(environment?.appPath)} />
            <RuntimeMetric label="CLI" value={compactPath(environment?.cliPath)} />
            <RuntimeMetric label="CLI source" value={environment?.cliSource ?? 'Unknown'} />
            <RuntimeMetric label="Version" value={serverStatus?.version ?? environment?.cliVersion ?? environment?.appVersion ?? 'Unknown'} />
          </div>
        ) : null}

        {(setupError || serverStatusError || environment?.notes.length) ? (
          <div className="mt-3 rounded-[18px] border border-amber-300/18 bg-amber-300/[0.075] px-4 py-3 text-[12px] leading-5 text-amber-50">
            {setupError ? <div>{setupError}</div> : null}
            {serverStatusError ? <div>{serverStatusError}</div> : null}
            {environment?.notes.map((note) => <div key={note}>{note}</div>)}
          </div>
        ) : null}
      </div>

      <div className="rounded-[22px] border border-white/8 bg-white/[0.04] p-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium text-white">Installed locally</div>
              <div className="rounded-full border border-white/10 bg-white/[0.045] px-2 py-0.5 text-[10px] text-slate-300">{installedModels.length} chat models</div>
            </div>
            <div className="mt-1 max-w-[72ch] text-[11px] leading-5 text-slate-400">
              Run loads the model through Ollama’s native API. Remove first stops a running copy, then deletes it from disk. Embedding models are filtered out because they cannot answer chat.
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <AuthActionButton className={ollamaNeutralClass} onClick={() => setIsInstalledSectionExpanded((value) => !value)}>
              {isInstalledSectionExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {isInstalledSectionExpanded ? 'Hide' : 'Show'}
            </AuthActionButton>
          </div>
        </div>

        {isInstalledSectionExpanded && installedError ? (
          <div className="mt-3 rounded-[18px] border border-amber-300/18 bg-amber-300/[0.075] px-4 py-3 text-[12px] leading-5 text-amber-50">
            {installedError}
          </div>
        ) : null}

        {isInstalledSectionExpanded ? (
          <div className="mt-3 overflow-hidden rounded-[18px] border border-white/8 bg-black/10">
            {installedModels.length > 0 ? installedModels.map((model) => {
              const running = isModelRunning(model.id);
              const runtimeAction = running ? `stop:${model.id}` : `load:${model.id}`;
              return (
                <div key={model.id} className="grid gap-2 border-b border-white/6 px-3.5 py-2.5 last:border-b-0 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="truncate font-mono text-[12px] text-slate-100">{model.id}</div>
                      <span className="rounded-full border border-emerald-300/18 bg-emerald-300/[0.08] px-2 py-0.5 text-[10px] font-medium text-emerald-100">Installed</span>
                      {running ? <span className="rounded-full border border-amber-300/18 bg-amber-300/[0.08] px-2 py-0.5 text-[10px] font-medium text-amber-100">Running</span> : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                      {model.size ? <span>{model.size}</span> : null}
                      {model.family ? <span>{model.family}</span> : null}
                      {model.parameterSize ? <span>{model.parameterSize}</span> : null}
                      {model.quantization ? <span>{model.quantization}</span> : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 xl:justify-end">
                    <AuthActionButton
                      className={running ? ollamaStopClass : ollamaNeutralClass}
                      onClick={() => void toggleModelRuntime(model.id)}
                      disabled={activeAction === runtimeAction}
                      title={running ? 'Running — click to stop' : 'Run this installed model'}
                    >
                      {running ? <Square className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
                      {activeAction === `load:${model.id}` ? 'Running…' : activeAction === `stop:${model.id}` ? 'Stopping…' : running ? 'Running' : 'Run'}
                    </AuthActionButton>
                    <AuthActionButton className={ollamaDangerClass} onClick={() => void deleteInstalledModel(model.id)} disabled={activeAction === `delete:${model.id}`}>
                      <Trash2 className="h-3.5 w-3.5" /> {activeAction === `delete:${model.id}` ? 'Removing…' : confirmDeleteModelId === model.id ? 'Confirm remove' : 'Remove'}
                    </AuthActionButton>
                  </div>
                </div>
              );
            }) : (
              <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0 text-[12px] leading-5 text-slate-400">
                  <div className="font-medium text-slate-200">No installed Ollama chat models yet.</div>
                  <div className="mt-1">Pull a model from the library or enter an exact Ollama tag such as <span className="font-mono text-slate-300">llama3.2:latest</span>.</div>
                </div>
                <AuthActionButton
                  className={ollamaNeutralClass}
                  onClick={() => setIsCatalogSectionExpanded(true)}
                >
                  <Search className="h-3.5 w-3.5" /> Browse library
                </AuthActionButton>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="rounded-[22px] border border-white/8 bg-white/[0.04] p-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium text-white">Ollama library</div>
              <div className="rounded-full border border-white/10 bg-white/[0.045] px-2 py-0.5 text-[10px] text-slate-300">{catalogSummary}</div>
            </div>
            <div className="mt-1 max-w-[72ch] text-[11px] leading-5 text-slate-400">
              Pull a common family directly, expand it for exact tags, or type a model name from docs. Embeddings are omitted from this chat setup flow.
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <AuthActionButton className={ollamaNeutralClass} onClick={() => setIsCatalogSectionExpanded((value) => !value)}>
              {isCatalogSectionExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {isCatalogSectionExpanded ? 'Hide library' : 'Show library'}
            </AuthActionButton>
            <AuthActionButton className={ollamaNeutralClass} onClick={() => void refreshCatalog()} disabled={activeAction === 'catalog'}>
              <RefreshCw className={cn('h-3.5 w-3.5', activeAction === 'catalog' && 'animate-spin')} /> Refresh
            </AuthActionButton>
          </div>
        </div>

        {isCatalogSectionExpanded ? (
          <div className="mt-3 grid gap-3">
            <div className="grid gap-2 rounded-[18px] border border-white/8 bg-black/10 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <label className="min-w-0">
                <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">Exact Ollama model</div>
                <input
                  value={exactModelDraft}
                  onChange={(event) => setExactModelDraft(event.target.value)}
                  placeholder="llama3.2:latest"
                  className="app-input-shell mt-1 h-9 w-full rounded-[12px] px-3 font-mono text-[12px] text-white outline-none"
                  style={nonDragStyle}
                />
              </label>
              <AuthActionButton className={ollamaPrimaryClass} onClick={() => void pullModel(exactModelDraft)} disabled={activeAction === `pull:${normalizeOllamaModelId(exactModelDraft)}`}>
                <Download className="h-3.5 w-3.5" /> {activeAction === `pull:${normalizeOllamaModelId(exactModelDraft)}` ? 'Pulling…' : 'Pull model'}
              </AuthActionButton>
            </div>

            <div className="flex flex-wrap gap-2">
              <div className="relative min-w-[16rem] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter library"
                  className="app-input-shell h-9 w-full rounded-[12px] pl-9 pr-3 text-[12px] text-white outline-none"
                  style={nonDragStyle}
                />
              </div>
              <AuthActionButton className={ollamaNeutralClass} onClick={() => openHelpUrl(OLLAMA_LIBRARY_URL)}>
                <ExternalLink className="h-3.5 w-3.5" /> Library
              </AuthActionButton>
              <AuthActionButton className={ollamaNeutralClass} onClick={() => openHelpUrl(OLLAMA_OPENAI_DOCS_URL)}>
                <Server className="h-3.5 w-3.5" /> OpenAI docs
              </AuthActionButton>
              <AuthActionButton className={ollamaNeutralClass} onClick={() => openHelpUrl(OLLAMA_DOCS_URL)}>
                <Terminal className="h-3.5 w-3.5" /> Docs
              </AuthActionButton>
            </div>

            {catalogError ? (
              <div className="rounded-[18px] border border-amber-300/18 bg-amber-300/[0.075] px-4 py-3 text-[12px] leading-5 text-amber-50">
                {catalogError}
              </div>
            ) : null}

            {catalogModels.length === 0 && activeAction !== 'catalog' ? (
              <div className="rounded-[18px] border border-white/8 bg-black/10 px-4 py-4 text-[12px] leading-5 text-slate-400">
                Load the Ollama library to browse popular chat models, or pull an exact tag above.
              </div>
            ) : null}

            <div className="overflow-hidden rounded-[18px] border border-white/8 bg-black/10">
              {visibleModels.map((model) => {
                const expanded = expandedFamilyIds.has(model.id);
                const loadingVariants = loadingFamilyIds.has(model.id);
                const latestId = normalizeOllamaModelId(model.id);
                const installed = installedIds.has(latestId) || installedIds.has(model.id);
                return (
                  <div key={model.id} className="border-b border-white/6 last:border-b-0">
                    <div className="grid gap-2 px-3.5 py-2.5 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
                      <button type="button" className="min-w-0 text-left" onClick={() => toggleFamily(model.id)}>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-slate-500" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-500" />}
                          <span className="truncate font-mono text-[12px] text-slate-100">{model.id}</span>
                          {installed ? <span className="rounded-full border border-emerald-300/18 bg-emerald-300/[0.08] px-2 py-0.5 text-[10px] font-medium text-emerald-100">Installed</span> : null}
                          {model.pulls ? <span className="rounded-full border border-white/10 bg-white/[0.045] px-2 py-0.5 text-[10px] text-slate-300">{model.pulls} pulls</span> : null}
                        </div>
                        <div className="mt-1 line-clamp-2 text-[11px] leading-5 text-slate-400">{model.description ?? modelSizesLabel(model)}</div>
                        <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-slate-500">
                          <span>{modelSizesLabel(model)}</span>
                          {model.tags ? <span>{model.tags} tags</span> : null}
                        </div>
                      </button>
                      <div className="flex flex-wrap gap-1.5 xl:justify-end">
                        <AuthActionButton className={ollamaNeutralClass} onClick={() => void pullModel(model.id)} disabled={activeAction === `pull:${latestId}`}>
                          <Download className="h-3.5 w-3.5" /> {activeAction === `pull:${latestId}` ? 'Pulling…' : 'Pull latest'}
                        </AuthActionButton>
                        <AuthActionButton className={ollamaNeutralClass} onClick={() => openHelpUrl(model.url)}>
                          <ExternalLink className="h-3.5 w-3.5" /> Details
                        </AuthActionButton>
                      </div>
                    </div>

                    {expanded ? (
                      <div className="border-t border-white/6 bg-white/[0.025] px-3.5 py-2.5">
                        {loadingVariants ? (
                          <div className="text-[11px] text-slate-500">Loading tags…</div>
                        ) : model.variants.length > 0 ? (
                          <div className="grid gap-1.5">
                            {model.variants.map((variant) => (
                              <div key={variant.id} className="grid gap-2 rounded-[14px] border border-white/8 bg-black/10 px-3 py-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                                <div className="min-w-0">
                                  <div className="truncate font-mono text-[11px] text-slate-200">{variant.id}</div>
                                  <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-slate-500">
                                    {variant.size ? <span>{variant.size}</span> : null}
                                    {variant.context ? <span>{variant.context}</span> : null}
                                    {variant.input ? <span>{variant.input}</span> : null}
                                  </div>
                                </div>
                                <div className="flex flex-wrap gap-1.5 lg:justify-end">
                                  <AuthActionButton className={ollamaNeutralClass} onClick={() => void pullModel(variant.id)} disabled={activeAction === `pull:${variant.id}`}>
                                    <Download className="h-3.5 w-3.5" /> {activeAction === `pull:${variant.id}` ? 'Pulling…' : 'Pull'}
                                  </AuthActionButton>
                                  <AuthActionButton className={ollamaNeutralClass} onClick={() => openHelpUrl(variant.url)}>
                                    <ExternalLink className="h-3.5 w-3.5" /> Details
                                  </AuthActionButton>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-500">No chat tags found for this family.</div>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
