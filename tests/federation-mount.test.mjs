// Root mount of the authorization-entry slice, the embed origin and host administration in packages/runtime/http.mjs:
// flag gating, F7 (the entry document keeps its own CSP and COOP), F8 (the manifest advertises only mounted routes)
// and the components-profile shell contract. Real entry store and federation stack; .example hosts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import application from '../packages/runtime/http.mjs';
import {provider,entryBody,issuer,embedOrigin,clientId,appOrigin} from './authorization-entry-helpers.mjs';
import {federationEntriesRemote,ENTRY_METHODS} from '../packages/runtime/federation.mjs';
const PROFILE='https://3sln.me/artefacts/profiles/components/v1',SHELL='<!doctype html><title>Islands</title><script type="application/json" id="config">{{CONFIG}}</script><script type="module" src="/embed/assets/boot.0123456789.js"></script>';
const SHELL_HASH='sha256-'+'B'.repeat(43)+'=',SHELL_BUILD={v:1,worker:'/embed/assets/apps/embed/src/worker/index.0123456789.js',sw:'/embed/sw.js',scripts:[SHELL_HASH]};
const MAP_HASH='sha256-'+'A'.repeat(43)+'=';
function assets({shell=false}={}){return {fetch:async request=>{const path=new URL(request.url).pathname;
 if(path==='/authorize.html')return new Response(`<!doctype html><head><meta name="bindle-import-map-csp" content="${MAP_HASH}"></head><title>Authorize</title>`,{headers:{'Content-Type':'text/html'}});
 if(shell&&path==='/embed/shell.html')return new Response(SHELL,{headers:{'Content-Type':'text/html'}});
 if(shell&&path==='/embed/shell.json')return new Response(JSON.stringify(SHELL_BUILD),{headers:{'Content-Type':'application/json'}});
 if(shell&&path==='/embed/sw.js')return new Response('self.x=1',{headers:{'Content-Type':'text/javascript'}});
 if(shell&&path==='/embed/assets/boot.0123456789.js')return new Response('export{}',{headers:{'Content-Type':'text/javascript','Set-Cookie':'x=1'}});
 return new Response('Not found',{status:404});}};}
async function fixture({entries=true,embed=true,shell=false,federation='true',extra={}}={}){
 const p=await provider(),consumed=[];
 const env={APP_ORIGIN:issuer,FEDERATION_ENABLED:federation,FEDERATION_ENTRY_ENABLED:'true',...embed?{EMBED_ORIGIN:embedOrigin}:{},LOCAL_DEVELOPMENT:'false',KEY_ENCRYPTION_KEY:p.config.KEY_ENCRYPTION_KEY,ABUSE:{consume:async key=>{consumed.push(key);return true;}},ASSETS:assets({shell}),FEDERATION_AUTHORITY:p.authority,...entries?{FEDERATION_ENTRIES:p.entries}:{},...extra};
 const fetch=(url,init={})=>{const request=new Request(url,init);if(!request.headers.has('CF-Connecting-IP'))request.headers.set('CF-Connecting-IP','203.0.113.7');return application.fetch(request,env);};
 return {p,env,fetch,consumed};
}
const manifestOf=async f=>(await f.fetch(issuer+'/.well-known/bindle/manifest.json')).json();

test('F8: the manifest advertises the entry feature only when mounted and the components profile only with a served shell',async()=>{
 const none=await fixture({entries:false});const bare=await manifestOf(none);
 assert.equal(bare.features['authorization-entry.v1'],undefined);assert.equal(bare.profiles,undefined);assert.ok(bare.features['intents.v1']);assert.equal(bare.revocation_endpoint,issuer+'/oauth/revoke');
 const noShell=await manifestOf(await fixture());
 assert.deepEqual(noShell.features['authorization-entry.v1'],{endpoint:issuer+'/api/oauth/entries',intents:['login','select-account','reauthenticate']});assert.equal(noShell.profiles,undefined,'no islands are built, so the profile is not offered');
 const noEmbed=await manifestOf(await fixture({embed:false,shell:true}));assert.equal(noEmbed.profiles,undefined,'an entry store without the embed origin mounted declares no profile');
 const full=await manifestOf(await fixture({shell:true}));
 assert.deepEqual(full.profiles[PROFILE],{embed_origin:embedOrigin,protocol:[1],parts:{avatar:{versions:[1]},'account-switcher':{versions:[1]},'sign-in':{versions:[1]}},credential_binding:['key-binding.v1']});
 for(const flat of ['authorization_entry_endpoint','authorization_entry_intents','embed_profiles_supported','embed_origin'])assert.equal(full[flat],undefined);
 assert.equal((await (await fixture({federation:'false',shell:true})).fetch(issuer+'/.well-known/bindle/manifest.json')).status,503,'nothing is advertised while federation is disabled');
});

