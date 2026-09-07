/* ICAL.js owns RFC parsing/recurrence; this adapter enforces the preview's limits. */
(function(root,factory){
  if(typeof module !== 'undefined') module.exports=factory(require('./ical.js'));
  else root.DigestICS=factory(root.ICAL);
})(typeof self !== 'undefined' ? self : this,function(ICAL){
  const E={
    day: value=>{const d=new Date(value);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');},
    wall: (date,time)=>new Date(date+'T'+time+':00').toISOString()
  };
  function parse(text,from,to) {
    if(typeof text!=='string'||text.length>1000000||unescape(encodeURIComponent(text)).length>1000000) throw Error('Use an ICS file smaller than 1 MB.');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||!(to>from)||(+new Date(to)-+new Date(from))/86400000>366) throw Error('Choose an import range of up to one year.');
    if(/^(https?:|webcal:)/i.test(text.trim())) throw Error('This is a calendar link. Use Connect calendar → ICS link, or paste the downloaded ICS file contents here.');
    let comp;
    try { comp=new ICAL.Component(ICAL.parse(text.replace(/^\uFEFF/,''))); } catch { throw Error('This is not valid ICS content. Paste the complete BEGIN:VCALENDAR … END:VCALENDAR text.'); }
    if(comp.name!=='vcalendar'||!/END:VCALENDAR\s*$/i.test(text)) throw Error('Paste a complete VCALENDAR file.');
    ICAL.TimezoneService.reset();
    const local=ICAL.Timezone.localTimezone;
    for(const zone of comp.getAllSubcomponents('vtimezone')) { const tz=new ICAL.Timezone(zone); ICAL.TimezoneService.register(tz.tzid,tz); }
    const parts=comp.getAllSubcomponents('vevent');
    if(!parts.length) throw Error('No calendar events were found.');
    if(parts.length>500) throw Error('This file has more than 500 event definitions. Export a smaller date range.');
    const result=[], warnings=[], seen=new Set(); let outside=0, steps=0;
    const instant=t=>{if(t.isDate)return E.wall(t.toString().slice(0,10),'00:00');const v=t.clone();if(v.zone===ICAL.Timezone.localTimezone)v.zone=local;return v.toJSDate().toISOString();};
    const localTime=iso=>{const d=new Date(iso);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');};
    const exceptions=parts.filter(p=>p.hasProperty('recurrence-id'));
    function checkZones(p) {
      for(const name of ['dtstart','dtend','recurrence-id','rdate','exdate']) for(const prop of p.getAllProperties(name)) {
        for(const value of prop.jCal.slice(3)) {
          if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}/.test(value))continue;
          const d=value.slice(0,10), test=new Date(d+'T12:00:00Z');
          if(!Number.isFinite(+test)||test.toISOString().slice(0,10)!==d)throw Error('Invalid calendar date.');
          if(value.includes('T')&&!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ?$/.test(value))throw Error('Invalid calendar time.');
        }
        const zone=prop.getParameter('tzid');
        if(zone&&!ICAL.TimezoneService.has(zone)) throw Error(`Timezone ${zone} has no VTIMEZONE definition. Export with timezone definitions or UTC dates.`);
      }
    }
    for(const part of parts.filter(p=>!p.hasProperty('recurrence-id'))) {
      const uid=part.getFirstPropertyValue('uid'), title=String(part.getFirstPropertyValue('summary')||'Untitled event').slice(0,160);
      try {
        if(!uid||String(uid).length>512) throw Error('A valid UID is required to prevent duplicate imports.');
        checkZones(part);
        const related=exceptions.filter(p=>p.getFirstPropertyValue('uid')===uid); related.forEach(checkZones);
        const event=new ICAL.Event(part,{exceptions:related,strictExceptions:true});
        if(!event.startDate) throw Error('Start date is missing.');
        if(part.getFirstPropertyValue('status')==='CANCELLED') {warnings.push(`${title}: cancelled event skipped; existing imports are not automatically removed.`);continue;}
        let scanEnd=to;
        for(const changed of related){
          const exception=new ICAL.Event(changed), changedDay=E.day(instant(exception.startDate)), originalDay=E.day(instant(exception.recurrenceId));
          if(changedDay>=from&&changedDay<to&&originalDay>=scanEnd){const d=new Date(originalDay+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);scanEnd=d.toISOString().slice(0,10);}
        }
        for(const prop of part.getAllProperties('rrule')){const rule=prop.getFirstValue();if(!['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(rule.freq))throw Error('Use daily, weekly, monthly or yearly recurrence.');}
        const recurring=event.isRecurring(), iter=recurring?event.iterator():null;
        let occurrence=recurring?iter.next():event.startDate;
        while(occurrence) {
          if(++steps>10000) throw Error('Recurrence scan limit reached; choose a smaller export.');
          const details=recurring?event.getOccurrenceDetails(occurrence):{startDate:event.startDate,endDate:event.endDate,item:event};
          const item=details.item, start=details.startDate, end=details.endDate;
          if(item.component.getFirstPropertyValue('status')!=='CANCELLED') {
            const startAt=instant(start), endAt=instant(end), allDay=start.isDate;
            const date=allDay?start.toString().slice(0,10):E.day(startAt), endDate=allDay?end.toString().slice(0,10):E.day(endAt);
            if(endAt<startAt) throw Error('End precedes start.');
            if(recurring&&(occurrence.isDate?occurrence.toString().slice(0,10):E.day(instant(occurrence)))>=scanEnd) break;
            if(date<to&&(allDay?endDate>from:date>=from||endDate>=from)) {
              const id='ics:'+encodeURIComponent(uid)+(recurring?':'+encodeURIComponent(occurrence.toString()):'');
              if(!seen.has(id)) {
                seen.add(id); result.push({id,uid:String(uid),origin:'ics',title:String(item.summary||title).slice(0,160),description:String(item.description||'').slice(0,5000),location:String(item.location||'').slice(0,500),
                  allDay,date,time:allDay?'':localTime(startAt),endTime:allDay?'':localTime(endAt),endDate,endDateExclusive:allDay?endDate:null,startAt,endAt,
                  timezone:'local',sourceTimezone:start.zone.tzid,sourceIds:[],revision:1,cancelled:false,reminderAt:null,reminderMinutes:null,recurring});
                if(result.length>1000) throw Error('More than 1,000 occurrences. Choose a shorter import range.');
              }
            } else outside++;
          }
          occurrence=recurring?iter.next():null;
        }
      } catch(error) {
        if(/limit|1,000/.test(error.message)) throw error;
        warnings.push(`${title}: ${error.message}`);
      }
    }
    for(const p of exceptions) if(!parts.some(master=>!master.hasProperty('recurrence-id')&&master.getFirstPropertyValue('uid')===p.getFirstPropertyValue('uid'))) warnings.push('A recurrence exception without its parent event was skipped.');
    if(outside) warnings.push('Occurrences outside the selected date range were not imported.');
    if(parts.some(p=>p.getAllSubcomponents('valarm').length)) warnings.push('ICS alarms are not activated automatically. Set reminders after import.');
    return {events:result.sort((a,b)=>a.startAt.localeCompare(b.startAt)),warnings:[...new Set(warnings)],from,to};
  }
  return {parse};
});
