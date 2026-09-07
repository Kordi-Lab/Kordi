import {useLayoutEffect,useMemo,useRef,useState,type ReactNode,type MouseEvent} from 'react';
import {AnimatePresence,motion,useReducedMotion} from 'framer-motion';
import { CalendarPlus, ChevronLeft, ChevronRight, FileUp } from 'lucide-react';
import { dateKey, eventOnDay, monthDays } from './calendar';
import type { CalendarEvent, DigestItem, DigestSource } from './types';
import { calendarProposalAvailable, isPendingCalendarProposal, proposalLabel, proposalSeries } from './calendarProposal';
import { digestEventLinks, digestSourceLinks } from './links';
import { DigestRelatedLinks } from './DigestRelatedLinks';
import {DigestWeek} from './DigestWeek';
import {weekEntries} from './weekLayout';

type CalendarProps = {
  month: string; selectedDay: string; events: CalendarEvent[]; candidates: DigestItem[];
  onMonth: (month: string) => void; onDay: (day: string) => void;
  onEvent: (event: CalendarEvent) => void; onCandidate: (item: DigestItem) => void;
};
export function DigestCalendar(props:CalendarProps) {
  const [view,setView]=useState<'month'|'week'>('month');
  const [instant,setInstant]=useState(false);
  const [opened,setOpened]=useState(false),reduce=useReducedMotion();
  const settings={instant,reduce:!!reduce};
  const enter={opacity:0,transform:reduce?'none':'scale(0.97)'};
  return <div className="digest-calendar-transition"><AnimatePresence initial={false} mode="wait" custom={settings}>
    <motion.div key={view} className="digest-calendar-pane" custom={settings} initial={instant?false:enter}
      animate={{opacity:1,transform:'scale(1)',transition:{duration:instant?0:reduce?0.1:0.18,ease:[0.23,1,0.32,1]}}}
      exit="leave" variants={{leave:({instant,reduce}:{instant:boolean;reduce:boolean})=>({opacity:0,transform:reduce?'none':'scale(0.97)',transition:{duration:instant?0:0.1,ease:[0.23,1,0.32,1]}})}}>
      {view==='month'?<DigestMonth {...props} restoreFocus={opened} onOpenWeek={(day,event)=>{setOpened(true);setInstant(event.detail===0);props.onMonth(day.slice(0,7));props.onDay(day);setView('week');}}/>:<DigestWeek day={props.selectedDay} events={props.events} candidates={props.candidates} onDay={day=>{props.onMonth(day.slice(0,7));props.onDay(day);}} onBack={event=>{setInstant(event.detail===0);setView('month');}} onEvent={props.onEvent} onCandidate={props.onCandidate}/>}
    </motion.div>
  </AnimatePresence></div>;
}
function DigestMonth({ month, selectedDay, events, candidates, onMonth, onDay, onEvent, onCandidate, onOpenWeek, restoreFocus }: CalendarProps & {onOpenWeek:(day:string,event:MouseEvent<HTMLButtonElement>)=>void;restoreFocus:boolean}) {
  const grid=useRef<HTMLDivElement>(null),[cellHeight,setCellHeight]=useState(120);
  useLayoutEffect(()=>{
    const element=grid.current;if(!element)return;
    const measure=()=>{if(element.clientHeight)setCellHeight(element.clientHeight/6);};measure();
    if(typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[]);
  useLayoutEffect(()=>{if(restoreFocus)grid.current?.querySelector<HTMLButtonElement>('.digest-day-number[aria-pressed=true]')?.focus({preventScroll:true});},[restoreFocus]);
  const monthDate = new Date(`${month}-01T12:00:00`);
  function step(delta: number) { const next = new Date(monthDate); next.setMonth(next.getMonth() + delta); onMonth(dateKey(next).slice(0, 7)); }
  const entries=useMemo(()=>weekEntries(events,candidates),[events,candidates]);
  return <section className="digest-calendar-view" aria-label="Month calendar">
    <div className="digest-month-header">
      <h2>{monthDate.toLocaleDateString(undefined, { month: 'long' })} <span>{monthDate.getFullYear()}</span></h2>
      <div className="digest-month-controls">
        <button aria-label="Previous month" onClick={() => step(-1)}><ChevronLeft size={16}/></button>
        <button onClick={() => { const today = dateKey(new Date()); onMonth(today.slice(0, 7)); onDay(today); }}>Today</button>
        <button aria-label="Next month" onClick={() => step(1)}><ChevronRight size={16}/></button>
      </div>
    </div>
    <div className="digest-calendar-legend"><span><i className="scheduled"/> Scheduled</span><span><i className="proposed"/> To review</span></div>
    <div className="digest-month" role="group" aria-label="Calendar dates">
      <div className="digest-weekdays" aria-hidden="true">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => <span key={day}>{day}</span>)}</div>
      <div className="digest-month-days" ref={grid}>
        {monthDays(month).map(day => {
          const matching=entries.filter(entry=>eventOnDay(entry,day)).sort((a,b)=>Date.parse(a.startAt)-Date.parse(b.startAt));
          const total = matching.length;
          const available=Math.max(0,cellHeight-40),full=Math.max(0,Math.floor((available+3)/25));
          const slots=total<=full?full:Math.max(0,Math.floor((available-18)/25));
          const shown=Math.min(total,slots);
          return <div key={day} className={`${day.startsWith(month) ? '' : 'outside'} ${day === selectedDay ? 'selected' : ''}`}>
            <button className="digest-day-hitbox" tabIndex={-1} aria-hidden="true" onClick={event=>onOpenWeek(day,event)}/>
            <button className={`digest-day-number ${day === dateKey(new Date()) ? 'today' : ''}`} aria-label={new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'full' })} aria-pressed={day === selectedDay} onClick={event=>onOpenWeek(day,event)}>{Number(day.slice(-2))}</button>
            <div className="digest-day-events">
              {matching.slice(0,slots).map(entry=><button className={`digest-calendar-event${entry.proposal?' proposed':''}${entry.proposal?.calendarAction==='delete'?' digest-cancellation':''}`} key={entry.key} title={`${entry.proposal?.calendarAction==='delete'?'Cancellation to review: ':entry.proposal?'To review: ':''}${entry.title}`} onClick={()=>entry.proposal?onCandidate(entry.proposal):entry.event&&onEvent(entry.event)}><span>{entry.allDay?'All day':new Date(entry.startAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</span><strong>{entry.proposal?.calendarAction==='delete'?'Cancel: ':''}{entry.title}</strong></button>)}
              {total > shown && <button className="digest-more" onClick={event=>onOpenWeek(day,event)}>+{total - shown} more</button>}
            </div>
          </div>;
        })}
      </div>
    </div>
  </section>;
}

