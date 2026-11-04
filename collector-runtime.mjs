import {createDouyinEventAdapter} from './douyin-events.mjs';

const MESSAGES={connecting:'正在连接直播间…',connected:'直播采集已连接',reconnecting:'连接中断，正在后台重连…',offline:'直播间当前未开播',error:'采集连接失败，请检查网络或重新登录',stopped:'抓取已停止'};
export function createCollectorRuntime({createSession,broadcast=()=>{},cookie='',mapGift=()=> 'other',lookupAvatar=()=>'',rememberAvatar=()=>{},now=Date.now,maxPeople=512}={}){
 if(typeof createSession!=='function')throw new TypeError('Collector session factory is required');
 let session=null,epoch=0,room='',destroyed=false,likeTokens=20,lastLikeAt=now(),lastEventAt=0;
 let state={type:'collector-status',collector:'lightweight',status:'stopped',message:MESSAGES.stopped,room:''};
 const people=new Map(),totals={comment:0,gift:0,like:0,join:0,follow:0};
 const send=value=>{try{broadcast(value)}catch{}};
 function setState(value){
  const status=Object.hasOwn(MESSAGES,value?.status)?value.status:'error';
  const code=typeof value?.code==='string'&&/^[A-Z0-9_]{1,50}$/.test(value.code)?value.code:'';
  const message=status==='error'&&['AUTH_REQUIRED','COOKIE_MISSING'].includes(code)?'登录状态需要更新，请重新登录抖音':status==='error'&&code==='BLOCKED'?'直播间请求受限，请稍后重试':MESSAGES[status];
  state={type:'collector-status',collector:'lightweight',room,status,code,message};send({...state});
 }
 const getPeople=()=>[...people.values()].slice(-8).map(p=>({...p}));
 function accept(event){
  if(destroyed)return;
  if(event.type==='room-ended'){session?.stop();setState({status:'offline'});return;}
  const key=event.userId||event.name;
  let avatar=event.avatar||people.get(key)?.avatar||lookupAvatar(event.name)||'';
  if(avatar.length>4096)avatar='';
  people.delete(key);people.set(key,{name:event.name,avatar});
  while(people.size>maxPeople)people.delete(people.keys().next().value);
  if(event.avatar)rememberAvatar(event.name,event.avatar);
  const output={...event,avatar};delete output.groupId;delete output.repeatEnd;
  if(event.type==='gift'){output.gift=mapGift(event.raw);totals.gift=Math.min(1e9,totals.gift+event.count);}
  else if(event.type==='like'){
   const time=now();likeTokens=Math.min(20,likeTokens+Math.max(0,time-lastLikeAt)/400);lastLikeAt=time;
   output.count=Math.min(event.count,3,Math.floor(likeTokens));likeTokens-=output.count;
   if(output.count<=0)return;totals.like=Math.min(1e9,totals.like+output.count);
  }else if(Object.hasOwn(totals,event.type))totals[event.type]=Math.min(1e9,totals[event.type]+1);
  lastEventAt=now();send(output);
 }
 const adapter=createDouyinEventAdapter({emit:accept,now});
 async function setRoom(nextRoom){
  if(destroyed)return false;
  if(!/^\d{5,25}$/.test(String(nextRoom)))throw new TypeError('Invalid room');
  const generation=++epoch;
  const previous=session;session=null;try{previous?.stop()}catch{}
  room=String(nextRoom);people.clear();adapter.reset(room);for(const key of Object.keys(totals))totals[key]=0;
  likeTokens=20;lastLikeAt=now();lastEventAt=0;
  send({type:'room',room});send({type:'hello',room,people:[]});setState({status:'connecting'});
  let candidate;
  try{
   candidate=createSession(room,{cookie,
    onMessage(message){if(!destroyed&&generation===epoch)adapter.handle(message);},
    onState(value){if(!destroyed&&generation===epoch)setState(value);}});
   session=candidate;await candidate.start();
   if(destroyed||generation!==epoch){candidate.stop();return false;}
   // A transport without a state callback still has an unambiguous open result.
   if(state.status==='connecting')setState({status:'connected'});
   return true;
  }catch(error){
   if(!destroyed&&generation===epoch&&!['offline','error'].includes(state.status))setState({status:'error',code:error?.code});
   if(candidate===session){session=null;++epoch;try{candidate?.stop()}catch{}}
   return false;
  }
 }
 return {
  setRoom,
  status:()=>({...state}),
  hello:()=>({type:'hello',room,people:getPeople()}),
  ping:()=>({type:'ping',room,people:getPeople(),stats:{...totals,roster:people.size,lastAgo:lastEventAt?Math.max(0,now()-lastEventAt):null}}),
  stats:()=>({...totals,people:people.size,...adapter.stats(),transport:session?.stats?.()||{}}),
  stop(){if(destroyed)return;destroyed=true;++epoch;const old=session;session=null;old?.stop();setState({status:'stopped'});people.clear();adapter.reset();}
 };
}
