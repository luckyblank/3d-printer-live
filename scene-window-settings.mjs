import {DEFAULT_SCENE_SETTINGS,normalizeSceneSettings,normalizeSceneSnapshot} from './scene-window-model.mjs';

export const SCENE_SETTINGS_KEY='printer-scene-window-settings';
const overlayKeys=['showQueue','showGiftRules','showCurrent','showStats'];

// The viewer receives small, bounded snapshots at most twice per second. This
// timer is independent of rendering and never reads the queue without a viewer.
export function createSceneWindowSettings({
 storage,send=()=>{},isConnected=()=>false,getSnapshot=()=>({}),
 getLanguage=()=> 'zh-CN',now=()=>Date.now(),setInterval:repeat=globalThis.setInterval,
 clearInterval:cancel=globalThis.clearInterval
}={}){
 if(storage===undefined){try{storage=globalThis.localStorage}catch{}}
 let saved;try{saved=JSON.parse(storage?.getItem(SCENE_SETTINGS_KEY)||'null')}catch{}
 let settings=normalizeSceneSettings(saved),lastJSON=null,lastSentAt=-Infinity,destroyed=false;
 const listeners=new Set();
 const getSettings=()=>({...settings});
 function publishSettings(){
  if(destroyed)return;
  try{send({type:'view-settings',settings:getSettings()})}catch{}
 }
 function publishSnapshot(){
  if(destroyed)return false;
  if(!isConnected()){lastJSON=null;return false;}
  const time=now();if(time-lastSentAt<500)return false;
  try{
   // Turning every overlay off sends one empty state, without building avatars
   // or repeatedly serializing live progress while the image remains clean.
   const source=overlayKeys.some(key=>settings[key])?getSnapshot(getSettings()):{lang:getLanguage()};
   const snapshot=normalizeSceneSnapshot(source),json=JSON.stringify(snapshot);
   if(json===lastJSON)return false;
   send({type:'view-overlay-state',snapshot});lastJSON=json;lastSentAt=time;return true;
  }catch{return false;}
 }
 function update(patch){
  if(destroyed)return getSettings();
  const next=normalizeSceneSettings({...settings,...patch},settings);
  if(JSON.stringify(next)===JSON.stringify(settings))return getSettings();
  settings=next;try{storage?.setItem(SCENE_SETTINGS_KEY,JSON.stringify(settings))}catch{}
  for(const listener of listeners)listener(getSettings());
  publishSettings();publishSnapshot();return getSettings();
 }
 function viewerReady(){lastJSON=null;publishSettings();publishSnapshot();}
 const interval=repeat(publishSnapshot,500);interval?.unref?.();
 publishSettings();
 return {
  getSettings,update,publishSettings,publishSnapshot,viewerReady,
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  destroy(){destroyed=true;cancel(interval);listeners.clear();}
 };
}

