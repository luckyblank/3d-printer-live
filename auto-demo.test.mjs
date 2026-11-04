import fs from 'node:fs';import assert from 'node:assert/strict';
const s=fs.readFileSync('index.html','utf8');const code=s.slice(s.indexOf('function replenishDemo(force){'),s.indexOf('function next(){'));const q=[];const f=new Function('autoDemo','paused','busy','queue','demoPeople','randomPerson','renderQueue','updateScreen','lastDemoFill','printRules',code+';return replenishDemo;');const person={name:'测试',avatar:'test'};const mk=(auto,pause,busy,lastFill,rules)=>f(auto,pause,busy,q,[person],()=>person,()=>{},()=>{},lastFill,Object.assign({demoGapMs:30000},rules));
q.length=0;mk(true,false,false,Date.now())();assert.equal(q.length,0,'30 秒内不重复补位');
mk(true,false,false,Date.now()-31000)();assert.equal(q.length,1,'超过间隔补一个');
q.length=0;mk(true,false,false,Date.now())(true);assert.equal(q.length,1,'force 立刻补位（30 秒内也强制）');
q.length=0;mk(true,false,false,Date.now(),{demoGapMs:0})();assert.equal(q.length,0,'间隔=关闭 时不自动补');
mk(true,false,false,Date.now(),{demoGapMs:0})(true);assert.equal(q.length,1,'关闭时 force 仍可补');
q.length=0;for(let i=0;i<100;i++){mk(true,false,false,0)();assert.equal(q.length,1);q.shift()}
mk(false,false,false,0)();assert.equal(q.length,0,'关闭自动演示不补位');mk(true,true,false,0)();assert.equal(q.length,0,'暂停不补位');mk(true,false,true,0)();assert.equal(q.length,0,'打印中不补位');q.push({priority:true,name:'礼物'});mk(true,false,false,0)();assert.equal(q.length,1,'队列有任务不补位（礼物保留，不额外补）');console.log('PASS: 30 秒节奏补位、间隔可设置、force 立刻补、暂停/关闭/打印中/队列占用均不补');
