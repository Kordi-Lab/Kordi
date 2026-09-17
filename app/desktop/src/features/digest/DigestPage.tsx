import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { Bell, RefreshCw } from 'lucide-react';
import { digestClient } from './client';
import { useDigest } from './useDigest';
import { CALENDAR_PRIVACY_SETTINGS_URL, fetchCalendarLink, dateKey, importCalendar, plainEventNotes, shiftedCalendarEnd, syncReminders, zonedEventLabel, type CalendarImport } from './calendar';
import type { CalendarConnection, CalendarEvent, CalendarRecurrence, DigestItem, DigestSource } from './types';
import { requestCalendarSync, useCalendarSyncStatus } from './calendarSyncRunner';
import { readCalendarSyncBaseline, readCalendarSyncPreferences, writeCalendarSyncPreferences, type CalendarSyncPreferences } from './calendarSyncPreferences';
import { openDesktopExternalUrl } from '@/lib/desktop';
import { DigestCalendar, DigestAgenda } from './DigestCalendar';
import { calendarErrorMessage, importCalendarEvents, type CalendarImportReport } from './calendarImport';
import { DigestPeople } from './DigestPeople';
import { DigestReadStatus, type DigestUnavailableState } from './DigestReadStatus';
import { proposalEvent, proposalSeries } from './calendarProposal';
import { digestEventLinks } from './links';
import { DigestRelatedLinks } from './DigestRelatedLinks';
import { DigestSplit } from './DigestSplit';
import { useCalendarPreview } from './useCalendarPreview';
import { MarkdownContent } from '@/kordi-app/components/markdown';
import './digest.css';