test('entry routes are mounted before the legacy federation routes and stay behind the flags',async()=>{
 const f=await fixture(),{body}=entryBody();
 const created=await f.fetch(issuer+'/api/oauth/entries',{method:'POST',headers:{'Content-Type':'application/json',Origin:appOrigin},body:JSON.stringify(body)});
 assert.equal(created.status,201);assert.equal(created.headers.get('Access-Control-Allow-Origin'),appOrigin);const {entryId}=await created.json();assert.match(entryId,/^[A-Za-z0-9_-]{43}$/);
 assert.ok(f.consumed.some(key=>key.startsWith('bindle/mutation/ip/')),'creation passes the root IP admission first');
 assert.equal((await f.fetch(issuer+'/api/oauth/entries/'+entryId,{headers:{Origin:issuer,'Sec-Fetch-Site':'same-origin'}})).status,200);
 const unmounted=await fixture({entries:false});
 assert.equal((await unmounted.fetch(issuer+'/api/oauth/entries',{method:'POST',headers:{'Content-Type':'application/json',Origin:appOrigin},body:JSON.stringify(body)})).status,503);
 const disabled=await fixture({federation:'false'});
 assert.equal((await disabled.fetch(issuer+'/api/oauth/entries',{method:'POST',headers:{'Content-Type':'application/json',Origin:appOrigin},body:JSON.stringify(body)})).status,503);
 // The legacy request-id document is untouched by the entry handler.
 assert.equal((await f.fetch(issuer+'/oauth/authorize?request_id=bad')).status,400);
});

test('F7: the entry document keeps its strict CSP with frame-src none and its COOP, plus only the import-map hash',async()=>{
 const f=await fixture(),{body}=entryBody();
 const {entryId}=await(await f.fetch(issuer+'/api/oauth/entries',{method:'POST',headers:{'Content-Type':'application/json',Origin:appOrigin},body:JSON.stringify(body)})).json();
 const page=await f.fetch(`${issuer}/oauth/authorize?entry=${entryId}`);assert.equal(page.status,200);
 const csp=page.headers.get('Content-Security-Policy');
 assert.match(csp,/frame-src 'none'/);assert.match(csp,/frame-ancestors 'none'/);assert.match(csp,/default-src 'self'/);assert.match(csp,/style-src 'self'(;|$)/);
 assert.equal(csp.includes('challenges.cloudflare.com'),false,'the root page policy did not replace the handler policy');assert.equal(csp.includes('blob:'),false);
 assert.match(csp,new RegExp(`script-src 'self' '${MAP_HASH.replaceAll('+','\\+')}'`),'only the build import-map hash joins script-src');
 assert.equal(page.headers.get('Cross-Origin-Opener-Policy'),'same-origin');assert.equal(page.headers.get('Cache-Control'),'no-store');assert.equal(page.headers.get('X-Frame-Options'),'DENY');
 // The ordinary console still receives the root policy.
 assert.match((await f.fetch(issuer+'/preferences')).headers.get('Content-Security-Policy'),/frame-src 'self' https:\/\/challenges\.cloudflare\.com blob:/);
});

