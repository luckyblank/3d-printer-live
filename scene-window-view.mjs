import {DEFAULT_SCENE_SETTINGS,normalizeSceneSettings,normalizeSceneSnapshot} from './scene-window-model.mjs';
import {GIFT_ICON_FALLBACKS} from './scene-gift-icons.mjs';

const GIFT_ICONS={heart:'assets/generated/original-icons/heart.png',beer:'assets/generated/original-icons/beer.png',lollipop:'assets/generated/original-icons/lollipop.png'};
const words=lang=>lang==='en'?{
 rules:'Print rules',waitingRules:'Waiting for workspace rules…',comment:'Comment',join:'Join',like:'Like',follow:'Follow',heart:'Heart',beer:'Beer',lollipop:'Lollipop',other:'Other gifts',giftOff:'Gift printing is off',allOff:'Interaction printing is off',
 queue:'Print queue',emptyQueue:'Waiting for viewers',priority:'Gift priority',small:'Small',large:'Large',current:'Current print',idle:'Waiting for a print',paused:'Paused',printing:'Printing',reveal:'Print complete',transfer:'Transferring',score:'pts',
 session:'Session',printed:'Printed',waiting:'Waiting',likes:'Likes',comments:'Comments',gifts:'Gifts',anonymous:'Viewer'
}:{
 rules:'打印规则',waitingRules:'等待主窗口同步规则…',comment:'评论',join:'进场',like:'点赞',follow:'关注',heart:'爱心',beer:'啤酒',lollipop:'棒棒糖',other:'其他礼物',giftOff:'礼物打印已关闭',allOff:'互动打印已关闭',
 queue:'等待打印',emptyQueue:'等待观众加入',priority:'礼物优先',small:'小图',large:'大图',current:'当前任务',idle:'等待打印任务',paused:'已暂停',printing:'正在打印',reveal:'制作完成',transfer:'正在转运',score:'分',
 session:'本场数据',printed:'已打印',waiting:'等待中',likes:'点赞',comments:'评论',gifts:'礼物',anonymous:'观众'
};

export function initialSceneSettings(search=''){
 const settings={...DEFAULT_SCENE_SETTINGS},onTop=new URLSearchParams(search).get('onTop');
 if(onTop==='0'||onTop==='1')settings.onTop=onTop==='1';
 return settings;
}

export function sceneOverlayContent(snapshot,{portrait=false}={}){
 if(!snapshot)return null;
 const state=normalizeSceneSnapshot(snapshot),t=words(state.lang),rules=state.rules;
 const giftRows=rules.giftEnabled?[
  ['heart',t.heart,rules.heartCount],['beer',t.beer,rules.beerCount],['lollipop',t.lollipop,rules.lollipopCount],['other',t.other,rules.otherCount]
 ].map(([kind,label,count])=>({kind,label,count,size:rules.giftSize,icon:GIFT_ICONS[kind]||''})):[];
 const current=state.current;
 const triggers=['comment','join','like','follow'].filter(kind=>rules[kind+'Enabled']).map(kind=>({kind,label:kind==='comment'?t.comment+' 666':t[kind],count:rules[kind+'Count'],size:rules[kind+'Size']}));
 return {...state,t,giftRows,triggers,queue:state.queue.slice(0,portrait?3:5),comment:rules.commentEnabled?{count:rules.commentCount,size:rules.commentSize}:null,
  currentStatus:current?(current.paused?t.paused:t[current.status]||current.status||t.printing):t.idle};
}

