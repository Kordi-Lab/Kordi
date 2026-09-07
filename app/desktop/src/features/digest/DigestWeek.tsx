import {useLayoutEffect,useMemo,useRef,type CSSProperties,type MouseEvent} from 'react';
import {ChevronLeft,ChevronRight} from 'lucide-react';
import {dateKey,eventOnDay} from './calendar';
import {placeWeekEntries,weekDays,weekEntries,weekHourHeight,type WeekEntry} from './weekLayout';
import type {CalendarEvent,DigestItem} from './types';

export function DigestWeek({day,events,candidates,onDay,onBack,onEvent,onCandidate}:{day:string;events:CalendarEvent[];candidates:DigestItem[];onDay:(day:string)=>void;onBack:(event:MouseEvent<HTMLButtonElement>)=>void;onEvent:(event:CalendarEvent)=>void;onCandidate:(item:DigestItem)=>void}){
  const days=useMemo(()=>weekDays(day),[day]);
  const entries=useMemo(()=>weekEntries(events,candidates),[events,candidates]);
  const scroll=useRef<HTMLDivElement>(null),grid=useRef<HTMLDivElement>(null),heading=useRef<HTMLHeadingElement>(null),lastFocus=useRef('');
  useLayoutEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
  useLayoutEffect(()=>{
    if(lastFocus.current===day||!scroll.current||!grid.current)return;lastFocus.current=day;
    const timed=placeWeekEntries(entries,day),allDay=entries.some(entry=>entry.allDay&&eventOnDay(entry,day));
    const target=timed[0]?.start??(allDay?0:9*60);
    scroll.current.scrollTop=target===0?0:grid.current.offsetTop+Math.max(0,target-60)*weekHourHeight/60-40;
  },[day,entries]);
  function move(delta:number){const date=new Date(day+'T12:00:00');date.setDate(date.getDate()+delta);onDay(dateKey(date));}
  function open(entry:WeekEntry){if(entry.proposal)onCandidate(entry.proposal);else if(entry.event)onEvent(entry.event);}
  function time(entry:WeekEntry,compact=false){
    if(entry.allDay)return 'All day';
    if(compact){const formatter:Intl.DateTimeFormat&{formatRange?:(start:Date,end:Date)=>string}=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'});const start=new Date(entry.startAt),end=entry.endAt?new Date(entry.endAt):null;
      if(end&&end>=start&&typeof formatter.formatRange==='function')return formatter.formatRange(start,end);
      return formatter.format(start);
    }
    return [entry.startAt,entry.endAt].filter(Boolean).map(value=>new Date(value!).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',timeZoneName:'short'})).join(' – ');
  }
  function button(entry:WeekEntry,style?:CSSProperties){const cancel=entry.proposal?.calendarAction==='delete';return <button key={entry.key} className={`digest-week-event${entry.proposal?' proposed':''}${cancel?' digest-cancellation':''}${entry.allDay?' all-day':''}`} style={style} onClick={()=>open(entry)} title={`${cancel?'Cancellation to review: ':entry.proposal?'To review: ':''}${entry.title} · ${time(entry)}`} aria-label={`${cancel?'Review cancellation: ':entry.proposal?'Review: ':''}${entry.title}, ${time(entry)}`}><strong>{entry.title}</strong><span>{cancel?'To cancel':time(entry,true)}</span></button>;}
  return <section className="digest-week-view" aria-label="Week calendar" style={{'--digest-hour-height':weekHourHeight+'px'} as CSSProperties}>
    <div className="digest-month-header"><button className="digest-week-back" onClick={onBack}><ChevronLeft size={16}/>Month</button><h2 ref={heading} tabIndex={-1}>{new Date(days[0]+'T12:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric'})} – {new Date(days[6]+'T12:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}</h2><div className="digest-month-controls"><button aria-label="Previous week" onClick={()=>move(-7)}><ChevronLeft size={16}/></button><button onClick={()=>onDay(dateKey(new Date()))}>Today</button><button aria-label="Next week" onClick={()=>move(7)}><ChevronRight size={16}/></button></div></div>
    <div className="digest-calendar-legend"><span><i className="scheduled"/>Scheduled</span><span><i className="proposed"/>To review</span><span>{Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div>
    <div className="digest-week-scroll" ref={scroll} tabIndex={0} role="region" aria-label="Weekly schedule">
      <div className="digest-week-columns digest-week-heading"><span/>{days.map(date=><button key={date} aria-pressed={date===day} onClick={()=>onDay(date)}>{new Date(date+'T12:00:00').toLocaleDateString(undefined,{weekday:'short',day:'numeric'})}</button>)}</div>
      {entries.some(entry=>entry.allDay&&days.some(date=>eventOnDay(entry,date)))&&<div className="digest-week-columns digest-week-all-day"><span>All day</span>{days.map(date=><div key={date}>{entries.filter(entry=>entry.allDay&&eventOnDay(entry,date)).map(entry=>button(entry))}</div>)}</div>}
      <div ref={grid} className="digest-week-columns digest-week-time-grid"><div className="digest-week-hours">{Array.from({length:24},(_,hour)=><span key={hour} style={{top:hour*weekHourHeight}}>{new Date(2026,0,1,hour).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</span>)}</div>{days.map(date=><div key={date} className={`digest-week-day${date===day?' selected':''}`} aria-label={new Date(date+'T12:00:00').toLocaleDateString(undefined,{dateStyle:'full'})}>{placeWeekEntries(entries,date).map(({entry,start,end,lane,lanes})=>button(entry,{top:start*weekHourHeight/60,height:Math.max(18,(end-start)*weekHourHeight/60),left:`calc(${lane*100/lanes}% + 2px)`,width:`calc(${100/lanes}% - 4px)`}))}</div>)}</div>
    </div>
  </section>;
}
