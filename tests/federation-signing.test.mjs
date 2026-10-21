import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto as crypto} from 'node:crypto';
import {brokeringKeys,mintAccessToken,verifyAccessToken,peekAccessToken,brokeringEnabled,BROKERING_JWKS_PATH,ACCESS_TOKEN_TYP,DEFAULT_LEAD,MIN_OVERLAP} from '../packages/federation/signing.mjs';
import {handleFederation} from '../packages/federation/http.mjs';
const issuer='https://provider.example',rpc='https://models.example/bindle/rpc',discovery='https://models.example/bindle/resources',contract='https://spec.bindle.example/contracts/decision-model/v1',secret=Buffer.alloc(32,7).toString('base64');
const enc=v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url');
/** Serialized in-memory transactional metadata with the federation tx shape. */
function memory(){const map=new Map();let tail=Promise.resolve();return {map,transaction(fn){const run=tail.then(()=>fn({get:async k=>structuredClone(map.get(k)),set:async(k,v)=>{map.set(k,structuredClone(v));},delete:async k=>{map.delete(k);},list:async()=>[]}));tail=run.catch(()=>{});return run;}};}
function fixture(extra={}){const clock={now:Date.UTC(2026,9,20,12)},metadata=memory();const keys=brokeringKeys({issuer,secret,metadata,clock:()=>clock.now,...extra});return {clock,metadata,keys,mint:(input={},lifetime)=>mintAccessToken(keys,{...grant(),...input,...lifetime===undefined?{}:{lifetime}},{clock:()=>clock.now}),verify:async(token,options={})=>verifyAccessToken(token,{issuer,audience:rpc,now:clock.now,...options,keys:options.jwks??await keys.jwks()})};}
const grant=()=>({subject:`${issuer}/entities/e_123`,audience:rpc,clientId:'https://notes.example/client.json',connection:'c_5c0f',generation:3,resource:'https://models.example/r/abc',grant:'g_81d2',methods:{[contract]:['decide']}});
const reject=(promise,reason)=>assert.rejects(promise,e=>e.code==='invalid_token'&&e.status===401&&(reason===undefined||e.reason===reason));
/** Signs arbitrary header/payload with any ECDSA key, bypassing the minter's checks. */
async function forge(privateKey,header,payload,{raw}={}){const input=`${raw?.header??enc(header)}.${raw?.payload??enc(payload)}`;return `${input}.${Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},privateKey,new TextEncoder().encode(input))).toString('base64url')}`;}

