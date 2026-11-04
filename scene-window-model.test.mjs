import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SCENE_SETTINGS,normalizeSceneSettings,normalizeSceneSnapshot,normalizeSceneAvatar} from './scene-window-model.mjs';

test('scene preferences keep explicit false values and discard unknown settings',()=>{
 assert.deepEqual(normalizeSceneSettings({onTop:false,showGiftRules:false,showQueue:true,extra:true}),{...DEFAULT_SCENE_SETTINGS,onTop:false,showGiftRules:false,showQueue:true});
 assert.deepEqual(normalizeSceneSettings({onTop:'false',showQueue:1}),DEFAULT_SCENE_SETTINGS);
 assert.equal(Object.isFrozen(DEFAULT_SCENE_SETTINGS),true);
});
test('rule layout upgrades old saved preferences and bounds each percentage independently',()=>{
 const legacy={onTop:false,showQueue:true,showGiftRules:true,showCurrent:false,showStats:false};
 assert.deepEqual(normalizeSceneSettings(legacy),{...DEFAULT_SCENE_SETTINGS,...legacy});
 assert.deepEqual(normalizeSceneSettings({rulesX:-5,rulesY:120,rulesOpacity:0}),{...DEFAULT_SCENE_SETTINGS,rulesX:0,rulesY:100,rulesOpacity:0});
 assert.equal(normalizeSceneSettings({rulesOpacity:100}).rulesOpacity,100);
 assert.equal(normalizeSceneSettings({rulesX:25.8,rulesY:true,rulesOpacity:NaN}).rulesX,26);
 assert.equal(normalizeSceneSettings({rulesY:true,rulesOpacity:NaN}).rulesY,100);
 assert.equal(normalizeSceneSettings({rulesOpacity:NaN}).rulesOpacity,90);
});

test('all four panel styles upgrade independently, bound scale, and retain previous rule choices',()=>{
 const older={onTop:false,showQueue:true,showGiftRules:true,showCurrent:false,showStats:false,rulesX:17,rulesY:83,rulesOpacity:0};
 assert.deepEqual(normalizeSceneSettings(older),{...DEFAULT_SCENE_SETTINGS,...older});
 assert.equal(Object.keys(DEFAULT_SCENE_SETTINGS).length,21);
 for(const prefix of ['rules','queue','current','stats']){
  for(const [suffix,input,expected]of [['X',-9,0],['Y',109,100],['Opacity',0,0],['Opacity',100,100],['Scale',0,60],['Scale',200,160],['Scale',125.6,126]]){
   const key=prefix+suffix;
   assert.deepEqual(normalizeSceneSettings({...older,[key]:input}),{...DEFAULT_SCENE_SETTINGS,...older,[key]:expected});
  }
  const key=prefix+'Scale';
  for(const bad of [null,true,'125',NaN,Infinity])assert.equal(normalizeSceneSettings({[key]:bad})[key],100);
  assert.equal(normalizeSceneSettings({[key]:NaN},{...DEFAULT_SCENE_SETTINGS,[key]:135})[key],135);
 }
});
test('avatar display permits only bounded image data and public HTTP or local asset paths',()=>{
 for(const value of ['javascript:alert(1)','data:text/html;base64,AAAA','data:image/svg+xml;base64,AAAA','https://user:password@example.com/a.png','./assets/../secret','data:image/png;base64,'+'A'.repeat(65536)])assert.equal(normalizeSceneAvatar(value),'');
 for(const value of ['data:image/webp;base64,AAAA','https://example.com/avatar.png','./assets/generated/original-icons/heart.png'])assert.equal(normalizeSceneAvatar(value),value);
});
test('overlay snapshots bound queue, text and counters while preserving current rules',()=>{
 const snapshot=normalizeSceneSnapshot({lang:'en',printed:5,waiting:12,likes:Infinity,gifts:1e12,current:{name:'a'.repeat(100),avatar:'javascript:x',progress:120,score:90,status:'printing',paused:true},queue:Array.from({length:10},()=>({name:'viewer',size:'large',priority:true})),rules:{commentEnabled:true,commentCount:5,commentSize:'large',giftEnabled:false,giftSize:'small',heartCount:10,beerCount:3,lollipopCount:2,otherCount:5}});
 assert.equal(snapshot.queue.length,5);assert.equal(snapshot.current.name.length,80);assert.equal(snapshot.current.progress,100);assert.equal(snapshot.current.avatar,'');
 assert.equal(snapshot.likes,0);assert.equal(snapshot.gifts,1e9);assert.equal(snapshot.waiting,12);
 assert.deepEqual(snapshot.rules,{commentEnabled:true,commentCount:5,commentSize:'large',joinEnabled:false,joinCount:1,joinSize:'small',likeEnabled:false,likeCount:1,likeSize:'small',followEnabled:false,followCount:1,followSize:'small',giftEnabled:false,giftSize:'small',heartCount:10,beerCount:3,lollipopCount:2,otherCount:5});
 assert.doesNotThrow(()=>JSON.stringify(normalizeSceneSnapshot(null)));
});

test('all interaction rules preserve independent enabled flags, quantities and portrait sizes',()=>{
 const input={};
 for(const [index,prefix]of ['comment','join','like','follow'].entries()){
  input[prefix+'Enabled']=index%2===0;
  input[prefix+'Count']=index+1;
  input[prefix+'Size']=index%2===0?'large':'small';
 }
 const result=normalizeSceneSnapshot({rules:input}).rules;
 for(const key of Object.keys(input))assert.equal(result[key],input[key]);
 const bounded=normalizeSceneSnapshot({rules:{joinEnabled:'true',joinCount:200,likeCount:-5,followSize:'invalid'}}).rules;
 assert.equal(bounded.joinEnabled,false);assert.equal(bounded.joinCount,10);assert.equal(bounded.likeCount,1);assert.equal(bounded.followSize,'small');
});
test('long emoji names stay valid Unicode for the cross-profile UTF-8 relay',()=>{
 const snapshot=normalizeSceneSnapshot({current:{name:'🌟'.repeat(100)+'\ud800',status:'printing'}});
 assert.equal(Array.from(snapshot.current.name).length,80);
 assert.equal(snapshot.current.name,'🌟'.repeat(80));
 assert.equal(normalizeSceneSnapshot({current:{name:'name\ud800'}}).current.name,'name');
});
