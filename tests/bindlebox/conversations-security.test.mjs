// BB-B4 adversarial cases: invitation nonces, replay across conversations and recipients, forged membership,
// equivocation evidence, blocks, departures, the single delegate-key snapshot (IDKEYS-1) and secret hygiene.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMesh,B,encoder} from './conversations-fixtures.test.mjs';

const mesh=async(t,options)=>{const m=await createMesh(options);t.after(()=>m.dispose());return m;};
const body=async(m,from,cid)=>{const op=[...(await m.party(from).store.list({prefix:'conv/op/'})).values()].filter(o=>o.cid===cid&&o.type==='message').at(-1);return op;};

test('invitation responses: identical replay returns the stored result, other bytes are invitation_used, unknown routes are uniform',async t=>{
 const m=await mesh(t,{names:['alice','bob','carol']}),cid=await m.conversation('alice',['bob','carol']);
 const row=await m.party('bob').store.get(`conv/response/${cid}`);assert.equal(row.state,'delivered');
 const post=bytes=>m.post('bob','alice',{method:'POST',url:row.resource,headers:{'content-type':'application/json'},body:bytes});
 const again=await post(encoder.encode(B.jcs(row.response)));assert.equal(again.status,200);assert.deepEqual(again.json,{result:{state:'accepted'}});
 const other=await B.signInvitationResponse({...row.response.payload,decision:'decline',acceptListed:undefined,binding:undefined,createdAt:m.clock.now()},m.party('bob').signer).catch(async()=>{const {acceptListed,binding,...p}=row.response.payload;return B.signInvitationResponse({...p,decision:'decline',createdAt:m.clock.now()},m.party('bob').signer);});
 const used=await post(encoder.encode(B.jcs(other)));assert.equal(used.status,409);assert.equal(used.json.error,'invitation_used');
 // Carol cannot answer on bob's return route, even with her own valid signature.
 const carolRow=await m.party('carol').store.get(`conv/response/${cid}`);
 const wrong=await m.post('carol','alice',{method:'POST',url:row.resource,headers:{'content-type':'application/json'},body:encoder.encode(B.jcs(carolRow.response))});assert.equal(wrong.status,403);
 const unknown=await m.post('bob','alice',{method:'POST',url:`${row.resource.slice(0,-32)}${'A'.repeat(32)}`,headers:{'content-type':'application/json'},body:encoder.encode(B.jcs(row.response))});
 assert.equal(unknown.status,403);assert.equal(unknown.json.error,'not_authorized');
});

test('replay across conversations and recipients is refused; identical replays return the stored receipt only',async t=>{
 const m=await mesh(t,{names:['alice','bob','carol']}),c1=await m.conversation('alice',['bob','carol']),c2=await m.conversation('alice',['bob','carol'],{text:'Second room.'});
 await m.run('bob','conversations.send',{conversationId:c1,text:'only in c1'});await m.settle();
 const op=await body(m,'bob',c1),before=(await m.texts('alice',c1)).length;
 const replay=await m.deliverPrepared('bob',op.operationId,'alice');assert.equal(replay.status,200);assert.equal((await m.texts('alice',c1)).length,before,'no second application');
 // The c1 envelope presented at carol's ingress names alice as recipient: never admitted for carol.
 const r=op.prepared.find(x=>x.envelope.payload.recipient.owner===m.party('alice').owner),wire=B.encodeDelivery(r.envelope,{body:encoder.encode('only in c1'),boundary:'x-1'});
 const misdirected=await m.post('bob','carol',{method:'POST',url:m.party('carol').ingress,headers:{authorization:r.credential,'content-type':wire.contentType},body:wire.bytes});assert.notEqual(misdirected.status,200);
 // A c2 record carrying a token derived from c1's secret fails the pair gate.
 const c1secret=await m.party('bob').store.get(`conv/secret/${c1}/${(await m.get('bob',c1)).epoch}`);
 const crossed=await m.craft('bob','alice',c2,{counter:500,secret:c1secret,epoch:(await m.get('bob',c2)).epoch});
 const refused=await m.post('bob','alice',crossed.request);assert.equal(refused.status,403);assert.equal(refused.json.error,'not_authorized');
 assert.ok(!(await m.texts('alice',c2)).includes('crafted'));
});

