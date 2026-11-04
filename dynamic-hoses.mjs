import {DynamicDrawUsage,TubeGeometry,Vector3} from './assets/three.module.js';

const point=new Vector3(),normal=new Vector3();
const rings=new Map();

function ringAngles(radialSegments){
 let angles=rings.get(radialSegments);
 if(!angles){
  angles=Array.from({length:radialSegments+1},(_,j)=>{
   const angle=j/radialSegments*Math.PI*2;
   return [-Math.cos(angle),Math.sin(angle)];
  });
  rings.set(radialSegments,angles);
 }
 return angles;
}

// Returns true only when the topology/radius changed and a new geometry was
// needed. Moving hose endpoints reuse the geometry, index, UV and GPU buffers.
export function updateTubeGeometry(mesh,curve,segments,radius,radialSegments){
 curve.updateArcLengths();
 const geometry=mesh.geometry,parameters=geometry?.parameters;
 const reusable=geometry?.type==='TubeGeometry'&&parameters?.tubularSegments===segments&&
  parameters.radialSegments===radialSegments&&parameters.radius===radius&&!parameters.closed;
 // These five short hoses are always part of the printer. Skipping their
 // frustum test avoids recomputing bounds for every deformation and prevents
 // stale bounds from hiding a moving hose. They are not used as pick targets.
 mesh.frustumCulled=false;
 if(!reusable){
  mesh.geometry=new TubeGeometry(curve,segments,radius,radialSegments,false);
  mesh.geometry.getAttribute('position').setUsage(DynamicDrawUsage);
  mesh.geometry.getAttribute('normal').setUsage(DynamicDrawUsage);
  geometry?.dispose();
  return true;
 }
 const position=geometry.getAttribute('position'),normals=geometry.getAttribute('normal');
 const vertices=position.array,normalData=normals.array;
 const frames=curve.computeFrenetFrames(segments,false),angles=ringAngles(radialSegments);
 let offset=0;
 for(let i=0;i<=segments;i++){
  curve.getPointAt(i/segments,point);
  const n=frames.normals[i],b=frames.binormals[i];
  for(const [cos,sin] of angles){
   normal.set(cos*n.x+sin*b.x,cos*n.y+sin*b.y,cos*n.z+sin*b.z).normalize();
   vertices[offset]=point.x+radius*normal.x;normalData[offset++]=normal.x;
   vertices[offset]=point.y+radius*normal.y;normalData[offset++]=normal.y;
   vertices[offset]=point.z+radius*normal.z;normalData[offset++]=normal.z;
  }
 }
 parameters.path=curve;
 geometry.tangents=frames.tangents;geometry.normals=frames.normals;geometry.binormals=frames.binormals;
 position.needsUpdate=true;normals.needsUpdate=true;
 geometry.boundingBox=null;geometry.boundingSphere=null;
 return false;
}
