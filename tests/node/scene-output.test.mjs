import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SceneOutput} from '../../scene-output.mjs';

function rendererStub(){
 const context={RENDERBUFFER:1,RGBA16F:2,RGBA8:3,SAMPLES:4,
  getExtension:()=>({}),getInternalformatParameter:()=>[8,4,2]};
 return {getContext:()=>context,capabilities:{maxTextureSize:16384},
  domElement:{width:0,height:0},shadowMap:{needsUpdate:false},resizes:0,shadowUpdates:0,
  setPixelRatio(){},setSize(width,height){this.resizes++;this.domElement.width=width;this.domElement.height=height},
  setRenderTarget(){},render(){if(this.shadowMap.needsUpdate){this.shadowUpdates++;this.shadowMap.needsUpdate=false}}};
}

test('repeated configure keeps render target attachments and canvas untouched',()=>{
 const renderer=rendererStub(),output=new SceneOutput(renderer);let targetResizes=0,disposals=0;
 const resize=output.target.setSize.bind(output.target);output.target.setSize=(...args)=>{targetResizes++;return resize(...args)};
 output.target.addEventListener('dispose',()=>disposals++);
 output.configure(1280,720,1,'msaa2');
 const initial={targetResizes,disposals,resizes:renderer.resizes};
 for(let i=0;i<10;i++)output.configure(1280,720,1,'msaa2');
 assert.deepEqual({targetResizes,disposals,resizes:renderer.resizes},initial);
 output.configure(1280,720,1,'off');assert.equal(disposals,initial.disposals+1);
 output.dispose();
});

test('1080p 2x output fits the bound without changing the exported canvas dimensions',()=>{
 const renderer=rendererStub(),output=new SceneOutput(renderer);
 output.configure(1920,1080,2,'msaa8');
 assert.deepEqual(renderer.domElement,{width:1920,height:1080});
 assert.ok(output.estimatedBytes<=96*1024*1024);
 assert.ok(output.samples<=2);
 output.dispose();
});

test('shadows update at most 30Hz while explicit invalidations remain respected',()=>{
 const renderer=rendererStub(),output=new SceneOutput(renderer);
 for(const time of [0,8,16,24,32])output.render({}, {},time);
 assert.equal(renderer.shadowUpdates,1);
 output.render({}, {},34);assert.equal(renderer.shadowUpdates,2);
 renderer.shadowMap.needsUpdate=true;output.render({}, {},40);assert.equal(renderer.shadowUpdates,3);
 output.dispose();
});

test('stale adaptive limits cannot make a native 1080p image blurry',()=>{
 const renderer=rendererStub(),output=new SceneOutput(renderer);
 output.configure(1920,1080,1,'msaa8',.65);
 assert.equal(output.scale,1);assert.equal(output.samples,2);
 assert.deepEqual([output.target.width,output.target.height],[1920,1080]);
 assert.ok(output.estimatedBytes<=96*1024*1024);
 output.dispose();
});
