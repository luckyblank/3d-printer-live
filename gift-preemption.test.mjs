import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
for(const file of ['index.html','index-en.html']){
 const code=fs.readFileSync(file,'utf8').split('function preemptForGift(){')[1].split('function next(){')[0];
 function run(phase,priority=false,paused=false){
  const product={factor:1,g:{rotation:{set(){}},position:{set(){}}}};
  const c={paused,busy:true,active:{name:'ordinary',priority},queue:[{name:'gift',priority:true},{name:'waiting',priority:false}],phase,currentProduct:product,products:[],scene:{attach(){}},transferState:{},elapsed:4,lastPct:50,disposeProduct:p=>p.disposed=true,articulateArm(){}};
  vm.runInNewContext('function preemptForGift(){'+code+';preemptForGift();',c);return {c,product};
 }
 test(file+' immediate gift preserves unfinished ordinary job',()=>{const {c,product}=run('printing');assert.deepEqual(c.queue.map(x=>x.name),['gift','ordinary','waiting']);assert.equal(product.disposed,true);assert.equal(c.busy,false)});
 test(file+' finished product retained without duplicate job',()=>{const {c,product}=run('transfer');assert.equal(c.products[0],product);assert.equal(c.queue.length,2)});
 test(file+' gift FIFO and manual pause respected',()=>{for(const c of [run('printing',true).c,run('printing',false,true).c]){assert.equal(c.busy,true);assert.equal(c.queue.length,2)}});
}
