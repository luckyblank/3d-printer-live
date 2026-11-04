import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {initialSceneSettings,sceneOverlayContent,createSceneWindowView,mountSceneResizeHandles} from '../../scene-window-view.mjs';
import {DEFAULT_SCENE_SETTINGS} from '../../scene-window-model.mjs';
import {GIFT_ICON_FALLBACKS} from '../../scene-gift-icons.mjs';

class Element{
 constructor(tag,ownerDocument){this.tagName=tag.toUpperCase();this.ownerDocument=ownerDocument;this.children=[];this.dataset={};this.style={setProperty(name,value){this[name]=String(value)},getPropertyValue(name){return this[name]??''}};this.attributes=new Map();this.listeners=new Map();this.hidden=false;this.className='';this.parentNode=null;this._text='';}
 append(...nodes){for(const node of nodes){node.remove?.();node.parentNode=this;this.children.push(node)}}
 replaceChildren(...nodes){for(const child of this.children)child.parentNode=null;this.children=[];this._text='';this.append(...nodes)}
 remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null}}
 setAttribute(name,value){this.attributes.set(name,String(value))}
 getAttribute(name){return this.attributes.get(name)??null}
 addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener)}
 removeEventListener(type,listener){this.listeners.get(type)?.delete(listener)}
 dispatchEvent(event){for(const listener of this.listeners.get(event.type)||[])listener(event);return !event.defaultPrevented}
 set textContent(value){this._text=String(value);this.children=[]}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join(' ')}
}
function documentFixture(){const doc={createElement(tag){return new Element(tag,doc)}};doc.body=new Element('body',doc);return doc;}
const byClass=(root,name)=>[root,...root.children.flatMap(child=>all(child))].filter(node=>node.className.split(' ').includes(name));
const all=root=>[root,...root.children.flatMap(child=>all(child))];
const snapshot=()=>({lang:'zh-CN',printed:8,waiting:12,likes:15,comments:7,gifts:3,
 current:{name:'测试观众',avatar:'javascript:alert(1)',score:null,progress:62,status:'printing',paused:false},
 queue:Array.from({length:8},(_,i)=>({name:'排队观众'+i,avatar:'',size:i%2?'large':'small',priority:i===0})),
 rules:{commentEnabled:true,commentCount:3,commentSize:'large',giftEnabled:true,giftSize:'small',heartCount:5,beerCount:7,lollipopCount:9,otherCount:2}
});

test('initial URL topmost explicitly overrides defaults without touching isolated localStorage',()=>{
 assert.deepEqual(initialSceneSettings('?onTop=0'),{...DEFAULT_SCENE_SETTINGS,onTop:false});
 assert.deepEqual(initialSceneSettings('?onTop=1'),DEFAULT_SCENE_SETTINGS);
 assert.deepEqual(initialSceneSettings('?onTop=false'),DEFAULT_SCENE_SETTINGS);
});

test('display content uses actual enabled rules, configured counts/sizes and portrait queue limits',()=>{
 const data=snapshot(),wide=sceneOverlayContent(data),portrait=sceneOverlayContent(data,{portrait:true});
 assert.equal(wide.queue.length,5);assert.equal(portrait.queue.length,3);assert.equal(portrait.waiting,12);
 assert.deepEqual(wide.giftRows.map(rule=>[rule.count,rule.size]),[[5,'small'],[7,'small'],[9,'small'],[2,'small']]);
 assert.deepEqual(wide.comment,{count:3,size:'large'});
 assert.ok(wide.giftRows.slice(0,3).every(rule=>rule.icon.startsWith('assets/generated/original-icons/')));
 data.rules.giftEnabled=false;assert.equal(sceneOverlayContent(data).giftRows.length,0);
 data.current.paused=true;assert.equal(sceneOverlayContent(data).currentStatus,'已暂停');
});

