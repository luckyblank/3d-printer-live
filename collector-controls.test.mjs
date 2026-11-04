import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createCollectorControls} from './workspace-ui.mjs';

class Element {
 constructor(){this.children=[];this.style={};this.textContent='';this.listeners=new Map();this.value='';this.disabled=false;this.hidden=false;}
 replaceChildren(...children){this.children=children;}
 addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
 removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
 fire(type){for(const fn of this.listeners.get(type)||[])fn({type});}
 focus(){this.focused=true;}
}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture({en=false,loggedIn=false,desktop=true,available=true}={}){
 const refs=Object.fromEntries(['liveStatus','liveFetch','roomStatus','roomInput','loginButton','startButton','mode','status'].map(key=>[key,new Element()]));refs.roomInput.value='123456789';
 const doc=new Element(),win=new Element();doc.createElement=()=>new Element();
 let time=0,sequence=0,auth={loggedIn,needsLogin:!loggedIn,updatedAt:loggedIn?'saved-1':null,loginInProgress:false,errorCode:null},apiAvailable=available;
 const calls=[],active=[],http=[],timers=new Map(),writes=[];
 const api={
  async get_collector_auth_status(){calls.push(['auth']);return {...auth};},
  async open_live_room(value){calls.push(['login',value]);auth={...auth,loginInProgress:true};return 'Sign-in opened';},
  async start_capture(value){calls.push(['start',value]);return 'Capture requested';},
  async stop_capture(){calls.push(['stop']);return 'Stopped';}
 };
 const controls=createCollectorControls({en,refs,getApi:()=>apiAvailable?api:undefined,isDesktop:()=>desktop,document:doc,window:win,storage:{setItem:(...args)=>writes.push(args)},getRoom:()=>refs.roomInput.value,connectBridge:()=>calls.push(['connect']),onActive:value=>active.push(value),now:()=>time,setTimeout:(fn,delay)=>{timers.set(++sequence,{fn,at:time+delay});return sequence;},clearTimeout:id=>timers.delete(id),fetch:async url=>{http.push(url);return {json:async()=>{
  if(url==='/__collector-auth-status')return {...auth};
  if(url.startsWith('/__open-live')){auth={...auth,loginInProgress:true};return {ok:true};}
  return {ok:true};
 }}}});
 return {controls,refs,doc,win,api,calls,http,timers,active,writes,setAuth:value=>{auth={...auth,...value};},available:value=>{apiAvailable=value;},count:name=>calls.filter(call=>call[0]===name).length,async tick(ms){const target=time+ms;while(true){const next=[...timers].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;time=next[1].at;timers.delete(next[0]);await next[1].fn();await flush();}time=target;await flush();},title:()=>refs.liveStatus.children[0]?.textContent};
}

