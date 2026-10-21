/* Shared media sub-pages and the Mac chat info popover frame for the contact profile preview.
   Loaded before the inline script; uses its globals (S, STATES, ic, esc, profile) at call time. */
const PH_SEEDS=["#8fa3b8","#b59a7c","#7fa58e","#a78bb0","#c9a46a","#6f8fa6","#b38282"];
const FAV_SEEDS={"arxiv.org":"#b0413e","cemse.kaust.edu.sa":"#2f6f8f","frankaemika.github.io":"#4a4a52","huggingface.co":"#c99a2e","figma.com":"#8a5cc2","github.com":"#3b3f46","roboticsconference.org":"#3a7d5c","nature.com":"#2d5d8a","onshape.com":"#2b78b7"};
const PAGE_TITLES={photos:"Photos",files:"Files",links:"Links"};

/* Synthetic shared media per state; counts match the profile rows */
const MEDIA_NADIA={
  photos:[["October",7],["September",5]],
  files:[["October",[["Grant draft v3.pdf","1.2 MB","14 Oct"],["Lab inventory.xlsx","48 KB","2 Oct"]]],["September",[["Manipulation notes.md","6 KB","29 Sep"]]]],
  links:[["October",[["Sim-to-real transfer survey","arxiv.org","18 Oct"],["KAUST robotics seminar","cemse.kaust.edu.sa","15 Oct"],["Franka setup guide","frankaemika.github.io","11 Oct"],["Tabletop grasping dataset","huggingface.co","7 Oct"],["Lab bench layout","figma.com","3 Oct"]]],
         ["September",[["Diffusion policy code","github.com","27 Sep"],["RSS call for papers","roboticsconference.org","22 Sep"],["Tactile sensing review","nature.com","16 Sep"],["Gripper CAD files","onshape.com","9 Sep"]]]]
};
const MEDIA={
  "person-online":MEDIA_NADIA,
  "common-ground":MEDIA_NADIA,
  "chat-info":MEDIA_NADIA,
  "person-offline":{photos:[["October",4]],files:[],links:[]},
  "person-new":{photos:[],files:[],links:[]},
  agent:{
    photos:[["October",4],["September",2]],
    files:[["October",[["Weekly digest.md","4 KB","20 Oct"],["Meeting notes.md","3 KB","17 Oct"],["Reading list.md","2 KB","9 Oct"]]],["September",[["Seminar summary.pdf","220 KB","24 Sep"],["Grant checklist.md","5 KB","12 Sep"]]]],
    links:[["October",[["Sim-to-real transfer survey","arxiv.org","18 Oct"],["KAUST robotics seminar","cemse.kaust.edu.sa","15 Oct"]]]]
  }
};
const EMPTY_MEDIA={photos:"No photos",files:"No files",links:"No links"};

const COUNT_NOUN={photos:["photo","photos"],files:["file","files"],links:["link","links"]};
function spCount(groups){
  const n=groups.reduce((a,[,x])=>a+(Array.isArray(x)?x.length:x),0);
  return n?`${n} ${COUNT_NOUN[S.page][n===1?0:1]}`:"";
}
function spHeader(where,title,count){
  if(where==="ios")return `<div class="sp-hd"><button class="sp-back" data-act="page" data-page="profile" aria-label="Back">${ic("chevl")}</button><span class="sp-title">${title}</span></div>`;
  /* Mac toolbar: back control, title, quiet count; pane and chat tab show a "Back" label, the popover is icon only */
  const label=where==="pop"?"":`<span class="sp-back-l">Back</span>`;
  return `<div class="sp-hd"><div class="sp-hd-in"><button class="sp-back" data-act="page" data-page="profile" aria-label="${where==="chat"?"Back":"Back to profile"}" title="Back">${ic("chevl")}${label}</button><span class="sp-title ell">${title}</span>${count?`<span class="sp-count">${count}</span>`:""}</div></div>`;
}
function spPhotos(groups){
  let k=0;
  return groups.map(([m,n])=>{
    const tiles=Array.from({length:n},()=>{const c=PH_SEEDS[(k*3+Math.floor(k/4))%PH_SEEDS.length];k++;return `<button class="sp-ph" style="--ph:${c}" aria-label="Photo"></button>`;}).join("");
    return `<div class="sp-mon">${m}</div><div class="sp-grid">${tiles}</div>`;
  }).join("");
}
function spFiles(groups){
  return groups.map(([m,items])=>`<div class="sp-mon">${m}</div><div class="card">${items.map(([name,size,date])=>
    `<div class="row click"><span class="sp-lead doc">${ic("doc")}</span><div class="grow"><div class="v ell">${esc(name)}</div><div class="c">${size} · ${date}</div></div></div>`).join("")}</div>`).join("");
}
function spLinks(groups){
  return groups.map(([m,items])=>`<div class="sp-mon">${m}</div><div class="card">${items.map(([title,domain,date])=>
    `<div class="row click"><span class="sp-lead fav" style="--fav:${FAV_SEEDS[domain]||"#6b7280"}">${esc(domain[0].toUpperCase())}</span><div class="grow"><div class="v ell">${esc(title)}</div><div class="c accent ell">${esc(domain)}</div></div><span class="d">${date}</span></div>`).join("")}</div>`).join("");
}
function sharedPage(where){
  const media=MEDIA[S.state]||{photos:[],files:[],links:[]};
  const groups=media[S.page]||[];
  const body=!groups.length?`<div class="sp-empty">${EMPTY_MEDIA[S.page]}</div>`
    :S.page==="photos"?spPhotos(groups):S.page==="files"?spFiles(groups):spLinks(groups);
  return `<div class="pv sp">${spHeader(where,PAGE_TITLES[S.page],spCount(groups))}<div class="sp-body">${body}</div></div>`;
}

/* Mac chat info popover over a faded chat */
function pop(){
  const bubbles=[["",62],["me",44],["",70],["",38],["me",56],["",48]].map(([c,w])=>`<span class="${c}" style="--w:${w}%"></span>`).join("");
  return `<section aria-label="Mac chat info popover"><div class="chatwin">
    <div class="fakechat" aria-hidden="true"><div class="fc-top"><i></i><i></i><i></i><b></b></div><div class="fc-msgs">${bubbles}</div><div class="fc-comp"></div></div>
    <div class="popcard" role="dialog" aria-label="Chat info"><button class="pop-x" aria-label="Close">${ic("x")}</button><div class="pop-scroll">${profile("pop")}</div></div>
  </div></section>`;
}