test('default viewer waits for real rules; toggles, language and theme update display-only overlays',async()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined});
 assert.match(view.element.textContent,/等待主窗口同步规则/);
 assert.equal(byClass(view.element,'scene-overlay-rule').length,0);
 assert.equal(byClass(view.element,'scene-overlay-queue')[0].hidden,true);
 view.applySnapshot(snapshot());
 assert.equal(byClass(view.element,'scene-overlay-rule').length,4);assert.match(view.element.textContent,/小图 × 5/);assert.match(view.element.textContent,/评论 666\s+→ 大图 × 3/);
 await view.applySettings({showQueue:true,showCurrent:true,showStats:true});
 assert.equal(byClass(view.element,'scene-overlay-queue-row').length,5);
 assert.equal(byClass(view.element,'scene-overlay-current')[0].hidden,false);assert.equal(byClass(view.element,'scene-overlay-stats')[0].hidden,false);
 assert.equal(byClass(view.element,'scene-current-score')[0].hidden,true);
 assert.equal(byClass(view.element,'scene-current-progress')[0].getAttribute('aria-valuenow'),'62');
 assert.ok(all(view.element).filter(node=>node.tagName==='IMG').every(img=>!img.src.startsWith('javascript:')));
 view.resize(405,720);assert.equal(byClass(view.element,'scene-overlay-queue-row').length,3);assert.equal(byClass(view.element,'scene-overlay-total')[0].textContent,'12');
 view.resize(960,540);assert.equal(byClass(view.element,'scene-overlay-queue-row').length,5);
 const english=snapshot();english.lang='en';view.applySnapshot(english);view.setTheme('light');
 assert.equal(view.element.dataset.theme,'light');assert.match(view.element.textContent,/Print rules/);assert.match(view.element.textContent,/Small × 5/);
 assert.equal(view.element.style.pointerEvents,'none');
 assert.equal(all(view.element).some(node=>['BUTTON','SELECT','INPUT','A'].includes(node.tagName)),false);
 await view.applySettings({showQueue:false,showCurrent:false,showStats:false,showGiftRules:false});assert.ok(view.element.children.every(card=>card.hidden));
 view.destroy();assert.equal(doc.body.children.length,0);
});

test('gift disabled is explicit and never displays gift quantities as an active promise',()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined}),data=snapshot();data.rules.giftEnabled=false;
 view.applySnapshot(data);assert.match(view.element.textContent,/礼物打印已关闭/);assert.equal(byClass(view.element,'scene-overlay-rule').length,0);
 assert.match(view.element.textContent,/评论 666\s+→ 大图 × 3/);
 data.rules.commentEnabled=false;view.applySnapshot(data);assert.match(view.element.textContent,/互动打印已关闭/);view.destroy();
});

test('inline gift fallbacks contain the exact original bytes of all three shipped PNGs',()=>{
 assert.deepEqual(Object.keys(GIFT_ICON_FALLBACKS),['heart','beer','lollipop']);assert.ok(Object.isFrozen(GIFT_ICON_FALLBACKS));
 for(const [kind,uri]of Object.entries(GIFT_ICON_FALLBACKS)){
  assert.match(uri,/^data:image\/png;base64,/);
  assert.deepEqual(Buffer.from(uri.slice('data:image/png;base64,'.length),'base64'),fs.readFileSync(new URL(`../../assets/generated/original-icons/${kind}.png`,import.meta.url)));
 }
});

test('a failed gift URL switches once to its original inline PNG, persists over rebuilds and retains nodes during style changes',async()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined}),data=snapshot();view.applySnapshot(data);
 let images=byClass(view.element,'scene-rule-icon');assert.deepEqual(images.map(img=>img.src),['heart','beer','lollipop'].map(kind=>`assets/generated/original-icons/${kind}.png`));
 const first=images[0],other=images[1];let src=first.src;const assignments=[];
 Object.defineProperty(first,'src',{get:()=>src,set:value=>{src=value;assignments.push(value)}});
 first.onerror();assert.equal(first.src,GIFT_ICON_FALLBACKS.heart);assert.equal(first.hidden,false);assert.deepEqual(assignments,[GIFT_ICON_FALLBACKS.heart]);assert.equal(other.src,'assets/generated/original-icons/beer.png');
 await view.applySettings({rulesX:100,rulesY:0,rulesOpacity:37,rulesScale:160});data.current.progress++;view.applySnapshot(data);
 assert.equal(byClass(view.element,'scene-rule-icon')[0],first);assert.deepEqual(assignments,[GIFT_ICON_FALLBACKS.heart]);
 data.rules.heartCount++;view.applySnapshot(data);images=byClass(view.element,'scene-rule-icon');assert.notEqual(images[0],first);assert.equal(images[0].src,GIFT_ICON_FALLBACKS.heart);assert.equal(images[1].src,'assets/generated/original-icons/beer.png');
 data.lang='en';view.applySnapshot(data);images=byClass(view.element,'scene-rule-icon');assert.equal(images[0].src,GIFT_ICON_FALLBACKS.heart);
 images[1].onerror();images[2].onerror();assert.equal(images[1].src,GIFT_ICON_FALLBACKS.beer);assert.equal(images[2].src,GIFT_ICON_FALLBACKS.lollipop);
 view.destroy();
});

