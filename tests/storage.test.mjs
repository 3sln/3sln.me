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
