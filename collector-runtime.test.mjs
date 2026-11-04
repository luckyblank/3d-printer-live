import test from 'node:test';
import assert from 'node:assert/strict';
import protobuf from 'protobufjs';
import {createCollectorRuntime} from './collector-runtime.mjs';
import {startWSServer} from './bridge-ws.mjs';
import WebSocket from 'ws';

const root=protobuf.parse(`syntax="proto3";message Image{repeated string urlList=1;}message User{uint64 id=1;string nickName=3;Image avatarThumb=9;}message Chat{User user=2;string content=3;}message Like{uint64 count=2;User user=5;}message Gift{string name=16;}message GiftMessage{uint64 giftId=2;uint64 repeatCount=5;User user=7;uint64 repeatEnd=9;uint64 groupId=11;Gift gift=15;}`).root;
const actor={id:123,nickName:'真实观众',avatarThumb:{urlList:['https://p3.douyinpic.com/aweme-avatar/test.png']}};
function packet(type,body,msgId){const p=root.lookupType(type);return{method:'Webcast'+(type==='GiftMessage'?'Gift':type)+'Message',payload:p.encode(p.fromObject(body)).finish(),msgId:String(msgId)}}
function fixture({pending=false}={}){
 const messages=[],sessions=[];let time=0;
 const runtime=createCollectorRuntime({cookie:'sessionid=synthetic-only',now:()=>time,broadcast:e=>messages.push(e),mapGift:name=>name==='啤酒'?'beer':'other',createSession:(room,opts)=>{
  let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});const s={room,opts,resolve,reject,stopped:0,start(){if(!pending){opts.onState({status:'connected'});resolve();}return promise;},stop(){this.stopped++;opts.onState({status:'stopped'});},stats:()=>({framesReceived:2})};sessions.push(s);return s;
 }});
 return{runtime,messages,sessions,at:value=>time=value};
}
test('direct runtime normalizes comments, avatar and incremental gift events into existing print messages',async()=>{
 const f=fixture();await f.runtime.setRoom('12345');const session=f.sessions[0];
 session.opts.onMessage(packet('Chat',{user:actor,content:'666'},1));
 for(const [count,id,end]of [[1,2,0],[3,3,0],[3,4,1]])session.opts.onMessage(packet('GiftMessage',{user:actor,giftId:9,groupId:8,repeatCount:count,repeatEnd:end,gift:{name:'啤酒'}},id));
 const prints=f.messages.filter(m=>['comment','gift'].includes(m.type));assert.deepEqual(prints.map(m=>m.type),['comment','gift','gift']);assert.deepEqual(prints.filter(m=>m.type==='gift').map(m=>m.count),[1,2]);assert.equal(prints[1].gift,'beer');assert.equal(prints[0].avatar,actor.avatarThumb.urlList[0]);
 assert.equal(session.opts.cookie,'sessionid=synthetic-only');assert.equal(f.runtime.ping().stats.gift,3);assert.equal(JSON.stringify(f.runtime.status()).includes('synthetic-only'),false);f.runtime.stop();
});
test('late events and open results from the previous room cannot contaminate a new room',async()=>{
 const f=fixture({pending:true}),first=f.runtime.setRoom('11111'),old=f.sessions[0],second=f.runtime.setRoom('22222'),active=f.sessions[1];
 old.opts.onState({status:'connected'});old.opts.onMessage(packet('Chat',{user:actor,content:'old'},1));old.resolve();active.opts.onState({status:'connected'});active.resolve();
 assert.equal(await first,false);assert.equal(await second,true);assert.equal(f.runtime.status().room,'22222');assert.equal(f.messages.some(m=>m.text==='old'),false);f.runtime.stop();
});
test('initial auth failures remain errors rather than being overwritten by transport stop',async()=>{
 const f=fixture({pending:true}),start=f.runtime.setRoom('12345'),s=f.sessions[0];s.opts.onState({status:'error',code:'AUTH_REQUIRED'});s.reject(Object.assign(new Error('not logged'),{code:'AUTH_REQUIRED'}));
 assert.equal(await start,false);assert.equal(f.runtime.status().status,'error');assert.equal(f.runtime.status().code,'AUTH_REQUIRED');assert.match(f.runtime.status().message,/重新登录/);f.runtime.stop();
});
test('stop wins against late startup callbacks, remains idempotent, and clears bounded state',async()=>{
 const f=fixture({pending:true}),start=f.runtime.setRoom('12345'),s=f.sessions[0];f.runtime.stop();f.runtime.stop();s.opts.onState({status:'connected'});s.opts.onMessage(packet('Chat',{user:actor,content:'late'},1));s.resolve();
 assert.equal(await start,false);assert.equal(f.runtime.status().status,'stopped');assert.equal(f.messages.some(m=>m.text==='late'),false);assert.equal(f.runtime.stats().people,0);
});
test('like throttling uses the real reported count and never invents extra likes',async()=>{
 const f=fixture();await f.runtime.setRoom('12345');const s=f.sessions[0];s.opts.onMessage(packet('Like',{user:actor,count:1},1));s.opts.onMessage(packet('Like',{user:actor,count:50},2));
 assert.deepEqual(f.messages.filter(m=>m.type==='like').map(m=>m.count),[1,3]);f.runtime.stop();
});
test('real local WebSocket clients receive collector state on connection and health exposes only metadata',async()=>{
 let port;const listening=new Promise(resolve=>port=resolve);const hub=startWSServer(0,{identity:'test-app',health:()=>({collector:'lightweight',pid:123,collectorStatus:'connected'}),onStatus:p=>port(p),onClient:(_client,send)=>{send({type:'hello',room:'12345'});send({type:'collector-status',status:'connected',collector:'lightweight'})}});
 const actual=await listening,ws=new WebSocket('ws://127.0.0.1:'+actual),messages=[];
 try{
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('local WS timeout')),2000);ws.on('message',data=>{messages.push(JSON.parse(String(data)));if(messages.length===2){clearTimeout(timeout);resolve();}});ws.on('error',reject);});
  assert.deepEqual(messages.map(m=>m.type),['hello','collector-status']);
  const health=await(await fetch('http://127.0.0.1:'+actual+'/health')).json();assert.equal(health.collector,'lightweight');assert.equal(health.pid,123);assert.equal(health.identity,'test-app');assert.equal(JSON.stringify(health).includes('cookie'),false);
 }finally{ws.terminate();hub.close();}
});
