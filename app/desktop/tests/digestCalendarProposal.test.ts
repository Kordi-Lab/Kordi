import assert from 'node:assert/strict';
import test from 'node:test';
import { proposalEvent, proposalLabel } from '../src/features/digest/calendarProposal';
import { digestEventLinks, digestLinkAction, digestSourceLinks } from '../src/features/digest/links';
import { externalMessageLinks, firstExternalMessageLink } from '../src/kordi-app/components/messageLinks';
import { eventOnDay, zonedEventLabel } from '../src/features/digest/calendar';
import type { CalendarEvent, DigestItem, DigestSource } from '../src/features/digest/types';

const source: DigestSource = {id:'message',conversationId:'conversation',sessionId:'session',sessionTitle:'Planning',senderAccountId:'viewer',senderName:'Viewer',text:'Join [Zoom](https://example.zoom.us/j/123?pwd=meeting) or **https://example.com/agenda**. `https://code.example/test`',createdAt:'2026-09-07T00:00:00Z',version:1};
const saved: CalendarEvent = {id:'meeting',title:'Weekly review',startAt:'2026-09-09T15:00:00+03:00',endAt:'2026-09-09T15:30:00+03:00',reminderAt:'2026-09-09T14:50:00+03:00',allDay:false,sourceIds:['message'],description:'Context',timezone:'Asia/Riyadh',links:['https://example.zoom.us/j/123?pwd=meeting'],revision:4};
const item: DigestItem = {id:'move-review',title:saved.title,text:'Move the meeting one hour later.',sourceIds:['message'],kind:'possible',calendarAction:'update',existingEventId:'meeting',existingEventRevision:4,startAt:'2026-09-09T13:00:00Z'};

test('a reschedule targets the reviewed revision and preserves duration, reminders, links and timezone',()=>{
  const next=proposalEvent(item,[saved],[source]);
  assert.equal(next.id,'meeting');assert.equal(next.revision,4);
  assert.equal(next.endAt,'2026-09-09T13:30:00.000Z');assert.equal(next.reminderAt,'2026-09-09T12:50:00.000Z');
  assert.deepEqual(next.links,saved.links);assert.equal(next.timezone,'Asia/Riyadh');
  assert.equal(saved.startAt,'2026-09-09T15:00:00+03:00');
  assert.throws(()=>proposalEvent(item,[{...saved,revision:5}],[source]),/changed/);
  assert.throws(()=>proposalEvent(item,[],[source]),/changed/);
  assert.equal(proposalLabel({...item,calendarAction:'delete'},[saved]),'Review cancellation');
  assert.deepEqual(proposalEvent({...item,calendarAction:'delete'},[saved],[source]),saved);
});

test('related links come from cited source messages, not invented model descriptions',()=>{
  assert.deepEqual(digestSourceLinks(['message'],[source]),['https://example.zoom.us/j/123?pwd=meeting','https://example.com/agenda']);
  assert.deepEqual(digestSourceLinks(['different'],[source]),[]);
  assert.deepEqual(digestEventLinks({...saved,description:'https://invented.example',links:undefined},[source]),digestSourceLinks(['message'],[source]));
  assert.equal(digestLinkAction(saved.links![0]),'Open Zoom');
  assert.equal(digestLinkAction('https://zoom.us.example.com/'),'Open link');
  assert.equal(firstExternalMessageLink(source.text)?.href,saved.links![0]);
  assert.deepEqual(externalMessageLinks('```\nhttps://code.example\n``` [unsafe](javascript:alert(1)) https://user:password@example.com'),[]);
});

test('a recurring proposal stays unsaved and retains its meeting timezone and end condition',()=>{
  const recurrence={frequency:'weekly' as const,interval:1,weekdays:[1],timezone:'America/New_York',count:3};
  const event=proposalEvent({...item,calendarAction:'create',existingEventId:null,existingEventRevision:null,recurrence},[],[source],'Asia/Riyadh');
  assert.equal(event.revision,0);assert.equal(event.timezone,'America/New_York');assert.deepEqual(event.recurrence,recurrence);
});

test('the same instant maps to local dates while all-day dates do not shift',()=>{
  assert.match(zonedEventLabel(saved.startAt,'Unknown/Timezone'),/UTC/);
  const oldZone=process.env.TZ;
  try {
    const event={...saved,startAt:'2026-09-08T00:30:00+03:00',endAt:null};
    process.env.TZ='America/Los_Angeles';assert.equal(eventOnDay(event,'2026-09-07'),true);
    process.env.TZ='Asia/Tokyo';assert.equal(eventOnDay(event,'2026-09-08'),true);
    for(const zone of ['America/Los_Angeles','Asia/Tokyo']){
      process.env.TZ=zone;
      assert.equal(eventOnDay({...event,allDay:true,startAt:'2026-09-08T00:00:00Z'},'2026-09-08'),true);
      assert.equal(eventOnDay({...event,allDay:true,startAt:'2026-09-08T00:00:00Z'},'2026-09-07'),false);
    }
  } finally {if(oldZone===undefined)delete process.env.TZ;else process.env.TZ=oldZone;}
});
