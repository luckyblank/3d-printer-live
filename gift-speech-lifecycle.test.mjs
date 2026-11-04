import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GiftSpeech as ChineseSpeech} from './gift-speech.mjs';
import {GiftSpeech as EnglishSpeech} from './gift-speech-en.mjs';

function environment(t,{voices=[],paused=false,unsupported=false}={}){
 const original={speechSynthesis:globalThis.speechSynthesis,SpeechSynthesisUtterance:globalThis.SpeechSynthesisUtterance};
 const listeners=new Set(),spoken=[];
 const synth={paused,resumes:0,cancels:0,
  getVoices:()=>voices,
  addEventListener(type,callback){if(type==='voiceschanged')listeners.add(callback)},
  removeEventListener(type,callback){if(type==='voiceschanged')listeners.delete(callback)},
  resume(){this.paused=false;this.resumes++},
  cancel(){this.cancels++},
  speak(utterance){spoken.push(utterance)},
 };
 globalThis.speechSynthesis=unsupported?undefined:synth;
 globalThis.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};
 t.after(()=>Object.assign(globalThis,original));
 return {synth,spoken,setVoices(list){voices=list;for(const callback of listeners)callback()}};
}

const voiceFor=language=>({voiceURI:language+'-voice',name:language==='zh-CN'?'Xiaoxiao':'Aria',lang:language});

