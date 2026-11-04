// MIT: adapted from DyHub 21251a1150b7320abaac7ab8222cfa6856abcee2.
// Copyright (c) 2026 DyHub Contributors. License: third_party/douyin-sign/DYHUB-LICENSE.
// The unchanged signing assets carry their own AGPL-3.0 license; see NOTICE.md.
import WebSocket from 'ws';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {decodeDouyinFrame,encodeHeartbeat,WIRE_LIMITS} from './douyin-wire.mjs';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
const MAX_HTML=8*1024*1024,MAX_COOKIE=32768,MAX_COOKIES=128,MAX_SEEN=4096;
const messages={STOPPED:'采集已停止',HTTP_TIMEOUT:'读取直播间超时',HTTP_FAILED:'直播间请求失败',AUTH_REQUIRED:'登录状态需要更新',BLOCKED:'直播间请求被限制，请稍后重试',COOKIE_MISSING:'未取得直播间设备状态，请重新登录',ROOM_PARSE_FAILED:'暂时无法识别直播间，请确认房间号与登录状态',OFFLINE:'直播间已下播',SIGN_FAILED:'直播连接签名失败',WS_FAILED:'直播数据连接失败',WS_TIMEOUT:'直播数据连接超时',WS_CLOSED:'直播数据连接已断开',STALE:'直播数据暂时中断',FRAME_INVALID:'直播数据格式异常',CONSUMER_ERROR:'直播数据处理失败'};
const failure=code=>Object.assign(new Error(messages[code]||messages.WS_FAILED),{code});
const noop=()=>{};
const bounded=(value,fallback,min,max)=>Number.isFinite(value)?Math.max(min,Math.min(max,Math.floor(value))):fallback;
let signContext=null,signCall=null;

export function signWebcastParams(text){
 try{
  if(typeof text!=='string'||text.length>8192)throw failure('SIGN_FAILED');
  if(!signContext){
   const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'});
   new vm.Script('globalThis.window={};globalThis.document={};globalThis.navigator={userAgent:'+JSON.stringify(UA)+'};').runInContext(context,{timeout:1500});
   new vm.Script(readFileSync(new URL('./third_party/douyin-sign/sign.js',import.meta.url),'utf8'),{filename:'douyin-sign.js'}).runInContext(context,{timeout:1500});
   signContext=context;signCall=new vm.Script('globalThis.__signatureOutput=get_sign(globalThis.__signatureInput)');
  }
  signContext.__signatureInput=createHash('md5').update(text).digest('hex');signContext.__signatureOutput='';
  signCall.runInContext(signContext,{timeout:1500});
  const result=signContext.__signatureOutput;delete signContext.__signatureInput;delete signContext.__signatureOutput;
  if(typeof result!=='string'||!result||result.length>4096)throw failure('SIGN_FAILED');
  return result;
 }catch{signContext=null;signCall=null;throw failure('SIGN_FAILED')}
}