test('minted tokens are RFC 9068 at+jwt with required claims, a fresh jti and a 300 s ceiling',async()=>{
 const f=fixture(),minted=await f.mint(),{header,claims}=peekAccessToken(minted.token);
 assert.deepEqual(Object.keys(header),['alg','typ','kid']);assert.equal(header.alg,'ES256');assert.equal(header.typ,ACCESS_TOKEN_TYP);assert.match(header.kid,/^invoke\./);
 for(const claim of ['iss','sub','aud','client_id','iat','exp','jti'])assert.ok(Object.hasOwn(claims,claim),claim);
 assert.equal(claims.iss,issuer);assert.equal(claims.aud,rpc);assert.equal(claims.exp-claims.iat,300);assert.equal(minted.expiresAt,claims.exp*1000);assert.equal(minted.tokenType,'Bearer');
 assert.deepEqual(claims.bindle,{v:1,purpose:'invoke',connection:'c_5c0f',generation:3,resource:'https://models.example/r/abc',grant:'g_81d2',methods:{[contract]:['decide']},scope:null});
 assert.deepEqual((await f.verify(minted.token)).claims,claims);
 assert.notEqual((await f.mint()).jti,minted.jti);
 const bound=await f.mint({jkt:'0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I'});assert.equal(bound.tokenType,'DPoP');assert.equal(peekAccessToken(bound.token).claims.cnf.jkt,'0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I');
 // Lifetime bounds per purpose, and claims the minter refuses to emit.
 assert.equal(peekAccessToken((await f.mint({},120)).token).claims.exp-peekAccessToken((await f.mint({},120)).token).claims.iat,120);
 for(const lifetime of [301,0,-1,1.5])await assert.rejects(f.mint({},lifetime),{code:'invalid_request'});
 const discover={purpose:'discover',audience:discovery,clientId:issuer,resource:undefined,grant:undefined,methods:undefined};
 const d=peekAccessToken((await f.mint(discover)).token);assert.equal(d.claims.exp-d.claims.iat,60);assert.match(d.header.kid,/^discover\./);assert.equal(d.claims.bindle.resource,undefined);
 await assert.rejects(f.mint(discover,61),{code:'invalid_request'});await assert.rejects(f.mint({...discover,clientId:'https://notes.example/client.json'}),{code:'invalid_request'});
 await assert.rejects(f.mint({purpose:'describe',clientId:issuer},61),{code:'invalid_request'});await assert.rejects(f.mint({purpose:'describe',clientId:issuer}),{code:'invalid_request'});
 assert.ok(await f.mint({purpose:'describe',clientId:issuer,methods:{'https://spec.bindle.example/contracts/resource-scoping/v1':['describe']}},60));
 for(const bad of [{audience:`${issuer}/bindle/rpc`},{audience:`${rpc}?x=1`},{audience:`${rpc}#f`},{audience:'http://models.example/bindle/rpc'},{audience:'https://u:p@models.example/bindle/rpc'},{audience:'https://MODELS.example/bindle/rpc'},{resource:'https://evil.example/r/abc'},{methods:{}},{methods:{[contract]:[]}},{methods:{[contract]:['decide','decide']}},{purpose:'event'},{purpose:'other'},{generation:-1},{connection:'c/../x'},{subject:''},{scope:'all'},{feature:'email-bridge'},{jkt:'short'}])
  await assert.rejects(f.mint(bad),{code:'invalid_request'},JSON.stringify(bad));
});

test('verification enforces issuer, exact audience, purpose, kid purpose and time with at most 30 s leeway',async()=>{
 const f=fixture(),{token}=await f.mint(),{claims}=peekAccessToken(token);
 await reject(f.verify(token,{audience:discovery}),'aud');await reject(f.verify(token,{issuer:'https://other.example'}),'iss');await reject(f.verify(token,{purposes:['describe']}),'purpose');
 assert.ok(await f.verify(token,{now:claims.exp*1000+29999}));await reject(f.verify(token,{now:claims.exp*1000+30000}),'time');
 assert.ok(await f.verify(token,{now:claims.iat*1000-30000}));await reject(f.verify(token,{now:claims.iat*1000-31000}),'time');
 await assert.rejects(f.verify(token,{leeway:31}),TypeError);await assert.rejects(f.verify(token,{audience:'models.example'}),TypeError);
 // Audience confusion: a discovery token is not an invocation token even if presented at the discovery URL as invoke.
 const disc=(await f.mint({purpose:'discover',audience:discovery,clientId:issuer,resource:undefined,grant:undefined,methods:undefined})).token;
 await reject(f.verify(disc),'aud');await reject(f.verify(disc,{audience:discovery}),'purpose');assert.ok(await f.verify(disc,{audience:discovery,purposes:['discover']}));
 // Unknown connection rejects before any key lookup.
 let fetched=0;await reject(f.verify(token,{connection:async peek=>peek.iss===issuer&&peek.connection==='other',jwks:async()=>{fetched++;return f.keys.jwks();}}),'connection');assert.equal(fetched,0);
 assert.ok(await f.verify(token,{connection:async peek=>peek.connection==='c_5c0f',jwks:async kid=>{fetched++;assert.equal(kid,peekAccessToken(token).header.kid);return f.keys.jwks();}}));assert.equal(fetched,1);
 // A validly signed token whose claims break the profile is refused (lifetime, aud array, issuer-origin aud, extra claims).
 const set=await f.keys.jwks(),base={...claims,jti:'AAAAAAAAAAAAAAAAAAAAAA'};
 for(const [payload,reason] of [[{...base,exp:base.iat+301},'claims'],[{...base,aud:[rpc]},'claims'],[{...base,aud:`${issuer}/bindle/rpc`},'claims'],[{...base,scope:'admin'},'claims'],[{...base,nbf:base.iat},'claims'],[{...base,bindle:{...base.bindle,purpose:'discover'}},'claims']])
  await reject(f.verify((await f.keys.sign('invoke',payload)).token,{jwks:set}),reason);
});

