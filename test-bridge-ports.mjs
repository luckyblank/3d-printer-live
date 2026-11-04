import {startWSServer} from './bridge-ws.mjs';
import http from 'node:http';
import assert from 'node:assert/strict';
const occupied=http.createServer();await new Promise(r=>occupied.listen(0,'127.0.0.1',r));const port=occupied.address().port;
let hub;const actual=await new Promise((resolve,reject)=>{hub=startWSServer(port,{fallbackPorts:9,identity:'test',onStatus:resolve,onError:reject})});
assert(actual>port);const h=await(await fetch(`http://127.0.0.1:${actual}/health`)).json();assert.equal(h.identity,'test');
const ws=new WebSocket(`ws://127.0.0.1:${actual}`);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});const received=new Promise(r=>ws.onmessage=e=>r(e.data));hub.broadcast({test:true});assert.equal(await received,'{"test":true}');await new Promise(r=>{ws.onclose=r;ws.close()});hub.close();occupied.close();console.log('PASS occupied port fallback, health identity, websocket delivery');
