// Saved audio preferences are not proof that the browser has unlocked audio.
// This coordinator owns user intent; both playback engines retain their own
// readiness and error reporting. Explicit previews never rewrite preferences.
export function createAudioControls({machineAudio,giftSpeech,quickSound,soundButton,volume,audioStatus,
 speechToggle,speechTest,welcomeButton,soundTest,repairAudio,nativeAudio,voiceSelect,rateInput,
 onVoiceReady=()=>{},onWelcome=()=>{},previewName=()=>'',en=false,
 document:doc=globalThis.document,storage}={}){
 if(storage===undefined){try{storage=globalThis.localStorage;}catch{storage=null;}}
 const t=(zh,english)=>en?english:zh;
 const read=(key,fallback=true)=>{try{const value=storage?.getItem(key);return value===null||value===undefined?fallback:value!=='off';}catch{return fallback;}};
 const write=(key,value)=>{try{storage?.setItem(key,value?'on':'off');}catch{}};
 let masterWanted=read('printer-sound'),effectsWanted=read('printer-effects'),voiceWanted=read('printer-voice');
 let generation=0,pending=null,attempted=false,effectsError='',voiceError='',previewError='',announcement=0;
 let previewGeneration=0,nativePreviewPending=false,nativePreviewActive=false,speechWasPreview=false,context=null,disposed=false;
 const speechPreview=()=>giftSpeech.previewing===true;
 const speechPreviewPending=()=>speechPreview()&&giftSpeech.state!=='speaking';
 const effectsReady=()=>masterWanted&&effectsWanted&&machineAudio.enabled===true&&machineAudio.ctx?.state==='running';
 const voiceReady=()=>masterWanted&&voiceWanted&&giftSpeech.ready===true;
 const previewActive=()=>nativePreviewActive||(speechPreview()&&giftSpeech.state==='speaking');
 const actualReady=()=>effectsReady()||voiceReady();
 const voiceFailed=()=>!!voiceError||['unsupported','no-voice','blocked','error'].includes(giftSpeech.state);
 function gates(){
  if(!masterWanted||!effectsWanted)machineAudio.mute();
  const enabled=masterWanted&&voiceWanted;
  if(giftSpeech.enabled!==enabled)giftSpeech.enabled=enabled;
 }
 function bindContext(){
  if(context===machineAudio.ctx)return;
  context?.removeEventListener?.('statechange',refresh);
  context=machineAudio.ctx;context?.addEventListener?.('statechange',refresh);
 }
 function voiceDescription(){
  if(!voiceWanted)return t('播报已关闭','Voice is switched off');
  if(voiceReady())return t('播报已就绪','Voice is ready');
  if(voiceError)return t('播报失败：','Voice failed: ')+voiceError;
  const state=giftSpeech.state;
  if(state==='unsupported')return t('系统不支持播报','Voice is unsupported');
  if(state==='no-voice')return t('未找到可用语音，请更换音色','No usable voice; choose another voice');
  if(state==='blocked')return t('播报未获授权，请点击启用播报重试','Voice blocked; click Enable voice to retry');
  if(state==='error')return t('播报失败：','Voice failed: ')+(giftSpeech.lastError||t('请重试','retry'));
  if(state==='loading-voices')return t('正在等待系统语音','Waiting for system voices');
  return t('播报待启用','Voice awaits activation');
 }
 function effectDescription(){
  if(!effectsWanted)return t('音效已关闭','Effects are switched off');
  if(effectsReady())return t('音效已开启 · 音量 ','Effects ready · volume ')+Math.round(machineAudio.volume*100)+'%';
  if(effectsError)return t('音效未启动：','Effects failed: ')+effectsError;
  if(machineAudio.ctx?.state==='suspended'||machineAudio.ctx?.state==='closed')return t('音效已暂停，点击启用声音恢复','Effects paused; click Enable sound to restore');
  return t('音效待启用','Effects await activation');
 }
 function getState(){
  let phase;
  if(pending||nativePreviewPending||speechPreviewPending())phase='enabling';
  else if(actualReady()||previewActive())phase='on';
  else if(!masterWanted||(!effectsWanted&&!voiceWanted))phase='off';
  else if(attempted&&(effectsError||voiceFailed()||previewError))phase='error';
  else phase='pending';
  return {phase,masterWanted,effectsWanted,voiceWanted,effectsReady:effectsReady(),voiceReady:voiceReady(),previewing:previewActive()||nativePreviewPending||speechPreview(),generation};
 }
 function refresh(){
  if(disposed)return;
  const state=getState(),onlyPreview=state.previewing&&!actualReady();
  const labels={pending:t('🔈 启用声音','🔈 Enable sound'),enabling:t('🔈 正在启用…','🔈 Enabling sound…'),on:onlyPreview?t('🔊 停止试听','🔊 Stop preview'):t('🔊 关闭声音','🔊 Mute sound'),off:t('🔇 启用声音','🔇 Enable sound'),error:t('🔈 重试声音','🔈 Retry sound')};
  quickSound.textContent=labels[state.phase];quickSound.title=labels[state.phase];
  quickSound.setAttribute('aria-pressed',String(actualReady()||state.previewing));quickSound.setAttribute('data-audio-state',state.phase);
  soundButton.textContent=effectsReady()?t('静音音效','Mute effects'):effectsError?t('重试音效','Retry effects'):t('启用音效','Enable effects');
  soundButton.setAttribute('aria-pressed',String(effectsReady()));soundButton.setAttribute('data-audio-state',effectsReady()?'on':pending&&effectsWanted?'enabling':effectsWanted?'pending':'off');
  speechToggle.textContent=voiceReady()?t('播报：开','Voice: On'):!voiceWanted?t('播报：关','Voice: Off'):voiceFailed()?t('重试播报','Retry voice'):t('启用播报','Enable voice');
  speechToggle.setAttribute('aria-pressed',String(voiceReady()));speechToggle.setAttribute('data-audio-state',voiceReady()?'on':voiceFailed()?'error':voiceWanted?'pending':'off');
  let status;
  if(nativePreviewPending||speechPreviewPending())status=t('正在准备试听，声音偏好保持不变','Preparing preview; saved sound preferences are unchanged');
  else if(onlyPreview)status=t('正在试听，结束后恢复原有声音设置','Preview playing; previous sound settings will be restored');
  else if(!masterWanted)status=t('声音已关闭，普通点击不会自动开启','Sound is off; ordinary interactions will not enable it');
  else if(!effectsWanted&&!voiceWanted)status=t('音效与播报均已关闭','Effects and voice are both switched off');
  else if(!attempted&&!actualReady())status=t('点击启用声音后开始播报','Click Enable sound to start voice playback');
  else status=(pending?t('正在启用 · ','Enabling · '):'')+effectDescription()+' · '+voiceDescription();
  if(previewError)status+=' · '+previewError;
  if(!masterWanted&&effectsError)status+=' · '+t('修复失败：','Repair failed: ')+effectsError;
  audioStatus.textContent=status;audioStatus.setAttribute('role','status');
  if(announcement&&announcement===generation&&voiceReady()){
   announcement=0;
   onVoiceReady();
  }
 }
 function invalidate(){generation++;pending=null;announcement=0;}
 function stopPreviews(){
  previewGeneration++;nativePreviewPending=false;nativePreviewActive=false;
  nativeAudio.pause?.();
  if(speechPreview())giftSpeech.stop();
 }
 function muteMaster(){
  invalidate();masterWanted=false;write('printer-sound',false);stopPreviews();
  gates();giftSpeech.stop();effectsError='';voiceError='';previewError='';refresh();
 }
 async function activate({explicit=false,rebuild=false}={}){
  if(disposed||(!explicit&&!masterWanted))return false;
  if(explicit){masterWanted=true;write('printer-sound',true);}
  if(!effectsWanted&&!voiceWanted){refresh();return false;}
  const token=++generation;pending={token};attempted=true;previewError='';
  if(effectsWanted)effectsError='';
  const needsAnnouncement=voiceWanted&&!voiceReady();
  gates();if(needsAnnouncement)announcement=token;
  const jobs=[];
  // Both calls begin inside the original trusted gesture, before any await.
  if(voiceWanted){voiceError='';try{giftSpeech.unlock();}catch(error){voiceError=String(error.message||error);}}
  if(effectsWanted){
   try{jobs.push(Promise.resolve(rebuild?machineAudio.rebuild():effectsReady()?undefined:machineAudio.enable()).then(()=>{if(!machineAudio.enabled||machineAudio.ctx?.state!=='running')throw Error(t('音频仍暂停','Audio remains suspended'));}));}
   catch(error){jobs.push(Promise.reject(error));}
  }
  bindContext();refresh();
  const results=await Promise.allSettled(jobs);
  bindContext();
  if(token===generation){const failed=results.find(result=>result.status==='rejected');if(failed)effectsError=String(failed.reason?.message||failed.reason);pending=null;}
  gates();refresh();return token===generation&&(effectsReady()||voiceReady());
 }
 function toggleMaster(){
  if((nativePreviewPending||speechPreview()||previewActive())&&!actualReady()&&!pending){stopPreviews();previewError='';refresh();return;}
  if(pending||actualReady()){muteMaster();return;}
  if(!effectsWanted&&!voiceWanted){effectsWanted=true;write('printer-effects',true);}
  void activate({explicit:true});
 }
 function toggleEffects(){
  if(masterWanted&&effectsWanted&&(effectsReady()||pending)){
   invalidate();effectsWanted=false;write('printer-effects',false);machineAudio.mute();effectsError='';gates();refresh();
  }else{effectsWanted=true;write('printer-effects',true);void activate({explicit:true});}
 }
 function toggleVoice(){
  if(masterWanted&&voiceWanted&&(voiceReady()||pending)){
   invalidate();voiceWanted=false;write('printer-voice',false);giftSpeech.enabled=false;giftSpeech.stop();voiceError='';refresh();
  }else{voiceWanted=true;write('printer-voice',true);void activate({explicit:true});}
 }
 function previewVoice(){
  previewError='';
  try{if(typeof giftSpeech.preview!=='function')throw Error(t('试听暂不可用','Voice preview unavailable'));giftSpeech.preview(previewName(),en?'heart':'爱心',1);if(voiceFailed()&&!speechPreview())previewError=t('试听未启动：','Preview did not start: ')+(giftSpeech.lastError||giftSpeech.state);}
  catch(error){previewError=t('试听失败：','Preview failed: ')+String(error.message||error);}
  refresh();
 }
 async function previewEffects(){
  const token=++previewGeneration;previewError='';nativePreviewPending=true;refresh();
  try{nativeAudio.currentTime=0;await nativeAudio.play();if(token!==previewGeneration){if(!masterWanted)nativeAudio.pause();return;}nativePreviewPending=false;nativePreviewActive=true;}
  catch(error){if(token===previewGeneration){nativePreviewPending=false;nativePreviewActive=false;previewError=t('测试音未启动：','Test tone failed: ')+String(error.message||error);}}
  refresh();
 }
 async function repairEffects(){
  if(masterWanted&&effectsWanted){void activate({explicit:true,rebuild:true});return;}
  const token=++generation;pending={token};attempted=true;effectsError='';refresh();
  try{await machineAudio.rebuild();}catch(error){if(token===generation)effectsError=String(error.message||error);}
  if(token===generation)pending=null;bindContext();gates();refresh();
 }
 function simulateWelcome(){
  if(!masterWanted||!voiceWanted){previewError=t('进场欢迎测试需要先启用播报','Enable voice before testing join welcomes');refresh();return;}
  previewError='';void activate();onWelcome();refresh();
 }
 const audioElements=[quickSound,soundButton,volume,speechToggle,speechTest,welcomeButton,soundTest,repairAudio,nativeAudio,voiceSelect,rateInput].filter(Boolean);
 function gesture(event){
  if(event.isTrusted!==true||!masterWanted||disposed||pending)return;
  if(event.type==='pointerdown'&&event.button!==0)return;
  if(event.type==='keydown'&&(event.ctrlKey||event.altKey||event.metaKey||['Escape','Shift','Control','Alt','Meta','Tab','CapsLock','NumLock','ScrollLock','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'].includes(event.key)))return;
  if(audioElements.some(element=>element===event.target||element.contains?.(event.target))||event.target?.closest?.('#ws-settings-audio'))return;
  if((effectsWanted&&!effectsReady())||(voiceWanted&&!voiceReady()))void activate();
 }
 function visibility(){if(machineAudio.isHidden?.())machineAudio.silence();refresh();}
 const trusted=action=>event=>{if(event?.isTrusted===false)return;return action(event);};
 quickSound.onclick=trusted(toggleMaster);soundButton.onclick=trusted(toggleEffects);speechToggle.onclick=trusted(toggleVoice);
 speechTest.onclick=trusted(previewVoice);soundTest.onclick=trusted(previewEffects);repairAudio.onclick=trusted(repairEffects);welcomeButton.onclick=trusted(simulateWelcome);
 volume.oninput=()=>{machineAudio.setVolume(Number(volume.value)/100);refresh();};
 voiceSelect.onchange=()=>{giftSpeech.stop();giftSpeech.voiceURI=voiceSelect.value;if(masterWanted&&voiceWanted)void activate();else refresh();};
 rateInput.oninput=()=>{giftSpeech.rate=Number(rateInput.value);refresh();};
 const previousSpeechState=giftSpeech.onStateChange;
 giftSpeech.onStateChange=snapshot=>{previousSpeechState?.(snapshot);if(snapshot?.ready)voiceError='';if(speechWasPreview&&!snapshot?.previewing&&['unsupported','no-voice','blocked','error'].includes(snapshot?.state))previewError=t('试听失败：','Preview failed: ')+(snapshot.error||snapshot.state);speechWasPreview=!!snapshot?.previewing;refresh();};
 const nativePlaying=()=>{if(nativeAudio.paused===true||nativeAudio.ended===true)return;nativePreviewPending=false;nativePreviewActive=true;refresh();};
 const nativeStopped=()=>{nativePreviewPending=false;nativePreviewActive=false;refresh();};
 nativeAudio.addEventListener('playing',nativePlaying);nativeAudio.addEventListener('pause',nativeStopped);nativeAudio.addEventListener('ended',nativeStopped);
 nativeAudio.addEventListener('error',()=>{nativeStopped();previewError=t('测试音文件加载失败','Test audio file failed to load');refresh();});
 doc.addEventListener('pointerdown',gesture);doc.addEventListener('keydown',gesture);doc.addEventListener('visibilitychange',visibility);
 function dispose(){if(disposed)return;invalidate();masterWanted=false;stopPreviews();gates();machineAudio.silence();giftSpeech.stop();disposed=true;context?.removeEventListener?.('statechange',refresh);doc.removeEventListener?.('pointerdown',gesture);doc.removeEventListener?.('keydown',gesture);doc.removeEventListener?.('visibilitychange',visibility);}
 globalThis.addEventListener?.('pagehide',dispose,{once:true});
 gates();refresh();
 return {getState,refresh,activate,mute:muteMaster,previewVoice,previewEffects,dispose};
}