test('forged membership: non-members, leaked secrets and forged introductions never join an accepted-peer set',async t=>{
 const m=await mesh(t,{names:['alice','bob','carol','erin']}),cid=await m.conversation('alice',['bob','carol']);
 const secret=await m.party('alice').store.get(`conv/secret/${cid}/${(await m.get('alice',cid)).epoch}`);
 // Erin (valid certificate, not in the genesis) with a leaked secret: no hello digest exists for her.
 await m.party('erin').store.transaction(async tx=>{await tx.put(`conv/room/${cid}`,{...await m.party('alice').store.get(`conv/room/${cid}`)});await tx.put(`conv/peer/${cid}/${encodeURIComponent(m.party('bob').principal.issuer)}|${encodeURIComponent(m.party('bob').principal.subject)}`,{outbound:{incarnation:'hello'}});});
 const binding={ingress:m.party('erin').ingress,incarnation:'erin-1',profiles:[B.PROFILE],limits:{maxParticipants:32,maxMessageBytes:1048576,maxEnvelopeBytes:65536}};
 const hello=await m.craft('erin','bob',cid,{type:'peer-hello',secret,data:{binding,startCounter:1}});
 assert.equal((await m.post('erin','bob',hello.request)).status,403);
 // A member relaying a "self-signed" introduction for erin that erin never signed is refused before any effect.
 const intro=await B.signInvitationResponse({version:1,profile:B.PROFILE,conversationId:cid,genesisDigest:(await m.party('alice').store.get(`conv/room/${cid}`)).genesisDigest,nonce:B.base64url(new Uint8Array(16)),decision:'accept',acceptListed:true,responder:{principal:m.party('erin').principal,identityDocument:`${m.party('erin').principal.identityURI}/identity.json`,keyId:m.party('erin').keyId,delegate:m.party('bob').signer.kid},binding,createdAt:m.clock.now()},m.party('bob').signer);
 const proposal=await m.craft('bob','carol',cid,{type:'peer-proposal',counter:200,data:{principal:m.party('erin').principal,keyId:m.party('erin').keyId,introduction:intro}});
 const forged=await m.post('bob','carol',proposal.request);assert.equal(forged.status,401);assert.equal(forged.json.error,'author_unverifiable');
 // A proposal without an introduction for someone outside the genesis creates nothing at all (BB4-S4).
 for(let i=0;i<20;i++){const bare=await m.craft('bob','carol',cid,{type:'peer-proposal',counter:201+i,data:{principal:{...m.party('erin').principal,subject:crypto.randomUUID()},keyId:m.party('erin').keyId}});assert.equal((await m.post('bob','carol',bare.request)).status,200);}
 assert.equal((await m.party('carol').store.list({prefix:`conv/peer/${cid}/`})).size,2,'only alice and bob');
 await assert.rejects(m.run('carol','conversations.decide',{conversationId:cid,principal:m.party('erin').principal,decision:'accept'}),e=>e.code==='not_found');
 // Even a genuine introduction relayed by an accepted member cannot expand genesis membership.
 const genuine=await B.signInvitationResponse({...intro.payload,responder:{...intro.payload.responder,delegate:m.party('erin').signer.kid}},m.party('erin').signer);
 const relayed=await m.craft('bob','alice',cid,{type:'peer-proposal',counter:101,data:{principal:m.party('erin').principal,keyId:m.party('erin').keyId,introduction:genuine}});
 assert.equal((await m.post('bob','alice',relayed.request)).status,200);
 assert.ok(!(await m.get('alice',cid)).peers.some(p=>p.principal.subject===m.party('erin').owner));
 await assert.rejects(m.run('alice','conversations.decide',{conversationId:cid,principal:m.party('erin').principal,decision:'accept'}),e=>e.code==='not_found');
 // A member cannot speak as another: a token computed for alice's author slot still needs alice's signature.
 const bobIntro=await m.party('alice').store.get(`conv/intro/${cid}/${encodeURIComponent(m.party('bob').principal.issuer)}|${encodeURIComponent(m.party('bob').principal.subject)}`);
 const spoof=await m.craft('carol','bob',cid,{counter:300,author_principal:m.party('alice').principal,incarnation:bobIntro.payload.binding.incarnation,author:{principal:m.party('alice').principal,identityDocument:`${m.party('alice').principal.identityURI}/identity.json`,keyId:m.party('alice').keyId,delegate:m.party('carol').signer.kid}});
 assert.equal((await m.post('carol','bob',spoof.request)).status,401);
});

