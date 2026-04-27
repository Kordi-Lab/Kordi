import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Circle, Download, ExternalLink, PlayCircle, RefreshCw, Search, Server, Square, Terminal } from 'lucide-react';

import {
  fetchLmStudioCatalogModelsDesktop,
  fetchLmStudioEnvironmentDesktop,
  fetchLmStudioInstalledModelsDesktop,
  fetchLmStudioLoadedModelIdsDesktop,
  fetchLmStudioServerStatusDesktop,
  getLmStudioModelDesktop,
  installLmStudioDesktop,
  loadLmStudioModelDesktop,
  openDesktopExternalUrl,
  openLmStudioAppDesktop,
  repairLmStudioCliPathDesktop,
  setDesktopLocalProviderPort,
  startLmStudioServerDesktop,
  stopLmStudioModelDesktop,
  stopLmStudioServerDesktop,
  type DesktopLmStudioCatalogModel,
  type DesktopLmStudioCatalogVariant,
  type DesktopLmStudioCommandResult,
  type DesktopLmStudioEnvironment,
  type DesktopLmStudioInstalledModel,
  type DesktopLmStudioServerStatus,
} from '@/lib/desktop';
import { cn } from '@/lib/utils';
import {
  AuthActionButton,
  nonDragStyle,
} from './AuthDetailPrimitives';

type LmStudioModelControlCenterProps = {
  endpoint: string;
  port: string;
  onRefreshAuth: () => void | Promise<void>;
  onSaved?: () => void;
  onEnterChat?: (preferredModelValue?: string) => void | Promise<void>;
};

type LmStudioAction =
  | 'catalog'
  | 'install'
  | 'server-start'
  | 'server-stop'
  | `get:${string}`
  | `load:${string}`
  | `stop:${string}`;

const LM_STUDIO_CATALOG_URL = 'https://lmstudio.ai/models';

const flatButtonShapeClass = '!h-8 !rounded-[10px] !px-3 shadow-none';

const modelControlPrimaryClass =
  `${flatButtonShapeClass} border border-emerald-300/24 bg-emerald-300/[0.09] text-emerald-50 hover:border-emerald-200/34 hover:bg-emerald-300/[0.13]`;

const modelControlNeutralClass =
  `${flatButtonShapeClass} border border-white/8 bg-white/[0.035] text-slate-200 hover:border-white/14 hover:bg-white/[0.06]`;

const modelControlStopClass =
  `${flatButtonShapeClass} border border-amber-300/18 bg-amber-300/[0.055] text-amber-50 hover:border-amber-200/26 hover:bg-amber-300/[0.08]`;

function openHelpUrl(url: string) {
  void openDesktopExternalUrl(url).catch((error) => {
    console.error('Unable to open LM Studio help URL', error);
  });
}

