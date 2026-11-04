import {test} from 'node:test';import assert from 'node:assert/strict';import {DemoRules} from '../../demo-rules.mjs';
for(const [type,count,size] of [['like',1,'small'],['heart',1,'large'],['beer',2,'large'],['lollipop',3,'large']])test(type+'数量与尺寸',()=>{let r=new DemoRules();r.event(type,{name:'测试'},'1');assert.equal(r.queue.length,count);assert.ok(r.queue.every(x=>x.size===size))});
test('事件去重',()=>{let r=new DemoRules();for(let i=0;i<2;i++)r.event('beer',{name:'测试'},'same');assert.equal(r.queue.length,2)});
test('拒绝旧规则',()=>{let r=new DemoRules();assert.throws(()=>r.event('small66',{name:'测试'},'1'))});
test('礼物优先于普通任务，礼物之间保持先来先打印',()=>{
 const r=new DemoRules();
 r.event('like',{name:'普通A'},'a');r.event('like',{name:'普通B'},'b');
 const first=r.event('beer',{name:'礼物A'},'gift-a');
 const second=r.event('heart',{name:'礼物B'},'gift-b');
 assert.deepEqual(r.queue.map(j=>j.name),['礼物A','礼物A','礼物B','普通A','普通B']);
 assert.equal(first.index,0);assert.equal(second.index,2);
});
test('插队任务的直播标记不污染普通队列，重连后仍保留礼物',()=>{
 const r=new DemoRules();r.event('like',{name:'演示'},'demo');
 const result=r.event('lollipop',{name:'礼物'},'gift');
 for(let i=result.index;i<result.index+result.added;i++){r.queue[i].live=true;r.queue[i].source='礼物·棒棒糖'}
 assert.equal(r.queue.at(-1).live,undefined);
 assert.equal(r.queue.filter(j=>j.live).length,3);
 assert.ok(result.jobs.every(j=>j.priority&&j.live));
});
test('长期事件缓存和等待队列有界，满队列不再分配任务',()=>{
 const r=new DemoRules({queueLimit:4,seenLimit:8});
 for(let i=0;i<100;i++)r.event('like',{name:'观众'+i},'event-'+i);
 assert.equal(r.queue.length,4);assert.equal(r.seen.size,8);
 assert.deepEqual(r.queue.map(j=>j.name),['观众0','观众1','观众2','观众3']);
 assert.equal(r.event('like',{name:'重复'},'event-99').duplicate,true);
 const result=r.event('like',{name:'满了'},'new');assert.equal(result.added,0);assert.equal(result.jobs.length,0);assert.equal(result.dropped,1);
});
test('容量受限时礼物仅使用余量，保留所有已接受任务及FIFO',()=>{
 const r=new DemoRules({queueLimit:6});
 r.event('heart',{name:'旧礼物'},'g0');
 for(let i=0;i<4;i++)r.event('like',{name:'普通'+i},'n'+i);
 const result=r.event('beer',{name:'新礼物'},'g1');
 assert.equal(result.index,1);assert.equal(result.added,1);assert.equal(result.dropped,1);
 assert.deepEqual(r.queue.map(j=>j.name),['旧礼物','新礼物','普通0','普通1','普通2','普通3']);
 assert.deepEqual(result.jobs,r.queue.slice(result.index,result.index+result.added));
});
test('礼物队列已满时不替换旧礼物，超大批量只创建可接纳任务',()=>{
 const r=new DemoRules({queueLimit:4});
 const result=r.event('lollipop',{name:'首批'},'first',100,{count:10});
 assert.equal(result.requested,1000);assert.equal(result.added,4);assert.equal(result.dropped,996);assert.equal(result.jobs.length,4);
 assert.ok(result.jobs.every(j=>j.total===4));
 const next=r.event('heart',{name:'后到'},'last');assert.equal(next.added,0);assert.equal(next.dropped,1);assert.ok(r.queue.every(j=>j.name==='首批'));
});
