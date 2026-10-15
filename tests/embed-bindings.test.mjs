import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {provider,post,form,createEntry,providerPage,exchange,refresh,dpopKey,tokenNonce,embedHeaders,embedNonce,codeOf,b64,issuer,embedOrigin,appOrigin,clientId} from './authorization-entry-helpers.mjs';
import {EMBED_PROOF_TYP} from '../packages/federation/dpop.mjs';
const api=path=>`${embedOrigin}/embed/api/${path}`;
async function attest(p,key,entryId,{signer=key,typ=EMBED_PROOF_TYP,entry=entryId}={}){
 const challenge=await post(p,`${issuer}/oauth/entries/${entryId}/embed-challenge`,{},{Origin:issuer,'Sec-Fetch-Site':'same-origin'});if(!challenge.ok)return {status:challenge.status};
 const proof=await signer.sign({typ,htu:`${issuer}/oauth/entries/${entryId}/embed-verify`,nonce:(await challenge.json()).challenge,claims:{entry},iat:Math.floor(p.clock()/1000)});
 const verified=await post(p,`${issuer}/oauth/entries/${entryId}/embed-verify`,{proof},{Origin:issuer});return {status:verified.status,...await verified.json()};
}
async function embedFlow(p,{key,session=p.signIn()}={}){
 key??=await dpopKey();const {entryId,verifier,body}=await createEntry(p,{delivery:'embed-popup',embedJkt:key.jkt},{Origin:embedOrigin});
 const {pageSecret}=await attest(p,key,entryId),page=await providerPage(p,entryId,session,{pageSecret});return {entryId,verifier,body,key,pageSecret,page,result:page.result};
}
const redeem=async(p,claim,key)=>post(p,api('claim'),{claim},embedHeaders({DPoP:await key.sign({htu:api('claim'),nonce:await embedNonce(p),ath:claim,iat:Math.floor(p.clock()/1000)})}));
const call=async(p,path,scheme,value,key)=>p.fetch(api(path),{method:'POST',headers:embedHeaders({Authorization:`${scheme} ${value}`,DPoP:await key.sign({htu:api(path),nonce:await embedNonce(p),ath:value,iat:Math.floor(p.clock()/1000)})})});
const startSession=(p,credential,key)=>call(p,'session','BindleEmbed',credential,key);

test('an attested embed approval yields a key-bound single-use claim; the credential activates only on the paired exchange',async()=>{
 const p=await provider(),{result,verifier,body,key}=await embedFlow(p),other=await dpopKey();
 assert.deepEqual(Object.keys(result).sort(),['claim','code','iss','state']);assert.equal(result.state,body.state);assert.equal(result.iss,issuer);
 assert.equal((await redeem(p,result.claim,other)).status,401);
 const redeemed=await redeem(p,result.claim,key);assert.equal(redeemed.status,200);const {credential,expires_in}=await redeemed.json();assert.equal(expires_in,600);assert.equal(redeemed.headers.get('Access-Control-Allow-Origin'),null);
 assert.equal((await redeem(p,result.claim,key)).status,401);
 assert.equal((await startSession(p,credential,key)).status,401);
 const token=await(await exchange(p,result.code,verifier)).json();assert.ok(token.access_token);
 const started=await startSession(p,credential,key);assert.equal(started.status,200);const session=await started.json();assert.equal(session.expires_in,600);assert.deepEqual(session.view,{subject:p.accounts[0].subject,handle:'alex',name:'Display alex',avatar:false},'the view carries the subject and avatar presence only');
 const state=await call(p,'state','BindleEmbedSession',session.session,key);assert.equal(state.status,200);assert.equal((await state.json()).view.handle,'alex');
 // A valid proof from another key is rejected identically and revokes nothing.
 const wrong=await startSession(p,credential,other);assert.equal(wrong.status,401);assert.deepEqual(await wrong.json(),{error:'unauthorized'});assert.equal((await startSession(p,credential,key)).status,200);
 assert.equal((await call(p,'forget','BindleEmbed',credential,key)).status,200);assert.equal((await startSession(p,credential,key)).status,401);assert.equal((await call(p,'state','BindleEmbedSession',session.session,key)).status,401);
});

