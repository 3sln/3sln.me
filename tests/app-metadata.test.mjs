import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectAppMetadata,parseBindleAppManifest,discoverWebAppManifest,metadataPolicy,validateAppMetadataConfig} from '../packages/apps/metadata.mjs';
import {nodeResources} from '../apps/node/resources.mjs';
import {digest} from '../packages/messaging/store.mjs';
const origin='https://app.example',client={id:'app.example',name:'Registered app',redirectUris:[origin+'/callback'],origins:[origin]},policy=metadataPolicy(client);
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/manifest+json'}});
test('declared application metadata is useful without network and remains public presentation',async()=>{
 const result=await collectAppMetadata({...client,application:{name:' App\u202E name ',short_name:'Short',description:'Useful app',icons:[{src:origin+'/icon.png',type:'image/png',sizes:'192x192'}],web_manifest:origin+'/manifest.json'}});
 assert.equal(result.name,'App name');assert.equal(result.description,'Useful app');assert.equal(result.discovery,'declared');assert.equal(result.appOrigin,origin);assert.equal(result.icons.length,1);assert.equal(result.webAppManifest,undefined);
 assert.throws(()=>validateAppMetadataConfig({...client,application:{web_manifest:'https://evil.example/manifest'}}));
 assert.throws(()=>validateAppMetadataConfig({...client,metadataSources:{indexPage:origin+'/?token=secret'}}));
});
test('Bindle application can refer to a standard PWA manifest and override its branding',async()=>{
 const requests=[],c={...client,metadataSources:{bindleManifest:origin+'/.well-known/bindle/manifest.json'}};
 const metadata=await collectAppMetadata(c,{publicFetch:async(url,options)=>{requests.push(url);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,undefined);return url.includes('.well-known')?json({application:{name:'Bindle app',web_manifest:'/manifest.webmanifest'}}):json({name:'PWA name',description:'PWA description',icons:[{src:'/icon.webp',type:'image/webp'}]});}});
 assert.equal(metadata.name,'Bindle app');assert.equal(metadata.description,'PWA description');assert.equal(metadata.icons[0].src,origin+'/icon.webp');assert.equal(metadata.source.kind,'bindle-manifest');assert.equal(metadata.manifestURL,origin+'/manifest.webmanifest');assert.equal(requests.length,2);
 assert.equal(parseBindleAppManifest({application:{short_name:'Short app'}},origin+'/bindle',policy).name,'Short app');
});
test('HTML manifest discovery uses inert standards parser, decoded attributes and bounded traversal',()=>{
 assert.equal(discoverWebAppManifest('<head><base href="/dir/"><link href="m&#97;nifest.json" REL="alternate MANIFEST"></head>',origin+'/',policy),origin+'/dir/manifest.json');
 assert.equal(discoverWebAppManifest('<script>"<link rel=manifest href=/bad>"</script><template><link rel=manifest href=/bad></template><link rel=manifest href=/good>',origin+'/',policy),origin+'/good');
 assert.equal(discoverWebAppManifest('<base href="https://evil.example/"><link rel=manifest href=/bad>',origin+'/',policy),undefined);
 assert.equal(discoverWebAppManifest('<div>'.repeat(12000),origin+'/',policy),undefined);
});
test('registered authorization page provides discovery fallback; malformed or offline sources are harmless',async()=>{
 const c={...client,metadataSources:{indexPage:origin+'/',authorizationPage:origin+'/login'}},requests=[];
 const metadata=await collectAppMetadata(c,{publicFetch:async url=>{requests.push(url);if(url===origin+'/')throw new Error('offline');if(url.endsWith('/login'))return new Response('<link rel=manifest href="/pwa">',{headers:{'Content-Type':'text/html'}});return json({short_name:'Discovered app'});}});
 assert.equal(metadata.name,'Discovered app');assert.equal(requests.length,3);
 const bad=await collectAppMetadata(c,{publicFetch:async()=>new Response('bad',{headers:{'Content-Type':'application/json'}})});assert.equal(bad.name,client.name);assert.equal(bad.discovery,'fallback');
});
test('MCP review pins presentation metadata and reconnect shows fresh metadata without reviving grants',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'3sln-metadata-'));const app={...client,application:{name:'My useful app',description:'Owner-reviewed label'}};
 const config={APP_ORIGIN:'http://localhost:8788',LOCAL_DEVELOPMENT:'true',MCP_CLIENTS:JSON.stringify([app]),WORK_LIMITS_ENABLED:'false',KEY_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')};
 const resources=await nodeResources({directory,config});t.after(async()=>{resources.close();await rm(directory,{recursive:true,force:true});});const owner=crypto.randomUUID();await resources.repository.create({id:owner,handle:'metadata_test',status:'active',revision:1});const account=resources.accounts.get(owner),collections=await account.mcpCollections(owner);
 const {requestId}=await resources.mcp.begin({client_id:client.id,redirect_uri:client.redirectUris[0],response_type:'code',code_challenge:await digest(crypto,'A'.repeat(43)),code_challenge_method:'S256',state:'metadata-state',scope:'mcp:items_list',resource:config.APP_ORIGIN+'/mcp'});
 const review=await resources.mcp.inspect(owner,requestId);assert.equal(review.client.name,'My useful app');assert.equal(review.client.registeredName,'Registered app');assert.equal(review.client.metadata.appOrigin,origin);
 await resources.mcp.approve(owner,{requestId,permissions:[{collectionId:collections[0].id,tools:['items_list']}]});const [connection]=await account.appConnections(owner);assert.equal(connection.name,review.client.name);assert.deepEqual(connection.metadata,review.client.metadata);assert.equal(connection.metadata.description,'Owner-reviewed label');assert.deepEqual(connection.contracts,[]);
});
test('concurrent MCP consent reads share one metadata fetch and durable snapshot survives later reads',async()=>{
 const {McpAuthorization}=await import('../packages/mcp/service.mjs');const {MemoryMessagingStore}=await import('../packages/messaging/store.mjs');
 const store=new MemoryMessagingStore();let calls=0,release;const wait=new Promise(resolve=>{release=resolve;});
 const registered={...client,metadataSources:{webAppManifest:origin+'/manifest'}};
 const service=new McpAuthorization({metadata:{transaction:fn=>store.transaction(fn)},config:{APP_ORIGIN:'https://identity.example',MCP_CLIENTS:JSON.stringify([registered]),APP_METADATA_FETCH:async()=>{calls++;await wait;return json({name:'Fetched once'});}}});
 const {requestId}=await service.begin({client_id:client.id,redirect_uri:client.redirectUris[0],response_type:'code',code_challenge:await digest(crypto,'A'.repeat(43)),code_challenge_method:'S256',state:'singleflight-state',scope:'mcp:items_list',resource:'https://identity.example/mcp'});
 const reads=[service.inspect('owner',requestId),service.inspect('owner',requestId)];await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,1);release();const values=await Promise.all(reads);assert.equal(values[0].client.name,'Fetched once');assert.deepEqual(values[0].client.metadata,values[1].client.metadata);
 await service.inspect('owner',requestId);assert.equal(calls,1);assert.equal(service.metadataLoads.size,0);
});