test('rotation publishes the next key before use and keeps the retired key for the overlap window only',async()=>{
 const f=fixture(),first=await f.mint(),initial=await f.keys.jwks();assert.equal(initial.keys.length,8,'one active key and one published standby per purpose');assert.deepEqual(initial.keys.map(k=>k.kid.split('.')[0]).sort(),['describe','describe','discover','discover','event','event','invoke','invoke']);
 const [staged]=await f.keys.rotate(['invoke']);assert.equal(staged.activatesAt,f.clock.now+DEFAULT_LEAD);assert.deepEqual(await f.keys.rotate('invoke'),[staged],'rotation is idempotent');
 assert.ok((await f.keys.jwks()).keys.some(k=>k.kid===staged.kid),'next key is published before use');
 f.clock.now+=DEFAULT_LEAD-1000;const last=await f.mint();assert.equal(last.kid,first.kid,'next key does not sign before its lead time');
 f.clock.now+=1000;const second=await f.mint();assert.equal(second.kid,staged.kid);
 // Overlap: the retiring key still verifies tokens it signed, so no valid token is stranded.
 assert.ok(await f.verify(last.token,{now:f.clock.now+290000}));assert.ok((await f.keys.jwks()).keys.some(k=>k.kid===first.kid));
 const status=await f.keys.status();assert.equal(status.find(k=>k.kid===first.kid).state,'retiring');assert.ok(status.every(k=>!('sealed' in k)&&!('d' in k)));
 f.clock.now+=3600000;const after=await f.keys.jwks();assert.ok(!after.keys.some(k=>k.kid===first.kid),'retired key leaves after overlap');await reject(f.verify(last.token,{jwks:after,now:f.clock.now-3600000}),'kid');
 assert.ok(await f.verify(second.token,{now:f.clock.now-3600000}));
 // Automatic staging ahead of the rotation period, and configuration that would strand tokens is refused.
 const auto=fixture({rotateAfter:10*86400000}),k0=(await auto.mint()).kid;auto.clock.now+=10*86400000-DEFAULT_LEAD;await auto.keys.jwks();auto.clock.now+=DEFAULT_LEAD;assert.notEqual((await auto.mint()).kid,k0);
 for(const bad of [{overlap:MIN_OVERLAP-1},{lead:1000},{rotateAfter:DEFAULT_LEAD}])assert.throws(()=>brokeringKeys({issuer,secret,metadata:memory(),...bad}),TypeError);
});

