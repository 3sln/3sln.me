import test from 'node:test';import assert from 'node:assert/strict';
import {AccountController} from '../packages/runtime/accounts.mjs';import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';import {developerContactTier,developerContactLink,developerContactRoutes,evaluateLinkPolicy,cleanupDailyDeveloperGrants,DEVELOPER_CONTACT_POLICY} from '../packages/runtime/developer-contact.mjs';import {key} from '../packages/messaging/store.mjs';import {BILLING_STATE_KEY} from '../packages/billing/catalog.mjs';import {authored} from './link-helpers.mjs';
const owner=crypto.randomUUID(),beneficiary=crypto.randomUUID(),origin='https://developer.example';
// A same-host world: developer and senders are real AccountControllers wired through the identity and account ports.
async function world(){
 const accounts=new Map(),directory=new Map(),tiers=new Map(),closers=[],state={population:'all-active'};
 const make=async handle=>{const id=crypto.randomUUID(),metadata=new SqliteMetadata(':memory:'),stored=new Map(),bucket={put:async(k,b)=>{stored.set(k,new Uint8Array(b));},get:async k=>stored.has(k)?{size:stored.get(k).byteLength,arrayBuffer:async()=>stored.get(k).buffer.slice(0)}:null,delete:async k=>{stored.delete(k);}};closers.push(()=>metadata.close());
  const controller=new AccountController({metadata,gate:new SerialGate(),blobs:bucket,archives:bucket,config:{APP_ORIGIN:origin,KEY_ENCRYPTION_KEY:Buffer.alloc(32,12).toString('base64'),WORK_LIMITS_ENABLED:'false',STORAGE_WRITE_ENABLED:'false',CONVERSATION_ACCOUNT:o=>accounts.get(o),IDENTITY_ACCOUNT:async o=>directory.get(o)??null,DEVELOPER_CONTACT_POPULATION:{policy:async()=>{if(state.population==='throw')throw Error('down');const now=Date.now();return {mode:state.population,observedAt:now,validUntil:now+60000};}}}});
  await controller.warm(id);await controller.signingKey(id);controller.developerContactTier=async o=>{if(tiers.get(o)==='error')throw Object.assign(Error('stale'),{code:'developer_contact_eligibility_unavailable'});return tiers.get(o)??'free';};
  accounts.set(id,controller);directory.set(id,{status:'active',handle});return {id,handle,controller,stored,sign:input=>controller.authorLinkEnvelope(id,input)};};
 const developer=await make('n.dev');
 return {accounts,directory,tiers,state,make,developer,close:()=>closers.forEach(close=>close())};
}
const principal=sender=>({issuer:origin,subject:sender.id});
test('tier eligibility requires recent confirmed entitlement, excludes provisional upgrades and expired/past-due states',async t=>{/* Frozen wall time: freshness bounds and the UTC-day quota cannot drift mid-test. */t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,14,12)});const metadata=new SqliteMetadata(':memory:'),now=Date.now(),config={APP_ORIGIN:origin,POLAR_SERVER:'production'},parameters={id:'paid',name:'Paid',storageBytes:5000000000,activityHour:1000,activityDay:5000},state={owner,source:'polar',catalogVersion:3,plan:'paid',status:'active',validUntil:now+86400000,reconciledAt:now,verifiedPlan:parameters,origin,server:'production',metadataPrefix:'3sln_me_',catalogMode:'static',organizationId:'org',productId:'paid',subscriptionId:'subscription',currency:'usd'},calls=[],controller={metadata,config,warm:async id=>calls.push(['warm',id]),billingRefresh:async(id,options)=>calls.push(['refresh',id,options])};try{await metadata.put(BILLING_STATE_KEY,{...state,upgrade:{version:1,owner,origin,server:'production',organizationId:'org',subscriptionId:'subscription',plan:'ultra',parameters:{...parameters,id:'ultra'},targetProductId:'ultra',currency:'usd',startedAt:now,expiresAt:now+600000}});assert.equal(await developerContactTier(controller,owner),'paid');assert.deepEqual(calls.at(-1),['refresh',owner,{force:true}]);await metadata.put(BILLING_STATE_KEY,{...state,status:'canceled'});assert.equal(await developerContactTier(controller,owner),'paid');for(const patch of [{status:'past_due'},{validUntil:now-1},{owner:beneficiary},{source:'history'},{origin:'https://wrong.example'}]){await metadata.put(BILLING_STATE_KEY,{...state,...patch});assert.equal(await developerContactTier(controller,owner),'free');}for(const reconciledAt of [undefined,now-300001,now+86400000]){await metadata.put(BILLING_STATE_KEY,{...state,reconciledAt});await assert.rejects(developerContactTier(controller,owner),{code:'developer_contact_eligibility_unavailable'});}}finally{metadata.close();}});

