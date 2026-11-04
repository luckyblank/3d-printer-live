import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('./live-view.html',import.meta.url),'utf8');
const start=html.indexOf('function layout(){');
const end=html.indexOf("window.addEventListener('resize',layout)",start);
assert.ok(start>=0&&end>start,'The real output-window layout function must be present');
const implementation=html.slice(start,end);

function harness(width,height,videoWidth,videoHeight){
 const context={innerWidth:width,innerHeight:height,v:{videoWidth,videoHeight},interaction:{style:{}},sceneWindowView:{resize(){}},
  camera:{aspect:0,updates:0,updateProjectionMatrix(){this.updates++}}};
 vm.runInNewContext(implementation+';layout();',context);
 return context;
}

function assertCover(context){
 const width=parseFloat(context.interaction.style.width),height=parseFloat(context.interaction.style.height);
 const left=parseFloat(context.interaction.style.left),top=parseFloat(context.interaction.style.top);
 const aspect=(context.v.videoWidth||1280)/(context.v.videoHeight||720);
 assert.ok(width>=context.innerWidth-1e-8&&height>=context.innerHeight-1e-8,'The interaction/video rectangle covers the entire viewport');
 assert.ok(left<=1e-8&&top<=1e-8,'Oversize content crops symmetrically rather than leaving black edges');
 assert.ok(Math.abs(left+width/2-context.innerWidth/2)<1e-8);
 assert.ok(Math.abs(top+height/2-context.innerHeight/2)<1e-8);
 assert.ok(Math.abs(width/height-aspect)<1e-8,'Cover keeps the source aspect ratio instead of stretching');
 assert.equal(context.camera.aspect,aspect);
}

test('scene video and its interaction layer fill landscape and portrait windows without blank edges',()=>{
 assert.match(html,/video\{[^}]*object-fit:cover;[^}]*object-position:center/);
 assert.match(html,/html,body\{[^}]*overflow:hidden/);
 for(const [width,height] of [[960,540],[1000,800],[1920,1080],[405,720],[600,900]]){
  for(const [videoWidth,videoHeight] of [[1280,720],[1920,1080],[720,1280],[1080,1920]]){
   assertCover(harness(width,height,videoWidth,videoHeight));
  }
 }
});

test('cover interaction offsets track the crop on the correct axis',()=>{
 const portraitVideo=harness(960,540,1080,1920);
 assert.equal(parseFloat(portraitVideo.interaction.style.left),0);
 assert.ok(parseFloat(portraitVideo.interaction.style.top)<0);
 const landscapeVideo=harness(405,720,1920,1080);
 assert.ok(parseFloat(landscapeVideo.interaction.style.left)<0);
 assert.equal(parseFloat(landscapeVideo.interaction.style.top),0);
 assertCover(portraitVideo);assertCover(landscapeVideo);
});

test('resize and source-orientation changes recompute only display geometry',()=>{
 const context=harness(960,540,1920,1080);assert.equal(context.camera.updates,1);
 context.innerWidth=600;context.innerHeight=800;
 vm.runInNewContext('layout()',context);assertCover(context);assert.equal(context.camera.updates,2);
 assert.deepEqual(context.v,{videoWidth:1920,videoHeight:1080});
 context.v.videoWidth=1080;context.v.videoHeight=1920;
 vm.runInNewContext('layout()',context);assertCover(context);assert.equal(context.camera.updates,3);
 assert.deepEqual(context.v,{videoWidth:1080,videoHeight:1920});
 assert.match(html,/window\.addEventListener\('resize',layout\);v\.addEventListener\('resize',layout\)/);
});

test('before metadata arrives the default 16:9 interaction rectangle still covers the window',()=>{
 const context=harness(1000,700,0,0);assertCover(context);
 assert.deepEqual(context.v,{videoWidth:0,videoHeight:0});
});
