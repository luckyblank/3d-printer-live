import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import protobuf from 'protobufjs';
import {gzipSync} from 'node:zlib';
import {LightweightSession,parseLightweightRoom,signWebcastParams} from './lightweight-session.mjs';

const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve()};
class Clock{
 constructor(){this.time=0;this.id=0;this.tasks=new Map()}
 setTimeout(fn,delay){const id=++this.id;this.tasks.set(id,{fn,at:this.time+delay});return id}
 clearTimeout(id){this.tasks.delete(id)}
 async advance(ms){const target=this.time+ms;let n=0;while(true){await flush();const next=[...this.tasks].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;if(++n>200)throw Error('Timer loop');this.time=next[1].at;this.tasks.delete(next[0]);next[1].fn();}this.time=target;await flush()}
 nextDelay(){return Math.min(...[...this.tasks.values()].map(t=>t.at-this.time))}
}
class FakeSocket extends EventEmitter{
 static instances=[];
 constructor(url,options){super();this.url=url;this.options=options;this.readyState=0;this.sent=[];FakeSocket.instances.push(this)}
 open(){this.readyState=1;this.emit('open')}
 send(bytes){if(this.readyState!==1)throw Error('closed');this.sent.push(Buffer.from(bytes))}
 terminate(){this.readyState=3;this.emit('close',1006)}
 disconnect(){this.readyState=3;this.emit('close',1006)}
}
const html=(id='790000000000000001',status=2)=>JSON.stringify({roomStore:{roomInfo:{room:{title:'test',status,id_str:id},roomId:id}}});
const response=(body=html(),cookies=[],status=200)=>({ok:status===200,status,headers:{getSetCookie:()=>cookies,get:()=>null},text:async()=>body});
const schema=protobuf.parse(`syntax="proto3";message PushFrame{uint64 logId=2;string payloadType=7;bytes payload=8;}message Message{string method=1;bytes payload=2;int64 msgId=3;}message Response{repeated Message messages=1;string internalExt=5;bool needAck=9;}`).root;
const Push=schema.lookupType('PushFrame'),Response=schema.lookupType('Response');
const frame=(ids,needAck=true)=>Buffer.from(Push.encode({logId:'9000000000000000001',payloadType:'msg',payload:gzipSync(Response.encode({needAck,internalExt:'ack-token',messages:ids.map(id=>({method:'WebcastGiftMessage',...(id===null?{}:{msgId:String(id)}),payload:Uint8Array.of(8,1)}))}).finish())}).finish());

function fixture(options={}){
 FakeSocket.instances=[];const clock=new Clock(),states=[],received=[],requests=[];
 const session=new LightweightSession('123456789',{cookie:'ttwid=device; sessionid_ss=private-test-session',onState:state=>states.push(state),onMessage:message=>received.push(message),fetchImpl:async(url,options)=>{requests.push({url,options});return response()},WebSocketImpl:FakeSocket,timers:clock,now:()=>clock.time,random:()=>.5,...options});
 return {session,clock,states,received,requests};
}
async function connected(f){const pending=f.session.start();await flush();const ws=FakeSocket.instances.at(-1);assert.ok(ws,'socket created after room parsing');ws.open();await pending;return ws;}

test('unchanged local signing script runs offline with a fixed input and rejects oversized input safely',()=>{
 const value=signWebcastParams('live_id=1,aid=6383,room_id=123');assert.equal(typeof value,'string');assert.ok(value.length>0&&value.length<4096);
 assert.throws(()=>signWebcastParams('x'.repeat(8193)),{code:'SIGN_FAILED'});
 assert.ok(signWebcastParams('live_id=1,aid=6383,room_id=456').length>0,'a failed call does not poison the next local VM');
});

