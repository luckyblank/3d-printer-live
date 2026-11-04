import {test} from 'node:test';
import assert from 'node:assert/strict';
import {avatarDimensions,loadAvatarFile,downsampleTexture} from '../../avatar-assets.mjs';

test('avatar sizing preserves aspect and does not enlarge small files',()=>{
 assert.deepEqual(avatarDimensions(6000,4000),{width:256,height:171});
 assert.deepEqual(avatarDimensions(4000,6000),{width:171,height:256});
 assert.deepEqual(avatarDimensions(32,64),{width:32,height:64});
 assert.throws(()=>avatarDimensions(0,100));
});

test('file imports keep only a compressed thumbnail and close decoded pixels',async()=>{
 const original={createImageBitmap:globalThis.createImageBitmap,document:globalThis.document};
 let closed=0;const draws=[];const canvas={width:0,height:0,getContext:()=>({drawImage:(...args)=>draws.push(args)}),toDataURL:(type,quality)=>`${type}:${quality}`};
 globalThis.createImageBitmap=async()=>({width:8000,height:4000,close(){closed++}});
 globalThis.document={createElement:()=>canvas};
 try{
  assert.equal(await loadAvatarFile({type:'image/jpeg',size:1000}),'image/webp:0.84');
  assert.deepEqual(draws[0].slice(1),[0,0,256,128]);
  assert.equal(closed,1);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
 }finally{globalThis.createImageBitmap=original.createImageBitmap;globalThis.document=original.document}
});

test('failed compression still releases the temporary decoded bitmap',async()=>{
 const original={createImageBitmap:globalThis.createImageBitmap,document:globalThis.document};let closed=0;
 globalThis.createImageBitmap=async()=>({width:4000,height:3000,close(){closed++}});
 const canvas={width:0,height:0,getContext:()=>({drawImage(){}}),toDataURL(){throw Error('encode failed')}};
 globalThis.document={createElement:()=>canvas};
 try{await assert.rejects(loadAvatarFile({type:'image/png',size:10}),/encode failed/);assert.equal(closed,1);assert.equal(canvas.width,0)}finally{globalThis.createImageBitmap=original.createImageBitmap;globalThis.document=original.document}
});

test('HTML image fallback revokes its object URL after decoding',async()=>{
 const original={createImageBitmap:globalThis.createImageBitmap,document:globalThis.document,Image:globalThis.Image,createObjectURL:URL.createObjectURL,revokeObjectURL:URL.revokeObjectURL};const revoked=[];
 globalThis.createImageBitmap=undefined;
 URL.createObjectURL=()=> 'blob:avatar-test';URL.revokeObjectURL=url=>revoked.push(url);
 globalThis.Image=class{width=512;height=512;set src(value){if(value)queueMicrotask(()=>this.onload())}};
 globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){}}),toDataURL:()=> 'image/webp:data'})};
 try{await loadAvatarFile({type:'image/png',size:10});assert.deepEqual(revoked,['blob:avatar-test'])}finally{globalThis.createImageBitmap=original.createImageBitmap;globalThis.document=original.document;globalThis.Image=original.Image;URL.createObjectURL=original.createObjectURL;URL.revokeObjectURL=original.revokeObjectURL}
});

test('large GPU avatar image is replaced by a bounded canvas',()=>{
 const document=globalThis.document;const draws=[];const canvas={width:0,height:0,getContext:()=>({drawImage:(...args)=>draws.push(args)})};
 globalThis.document={createElement:()=>canvas};
 try{const texture={image:{width:4096,height:2048}};assert.equal(downsampleTexture(texture),texture);assert.equal(texture.image,canvas);assert.equal(canvas.width,512);assert.equal(canvas.height,256);assert.equal(texture.needsUpdate,true);assert.equal(draws.length,1)}finally{globalThis.document=document}
});
