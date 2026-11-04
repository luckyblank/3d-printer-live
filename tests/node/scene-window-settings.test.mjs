import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createSceneWindowSettings,mountSceneWindowSettings,SCENE_SETTINGS_KEY} from '../../scene-window-settings.mjs';
import {DEFAULT_SCENE_SETTINGS,normalizeSceneSnapshot} from '../../scene-window-model.mjs';

function fixture(saved){
 const messages=[],writes=[],timers=new Map();let time=0,connected=false,reads=0,nextTimer=0;
 const store={getItem:key=>key===SCENE_SETTINGS_KEY?saved:null,setItem:(key,value)=>writes.push([key,value])};
 let snapshot={lang:'zh-CN',waiting:3,rules:{giftEnabled:true,heartCount:2}};
 const controller=createSceneWindowSettings({storage:store,send:message=>messages.push(message),isConnected:()=>connected,getSnapshot:()=>{reads++;return snapshot;},getLanguage:()=>snapshot.lang,now:()=>time,setInterval:(fn,delay)=>{assert.equal(delay,500);timers.set(++nextTimer,fn);return nextTimer;},clearInterval:id=>timers.delete(id)});
 return {controller,messages,writes,timers,get reads(){return reads;},states:()=>messages.filter(m=>m.type==='view-overlay-state'),settings:()=>messages.filter(m=>m.type==='view-settings'),connect:value=>{connected=value;},change:value=>{snapshot=value;},at:value=>{time=value;},tick(value){time=value;for(const fn of timers.values())fn();}};
}

