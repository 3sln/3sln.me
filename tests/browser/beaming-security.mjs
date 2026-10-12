import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://portal.example/'});
const names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element'];
const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));
for(const name of names)globalThis[name]=window[name];
const {createBeaming}=await import('../../apps/web/src/providers/beaming.mjs');
test.after(async()=>{await window.happyDOM.close();for(const name of names)globalThis[name]=previous[name];});
const delay=()=>new Promise(resolve=>setTimeout(resolve,10));
class Channel {label='3sln-beam-v1';readyState='open';sent=[];close(){this.readyState='closed';}send(value){this.sent.push(value);}message(data){this.onmessage?.({data});}}
class Peer {static current;constructor(){Peer.current=this;}close(){this.closed=true;}}

test('cancelling while a writable destination opens aborts the late writer',async()=>{
 let resolveWriter,opening=false,aborts=0,writes=0;
 const writer={write:async()=>{writes++;},close:async()=>{},abort:async()=>{aborts++;}};
 const beam=createBeaming({Peer,savePicker:async()=>({createWritable:()=>{opening=true;return new Promise(resolve=>{resolveWriter=resolve;});}})});
 try{
  const files=[{id:'one',name:'one.bin',size:1,type:'application/octet-stream'}],destination=await beam.prepareDestination(files,'stream');
  await beam.connect({id:'offer',role:'receiver',files,selected:['one'],destination,sendSignal:async()=>{}});
  const channel=new Channel();Peer.current.ondatachannel({channel});channel.message(JSON.stringify({kind:'start',id:'one'}));await delay();assert.equal(opening,true);
  beam.cancel('offer');resolveWriter(writer);await delay();assert.equal(aborts,1);assert.equal(writes,0);assert.equal(beam.connected('offer'),false);assert.equal(Peer.current.closed,true);
 }finally{beam.dispose();}
});

test('completed empty-file receipt releases the peer and destination binding',async()=>{
 let closed=0;
 const beam=createBeaming({Peer,savePicker:async()=>({createWritable:async()=>({write:async()=>{},close:async()=>{closed++;},abort:async()=>{}})})});
 try{
  const files=[{id:'empty',name:'empty.txt',size:0,type:'text/plain'}],destination=await beam.prepareDestination(files,'stream');
  beam.remember('offer',{destination});await beam.connect({id:'offer',role:'receiver',files,selected:['empty'],destination,sendSignal:async()=>{}});
  const channel=new Channel();Peer.current.ondatachannel({channel});channel.message(JSON.stringify({kind:'start',id:'empty'}));channel.message(JSON.stringify({kind:'end',id:'empty',size:0}));
  await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(closed,1);assert.equal(beam.connected('offer'),false);assert.equal(beam.binding('offer'),undefined);assert.equal(Peer.current.closed,true);
 }finally{beam.dispose();}
});
