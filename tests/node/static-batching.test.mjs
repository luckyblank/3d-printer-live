import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../assets/three.module.js';
import {batchStaticMeshes} from '../../static-batching.mjs';

function createMesh(material,geometry=new THREE.BoxGeometry(1,1,1)){
 const mesh=new THREE.Mesh(geometry,material);mesh.castShadow=true;mesh.receiveShadow=true;return mesh;
}

test('indexed batching preserves world-space positions, normals, indices and material identity',()=>{
 const scene=new THREE.Scene();scene.position.set(3,-2,1);scene.rotation.y=.2;
 const material=new THREE.MeshStandardMaterial(),a=createMesh(material),b=createMesh(material);
 a.position.set(2,0,0);a.rotation.z=.4;b.position.set(-1,3,1);b.scale.set(2,.5,1);
 scene.add(a,b);scene.updateMatrixWorld(true);
 const originals=[a,b].flatMap(mesh=>{const p=mesh.geometry.attributes.position;return Array.from({length:p.count},(_,i)=>new THREE.Vector3().fromBufferAttribute(p,i).applyMatrix4(mesh.matrixWorld))});
 const expectedBox=new THREE.Box3().setFromPoints(originals),count=a.geometry.index.count+b.geometry.index.count;
 const stats=batchStaticMeshes(scene);assert.equal(stats.batches,1);assert.equal(stats.meshesAfter,1);
 const merged=scene.children[0];assert.equal(merged.material,material);assert.equal(merged.geometry.index.count,count);assert.equal(merged.geometry.attributes.position.count,originals.length);
 scene.updateMatrixWorld(true);const points=merged.geometry.attributes.position;
 for(let i=0;i<points.count;i++)assert.ok(new THREE.Vector3().fromBufferAttribute(points,i).applyMatrix4(merged.matrixWorld).distanceTo(originals[i])<1e-6);
 const worldBox=new THREE.Box3().setFromObject(merged,true);assert.ok(worldBox.min.distanceTo(expectedBox.min)<1e-6);assert.ok(worldBox.max.distanceTo(expectedBox.max)<1e-6);
 const normals=merged.geometry.attributes.normal;for(let i=0;i<normals.count;i++)assert.ok(Math.abs(new THREE.Vector3().fromBufferAttribute(normals,i).length()-1)<1e-6);
 const index=merged.geometry.index;for(let i=a.geometry.index.count;i<index.count;i++)assert.ok(index.getX(i)>=a.geometry.attributes.position.count);
});

test('exclude, dynamic groups, custom callbacks, transparency, visibility and shadow flags remain separate',()=>{
 const scene=new THREE.Scene(),material=new THREE.MeshStandardMaterial();
 const a=createMesh(material),b=createMesh(material),exclude=createMesh(material),hidden=createMesh(material);hidden.visible=false;
 const noShadow=createMesh(material);noShadow.castShadow=false;
 const callback=createMesh(material);callback.onBeforeRender=()=>{};
 const transparent=createMesh(new THREE.MeshStandardMaterial({transparent:true,opacity:.5}));
 const group=new THREE.Group(),moving=createMesh(material);group.add(moving);
 scene.add(a,b,exclude,hidden,noShadow,callback,transparent,group);
 const stats=batchStaticMeshes(scene,{exclude:[exclude]});assert.equal(stats.batches,1);assert.equal(stats.batchedMeshes,2);
 for(const object of [exclude,hidden,noShadow,callback,transparent,group])assert.equal(object.parent,scene);
 assert.equal(moving.parent,group);assert.equal(hidden.visible,false);
});

test('only unreferenced source geometries are disposed, shared material stays alive',()=>{
 const scene=new THREE.Scene(),material=new THREE.MeshStandardMaterial(),shared=new THREE.BoxGeometry(1,1,1),unique=new THREE.BoxGeometry(1,1,1);
 const a=createMesh(material,shared),b=createMesh(material,unique),group=new THREE.Group(),moving=createMesh(material,shared);group.add(moving);scene.add(a,b,group);
 let sharedDisposals=0,uniqueDisposals=0,materialDisposals=0;shared.addEventListener('dispose',()=>sharedDisposals++);unique.addEventListener('dispose',()=>uniqueDisposals++);material.addEventListener('dispose',()=>materialDisposals++);
 const stats=batchStaticMeshes(scene);assert.equal(stats.disposedGeometries,1);assert.equal(sharedDisposals,0);assert.equal(uniqueDisposals,1);assert.equal(materialDisposals,0);assert.equal(moving.geometry,shared);
});

test('all-static shared geometries are disposed once and repeated batching is stable',()=>{
 const scene=new THREE.Scene(),material=new THREE.MeshStandardMaterial(),geometry=new THREE.BoxGeometry(1,1,1);scene.add(createMesh(material,geometry),createMesh(material,geometry));let disposals=0;geometry.addEventListener('dispose',()=>disposals++);
 assert.equal(batchStaticMeshes(scene).disposedGeometries,1);assert.equal(disposals,1);assert.equal(batchStaticMeshes(scene).batches,0);
});

test('different material identity and incompatible vertex layouts are not mixed',()=>{
 const scene=new THREE.Scene(),aMaterial=new THREE.MeshStandardMaterial(),bMaterial=aMaterial.clone();
 const a=createMesh(aMaterial),b=createMesh(bMaterial),differentGeometry=new THREE.BoxGeometry(1,1,1);differentGeometry.deleteAttribute('uv');
 const c=createMesh(aMaterial,differentGeometry);scene.add(a,b,c);assert.equal(batchStaticMeshes(scene).batches,0);assert.equal(scene.children.length,3);
});
