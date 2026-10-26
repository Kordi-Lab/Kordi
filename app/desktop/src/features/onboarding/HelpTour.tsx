import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { helpTourEntry, helpTours, type HelpTourId, type HelpTourStep } from './helpTourSteps';
import { readHelpProgress, saveHelpProgress } from './helpProgress';
import { helpTourGeometry, type TourRect } from './helpTourGeometry';
import { cloudApiBaseUrl, defaultCloudAuthClient } from '@/features/cloud/authClient';
import { useCloudAuthCapabilitiesState } from '@/features/cloud/cloudAuthCapabilities';
import { commonGroundVersionFromCapabilities } from '@/features/cloud/commonGroundCapability';
import { setHelpTourLocation } from './helpTourSession';
import { trackHelpTourTarget } from './helpTourTarget';
import '@/styles/help.css';

type Props = {
  progressKey: string;
  tourId?: HelpTourId;
  initialSection?: Exclude<HelpTourId, 'workspace'>;
  settingsAvailable: boolean;
  onPrepare: (step: HelpTourStep) => void;
  onExit: (permissions?: boolean) => void;
};

export default function HelpTour({ progressKey, tourId = 'workspace', initialSection, settingsAvailable, onPrepare, onExit }: Props) {
  const helpTourSteps = helpTours[tourId];
  const [index, setIndex] = useState(() => { const saved = readHelpProgress(progressKey); if (initialSection) return Math.max(0, helpTourSteps.findIndex((item) => item.target === helpTourEntry[initialSection])); return saved.completed ? 0 : Math.min(saved.step, helpTourSteps.length - 1); });
  const [saved, setSaved] = useState(true);
  const [anchor, setAnchor] = useState<{ target: string; rect: TourRect } | null>(null);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const client = useMemo(() => defaultCloudAuthClient(), []);
  const { capabilities, status } = useCloudAuthCapabilitiesState(client, cloudApiBaseUrl());
  const steps = helpTourSteps.filter((item) => !unavailable.includes(item.target)
    && (settingsAvailable || !item.settings || item.settings === 'auth')
    && ((!item.groundingScreen && item.target !== 'grounding') || status === 'loading' || commonGroundVersionFromCapabilities(capabilities) !== null));
  const [trackedTarget, setTrackedTarget] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [size, setSize] = useState({ width: 320, height: 250 });
  const panel = useRef<HTMLDivElement>(null);
  const prepare = useRef(onPrepare);
  useLayoutEffect(() => { prepare.current = onPrepare; }, [onPrepare]);
  const titleId = useId();
  const bodyId = useId();
  // Persist the canonical step index so hiding an unavailable feature does not shift saved progress.
  const step = steps.find((item) => helpTourSteps.indexOf(item) >= index) ?? steps[steps.length - 1] ?? helpTourSteps[helpTourSteps.length - 1];
  const visibleIndex = steps.indexOf(step);
  const canonicalIndex = helpTourSteps.indexOf(step);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSaved(saveHelpProgress(progressKey, { step: canonicalIndex, completed: false, welcome: false })));
    return () => cancelAnimationFrame(frame);
  }, [canonicalIndex, progressKey]);
  const targetName = step.target === 'settings-auth' && !settingsAvailable ? 'profile' : step.target;
  const rect = trackedTarget === targetName && anchor?.target === targetName ? anchor.rect : null;
  const last = visibleIndex === steps.length - 1;
  const popoverVisible = Boolean(rect);
  useLayoutEffect(() => { if (popoverVisible) panel.current?.focus(); }, [targetName, popoverVisible]);
  const remember = (next: number, completed = false) => setSaved(saveHelpProgress(progressKey, { step: next, completed, welcome: false }));
  const next = () => { if (last) { remember(canonicalIndex, true); onExit(); } else { const destination = helpTourSteps.indexOf(steps[visibleIndex + 1]); remember(destination); setIndex(destination); } };
  const previous = () => { if (visibleIndex > 0) { const destination = helpTourSteps.indexOf(steps[visibleIndex - 1]); remember(destination); setIndex(destination); } };

  useLayoutEffect(() => { setHelpTourLocation(step); return () => setHelpTourLocation(null); }, [step]);

  useLayoutEffect(() => {
    prepare.current(step);
    let frame = 0;
    let current: HTMLElement | null = null;
    let target: ReturnType<typeof trackHelpTourTarget> | null = null;
    let missingSince: number | null = null;
    const measure = (now: number) => {
      missingSince ??= now;
      const element = document.querySelector<HTMLElement>(`[data-help-target="${targetName}"]`);
      if (element !== current) { target?.dispose(); current = element; target = element ? trackHelpTourTarget(element) : null; }
      const nextRect = target?.measure() ?? null;
      // Keep the last placement while navigation mounts the next target.
      // Clearing it would send the popover to a fallback position for one frame.
      if (nextRect) setAnchor((old) => old?.target === targetName && JSON.stringify(old.rect) === JSON.stringify(nextRect) ? old : { target: targetName, rect: nextRect });
      setTrackedTarget(nextRect ? targetName : null);
      if (nextRect) missingSince = now;
      else if (now - missingSince >= (step.groundingScreen || step.settings ? 6000 : 1500)) {
        // A tour only explains controls the user can see and use.
        setUnavailable((old) => old.includes(step.target) ? old : [...old, step.target]);
        return;
      }
      setViewport((old) => old.width === innerWidth && old.height === innerHeight ? old : { width: innerWidth, height: innerHeight });
      const panelBounds = panel.current?.getBoundingClientRect();
      if (panelBounds) setSize((old) => old.width === panelBounds.width && old.height === panelBounds.height ? old : { width: panelBounds.width, height: panelBounds.height });
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => { cancelAnimationFrame(frame); target?.dispose(); };
  }, [step, targetName]);

  useEffect(() => { if (steps.length === 0) onExit(); }, [steps.length, onExit]);

  useEffect(() => {
    // Capture Escape before an underlying settings dialog can consume it.
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onExit(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [onExit]);

  const sectionSteps = step.section ? steps.filter((item) => item.section === step.section) : steps;
  const sections = [...new Set(steps.map((item) => item.section).filter(Boolean))];
  const position = helpTourGeometry(rect ?? anchor?.rect ?? null, viewport, size);
  return createPortal(<div className="help-tour-layer">
    {rect ? <div className="help-tour-spotlight" data-target={targetName} style={rect} aria-hidden="true" /> : null}
    <div className="help-tour-card" ref={panel} data-target={targetName} data-positioned={Boolean(rect)} style={{ left: position.left, top: position.top, visibility: popoverVisible ? undefined : 'hidden' }} role="dialog" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1} onKeyDown={(event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); next(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); previous(); }
      if (event.key === 'Tab') {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        const destination = current < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[destination]?.focus();
      }
    }}>
      {rect ? <span className="help-tour-arrow" data-side={position.side} style={position.side === 'left' || position.side === 'right' ? { top: position.arrow } : { left: position.arrow }} aria-hidden="true" /> : null}
      <div className="help-tour-body">
      <div className="help-tour-top">{sections.length > 1 ? <button className="help-tour-sections-toggle" aria-label="Tour sections" aria-expanded={sectionsOpen} onClick={() => setSectionsOpen(!sectionsOpen)}><span aria-live="polite">{step.section} · Step {sectionSteps.indexOf(step) + 1} of {sectionSteps.length}</span></button> : <span aria-live="polite">Step {visibleIndex + 1} of {steps.length}</span>}<button className="help-icon-button" aria-label="Close tour" onClick={() => onExit()}><X size={16} /></button></div>
      {sectionsOpen ? <nav aria-label="Tour sections" className="help-tour-sections">{sections.map((name) => <button key={name} aria-current={name === step.section ? 'step' : undefined} onClick={() => { const target = steps.find((item) => item.section === name)!; const destination = helpTourSteps.indexOf(target); remember(destination); setIndex(destination); setSectionsOpen(false); }}>{name}</button>)}</nav> : null}
      <h2 id={titleId}>{step.title}</h2>
      <p id={bodyId}>{step.target === 'settings-auth' && !settingsAvailable ? 'Open your profile to sign in. Then open Authentication in settings to connect an AI provider.' : step.body}</p>
      {last && tourId === 'workspace' ? <button className="help-text-button" onClick={() => { remember(canonicalIndex, true); onExit(true); }}>Open Permissions & access</button> : null}
      {!saved ? <p role="status">Progress could not be saved on this device.</p> : null}
      <div className="help-tour-actions"><button className="help-text-button" onClick={() => onExit()}>Skip tour</button><div><button className="help-secondary" disabled={visibleIndex <= 0} onClick={previous} aria-label="Previous step"><ArrowLeft size={16} /></button><button className="help-primary" onClick={next}>{last ? 'Finish tour' : 'Next'}{!last ? <ArrowRight size={15} /> : null}</button></div></div>
      </div>
    </div>
  </div>, document.querySelector('.kordi-app') ?? document.body);
}