test('inline decoding failure hides only the broken glyph and never loops or retries during later rule rebuilds',()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined}),data=snapshot();view.applySnapshot(data);
 const image=byClass(view.element,'scene-rule-icon')[0];let src=image.src;const assignments=[];
 Object.defineProperty(image,'src',{get:()=>src,set:value=>{src=value;assignments.push(value)}});
 image.onerror();image.onerror();assert.equal(image.onerror,null);assert.equal(image.style.visibility,'hidden');assert.equal(image.hidden,false);assert.deepEqual(assignments,[GIFT_ICON_FALLBACKS.heart]);
 assert.match(view.element.textContent,/爱心/);assert.match(view.element.textContent,/小图 × 5/);
 data.rules.heartCount=9;data.lang='en';view.applySnapshot(data);
 const rebuilt=byClass(view.element,'scene-rule-icon')[0];assert.equal(rebuilt.style.visibility,'hidden');assert.equal(rebuilt.hidden,false);assert.equal(rebuilt.onerror,null);assert.equal(rebuilt.src,undefined);
 assert.match(view.element.textContent,/Heart/);assert.match(view.element.textContent,/Small × 9/);assert.equal(byClass(view.element,'scene-rule-icon')[1].hidden,false);
 view.destroy();
});

test('comment display emphasizes the requested 666 prefix while actual configured size and quantity remain dynamic',()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined}),data=snapshot();
 for(const [lang,prefix,large,small]of [['zh-CN','评论 666','大图','小图'],['en','Comment 666','Large','Small']]){
  data.lang=lang;data.rules.commentEnabled=true;data.rules.commentSize='large';data.rules.commentCount=3;view.applySnapshot(data);
  let row=byClass(view.element,'scene-overlay-comment')[0];assert.equal(row.children.length,2);
  assert.equal(row.children[0].tagName,'SPAN');assert.ok(row.children[0].className.split(' ').includes('scene-comment-prefix'));assert.equal(row.children[0].textContent,prefix);
  assert.ok(row.children[1].className.split(' ').includes('scene-comment-result'));assert.equal(row.children[1].textContent,` → ${large} × 3`);
  data.rules.commentSize='small';data.rules.commentCount=1;view.applySnapshot(data);
  assert.equal(byClass(view.element,'scene-comment-result')[0].textContent,` → ${small} × 1`);
  row=byClass(view.element,'scene-overlay-comment')[0];const first=row.children[0],second=row.children[1];
  data.current.progress++;view.applySnapshot(data);assert.equal(byClass(view.element,'scene-comment-prefix')[0],first);assert.equal(byClass(view.element,'scene-comment-result')[0],second);
  data.rules.commentEnabled=false;view.applySnapshot(data);assert.equal(byClass(view.element,'scene-overlay-comment').length,0);
 }
 view.destroy();
});

test('rule title, comment prefix and gift amounts share local orange-red colors in both themes',()=>{
 const css=fs.readFileSync(new URL('../../assets/scene-window-view.css',import.meta.url),'utf8');
 assert.match(css,/\.scene-overlay-rules \{[^}]*--scene-rules-accent:#ff795f/);
 assert.match(css,/\[data-theme="light"\] \.scene-overlay-rules \{--scene-rules-accent:#b1472e\}/);
 assert.match(css,/\.scene-overlay-rules :is\(\.scene-overlay-heading h2,\.scene-trigger-prefix,\.scene-rule-amount\) \{color:var\(--scene-rules-accent\)\}/);
 assert.match(css,/\.scene-trigger-result \{color:var\(--scene-text\)\}/);
});

test('enabled comment, join, like and follow rules show their actual counts and sizes in both languages',()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined}),data=snapshot();
 Object.assign(data.rules,{commentEnabled:true,commentCount:1,commentSize:'small',joinEnabled:true,joinCount:2,joinSize:'large',likeEnabled:true,likeCount:3,likeSize:'small',followEnabled:true,followCount:4,followSize:'large'});
 for(const [lang,labels,sizes]of [['zh-CN',['评论 666','进场','点赞','关注'],['小图','大图','小图','大图']],['en',['Comment 666','Join','Like','Follow'],['Small','Large','Small','Large']]]){
  data.lang=lang;const content=sceneOverlayContent(data);
  assert.deepEqual(content.triggers.map(rule=>[rule.kind,rule.count,rule.size]),[['comment',1,'small'],['join',2,'large'],['like',3,'small'],['follow',4,'large']]);
  view.applySnapshot(data);let rows=byClass(view.element,'scene-overlay-trigger');assert.equal(rows.length,4);
  assert.deepEqual(rows.map(row=>row.children[0].textContent),labels);assert.deepEqual(rows.map((row,index)=>row.children[1].textContent),sizes.map((size,index)=>` → ${size} × ${index+1}`));
  const first=rows[1];data.current.progress++;view.applySnapshot(data);assert.equal(byClass(view.element,'scene-overlay-trigger')[1],first);
  data.rules.joinCount=7;data.rules.joinSize='small';view.applySnapshot(data);rows=byClass(view.element,'scene-overlay-trigger');assert.equal(rows[1].children[1].textContent,` → ${lang==='en'?'Small':'小图'} × 7`);
  data.rules.joinCount=2;data.rules.joinSize='large';
 }
 view.destroy();
});