for(const en of [false,true]){
 const language=en?'en':'zh';
 test(`${language}: synchronous construction never invokes later-declared live state through callbacks`,()=>{
  const refs=Object.fromEntries(['liveStatus','liveFetch','roomStatus','roomInput','loginButton','startButton','mode','status'].map(key=>[key,new Element()]));
  const document=new Element(),window=new Element();document.createElement=()=>new Element();
  const calls=[];
  // The actual temporal dead zone is intentional: an eager callback or room
  // getter during construction/service discovery would throw ReferenceError.
  const controls=createCollectorControls({en,refs,document,window,storage:null,getRoom:()=>mountedState.room,onActive:on=>calls.push({on,ready:mountedState.ready})});
  controls.setBridgeConnected(false);controls.setBridgeConnected(true);controls.receiveStatus({status:'connecting'});
  const mountedState={room:'123456789',ready:true};
  assert.deepEqual(calls,[]);
  controls.receiveStatus({status:'connected'});assert.deepEqual(calls,[{on:true,ready:true}]);controls.destroy();
 });
 test(`${language}: startup without credentials checks once and never opens a login window`,async()=>{
  const f=fixture({en});await f.controls.initialize();await flush();
  assert.equal(f.count('auth'),1);assert.equal(f.count('login'),0);assert.equal(f.count('start'),0);assert.equal(f.timers.size,0);
  assert.match(f.title(),en?/Sign-in required/:/需要登录/);await f.controls.maybeAutoStart();assert.equal(f.count('auth'),1);f.controls.destroy();
 });
 test(`${language}: saved login starts native capture but service and ping cannot claim a connected room`,async()=>{
  const f=fixture({en,loggedIn:true});await f.controls.initialize();await flush();
  assert.equal(f.count('start'),1);assert.equal(f.count('login'),0);assert.equal(f.http.length,0);
  f.controls.setBridgeConnected(true);f.controls.setStats({comment:2,like:3,gift:4});assert.deepEqual(f.active,[]);
  f.controls.receiveStatus({status:'connecting',code:'CONNECTING',message:''});assert.deepEqual(f.active,[]);
  f.controls.receiveStatus({status:'connected',code:'CONNECTED',message:''});assert.deepEqual(f.active,[true]);
  assert.match(f.title(),en?/Capturing/:/正在采集/);assert.match(f.refs.liveFetch.textContent,/2/);f.controls.destroy();
 });
 test(`${language}: explicit start requires saved login and does not open a window`,async()=>{
  const f=fixture({en});assert.equal(await f.controls.start(),false);assert.equal(f.count('start'),0);assert.equal(f.count('login'),0);
  assert.match(f.refs.roomStatus.textContent,en?/Sign in first/:/请先点击/);f.controls.destroy();
 });
 test(`${language}: successful temporary login polls then stops, without declaring the room connected`,async()=>{
  const f=fixture({en});assert.equal(await f.controls.login(),true);assert.equal(f.count('login'),1);assert.equal(f.timers.size,2);
  await f.tick(2000);f.setAuth({loggedIn:true,needsLogin:false,updatedAt:'saved-2',loginInProgress:false});await f.tick(2000);
  assert.equal(f.timers.size,0);assert.equal(f.refs.loginButton.disabled,false);assert.equal(f.count('start'),1);assert.deepEqual(f.active,[]);
  assert.match(f.refs.roomStatus.textContent,en?/Capture requested/:/已请求后台采集/);f.controls.destroy();
 });
 test(`${language}: re-signing in does not treat the old credential as a new successful login`,async()=>{
  const f=fixture({en,loggedIn:true});await f.controls.login();await f.tick(2000);
  assert.equal(f.count('start'),0);assert.equal(f.refs.loginButton.disabled,true);
  f.setAuth({updatedAt:'saved-2',loginInProgress:false});await f.tick(2000);assert.equal(f.count('start'),1);assert.equal(f.timers.size,0);f.controls.destroy();
 });
 test(`${language}: cancelled login releases controls and never automatically reopens`,async()=>{
  const f=fixture({en});await f.controls.login();await f.tick(2000);
  f.setAuth({loginInProgress:false,errorCode:'LOGIN_CANCELLED'});await f.tick(2000);await f.tick(600000);
  assert.equal(f.count('login'),1);assert.equal(f.count('start'),0);assert.equal(f.timers.size,0);assert.equal(f.refs.loginButton.disabled,false);
  assert.match(f.refs.roomStatus.textContent,en?/cancelled/:/已取消/);f.controls.destroy();
 });
 test(`${language}: login polling has a ten-minute deadline instead of an endless timer`,async()=>{
  const f=fixture({en});await f.controls.login();await f.tick(600001);
  assert.equal(f.count('login'),1);assert.equal(f.count('start'),0);assert.equal(f.timers.size,0);assert.equal(f.refs.loginButton.disabled,false);
  assert.ok(f.count('auth')<=301);assert.match(f.refs.roomStatus.textContent,en?/wait ended/:/等待已结束/);f.controls.destroy();
 });
 test(`${language}: hiding pauses login polling and showing resumes within the original deadline`,async()=>{
  const f=fixture({en});await f.controls.login();f.doc.hidden=true;f.doc.fire('visibilitychange');assert.equal(f.timers.size,0);
  const before=f.count('auth');await f.tick(10000);assert.equal(f.count('auth'),before);
  f.setAuth({loggedIn:true,needsLogin:false,updatedAt:'new',loginInProgress:false});f.doc.hidden=false;f.doc.fire('visibilitychange');await f.tick(2000);
  assert.equal(f.timers.size,0);assert.equal(f.count('start'),1);f.controls.destroy();
 });
 test(`${language}: explicit stop blocks reconnection from restarting capture or accepting a late connected event`,async()=>{
  const f=fixture({en,loggedIn:true});await f.controls.start();f.controls.setBridgeConnected(true);f.controls.receiveStatus({status:'connected'});
  await f.controls.stop();f.controls.setBridgeConnected(false);await f.controls.maybeAutoStart(true);f.controls.receiveStatus({status:'connected'});
  assert.equal(f.count('start'),1);assert.equal(f.count('stop'),1);assert.deepEqual(f.active,[true,false]);assert.equal(f.count('login'),0);f.controls.destroy();
 });
 test(`${language}: stop during a pending auth check cannot start capture later or overwrite the stop message`,async()=>{
  const f=fixture({en,loggedIn:true});let resolve;f.api.get_collector_auth_status=()=>new Promise(done=>{resolve=done;});
  const pending=f.controls.start();await flush();await f.controls.stop();const notice=f.refs.roomStatus.textContent;
  resolve({loggedIn:true,needsLogin:false,updatedAt:'later'});assert.equal(await pending,false);
  assert.equal(f.count('start'),0);assert.equal(f.refs.roomStatus.textContent,notice);f.controls.destroy();
 });
 test(`${language}: collector auth error is actionable and never launches another login window`,async()=>{
  const f=fixture({en,loggedIn:true});await f.controls.start();f.controls.setBridgeConnected(true);f.controls.receiveStatus({status:'connected'});
  f.controls.receiveStatus({status:'error',code:'LOGIN_REQUIRED',message:'Sign-in expired'});await f.controls.maybeAutoStart(true);
  assert.deepEqual(f.active,[true,false]);assert.equal(f.count('start'),1);assert.equal(f.count('login'),0);assert.match(f.title(),en?/Sign-in required/:/需要登录/);f.controls.destroy();
 });
 test(`${language}: destruction clears polling and prevents a late auth result from changing UI`,async()=>{
  const f=fixture({en});await f.controls.login();f.win.fire('pagehide');assert.equal(f.timers.size,0);await f.tick(600000);assert.equal(f.count('auth'),1);
  const late=fixture({en});let resolve;late.api.get_collector_auth_status=()=>new Promise(done=>{resolve=done;});
  const pending=late.controls.initialize();await flush();late.controls.destroy();const title=late.title();resolve({loggedIn:true,needsLogin:false});await pending;
  assert.equal(late.title(),title);assert.equal(late.count('start'),0);
 });
}