test('equivocation is kept as evidence and stops only that stream until the owner acts',async t=>{
 const m=await mesh(t,{names:['alice','bob','carol']}),cid=await m.conversation('alice',['bob','carol']);
 const a=await m.craft('bob','alice',cid,{counter:700,text:'first version'}),b=await m.craft('bob','alice',cid,{counter:700,text:'second version'});
 assert.equal((await m.post('bob','alice',a.request)).status,200);assert.equal((await m.post('bob','alice',b.request)).status,200);
 const view=await m.get('alice',cid);assert.equal(view.quarantinedStreams,1);assert.ok(view.timeline.some(e=>e.text==='first version'));assert.ok(!view.timeline.some(e=>e.text==='second version'));
 assert.equal((await m.party('alice').store.list({prefix:`conv/evidence/${cid}/`})).size,1);
 const next=await m.craft('bob','alice',cid,{counter:701});assert.equal((await m.post('bob','alice',next.request)).status,403);
 // The author's next key opens a new stream that is unaffected.
 await m.switchApp('bob');await m.run('bob','conversations.send',{conversationId:cid,text:'new stream'});await m.settle({advance:true});
 assert.ok((await m.texts('alice',cid)).includes('new stream'));
 await m.run('alice','conversations.resolve-stream',{conversationId:cid,principal:m.party('bob').principal,stream:a.envelope.payload.record.stream});
 assert.equal((await m.get('alice',cid)).quarantinedStreams,0);
});

test('a block wins over queued delivery and identical replays; leave stops addressing the leaver',async t=>{
 const m=await mesh(t),cid=await m.conversation('alice',['bob','carol','dave']);
 await m.run('carol','conversations.send',{conversationId:cid,text:'before block'});await m.settle();
 const op=await body(m,'carol',cid);
 await m.run('alice','contacts.block',{principal:m.party('carol').principal});
 assert.equal((await m.deliverPrepared('carol',op.operationId,'alice')).status,403,'a replay is rechecked live before the stored receipt');
 m.network.kill('carol');const queued=await m.run('alice','conversations.send',{conversationId:cid,text:'not for carol'});await m.settle();
 const st=await m.run('alice','conversations.status',{conversationId:cid,eventId:queued.eventId});assert.ok(!st.recipients.some(r=>r.principal.subject===m.party('carol').owner));
 await m.network.recover('carol');
 // Leave is a local courtesy: the leaver is no longer addressed and its room stops.
 await m.run('dave','conversations.leave',{conversationId:cid});await m.settle();
 assert.equal((await m.peerStates('bob',cid)).dave,'left');assert.equal((await m.get('dave',cid)).state,'left');
 const later=await m.run('bob','conversations.send',{conversationId:cid,text:'after dave left'});await m.settle();
 const s2=await m.run('bob','conversations.status',{conversationId:cid,eventId:later.eventId});assert.ok(!s2.recipients.some(r=>r.principal.subject===m.party('dave').owner));
});

test('one delegate-key snapshot per operation (IDKEYS-1): alternating key reads never mix kid and key',async t=>{
 const m=await mesh(t,{names:['alice','bob','carol']}),cid=await m.conversation('alice',['bob','carol']);
 const bob=m.party('bob'),first=bob.signer;await m.switchApp('bob');const second=bob.signer;m.revoked.clear();
 let n=0;bob.current=()=>(n++%2?second:first);
 for(let i=0;i<4;i++)await m.run('bob','conversations.send',{conversationId:cid,text:`alternating ${i}`});
 await m.settle({advance:true});
 for(let i=0;i<4;i++)assert.ok((await m.texts('alice',cid)).includes(`alternating ${i}`),`message ${i}`);
 assert.equal((await m.get('alice',cid)).quarantinedStreams,0);
});