test('developer policy: same-host principals only; paid tiers tag priority; population decides free accounts; unknown authority is unavailable',async()=>{const w=await world();try{const d=w.developer.controller,s=await w.make('n.abc');
 assert.deepEqual(await evaluateLinkPolicy(d,DEVELOPER_CONTACT_POLICY,{issuer:'https://other.example',subject:s.id}),{eligible:false,reason:'local-only',final:false});
 assert.deepEqual(await evaluateLinkPolicy(d,DEVELOPER_CONTACT_POLICY,principal(s)),{eligible:true,tier:'free',tags:['priority:free'],final:false});
 w.tiers.set(s.id,'paid');assert.deepEqual(await evaluateLinkPolicy(d,DEVELOPER_CONTACT_POLICY,principal(s)),{eligible:true,tier:'paid',tags:['priority:paid'],final:false});
 w.tiers.set(s.id,'ultra');assert.equal((await evaluateLinkPolicy(d,DEVELOPER_CONTACT_POLICY,principal(s))).final,true);
 w.tiers.delete(s.id);w.state.population='paid-only';assert.deepEqual(await evaluateLinkPolicy(d,DEVELOPER_CONTACT_POLICY,principal(s)),{eligible:false,reason:'paid-required',tier:'free'});
 w.state.population='throw';assert.deepEqual(await evaluateLinkPolicy(d,DEVELOPER_CONTACT_POLICY,principal(s)),{state:'unavailable'});
 w.state.population='unavailable';assert.deepEqual(await evaluateLinkPolicy(d,DEVELOPER_CONTACT_POLICY,principal(s)),{state:'unavailable'});
 w.tiers.set(s.id,'error');assert.deepEqual(await evaluateLinkPolicy(d,DEVELOPER_CONTACT_POLICY,principal(s)),{state:'unavailable'});
 assert.deepEqual(await evaluateLinkPolicy(d,'https://3sln.example/policies/other/v1',principal(s)),{state:'unavailable'});assert.deepEqual(await evaluateLinkPolicy(d,undefined,principal(s)),{eligible:true,final:true});
}finally{w.close();}});

