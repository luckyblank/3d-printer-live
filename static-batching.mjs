import * as THREE from './assets/three.module.js';

function geometrySchema(geometry){
 const attributes=Object.entries(geometry.attributes).sort(([a],[b])=>a.localeCompare(b));
 if(!geometry.attributes.position||Object.values(geometry.morphAttributes).some(a=>a.length))return null;
 if(attributes.some(([,a])=>a.isInterleavedBufferAttribute||a.isInstancedBufferAttribute||a.isFloat16BufferAttribute))return null;
 if(geometry.attributes.skinIndex||geometry.attributes.skinWeight)return null;
 const count=geometry.index?.count??geometry.attributes.position.count;
 if(geometry.drawRange.start!==0||geometry.drawRange.count<count)return null;
 return JSON.stringify([!!geometry.index,attributes.map(([name,a])=>[name,a.itemSize,a.normalized,a.array.constructor.name,a.usage,a.gpuType])]);
}

function mergeTransformedGeometry(meshes,rootInverse){
 // Keep indexing: expanding every face would multiply memory for torus/cylinder meshes.
 const transformed=meshes.map(mesh=>mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInverse,mesh.matrixWorld)));
 const geometry=new THREE.BufferGeometry(),first=transformed[0];
 for(const name of Object.keys(first.attributes)){
  const source=first.attributes[name],length=transformed.reduce((sum,g)=>sum+g.attributes[name].array.length,0);
  const data=new source.array.constructor(length);let offset=0;
  for(const g of transformed){data.set(g.attributes[name].array,offset);offset+=g.attributes[name].array.length}
  const attribute=new THREE.BufferAttribute(data,source.itemSize,source.normalized);attribute.setUsage(source.usage);attribute.gpuType=source.gpuType;
  geometry.setAttribute(name,attribute);
 }
 if(first.index){
  const vertices=transformed.reduce((sum,g)=>sum+g.attributes.position.count,0);
  const length=transformed.reduce((sum,g)=>sum+g.index.count,0);
  const indices=vertices>65535?new Uint32Array(length):new Uint16Array(length);let offset=0,vertexOffset=0;
  for(const g of transformed){for(let i=0;i<g.index.count;i++)indices[offset++]=g.index.getX(i)+vertexOffset;vertexOffset+=g.attributes.position.count}
  geometry.setIndex(new THREE.BufferAttribute(indices,1));
 }
 geometry.computeBoundingBox();geometry.computeBoundingSphere();
 for(const g of transformed)g.dispose();
 return geometry;
}

export function batchStaticMeshes(scene,{exclude=[],minBatchSize=2}={}){
 const excluded=new Set(exclude),groups=new Map(),retired=new Set();
 const stats={batches:0,batchedMeshes:0,disposedGeometries:0,meshesBefore:0,meshesAfter:0};
 scene.traverse(o=>{if(o.isMesh)stats.meshesBefore++});
 scene.updateMatrixWorld(true);const rootInverse=new THREE.Matrix4().copy(scene.matrixWorld).invert();
 // Deliberately do not recurse into groups: the printer head, arm and conveyor
 // products have moving descendants and retain their original geometry/identity.
 for(const mesh of [...scene.children]){
  const material=mesh.material;
  if(!mesh.isMesh||mesh.isInstancedMesh||mesh.isSkinnedMesh||mesh.isReflector||excluded.has(mesh)||!mesh.visible||mesh.children.length||mesh.renderOrder!==0)continue;
  if(!material||Array.isArray(material)||material.transparent||material.transmission>0||material.isShaderMaterial||material.isRawShaderMaterial)continue;
  if(mesh.onBeforeRender!==THREE.Object3D.prototype.onBeforeRender||mesh.onAfterRender!==THREE.Object3D.prototype.onAfterRender||mesh.onBeforeShadow!==THREE.Object3D.prototype.onBeforeShadow||mesh.onAfterShadow!==THREE.Object3D.prototype.onAfterShadow||mesh.customDepthMaterial||mesh.customDistanceMaterial)continue;
  if(mesh.userData.dynamic||mesh.userData.staticBatch===false)continue;
  const schema=geometrySchema(mesh.geometry);if(!schema)continue;
  // Reflections/negative scale require per-triangle winding changes; leave them intact.
  if(new THREE.Matrix4().multiplyMatrices(rootInverse,mesh.matrixWorld).determinant()<=0)continue;
  const key=JSON.stringify([material.uuid,mesh.castShadow,mesh.receiveShadow,mesh.frustumCulled,mesh.layers.mask,schema]);
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(mesh);
 }
 for(const meshes of groups.values()){
  if(meshes.length<Math.max(2,minBatchSize))continue;
  const first=meshes[0],geometry=mergeTransformedGeometry(meshes,rootInverse),merged=new THREE.Mesh(geometry,first.material);
  merged.name='Static printer details';merged.castShadow=first.castShadow;merged.receiveShadow=first.receiveShadow;merged.frustumCulled=first.frustumCulled;merged.layers.mask=first.layers.mask;
  merged.userData.staticBatchCount=meshes.length;
  for(const mesh of meshes){retired.add(mesh.geometry);mesh.removeFromParent()}
  scene.add(merged);stats.batches++;stats.batchedMeshes+=meshes.length;
 }
 // A geometry can be shared by an excluded mesh or a moving descendant. Dispose
 // only buffers that no remaining scene node references; never dispose materials.
 const retained=new Set();scene.traverse(o=>{if(o.geometry)retained.add(o.geometry);if(o.isMesh)stats.meshesAfter++});
 for(const geometry of retired)if(!retained.has(geometry)){geometry.dispose();stats.disposedGeometries++}
 return stats;
}
