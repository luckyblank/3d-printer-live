import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const pages=['index.html','index-en.html'].map(name=>({name,html:fs.readFileSync(new URL('../../'+name,import.meta.url),'utf8')}));
const scriptFor=html=>html.match(/<script id="workspace-boot-bootstrap">([\s\S]*?)<\/script>/)[1];

function boot({theme='dark',storageFails=false,lang='zh-CN',search=''}={}){
 const classes=new Set(['workspace-booting']),attributes={},events=new Map(),documentEvents=new Map();
 const frames=[],timers=new Map();let timerId=0,reloads=0;
 const elements=new Map(['workspace-boot-title','workspace-boot-message','workspace-boot-retry','workspace-boot-screen','workspace-boot-close'].map(id=>[id,{
  textContent:'',hidden:true,removed:false,attributes:{},
  setAttribute(name,value){this.attributes[name]=value},remove(){this.removed=true}
 }]));
 const root={lang,classList:{remove:name=>classes.delete(name)},setAttribute:(name,value)=>attributes[name]=value};
 const document={documentElement:root,readyState:'loading',
  getElementById:id=>elements.get(id)?.removed?null:elements.get(id),
  addEventListener:(type,handler)=>documentEvents.set(type,handler)};
 const window={localStorage:{getItem(){if(storageFails)throw Error('Storage unavailable');return theme}},
  location:{search,reload(){reloads++}},
  addEventListener(type,handler,capture){events.set(type,{handler,capture})},
  requestAnimationFrame:handler=>frames.push(handler),
  setTimeout(handler,delay){timers.set(++timerId,{handler,delay});return timerId},
  clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(scriptFor(pages[0].html),{window,document});
 return {api:window.workspaceBoot,classes,attributes,elements,timers,frames,events,window,
  parsed(){documentEvents.get('DOMContentLoaded')?.()},
  dispatch(type,event={}){events.get(type).handler({target:window,...event})},
  flushFrame(){frames.splice(0).forEach(handler=>handler())},
  slow(){[...timers.values()].forEach(timer=>timer.handler())},
  get reloads(){return reloads}};
}

test('both pages hide legacy markup before modules or external styles can run',()=>{
 for(const {name,html} of pages){
  assert.match(html,/<html[^>]*class="workspace-booting"/,name);
  const cssIndex=html.indexOf('<style id="workspace-boot-critical">');
  const scriptIndex=html.indexOf('<script id="workspace-boot-bootstrap">');
  assert.ok(cssIndex<scriptIndex&&scriptIndex<html.indexOf('href="assets/workspace.css"'),name);
  assert.ok(scriptIndex<html.indexOf('<script type="module">'),name);
  assert.match(html,/html\.workspace-booting body>header[^\n]+visibility:hidden!important/);
  assert.match(html,/<body>\s*<div id="workspace-boot-screen"/);
  assert.match(html,/<div class="workspace-boot-header pywebview-drag-region">/);
  assert.match(html,/<span class="pywebview-drag-region">/);
  assert.match(html,/<button id="workspace-boot-close"[^>]+hidden>/);
  assert.doesNotMatch(html,/<button id="workspace-boot-close"[^>]+class="[^"]*pywebview-drag-region/);
  assert.ok(html.lastIndexOf('window.workspaceBoot.ready();')>html.indexOf('if(!SCENE_MODE)mountWorkspace('),name);
 }
 assert.equal(scriptFor(pages[0].html),scriptFor(pages[1].html),'language pages share the same state machine');
});

test('ready reveals mounted controls only on the next frame',()=>{
 const b=boot();b.parsed();b.api.ready();
 assert.equal(b.api.state,'ready-pending');assert.ok(b.classes.has('workspace-booting'));
 assert.equal(b.elements.get('workspace-boot-screen').removed,false);
 b.flushFrame();assert.equal(b.api.state,'ready');assert.equal(b.classes.has('workspace-booting'),false);
 assert.equal(b.elements.get('workspace-boot-screen').removed,true);assert.equal(b.timers.size,0);
});

