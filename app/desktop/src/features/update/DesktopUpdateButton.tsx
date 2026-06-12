import type { DesktopUpdateState } from './desktopUpdater';

export type DesktopUpdateButtonProps = {
  state: DesktopUpdateState;
  onUpdate: () => void;
  onRestart: () => void;
  onCancel: () => void;
};

function buttonLabel(state: DesktopUpdateState) {
  if (state.kind === 'downloading') return state.percent === null ? 'Updating' : `${state.percent}%`;
  if (state.kind === 'installing') return 'Installing';
  if (state.kind === 'checking') return 'Checking';
  if (state.kind === 'restarting') return 'Restarting';
  return 'Update';
}

function updateButtonDisabled(state: DesktopUpdateState) {
  return ['checking', 'downloading', 'installing', 'restarting'].includes(state.kind);
}

export function DesktopUpdateButton({ state, onUpdate, onRestart, onCancel }: DesktopUpdateButtonProps) {
  if (state.kind === 'idle') return null;

  if (state.kind === 'ready') {
    return (
      <div className="app-update-ready inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-2 py-1 text-[12px] text-slate-200 shadow-[0_10px_28px_rgba(0,0,0,0.24)]">
        <span className="pl-1 font-medium">Update installed</span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-white/10 px-2.5 py-1 font-semibold text-slate-300 transition hover:border-white/20 hover:text-white"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onRestart}
          className="rounded-full bg-[#2f9bff] px-3 py-1 font-semibold text-white shadow-[0_8px_24px_rgba(47,155,255,0.28)] transition hover:bg-[#58adff]"
        >
          Restart
        </button>
      </div>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div className="app-update-error inline-flex max-w-[360px] items-center gap-2 rounded-full border border-red-400/25 bg-red-500/10 px-2.5 py-1 text-[12px] text-red-100">
        <span className="truncate">{state.message}</span>
        <a className="shrink-0 font-semibold text-white underline decoration-white/30 underline-offset-2" href={state.fallbackUrl} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="app-update-button rounded-full bg-[#2f9bff] px-5 py-2 text-[15px] font-semibold leading-none text-white shadow-[0_8px_24px_rgba(47,155,255,0.28)] transition hover:bg-[#58adff] disabled:cursor-default disabled:opacity-75"
      onClick={onUpdate}
      disabled={updateButtonDisabled(state)}
    >
      {buttonLabel(state)}
    </button>
  );
}