test('embed origin: mounted only with entries, cookieless shell with per-client frame-ancestors and an inert page otherwise',async()=>{
 const off=await fixture({entries:false,shell:true});assert.equal((await off.fetch(embedOrigin+'/embed?client='+encodeURIComponent(clientId))).status,404);
 const disabled=await fixture({federation:'false',shell:true});assert.equal((await disabled.fetch(embedOrigin+'/embed?client='+encodeURIComponent(clientId))).status,404);
 const f=await fixture({shell:true});
 const shell=await f.fetch(embedOrigin+'/embed?client='+encodeURIComponent(clientId));assert.equal(shell.status,200);
 // Per-client config filled at request time; `<` can never close the JSON block.
 const html=await shell.text(),config=JSON.parse(/id="config">(.*?)<\/script>/.exec(html)[1]);assert.equal(html.replace(/id="config">.*?<\/script>/,'id="config">{{CONFIG}}</script>'),SHELL);
 assert.deepEqual(config,{v:1,issuer,clientId,origins:[appOrigin],parts:['avatar','account-switcher','sign-in'],worker:SHELL_BUILD.worker,sw:'/embed/sw.js'});
 const csp=shell.headers.get('Content-Security-Policy');
 assert.match(csp,new RegExp(`frame-ancestors ${appOrigin.replaceAll('.','\\.')};`));assert.match(csp,new RegExp(`script-src 'self' '${SHELL_HASH.replaceAll('+','\\+')}';`));assert.match(csp,/require-trusted-types-for 'script'; trusted-types bindle-embed$/);assert.match(csp,/frame-src 'none'/);assert.match(csp,/trusted-types bindle-embed/);assert.match(csp,new RegExp(`connect-src 'self' ${issuer.replaceAll('.','\\.')};`));
 assert.equal(shell.headers.get('Set-Cookie'),null);assert.equal(shell.headers.get('X-Frame-Options'),null);assert.equal(shell.headers.get('Cache-Control'),'private, max-age=300');assert.equal(shell.headers.get('Origin-Agent-Cluster'),'?1');assert.equal(shell.headers.get('Referrer-Policy'),'no-referrer');
 const etag=shell.headers.get('ETag');assert.match(etag,/^"[a-f0-9]{64}"$/);assert.equal((await f.fetch(embedOrigin+'/embed?client='+encodeURIComponent(clientId),{headers:{'If-None-Match':etag}})).status,304);
 for(const url of [embedOrigin+'/embed?client=https%3A%2F%2Funknown.example%2Fclient',embedOrigin+'/embed',embedOrigin+'/embed?client='+encodeURIComponent(clientId)+'&x=1']){const inert=await f.fetch(url);assert.equal(inert.status,200);assert.equal(await inert.text(),'<!doctype html><meta charset="utf-8"><title></title>');assert.match(inert.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);assert.equal(inert.headers.get('Content-Security-Policy').includes('script-src'),false);}
 const unbuilt=await fixture();const pending=await unbuilt.fetch(embedOrigin+'/embed?client='+encodeURIComponent(clientId));assert.equal(await pending.text(),'<!doctype html><meta charset="utf-8"><title></title>');assert.equal(pending.headers.get('Cache-Control'),'no-store');
 const asset=await f.fetch(embedOrigin+'/embed/assets/boot.0123456789.js');assert.equal(asset.status,200);assert.equal(asset.headers.get('Set-Cookie'),null);assert.equal(asset.headers.get('Cross-Origin-Resource-Policy'),'same-origin');assert.match(asset.headers.get('Cache-Control'),/immutable/);
 assert.equal(asset.headers.get('Cross-Origin-Embedder-Policy'),'require-corp','the island worker script must be COEP');assert.equal(asset.headers.get('Content-Type'),'text/javascript; charset=utf-8');assert.match(asset.headers.get('Content-Security-Policy'),new RegExp(`connect-src 'self' ${issuer.replaceAll('.','\\.')};`));
 assert.equal((await f.fetch(embedOrigin+'/embed/assets/boot.0123456789.js?v=2')).status,404,'no query variants of immutable assets');
 const sw=await f.fetch(embedOrigin+'/embed/sw.js');assert.equal(sw.status,200);assert.equal(sw.headers.get('Service-Worker-Allowed'),'/embed');assert.equal(sw.headers.get('Cache-Control'),'no-cache');assert.equal(sw.headers.get('Cross-Origin-Resource-Policy'),'same-origin');assert.match(sw.headers.get('Content-Security-Policy'),/connect-src 'self';/);
 assert.equal((await f.fetch(embedOrigin+'/embed/sw.js?scope=/')).status,404);
 for(const path of ['/embed/shell.html','/embed/shell.json'])assert.equal((await f.fetch(embedOrigin+path)).status,404,`${path} is a build input, never served`);
 // A plain-HTTP redirect origin never becomes a frame ancestor outside local development.
 const insecure=await fixture({shell:true,extra:{FEDERATION_ENTRIES:{...f.env.FEDERATION_ENTRIES,clients:new Map([[clientId,{id:clientId,redirectUris:['http://app.example/callback']}]])}}});
 const plain=await insecure.fetch(embedOrigin+'/embed?client='+encodeURIComponent(clientId));assert.match(plain.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);assert.equal(await plain.text(),'<!doctype html><meta charset="utf-8"><title></title>');
 for(const path of ['/console','/api/session','/oauth/authorize','/.well-known/bindle/manifest.json','/embed/../console','/embedded','/embed/assets/missing.js'])assert.equal((await f.fetch(embedOrigin+path)).status,404,path);
 assert.equal((await f.fetch(embedOrigin+'/embed',{method:'POST'})).status,405);
 // Embed API: Fetch Metadata gated, never cross-site, no CORS.
 const api=await f.fetch(embedOrigin+'/embed/api/nonce',{method:'POST',headers:{Origin:'https://evil.example'}});assert.equal(api.status,403);assert.equal(api.headers.get('Access-Control-Allow-Origin'),null);
 const nonce=await f.fetch(embedOrigin+'/embed/api/nonce',{method:'POST',headers:{Origin:embedOrigin,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty','X-Bindle-Embed':'1'}});assert.equal(nonce.status,200);assert.ok((await nonce.json()).nonce);
 assert.ok(f.consumed.some(key=>key.startsWith('embed/api/ip/'))&&f.consumed.some(key=>key.startsWith('embed/shell/ip/')),'shell and API pass IP admission');
 // The app origin never serves islands, and the embed origin cannot reach app routes.
 assert.equal((await f.fetch(issuer+'/embed?client='+encodeURIComponent(clientId))).headers.get('Content-Security-Policy')?.includes('trusted-types bindle-embed')??false,false);
});

test('Worker entry facade: local manifest, structured fault envelopes and no end-session',async()=>{
 const calls=[],config={APP_ORIGIN:issuer,FEDERATION_ENTRY_ENABLED:'true',EMBED_ORIGIN:embedOrigin,KEY_ENCRYPTION_KEY:'k',FEDERATION_CLIENTS:JSON.stringify([{id:clientId,name:'App',origin:appOrigin,redirectUris:[appOrigin+'/callback']}]),FEDERATION_END_SESSION_ENABLED:'true'};
 assert.equal(federationEntriesRemote({config:{...config,FEDERATION_ENTRY_ENABLED:'false'},invoke:()=>{}}),null);
 const remote=federationEntriesRemote({config,invoke:async(method,args)=>{calls.push(method);return method==='view'?{ok:false,error:{code:'invalid_request',message:'expired',retryAfter:5}}:{ok:true,result:{entryId:'x'}};}});
 assert.deepEqual(remote.manifest().features['authorization-entry.v1'].intents,['login','select-account','reauthenticate']);assert.equal(remote.manifest().profiles,undefined);assert.ok(remote.manifest({components:true}).profiles[PROFILE]);
 assert.equal(remote.clients.get(clientId).origin,appOrigin);assert.equal(remote.embedOrigin,embedOrigin);
 assert.deepEqual(await remote.create({}),{entryId:'x'});await assert.rejects(remote.view('id'),error=>error.code==='invalid_request'&&error.retryAfter===5);
 assert.deepEqual(ENTRY_METHODS.filter(m=>typeof remote[m]!=='function'),[]);assert.equal(remote.cleanup,undefined,'cleanup stays inside the store');
});

test('admin routes are mounted inside /api/, same-origin POST only and inert without a service',async()=>{
 const engine={IDENTITY_ENGINE:async()=>({dispose(){}})},f=await fixture({entries:false,extra:engine});
 assert.equal((await f.fetch(issuer+'/api/admin/boot/status',{method:'POST',headers:{Origin:issuer,'Content-Type':'application/json'},body:'{}'})).status,503);
 const seen=[];const g=await fixture({entries:false,extra:{...engine,ADMIN_SERVICE:async()=>({bootStatus:async(input,context)=>{seen.push(context);return {configured:false};}})}});
 const status=await g.fetch(issuer+'/api/admin/boot/status',{method:'POST',headers:{Origin:issuer,'Content-Type':'application/json','X-Bindle-Admin-Actor':'root',Cookie:'__Host-bindle_boot='+'b'.repeat(43)},body:'{}'});
 assert.equal(status.status,200);assert.deepEqual(await status.json(),{configured:false});assert.equal(seen[0].actor,undefined,'only boot or admin actors are recognized');assert.equal(seen[0].bootSession,'b'.repeat(43));
 assert.equal((await g.fetch(issuer+'/api/admin/boot/status',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await g.fetch(issuer+'/api/admin/boot/status')).status,405);
 assert.equal((await g.fetch(issuer+'/api/admin/unknown',{method:'POST',headers:{Origin:issuer,'Content-Type':'application/json'},body:'{}'})).status,404);
});

test('Node composition: one entry store, admin store and the embed host behind their flags',async t=>{
 const {createNodeServer}=await import('../apps/node/server.mjs'),{mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const origin='http://localhost:8797',embed='http://127.0.0.1:8797',directory=await mkdtemp(join(tmpdir(),'3sln-mount-'));
 const app=await createNodeServer({directory,config:{APP_ORIGIN:origin,FEDERATION_ENABLED:'true',FEDERATION_ENTRY_ENABLED:'true',EMBED_ORIGIN:embed,FEDERATION_CLIENTS:JSON.stringify([{id:clientId,name:'App',origin:appOrigin,redirectUris:[appOrigin+'/callback']}])}});
 t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const manifest=await(await app.fetch(new Request(origin+'/.well-known/bindle/manifest.json',{headers:{'CF-Connecting-IP':'203.0.113.9'}}))).json();
 assert.deepEqual(manifest.features['authorization-entry.v1'].intents,['login','select-account','reauthenticate'],'end-session has no Node hook and is never offered');
 const {body}=entryBody(),created=await app.fetch(new Request(origin+'/api/oauth/entries',{method:'POST',headers:{'Content-Type':'application/json',Origin:appOrigin,'CF-Connecting-IP':'203.0.113.9'},body:JSON.stringify({...body,redirectUri:appOrigin+'/callback'})}));
 assert.equal(created.status,201);assert.ok(await app.resources.federationEntries.store.transaction(tx=>tx.get('@alarm')),'creation arms the cleanup alarm');
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const port=app.server.address().port;
 const get=(host,path)=>new Promise((resolve,reject)=>{import('node:http').then(({request})=>{const req=request({host:'127.0.0.1',port,path,headers:{Host:host}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));});req.on('error',reject);req.end();});});
 const shell=await get('127.0.0.1:8797','/embed?client='+encodeURIComponent(clientId));assert.equal(shell.status,200);assert.match(shell.headers['content-security-policy'],/frame-ancestors https:\/\/app\.example/);assert.equal(shell.headers['set-cookie'],undefined);
 assert.equal((await get('127.0.0.1:8797','/console')).status,404);assert.equal((await get('evil.example','/embed')).status,403);
 const disabled=await createNodeServer({directory:await mkdtemp(join(tmpdir(),'3sln-mount-off-')),config:{APP_ORIGIN:'http://localhost:8798'}});t.after(()=>disabled.close());
 assert.equal(disabled.resources.federationEntries,null);assert.ok(disabled.resources.adminStore,'the admin store exists; boot stays inert without BOOTSTRAP_TOKEN_SHA256');
 assert.equal((await disabled.fetch(new Request('http://localhost:8798/api/admin/boot/status',{method:'POST',headers:{Origin:'http://localhost:8798','Content-Type':'application/json'},body:'{}'}))).status,503,'admin routes are unmounted until boot is configured (review M6)');
 assert.equal((await app.fetch(new Request(origin+'/embed/shell.html'))).status,404,'island paths never resolve on the app origin (review M3)');
});

test('entry view accepts a real same-origin browser GET (no Origin header) but never a cross-site or unmarked one',async()=>{
 const f=await fixture(),{body}=entryBody();
 const {entryId}=await(await f.fetch(issuer+'/api/oauth/entries',{method:'POST',headers:{'Content-Type':'application/json',Origin:appOrigin},body:JSON.stringify(body)})).json();
 assert.equal((await f.fetch(issuer+'/api/oauth/entries/'+entryId,{headers:{'Sec-Fetch-Site':'same-origin'}})).status,200);
 assert.equal((await f.fetch(issuer+'/api/oauth/entries/'+entryId)).status,403);
 assert.equal((await f.fetch(issuer+'/api/oauth/entries/'+entryId,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await f.fetch(issuer+'/api/oauth/entries/'+entryId,{headers:{Origin:appOrigin,'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await f.fetch(`${issuer}/oauth/entries/${entryId}/embed-challenge`,{method:'POST',headers:{'Content-Type':'application/json','Sec-Fetch-Site':'same-origin'},body:'{}'})).status,403,'POST still requires the exact Origin');
});

test('a misconfigured embed origin disables components instead of failing requests (review M4)',async()=>{
 const {componentsProfile}=await import('../packages/federation/components-profile.mjs'),c=extra=>componentsProfile({FEDERATION_ENTRY_ENABLED:'true',APP_ORIGIN:issuer,...extra});
 assert.equal(c({EMBED_ORIGIN:embedOrigin}).embedOrigin,embedOrigin);
 for(const value of ['http://embed.provider.example','https://203.0.113.5','https://[2001:db8::1]',issuer,embedOrigin+'/path','not a url'])assert.equal(c({EMBED_ORIGIN:value}),null,value);
 assert.ok(c({EMBED_ORIGIN:'http://127.0.0.1:8787',LOCAL_DEVELOPMENT:'true'}));
 const f=await fixture({extra:{EMBED_ORIGIN:'http://embed.provider.example'}});assert.equal((await f.fetch(issuer+'/.well-known/bindle/manifest.json')).status,200);
});