test('secrets and tokens never reach audit entries, progress events or owner views',async t=>{
 const m=await mesh(t,{names:['alice','bob','carol']}),cid=await m.conversation('alice',['bob','carol']);
 await m.run('alice','conversations.rotate',{conversationId:cid});await m.settle();
 const secrets=[];for(const name of ['alice','bob','carol'])for(const [,s] of await m.party(name).store.list({prefix:`conv/secret/${cid}/`}))secrets.push(B.base64url(Uint8Array.from(s)));
 for(const name of ['alice','bob','carol']){
  m.clock.advance(300);const surfaces=JSON.stringify([m.party(name).peer.engine.audit.entries,await m.run(name,'send.events'),await m.get(name,cid),await m.run(name,'conversations.list'),await m.run(name,'conversations.invitations')]);
  for(const s of secrets)assert.ok(!surfaces.includes(s),`${name} leaked a secret`);assert.ok(!surfaces.includes('BindleConversation'));
 }
 for(const [,entry] of await m.edgeStore.list({prefix:'conv-peer/'}))assert.ok(!secrets.some(s=>JSON.stringify(entry).includes(s)));
});

test('a rejoining mailbox installs only secrets matching the digests it recorded, shared by an accepted peer',async t=>{
 let blocking=false;const m=await mesh(t,{names:['alice','bob','dave'],rules:[{to:'bob',mode:'status',status:503,when:()=>blocking}]}),cid=await m.conversation('alice',['bob','dave']);
 const room=await m.party('bob').store.get(`conv/room/${cid}`),epoch=room.current,real=Uint8Array.from(await m.party('bob').store.get(`conv/secret/${cid}/${epoch}`));
 await m.switchApp('bob');await m.party('bob').store.transaction(async tx=>{for(const [key] of await tx.list({prefix:`conv/secret/${cid}/`}))await tx.delete(key);});
 await m.run('bob','conversations.rejoin');blocking=true;await m.settle();blocking=false;
 assert.equal((await m.get('bob',cid)).awaitingSecret,true);
 const bobKey=`conv/peer/${cid}/${encodeURIComponent(m.party('bob').principal.issuer)}|${encodeURIComponent(m.party('bob').principal.subject)}`,incarnation=(await m.party('dave').store.get(bobKey)).outbound.incarnation;
 const share=async(secret,counter,over={})=>m.post('dave','bob',(await m.craft('dave','bob',cid,{type:'secret-share',counter,epoch,incarnation,secret,share:secret,data:{epoch,secretDigest:await B.secretDigest(secret)},...over})).request);
 // bob shares a hub host; dave's replies to it are held back, so bob still awaits its secret.
 // A member planting a different secret (or one for an epoch bob never recorded) is refused.
 const bogus=crypto.getRandomValues(new Uint8Array(32));assert.equal((await share(bogus,400)).status,403);
 const unknownEpoch=crypto.randomUUID();
 assert.equal((await m.post('dave','bob',(await m.craft('dave','bob',cid,{type:'secret-share',counter:401,epoch:unknownEpoch,incarnation,secret:real,share:real,data:{epoch:unknownEpoch,secretDigest:await B.secretDigest(real)}})).request)).status,403);
 // Anything else from an accepted peer is asked to retry until the secret is restored.
 const early=await m.post('dave','bob',(await m.craft('dave','bob',cid,{counter:402,incarnation,secret:real})).request);assert.equal(early.status,503,JSON.stringify(early.json));
 assert.equal((await share(real,403)).status,200);assert.equal((await m.get('bob',cid)).awaitingSecret,false);
 await m.settle({advance:true});await m.run('alice','conversations.send',{conversationId:cid,text:'restored'});await m.settle({advance:true});assert.ok((await m.texts('bob',cid)).includes('restored'));
});

test('the invitation item no longer holds the shared secret once the invitation is decided',async t=>{
 const m=await mesh(t,{names:['alice','bob','carol']});await m.conversation('alice',['bob','carol'],{accept:['bob']});
 const bobItems=[...(await m.party('bob').store.list({prefix:'item/'})).values()].filter(i=>i.kind==='conversation-init');
 assert.equal(bobItems.length,1);assert.equal(bobItems[0].secretRedacted,true);assert.ok(!('sharedSecret' in bobItems[0].envelope.payload.conversation));
 const carolItems=[...(await m.party('carol').store.list({prefix:'item/'})).values()].filter(i=>i.kind==='conversation-init');
 assert.ok('sharedSecret' in carolItems[0].envelope.payload.conversation,'undecided invitations keep it until accepted or declined');
 const {invitations}=await m.run('carol','conversations.invitations');await m.run('carol','conversations.accept',{itemId:invitations[0].itemId,decision:'decline'});
 assert.ok(!('sharedSecret' in (await m.party('carol').store.get(`item/${invitations[0].itemId}`)).envelope.payload.conversation));
 assert.equal((await m.run('carol','conversations.invitations')).invitations.length,0);
});