function objectAfter(text,key,start=0){
 const index=text.indexOf('"'+key+'"',start);if(index<0)return null;
 const begin=text.indexOf('{',index+key.length+2);if(begin<0||begin-index>32)return null;
 let depth=0,quoted=false,escape=false;
 for(let i=begin;i<Math.min(text.length,begin+2*1024*1024);i++){
  const char=text[i];if(quoted){if(escape)escape=false;else if(char==='\\')escape=true;else if(char==='"')quoted=false;continue;}
  if(char==='"')quoted=true;else if(char==='{'){if(++depth>128)return null;}else if(char==='}'&&!--depth){try{return JSON.parse(text.slice(begin,i+1))}catch{return null}}
 }
 return null;
}
export function parseLightweightRoom(html){
 if(typeof html!=='string'||Buffer.byteLength(html)>MAX_HTML)throw failure('ROOM_PARSE_FAILED');
 const clean=html.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/\\"/g,'"');
 const store=objectAfter(clean,'roomStore'),room=store?.roomInfo?.room||objectAfter(clean,'room');
 const value=room?.id_str||store?.roomInfo?.roomId||clean.match(/"roomId"\s*:\s*"?(\d{1,24})"?/)?.[1];
 if(!/^\d{1,24}$/.test(String(value||'')))throw failure('ROOM_PARSE_FAILED');
 return {roomId:String(value),status:Number.isFinite(Number(room?.status))?Number(room.status):null};
}
function acSignature(site,nonce,ua,ts){
 const cal1=(s,iv)=>{let k=iv;for(const c of s)k=((k^c.charCodeAt(0))*65599)&0xffffffff;return k;};
 const cal2=(s,iv)=>{let k=iv;for(let i=0;i<32;i++)k=(k*65599+s.charCodeAt(k%s.length))&0xffffffff;return k;};
 const cal3=(s,iv)=>{let k=iv;for(const c of s)k=(k*65599+c.charCodeAt(0))&0xffffffff;return k;};
 const chr=c=>c<26?String.fromCharCode(c+65):c<52?String.fromCharCode(c+71):c<62?String.fromCharCode(c-4):String.fromCharCode(c-17);
 const enc=n=>{let s='';for(let i=24;i>=0;i-=6)s+=chr((n>>i)&63);return s;};
 const s1=cal1(site,0),s3=cal1(site,0),s5=cal2(site,0),s2=cal2(ua,s1),s4=cal3(ua,s3),s6=cal3(ua,s5),s7=(s1+s2)&0xffffffff,s8=(s3+s4)&0xffffffff,s9=(s5+s6)&0xffffffff,s10=(s7+s8)&0xffffffff,s11=(s8+s9)&0xffffffff,s12=(s10+s11)&0xffffffff,s13=(s1+s4+s5+s7+s9+s11)&0xffffffff,s14=(s2+s3+s6+s8+s10+s12)&0xffffffff;
 return enc(ts&0xffffffff)+enc(s12)+enc((s13+s14)&0xffffffff)+enc(ts&0xffffffff);
}
async function responseText(response){
 const size=Number(response.headers?.get?.('content-length'));if(Number.isFinite(size)&&size>MAX_HTML)throw failure('ROOM_PARSE_FAILED');
 if(!response.body?.getReader){const text=await response.text();if(Buffer.byteLength(text)>MAX_HTML)throw failure('ROOM_PARSE_FAILED');return text;}
 const reader=response.body.getReader(),parts=[];let length=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_HTML){await reader.cancel();throw failure('ROOM_PARSE_FAILED')}parts.push(Buffer.from(value));}return Buffer.concat(parts,length).toString('utf8');}
 finally{reader.releaseLock();}
}

