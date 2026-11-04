import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_RENDER_TARGET_BYTES,renderTargetPlan,nextRenderScale} from './render-budget.mjs';

test('HDR and multisampling remain within the framebuffer memory budget',()=>{
 for(const [width,height] of [[1280,720],[1920,1080],[1080,1920],[3840,2160]]){
  for(const scale of [1,1.25,1.5,2])for(const samples of [0,2,4,8]){
   const plan=renderTargetPlan(width,height,{scale,samples,supportedSamples:[8,4,2],hdr:true});
   assert.ok(plan.estimatedBytes<=MAX_RENDER_TARGET_BYTES,JSON.stringify({width,height,scale,samples,plan}));
   assert.ok(plan.width<=width*2&&plan.height<=height*2);
   assert.ok(plan.samples<=samples);
  }
 }
});

test('large outputs reduce MSAA before dropping below native resolution',()=>{
 const plan=renderTargetPlan(1920,1080,{scale:1.25,samples:8,supportedSamples:[8,4,2],hdr:true});
 assert.equal(plan.samples,2);
 assert.ok(plan.scale>=1);
 assert.ok(plan.estimatedBytes<=MAX_RENDER_TARGET_BYTES);
 const baseline=renderTargetPlan(1280,720,{scale:1.25,samples:4,supportedSamples:[4,2],hdr:true});
 assert.equal(baseline.samples,4);assert.equal(baseline.scale,1.25);
});

test('texture limits, unsupported samples and non-HDR devices are accounted for',()=>{
 const plan=renderTargetPlan(3840,2160,{scale:2,samples:8,supportedSamples:[],maxTextureSize:2048,hdr:false});
 assert.equal(plan.samples,0);assert.ok(plan.width<=2048&&plan.height<=2048);
 assert.equal(plan.estimatedBytes,plan.width*plan.height*8);
 assert.throws(()=>renderTargetPlan(0,1080),RangeError);
});

test('native 720p and 1080p stay sharp even with a stale sub-native adaptive limit',()=>{
 for(const [width,height] of [[1280,720],[1920,1080],[1080,1920]]){
  const plan=renderTargetPlan(width,height,{scale:.65,limit:.65,samples:8,supportedSamples:[8,4,2],hdr:true});
  assert.equal(plan.scale,1);
  assert.equal(plan.width,width);assert.equal(plan.height,height);
  assert.ok(plan.estimatedBytes<=MAX_RENDER_TARGET_BYTES);
  if(width*height===1920*1080)assert.equal(plan.samples,2);
 }
});

test('sustained low frame rate trims supersampling but never drops below 1x',()=>{
 assert.equal(nextRenderScale(1,15,60),1);
 assert.equal(nextRenderScale(1.25,15,60),1);
 assert.equal(nextRenderScale(1.5,15,60),1.13);
 assert.equal(nextRenderScale(.75,15,60),.75);
 assert.equal(nextRenderScale(.65,15,60),.65);
 assert.equal(nextRenderScale(.5,15,60),.5);
 assert.equal(nextRenderScale(1.25,60,60),1.25);
 for(const invalid of [0,NaN,Infinity,-1])assert.equal(nextRenderScale(1,invalid,60),1);
});