test('room parsing handles escaped HTML and reordered room fields without trusting unrelated recommendation status',()=>{
 assert.deepEqual(parseLightweightRoom(html()),{roomId:'790000000000000001',status:2});
 assert.deepEqual(parseLightweightRoom(html().replace(/"/g,'&quot;')),{roomId:'790000000000000001',status:2});
 assert.deepEqual(parseLightweightRoom(html().replace(/"/g,'\\"')),{roomId:'790000000000000001',status:2});
 assert.equal(parseLightweightRoom('{"recommendation":{"status":4},"roomId":"12345"}').status,null);
 assert.throws(()=>parseLightweightRoom('<html>please login</html>'),{code:'ROOM_PARSE_FAILED'});
});

test('start awaits the WSS open event, uses full cookies and remains idempotent while connected',async()=>{
 const f=fixture(),first=f.session.start(),second=f.session.start();assert.equal(first,second);await flush();const ws=FakeSocket.instances[0];assert.equal(f.states.at(-1).status,'connecting');
 assert.match(ws.options.headers.Cookie,/sessionid_ss=private-test-session/);assert.equal(new URL(ws.url).searchParams.get('room_id'),'790000000000000001');assert.ok(new URL(ws.url).searchParams.get('signature'));
 ws.open();await first;assert.equal(f.session.stats().connected,true);await f.session.start();assert.equal(FakeSocket.instances.length,1);
 assert.doesNotMatch(JSON.stringify([f.states,f.session.stats()]),/private-test-session|signature=|wss:\/\//);f.session.stop();f.session.stop();assert.equal(f.states.filter(s=>s.status==='stopped').length,1);assert.equal(f.clock.tasks.size,0);
});

test('missing ttwid bootstrap merges cookies and never discards or replaces supplied login credentials',async()=>{
 const requests=[];let index=0;
 const f=fixture({cookie:'sessionid_ss=keep-login; sid_tt=keep-backup',fetchImpl:async(url,options)=>{requests.push({url,options});index++;return response(index===3?html():'home',index===1?['__ac_nonce=nonce; Path=/','sessionid_ss=anonymous; Path=/']:index===2?['ttwid=fresh-device; Path=/']:[])}});
 const ws=await connected(f);assert.equal(requests.length,3);assert.match(requests[1].options.headers.Cookie,/sessionid_ss=keep-login/);assert.match(ws.options.headers.Cookie,/sessionid_ss=keep-login/);assert.match(ws.options.headers.Cookie,/sid_tt=keep-backup/);assert.match(ws.options.headers.Cookie,/ttwid=fresh-device/);assert.doesNotMatch(ws.options.headers.Cookie,/anonymous/);f.session.stop();
});

test('ACK precedes delivery and duplicate messages are bounded without coalescing distinct gift IDs',async()=>{
 const f=fixture({seenLimit:2}),ws=await connected(f);ws.emit('message',frame([1,2,3]),true);assert.equal(f.received.length,3);assert.equal(Push.decode(ws.sent[0]).payloadType,'ack');assert.equal(Push.decode(ws.sent[0]).logId.toString(),'9000000000000000001');
 ws.emit('message',frame([3,1]),true);assert.deepEqual(f.received.map(m=>m.msgId),['1','2','3','1']);assert.equal(f.session.stats().duplicates,1);assert.equal(f.session.stats().cacheSize,2);assert.equal(ws.sent.length,2);
 ws.emit('message',frame([null,null]),true);assert.equal(f.received.length,6,'messages without a real ID are not conflated');f.session.stop();
});

test('stop cancels an uncooperative HTTP request and all timers without a late error or reconnect',async()=>{
 let signal;const f=fixture({fetchImpl:(_url,options)=>{signal=options.signal;return new Promise(()=>{})}});
 const pending=f.session.start();await flush();f.session.stop();await assert.rejects(pending,{code:'STOPPED'});assert.equal(signal.aborted,true);assert.equal(f.clock.tasks.size,0);await f.clock.advance(100000);assert.equal(f.states.at(-1).status,'stopped');assert.equal(FakeSocket.instances.length,0);
});

test('HTTP and WSS opening have finite deadlines with sanitized error messages',async()=>{
 const f=fixture({requestTimeoutMs:10,fetchImpl:()=>new Promise(()=>{})});const pending=f.session.start();await flush();const rejected=assert.rejects(pending,{code:'HTTP_TIMEOUT'});await f.clock.advance(10);await rejected;assert.equal(f.clock.tasks.size,0);assert.equal(f.states.at(-1).code,'HTTP_TIMEOUT');f.session.stop();
 const g=fixture({connectTimeoutMs:10});const waiting=g.session.start();await flush();const failure=assert.rejects(waiting,{code:'WS_TIMEOUT'});await g.clock.advance(10);await failure;assert.equal(FakeSocket.instances[0].readyState,3);assert.equal(g.clock.tasks.size,0);g.session.stop();
});

test('offline rooms never create a WSS and HTTP errors do not leak server bodies or credentials',async()=>{
 const f=fixture({fetchImpl:async()=>response(html('12345',4))});await assert.rejects(f.session.start(),{code:'OFFLINE'});assert.equal(f.states.at(-1).status,'offline');assert.equal(FakeSocket.instances.length,0);f.session.stop();
 const g=fixture({fetchImpl:async()=>response('private-test-session signature=secret',[],403)});await assert.rejects(g.session.start(),{code:'AUTH_REQUIRED'});assert.doesNotMatch(JSON.stringify(g.states),/private-test-session|signature=/);g.session.stop();
});

test('disconnects back off exponentially, repeated errors do not create duplicate retries, and stop cancels them',async()=>{
 const f=fixture({reconnectBaseMs:10,reconnectMaxMs:20}),first=await connected(f);first.disconnect();assert.equal(f.clock.nextDelay(),10);assert.equal(f.states.at(-1).status,'reconnecting');
 first.emit('error',Error('private-test-session'));assert.equal(f.clock.tasks.size,1);await f.clock.advance(10);const second=FakeSocket.instances[1];assert.ok(second);second.emit('error',Error('signature=secret'));await flush();assert.equal(f.clock.nextDelay(),20);
 await f.clock.advance(20);const third=FakeSocket.instances[2];third.emit('error',Error());await flush();assert.equal(f.clock.nextDelay(),20);f.session.stop();await f.clock.advance(1000);assert.equal(FakeSocket.instances.length,3);assert.equal(f.clock.tasks.size,0);assert.doesNotMatch(JSON.stringify(f.states),/private-test-session|signature=/);
});

test('heartbeat uses protobuf and stale connections reconnect without keeping the old socket listeners alive',async()=>{
 const f=fixture({heartbeatMs:5,staleMs:12,reconnectBaseMs:100}),ws=await connected(f);await f.clock.advance(5);assert.equal(Push.decode(ws.sent[0]).payloadType,'hb');await f.clock.advance(10);assert.equal(f.states.at(-1).status,'reconnecting');assert.equal(ws.listenerCount('message'),0);assert.equal(ws.listenerCount('open'),0);assert.equal(ws.listenerCount('close'),0);f.session.stop();assert.equal(f.clock.tasks.size,0);
});

test('stopping during a WSS handshake rejects start promptly and no delayed open can resurrect it',async()=>{
 const f=fixture(),pending=f.session.start();await flush();const ws=FakeSocket.instances[0];f.session.stop();await assert.rejects(pending,{code:'STOPPED'});ws.open();assert.equal(f.session.stats().status,'stopped');assert.equal(f.clock.tasks.size,0);assert.equal(ws.listenerCount('message'),0);
});

test('an immediate stop/start uses a new generation rather than returning the canceled start promise',async()=>{
 const f=fixture();const old=f.session.start();await flush();f.session.stop();const rejected=assert.rejects(old,{code:'STOPPED'}),fresh=f.session.start();assert.notEqual(fresh,old);await flush();FakeSocket.instances.at(-1).open();await fresh;await rejected;assert.equal(f.session.stats().connected,true);f.session.stop();assert.equal(f.clock.tasks.size,0);
});

test('a state callback that synchronously stops cannot leave a heartbeat or reconnect timer behind',async()=>{
 let session;const f=fixture({onState:state=>{if(state.status==='connected')session.stop()}});session=f.session;
 const start=session.start();await flush();FakeSocket.instances[0].open();await assert.rejects(start,{code:'STOPPED'});assert.equal(f.clock.tasks.size,0);assert.equal(session.stats().status,'stopped');
 let other;const g=fixture({onState:state=>{if(state.status==='reconnecting')other.stop()}});other=g.session;const ws=await connected(g);ws.disconnect();assert.equal(g.clock.tasks.size,0);assert.equal(other.stats().status,'stopped');
});

test('one malformed frame and a throwing consumer do not stop valid subsequent delivery',async()=>{
 let delivered=0;const f=fixture({onMessage:()=>{delivered++;if(delivered===1)throw Error('consumer private data')}}),ws=await connected(f);
 ws.emit('message',Buffer.from([255]),true);ws.emit('message',frame([1,2]),true);assert.equal(delivered,2);assert.equal(f.session.stats().callbackErrors,1);assert.equal(f.session.stats().invalidFrames,1);assert.equal(f.session.stats().connected,true);f.session.stop();
});
