/* Mac person chat detail panel, Info tab: participants plus the shared media rows.
   Loaded before the inline script; uses its globals (S, STATES, PEOPLE, av, ic, esc, chev, sharedPage) at call time. */
const CI_ICONS={
  info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  box:'<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  tasks:'<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  memory:'<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/>'
};
const ci=k=>CI_ICONS[k]?`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${CI_ICONS[k]}</svg>`:ic(k);
const CI_TABS=[["msg","Messages"],["info","Info"],["box","Artifacts"],["tasks","Tasks"],["memory","Memory"]];
const CI_SELF={name:"Alex",ini:"A",seed:"#2563eb"};
const CI_GROUP={name:"Robotics reading group",ini:"RG",seed:"#e08a3c"};
/* [person, snippet, time] */
const CI_CHATS=[[null,"Sending the grant draft tonight","20:41","nadia"],[CI_GROUP,"Priya: next week is the diffusion paper","18:02"],[null,"Thanks, see you Thursday","Mon","priya"]];

function ciSidebar(){
  const rows=CI_CHATS.map(([g,snip,time,k],i)=>{const p=g||PEOPLE[k];
    return `<div class="m-row ci-chat${i===0?" on":""}">${av(p,32,{dot:k==="nadia",cls:"sm"})}<div class="grow" style="min-width:0"><div class="ci-top"><span class="nm ell">${esc(p.name)}</span><span class="ci-time">${time}</span></div><div class="sub ell">${esc(snip)}</div></div></div>`;}).join("");
  return `<aside class="m-list"><div class="m-lights"><i></i><i></i><i></i></div><div class="m-title">Chats</div><div class="m-search">${ic("search")}Search</div>${rows}</aside>`;
}
function ciPerson(p,sub,{online,dot}={}){
  return `<button class="row ci-p" data-act="profile-pop">${av(p,36,{dot,cls:"sm"})}<div class="grow"><div class="ci-nm ell">${esc(p.name)}</div><div class="ci-sub ell${online?" online":""}">${esc(sub)}</div></div>${chev}</button>`;
}
function ciInfo(){
  const st=STATES[S.state];
  const shared=st.shared.map(([k,l,n,pg])=>{
    const g=k==="users"&&n>0?`<span class="gav">${av(PEOPLE.g1,20)}${n>1?av(PEOPLE.g2,20):""}</span>`:"";
    const nav=pg&&n>0?` data-act="page" data-page="${pg}"`:"";
    return `<button class="row srow${n===0?" zero":""}"${nav}><span class="ic">${ic(k)}</span><span class="lb ell">${l}</span>${g}<span class="n">${n}</span>${chev}</button>`;
  }).join("");
  return `<div class="pv ci-col"><div class="sec">Participants</div><div class="card">${ciPerson(PEOPLE.nadia,"online",{online:true,dot:true})}${ciPerson(CI_SELF,"You")}</div>
    <div class="sec">Shared with you</div><div class="card">${shared}</div></div>`;
}
function chatInfo(){
  const tabs=CI_TABS.map(([k,l])=>`<button class="ci-tab${k==="info"?" on":""}" aria-selected="${k==="info"}" role="tab">${ci(k)}<span>${l}</span></button>`).join("");
  const body=S.page!=="profile"?sharedPage("chat"):ciInfo();
  return `<section aria-label="Mac chat info tab"><div class="mac">${ciSidebar()}
    <section class="m-pane ci-pane"><div class="ci-tabs" role="tablist">${tabs}</div><div class="ci-body">${body}</div></section></div></section>`;
}
