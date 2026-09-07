import {useRef, useState, type CSSProperties, type ReactNode} from 'react';
import {readPreferenceStorageItem, resolvePreferenceStorage, writePreferenceStorageItem} from '@/features/cloud/preferenceStorage';

const widthKey='kordi.digest.sidebar-width.v1';
const bounded=(width:number,available=1120)=>Math.max(240,Math.min(width,560,available/2));

export function DigestSplit({children}:{children:[ReactNode,ReactNode]}) {
  const grid=useRef<HTMLDivElement>(null);
  const drag=useRef<{x:number;width:number;current:number}|null>(null);
  const [width,setWidth]=useState(()=>{
    const storage=resolvePreferenceStorage();
    const saved=Number(storage&&readPreferenceStorageItem(storage,widthKey));
    return Number.isFinite(saved)&&saved>0?bounded(saved):320;
  });
  function remember(value:number){const storage=resolvePreferenceStorage();if(storage)writePreferenceStorageItem(storage,widthKey,String(value));}
  function stop(){if(drag.current)remember(drag.current.current);drag.current=null;}
  return <div ref={grid} className="digest-content-grid" style={{'--digest-agenda-width':width+'px'} as CSSProperties}>
    {children[0]}
    <div className="digest-sidebar-resizer" role="separator" tabIndex={0} aria-label="Resize calendar sidebar" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={560} aria-valuenow={width}
      onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();const actual=grid.current?.querySelector('.digest-agenda')?.getBoundingClientRect().width??width;drag.current={x:event.clientX,width:actual,current:actual};event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{if(!drag.current)return;const next=bounded(drag.current.width+drag.current.x-event.clientX,grid.current?.clientWidth||1120);drag.current.current=next;setWidth(next);}}
      onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
      onDoubleClick={()=>{setWidth(320);remember(320);}}
      onKeyDown={event=>{const next=event.key==='ArrowLeft'?width+16:event.key==='ArrowRight'?width-16:event.key==='Home'?240:event.key==='End'?560:null;if(next===null)return;event.preventDefault();const value=bounded(next,grid.current?.clientWidth||1120);setWidth(value);remember(value);}}
    />
    {children[1]}
  </div>;
}
