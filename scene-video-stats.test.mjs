import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function block(file,marker){
 const html=fs.readFileSync(new URL(file,import.meta.url),'utf8');
 const code=html.match(new RegExp(`// ${marker}_START([\\s\\S]*?)// ${marker}_END`))?.[1];
 assert.ok(code,`${file} has its real inline statistics implementation`);
 assert.doesNotMatch(code,/setInterval|setTimeout|requestAnimationFrame/);
 return {html,code};
}
const report=(...rows)=>new Map(rows.map((row,index)=>[String(index),row]));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const assertScalars=message=>assert.ok(Object.values(message).every(value=>value===null||['string','number','boolean'].includes(typeof value)));

function viewerFixture(getStats=async()=>report()){
 let now=0;const messages=[];
 const video={videoWidth:1920,videoHeight:1080,currentTime:12,paused:false,readyState:4,total:30,dropped:10,getVideoPlaybackQuality(){return {totalVideoFrames:this.total,droppedVideoFrames:this.dropped}}};
 const context=vm.createContext({performance:{now:()=>now},v:video,document:{visibilityState:'visible',hidden:false},connected:true,pc:{connectionState:'connected',getStats},bc:{postMessage:message=>messages.push({...message})}});
 const {html,code}=block('./live-view.html','SCENE_VIEWER_STATS');vm.runInContext(code,context);
 assert.match(html,/setInterval\(publishViewerStats,2000\)/);
 return {context,video,messages,setNow:value=>{now=value},publish:()=>context.publishViewerStats()};
}

test('viewer reports raw quality and video-only inbound counters even when presented FPS is zero',async()=>{
 let decoded=100;
 const f=viewerFixture(async()=>report(
  {type:'inbound-rtp',kind:'video',framesDecoded:decoded,framesReceived:120,bytesReceived:1000},
  {type:'inbound-rtp',mediaType:'video',framesDecoded:5,framesReceived:6,bytesReceived:100},
  {type:'inbound-rtp',kind:'audio',framesDecoded:9000,bytesReceived:9000},
  {type:'inbound-rtp',kind:'video',isRemote:true,framesDecoded:8000},
  {type:'outbound-rtp',kind:'video',framesDecoded:7000},
  {type:'inbound-rtp',kind:'video',framesDecoded:-2,bytesReceived:NaN}
 ));
 f.setNow(2000);await f.publish();let m=f.messages[0];assertScalars(m);
 assert.equal(m.role,'viewer');assert.equal(m.fps,10);assert.equal(m.totalVideoFrames,30);assert.equal(m.droppedVideoFrames,10);
 assert.equal(m.framesDecoded,105);assert.equal(m.framesReceived,126);assert.equal(m.bytesReceived,1100);assert.equal(m.currentTime,12);assert.equal(m.paused,false);assert.equal(m.readyState,4);assert.equal(m.pcState,'connected');assert.equal(m.visibility,'visible');assert.equal(m.hidden,false);
 f.video.total=50;f.video.dropped=30;f.video.currentTime=14;decoded=120;f.setNow(4000);await f.publish();m=f.messages[1];
 assert.equal(m.fps,0);assert.equal(m.framesDecoded,125);assert.equal(m.totalVideoFrames,50);assert.equal(m.droppedVideoFrames,30);assert.equal(m.currentTime,14);
});

test('viewer avoids overlapping getStats and discards results from a replaced peer',async()=>{
 let resolve,calls=0;const f=viewerFixture(()=>{calls++;return new Promise(done=>{resolve=done})});
 f.setNow(2000);const first=f.publish();f.setNow(4000);assert.equal(await f.publish(),false);assert.equal(calls,1);
 f.context.pc={connectionState:'connected',getStats:async()=>report({type:'inbound-rtp',kind:'video',framesDecoded:3})};
 resolve(report({type:'inbound-rtp',kind:'video',framesDecoded:999}));assert.equal(await first,false);assert.equal(f.messages.length,0);
 assert.equal(await f.publish(),true);assert.equal(f.messages[0].framesDecoded,3);
 f.context.connected=false;assert.equal(await f.publish(),false);assert.equal(f.messages.length,1);
});

