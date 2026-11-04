// Reparent the real controls, retaining their original handlers and state.
// The independent output window never mounts the workbench or its navigation.
import {arrangeDemoPanel} from './demo-panel.mjs';
import {arrangeSettingsPanels} from './settings-panel.mjs';
import {mountSceneWindowSettings} from './scene-window-settings.mjs';
const icons={settings:'M4 7h16M4 17h16M9 4v6m6 4v6',popup:'M13 4h7v7m0-7-9 9M9 4H4v16h16v-5',close:'m6 6 12 12M18 6 6 18',more:'M4 6h16M4 12h16M4 18h16',chevron:'m6 9 6 6 6-6',check:'m5 12 4 4L19 6'};
const icon=name=>`<svg class="workspace-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name]}"/></svg>`;
function node(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function button(text,action,cls=''){const b=node('button',cls,text);b.type='button';b.onclick=action;return b}
function append(parent,...items){for(const item of items.flat())if(item)parent.append(item);return parent}

// Transport availability, collector readiness and saved authentication are
// separate states. A connected local socket never implies a live room is ready.
export function createCollectorControls({
 en=false,refs={},getApi=()=>globalThis.window?.pywebview?.api,isDesktop=()=>false,
 fetch:request=globalThis.fetch,document:doc=globalThis.document,window:win=globalThis.window,
 storage,getRoom=()=>refs.roomInput?.value||'',connectBridge=()=>{},onActive=()=>{},
 now=()=>Date.now(),setTimeout:later=globalThis.setTimeout,clearTimeout:cancel=globalThis.clearTimeout
}={}){
 const t=(zh,english)=>en?english:zh;
 if(storage===undefined){try{storage=globalThis.localStorage}catch{}}
 const labels={connecting:t('连接直播中','Connecting to room'),connected:t('正在采集','Capturing'),reconnecting:t('采集重连中','Reconnecting capture'),offline:t('直播采集离线','Capture offline'),error:t('采集异常','Capture error'),stopped:t('采集已停止','Capture stopped')};
 let destroyed=false,bridge=false,active=false,wanted=true,blocked=false,state='stopped',stateCode='',stateMessage='',stats=null,auth=null;
 let action=0,busy=false,notice=t('登录后窗口自动关闭，采集在后台运行。','The sign-in window closes after login. Capture runs in the background.');
 let pollTimer=null,deadlineTimer=null,pollVersion=0,loginDeadline=0,loginBaseline=null,sawLogin=false,autoAt=-Infinity,autoAttempts=0,authPromise=null;
 const ready=value=>value?.loggedIn===true&&value.needsLogin!==true;
 const room=()=>{const match=String(getRoom()||'').trim().match(/^(?:https?:\/\/live\.douyin\.com\/)?(\d{5,25})(?:[/?#].*)?$/);return match?.[1]||'';};
 const persistRoom=value=>{try{storage?.setItem('printer-live-room',value)}catch{}};
 function errorText(error){
  const code=String(error?.errorCode||error?.code||'');
  if(/LOGIN_CANCELLED/.test(code))return t('登录已取消；需要时可重新登录。','Sign-in cancelled. You can sign in again.');
  if(/AUTH_STORAGE_UNAVAILABLE/.test(code))return t('无法读取本机登录凭据，请重新登录。','Saved credentials are unavailable. Sign in again.');
  if(/LOGIN_REQUIRED|AUTH_EXPIRED|COOKIE_EXPIRED/.test(code))return t('登录已失效，请点击「登录抖音」。','Sign-in has expired. Click Sign in.');
  return t('操作未完成，请重试；必要时重新登录。','The action could not complete. Retry or sign in again.');
 }
 function render(){
  if(destroyed)return;
  const isLive=bridge&&wanted&&state==='connected';
  if(isLive!==active){active=isLive;onActive(isLive);}
  const needsLogin=auth?.needsLogin===true||auth?.loggedIn===false;
  const title=needsLogin?t('需要登录','Sign-in required'):state==='error'?labels.error:!bridge?t('数据服务未连接','Data service offline'):labels[state];
  if(refs.liveStatus){const span=doc.createElement('span');span.textContent='● '+title;span.style.color=isLive?'#7fd69a':needsLogin||state==='error'?'#e08f8f':'#d9b96a';refs.liveStatus.replaceChildren(span);refs.liveStatus.title=title;}
  if(refs.liveFetch){
   const service=t('数据服务：','Data service: ')+(bridge?t('已连接','connected'):t('未连接','offline'));
   let detail=t('后台采集：','Background capture: ')+labels[state];
   if(stateMessage)detail+=' · '+stateMessage;
   if(stateCode)detail+=' ['+stateCode+']';
   if(isLive&&stats){const count=key=>Math.max(0,Math.floor(Number(stats[key])||0));detail+=' · '+t('评论','comments ')+count('comment')+' · '+t('点赞','likes ')+count('like')+' · '+t('礼物','gifts ')+count('gift');}
   refs.liveFetch.textContent=service+'\n'+detail;
  }
  if(refs.mode)refs.mode.textContent=isLive?t('● 直播数据','● LIVE data'):t('● 本地演示','● Local demo');
  if(refs.status)refs.status.textContent=isLive?labels.connected+(room()?' · '+t('房间 ','room ')+room():''):title;
  if(refs.roomStatus)refs.roomStatus.textContent=notice;
  if(refs.loginButton){refs.loginButton.disabled=busy||loginDeadline>0;refs.loginButton.textContent=loginDeadline?t('登录中…','Signing in…'):t('登录抖音','Sign in');}
  if(refs.startButton)refs.startButton.disabled=busy;
 }
 async function call(method,path,value){
  const api=getApi();
  if(typeof api?.[method]==='function')return value===undefined?api[method]():api[method](value);
  if(isDesktop()){const error=new Error('Desktop bridge is not ready');error.code='BRIDGE_PENDING';throw error;}
  const response=await request(path,{signal:globalThis.AbortSignal?.timeout?.(12000)});
  const result=await response.json();
  if(result?.ok===false){const error=new Error('Collector request failed');error.code=result.errorCode||'REQUEST_FAILED';throw error;}
  return result;
 }
 function clearPolling(){cancel(pollTimer);cancel(deadlineTimer);pollTimer=null;deadlineTimer=null;pollVersion++;}
 function finishLogin(message){clearPolling();loginDeadline=0;loginBaseline=null;sawLogin=false;if(message)notice=message;render();}
 function armPoll(){
  clearPolling();if(!loginDeadline||destroyed||doc.hidden)return;
  const remaining=loginDeadline-now();
  if(remaining<=0){finishLogin(t('登录等待已结束，可点击「登录抖音」重试。','Sign-in wait ended. Click Sign in to retry.'));return;}
  const version=pollVersion;
  deadlineTimer=later(()=>{if(version===pollVersion)finishLogin(t('登录等待已结束，可点击「登录抖音」重试。','Sign-in wait ended. Click Sign in to retry.'));},remaining);
  pollTimer=later(async()=>{
   if(version!==pollVersion||destroyed||doc.hidden)return;
   const value=await refreshAuth();
   if(version!==pollVersion||destroyed||doc.hidden||!loginDeadline)return;
   if(value?.loginInProgress)sawLogin=true;
   const changed=value?.updatedAt!==loginBaseline?.updatedAt;
   if(ready(value)&&(changed||!ready(loginBaseline)||(sawLogin&&!value.loginInProgress))){
    finishLogin(t('登录已保存，窗口将自动关闭；采集在后台运行。','Sign-in saved. The window closes automatically; capture runs in the background.'));blocked=false;autoAttempts=0;void maybeAutoStart(true);return;
   }
   if(value&&!value.loginInProgress&&(sawLogin||value.errorCode)){
    finishLogin(value.errorCode?errorText({code:value.errorCode}):t('登录已取消；需要时可重新登录。','Sign-in cancelled. You can sign in again.'));return;
   }
   armPoll();
  },2000);
 }
 async function refreshAuth(){
  if(destroyed||doc.hidden)return auth;
  if(authPromise)return authPromise;
  const noticeAction=action,noticePoll=pollVersion;
  authPromise=(async()=>{
   try{
    const value=await call('get_collector_auth_status','/__collector-auth-status');
    if(destroyed)return null;
    auth={loggedIn:value?.loggedIn===true,needsLogin:value?.needsLogin!==false,loginInProgress:value?.loginInProgress===true,updatedAt:typeof value?.updatedAt==='string'?value.updatedAt:null,errorCode:typeof value?.errorCode==='string'?value.errorCode:null};
    if(!loginDeadline&&noticeAction===action&&noticePoll===pollVersion){notice=ready(auth)?t('登录已保存，可开始后台采集；无需保留登录窗口。','Sign-in saved. You can start background capture without a login window.'):errorText({code:auth.errorCode||'LOGIN_REQUIRED'});}
    render();return auth;
   }catch(error){if(!destroyed&&error.code!=='BRIDGE_PENDING'){notice=errorText(error);render();}return null;}
   finally{authPromise=null;}
  })();
  return authPromise;
 }
 async function start(automatic=false){
  if(destroyed||busy)return false;
  if(!automatic){wanted=true;blocked=false;autoAttempts=0;}
  const value=room();
  if(!value){if(!automatic){notice=t('请先输入直播间号或链接。','Enter a live room ID or link first.');render();refs.roomInput?.focus();}return false;}
  const version=++action;busy=true;render();
  try{
   const saved=await refreshAuth();
   if(destroyed||version!==action||!wanted)return false;
   if(!ready(saved)){if(saved){blocked=true;notice=t('请先点击「登录抖音」，登录成功后再开始采集。','Click Sign in first, then start capture after login.');}return false;}
   if(isDesktop()&&typeof getApi()?.start_capture!=='function')return false;
   persistRoom(value);if(state!=='connected'){state='connecting';stateCode='';stateMessage='';}notice=t('已请求后台采集，正在连接直播间…','Capture requested. Connecting to the live room…');render();
   await call('start_capture','/__start-bridge?room='+encodeURIComponent(value),value);
   if(destroyed||version!==action||!wanted)return false;
   connectBridge();return true;
  }catch(error){if(!destroyed&&version===action){blocked=!automatic||/LOGIN_REQUIRED|AUTH_|COOKIE_/.test(String(error.code||''));state='error';notice=errorText(error);render();}return false;}
  finally{if(version===action){busy=false;render();}}
 }
 async function maybeAutoStart(force=false){
  if(destroyed||doc.hidden||busy||!wanted||blocked||!ready(auth)||autoAttempts>=3)return false;
  if(!force&&bridge)return false;
  if(!force&&now()-autoAt<15000)return false;
  if(isDesktop()&&typeof getApi()?.start_capture!=='function')return false;
  autoAt=now();autoAttempts++;return start(true);
 }
 async function login(){
  if(destroyed||busy||loginDeadline)return false;
  const value=room();if(!value){notice=t('请先输入直播间号或链接。','Enter a live room ID or link first.');render();refs.roomInput?.focus();return false;}
  const version=++action;busy=true;render();
  try{
   const before=await refreshAuth();if(destroyed||version!==action)return false;
   notice=t('正在打开登录窗口…','Opening sign-in window…');render();persistRoom(value);
   await call('open_live_room','/__open-live?room='+encodeURIComponent(value),value);
   if(destroyed||version!==action)return false;
   loginBaseline=before?{...before}:null;sawLogin=false;loginDeadline=now()+600000;
   notice=t('请在窗口中登录；成功后自动关闭，采集在后台运行。','Sign in in the new window. It closes after success; capture runs in the background.');armPoll();return true;
  }catch(error){if(!destroyed&&version===action){notice=errorText(error);render();}return false;}
  finally{if(version===action){busy=false;render();}}
 }
 async function stop(){
  if(destroyed)return false;
  const version=++action;wanted=false;blocked=false;busy=false;state='stopped';stateCode='';stateMessage='';notice=t('正在停止后台采集…','Stopping background capture…');render();
  try{await call('stop_capture','/__stop-bridge');if(!destroyed&&version===action){notice=t('后台采集已停止，可继续使用本地演示。','Background capture stopped. Local demo remains available.');render();}return true;}
  catch(error){if(!destroyed&&version===action){state='error';notice=errorText(error);render();}return false;}
 }
 function receiveStatus(value){
  if(destroyed||!Object.hasOwn(labels,value?.status))return;
  if(!wanted&&['connecting','connected','reconnecting'].includes(value.status))return;
  state=value.status;stateCode=String(value.code||'').slice(0,64);stateMessage=String(value.message||'').slice(0,180);
  if(/sessionid|cookie\s*[:=]|bearer\s|token=/i.test(stateMessage))stateMessage='';
  if(state==='error')blocked=true;
  if(state==='connected'){blocked=false;autoAttempts=0;}
  if(/LOGIN_REQUIRED|AUTH_EXPIRED|COOKIE_EXPIRED/.test(stateCode)){auth={...auth,loggedIn:false,needsLogin:true};notice=errorText({code:stateCode});}
  render();
 }
 async function initialize(){
  if(destroyed||doc.hidden)return;
  const value=await refreshAuth();if(destroyed)return;
  if(value?.loginInProgress&&!loginDeadline){loginBaseline={...value};sawLogin=true;loginDeadline=now()+600000;armPoll();render();}
  if(ready(value)&&!loginDeadline)void maybeAutoStart(state==='stopped'||state==='offline');
 }
 function visibility(){if(doc.hidden)clearPolling();else if(loginDeadline)armPoll();else if(!auth)void initialize();}
 doc?.addEventListener('visibilitychange',visibility);win?.addEventListener('pywebviewready',initialize);
 function destroy(){destroyed=true;action++;clearPolling();doc?.removeEventListener('visibilitychange',visibility);win?.removeEventListener('pywebviewready',initialize);win?.removeEventListener('pagehide',destroy);}
 win?.addEventListener('pagehide',destroy,{once:true});render();
 return {initialize,refreshAuth,start:()=>start(false),stop,login,maybeAutoStart,receiveStatus,setStats(value){stats=value;render();},setBridgeConnected(value){bridge=!!value;if(!bridge&&state==='connected')state='reconnecting';render();},destroy};
}

export function mountWorkspace(c){
 if(document.body.classList.contains('scene-only'))return;
 const controlsById=new Map([...document.querySelectorAll('[id]')].map(element=>[element.id,element]));
 const $=id=>document.getElementById(id)||controlsById.get(id),en=document.documentElement.lang==='en',t=(cn,eng)=>en?eng:cn;
 const oldMain=document.querySelector('main'),header=document.querySelector('header'),oldFooter=document.querySelector('footer');
 const oldStatus=$('status'),mode=$('mode');
 const metrics=$('count').closest('.metrics'),queue=$('queue'),result=document.querySelector('.result');
 const likes=$('stat-likes').closest('.metrics');
 const sceneSelect=node('select','workspace-scene-select');sceneSelect.setAttribute('aria-label',t('房间场景','Room scene'));
 for(const [id,name]of c.rooms)sceneSelect.append(new Option(name,id));sceneSelect.value=c.getRoom();sceneSelect.onchange=()=>c.setRoom(sceneSelect.value);
 const cameraSelect=node('select','workspace-camera-select');cameraSelect.setAttribute('aria-label',t('镜头视角','Camera view'));
 function refreshCameras(){const selected=c.getActiveView();cameraSelect.replaceChildren(new Option(t('机位：初始视角','View: default'),'__initial'),new Option(t('机位：头像近景','View: close-up'),'__close'));for(const v of c.loadViews())cameraSelect.append(new Option(v.name,v.id));cameraSelect.value=[...cameraSelect.options].some(o=>o.value===selected)?selected:'__initial';}
 cameraSelect.onchange=()=>c.selectView(cameraSelect.value);refreshCameras();
 const saveCamera=button(t('＋ 保存机位','＋ Save view'),()=>{c.saveCurrentView();refreshCameras()},'workspace-save-camera workspace-ghost');
 const settingsButton=button('',()=>openSettings('rules'),'workspace-ghost');settingsButton.innerHTML=icon('settings')+t('设置','Settings');
 const visualButton=button('',()=>openSettings('visual'),'workspace-icon-button workspace-ghost');visualButton.innerHTML=icon('settings');visualButton.setAttribute('aria-label',t('画面设置','Visual settings'));
 const tools=append(node('div','workspace-stage-tools'),node('strong','workspace-stage-title',t('打印现场','Print floor')),sceneSelect,cameraSelect,saveCamera,node('span','workspace-spacer'),c.quickSound,visualButton);
 const progressLabel=$('print-progress'),progress=node('progress','workspace-progress');progress.max=100;progress.value=0;progress.setAttribute('aria-label',t('当前打印进度','Print progress'));
 const progressWrap=append(node('div','workspace-progress-wrap'),progressLabel,progress);
 const progressObserver=new MutationObserver(()=>{const match=progressLabel.textContent.match(/(\d+)%/);progress.value=match?Number(match[1]):0;});progressObserver.observe(progressLabel,{childList:true,characterData:true,subtree:true});
 const transport=append(node('div','workspace-transport'),result,progressWrap,append(node('div','workspace-transport-actions'),$('toggle'),$('skip')));
 const stagePanel=append(node('section','workspace-stage'),tools,$('stage'),transport);stagePanel.setAttribute('aria-label',t('打印现场','Print floor'));
 const connection=node('section','workspace-connection');
 append(connection,append(node('div','workspace-connection-heading'),node('span','',t('直播连接','Live connection')),$('live-status')),
  append(node('div','workspace-room-field'),$('room-input'),$('room-set')),
  append(node('div','workspace-room-actions'),$('room-open'),$('capture-start'),$('capture-stop')),
  append(node('div','workspace-connection-foot'),$('room-open-status'),button(t('连接详情','Details'),()=>openSettings('connection'),'workspace-text-button')));
 $('room-input').setAttribute('aria-label',t('直播间号或链接','Live room or URL'));$('room-input').placeholder=t('直播间号或链接','Live room or URL');
 $('room-open').textContent=t('登录抖音','Sign in');$('room-set').textContent=t('切换','Set');
 metrics.classList.add('workspace-session-primary');likes.classList.remove('metrics');likes.classList.add('workspace-session-secondary');
 const session=append(node('section','workspace-session'),node('div','workspace-session-heading',t('本场概览','Session')),metrics,likes);
 const activity=node('section','workspace-activity'),tabs=node('div','workspace-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',t('任务面板','Tasks'));
 const panes={};const tabButtons={};
 const switchTab=name=>{for(const [key,pane]of Object.entries(panes)){const selected=key===name;pane.hidden=!selected;tabButtons[key].classList.toggle('active',selected);tabButtons[key].setAttribute('aria-selected',String(selected));tabButtons[key].tabIndex=selected?0:-1;}};
 for(const [key,label]of [['queue',t('队列','Queue')],['history',t('记录','History')],['demo',t('演示','Demo')]]){
  const b=button(label,()=>switchTab(key));b.id='ws-tab-'+key;b.setAttribute('role','tab');b.setAttribute('aria-controls','ws-tabpanel-'+key);tabs.append(b);tabButtons[key]=b;
  const pane=node('div','workspace-tabpanel');pane.id='ws-tabpanel-'+key;pane.setAttribute('role','tabpanel');pane.setAttribute('aria-labelledby',b.id);panes[key]=pane;
 }
 append(panes.queue,queue);append(panes.history,c.historyPanel.querySelector('.body'));append(panes.demo,c.connectionPanel.querySelector('.body'),$('demo'),c.autoButton);
 const addDetails=(parent,title,...children)=>{const d=node('details');append(d,node('summary','',title),children);parent.append(d);return d;};
 arrangeDemoPanel(panes.demo,{demoButton:$('demo'),autoButton:c.autoButton,en});
 append(activity,tabs,...Object.values(panes),append(node('div','workspace-activity-footer'),node('span','',t('礼物优先 · 普通任务保留','Gifts first · queued tasks retained')),button(t('打印规则','Print rules'),()=>openSettings('rules'),'workspace-text-button')));switchTab('queue');
 const side=append(node('aside','workspace-side'),connection,session,activity),grid=append(node('div','workspace-grid'),stagePanel,side),main=append(node('main','workspace-main'),grid);

 const shade=node('div','workspace-shade');shade.hidden=true;
 const drawer=node('section','workspace-drawer');drawer.setAttribute('role','dialog');drawer.setAttribute('aria-modal','true');drawer.setAttribute('aria-labelledby','ws-settings-title');
 const close=button('',closeSettings,'workspace-icon-button workspace-ghost');close.innerHTML=icon('close');close.setAttribute('aria-label',t('关闭设置','Close settings'));
 const drawerTitle=node('h2','','工作台设置');drawerTitle.id='ws-settings-title';drawerTitle.textContent=t('工作台设置','Workspace settings');
 append(drawer,append(node('div','workspace-drawer-header'),drawerTitle,close));
 const settingsTabs=node('div','workspace-settings-tabs');settingsTabs.setAttribute('role','tablist');settingsTabs.setAttribute('aria-label',t('设置分类','Settings categories'));
 const settingsBody=node('div','workspace-settings-body'),settingsPanes={},settingsButtons={};
 for(const [key,label]of [['rules',t('打印规则','Print rules')],['visual',t('画面','Visual')],['audio',t('声音','Audio')],['connection',t('连接','Connection')],['window',t('小窗','Output window')]]){
  const b=button(label,()=>selectSettings(key));b.id='ws-setting-tab-'+key;b.setAttribute('role','tab');b.setAttribute('aria-controls','ws-settings-'+key);settingsTabs.append(b);settingsButtons[key]=b;
  const pane=node('div','workspace-settings-pane');pane.id='ws-settings-'+key;pane.setAttribute('role','tabpanel');pane.setAttribute('aria-labelledby',b.id);settingsPanes[key]=pane;settingsBody.append(pane);
 }
 const rules=$('print-rules');rules.open=true;append(settingsPanes.rules,...[...rules.children].filter(x=>x.tagName!=='SUMMARY'));
 c.outputSettings.hidden=false;c.outputSettings.removeAttribute('style');append(settingsPanes.visual,c.overlayButton,c.outputSettings);
 c.sceneBar.hidden=true;c.viewBar.classList.add('workspace-camera-manager');append(settingsPanes.visual,node('h3','',t('机位管理','Saved views')),c.viewBar);
 const viewActions=node('div','workspace-camera-actions');
 const selectedView=()=>c.loadViews().find(v=>v.id===cameraSelect.value);
 append(viewActions,button(t('重命名机位','Rename view'),()=>{const v=selectedView();if(!v)return;const name=prompt(t('机位名称','View name'),v.name);if(!name?.trim())return;const all=c.loadViews();all.find(x=>x.id===v.id).name=name.trim().slice(0,30);c.saveViews(all);c.renderViews();refreshCameras();}),button(t('删除当前机位','Delete view'),()=>{const v=selectedView();if(!v)return;c.saveViews(c.loadViews().filter(x=>x.id!==v.id));c.selectView('__initial');c.renderViews();refreshCameras();}));settingsPanes.visual.append(viewActions);
 c.soundBar.removeAttribute('style');c.speechPanel.removeAttribute('style');append(settingsPanes.audio,c.soundBar,c.speechPanel);
 addDetails(settingsPanes.audio,t('声音诊断','Audio diagnostics'),c.soundTest,c.nativeLabel,c.nativeAudio,c.repairAudio);
 append(settingsPanes.connection,$('live-room'),$('live-fetch'),$('yield-note'));
 const connectionNote=node('p','note',t('数据服务连通与直播采集状态分别显示。登录后窗口自动关闭，采集在后台运行；凭据失效时请主动重新登录。','Data service and live capture status are separate. The sign-in window closes after login; capture runs in the background. Sign in again if credentials expire.'));settingsPanes.connection.append(connectionNote);
 append(drawer,settingsTabs,settingsBody,append(node('div','workspace-drawer-footer'),node('span','',t('设置自动保存 · 打印规则对新任务生效','Saved automatically · print rules apply to new jobs')),button(t('完成','Done'),closeSettings)));shade.append(drawer);
 arrangeSettingsPanels(settingsPanes,{en});
 const disposeWindowSettings=mountSceneWindowSettings(settingsPanes.window,c.sceneWindowSettings,{en});
 let returnFocus=null;
 function selectSettings(name){for(const[key,pane]of Object.entries(settingsPanes)){const selected=key===name;pane.hidden=!selected;settingsButtons[key].classList.toggle('active',selected);settingsButtons[key].setAttribute('aria-selected',String(selected));settingsButtons[key].tabIndex=selected?0:-1;}settingsBody.scrollTop=0;}
 function openSettings(name){returnFocus=document.activeElement;selectSettings(name);shade.hidden=false;close.focus();}
 function closeSettings(){shade.hidden=true;returnFocus?.focus();}
 shade.onclick=e=>{if(e.target===shade)closeSettings();};
 c.advancedButton.onclick=()=>openSettings('visual');

 const more=node('div','workspace-more');more.id='workspace-more-menu';more.hidden=true;more.setAttribute('role','menu');more.setAttribute('aria-label',t('更多选项','More options'));
 const group=title=>{const g=node('div','workspace-menu-group');g.setAttribute('role','group');g.setAttribute('aria-label',title);append(g,node('div','workspace-menu-heading',title));more.append(g);return g;};
 const appearance=group(t('外观','Appearance')),themeChoices={};
 let themeTimer;
 function syncThemeChoices(){const theme=document.body.classList.contains('workspace-light')?'light':'dark';for(const [key,b]of Object.entries(themeChoices))b.setAttribute('aria-checked',String(key===theme));}
 function setTheme(theme){
  if(theme!=='dark'&&theme!=='light')return;
  clearTimeout(themeTimer);const reduced=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches??false;
  document.body.classList.toggle('workspace-theme-changing',!reduced);
  if(!reduced)getComputedStyle(document.body).backgroundColor;
  document.body.classList.toggle('workspace-light',theme==='light');document.documentElement.dataset.workspaceBootTheme=theme;
  try{localStorage.setItem('printer-workspace-theme',theme)}catch{}
  syncThemeChoices();syncHelpTheme();c.publishTheme?.(theme);
  if(!reduced)themeTimer=setTimeout(()=>document.body.classList.remove('workspace-theme-changing'),280);
 }
 for(const [value,label]of [['light',t('浅色主题','Light theme')],['dark',t('深色主题','Dark theme')]]){const b=button('',()=>setTheme(value));b.setAttribute('role','menuitemradio');b.dataset.theme=value;append(b,node('span','',label));const mark=node('span','workspace-menu-check');mark.innerHTML=icon('check');b.append(mark);themeChoices[value]=b;appearance.append(b);}
 const languages=group(t('语言','Language'));
 for(const [code,label,href]of [['zh-CN','简体中文','./index.html'],['en','English','./index-en.html']]){const a=node('a');a.href=href+(new URLSearchParams(location.search).get('desktop')==='1'?'?desktop=1':'');a.setAttribute('role','menuitemradio');a.setAttribute('aria-checked',String((en?'en':'zh-CN')===code));append(a,node('span','',label));const mark=node('span','workspace-menu-check');mark.innerHTML=icon('check');a.append(mark);a.onclick=event=>{if((en?'en':'zh-CN')===code)event.preventDefault();closeMore();};languages.append(a);}
 const helpGroup=group(t('帮助','Help'));const helpButton=button(t('帮助与教程','Help and guide'),()=>{closeMore();openHelp();});helpButton.setAttribute('role','menuitem');helpGroup.append(helpButton);
 const program=group(t('程序','Application'));c.restartButton.setAttribute('role','menuitem');c.restartButton.classList.add('workspace-menu-restart');program.append(c.restartButton);
 const moreButton=button('',()=>{const open=more.hidden;more.hidden=!open;moreButton.setAttribute('aria-expanded',String(open));if(open)(more.querySelector('[aria-checked="true"]')||more.querySelector('button,a'))?.focus();},'workspace-more-toggle');moreButton.innerHTML=icon('more')+t('更多','More')+icon('chevron');moreButton.setAttribute('aria-label',t('更多选项','More options'));moreButton.setAttribute('aria-haspopup','menu');moreButton.setAttribute('aria-controls',more.id);moreButton.setAttribute('aria-expanded','false');
 function closeMore(){more.hidden=true;moreButton.setAttribute('aria-expanded','false');}
 more.addEventListener('keydown',event=>{const items=[...more.querySelectorAll('button,a')].filter(x=>!x.disabled&&x.getClientRects().length);const at=items.indexOf(document.activeElement);let next;if(event.key==='ArrowDown')next=(at+1)%items.length;else if(event.key==='ArrowUp')next=(at-1+items.length)%items.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=items.length-1;else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMore();moreButton.focus();return}else return;event.preventDefault();items[next]?.focus();});
 const helpShade=node('div','workspace-help-shade');helpShade.hidden=true;
 const helpDialog=node('section','workspace-help-dialog');helpDialog.setAttribute('role','dialog');helpDialog.setAttribute('aria-modal','true');helpDialog.setAttribute('aria-labelledby','workspace-help-title');
 const helpTitle=node('h2','',t('帮助与教程','Help and guide'));helpTitle.id='workspace-help-title';
 const helpClose=button('',closeHelp,'workspace-icon-button workspace-ghost');helpClose.innerHTML=icon('close');helpClose.setAttribute('aria-label',t('关闭帮助','Close help'));
 const helpFrame=node('iframe','workspace-help-frame');helpFrame.title=t('帮助中心','Help center');let helpReturnFocus=null;
 append(helpDialog,append(node('div','workspace-help-heading'),helpTitle,helpClose),helpFrame);helpShade.append(helpDialog);
 function syncHelpTheme(){if(helpFrame.hasAttribute('src'))helpFrame.contentWindow?.postMessage({type:'workspace-theme',theme:document.body.classList.contains('workspace-light')?'light':'dark'},location.origin);}
 function openHelp(){helpReturnFocus=more.contains(document.activeElement)?moreButton:document.activeElement;closeMore();helpShade.hidden=false;if(!helpFrame.hasAttribute('src'))helpFrame.src='./help.html?theme='+(document.body.classList.contains('workspace-light')?'light':'dark');else syncHelpTheme();helpClose.focus();}
 function closeHelp(){helpShade.hidden=true;helpReturnFocus?.focus();}
 helpShade.onclick=event=>{if(event.target===helpShade)closeHelp();};
 helpFrame.addEventListener('load',()=>{syncHelpTheme();try{helpFrame.contentDocument.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeHelp();}else if(event.key==='Tab'){const items=[...helpFrame.contentDocument.querySelectorAll('a,button,input,select,summary,[tabindex="0"]')].filter(x=>!x.disabled&&x.getClientRects().length);if((event.shiftKey&&document.activeElement===helpFrame&&helpFrame.contentDocument.activeElement===items[0])||(!event.shiftKey&&helpFrame.contentDocument.activeElement===items.at(-1))){event.preventDefault();helpClose.focus();}}});}catch{}});
 const brand=append(node('div','workspace-header-brand'),Object.assign(node('img'),{src:'assets/printer.ico',alt:''}),append(node('div','workspace-brand-text'),node('strong','',t('头像打印机','Avatar Printer')),node('small','workspace-brand-sub','AVATAR PRINT STUDIO')));
 header.replaceChildren(brand,node('span','workspace-header-title',t('直播工作台','Live workspace')),append(node('div','workspace-header-actions'),mode,settingsButton,c.liveButton,moreButton));header.className='workspace-header pywebview-drag-region';
 for(const part of [brand,...brand.querySelectorAll('*'),header.querySelector('.workspace-header-title')])part.classList.add('pywebview-drag-region');
 let nativeControls=null,nativeButtons={},syncNativeWindowState=null;
 function callWindowApi(method){const api=window.pywebview?.api;if(typeof api?.[method]!=='function')return Promise.resolve(undefined);return Promise.resolve().then(()=>api[method]()).catch(()=>undefined);}
 function mountNativeControls(){
  const api=window.pywebview?.api,desktop=new URLSearchParams(location.search).get('desktop')==='1';
  if(!nativeControls&&(desktop||typeof api?.window_close==='function')){
   nativeControls=node('div','workspace-native-controls');
   const minimize=button('',()=>callWindowApi('window_minimize'),'workspace-window-button');minimize.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>';minimize.setAttribute('aria-label',t('最小化窗口','Minimize window'));
   const maximize=button('',()=>callWindowApi('window_toggle_maximize').then(state=>{if(state!==undefined)syncNativeWindowState(state);}),'workspace-window-button');
   syncNativeWindowState=state=>{const maximized=typeof state==='boolean'?state:!!state?.maximized;maximize.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(maximized?'M8 8V5h11v11h-3M5 8h11v11H5z':'M5 5h14v14H5z')+'"/></svg>';const label=maximized?t('还原窗口','Restore window'):t('最大化窗口','Maximize window');maximize.setAttribute('aria-label',label);maximize.title=label;maximize.setAttribute('aria-pressed',String(maximized));};syncNativeWindowState(false);
   const closeWindow=button('',()=>callWindowApi('window_close'),'workspace-window-button workspace-window-close');closeWindow.innerHTML=icon('close');closeWindow.setAttribute('aria-label',t('关闭窗口','Close window'));
   nativeButtons={window_minimize:minimize,window_toggle_maximize:maximize,window_close:closeWindow};
   append(nativeControls,minimize,maximize,closeWindow);header.querySelector('.workspace-header-actions').append(nativeControls);
   window.addEventListener('workspace-window-state',event=>syncNativeWindowState(event.detail));
   header.addEventListener('dblclick',event=>{if(!event.target.closest('button,a,input,select'))maximize.click();});
  }
  if(!nativeControls)return;
  for(const [method,control]of Object.entries(nativeButtons))control.disabled=typeof api?.[method]!=='function';
  if(typeof api?.window_state==='function')callWindowApi('window_state').then(state=>{if(state!==undefined)syncNativeWindowState(state);});
 }
 mountNativeControls();window.addEventListener('pywebviewready',mountNativeControls,{once:true});
 const fps=node('span','workspace-performance','');fps.id='workspace-performance';
 const footer=append(node('footer','workspace-statusbar'),oldStatus,node('span','',t('评分为娱乐随机分数','Scores are random, for fun')),fps);
 // Keep the originals detached only after every stateful control has moved.
 oldMain.replaceWith(main,footer);document.body.append(shade,more,helpShade);document.body.classList.add('workspace-app');
 try{document.body.classList.toggle('workspace-light',localStorage.getItem('printer-workspace-theme')==='light')}catch{}
 syncThemeChoices();c.publishTheme?.(document.body.classList.contains('workspace-light')?'light':'dark');
 for(const tablist of [tabs,settingsTabs]){const buttons=[...tablist.querySelectorAll('[role="tab"]')];tablist.addEventListener('keydown',e=>{const at=buttons.indexOf(document.activeElement);if(at<0)return;let next;if(e.key==='ArrowRight')next=(at+1)%buttons.length;else if(e.key==='ArrowLeft')next=(at-1+buttons.length)%buttons.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=buttons.length-1;else return;e.preventDefault();buttons[next].click();buttons[next].focus();});}
 document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!helpShade.hidden)closeHelp();else if(!shade.hidden)closeSettings();closeMore();}if(e.key==='Tab'&&!shade.hidden){const focusable=[...drawer.querySelectorAll('button,input,select,summary,a')].filter(x=>!x.disabled&&x.getClientRects().length),first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}else if(e.key==='Tab'&&!helpShade.hidden&&e.shiftKey&&document.activeElement===helpClose){e.preventDefault();helpFrame.focus();}});
 document.addEventListener('click',e=>{if(!more.hidden&&!more.contains(e.target)&&!moreButton.contains(e.target))closeMore();});
 // No per-frame DOM polling: the engine updates diagnostics at its existing interval.
 window.updateWorkspacePerformance=d=>{fps.textContent=`${Math.round(d.fps)} FPS · ${Math.round(d.estimatedTargetMiB)} MiB ${t('渲染缓冲','render target')}${d.adaptiveEffects?t(' · 流畅优先',' · adaptive'):''}`;};
 window.workspaceUI={openSettings,switchTab,refreshCameras,openHelp,setTheme};
 const queueCount=node('span','workspace-tab-count',$('waiting').textContent),historyCount=node('span','workspace-tab-count',$('count').textContent);append(tabButtons.queue,queueCount);append(tabButtons.history,historyCount);
 const countObserver=new MutationObserver(()=>{queueCount.textContent=$('waiting').textContent;historyCount.textContent=$('count').textContent;});for(const id of ['waiting','count'])countObserver.observe($(id),{childList:true,characterData:true,subtree:true});
 window.addEventListener('printer-queue-overflow',event=>{const warning=document.querySelector('.workspace-queue-warning')||node('div','workspace-queue-warning');warning.setAttribute('role','status');warning.textContent=t('队列已满，本次有 '+event.detail+' 张未加入；已排队任务保留。','Queue full: '+event.detail+' new jobs were not accepted. Existing jobs retained.');if(!warning.isConnected)activity.insertBefore(warning,tabs.nextSibling);});
 window.addEventListener('pagehide',()=>{progressObserver.disconnect();countObserver.disconnect();disposeWindowSettings?.();},{once:true});
 // Show an explicit placeholder when the native output takes over the image.
 const detached=node('div','workspace-detached');detached.hidden=true;append(detached,node('strong','',t('画面正在独立窗口输出','Scene is playing in the output window')),node('p','',t('主窗口继续控制打印与声音，关闭直播小窗后恢复预览。','Printing and audio stay in this window. Close the output window to restore the preview.')),button(t('显示独立画面','Show output window'),()=>c.liveButton.click()));stagePanel.insertBefore(detached,transport);
 window.updateWorkspaceDetached=on=>{detached.hidden=!on;};
 window.dispatchEvent(new Event('resize'));
}