test('provider-side verification rejects tokens claiming issue after the key retired; revoked keys vanish at once',async()=>{
 const f=fixture();await f.keys.rotate('invoke');f.clock.now+=DEFAULT_LEAD-1000;const old=await f.mint(),oldClaims=peekAccessToken(old.token).claims;f.clock.now+=1000;await f.mint();
 assert.ok(await f.keys.verify(old.token,{audience:rpc,now:f.clock.now}));
 // A token from the retiring key with an issue time after retirement (stolen-key replay) fails key_state.
 const late=(await verifyAccessToken(old.token,{keys:await f.keys.jwks(),issuer,audience:rpc,now:f.clock.now,signedWhile:()=>({from:0,until:oldClaims.iat*1000-31000})}).catch(e=>e));assert.equal(late.reason,'key_state');
 // Compromise: the active key is erased, unpublished and replaced immediately; its tokens no longer verify.
 const live=await f.mint(),standby=(await f.keys.status()).find(k=>k.purpose==='invoke'&&k.state==='next').kid,cachedSet=await f.keys.jwks(),r=await f.keys.revoke(live.kid);assert.equal(r.replacement,standby,'the replacement was already published');assert.ok(cachedSet.keys.some(k=>k.kid===standby));assert.equal(r.purpose,'invoke');assert.ok(r.replacement&&r.replacement!==live.kid);
 const jwks=await f.keys.jwks();assert.ok(!jwks.keys.some(k=>k.kid===live.kid));await reject(f.verify(live.token,{jwks}),'kid');await reject(f.keys.verify(live.token,{audience:rpc,now:f.clock.now}),'kid');
 const replaced=await f.mint();assert.equal(replaced.kid,r.replacement);assert.ok(await f.verify(replaced.token,{jwks:cachedSet}),'verifiers holding the pre-compromise key set accept the replacement');
 const stored=f.metadata.map.get('brokering/keyset').keys.find(k=>k.kid===live.kid);assert.deepEqual(Object.keys(stored).sort(),['createdAt','kid','purpose','revokedAt','state']);
 await assert.rejects(f.keys.revoke(live.kid),{code:'not_found'});
 // Revoking a staged key never lets it sign; the purpose keeps its active key.
 const [next]=await f.keys.rotate('discover');await f.keys.revoke(next.kid);f.clock.now+=DEFAULT_LEAD;assert.ok(!(await f.keys.jwks()).keys.some(k=>k.kid===next.kid));
});

test('private keys are sealed at rest and bound to their kid, purpose and public point',async()=>{
 const f=fixture();await f.mint();const record=f.metadata.map.get('brokering/keyset');
 assert.ok(!JSON.stringify(record).includes('"d"'));for(const k of record.keys)assert.deepEqual(Object.keys(k.sealed),['v','iv','ciphertext']);
 // Swapping sealed blobs between keys (or editing the public point) fails AAD and closes signing.
 const swapped=structuredClone(record),[a,b]=swapped.keys;[a.sealed,b.sealed]=[b.sealed,a.sealed];
 const g=fixture();g.metadata.map.set('brokering/keyset',swapped);await assert.rejects(g.mint(),e=>e.code==='brokering_unavailable'&&e.status===503);
 const h=fixture({secret:Buffer.alloc(32,8).toString('base64')});h.metadata.map.set('brokering/keyset',structuredClone(record));await assert.rejects(h.mint(),{code:'brokering_unavailable'});
 for(const bad of [undefined,'',Buffer.alloc(16).toString('base64'),'not base64!'])await assert.rejects(fixture({secret:bad}).keys.jwks(),{code:'brokering_unavailable'});
});