test('disabled triggers are omitted and interaction-off appears only after every trigger and gifts are off',()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined}),data=snapshot();
 Object.assign(data.rules,{commentEnabled:false,joinEnabled:true,joinCount:1,joinSize:'small',likeEnabled:false,followEnabled:true,followCount:2,followSize:'large',giftEnabled:false});
 view.applySnapshot(data);assert.deepEqual(sceneOverlayContent(data).triggers.map(rule=>rule.kind),['join','follow']);
 assert.deepEqual(byClass(view.element,'scene-overlay-trigger').map(row=>row.dataset.trigger),['join','follow']);assert.match(view.element.textContent,/进场\s+→ 小图 × 1/);assert.match(view.element.textContent,/礼物打印已关闭/);assert.doesNotMatch(view.element.textContent,/互动打印已关闭/);
 data.rules.joinEnabled=false;data.rules.followEnabled=false;data.rules.likeEnabled=true;data.rules.likeCount=5;data.rules.likeSize='large';view.applySnapshot(data);
 assert.deepEqual(byClass(view.element,'scene-overlay-trigger').map(row=>row.dataset.trigger),['like']);assert.match(view.element.textContent,/点赞\s+→ 大图 × 5/);assert.doesNotMatch(view.element.textContent,/互动打印已关闭/);
 data.rules.likeEnabled=false;view.applySnapshot(data);assert.equal(byClass(view.element,'scene-overlay-trigger').length,0);assert.match(view.element.textContent,/互动打印已关闭/);
 view.destroy();
});

test('progress updates retain static cards and all unchanged images; current status/score update in place',async()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined}),data=snapshot();
 data.current.avatar='/assets/generated/original-icons/heart.png';data.queue[0].avatar='/assets/generated/original-icons/beer.png';
 await view.applySettings({showQueue:true,showGiftRules:true,showCurrent:true,showStats:true});view.applySnapshot(data);
 const ruleIcon=byClass(view.element,'scene-rule-icon')[0],queueRow=byClass(view.element,'scene-overlay-queue-row')[0],queueAvatar=all(queueRow).find(node=>node.tagName==='IMG');
 const currentAvatar=byClass(view.element,'scene-current-avatar')[0],currentImage=all(currentAvatar).find(node=>node.tagName==='IMG'),progress=byClass(view.element,'scene-current-progress')[0],status=byClass(view.element,'scene-current-status')[0],score=byClass(view.element,'scene-current-score')[0];
 const statValue=byClass(view.element,'scene-stat-primary')[0];
 data.current.progress=74;view.applySnapshot(data);
 assert.equal(byClass(view.element,'scene-rule-icon')[0],ruleIcon);assert.equal(byClass(view.element,'scene-overlay-queue-row')[0],queueRow);assert.equal(all(queueRow).find(node=>node.tagName==='IMG'),queueAvatar);
 assert.equal(byClass(view.element,'scene-current-avatar')[0],currentAvatar);assert.equal(all(currentAvatar).find(node=>node.tagName==='IMG'),currentImage);assert.equal(byClass(view.element,'scene-current-progress')[0],progress);assert.equal(progress.getAttribute('aria-valuenow'),'74');
 assert.equal(byClass(view.element,'scene-stat-primary')[0],statValue);
 data.current.progress=100;data.current.status='reveal';data.current.score=92;view.applySnapshot(data);
 assert.equal(byClass(view.element,'scene-current-status')[0],status);assert.equal(status.textContent,'制作完成');assert.equal(byClass(view.element,'scene-current-score')[0],score);assert.equal(score.textContent,'92分');assert.equal(score.hidden,false);assert.equal(progress.hidden,true);assert.equal(all(currentAvatar).find(node=>node.tagName==='IMG'),currentImage);
 data.waiting=13;view.applySnapshot(data);assert.equal(byClass(view.element,'scene-overlay-queue-row')[0],queueRow);assert.equal(all(queueRow).find(node=>node.tagName==='IMG'),queueAvatar);assert.equal(byClass(view.element,'scene-overlay-total')[0].textContent,'13');
 view.setTheme('light');await view.applySettings({onTop:false});assert.equal(byClass(view.element,'scene-rule-icon')[0],ruleIcon);assert.equal(all(currentAvatar).find(node=>node.tagName==='IMG'),currentImage);
 data.current.name='新观众';view.applySnapshot(data);assert.notEqual(byClass(view.element,'scene-current-avatar')[0],currentAvatar);assert.equal(byClass(view.element,'scene-current-progress')[0],progress);view.destroy();
});

