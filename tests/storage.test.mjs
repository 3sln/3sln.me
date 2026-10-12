import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedEndpoint, endpointKey, objectKey } from '../packages/storage/policy.mjs';
import { S3Adapter, WebDAVAdapter } from '../packages/storage/adapters.mjs';
test('connector destinations reject private endpoints, credentials, redirects and unknown custom hosts',()=>{
 for(const value of ['http://s3.amazonaws.com','https://127.0.0.1','https://localhost','https://user:secret@s3.amazonaws.com','https://s3.amazonaws.com:8443','https://unknown.example'])assert.throws(()=>approvedEndpoint(value));
 assert.equal(approvedEndpoint('https://s3.us-east-1.amazonaws.com').hostname,'s3.us-east-1.amazonaws.com');
 assert.equal(approvedEndpoint('https://dav.example',['dav.example']).hostname,'dav.example');
});
test('resource keys cannot escape approved storage roots',()=>{
 for(const key of ['../secret','a/../b','a\\b','a/%2e%2e/b','a\0b'])assert.throws(()=>objectKey(key));
 assert.equal(endpointKey(new URL('https://dav.example/root/'),'private','folder/a b').href,'https://dav.example/root/private/folder/a%20b');
});
test('unverified provider writes and presigned uploads remain unavailable',async()=>{
 const s3=new S3Adapter({endpoint:'https://s3.amazonaws.com',bucket:'bucket',accessKeyId:'test',secretAccessKey:'test',write:true});
 await assert.rejects(s3.put({key:'a',bytes:new Uint8Array(1),condition:{absent:true}}),{code:'write_unavailable'});
 await assert.rejects(s3.presign({key:'a',operation:'write'}),{code:'unsupported'});
 assert.equal(new WebDAVAdapter({endpoint:'https://dav.example',username:'a',password:'b'},{allowedHosts:['dav.example']}).describe().write,false);
});


// The provider-native list helpers are not public object-storage RPC methods.
import { AccountController } from '../packages/runtime/accounts.mjs';
import { HostedR2Adapter, GoogleDriveAdapter } from '../packages/storage/providers.mjs';
import { readFile } from 'node:fs/promises';
test('object-storage listing is rejected before warm-up, metadata or upstream work',async()=>{
 let touched=false;const owner='00000000-0000-4000-8000-000000000001';
 const account={config:{APP_ORIGIN:'https://identity.example'},warm:async()=>{touched=true;throw new Error('Must not touch storage');}};
 await assert.rejects(AccountController.prototype.federationRPC.call(account,{subject:`https://identity.example/entities/${owner}`,method:'list'}),{code:'unsupported_method'});
 await assert.rejects(AccountController.prototype.hostedOperation.call({}, {id:'resource'},'list',{}),{code:'unsupported_method'});
 assert.equal(touched,false);
});
test('object-storage schema and provider capabilities contain no listing surface',async()=>{
 const schema=JSON.parse(await readFile(new URL('../docs/artefacts/object-storage-v1.json',import.meta.url)));
 assert.equal(schema.oneOf.some(v=>v.properties.method.const==='list'),false);
 assert.equal(Object.hasOwn(schema.$defs.capabilitiesResult.properties,'list'),false);
 assert.equal(Object.hasOwn(schema['x-permissions'],'list'),false);
 for(const adapter of [new S3Adapter({endpoint:'https://s3.amazonaws.com',bucket:'bucket',accessKeyId:'test',secretAccessKey:'test'}),new GoogleDriveAdapter({accessToken:'test',rootFolder:'root'}),new HostedR2Adapter({bucket:{},namespace:'root'})])assert.equal(Object.hasOwn(adapter.describe(),'list'),false);
 const caps=await AccountController.prototype.hostedOperation.call({}, {capabilities:{read:true,list:true}},'capabilities');assert.deepEqual(caps,{read:true});
});

test('connector verification requires an explicit known key before credential/storage access',async()=>{
 let touched=false;const account={metadata:{get:async()=>{touched=true;throw new Error('must not access');}}};
 for(const input of [{},{key:'../escape'},{key:''}])await assert.rejects(AccountController.prototype.verifyResource.call(account,'owner','resource',input));
 assert.equal(touched,false);
});
