import {dateKey,eventOnDay} from './calendar';
import {isPendingCalendarProposal,proposalSeries} from './calendarProposal';
import type {CalendarEvent,DigestItem} from './types';

export const weekHourHeight=64;
export type WeekEntry={key:string;title:string;startAt:string;endAt?:string|null;allDay:boolean;event?:CalendarEvent;proposal?:DigestItem};
export function weekDays(day:string):string[]{
  const start=new Date(day+'T12:00:00');start.setDate(start.getDate()-start.getDay());
  return Array.from({length:7},(_,index)=>{const date=new Date(start);date.setDate(date.getDate()+index);return dateKey(date);});
}
export function weekEntries(events:CalendarEvent[],candidates:DigestItem[]):WeekEntry[]{
  const saved=events.map(event=>({...event,key:'event:'+event.id,event}));
  const proposals=candidates.filter(item=>isPendingCalendarProposal(item,events)).flatMap<WeekEntry>(item=>{
    const series=proposalSeries(item,events);
    if(series)return series.map(event=>({...event,key:`proposal:${item.id}:${event.id}`,event,proposal:item}));
    const target=events.find(event=>event.id===item.existingEventId);
    const startAt=item.startAt??target?.startAt;
    return startAt?[{key:'proposal:'+item.id,title:item.title,startAt,endAt:item.endAt??target?.endAt,allDay:target?.allDay??false,event:target,proposal:item}]:[];
  });
  const cancelled=new Set(proposals.filter(entry=>entry.proposal?.calendarAction==='delete').map(entry=>entry.event?.id));
  return [...saved.filter(entry=>!cancelled.has(entry.event.id)),...proposals];
}
export type WeekPlacement={entry:WeekEntry;start:number;end:number;lane:number;lanes:number};
export function placeWeekEntries(entries:WeekEntry[],day:string):WeekPlacement[]{
  const midnight=new Date(day+'T00:00:00'),next=new Date(midnight);next.setDate(next.getDate()+1);
  const minutes=(date:Date)=>date.getHours()*60+date.getMinutes()+date.getSeconds()/60;
  const rows=entries.filter(entry=>!entry.allDay&&eventOnDay(entry,day)).flatMap(entry=>{
    const startDate=new Date(entry.startAt),endDate=entry.endAt?new Date(entry.endAt):new Date(startDate.getTime()+30*60000);
    if(!Number.isFinite(startDate.getTime())||!Number.isFinite(endDate.getTime()))return [];
    const start=startDate<midnight?0:minutes(startDate);
    let end=endDate>=next?1440:minutes(endDate);
    // Repeated DST clock hours retain elapsed duration; labels retain the exact offset-bearing instants.
    if(end<=start)end=start+Math.max(1,(endDate.getTime()-startDate.getTime())/60000);
    return [{entry,start,end:Math.min(1440,Math.max(end,start+26*60/weekHourHeight)),lane:0,lanes:1}];
  }).sort((a,b)=>a.start-b.start||a.end-b.end||a.entry.key.localeCompare(b.entry.key));
  let group:WeekPlacement[]=[],ends:number[]=[],until=-1;
  const finish=()=>{for(const row of group)row.lanes=ends.length;group=[];ends=[];until=-1;};
  for(const row of rows){
    if(row.start>=until)finish();
    let lane=ends.findIndex(end=>end<=row.start);if(lane<0)lane=ends.length;
    ends[lane]=row.end;row.lane=lane;group.push(row);until=Math.max(until,row.end);
  }
  finish();return rows;
}
