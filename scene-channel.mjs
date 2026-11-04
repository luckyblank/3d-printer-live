// BroadcastChannel remains for local tabs; isolated native windows use local HTTP
// only for signalling. Video and interactive controls use their WebRTC connection.
const validThemeMessage=message=>message?.type!=='workspace-theme'||message.theme==='light'||message.theme==='dark';
export class SceneChannel {
  constructor() {
    this.id=crypto.randomUUID();this.onmessage=null;this.closed=false;
    this.native=new BroadcastChannel('printer-scene');
    this.native.onmessage=e=>{if(validThemeMessage(e.data))this.onmessage?.(e);};
    this.pending=[];this.cursor=null;this.available=false;
    this.poll();
  }
  async poll() {
    while(!this.closed) {
      try {
        const suffix=this.cursor===null?'':'&after='+this.cursor;
        const response=await fetch('/__scene-events?client='+this.id+suffix,{cache:'no-store'});
        if(!response.ok)throw new Error('signalling '+response.status);
        const data=await response.json();this.cursor=data.cursor;this.available=true;
        for(const m of data.messages)if(validThemeMessage(m))this.onmessage?.({data:m});
        for(const m of this.pending.splice(0))this.postMessage(m);
      } catch(error) {this.available=false;await new Promise(r=>setTimeout(r,1000));}
    }
  }
  postMessage(message) {
    if(!validThemeMessage(message))return;
    // Exact extra type: theme changes must cross isolated native profiles just
    // like view signalling. Other workspace messages retain local-only routing.
    if(!message.type?.startsWith('view-')&&message.type!=='workspace-theme'){this.native.postMessage(message);return;}
    if(!this.available){
      // Snapshots repeat avatar data. Keep only the latest local state while
      // offline, leaving ICE, offers, answers, settings and themes in order.
      if(message.type==='view-overlay-state'){
        for(let i=this.pending.length-1;i>=0;i--)if(this.pending[i].type==='view-overlay-state')this.pending.splice(i,1);
      }
      this.pending.push(message);if(this.pending.length>64)this.pending.shift();return;
    }
    fetch('/__scene-message',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({client:this.id,message}),keepalive:message.type==='view-bye'})
      .catch(()=>{});
  }
  close(){this.closed=true;this.native.close();}
}
