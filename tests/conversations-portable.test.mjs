import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNodeServer} from '../apps/node/server.mjs';
import {httpConversationTransport} from '../packages/conversations/http.mjs';
import {INVITE_MIME} from '../packages/conversations/index.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('configured portable HTTP fixture uses two independent durable localhost hosts, queued receipts and consent',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'conversation-portable-')),origins=['http://localhost:18891','http://localhost:18892'];const apps=[];const socket=process.env.CONVERSATION_SOCKET_TEST==='true';const fixtureFetch=async(url,init)=>{const u=new URL(url),i=origins.indexOf(u.origin);assert.notEqual(i,-1);return apps[i].fetch(new Request(url,init));};const fetchPeer=socket?fetch:fixtureFetch;
 try{
 for(let i=0;i<2;i++){const app=await createNodeServer({directory:join(directory,String(i)),config:{APP_ORIGIN:origins[i],WORK_LIMITS_ENABLED:'false',CONVERSATION_PEER_ORIGINS:origins[1-i],CONVERSATION_TRANSPORT:httpConversationTransport({allowedOrigins:[origins[1-i]],fetch:fetchPeer})}});apps.push(app);if(socket)await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(Number(new URL(origins[i]).port),'127.0.0.1',resolve);});}
 const req=async(host,path,{user,value,bearer,method=value===undefined?'GET':'POST'}={})=>fetchPeer(origins[host]+path,{method,headers:{...user?{Cookie:user.cookie,'X-CSRF-Token':user.csrf,Origin:origins[host]}:{},...value===undefined?{}:{'Content-Type':'application/json'},...bearer?{Authorization:'Bearer '+bearer}:{}},...value===undefined?{}:{body:JSON.stringify(value)}});
 const j=async(host,path,opts)=>{const r=await req(host,path,opts);assert.ok(r.ok,`${r.status}: ${await r.clone().text()}`);return r.json();};
 const signup=async(host,handle)=>{const pending=await j(host,'/api/auth/signup',{user:{},value:{handle,method:'password',password:'Portable conversation fixture password!',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'}}),recovery=await j(host,'/api/auth/recovery/download',{user:{},value:{pendingToken:pending.pendingToken}});const r=await req(host,'/api/auth/recovery/confirm',{user:{},value:{pendingToken:pending.pendingToken,recoveryToken:recovery.recoveryToken,downloadConfirmed:true}}),session=await r.json();const user={cookie:r.headers.get('Set-Cookie').split(';')[0],csrf:session.csrfToken,owner:session.account.id};user.collection=(await j(host,'/api/account',{user})).collections[0].id;return user;};
 const a=await signup(0,'portable_a'),b=await signup(1,'portable_b');const room=await j(0,'/api/conversations',{user:a,value:{title:'Portable fixture',collection:a.collection}}),actionPath='/api/conversations/'+a.owner+'/'+room.id+'/action';
 const act=(host,user,operation,input={})=>j(host,actionPath,{user,value:{source:{origin:origins[0],owner:a.owner},operation,input}});
 const contact=await j(1,'/api/contacts',{user:b,value:{name:'Portable contact',collections:[b.collection],mimeTypes:[INVITE_MIME],expiresAt:Date.now()+3600000,maxMessages:10}});
 const invited=await act(0,a,'invite',{confirmed:true,target:{origin:origins[1],owner:b.owner},collection:b.collection,contactURL:contact.url});assert.equal(invited.complete,true);assert.equal((await j(1,'/api/conversations',{user:b})).items[0].state,'invited');
 await act(1,b,'accept',{confirmed:true});let state;for(let i=0;i<50;i++){state=(await j(1,'/api/conversations',{user:b})).items[0].state;if(state==='active')break;await sleep(20);}assert.equal(state,'active');
 const post=await act(1,b,'post',{text:'A real HTTP contribution from another host'});assert.equal(post.accepted,true);let receipt;for(let i=0;i<50;i++){receipt=await act(1,b,'receipt',{eventId:post.eventId});if(receipt.complete)break;await sleep(20);}assert.equal(receipt.complete,true);assert.equal(receipt.peers.length,2);for(const [host,user]of [[0,a],[1,b]]){const history=await act(host,user,'history');assert.equal(history.items.length,1);assert.equal(history.items[0].text,'A real HTTP contribution from another host');}
 const capability=await act(1,b,'capability');assert.equal(new URL(capability.endpoint).origin,origins[0]);const info=await j(0,'/api/conversations/'+a.owner+'/'+room.id,{bearer:capability.secret});assert.equal(info.members.length,2);assert.ok(!JSON.stringify(info).includes(capability.secret));
 // This fixture configures two localhost servers. It is not evidence of an
 // independently hosted provider or production federation conformance.
 }finally{for(const app of apps)await app.close();await rm(directory,{recursive:true,force:true});}
});