test('algorithm confusion and header tricks are rejected before any claim is trusted',async()=>{
 const f=fixture(),{token}=await f.mint(),{header,claims}=peekAccessToken(token),jwks=await f.keys.jwks(),pub=jwks.keys.find(k=>k.kid===header.kid);
 const attacker=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),attackerJwk=await crypto.subtle.exportKey('jwk',attacker.publicKey);
 const [h,p,s]=token.split('.');
 await reject(f.verify(`${enc({alg:'none',typ:'at+jwt',kid:header.kid})}.${p}.`),'alg');
 // HS256 keyed with the public key bytes (classic RS/ES→HS confusion) never reaches an HMAC verifier.
 const hmac=await crypto.subtle.importKey('raw',new TextEncoder().encode(JSON.stringify(pub)),{name:'HMAC',hash:'SHA-256'},false,['sign']),hi=`${enc({alg:'HS256',typ:'at+jwt',kid:header.kid})}.${p}`;
 await reject(f.verify(`${hi}.${Buffer.from(await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(hi))).toString('base64url')}`),'alg');
 for(const [hdr,reason] of [[{alg:'ES384',typ:'at+jwt',kid:header.kid},'alg'],[{alg:'ES256',typ:'JWT',kid:header.kid},'typ'],[{alg:'ES256',typ:'secevent+jwt',kid:header.kid},'typ'],[{alg:'ES256',typ:'dpop+jwt',kid:header.kid},'typ'],[{alg:'ES256',typ:'at+jwt'},'header'],[{alg:'ES256',typ:'at+jwt',kid:header.kid,jwk:attackerJwk},'header'],[{alg:'ES256',typ:'at+jwt',kid:header.kid,jku:'https://evil.example/jwks'},'header'],[{alg:'ES256',typ:'at+jwt',kid:header.kid,crit:['exp']},'header'],[{alg:'ES256',typ:'at+jwt',kid:'../../etc'},'kid']])
  await reject(f.verify(await forge(attacker.privateKey,hdr,claims)),reason);
 // An attacker key presented under the real kid fails the signature; an event-purpose kid is never an access key.
 await reject(f.verify(await forge(attacker.privateKey,header,claims)),'signature');
 const eventKid=jwks.keys.find(k=>k.kid.startsWith('event.')).kid;await reject(f.verify(await forge(attacker.privateKey,{...header,kid:eventKid},claims)),'kid');
 const discoverKid=jwks.keys.find(k=>k.kid.startsWith('discover.')).kid,crossPurpose=await f.keys.sign('discover',claims);assert.equal(peekAccessToken(crossPurpose.token).header.kid.split('.')[0],'discover');assert.ok(discoverKid);await reject(f.verify(crossPurpose.token),'purpose');
 // Signature encodings and JSON canonicalization.
 await reject(f.verify(`${h}.${p}.${s}AA`),'signature');await reject(f.verify(`${h}.${p}.${s.slice(0,-1)}${s.at(-1)==='A'?'B':'A'}`));await reject(f.verify(`${h}.${p}`),'malformed');await reject(f.verify(`${h}=.${p}.${s}`),'header');
 await reject(f.verify(await forge(attacker.privateKey,null,null,{raw:{header:enc(`{"alg":"ES256","typ":"at+jwt","kid":"${header.kid}","alg":"none"}`),payload:p}})),'header');
 await reject(f.verify(await forge(attacker.privateKey,null,null,{raw:{header:h,payload:enc(JSON.stringify(claims,null,1))}})),'claims');
 // Poisoned key sets: private members, foreign algorithms, duplicate kids and oversize sets.
 for(const [set,reason] of [[{keys:[{...pub,d:'x'.repeat(43)}]},'jwks'],[{keys:[{...pub,alg:'HS256'}]},'jwks'],[{keys:[{...pub,use:'enc'}]},'jwks'],[{keys:[{...pub,crv:'P-384'}]},'jwks'],[{keys:[pub,{...pub,x:attackerJwk.x,y:attackerJwk.y}]},'kid'],[{keys:Array(65).fill(pub)},'jwks'],[{keys:[{...pub,x:attackerJwk.x,y:attackerJwk.y}]},'signature'],[[pub],'jwks']])
  await reject(f.verify(token,{jwks:set}),reason);
});