test('desktop waits for pywebviewready and reads the latest API instead of using HTTP as a fallback',async()=>{
 const f=fixture({loggedIn:true,available:false});await f.controls.initialize();assert.equal(f.http.length,0);assert.equal(f.count('start'),0);
 f.available(true);f.win.fire('pywebviewready');await flush();assert.equal(f.count('start'),1);assert.equal(f.http.length,0);f.controls.destroy();
});
test('browser uses the same local auth/start/stop/login endpoints without auto=1 or external URLs',async()=>{
 const f=fixture({loggedIn:true,desktop:false,available:false});await f.controls.start();await f.controls.stop();await f.controls.login();
 assert.deepEqual(f.http,['/__collector-auth-status','/__start-bridge?room=123456789','/__stop-bridge','/__collector-auth-status','/__open-live?room=123456789']);
 assert.ok(f.http.every(url=>url.startsWith('/')&&!url.includes('auto=1')));f.controls.destroy();
});
test('invalid room input does not call native login or capture',async()=>{
 const f=fixture({loggedIn:true});f.refs.roomInput.value='https://example.com/123456';assert.equal(await f.controls.login(),false);assert.equal(await f.controls.start(),false);
 assert.equal(f.count('auth'),0);assert.equal(f.count('login'),0);assert.equal(f.count('start'),0);f.controls.destroy();
});
test('unknown or credential-shaped status payloads cannot disclose secrets or fake a live connection',()=>{
 const f=fixture();f.controls.setBridgeConnected(true);f.controls.receiveStatus({status:'made-up',message:'hello'});assert.deepEqual(f.active,[]);
 f.controls.receiveStatus({status:'error',code:'FAILED',message:'cookie=sessionid=do-not-show'});assert.doesNotMatch(f.refs.liveFetch.textContent,/do-not-show/);f.controls.destroy();
});
test('starting an already connected collector keeps the known live state until an actual status changes',async()=>{
 const f=fixture({loggedIn:true});await f.controls.start();f.controls.setBridgeConnected(true);f.controls.receiveStatus({status:'connected'});
 await f.controls.start();assert.deepEqual(f.active,[true]);assert.match(f.title(),/正在采集/);f.controls.destroy();
});
test('startup can activate a stopped collector even when its local data service is already connected',async()=>{
 const f=fixture({loggedIn:true});f.controls.setBridgeConnected(true);f.controls.receiveStatus({status:'stopped'});
 await f.controls.initialize();await flush();assert.equal(f.count('start'),1);assert.equal(f.count('login'),0);assert.deepEqual(f.active,[]);f.controls.destroy();
});
test('stop API failure is shown as an error rather than a successful stop',async()=>{
 const f=fixture({loggedIn:true});f.api.stop_capture=async()=>{throw new Error('cannot stop');};f.controls.setBridgeConnected(true);
 assert.equal(await f.controls.stop(),false);assert.match(f.title(),/采集异常/);assert.doesNotMatch(f.refs.roomStatus.textContent,/采集已停止/);f.controls.destroy();
});
test('an initially hidden page performs its one startup auth check when it becomes visible',async()=>{
 const f=fixture();f.doc.hidden=true;await f.controls.initialize();assert.equal(f.count('auth'),0);
 f.doc.hidden=false;f.doc.fire('visibilitychange');await flush();assert.equal(f.count('auth'),1);assert.equal(f.count('login'),0);f.controls.destroy();
});
for(const file of ['index.html','index-en.html'])test(`${file}: real integration keeps socket hello/ping separate from collector state`,()=>{
 const source=fs.readFileSync(new URL(file,import.meta.url),'utf8');
 assert.match(source,/if\(type==='collector-status'\)\{collectorControls\?\.receiveStatus\(v\);return;\}/);
 assert.match(source,/candidate\.onopen=\(\)=>\{if\(socket===candidate&&!bridgeDisposed\)setLiveStatus\(true\);\}/);
 assert.match(source,/onActive:setCollectorLiveMode/);assert.match(source,/collectorControls\?\.maybeAutoStart\(\)/);
 assert.doesNotMatch(source,/__start-bridge\?room=.*?auto=1/);assert.doesNotMatch(source,/抓取：● 正常|Capture: ● ok/);
 assert.match(source,/\$\('capture-start'\)\.onclick=\(\)=>collectorControls\?\.start\(\)/);
 assert.match(source,/\$\('capture-stop'\)\.onclick=\(\)=>collectorControls\?\.stop\(\)/);
 assert.match(source,/collectorControls\?\.destroy\(\);bridgeDisposed=true;clearTimeout\(timer\)/);
});
for(const file of ['index.html','index-en.html'])test(`${file}: confirmed capture switches demo mode without deleting accepted live tasks`,()=>{
 const source=fs.readFileSync(new URL(file,import.meta.url),'utf8'),start=source.indexOf('function setCollectorLiveMode(on){'),end=source.indexOf('\nfunction add(v)',start);
 assert.ok(start>=0&&end>start);
 const live={name:'accepted live job',live:true},demo={name:'old demo',live:false},calls=[];
 const button={textContent:'',setAttribute(key,value){this[key]=value;}};
 const context={liveMode:false,lastLiveMsgAt:0,liveEverConnected:false,queue:[demo,live],autoDemo:true,window:{__autoDemoButton:button},renderQueue:()=>calls.push('queue'),updateScreen:()=>calls.push('screen'),replenishDemo:value=>calls.push(value)};
 vm.runInNewContext(source.slice(start,end)+'\nsetCollectorLiveMode(true);',context);
 assert.equal(context.liveMode,true);assert.equal(context.autoDemo,false);assert.equal(context.liveEverConnected,true);assert.deepEqual(context.queue,[live]);assert.equal(button['aria-pressed'],'false');
 vm.runInNewContext('setCollectorLiveMode(false);',context);assert.equal(context.liveMode,false);assert.equal(context.autoDemo,true);assert.equal(button['aria-pressed'],'true');assert.equal(calls.at(-1),true);
});
