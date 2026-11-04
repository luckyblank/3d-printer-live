import * as THREE from './assets/three.module.js';
import {renderTargetPlan} from './render-budget.mjs';

export const AA_MODES = {
  off: {label:'关闭抗锯齿 · 最省性能', samples:0, scale:1},
  msaa2: {label:'MSAA 2× · 流畅', samples:2, scale:1},
  msaa4: {label:'MSAA 4× · 推荐', samples:4, scale:1},
  msaa8: {label:'MSAA 8× · 高质量', samples:8, scale:1},
  ssaa15: {label:'超采样 1.5× · 精细', samples:0, scale:1.5},
  ssaa2: {label:'超采样 2× · 极精细', samples:0, scale:2}
};

// Render at a bounded internal resolution; present/capture at the exact output size.
// Tone mapping and sRGB conversion occur once, on the final fullscreen pass.
export class SceneOutput {
  constructor(renderer) {
    this.renderer=renderer;
    const gl=renderer.getContext();
    this.hdr=!!gl.getExtension('EXT_color_buffer_float');
    this.supportedSamples=Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER,
      this.hdr?gl.RGBA16F:gl.RGBA8, gl.SAMPLES)||[]);
    this.target=new THREE.WebGLRenderTarget(1,1,{type:this.hdr?THREE.HalfFloatType:THREE.UnsignedByteType,depthBuffer:true});
    this.material=new THREE.ShaderMaterial({
      uniforms:{image:{value:this.target.texture}}, depthTest:false, depthWrite:false,
      vertexShader:'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader:`uniform sampler2D image; varying vec2 vUv;
      void main(){gl_FragColor=texture2D(image,vUv);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`
    });
    this.scene=new THREE.Scene();
    this.mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),this.material);
    this.mesh.frustumCulled=false;this.scene.add(this.mesh);
    this.camera=new THREE.Camera();this.scale=1;this.samples=0;
    this.estimatedBytes=0;this.lastShadowAt=-Infinity;this.shadowInterval=1000/30;
  }
  configure(width,height,quality,mode,limit=Infinity) {
    const aa=AA_MODES[mode]||AA_MODES.msaa4;
    const plan=renderTargetPlan(width,height,{scale:quality*aa.scale,limit,
      samples:aa.samples,supportedSamples:this.supportedSamples,
      maxTextureSize:this.renderer.capabilities.maxTextureSize,hdr:this.hdr});
    this.scale=plan.scale;this.samples=plan.samples;this.estimatedBytes=plan.estimatedBytes;
    const sizeChanged=this.target.width!==plan.width||this.target.height!==plan.height;
    const samplesChanged=this.target.samples!==plan.samples;
    this.target.samples=plan.samples;
    // setSize disposes old attachments itself. A sample-only change still
    // needs disposal; repeated configure calls need neither operation.
    if(sizeChanged)this.target.setSize(plan.width,plan.height);
    else if(samplesChanged)this.target.dispose();
    if(this.renderer.domElement.width!==width||this.renderer.domElement.height!==height){
      this.renderer.setPixelRatio(1);this.renderer.setSize(width,height,false);
    }
  }
  render(scene,camera,now=performance.now()) {
    const r=this.renderer;
    if(now-this.lastShadowAt>=this.shadowInterval){
      r.shadowMap.needsUpdate=true;this.lastShadowAt=now;
    }
    r.setRenderTarget(this.target);
    try {r.render(scene,camera);} finally {r.setRenderTarget(null);}
    r.render(this.scene,this.camera);
  }
  dispose() {
    this.target.dispose();this.mesh.geometry.dispose();this.material.dispose();
    this.scene.remove(this.mesh);
  }
}
