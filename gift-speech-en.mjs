// English voice module for the TikTok edition (index-en.html).
// Same API as gift-speech.mjs (text/printing/welcome/say/enqueue/stop) but fully independent code:
// English phrase banks, English voice preference (en-US), English status captions.
export class GiftSpeech {
 constructor(onStatus=()=>{},onStateChange=()=>{}){
  this._enabled=true;this.volume=.85;this.rate=1.04;this.voiceURI='';this.onStatus=onStatus;this.onStateChange=onStateChange;
  this.unlocked=false;this.previous=-1;this.lastWelcome=-1;this.queue=[];this.speaking=false;this.generation=0;
  this.state='locked';this.lastError='';this._waitingVoices=false;this._startTimer=null;this._synth=null;this._voicesChanged=null;this._previewing=false;this._previewRestore=null;this._lastStateKey='';
  this.language="en-US";this.pitch=1.05;this.messages={locked:'Voice needs a click to enable',disabled:'Voice is muted',unsupported:'Speech synthesis is not supported in this browser',loading:'Waiting for system voices…',noVoice:'No English voice is available. Install an English voice or choose another voice.',ready:'Voice is ready',starting:'Starting voice playback…',failure:'Voice playback failed: ',retry:' — click Preview voice or Enable sound to retry',full:'Voice queue is full — caption only: '};
 }
 voices(){try{return globalThis.speechSynthesis?.getVoices?.()||[]}catch{return []}}
 preferred(){const voices=this.voices();return voices.find(v=>v.voiceURI===this.voiceURI)||voices.find(v=>/^en(-|_)?US/i.test(v.lang)&&/female|samantha|zira|aria|jenny|google us english/i.test(v.name))||voices.find(v=>/^en(-|_)?US/i.test(v.lang))||voices.find(v=>/^en/i.test(v.lang))}
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
 text(name,gift,amount){const safe=String(name).replace(/[<>\n\r]/g,'').slice(0,24);const phrases=[`Thank you ${safe} for ${amount} ${gift}! Have a wonderful day!`,`Thanks ${safe} for the ${amount} ${gift} — may your plans work out one by one!`,`${safe} sent ${amount} ${gift} — got it! Eat well, sleep well, small surprises every day!`,`Thank you ${safe} for the ${amount} ${gift}! Good luck in, worries out!`,`Thanks for the ${amount} ${gift}, ${safe}! May your road be scenic and your heart warm.`,`How sweet, ${amount} ${gift} from ${safe}! Wish you a fat wallet and full happiness.`,`Got your ${amount} ${gift}, ${safe}! May every effort pay off.`,`Thank you ${safe} for the ${amount} ${gift} — smooth day today, shining days ahead!`,`Wow, ${amount} ${gift} from ${safe}! Keep smiling, luck is coming!`,`I'll take your ${amount} ${gift}, ${safe}! Something to look forward to every day!`,`Thank you ${safe} for the ${amount} ${gift}! May life treat you gently.`,`${amount} ${gift} from ${safe} — amazing! Green lights all the way!`,`Thanks ${safe} for the ${amount} ${gift}! Eat well, drink well, sunny mood every day!`,`Got it, ${safe} — ${amount} ${gift}! Sweet dreams tonight, great weather tomorrow!`,`Thank you ${safe} for the ${amount} ${gift}! Worries to zero, happiness to full!`,`${safe} sent ${amount} ${gift}! May every day be filled with little surprises like today!`];let n=Math.floor(Math.random()*phrases.length);if(n===this.previous)n=(n+1)%phrases.length;this.previous=n;return phrases[n]}
 printing(name,finished=false){if(!this.unlocked||!this.enabled)return;const safe=String(name).replace(/[<>\n\r]/g,'').slice(0,24);const options=finished?[`${safe}, your avatar is ready!`,`${safe}, look — your custom avatar!`,`${safe}, printing done. Good luck!`,`${safe}, your avatar just came out — come check it!`,`${safe}, printing finished! May this luck stay with you!`,`${safe}, fresh off the printer — hope you like it!`]:[`${safe}, printing starts now!`,`${safe}, it's your turn — have fun!`,`${safe}, your avatar is on the schedule!`,`${safe}, the machine is running — avatar coming right up!`,`${safe}, making your custom avatar!`,`${safe}, your turn — good luck!`];const text=options[Math.floor(Math.random()*options.length)];if(this.speaking||this.queue.length)return;this.enqueue(text)}
 welcome(name){const safe=String(name).replace(/[<>\n\r]/g,'').slice(0,24);const lines=[`Welcome to the stream, ${safe}! Have an awesome day!`,`Welcome, ${safe}! Great to see you — only good things from here!`,`${safe} is here — welcome! May life be sweet and days be bright.`,`Come in, ${safe}! Less worries, more fun!`,`Welcome ${safe}! Enjoy the show and sleep well tonight!`,`${safe}, welcome! May everything you meet be warm.`,`Welcome ${safe}! Good vibes only — hope everything goes your way.`,`Welcome to the stream, ${safe}! Little surprises every day!`,`Welcome ${safe}! Everyone's here — we were waiting for you!`,`${safe} is here! May your mood shine like the printer's lights.`,`Welcome in, ${safe}! May your wishes come true.`,`Hi ${safe}! Good luck from today on, keep smiling!`,`Welcome ${safe}! Grab a seat — the fun starts now!`,`${safe} is here! May your life be as shiny as a fresh print!`,`Welcome ${safe}! Enjoy your stay!`,`${safe} is here! May the world be gentle to you — little joys every day!`];let n=Math.floor(Math.random()*lines.length);if(n===this.lastWelcome)n=(n+1)%lines.length;this.lastWelcome=n;this.enqueue(lines[n])}
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