// These are new viewer preferences; no engine controls or event handlers move.
export function mountSceneWindowSettings(pane,controller,{en=false,document=globalThis.document}={}){
 if(!pane||pane.dataset.sceneWindowArranged==='true')return;
 const t=(zh,english)=>en?english:zh;
 const make=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;};
 const panel=make('div','settings-panel scene-window-settings');
 const group=title=>{const n=make('section','settings-group scene-window-group');n.append(make('h3','settings-group-title',title));panel.append(n);return n;};
 const controls=new Map(),settings=controller?.getSettings()||DEFAULT_SCENE_SETTINGS;
 function toggle(parent,key,title,description){
  const label=make('label','settings-toggle-row scene-window-toggle');
  const input=make('input');input.type='checkbox';input.id='scene-window-'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());input.checked=settings[key];input.setAttribute('role','switch');
  label.htmlFor=input.id;
  const copy=make('span','settings-toggle-copy',title);copy.append(make('small','settings-hint',description));
  label.append(copy,input);parent.append(label);controls.set(key,input);
  input.addEventListener('change',()=>controller?.update({[key]:input.checked}));
 }
 const windowGroup=group(t('窗口行为','Window behavior'));
 toggle(windowGroup,'onTop',t('窗口置顶','Keep window on top'),t('让直播小窗保持在其他窗口上方。','Keep the output window above other windows.'));
 windowGroup.append(make('p','settings-hint scene-window-platform-note',t('置顶仅适用于桌面端直播小窗，浏览器弹窗不支持。','Always on top applies to the desktop output window. Browser popups do not support it.')));
 const overlays=group(t('画面信息','On-screen information'));
 overlays.append(make('p','scene-window-intro',t('按需叠加到直播画面，关闭后仅保留 3D 场景。','Choose which information appears over the 3D scene.')));
 const positions=[
  [0,0,t('左上','Top left')],[50,0,t('上中','Top center')],[100,0,t('右上','Top right')],
  [0,50,t('左中','Middle left')],[50,50,t('居中','Center')],[100,50,t('右中','Middle right')],
  [0,100,t('左下','Bottom left')],[50,100,t('下中','Bottom center')],[100,100,t('右下','Bottom right')]
 ];
 const panels=[
  {prefix:'queue',visible:'showQueue',title:t('等待队列','Waiting queue'),styleTitle:t('队列位置与样式','Queue position and style'),description:t('显示前 5 个等待打印的头像。','Show up to 5 avatars waiting to print.')},
  {prefix:'rules',visible:'showGiftRules',title:t('互动规则','Interaction rules'),styleTitle:t('规则位置与样式','Rule position and style'),description:t('显示当前评论、礼物对应的打印规则。','Show the current comment and gift printing rules.')},
  {prefix:'current',visible:'showCurrent',title:t('当前任务','Current task'),styleTitle:t('任务位置与样式','Task position and style'),description:t('显示当前头像、打印进度与完成评分。','Show the current avatar, print progress and final score.')},
  {prefix:'stats',visible:'showStats',title:t('本场统计','Session statistics'),styleTitle:t('统计位置与样式','Statistics position and style'),description:t('显示已打印、点赞、评论和礼物数量。','Show print, like, comment and gift counts.')}
 ];
 const syncStyles=[];
 function addPanelStyle({prefix,visible,styleTitle}){
  const xKey=prefix+'X',yKey=prefix+'Y',scaleKey=prefix+'Scale';
  const styleDetails=make('details','settings-disclosure scene-window-panel-style scene-window-'+prefix+'-style');
  styleDetails.id='scene-window-'+prefix+'-style';
  const styleSummary=make('summary');
  const summaryValue=make('span','scene-window-style-summary-value');summaryValue.setAttribute('aria-hidden','true');
  styleSummary.append(make('span','scene-window-style-title',styleTitle),summaryValue);
  const styleBody=make('fieldset','scene-window-style-body');styleBody.setAttribute('aria-label',styleTitle);
  const positionField=make('div','settings-field scene-window-position-field');
  const positionLabel=make('label','settings-field-label',t('快捷位置','Position preset'));
  const positionSelect=make('select','settings-control');positionSelect.id='scene-window-'+prefix+'-position';positionLabel.htmlFor=positionSelect.id;
  for(const [x,y,title]of positions){const option=make('option','',title);option.value=x+','+y;positionSelect.append(option);}
  const customPosition=make('option','',t('自定义','Custom'));customPosition.value='custom';positionSelect.append(customPosition);
  positionSelect.addEventListener('change',()=>{
   if(!controller?.getSettings()[visible])return;
   const preset=positions.find(([x,y])=>x+','+y===positionSelect.value);
   if(preset)controller.update({[xKey]:preset[0],[yKey]:preset[1]});
  });
  positionField.append(positionLabel,positionSelect);styleBody.append(positionField);
  const styleControls=new Map();
  for(const [suffix,title,min,max]of [
   ['X',t('水平位置','Horizontal position'),0,100],['Y',t('垂直位置','Vertical position'),0,100],
   ['Opacity',t('背景不透明度','Background opacity'),0,100],['Scale',t('整体缩放','Overall scale'),60,160]
  ]){
   const key=prefix+suffix,field=make('div','scene-window-range-field'),heading=make('div','scene-window-range-heading');
   const input=make('input','settings-control');input.type='range';input.id='scene-window-'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());input.min=String(min);input.max=String(max);input.step='1';
   const label=make('label','settings-field-label',title);label.htmlFor=input.id;
   const value=make('output','scene-window-range-value');value.setAttribute('for',input.id);value.setAttribute('aria-hidden','true');
   heading.append(label,value);field.append(heading,input);styleBody.append(field);styleControls.set(key,{input,value});
   const change=()=>{if(controller?.getSettings()[visible])controller.update({[key]:Number(input.value)});};
   input.addEventListener('input',change);input.addEventListener('change',change);
  }
  const styleDescription=t('位置按面板可移动范围计算。背景 0% 为透明，100% 为不透明；整体缩放同步调整文字和图标大小。','Position uses the available space around the panel. Background: 0% transparent, 100% solid. Overall scale also resizes text and icons.')+(prefix==='rules'?t('窗口空间不足时，规则面板会自动缩小以完整显示内容。',' When window space is limited, the rules panel automatically scales down to show all its content.'):'');
  const styleNote=make('p','settings-hint scene-window-style-note',styleDescription);
  const disabledNote=make('p','settings-hint scene-window-style-disabled',t('开启该面板后可调整，已有设置会保留。','Enable this panel to adjust these values. Your settings are retained.'));
  styleBody.append(styleNote);styleDetails.append(styleSummary,styleBody,disabledNote);overlays.append(styleDetails);
  function syncStyle(next){
   const enabled=next[visible];styleBody.disabled=!enabled;positionSelect.disabled=!enabled;disabledNote.hidden=enabled;
   const preset=positions.find(([x,y])=>x===next[xKey]&&y===next[yKey]);
   positionSelect.value=preset?next[xKey]+','+next[yKey]:'custom';
   summaryValue.textContent=(preset?preset[2]:t('自定义','Custom'))+' · '+next[scaleKey]+'%';
   for(const [key,{input,value}]of styleControls){input.value=String(next[key]);input.disabled=!enabled;input.setAttribute('aria-valuetext',next[key]+'%');value.textContent=next[key]+'%';}
  }
  syncStyle(settings);syncStyles.push(syncStyle);
 }
 for(const descriptor of panels){toggle(overlays,descriptor.visible,descriptor.title,descriptor.description);addPanelStyle(descriptor);}
 panel.append(make('p','settings-hint scene-window-save-note',t('自动保存，修改后同步到已打开的直播小窗。','Saved automatically and synced to the open output window.')));
 pane.append(panel);pane.dataset.sceneWindowArranged='true';
 const unsubscribe=controller?.subscribe(next=>{for(const [key,input]of controls)input.checked=next[key];for(const sync of syncStyles)sync(next);});
 return()=>unsubscribe?.();
}
