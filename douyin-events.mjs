// Protocol field numbers follow DyHub 21251a1 (MIT); provenance is documented
// in THIRD-PARTY-NOTICES.md. Keep capture details out of the printing engine.
import protobuf from 'protobufjs';

const MAX_PAYLOAD=1024*1024;
const clean=(value,max=80)=>Array.from(String(value??'').replace(/[\u0000-\u001f\u007f]/g,'')).slice(0,max).join('');
function fields(input){
 const bytes=Buffer.from(input||[]);if(bytes.length>MAX_PAYLOAD)throw new Error('Message too large');
 const reader=protobuf.Reader.create(bytes),out=[];
 while(reader.pos<reader.len){
  if(out.length>=2048)throw new Error('Too many fields');
  const tag=reader.uint32(),n=tag>>>3,wire=tag&7;if(!n)throw new Error('Invalid field');
  if(wire===0)out.push({n,wire,value:reader.uint64().toString()});
  else if(wire===2)out.push({n,wire,value:Buffer.from(reader.bytes())});
  else if(wire===1||wire===5)reader.skipType(wire);
  else throw new Error('Unsupported wire type');
 }
 return out;
}
const bytes=(items,n)=>items.find(f=>f.n===n&&f.wire===2)?.value;
const string=(items,n,max=500)=>clean(bytes(items,n)?.toString('utf8')||'',max);
const id=(items,n)=>items.find(f=>f.n===n&&f.wire===0)?.value||'';
const number=(items,n,fallback=0)=>{const v=id(items,n);return v?Math.min(1e9,Number(v)):fallback;};
function image(buffer){
 if(!buffer)return '';
 for(const f of fields(buffer))if(f.n===1&&f.wire===2){
  const value=f.value.toString('utf8');
  if(value.length>4096)continue;
  try{const u=new URL(value);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)return u.href;}catch{}
 }
 return '';
}
function user(buffer){
 if(!buffer)return null;
 const data=fields(buffer),name=string(data,3,80),userId=string(data,1029,80)||id(data,1)||string(data,46,160);
 if(!name)return null;
 const avatar=[9,10,11].map(n=>image(bytes(data,n))).find(Boolean)||'';
 return {name,userId,avatar};
}

export function parseDouyinMessage(message,room=''){
 try{
  if(!message||typeof message.method!=='string')return null;
  const data=fields(message.payload),common=fields(bytes(data,1)||[]);
  const messageId=clean(message.msgId||id(common,2),80);
  const base={room:String(room),messageId:messageId==='0'?'':messageId};
  if(message.method==='WebcastControlMessage')return number(data,2)===3?{...base,type:'room-ended'}:null;
  const kinds={WebcastChatMessage:'comment',WebcastEmojiChatMessage:'comment',WebcastGiftMessage:'gift',WebcastMemberMessage:'join',WebcastLikeMessage:'like',WebcastSocialMessage:'follow'};
  const type=kinds[message.method];if(!type)return null;
  // Social also carries shares and other actions. Only action 1 is a follow.
  if(type==='follow'&&number(data,4)!==1)return null;
  const actor=user(bytes(data,type==='gift'?7:type==='like'?5:2));if(!actor)return null;
  const event={...base,...actor,type};
  if(type==='comment')event.text=string(data,message.method==='WebcastEmojiChatMessage'?5:3,500)||'表情弹幕';
  else if(type==='like')event.count=Math.max(0,number(data,2));
  else if(type==='gift'){
   const gift=fields(bytes(data,15)||[]);
   Object.assign(event,{giftId:id(data,2)||id(gift,5),raw:string(gift,16,80)||'其他礼物',groupId:id(data,11),repeatEnd:number(data,9)!==0,
    count:Math.max(1,number(data,5)||number(data,4)||number(data,6)||1)});
  }
  return event;
 }catch{return null;}
}

export function createDouyinEventAdapter({room='',emit=()=>{},now=Date.now,maxEntries=4096,ttlMs=10*60_000}={}){
 const seen=new Map(),groups=new Map();let currentRoom=String(room),lastSweep=0;
 function prune(map,time){
  if(time-lastSweep>60_000)for(const [key,value]of map)if(time-value.at>ttlMs)map.delete(key);
  while(map.size>maxEntries)map.delete(map.keys().next().value);
 }
 function handle(message){
  const event=parseDouyinMessage(message,currentRoom);if(!event)return false;
  const time=now();prune(seen,time);prune(groups,time);lastSweep=time-lastSweep>60_000?time:lastSweep;
  const key=event.messageId?event.type+':'+event.messageId:'';
  if(key&&seen.has(key)&&time-seen.get(key).at<=ttlMs)return false;
  if(key){seen.set(key,{at:time});prune(seen,time);}
  if(event.type==='gift'&&event.groupId&&event.groupId!=='0'){
   const groupKey=[event.userId||event.name,event.giftId||event.raw,event.groupId].join(':');
   const previous=groups.get(groupKey),old=previous&&time-previous.at<=ttlMs?previous.count:0;
   const count=event.count;groups.delete(groupKey);groups.set(groupKey,{count:Math.max(old,count),at:time});prune(groups,time);
   event.count=Math.max(0,count-old);if(!event.count)return false;
  }
  emit(event);return true;
 }
 return {handle,reset(room=''){currentRoom=String(room);seen.clear();groups.clear();lastSweep=0;},stats:()=>({seen:seen.size,giftGroups:groups.size})};
}
