import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {encryptSecret} from '../packages/runtime/secrets.mjs';
import {mcpCollections,mcpOperation} from '../packages/mcp/account.mjs';

async function connectorFixture(){
  const key=Buffer.alloc(32,42).toString('base64');
  const resource={id:'resource',owner:'owner',provider:'webdav',status:'unverified',capabilities:{read:true,list:true},secret:await encryptSecret({endpoint:'https://dav.example/storage/',prefix:'selected',username:'probe-user',password:'probe-password'},key)};
  const writes=[];
  const account={config:{KEY_ENCRYPTION_KEY:key,ALLOWED_CONNECTOR_HOSTS:'dav.example'},metadata:{get:async()=>structuredClone(resource),put:async(k,v)=>writes.push([k,structuredClone(v)])}};
  return {account,writes};
}

test('known-key verification reads exactly the scoped object and returns neither credentials nor probe bytes',async t=>{
  const {account,writes}=await connectorFixture(),requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url:String(url),options});return new Response('private probe contents',{headers:{ETag:'"probe-v1"'}});});
  const result=await AccountController.prototype.verifyResource.call(account,'owner','resource',{key:'app/directory.json'});
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'https://dav.example/storage/selected/app/directory.json');
  assert.equal(requests[0].options.method??'GET','GET');
  assert.equal(requests[0].options.redirect,'error');
  assert.equal(result.status,'connected');
  assert.equal(Object.hasOwn(result,'secret'),false);
  assert.equal(Object.hasOwn(result.capabilities,'list'),false);
  assert.doesNotMatch(JSON.stringify(result),/private probe contents|probe-password|probe-user/);
  assert.equal(writes.length,1);
});

test('failed known-key reads never mark a connector verified or fall back to enumeration',async t=>{
  for(const status of [403,404,502]){
    const {account,writes}=await connectorFixture();let requests=0;
    const mock=t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response('upstream secret details',{status});});
    try{
      await assert.rejects(AccountController.prototype.verifyResource.call(account,'owner','resource',{key:'directory.json'}),error=>{assert.doesNotMatch(error.message,/upstream secret details/);return true;});
      assert.equal(requests,1);
      assert.equal(writes.length,0);
    }finally{mock.mock.restore();}
  }
});

test('persisted list capability cannot restore storage enumeration through MCP',async()=>{
  let dispatched=false;
  const account={warm:async()=>{},messages:{collections:async()=>[]},metadata:{list:async()=>new Map([['resource/r',{id:'r',owner:'owner',provider:'hosted',status:'connected',capabilities:{read:true,list:true}}]])},federationRPC:async()=>{dispatched=true;}};
  const collections=await mcpCollections(account,'owner');
  assert.equal(collections[0].tools.includes('items_list'),false);
  assert.equal(collections[0].tools.includes('item_read'),true);
  await assert.rejects(mcpOperation(account,'owner','client','items_list',{collectionId:'resource:r'}),{code:'forbidden'});
  assert.equal(dispatched,false);
});
