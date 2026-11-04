import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const port=9337;
const child=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',[
 '--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${port}`,
 `--user-data-dir=${path.join(os.tmpdir(),'printer-design-check-'+Date.now())}`,'about:blank'
],{stdio:'ignore',windowsHide:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let socket;
const report={viewports:[],interactions:[],errors:[]};
try{
 let tabs;
 for(let i=0;i<40;i++){
  try{tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();break}catch{}
  await sleep(250);
 }
 if(!tabs)throw Error('Headless preview did not start');
 socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
 const pending=new Map();let seq=0;
 socket.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){const {resolve,reject,timer}=pending.get(m.id);clearTimeout(timer);pending.delete(m.id);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result)}if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.text);if(m.method==='Log.entryAdded'&&['error','warning'].includes(m.params.entry.level))report.errors.push(m.params.entry.text)};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value};
 await send('Runtime.enable');await send('Log.enable');await send('Page.enable');
 const dimensions=async(width,height)=>send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
 const screenshot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(root,name),Buffer.from(r.data,'base64'))};
 const geometry=()=>evaluate(`(()=>({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,stage:document.querySelector('.scene-viewport').getBoundingClientRect().toJSON(),sidebar:document.querySelector('.sidebar').getBoundingClientRect().toJSON(),controls:document.querySelector('.stage-control').getBoundingClientRect().toJSON(),badImages:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src),overflow:[...document.querySelectorAll('button,select,.connection,.stage-toolbar,.stage-control')].filter(e=>e.getClientRects().length&&e.scrollWidth>e.clientWidth+2).map(e=>({text:e.textContent.trim().slice(0,40),width:e.clientWidth,scroll:e.scrollWidth}))}))()`);
 await dimensions(1380,860);
 await send('Page.navigate',{url:pathToFileURL(path.join(root,'printer-workspace-v1.html')).href});
 await sleep(700);
 await screenshot('workspace-dark-1380.png');report.viewports.push(await geometry());
 await dimensions(1366,768);await sleep(150);await screenshot('workspace-dark-1366.png');report.viewports.push(await geometry());
 await evaluate(`document.querySelector('[data-drawer="rules"]').click()`);await sleep(250);await screenshot('settings-rules-1366.png');
 report.interactions.push({name:'rules drawer',passed:await evaluate(`document.querySelector('#settings-shade').classList.contains('open')&&document.activeElement.id==='drawer-close'`)});
 await evaluate(`document.querySelector('[data-settings="visual"]').click()`);report.interactions.push({name:'visual settings',passed:await evaluate(`document.querySelector('[data-pane="visual"]').classList.contains('active')`)});
 await evaluate(`document.querySelector('[data-settings="audio"]').click()`);report.interactions.push({name:'audio settings',passed:await evaluate(`document.querySelector('[data-pane="audio"]').classList.contains('active')`)});
 await evaluate(`document.querySelector('#drawer-close').click();document.querySelector('#tab-demo').click()`);await screenshot('demo-panel-1366.png');report.interactions.push({name:'demo tab',passed:await evaluate(`!document.querySelector('#view-demo').hidden&&document.querySelector('#tab-demo').getAttribute('aria-selected')==='true'`)});
 await evaluate(`document.querySelector('#tab-history').click()`);report.interactions.push({name:'history tab',passed:await evaluate(`!document.querySelector('#view-history').hidden`)});
 await evaluate(`document.querySelector('#tab-queue').click();document.querySelector('#pause-button').click()`);report.interactions.push({name:'pause feedback',passed:await evaluate(`document.querySelector('#pause-button span').textContent==='继续'`)});
 await evaluate(`document.querySelector('#pause-button').click();document.querySelector('#toast').classList.remove('show')`);
 await evaluate(`document.querySelector('#room-input').value='12345678';document.querySelector('#capture-toggle').click()`);report.interactions.push({name:'connection mock',passed:await evaluate(`document.querySelector('#capture-toggle span').textContent==='停止抓取'`)});await evaluate(`document.querySelector('#capture-toggle').click();document.querySelector('#room-input').value='';document.querySelector('#toast').classList.remove('show')`);
 await dimensions(1380,860);await evaluate(`document.body.classList.add('light')`);await sleep(100);await screenshot('workspace-light-1380.png');report.viewports.push(await geometry());
 await evaluate(`document.body.classList.remove('light');document.body.classList.add('compact')`);await dimensions(1366,768);await sleep(100);report.viewports.push(await geometry());
 await evaluate(`document.body.classList.remove('compact');document.body.classList.add('focus')`);await sleep(100);report.viewports.push(await geometry());
 await evaluate(`document.body.classList.remove('focus');document.querySelector('#output-open').click()`);report.interactions.push({name:'output preview',passed:await evaluate(`document.querySelector('#output-preview').classList.contains('open')`)});
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 report.interactions.push({name:'output closes with Escape',passed:await evaluate(`!document.querySelector('#output-preview').classList.contains('open')`)});
 fs.writeFileSync(path.join(root,'preview-check.json'),JSON.stringify(report,null,2));
 const failed=report.errors.length||report.interactions.some(i=>!i.passed)||report.viewports.some(v=>v.documentWidth>v.width||v.documentHeight>v.height||v.badImages.length||v.overflow.length);
 console.log(JSON.stringify({passed:!failed,interactions:report.interactions,viewports:report.viewports.map(v=>({width:v.width,height:v.height,documentWidth:v.documentWidth,documentHeight:v.documentHeight,overflow:v.overflow,badImages:v.badImages})),errors:report.errors},null,2));
 if(failed)process.exitCode=1;
 await send('Browser.close');
}finally{socket?.close();child.kill()}
