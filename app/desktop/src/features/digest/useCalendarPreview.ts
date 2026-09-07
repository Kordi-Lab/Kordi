import {useEffect, useState} from 'react';
import {digestClient} from './client';
import {calendarErrorMessage} from './calendarImport';
import type {CalendarEvent} from './types';

export function useCalendarPreview(accountId:string, request:string|null) {
  const [attempt,setAttempt]=useState(0);
  const [result,setResult]=useState<{accountId:string;request:string;attempt:number;events:CalendarEvent[];error:string|null}|null>(null);
  useEffect(()=>{
    if(!request)return;
    const controller=new AbortController();let cancelled=false;
    let timeout:ReturnType<typeof setTimeout>|undefined;
    const timer=setTimeout(()=>{
      timeout=setTimeout(()=>controller.abort(),15_000);
      void digestClient.previewSeries(accountId,JSON.parse(request) as CalendarEvent,controller.signal)
        .then(({events})=>{if(!events.length)throw new Error('No dates match this rule.');if(!cancelled)setResult({accountId,request,attempt,events,error:null});})
        .catch(error=>{if(!cancelled)setResult({accountId,request,attempt,events:[],error:controller.signal.aborted?'Loading dates timed out.':calendarErrorMessage(error,'Could not load dates.')});})
        .finally(()=>clearTimeout(timeout));
    },200);
    return()=>{cancelled=true;clearTimeout(timer);clearTimeout(timeout);controller.abort();};
  },[accountId,request,attempt]);
  const current=result?.accountId===accountId&&result.request===request&&result.attempt===attempt?result:null;
  return {events:current?.events??[],error:current?.error??null,loading:!!request&&!current,ready:!!current&&!current.error&&current.events.length>0,retry:()=>setAttempt(value=>value+1)};
}