test('startup errors before the ready frame keep the legacy interface hidden',()=>{
 const b=boot();b.parsed();b.api.ready();b.dispatch('error',{message:'first animation frame failed'});b.flushFrame();
 assert.equal(b.api.state,'failed');assert.ok(b.classes.has('workspace-booting'));
 assert.equal(b.elements.get('workspace-boot-screen').removed,false);
 assert.equal(b.elements.get('workspace-boot-title').textContent,'工作台启动失败');
 assert.equal(b.elements.get('workspace-boot-retry').hidden,false);
 b.api.ready();b.flushFrame();assert.equal(b.api.state,'failed');
 b.elements.get('workspace-boot-retry').onclick();assert.equal(b.reloads,1);
});

test('required script and workspace stylesheet errors fail boot, optional image errors do not',()=>{
 for(const target of [{tagName:'SCRIPT',src:'workspace-ui.mjs'},{tagName:'LINK',href:'http://127.0.0.1:8080/assets/workspace.css?v=2'}]){
  const b=boot();b.dispatch('error',{target});b.parsed();assert.equal(b.api.state,'failed');
 }
 const b=boot();b.parsed();
 for(const target of [{tagName:'IMG',src:'avatar.png'},{tagName:'IMG',src:'home.png'},{tagName:'LINK',href:'assets/live-rules.css'}])b.dispatch('error',{target});
 assert.equal(b.api.state,'loading');assert.equal(b.events.get('error').capture,true);
 b.api.ready();b.flushFrame();assert.equal(b.api.state,'ready');
});

test('a module rejection is fatal during boot but a later handled workspace state is not replaced',()=>{
 const b=boot();b.dispatch('unhandledrejection',{reason:Error('Import failed')});
 assert.equal(b.api.state,'failed');
 const ready=boot();ready.api.ready();ready.flushFrame();ready.dispatch('error',{message:'later event error'});
 assert.equal(ready.api.state,'ready');
});

test('10-second timeout offers retry without revealing legacy markup',()=>{
 const b=boot();b.parsed();assert.equal([...b.timers.values()][0].delay,10000);b.slow();
 assert.equal(b.api.state,'loading');assert.ok(b.classes.has('workspace-booting'));
 assert.equal(b.elements.get('workspace-boot-retry').hidden,false);
 assert.match(b.elements.get('workspace-boot-message').textContent,/加载时间/);
 b.api.ready();b.flushFrame();assert.equal(b.api.state,'ready');
});

test('theme is applied synchronously, storage errors fall back, and scene boot stays identified',()=>{
 const b=boot({theme:'light',search:'?scene=1'});
 assert.equal(b.attributes['data-workspace-boot-theme'],'light');
 assert.equal(b.attributes['data-workspace-boot-scene'],'true');
 const fallback=boot({storageFails:true});assert.equal(fallback.attributes['data-workspace-boot-theme'],'dark');
 const en=boot({lang:'en'});en.parsed();assert.equal(en.elements.get('workspace-boot-title').textContent,'Preparing print workspace…');
});

test('native close stays hidden in browser previews and binds when the desktop API is ready',()=>{
 const b=boot();b.parsed();const close=b.elements.get('workspace-boot-close');
 assert.equal(close.hidden,true);assert.equal(close.onclick,null);
 let closed=0;b.window.pywebview={api:{window_close(){closed++}}};
 b.dispatch('pywebviewready');assert.equal(close.hidden,false);close.onclick();assert.equal(closed,1);
 b.api.fail();assert.equal(close.hidden,false);close.onclick();assert.equal(closed,2);
 const early=boot();early.window.pywebview={api:{window_close(){closed++}}};early.parsed();
 assert.equal(early.elements.get('workspace-boot-close').hidden,false);
});