test('independent cards have no grid competition and compact rules retain complete comments and all gift rows',async()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined}),data=snapshot();view.applySnapshot(data);
 assert.equal(view.element.dataset.statsVisible,'false');assert.equal(view.element.dataset.currentVisible,'false');
 await view.applySettings({showQueue:true,showStats:true,showCurrent:true});assert.equal(view.element.dataset.statsVisible,'true');assert.equal(view.element.dataset.currentVisible,'true');
 assert.equal(byClass(view.element,'scene-rule-icon').length,3);assert.equal(byClass(view.element,'scene-overlay-rule-other').length,1);
 await view.applySettings({showStats:false,showCurrent:false});assert.equal(view.element.dataset.statsVisible,'false');assert.equal(view.element.dataset.currentVisible,'false');
 const css=fs.readFileSync(new URL('../../assets/scene-window-view.css',import.meta.url),'utf8');
 assert.match(css,/\.scene-overlay-card \{[^}]*position:absolute;grid-area:auto;[^}]*max-height:calc\(\(100% - 2 \* var\(--scene-panel-margin\)\) \/ var\(--scene-panel-effective-scale\)\)/);
 assert.doesNotMatch(css,/grid-row:|grid-column:|data-stats-visible|data-current-visible/);
 assert.doesNotMatch(css,/[^{}]*(?:scene-overlay-comment|scene-overlay-rule-other)[^{}]*\{[^}]*display:none/);
 assert.match(css,/data-density="tight"[^{}]*\.scene-overlay-rule \{[^}]*min-height:21px/);
 view.destroy();
});

test('each panel position, background opacity and scale update independently without remounting content',async()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined});
 const panels=Object.fromEntries(['rules','queue','current','stats'].map(name=>[name,byClass(view.element,'scene-overlay-'+name)[0]]));
 const values=card=>['x','y','opacity','scale'].map(key=>card.style.getPropertyValue('--scene-panel-'+key));
 assert.deepEqual(values(panels.rules),['0','1','0.9','1']);assert.deepEqual(values(panels.queue),['1','0','0.9','1']);
 assert.deepEqual(values(panels.current),['1','1','0.9','1']);assert.deepEqual(values(panels.stats),['0','0','0.9','1']);
 await view.applySettings({showQueue:true,showCurrent:true,showStats:true});view.applySnapshot(snapshot());
 const rules=panels.rules,icons=byClass(rules,'scene-rule-icon'),heading=byClass(rules,'scene-overlay-heading')[0],queue=byClass(view.element,'scene-overlay-queue-row')[0],current=byClass(view.element,'scene-current-person')[0],stats=byClass(view.element,'scene-stat-primary')[0];
 for(const panel of Object.keys(panels))for(const [x,y,opacity,scale]of [[0,0,0,60],[100,0,100,160],[0,100,90,100],[100,100,0,160],[50,50,37,85]]){
  const prior=Object.fromEntries(Object.entries(panels).map(([name,card])=>[name,values(card)]));
  await view.applySettings({[panel+'X']:x,[panel+'Y']:y,[panel+'Opacity']:opacity,[panel+'Scale']:scale});
  assert.deepEqual(values(panels[panel]),[x,y,opacity,scale].map(value=>String(value/100)));
  for(const [name,card]of Object.entries(panels))if(name!==panel)assert.deepEqual(values(card),prior[name]);
  assert.deepEqual(byClass(rules,'scene-rule-icon'),icons);assert.equal(byClass(rules,'scene-overlay-heading')[0],heading);
  assert.equal(byClass(view.element,'scene-overlay-queue-row')[0],queue);assert.equal(byClass(view.element,'scene-current-person')[0],current);assert.equal(byClass(view.element,'scene-stat-primary')[0],stats);
 }
 await view.applySettings({showGiftRules:false});await view.applySettings({rulesX:100,rulesY:0,rulesOpacity:0});await view.applySettings({showGiftRules:true});
 assert.deepEqual(byClass(rules,'scene-rule-icon'),icons);assert.deepEqual(values(rules),['1','0','0','0.85']);
 view.setTheme('light');view.resize(405,720);assert.deepEqual(byClass(rules,'scene-rule-icon'),icons);assert.equal(rules.style.opacity,undefined);
 for(const card of Object.values(panels))assert.equal(card.style.opacity,undefined);
 view.destroy();
});

