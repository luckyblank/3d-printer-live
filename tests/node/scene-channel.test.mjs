import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SceneChannel} from '../../scene-channel.mjs';

function replaceGlobal(t,name,value){
 const previous=globalThis[name];globalThis[name]=value;
 t.after(()=>{globalThis[name]=previous});
}

function sender({available=true}={}){
 const broadcasts=[];
 const channel={id:'main-profile',available,pending:[],native:{postMessage:message=>broadcasts.push(message)}};
 channel.postMessage=SceneChannel.prototype.postMessage;
 return {channel,broadcasts};
}

test('light and dark theme changes use local HTTP rather than profile-local BroadcastChannel',t=>{
 const requests=[];
 replaceGlobal(t,'fetch',async(url,options)=>{requests.push({url,options,body:JSON.parse(options.body)});return {ok:true}});
 const {channel,broadcasts}=sender();
 for(const theme of ['light','dark'])channel.postMessage({type:'workspace-theme',theme});
 assert.equal(broadcasts.length,0);assert.equal(requests.length,2);
 assert.ok(requests.every(request=>request.url==='/__scene-message'&&request.options.method==='POST'));
 assert.deepEqual(requests.map(request=>request.body),[
  {client:'main-profile',message:{type:'workspace-theme',theme:'light'}},
  {client:'main-profile',message:{type:'workspace-theme',theme:'dark'}},
 ]);
});

test('invalid workspace theme values are rejected without network, queue or broadcast side effects',t=>{
 let requests=0;replaceGlobal(t,'fetch',async()=>{requests++;return {ok:true}});
 for(const available of [false,true]){
  const {channel,broadcasts}=sender({available});
  for(const theme of [undefined,null,'auto','LIGHT','',{},[],true,0])channel.postMessage({type:'workspace-theme',theme});
  assert.equal(channel.pending.length,0);assert.equal(broadcasts.length,0);
 }
 assert.equal(requests,0);
});

test('queued themes cross profiles after the relay becomes available and share the existing pending bound',async t=>{
 const {channel,broadcasts}=sender({available:false});
 for(let i=0;i<68;i++)channel.postMessage({type:'view-ping',index:i});
 channel.postMessage({type:'workspace-theme',theme:'light'});
 assert.equal(channel.pending.length,64);assert.equal(channel.pending[0].index,5);
 const requests=[];channel.closed=false;channel.cursor=null;
 replaceGlobal(t,'fetch',async(url,options)=>{
  if(options?.method==='POST'){requests.push(JSON.parse(options.body));return {ok:true}}
  return {ok:true,json:async()=>{channel.closed=true;return {cursor:10,messages:[]}}};
 });
 await SceneChannel.prototype.poll.call(channel);
 assert.equal(channel.available,true);assert.equal(channel.pending.length,0);assert.equal(requests.length,64);
 assert.deepEqual(requests.at(-1),{client:'main-profile',message:{type:'workspace-theme',theme:'light'}});
 assert.equal(broadcasts.length,0);
});

test('HTTP receiver filters invalid themes while preserving video signalling messages',async t=>{
 const received=[];
 const receiver={id:'scene-profile',cursor:0,pending:[],closed:false,onmessage:event=>received.push(event.data)};
 replaceGlobal(t,'fetch',async()=>({ok:true,json:async()=>{
  receiver.closed=true;
  return {cursor:8,messages:[
   {type:'workspace-theme',theme:'light'},
   {type:'workspace-theme',theme:'invalid'},
   {type:'workspace-theme'},
   {type:'view-offer',sdp:{type:'offer',sdp:'test'}},
   {type:'workspace-theme',theme:'dark'},
  ]};
 }}));
 await SceneChannel.prototype.poll.call(receiver);
 assert.deepEqual(received,[
  {type:'workspace-theme',theme:'light'},
  {type:'view-offer',sdp:{type:'offer',sdp:'test'}},
  {type:'workspace-theme',theme:'dark'},
 ]);
});

