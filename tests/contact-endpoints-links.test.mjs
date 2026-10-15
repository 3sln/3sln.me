import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMessagingStore, ContactTokenService, ContactEndpointService, MessagingService, signContactToken } from '../packages/messaging/index.mjs';
import { key, fromBase64url, strictText } from '../packages/messaging/store.mjs';
import { CONTACT_LINK_TYPE } from '../packages/messaging/bindle-links.mjs';
import { intakeDeliveryTags } from '../packages/messaging/tag-policy.mjs';

const POLICY='https://3sln.example/policies/developer-contact/v1';
async function fixture({audience,form='link',requiredTags=['contact:developer'],optionalTags=['topic:bug','topic:idea'],tagLabels={'topic:bug':{en:'Bug report',es:'Error'}}}={}) {
  let now=1800000000000; const clock=()=>now; const store=new MemoryMessagingStore();
  const tokens=new ContactTokenService({store,issuer:'https://3sln.example',clock});
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const owner='11111111-1111-4111-8111-111111111111';await tokens.registerKey(owner,{kid:'one',alg:'ES256',publicJwk:await crypto.subtle.exportKey('jwk',pair.publicKey)});
  const endpoints=new ContactEndpointService({tokens,signer:async()=>pair.privateKey,linkPolicies:[POLICY]});
  const messages=new MessagingService({store,tokens:endpoints,clock});
  const collection=await messages.createCollection(owner,'Inbox');
  const options={handle:'alice',kid:'one',collections:[collection.id],mimeTypes:['text/plain'],expiresAt:now+86400000,maxMessages:3,requiredTags,optionalTags};
  const issued=form==='link'?await endpoints.createLink(owner,{...options,audience,tagLabels}):await endpoints.create(owner,options);
  const receive=(token,idempotencyKey='send',tags=[])=>messages.receive(token,{collection:collection.id,mimeType:'text/plain',bytes:new TextEncoder().encode('Hello'),idempotencyKey,senderMetadata:{tags}});
  return {store,tokens,endpoints,messages,owner,issued,pair,receive,collection,clock,advance:ms=>{now+=ms;}};
}
const metaOf=url=>new URL(url).searchParams.get('bindle_meta');
const decoded=segment=>JSON.parse(strictText(fromBase64url(segment)));
const grantOf=(f,id=f.issued.grant.id)=>f.store.transaction(tx=>tx.get(key('contact-grant',id)));

