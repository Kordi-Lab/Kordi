import type { CalendarEvent, CalendarConnection } from './types';
import { isNativeDesktopShell } from '@/lib/desktop';

export function dateKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
export function monthDays(month: string) {
  const start = new Date(`${month}-01T12:00:00`); start.setDate(start.getDate()-start.getDay());
  return Array.from({length:42},(_,i)=>{const day=new Date(start);day.setDate(day.getDate()+i);return dateKey(day);});
}
export function eventOnDay(event: CalendarEvent, day: string) {
  if(event.allDay) return day>=event.startAt.slice(0,10)&&(event.endAt?day<event.endAt.slice(0,10):day===event.startAt.slice(0,10));
  const start=dateKey(new Date(event.startAt));
  const last=event.endAt?dateKey(new Date(new Date(event.endAt).getTime()-1)):start;
  return day>=start&&day<=last;
}
type ImportedEvent = { id: string; title: string; startAt: string; endAt: string; allDay: boolean; date: string; endDateExclusive: string; description: string };
type WorkerReply = { error?: string; result?: { events: ImportedEvent[]; warnings: string[] } };
export type CalendarImport = { events: CalendarEvent[]; warnings: string[] };
export async function importCalendar(text: string, from: string, to: string): Promise<CalendarImport> {
  // Blob workers also work with the packaged desktop app's custom URL scheme.
  const scripts = await Promise.all(['ical.js', 'import.js'].map(async name => {
    const response = await fetch(new URL(`/digest/${name}`, window.location.href), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Could not load the calendar reader.');
    return response.text();
  }));
  const scriptUrl = URL.createObjectURL(new Blob([...scripts, '\nonmessage=({data})=>{try{postMessage({result:DigestICS.parse(data.text,data.from,data.to)});}catch(error){postMessage({error:error.message});}};'], { type: 'text/javascript' }));
  let worker: Worker;
  try { worker = new Worker(scriptUrl); } finally { URL.revokeObjectURL(scriptUrl); }
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{worker.terminate();reject(new Error('Calendar processing timed out. Export a smaller date range.'));},5000);
    worker.onerror=()=>{clearTimeout(timer);worker.terminate();reject(new Error('Could not read this calendar.'));};
    worker.onmessage=async({data}:MessageEvent<WorkerReply>)=>{
      clearTimeout(timer);worker.terminate();
      if(data.error||!data.result){reject(new Error(data.error||'The calendar response was invalid.'));return;}
      try {
        const events=await Promise.all(data.result.events.map(async(event: ImportedEvent)=>{
          const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(event.id)));
          const id='ics-'+Array.from(new Uint8Array(bytes)).map(v=>v.toString(16).padStart(2,'0')).join('');
          return {id,title:String(event.title),startAt:event.allDay?`${event.date}T00:00:00Z`:String(event.startAt),endAt:event.allDay?`${event.endDateExclusive}T00:00:00Z`:event.endAt===event.startAt?null:String(event.endAt),allDay:Boolean(event.allDay),description:String(event.description||''),sourceIds:[],externalUid:String(event.id),reminderAt:null,revision:0} satisfies CalendarEvent;
        }));
        resolve({events,warnings:data.result.warnings});
      }catch(error){reject(error instanceof Error?error:new Error('Could not read the calendar.'));}
    };
    worker.postMessage({text,from,to});
  });
}
export async function connectedCalendars():Promise<CalendarConnection[]> {
  if(!isNativeDesktopShell())throw new Error('Device calendar access is available in the desktop app. You can import ICS here.');
  const {invoke}=await import('@tauri-apps/api/core');
  return invoke('desktop_digest_calendars');
}
export async function readDeviceEvents(calendarIds:string[],from:string,to:string):Promise<CalendarEvent[]> {
  const {invoke}=await import('@tauri-apps/api/core');
  return invoke('desktop_digest_calendar_events',{calendarIds,from,to});
}
export async function syncReminders(accountId:string,events:CalendarEvent[],requestPermission=false):Promise<string>{
  if(!isNativeDesktopShell())return 'unavailable';
  const {invoke}=await import('@tauri-apps/api/core');
  return invoke('desktop_digest_reminders',{accountId,events,requestPermission});
}

export async function fetchCalendarLink(value:string):Promise<string>{
  const url=new URL(value.trim().replace(/^webcal:/i,'https:'));
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Use an HTTPS calendar link without embedded login credentials.');
  if(isNativeDesktopShell()){const {invoke}=await import('@tauri-apps/api/core');return invoke('desktop_digest_fetch_ics',{url:url.href});}
  const response=await fetch(url.href,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Could not fetch this calendar. Download its ICS file instead.');
  const reader=response.body?.getReader();if(!reader)throw new Error('Calendar response was empty.');
  const chunks:Uint8Array[]=[];let length=0;
  while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>1_000_000){await reader.cancel();throw new Error('Choose a calendar smaller than 1 MB.');}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
