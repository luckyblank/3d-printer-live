import test from 'node:test';
import assert from 'node:assert/strict';
import protobuf from 'protobufjs';
import {parseDouyinMessage,createDouyinEventAdapter} from '../../douyin-events.mjs';

const schema=protobuf.parse(`syntax="proto3";
message Image {repeated string urlList=1;}
message User {uint64 id=1;string nickName=3;Image avatarThumb=9;string idStr=1029;}
message Common {uint64 msgId=2;}
message Gift {uint64 id=5;string name=16;}
message Chat {Common common=1;User user=2;string content=3;}
message Like {User user=5;uint64 count=2;}
message Social {User user=2;uint64 action=4;}
message Member {User user=2;}
message GiftMessage {Common common=1;uint64 giftId=2;uint64 groupCount=4;uint64 repeatCount=5;uint64 comboCount=6;User user=7;uint64 repeatEnd=9;uint64 groupId=11;Gift gift=15;}
message Control {uint64 status=2;}`).root;
const actor={id:'9007199254740993',nickName:'团子🌸',avatarThumb:{urlList:['https://p3.douyinpic.com/aweme-avatar/a.png']}};
function raw(type,body,msgId='1'){
 const model=schema.lookupType(type),payload=model.encode(model.fromObject(body)).finish();
 return {method:'Webcast'+(type==='GiftMessage'?'Gift':type)+'Message',payload,msgId};
}

test('protocol comments preserve exact 64-bit user IDs, avatar and text without scraping the page',()=>{
 const result=parseDouyinMessage(raw('Chat',{user:actor,content:'666 😀'}),'12345');
 assert.equal(result.userId,'9007199254740993');assert.equal(result.avatar,actor.avatarThumb.urlList[0]);assert.equal(result.text,'666 😀');assert.equal(result.type,'comment');assert.equal(result.room,'12345');
 const missing=parseDouyinMessage(raw('Chat',{user:{nickName:'没有头像'},content:'你好'}));assert.equal(missing.name,'没有头像');assert.equal(missing.avatar,'');
});
test('identical comment text with different IDs is delivered twice, duplicate ID only once',()=>{
 const events=[],a=createDouyinEventAdapter({emit:e=>events.push(e)});
 a.handle(raw('Chat',{user:actor,content:'666'},'11'));a.handle(raw('Chat',{user:actor,content:'666'},'12'));a.handle(raw('Chat',{user:actor,content:'666'},'11'));
 assert.equal(events.length,2);
});
test('gift progress, out-of-order frames and final messages produce only incremental quantities',()=>{
 const events=[],a=createDouyinEventAdapter({room:'11111',emit:e=>events.push(e)});
 const gift=(count,id,end=0,groupId='456')=>raw('GiftMessage',{user:actor,giftId:'123',groupId,repeatCount:count,repeatEnd:end,gift:{name:'啤酒',id:'123'}},id);
 for(const entry of [gift(1,'1'),gift(3,'2'),gift(2,'3'),gift(3,'4',1),gift(3,'4',1),gift(1,'5',0,'457')])a.handle(entry);
 assert.deepEqual(events.map(e=>e.count),[1,2,1]);assert.equal(events[0].raw,'啤酒');assert.equal(events[0].giftId,'123');
 a.reset('22222');a.handle(gift(1,'1'));assert.equal(events.length,4);assert.equal(events.at(-1).room,'22222');
});
test('first observed gift can be the final frame, and independent gifts are not merged by name',()=>{
 const events=[],a=createDouyinEventAdapter({emit:e=>events.push(e)});
 a.handle(raw('GiftMessage',{user:actor,giftId:7,groupId:1,repeatCount:3,repeatEnd:1,gift:{name:'爱心'}},'10'));
 a.handle(raw('GiftMessage',{user:actor,giftId:7,groupId:2,repeatCount:1,gift:{name:'爱心'}},'11'));
 assert.deepEqual(events.map(e=>e.count),[3,1]);
});
test('share and other social actions do not become false follows; join and likes preserve actor/count',()=>{
 assert.equal(parseDouyinMessage(raw('Social',{user:actor,action:3})),null);
 assert.equal(parseDouyinMessage(raw('Social',{user:actor,action:1})).type,'follow');
 assert.equal(parseDouyinMessage(raw('Member',{user:actor})).type,'join');
 assert.equal(parseDouyinMessage(raw('Like',{user:actor,count:8})).count,8);
 assert.equal(parseDouyinMessage(raw('Like',{user:actor,count:0})).count,0);
});
test('malformed, oversized, unrecognized and invalid avatar messages are bounded and harmless',()=>{
 for(const m of [null,{method:'WebcastChatMessage',payload:Buffer.from([255])},{method:'WebcastChatMessage',payload:Buffer.alloc(1024*1024+1)},raw('Chat',{user:{...actor,avatarThumb:{urlList:['javascript:alert(1)']}}})])assert.doesNotThrow(()=>parseDouyinMessage(m));
 assert.equal(parseDouyinMessage({method:'unknown',payload:Buffer.alloc(0)}),null);
 assert.equal(parseDouyinMessage(raw('Chat',{user:{...actor,avatarThumb:{urlList:['javascript:alert(1)']}},content:'x'})).avatar,'');
});
test('message and gift-group caches stay bounded and expire; actual room end is explicit',()=>{
 let time=0;const events=[],a=createDouyinEventAdapter({maxEntries:3,ttlMs:10,now:()=>time,emit:e=>events.push(e)});
 for(let i=1;i<=8;i++)a.handle(raw('GiftMessage',{user:actor,giftId:1,groupId:i,repeatCount:1,gift:{name:'小心心'}},String(i)));
 assert.deepEqual(a.stats(),{seen:3,giftGroups:3});
 time=20;a.handle(raw('GiftMessage',{user:actor,giftId:1,groupId:8,repeatCount:1,gift:{name:'小心心'}},'8'));assert.equal(events.length,9);
 assert.equal(parseDouyinMessage(raw('Control',{status:3})).type,'room-ended');
 assert.equal(parseDouyinMessage(raw('Control',{status:1})),null);
});