export function mountSceneResizeHandles({root=globalThis.document?.body,api=()=>globalThis.pywebview?.api}={}){
 if(!root)throw Error('Scene resize handles need a document root');
 const doc=root.ownerDocument||globalThis.document;
 let layer=null,destroyed=false;const bindings=[];
 const bridge=()=>{try{return api()}catch{return undefined}};
 function remove(){
  for(const [element,handler]of bindings.splice(0))element.removeEventListener('pointerdown',handler);
  layer?.remove();layer=null;
 }
 function nativeReady(){
  if(destroyed)return;
  if(typeof bridge()?.resize_scene_window!=='function'){remove();return;}
  if(layer)return;
  // A sibling of the display-only overlay keeps these native-only hit areas
  // outside its pointer-events:none!important rule. Nothing is painted.
  layer=doc.createElement('div');layer.className='scene-window-resize-handles';layer.setAttribute('aria-hidden','true');
  for(const edge of ['left','right']){
   const handle=doc.createElement('div');handle.className='scene-window-resize-handle scene-window-resize-'+edge;handle.dataset.edge=edge;
   const down=event=>{
    if(destroyed||event.button!==0||event.isPrimary===false)return;
    const current=bridge();if(typeof current?.resize_scene_window!=='function'){nativeReady();return;}
    event.preventDefault();event.stopPropagation();
    try{Promise.resolve(current.resize_scene_window(edge)).catch(()=>{})}catch{}
   };
   handle.addEventListener('pointerdown',down);bindings.push([handle,down]);layer.append(handle);
  }
  root.append(layer);
 }
 nativeReady();
 return {nativeReady,destroy(){if(destroyed)return;destroyed=true;remove();}};
}

