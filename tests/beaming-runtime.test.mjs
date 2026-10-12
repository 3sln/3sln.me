import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNodeServer} from '../apps/node/server.mjs';
import {beamFiles,BeamService} from '../packages/beaming/index.mjs';
import {CloudflareTurnAdapter} from '../packages/beaming/turn.mjs';
const origin='http://localhost:8797',password='Beam integration password enough entropy!';
const files=[{id:'one',name:'one.txt',size:12,type:'text/plain'},{id:'two',name:'two.txt',size:24,type:'text/plain'}];
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'beam-runtime-')),config={APP_ORIGIN:origin,BEAM_ENABLED:'true',BEAM_STUN_ENABLED:'false',BEAM_MONTHLY_DELIVERY_BYTES:'1000000000',BEAM_MONTHLY_OFFERS:'20'};let signupCount=0,app=await createNodeServer({directory,config});
 const request=async(path,{method='GET',input,headers={}}={})=>{const response=await app.fetch(new Request(new URL(path,origin),{method,headers:{Origin:origin,...path==='/api/auth/signup'?{'CF-Connecting-IP':`127.0.0.${++signupCount}`}:{},...headers,...input!==undefined?{'Content-Type':'application/json'}:{}},...input===undefined?{}:{body:JSON.stringify(input)}}));return {status:response.status,value:await response.json(),response};};
 const post=(path,input,session)=>request(path,{method:'POST',input,headers:session?.headers});
 const login=async handle=>{const r=await post('/api/auth/login/password',{handle,password,turnstileToken:'local-browser-test-token'});assert.equal(r.status,200,JSON.stringify(r.value));return {...r.value,headers:{Cookie:r.response.headers.get('Set-Cookie').split(';')[0],'X-CSRF-Token':r.value.csrfToken}};};
 const signup=async handle=>{const pending=await post('/api/auth/signup',{handle,password,method:'password',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'});assert.equal(pending.status,200,JSON.stringify(pending.value));const recovery=await post('/api/auth/recovery/download',{pendingToken:pending.value.pendingToken});const activated=await post('/api/auth/recovery/confirm',{pendingToken:pending.value.pendingToken,recoveryToken:recovery.value.recoveryToken,downloadConfirmed:true});assert.equal(activated.status,200);return {...activated.value,headers:{Cookie:activated.response.headers.get('Set-Cookie').split(';')[0],'X-CSRF-Token':activated.value.csrfToken}};};
 const sender=await signup('beam_sender'),recipient=await signup('beam_recipient'),second=await login('beam_recipient');
 const paid=async session=>app.resources.accounts.get(session.account.id).metadata.put('billing/state',{owner:session.account.id,source:'polar',plan:'plus',validUntil:Date.now()+3600000});await paid(sender);
 return {request,post,sender,recipient,second,paid,get app(){return app;},restart:async()=>{await app.close();app=await createNodeServer({directory,config});},close:async()=>{await app.close();await rm(directory,{force:true,recursive:true});}};
}
test('signed contact grant gates remote beam; multi-device mailbox atomically claims exact session, revocation stops signaling',async()=>{
 const f=await fixture();try{
 const account=await f.request('/api/account',{headers:f.recipient.headers}),collection=account.value.collections[0].id;
 const contact=await f.post('/api/contacts',{name:'Beam sender',collections:[collection],mimeTypes:['text/plain'],expiresAt:Date.now()+3600000,beamEnabled:true},f.recipient);assert.equal(contact.status,200,JSON.stringify(contact.value));
 const redeem=await f.post('/api/contacts/redeem',{url:contact.value.url},f.sender);assert.equal(redeem.status,200,JSON.stringify(redeem.value));
 const directory=await f.request('/api/contacts/directory',{headers:f.sender.headers});assert.equal(directory.value[0].peer,f.recipient.account.id);assert.equal(directory.value[0].profile,null);assert.equal(directory.value[0].devices,undefined);assert.equal(directory.value[0].url,contact.value.url);assert(!JSON.stringify(await f.app.resources.accounts.get(f.sender.account.id).metadata.get('beam/directory/'+f.recipient.account.id)).includes(contact.value.url));
 const offer=await f.post('/api/beams/offers',{recipient:f.recipient.account.id,files},f.sender);assert.equal(offer.status,201,JSON.stringify(offer.value));const path=`/api/beams/${f.sender.account.id}/${offer.value.id}`;
 const early=await f.post(path+'/signal',{seq:1,type:'offer',data:{type:'offer',sdp:'v=0'}},f.sender);assert.equal(early.value.error,'beam_not_accepted');
 for(const session of [f.recipient,f.second]){const box=await f.request('/api/beams/mailbox',{headers:session.headers});assert.equal(box.value.offers.length,1);assert.deepEqual(box.value.offers[0].files,files);}
 assert.equal((await f.post(path+'/accept',{fileIds:['one']},f.recipient)).status,200);assert.equal((await f.post(path+'/accept',{fileIds:['two']},f.second)).value.error,'beam_forbidden');
 const senderMailbox=await f.request('/api/beams/mailbox',{headers:f.sender.headers});assert.equal(senderMailbox.value.offers[0].state,'accepted');assert.deepEqual(senderMailbox.value.offers[0].selected,['one']);
 const signal=await f.post(path+'/signal',{seq:1,type:'offer',data:{type:'offer',sdp:'v=0'}},f.sender);assert.equal(signal.status,200);assert.equal((await f.post(path+'/signal',{seq:1,type:'offer',data:{type:'offer',sdp:'v=0'}},f.sender)).value.error,'beam_signal_sequence');
 const receiverView=await f.request(path,{headers:f.recipient.headers});assert.equal(receiverView.value.signals[0].data.sdp,'v=0');
 const ice=await f.post(path+'/ice',{},f.recipient);assert.equal(ice.status,200);assert.deepEqual(ice.value,{iceServers:[],relayEnabled:false});f.app.resources.accounts.get(f.sender.account.id).config.BEAM_STUN_ENABLED='true';assert.deepEqual((await f.post(path+'/ice',{},f.recipient)).value,{iceServers:[{urls:['stun:stun.cloudflare.com:3478']}],relayEnabled:false});
 await f.restart();assert.equal((await f.request(path,{headers:f.recipient.headers})).value.state,'accepted');
 await f.request(`/api/contacts/${contact.value.id}/beam`,{method:'PUT',input:{beamEnabled:false},headers:f.recipient.headers});assert.equal((await f.post(path+'/signal',{seq:1,type:'answer',data:{type:'answer',sdp:'v=0'}},f.recipient)).value.error,'beam_contact_required');assert.equal((await f.request('/api/contacts/directory/'+f.recipient.account.id,{method:'DELETE',headers:f.sender.headers})).value.removed,true);assert.deepEqual((await f.request('/api/contacts/directory',{headers:f.sender.headers})).value,[]);
 }finally{await f.close();}
});
test('nearby pairing is authenticated, one use, recipient-session bound; paid check and rename persist',async()=>{
 const f=await fixture();try{
 const created=await f.post('/api/beams/invites',{direction:'receive'},f.recipient);assert.equal(created.status,200,JSON.stringify(created.value));const qr=await f.app.fetch(new Request(new URL('/api/beams/invites/'+created.value.id+'/qr.svg',origin),{headers:f.recipient.headers}));assert.equal(qr.status,200);assert((await qr.text()).startsWith('<svg'));const joined=await f.post('/api/beams/invites/redeem',{token:created.value.token},f.sender);assert.equal(joined.status,200,JSON.stringify(joined.value));assert.equal((await f.post('/api/beams/invites/redeem',{token:created.value.token},f.sender)).value.error,'beam_invite_used');
 const offer=await f.post('/api/beams/offers',{recipient:f.recipient.account.id,inviteId:joined.value.inviteId,files},f.sender);assert.equal(offer.status,201,JSON.stringify(offer.value));assert.equal((await f.request('/api/beams/mailbox',{headers:f.second.headers})).value.offers.length,0);
 assert.equal((await f.post('/api/beams/offers',{recipient:f.recipient.account.id,inviteId:joined.value.inviteId,files},f.sender)).value.error,'beam_invite_expired');
 const current=(await f.request('/api/session',{headers:f.sender.headers})).value.devices.find(d=>d.current);const rename=await f.post('/api/auth/devices/rename',{sessionId:current.id,label:'Desk'},f.sender);assert.equal(rename.status,200,JSON.stringify(rename.value));await f.restart();assert.equal((await f.request('/api/session',{headers:f.sender.headers})).value.devices.find(d=>d.current).label,'Desk');
 const secondSender=await f.post('/api/auth/login/password',{handle:'beam_sender',password,turnstileToken:'local-browser-test-token'});const revoker={...secondSender.value,headers:{Cookie:secondSender.response.headers.get('Set-Cookie').split(';')[0],'X-CSRF-Token':secondSender.value.csrfToken}};
 assert.equal((await f.post('/api/auth/devices/revoke',{sessionId:current.id},revoker)).status,200);assert.equal((await f.request(`/api/beams/${f.sender.account.id}/${offer.value.id}`,{headers:f.recipient.headers})).value.error,'beam_device_revoked');
 const free=(await f.request('/api/beams/status',{headers:f.recipient.headers})).value;assert.equal(free.paid,false);assert.equal(free.available,false);assert.equal(free.relayEnabled,false);
 }finally{await f.close();}
});
test('beam file metadata rejects byte payload fields, unsafe names, file count and oversized manifests',()=>{
 assert.throws(()=>beamFiles([{...files[0],name:'..'}]),e=>e.code==='beam_invalid_file');assert.throws(()=>beamFiles([{...files[0],name:'\u202ebad.txt'}]),e=>e.code==='beam_invalid_file');assert.throws(()=>beamFiles([{...files[0],bytes:[1]}]),e=>e.code==='beam_invalid_file');assert.throws(()=>beamFiles(Array.from({length:17},(_,i)=>({...files[0],id:String(i)}))),e=>e.code==='beam_file_count');assert.throws(()=>beamFiles([{...files[0],size:100000001}]),e=>e.code==='beam_invalid_file');
});
test('TURN adapter uses real credential endpoint, short TTL and validates response without provider secrets',async()=>{
 let call;const adapter=new CloudflareTurnAdapter({keyId:'key_example',apiToken:'server-secret',fetch:async(url,options)=>{call={url,options};return new Response(JSON.stringify({iceServers:[{urls:['turn:turn.cloudflare.com:3478?transport=udp'],username:'short',credential:'temporary'}]}),{status:201});}});const result=await adapter.issue({ttl:120});assert.equal(result.expiresIn,120);assert.equal(call.options.headers.Authorization,'Bearer server-secret');assert.deepEqual(JSON.parse(call.options.body),{ttl:120});assert(call.url.endsWith('/key_example/credentials/generate-ice-servers'));assert(!JSON.stringify(result).includes('server-secret'));
 await assert.rejects(()=>adapter.issue({ttl:301}),e=>e.code==='beam_turn_unconfigured');
});
function memoryMetadata(){const rows=new Map();let queue=Promise.resolve();const port={get:async k=>structuredClone(rows.get(k)),put:async(k,v)=>rows.set(k,structuredClone(v)),delete:async k=>rows.delete(k),list:async({prefix='',limit=1000}={})=>new Map([...rows].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([k,v])=>[k,structuredClone(v)]))};return {...port,transaction:fn=>{const result=queue.then(()=>fn(port));queue=result.catch(()=>{});return result;}};}
test('durable budget reservation is atomic and denies free or unfunded senders; expired sessions cannot signal',async()=>{
 const metadata=memoryMetadata(),owner=crypto.randomUUID(),recipient=crypto.randomUUID(),actor={account:owner,device:'sender'},input={recipient,devices:['receiver'],files};let now=Date.now(),plan='plus';const config={BEAM_ENABLED:'true',BEAM_MONTHLY_DELIVERY_BYTES:'1000',BEAM_MONTHLY_OFFERS:'1'},service=new BeamService({metadata,config,entitlement:async()=>({plan}),clock:()=>now});
 const attempts=await Promise.allSettled([service.create(owner,actor,input),service.create(owner,actor,input)]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.find(r=>r.status==='rejected').reason.code,'beam_allowance_exceeded');const record=attempts.find(r=>r.status==='fulfilled').value;
 assert.equal((await service.status(owner)).usage.bytes,36);plan='free';await assert.rejects(()=>service.create(owner,actor,input),e=>e.code==='beam_paid_required');plan='plus';config.BEAM_MONTHLY_OFFERS='0';await assert.rejects(()=>service.create(owner,actor,input),e=>e.code==='beam_unfunded');
 const receiver={account:recipient,device:'receiver'};await service.action(record.id,receiver,'accept',{fileIds:['one']});await assert.rejects(()=>service.action(record.id,receiver,'signal',{seq:1,type:'offer',data:{type:'offer',sdp:'v=0'}}),e=>e.code==='beam_signal_role');await assert.rejects(()=>service.action(record.id,actor,'signal',{seq:1,type:'offer',data:{type:'offer',sdp:'v=0'+ '😀'.repeat(20000)}}),e=>e.code==='beam_signal_limit');await assert.rejects(()=>service.action(record.id,receiver,'signal',{seq:1,type:'complete',data:{payload:'bytes'}}),e=>e.code==='beam_signal_invalid');
 now+=900001;await assert.rejects(()=>service.action(record.id,actor,'get'),e=>e.code==='beam_expired');await service.cleanup();await assert.rejects(()=>service.raw(record.id),e=>e.code==='beam_not_found');
});
test('profile HTTP disclosure pins the imported signed link and exposes only its selected fields',async()=>{
 const f=await fixture();try{
 const own=await f.request('/api/account',{headers:f.recipient.headers}),collection=own.value.collections[0].id;
 const set=await f.request('/api/profile',{method:'PUT',headers:f.recipient.headers,input:{displayName:'Shared name',bio:'Private biography',avatar:'https://image.example/private.png',discloseToContacts:true}});assert.equal(set.status,200);
 const create=async options=>f.post('/api/contacts',{name:'Profile grant',collections:[collection],mimeTypes:['text/plain'],expiresAt:Date.now()+3600000,beamEnabled:true,...options},f.recipient);
 const hidden=await create({}),named=await create({profileFields:['displayName']});assert.equal(named.status,200);assert.deepEqual(hidden.value.profileFields,[]);assert.deepEqual(named.value.profileFields,['displayName']);assert.equal(named.value.discloseProfile,true);
 assert.equal((await f.post('/api/contacts/redeem',{url:named.value.url},f.sender)).status,200);const endpoint='/api/contacts/profile/'+f.recipient.account.id;
 assert.deepEqual((await f.request(endpoint,{headers:f.sender.headers})).value,{displayName:'Shared name'});assert.deepEqual((await f.request('/api/contacts/directory',{headers:f.sender.headers})).value[0].profile,{displayName:'Shared name'});
 await f.request('/api/contacts/'+named.value.id+'/beam',{method:'PUT',headers:f.recipient.headers,input:{beamEnabled:false}});const listing=await f.request('/api/account',{headers:f.recipient.headers});assert.deepEqual(listing.value.contacts.find(c=>c.id===named.value.id).profileFields,['displayName']);
 await f.request('/api/contacts/'+named.value.id+'/beam',{method:'PUT',headers:f.recipient.headers,input:{beamEnabled:true}});
 assert.equal((await f.post('/api/contacts/redeem',{url:hidden.value.url},f.sender)).status,200);assert.equal((await f.request(endpoint,{headers:f.sender.headers})).value,null);assert.equal((await f.request(endpoint+'?grantId='+named.value.id,{headers:f.sender.headers})).value.error,'profile_grant_mismatch');
 await f.request('/api/contacts/'+named.value.id,{method:'DELETE',headers:f.recipient.headers});assert.equal((await f.request('/api/contacts/directory',{headers:f.sender.headers})).value[0].profile,null);
 assert.equal((await f.request('/api/contacts/'+hidden.value.id+'/beam',{method:'PUT',headers:f.recipient.headers,input:{profileFields:['passwordHash']}})).value.error,'profile_fields_invalid');
 }finally{await f.close();}
});
test('ordinary non-beam contact import and signed profile representation disclose only exact parent scopes without minting',async()=>{
 const f=await fixture();try{
 const own=await f.request('/api/account',{headers:f.recipient.headers}),collection=own.value.collections[0].id;
 await f.request('/api/profile',{method:'PUT',headers:f.recipient.headers,input:{displayName:'Scoped name',bio:'Hidden biography',avatar:'https://images.example/private.png',discloseToContacts:true}});
 const create=options=>f.post('/api/contacts',{name:'Ordinary contact',collections:[collection],mimeTypes:['text/plain'],expiresAt:Date.now()+3600000,...options},f.recipient),privateLink=await create({}),namedLink=await create({profileFields:['displayName']});
 assert.equal((await f.post('/api/contacts/redeem',{url:privateLink.value.url},f.sender)).status,200);const directory=await f.request('/api/contacts/directory',{headers:f.sender.headers});assert.equal(directory.value[0].beamEnabled,false);assert.equal(directory.value[0].profile,null);
 assert.equal((await f.post('/api/beams/offers',{recipient:f.recipient.account.id,files},f.sender)).value.error,'beam_contact_required');
 const mime='application/vnd.bindle.contact-profile+json',publicGet=link=>f.request(link,{headers:{Accept:mime}}),controller=f.app.resources.accounts.get(f.recipient.account.id),before=JSON.stringify([...await controller.metadata.list()]);
 const hidden=await publicGet(privateLink.value.url);assert.equal(hidden.status,200);assert.equal(hidden.value.profile,null);assert.equal(hidden.response.headers.get('Content-Type'),mime);assert.equal(hidden.response.headers.get('Set-Cookie'),null);
 const named=await publicGet(namedLink.value.url);assert.deepEqual(named.value,{identityURI:origin+'/users/beam_recipient',beamEnabled:false,profile:{displayName:'Scoped name'}});assert.equal(JSON.stringify([...await controller.metadata.list()]),before);
 assert.equal((await f.post('/api/contacts/redeem',{url:namedLink.value.url},f.sender)).status,200);assert.deepEqual((await f.request('/api/contacts/directory',{headers:f.sender.headers})).value[0].profile,{displayName:'Scoped name'});
 const bad=new URL(namedLink.value.url),sig=bad.searchParams.get('sig');bad.searchParams.set('sig',sig.slice(0,-2)+(sig.at(-2)==='a'?'b':'a')+sig.at(-1));assert.equal((await publicGet(bad.href)).status,401);
 await f.post('/api/contacts/'+namedLink.value.id+'/quarantine',{quarantined:true},f.recipient);assert.equal((await publicGet(namedLink.value.url)).status,403);assert.equal((await f.post('/api/contacts/redeem',{url:namedLink.value.url},f.sender)).value.error,'contact_quarantined');
 await f.request('/api/contacts/'+privateLink.value.id,{method:'DELETE',headers:f.recipient.headers});assert.equal((await publicGet(privateLink.value.url)).status,401);
 }finally{await f.close();}
});
test('relay issuance reserves participant once and cannot overwrite a cancellation after a provider wait',async()=>{
 const f=await fixture(),originalFetch=globalThis.fetch;try{
 const controller=f.app.resources.accounts.get(f.sender.account.id),device=(await f.request('/api/session',{headers:f.sender.headers})).value.devices.find(d=>d.current).id,actor={account:f.sender.account.id,device},recipientDevice=(await f.request('/api/session',{headers:f.recipient.headers})).value.devices.find(d=>d.current).id;
 const record=await controller.beams.create(f.sender.account.id,actor,{recipient:f.recipient.account.id,devices:[recipientDevice],deviceId:recipientDevice,files});await controller.beams.action(record.id,{account:f.recipient.account.id,device:recipientDevice},'accept',{fileIds:['one']});
 controller.config.BEAM_TURN_ENABLED='true';controller.config.CLOUDFLARE_TURN_KEY_ID='mock-key';controller.config.CLOUDFLARE_TURN_API_TOKEN='mock-token';controller.config.BEAM_RELAY_BUDGET={reserve:async()=>({enforced:true}),commit:async()=>{}};
 let started,finish;const pending=new Promise(resolve=>started=resolve),responseReady=new Promise(resolve=>finish=resolve);let issues=0,revocations=0;
 globalThis.fetch=async url=>{if(url.endsWith('/revoke')){revocations++;return new Response(null,{status:204});}issues++;started();await responseReady;return new Response(JSON.stringify({iceServers:[{urls:['turn:turn.cloudflare.com:3478?transport=udp'],username:'mock-user',credential:'mock-credential'}]}),{status:201});};
 const issuance=controller.beamIce(f.sender.account.id,record.id,actor);await pending;await assert.rejects(()=>controller.beamIce(f.sender.account.id,record.id,actor),e=>e.code==='beam_turn_already_issued');await controller.beams.action(record.id,actor,'reject',{});finish();await assert.rejects(issuance,e=>e.code==='beam_not_accepted');assert.equal((await controller.beams.raw(record.id)).state,'cancelled');assert.equal(issues,1);assert.equal(revocations,1);assert(!JSON.stringify([...await controller.metadata.list()]).includes('mock-credential'));
 }finally{globalThis.fetch=originalFetch;await f.close();}
});