test('density follows each scaled viewport on same-orientation resize without hiding full rules or replacing their PNGs',async()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined,width:960,height:540});
 await view.applySettings({showQueue:true,showCurrent:true,showStats:true});view.applySnapshot(snapshot());
 const panels=Object.fromEntries(['rules','queue','current','stats'].map(name=>[name,byClass(view.element,'scene-overlay-'+name)[0]])),icons=byClass(view.element,'scene-rule-icon');
 assert.ok(Object.values(panels).every(card=>card.dataset.density==='normal'));
 await view.applySettings({rulesScale:160});assert.equal(panels.rules.dataset.density,'compact');assert.equal(panels.stats.dataset.density,'normal');
 view.resize(480,270);assert.equal(panels.rules.dataset.density,'tight');assert.equal(panels.queue.dataset.density,'compact');
 await view.applySettings({queueScale:160,currentScale:160,statsScale:160});assert.ok(Object.values(panels).every(card=>card.dataset.density==='tight'));
 assert.equal(byClass(view.element,'scene-comment-prefix')[0].textContent,'评论 666');assert.equal(byClass(view.element,'scene-overlay-rule').length,4);
 view.resize(405,720);assert.ok(Object.values(panels).every(card=>card.dataset.density==='normal'));assert.deepEqual(byClass(view.element,'scene-rule-icon'),icons);
 view.resize(500,600);assert.ok(Object.values(panels).every(card=>card.dataset.density==='compact'));assert.deepEqual(byClass(view.element,'scene-rule-icon'),icons);
 view.destroy();
});