test('defaults are complete and no live state is read or sent without a viewer',()=>{
 const f=fixture();assert.deepEqual(f.controller.getSettings(),DEFAULT_SCENE_SETTINGS);
 assert.deepEqual(f.messages,[{type:'view-settings',settings:{...DEFAULT_SCENE_SETTINGS}}]);
 f.tick(500);f.tick(1000);assert.equal(f.reads,0);assert.equal(f.states().length,0);assert.equal(f.writes.length,0);
});
test('stored false values survive reopening, including always on top',()=>{
 const saved={onTop:false,showQueue:true,showGiftRules:false,showCurrent:true,showStats:false};
 const f=fixture(JSON.stringify(saved));assert.deepEqual(f.controller.getSettings(),{...DEFAULT_SCENE_SETTINGS,...saved});
 assert.deepEqual(f.settings()[0].settings,{...DEFAULT_SCENE_SETTINGS,...saved});
});
test('invalid storage is normalized and unavailable storage does not block startup or changes',()=>{
 for(const saved of ['broken','null','[]','{"onTop":"false","showQueue":true,"unknown":true}']){
  const f=fixture(saved);assert.equal(f.controller.getSettings().onTop,true);assert.equal('unknown'in f.controller.getSettings(),false);
 }
 const controller=createSceneWindowSettings({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}},setInterval:()=>0,clearInterval:()=>{}});
 assert.doesNotThrow(()=>controller.update({onTop:false}));assert.equal(controller.getSettings().onTop,false);controller.destroy();
});
test('one setting change keeps every other saved preference and persists the full bounded object',()=>{
 const f=fixture();f.controller.update({showQueue:true});
 assert.deepEqual(f.controller.getSettings(),{...DEFAULT_SCENE_SETTINGS,showQueue:true});
 assert.deepEqual(f.writes,[[SCENE_SETTINGS_KEY,JSON.stringify({...DEFAULT_SCENE_SETTINGS,showQueue:true})]]);
 f.controller.update({showQueue:true});assert.equal(f.writes.length,1);
 f.controller.update({showQueue:'false',extra:true});assert.equal(f.controller.getSettings().showQueue,true);assert.equal(f.writes.length,1);
});
test('preference copies cannot mutate controller state and subscribers can detach',()=>{
 const f=fixture(),received=[];const dispose=f.controller.subscribe(value=>received.push(value));
 f.controller.getSettings().onTop=false;assert.equal(f.controller.getSettings().onTop,true);
 f.controller.update({onTop:false});assert.equal(received.length,1);dispose();f.controller.update({onTop:true});assert.equal(received.length,1);
});
test('initial viewer sync resends settings and state without waiting for a render frame',()=>{
 const f=fixture();f.connect(true);f.controller.viewerReady();
 assert.equal(f.settings().length,2);assert.equal(f.states().length,1);
 assert.deepEqual(f.states()[0].snapshot,normalizeSceneSnapshot({lang:'zh-CN',waiting:3,rules:{giftEnabled:true,heartCount:2}}));
});
test('snapshot rate never exceeds 2 Hz, including forced viewer sync and setting changes',()=>{
 const f=fixture();f.connect(true);f.controller.viewerReady();
 f.change({waiting:4});f.at(100);f.controller.viewerReady();f.controller.update({showQueue:true});f.tick(499);
 assert.equal(f.states().length,1);f.tick(500);assert.equal(f.states().length,2);assert.equal(f.states()[1].snapshot.waiting,4);
 f.change({waiting:5});f.at(501);f.controller.publishSnapshot();f.tick(999);assert.equal(f.states().length,2);f.tick(1000);assert.equal(f.states().length,3);
});
test('identical state is not republished even across many polling ticks',()=>{
 const f=fixture();f.connect(true);for(let t=0;t<=10000;t+=500)f.tick(t);
 assert.equal(f.states().length,1);
});
test('closing all overlays sends one clear and stops reading avatar/progress state',()=>{
 const f=fixture();f.connect(true);f.tick(0);assert.equal(f.reads,1);
 f.at(100);f.controller.update({showQueue:false,showGiftRules:false,showCurrent:false,showStats:false});f.tick(500);
 assert.equal(f.reads,1);assert.equal(f.states().length,2);assert.deepEqual(f.states()[1].snapshot,normalizeSceneSnapshot({lang:'zh-CN'}));
 for(let t=1000;t<=10000;t+=500)f.tick(t);assert.equal(f.reads,1);assert.equal(f.states().length,2);
 f.controller.update({showStats:true});assert.equal(f.reads,2);assert.equal(f.states().length,3);
});
test('clear snapshots keep the English viewer language',()=>{
 const f=fixture(JSON.stringify({showGiftRules:false}));f.change({lang:'en'});f.connect(true);f.tick(0);
 assert.equal(f.reads,0);assert.equal(f.states()[0].snapshot.lang,'en');
});
test('reconnected viewers get an unchanged snapshot again while disconnected timers stay idle',()=>{
 const f=fixture();f.connect(true);f.tick(0);f.connect(false);f.tick(500);assert.equal(f.reads,1);
 f.connect(true);f.controller.viewerReady();assert.equal(f.states().length,2);assert.equal(f.reads,2);
});
test('send failure does not consume dedup state or the next retry',()=>{
 let time=0,fail=true,callback;const sent=[];
 const controller=createSceneWindowSettings({storage:null,isConnected:()=>true,now:()=>time,getSnapshot:()=>({printed:3}),send:m=>{if(m.type==='view-overlay-state'&&fail)throw Error('connection gone');sent.push(m);},setInterval:fn=>(callback=fn,1),clearInterval:()=>{}});
 assert.equal(controller.publishSnapshot(),false);fail=false;time=500;callback();assert.equal(sent.filter(m=>m.type==='view-overlay-state').length,1);controller.destroy();
});
test('destroy clears its timer, subscriptions and future publications',()=>{
 const f=fixture();f.connect(true);let changes=0;f.controller.subscribe(()=>changes++);f.controller.destroy();
 f.controller.update({showQueue:true});f.controller.viewerReady();f.controller.publishSnapshot();
 assert.equal(f.timers.size,0);assert.equal(changes,0);assert.equal(f.messages.length,1);
});

