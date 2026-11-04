// Keep the exported/captured canvas at its chosen size while bounding the
// offscreen framebuffer. HDR, depth and multisampling all consume GPU memory.
export const MAX_RENDER_TARGET_BYTES = 96 * 1024 * 1024;
export const MAX_INTERNAL_PIXELS = 8294400;

export function renderTargetPlan(width, height, {
 scale=1, limit=Infinity, samples=0, supportedSamples=[], maxTextureSize=16384,
 hdr=true, maxBytes=MAX_RENDER_TARGET_BYTES
}={}) {
 if (!Number.isFinite(width) || !Number.isFinite(height) || width<1 || height<1) {
  throw new RangeError('Output dimensions must be positive finite numbers');
 }
 const pixels=width*height, bytesPerPixel=(hdr?8:4)+4;
 const nativeFits=width<=maxTextureSize&&height<=maxTextureSize&&pixels<=MAX_INTERNAL_PIXELS&&
  pixels*bytesPerPixel<=maxBytes;
 // Preserve crisp native output whenever the unsampled framebuffer fits.
 // Older adaptive limits below 1x must not silently blur a 720p/1080p stream.
 const desired=Math.max(nativeFits?1:.1,Math.min(Number.isFinite(scale)?scale:1,
  limit,2,Math.sqrt(MAX_INTERNAL_PIXELS/pixels),maxTextureSize/width,maxTextureSize/height));
 // Prefer the requested MSAA only if its native-resolution buffers fit. At
 // large outputs this reduces samples before sacrificing useful image detail.
 const nativeScale=Math.min(desired,1);
 const choices=[...new Set(supportedSamples.filter(n=>Number.isInteger(n)&&n>0&&n<=samples)),0].sort((a,b)=>b-a);
 const selected=choices.find(n=>pixels*nativeScale*nativeScale*bytesPerPixel*(n+1)<=maxBytes)??0;
 const bounded=Math.min(desired,Math.sqrt(maxBytes/(pixels*bytesPerPixel*(selected+1))));
 const internalWidth=Math.max(1,Math.floor(width*bounded));
 const internalHeight=Math.max(1,Math.floor(height*bounded));
 return {width:internalWidth,height:internalHeight,scale:bounded,samples:selected,
  estimatedBytes:internalWidth*internalHeight*bytesPerPixel*(selected+1)};
}

// Trim supersampling only. Native pixels remain intact; reduce optional effects
// or frame rate instead of upscaling a smaller image when native rendering is slow.
export function nextRenderScale(current, fps, target) {
 if (!Number.isFinite(current) || current<=1 || !Number.isFinite(target) || target<=0 ||
  !Number.isFinite(fps) || fps<=0 || fps>=target*.8) return current;
 return Math.max(1,Math.round(current*(fps<target*.45?.75:.85)*100)/100);
}