test('shared card CSS anchors account for effective scaled dimensions at every corner without content opacity',()=>{
 const css=fs.readFileSync(new URL('../../assets/scene-window-view.css',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../../scene-window-view.mjs',import.meta.url),'utf8');
 const card=css.match(/\.scene-overlay-card \{([^}]+)\}/)[1];
 assert.match(card,/left:calc\(var\(--scene-panel-margin\) \+ \(100% - 2 \* var\(--scene-panel-margin\)\) \* var\(--scene-panel-x\)\)/);
 assert.match(card,/top:calc\(var\(--scene-panel-margin\) \+ \(100% - 2 \* var\(--scene-panel-margin\)\) \* var\(--scene-panel-y\)\)/);
 assert.match(card,/transform:translate\(calc\(-100% \* var\(--scene-panel-x\)\),calc\(-100% \* var\(--scene-panel-y\)\)\) scale\(var\(--scene-panel-effective-scale\)\)/);
 assert.match(card,/transform-origin:calc\(100% \* var\(--scene-panel-x\)\) calc\(100% \* var\(--scene-panel-y\)\)/);
 assert.match(card,/max-width:calc\(\(100% - 2 \* var\(--scene-panel-margin\)\) \/ var\(--scene-panel-effective-scale\)\)/);
 assert.match(card,/max-height:calc\(\(100% - 2 \* var\(--scene-panel-margin\)\) \/ var\(--scene-panel-effective-scale\)\)/);
 assert.match(card,/background:rgba\(var\(--scene-panel-rgb\),var\(--scene-panel-opacity\)\)/);
 assert.match(card,/--scene-line:rgba\(var\(--scene-border-rgb\),calc\(var\(--scene-panel-opacity\) \* \.2\)\)/);
 assert.doesNotMatch(card,/(?:^|;)\s*opacity:/);assert.doesNotMatch(js,/getBoundingClientRect|offsetWidth|offsetHeight|clientWidth|clientHeight/);
 assert.match(css,/\[data-theme="light"\][^\n]*--scene-panel-rgb:250,249,246/);
 assert.match(css,/\[data-orientation="portrait"\] \{--scene-panel-margin:10px;--scene-panel-gap:10px\}/);
 assert.doesNotMatch(css,/max-width:100%/);
 // Apply the CSS transform matrix, including its percentage origin, to boxes
 // capped before scaling. All anchors keep both visual edges inside margins.
 for(const [width,height,baseWidth,baseHeight,margin]of [[960,540,260,210,12],[405,720,187.5,202,10],[480,270,260,145,12],[270,270,260,145,12]]){
  for(const scale of [.6,1,1.6])for(const x of [0,.37,.5,1])for(const y of [0,.63,.5,1]){
   const w=Math.min(baseWidth,(width-2*margin)/scale),h=Math.min(baseHeight,(height-2*margin)/scale);
   const originX=x*w,originY=y*h,translateX=-x*w,translateY=-y*h;
   const left=margin+(width-2*margin)*x+originX+translateX-scale*originX,top=margin+(height-2*margin)*y+originY+translateY-scale*originY;
   assert.ok(left>=margin-1e-9&&left+w*scale<=width-margin+1e-9);assert.ok(top>=margin-1e-9&&top+h*scale<=height-margin+1e-9);
  }
 }
});

test('all eight rule rows fit a 270px-high window at requested 160% with one measurement only on meaningful changes',async()=>{
 const doc=documentFixture(),view=createSceneWindowView({root:doc.body,api:()=>undefined}),data=snapshot(),card=byClass(view.element,'scene-overlay-rules')[0];let reads=0;
 Object.defineProperty(card,'scrollHeight',{get(){reads++;return 238}});
 Object.assign(data.rules,{joinEnabled:true,joinCount:1,joinSize:'small',likeEnabled:true,likeCount:2,likeSize:'large',followEnabled:true,followCount:3,followSize:'small'});
 view.applySnapshot(data);assert.equal(reads,1);await view.applySettings({rulesScale:160});assert.equal(reads,2);const beforeResize=reads;view.resize(480,270);assert.equal(reads,beforeResize+1);
 const fit=Number(card.style.getPropertyValue('--scene-panel-fit'));assert.ok(fit>0&&fit<1);assert.ok((238+3)*1.6*fit<=270-24+1e-9);assert.equal(view.settings.rulesScale,160);assert.equal(card.dataset.autoFit,'true');
 assert.equal(byClass(card,'scene-overlay-trigger').length,4);assert.equal(byClass(card,'scene-overlay-rule').length,4);assert.equal(byClass(card,'scene-rule-icon').length,3);
 const row=byClass(card,'scene-overlay-trigger')[1],unchanged=reads,retainedFit=card.style.getPropertyValue('--scene-panel-fit');data.current.progress++;view.applySnapshot(data);await view.applySettings({rulesX:100,rulesY:50,rulesOpacity:20});assert.equal(reads,unchanged);assert.equal(card.style.getPropertyValue('--scene-panel-fit'),retainedFit);assert.equal(byClass(card,'scene-overlay-trigger')[1],row);
 data.rules.joinCount=9;view.applySnapshot(data);assert.equal(reads,unchanged+1);assert.match(card.textContent,/进场\s+→ 小图 × 9/);
 const beforeLanguage=reads;data.lang='en';view.applySnapshot(data);assert.equal(reads,beforeLanguage+1);assert.match(card.textContent,/Join\s+→ Small × 9/);
 const beforeRestore=reads;view.resize(960,540);assert.equal(reads,beforeRestore+1);assert.equal(card.style.getPropertyValue('--scene-panel-fit'),'1');assert.equal(card.dataset.autoFit,'false');
 view.destroy();
});

test('topmost bridge applies CLI false initially, serializes changes and deduplicates repeated settings',async()=>{
 const doc=documentFixture(),calls=[],resolvers=[];
 const view=createSceneWindowView({root:doc.body,search:'?onTop=0',api:()=>({set_scene_topmost(value){calls.push(value);return new Promise(resolve=>resolvers.push(()=>resolve({onTop:value,applied:true})))}})});
 assert.deepEqual(calls,[false]);const pending=view.applySettings({onTop:true});
 assert.deepEqual(calls,[false]);resolvers.shift()();await Promise.resolve();assert.deepEqual(calls,[false,true]);
 resolvers.shift()();await pending;
 await view.applySettings({onTop:true,showQueue:true});assert.deepEqual(calls,[false,true]);
 const replay=view.nativeReady();assert.deepEqual(calls,[false,true,true]);resolvers.shift()();await replay;view.destroy();
});

test('pywebviewready replays URL preference even when the first bridge check was not yet settled',async()=>{
 const doc=documentFixture(),calls=[];let available=false;
 const bridge={async set_scene_topmost(value){calls.push(value);return {onTop:value,applied:true}}};
 const view=createSceneWindowView({root:doc.body,search:'?onTop=0',api:()=>available?bridge:undefined});
 available=true;await view.nativeReady();assert.deepEqual(calls,[false]);view.destroy();
});

test('failed native application keeps intent for a later ready replay and destroy stops pending follow-up',async()=>{
 const doc=documentFixture(),calls=[];let fail=true;
 const view=createSceneWindowView({root:doc.body,api:()=>({async set_scene_topmost(value){calls.push(value);return {onTop:value,applied:!fail}}})});
 await view.applySettings({onTop:false});assert.equal(view.settings.onTop,false);fail=false;await view.nativeReady();assert.equal(calls.at(-1),false);
 view.destroy();const before=calls.length;await view.applySettings({onTop:true});await view.nativeReady();assert.equal(calls.length,before);
});

const pointer=(button=0,isPrimary=true)=>({type:'pointerdown',button,isPrimary,defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true},stopPropagation(){this.stopped=true}});

test('browser-only viewers have no resize hit areas; actual native readiness mounts two sibling edges once',async()=>{
 const doc=documentFixture();let current;
 const view=createSceneWindowView({root:doc.body,api:()=>current});
 assert.equal(byClass(doc.body,'scene-window-resize-handle').length,0);
 await view.nativeReady();assert.equal(byClass(doc.body,'scene-window-resize-handle').length,0);
 current={resize_scene_window(){return {queued:true}}};await view.nativeReady();
 const layer=byClass(doc.body,'scene-window-resize-handles')[0],edges=byClass(doc.body,'scene-window-resize-handle');
 assert.equal(edges.length,2);assert.deepEqual(edges.map(edge=>edge.dataset.edge),['left','right']);
 assert.equal(layer.parentNode,doc.body);assert.equal(view.element.children.includes(layer),false);assert.equal(layer.getAttribute('aria-hidden'),'true');
 await view.nativeReady();assert.equal(byClass(doc.body,'scene-window-resize-handles')[0],layer);assert.equal(byClass(doc.body,'scene-window-resize-handle').length,2);
 view.destroy();assert.equal(doc.body.children.length,0);
});

