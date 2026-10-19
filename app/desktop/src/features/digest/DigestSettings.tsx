import { useEffect, useState } from 'react';
import { digestClient } from './client';
import type { DigestSettings as Settings } from './types';

const THINKING = [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] as const;

/** The digest model choice and a full rebuild. */
export function DigestSettings({ accountId, onRebuilt }: { accountId: string; onRebuilt: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    digestClient.settings(accountId).then(value => { if (!cancelled) setSettings(value); })
      .catch(() => { if (!cancelled) setError('Could not load digest settings.'); });
    return () => { cancelled = true; };
  }, [accountId]);
  async function save(next: Settings) {
    const previous = settings;
    setSettings(next); setError(null);
    try { await digestClient.saveSettings(accountId, { model: next.model, thinking: next.thinking }); }
    catch { setSettings(previous); setError('Could not save digest settings.'); }
  }
  async function rebuild() {
    setBusy(true); setError(null);
    try { await digestClient.refresh(accountId, true); onRebuilt(); }
    catch { setError('Could not rebuild the digest.'); }
    finally { setBusy(false); }
  }
  if (!settings) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;
  const named = (label: string, model?: string | null) => model ? `${label} (${model})` : label;
  const custom = settings.model !== 'fast' && settings.model !== 'chat';
  return <div className="digest-settings">
    {error && <p role="alert" className="digest-warning">{error}</p>}
    <label>Model<select value={settings.model} onChange={event => void save({ ...settings, model: event.target.value })}>
      <option value="fast">{named('Fast', settings.fastModel)}</option>
      <option value="chat">{named('Same as chat', settings.chatModel)}</option>
      {custom && <option value={settings.model}>{settings.model}</option>}
    </select></label>
    <label>Thinking<select value={settings.thinking} onChange={event => void save({ ...settings, thinking: event.target.value })}>
      {THINKING.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <button type="button" disabled={busy} onClick={() => void rebuild()}>{busy ? 'Rebuilding…' : 'Rebuild digest'}</button>
  </div>;
}
