import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createAudioControls} from './audio-state.mjs';

class Node {
 constructor(){this.attributes={};this.listeners=new Map();this.children=[];this.textContent='';this.value='';}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getAttribute(name){return this.attributes[name]??null;}
 addEventListener(name,listener){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(listener);}
 removeEventListener(name,listener){this.listeners.get(name)?.delete(listener);}
 dispatch(name,extra={}){for(const listener of this.listeners.get(name)||[])listener({type:name,target:this,...extra});}
 contains(node){return this===node||this.children.some(child=>child.contains(node));}
 closest(){return null;}
}
class Document extends Node {
 constructor(){super();this.hidden=false;this.body=new Node();}
 gesture(type='pointerdown',extra={}){this.dispatch(type,{isTrusted:true,button:0,key:'Enter',target:this.body,...extra});}
}
class Media extends Node {
 constructor(){super();this.paused=true;this.ended=false;this.playCalls=0;this.currentTime=0;this.behavior=null;}
 async play(){this.playCalls++;this.paused=false;this.ended=false;if(this.behavior)await this.behavior();if(this.paused)throw Error('play was cancelled');this.dispatch('playing');}
 pause(){const wasPlaying=!this.paused;this.paused=true;if(wasPlaying)this.dispatch('pause');}
 finish(){this.ended=true;this.paused=true;this.dispatch('ended');}
}
class Effects {
 constructor(doc){this.doc=doc;this.ctx=null;this.enabled=false;this.volume=.65;this.enableCalls=0;this.rebuildCalls=0;this.silenceCalls=0;this.plans=[];this.error=null;}
 async enable(){
  this.enableCalls++;if(!this.ctx){this.ctx=new Node();this.ctx.state='suspended';}
  const plan=this.plans.shift();if(plan)await plan;
  if(this.error)throw this.error;
  this.enabled=true;this.ctx.state='running';this.ctx.dispatch('statechange');
 }
 async rebuild(){this.rebuildCalls++;return this.enable();}
 mute(){this.enabled=false;}
 setVolume(value){this.volume=value;}
 silence(){this.silenceCalls++;}
 isHidden(){return this.doc.hidden;}
 suspend(){this.ctx.state='suspended';this.ctx.dispatch('statechange');}
}
class Speech {
 constructor(){this._enabled=true;this.unlocked=false;this.state='locked';this.lastError='';this.available=true;this.supported=true;this.blocked=false;this.previewing=false;this.unlockCalls=0;this.previewCalls=0;this.stopCalls=0;this.onStateChange=null;}
 get enabled(){return this._enabled;}
 set enabled(value){if(value===this._enabled)return;this._enabled=value;this.stop();if(value){this.state='locked';this.emit();}}
 get ready(){return this.enabled&&this.unlocked&&this.available&&['ready','starting','speaking'].includes(this.state);}
 emit(){this.onStateChange?.({state:this.state,ready:this.ready,enabled:this.enabled,unlocked:this.unlocked,previewing:this.previewing,error:this.lastError});}
 unlock(){
  this.unlockCalls++;
  if(!this.supported){this.state='unsupported';this.emit();return false;}
  if(this.blocked){this.unlocked=false;this.state='blocked';this.lastError='not-allowed';this.emit();return false;}
  this.unlocked=true;this.lastError='';this.state=this.available?'ready':'loading-voices';this.emit();return this.ready;
 }
 stop(){this.stopCalls++;this.previewing=false;this.unlocked=false;this.state=this.enabled?'stopped':'disabled';this.emit();}
 cancel(){const unlocked=this.unlocked;this.stop();this.unlocked=unlocked;this.state=this.enabled?(unlocked?'ready':'locked'):'disabled';this.emit();}
 loadVoices(){this.available=true;if(this.enabled&&this.unlocked)this.state='ready';this.emit();}
 preview(){this.previewCalls++;this.restore={enabled:this.enabled,unlocked:this.unlocked};this.stop();this.previewing=true;this.unlocked=true;this.state='speaking';this.emit();return true;}
 finishPreview(){this.previewing=false;this.unlocked=this.enabled&&this.restore.unlocked;this.state=this.enabled?(this.unlocked?'ready':'locked'):'disabled';this.emit();}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(en,prefs={},configure=()=>{}){
 const doc=new Document(),entries=new Map(Object.entries(prefs)),writes=[];
 const storage={getItem:key=>entries.get(key)??null,setItem:(key,value)=>{entries.set(key,value);writes.push([key,value]);}};
 const refs=Object.fromEntries(['quickSound','soundButton','volume','audioStatus','speechToggle','speechTest','welcomeButton','soundTest','repairAudio','voiceSelect','rateInput'].map(key=>[key,new Node()]));
 refs.volume.value='65';refs.rateInput.value='1.05';refs.nativeAudio=new Media();
 const effects=new Effects(doc),speech=new Speech(),announcements=[],welcomes=[];
 configure({effects,speech,doc,refs});
 const controls=createAudioControls({...refs,machineAudio:effects,giftSpeech:speech,document:doc,storage,en,onVoiceReady:()=>announcements.push('current viewer'),onWelcome:()=>welcomes.push('welcome'),previewName:()=>en?'Demo viewer':'测试观众'});
 const click=node=>node.onclick({isTrusted:true,target:node});
 return {doc,entries,writes,refs,effects,speech,announcements,welcomes,controls,click};
}

for(const en of [false,true]){
 const language=en?'en':'zh';
 test(`${language}: startup shows pending activation, not a saved-on claim`,()=>{
  const f=fixture(en);assert.equal(f.controls.getState().phase,'pending');assert.equal(f.effects.enableCalls,0);assert.equal(f.speech.unlockCalls,0);
  assert.equal(f.refs.quickSound.getAttribute('aria-pressed'),'false');assert.match(f.refs.quickSound.textContent,en?/Enable sound/:/启用声音/);
  assert.match(f.refs.audioStatus.textContent,en?/Click Enable sound/:/点击启用声音后开始播报/);assert.equal(f.writes.length,0);f.controls.dispose();
 });
 test(`${language}: first dedicated click enables, pointerdown cannot double-toggle, current task announced once`,async()=>{
  const f=fixture(en);f.doc.gesture('pointerdown',{target:f.refs.quickSound});assert.equal(f.effects.enableCalls,0);
  f.click(f.refs.quickSound);await flush();assert.equal(f.controls.getState().phase,'on');assert.equal(f.entries.get('printer-sound'),'on');assert.equal(f.speech.unlockCalls,1);assert.equal(f.effects.enableCalls,1);assert.equal(f.announcements.length,1);
  f.speech.emit();assert.equal(f.announcements.length,1);assert.match(f.refs.quickSound.textContent,en?/Mute sound/:/关闭声音/);assert.notEqual(f.refs.quickSound.textContent,'🔊');
  f.click(f.refs.quickSound);assert.equal(f.controls.getState().phase,'off');assert.equal(f.entries.get('printer-sound'),'off');assert.equal(f.speech.enabled,false);assert.equal(f.effects.enabled,false);f.controls.dispose();
 });
 test(`${language}: saved mute survives ordinary gestures, focus, visibility and a fresh page`,async()=>{
  const f=fixture(en,{'printer-sound':'off'});f.doc.gesture();f.doc.gesture('keydown');f.doc.dispatch('focus');f.doc.hidden=true;f.doc.dispatch('visibilitychange');f.doc.hidden=false;f.doc.dispatch('visibilitychange');await flush();
  assert.equal(f.controls.getState().phase,'off');assert.equal(f.effects.enableCalls,0);assert.equal(f.speech.unlockCalls,0);assert.equal(f.entries.get('printer-sound'),'off');assert.equal(f.writes.length,0);f.controls.dispose();
  const again=fixture(en,{'printer-sound':'off'});assert.equal(again.controls.getState().phase,'off');again.controls.dispose();
 });
 test(`${language}: global activation requires a trusted effective key or primary pointer`,async()=>{
  const f=fixture(en);for(const key of ['Escape','Shift','Control','Alt','Meta','Tab','F1'])f.doc.gesture('keydown',{key});
  f.doc.gesture('keydown',{key:'Enter',ctrlKey:true});f.doc.gesture('pointerdown',{isTrusted:false});f.doc.gesture('pointerdown',{button:2});await flush();assert.equal(f.effects.enableCalls,0);
  f.doc.gesture('keydown',{key:'Enter'});await flush();assert.equal(f.controls.getState().phase,'on');f.controls.dispose();
 });
 test(`${language}: pending enable completing after mute cannot turn sound back on`,async()=>{
  const wait=deferred();const f=fixture(en,{},({effects})=>effects.plans.push(wait.promise));
  f.click(f.refs.quickSound);assert.equal(f.controls.getState().phase,'enabling');f.click(f.refs.quickSound);assert.equal(f.controls.getState().masterWanted,false);
  wait.resolve();await flush();assert.equal(f.effects.enabled,false);assert.equal(f.speech.enabled,false);assert.equal(f.controls.getState().phase,'off');assert.equal(f.entries.get('printer-sound'),'off');f.controls.dispose();
 });
 test(`${language}: an older operation cannot mute a newer successful enable`,async()=>{
  const first=deferred(),second=deferred();const f=fixture(en,{},({effects})=>effects.plans.push(first.promise,second.promise));
  f.click(f.refs.quickSound);f.click(f.refs.quickSound);f.click(f.refs.quickSound);second.resolve();await flush();assert.equal(f.controls.getState().phase,'on');
  first.resolve();await flush();assert.equal(f.effects.enabled,true);assert.equal(f.controls.getState().masterWanted,true);assert.equal(f.entries.get('printer-sound'),'on');f.controls.dispose();
 });
 test(`${language}: independent effects and voice preferences survive master mute`,async()=>{
  const voiceOnly=fixture(en,{'printer-effects':'off'});voiceOnly.click(voiceOnly.refs.quickSound);await flush();assert.equal(voiceOnly.effects.enableCalls,0);assert.equal(voiceOnly.controls.getState().voiceReady,true);assert.equal(voiceOnly.controls.getState().phase,'on');voiceOnly.controls.dispose();
  const effectsOnly=fixture(en,{'printer-voice':'off'});effectsOnly.click(effectsOnly.refs.quickSound);await flush();assert.equal(effectsOnly.speech.unlockCalls,0);assert.equal(effectsOnly.speech.enabled,false);effectsOnly.click(effectsOnly.refs.quickSound);effectsOnly.click(effectsOnly.refs.quickSound);await flush();assert.equal(effectsOnly.entries.get('printer-voice'),'off');assert.equal(effectsOnly.speech.enabled,false);assert.equal(effectsOnly.controls.getState().effectsReady,true);effectsOnly.controls.dispose();
 });
 test(`${language}: one failing channel does not block the working channel`,async()=>{
  const effects=fixture(en,{},({speech})=>speech.supported=false);effects.click(effects.refs.quickSound);await flush();assert.equal(effects.controls.getState().effectsReady,true);assert.equal(effects.controls.getState().voiceReady,false);assert.equal(effects.controls.getState().phase,'on');assert.match(effects.refs.audioStatus.textContent,en?/unsupported/:/不支持/);effects.controls.dispose();
  const voice=fixture(en,{},({effects})=>effects.error=Error('no audio context'));voice.click(voice.refs.quickSound);await flush();assert.equal(voice.controls.getState().voiceReady,true);assert.equal(voice.controls.getState().effectsReady,false);assert.equal(voice.controls.getState().phase,'on');assert.match(voice.refs.audioStatus.textContent,/no audio context/);voice.controls.dispose();
 });
 test(`${language}: a failed activation retries on the next click instead of switching off`,async()=>{
  const f=fixture(en,{},({effects,speech})=>{effects.error=Error('blocked');speech.blocked=true;});f.click(f.refs.quickSound);await flush();assert.equal(f.controls.getState().phase,'error');assert.match(f.refs.quickSound.textContent,en?/Retry/:/重试/);
  f.effects.error=null;f.speech.blocked=false;f.click(f.refs.quickSound);await flush();assert.equal(f.controls.getState().phase,'on');assert.equal(f.controls.getState().masterWanted,true);f.controls.dispose();
 });
 test(`${language}: delayed voices become ready and announce only the current task once`,async()=>{
  const f=fixture(en,{},({speech})=>speech.available=false);f.click(f.refs.quickSound);await flush();assert.equal(f.controls.getState().effectsReady,true);assert.equal(f.controls.getState().voiceReady,false);assert.equal(f.announcements.length,0);
  f.speech.loadVoices();assert.equal(f.controls.getState().voiceReady,true);assert.equal(f.announcements.length,1);f.speech.emit();assert.equal(f.announcements.length,1);f.controls.dispose();
 });
 test(`${language}: explicit voice preview while muted is temporary and does not change preferences`,()=>{
  const f=fixture(en,{'printer-sound':'off','printer-voice':'off'});f.click(f.refs.speechTest);assert.equal(f.speech.previewCalls,1);assert.equal(f.controls.getState().previewing,true);assert.equal(f.speech.enabled,false);assert.equal(f.writes.length,0);
  f.speech.finishPreview();assert.equal(f.controls.getState().phase,'off');assert.equal(f.entries.get('printer-sound'),'off');assert.equal(f.entries.get('printer-voice'),'off');assert.equal(f.effects.enableCalls,0);f.controls.dispose();
 });
 test(`${language}: explicit effect preview is temporary and can be cancelled during loading`,async()=>{
  const f=fixture(en,{'printer-sound':'off'});f.click(f.refs.soundTest);await flush();assert.equal(f.controls.getState().previewing,true);assert.equal(f.writes.length,0);assert.equal(f.effects.enableCalls,0);f.refs.nativeAudio.finish();assert.equal(f.controls.getState().phase,'off');f.controls.dispose();
  const waiting=deferred(),g=fixture(en,{'printer-sound':'off'},({refs})=>refs.nativeAudio.behavior=()=>waiting.promise);g.click(g.refs.soundTest);assert.equal(g.controls.getState().phase,'enabling');g.click(g.refs.quickSound);waiting.resolve();await flush();assert.equal(g.refs.nativeAudio.paused,true);assert.equal(g.controls.getState().phase,'off');assert.equal(g.writes.length,0);g.controls.dispose();
 });
 test(`${language}: an effects-only suspended context can be restored by its next enable click`,async()=>{
  const f=fixture(en,{'printer-voice':'off'});f.click(f.refs.quickSound);await flush();f.effects.suspend();assert.equal(f.controls.getState().phase,'pending');f.click(f.refs.quickSound);await flush();assert.equal(f.controls.getState().masterWanted,true);assert.equal(f.controls.getState().phase,'on');f.controls.dispose();
 });
 test(`${language}: repair while muted cannot persistently unmute, and simulated joins respect voice off`,async()=>{
  const f=fixture(en,{'printer-sound':'off','printer-voice':'off'});f.click(f.refs.repairAudio);await flush();assert.equal(f.effects.rebuildCalls,1);assert.equal(f.effects.enabled,false);assert.equal(f.entries.get('printer-sound'),'off');assert.equal(f.writes.length,0);
  f.click(f.refs.welcomeButton);assert.equal(f.welcomes.length,0);assert.match(f.refs.audioStatus.textContent,en?/Enable voice before/:/需要先启用播报/);f.controls.dispose();
 });
 test(`${language}: channel toggles, volume and visibility do not overwrite the other preference`,async()=>{
  const f=fixture(en);f.click(f.refs.speechToggle);await flush();assert.equal(f.controls.getState().voiceReady,true);f.click(f.refs.speechToggle);assert.equal(f.entries.get('printer-voice'),'off');assert.equal(f.controls.getState().voiceReady,false);assert.equal(f.controls.getState().effectsReady,true);
  f.refs.volume.value='32';f.refs.volume.oninput();assert.equal(f.effects.volume,.32);f.doc.hidden=true;f.doc.dispatch('visibilitychange');f.doc.hidden=false;f.doc.dispatch('visibilitychange');assert.equal(f.entries.get('printer-voice'),'off');assert.equal(f.effects.silenceCalls,1);f.controls.dispose();
 });
}

test('both pages install the real shared coordinator, retain current-task callback and avoid old unsafe listeners',()=>{
 for(const file of ['index.html','index-en.html']){
  const source=fs.readFileSync(new URL(file,import.meta.url),'utf8');
  assert.match(source,/import \{createAudioControls\} from '\.\/audio-state\.mjs'/);
  assert.match(source,/onVoiceReady:\(\)=>\{if\(active\)giftSpeech\.printing\(active\.name\)\}/);
  assert.match(source,/function resetDemo\(\)\{giftSpeech\.cancel\(\{lock:false\}\)/);
  assert.doesNotMatch(source,/giftSpeech\.unlocked\s*=\s*true|function gestureAudio|quickSound\.textContent='🔊'|quickSound\.textContent='🔇'/);
  const voiceRefresh=source.match(/function refreshVoices\(\)\{[^\n]+/)[0];assert.doesNotMatch(voiceRefresh,/speech-caption|\.textContent/);
 }
});