test('viewer stats failures still send scalar quality and distinguish unavailable counters from real zero',async()=>{
 const f=viewerFixture(async()=>{const error=Error('not exposed');error.name='OperationError';throw error});
 f.setNow(2000);await f.publish();let m=f.messages[0];assert.equal(m.statsError,'OperationError');assert.equal(m.framesDecoded,null);assert.equal(m.bytesReceived,null);assert.equal(m.totalVideoFrames,30);assertScalars(m);
 f.context.pc.getStats=async()=>report({type:'inbound-rtp',kind:'video',framesDecoded:0,framesReceived:0,bytesReceived:0});f.setNow(4000);await f.publish();m=f.messages[1];assert.equal(m.statsError,'');assert.equal(m.framesDecoded,0);assert.equal(m.bytesReceived,0);
 f.video.getVideoPlaybackQuality=undefined;f.setNow(5000);await f.publish();m=f.messages[2];assert.equal(m.statsError,'quality-unavailable');assert.equal(m.totalVideoFrames,null);assert.equal(m.framesDecoded,0);
 f.context.pc.getStats=undefined;f.setNow(6000);await f.publish();assert.equal(f.messages[3].statsError,'stats-unavailable');assert.equal(f.messages[3].framesDecoded,null);
});

function sourceFixture(file,getStats=async()=>report()){
 let now=0;const messages=[],label={textContent:'untouched'};
 const context=vm.createContext({performance:{now:()=>now},document:{visibilityState:'visible',hidden:false,getElementById:id=>id==='output-fps'?label:null},viewPC:{connectionState:'connected',getStats},sceneChan:{postMessage:message=>messages.push({...message})},renderFps:8,targetFps:30});
 const {html,code}=block(file,'SCENE_SOURCE_STATS');vm.runInContext(code,context);
 assert.match(html,/m\.type==='view-stats'\)\{handleViewStats\(m\)\}/);
 return {context,messages,label,setNow:value=>{now=value},publish:()=>context.publishSourceStats(),handle:message=>context.handleViewStats(message)};
}

for(const file of ['./index.html','./index-en.html']){
 test(`source replies at most every two seconds, filters audio, and never renders source diagnostics as viewer FPS (${file})`,async()=>{
  const f=sourceFixture(file,async()=>report(
   {type:'outbound-rtp',kind:'video',framesEncoded:12,framesSent:11,bytesSent:1200},
   {type:'outbound-rtp',mediaType:'video',framesEncoded:2,framesSent:1,bytesSent:100},
   {type:'outbound-rtp',kind:'audio',framesSent:9000,bytesSent:9000},
   {type:'remote-outbound-rtp',kind:'video',framesEncoded:8000}
  ));
  const viewer={role:'viewer',fps:0,width:1920,height:1080};assert.equal(f.handle(viewer),true);await tick();
  let m=f.messages[0];assertScalars(m);assert.equal(m.role,'source');assert.equal(m.renderFps,8);assert.equal(Object.hasOwn(m,'fps'),false);assert.equal(m.framesEncoded,14);assert.equal(m.framesSent,12);assert.equal(m.bytesSent,1300);assert.equal(m.hidden,false);assert.equal(m.pcState,'connected');
  assert.match(f.label.textContent,/0 FPS/);const saved=f.label.textContent;
  assert.equal(f.handle({role:'source',fps:999,width:1,height:1}),false);assert.equal(f.handle({role:'unexpected',fps:999}),false);await tick();assert.equal(f.label.textContent,saved);assert.equal(f.messages.length,1);
  f.setNow(1000);f.handle(viewer);await tick();assert.equal(f.messages.length,1);
  f.context.document.hidden=true;f.context.document.visibilityState='hidden';f.setNow(2000);f.handle(viewer);await tick();assert.equal(f.messages.length,2);assert.equal(f.messages[1].hidden,true);assert.equal(f.messages[1].visibility,'hidden');
  f.setNow(4000);assert.equal(f.handle({fps:3,width:1280,height:720}),true);await tick();assert.equal(f.messages.length,3);
 });

 test(`source diagnostics are non-overlapping, recover from failures and suppress stale peer results (${file})`,async()=>{
  let resolve,calls=0;const f=sourceFixture(file,()=>{calls++;return new Promise(done=>{resolve=done})});
  const pending=f.publish();f.setNow(5000);assert.equal(await f.publish(),false);assert.equal(calls,1);
  resolve(report({type:'outbound-rtp',kind:'video',framesEncoded:5}));assert.equal(await pending,true);assert.equal(f.messages.length,1);
  f.context.viewPC.getStats=async()=>{const error=Error();error.name='InvalidStateError';throw error};f.setNow(6000);await f.publish();assert.equal(f.messages[1].statsError,'InvalidStateError');assert.equal(f.messages[1].framesEncoded,null);
  f.context.viewPC.getStats=()=>new Promise(done=>{resolve=done});f.setNow(8000);const stale=f.publish();f.context.viewPC={connectionState:'connected',getStats:async()=>report({type:'outbound-rtp',kind:'video',framesEncoded:0})};resolve(report({type:'outbound-rtp',kind:'video',framesEncoded:999}));assert.equal(await stale,false);assert.equal(f.messages.length,2);
  f.setNow(10000);await f.publish();assert.equal(f.messages[2].framesEncoded,0);assert.equal(f.messages[2].statsError,'');
 });
}