function resultSummary(result: DesktopLmStudioCommandResult) {
  const output = result.stdout.trim() || result.stderr.trim();
  if (!output) return `${result.command} finished successfully.`;
  return output.split('\n').slice(-3).join(' ');
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

function modelSizesLabel(model: DesktopLmStudioCatalogModel) {
  if (model.sizes.length === 0) return `${model.variants.length} variants`;
  if (model.sizes.length <= 5) return model.sizes.join(' · ');
  return `${model.sizes.slice(0, 5).join(' · ')} · +${model.sizes.length - 5}`;
}

function compactPath(value?: string | null) {
  if (!value) return 'Not found';
  return value.replace(/^\/Users\/[^/]+/, '~');
}

function modelToneClass(index: number) {
  const classes = [
    'border-emerald-300/18 bg-emerald-300/[0.055] text-emerald-100',
    'border-sky-300/18 bg-sky-300/[0.055] text-sky-100',
    'border-amber-300/18 bg-amber-300/[0.055] text-amber-100',
    'border-violet-300/18 bg-violet-300/[0.055] text-violet-100',
  ];
  return classes[index % classes.length];
}

function familyMatchesQuery(model: DesktopLmStudioCatalogModel, normalized: string) {
  if (!normalized) return true;
  return [model.name, model.id, model.sizes.join(' '), model.updated ?? '']
    .some((value) => value.toLowerCase().includes(normalized));
}

function variantMatchesQuery(variant: DesktopLmStudioCatalogVariant, normalized: string) {
  if (!normalized) return true;
  return `${variant.id} ${variant.size ?? ''}`.toLowerCase().includes(normalized);
}

function modelMatchesQuery(model: DesktopLmStudioCatalogModel, normalized: string) {
  return familyMatchesQuery(model, normalized) || model.variants.some((variant) => variantMatchesQuery(variant, normalized));
}

function visibleVariants(model: DesktopLmStudioCatalogModel, expanded: boolean, normalizedQuery: string) {
  if (!expanded && !normalizedQuery) return [];
  if (!normalizedQuery || familyMatchesQuery(model, normalizedQuery)) return model.variants;
  return model.variants.filter((variant) => variantMatchesQuery(variant, normalizedQuery));
}

export function LmStudioModelControlCenter({
  endpoint,
  port,
  onRefreshAuth,
  onSaved,
  onEnterChat,
}: LmStudioModelControlCenterProps) {
  const [query, setQuery] = useState('');
  const [catalogModels, setCatalogModels] = useState<DesktopLmStudioCatalogModel[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<DesktopLmStudioEnvironment | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [isCheckingSetup, setIsCheckingSetup] = useState(false);
  const [isRepairingCliPath, setIsRepairingCliPath] = useState(false);
  const [isOpeningApp, setIsOpeningApp] = useState(false);
  const [isSavingConnection, setIsSavingConnection] = useState(false);
  const [serverStatus, setServerStatus] = useState<DesktopLmStudioServerStatus | null>(null);
  const [serverStatusError, setServerStatusError] = useState<string | null>(null);
  const [installedModels, setInstalledModels] = useState<DesktopLmStudioInstalledModel[]>([]);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [expandedFamilyIds, setExpandedFamilyIds] = useState<Set<string>>(() => new Set());
  const [isInstalledSectionExpanded, setIsInstalledSectionExpanded] = useState(true);
  const [isCatalogSectionExpanded, setIsCatalogSectionExpanded] = useState(false);
  const [isSetupDetailsExpanded, setIsSetupDetailsExpanded] = useState(false);
  const [runningVariantIds, setRunningVariantIds] = useState<Set<string>>(() => new Set());
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [activeAction, setActiveAction] = useState<LmStudioAction | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const endpointConfigured = endpoint.trim().length > 0;
  const normalizedQuery = query.trim().toLowerCase();

  const refreshCatalog = async () => {
    try {
      setActiveAction('catalog');
      setCatalogError(null);
      const models = await fetchLmStudioCatalogModelsDesktop();
      setCatalogModels(models);
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : 'Unable to fetch LM Studio catalog.');
    } finally {
      setActiveAction(null);
    }
  };

  const refreshEnvironment = async () => {
    try {
      setIsCheckingSetup(true);
      setSetupError(null);
      const snapshot = await fetchLmStudioEnvironmentDesktop();
      setEnvironment(snapshot);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Unable to inspect LM Studio setup.');
    } finally {
      setIsCheckingSetup(false);
    }
  };

  const refreshInstalledModels = async () => {
    try {
      setInstalledError(null);
      const models = await fetchLmStudioInstalledModelsDesktop();
      setInstalledModels(models);
    } catch (error) {
      setInstalledError(error instanceof Error ? error.message : 'Unable to read installed LM Studio models.');
    }
  };

  const refreshServerStatus = async () => {
    try {
      setServerStatusError(null);
      const status = await fetchLmStudioServerStatusDesktop();
      setServerStatus(status);
      return status;
    } catch (error) {
      setServerStatus(null);
      setServerStatusError(error instanceof Error ? error.message : 'Unable to read LM Studio server status.');
      return null;
    }
  };

  const refreshRunningModels = async () => {
    if (!endpointConfigured) return runningVariantIds;
    try {
      const loadedModelIds = await fetchLmStudioLoadedModelIdsDesktop(endpoint);
      const next = new Set(loadedModelIds);
      setRunningVariantIds(next);
      return next;
    } catch (error) {
      console.debug('Unable to refresh LM Studio loaded models', error);
      return runningVariantIds;
    }
  };

  useEffect(() => {
    void refreshEnvironment();
    void refreshCatalog();
    void refreshInstalledModels();
    void refreshServerStatus();
  }, []);

  useEffect(() => {
    void refreshRunningModels();
    void refreshServerStatus();
  }, [endpoint, endpointConfigured]);

  const visibleModels = useMemo(() => catalogModels.filter((model) => modelMatchesQuery(model, normalizedQuery)), [catalogModels, normalizedQuery]);
  const totalVariantCount = useMemo(() => catalogModels.reduce((sum, model) => sum + model.variants.length, 0), [catalogModels]);
  const visibleVariantCount = useMemo(
    () => visibleModels.reduce((sum, model) => sum + visibleVariants(model, true, normalizedQuery).length, 0),
    [normalizedQuery, visibleModels],
  );
  const installedModelIds = useMemo(() => new Set(installedModels.map((model) => model.id)), [installedModels]);
  const variantDetailsById = useMemo(() => {
    const details = new Map<string, { family: DesktopLmStudioCatalogModel; variant: DesktopLmStudioCatalogVariant }>();
    for (const family of catalogModels) {
      for (const variant of family.variants) {
        details.set(variant.id, { family, variant });
      }
    }
    return details;
  }, [catalogModels]);

  const runLmStudioAction = async (
    action: LmStudioAction,
    run: () => Promise<DesktopLmStudioCommandResult>,
    successPrefix: string,
    onSuccess?: () => void,
  ) => {
    try {
      setActiveAction(action);
      setActionError(null);
      setActionMessage(`${successPrefix}…`);
      const result = await run();
      setActionMessage(resultSummary(result));
      onSuccess?.();
      if (action.startsWith('get:') || action.startsWith('remove:')) {
        void refreshInstalledModels();
      }
      if (action.startsWith('load:') || action.startsWith('stop:') || action.startsWith('remove:')) {
        onRefreshAuth();
        void refreshRunningModels();
      }
    } catch (error) {
      setActionMessage(null);
      setActionError(error instanceof Error ? error.message : `Unable to run ${successPrefix.toLowerCase()}.`);
      if (action.startsWith('load:') || action.startsWith('stop:') || action.startsWith('remove:')) {
        void refreshRunningModels();
      }
    } finally {
      setActiveAction(null);
    }
  };

  const installLmStudio = async () => {
    if (!confirmInstall) {
      setConfirmInstall(true);
      setActionError(null);
      setActionMessage('Click Confirm install/update to run the official LM Studio installer helper on this Mac.');
      return;
    }

    setConfirmInstall(false);
    await runLmStudioAction('install', installLmStudioDesktop, 'Installing LM Studio', () => {
      void refreshEnvironment();
      void refreshInstalledModels();
    });
  };

  const openLmStudioApp = async () => {
    try {
      setIsOpeningApp(true);
      setActionError(null);
      const result = await openLmStudioAppDesktop();
      setActionMessage(resultSummary(result));
      window.setTimeout(() => {
        void refreshEnvironment();
        void refreshInstalledModels();
      }, 2000);
    } catch (error) {
      setActionMessage(null);
      setActionError(error instanceof Error ? error.message : 'Unable to open LM Studio.');
    } finally {
      setIsOpeningApp(false);
    }
  };

  const repairCliPath = async () => {
    try {
      setIsRepairingCliPath(true);
      setActionError(null);
      const result = await repairLmStudioCliPathDesktop();
      setActionMessage(resultSummary(result));
      await refreshEnvironment();
      await refreshInstalledModels();
    } catch (error) {
      setActionMessage(null);
      setActionError(error instanceof Error ? error.message : 'Unable to add lms to PATH.');
    } finally {
      setIsRepairingCliPath(false);
    }
  };

  const startLocalServer = async () => {
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setActionMessage(null);
      setActionError('LM Studio port must be between 1 and 65535.');
      return null;
    }

    try {
      setActiveAction('server-start');
      setActionError(null);
      setActionMessage(`Starting LM Studio local server on port ${parsedPort}…`);
      const result = await startLmStudioServerDesktop(parsedPort);
      setActionMessage(resultSummary(result));
      const status = await refreshServerStatus();
      void refreshRunningModels();
      return status;
    } catch (error) {
      setActionMessage(null);
      setActionError(error instanceof Error ? error.message : 'Unable to start LM Studio local server.');
      void refreshServerStatus();
      return null;
    } finally {
      setActiveAction(null);
    }
  };

  const stopLocalServer = async () => {
    try {
      setActiveAction('server-stop');
      setActionError(null);
      setActionMessage('Stopping LM Studio local server…');
      const result = await stopLmStudioServerDesktop();
      setActionMessage(resultSummary(result));
      const status = await refreshServerStatus();
      return status;
    } catch (error) {
      setActionMessage(null);
      setActionError(error instanceof Error ? error.message : 'Unable to stop LM Studio local server.');
      void refreshServerStatus();
      return null;
    } finally {
      setActiveAction(null);
    }
  };

  const ensureLocalServerRunning = async () => {
    const status = await refreshServerStatus();
    if (status?.running) return true;
    const nextStatus = await startLocalServer();
    return nextStatus?.running ?? false;
  };

  const saveConnection = async (preferredModelId?: string | null) => {
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setActionMessage(null);
      setActionError('LM Studio port must be between 1 and 65535.');
      return;
    }

    try {
      setIsSavingConnection(true);
      setActionError(null);
      const selectedModelId = preferredModelId ?? firstRunningModelId();
      const serverReady = await ensureLocalServerRunning();
      if (!serverReady) {
        throw new Error('LM Studio has a loaded model, but its local server is not running. Start the local server, then save again.');
      }
      await setDesktopLocalProviderPort('lm-studio', parsedPort, selectedModelId);
      await Promise.resolve(onRefreshAuth());
      setActionMessage(onEnterChat || onSaved ? 'LM Studio saved. Opening chat…' : 'LM Studio connection saved.');
      if (onEnterChat) await onEnterChat(selectedModelId ? `lm-studio/${selectedModelId}` : undefined);
      else onSaved?.();
    } catch (error) {
      setActionMessage(null);
      setActionError(error instanceof Error ? error.message : 'Unable to save LM Studio connection.');
    } finally {
      setIsSavingConnection(false);
    }
  };

  const getVariant = async (variant: DesktopLmStudioCatalogVariant) => {
    await runLmStudioAction(
      `get:${variant.id}`,
      () => getLmStudioModelDesktop(variant.id),
      `Getting ${variant.id}`,
      () => setInstalledModels((current) => current.some((model) => model.id === variant.id)
        ? current
        : [...current, { id: variant.id, name: variant.name, size: variant.size }]),
    );
  };

  const isVariantRunning = (variantId: string) => runningVariantIds.has(variantId);

  const toggleInstalledModelRuntime = async (modelId: string) => {
    const latestRunningIds = await refreshRunningModels();
    if (latestRunningIds.has(modelId)) {
      await runLmStudioAction(
        `stop:${modelId}`,
        () => stopLmStudioModelDesktop(modelId),
        `Stopping ${modelId}`,
        () => setRunningVariantIds((current) => {
          const next = new Set(current);
          next.delete(modelId);
          return next;
        }),
      );
      return;
    }

    await runLmStudioAction(
      `load:${modelId}`,
      () => loadLmStudioModelDesktop(modelId),
      `Running ${modelId}`,
      () => setRunningVariantIds((current) => new Set(current).add(modelId)),
    );
  };

  const firstRunningModelId = () => installedModels.find((model) => isVariantRunning(model.id))?.id
    ?? Array.from(runningVariantIds)[0]
    ?? null;

  const toggleFamily = (familyId: string) => {
    setExpandedFamilyIds((current) => {
      const next = new Set(current);
      if (next.has(familyId)) next.delete(familyId);
      else next.add(familyId);
      return next;
    });
  };

  const catalogSummary = activeAction === 'catalog'
    ? 'Refreshing catalog…'
    : `${visibleModels.length} of ${catalogModels.length} families · ${visibleVariantCount} of ${totalVariantCount} variants`;
  const activeRunningModelId = firstRunningModelId();
  const appReady = Boolean(environment?.appPath);
  const cliReady = Boolean(environment?.cliPath);
  const serverRunning = serverStatus?.running ?? false;
  const hasInstalledModels = installedModels.length > 0;
  const hasRunningModel = Boolean(activeRunningModelId);
  const firstInstalledModelId = installedModels[0]?.id ?? null;
  const readinessSteps = [
    {
      label: 'App + CLI',
      detail: cliReady ? 'lms resolved' : appReady ? 'add lms path' : 'install app',
      complete: cliReady,
      active: !cliReady,
    },
    {
      label: 'Local server',
      detail: serverRunning ? `port ${port}` : 'start server',
      complete: serverRunning,
      active: cliReady && !serverRunning,
    },
    {
      label: 'Installed model',
      detail: hasInstalledModels ? `${installedModels.length} local` : 'get variant',
      complete: hasInstalledModels,
      active: cliReady && serverRunning && !hasInstalledModels,
    },
    {
      label: 'Running model',
      detail: activeRunningModelId ?? 'load best context',
      complete: hasRunningModel,
      active: cliReady && serverRunning && hasInstalledModels && !hasRunningModel,
    },
  ];
  const primaryActionLabel = !environment
    ? 'Check setup'
    : !appReady
      ? confirmInstall ? 'Confirm install/update' : 'Install LM Studio'
      : !cliReady
        ? 'Add lms to PATH'
        : !serverRunning
          ? 'Start local server'
          : !hasInstalledModels
            ? 'Browse catalog'
            : !hasRunningModel
              ? 'Run installed model'
              : onEnterChat || onSaved ? 'Save & enter chat' : 'Save LM Studio';
  const primaryActionDetail = !environment
    ? 'Verify app, CLI, and local paths.'
    : !appReady
      ? 'Install or update LM Studio from the official helper.'
      : !cliReady
        ? 'Make Kordi able to run lms without Terminal.'
        : !serverRunning
          ? `Start the OpenAI-compatible endpoint on port ${port}.`
          : !hasInstalledModels
            ? 'Open the catalog and choose an exact variant to get.'
            : !hasRunningModel
              ? 'Load the first installed model with the best supported context.'
              : `Ready to chat with ${activeRunningModelId}.`;
  const primaryActionDisabled = isSavingConnection
    || isCheckingSetup
    || isRepairingCliPath
    || isOpeningApp
    || activeAction === 'install'
    || activeAction === 'server-start'
    || Boolean(firstInstalledModelId && activeAction === `load:${firstInstalledModelId}`);
  const runPrimaryAction = () => {
    if (!environment) {
      void refreshEnvironment();
      return;
    }
    if (!appReady) {
      void installLmStudio();
      return;
    }
    if (!cliReady) {
      void repairCliPath();
      return;
    }
    if (!serverRunning) {
      void startLocalServer();
      return;
    }
    if (!hasInstalledModels) {
      setIsCatalogSectionExpanded(true);
      setActionError(null);
      setActionMessage('Catalog opened. Choose a family, then Get an exact model variant.');
      return;
    }
    if (!hasRunningModel && firstInstalledModelId) {
      void toggleInstalledModelRuntime(firstInstalledModelId);
      return;
    }
    void saveConnection(activeRunningModelId);
  };

  return (
    <div className="space-y-3.5 px-4 py-3.5">
      <div className="overflow-hidden rounded-[24px] border border-white/8 bg-[linear-gradient(140deg,rgba(54,49,39,0.72),rgba(22,24,22,0.76)_52%,rgba(16,18,20,0.9))] shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_18px_36px_rgba(0,0,0,0.18)]">
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.06fr)_minmax(280px,0.94fr)]">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.055] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300">
              <Server className="h-3.5 w-3.5" /> LM Studio authentication
            </div>
            <div className="mt-3 max-w-[16rem] text-[21px] font-semibold leading-7 tracking-[-0.04em] text-white sm:max-w-[30rem]">
              One local model, loaded correctly, ready for Kordi chat.
            </div>
            <div className="mt-2 max-w-[62ch] text-[12px] leading-5 text-slate-300">
              Kordi treats LM Studio like a local chat provider: resolve <span className="font-mono text-slate-100">lms</span>, start the server, install an exact variant, then run it with the best supported context instead of the 4k default.
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <AuthActionButton className={modelControlPrimaryClass} onClick={runPrimaryAction} disabled={primaryActionDisabled}>
                <CheckCircle2 className="h-3.5 w-3.5" /> {primaryActionLabel}
              </AuthActionButton>
            </div>
            <div className="mt-3 rounded-[16px] border border-white/8 bg-white/[0.04] px-3 py-2 text-[11px] leading-5 text-slate-300">
              <span className="font-medium text-slate-100">Next:</span> {primaryActionDetail}
            </div>
            {(actionMessage || actionError) ? (
              <div className={cn(
                'mt-2 rounded-[16px] border px-3 py-2 text-[11px] leading-5',
                actionError
                  ? 'border-rose-300/20 bg-rose-400/[0.08] text-rose-100'
                  : 'border-white/10 bg-white/[0.045] text-slate-200',
              )}
              >
                {actionError ?? actionMessage}
              </div>
            ) : null}
          </div>

          <div className="rounded-[20px] border border-white/8 bg-black/15 p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[12px] font-medium text-white">Current runtime</div>
                <div className="mt-1 text-[11px] leading-5 text-slate-400">Kordi uses this OpenAI-compatible endpoint for chat and checks running models with lms.</div>
              </div>
              <RuntimeStatusPill running={serverStatus?.running ?? false} />
            </div>
            <div className="mt-3 rounded-[16px] border border-white/8 bg-white/[0.045] px-3 py-2 font-mono text-[11px] text-slate-200">
              {endpoint || `http://localhost:${port}/v1`}
            </div>
            <div className={cn(
              'mt-2 rounded-[14px] border px-3 py-2 text-[11px] leading-5',
              serverStatus?.running
                ? 'border-emerald-300/16 bg-emerald-300/[0.055] text-emerald-100/90'
                : 'border-amber-300/16 bg-amber-300/[0.06] text-amber-100/90',
            )}
            >
              {serverStatusError ?? serverStatus?.detail ?? 'Check whether LM Studio’s local server is running before chatting.'}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <RuntimeMetric label="Port" value={port} />
              <RuntimeMetric label="Discovery" value="/v1/models" />
              <div className="col-span-2">
                <RuntimeMetric label="Active local model" value={activeRunningModelId ?? 'No model running'} />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap justify-end gap-1.5">
              <AuthActionButton
                className={modelControlNeutralClass}
                onClick={() => {
                  onRefreshAuth();
                  void refreshRunningModels();
                  void refreshServerStatus();
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Refresh status
              </AuthActionButton>
              <AuthActionButton
                className={serverStatus?.running ? modelControlStopClass : modelControlPrimaryClass}
                onClick={() => {
                  if (serverStatus?.running) void stopLocalServer();
                  else void startLocalServer();
                }}
                disabled={activeAction === 'server-start' || activeAction === 'server-stop'}
              >
                {serverStatus?.running ? <Square className="h-3.5 w-3.5" /> : <Server className="h-3.5 w-3.5" />}
                {activeAction === 'server-start'
                  ? 'Starting server…'
                  : activeAction === 'server-stop'
                    ? 'Stopping server…'
                    : serverStatus?.running ? 'Stop server' : 'Start local server'}
              </AuthActionButton>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {readinessSteps.map((step) => (
          <ReadinessStep
            key={step.label}
            label={step.label}
            detail={step.detail}
            complete={step.complete}
            active={step.active}
          />
        ))}
      </div>

      <div className="rounded-[22px] border border-white/8 bg-white/[0.04] p-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium text-white">LM Studio setup</div>
              <div className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                environment?.cliPath ? 'border-emerald-300/18 bg-emerald-300/[0.08] text-emerald-100' : 'border-amber-300/18 bg-amber-300/[0.08] text-amber-100',
              )}
              >
                {environment?.cliPath ? 'CLI ready' : 'CLI missing'}
              </div>
              {environment?.cliInShellPath ? <div className="rounded-full border border-sky-300/18 bg-sky-300/[0.07] px-2 py-0.5 text-[10px] text-sky-100">PATH configured</div> : null}
            </div>
            <div className="mt-1 max-w-[72ch] text-[11px] leading-5 text-slate-400">
              LM Studio ships <span className="font-mono text-slate-300">lms</span>, but macOS apps do not always inherit your Terminal PATH. Kordi checks the app, LM Studio home, CLI path, and shell PATH here.
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <AuthActionButton className={modelControlNeutralClass} onClick={refreshEnvironment} disabled={isCheckingSetup}>
              <RefreshCw className="h-3.5 w-3.5" /> {isCheckingSetup ? 'Checking…' : 'Check setup'}
            </AuthActionButton>
            <AuthActionButton className={modelControlNeutralClass} onClick={openLmStudioApp} disabled={isOpeningApp}>
              <ExternalLink className="h-3.5 w-3.5" /> {isOpeningApp ? 'Opening…' : 'Open LM Studio'}
            </AuthActionButton>
            <AuthActionButton className={modelControlNeutralClass} onClick={repairCliPath} disabled={isRepairingCliPath}>
              <Terminal className="h-3.5 w-3.5" /> {isRepairingCliPath ? 'Adding…' : 'Add lms to PATH'}
            </AuthActionButton>
            <AuthActionButton className={modelControlNeutralClass} onClick={() => setIsSetupDetailsExpanded((value) => !value)}>
              {isSetupDetailsExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {isSetupDetailsExpanded ? 'Hide details' : 'Details'}
            </AuthActionButton>
          </div>
        </div>

        {isSetupDetailsExpanded ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <div className="rounded-[16px] border border-white/8 bg-black/10 px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">LM Studio app</div>
            <div className="mt-1 break-all font-mono text-[11px] text-slate-200">{compactPath(environment?.appPath)}</div>
            {environment?.appVersion ? <div className="mt-1 text-[10px] text-slate-500">Version {environment.appVersion}</div> : null}
          </div>
          <div className="rounded-[16px] border border-white/8 bg-black/10 px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">lms CLI</div>
            <div className="mt-1 break-all font-mono text-[11px] text-slate-200">{compactPath(environment?.cliPath)}</div>
            <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-slate-500">
              {environment?.cliVersion ? <span>Version {environment.cliVersion}</span> : null}
              {environment?.cliSource ? <span>Source {environment.cliSource}</span> : null}
            </div>
          </div>
          <div className="rounded-[16px] border border-white/8 bg-black/10 px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">LM Studio home</div>
            <div className="mt-1 break-all font-mono text-[11px] text-slate-200">{compactPath(environment?.homePath)}</div>
            {environment?.binPath ? <div className="mt-1 break-all font-mono text-[10px] text-slate-500">bin {compactPath(environment.binPath)}</div> : null}
          </div>
          <div className="rounded-[16px] border border-white/8 bg-black/10 px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">Shell PATH</div>
            <div className="mt-1 text-[11px] text-slate-200">{environment?.cliInShellPath ? 'lms is available from shell PATH' : 'lms is not in shell PATH yet'}</div>
            {environment?.shellConfigPaths.length ? <div className="mt-1 break-all font-mono text-[10px] text-slate-500">{environment.shellConfigPaths.map(compactPath).join(' · ')}</div> : null}
          </div>
        </div>
        ) : null}

        {(setupError || environment?.notes.length) ? (
          <div className="mt-3 rounded-[16px] border border-amber-300/18 bg-amber-300/[0.07] px-3 py-2 text-[11px] leading-5 text-amber-50/90">
            {setupError ?? environment?.notes.join(' ')}
          </div>
        ) : null}
      </div>

      <div className="rounded-[22px] border border-emerald-300/12 bg-emerald-300/[0.035] p-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium text-white">Installed locally</div>
              <div className="rounded-full border border-emerald-300/18 bg-emerald-300/[0.07] px-2 py-0.5 text-[10px] text-emerald-100">{installedModels.length} models</div>
            </div>
            <div className="mt-1 max-w-[72ch] text-[11px] leading-5 text-slate-400">
              This list comes from <span className="font-mono text-slate-300">lms ls --json</span>. Run clears stale LM Studio instances, then reloads with the best supported context length.
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <AuthActionButton
              className={modelControlNeutralClass}
              onClick={() => setIsInstalledSectionExpanded((value) => !value)}
            >
              {isInstalledSectionExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {isInstalledSectionExpanded ? 'Hide models' : `Show ${installedModels.length || 'installed'} models`}
            </AuthActionButton>
            <AuthActionButton
              className={modelControlNeutralClass}
              onClick={() => {
                void refreshInstalledModels();
                void refreshRunningModels();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh installed
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
            const running = isVariantRunning(model.id);
            const runtimeAction = running ? `stop:${model.id}` : `load:${model.id}`;
            const catalogDetail = variantDetailsById.get(model.id);
            return (
              <div key={model.id} className="grid gap-2 border-b border-white/6 px-3.5 py-2.5 last:border-b-0 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="truncate font-mono text-[12px] text-slate-100">{model.id}</div>
                    <span className="rounded-full border border-emerald-300/18 bg-emerald-300/[0.08] px-2 py-0.5 text-[10px] font-medium text-emerald-100">Installed</span>
                    {running ? <span className="rounded-full border border-amber-300/18 bg-amber-300/[0.08] px-2 py-0.5 text-[10px] font-medium text-amber-100">Running</span> : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                    {model.size ?? catalogDetail?.variant.size ? <span>{model.size ?? catalogDetail?.variant.size}</span> : null}
                    {catalogDetail ? <span>{catalogDetail.family.name}</span> : null}
                    {model.architecture ? <span>{model.architecture}</span> : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 xl:justify-end">
                  <AuthActionButton
                    className={running ? modelControlStopClass : modelControlNeutralClass}
                    onClick={() => toggleInstalledModelRuntime(model.id)}
                    disabled={activeAction === runtimeAction}
                    title={running ? 'Running — click to stop' : 'Run this installed model'}
                  >
                    {running ? <Square className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
                    {activeAction === `load:${model.id}` ? 'Running…' : activeAction === `stop:${model.id}` ? 'Stopping…' : running ? 'Running' : 'Run'}
                  </AuthActionButton>
                  <AuthActionButton className={modelControlNeutralClass} onClick={() => openHelpUrl(catalogDetail?.variant.url ?? LM_STUDIO_CATALOG_URL)}>
                    <ExternalLink className="h-3.5 w-3.5" /> Details
                  </AuthActionButton>
                </div>
              </div>
            );
          }) : (
            <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0 text-[12px] leading-5 text-slate-400">
                <div className="font-medium text-slate-200">No installed LM Studio models yet.</div>
                <div className="mt-1">Open the catalog, expand a family, and click Get on the exact variant you want Kordi to run.</div>
              </div>
              <AuthActionButton
                className={modelControlNeutralClass}
                onClick={() => setIsCatalogSectionExpanded(true)}
              >
                <Search className="h-3.5 w-3.5" /> Browse catalog
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
              <div className="text-[13px] font-medium text-white">Full LM Studio model catalog</div>
              <div className="rounded-full border border-white/10 bg-white/[0.045] px-2 py-0.5 text-[10px] text-slate-300">{catalogSummary}</div>
            </div>
            <div className="mt-1 max-w-[72ch] text-[11px] leading-5 text-slate-400">
              Families stay folded by default. Catalog rows install variants; runtime controls live in the Installed locally list.
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <AuthActionButton className={modelControlNeutralClass} onClick={() => setIsCatalogSectionExpanded((value) => !value)}>
              {isCatalogSectionExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {isCatalogSectionExpanded ? 'Hide catalog' : 'Show catalog'}
            </AuthActionButton>
            <AuthActionButton className={modelControlNeutralClass} onClick={refreshCatalog} disabled={activeAction === 'catalog'}>
              <RefreshCw className="h-3.5 w-3.5" /> {activeAction === 'catalog' ? 'Refreshing…' : 'Refresh catalog'}
            </AuthActionButton>
            <AuthActionButton className={modelControlNeutralClass} onClick={() => openHelpUrl(LM_STUDIO_CATALOG_URL)}>
              <Search className="h-3.5 w-3.5" /> Open catalog
            </AuthActionButton>
          </div>
        </div>

        {isCatalogSectionExpanded ? (
          <>
        <div className="mt-3 flex items-center gap-2 rounded-[17px] border border-white/8 bg-black/10 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-slate-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search families or variants, e.g. gemma-4-e4b…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-white outline-none placeholder:text-slate-500"
            style={nonDragStyle}
          />
        </div>

        {catalogError ? (
          <div className="mt-3 rounded-[18px] border border-rose-300/20 bg-rose-400/[0.08] px-4 py-3 text-[12px] leading-5 text-rose-100">
            {catalogError}
          </div>
        ) : null}

        <div className="mt-3 grid gap-2.5">
          {visibleModels.length > 0 ? visibleModels.map((model, index) => {
            const expanded = expandedFamilyIds.has(model.id);
            const variants = visibleVariants(model, expanded, normalizedQuery);
            return (
              <div key={model.id} className="overflow-hidden rounded-[19px] border border-white/8 bg-[color:var(--app-control-bg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
                <div className="px-3.5 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[13px] font-medium text-white">{model.name}</div>
                        <div className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium', modelToneClass(index))}>{modelSizesLabel(model)}</div>
                        <div className="rounded-full border border-white/8 bg-white/[0.035] px-2 py-0.5 text-[10px] text-slate-400">{model.variants.length} variants</div>
                        {model.updated ? <div className="text-[10px] text-slate-500">{model.updated}</div> : null}
                      </div>
                      <div className="mt-1 text-[11px] leading-5 text-slate-400">
                        Family id <span className="font-mono text-slate-300">{model.id}</span>. Expand to choose the exact model variant.
                      </div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {!normalizedQuery ? (
                        <AuthActionButton className={modelControlNeutralClass} onClick={() => toggleFamily(model.id)}>
                          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          {expanded ? 'Hide variants' : `Show ${model.variants.length === 1 ? 'variant' : `${model.variants.length} variants`}`}
                        </AuthActionButton>
                      ) : null}
                      <AuthActionButton className={modelControlNeutralClass} onClick={() => openHelpUrl(model.url)}>
                        <ExternalLink className="h-3.5 w-3.5" /> Family details
                      </AuthActionButton>
                    </div>
                  </div>
                </div>
                {expanded || normalizedQuery ? (
                  <div className="border-t border-white/8">
                    {variants.length > 0 ? variants.map((variant) => {
                      const installed = installedModelIds.has(variant.id);
                      return (
                        <div key={variant.id} className="grid gap-2 border-b border-white/6 px-3.5 py-2.5 last:border-b-0 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate font-mono text-[12px] text-slate-100">{variant.id}</div>
                              {installed ? <span className="rounded-full border border-emerald-300/18 bg-emerald-300/[0.08] px-2 py-0.5 text-[10px] font-medium text-emerald-100">Installed</span> : null}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                              {variant.size ? <span>{variant.size}</span> : <span>Size from LM Studio</span>}
                              <span>Exact model variant</span>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1.5 xl:justify-end">
                            <AuthActionButton className={installed ? modelControlNeutralClass : modelControlPrimaryClass} onClick={() => getVariant(variant)} disabled={installed || activeAction === `get:${variant.id}`}>
                              {installed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                              {activeAction === `get:${variant.id}` ? 'Getting…' : installed ? 'Installed' : 'Get'}
                            </AuthActionButton>
                            <AuthActionButton className={modelControlNeutralClass} onClick={() => openHelpUrl(variant.url)}>
                              <ExternalLink className="h-3.5 w-3.5" /> Details
                            </AuthActionButton>
                          </div>
                        </div>
                      );
                    }) : (
                      <div className="px-3.5 py-3 text-[11px] text-slate-500">No variants matched this search.</div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          }) : (
            <div className="rounded-[18px] border border-white/8 bg-white/[0.035] px-4 py-4 text-[12px] text-slate-400">
              {activeAction === 'catalog' ? 'Loading LM Studio catalog…' : `No LM Studio catalog models match “${query}”.`}
            </div>
          )}
        </div>
          </>
        ) : null}
      </div>

    </div>
  );
}
