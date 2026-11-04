// MIT: adapted from DyHub 21251a1150b7320abaac7ab8222cfa6856abcee2.
// Original notice: third_party/douyin-sign/DYHUB-LICENSE. Business payloads are
// deliberately opaque; the existing bridge remains responsible for them.
import protobuf from 'protobufjs';
import {gunzipSync} from 'node:zlib';

export const WIRE_LIMITS=Object.freeze({frame:4*1024*1024,inflated:16*1024*1024,message:2*1024*1024,messages:1024,ack:8192});
const root=protobuf.parse(`syntax="proto3";
 message PushFrame {uint64 logId=2;string payloadType=7;bytes payload=8;}
 message Message {string method=1;bytes payload=2;int64 msgId=3;int32 msgType=4;}
`).root;
const PushFrame=root.lookupType('PushFrame'),Message=root.lookupType('Message');
const invalid=code=>Object.assign(new Error(code),{code});

export function encodeHeartbeat(){return Buffer.from(PushFrame.encode({payloadType:'hb'}).finish());}
export function decodeDouyinFrame(input){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
 if(bytes.byteLength>WIRE_LIMITS.frame)throw invalid('FRAME_TOO_LARGE');
 const frame=PushFrame.decode(bytes),raw=frame.payload;
 if(!raw?.length||frame.payloadType==='hb'||frame.payloadType==='ack')return {messages:[],ack:null};
 const payload=raw[0]===0x1f&&raw[1]===0x8b?gunzipSync(raw,{maxOutputLength:WIRE_LIMITS.inflated}):raw;
 if(payload.length>WIRE_LIMITS.inflated)throw invalid('PAYLOAD_TOO_LARGE');
 // Read repeated messages incrementally. A frame cannot allocate an unbounded
 // list of empty protobuf messages before our message-count guard runs.
 const reader=protobuf.Reader.create(payload),messages=[];let needAck=false,internalExt='',fields=0;
 while(reader.pos<reader.len){
  if(++fields>WIRE_LIMITS.messages*4)throw invalid('TOO_MANY_FIELDS');
  const tag=reader.uint32(),field=tag>>>3,wire=tag&7;
  if(field===1&&wire===2){
   if(messages.length>=WIRE_LIMITS.messages)throw invalid('TOO_MANY_MESSAGES');
   const length=reader.uint32();if(length>WIRE_LIMITS.message||reader.pos+length>reader.len)throw invalid('MESSAGE_TOO_LARGE');
   const item=Message.decode(reader,length);
   if(item.method?.length>128||item.payload?.length>WIRE_LIMITS.message)throw invalid('MESSAGE_TOO_LARGE');
   const id=Object.hasOwn(item,'msgId')?item.msgId.toString():'';
   messages.push({method:item.method||'',payload:Uint8Array.from(item.payload||[]),msgId:id==='0'?'':id});
  }else if(field===5&&wire===2){
   const value=reader.bytes();if(value.length>WIRE_LIMITS.ack)throw invalid('ACK_TOO_LARGE');internalExt=Buffer.from(value).toString('utf8');
  }else if(field===9&&wire===0){needAck=reader.bool()}
  else reader.skipType(wire);
 }
 const ack=needAck?Buffer.from(PushFrame.encode({logId:frame.logId,payloadType:'ack',payload:Buffer.from(internalExt,'utf8')}).finish()):null;
 return {messages,ack};
}