test('review regressions BB4-S1/S3/S5: spoofed invitations, sticky removal and blocks during relayed introductions',async t=>{
 const m=await mesh(t),cid=await m.conversation('alice',['bob','carol','dave']);
 // S1: carol re-sends bob a conversation-init reusing the ID; neither accept nor decline touches bob's real one.
 const genesis=(await m.party('bob').store.get(`conv/room/${cid}`)).genesisDigest,before=await m.party('bob').store.get(`conv/response/${cid}`);
 const room=await m.party('carol').store.get(`conv/room/${cid}`);
 const link=await m.link('bob'),meta=new URL(link).searchParams.get('bindle_meta'),claims=JSON.parse(new TextDecoder().decode(B.fromBase64url(meta.split('.')[1])));
 const secret=crypto.getRandomValues(new Uint8Array(32)),body=encoder.encode('spoof'),content=await B.contentDescriptor('text/plain',body),c=m.party('carol');
 const author={principal:c.principal,identityDocument:`${c.principal.identityURI}/identity.json`,keyId:c.keyId,delegate:c.signer.kid};
 const g=await B.signGenesis({version:1,profile:B.PROFILE,conversationId:cid,createdAt:m.clock.now(),creator:author,participants:[{principal:c.principal,keyId:c.keyId},{principal:m.party('bob').principal,keyId:m.party('bob').keyId}],secretEpoch:crypto.randomUUID(),secretDigest:await B.secretDigest(secret),subject:'spoof',content},c.signer);
 const env=await B.signEnvelope({version:1,profile:B.PROFILE,kind:'conversation-init',noReply:false,operationId:crypto.randomUUID(),createdAt:m.clock.now(),recipient:{issuer:claims.iss,owner:claims.sub,contactId:claims.jti,resource:claims.resource},content,subject:'spoof',optionalTags:[],author,conversation:{genesis:g,sharedSecret:B.base64url(secret),returnControl:{resource:`${c.ingress}/return/${'B'.repeat(32)}`,nonce:B.base64url(new Uint8Array(16)),expiresAt:m.clock.now()+86400000,maxResponseBytes:8192},creatorBinding:{ingress:c.ingress,incarnation:'spoof-1',profiles:[B.PROFILE],limits:{maxParticipants:32,maxMessageBytes:1048576,maxEnvelopeBytes:65536}}}},c.signer);
 const wire=B.encodeDelivery(env,{body,boundary:'bb4-spoof'});assert.equal((await m.post('carol','bob',{method:'POST',url:m.party('bob').ingress,headers:{authorization:`BindleLink ${meta}`,'content-type':wire.contentType},body:wire.bytes})).status,200);
 const spoof=(await m.run('bob','conversations.invitations')).invitations.find(i=>i.conversationId===cid);void room;
 for(const decision of ['decline','accept'])await assert.rejects(m.run('bob','conversations.accept',{itemId:spoof.itemId,decision}),e=>e.code==='conversation_conflict');
 assert.deepEqual(await m.party('bob').store.get(`conv/response/${cid}`),before);assert.equal((await m.party('bob').store.get(`conv/room/${cid}`)).genesisDigest,genesis);
 // S3: a removed member cannot re-prompt the owner with hellos.
 await m.run('alice','conversations.remove',{conversationId:cid,principal:m.party('dave').principal});await m.settle();
 const binding={ingress:m.party('dave').ingress,incarnation:'dave-again',profiles:[B.PROFILE],limits:{maxParticipants:32,maxMessageBytes:1048576,maxEnvelopeBytes:65536}};
 const hello=await m.craft('dave','alice',cid,{type:'peer-hello',counter:300,data:{binding,startCounter:300}});
 assert.equal((await m.post('dave','alice',hello.request)).status,403);assert.equal((await m.peerStates('alice',cid)).dave,'removed');
});