test('one conditional developer link: reused, renewed near expiry, never silently recreated after revocation, legacy daily grants reclaimed',async()=>{const w=await world();try{const d=w.developer;
 const first=await developerContactLink(d.controller,d.id,d.handle),again=await developerContactLink(d.controller,d.id,d.handle);assert.equal(first.available,true);assert.equal(again.url,first.url);assert.equal(again.grantId,first.grantId);assert.match(first.url,/\/users\/n\.dev\/contact\/[a-f0-9-]{36}\?bindle_meta=/);assert.equal(first.policy,DEVELOPER_CONTACT_POLICY);
 const grant=await d.controller.metadata.get(key('contact-grant',first.grantId));assert.equal(grant.endpoint.claims.audience.policy,DEVELOPER_CONTACT_POLICY);assert.deepEqual(grant.endpoint.claims.kinds,['one-off']);assert.equal(grant.claims.maxMessages,5);assert.equal(grant.claims.maxMessageBytes,16384);assert.deepEqual(grant.intake.autoTags,['contact:developer']);assert.deepEqual(grant.intake.optionalTags,['topic:bug','topic:feature','topic:general']);assert.equal(grant.claims.requiredTags.length,0);
 grant.claims.exp=Math.floor(Date.now()/1000)+86400;await d.controller.metadata.put(key('contact-grant',first.grantId),grant);const renewed=await developerContactLink(d.controller,d.id,d.handle);assert.notEqual(renewed.grantId,first.grantId);
 await d.controller.revokeContact(d.id,renewed.grantId);assert.deepEqual(await developerContactLink(d.controller,d.id,d.handle),{available:false,reason:'contact-unavailable'});assert.equal((await d.controller.tokens.list(d.id)).filter(g=>g.active).length,1);
 const expired={id:crypto.randomUUID(),owner:d.id,internalKind:'developer-contact/v1',internalPointer:'developer-contact/v1/2026-01-01/x/free',claims:{exp:1}},ordinary={id:crypto.randomUUID(),owner:d.id,claims:{exp:1}};for(const g of [expired,ordinary])await d.controller.metadata.put(key('contact-grant',g.id),g);await d.controller.metadata.put(`contact-url/${expired.id}`,{});
 assert.equal(await cleanupDailyDeveloperGrants(d.controller,d.id),1);assert.equal(await d.controller.metadata.get(key('contact-grant',expired.id)),undefined);assert.equal(await d.controller.metadata.get(`contact-url/${expired.id}`),undefined);assert.ok(await d.controller.metadata.get(key('contact-grant',ordinary.id)));
}finally{w.close();}});

test('conditional delivery re-evaluates the author at admission, adds policy tags and applies per-author UTC-day quotas',async t=>{/* Frozen wall time: freshness bounds and the UTC-day quota cannot drift mid-test. */t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,14,12)});const w=await world();try{const d=w.developer,link=await developerContactLink(d.controller,d.id,d.handle),alice=await w.make('n.abc'),bob=await w.make('n.abd');
 const deliver=async(sender,options={})=>{const m=await authored(sender.sign,link.url,options);return d.controller.deliverLink(d.id,{url:link.url},{envelope:m.envelope,body:m.body});};
 const first=await deliver(alice,{text:'Hello developer',optionalTags:['topic:bug']}),message=await d.controller.messages.read(d.id,first.receipt.payload.messageId);
 assert.equal(first.replayed,false);assert.deepEqual(message.deliveryTags,['contact:developer','topic:bug','priority:free']);assert.equal(message.tagProvenance['priority:free'].source,'policy');assert.equal(message.tagProvenance['contact:developer'].source,'intake');assert.equal(message.delivery.authorship,'identity');assert.equal(message.delivery.author.principal.subject,alice.id);
 for(let i=1;i<5;i++)await deliver(alice);await assert.rejects(deliver(alice),{code:'quota_exceeded'});
 assert.equal((await deliver(bob)).replayed,false);
 // Decisions are reused within their bounded window; a newly ineligible principal is refused without storing content.
 w.state.population='paid-only';const carol=await w.make('n.abe'),before=d.stored.size;await assert.rejects(deliver(carol),{code:'audience_ineligible'});assert.equal(d.stored.size,before);
 w.state.population='throw';const dave=await w.make('n.abf');await assert.rejects(deliver(dave),{code:'audience_unavailable'});
 w.tiers.set(dave.id,'plus');const paid=await deliver(dave);assert.ok((await d.controller.messages.read(d.id,paid.receipt.payload.messageId)).deliveryTags.includes('priority:plus'));
 // Foreign or suspended authors are unverifiable.
 w.directory.set(bob.id,{status:'suspended',handle:'n.abd'});await assert.rejects(deliver(bob),{code:'author_unverifiable'});
}finally{w.close();}});