export function createSceneWindowView({root=globalThis.document?.body,api=()=>globalThis.pywebview?.api,search=globalThis.location?.search||'',theme='dark',width=globalThis.innerWidth||960,height=globalThis.innerHeight||540}={}){
 if(!root)throw Error('Scene overlay needs a document root');
 const doc=root.ownerDocument||globalThis.document;
 let settings=initialSceneSettings(search),snapshot=null,portrait=height>width,destroyed=false,viewportWidth=width,viewportHeight=height;
 let appliedTopmost=null,topmostEpoch=0,topmostSync=null,topmostAgain=false;
 const element=doc.createElement('div');element.className='scene-window-overlays';element.setAttribute('aria-label','直播画面信息');element.style.pointerEvents='none';
 root.append(element);
 const resizeHandles=mountSceneResizeHandles({root,api});
 const cards={},cardKeys={};let queueNodes=null,queueRowsKey=null,currentNodes=null,currentPersonKey=null;
 const avatarFallbacks=new WeakMap();
 // Three known gift kinds only: remember a failed URL across card rebuilds,
 // and stop entirely if the same original PNG also fails as an inline image.
 const failedKinds=new Map();
 const make=(tag,className,text)=>{const e=doc.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=String(text);return e};
 for(const corner of ['stats','queue','rules','current']){cards[corner]=make('section','scene-overlay-card scene-overlay-'+corner);cards[corner].hidden=true;element.append(cards[corner]);}
 const t=()=>words(snapshot?.lang);
 const sizeLabel=size=>size==='large'?t().large:t().small;
 function number(value){
  if(snapshot?.lang==='en'){if(value>=1e6)return (value/1e6).toFixed(value>=1e7?0:1).replace(/\.0$/,'')+'M';if(value>=1e4)return (value/1e3).toFixed(0)+'K';}
  else{if(value>=1e8)return (value/1e8).toFixed(1).replace(/\.0$/,'')+'亿';if(value>=1e4)return (value/1e4).toFixed(1).replace(/\.0$/,'')+'万';}
  return String(value);
 }
 function heading(card,label,total){const head=make('div','scene-overlay-heading');head.append(make('h2','',label));if(total!==undefined)head.append(make('span','scene-overlay-total',number(total)));card.append(head);}
 function avatar(person,className='scene-overlay-avatar'){
  const wrapper=make('span',className),fallback=make('span','scene-avatar-initial',(person.name||t().anonymous).slice(0,1));wrapper.append(fallback);
  avatarFallbacks.set(wrapper,fallback);
  if(person.avatar){const img=make('img');img.alt='';img.decoding='async';img.referrerPolicy='no-referrer';img.src=person.avatar;img.onload=()=>{fallback.hidden=true};img.onerror=()=>{img.hidden=true;fallback.hidden=false};wrapper.append(img);}
  return wrapper;
 }
 function giftIcon(rule){
  const img=make('img','scene-rule-icon'),fallback=GIFT_ICON_FALLBACKS[rule.kind];img.alt='';
  let inline=failedKinds.get(rule.kind)==='inline';
  if(failedKinds.get(rule.kind)==='hidden'){img.style.visibility='hidden';img.onerror=null;return img;}
  img.onerror=()=>{
   if(!inline&&fallback){inline=true;failedKinds.set(rule.kind,'inline');img.src=fallback;}
   else{failedKinds.set(rule.kind,'hidden');img.onerror=null;img.style.visibility='hidden';}
  };
  img.src=inline?fallback:rule.icon;
  return img;
 }
 function renderRules(content){
  const card=cards.rules;card.hidden=!settings.showGiftRules;if(card.hidden)return false;
  const key=JSON.stringify([content?.lang||'zh-CN',content?.rules||null]);if(cardKeys.rules===key)return false;cardKeys.rules=key;card.replaceChildren();
  heading(card,t().rules);
  if(!content){card.append(make('p','scene-overlay-empty',t().waitingRules));return true;}
  if(content.triggers.length){
   const triggers=make('div','scene-overlay-triggers');
   for(const trigger of content.triggers){
    const comment=trigger.kind==='comment',row=make('div','scene-overlay-trigger'+(comment?' scene-overlay-comment':''));row.dataset.trigger=trigger.kind;
    row.append(make('span','scene-trigger-prefix'+(comment?' scene-comment-prefix':''),trigger.label),make('span','scene-trigger-result'+(comment?' scene-comment-result':''),` → ${sizeLabel(trigger.size)} × ${trigger.count}`));
    triggers.append(row);
   }
   card.append(triggers);
  }
  for(const rule of content.giftRows){
   const row=make('div','scene-overlay-rule'+(rule.kind==='other'?' scene-overlay-rule-other':''));
   if(rule.icon)row.append(giftIcon(rule));else row.append(make('span','scene-rule-other','＋'));
   row.append(make('span','scene-rule-name',rule.label),make('strong','scene-rule-amount',`${sizeLabel(rule.size)} × ${rule.count}`));card.append(row);
  }
  if(!content.giftRows.length)card.append(make('p','scene-overlay-empty',content.triggers.length?t().giftOff:t().allOff));
  return true;
 }
 function renderQueue(content){
  const card=cards.queue;card.hidden=!settings.showQueue||!content;if(card.hidden)return;
  const key=JSON.stringify([content.lang,content.waiting,content.queue]);if(cardKeys.queue===key)return;cardKeys.queue=key;
  if(!queueNodes){
   const head=make('div','scene-overlay-heading'),label=make('h2'),total=make('span','scene-overlay-total'),empty=make('p','scene-overlay-empty'),list=make('ol','scene-overlay-queue-list');
   head.append(label,total);card.append(head,list,empty);queueNodes={label,total,empty,list};
  }
  const {label,total,empty,list}=queueNodes;label.textContent=t().queue;total.textContent=number(content.waiting);empty.textContent=t().emptyQueue;
  empty.hidden=content.queue.length>0;list.hidden=!content.queue.length;
  // A counter change does not remove and recreate the same viewer avatars.
  const rowsKey=JSON.stringify([content.lang,content.queue]);if(rowsKey===queueRowsKey)return;queueRowsKey=rowsKey;list.replaceChildren();
  for(const [index,person]of content.queue.entries()){
   const row=make('li','scene-overlay-queue-row');row.append(make('span','scene-queue-order',String(index+1).padStart(2,'0')),avatar(person));
   const info=make('div','scene-queue-person');info.append(make('strong','scene-queue-name',person.name||t().anonymous));
   const meta=make('div','scene-queue-meta');meta.append(make('span','',sizeLabel(person.size)));if(person.priority)meta.append(make('span','scene-queue-priority',t().priority));info.append(meta);row.append(info);list.append(row);
  }
 }
 function renderCurrent(content){
  const card=cards.current;card.hidden=!settings.showCurrent||!content;if(card.hidden)return;
  const key=JSON.stringify([content.lang,content.current]);if(cardKeys.current===key)return;cardKeys.current=key;
  if(!currentNodes){
   const head=make('div','scene-overlay-heading'),label=make('h2'),empty=make('p','scene-overlay-empty'),line=make('div','scene-current-person'),slot=make('span','scene-current-avatar-slot'),info=make('div','scene-current-info');
   const name=make('strong','scene-current-name'),status=make('span','scene-current-status'),score=make('strong','scene-current-score'),track=make('div','scene-current-progress'),fill=make('i');
   head.append(label);info.append(name,status);line.append(slot,info,score);track.append(fill);track.setAttribute('role','progressbar');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');card.append(head,line,track,empty);
   currentNodes={label,empty,line,slot,name,status,score,track,fill,avatar:null};
  }
  const nodes=currentNodes,person=content.current;nodes.label.textContent=t().current;nodes.empty.textContent=t().idle;nodes.empty.hidden=!!person;nodes.line.hidden=!person;
  if(!person){nodes.track.hidden=true;nodes.slot.replaceChildren();nodes.avatar=null;currentPersonKey=null;return;}
  const personKey=JSON.stringify([person.name,person.avatar]);
  if(personKey!==currentPersonKey){currentPersonKey=personKey;nodes.avatar=avatar(person,'scene-overlay-avatar scene-current-avatar');nodes.slot.replaceChildren(nodes.avatar);}
  const initial=avatarFallbacks.get(nodes.avatar);if(initial)initial.textContent=(person.name||t().anonymous).slice(0,1);
  nodes.name.textContent=person.name||t().anonymous;nodes.status.textContent=content.currentStatus;nodes.score.hidden=person.score===null;nodes.score.textContent=person.score===null?'':`${Math.round(person.score)}${t().score}`;
  nodes.track.hidden=person.status!=='printing'&&!person.paused;nodes.track.setAttribute('aria-label',content.currentStatus);nodes.track.setAttribute('aria-valuenow',String(person.progress));nodes.fill.style.width=person.progress+'%';
 }
 function renderStats(content){
  const card=cards.stats;card.hidden=!settings.showStats||!content;if(card.hidden)return;
  const key=JSON.stringify([content.lang,content.printed,content.waiting,content.likes,content.comments,content.gifts]);if(cardKeys.stats===key)return;cardKeys.stats=key;card.replaceChildren();
  heading(card,t().session);
  const primary=make('div','scene-stat-primary');
  for(const [label,value]of [[t().printed,content.printed],[t().waiting,content.waiting]]){const cell=make('div');cell.append(make('span','',label),make('strong','',number(value)));primary.append(cell);}card.append(primary);
  const secondary=make('div','scene-stat-secondary');for(const [label,value]of [[t().likes,content.likes],[t().comments,content.comments],[t().gifts,content.gifts]]){const cell=make('div');cell.append(make('span','',label),make('strong','',number(value)));secondary.append(cell);}card.append(secondary);
 }
 function render(){if(destroyed)return false;const content=sceneOverlayContent(snapshot,{portrait});element.dataset.orientation=portrait?'portrait':'landscape';element.lang=snapshot?.lang||'zh-CN';const rulesChanged=renderRules(content);renderQueue(content);renderCurrent(content);renderStats(content);element.dataset.statsVisible=String(!cards.stats.hidden);element.dataset.currentVisible=String(!cards.current.hidden);if(rulesChanged)fitRules();return rulesChanged;}
 function syncTopmost(){
  if(destroyed)return Promise.resolve();
  if(topmostSync){topmostAgain=true;return topmostSync;}
  topmostSync=(async()=>{
   while(!destroyed&&appliedTopmost!==settings.onTop){
    const bridge=api();if(typeof bridge?.set_scene_topmost!=='function')break;
    const desired=settings.onTop,epoch=topmostEpoch;
    let result;try{result=await bridge.set_scene_topmost(desired)}catch{break;}
    if(destroyed)break;if(epoch!==topmostEpoch)continue;
    if(result?.applied===false||(typeof result?.onTop==='boolean'&&result.onTop!==desired))break;
    appliedTopmost=desired;
   }
  })().finally(()=>{topmostSync=null;if(topmostAgain&&!destroyed){topmostAgain=false;return syncTopmost();}});
  return topmostSync;
 }
 function applyPanelStyles(){
  // The matching transform origin accounts for scaled card dimensions. CSS
  // caps the unscaled box to the usable viewport divided by its scale.
  // Density uses only viewport/preferences, never DOM or image measurements.
  const margin=portrait?10:12;
  for(const [panel,card]of Object.entries(cards)){
   for(const [suffix,variable]of [['X','--scene-panel-x'],['Y','--scene-panel-y'],['Opacity','--scene-panel-opacity'],['Scale','--scene-panel-scale']]){
    card.style.setProperty(variable,String(settings[panel+suffix]/100));
   }
   const scale=settings[panel+'Scale']/100,usableHeight=(viewportHeight-2*margin)/scale,usableWidth=(viewportWidth-2*margin)/scale;
   card.dataset.density=usableHeight<=190||usableWidth<=170?'tight':usableHeight<=420?'compact':'normal';
  }
 }
 function fitRules(){
  const card=cards.rules;if(destroyed||card.hidden)return;
  // One layout read only when rules, scale, visibility or viewport change.
  // Fixed-size PNGs cannot change this height after loading. Reducing scale
  // relaxes max-width, so the resulting text can only wrap less, never more.
  card.style.setProperty('--scene-panel-fit','1');
  const contentHeight=card.scrollHeight,margin=portrait?10:12,available=viewportHeight-2*margin;
  const fit=Number.isFinite(contentHeight)&&contentHeight>0?Math.min(1,Math.max(0,available)/((contentHeight+3)*settings.rulesScale/100)):1;
  card.style.setProperty('--scene-panel-fit',String(fit));card.dataset.autoFit=String(fit<1);
 }
 function applySettings(value){
  const previous=settings;settings=normalizeSceneSettings(value,settings);applyPanelStyles();
  // Moving/fading a card needs no snapshot normalization or content rendering.
  const rulesRendered=['showQueue','showGiftRules','showCurrent','showStats'].some(key=>settings[key]!==previous[key])?render():false;
  if(!rulesRendered&&(settings.rulesScale!==previous.rulesScale||(!previous.showGiftRules&&settings.showGiftRules)))fitRules();
  return syncTopmost();
 }
 function applySnapshot(value){snapshot=normalizeSceneSnapshot(value);render();}
 function setTheme(value){if(value!=='light'&&value!=='dark')return;element.dataset.theme=value;}
 function resize(w,h){
  if(!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0)return;
  viewportWidth=w;viewportHeight=h;const next=h>w,changed=next!==portrait;portrait=next;applyPanelStyles();if(!changed||!render())fitRules();
 }
 function nativeReady(){resizeHandles.nativeReady();appliedTopmost=null;topmostEpoch++;return syncTopmost();}
 function destroy(){destroyed=true;topmostEpoch++;resizeHandles.destroy();element.remove();}
 setTheme(theme);applyPanelStyles();render();void syncTopmost();
 return {element,applySettings,applySnapshot,setTheme,resize,nativeReady,destroy,get settings(){return {...settings}}};
}