test('review regression BB4-S5: a blocked genesis participant is never auto-accepted through a relayed introduction',async t=>{
 const m=await mesh(t);const participants=[];for(const n of ['bob','carol','dave'])participants.push(await m.participant(n));
 const {conversationId:cid}=await m.run('alice','conversations.create',{text:'hi',participants});await m.settle();
 const accept=async n=>{const {invitations}=await m.run(n,'conversations.invitations');await m.run(n,'conversations.accept',{itemId:invitations[0].itemId,acceptListed:true});};
 await accept('bob');await m.run('bob','contacts.block',{principal:m.party('dave').principal});await accept('carol');await accept('dave');await m.settle({advance:true});
 assert.notEqual((await m.peerStates('bob',cid)).dave,'accepted');assert.equal((await m.peerStates('bob',cid)).carol,'accepted');
});

test('review regressions BB4-S2/S6/S7/S9: secrets leave op rows, retractions survive quarantine, roots follow genesis, awaiting answers verify first',async t=>{
 const m=await mesh(t,{names:['alice','bob','carol']}),cid=await m.conversation('alice',['bob','carol']);
 await m.run('alice','conversations.rotate',{conversationId:cid});await m.settle();
 const secrets=[];for(const [,x] of await m.party('alice').store.list({prefix:`conv/secret/${cid}/`}))secrets.push(B.base64url(Uint8Array.from(x)));
 const ops=JSON.stringify([...(await m.party('alice').store.list({prefix:'conv/op/'})).values()]);for(const x of secrets)assert.ok(!ops.includes(x)&&!ops.includes(JSON.stringify(Array.from(B.fromBase64url(x)))));
 // S7: a parentless message never sorts before the genesis.
 for(let i=0;i<6;i++){const r=await m.craft('bob','carol',cid,{counter:900+i,text:`root ${i}`});assert.equal((await m.post('bob','carol',r.request)).status,200);}
 assert.equal((await m.get('carol',cid)).timeline[0].type,'genesis');
 // S6: a retraction later quarantined (revoked key) does not hide the author's genuine retraction.
 const msg=await m.run('bob','conversations.send',{conversationId:cid,text:'please delete me'});await m.settle();
 const {old}=await m.switchApp('bob');const stolen=m.party('bob');void stolen;
 await m.party('carol').store.transaction(async tx=>{const ev=await tx.get(`conv/event/${cid}/${msg.eventId}`);ev.retractions=['A'.repeat(43)];await tx.put(`conv/event/${cid}/${msg.eventId}`,ev);await tx.put(`conv/event/${cid}/${'A'.repeat(43)}`,{eventId:'A'.repeat(43),type:'retract',parents:[],quarantined:{reason:'delegation_revoked'},author:ev.author});});
 assert.equal((await m.get('carol',cid)).timeline.find(e=>e.eventId===msg.eventId).deleted,false);
 await m.run('bob','conversations.retract',{conversationId:cid,target:msg.eventId});await m.settle({advance:true});
 assert.equal((await m.get('carol',cid)).timeline.find(e=>e.eventId===msg.eventId).deleted,true);void old;
 // S9: while awaiting a secret, a hello with a forged signature is refused without revealing membership.
 await m.party('carol').store.transaction(async tx=>{for(const [k] of await tx.list({prefix:`conv/secret/${cid}/`}))await tx.delete(k);});await m.run('carol','conversations.rejoin');await m.flush();
 const binding={ingress:m.party('alice').ingress,incarnation:'a-x',profiles:[B.PROFILE],limits:{maxParticipants:32,maxMessageBytes:1048576,maxEnvelopeBytes:65536}};
 const forged=await m.craft('alice','carol',cid,{type:'peer-hello',counter:950,secret:crypto.getRandomValues(new Uint8Array(32)),data:{binding,startCounter:950}});
 const f=structuredClone(forged.envelope);f.payload.subject='tampered';const wire=B.encodeDelivery(f,{boundary:'bb4-f'});
 const r=await m.post('alice','carol',{...forged.request,headers:{...forged.request.headers,'content-type':wire.contentType},body:wire.bytes});assert.equal(r.status,401);
});