const controller={ready:async()=>true,manifest:async()=>({version:'0',issuer,jwks_uri:`${issuer}/oauth/jwks`})};
const get=(path,headers={})=>new Request(issuer+path,{headers});
test('the JWKS route and manifest member exist only with brokering enabled, with public caching headers',async()=>{
 const f=fixture(),brokering={enabled:true,jwks:()=>f.keys.jwks()};
 const response=await handleFederation(get(BROKERING_JWKS_PATH),{controller,issuer,brokering});assert.equal(response.status,200);
 assert.equal(response.headers.get('Content-Type'),'application/jwk-set+json');assert.equal(response.headers.get('Cache-Control'),'public, max-age=300, must-revalidate');assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(response.headers.get('Set-Cookie'),null);
 const etag=response.headers.get('ETag'),body=await response.json();assert.match(etag,/^"[A-Za-z0-9_-]{43}"$/);assert.deepEqual(Object.keys(body),['keys']);assert.equal(body.keys.length,8);
 for(const key of body.keys){assert.deepEqual(Object.keys(key),['kty','crv','x','y','kid','alg','use']);assert.equal(key.alg,'ES256');assert.equal(key.use,'sig');}
 assert.equal(new Set(body.keys.map(k=>k.kid)).size,8);
 const cached=await handleFederation(get(BROKERING_JWKS_PATH,{'If-None-Match':etag}),{controller,issuer,brokering});assert.equal(cached.status,304);assert.equal(await cached.text(),'');
 assert.equal((await handleFederation(new Request(issuer+BROKERING_JWKS_PATH,{method:'POST'}),{controller,issuer,brokering})).status,405);
 assert.equal((await handleFederation(new Request('https://evil.example'+BROKERING_JWKS_PATH),{controller,issuer,brokering})).status,403);
 const manifest=await(await handleFederation(get('/.well-known/bindle/manifest.json'),{controller,issuer,brokering})).json();assert.equal(manifest.brokering_jwks_uri,issuer+BROKERING_JWKS_PATH);assert.equal(manifest.features,undefined,'the brokered-resources feature is not claimed yet');
 // Unavailable key custody fails closed and uncached.
 const broken=await handleFederation(get(BROKERING_JWKS_PATH),{controller,issuer,brokering:{enabled:true,jwks:()=>fixture({secret:''}).keys.jwks()}});assert.equal(broken.status,503);assert.equal(broken.headers.get('Cache-Control'),'no-store');
 // The legacy /oauth/jwks stays empty: brokering keys are never mixed into another key use.
 assert.deepEqual(await(await handleFederation(get('/oauth/jwks'),{controller,issuer,brokering})).json(),{keys:[]});
 // Flag off: no route (null, falls through to 404) and no advertisement, without touching the key store.
 let touched=0;const off={enabled:false,jwks:()=>{touched++;return f.keys.jwks();}};
 for(const option of [undefined,off,{enabled:'true',jwks:off.jwks},{enabled:true}]){assert.equal(await handleFederation(get(BROKERING_JWKS_PATH),{controller,issuer,brokering:option}),null);const m=await(await handleFederation(get('/.well-known/bindle/manifest.json'),{controller,issuer,brokering:option})).json();assert.ok(!('brokering_jwks_uri' in m));}
 assert.equal(touched,0);
 assert.equal(brokeringEnabled({BROKERING_ENABLED:'true'}),true);for(const v of ['false','TRUE','1',true,undefined])assert.equal(brokeringEnabled({BROKERING_ENABLED:v}),false);assert.equal(brokeringEnabled(undefined),false);
});

test('signatures are low-s only, purposes fix the typ, and public JWKS reads neither write nor contend per request',async()=>{
 const f=fixture();for(let i=0;i<8;i++){const {token}=await f.mint(),[h,p,sig]=token.split('.'),raw=Buffer.from(sig,'base64url'),N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,sv=BigInt('0x'+raw.subarray(32).toString('hex'));
  assert.ok(sv<=N>>1n,'minted s is low');const flipped=Buffer.concat([raw.subarray(0,32),Buffer.from((N-sv).toString(16).padStart(64,'0'),'hex')]);await reject(f.verify(`${h}.${p}.${flipped.toString('base64url')}`),'signature');}
 const event=await f.keys.sign('event',{iss:issuer});const eh=JSON.parse(Buffer.from(event.token.split('.')[0],'base64url'));assert.equal(eh.typ,'secevent+jwt');assert.match(eh.kid,/^event\./);
 await reject(f.verify(event.token),'typ');await assert.rejects(f.keys.sign('other',{}),TypeError);
 let transactions=0,writes=0;const metadata=memory(),counted={transaction:fn=>{transactions++;return metadata.transaction(tx=>fn({...tx,set:(k,v)=>{writes++;return tx.set(k,v);}}));}},clock={now:Date.UTC(2026,9,20,12)};
 const keys=brokeringKeys({issuer,secret,metadata:counted,clock:()=>clock.now});await keys.jwks();const [t0,w0]=[transactions,writes];assert.equal(w0,1,'first read provisions the set');
 for(let i=0;i<100;i++)await keys.jwks();assert.equal(transactions,t0,'memoized within cacheMs');clock.now+=6000;await keys.jwks();assert.equal(transactions,t0+1);assert.equal(writes,w0,'public reads never write');
});
