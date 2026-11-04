export class GiftSpeech {
 constructor(onStatus=()=>{},onStateChange=()=>{}){
  this._enabled=true;this.volume=.85;this.rate=1.08;this.voiceURI='';this.onStatus=onStatus;this.onStateChange=onStateChange;
  this.unlocked=false;this.previous=-1;this.lastWelcome=-1;this.queue=[];this.speaking=false;this.generation=0;
  this.state='locked';this.lastError='';this._waitingVoices=false;this._startTimer=null;this._synth=null;this._voicesChanged=null;this._previewing=false;this._previewRestore=null;this._lastStateKey='';
  this.language="zh-CN";this.pitch=1.16;this.messages={locked:'语音待启用，请点击开启声音',disabled:'语音已静音',unsupported:'当前浏览器不支持语音播报',loading:'正在等待系统语音加载…',noVoice:'没有可用的中文语音，请安装中文语音或更换音色',ready:'语音已就绪',starting:'正在启动语音播放…',failure:'语音播放失败：',retry:'，请点击试听或开启声音重试',full:'播报队列已满，本次仅显示字幕：'};
 }
 voices(){try{return globalThis.speechSynthesis?.getVoices?.()||[]}catch{return []}}
 preferred(){const voices=this.voices();return voices.find(v=>v.voiceURI===this.voiceURI)||voices.find(v=>/zh|cmn/i.test(v.lang)&&/xiaoxiao|xiaoyi|huihui|yaoyao|female|女/i.test(v.name))||voices.find(v=>/zh-CN/i.test(v.lang))||voices.find(v=>/^zh/i.test(v.lang))}
 get enabled(){return this._enabled}
 set enabled(value){
  const enabled=!!value;
  if(enabled===this._enabled)return;
  this._enabled=enabled;this.stop();
  if(enabled)this._setState('locked',this.messages.locked);
 }
 get previewing(){return this._previewing}
 get ready(){return this.enabled&&this.unlocked&&!this._waitingVoices&&['ready','starting','speaking'].includes(this.state)&&!!this.preferred()}
 snapshot(){return {state:this.state,ready:this.ready,unlocked:this.unlocked,enabled:this.enabled,error:this.lastError,previewing:this._previewing}}
 _canSpeak(){return (this.enabled||this._previewing)&&this.unlocked}
 _setState(state,caption,error=''){
  this.state=state;this.lastError=error;
  if(caption){try{this.onStatus(caption)}catch{}}
  const snapshot=this.snapshot(),key=JSON.stringify(snapshot);
  if(key!==this._lastStateKey){this._lastStateKey=key;try{this.onStateChange?.(snapshot)}catch{}}
 }
 _supported(){return typeof globalThis.speechSynthesis?.speak==='function'&&typeof globalThis.SpeechSynthesisUtterance==='function'}
 _clearStartTimer(){if(this._startTimer!==null){clearTimeout(this._startTimer);this._startTimer=null}}
 _listenForVoices(){
  const synth=globalThis.speechSynthesis;if(this._synth===synth)return;
  if(this._synth&&this._voicesChanged)this._synth.removeEventListener?.('voiceschanged',this._voicesChanged);
  this._synth=synth;
  this._voicesChanged=()=>{
   if(!this._canSpeak()||this.speaking)return;
   if(!this.preferred()){this._waitingVoices=true;this.queue=this.queue.slice(-1);this._setState('no-voice',this.messages.noVoice);return}
   if(this._waitingVoices){this._waitingVoices=false;this._setState('ready',this.messages.ready);this.pump()}
  };
  synth?.addEventListener?.('voiceschanged',this._voicesChanged);
 }
 unlock(){
  // The controller calls this synchronously from a real user gesture. Network
  // gifts and welcome events must never establish this permission themselves.
  if(!this.enabled&&!this._previewing){this._setState('disabled',this.messages.disabled);return false}
  if(!this._supported()){this.unlocked=false;this._setState('unsupported',this.messages.unsupported,'unsupported');return false}
  this._listenForVoices();this.unlocked=true;
  try{if(globalThis.speechSynthesis.paused)globalThis.speechSynthesis.resume()}catch(error){this._fail(error?.message||'resume-failed');return false}
  if(!this.preferred()){
   this._waitingVoices=true;this.queue=this.queue.slice(-1);
   this._setState(this.voices().length?'no-voice':'loading-voices',this.voices().length?this.messages.noVoice:this.messages.loading);
   return false;
  }
  this._waitingVoices=false;
  this._setState(this.speaking?(this.state==='speaking'?'speaking':'starting'):'ready',this.speaking?undefined:this.messages.ready);
  this.pump();return this.ready;
 }
 _fail(error){
  this.generation++;this._clearStartTimer();this.unlocked=false;this._waitingVoices=false;this.queue=[];this.speaking=false;this._previewing=false;this._previewRestore=null;
  try{globalThis.speechSynthesis?.cancel()}catch{}
  const code=String(error||'speech-error');
  const blocked=/not-allowed|permission|user-gesture/i.test(code);
  this._setState(blocked?'blocked':'error',this.messages.failure+code+this.messages.retry,code);
 }
 text(name,gift,amount){const safe=String(name).replace(/[<>\n\r]/g,'').slice(0,24);const phrases=[`谢谢${safe}送来的${amount}个${gift}，祝你今天开心，明天也有好消息！`,`感谢${safe}的${amount}个${gift}，愿你想做的事情，都慢慢变成现实。`,`${safe}，你的${amount}个${gift}收到啦！祝你吃得香，睡得好，每天都有小惊喜。`,`谢谢${safe}送的${amount}个${gift}呀，祝你好运常在，烦恼拜拜！`,`感谢${safe}送来${amount}个${gift}，愿你一路有风景，身边有温暖。`,`${safe}送来的${amount}个${gift}好暖心，谢谢你！祝你钱包鼓鼓，快乐满满。`,`收到${safe}的${amount}个${gift}啦，愿你所有认真，都有美好的回应。`,`谢谢${safe}的${amount}个${gift}，祝你今天顺顺利利，往后闪闪发光！`,`哇，${safe}的${amount}个${gift}到货啦！祝你笑口常开，好运挡不住。`,`${safe}送的${amount}个${gift}我收下啦，祝你天天有盼头，事事有着落。`,`谢谢${safe}的${amount}个${gift}，愿你被生活温柔对待，被好运常常想起。`,`${safe}的${amount}个${gift}超给力！祝你接下来的日子一路绿灯。`,`感谢${safe}送来${amount}个${gift}，祝你吃好喝好，心情天天晴朗。`,`${safe}的${amount}个${gift}收到！愿你今晚有好梦，明天有好天气。`,`谢谢${safe}的${amount}个${gift}呀，祝你烦恼清零，快乐续满格！`,`${safe}送来${amount}个${gift}，愿你的每一天都像今天一样被惊喜填满。`];let n=Math.floor(Math.random()*phrases.length);if(n===this.previous)n=(n+1)%phrases.length;this.previous=n;return phrases[n]}
 printing(name,finished=false){if(!this.unlocked||!this.enabled)return;const safe=String(name).replace(/[<>\n\r]/g,'').slice(0,24);const options=finished?[`${safe}，头像打印好啦！`,`${safe}，快看你的专属头像！`,`${safe}，制作完成，祝你好运！`,`${safe}，你的专属头像出炉啦，快来验收！`,`${safe}，打印完成，愿这份好运天天陪着你！`,`${safe}，成品新鲜出炉，快看看满不满意！`]:[`${safe}，开始打印啦！`,`${safe}，轮到你啦，祝你开心！`,`${safe}，头像安排上啦！`,`${safe}，机器转起来，你的头像马上好！`,`${safe}，正在为你定制专属头像哦！`,`${safe}，轮到你的头像啦，愿你好运连连！`];const text=options[Math.floor(Math.random()*options.length)];if(this.speaking||this.queue.length)return;this.enqueue(text)}
 welcome(name){const safe=String(name).replace(/[<>\n\r]/g,'').slice(0,24);const lines=[`欢迎${safe}来到直播间，祝你今天好运满满，开心加倍！`,`欢迎${safe}，很高兴见到你呀，愿你接下来遇到的都是好事情。`,`${safe}来啦，欢迎欢迎！祝你生活有甜头，日子有盼头。`,`欢迎${safe}进来坐坐，愿你烦恼少一点，快乐多一点。`,`欢迎${safe}来到这里，祝你今天顺心，今晚睡个好觉！`,`${safe}，欢迎你呀！愿你所遇皆温暖，所行皆坦途。`,`欢迎${safe}，送你一份好心情，祝你吃嘛嘛香，做什么都顺顺利利。`,`欢迎${safe}来到直播间，愿你心里有光，每天都有小惊喜！`,`欢迎${safe}！今天人齐聚齐的，就等你来一起开心啦。`,`${safe}来啦！愿你今天的好心情像打印机的灯一样亮。`,`欢迎${safe}进直播间，愿你所求皆如愿，所行化坦途。`,`${safe}你好呀，愿你从今天起好运连连，笑容不断。`,`欢迎${safe}！搬好小板凳，精彩马上开始。`,`${safe}来啦，愿你的生活像新打印的头像一样，又亮又体面。`,`欢迎${safe}！祝你点的每一餐都好吃，走的每一步都顺。`,`${safe}来啦！愿你被这个世界温柔以待，天天都有小欢喜。`];let n=Math.floor(Math.random()*lines.length);if(n===this.lastWelcome)n=(n+1)%lines.length;this.lastWelcome=n;this.enqueue(lines[n])}
 enqueue(text){
  if(!this.enabled||!this.unlocked||this._previewing)return false;
  if(!this._supported()){this.unlocked=false;this._setState('unsupported',this.messages.unsupported,'unsupported');return false}
  if(this._waitingVoices){this.queue=[text];this.pump();return true}
  if(this.queue.length>=12){try{this.onStatus(this.messages.full+text)}catch{}return false}
  this.queue.push(text);this.pump();return true;
 }
 say(name,gift,amount=1){this.enqueue(this.text(name,gift,amount))}
 pump(){
  if(!this._canSpeak()||this.speaking||!this.queue.length)return;
  if(!this._supported()){this.unlocked=false;this.queue=[];this._setState('unsupported',this.messages.unsupported,'unsupported');return}
  const voice=this.preferred();
  if(!voice){
   this._listenForVoices();this._waitingVoices=true;this.queue=this.queue.slice(-1);
   this._setState(this.voices().length?'no-voice':'loading-voices',this.voices().length?this.messages.noVoice:this.messages.loading);return;
  }
  this._waitingVoices=false;
  const text=this.queue.shift(),token=this.generation;let utterance;
  try{utterance=new globalThis.SpeechSynthesisUtterance(text)}catch(error){this._fail(error?.message||'utterance-failed');return}
  utterance.voice=voice;utterance.lang=voice.lang||this.language;utterance.rate=this.rate;utterance.pitch=this.pitch;utterance.volume=this.volume;
  let started=false;
  utterance.onstart=()=>{if(token!==this.generation||!this._canSpeak())return;started=true;this._clearStartTimer();this._setState('speaking',text)};
  utterance.onend=()=>{if(token!==this.generation)return;this._clearStartTimer();this.speaking=false;if(this._previewing){this._finishPreview();return}this._setState('ready');this.pump()};
  utterance.onerror=event=>{if(token!==this.generation)return;this._fail(event.error||'speech-error')};
  this.speaking=true;this._setState('starting',this.messages.starting);
  this._startTimer=setTimeout(()=>{if(token===this.generation&&!started)this._fail('start-timeout')},5000);this._startTimer?.unref?.();
  try{globalThis.speechSynthesis.speak(utterance)}catch(error){this._fail(error?.message||'speak-failed')}
 }
 preview(name,gift=this.language==='en-US'?'heart':'爱心',amount=1){
  // This one-shot path is called only by the explicit Preview voice click. It
  // never enables regular events or changes the saved enabled preference.
  const restore=this._previewRestore||{unlocked:this.unlocked};
  this.stop();this._previewRestore=restore;this._previewing=true;
  this.unlock();
  if(!this.unlocked){this._previewing=false;this._previewRestore=null;this._setState(this.state,undefined,this.lastError);return false}
  this.queue=[this.text(name??(this.language==='en-US'?'Demo viewer':'演示观众'),gift,amount)];this.pump();
  return this._canSpeak()&&!this._waitingVoices;
 }
 _finishPreview(){
  const restore=this._previewRestore;this._previewing=false;this._previewRestore=null;this.queue=[];this._waitingVoices=false;
  this.unlocked=this.enabled&&!!restore?.unlocked;
  this._setState(!this.enabled?'disabled':this.unlocked?'ready':'locked');
 }
 cancel({lock=false}={}){
  // A reset or voice change may clear old speech without revoking an existing
  // user activation. A preview's temporary activation is never promoted.
  const authorized=this._previewing?!!this._previewRestore?.unlocked:this.unlocked;
  this.generation++;this._clearStartTimer();this.queue=[];this.speaking=false;this._previewing=false;this._previewRestore=null;
  this.unlocked=!lock&&this.enabled&&authorized;this._waitingVoices=this.unlocked&&!this.preferred();
  try{globalThis.speechSynthesis?.cancel()}catch{}
  if(!this.enabled)this._setState('disabled',this.messages.disabled);
  else if(lock)this._setState('stopped');
  else if(!this.unlocked)this._setState('locked');
  else if(this._waitingVoices)this._setState(this.voices().length?'no-voice':'loading-voices',this.voices().length?this.messages.noVoice:this.messages.loading);
  else this._setState('ready');
 }
 stop(){this.cancel({lock:true})}
}