class Element {
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.listeners=new Map();this.textContent='';}
 append(...children){this.children.push(...children);}
 setAttribute(key,value){this.attributes[key]=String(value);}
 addEventListener(type,fn){this.listeners.set(type,fn);}
 change(value){if(this.type==='checkbox')this.checked=value;else this.value=String(value);this.listeners.get('change')?.({target:this});}
 input(value){this.value=String(value);this.listeners.get('input')?.({target:this});}
}
const descendants=node=>[node,...node.children.flatMap(descendants)];
const switchKeys=['onTop','showQueue','showGiftRules','showCurrent','showStats'];
function mountedFixture(en=false,saved){
 const f=fixture(saved),pane=new Element('div'),document={createElement:tag=>new Element(tag)};
 const dispose=mountSceneWindowSettings(pane,f.controller,{en,document}),nodes=descendants(pane);
 return {...f,pane,document,dispose,nodes,byId:id=>nodes.find(node=>node.id===id)};
}
const panelSpecs=[
 {prefix:'queue',visible:'showQueue',x:100,y:0},
 {prefix:'rules',visible:'showGiftRules',x:0,y:100},
 {prefix:'current',visible:'showCurrent',x:100,y:100},
 {prefix:'stats',visible:'showStats',x:0,y:0}
];
for(const en of [false,true]){
 test(`settings panel has five switches, four collapsed style groups and unique labels (${en?'en':'zh'})`,()=>{
  const f=mountedFixture(en),switches=f.nodes.filter(n=>n.tagName==='INPUT'&&n.type==='checkbox'),labels=f.nodes.filter(n=>n.tagName==='LABEL');
  assert.equal(switches.length,5);assert.equal(new Set(switches.map(n=>n.id)).size,5);
  assert.ok(switches.every(input=>labels.some(label=>label.htmlFor===input.id)&&input.attributes.role==='switch'));
  assert.deepEqual(switches.map(input=>input.checked),switchKeys.map(key=>DEFAULT_SCENE_SETTINGS[key]));
  const details=f.nodes.filter(n=>n.tagName==='DETAILS');assert.equal(details.length,4);assert.ok(details.every(n=>!n.open));
  assert.equal(f.nodes.filter(n=>n.type==='range').length,16);assert.equal(f.nodes.filter(n=>n.tagName==='SELECT').length,4);
  const ids=f.nodes.filter(n=>n.id).map(n=>n.id);assert.equal(ids.length,new Set(ids).size);
  switches[0].change(false);assert.equal(f.controller.getSettings().onTop,false);
  f.controller.update({showQueue:true});assert.equal(switches[1].checked,true);
  assert.ok(f.nodes.some(n=>n.textContent.includes(en?'Browser popups do not support':'浏览器弹窗不支持')));
  mountSceneWindowSettings(f.pane,f.controller,{en,document:f.document});assert.equal(descendants(f.pane).filter(n=>n.type==='checkbox').length,5);f.dispose();
 });
 for(const {prefix,visible,x:defaultX,y:defaultY}of panelSpecs){
  const xKey=prefix+'X',yKey=prefix+'Y',opacityKey=prefix+'Opacity',scaleKey=prefix+'Scale';
  const id=suffix=>'scene-window-'+prefix+'-'+suffix;
  test(`${prefix} starts at its existing corner with 0..100 position/opacity and 60..160 scale (${en?'en':'zh'})`,()=>{
   const f=mountedFixture(en),details=f.byId(id('style')),select=f.byId(id('position'));
   assert.ok(!details.open);assert.equal(select.children.length,10);assert.equal(select.value,defaultX+','+defaultY);
   assert.equal(select.children.at(-1).textContent,en?'Custom':'自定义');assert.equal(select.children[0].textContent,en?'Top left':'左上');
   for(const key of ['x','y','opacity','scale']){
    const input=f.byId(id(key));assert.equal(input.type,'range');assert.equal(input.min,key==='scale'?'60':'0');assert.equal(input.max,key==='scale'?'160':'100');assert.equal(input.step,'1');
    assert.ok(f.nodes.some(node=>node.tagName==='LABEL'&&node.htmlFor===input.id));
   }
   assert.equal(f.byId(id('opacity')).value,'90');assert.equal(f.byId(id('scale')).value,'100');
   const values=descendants(details).filter(node=>node.tagName==='OUTPUT').map(node=>node.textContent);assert.ok(values.includes('90%'));assert.ok(values.includes('100%'));f.dispose();
  });
  test(`${prefix} presets change only its x/y and publish the complete 21-field settings (${en?'en':'zh'})`,()=>{
   const saved={...DEFAULT_SCENE_SETTINGS,onTop:false,showQueue:true,showCurrent:true,[visible]:true,[opacityKey]:23,[scaleKey]:127};
   const f=mountedFixture(en,JSON.stringify(saved)),select=f.byId(id('position'));
   for(const [x,y]of [[0,0],[50,0],[100,0],[0,50],[50,50],[100,50],[0,100],[50,100],[100,100]]){
    const before=f.controller.getSettings(),previous=f.writes.length;select.change(x+','+y);
    assert.deepEqual(f.controller.getSettings(),{...saved,[xKey]:x,[yKey]:y});
    assert.equal(f.byId(id('x')).value,String(x));assert.equal(f.byId(id('y')).value,String(y));assert.equal(select.value,x+','+y);
    assert.equal(f.writes.length,previous+Number(before[xKey]!==x||before[yKey]!==y));assert.equal(Object.keys(f.settings().at(-1).settings).length,21);
   }
   const previous=f.writes.length;select.change('custom');assert.equal(f.writes.length,previous);assert.equal(f.controller.getSettings()[xKey],100);f.dispose();
  });
  test(`${prefix} fine tuning matches a preset or custom and refreshes percentage labels (${en?'en':'zh'})`,()=>{
   const f=mountedFixture(en,JSON.stringify({...DEFAULT_SCENE_SETTINGS,[visible]:true})),select=f.byId(id('position')),x=f.byId(id('x')),y=f.byId(id('y'));
   x.input(37);y.input(64);assert.equal(select.value,'custom');assert.equal(f.controller.getSettings()[xKey],37);assert.equal(f.controller.getSettings()[yKey],64);
   assert.equal(x.attributes['aria-valuetext'],'37%');assert.equal(y.attributes['aria-valuetext'],'64%');
   assert.ok(descendants(f.byId(id('style'))).some(node=>node.tagName==='OUTPUT'&&node.textContent==='37%'));
   x.input(50);y.input(50);assert.equal(select.value,'50,50');assert.equal(f.controller.getSettings()[opacityKey],90);
   assert.equal(f.byId(id('style')).children[0].children[1].textContent,(en?'Center':'居中')+' · 100%');f.dispose();
  });
  test(`${prefix} opacity endpoints persist independently without changing other panels (${en?'en':'zh'})`,()=>{
   const saved={...DEFAULT_SCENE_SETTINGS,onTop:false,showQueue:true,showCurrent:true,showStats:true,[visible]:true,[xKey]:18,[yKey]:73,[scaleKey]:119};
   const f=mountedFixture(en,JSON.stringify(saved)),opacity=f.byId(id('opacity'));
   for(const value of [0,100]){
    opacity.input(value);const expected={...saved,[opacityKey]:value};
    assert.deepEqual(f.controller.getSettings(),expected);assert.deepEqual(JSON.parse(f.writes.at(-1)[1]),expected);assert.deepEqual(f.settings().at(-1),{type:'view-settings',settings:expected});
    assert.equal(opacity.attributes['aria-valuetext'],value+'%');
   }
   const reopened=fixture(f.writes.at(-1)[1]);assert.equal(reopened.controller.getSettings()[opacityKey],100);assert.equal(reopened.controller.getSettings()[scaleKey],119);f.dispose();
  });
  test(`${prefix} scale 60/100/160 persists independently and updates its collapsed summary (${en?'en':'zh'})`,()=>{
   const saved={...DEFAULT_SCENE_SETTINGS,onTop:false,showQueue:true,showCurrent:true,showStats:true,[visible]:true,[xKey]:18,[yKey]:73,[opacityKey]:0};
   const f=mountedFixture(en,JSON.stringify(saved)),scale=f.byId(id('scale'));
   for(const value of [60,100,160]){
    scale.input(value);const expected={...saved,[scaleKey]:value};
    assert.deepEqual(f.controller.getSettings(),expected);assert.deepEqual(JSON.parse(f.writes.at(-1)[1]),expected);assert.deepEqual(f.settings().at(-1),{type:'view-settings',settings:expected});
    assert.equal(scale.attributes['aria-valuetext'],value+'%');assert.equal(f.byId(id('style')).children[0].children[1].textContent,(en?'Custom':'自定义')+' · '+value+'%');
   }
   assert.equal(fixture(f.writes.at(-1)[1]).controller.getSettings()[scaleKey],160);f.dispose();
  });
  test(`${prefix} off disables only its controls, retaining every panel preference (${en?'en':'zh'})`,()=>{
   const saved={...DEFAULT_SCENE_SETTINGS,onTop:false,showQueue:true,showGiftRules:true,showCurrent:true,showStats:true,[xKey]:27,[yKey]:82,[opacityKey]:0,[scaleKey]:137};
   const f=mountedFixture(en,JSON.stringify(saved)),toggle=f.byId('scene-window-'+visible.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())),fieldset=f.byId(id('style')).children[1],select=f.byId(id('position')),x=f.byId(id('x'));
   toggle.change(false);assert.equal(fieldset.disabled,true);assert.equal(select.disabled,true);assert.equal(x.disabled,true);assert.equal(f.byId(id('scale')).disabled,true);
   for(const other of panelSpecs.filter(panel=>panel.prefix!==prefix))assert.equal(f.byId('scene-window-'+other.prefix+'-style').children[1].disabled,false);
   assert.deepEqual(f.controller.getSettings(),{...saved,[visible]:false});
   select.change('100,0');x.input(100);f.byId(id('scale')).input(160);assert.equal(f.controller.getSettings()[xKey],27);assert.equal(f.controller.getSettings()[scaleKey],137);
   toggle.change(true);assert.equal(fieldset.disabled,false);assert.equal(select.disabled,false);assert.equal(x.value,'27');assert.equal(f.byId(id('opacity')).value,'0');assert.equal(f.byId(id('scale')).value,'137');
   assert.deepEqual(f.controller.getSettings(),saved);f.dispose();
  });
 }
}
test('old five-field storage receives all style defaults without resetting saved off preferences',()=>{
 const saved={onTop:false,showQueue:true,showGiftRules:false,showCurrent:true,showStats:false};
 const f=mountedFixture(false,JSON.stringify(saved)),expected={...DEFAULT_SCENE_SETTINGS,...saved};
 assert.deepEqual(f.controller.getSettings(),expected);assert.equal(Object.keys(expected).length,21);
 assert.equal(f.byId('scene-window-rules-style').children[1].disabled,true);assert.equal(f.byId('scene-window-rules-position').value,'0,100');
 f.byId('scene-window-show-gift-rules').change(true);
 assert.deepEqual(JSON.parse(f.writes.at(-1)[1]),{...expected,showGiftRules:true});f.dispose();
});
test('old eight-field storage preserves customized rule placement and zero opacity while adding scales and other panel defaults',()=>{
 const saved={onTop:false,showQueue:true,showGiftRules:false,showCurrent:true,showStats:false,rulesX:23,rulesY:77,rulesOpacity:0};
 const f=mountedFixture(false,JSON.stringify(saved)),expected={...DEFAULT_SCENE_SETTINGS,...saved};
 assert.deepEqual(f.controller.getSettings(),expected);assert.equal(f.byId('scene-window-rules-position').value,'custom');
 assert.equal(f.byId('scene-window-rules-opacity').value,'0');assert.equal(f.byId('scene-window-rules-scale').value,'100');
 f.byId('scene-window-show-gift-rules').change(true);assert.deepEqual(f.settings().at(-1).settings,{...expected,showGiftRules:true});f.dispose();
});
test('style-only changes use settings messages and do not dirty unchanged live snapshots',()=>{
 const f=fixture();f.connect(true);f.tick(0);
 f.at(500);f.controller.update({rulesX:25,rulesY:75,rulesOpacity:0});f.tick(1000);
 assert.equal(f.states().length,1);assert.equal(f.settings().length,2);assert.equal(f.settings().at(-1).settings.rulesOpacity,0);
});