export function DigestAgenda({ day, events, candidates, sources, people, evidence, onEvent, onCandidate, onConnect, onImport }: {
  day: string; events: CalendarEvent[]; candidates: DigestItem[];
  sources: DigestSource[];
  people: (item: DigestItem) => ReactNode; evidence: (item: DigestItem) => ReactNode;
  onEvent: (event: CalendarEvent) => void; onCandidate: (item: DigestItem) => void;
  onConnect: () => void; onImport: () => void;
}) {
  const scheduled = events.filter(event => eventOnDay(event, day));
  const available=candidates.filter(item=>calendarProposalAvailable(item,events));
  return <aside className="digest-agenda" aria-label="Schedule and calendar suggestions" tabIndex={0}>
    <section>
      <h2>{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</h2>
      <p className="digest-meta">{Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
      {scheduled.length ? scheduled.map(event => <div key={event.id}><button className="digest-agenda-event" onClick={() => onEvent(event)}><span>{event.allDay ? 'All day' : new Date(event.startAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span><strong>{event.title}</strong></button><DigestRelatedLinks links={digestEventLinks(event,sources)}/></div>) : <p className="digest-muted">No events scheduled for this day.</p>}
    </section>
    <section className="digest-proposals">
      <h2>From your chats</h2>
      <p className="digest-muted">Review proposed additions, changes and cancellations.</p>
      {available.map(item => <article className={`digest-proposal${item.calendarAction==='delete'?' digest-cancellation':''}`} key={item.id}>
        <div className="digest-proposal-label">{item.calendarAction==='delete'?'Cancellation to review':isPendingCalendarProposal(item,events)?'To review':'Scheduled'}</div>
        <h3>{item.title}</h3>
        <p className="digest-proposal-time">{item.calendarScope==='series'?`${proposalSeries(item,events)?.length??0} events in this series`:item.startAt ? new Date(item.startAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Date or time not agreed'}</p>
        {people(item)}{evidence(item)}
        <DigestRelatedLinks links={digestSourceLinks(item.sourceIds,sources)}/>
        <button className="digest-primary-action" onClick={() => onCandidate(item)}>{proposalLabel(item,events)}</button>
      </article>)}
      {!available.length && <p className="digest-muted">New arrangements will appear here.</p>}
    </section>
    <section className="digest-calendar-connections">
      <h2>Your calendars</h2>
      <button onClick={onConnect}><CalendarPlus size={16} strokeWidth={1.6} aria-hidden="true"/> Connect calendars</button>
      <button onClick={onImport}><FileUp size={16} strokeWidth={1.6} aria-hidden="true"/> Import ICS</button>
    </section>
  </aside>;
}
