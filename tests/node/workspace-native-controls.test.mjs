import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../workspace-ui.mjs',import.meta.url),'utf8');
const helperEnd=source.indexOf('export function mountWorkspace(');
const blockStart=source.indexOf(' let nativeControls=null,nativeButtons={},syncNativeWindowState=null;');
const blockEnd=source.indexOf(" const fps=node('span','workspace-performance'",blockStart);
assert.ok(helperEnd>0&&blockStart>helperEnd&&blockEnd>blockStart,'Real native-control source markers must be present');
const realImplementation=source.slice(0,helperEnd).replace(/^import[^\n]+\n/gm,'').replace(/^export (?=(?:async )?function )/gm,'')+source.slice(blockStart,blockEnd);

class Events {
 constructor(){this.listeners=new Map()}
 addEventListener(type,handler,options={}){const items=this.listeners.get(type)||[];items.push({handler,once:options?.once===true});this.listeners.set(type,items)}
 emit(type,event={}){for(const entry of [...(this.listeners.get(type)||[])]){entry.handler(event);if(entry.once)this.listeners.set(type,this.listeners.get(type).filter(item=>item!==entry))}}
 count(type){return (this.listeners.get(type)||[]).length}
}

class Element extends Events {
 constructor(tag){super();this.tagName=tag.toUpperCase();this.className='';this.children=[];this.attributes={};this.disabled=false;this.innerHTML='';this.title='';this.parentElement=null;this.classList={contains:name=>this.className.split(/\s+/).includes(name),add:(...names)=>{this.className=[...new Set([...this.className.split(/\s+/).filter(Boolean),...names])].join(' ')}}}
 append(...children){for(const child of children){this.children.push(child);child.parentElement=this}}
 setAttribute(name,value){this.attributes[name]=String(value)}
 getAttribute(name){return this.attributes[name]??null}
 matches(selector){return selector.startsWith('.')?this.classList.contains(selector.slice(1)):this.tagName.toLowerCase()===selector}
 querySelectorAll(selector){const matches=[];for(const child of this.children){if(child.matches(selector))matches.push(child);matches.push(...child.querySelectorAll(selector))}return matches}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null}
 closest(selector){for(let current=this;current;current=current.parentElement)if(selector.split(',').some(part=>current.matches(part)))return current;return null}
 click(){if(!this.disabled)return this.onclick?.({target:this})}
}

function harness({desktop=true,api,en=false}={}){
 const header=new Element('header'),actions=new Element('div');actions.className='workspace-header-actions';header.append(actions);
 const window=new Events();if(api)window.pywebview={api};
 const context={window,header,location:{search:desktop?'?desktop=1':''},URLSearchParams,
  document:{createElement:tag=>new Element(tag)},t:(chinese,english)=>en?english:chinese};
 vm.runInNewContext(realImplementation+`;globalThis.controlsHarness={mount:mountNativeControls,get group(){return nativeControls},get buttons(){return nativeButtons}};`,context);
 return {window,header,actions,controls:context.controlsHarness};
}

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const fullApi=overrides=>({window_minimize(){},window_toggle_maximize(){return false},window_close(){},...overrides});

test('desktop markup synchronously reserves three disabled controls before the bridge exists',()=>{
 const h=harness();
 assert.equal(h.actions.querySelectorAll('.workspace-native-controls').length,1);
 assert.equal(h.controls.group.children.length,3);
 assert.equal(Object.keys(h.controls.buttons).length,3);
 assert.ok(Object.values(h.controls.buttons).every(button=>button.disabled));
 assert.equal(h.controls.buttons.window_toggle_maximize.getAttribute('aria-label'),'最大化窗口');
 assert.equal(h.controls.buttons.window_toggle_maximize.title,'最大化窗口');
});

test('bridge readiness enables existing nodes without duplicating groups or listeners',async()=>{
 const h=harness(),group=h.controls.group,buttons=Object.values(h.controls.buttons);
 h.window.pywebview={api:fullApi()};h.window.emit('pywebviewready');
 h.controls.mount();h.controls.mount();h.window.emit('pywebviewready');await flush();
 assert.equal(h.controls.group,group);
 assert.equal(h.actions.querySelectorAll('.workspace-native-controls').length,1);
 assert.deepEqual(Object.values(h.controls.buttons),buttons);
 assert.ok(buttons.every(button=>!button.disabled));
 assert.equal(h.header.count('dblclick'),1);
 assert.equal(h.window.count('workspace-window-state'),1);
 assert.equal(h.window.count('pywebviewready'),0);
});

test('double-click and native state update maximize/restore icons and accessible labels',async()=>{
 let maximized=false,calls=0;
 const h=harness({api:fullApi({window_toggle_maximize(){calls++;maximized=!maximized;return maximized}})});
 h.controls.mount();h.controls.mount();const maximize=h.controls.buttons.window_toggle_maximize;
 h.header.emit('dblclick',{target:h.header});await flush();
 assert.equal(calls,1);assert.equal(maximize.getAttribute('aria-pressed'),'true');
 assert.equal(maximize.getAttribute('aria-label'),'还原窗口');assert.equal(maximize.title,'还原窗口');
 assert.match(maximize.innerHTML,/M8 8V5h11v11h-3M5 8h11v11H5z/);
 h.header.emit('dblclick',{target:h.controls.buttons.window_close});await flush();assert.equal(calls,1);
 h.window.emit('workspace-window-state',{detail:{maximized:false,minimized:false}});
 assert.equal(maximize.getAttribute('aria-pressed'),'false');assert.equal(maximize.title,'最大化窗口');
 assert.match(maximize.innerHTML,/M5 5h14v14H5z/);
 maximize.click();await flush();assert.equal(calls,2);
});

test('clicks use the current bridge API after replacement, not stale captured methods',async()=>{
 const oldCalls=[],newCalls=[];
 const h=harness({api:fullApi({window_minimize(){oldCalls.push('minimize')},window_close(){oldCalls.push('close')},window_toggle_maximize(){oldCalls.push('maximize');return true}})});
 const buttons=Object.values(h.controls.buttons);
 h.window.pywebview.api=fullApi({window_minimize(){newCalls.push('minimize')},window_close(){newCalls.push('close')},window_toggle_maximize(){newCalls.push('maximize');return true}});
 for(const button of buttons)button.click();await flush();
 assert.deepEqual(oldCalls,[]);assert.deepEqual(newCalls,['minimize','maximize','close']);
 assert.equal(h.controls.buttons.window_toggle_maximize.getAttribute('aria-label'),'还原窗口');
});

test('ordinary browser previews without a native API do not display native controls',()=>{
 const h=harness({desktop:false});h.window.emit('pywebviewready');
 assert.equal(h.controls.group,null);
 assert.equal(h.actions.querySelectorAll('.workspace-native-controls').length,0);
 assert.equal(h.header.count('dblclick'),0);assert.equal(h.window.count('workspace-window-state'),0);
});

test('initial actual native state synchronizes the restore icon, including legacy desktop URLs',async()=>{
 const h=harness({desktop:false,en:true,api:fullApi({window_state(){return {maximized:true,minimized:false}}})});
 await flush();
 assert.equal(h.actions.querySelectorAll('.workspace-native-controls').length,1);
 const maximize=h.controls.buttons.window_toggle_maximize;
 assert.equal(maximize.getAttribute('aria-label'),'Restore window');assert.equal(maximize.title,'Restore window');
 assert.equal(maximize.getAttribute('aria-pressed'),'true');
 h.window.emit('workspace-window-state',{detail:false});assert.equal(maximize.title,'Maximize window');
});
