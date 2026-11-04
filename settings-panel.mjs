// Presentation-only settings layout. Form nodes, their values and engine
// handlers stay intact; asynchronous status elements are moved as a whole.
const make=(tag,className,text)=>{
 const node=document.createElement(tag);
 if(className)node.className=className;
 if(text!==undefined)node.textContent=text;
 return node;
};
const put=(parent,...nodes)=>{
 for(const node of nodes.flat())if(node)parent.append(node);
 return parent;
};

export function arrangeSettingsPanels(panes,{en=false}={}){
 if(!panes)return;
 const t=(zh,english)=>en?english:zh;
 let sequence=0;
 function identify(control,name){
  if(!control.id)control.id='settings-'+name+'-'+(++sequence);
  return control.id;
 }
 function group(title,className=''){
  const section=make('section','settings-group '+className);
  section.append(make('h3','settings-group-title',title));
  return section;
 }
 function field(control,title,{name='field',wide=false}={}){
  if(!control)return null;
  const wrapper=make('div','settings-field'+(wide?' settings-field-wide':''));
  const label=make('label','settings-field-label',title);
  label.htmlFor=identify(control,name);
  control.classList.add('settings-control');
  if(!control.getAttribute('aria-label'))control.setAttribute('aria-label',title);
  return put(wrapper,label,control);
 }
 function toggle(control,title,description=''){
  if(!control)return null;
  const label=make('label','settings-toggle-row');
  label.htmlFor=identify(control,'toggle');
  const content=make('span','settings-toggle-copy',title);
  if(description)content.append(make('small','settings-hint',description));
  return put(label,content,control);
 }
 function action(control,title){
  if(!control)return null;
  return put(make('div','settings-field settings-action-field'),make('span','settings-field-label',title),control);
 }
 function disclosure(title,className=''){
  const details=make('details','settings-disclosure '+className),body=make('div','settings-details-body');
  put(details,make('summary','',title),body);
  return {details,body};
 }
 function finish(pane,panel){
  // Keep future engine controls visible rather than silently discarding them.
  const remaining=[...pane.children].filter(node=>node.matches('button,input,select,textarea,a[href],audio')||node.querySelector('button,input,select,textarea,a[href],audio'));
  if(remaining.length)put(panel,put(group(t('其他设置','Other settings')),remaining));
  pane.replaceChildren(panel);pane.dataset.settingsArranged='true';
 }

 const rules=panes.rules;
 if(rules&&rules.dataset.settingsArranged!=='true'){
  const root=rules.querySelector('#print-rules-body');
  const groups=root?[...root.querySelectorAll(':scope > .print-setting-group')]:[];
  if(groups.length>=5){
   const [trigger,gifts,voice,idle,demo,...extra]=groups;
   const rootNote=root.querySelector(':scope > .print-setting-note');
   const headings=[t('互动触发','Interaction triggers'),t('礼物打印','Gift printing'),t('语音触发','Voice triggers'),t('无互动补位','Idle fill'),t('自动演示','Automatic demo')];
   for(const [i,current]of [trigger,gifts,voice,idle,demo].entries()){
    current.classList.add('settings-group');
    const heading=current.querySelector('h4');if(heading){heading.classList.add('settings-group-title');heading.textContent=headings[i];}
   }
   trigger.classList.add('settings-trigger-group');
   const columns=put(make('div','settings-trigger-columns'),make('span','',t('互动类型','Interaction')),make('span','',t('每次张数','Quantity')),make('span','',t('头像大小','Size')));
   trigger.querySelector('h4')?.after(columns);
   for(const [index,row]of [...trigger.querySelectorAll('.print-setting-card')].entries()){
    const type=t(['评论','进场','点赞','关注'][index],['Comment','Join','Like','Follow'][index]);
    const choices=[...row.querySelectorAll('select')];
    if(choices[0])choices[0].setAttribute('aria-label',type+' · '+t('每次张数','Quantity'));
    if(choices[1])choices[1].setAttribute('aria-label',type+' · '+t('头像大小','Size'));
    row.classList.add('settings-trigger-row');
   }
   gifts.classList.add('settings-gift-group');
   const giftHeading=gifts.querySelector('h4'),giftToggles=[...gifts.querySelectorAll(':scope > .print-setting-toggle')];
   const giftFields=[...gifts.querySelectorAll(':scope > .print-setting-field')];
   const giftSize=giftFields.shift();
   giftSize?.classList.add('settings-gift-size');
   const giftCounts=put(make('div','settings-gift-counts'),giftFields);
   gifts.replaceChildren(...[giftHeading,put(make('div','settings-gift-switches'),giftToggles),giftSize,giftCounts].filter(Boolean));
   voice.classList.add('settings-compact-group');idle.classList.add('settings-compact-group');demo.classList.add('settings-demo-group');
   const secondary=put(make('div','settings-two-column'),voice,idle);
   root.replaceChildren(trigger,gifts,secondary,demo,...extra,...(rootNote?[rootNote]:[]));
   root.classList.add('settings-rules-root');
   const panel=put(make('div','settings-panel settings-rules-panel'),root);
   finish(rules,panel);
  }
 }

 const visual=panes.visual;
 if(visual&&visual.dataset.settingsArranged!=='true'){
  const preset=visual.querySelector('#visual-preset'),resolution=visual.querySelector('#output-resolution');
  const fps=visual.querySelector('#target-fps'),aa=visual.querySelector('#antialias-mode');
  const output=preset?.closest('label')?.parentElement;
  if(output&&resolution&&fps){
   const quality=[...output.querySelectorAll('select')].find(select=>![preset,resolution,fps,aa].includes(select));
   const smooth=output.querySelector('input[type="checkbox"]');
   const smoothDescription=(smooth?.closest('label')?.textContent.trim()||'').replace(/^(?:流畅优先|Prefer smooth rendering|Smooth rendering)\s*[:：]\s*/i,'');
   const compatibility=output.querySelector('button');
   const paragraphs=[...output.querySelectorAll(':scope > p')];
   const presetNote=paragraphs[0],renderNote=paragraphs[1],compatibilityNote=compatibility?.nextElementSibling;
   const outputFps=output.querySelector('#output-fps');
   const helpNotes=paragraphs.filter(p=>![presetNote,renderNote,compatibilityNote,outputFps].includes(p));
   const overlay=[...visual.children].find(element=>element.tagName==='BUTTON');
   const cameraBar=visual.querySelector('.workspace-camera-manager'),cameraActions=visual.querySelector('.workspace-camera-actions');
   const panel=make('div','settings-panel settings-visual-panel');
   const outputGroup=group(t('输出画面','Output picture'),'settings-output-group');
   put(outputGroup,put(make('div','settings-fields-grid'),field(resolution,t('方向与输出分辨率','Orientation and resolution'),{wide:true,name:'resolution'}),action(overlay,t('打印状态牌','Print status card'))));
   if(outputFps){outputFps.classList.add('settings-status-text');outputGroup.append(outputFps);}
   const qualityGroup=group(t('画质与性能','Quality and performance'));
   put(qualityGroup,put(make('div','settings-fields-grid'),field(preset,t('画质预设','Quality preset'),{name:'quality-preset'}),field(fps,t('目标帧率','Target frame rate'),{name:'target-fps'})));
   if(presetNote){presetNote.classList.add('settings-status-text');qualityGroup.append(presetNote);}
   put(qualityGroup,toggle(smooth,t('流畅优先','Prefer smooth rendering'),smoothDescription));
   const advanced=disclosure(t('高级渲染参数','Advanced rendering'));
   put(advanced.body,put(make('div','settings-fields-grid'),field(quality,t('渲染精细度','Render detail'),{name:'render-detail'}),field(aa,t('抗锯齿','Anti-aliasing'),{name:'anti-alias'})),renderNote,helpNotes);
   qualityGroup.append(advanced.details);
   const cameraGroup=group(t('机位管理','Saved views'),'settings-camera-group');
   if(cameraBar){const oldLabel=cameraBar.querySelector(':scope > span');oldLabel?.remove();cameraBar.classList.add('settings-camera-list');cameraGroup.append(cameraBar);}
   if(cameraActions){cameraActions.classList.add('settings-camera-actions');cameraGroup.append(cameraActions);}
   const capture=disclosure(t('采集兼容与诊断','Capture compatibility and diagnostics'),'settings-compatibility');
   put(capture.body,compatibility,compatibilityNote);
   put(panel,outputGroup,qualityGroup,cameraGroup,capture.details);
   finish(visual,panel);
  }
 }

 const audio=panes.audio;
 if(audio&&audio.dataset.settingsArranged!=='true'){
  const volume=[...audio.querySelectorAll('input[type="range"]')].find(input=>input.id!=='speech-rate');
  const voice=audio.querySelector('#speech-voice'),rate=audio.querySelector('#speech-rate');
  const speechToggle=audio.querySelector('#speech-toggle'),testVoice=audio.querySelector('#speech-test');
  if(volume&&voice&&rate&&speechToggle&&testVoice){
   const soundBar=volume.closest('label')?.parentElement;
   const soundButton=soundBar?.querySelector('button');
   const audioStatus=soundBar?.querySelector(':scope > span');
   const speechPanel=speechToggle.parentElement?.parentElement;
   const welcome=speechPanel?[...speechPanel.querySelectorAll('button')].find(button=>![speechToggle,testVoice].includes(button)):null;
   const caption=audio.querySelector('#speech-caption');
   const diagnostics=[...audio.querySelectorAll(':scope > details')].find(details=>details.querySelector('audio'));
   const panel=make('div','settings-panel settings-audio-panel');
   const effects=group(t('打印音效','Printing sound effects'));
   put(effects,put(make('div','settings-fields-grid'),action(soundButton,t('音效开关','Sound effects')),field(volume,t('音效音量','Effect volume'),{name:'effect-volume'})));
   if(audioStatus){audioStatus.classList.add('settings-status-text');effects.append(audioStatus);}
   const speech=group(t('互动播报','Interaction voice'));
   put(speech,put(make('div','settings-fields-grid'),action(speechToggle,t('播报开关','Voice playback')),field(rate,t('语速','Speech rate'),{name:'speech-rate'}),field(voice,t('播报声音','Voice'),{wide:true,name:'speech-voice'})),put(make('div','settings-voice-actions'),testVoice,welcome),caption);
   speech.append(make('p','settings-hint',t('礼物答谢与进场欢迎的触发开关，在「打印规则」中分别设置。','Gift thanks and join welcomes can be enabled separately under Print rules.')));
   put(panel,effects,speech);
   if(diagnostics){
    diagnostics.classList.add('settings-disclosure','settings-audio-diagnostics');diagnostics.open=false;
    const summary=diagnostics.querySelector(':scope > summary');
    const controls=[...diagnostics.children].filter(node=>node!==summary);
    const body=put(make('div','settings-details-body'),controls);
    const player=body.querySelector('audio');
    if(player){player.classList.add('settings-audio-player');player.style.width='100%';}
    diagnostics.append(body);panel.append(diagnostics);
   }
   finish(audio,panel);
  }
 }

 const connection=panes.connection;
 if(connection&&connection.dataset.settingsArranged!=='true'){
  const room=connection.querySelector('#live-room'),capture=connection.querySelector('#live-fetch'),context=connection.querySelector('#yield-note');
  if(room&&capture){
   const panel=make('div','settings-panel settings-connection-panel');
   const status=group(t('连接状态','Connection status'));
   const grid=make('div','settings-status-grid');
   const roomCard=put(make('div','settings-status-card'),make('h4','',t('当前直播间','Current room')),room);
   room.dataset.emptyLabel=t('尚未连接直播间','No room connected');
   const captureCard=put(make('div','settings-status-card'),make('h4','',t('抓取状态','Capture status')),capture);
   put(grid,roomCard,captureCard);status.append(grid);
   if(context)status.append(put(make('div','settings-context-status'),context));
   const setup=group(t('连接操作','Connection controls'));
   const originalNotes=[...connection.querySelectorAll(':scope > p')];
   const steps=make('ol','settings-connection-steps');
   for(const description of [t('在主工作台输入直播间号或链接，然后点击「切换」。','Enter a room ID or link on the workbench and select Set.'),t('打开直播间窗口，自行完成登录。','Open the live-room window and sign in.'),t('点击「开始抓取」，回到这里查看数据状态。','Start capture, then check the live status here.')])steps.append(make('li','',description));
   put(setup,steps,originalNotes);
   put(panel,status,setup);
   finish(connection,panel);
  }
 }
 for(const pane of Object.values(panes))if(pane?.dataset.settingsArranged==='true')pane.closest('.workspace-drawer')?.classList.add('settings-enhanced-drawer');
}