test('native resize accepts only primary left-button presses and safely handles rejected or thrown native calls',async()=>{
 const doc=documentFixture(),calls=[];let throwing=false;
 const handles=mountSceneResizeHandles({root:doc.body,api:()=>({resize_scene_window(edge){calls.push(edge);if(throwing)throw Error('closing');return Promise.reject(Error('not available'))}})});
 const [left,right]=byClass(doc.body,'scene-window-resize-handle');
 for(const event of [pointer(1),pointer(2),pointer(0,false)]){left.dispatchEvent(event);assert.equal(event.defaultPrevented,false);assert.equal(event.stopped,false);}
 assert.deepEqual(calls,[]);
 const first=pointer();left.dispatchEvent(first);assert.deepEqual(calls,['left']);assert.equal(first.defaultPrevented,true);assert.equal(first.stopped,true);
 await Promise.resolve();throwing=true;const second=pointer();assert.doesNotThrow(()=>right.dispatchEvent(second));assert.deepEqual(calls,['left','right']);assert.equal(second.defaultPrevented,true);assert.equal(second.stopped,true);
 handles.destroy();
});

test('resize presses use the latest bridge and ready removes unavailable handles without retaining listeners',()=>{
 const doc=documentFixture(),calls=[];let current={resize_scene_window:edge=>calls.push('first:'+edge)};
 const handles=mountSceneResizeHandles({root:doc.body,api:()=>current}),edge=byClass(doc.body,'scene-window-resize-handle')[1];
 current={resize_scene_window:value=>calls.push('second:'+value)};edge.dispatchEvent(pointer());assert.deepEqual(calls,['second:right']);
 current={};const unavailable=pointer();edge.dispatchEvent(unavailable);
 assert.equal(unavailable.defaultPrevented,false);assert.equal(unavailable.stopped,false);assert.equal(doc.body.children.length,0);assert.equal(edge.listeners.get('pointerdown').size,0);
 current={resize_scene_window:value=>calls.push('third:'+value)};handles.nativeReady();assert.equal(byClass(doc.body,'scene-window-resize-handle').length,2);
 const currentEdge=byClass(doc.body,'scene-window-resize-handle')[0];handles.destroy();const before=calls.length;currentEdge.dispatchEvent(pointer());handles.nativeReady();assert.equal(calls.length,before);assert.equal(currentEdge.listeners.get('pointerdown').size,0);assert.equal(doc.body.children.length,0);
});

test('native ready mounts resize handles immediately even while a topmost bridge promise remains pending',async()=>{
 const doc=documentFixture();let resolveTopmost;
 const view=createSceneWindowView({root:doc.body,api:()=>({resize_scene_window(){},set_scene_topmost(value){return new Promise(resolve=>{resolveTopmost=()=>resolve({onTop:value,applied:true})})}})});
 const ready=view.nativeReady();assert.equal(byClass(doc.body,'scene-window-resize-handle').length,2);
 resolveTopmost();await Promise.resolve();resolveTopmost();await ready;
 view.destroy();assert.equal(doc.body.children.length,0);
});

test('resize CSS adds transparent eight-pixel edges outside the pointer-disabled overlay without visible borders',()=>{
 const css=fs.readFileSync(new URL('../../assets/scene-window-view.css',import.meta.url),'utf8');
 assert.match(css,/\.scene-window-resize-handles \{position:fixed;inset:0;z-index:8;pointer-events:none\}/);
 assert.match(css,/\.scene-window-resize-handle \{[^}]*width:8px;border:0;background:transparent;cursor:ew-resize;touch-action:none;pointer-events:auto/);
 assert.match(css,/\.scene-window-resize-left \{left:0\}/);assert.match(css,/\.scene-window-resize-right \{right:0\}/);
});

test('viewer wiring preserves cover video and orbit geometry, and adds no navigation toolbar',()=>{
 const html=fs.readFileSync(new URL('../../live-view.html',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../../assets/scene-window-view.css',import.meta.url),'utf8');
 assert.match(html,/object-fit:cover/);assert.match(html,/Math\.max\(innerWidth,innerHeight\*aspect\)/);
 assert.match(html,/m\.type==='view-settings'/);assert.match(html,/m\.type==='view-overlay-state'/);assert.match(html,/sceneWindowView\.setTheme\(theme\)/);
 assert.doesNotMatch(html,/localStorage|返回工作台|output-close|<button/);
 assert.match(css,/position:absolute;grid-area:auto/);assert.match(css,/pointer-events:none!important/);
});
