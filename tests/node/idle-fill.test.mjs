import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createCollectorControls} from '../../workspace-ui.mjs';

function realFunction(source,name){
 const start=source.indexOf('function '+name+'('),body=source.indexOf('{',start);
 assert.ok(start>=0&&body>start,'Real '+name+' function must exist');
 let depth=0;
 for(let i=body;i<source.length;i++){
  if(source[i]==='{')depth++;
  if(source[i]==='}'&&--depth===0)return source.slice(start,i+1);
 }
 assert.fail('Unclosed '+name+' function');
}

for(const file of ['index.html','index-en.html']){
 const source=fs.readFileSync(new URL('../../'+file,import.meta.url),'utf8'),en=file==='index-en.html';
 test(`${file}: public audience messages reset idle time and filling is checked once per second`,()=>{
  assert.ok(source.includes("if(type==='comment'||type==='like'||type==='gift'||type==='follow'||type==='join')lastLiveMsgAt=Date.now()"));
  assert.ok(source.includes('setInterval(idleTestFill,1000);'));
 });
 test(`${file}: only confirmed collector connection resets idle time, not local socket open`,()=>{
  let now=1000000;
  const context={Date:{now:()=>now},liveRoom:'',liveMode:false,liveEverConnected:false,lastLiveMsgAt:100,queue:[],autoDemo:true,window:{},$:()=>null,renderQueue(){},updateScreen(){},replenishDemo(){}};
  const doc={hidden:false,addEventListener(){},removeEventListener(){}},win={addEventListener(){},removeEventListener(){}};
  const controls=createCollectorControls({document:doc,window:win,storage:null,onActive:on=>context.setCollectorLiveMode(on)});
  context.collectorControls=controls;context.candidate={};context.socket=context.candidate;context.bridgeDisposed=false;
  const assignment=source.match(/candidate\.onopen=(\(\)=>\{[^\n]+\});/);
  assert.ok(assignment,'Real local socket onopen handler must exist');
  assert.match(source,/onActive:setCollectorLiveMode/);
  vm.runInNewContext(realFunction(source,'setLiveStatus')+'\n'+realFunction(source,'setCollectorLiveMode')+'\ncandidate.onopen='+assignment[1]+';candidate.onopen();',context);
  assert.equal(context.lastLiveMsgAt,100,'Service connection must not reset audience idle time');
  assert.equal(context.liveMode,false,'Local bridge alone must not stop demo mode');
  controls.receiveStatus({status:'connecting'});assert.equal(context.lastLiveMsgAt,100);
  controls.receiveStatus({status:'connected'});assert.equal(context.lastLiveMsgAt,now);assert.equal(context.liveMode,true);
  now+=10000;controls.receiveStatus({status:'connected'});assert.equal(context.lastLiveMsgAt,1000000,'Repeated status must not indefinitely postpone idle filling');
  controls.receiveStatus({status:'reconnecting'});assert.equal(context.lastLiveMsgAt,1000000);
  now+=10000;controls.receiveStatus({status:'connected'});assert.equal(context.lastLiveMsgAt,now,'A confirmed reconnection starts a fresh idle period');
  controls.destroy();
 });
 test(`${file}: 30-second threshold, reset, pause, queue capacity and empty avatar pool remain intact`,()=>{
  let now=1000000;
  const person={name:'Test viewer',avatar:'test'},queue=[],calls=[];
  const make=(paused=false,people=[person],queueArr=queue,enabled=true)=>{
   const context={printRules:{idleFill:enabled,idleSeconds:30},paused,demoPeople:people,queue:queueArr,lastLiveMsgAt:1000000,Date:{now:()=>now},liveEvent:(type,user,amount,label,sourceTag,markLive)=>calls.push({type,user,amount,sourceTag,markLive}),randomPerson:()=>person};
   vm.runInNewContext(realFunction(source,'idleTestFill'),context);return context.idleTestFill;
  };
  const fill=make();fill();assert.equal(calls.length,0);
  now+=29999;fill();assert.equal(calls.length,0,'One millisecond before the threshold must not fill');
  now+=1;fill();assert.equal(calls.length,1,'Exactly 30 seconds fills one test avatar');
  assert.equal(calls[0].type,'like');assert.equal(calls[0].sourceTag,en?'30s idle · test avatar':'30秒无互动·测试头像');assert.equal(calls[0].markLive,false);assert.equal(calls[0].user.name,person.name);
  fill();assert.equal(calls.length,1,'Filling immediately resets the idle clock');
  now+=29999;fill();assert.equal(calls.length,1);
  now+=1;fill();assert.equal(calls.length,2);
  now+=30000;make(false,[person],[{name:'a'},{name:'b'}])();assert.equal(calls.length,2,'Two queued jobs block filler');
  now+=30000;make(true)();assert.equal(calls.length,2,'Paused printing blocks filler');
  now+=30000;make(false,[])();assert.equal(calls.length,2,'Empty avatar pool blocks filler');
  now+=30000;make(false,[person],queue,false)();assert.equal(calls.length,2,'Disabled filler stays disabled');
 });
}
