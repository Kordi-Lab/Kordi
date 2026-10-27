import { useEffect, useMemo, useState } from 'react';

import { qrModules, type QrFactory } from './qrModules';

/** The encoder loads with the first Pair popover, in its own chunk. */
let encoder: QrFactory | null = null;
let loading: Promise<QrFactory> | null = null;
function loadEncoder(): Promise<QrFactory> {
  loading ??= import('qrcode-generator').then((module) => (encoder = module.default));
  return loading;
}

/** A QR code for `value`: dark modules on white with a two-module margin, in every theme. */
export function PairQr({ value }: { value: string | null }) {
  const [factory, setFactory] = useState<QrFactory | null>(() => encoder);
  useEffect(() => {
    if (factory) return undefined;
    let live = true;
    void loadEncoder().then((loaded) => { if (live) setFactory(() => loaded); }, () => undefined);
    return () => { live = false; };
  }, [factory]);
  const modules = useMemo(() => (factory && value ? qrModules(factory, value) : null), [factory, value]);
  return (
    <span className="cg-qr" role="img" aria-label="Your pairing QR code">
      {modules ? (
        <svg viewBox={`-2 -2 ${modules.size + 4} ${modules.size + 4}`} shapeRendering="crispEdges" aria-hidden="true">
          <path d={modules.d} fill="#111" />
        </svg>
      ) : null}
    </span>
  );
}
