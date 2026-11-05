import { useId } from 'react';
import { Unplug } from 'lucide-react';

type ProviderConnectTrayProps = {
  /** True while no provider can run the agent; the tray renders nothing otherwise. */
  needsProvider: boolean;
  /** Opens the same authentication surface as the composer's sign-in control. */
  onConnect: () => void;
};

/** A slim tray attached to the top edge of the composer while no model is connected. */
export function ProviderConnectTray({ needsProvider, onConnect }: ProviderConnectTrayProps) {
  const textId = useId();
  if (!needsProvider) return null;
  return (
    <div className="app-composer-provider-tray" role="status" data-provider-connect-tray="true">
      <Unplug className="app-composer-provider-tray-icon" aria-hidden="true" />
      <span id={textId} className="app-composer-provider-tray-text">Connect a model to start</span>
      <button
        type="button"
        className="app-composer-provider-tray-action"
        aria-describedby={textId}
        onClick={onConnect}
      >
        Connect
      </button>
    </div>
  );
}
