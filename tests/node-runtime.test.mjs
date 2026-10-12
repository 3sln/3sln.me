import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeServer } from '../apps/node/server.mjs';
test('same HTTP application supports durable unbranded Node signup/recovery/session and restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'bindle-node-'));const origin='http://localhost:8788';let app;
 try{
  app=await createNodeServer({directory});
  const post=(path,value,headers={})=>app.fetch(new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(value)}));
  const signup=await post('/api/auth/signup',{handle:'selfhost',method:'password',password:'Self hosted test long password!',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'});assert.equal(signup.status,200);const pending=await signup.json();
  const recovery=await (await post('/api/auth/recovery/download',{pendingToken:pending.pendingToken})).json();
  const activation=await post('/api/auth/recovery/confirm',{pendingToken:pending.pendingToken,recoveryToken:recovery.recoveryToken,downloadConfirmed:true});assert.equal(activation.status,200);const session=await activation.json();const cookie=activation.headers.get('Set-Cookie').split(';')[0];assert.equal(session.account.handle,'selfhost');assert.equal(session.sessionToken,undefined);
  const snapshot=await app.fetch(new Request(origin+'/api/account',{headers:{Cookie:cookie}}));assert.equal(snapshot.status,200);const account=await snapshot.json();assert.equal(account.collections[0].name,'Inbox');
  await app.close();app=await createNodeServer({directory});
  const after=await app.fetch(new Request(origin+'/api/session',{headers:{Cookie:cookie}}));assert.equal((await after.json()).account.handle,'selfhost');
  assert.equal((await post('/api/contacts',{name:'Test'}, {Cookie:cookie,'X-CSRF-Token':'incorrect'})).status,403);
 }finally{await app?.close();await rm(directory,{recursive:true,force:true});}
});
