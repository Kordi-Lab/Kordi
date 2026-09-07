import assert from 'node:assert/strict';
import test from 'node:test';
import {placeWeekEntries,weekDays,weekEntries} from '../src/features/digest/weekLayout';
import {isPendingCalendarProposal,proposalEvent,proposalSeries} from '../src/features/digest/calendarProposal';
import type {CalendarEvent,DigestItem} from '../src/features/digest/types';

test('week columns retain local dates, split overnight events and assign overlapping lanes',()=>{
  const previous=process.env.TZ;process.env.TZ='Asia/Riyadh';
  try{
    assert.deepEqual(weekDays('2026-12-31'),['2026-12-27','2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02']);
    const event=(id:string,startAt:string,endAt:string):CalendarEvent=>({id,title:id,startAt,endAt,allDay:false,sourceIds:[],description:'',revision:1});
    const rows=weekEntries([event('a','2026-09-08T06:00:00Z','2026-09-08T07:00:00Z'),event('b','2026-09-08T06:30:00Z','2026-09-08T07:30:00Z'),event('c','2026-09-08T07:30:00Z','2026-09-08T08:00:00Z')],[]);
    const placed=placeWeekEntries(rows,'2026-09-08');
    assert.deepEqual(placed.map(row=>[row.start,row.lane,row.lanes]),[[540,0,2],[570,1,2],[630,0,1]]);
    const overnight=weekEntries([event('night','2026-09-08T20:30:00Z','2026-09-08T21:30:00Z')],[]);
    assert.deepEqual(placeWeekEntries(overnight,'2026-09-08').map(row=>[row.start,row.end]),[[1410,1440]]);
    assert.deepEqual(placeWeekEntries(overnight,'2026-09-09').map(row=>[row.start,row.end]),[[0,30]]);
  }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});

test('model-selected series cancellation targets all and only the saved series, even with a reused proposal ID',()=>{
  const events:CalendarEvent[]=[8,15,22].map((day,index)=>({id:index?'occurrence-'+index:'digest-proposal',title:'Review',startAt:`2026-09-${day.toString().padStart(2,'0')}T12:00:00Z`,endAt:null,allDay:false,sourceIds:[],description:'',revision:index+1,seriesId:'owned-series'}));
  const other={...events[0],id:'other',seriesId:'other-series'};
  const item:DigestItem={id:'proposal',title:'Review',text:'A contextual request.',kind:'possible',sourceIds:['reply'],calendarAction:'delete',calendarScope:'series',existingSeriesId:'owned-series'};
  assert.equal(isPendingCalendarProposal(item,events),true);
  assert.deepEqual(proposalSeries(item,[...events,other])?.map(event=>event.id),events.map(event=>event.id));
  assert.equal(proposalEvent(item,events,[]).id,events[0].id);
  assert.equal(weekEntries([...events,other],[item]).filter(entry=>entry.proposal).length,3);
  assert.throws(()=>proposalEvent({...item,existingSeriesId:'unavailable'},events,[]),/series changed/);
  assert.equal(isPendingCalendarProposal({...item,calendarAction:'create',calendarScope:null,existingSeriesId:null},events),false);
});