for(const file of ['index.html','index-en.html']){
 const source=fs.readFileSync(new URL('../../'+file,import.meta.url),'utf8');
 const start=source.indexOf('function sceneOverlaySnapshot(settings){'),end=source.indexOf('\nconst batchStats=',start);
 assert.ok(start>=0&&end>start);
 const fn=source.slice(start,end);
 const fixtureRules={comment:false,commentCount:3,commentSize:'large',join:true,joinCount:5,joinSize:'small',like:false,likeCount:2,likeSize:'large',follow:true,followCount:4,followSize:'large',gift:true,giftSize:'small',heartCount:5,beerCount:3,lollipopCount:2,otherCount:4};
 function snapshot(settings,patch={}){
  const scope={document:{documentElement:{lang:file==='index-en.html'?'en':'zh-CN'}},count:12,queue:Array.from({length:8},(_,i)=>({name:'Guest '+i,avatar:'./assets/guest.png',size:i%2?'large':'small',priority:i===0})),liveStats:{like:31,comment:7,gift:5},active:{name:'Current guest',avatar:'./assets/current.png',score:88},busy:true,phase:'printing',elapsed:6,printDuration:12,paused:false,printRules:{...fixtureRules},settings,...patch};
  return JSON.parse(JSON.stringify(vm.runInNewContext(fn+'\nsceneOverlaySnapshot(settings)',scope)));
 }
 test(`real snapshot masks all hidden content and uses current rules (${file})`,()=>{
  const value=snapshot(DEFAULT_SCENE_SETTINGS);
  assert.deepEqual(value.current,null);assert.deepEqual(value.queue,[]);assert.equal(value.printed,0);assert.equal(value.waiting,0);assert.equal(value.likes,0);
  assert.deepEqual(value.rules,{commentEnabled:false,commentCount:3,commentSize:'large',joinEnabled:true,joinCount:5,joinSize:'small',likeEnabled:false,likeCount:2,likeSize:'large',followEnabled:true,followCount:4,followSize:'large',giftEnabled:true,giftSize:'small',heartCount:5,beerCount:3,lollipopCount:2,otherCount:4});
  assert.equal(value.lang,file==='index-en.html'?'en':'zh-CN');
 });
 for(const trigger of ['comment','join','like','follow'])for(const enabled of [false,true]){
  test(`real ${trigger} rule publishes its ${enabled?'enabled':'disabled'} state, count and size (${file})`,()=>{
   const configured={...fixtureRules,[trigger]:enabled,[trigger+'Count']:enabled?10:2,[trigger+'Size']:enabled?'large':'small'};
   const value=snapshot(DEFAULT_SCENE_SETTINGS,{printRules:configured});
   assert.equal(Object.keys(value.rules).length,18);
   assert.equal(value.rules[trigger+'Enabled'],enabled);
   assert.equal(value.rules[trigger+'Count'],enabled?10:2);
   assert.equal(value.rules[trigger+'Size'],enabled?'large':'small');
   const normalized=normalizeSceneSnapshot(value).rules;
   assert.equal(normalized[trigger+'Enabled'],enabled);
   assert.equal(normalized[trigger+'Count'],enabled?10:2);
   assert.equal(normalized[trigger+'Size'],enabled?'large':'small');
   assert.equal(value.rules.giftEnabled,true);assert.equal(value.rules.heartCount,5);assert.equal(value.rules.giftSize,'small');
  });
 }
 test(`hidden rules remain masked even when join, like and follow printing are on (${file})`,()=>{
  const value=snapshot({...DEFAULT_SCENE_SETTINGS,showGiftRules:false},{printRules:{...fixtureRules,join:true,like:true,follow:true}});
  assert.equal('rules' in value,false);
 });
 test(`real snapshot bounds queue, keeps actual statistics and conceals future score (${file})`,()=>{
  const settings={...DEFAULT_SCENE_SETTINGS,showQueue:true,showCurrent:true,showStats:true};
  const value=snapshot(settings);assert.equal(value.queue.length,5);assert.equal(value.waiting,8);assert.equal(value.printed,12);assert.equal(value.likes,31);assert.equal(value.comments,7);assert.equal(value.gifts,5);
  assert.equal(value.current.progress,50);assert.equal(value.current.score,null);assert.equal(value.current.status,'printing');assert.equal(value.queue[0].priority,true);
  const complete=snapshot(settings,{phase:'reveal',paused:true});assert.equal(complete.current.score,88);assert.equal(complete.current.progress,100);assert.equal(complete.current.paused,true);
  assert.equal(snapshot(settings,{active:null}).current,null);
  assert.equal(snapshot(settings,{busy:false,phase:'idle'}).current,null);
 });
 test(`opening a small window passes settings to native and marks browser limitations (${file})`,()=>{
  assert.match(source,/open_scene_window\('\/live-view\.html\?scene=1&theme='\+theme,orient,theme,windowSettings\)/);
  assert.match(source,/window\.open\('\.\/live-view\.html\?theme='\+theme\+'&onTop='/);
  assert.match(source,/isConnected:\(\)=>mirrorConnected/);
  assert.match(source,/sceneWindowSettings\?\.destroy\(\);closeViewConnection/);
  assert.match(source,/mountWorkspace\(\{sceneWindowSettings,/);
 });
}
