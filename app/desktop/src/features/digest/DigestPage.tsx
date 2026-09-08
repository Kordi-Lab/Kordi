import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { Bell, RefreshCw } from 'lucide-react';
import { digestClient } from './client';
import { useDigest } from './useDigest';
import { connectedCalendars, fetchCalendarLink, dateKey, importCalendar, readDeviceEvents, shiftedCalendarEnd, syncReminders, zonedEventLabel, type CalendarImport } from './calendar';
import type { CalendarConnection, CalendarEvent, CalendarRecurrence, DigestItem, DigestSource } from './types';
import { DigestCalendar, DigestAgenda } from './DigestCalendar';
import { calendarErrorMessage, importCalendarEvents, type CalendarImportReport } from './calendarImport';
import { DigestPeople } from './DigestPeople';
import { DigestReadStatus } from './DigestReadStatus';
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
  return <dialog className="digest-sheet" ref={ref} onCancel={onClose}><header><h2>{title}</h2><button onClick={onClose}>Close</button></header>{error&&<p role="alert" className="digest-warning">{error}</p>}{children}</dialog>;
}
export default function DigestPage({accountId}:{accountId:string}){
  const {digest,events,error,digestError,calendarError,reload,calendarLoaded}=useDigest(accountId);
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
  const [connections,setConnections]=useState<CalendarConnection[]|null>(null);
  const [busy,setBusy]=useState(false);const [actionError,setActionError]=useState<string|null>(null);
  const [reminderState,setReminderState]=useState('unknown');
  const sources=digest?.sources??[];const output=digest?.snapshot;
  async function retryReads(){setBusy(true);try{await reload();}catch{/* Read failures are published by the store. */}finally{setBusy(false);}}
  const digestStatus=(!digest||(!output&&digest.status!=='ready'))?<DigestReadStatus label="Digest" failed={!!digestError||digest?.status==='error'} busy={busy} onRetry={()=>void retryReads()}/>:null;
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
  async function act(operation:()=>Promise<unknown>){setBusy(true);setActionError(null);try{await operation();await reload();}catch(e){setActionError(calendarErrorMessage(e,'Could not complete this action.'));try{await reload();}catch{/* Retain the visible action error. */}}finally{setBusy(false);}}
  async function saveImported(incoming:CalendarEvent[]){
    const current=await digestClient.calendar(accountId);
    const report=await importCalendarEvents(incoming,current.events,event=>digestClient.saveEvent(accountId,event));
    await reload();return report;
  }
  const visibleActionError=sourceId||editEvent||importOpen||connections?null:actionError;
  function people(item:DigestItem){
    return <DigestPeople item={item} sources={sources} accountId={accountId} onSource={setSourceId}/>;
  }
  function evidence(item:DigestItem){
    const groups=new Map<string,DigestSource[]>();
    for(const id of item.sourceIds){const source=sources.find(s=>s.id===id);if(source)groups.set(source.sessionId,[...(groups.get(source.sessionId)??[]),source]);}
    return <div className="digest-evidence">{[...groups.entries()].map(([sessionId,group])=><button key={sessionId} onClick={()=>setSourceId(group.map(s=>s.id))}>↗ {group[0].sessionTitle}{group.length>1?` · ${group.length} messages`:''}</button>)}</div>;
  }
  function openEvent(event:CalendarEvent){setReview(null);setEditEvent(event);}
  function calendarCandidate(item:DigestItem){try{const event=proposalEvent(item,events,sources,digest?.timezone);setReview({item,original:events.find(e=>e.id===item.existingEventId),series:proposalSeries(item,events)});setEditEvent(event);}catch(error){setActionError(calendarErrorMessage(error,'Could not review this event.'));}}
  function changeMonth(next:string){setMonth(next);if(!selectedDay.startsWith(next))setSelectedDay(`${next}-01`);}
  return <ActionErrorContext.Provider value={{error:actionError,setError:setActionError}}><section className="digest-page" aria-label="Digest"><header className="digest-header"><div><h1>Digest</h1><div className="digest-header-actions"><button aria-label="Enable calendar reminders" onClick={()=>void act(async()=>setReminderState(await syncReminders(accountId,events,true)))}><Bell size={18}/></button><button aria-label="Refresh digest" disabled={busy||digest?.status==='updating'} onClick={()=>void act(()=>digestClient.refresh(accountId))}><RefreshCw size={18}/></button></div></div><div className="digest-status"><span>{!digest?(digestError?'Digest unavailable':'Loading digest…'):digest.status==='updating'?(output?'Updating · previous brief available':'Preparing your digest…'):digest.updatedAt?`Updated ${timeLabel(digest.updatedAt)}`:digest.status==='error'?'Digest unavailable':'Preparing your digest…'}</span><span className="digest-live"><i aria-hidden="true"/> Updates with your conversations</span></div><nav aria-label="Digest views">{(['brief','tasks','calendar'] as const).map(v=><button key={v} aria-pressed={view===v} onClick={()=>setView(v)}>{v==='brief'?'Brief':v==='tasks'?'Next steps':'Calendar'}</button>)}</nav></header>
    <div className="digest-notices" role="status">{(visibleActionError||error)&&<p className="digest-warning">{visibleActionError||error}</p>}{digest?.errorCode&&<p className="digest-warning">{digest.errorCode==='missing_provider_auth'?'Connect a model provider in account settings to generate your digest.':'The last update could not finish. Your previous brief remains available.'}</p>}{reminderState==='denied'&&<p className="digest-warning">Device notifications are off. Enable them in system settings to receive reminders.</p>}</div><div className="digest-body">
      <DigestSplit><div className="digest-main" ref={mainRef} role="region" aria-label="Digest content" tabIndex={0} onScroll={event=>{scrollPositions.current[view]=event.currentTarget.scrollTop;}}>
      <section hidden={view!=='brief'} aria-label="Brief">{digestStatus ?? (visibleClaims.length?visibleClaims.map(item=><article className="digest-row" key={item.id}><h3>{item.title}</h3><p>{item.text}</p>{people(item)}{evidence(item)}<button disabled={busy} aria-label={`Dismiss ${item.title}`} onClick={()=>void act(()=>digestClient.feedback(accountId,item.id,true))}>Dismiss</button></article>):<p className="digest-empty">{digest?.status==='ready'?(sources.length?'No brief entries to show.':'No conversations to summarize yet.'):digest?.status==='error'?'Refresh after checking your provider connection.':'Your sourced brief will appear here after the first update.'}</p>)}{dismissedClaims.length>0&&<button disabled={busy} onClick={()=>void act(async()=>{for(const item of dismissedClaims)await digestClient.feedback(accountId,item.id,false);})}>Restore dismissed entries</button>}</section>
      <section hidden={view!=='tasks'} aria-label="Next steps"><h2>AI suggestions</h2>{digestStatus}{!digestStatus&&visibleSuggestions.map(item=><article className="digest-row" key={item.id}><h3>{item.title}</h3><p>{item.text}</p>{people(item)}{evidence(item)}<button disabled={busy} aria-label={`Dismiss ${item.title}`} onClick={()=>void act(()=>digestClient.feedback(accountId,item.id,true))}>Dismiss</button></article>)}{!digestStatus&&visibleSuggestions.length===0&&<p className="digest-empty">No suggestions to show.</p>}{dismissedSuggestions.length>0&&<button disabled={busy} onClick={()=>void act(async()=>{for(const item of dismissedSuggestions)await digestClient.feedback(accountId,item.id,false);})}>Restore dismissed suggestions</button>}</section>
      <section hidden={view!=='calendar'} aria-label="Calendar">{calendarStatus ?? <DigestCalendar month={month} selectedDay={selectedDay} events={events} candidates={output?.calendarCandidates??[]} onMonth={changeMonth} onDay={setSelectedDay} onEvent={openEvent} onCandidate={calendarCandidate}/>}</section>
      </div><DigestAgenda digestStatus={digestStatus} calendarStatus={calendarStatus} day={selectedDay} events={events} candidates={output?.calendarCandidates??[]} sources={sources} people={people} evidence={evidence} onEvent={openEvent} onCandidate={calendarCandidate} onConnect={()=>void act(async()=>setConnections(await connectedCalendars()))} onImport={()=>setImportOpen(true)}/></DigestSplit>
    </div>
    {sourceId&&<Sheet title={source?.sessionTitle||'Source unavailable'} onClose={()=>setSourceId(null)}>{source?<>{selectedSources.map(source=><article key={source.id}><p className="digest-meta">@{source.senderName} · {timeLabel(source.createdAt)}</p><blockquote><MarkdownContent text={source.text} tone="inherit" className="whitespace-normal" copySurface="message" preserveLineBreaks /></blockquote></article>)}</>:<p>This message is no longer included or accessible. Refresh the digest.</p>}</Sheet>}
    {editEvent&&(!review||editEvent.revision>0||output?.calendarCandidates.some(item=>item.id===review.item.id))&&editEvent.sourceIds.every(id=>sources.some(s=>s.id===id))&&<EventEditor key={editEvent.id+(review?.item.id??'')} event={editEvent} review={review} sources={sources} accountId={accountId} onClose={()=>setEditEvent(null)} onSave={event=>act(async()=>{if(event.recurrence&&!event.revision)await digestClient.saveSeries(accountId,event);else await digestClient.saveEvent(accountId,event);setEditEvent(null);})} onRemove={editEvent.revision?()=>act(async()=>{if(review?.series&&review.item.existingSeriesId)await digestClient.removeSeries(accountId,review.item.existingSeriesId,review.series);else await digestClient.removeEvent(accountId,editEvent);setEditEvent(null);}):undefined}/>}
    {importOpen&&<ImportSheet events={events} onClose={()=>setImportOpen(false)} onImport={saveImported}/>}
    {connections&&<ConnectSheet calendars={connections} onClose={()=>setConnections(null)} onImport={async ids=>{const from=new Date(),to=new Date();to.setFullYear(to.getFullYear()+1);return saveImported(await readDeviceEvents(ids,from.toISOString(),to.toISOString()));}}/>}
  </section></ActionErrorContext.Provider>;
}
function EventEditor({event,review,sources,accountId,onClose,onSave,onRemove}:{event:CalendarEvent;review:{item:DigestItem;original?:CalendarEvent;series?:CalendarEvent[]}|null;sources:DigestSource[];accountId:string;onClose:()=>void;onSave:(event:CalendarEvent)=>Promise<void>;onRemove?:()=>Promise<void>}){
  const [title,setTitle]=useState(event.title);
  const [start,setStart]=useState(event.allDay?event.startAt.slice(0,10):localInput(event.startAt));
  const initialEnd=shiftedCalendarEnd(event.startAt,event.startAt,event.endAt,event.allDay);
  const [end,setEnd]=useState(()=>event.allDay?initialEnd.slice(0,10):localInput(initialEnd));
  const [minutes,setMinutes]=useState(event.reminderAt?String(Math.round((Date.parse(event.startAt)-Date.parse(event.reminderAt))/60000)):event.revision===0&&!event.allDay?'10':'');
  const [rule,setRule]=useState<CalendarRecurrence|null>(()=>event.recurrence?{...event.recurrence,...(!event.recurrence.count&&!event.recurrence.until?{count:event.recurrence.frequency==='yearly'?5:12}:{})}:null);
  const [busy,setBusy]=useState(false);
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
    {links}{event.sourceIds.length>0&&<DigestPeople item={event} sources={sources} accountId={accountId} showMessages/>}{event.sourceIds.length===0&&event.description&&<p className="digest-event-context">{event.description}</p>}
    {error&&<p role="alert">{error}</p>}
    <footer>{onRemove&&<button type="button" disabled={busy} onClick={()=>void remove()}>Remove event</button>}<button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={busy||(needsPreview&&!preview.ready)}>{rule&&!event.revision?'Confirm series':review?.item.calendarAction==='update'?'Confirm change':event.revision?'Save event':'Add to calendar'}</button></footer>
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
function ConnectSheet({calendars,onClose,onImport}:{calendars:CalendarConnection[];onClose:()=>void;onImport:(ids:string[])=>Promise<CalendarImportReport>}){
  const [selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[report,setReport]=useState<CalendarImportReport|null>(null);
  async function run(){setBusy(true);setError(null);try{setReport(await onImport(selected));}catch(error){setError(calendarErrorMessage(error,'Could not import calendars.'));}finally{setBusy(false);}}
  return <Sheet title={report?'Import complete':'Choose calendars'} onClose={onClose}>{report?<ImportReport report={report} onClose={onClose}/>:<><p>Choose calendars connected to this device. Their events will be copied into your private Kordi calendar.</p>{error&&<p role="alert">{error}</p>}{calendars.map(c=><label className="digest-choice" key={c.id}><input type="checkbox" disabled={busy} checked={selected.includes(c.id)} onChange={e=>setSelected(s=>e.target.checked?[...s,c.id]:s.filter(id=>id!==c.id))}/>{c.title}</label>)}<p className="digest-meta">No invitations are sent. Source calendars stay unchanged.</p><footer><button disabled={busy} onClick={onClose}>Cancel</button><button disabled={!selected.length||busy} onClick={()=>void run()}>{busy?'Importing…':'Import selected calendars'}</button></footer></>}</Sheet>;
}
