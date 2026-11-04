// Small, bounded display snapshots shared by the workbench and isolated viewer.
export const DEFAULT_SCENE_SETTINGS=Object.freeze({
 onTop:true,showQueue:false,showGiftRules:true,showCurrent:false,showStats:false,
 rulesX:0,rulesY:100,rulesOpacity:90,rulesScale:100,
 queueX:100,queueY:0,queueOpacity:90,queueScale:100,
 currentX:100,currentY:100,currentOpacity:90,currentScale:100,
 statsX:0,statsY:0,statsOpacity:90,statsScale:100
});
const SETTING_KEYS=Object.keys(DEFAULT_SCENE_SETTINGS);
export function normalizeSceneSettings(value,defaults=DEFAULT_SCENE_SETTINGS){
 const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
 return Object.fromEntries(SETTING_KEYS.map(key=>{
  if(typeof DEFAULT_SCENE_SETTINGS[key]==='boolean')return [key,typeof source[key]==='boolean'?source[key]:typeof defaults?.[key]==='boolean'?defaults[key]:DEFAULT_SCENE_SETTINGS[key]];
  const fallback=typeof defaults?.[key]==='number'&&Number.isFinite(defaults[key])?defaults[key]:DEFAULT_SCENE_SETTINGS[key];
  const value=typeof source[key]==='number'&&Number.isFinite(source[key])?source[key]:fallback;
  const scale=key.endsWith('Scale');
  return [key,Math.round(Math.max(scale?60:0,Math.min(scale?160:100,value)))];
 }));
}
const number=(value,fallback,min,max,integer=false)=>{
 const n=typeof value==='number'&&Number.isFinite(value)?value:fallback;
 const bounded=Math.max(min,Math.min(max,n));return integer?Math.floor(bounded):bounded;
};
const text=(value,max)=>typeof value==='string'?Array.from(value.replace(/[\u0000-\u001f\u007f]/g,''))
 .filter(character=>character.length>1||!/[\ud800-\udfff]/.test(character)).slice(0,max).join(''):'';
export function normalizeSceneAvatar(value){
 if(typeof value!=='string'||value.length>65536)return '';
 if(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(value))return value;
 if(value.length<=4096&&/^https?:\/\//i.test(value)){
  try{const url=new URL(value);return !url.username&&!url.password?url.href:'';}catch{return '';}
 }
 if(/^(?:\.\/|\/)assets\/[A-Za-z0-9_./%\-]+$/.test(value)&&!value.includes('..'))return value;
 return '';
}
const count=(value,fallback=0)=>number(value,fallback,0,1e9,true);
const quantity=(value,fallback=1)=>number(value,fallback,1,10,true);
const size=value=>value==='large'?'large':'small';
export function normalizeSceneSnapshot(value){
 const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
 const ruleSource=source.rules&&typeof source.rules==='object'?source.rules:{};
 const current=source.current&&typeof source.current==='object'?source.current:null;
 return {
  lang:source.lang==='en'?'en':'zh-CN',
  printed:count(source.printed),waiting:count(source.waiting),likes:count(source.likes),comments:count(source.comments),gifts:count(source.gifts),
  current:current?{
   name:text(current.name,80),avatar:normalizeSceneAvatar(current.avatar),
   score:typeof current.score==='number'&&Number.isFinite(current.score)?number(current.score,0,0,100):null,
   progress:number(current.progress,0,0,100),status:text(current.status,120),paused:current.paused===true
  }:null,
  queue:(Array.isArray(source.queue)?source.queue:[]).slice(0,5).map(job=>({
   name:text(job?.name,80),avatar:normalizeSceneAvatar(job?.avatar),size:size(job?.size),priority:job?.priority===true
  })),
  rules:{
   commentEnabled:ruleSource.commentEnabled===true,commentCount:quantity(ruleSource.commentCount),commentSize:size(ruleSource.commentSize),
   joinEnabled:ruleSource.joinEnabled===true,joinCount:quantity(ruleSource.joinCount),joinSize:size(ruleSource.joinSize),
   likeEnabled:ruleSource.likeEnabled===true,likeCount:quantity(ruleSource.likeCount),likeSize:size(ruleSource.likeSize),
   followEnabled:ruleSource.followEnabled===true,followCount:quantity(ruleSource.followCount),followSize:size(ruleSource.followSize),
   giftEnabled:ruleSource.giftEnabled===true,giftSize:ruleSource.giftSize==='small'?'small':'large',
   heartCount:quantity(ruleSource.heartCount),beerCount:quantity(ruleSource.beerCount,2),lollipopCount:quantity(ruleSource.lollipopCount,3),otherCount:quantity(ruleSource.otherCount)
  }
 };
}
