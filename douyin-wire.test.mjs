import {test} from 'node:test';
import assert from 'node:assert/strict';
import protobuf from 'protobufjs';
import {gzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {decodeDouyinFrame,encodeHeartbeat,WIRE_LIMITS} from './douyin-wire.mjs';

const root=protobuf.parse(`syntax="proto3";
 message PushFrame {uint64 logId=2;string payloadType=7;bytes payload=8;}
 message Message {string method=1;bytes payload=2;int64 msgId=3;}
 message Response {repeated Message messages=1;string internalExt=5;bool needAck=9;}
`).root;
const Push=root.lookupType('PushFrame'),Response=root.lookupType('Response');
const packet=(messages,{gzip=true,needAck=false,logId='18446744073709551614',internalExt='确认'}={})=>Buffer.from(Push.encode({logId,payloadType:'msg',payload:(gzip?gzipSync:Buffer.from)(Response.encode({messages,needAck,internalExt}).finish())}).finish());

test('gzip transport preserves raw payloads and 64-bit IDs, then ACKs the exact original log ID',()=>{
 const bytes=packet([{method:'WebcastGiftMessage',msgId:'7900000000000000001',payload:Uint8Array.of(8,12)}],{needAck:true});
 const value=decodeDouyinFrame(bytes);assert.equal(value.messages.length,1);assert.equal(value.messages[0].method,'WebcastGiftMessage');assert.equal(value.messages[0].msgId,'7900000000000000001');assert.deepEqual(value.messages[0].payload,Uint8Array.of(8,12));
 const ack=Push.decode(value.ack);assert.equal(ack.logId.toString(),'18446744073709551614');assert.equal(ack.payloadType,'ack');assert.equal(Buffer.from(ack.payload).toString(),'确认');
 assert.equal(value.messages[0].payload.buffer.byteLength,2,'small messages do not retain the full inflated frame');
});

test('raw protobuf responses, heartbeats and missing IDs do not invent message identities',()=>{
 const result=decodeDouyinFrame(packet([{method:'WebcastChatMessage',payload:Uint8Array.of(1)},{method:'WebcastChatMessage',msgId:'0',payload:Uint8Array.of(2)}],{gzip:false}));
 assert.deepEqual(result.messages.map(m=>m.msgId),['','']);assert.equal(result.ack,null);
 assert.equal(Push.decode(encodeHeartbeat()).payloadType,'hb');assert.deepEqual(decodeDouyinFrame(encodeHeartbeat()),{messages:[],ack:null});
});

test('frame, decompression, message-count, message-size and ACK limits are enforced',()=>{
 assert.throws(()=>decodeDouyinFrame(Buffer.alloc(WIRE_LIMITS.frame+1)),{code:'FRAME_TOO_LARGE'});
 const bomb=Buffer.from(Push.encode({payloadType:'msg',payload:gzipSync(Buffer.alloc(WIRE_LIMITS.inflated+1))}).finish());assert.throws(()=>decodeDouyinFrame(bomb));
 assert.throws(()=>decodeDouyinFrame(packet(Array.from({length:WIRE_LIMITS.messages+1},()=>({method:'x',payload:new Uint8Array()})))),{code:'TOO_MANY_MESSAGES'});
 assert.throws(()=>decodeDouyinFrame(packet([{method:'x',payload:Buffer.alloc(WIRE_LIMITS.message+1)}])),{code:'MESSAGE_TOO_LARGE'});
 assert.throws(()=>decodeDouyinFrame(packet([],{needAck:true,internalExt:'x'.repeat(WIRE_LIMITS.ack+1)})),{code:'ACK_TOO_LARGE'});
});

test('malformed protobuf and oversized method names fail without returning partial messages',()=>{
 assert.throws(()=>decodeDouyinFrame(Uint8Array.of(66,255,255,255,255,127)));
 assert.throws(()=>decodeDouyinFrame(packet([{method:'x'.repeat(129),payload:new Uint8Array()}])),{code:'MESSAGE_TOO_LARGE'});
});

test('original signing assets and both upstream licenses retain their verified Git blob bytes',()=>{
 for(const [name,expected]of Object.entries({'sign.js':'eef7918321d0938b9851eaafe6c4d22e8ea4cdaf','a_bogus.js':'f5b901f2f1771ef3244a6c8fa0c9f28238a8231e','LICENSE':'e20b431bcb69267acc39eaf8fdb94c30f40e3223','DYHUB-LICENSE':'a33c802590ba5ed1b5aa01969f09ea7c0f802ba0','UPSTREAM-README.md':'236a56befd478c21ad73522382c8fdb9c82c0d4f'})){
  const bytes=readFileSync(new URL('./third_party/douyin-sign/'+name,import.meta.url));const digest=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');assert.equal(digest,expected,name);
 }
});
