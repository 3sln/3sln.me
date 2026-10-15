import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,mkdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {publicArtifacts,publicContracts,publicSchemas,artifactIdentifier} from '../packages/core/public-contracts.mjs';
import application from '../packages/runtime/http.mjs';
const origin='https://bindle.example';
async function build(t){const out=await mkdtemp(join(tmpdir(),'bindle-contract-registry-'));t.after(()=>rm(out,{recursive:true,force:true}));await mkdir(join(out,'artefacts/contracts/obsolete'),{recursive:true});await writeFile(join(out,'artefacts/contracts/obsolete/v1.json'),'{}');const result=spawnSync(process.execPath,['scripts/build-docs.mjs'],{env:{...process.env,PUBLIC_DOCS_OUTPUT:out},encoding:'utf8'});assert.equal(result.status,0,result.stderr);return out;}
function host(out){const calls=[];const env={APP_ORIGIN:origin,ASSETS:{fetch:async request=>{const path=new URL(request.url).pathname;calls.push(path);try{return new Response(await readFile(join(out,path)),{headers:{'Content-Type':path.endsWith('.html')?'text/html':'application/json'}});}catch{return new Response('missing',{status:404});}}},IDENTITY_ENGINE:()=>{throw Error('Public contract must not instantiate identity');}};return {calls,env,request:(path,options={})=>application.fetch(new Request(origin+path,options),env)};}

test('registry publishes exact existing JSON definitions and separates submission schemas from resource contracts',async t=>{
 const out=await build(t),index=JSON.parse(await readFile(join(out,'artefacts/contracts/index.json'),'utf8')),html=await readFile(join(out,'artefacts/contracts/index.html'),'utf8');
 assert.equal(index.contracts.length,6);assert.equal(index.schemas.length,1);assert.equal(index.schemas[0].kind,'submission-schema');
 assert.equal(publicContracts.length,6);assert.equal(publicSchemas.length,1);
 for(const artifact of publicArtifacts){const original=await readFile(artifact.source,'utf8'),emitted=await readFile(join(out,artifact.path),'utf8');assert.equal(emitted,original);assert.equal(artifactIdentifier(artifact,JSON.parse(emitted)),artifact.id);if(artifact.kind==='manifest-profile')assert(JSON.parse(emitted).declaration.$schema);else if(artifact.kind!=='preferences-fragment')assert(JSON.parse(emitted).$schema);assert(html.includes('href="'+artifact.path+'"'));assert(index.contracts.concat(index.schemas,index.fragments,index.profiles).some(entry=>entry.schema===artifact.path&&entry.id===artifact.id));}
 await assert.rejects(access(join(out,'artefacts/contracts/obsolete/v1.json')));await assert.rejects(access(join(out,'artefacts/contracts/conversation/v2.json')));await assert.rejects(access(join(out,'artefacts/automation-v1.json')));
 assert.match(html,/not a complete resource RPC contract/);assert.match(await readFile(join(out,'docs/index.html'),'utf8'),/href="\/artefacts\/contracts\/">Contract registry/);
 const conversation=await readFile(join(out,'docs/spec/conversations.html'),'utf8');assert.match(conversation,/href="\/artefacts\/conversation-v1.json"/);assert(!conversation.includes('href="../artefacts/'));
 const agent=await readFile(join(out,'llms.txt'),'utf8');for(const artifact of publicArtifacts)assert(agent.includes(artifact.path));
});

test('canonical IDs, explicit JSON and legacy source aliases return identical machine JSON even to browsers',async t=>{
 const out=await build(t),h=host(out);
 for(const artifact of publicArtifacts)for(const path of new Set([new URL(artifact.id).pathname,artifact.path,'/'+artifact.source,`/artefacts/${artifact.name}-${artifact.version}.json`]))for(const accept of ['text/html','application/schema+json','*/*']){
  const response=await h.request(path,{headers:{Accept:accept,Cookie:'private=irrelevant'}});assert.equal(response.status,200,path);assert.equal(response.headers.get('Content-Type'),['preferences-fragment','manifest-profile'].includes(artifact.kind)?'application/json':'application/schema+json');assert.equal(await response.text(),await readFile(artifact.source,'utf8'));assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(response.headers.get('Content-Location'),artifact.path);assert.match(response.headers.get('Cache-Control'),/^public/);assert.equal(response.headers.get('Set-Cookie'),null);
 }
 for(const artifact of publicArtifacts){const head=await h.request(artifact.path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');const before=h.calls.length;assert.equal((await h.request(artifact.path,{method:'OPTIONS'})).status,204);assert.equal(h.calls.length,before);assert.equal((await h.request(artifact.path,{method:'POST'})).status,405);}
});

test('directory links all resolve to JSON and missing/proposed contracts stay errors',async t=>{
 const out=await build(t),h=host(out);assert.equal((await h.request('/artefacts/contracts')).headers.get('Location'),'/artefacts/contracts/');
 const page=await h.request('/artefacts/contracts/');assert.equal(page.status,200);assert.match(page.headers.get('Content-Type'),/text\/html/);const html=await page.text();
 const targets=[...html.matchAll(/href="([^"#]+\.json)"/g)].map(match=>match[1]);assert.equal(targets.length,10);
 for(const target of targets){const response=await h.request(target,{headers:{Accept:'text/html'}});assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/json/);await response.json();}
 for(const path of ['/artefacts/contracts/conversation/v2','/artefacts/contracts/made-up/v1.json','/docs/artefacts/automation-v1.json'])assert.equal((await h.request(path)).status,404);
 h.env.ASSETS.fetch=async()=>new Response(null,{status:304,headers:{ETag:'"schema"'}});const unchanged=await h.request(publicContracts[0].path,{headers:{'If-None-Match':'"schema"'}});assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');assert.equal(unchanged.headers.get('ETag'),'"schema"');
 h.env.ASSETS.fetch=async()=>new Response('missing',{status:404});assert.equal((await h.request(publicContracts[0].path)).status,404);
});
