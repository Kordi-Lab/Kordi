import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

import type {
  CanvasExportCrop,
  CanvasExportFormat,
  CanvasExportOptions,
} from './download/exportCanvas';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scratchName: string;
  onExport: (options: CanvasExportOptions) => void | Promise<void>;
};

const RADIO_LABEL = 'flex cursor-pointer items-center gap-2 text-[13px] text-slate-200';
const RADIO_INPUT = 'h-3.5 w-3.5 cursor-pointer accent-blue-500';

export function ExportCanvasDialog({ open, onOpenChange, scratchName, onExport }: Props) {
  const [format, setFormat] = useState<CanvasExportFormat>('png');
  const [background, setBackground] = useState(true);
  const [crop, setCrop] = useState<CanvasExportCrop>('content');
  const [padding, setPadding] = useState(16);
  const [busy, setBusy] = useState(false);

  const handleDownload = async () => {
    setBusy(true);
    try {
      await onExport({ format, background, crop, padding });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[color:var(--app-divider)] bg-zinc-900 p-5 text-slate-200 shadow-2xl">
          <Dialog.Title className="mb-1 text-[14px] font-semibold text-white">
            Download canvas
          </Dialog.Title>
          <Dialog.Description className="mb-4 text-[12px] text-slate-400">
            &ldquo;{scratchName}&rdquo;
          </Dialog.Description>

          <div className="space-y-4">
            <Field label="Format">
              <div className="flex gap-4">
                {(['png', 'svg'] as const).map((value) => (
                  <label key={value} className={RADIO_LABEL}>
                    <input
                      type="radio"
                      name="canvas-export-format"
                      value={value}
                      checked={format === value}
                      onChange={() => setFormat(value)}
                      className={RADIO_INPUT}
                    />
                    {value.toUpperCase()}
                  </label>
                ))}
              </div>
            </Field>

            <Field label="Background">
              <label className={RADIO_LABEL}>
                <input
                  type="checkbox"
                  checked={background}
                  onChange={(e) => setBackground(e.target.checked)}
                  className={RADIO_INPUT}
                />
                Include background (transparent if unchecked)
              </label>
            </Field>

            <Field label="Crop">
              <div className="flex flex-col gap-1.5">
                {(
                  [
                    ['content', 'All content (auto bounds)'],
                    ['selection', 'Current selection (falls back to all if nothing selected)'],
                    ['page', 'Whole page'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className={RADIO_LABEL}>
                    <input
                      type="radio"
                      name="canvas-export-crop"
                      value={value}
                      checked={crop === value}
                      onChange={() => setCrop(value)}
                      className={RADIO_INPUT}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </Field>

            <Field label={`Padding · ${padding}px`}>
              <input
                type="range"
                min={0}
                max={64}
                step={1}
                value={padding}
                onChange={(e) => setPadding(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
            </Field>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={busy}
                className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-[12px] text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={handleDownload}
              disabled={busy}
              className="rounded-md border border-blue-500/40 bg-blue-500/20 px-3 py-1.5 text-[12px] font-medium text-blue-100 transition hover:bg-blue-500/30 disabled:opacity-50"
            >
              {busy ? 'Exporting…' : 'Download'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      {children}
    </div>
  );
}