test('a claim redeemed after the exchange is linked to the app session immediately; an unexchanged credential expires',async()=>{
 const p=await provider(),late=await embedFlow(p);await exchange(p,late.result.code,late.verifier);
 const {credential}=await(await redeem(p,late.result.claim,late.key)).json();assert.equal((await startSession(p,credential,late.key)).status,200);
 const orphan=await embedFlow(p),pending=await(await redeem(p,orphan.result.claim,orphan.key)).json();p.time.advance(600001);
 assert.equal((await exchange(p,orphan.result.code,orphan.verifier)).status,400);assert.equal((await startSession(p,pending.credential,orphan.key)).status,401);
 const expired=await embedFlow(p);p.time.advance(120001);assert.equal((await redeem(p,expired.result.claim,expired.key)).status,401);
});

test('component credentials never appear in client-reachable outputs and are refused at token, revocation and RPC endpoints',async()=>{
 const p=await provider(),flow=await embedFlow(p),{credential}=await(await redeem(p,flow.result.claim,flow.key)).json();
 const tokenResponse=await exchange(p,flow.result.code,flow.verifier),token=await tokenResponse.json(),reachable=JSON.stringify(token)+JSON.stringify(await p.entries.store.transaction(tx=>tx.list('')));
 for(const secret of [credential,flow.result.claim])assert.equal(reachable.includes(secret),false);
 for(const entry of p.log.filter(e=>!e.url.startsWith(embedOrigin)&&e.url.includes(issuer)))for(const secret of [credential])assert.equal(JSON.stringify(entry).includes(secret),false);
 // Every request carrying the claim or credential went to the embed origin only.
 assert.ok(p.log.filter(e=>JSON.stringify(e).includes(credential)).every(e=>e.url.startsWith(embedOrigin)));
 assert.equal((await refresh(p,credential)).status,400);
 assert.equal((await form(p,`${issuer}/oauth/revoke`,{token:credential,client_id:clientId},{Origin:appOrigin})).status,200);assert.equal((await startSession(p,credential,flow.key)).status,200);
 const rpc=await p.fetch(`${issuer}/bindle/rpc`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${credential}`},body:JSON.stringify({version:'0',tx:randomUUID(),resource:'@profile',contract:'https://3sln.me/artefacts/contracts/profile/v1',method:'read',args:{}})});assert.equal(rpc.status,401);
 // The access token cannot open an embed session either.
 assert.equal((await startSession(p,token.access_token,flow.key)).status,401);
 // Plain completions and app-created entries never carry a claim.
 const plain=await createEntry(p),page=await providerPage(p,plain.entryId,p.signIn());assert.deepEqual(Object.keys(page.result),['redirectUri']);
});

test('without the handshake an embed entry continues only in irreversible plain mode with no claim',async()=>{
 const p=await provider(),key=await dpopKey(),alex=p.signIn(),{entryId}=await createEntry(p,{delivery:'embed-popup',embedJkt:key.jkt},{Origin:embedOrigin});
 const refused=await providerPage(p,entryId,alex);assert.equal(refused.selected.status,403);assert.equal(refused.selection.error,'embed_attestation_required');
 const page=await providerPage(p,entryId,alex,{plain:true});assert.deepEqual(Object.keys(page.result),['redirectUri']);assert.ok(codeOf(page.result.redirectUri));
 const after=await createEntry(p,{delivery:'embed-popup',embedJkt:key.jkt},{Origin:embedOrigin});await providerPage(p,after.entryId,alex,{plain:true,decision:'deny'});
 assert.equal((await attest(p,key,after.entryId)).status,400);
 const declared=await createEntry(p,{delivery:'embed-popup',embedJkt:key.jkt},{Origin:embedOrigin}),view=await p.entries.view(declared.entryId);
 await post(p,`${issuer}/api/oauth/entries/${declared.entryId}/select`,{nonce:view.entry.nonce,plain:true},{Origin:issuer,Cookie:alex.cookie,'X-CSRF-Token':alex.csrf});
 assert.equal((await attest(p,key,declared.entryId)).status,403);assert.equal((await p.fetch(`${issuer}/oauth/authorize?entry=${declared.entryId}`)).headers.get('Cross-Origin-Opener-Policy'),'same-origin');
 // Once attested, neither a plain declaration nor a wrong page secret can decide.
 const attested=await createEntry(p,{delivery:'embed-popup',embedJkt:key.jkt},{Origin:embedOrigin});const {pageSecret}=await attest(p,key,attested.entryId);assert.ok(pageSecret);
 assert.equal((await providerPage(p,attested.entryId,alex,{plain:true})).selected.status,403);assert.equal((await providerPage(p,attested.entryId,alex,{pageSecret:b64(32)})).selected.status,403);
});

test('the opener handshake requires the entry key, the single-use challenge, the handshake type and the right entry',async()=>{
 const p=await provider(),key=await dpopKey(),other=await dpopKey(),make=async()=>(await createEntry(p,{delivery:'embed-popup',embedJkt:key.jkt},{Origin:embedOrigin})).entryId;
 assert.equal((await attest(p,key,await make(),{signer:other})).status,403);
 assert.equal((await attest(p,key,await make(),{typ:'dpop+jwt'})).status,403);
 const first=await make(),second=await make();assert.equal((await attest(p,key,first,{entry:second})).status,403);
 assert.equal((await attest(p,key,first)).status,200);assert.equal((await attest(p,key,first)).status,403);
 const limited=await make();for(let n=0;n<3;n++)await attest(p,key,limited,{signer:other});assert.equal((await attest(p,key,limited)).status,403);
 const app=await createEntry(p);assert.equal((await attest(p,key,app.entryId)).status,403);
 assert.equal((await post(p,`${issuer}/oauth/entries/${await make()}/embed-challenge`,{},{Origin:embedOrigin})).status,403);
});

test('embed API is Fetch-Metadata gated, cookieless and CORS-free',async()=>{
 const p=await provider(),url=api('nonce'),status=async headers=>(await p.fetch(url,{method:'POST',headers})).status;
 assert.equal(await status(embedHeaders()),200);
 for(const drop of ['Sec-Fetch-Site','Sec-Fetch-Mode','Sec-Fetch-Dest','X-Bindle-Embed','Origin']){const headers=embedHeaders();delete headers[drop];assert.equal(await status(headers),403,drop);}
 assert.equal(await status(embedHeaders({Origin:appOrigin})),403);assert.equal(await status(embedHeaders({'Sec-Fetch-Site':'cross-site'})),403);
 // Origin: null (a same-origin POST under the shell's no-referrer policy) passes only with Sec-Fetch-Site: same-origin;
 // an opaque-origin initiator (sandboxed or data: document) is never same-origin.
 assert.equal(await status(embedHeaders({Origin:'null'})),200);for(const site of ['cross-site','same-site','none'])assert.equal(await status(embedHeaders({Origin:'null','Sec-Fetch-Site':site})),403,site);
 const nullNoSite=embedHeaders({Origin:'null'});delete nullNoSite['Sec-Fetch-Site'];assert.equal(await status(nullNoSite),403);
 // Origin is required on POST and checked on a GET only when present; every route is POST-only.
 assert.equal((await p.fetch(url,{method:'GET',headers:embedHeaders()})).status,405);const bareGet=embedHeaders();delete bareGet.Origin;assert.equal((await p.fetch(url,{method:'GET',headers:bareGet})).status,405);assert.equal((await p.fetch(url,{method:'GET',headers:embedHeaders({Origin:appOrigin})})).status,403);
 const response=await p.fetch(url,{method:'POST',headers:embedHeaders({Cookie:'__Host-bindle_session=x'})});assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
 assert.equal((await p.fetch(`${issuer}/embed/api/nonce`,{method:'POST',headers:embedHeaders()})).status,404);
});

test('one frame key holds at most four shared sessions; the oldest yields and the rest keep working for every island',async()=>{
 const p=await provider(),flow=await embedFlow(p),{credential}=await(await redeem(p,flow.result.claim,flow.key)).json();await exchange(p,flow.result.code,flow.verifier);
 const sessions=[];for(let n=0;n<5;n++){sessions.push((await(await startSession(p,credential,flow.key)).json()).session);p.time.advance(10);}
 assert.equal((await call(p,'state','BindleEmbedSession',sessions[0],flow.key)).status,401);
 for(const session of sessions.slice(1))for(let island=0;island<2;island++)assert.equal((await call(p,'state','BindleEmbedSession',session,flow.key)).status,200);
});

test('revocation cascade: RFC 7009 on the refresh token, refresh reuse and account suspension end the embed credential',async()=>{
 const p=await provider(),cases=[];for(let n=0;n<3;n++){const flow=await embedFlow(p),{credential}=await(await redeem(p,flow.result.claim,flow.key)).json(),token=await(await exchange(p,flow.result.code,flow.verifier)).json();assert.equal((await startSession(p,credential,flow.key)).status,200);cases.push({...flow,credential,token});}
 await form(p,`${issuer}/oauth/revoke`,{token:cases[0].token.refresh_token,client_id:clientId},{Origin:appOrigin});assert.equal((await startSession(p,cases[0].credential,cases[0].key)).status,401);
 await refresh(p,cases[1].token.refresh_token);assert.equal((await refresh(p,cases[1].token.refresh_token)).status,400);assert.equal((await startSession(p,cases[1].credential,cases[1].key)).status,401);
 const session=await(await startSession(p,cases[2].credential,cases[2].key)).json();p.owners.get(p.accounts[0].owner).status='suspended';
 assert.equal((await startSession(p,cases[2].credential,cases[2].key)).status,401);assert.equal((await call(p,'state','BindleEmbedSession',session.session,cases[2].key)).status,401);
 assert.ok(await tokenNonce(p));
});

test('an unauthenticated caller holding the entry nonce cannot force plain mode',async()=>{
 const p=await provider(),key=await dpopKey(),{entryId}=await createEntry(p,{delivery:'embed-popup',embedJkt:key.jkt},{Origin:embedOrigin}),view=await p.entries.view(entryId);
 const anonymous=await post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce,plain:true},{Origin:issuer,'X-CSRF-Token':'x'});assert.equal(anonymous.status,401);
 assert.equal((await p.entries.view(entryId)).entry.embed.plain,false);const {pageSecret}=await attest(p,key,entryId);assert.ok(pageSecret);
});

import {encodePNG,decodePNG,squareResample,reencodeAvatar,readAvatarSource,avatarOrigins,AVATAR} from '../packages/federation/embed-avatar.mjs';
const getProof=async(p,path,value,key,query='')=>({url:api(path)+query,headers:embedHeaders({Authorization:`BindleEmbedSession ${value}`,DPoP:await key.sign({htm:'GET',htu:api(path),nonce:await embedNonce(p),ath:value,iat:Math.floor(p.clock()/1000)})})});
async function boundSession(p){
 const flow=await embedFlow(p),{credential}=await(await redeem(p,flow.result.claim,flow.key)).json();await exchange(p,flow.result.code,flow.verifier);
 return {...flow,credential,session:(await(await startSession(p,credential,flow.key)).json()).session};
}
async function solidPNG(width,height,[r,g,b,a]){const rgba=new Uint8Array(width*height*4);for(let i=0;i<width*height;i++)rgba.set([r,g,b,a],i*4);return width===height?encodePNG(rgba,width):null;}

test('avatar codec: decodes bounded 8-bit PNGs, cover-crops, resamples and re-encodes; refuses everything else',async()=>{
 const red=await solidPNG(40,40,[220,20,20,255]),decoded=await decodePNG(red);assert.equal(decoded.width,40);assert.deepEqual([...decoded.rgba.subarray(0,4)],[220,20,20,255]);
 const out=await reencodeAvatar(red,64),back=await decodePNG(out);assert.equal(back.width,64);assert.deepEqual([...back.rgba.subarray(4*64*32+4*32,4*64*32+4*32+4)],[220,20,20,255]);
 // A wide source is centre-cropped: a 4x2 image whose middle columns are blue becomes all blue.
 const wide={width:4,height:2,rgba:Uint8Array.from({length:32},(_,i)=>{const x=(i>>2)%4,c=i%4;return c===3?255:(x===1||x===2)?(c===2?255:0):(c===0?255:0);})};
 const square=squareResample(wide,2);for(let i=0;i<4;i++)assert.deepEqual([...square.subarray(i*4,i*4+4)],[0,0,255,255]);
 for(const bad of [new Uint8Array([0xff,0xd8,0xff,0xe0,...new Uint8Array(60)]),new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(80)),red.slice(0,40)])await assert.rejects(reencodeAvatar(bad,64),{code:'avatar_unavailable'});
 const big=new Uint8Array(red);big.set([0,0,8,1],16);await assert.rejects(decodePNG(big),{code:'avatar_unavailable'},'over the side limit');
 await assert.rejects(reencodeAvatar(red,100),{code:'avatar_unavailable'},'only the fixed buckets');
});

test('avatar sources: own static assets or operator-approved HTTPS origins only, no redirects, credentials or queries',async()=>{
 const red=await solidPNG(8,8,[1,2,3,255]),seen=[];
 const assets={fetch:async request=>{seen.push(['asset',request.url]);return new Response(red,{headers:{'Content-Type':'image/png'}});}},fetch=async(url,init)=>{seen.push(['net',url,init.redirect,init.credentials]);return new Response(red);};
 const origins=avatarOrigins(JSON.stringify(['https://images.example']));
 assert.deepEqual(await readAvatarSource(`${issuer}/branding/a.png`,{issuer,assets,fetch,origins}),red);
 assert.deepEqual(await readAvatarSource('https://images.example/a.png',{issuer,assets,fetch,origins}),red);
 assert.deepEqual(seen,[['asset',`${issuer}/branding/a.png`],['net','https://images.example/a.png','manual','omit']]);
 for(const url of ['https://other.example/a.png','https://images.example/a.png?x=1','https://u:p@images.example/a.png','http://images.example/a.png','not a url'])await assert.rejects(readAvatarSource(url,{issuer,assets,fetch,origins}),{code:'avatar_unavailable'},url);
 await assert.rejects(readAvatarSource('https://images.example/a.png',{issuer,assets,origins,fetch:async()=>new Response(null,{status:302,headers:{Location:'https://169.254.169.254/'}})}),{code:'avatar_unavailable'});
 await assert.rejects(readAvatarSource('https://images.example/a.png',{issuer,assets,origins,fetch:async()=>new Response(new Uint8Array(AVATAR.sourceBytes+1))}),{code:'avatar_unavailable'});
 for(const value of ['["http://images.example"]','["https://203.0.113.9"]','["https://images.example/path"]','nope'])assert.equal(avatarOrigins(value).size,0,value);
});

test('GET /embed/api/avatar: session plus GET key proof, re-encoded PNG, CORP same-origin, no CORS, no-store, one fixed deadline',async()=>{
 const picture=await solidPNG(32,32,[220,20,20,255]),waits=[];let now=0;
 const p=await provider({avatars:{alex:`${issuer}/branding/alex.png`},embed:{clock:()=>now,wait:async ms=>{waits.push(ms);now+=ms;},avatars:{responseMs:1500,render:async(source,size)=>{now+=7;assert.equal(source,`${issuer}/branding/alex.png`);return reencodeAvatar(picture,size);}}}});
 const bound=await boundSession(p),other=await dpopKey();
 const ok=await getProof(p,'avatar',bound.session,bound.key,'?s=128'),response=await p.fetch(ok.url,{headers:ok.headers});
 assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin');assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.match(response.headers.get('Content-Security-Policy'),/^sandbox; default-src 'none'$/);
 assert.equal((await decodePNG(new Uint8Array(await response.arrayBuffer()))).width,128);
 const replay=await p.fetch(ok.url,{headers:ok.headers});assert.equal(replay.status,401,'a proof is single use');
 const wrongKey=await getProof(p,'avatar',bound.session,other,'?s=128');assert.equal((await p.fetch(wrongKey.url,{headers:wrongKey.headers})).status,401);
 const post=await getProof(p,'avatar',bound.session,bound.key,'?s=128');assert.equal((await p.fetch(post.url,{method:'POST',headers:post.headers})).status,405);
 for(const query of ['','?s=100','?s=128&b=1','?s=128&s=64']){const r=await getProof(p,'avatar',bound.session,bound.key,query);assert.equal((await p.fetch(r.url,{headers:r.headers})).status,401,query);}
 const noProof=embedHeaders({Authorization:`BindleEmbedSession ${bound.session}`});delete noProof.Origin;assert.equal((await p.fetch(api('avatar')+'?s=64',{headers:noProof})).status,401,'bearer alone is refused');
 // Every outcome waits for the same deadline, measured from arrival.
 assert.ok(waits.length>=8);for(const ms of waits)assert.ok(ms<=1500&&ms>=1493,String(ms));
 // An account without a picture answers 404 at the same deadline; a cross-site or no-cors request never reaches it.
 const sam=await provider({embed:{clock:()=>now,wait:async ms=>{waits.push(ms);now+=ms;},avatars:{responseMs:1500,render:async()=>{throw new Error('unexpected');}}}}),none=await boundSession(sam),r=await getProof(sam,'avatar',none.session,none.key,'?s=64');
 waits.length=0;assert.equal((await sam.fetch(r.url,{headers:r.headers})).status,404);assert.deepEqual(waits,[1500]);
 for(const site of ['cross-site','same-site']){const h=await getProof(p,'avatar',bound.session,bound.key,'?s=64');assert.equal((await p.fetch(h.url,{headers:{...h.headers,'Sec-Fetch-Site':site}})).status,403);}
 const img=await getProof(p,'avatar',bound.session,bound.key,'?s=64');assert.equal((await p.fetch(img.url,{headers:{...img.headers,'Sec-Fetch-Mode':'no-cors','Sec-Fetch-Dest':'image'}})).status,403);
});

test('events stream and session end: a key-bound lease, at most two streams per credential, bearer-only constant end',async()=>{
 const p=await provider({embed:{stream:{tickMs:5,maxMs:60000}}}),bound=await boundSession(p);
 const open=async()=>{const r=await getProof(p,'events',bound.session,bound.key);return p.fetch(r.url,{headers:r.headers});};
 const first=await open();assert.equal(first.status,200);assert.match(first.headers.get('Content-Type'),/^application\/x-ndjson/);assert.equal(first.headers.get('Cache-Control'),'no-store');assert.equal(first.headers.get('Access-Control-Allow-Origin'),null);
 const reader=first.body.getReader(),decoder=new TextDecoder();let text='';const next=async()=>{while(!text.includes('\n')){const {done,value}=await reader.read();if(done)return null;text+=decoder.decode(value);}const [line,...rest]=text.split('\n');text=rest.join('\n');return JSON.parse(line);};
 assert.deepEqual(await next(),{type:'view',view:{subject:p.accounts[0].subject,handle:'alex',name:'Display alex',avatar:false}});assert.deepEqual(await next(),{type:'ping'});
 // Two newer streams for the same credential evict the first, which then ends.
 const second=await open(),third=await open();assert.equal(second.status,200);assert.equal(third.status,200);
 let ended=false;for(let i=0;i<50&&!ended;i++){ended=(await next())===null;}assert.ok(ended,'the oldest stream yields');
 const bareGet=embedHeaders({Authorization:`BindleEmbedSession ${bound.session}`});assert.equal((await p.fetch(api('events'),{headers:bareGet})).status,401,'a stream needs a key proof');
 // session/end: bearer only, idempotent, identical for unknown sessions, and ends the session's streams.
 const end=value=>p.fetch(api('session/end'),{method:'POST',headers:embedHeaders({Authorization:`BindleEmbedSession ${value}`})});
 for(const value of [bound.session,bound.session,`${p.accounts[0].owner}.${'A'.repeat(43)}`,'garbage']){const r=await end(value);assert.equal(r.status,204,value);assert.equal(await r.text(),'');}
 assert.equal((await call(p,'state','BindleEmbedSession',bound.session,bound.key)).status,401);
 for(const stream of [second,third]){const r=stream.body.getReader();let done=false;for(let i=0;i<50&&!done;i++)done=(await r.read()).done;assert.ok(done,'streams end with their session');}
 assert.equal((await p.fetch(api('session/end'),{method:'GET',headers:embedHeaders()})).status,405);
});

test('the avatar deadline is also a ceiling: unfinished work is abandoned and answered as not_found',async()=>{
 const p=await provider({avatars:{alex:`${issuer}/branding/alex.png`},embed:{avatars:{responseMs:300,render:()=>new Promise(()=>{})}}}),bound=await boundSession(p);
 const r=await getProof(p,'avatar',bound.session,bound.key,'?s=64'),started=Date.now(),response=await p.fetch(r.url,{headers:r.headers}),elapsed=Date.now()-started;
 assert.equal(response.status,404);assert.ok(elapsed>=250&&elapsed<1000,String(elapsed));assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
});