export class LightweightSession {
 constructor(webRid,{cookie='',onMessage=noop,onState=noop,fetchImpl=globalThis.fetch,WebSocketImpl=WebSocket,timers=globalThis,now=()=>Date.now(),random=Math.random,requestTimeoutMs=12000,connectTimeoutMs=15000,heartbeatMs=5000,staleMs=45000,reconnectBaseMs=1000,reconnectMaxMs=30000,seenLimit=MAX_SEEN}={}){
  this.webRid=String(webRid).trim();if(!/^\d{1,24}$/.test(this.webRid))throw new TypeError('Invalid room ID');
  if(typeof cookie!=='string'||Buffer.byteLength(cookie)>MAX_COOKIE||/[\r\n]/.test(cookie))throw new TypeError('Invalid session configuration');
  if(typeof fetchImpl!=='function'||typeof WebSocketImpl!=='function')throw new TypeError('Missing collector dependency');
  this._fetch=fetchImpl;this._WS=WebSocketImpl;this._onMessage=typeof onMessage==='function'?onMessage:noop;this._onState=typeof onState==='function'?onState:noop;
  this._timersApi=timers;this._now=now;this._random=random;this._limits={requestTimeoutMs:bounded(requestTimeoutMs,12000,1,120000),connectTimeoutMs:bounded(connectTimeoutMs,15000,1,120000),heartbeatMs:bounded(heartbeatMs,5000,1,60000),staleMs:bounded(staleMs,45000,1,300000),reconnectBaseMs:bounded(reconnectBaseMs,1000,1,30000),reconnectMaxMs:bounded(reconnectMaxMs,30000,1,300000),seenLimit:bounded(seenLimit,MAX_SEEN,1,MAX_SEEN)};
  this._jar=new Map();for(const part of cookie.split(';')){const i=part.indexOf('=');if(i<1)continue;const key=part.slice(0,i).trim(),value=part.slice(i+1).trim();if(/^[A-Za-z0-9_.-]+$/.test(key)&&value)this._jar.set(key,value);}
  if(this._jar.size>MAX_COOKIES)throw new TypeError('Invalid session configuration');
  this._originalKeys=new Set(this._jar.keys());this._timers=new Set();this._requests=new Set();this._seen=new Map();this._generation=0;this._stopped=true;this._ws=null;this._cleanupSocket=null;this._cancelConnect=null;this._startPromise=null;this._reconnectTimer=null;this._attempts=0;this._status='stopped';
  this._counts={framesReceived:0,messagesReceived:0,bytesReceived:0,duplicates:0,reconnects:0,invalidFrames:0,callbackErrors:0};this._lastReceivedAt=0;
 }
 _state(status,code){this._status=status;try{this._onState({status,...(code?{code,message:messages[code]||messages.WS_FAILED}:{})})}catch{}}
 _active(generation){return !this._stopped&&generation===this._generation;}
 _check(generation){if(!this._active(generation))throw failure('STOPPED');}
 _later(callback,ms){const id=this._timersApi.setTimeout(()=>{this._timers.delete(id);callback();},ms);this._timers.add(id);id?.unref?.();return id;}
 _clear(id){if(id!==null&&id!==undefined){this._timersApi.clearTimeout(id);this._timers.delete(id);}}
 _cookies(){return [...this._jar].map(([key,value])=>key+'='+value).join('; ');}
 _storeCookies(headers){
  const values=headers?.getSetCookie?.()||String(headers?.get?.('set-cookie')||'').split(/,(?=\s*[^;,\s]+=)/);
  for(const item of values){const token=item.split(';')[0],at=token.indexOf('=');if(at<1)continue;const key=token.slice(0,at).trim(),value=token.slice(at+1).trim();if(!/^[A-Za-z0-9_.-]+$/.test(key)||!value||this._originalKeys.has(key)||this._jar.size>=MAX_COOKIES)continue;if(Buffer.byteLength(this._cookies())+Buffer.byteLength(token)+2>MAX_COOKIE)continue;this._jar.set(key,value);}
 }
 async _html(url,generation){
  this._check(generation);const controller=new AbortController();this._requests.add(controller);let expired=false,abort;
  const timeout=this._later(()=>{expired=true;controller.abort()},this._limits.requestTimeoutMs);
  const canceled=new Promise((_,reject)=>{abort=()=>reject(failure(expired?'HTTP_TIMEOUT':'STOPPED'));controller.signal.addEventListener('abort',abort,{once:true});});
  try{
   const operation=(async()=>{const response=await this._fetch(url,{headers:{'User-Agent':UA,'Accept':'text/html,*/*;q=0.8','Accept-Language':'zh-CN,zh;q=0.9',Cookie:this._cookies(),Referer:'https://live.douyin.com/'},redirect:'error',signal:controller.signal});this._check(generation);this._storeCookies(response.headers);if(!response.ok)throw failure(response.status===404?'OFFLINE':response.status===401||response.status===403?'AUTH_REQUIRED':response.status===415||response.status===429?'BLOCKED':'HTTP_FAILED');return responseText(response);})();
   const text=await Promise.race([operation,canceled]);this._check(generation);return text;
  }catch(error){if(!this._active(generation))throw failure('STOPPED');throw error?.code&&messages[error.code]?error:failure(expired?'HTTP_TIMEOUT':'HTTP_FAILED');}
  finally{controller.signal.removeEventListener('abort',abort);this._requests.delete(controller);this._clear(timeout);}
 }
 async _room(generation){
  if(!this._jar.has('ttwid')){
   await this._html('https://www.douyin.com/',generation);
   const nonce=this._jar.get('__ac_nonce');if(nonce&&!this._jar.has('__ac_signature')&&this._jar.size<MAX_COOKIES)this._jar.set('__ac_signature',acSignature('www.douyin.com',nonce,UA,Math.floor(this._now()/1000)));
   await this._html('https://live.douyin.com/',generation);
   if(!this._jar.has('ttwid'))throw failure('COOKIE_MISSING');
  }
  const room=parseLightweightRoom(await this._html('https://live.douyin.com/'+this.webRid,generation));if(room.status===4)throw failure('OFFLINE');return room.roomId;
 }
 _url(roomId){
  const now=this._now(),params=new URLSearchParams({app_name:'douyin_web',version_code:'180800',webcast_sdk_version:'1.0.14-beta.0',update_version_code:'1.0.14-beta.0',compress:'gzip',device_platform:'web',cookie_enabled:'true',screen_width:'1536',screen_height:'864',browser_language:'zh-CN',browser_platform:'Win32',browser_name:'Mozilla',browser_version:UA,browser_online:'true',tz_name:'Asia/Shanghai',cursor:`r-${roomId}_d-1_u-1_fh-${roomId}_t-${now}`,internal_ext:`internal_src:dim|wss_push_room_id:${roomId}|wss_push_did:${roomId}|first_req_ms:${now}|fetch_time:${now}|seq:1|wss_info:0-${now}-0-0|wrds_v:${roomId}`,host:'https://live.douyin.com',aid:'6383',live_id:'1',did_rule:'3',endpoint:'live_pc',support_wrds:'1',user_unique_id:roomId,im_path:'/webcast/im/fetch/',identity:'audience',need_persist_msg_count:'15',insert_task_id:'',live_reason:'',room_id:roomId,heartbeatDuration:'0'});
  const keys=['live_id','aid','version_code','webcast_sdk_version','room_id','sub_room_id','sub_channel_id','did_rule','user_unique_id','device_platform','device_type','ac','identity'];params.set('signature',signWebcastParams(keys.map(key=>key+'='+(params.get(key)||'')).join(',')));
  return 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?'+params;
 }
 _releaseSocket(){const ws=this._ws;this._ws=null;this._cleanupSocket?.();this._cleanupSocket=null;if(ws){ws.on?.('error',noop);try{if(typeof ws.terminate==='function')ws.terminate();else ws.close()}catch{}}}
 _connect(roomId,generation){
  this._check(generation);const url=this._url(roomId);this._check(generation);
  return new Promise((resolve,reject)=>{
   let ws;try{ws=new this._WS(url,{headers:{'User-Agent':UA,Cookie:this._cookies()},handshakeTimeout:this._limits.connectTimeoutMs,maxPayload:WIRE_LIMITS.frame})}catch{reject(failure('WS_FAILED'));return;}
   this._ws=ws;let opened=false,settled=false,heartbeat=null;
   const timeout=this._later(()=>fail('WS_TIMEOUT'),this._limits.connectTimeoutMs);
   const fail=code=>{if(settled&&opened){this._drop(ws,generation,code);return;}if(settled)return;settled=true;this._clear(timeout);this._cancelConnect=null;this._releaseSocket();reject(failure(code));};
   const beat=()=>{if(!this._active(generation)||this._ws!==ws)return;if(this._now()-this._lastReceivedAt>this._limits.staleMs){this._drop(ws,generation,'STALE');return;}try{ws.send(encodeHeartbeat())}catch{this._drop(ws,generation,'WS_FAILED');return;}heartbeat=this._later(beat,this._limits.heartbeatMs);};
   const handlers={
    open:()=>{if(settled||!this._active(generation)){fail('STOPPED');return;}opened=settled=true;this._clear(timeout);this._cancelConnect=null;this._lastReceivedAt=this._now();this._attempts=0;this._state('connected');if(!this._active(generation)||this._ws!==ws){reject(failure('STOPPED'));return;}heartbeat=this._later(beat,this._limits.heartbeatMs);resolve(this.stats());},
    message:(data,isBinary)=>{if(!opened||!this._active(generation)||this._ws!==ws||isBinary===false)return;this._receive(data,ws,generation);},
    error:()=>fail('WS_FAILED'),close:()=>fail('WS_CLOSED'),
    'unexpected-response':()=>fail('WS_FAILED')
   };
   this._cleanupSocket=()=>{this._clear(timeout);this._clear(heartbeat);for(const [event,handler]of Object.entries(handlers))ws.off?.(event,handler);};
   this._cancelConnect=()=>fail('STOPPED');for(const [event,handler]of Object.entries(handlers))ws.on(event,handler);
  });
 }
 _receive(data,ws,generation){
  try{
   let bytes=data;if(Array.isArray(data)){let length=0;for(const part of data){length+=part.byteLength;if(!Number.isFinite(length)||length>WIRE_LIMITS.frame)throw failure('FRAME_INVALID');}bytes=Buffer.concat(data,length);}else if(data instanceof ArrayBuffer)bytes=Buffer.from(data);
   if(!bytes||!Number.isFinite(bytes.byteLength)||bytes.byteLength>WIRE_LIMITS.frame)throw failure('FRAME_INVALID');this._lastReceivedAt=this._now();this._counts.framesReceived++;this._counts.bytesReceived+=bytes.byteLength;
   const frame=decodeDouyinFrame(bytes);if(frame.ack)ws.send(frame.ack);
   for(const message of frame.messages){
    if(!this._active(generation)||this._ws!==ws)break;if(!message.method)continue;
    const key=message.msgId?message.method+':'+message.msgId:null;if(key&&this._seen.has(key)){this._counts.duplicates++;continue;}if(key){this._seen.set(key,true);while(this._seen.size>this._limits.seenLimit)this._seen.delete(this._seen.keys().next().value);}
    this._counts.messagesReceived++;try{this._onMessage(message)}catch{this._counts.callbackErrors++;}
   }
  }catch{this._counts.invalidFrames++;if(this._counts.invalidFrames%5===0)this._drop(ws,generation,'FRAME_INVALID');}
 }
 _drop(ws,generation,code){if(!this._active(generation)||this._ws!==ws)return;this._releaseSocket();this._schedule(generation,code);}
 _schedule(generation,code){
  if(!this._active(generation)||this._reconnectTimer!==null)return;
  const attempt=this._attempts++,base=Math.min(this._limits.reconnectMaxMs,this._limits.reconnectBaseMs*2**Math.min(attempt,10)),random=this._random(),jitter=Number.isFinite(random)?Math.max(0,Math.min(1,random)):.5,delay=Math.min(this._limits.reconnectMaxMs,Math.round(base*(.8+.4*jitter)));
  this._state('reconnecting',code);if(!this._active(generation))return;this._reconnectTimer=this._later(()=>{this._reconnectTimer=null;if(!this._active(generation))return;this._counts.reconnects++;this._attempt(generation).catch(error=>{if(!this._active(generation))return;if(error.code==='AUTH_REQUIRED'){this._state('error',error.code);return;}if(error.code==='OFFLINE')this._state('offline',error.code);this._schedule(generation,error.code);});},delay);
 }
 async _attempt(generation){const roomId=await this._room(generation);this._check(generation);return this._connect(roomId,generation);}
 start(){
  if(this._startPromise)return this._startPromise;if(!this._stopped&&this._status==='connected')return Promise.resolve(this.stats());
  if(!this._stopped)this.stop();
  this._stopped=false;const generation=++this._generation;this._attempts=0;this._state('connecting');
  const promise=this._attempt(generation).catch(error=>{if(this._active(generation))this._state(error.code==='OFFLINE'?'offline':'error',error.code);throw failure(error.code||'WS_FAILED');}).finally(()=>{if(this._startPromise===promise)this._startPromise=null;});this._startPromise=promise;return promise;
 }
 stop(){
  if(this._stopped)return;this._stopped=true;this._generation++;this._startPromise=null;this._cancelConnect?.();this._cancelConnect=null;
  for(const request of this._requests)request.abort();for(const id of this._timers)this._timersApi.clearTimeout(id);this._timers.clear();this._reconnectTimer=null;this._releaseSocket();this._seen.clear();this._state('stopped');
 }
 stats(){return {status:this._status,connected:this._status==='connected',roomId:this.webRid,...this._counts,lastMessageAt:this._lastReceivedAt,cacheSize:this._seen.size};}
}
