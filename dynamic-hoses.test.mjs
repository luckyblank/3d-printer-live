import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from './assets/three.module.js';
import {updateTubeGeometry} from './dynamic-hoses.mjs';

const curveFor=(x,y)=>new THREE.CatmullRomCurve3([
 new THREE.Vector3(-3,4,-1),new THREE.Vector3(-2,6,-1),
 new THREE.Vector3(-1,Math.max(y+1,5),-.8),new THREE.Vector3(x,y,-.5)
]);

test('moving endpoints reuse all GPU buffers and agree with a freshly generated tube',()=>{
 const mesh=new THREE.Mesh(new THREE.BufferGeometry());let disposals=0;
 mesh.geometry.addEventListener('dispose',()=>disposals++);
 assert.equal(updateTubeGeometry(mesh,curveFor(0,3),24,.025,8),true);
 assert.equal(disposals,1);
 const geometry=mesh.geometry,position=geometry.getAttribute('position'),normals=geometry.getAttribute('normal');
 const index=geometry.index,uv=geometry.getAttribute('uv'),positionData=position.array;
 geometry.addEventListener('dispose',()=>disposals++);
 for(const [x,y] of [[.8,4.8],[-.4,1.4],[1.5,3.2]]){
  const curve=curveFor(x,y),version=position.version;
  assert.equal(updateTubeGeometry(mesh,curve,24,.025,8),false);
  assert.equal(mesh.geometry,geometry);assert.equal(geometry.getAttribute('position'),position);
  assert.equal(position.array,positionData);assert.equal(geometry.getAttribute('normal'),normals);
  assert.equal(geometry.index,index);assert.equal(geometry.getAttribute('uv'),uv);
  assert.equal(position.version,version+1);assert.equal(disposals,1);
  assert.equal(geometry.parameters.path,curve);assert.equal(mesh.frustumCulled,false);
  const expected=new THREE.TubeGeometry(curve,24,.025,8,false);
  const reference=expected.getAttribute('position').array;
  for(let i=0;i<reference.length;i++)assert.ok(Math.abs(reference[i]-positionData[i])<1e-6);
  // Last-ring positions minus the radial offset must end exactly at the socket.
  const last=24*9,center=new THREE.Vector3().fromBufferAttribute(position,last)
   .addScaledVector(new THREE.Vector3().fromBufferAttribute(normals,last),-.025);
  assert.ok(center.distanceTo(curve.getPoint(1))<1e-6);
  expected.dispose();
 }
 mesh.geometry.dispose();
});

test('changing topology disposes the old geometry once, while later moves remain in-place',()=>{
 const mesh=new THREE.Mesh(new THREE.TubeGeometry(curveFor(0,3),24,.025,8));
 const previous=mesh.geometry;let disposals=0;previous.addEventListener('dispose',()=>disposals++);
 assert.equal(updateTubeGeometry(mesh,curveFor(0,3),32,.04,10),true);
 assert.equal(disposals,1);assert.notEqual(mesh.geometry,previous);
 const replacement=mesh.geometry;
 assert.equal(updateTubeGeometry(mesh,curveFor(1,2),32,.04,10),false);
 assert.equal(mesh.geometry,replacement);assert.equal(disposals,1);
 mesh.geometry.dispose();
});
