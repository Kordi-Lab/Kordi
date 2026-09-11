import {MessagesSquare,LoaderCircle} from 'lucide-react';
export function ThreadShortcut({count,busy,onClick,error}:{count:number;busy?:boolean;onClick:()=>void;error?:string|null}) {
  if(!count&&!error)return null;
  return <div className="flex items-center gap-2">
    {error?<div role="alert" className="max-w-64 rounded-xl border border-[color:var(--app-divider)] bg-[color:var(--app-main-bg)] p-3 text-xs">{error}<button className="ml-2 underline" onClick={onClick}>Retry</button></div>:null}
    <button type="button" aria-label="Jump to next unread thread" title="Jump to next unread thread" disabled={busy} onClick={onClick}
      className="relative grid h-11 w-11 place-items-center rounded-full border border-[color:var(--app-divider)] bg-[color:var(--app-native-main-bg)] text-[color:var(--app-sidebar-accent)] shadow-md transition hover:brightness-110 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--app-sidebar-accent)]">
      {busy?<LoaderCircle className="h-5 w-5 animate-spin motion-reduce:animate-none"/>:<MessagesSquare className="h-5 w-5" aria-hidden="true"/>}
      {count>0?<span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-[color:var(--app-sidebar-accent)] px-1 text-[10px] font-semibold text-[color:var(--app-sidebar-accent-text)]">{count>99?'99+':count}</span>:null}
    </button>
  </div>;
}
