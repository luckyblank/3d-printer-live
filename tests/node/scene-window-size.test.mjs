import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sceneWindowSize} from '../../scene-window-size.mjs';

test('browser preview geometry does not grow with output resolution',()=>{
 assert.deepEqual(sceneWindowSize('landscape',1920,1080),[960,540]);
 assert.deepEqual(sceneWindowSize('landscape-1080p',1920,1080),[960,540]);
 assert.deepEqual(sceneWindowSize('portrait',1920,1080),[405,720]);
 assert.deepEqual(sceneWindowSize('portrait-1080p',1920,1080),[405,720]);
});
test('small browser work areas scale both dimensions together with margins',()=>{
 for(const orient of ['landscape-1080p','portrait-1080p']){
  const [w,h]=sceneWindowSize(orient,800,600);
  assert.ok(w<=736&&h<=536);
  assert.equal(w/h,orient.startsWith('portrait')?9/16:16/9);
 }
});
