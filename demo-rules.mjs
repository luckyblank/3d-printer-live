export const RULES={like:{count:1,size:'small',label:'点赞'},heart:{count:1,size:'large',priority:true,label:'爱心'},beer:{count:2,size:'large',priority:true,label:'啤酒'},lollipop:{count:3,size:'large',priority:true,label:'棒棒糖'},other:{count:1,size:'large',priority:true,label:'礼物'}};
export const QUEUE_LIMIT=2048,SEEN_LIMIT=4096;
export class DemoRules{
 constructor({queueLimit=QUEUE_LIMIT,seenLimit=SEEN_LIMIT}={}){
  if(!Number.isInteger(queueLimit)||queueLimit<1||!Number.isInteger(seenLimit)||seenLimit<1)throw Error('队列和事件缓存上限应为正整数');
  this.queue=[];this.likes=new Map();this.seen=new Set();this.follows=new Set();this.queueLimit=queueLimit;this.seenLimit=seenLimit;
 }
 event(type,user,id,amount=1,options={}){
  if(!RULES[type])throw Error('未知规则');
  if(!user?.name)throw Error('缺少用户');
  if(!Number.isInteger(amount)||amount<1||amount>100)throw Error('演示单次数量应为1到100');
  const rule={...RULES[type],...options};
  if(!Number.isInteger(rule.count)||rule.count<1||rule.count>10)throw Error('每次打印数量应为1到10');
  if(id&&this.seen.has(id))return {added:0,duplicate:true};
  if(id){this.seen.add(id);while(this.seen.size>this.seenLimit)this.seen.delete(this.seen.values().next().value)}
  const requested=rule.count*amount;
  // Bound new pending work without deleting any accepted gift or ordinary task.
  // The active print is already shifted out of this queue and stays untouched.
  const count=Math.min(requested,Math.max(0,this.queueLimit-this.queue.length));
  const jobs=Array.from({length:count},(_,i)=>({...user,size:rule.size,priority:!!rule.priority,source:rule.label,copy:i+1,total:count}));
  let index=this.queue.length;
  if(rule.priority){index=this.queue.findIndex(j=>!j.priority);if(index<0)index=this.queue.length}
  this.queue.splice(index,0,...jobs);
  return {added:count,size:rule.size,index,jobs,requested,dropped:requested-count};
 }
}