const timeLabel=(value:string)=>new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const localInput=(value?:string|null)=>{if(!value)return '';const d=new Date(value);return `${dateKey(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
const ActionErrorContext = createContext<{error:string|null;setError:(error:string|null)=>void}>({error:null,setError:()=>{}});
function Sheet({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
  const ref=useRef<HTMLDialogElement>(null);
  const {error,setError}=useContext(ActionErrorContext);
  useEffect(()=>{setError(null);ref.current?.showModal();return()=>setError(null);},[setError]);
  // Unmounting an open <dialog> (instead of calling close()) still runs the browser's focus-restoration
  // step, which scrolls the trigger element back into view. Blur first so there is nothing to restore to.
  useLayoutEffect(()=>{const dialog=ref.current;return()=>{const view=dialog?.ownerDocument.defaultView,active=dialog?.ownerDocument.activeElement;if(view&&active instanceof view.HTMLElement&&dialog?.contains(active))active.blur();};},[]);
  return <dialog className="digest-sheet" ref={ref} onCancel={onClose}><header><h2>{title}</h2><button onClick={onClose}>Close</button></header>{error&&<p role="alert" className="digest-warning">{error}</p>}{children}</dialog>;
}
/** A small modal stacked above a sheet. Escape or "Keep" closes only this dialog. */
function ConfirmDialog({title,confirmLabel,busy,onKeep,onConfirm,children}:{title:string;confirmLabel:string;busy:boolean;onKeep:()=>void;onConfirm:()=>void;children:ReactNode}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>{if(dialog?.open)dialog.close();};},[]);
  return <dialog className="digest-sheet digest-confirm" ref={ref} role="alertdialog" aria-label={title} onCancel={event=>{event.preventDefault();if(!busy)onKeep();}}><h2>{title}</h2>{children}<footer><button type="button" disabled={busy} onClick={onKeep}>Keep event</button><button type="button" className="digest-cancel-action" disabled={busy} autoFocus onClick={onConfirm}>{confirmLabel}</button></footer></dialog>;
}
export default function DigestPage({accountId,onOpenProviderSettings}:{accountId:string;onOpenProviderSettings?:()=>void}){
  const {digest,events,error,digestError,calendarError,reload,calendarLoaded,setFeedback,removeEvents,pendingMutationKeys,mutationError,canRetryMutation,retryMutation}=useDigest(accountId);
  const [view,setView]=useState<'brief'|'tasks'|'calendar'>('brief');
  const mainRef=useRef<HTMLDivElement>(null);
  const scrollPositions=useRef({brief:0,tasks:0,calendar:0});
  useLayoutEffect(()=>{if(mainRef.current)mainRef.current.scrollTop=scrollPositions.current[view];},[view]);
  const [month,setMonth]=useState(()=>dateKey(new Date()).slice(0,7));
  const [selectedDay,setSelectedDay]=useState(()=>dateKey(new Date()));
  const [sourceId,setSourceId]=useState<string|string[]|null>(null);
  const [editEvent,setEditEvent]=useState<CalendarEvent|null>(null);
  const [review,setReview]=useState<{item:DigestItem;original?:CalendarEvent;series?:CalendarEvent[]}|null>(null);
  const [importOpen,setImportOpen]=useState(false);
  const [calendarSettingsOpen,setCalendarSettingsOpen]=useState(false);
  const sync=useCalendarSyncStatus(accountId);
  const [busy,setBusy]=useState(false);const [actionError,setActionError]=useState<string|null>(null);
  const [reminderState,setReminderState]=useState('unknown');
  const sources=digest?.sources??[];const output=digest?.snapshot;
  function feedbackPending(id:string){return pendingMutationKeys.includes(`feedback:${id}`);}
  function changeFeedback(id:string,dismissed:boolean){void setFeedback(id,dismissed).catch(()=>{});}
  async function retryReads(){setBusy(true);try{await reload();}catch{/* Read failures are published by the store. */}finally{setBusy(false);}}
  // One status for the whole page: the header says how fresh the brief is,
  // and a digest without a brief explains itself once, in its own card.
  const needsProvider=digest?.errorCode==='missing_provider_auth';
  const unavailable:DigestUnavailableState|null=!digest?(digestError?'unreachable':'loading')
    :output?null
    :digest.status==='updating'||digest.status==='loading'?'preparing'
    :needsProvider?'needsProvider'
    :digest.errorCode==='provider_auth_rejected'?'providerRejected'
    :digest.errorCode==='provider_unavailable'?'providerUnavailable'
    :digest.status==='error'?'failed'
    :null;
  function retryGeneration(){void act(()=>digestClient.refresh(accountId));}
  // Every status and its one action live in the header line, which keeps the
  // same height in every state; the body stays empty until there is a brief.
  const statusAction=(label:string,onClick:()=>void)=><> · <button className="digest-link" disabled={busy} onClick={onClick}>{label}</button></>;
  const settingsAction=onOpenProviderSettings?statusAction('Open settings',onOpenProviderSettings):null;
  const freshness=unavailable==='loading'?<>Loading…</>
    :unavailable==='unreachable'?<>Couldn't reach Kordi{statusAction('Try again',()=>void retryReads())}</>
    :unavailable==='preparing'?<>Preparing your digest…</>
    :unavailable==='needsProvider'?<>Connect a model provider to get your digest{settingsAction}</>
    :unavailable==='providerRejected'?<>Your model provider sign-in didn't work{settingsAction}</>
    :unavailable==='providerUnavailable'?<>Your model provider is unavailable right now{statusAction('Try again',retryGeneration)}</>
    :unavailable==='failed'?<>Your digest couldn't be prepared{statusAction('Try again',retryGeneration)}</>
    :<><span title="Updates a few minutes after your conversations go quiet">{digest?.updatedAt?`Updated ${timeLabel(digest.updatedAt)}`:'Up to date'}</span>{digest?.status==='updating'?<> · Updating…</>:needsProvider?<> · Connect a model provider{settingsAction}</>:digest?.errorCode==='provider_auth_rejected'?<> · Provider sign-in didn't work{settingsAction}</>:digest?.errorCode==='provider_unavailable'?<> · Provider unavailable{statusAction('Retry',retryGeneration)}</>:digest?.errorCode?<> · Last update failed{statusAction('Retry',retryGeneration)}</>:null}</>;
  const digestStatus=unavailable?<div className="digest-placeholder" aria-hidden="true"/>:null;
  const calendarStatus=!calendarLoaded?<DigestReadStatus label="Calendar" failed={!!calendarError} busy={busy} onRetry={()=>void retryReads()}/>:null;
  const selectedSources=sources.filter(s=>(Array.isArray(sourceId)?sourceId:[sourceId]).includes(s.id)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  const source=selectedSources[0];
  const feedback=digest?.feedback??[];
  const dismissedClaims=(output?.claims??[]).filter(i=>feedback.some(f=>f.id===i.id&&f.status==='dismissed'));
  const dismissedSuggestions=(output?.suggestions??[]).filter(i=>feedback.some(f=>f.id===i.id&&f.status==='dismissed'));
  const visibleClaims=(output?.claims??[]).filter(i=>!dismissedClaims.some(d=>d.id===i.id));
  const visibleSuggestions=(output?.suggestions??[]).filter(i=>!dismissedSuggestions.some(d=>d.id===i.id));
  const eventSignature=JSON.stringify(events.map(e=>({id:e.id,title:e.title,startAt:e.startAt,reminderAt:e.reminderAt,revision:e.revision})));
  useEffect(()=>{if(!calendarLoaded)return;let cancelled=false;void syncReminders(accountId,JSON.parse(eventSignature) as CalendarEvent[]).then(value=>{if(!cancelled)setReminderState(value);}).catch(()=>{if(!cancelled)setReminderState('error');});return()=>{cancelled=true;};},[accountId,eventSignature,calendarLoaded]);
  async function act(operation:()=>Promise<unknown>){setBusy(true);setActionError(null);try{await operation();await reload();requestCalendarSync(accountId);}catch(e){setActionError(calendarErrorMessage(e,'Could not complete this action.'));try{await reload();}catch{/* Retain the visible action error. */}}finally{setBusy(false);}}
  async function saveImported(incoming:CalendarEvent[]){
    const current=await digestClient.calendar(accountId);
    const report=await importCalendarEvents(incoming,current.events,event=>digestClient.saveEvent(accountId,event));
    await reload();requestCalendarSync(accountId);return report;
  }
  const visibleActionError=sourceId||editEvent||importOpen||calendarSettingsOpen?null:actionError;
  function people(item:DigestItem){
    return <DigestPeople item={item} sources={sources} accountId={accountId} onSource={setSourceId}/>;
  }
  function evidence(item:DigestItem){
    const groups=new Map<string,DigestSource[]>();
    for(const id of item.sourceIds){const source=sources.find(s=>s.id===id);if(source)groups.set(source.sessionId,[...(groups.get(source.sessionId)??[]),source]);}
    return <div className="digest-evidence">{[...groups.entries()].map(([sessionId,group])=><button key={sessionId} onClick={()=>setSourceId(group.map(s=>s.id))}>↗ {group[0].sessionTitle}{group.length>1?` · ${group.length} messages`:''}</button>)}</div>;
  }
  function openEvent(event:CalendarEvent){setReview(null);setEditEvent(event);}
  function removesFromDevice(event:CalendarEvent){
    if(!event.externalUid?.startsWith('device:'))return false;
    const calendarId=readCalendarSyncBaseline(accountId)[event.externalUid]?.calendarId;
    const calendar=sync.calendars.find(item=>item.id===calendarId);
    return !!calendar&&calendar.allowsModifications!==false;
  }
  function calendarCandidate(item:DigestItem){try{const event=proposalEvent(item,events,sources,digest?.timezone);setReview({item,original:events.find(e=>e.id===item.existingEventId),series:proposalSeries(item,events)});setEditEvent(event);}catch(error){setActionError(calendarErrorMessage(error,'Could not review this event.'));}}
  function changeMonth(next:string){setMonth(next);if(!selectedDay.startsWith(next))setSelectedDay(`${next}-01`);}
  return <ActionErrorContext.Provider value={{error:actionError,setError:setActionError}}><section className="digest-page" aria-label="Digest"><header className="digest-header"><div><h1>Digest</h1><div className="digest-header-actions"><button aria-label="Enable calendar reminders" onClick={()=>void act(async()=>setReminderState(await syncReminders(accountId,events,true)))}><Bell size={18}/></button><button aria-label="Refresh digest" disabled={busy||digest?.status==='updating'} onClick={()=>void act(()=>digestClient.refresh(accountId))}><RefreshCw size={18}/></button></div></div><div className="digest-status" role="status" aria-live="polite"><span className="digest-status-line">{pendingMutationKeys.length>0&&!unavailable?<>Saving changes…</>:freshness}</span></div><nav aria-label="Digest views">{(['brief','tasks','calendar'] as const).map(v=><button key={v} aria-pressed={view===v} onClick={()=>setView(v)}>{v==='brief'?'Brief':v==='tasks'?'Next steps':'Calendar'}</button>)}</nav></header>
    <div className="digest-notices" role="status">{mutationError&&<p className="digest-warning">{mutationError} {canRetryMutation&&<button onClick={()=>void retryMutation().catch(()=>{})}>Try again</button>}</p>}{(visibleActionError||error)&&<p className="digest-warning">{visibleActionError||error}</p>}{reminderState==='denied'&&<p className="digest-warning">Device notifications are off. Enable them in system settings to receive reminders.</p>}</div><div className="digest-body">
      <DigestSplit><div className="digest-main" ref={mainRef} role="region" aria-label="Digest content" tabIndex={0} onScroll={event=>{scrollPositions.current[view]=event.currentTarget.scrollTop;}}>
      <section hidden={view!=='brief'} aria-label="Brief">{digestStatus ?? (visibleClaims.length?visibleClaims.map(item=><article className="digest-row" key={item.id}><h3>{item.title}</h3><p>{item.text}</p>{people(item)}{evidence(item)}<button disabled={busy||feedbackPending(item.id)} aria-label={`Dismiss ${item.title}`} onClick={()=>changeFeedback(item.id,true)}>Dismiss</button></article>):<p className="digest-empty">{sources.length?'No brief entries to show.':'No conversations to summarize yet.'}</p>)}{dismissedClaims.length>0&&<button disabled={busy||dismissedClaims.some(item=>feedbackPending(item.id))} onClick={()=>dismissedClaims.forEach(item=>changeFeedback(item.id,false))}>Restore dismissed entries</button>}</section>
      <section hidden={view!=='tasks'} aria-label="Next steps"><h2>AI suggestions</h2>{digestStatus}{!digestStatus&&visibleSuggestions.map(item=><article className="digest-row" key={item.id}><h3>{item.title}</h3><p>{item.text}</p>{people(item)}{evidence(item)}<button disabled={busy||feedbackPending(item.id)} aria-label={`Dismiss ${item.title}`} onClick={()=>changeFeedback(item.id,true)}>Dismiss</button></article>)}{!digestStatus&&visibleSuggestions.length===0&&<p className="digest-empty">No suggestions to show.</p>}{dismissedSuggestions.length>0&&<button disabled={busy||dismissedSuggestions.some(item=>feedbackPending(item.id))} onClick={()=>dismissedSuggestions.forEach(item=>changeFeedback(item.id,false))}>Restore dismissed suggestions</button>}</section>
      <section hidden={view!=='calendar'} aria-label="Calendar">{calendarStatus ?? <DigestCalendar month={month} selectedDay={selectedDay} events={events} candidates={output?.calendarCandidates??[]} onMonth={changeMonth} onDay={setSelectedDay} onEvent={openEvent} onCandidate={calendarCandidate}/>}</section>
      </div><DigestAgenda digestStatus={unavailable?<></>:null} calendarStatus={calendarStatus} day={selectedDay} events={events} candidates={output?.calendarCandidates??[]} sources={sources} people={people} evidence={evidence} onEvent={openEvent} onCandidate={calendarCandidate} sync={sync} onCalendarSettings={()=>setCalendarSettingsOpen(true)} onOpenPrivacy={()=>void openDesktopExternalUrl(CALENDAR_PRIVACY_SETTINGS_URL).catch(error=>setActionError(calendarErrorMessage(error,'Could not open System Settings.')))} onRetrySync={()=>requestCalendarSync(accountId)} onImport={()=>setImportOpen(true)}/></DigestSplit>
    </div>
    {sourceId&&<Sheet title={source?.sessionTitle||'Source unavailable'} onClose={()=>setSourceId(null)}>{source?<>{selectedSources.map(source=><article key={source.id}><p className="digest-meta">@{source.senderName} · {timeLabel(source.createdAt)}</p><blockquote><MarkdownContent text={source.text} tone="inherit" className="whitespace-normal" copySurface="message" preserveLineBreaks /></blockquote></article>)}</>:<p>This message is no longer included or accessible. Refresh the digest.</p>}</Sheet>}
    {editEvent&&(!review||editEvent.revision>0||output?.calendarCandidates.some(item=>item.id===review.item.id))&&editEvent.sourceIds.every(id=>sources.some(s=>s.id===id))&&<EventEditor key={editEvent.id+(review?.item.id??'')} removesFromDevice={removesFromDevice(editEvent)} event={editEvent} review={review} sources={sources} accountId={accountId} onClose={()=>setEditEvent(null)} onSave={event=>act(async()=>{if(event.recurrence&&!event.revision)await digestClient.saveSeries(accountId,event);else await digestClient.saveEvent(accountId,event);setEditEvent(null);})} onRemove={editEvent.revision?async()=>{const seriesId=review?.series?review.item.existingSeriesId:undefined;const targets=seriesId&&review?.series?review.series:[editEvent];setEditEvent(null);setReview(null);try{await removeEvents(targets,seriesId??undefined);}catch{/* The account-owned store reports failure and restores the event. */}}:undefined}/>}
    {importOpen&&<ImportSheet events={events} onClose={()=>setImportOpen(false)} onImport={saveImported}/>}
    {calendarSettingsOpen&&<CalendarSettingsSheet accountId={accountId} calendars={sync.calendars} onClose={()=>setCalendarSettingsOpen(false)}/>}
  </section></ActionErrorContext.Provider>;
}
function EventEditor({event,review,sources,accountId,onClose,onSave,onRemove,removesFromDevice=false}:{removesFromDevice?:boolean;event:CalendarEvent;review:{item:DigestItem;original?:CalendarEvent;series?:CalendarEvent[]}|null;sources:DigestSource[];accountId:string;onClose:()=>void;onSave:(event:CalendarEvent)=>Promise<void>;onRemove?:()=>Promise<void>}){
  const [title,setTitle]=useState(event.title);
  const [start,setStart]=useState(event.allDay?event.startAt.slice(0,10):localInput(event.startAt));
  const initialEnd=shiftedCalendarEnd(event.startAt,event.startAt,event.endAt,event.allDay);
  const [end,setEnd]=useState(()=>event.allDay?initialEnd.slice(0,10):localInput(initialEnd));
  const [minutes,setMinutes]=useState(event.reminderAt?String(Math.round((Date.parse(event.startAt)-Date.parse(event.reminderAt))/60000)):event.revision===0&&!event.allDay?'10':'');
  const [rule,setRule]=useState<CalendarRecurrence|null>(()=>event.recurrence?{...event.recurrence,...(!event.recurrence.count&&!event.recurrence.until?{count:event.recurrence.frequency==='yearly'?5:12}:{})}:null);
  const [busy,setBusy]=useState(false);
  const [confirmRemove,setConfirmRemove]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const needsPreview=!!rule&&!event.revision&&review?.item.calendarAction!=='delete';
  let previewRequest:string|null=null,previewValidation:string|null=null;
  if(needsPreview){try{previewRequest=JSON.stringify(payload());}catch(error){previewValidation=calendarErrorMessage(error,'Check the event dates.');}}
  const preview=useCalendarPreview(accountId,previewRequest);
  const links=<DigestRelatedLinks links={digestEventLinks(event,sources)}/>;
  const deviceZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  function changeStart(value:string){
    const previousStart=!event.allDay&&start===localInput(event.startAt)?event.startAt:start;
    const previousEnd=!event.allDay&&end===localInput(initialEnd)?initialEnd:end;
    const nextEnd=shiftedCalendarEnd(value,previousStart,previousEnd,event.allDay);
    setStart(value);setEnd(event.allDay?nextEnd.slice(0,10):localInput(nextEnd));
  }
  async function remove(){setBusy(true);try{await onRemove?.();}finally{setBusy(false);}}
  if(review?.item.calendarAction==='delete')return <Sheet title="Review cancellation" onClose={onClose}><h3 className="digest-cancel-heading">{event.title}</h3><p>{review.series?`${review.series.length} events in this series`:event.allDay?event.startAt.slice(0,10):timeLabel(event.startAt)}</p>{review.series&&<ol className="digest-import-list">{review.series.map(occurrence=><li key={occurrence.id}>{occurrence.allDay?occurrence.startAt.slice(0,10):timeLabel(occurrence.startAt)}</li>)}</ol>}{links}<p>{review.series?'These events will be removed from your personal Kordi calendar.':'Only this event will be removed from your personal Kordi calendar.'} Source calendars and invitations stay unchanged.</p><footer><button onClick={onClose}>Keep event</button><button className="digest-cancel-action" disabled={busy} onClick={()=>void remove()}>Confirm removal</button></footer></Sheet>;
  function payload():CalendarEvent {
    if(!start)throw new Error('Choose the start date and time.');
    const startAt=new Date(event.allDay?start+'T00:00:00Z':start===localInput(event.startAt)?event.startAt:start).toISOString();
    const endAt=end?new Date(event.allDay?end+'T00:00:00Z':end===localInput(initialEnd)?initialEnd:end).toISOString():null;
    if(endAt&&Date.parse(endAt)<=Date.parse(startAt))throw new Error('End must follow start.');
    const reminderAt=minutes!==''?new Date(Date.parse(startAt)-Number(minutes)*60000).toISOString():null;
    if(reminderAt&&Date.parse(reminderAt)<Date.now())throw new Error('That reminder time has passed. Choose No reminder or a later date.');
    return {...event,title,startAt,endAt,reminderAt,recurrence:rule,timezone:rule?.timezone??event.timezone,confirmSingleOccurrence:!rule&&!event.revision};
  }
  async function save(e:FormEvent){
    e.preventDefault();setError(null);
    try{const next=payload();if(needsPreview&&(!preview.ready||previewRequest!==JSON.stringify(next)))return;
      setBusy(true);await onSave(next);
    }catch(error){setError(calendarErrorMessage(error,'Could not save this event.'));}finally{setBusy(false);}
  }
  return <Sheet title={event.revision?'Edit event':'Review calendar event'} onClose={onClose}><form onSubmit={e=>void save(e)}>
    {review?.original&&<p className="digest-meta">Currently: {review.original.title} · {review.original.allDay?review.original.startAt.slice(0,10):timeLabel(review.original.startAt)}</p>}
    <label>Title<input required maxLength={500} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>{event.allDay?'Start date':'Start time'}<input required type={event.allDay?'date':'datetime-local'} value={start} onChange={e=>changeStart(e.target.value)}/></label>
    <label>{event.allDay?'End date (exclusive)':'End time (optional)'}<input type={event.allDay?'date':'datetime-local'} min={start} value={end} onChange={e=>setEnd(e.target.value)}/></label>
    {!event.allDay&&<label>Remind me<select value={minutes} onChange={e=>setMinutes(e.target.value)}><option value="">No reminder</option><option value="0">At start</option><option value="5">5 minutes before</option><option value="10">10 minutes before</option><option value="15">15 minutes before</option><option value="60">1 hour before</option></select></label>}
    <p className="digest-meta">Shown in {deviceZone}{event.timezone?' · Event timezone: '+event.timezone:''} · Personal calendar. No invitations are sent.</p>
    {!event.revision&&<fieldset><legend>Repeat</legend>
      <label>Frequency<select value={rule?.frequency??''} onChange={e=>setRule(e.target.value?{frequency:e.target.value as CalendarRecurrence['frequency'],interval:1,weekdays:[],timezone:event.timezone??deviceZone,count:e.target.value==='yearly'?5:12}:null)}><option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
      {rule&&<><label>Every<input type="number" min="1" max="99" value={rule.interval} onChange={e=>setRule({...rule,interval:Number(e.target.value)})}/></label>
        <label>Meeting timezone<input required value={rule.timezone} onChange={e=>setRule({...rule,timezone:e.target.value})}/></label>
        {rule.frequency==='weekly'&&<div className="digest-repeat-weekdays">{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((day,index)=><label key={day}><input type="checkbox" checked={rule.weekdays.includes(index+1)} onChange={e=>setRule({...rule,weekdays:e.target.checked?[...rule.weekdays,index+1]:rule.weekdays.filter(value=>value!==index+1)})}/>{day}</label>)}</div>}
        <label>Ends<select value={rule.until?'until':'count'} onChange={e=>setRule({...rule,count:e.target.value==='count'?12:null,until:e.target.value==='until'?start.slice(0,10):null})}><option value="count">After a number of occurrences</option><option value="until">On a date (inclusive)</option></select></label>
        {rule.until?<label>Last date<input required type="date" value={rule.until} onChange={e=>setRule({...rule,until:e.target.value})}/></label>:<label>Occurrences<input required type="number" min="1" max="250" value={rule.count??12} onChange={e=>setRule({...rule,count:Number(e.target.value)})}/></label>}
        {preview.loading&&<p role="status" className="digest-meta">Loading dates…</p>}
        {preview.ready&&<><p>{preview.events.length} dates</p><ol className="digest-import-list">{preview.events.map(occurrence=><li key={occurrence.id}>{event.allDay?occurrence.startAt.slice(0,10):new Date(occurrence.startAt).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})}{!event.allDay&&occurrence.timezone&&occurrence.timezone!==deviceZone&&<small>{zonedEventLabel(occurrence.startAt,occurrence.timezone)}</small>}</li>)}</ol></>}
        {(previewValidation||preview.error)&&<p role="alert">{previewValidation||preview.error}{preview.error&&<> <button type="button" onClick={preview.retry}>Retry</button></>}</p>}
      </>}
    </fieldset>}
    {event.seriesId&&<p className="digest-meta">Part of a repeating series. Editing or removing here affects only this occurrence.</p>}
    {links}{event.sourceIds.length>0&&<DigestPeople item={event} sources={sources} accountId={accountId} showMessages/>}{event.sourceIds.length===0&&event.description&&<p className="digest-event-context">{plainEventNotes(event.description)}</p>}
    {error&&<p role="alert">{error}</p>}
    <footer>{onRemove&&<button type="button" className="digest-remove-trigger" disabled={busy} onClick={()=>setConfirmRemove(true)}>Remove event</button>}<button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={busy||(needsPreview&&!preview.ready)}>{rule&&!event.revision?'Confirm series':review?.item.calendarAction==='update'?'Confirm change':event.revision?'Save event':'Add to calendar'}</button></footer>
    {confirmRemove&&<ConfirmDialog title="Remove this event?" confirmLabel={busy?'Removing…':'Remove'} busy={busy} onKeep={()=>setConfirmRemove(false)} onConfirm={()=>void remove()}><p><strong>{event.title}</strong></p><p className="digest-meta">{removesFromDevice?'It is removed from your Kordi calendar and from your device calendar.':'It is removed from your Kordi calendar.'}</p></ConfirmDialog>}
  </form></Sheet>;
}
function ImportSheet({events,onClose,onImport}:{events:CalendarEvent[];onClose:()=>void;onImport:(events:CalendarEvent[])=>Promise<CalendarImportReport>}){
  const [report,setReport]=useState<CalendarImportReport|null>(null);
  const [link,setLink]=useState('');
  const [text,setText]=useState(''),[preview,setPreview]=useState<CalendarImport|null>(null),[error,setError]=useState<string|null>(null),[selected,setSelected]=useState<Set<string>>(new Set()),[busy,setBusy]=useState(false);
  const [from,setFrom]=useState(dateKey(new Date()));const [to,setTo]=useState(()=>{const date=new Date();date.setFullYear(date.getFullYear()+1);return dateKey(date);});
  async function parse(){setBusy(true);setError(null);try{const data=await importCalendar(text,from,to);setPreview(data);setSelected(new Set(data.events.filter(e=>!events.some(old=>old.id===e.id||old.externalUid===e.externalUid)).map(e=>e.id)));}catch(e){setError(e instanceof Error?e.message:'Could not import calendar.');}finally{setBusy(false);}}
  return <Sheet title={report?'Import complete':preview?'Review import':'Import ICS'} onClose={onClose}>{error&&<p role="alert">{error}</p>}{report?<ImportReport report={report} onClose={onClose}/>:preview?<><p>{selected.size} occurrences selected</p>{preview.warnings.map(w=><p className="digest-warning" key={w}>{w}</p>)}<div className="digest-import-list">{preview.events.map(e=><label key={e.id}><input type="checkbox" checked={selected.has(e.id)} disabled={events.some(old=>old.id===e.id||old.externalUid===e.externalUid)} onChange={v=>setSelected(old=>{const next=new Set(old);if(v.target.checked)next.add(e.id);else next.delete(e.id);return next;})}/><span>{e.title}<small>{e.allDay?e.startAt.slice(0,10):timeLabel(e.startAt)}</small></span></label>)}</div><p className="digest-meta">Alarms and invitations are not imported. You can set reminders after reviewing an event.</p><footer><button onClick={()=>setPreview(null)}>Back</button><button disabled={!selected.size||busy} onClick={()=>{setBusy(true);setError(null);void onImport(preview.events.filter(e=>selected.has(e.id))).then(setReport).catch(error=>setError(calendarErrorMessage(error,'Could not import events.'))).finally(()=>setBusy(false));}}>Import selected</button></footer></>:<><label>Paste calendar text<textarea rows={8} value={text} onChange={e=>setText(e.target.value)} placeholder="BEGIN:VCALENDAR…"/></label><label>Choose .ics file<input type="file" accept=".ics,text/calendar" onChange={e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>1_000_000){setError('Choose a file smaller than 1 MB.');return;}void file.text().then(setText);}}/></label><details><summary>Import from a calendar link</summary><label>HTTPS or webcal link<input type="url" value={link} onChange={e=>setLink(e.target.value)} autoComplete="off"/></label><button disabled={busy||!link.trim()} onClick={()=>{setBusy(true);void fetchCalendarLink(link).then(text=>{setText(text);setLink('');}).catch(e=>setError(e instanceof Error?e.message:'Could not fetch calendar.')).finally(()=>setBusy(false));}}>Load calendar text</button><p className="digest-meta">One-time import. The link is not stored.</p></details><label>From<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>Before<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label><p className="digest-meta">One-time import, up to one year. Floating times use this device’s timezone.</p><footer><button onClick={onClose}>Cancel</button><button disabled={!text.trim()||busy} onClick={()=>void parse()}>{busy?'Reading…':'Preview events'}</button></footer></>}</Sheet>;
}
function ImportReport({report,onClose}:{report:CalendarImportReport;onClose:()=>void}){
  return <><p>{report.imported} {report.imported===1?'event':'events'} imported.{report.duplicates>0?` ${report.duplicates} already in your calendar.`:''}</p>{report.skipped.length>0&&<><p>{report.skipped.length} {report.skipped.length===1?'event was':'events were'} skipped. Review their details in the source calendar.</p><ul className="digest-import-list">{report.skipped.map((event,index)=><li key={index}><strong>{event.title}</strong><p className="digest-meta">{event.reason}</p></li>)}</ul></>}<footer><button onClick={onClose}>Done</button></footer></>;
}
function CalendarSettingsSheet({accountId,calendars,onClose}:{accountId:string;calendars:CalendarConnection[];onClose:()=>void}){
  const [preferences,setPreferences]=useState<CalendarSyncPreferences>(()=>readCalendarSyncPreferences(accountId));
  function update(next:CalendarSyncPreferences){setPreferences(next);writeCalendarSyncPreferences(accountId,next);}
  const excluded=new Set(preferences.excludedCalendarIds);
  const writable=calendars.filter(calendar=>calendar.allowsModifications!==false);
  return <Sheet title="Calendar settings" onClose={onClose}>
    <p>Every calendar on this Mac stays in sync with your private Kordi calendar automatically. Turn a calendar off to keep it out of Kordi.</p>
    {calendars.length===0&&<p className="digest-meta">No device calendars were found yet. They appear here after the first sync.</p>}
    {calendars.map(calendar=><label className="digest-choice" key={calendar.id}><input type="checkbox" checked={!excluded.has(calendar.id)} onChange={e=>update({...preferences,excludedCalendarIds:e.target.checked?preferences.excludedCalendarIds.filter(id=>id!==calendar.id):[...preferences.excludedCalendarIds,calendar.id]})}/>{calendar.title}</label>)}
    <label className="digest-choice"><input type="checkbox" checked={preferences.outbound} onChange={e=>update({...preferences,outbound:e.target.checked})}/>Add events created in Kordi to my device calendar</label>
    {preferences.outbound&&<label>Add them to<select value={preferences.targetCalendarId??''} onChange={e=>update({...preferences,targetCalendarId:e.target.value||null})}><option value="">System default calendar</option>{writable.map(calendar=><option key={calendar.id} value={calendar.id}>{calendar.title}</option>)}</select></label>}
    <p className="digest-meta">Turning a calendar off removes its events from Kordi. Source calendars are never changed by that choice. No invitations are sent.</p>
    <footer><button onClick={onClose}>Done</button></footer>
  </Sheet>;
}