for(const [label,Speech,language] of [['Chinese',ChineseSpeech,'zh-CN'],['English',EnglishSpeech,'en-US']]){
 test(label+': network gifts and welcomes never unlock or backlog before a gesture',t=>{
  const e=environment(t,{voices:[voiceFor(language)]}),speech=new Speech();t.after(()=>speech.stop());
  speech.say('观众','gift');speech.welcome('观众');speech.printing('观众');
  assert.equal(speech.unlocked,false);assert.equal(speech.queue.length,0);assert.equal(e.spoken.length,0);assert.equal(speech.state,'locked');
 });

 test(label+': explicit unlock resumes paused synthesis and exposes actual starting/start states',t=>{
  const e=environment(t,{voices:[voiceFor(language)],paused:true}),states=[],speech=new Speech(()=>{},state=>states.push(state));t.after(()=>speech.stop());
  assert.equal(speech.unlock(),true);assert.equal(e.synth.resumes,1);assert.equal(speech.ready,true);assert.equal(speech.state,'ready');
  speech.say('观众','gift');assert.equal(e.spoken.length,1);assert.equal(speech.state,'starting');
  e.spoken[0].onstart();assert.equal(speech.state,'speaking');
  e.spoken[0].onend();assert.equal(speech.state,'ready');assert.equal(speech.speaking,false);
  assert.ok(states.some(state=>state.state==='speaking'&&state.ready));
 });

 test(label+': delayed system voices retain only the newest message and start on voiceschanged',t=>{
  const e=environment(t),speech=new Speech();t.after(()=>speech.stop());
  assert.equal(speech.unlock(),false);assert.equal(speech.state,'loading-voices');
  speech.say('旧观众','gift');speech.welcome('最新观众');
  assert.equal(e.spoken.length,0);assert.equal(speech.queue.length,1);assert.ok(speech.queue[0].includes('最新观众'));
  e.setVoices([voiceFor(language)]);assert.equal(e.spoken.length,1);assert.ok(e.spoken[0].text.includes('最新观众'));assert.equal(speech.state,'starting');
  e.spoken[0].onstart();assert.equal(speech.state,'speaking');
 });

 test(label+': cancellation invalidates late callbacks and late voices cannot restore muted speech',t=>{
  const e=environment(t,{voices:[voiceFor(language)]}),speech=new Speech();t.after(()=>speech.stop());
  speech.unlock();speech.say('先前','gift');const old=e.spoken[0];speech.welcome('排队');
  speech.stop();const generation=speech.generation;old.onstart();old.onend();old.onerror({error:'not-allowed'});
  speech.say('新事件','gift');assert.equal(speech.generation,generation);assert.equal(speech.state,'stopped');assert.equal(speech.enabled,true);assert.equal(speech.unlocked,false);assert.equal(e.spoken.length,1);assert.equal(speech.queue.length,0);
  e.setVoices([]);speech.unlock();speech.say('等待','gift');speech.enabled=false;e.setVoices([voiceFor(language)]);
  assert.equal(speech.state,'disabled');assert.equal(speech.ready,false);assert.equal(e.spoken.length,1);assert.equal(speech.queue.length,0);
 });

 test(label+': permission failure is observable, relocks and does not auto-retry network events',t=>{
  const e=environment(t,{voices:[voiceFor(language)]}),states=[],speech=new Speech(()=>{},state=>states.push(state));t.after(()=>speech.stop());
  speech.unlock();speech.say('观众','gift');speech.welcome('排队');e.spoken[0].onerror({error:'not-allowed'});
  assert.equal(speech.state,'blocked');assert.equal(speech.lastError,'not-allowed');assert.equal(speech.unlocked,false);assert.equal(speech.queue.length,0);
  speech.welcome('之后');speech.say('之后','gift');assert.equal(e.spoken.length,1);
  assert.ok(states.some(state=>state.state==='blocked'&&!state.ready&&state.error==='not-allowed'));
  speech.unlock();speech.say('显式重试','gift');assert.equal(e.spoken.length,2);
 });

 test(label+': unsupported API and unavailable language voices have explicit states',t=>{
  const e=environment(t,{unsupported:true}),speech=new Speech();t.after(()=>speech.stop());
  assert.equal(speech.unlock(),false);assert.equal(speech.state,'unsupported');assert.equal(speech.lastError,'unsupported');
  globalThis.speechSynthesis=e.synth;e.setVoices([{voiceURI:'other',name:'Other',lang:'fr-FR'}]);
  assert.equal(speech.unlock(),false);assert.equal(speech.state,'no-voice');assert.equal(speech.ready,false);
 });

 test(label+': one-shot preview works while disabled without allowing network speech or changing preference',t=>{
  const e=environment(t,{voices:[voiceFor(language)]}),states=[],speech=new Speech(()=>{},state=>states.push(state));t.after(()=>speech.stop());
  speech.enabled=false;assert.equal(speech.preview('试听观众'),true);assert.equal(speech.enabled,false);assert.equal(speech.previewing,true);assert.equal(speech.ready,false);
  speech.say('网络观众','gift');speech.welcome('网络观众');assert.equal(e.spoken.length,1);assert.equal(speech.queue.length,0);
  e.spoken[0].onstart();assert.equal(speech.state,'speaking');e.spoken[0].onend();
  assert.equal(speech.state,'disabled');assert.equal(speech.enabled,false);assert.equal(speech.previewing,false);assert.equal(speech.unlocked,false);
  speech.say('后续网络','gift');assert.equal(e.spoken.length,1);assert.ok(states.some(state=>state.previewing&&state.enabled===false));
 });

 test(label+': preview restores already-unlocked speech and stop defeats a late preview completion',t=>{
  const e=environment(t,{voices:[voiceFor(language)]}),speech=new Speech();t.after(()=>speech.stop());
  speech.unlock();speech.preview('试听');e.spoken[0].onstart();e.spoken[0].onend();
  assert.equal(speech.ready,true);assert.equal(speech.unlocked,true);assert.equal(speech.state,'ready');
  speech.say('正常观众','gift');assert.equal(e.spoken.length,2);e.spoken[1].onend();
  speech.preview('取消试听');const preview=e.spoken[2];speech.enabled=false;preview.onend();
  assert.equal(speech.state,'disabled');assert.equal(speech.enabled,false);assert.equal(speech.previewing,false);assert.equal(speech.unlocked,false);
 });

 test(label+': preview before first regular unlock restores locked state, including delayed voices',t=>{
  const e=environment(t),speech=new Speech();t.after(()=>speech.stop());
  assert.equal(speech.preview('试听'),false);assert.equal(speech.state,'loading-voices');assert.equal(speech.previewing,true);
  e.setVoices([voiceFor(language)]);assert.equal(e.spoken.length,1);e.spoken[0].onstart();e.spoken[0].onend();
  assert.equal(speech.state,'locked');assert.equal(speech.enabled,true);assert.equal(speech.unlocked,false);assert.equal(speech.previewing,false);
  speech.say('未开启普通事件','gift');assert.equal(e.spoken.length,1);
 });

 test(label+': regular speech queue stays bounded and a blocked start cannot hang silently',t=>{
  const e=environment(t,{voices:[voiceFor(language)]}),speech=new Speech();t.after(()=>speech.stop());
  const originalSetTimeout=globalThis.setTimeout,originalClearTimeout=globalThis.clearTimeout;let startTimeout;
  try{
   globalThis.setTimeout=(callback,delay)=>{assert.equal(delay,5000);startTimeout=callback;return {unref(){}}};
   globalThis.clearTimeout=()=>{};
   speech.unlock();for(let i=0;i<30;i++)speech.say('观众'+i,'gift');
   assert.equal(e.spoken.length,1);assert.equal(speech.queue.length,12);
   startTimeout();assert.equal(speech.state,'error');assert.equal(speech.lastError,'start-timeout');assert.equal(speech.unlocked,false);assert.equal(speech.queue.length,0);
   e.spoken[0].onstart();e.spoken[0].onend();assert.equal(speech.state,'error');assert.equal(speech.speaking,false);
  }finally{speech.stop();globalThis.setTimeout=originalSetTimeout;globalThis.clearTimeout=originalClearTimeout}
 });

 test(label+': ordinary demo reset cancels stale speech while keeping existing activation for the next print',t=>{
  const e=environment(t,{voices:[voiceFor(language)]}),speech=new Speech();t.after(()=>speech.stop());
  speech.unlock();speech.say('重置之前','gift');const beforeReset=e.spoken[0];speech.welcome('原排队');
  speech.cancel({lock:false});assert.equal(speech.enabled,true);assert.equal(speech.unlocked,true);assert.equal(speech.ready,true);assert.equal(speech.queue.length,0);
  beforeReset.onstart();beforeReset.onend();beforeReset.onerror({error:'not-allowed'});assert.equal(speech.state,'ready');
  speech.printing('重置后观众');assert.equal(e.spoken.length,2);assert.ok(e.spoken[1].text.includes('重置后观众'));
 });

 test(label+': cancelling a preview restores only prior normal activation and never unmutes a stopped controller',t=>{
  const e=environment(t,{voices:[voiceFor(language)]}),speech=new Speech();t.after(()=>speech.stop());
  speech.preview('尚未开声的试听');const first=e.spoken[0];speech.cancel({lock:false});first.onend();
  assert.equal(speech.unlocked,false);assert.equal(speech.state,'locked');speech.say('不能私自恢复','gift');assert.equal(e.spoken.length,1);
  speech.unlock();speech.preview('已经开声的试听');speech.cancel({lock:false});assert.equal(speech.ready,true);assert.equal(speech.previewing,false);
  speech.enabled=false;speech.preview('静音下试听');const last=e.spoken.at(-1);speech.cancel({lock:false});last.onend();
  assert.equal(speech.enabled,false);assert.equal(speech.unlocked,false);assert.equal(speech.state,'disabled');
  speech.enabled=true;speech.unlock();speech.stop();speech.cancel({lock:false});assert.equal(speech.unlocked,false);assert.equal(speech.ready,false);
 });

 test(label+': reaffirming an existing muted gate cannot cancel a newer explicit preview',t=>{
  const e=environment(t,{voices:[voiceFor(language)]}),speech=new Speech();t.after(()=>speech.stop());
  speech.enabled=false;speech.preview('独立试听');const utterance=e.spoken[0];
  speech.enabled=false;assert.equal(speech.previewing,true);assert.equal(speech.state,'starting');assert.equal(speech.enabled,false);
  utterance.onstart();assert.equal(speech.state,'speaking');
  speech.stop();utterance.onend();assert.equal(speech.previewing,false);assert.equal(speech.state,'disabled');
 });
}
