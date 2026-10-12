import test from 'node:test';
import assert from 'node:assert/strict';
import {objectURLAuthority} from '../packages/storage/object-urls.mjs';
import {handleObjectURL} from '../packages/storage/object-http.mjs';
import {federationAuthority} from '../packages/runtime/federation.mjs';
import {S3Adapter} from '../packages/storage/adapters.mjs';
const issuer='https://identity.example',owner='00000000-0000-4000-8000-000000000001',id='a'.repeat(43),secret=btoa('x'.repeat(32)),now=1791800000000;
test('signed object URLs cannot expand method, object, owner, issuer or expiry; malformed proofs allocate no shards',async()=>{
 const signer=objectURLAuthority({issuer,secret,clock:()=>now}),url=await signer.sign({owner,id,operation:'read',expiresAt:now+100000});
 assert.equal((await signer.verify(url,'read')).owner,owner);
 for(const [candidate,operation] of [[url,'write'],[url.replace(id,'b'.repeat(43)),'read'],[url.replace('000000000001','000000000002'),'read'],[url.replace(String(now+100000),String(now+200000)),'read'],[url+'&expires='+String(now+100000),'read'],[url+'&extra=true','read'],[url.replace('?expires=','?expires=%31'),'read'],[url.replace('identity.example','other.example'),'read'],[url.replace('/bindle/objects/','/bindle/else/../objects/'),'read']])await assert.rejects(signer.verify(candidate,operation),{code:'unauthorized'});
 let lookups=0,allocations=0;const authority=federationAuthority({config:{APP_ORIGIN:issuer,KEY_ENCRYPTION_KEY:secret},repository:{get:async()=>{lookups++;return null;}},shard:()=>{allocations++;}});
 await assert.rejects(authority.inspectObjectURL(`${issuer}/bindle/objects/${owner}/${id}?expires=${Date.now()+60000}&sig=${'b'.repeat(43)}`,'read'),{code:'unauthorized'});assert.equal(lookups,0);assert.equal(allocations,0);
 const expired=objectURLAuthority({issuer,secret,clock:()=>now+100001});await assert.rejects(expired.verify(url,'read'),{code:'unauthorized'});
});
test('proxy rejects an upload before reading bytes when permission or required conditions fail',async()=>{
 let reads=0,effects=0;
 const request={url:issuer+'/bindle/objects/x',method:'PUT',headers:new Headers({'Content-Type':'text/plain'}),body:{getReader(){reads++;throw new Error('Body must not be consumed');}}};
 const denied=await handleObjectURL(request,{enabled:true,controller:{inspectObjectURL:async()=>{throw Object.assign(new Error(),{code:'forbidden'});}}});assert.equal(denied.status,403);assert.equal(reads,0);
 const conditional=await handleObjectURL(request,{enabled:true,controller:{inspectObjectURL:async()=>({size:1,contentType:'text/plain',condition:{absent:true}}),objectURL:async()=>{effects++;}}});assert.equal(conditional.status,428);assert.equal(reads,0);assert.equal(effects,0);
});
test('proxy enforces exact upload size and type and serves active HTML as an inert attachment',async()=>{
 let effects=0;const controller={inspectObjectURL:async(_,operation)=>operation==='write'?{size:3,contentType:'text/plain',condition:{absent:true}}:{},objectURL:async(_,operation,args)=>{effects++;return operation==='write'?{object:{size:3}}:{dataBase64:btoa('<script>alert(1)</script>'),object:{version:'v1',contentType:'text/html'}};}};
 const put=bytes=>new Request(issuer+'/bindle/objects/x',{method:'PUT',headers:{'Content-Type':'text/plain','If-None-Match':'*'},body:bytes});
 assert.equal((await handleObjectURL(put('ab'),{controller,enabled:true})).status,400);assert.equal((await handleObjectURL(put('abcd'),{controller,enabled:true})).status,413);assert.equal(effects,0);
 assert.equal((await handleObjectURL(put('abc'),{controller,enabled:true})).status,200);assert.equal(effects,1);
 const response=await handleObjectURL(new Request(issuer+'/bindle/objects/x',{headers:{Cookie:'owner-session',Authorization:'Bearer broad-token'}}),{controller,enabled:true});assert.equal(response.headers.get('Content-Type'),'application/octet-stream');assert.match(response.headers.get('Content-Disposition'),/^attachment/);assert.match(response.headers.get('Content-Security-Policy'),/^sandbox/);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');
});
test('native S3 URLs cryptographically require the pinned version and range headers',async()=>{
 const adapter=new S3Adapter({endpoint:'https://s3.amazonaws.com',bucket:'bucket',accessKeyId:'fixture',secretAccessKey:'fixture'}),result=await adapter.presign({key:'file',ifVersion:'"v1"',range:{start:1,end:3}});
 assert.equal(result.mode,'native');assert.deepEqual(result.requiredHeaders,{'Range':'bytes=1-3','If-Match':'"v1"'});const signedHeaders=new URL(result.url).searchParams.get('X-Amz-SignedHeaders');assert.match(signedHeaders,/if-match/);assert.match(signedHeaders,/range/);
});
