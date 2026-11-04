// Avatar inputs are displayed at badge size. Retaining multi-megapixel originals
// in data URLs, history rows and GPU textures wastes memory throughout a session.
export function avatarDimensions(width,height,maxSide=256){
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw Error('头像尺寸无效');
 if(!Number.isInteger(maxSide)||maxSide<1||maxSide>4096)throw Error('头像最大尺寸无效');
 const ratio=Math.min(1,maxSide/Math.max(width,height));
 return {width:Math.max(1,Math.round(width*ratio)),height:Math.max(1,Math.round(height*ratio))};
}

async function decodeAvatarFile(file){
 if(typeof createImageBitmap==='function'){
  try{const image=await createImageBitmap(file);return {image,release:()=>image.close()}}catch{/* Older codecs may require HTMLImageElement. */}
 }
 const url=URL.createObjectURL(file);const image=new Image();
 try{
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('无法读取头像图片'));image.src=url});
  return {image,release:()=>{image.src='';URL.revokeObjectURL(url)}};
 }catch(error){image.src='';URL.revokeObjectURL(url);throw error}
}

export async function loadAvatarFile(file,{maxSide=256,quality=.84}={}){
 if(!file?.type?.startsWith('image/'))throw Error('请选择图片文件');
 // Reject a single oversized source before decoding its pixels.
 if(file.size>32*1024*1024)throw Error('单张头像图片不能超过32MB');
 const source=await decodeAvatarFile(file);let canvas;
 try{
  const image=source.image;
  const dimensions=avatarDimensions(image.naturalWidth||image.width,image.naturalHeight||image.height,maxSide);
  canvas=document.createElement('canvas');canvas.width=dimensions.width;canvas.height=dimensions.height;
  const context=canvas.getContext('2d');if(!context)throw Error('无法处理头像图片');
  context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
  context.drawImage(image,0,0,canvas.width,canvas.height);
  // WebP keeps alpha and is supported by WebView2; canvas falls back to PNG if unavailable.
  return canvas.toDataURL('image/webp',Math.min(.95,Math.max(.5,Number(quality)||.84)));
 }finally{source.release();if(canvas){canvas.width=0;canvas.height=0}}
}

export function downsampleTexture(texture,maxSide=512){
 const image=texture?.image;if(!image)return texture;
 const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
 if(!width||!height||Math.max(width,height)<=maxSide)return texture;
 const dimensions=avatarDimensions(width,height,maxSide),canvas=document.createElement('canvas');
 canvas.width=dimensions.width;canvas.height=dimensions.height;
 const context=canvas.getContext('2d');if(!context)return texture;
 context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(image,0,0,canvas.width,canvas.height);
 texture.image=canvas;texture.needsUpdate=true;
 return texture;
}
