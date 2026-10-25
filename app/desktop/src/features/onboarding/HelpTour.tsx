import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { helpTourSteps, type HelpTourStep } from './helpTourSteps';
import { readHelpProgress, saveHelpProgress } from './helpProgress';
import { helpTourGeometry, type TourRect } from './helpTourGeometry';
import '@/styles/help.css';

type Props = {
  progressKey: string;
  settingsAvailable: boolean;
  onPrepare: (step: HelpTourStep) => void;
  onExit: (permissions?: boolean) => void;
};

export default function HelpTour({ progressKey, settingsAvailable, onPrepare, onExit }: Props) {
  const [index, setIndex] = useState(() => { const saved = readHelpProgress(progressKey); return saved.completed ? 0 : saved.step; });
  const [saved, setSaved] = useState(true);
  const [anchor, setAnchor] = useState<{ target: string; rect: TourRect } | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [size, setSize] = useState({ width: 320, height: 250 });
  const panel = useRef<HTMLDivElement>(null);
  const prepare = useRef(onPrepare);
  useLayoutEffect(() => { prepare.current = onPrepare; }, [onPrepare]);
  const titleId = useId();
  const bodyId = useId();
  const step = helpTourSteps[index];
  const targetName = index === 0 && !settingsAvailable ? 'profile' : step.target;
  const rect = anchor?.target === targetName ? anchor.rect : null;
  const last = index === helpTourSteps.length - 1;
  const remember = (next: number, completed = false) => setSaved(saveHelpProgress(progressKey, { step: next, completed, welcome: false }));
  const next = () => { if (last) { remember(index, true); onExit(); } else { remember(index + 1); setIndex(index + 1); } };
  const previous = () => { if (index > 0) { remember(index - 1); setIndex(index - 1); } };

  useEffect(() => {
    prepare.current(step);
    panel.current?.focus();
    let frame = 0;
    let current: HTMLElement | null = null;
    const started = performance.now();
    const measure = () => {
      const element = document.querySelector<HTMLElement>(`[data-help-target="${targetName}"]`);
      if (element && element !== current) { current = element; element.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); }
      const bounds = element?.getBoundingClientRect();
      const visible = bounds && bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < innerHeight && bounds.left < innerWidth && !element?.closest('[inert], [aria-hidden="true"]');
      const nextRect = visible ? { left: Math.max(4, bounds.left - 5), top: Math.max(4, bounds.top - 5), width: Math.min(innerWidth - 4, bounds.right + 5) - Math.max(4, bounds.left - 5), height: Math.min(innerHeight - 4, bounds.bottom + 5) - Math.max(4, bounds.top - 5) } : null;
      setAnchor((old) => JSON.stringify(old) === JSON.stringify(nextRect ? { target: targetName, rect: nextRect } : null) ? old : nextRect ? { target: targetName, rect: nextRect } : null);
      setWaiting(!nextRect && performance.now() - started < 1500);
      setViewport((old) => old.width === innerWidth && old.height === innerHeight ? old : { width: innerWidth, height: innerHeight });
      const panelBounds = panel.current?.getBoundingClientRect();
      if (panelBounds) setSize((old) => old.width === panelBounds.width && old.height === panelBounds.height ? old : { width: panelBounds.width, height: panelBounds.height });
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [step, targetName]);

  useEffect(() => {
    // Capture Escape before an underlying settings dialog can consume it.
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onExit(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [onExit]);

  const position = helpTourGeometry(rect, viewport, size);
  return createPortal(<div className="help-tour-layer">
    {rect ? <div className="help-tour-spotlight" data-target={targetName} style={rect} aria-hidden="true" /> : <div className="help-tour-dim" aria-hidden="true" />}
    <div className="help-tour-card" ref={panel} style={{ left: position.left, top: position.top }} role="dialog" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1} onKeyDown={(event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); next(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); previous(); }
      if (event.key === 'Tab') {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    }}>
      {rect ? <span className="help-tour-arrow" data-side={position.side} style={position.side === 'left' || position.side === 'right' ? { top: position.arrow } : { left: position.arrow }} aria-hidden="true" /> : null}
      <div className="help-tour-body">
      <div className="help-tour-top"><span aria-live="polite">Step {index + 1} of {helpTourSteps.length}</span><button className="help-icon-button" aria-label="Close tour" onClick={() => onExit()}><X size={16} /></button></div>
      <h2 id={titleId}>{step.title}</h2>
      <p id={bodyId}>{index === 0 && !settingsAvailable ? 'Open your profile to sign in and reach account settings. Authentication connects the AI providers and models your agents use.' : step.body}</p>
      {!rect ? <p className="help-tour-note" role="status">{waiting ? 'Finding this control…' : 'This control is not visible in this workspace. You can continue the tour or skip it for now.'}</p> : null}
      {last ? <button className="help-text-button" onClick={() => { remember(index, true); onExit(true); }}>Open Permissions & access</button> : null}
      {!saved ? <p role="status">Progress could not be saved on this device.</p> : null}
      <div className="help-tour-actions"><button className="help-text-button" onClick={() => onExit()}>Skip tour</button><div><button className="help-secondary" disabled={index === 0} onClick={previous} aria-label="Previous step"><ArrowLeft size={16} /></button><button className="help-primary" onClick={next}>{last ? 'Finish tour' : 'Next'}{!last ? <ArrowRight size={15} /> : null}</button></div></div>
      </div>
    </div>
  </div>, document.querySelector('.kordi-app') ?? document.body);
}