test('BroadcastChannel receiver also rejects invalid themes without changing ordinary local events',t=>{
 const originalPoll=SceneChannel.prototype.poll;SceneChannel.prototype.poll=()=>{};
 t.after(()=>{SceneChannel.prototype.poll=originalPoll});
 replaceGlobal(t,'BroadcastChannel',class{close(){this.closed=true}});
 const channel=new SceneChannel(),received=[];channel.onmessage=event=>received.push(event.data);
 t.after(()=>channel.close());
 channel.native.onmessage({data:{type:'workspace-theme',theme:'auto'}});
 channel.native.onmessage({data:{type:'workspace-theme',theme:'dark'}});
 channel.native.onmessage({data:{type:'who',sid:'local-peer'}});
 assert.deepEqual(received,[{type:'workspace-theme',theme:'dark'},{type:'who',sid:'local-peer'}]);
});

test('existing view messages retain HTTP and unload handling while other workspace types stay local',t=>{
 const requests=[];replaceGlobal(t,'fetch',async(url,options)=>{requests.push({url,options,body:JSON.parse(options.body)});return {ok:true}});
 const {channel,broadcasts}=sender();
 channel.postMessage({type:'view-offer',sdp:{type:'offer',sdp:'test'}});
 channel.postMessage({type:'view-bye'});
 channel.postMessage({type:'who',sid:'same-profile'});
 channel.postMessage({type:'workspace-theme-update',theme:'light'});
 assert.equal(requests.length,2);assert.equal(requests[0].options.keepalive,false);assert.equal(requests[1].options.keepalive,true);
 assert.deepEqual(requests.map(request=>request.body.message.type),['view-offer','view-bye']);
 assert.deepEqual(broadcasts,[{type:'who',sid:'same-profile'},{type:'workspace-theme-update',theme:'light'}]);
});

test('offline avatar snapshots retain only the newest state and keep the original total queue bound',()=>{
 const {channel}=sender({available:false});const pending=channel.pending;let latest;
 for(let i=0;i<64;i++){
  latest={type:'view-overlay-state',snapshot:{printed:i,current:{avatar:'a'.repeat(16000)+i}}};
  channel.postMessage(latest);
 }
 assert.equal(channel.pending,pending);assert.equal(pending.length,1);assert.equal(pending[0],latest);
 for(let i=0;i<63;i++)channel.postMessage({type:'view-ice',candidate:{candidate:String(i)}});
 latest={type:'view-overlay-state',snapshot:{printed:64}};channel.postMessage(latest);
 assert.equal(channel.pending.length,64);
 assert.deepEqual(channel.pending.slice(0,-1).map(message=>message.candidate.candidate),Array.from({length:63},(_,i)=>String(i)));
 assert.equal(channel.pending.at(-1),latest);
 channel.postMessage({type:'view-answer',sdp:'last'});
 assert.equal(channel.pending.length,64);assert.equal(channel.pending[0].candidate.candidate,'1');
 assert.equal(channel.pending.at(-1).type,'view-answer');
});

test('relay recovery sends one newest snapshot without discarding or reordering signalling and themes',async t=>{
 const {channel,broadcasts}=sender({available:false});
 const offer={type:'view-offer',sdp:{type:'offer',sdp:'keep'}};
 const ice={type:'view-ice',candidate:{candidate:'keep'}};
 const theme={type:'workspace-theme',theme:'light'};
 const answer={type:'view-answer',sdp:{type:'answer',sdp:'keep'}};
 channel.postMessage(offer);channel.postMessage({type:'view-overlay-state',snapshot:{printed:0}});
 channel.postMessage(ice);channel.postMessage(theme);
 let latest;for(let i=1;i<=64;i++){latest={type:'view-overlay-state',snapshot:{printed:i}};channel.postMessage(latest)}
 channel.postMessage(answer);
 assert.deepEqual(channel.pending,[offer,ice,theme,latest,answer]);
 channel.closed=false;channel.cursor=null;const sent=[];
 replaceGlobal(t,'fetch',async(url,options)=>{
  if(options?.method==='POST'){sent.push(JSON.parse(options.body).message);return {ok:true}}
  return {ok:true,json:async()=>{channel.closed=true;return {cursor:99,messages:[]}}};
 });
 await SceneChannel.prototype.poll.call(channel);
 assert.deepEqual(sent,[offer,ice,theme,latest,answer]);
 assert.equal(sent.filter(message=>message.type==='view-overlay-state').length,1);
 assert.equal(channel.pending.length,0);assert.equal(broadcasts.length,0);
});
