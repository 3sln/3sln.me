import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeServer } from '../apps/node/server.mjs';

const MIME='application/vnd.bindle.contact-token+jwt';
const origin='http://localhost:8789';
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'bindle-node-contact-'));let app=await createNodeServer({directory,config:{APP_ORIGIN:origin,BRAND_NAME:'Private Notes'}});
 const request=(path,{method='GET',value,headers={},form}={})=>app.fetch(new Request(new URL(path,origin),{method,headers:{...(value===undefined?{}:{'Content-Type':'application/json'}),...headers},...(form?{body:form}:value===undefined?{}:{body:JSON.stringify(value)})}));
 const post=(path,value,headers={})=>request(path,{method:'POST',value,headers:{Origin:origin,...headers}});
 const signup=await post('/api/auth/signup',{handle:'local_contact',method:'password',password:'Private self-host account password!',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'});assert.equal(signup.status,200);const pending=await signup.json();
 const recovery=await (await post('/api/auth/recovery/download',{pendingToken:pending.pendingToken})).json();
 const activated=await post('/api/auth/recovery/confirm',{pendingToken:pending.pendingToken,recoveryToken:recovery.recoveryToken,downloadConfirmed:true});assert.equal(activated.status,200);const session=await activated.json(),cookie=activated.headers.get('Set-Cookie').split(';')[0];
 const headers={Origin:origin,Cookie:cookie,'X-CSRF-Token':session.csrfToken};
 const account=await (await request('/api/account',{headers})).json();const collection=account.collections[0].id;
 const create=async extra=>{const response=await post('/api/contacts',{name:'Self-hosted share',collections:[collection],mimeTypes:['text/plain'],expiresAt:Date.now()+3600000,...extra},headers);assert.equal(response.status,200,await response.clone().text());return response.json();};
 const send=async url=>{const data=new FormData();data.set('collection',collection);data.set('mimeType','text/plain');data.set('idempotencyKey',crypto.randomUUID());data.set('message',new Blob(['Private payload'],{type:'text/plain'}),'message.txt');return request(url,{method:'POST',form:data});};
 return {directory,request,post,headers,session,collection,create,send,get app(){return app;},restart:async()=>{await app.close();app=await createNodeServer({directory,config:{APP_ORIGIN:origin,BRAND_NAME:'Private Notes'}});},close:async()=>{await app.close();await rm(directory,{recursive:true,force:true});}};
}

test('Node signed contact uses configured origin and survives SQLite restart with encrypted URL/key custody',async()=>{
 const f=await fixture();try{
  const config=await (await f.request('/api/config')).json();assert.equal(config.origin,origin);assert.equal(config.brand.name,'Private Notes');
  const contact=await f.create();assert(contact.url.startsWith(origin+'/users/local_contact/contact/'));
  const tokenResponse=await f.request(contact.url,{headers:{Accept:MIME,Origin:'https://sender.example'}});assert.equal(tokenResponse.status,200);assert.equal(tokenResponse.headers.get('Set-Cookie'),null);assert.equal(tokenResponse.headers.get('Access-Control-Allow-Credentials'),null);const token=await tokenResponse.text();
  const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));assert.equal(claims.iss,origin);assert.equal(claims.aud,origin+'/api/messages');
  const controller=f.app.resources.accounts.get(f.session.account.id);const rows=new Map(await controller.metadata.list());
  assert(!JSON.stringify(rows.get(`contact-url/${contact.id}`)).includes(contact.url));assert(rows.get('signing-key').encrypted);assert.equal(rows.get('signing-key').privateKey,undefined);
  const publicKeys=[...rows].filter(([key])=>key.startsWith('contact-key/'));assert.equal(publicKeys.length,1);assert.equal(publicKeys[0][1].publicJwk.d,undefined);
  const before=await f.send(contact.url);assert.equal(before.status,202,await before.clone().text());const {id}=await before.json();
  await f.restart();assert.equal((await f.request(contact.url,{headers:{Accept:MIME}})).status,200);
  const download=await f.request(`/api/messages/${id}/download`,{headers:f.headers});assert.equal(download.status,200);assert.equal(await download.text(),'Private payload');
  const revoked=await f.request(`/api/contacts/${contact.id}`,{method:'DELETE',headers:f.headers});assert.equal(revoked.status,200);assert.equal((await f.request(contact.url,{headers:{Accept:MIME}})).status,401);
 }finally{await f.close();}
});

test('Node archive serializes concurrent owner updates and message ingress without losing committed state',async()=>{
 const f=await fixture();try{
  const contact=await f.create();const owner=f.session.account.id;const controller=f.app.resources.accounts.get(owner);
  const minted=await controller.invoke({method:'mintContact',args:[owner,contact.url]});assert.equal(minted.$fault,undefined);
  const delivered=await controller.invoke({method:'receive',args:[owner,minted.token,{collection:f.collection,mimeType:'text/plain',bytes:Array.from(new TextEncoder().encode('Archive race payload')),idempotencyKey:'archive-race'}]});assert.equal(delivered.$fault,undefined);const {id}=delivered;await controller.metadata.put('lastOwnerActiveAt',0);
  let reached,release;const waiting=new Promise(resolve=>reached=resolve),barrier=new Promise(resolve=>release=resolve);const put=controller.archives.put.bind(controller.archives);
  controller.archives.put=async(...args)=>{reached();await barrier;return put(...args);};
  const alarm=controller.alarm();await waiting;
  const update=controller.invoke({method:'updateMessage',args:[owner,id,{read:true,tags:['committed-during-archive']}]});
  const ingress=controller.invoke({method:'receive',args:[owner,minted.token,{collection:f.collection,mimeType:'text/plain',bytes:Array.from(new TextEncoder().encode('Concurrent incoming payload')),idempotencyKey:'concurrent-ingress'}]});
  await new Promise(resolve=>setImmediate(resolve));release();const results=await Promise.all([alarm,update,ingress]);assert.equal(results[1]?.$fault,undefined);assert.equal(results[2]?.$fault,undefined);await controller.warm(owner);
  const record=await controller.messages.read(owner,id);assert.deepEqual(record.tags,['committed-during-archive']);assert.equal(typeof record.readAt,'number');assert.equal((await controller.message(owner,id)).render.kind,'document');assert.equal((await controller.messages.list(owner)).length,2);assert.equal(new TextDecoder().decode((await controller.content(owner,results[2].id)).bytes),'Concurrent incoming payload');
 }finally{await f.close();}
});