test('GET evaluation consumes a response once; rotation invalidates outstanding responses; intake edits apply without reissuing',async()=>{const w=await world();try{const d=w.developer,link=await developerContactLink(d.controller,d.id,d.handle),alice=await w.make('n.abc');
 const respond=async(sender,url=link.url)=>(await sender.controller.signLinkResponse(sender.id,sender.handle,url)).data,inspect=(url,data)=>d.controller.inspectContactLink(d.id,data?`${url}&bindle_data=${data}`:url);
 assert.deepEqual((await inspect(link.url)).audience,{state:'required'});
 const data=await respond(alice);assert.deepEqual((await inspect(link.url,data)).audience,{state:'eligible'});assert.deepEqual((await inspect(link.url,data)).audience,{state:'stale'});
 const inspected=await inspect(link.url);for(const field of ['collections','autoTags'])assert.equal(Object.hasOwn(inspected,field),false);assert.equal(inspected.policy,DEVELOPER_CONTACT_POLICY);
 w.state.population='paid-only';const bob=await w.make('n.abd');assert.deepEqual((await inspect(link.url,await respond(bob))).audience,{state:'ineligible',reason:'paid-required'});
 await assert.rejects(inspect(link.url,'a.b.c'),{code:'audience_malformed'});
 w.directory.set(bob.id,{status:'active',handle:'n.zzz'});assert.deepEqual((await inspect(link.url,await respond(bob))).audience,{state:'unverifiable'});
 const outstanding=await respond(alice),{url}=await d.controller.rotateContactChallenge(d.id,link.grantId);await assert.rejects(inspect(link.url),{code:'link_invalid'});assert.deepEqual((await inspect(url,outstanding)).audience,{state:'stale'});assert.equal(await d.controller.contactURL(d.id,link.grantId),url);
 const intake=await d.controller.contactIntake(d.id,link.grantId);await d.controller.updateContactIntake(d.id,link.grantId,{revision:intake.revision,autoTags:['contact:developer'],optionalTags:['topic:praise'],labels:{'topic:praise':{en:'Praise'}}});
 await assert.rejects(d.controller.updateContactIntake(d.id,link.grantId,{revision:intake.revision,autoTags:[],optionalTags:[]}),{code:'intake_conflict'});
 const metadata=await d.controller.contactMetadata(d.id,url,['en']);assert.deepEqual(metadata.optionalTags,[{id:'topic:praise',label:'Praise'}]);assert.equal(metadata.conditional,true);assert.equal(metadata.quotaScope,'principal-day');
 const praise=await authored(alice.sign,url,{optionalTags:['topic:praise']}),accepted=await d.controller.deliverLink(d.id,{url},{envelope:praise.envelope,body:praise.body});assert.equal((await d.controller.messages.read(d.id,accepted.receipt.payload.messageId)).intakeRevision,intake.revision+1);
 const removed=await authored(alice.sign,url,{optionalTags:['topic:bug']});await assert.rejects(d.controller.deliverLink(d.id,{url},{envelope:removed.envelope,body:removed.body}),{code:'forbidden_tags'});
}finally{w.close();}});

test('console route shows the single link and the caller eligibility; only the protected developer identity qualifies',async()=>{const w=await world();try{const d=w.developer,s=await w.make('n.abc'),assignmentId=crypto.randomUUID();
 const recipient={id:d.id,handle:d.handle,assignmentId,status:'active',systemIdentity:{version:1,handle:'ray',role:'developer',assignmentId,bootstrapId:crypto.randomUUID(),claimDigest:'a'.repeat(64)}};
 const env={APP_ORIGIN:origin,IDENTITY_REPOSITORY:{findByHandle:async handle=>handle==='ray'?recipient:null}},accountHandle=(e,id)=>new Proxy({},{get:(_,method)=>async(...args)=>{const result=await w.accounts.get(id).invoke({method,args});if(result?.$fault)throw Object.assign(Error(result.$fault.message),result.$fault);return result;}});
 const json=(value,status=200)=>({status,value}),run=(method='GET',caller=s)=>developerContactRoutes({path:'/api/developer-contact',request:{method},env,owner:{account:{id:caller.id}},accountHandle,json});
 const result=(await run()).value;assert.equal(result.available,true);assert.match(result.url,/bindle_meta=/);assert.deepEqual(result.eligibility,{state:'eligible',tier:'free'});assert.equal(result.recipientBadge.role,'developer');
 assert.equal((await run('POST')).status,405);
 recipient.systemIdentity.role='system';assert.deepEqual((await run()).value,{available:false,reason:'developer-unavailable'});
}finally{w.close();}});