test('new-form contact meta: bindle_meta only, exact member set, no tags, stored exact header/claims/input',async()=>{
  const f=await fixture({audience:{policy:POLICY}});const url=new URL(f.issued.url);
  assert.deepEqual([...url.searchParams.keys()],['bindle_meta']);assert.equal(url.pathname,`/users/alice/contact/${f.issued.grant.id}`);
  const [h,p]=metaOf(f.issued.url).split('.');const header=decoded(h),claims=decoded(p);
  assert.deepEqual(header,{alg:'ES256',kid:'one',typ:'bindle-link-meta+jwt'});
  assert.deepEqual(Object.keys(claims).sort(),['aud','audience','bindle','collections','exp','iat','iss','jti','kinds','maxBytes','maxMessageBytes','maxMessages','mimeTypes','resource','sub','type','v'].sort());
  assert.equal(claims.type,CONTACT_LINK_TYPE);assert.equal(claims.aud,`${url.origin}${url.pathname}`);assert.deepEqual(claims.kinds,['one-off']);assert.equal(claims.audience.policy,POLICY);assert.equal(claims.audience.challenge.length,22);
  assert.equal(claims.resource,`https://3sln.example/entities/${f.owner}/contacts/${f.issued.grant.id}`);
  const grant=await grantOf(f);assert.equal(grant.endpoint.form,'link');assert.equal(grant.endpoint.input,`${h}.${p}`);assert.deepEqual(grant.intake.autoTags,['contact:developer']);assert.equal(grant.intake.revision,1);
  const inspected=await f.endpoints.inspect(f.issued.url);assert.equal(inspected.form,'link');assert.equal(inspected.conditional,true);assert.equal(inspected.data,undefined);
});
test('unrelated parameters are ignored; host, path, userinfo, legacy conflict and cross-form substitution fail',async()=>{
  const f=await fixture();const meta=metaOf(f.issued.url),endpoint=f.issued.endpoint;
  assert.equal((await f.endpoints.inspect(`${endpoint}?utm_source=x&bindle_meta=${meta}&ref=%zz`)).form,'link');
  for(const invalid of [f.issued.url.replace('/alice/','/bob/'),f.issued.url.replace('3sln.example','evil.example'),f.issued.url.replace('https://','https://u:p@'),`${endpoint}/?bindle_meta=${meta}`])await assert.rejects(f.endpoints.inspect(invalid),{code:'link_invalid'},invalid);
  for(const malformed of [`${f.issued.url}&sig=a.b.c`,`${f.issued.url}&%73ig=1`,`${f.issued.url}&bindle_meta=${meta}`,`${f.issued.url}&bindle_x=1`,`${endpoint}?BINDLE_META=${meta}`])await assert.rejects(f.endpoints.inspect(malformed),{code:'link_malformed'},malformed);
  // Dot segments are removed by the WHATWG parser before aud comparison.
  assert.equal((await f.endpoints.inspect(`${endpoint.replace('/contact/','/x/../contact/')}?bindle_meta=${meta}`)).form,'link');
  const legacy=await fixture({form:'legacy'});const sig=new URL(legacy.issued.url).searchParams.get('sig');
  await assert.rejects(legacy.endpoints.inspect(`${legacy.issued.endpoint}?bindle_meta=${sig}`),{code:'link_invalid'});
  await assert.rejects(f.endpoints.inspect(`${endpoint}?sig=${meta}`),{code:'unauthorized'});
});
test('a valid owner signature over claims the host did not store is link_invalid; expiry, revocation and key retirement too',async()=>{
  const f=await fixture({audience:{}});const [h,p]=metaOf(f.issued.url).split('.');const header=decoded(h),claims=decoded(p);
  for(const changes of [{maxMessages:100},{kinds:['conversation-init','one-off']},{audience:{challenge:'AAAAAAAAAAAAAAAAAAAAAA'}},{exp:claims.exp-1}]){
    const forged=await signContactToken({header,claims:{...claims,...changes},privateKey:f.pair.privateKey});
    await assert.rejects(f.endpoints.inspect(`${f.issued.endpoint}?bindle_meta=${forged}`),{code:'link_invalid'},JSON.stringify(changes));
  }
  const reordered=await signContactToken({header,claims,privateKey:f.pair.privateKey});assert.equal((await f.endpoints.inspect(`${f.issued.endpoint}?bindle_meta=${reordered}`)).form,'link');
  const second=await fixture();await second.tokens.revokeKey(second.owner,'one');await assert.rejects(second.endpoints.inspect(second.issued.url),{code:'link_invalid'});
  const third=await fixture();await third.endpoints.revoke(third.owner,third.issued.grant.id);await assert.rejects(third.endpoints.inspect(third.issued.url),{code:'link_invalid'});
  f.advance(86400000);await assert.rejects(f.endpoints.inspect(f.issued.url),{code:'link_invalid'});
});
test('bindle_data is accepted only by the inspection caller of a conditional link, after meta verification',async()=>{
  const conditional=await fixture({audience:{}}),plain=await fixture();const data='a.b.c';
  await assert.rejects(plain.endpoints.inspect(`${plain.issued.url}&bindle_data=${data}`,{allowData:true}),{code:'link_malformed'});
  await assert.rejects(conditional.endpoints.inspect(`${conditional.issued.url}&bindle_data=${data}`),{code:'link_malformed'});
  await assert.rejects(conditional.endpoints.mint(`${conditional.issued.url}&bindle_data=${data}`),{code:'link_malformed'});
  await assert.rejects(conditional.endpoints.linkMetadata(`${conditional.issued.url}&bindle_data=${data}`),{code:'link_malformed'});
  assert.equal((await conditional.endpoints.inspect(`${conditional.issued.url}&bindle_data=${data}`,{allowData:true})).data,data);
  await assert.rejects(conditional.endpoints.inspect(`${conditional.issued.url.replace('/alice/','/bob/')}&bindle_data=${data}`,{allowData:true}),{code:'link_invalid'});
});
test('issuance checks the operator policy registry, audience shape and kinds',async()=>{
  for(const [input,code] of [[{audience:{policy:'https://tenant.example/policy'}},'invalid_link_policy'],[{audience:{challenge:'AAAAAAAAAAAAAAAAAAAAAA'}},'invalid_link_policy'],[{audience:'yes'},'invalid_link_policy'],[{kinds:[]},'invalid_link_kinds'],[{kinds:['one-off','conversation-init']},'invalid_link_kinds'],[{kinds:['one-off','one-off']},'invalid_link_kinds'],[{kinds:['reply']},'invalid_link_kinds']]){
    const f=await fixture();await assert.rejects(f.endpoints.createLink(f.owner,{handle:'alice',kid:'one',collections:[f.collection.id],mimeTypes:['text/plain'],expiresAt:f.clock()+1000,...input}),{code},JSON.stringify(input));
  }
  const f=await fixture();for(const extra of [{audience:{}},{form:'link'},{form:'legacy'},{kinds:['one-off']}])await assert.rejects(f.endpoints.create(f.owner,{handle:'alice',kid:'one',collections:[f.collection.id],mimeTypes:['text/plain'],expiresAt:f.clock()+1000,...extra}),{code:'invalid_link_form'},JSON.stringify(extra));
  assert.throws(()=>new ContactEndpointService({tokens:f.tokens,signer:async()=>null,linkPolicies:['http://x.example/p']}),{code:'invalid_endpoint_service'});
});
test('challenge rotation preserves parent quota/receipts/intake and invalidates the previous meta',async()=>{
  const f=await fixture({audience:{policy:POLICY}});
  await f.store.transaction(async tx=>{const g=await tx.get(key('contact-grant',f.issued.grant.id));g.messagesUsed=1;g.bytesUsed=5;await tx.set(key('contact-grant',g.id),g);await tx.set(key('message-receipt',g.id,'one'),{id:'m',fingerprint:'x'});});
  const before=await grantOf(f);const rotated=await f.endpoints.rotateChallenge(f.owner,f.issued.grant.id);
  await assert.rejects(f.endpoints.inspect(f.issued.url),{code:'link_invalid'});assert.equal((await f.endpoints.inspect(rotated.url)).form,'link');
  const after=await grantOf(f);assert.equal(after.messagesUsed,1);assert.equal(after.bytesUsed,5);assert.ok(await f.store.transaction(tx=>tx.get(key('message-receipt',after.id,'one'))));assert.deepEqual(after.intake,before.intake);assert.notEqual(after.endpoint.claims.audience.challenge,before.endpoint.claims.audience.challenge);assert.equal(after.endpoint.claims.audience.policy,POLICY);
  const plain=await fixture();await assert.rejects(plain.endpoints.rotateChallenge(plain.owner,plain.issued.grant.id),{code:'not_found'});
  await assert.rejects(f.endpoints.rotateChallenge('22222222-2222-4222-8222-222222222222',f.issued.grant.id),{code:'not_found'});
});
test('new-form links never mint anonymous legacy inbox bearers, and forged inbox bearers for link parents fail',async()=>{
  const f=await fixture({audience:{}});await assert.rejects(f.endpoints.mint(f.issued.url),{code:'not_acceptable'});
  const grant=await grantOf(f),iat=Math.floor(f.clock()/1000);
  const token=await signContactToken({header:{...grant.header,typ:'bindle-inbox+jwt'},claims:{...grant.claims,jti:crypto.randomUUID(),parent:grant.id,endpoint:grant.endpoint.url,iat,exp:iat+300},privateKey:f.pair.privateKey});
  await assert.rejects(f.endpoints.verify(token),{code:'unauthorized'});await assert.rejects(f.receive(token),{code:'unauthorized'});
  assert.deepEqual(grant.claims.requiredTags,[]);assert.deepEqual(grant.claims.optionalTags,[]);
  assert.deepEqual(grant.delivery,{resource:grant.endpoint.claims.resource,kinds:['one-off'],collection:f.collection.id});
});
test('intake: auto tags applied, allowlist enforced, updates take effect without changing md, claims or quotas',async()=>{
  const f=await fixture();const tags=async sender=>intakeDeliveryTags(await f.store.transaction(tx=>f.endpoints.intakeOf(f.issued.grant.id,tx)),sender);
  assert.deepEqual(await tags(['topic:bug']),['contact:developer','topic:bug']);
  const stored=await grantOf(f);
  await assert.rejects(f.endpoints.updateIntake(f.owner,f.issued.grant.id,{revision:0,autoTags:['x']}),{code:'intake_conflict'});
  await assert.rejects(f.endpoints.updateIntake('other',f.issued.grant.id,{revision:1}),{code:'not_found'});
  await assert.rejects(f.endpoints.updateIntake(f.owner,f.issued.grant.id,{revision:1,autoTags:['a'],optionalTags:['a']}),{code:'invalid_contact_tags'});
  await assert.rejects(f.endpoints.updateIntake(f.owner,f.issued.grant.id,{revision:1,optionalTags:['b'],labels:{c:{en:'C'}}}),{code:'invalid_contact_tags'});
  await assert.rejects(f.endpoints.updateIntake(f.owner,f.issued.grant.id,{revision:1,optionalTags:['sys:suspected.spam']}),{code:'invalid_contact_tags'});
  const next=await f.endpoints.updateIntake(f.owner,f.issued.grant.id,{revision:1,autoTags:['priority:paid'],optionalTags:['topic:idea','sys:personal']});assert.equal(next.revision,2);
  const updated=await grantOf(f);assert.deepEqual(updated.endpoint,stored.endpoint);assert.deepEqual(updated.claims,stored.claims);assert.equal(updated.messagesUsed,stored.messagesUsed);
  await assert.rejects(tags(['topic:bug']),{code:'forbidden_tags'});
  assert.deepEqual(await tags(['topic:idea','sys:personal']),['priority:paid','topic:idea','sys:personal']);
  assert.equal((await f.endpoints.inspect(f.issued.url)).form,'link');assert.deepEqual(await f.endpoints.intake(f.owner,f.issued.grant.id),next);
  await f.endpoints.revoke(f.owner,f.issued.grant.id);await assert.rejects(f.endpoints.updateIntake(f.owner,f.issued.grant.id,{revision:2}),{code:'not_found'});
});
test('legacy ?sig= parents keep verifying; signed tags seed revision-0 intake lazily, then intake is authoritative',async()=>{
  const f=await fixture({form:'legacy'});assert.equal((await f.endpoints.inspect(f.issued.url)).form,'legacy');
  assert.equal((await grantOf(f)).intake,undefined);
  const metadata=await f.endpoints.linkMetadata(f.issued.url);assert.equal(metadata.intakeRevision,0);assert.deepEqual(metadata.optionalTags,[{id:'topic:bug'},{id:'topic:idea'}]);assert.deepEqual(metadata.kinds,['one-off']);
  assert.equal((await grantOf(f)).intake,undefined,'metadata reads never write');
  const minted=await f.endpoints.mint(f.issued.url);const first=await f.receive(minted.token,'a',['topic:idea']);
  assert.deepEqual((await f.messages.read(f.owner,first.id)).tags,['contact:developer','topic:idea']);assert.equal((await grantOf(f)).intake.revision,0);
  await f.endpoints.updateIntake(f.owner,f.issued.grant.id,{revision:0,autoTags:[],optionalTags:['topic:new']});
  const second=await f.receive(minted.token,'b',['topic:new']);assert.deepEqual((await f.messages.read(f.owner,second.id)).tags,['topic:new']);
  await assert.rejects(f.receive(minted.token,'c',['topic:idea']),{code:'forbidden_tags'});
  assert.equal((await f.endpoints.inspect(f.issued.url)).form,'legacy');
});
test('sender metadata representation is side-effect free, localized and never discloses auto tags or collections',async()=>{
  const f=await fixture({audience:{policy:POLICY}});const before=await f.store.transaction(tx=>tx.list(''));
  const metadata=await f.endpoints.linkMetadata(`${f.issued.url}&utm_source=x`,{locales:['es-MX','en']});
  assert.deepEqual(metadata,{version:1,form:'link',type:CONTACT_LINK_TYPE,intakeRevision:1,optionalTags:[{id:'topic:bug',label:'Error'},{id:'topic:idea'}],kinds:['one-off'],mimeTypes:['text/plain'],maxMessageBytes:1048576,maxMessages:3,maxBytes:10485760,quotaScope:'principal-day',expiresAt:f.clock()+86400000,conditional:true,policy:POLICY});
  assert.equal((await f.endpoints.linkMetadata(f.issued.url)).optionalTags[0].label,'Bug report');assert.equal((await f.endpoints.linkMetadata(f.issued.url,{locales:['ES']})).optionalTags[0].label,'Error');
  assert.equal(JSON.stringify(metadata).includes('contact:developer'),false);assert.equal(JSON.stringify(metadata).includes(f.collection.id),false);
  assert.deepEqual(await f.store.transaction(tx=>tx.list('')),before);
  await assert.rejects(f.endpoints.linkMetadata(f.issued.url,{locales:['en;q=1']}),{code:'invalid_locale'});
});
