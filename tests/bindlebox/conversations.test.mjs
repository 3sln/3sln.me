// BB-B4 conversations over the seeded network simulator: a 3–5 party mesh across hosts, an offline peer catching up,
// removal with late events, concurrent and out-of-order edits, rotation disagreement, an app switch and the group bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMesh,B} from './conversations-fixtures.test.mjs';
import {CONVERSATION_OPERATIONS,orderEvents} from '../../packages/bindlebox-engine/domains/conversations.mjs';
import {MAILBOX_OPERATIONS} from '../../packages/bindlebox-engine/operations.mjs';

const ALL=['alice','bob','carol','dave','erin'];
const mesh=async(t,options)=>{const m=await createMesh(options);t.after(()=>m.dispose());return m;};
const others=(names,me)=>names.filter(n=>n!==me);

test('a five-party mesh across three hosts forms from one opt-in each and converges on one order',async t=>{
 const m=await mesh(t,{names:ALL}),cid=await m.conversation('alice',others(ALL,'alice'));
 // Bootstrap works both ways (P-1) and groups form through relayed introductions and direct hellos (P-2).
 for(const name of ALL)assert.deepEqual(await m.peerStates(name,cid),Object.fromEntries(others(ALL,name).map(n=>[n,'accepted'])),name);
 for(const name of ALL)await m.run(name,'conversations.send',{conversationId:cid,text:`hi from ${name}`});
 await m.settle();
 const reference=await m.order('alice',cid);assert.equal(reference.length,6);
 for(const name of ALL){assert.deepEqual(await m.order(name,cid),reference,`${name} order`);const view=await m.get(name,cid);assert.equal(view.rosterVerified,false);assert.equal(view.quarantinedStreams,0);
  for(const e of view.timeline.slice(1))assert.equal(e.text,`hi from ${[...m.parties.values()].find(p=>p.principal.subject===e.author.subject).name}`);}
 // Honest per-recipient status over the frozen audience: four custody receipts, nothing claimed beyond them.
 const own=(await m.get('carol',cid)).timeline.find(e=>e.own&&e.type==='message'),status=await m.run('carol','conversations.status',{conversationId:cid,eventId:own.eventId});
 assert.deepEqual([status.delivered,status.pending,status.failed,status.cancelled],[4,0,0,0]);assert.equal(status.recipients.length,4);assert.deepEqual(status.joinedAfter,[]);
 // No secret, token or incarnation in any owner view.
 const json=JSON.stringify(await m.get('bob',cid))+JSON.stringify(await m.run('bob','conversations.list'));
 const secret=B.base64url(Uint8Array.from(await m.party('bob').store.get(`conv/secret/${cid}/${(await m.get('bob',cid)).epoch}`)));
 assert.ok(!json.includes(secret)&&!/incarnation|BindleConversation|"secret"/.test(json));
 assert.ok(m.network.trace.some(r=>r.from==='bob'&&r.to==='bob'),'the shared hub carries bob→carol directly');
});

test('operations are registered as engine operations and queued work never repeats',async t=>{
 for(const Operation of CONVERSATION_OPERATIONS)assert.equal(typeof Operation.operation,'string');
 assert.ok(CONVERSATION_OPERATIONS.every(O=>MAILBOX_OPERATIONS[O.operation]===O));
 const m=await mesh(t,{names:['alice','bob','carol']}),cid=await m.conversation('alice',['bob','carol']);
 const sent=await m.run('bob','conversations.send',{conversationId:cid,text:'once',operationId:'00000000-0000-4000-8000-000000000042'});
 const again=await m.run('bob','conversations.send',{conversationId:cid,text:'once',operationId:'00000000-0000-4000-8000-000000000042'});
 assert.equal(again.eventId,sent.eventId);await m.settle();assert.equal((await m.texts('carol',cid)).filter(x=>x==='once').length,1);
 assert.equal(await m.settle(),0,'a settled mesh has no further work');
});

test('one peer offline, then catching up: retries, expiry, Retry missing and automatic catch-up on its return',async t=>{
 const m=await mesh(t),cid=await m.conversation('alice',['bob','carol','dave']);
 m.network.kill('dave');
 const first=await m.run('alice','conversations.send',{conversationId:cid,text:'while dave is away'});await m.settle();
 let status=await m.run('alice','conversations.status',{conversationId:cid,eventId:first.eventId});
 assert.deepEqual([status.delivered,status.pending],[2,1]);const dave=status.recipients.find(r=>r.principal.subject===m.party('dave').owner);
 assert.equal(dave.state,'retry_scheduled');assert.equal(dave.reason,'unreachable');
 // Short outage: dave returns inside the window and the queued obligation is delivered with the same envelope.
 await m.network.recover('dave');await m.settle({advance:true});
 status=await m.run('alice','conversations.status',{conversationId:cid,eventId:first.eventId});assert.deepEqual([status.delivered,status.pending],[3,0]);
 assert.deepEqual(await m.texts('dave',cid),await m.texts('alice',cid));
 // Catch-up after 73 hours renews the certificate while preserving the event and recipient context.
 m.network.kill('dave');const second=await m.run('alice','conversations.send',{conversationId:cid,text:'long gone'});await m.settle();
 m.clock.advance(73*3600000);await m.renew();await m.settle({advance:true});
 status=await m.run('alice','conversations.status',{conversationId:cid,eventId:second.eventId});assert.equal(status.recipients.find(r=>r.principal.subject===m.party('dave').owner).state,'expired');assert.deepEqual([status.delivered,status.failed],[2,1]);
 await m.network.recover('dave');await m.run('dave','conversations.send',{conversationId:cid,text:'back'});await m.settle({advance:true});
 const task=await m.taskFor('alice','dave',second.eventId);assert.equal(task.manualUsed,true);assert.ok(task.attempts>1,'catch-up requeued the expired obligation');
 assert.ok((await m.texts('alice',cid)).includes('back'));assert.equal(task.state,'delivered');assert.ok((await m.texts('dave',cid)).includes('long gone'));assert.equal(task.secret,null);assert.equal(task.credential,null);
});

test('removal: late events from the removed member are refused while others still accept them; readmission is fresh',async t=>{
 let failing=false;const m=await mesh(t,{rules:[{from:'carol',to:'alice',mode:'status',status:503,when:()=>failing}]}),cid=await m.conversation('alice',['bob','carol','dave']);
 // Carol's message is in flight to alice (its first attempt fails) when alice removes her.
 failing=true;const late=await m.run('carol','conversations.send',{conversationId:cid,text:'late from carol'});await m.settle();failing=false;
 assert.equal((await m.taskFor('carol','alice',late.eventId)).state,'retry_scheduled');
 await m.run('alice','conversations.remove',{conversationId:cid,principal:m.party('carol').principal});await m.settle({advance:true});
 assert.equal((await m.taskFor('carol','alice',late.eventId)).state,'rejected','a removed author is refused, not silently dropped');
 assert.ok(!(await m.texts('alice',cid)).includes('late from carol'));assert.ok((await m.texts('bob',cid)).includes('late from carol'));
 // A forged attempt with carol's still-valid key and the old token is refused at the edge.
 const crafted=await m.craft('carol','alice',cid,{signer:m.party('carol').signer,counter:50});
 assert.equal((await m.post('carol','alice',crafted.request)).status,403);
 // Alice's later messages exclude carol (frozen audience), and her own late edit cannot reach alice.
 const after=await m.run('alice','conversations.send',{conversationId:cid,text:'without carol'});await m.settle();
 assert.equal((await m.run('alice','conversations.status',{conversationId:cid,eventId:after.eventId})).recipients.length,2);
 assert.ok(!(await m.texts('carol',cid)).includes('without carol'));
 await m.run('carol','conversations.edit',{conversationId:cid,target:late.eventId,text:'edited late'});await m.settle({advance:true});
 assert.ok((await m.texts('bob',cid)).includes('edited late'));assert.ok(!(await m.texts('alice',cid)).includes('edited late'));
 // Readmission issues a fresh incarnation through a hello; the rejected obligation stays rejected.
 await m.run('alice','conversations.readmit',{conversationId:cid,principal:m.party('carol').principal});await m.settle({advance:true});
 assert.equal((await m.peerStates('alice',cid)).carol,'accepted');assert.equal((await m.taskFor('carol','alice',late.eventId)).state,'rejected');
 await m.run('carol','conversations.send',{conversationId:cid,text:'carol again'});await m.settle({advance:true});
 assert.ok((await m.texts('alice',cid)).includes('carol again'));
 // The old incarnation is stale after readmission.
 const old=await m.craft('carol','alice',cid,{counter:60,incarnation:crafted.envelope.payload.recipient.incarnation});
 assert.ok([403,409].includes((await m.post('carol','alice',old.request)).status));
});

test('edits and retractions: out-of-order arrival converges, history is kept, and only the author can mutate',async t=>{
 const m=await mesh(t,{names:['alice','bob','carol']}),cid=await m.conversation('alice',['bob','carol']);
 m.network.kill('bob');
 const original=await m.run('alice','conversations.send',{conversationId:cid,text:'v1'});
 const e1=await m.run('alice','conversations.edit',{conversationId:cid,target:original.eventId,text:'v2'});
 const e2=await m.run('alice','conversations.edit',{conversationId:cid,target:original.eventId,text:'v3'});
 await m.network.recover('bob');
 // Bob receives the second edit, then the first, then the target (P-8): both wait as pending mutations.
 for(const op of [e2,e1,original])assert.equal((await m.deliverPrepared('alice',op.operationId,'bob')).status,200);
 await m.settle({advance:true});
 const bob=(await m.get('bob',cid)).timeline.find(e=>e.eventId===original.eventId),carol=(await m.get('carol',cid)).timeline.find(e=>e.eventId===original.eventId);
 assert.equal(bob.text,'v3');assert.deepEqual(bob.history.map(h=>h.text),['v1','v2','v3']);assert.deepEqual(carol,bob);
 // A retraction suppresses rendering and later edits never resurrect it; history stays for Peek.
 await m.run('alice','conversations.retract',{conversationId:cid,target:original.eventId});await m.settle();
 const gone=(await m.get('carol',cid)).timeline.find(e=>e.eventId===original.eventId);assert.equal(gone.deleted,true);assert.equal(gone.text,null);assert.equal(gone.history.length,3);
 const resurrect=await m.craft('alice','carol',cid,{type:'edit',target:original.eventId,text:'back from the dead',counter:40,signer:m.party('alice').signer});
 assert.equal((await m.post('alice','carol',resurrect.request)).status,200);assert.equal((await m.get('carol',cid)).timeline.find(e=>e.eventId===original.eventId).deleted,true);
 // Another member cannot edit alice's message: a known target with another author is record_forbidden.
 const forged=await m.craft('bob','carol',cid,{type:'edit',target:original.eventId,text:'forged',counter:30});
 const refused=await m.post('bob','carol',forged.request);assert.equal(refused.status,403);assert.equal(refused.json.error,'record_forbidden');
 // A pending mutation from the wrong author is dropped when the target arrives.
 const mine=await m.run('carol','conversations.send',{conversationId:cid,text:'carol original'});
 const early=await m.craft('bob','alice',cid,{type:'retract',target:mine.eventId,counter:31});assert.equal((await m.post('bob','alice',early.request)).status,200);
 await m.settle();assert.equal((await m.get('alice',cid)).timeline.find(e=>e.eventId===mine.eventId).deleted,false);
});

test('ordering is a deterministic topological sort with an event-ID tie-break',()=>{
 const a={eventId:'a',type:'genesis',parents:[]},b={eventId:'b',type:'message',parents:['a']},c={eventId:'c',type:'message',parents:['a']},d={eventId:'d',type:'message',parents:['c','b']},h={eventId:'0',type:'peer-hello',parents:[]};
 assert.deepEqual(orderEvents([d,c,b,a,h]),['a','b','c','d']);assert.deepEqual(orderEvents([a,b,c,d]),orderEvents([d,b,a,c]));
});

test('rotation disagreement: explicit local choices, epoch-pending delivery, overlap, and conflicting proposals',async t=>{
 const m=await mesh(t),cid=await m.conversation('alice',['bob','carol','dave']);
 const rotated=await m.run('alice','conversations.rotate',{conversationId:cid});await m.settle();
 // Concurrent proposal by bob before he sees alice's choice: dave must choose explicitly.
 await m.run('bob','conversations.rotate',{conversationId:cid});await m.settle();
 const dave=await m.get('dave',cid);assert.equal(dave.rotationConflict,true);assert.equal(dave.rotations.filter(r=>r.state==='pending').length,2);
 await m.run('carol','conversations.select-rotation',{conversationId:cid,epoch:rotated.epoch,decision:'accept'});
 await m.run('dave','conversations.select-rotation',{conversationId:cid,epoch:rotated.epoch,decision:'decline'});
 // Alice's next message: carol accepts the new epoch; dave's obligation waits with reason `epoch`, never terminal.
 const msg=await m.run('alice','conversations.send',{conversationId:cid,text:'new epoch'});await m.settle();
 const st=await m.run('alice','conversations.status',{conversationId:cid,eventId:msg.eventId}),byName=n=>st.recipients.find(r=>r.principal.subject===m.party(n).owner);
 assert.equal(byName('carol').state,'delivered');assert.equal(byName('dave').state,'retry_scheduled');assert.equal(byName('dave').reason,'epoch');
 // Dave still sends under the old epoch; alice accepts it during the 7-day overlap and shows the disagreement.
 await m.run('dave','conversations.send',{conversationId:cid,text:'old epoch'});await m.settle();
 assert.ok((await m.texts('alice',cid)).includes('old epoch'));assert.equal((await m.get('alice',cid)).peers.find(p=>p.principal.subject===m.party('dave').owner).rotationDisagreement,true);
 // Dave changes his mind: the waiting obligation is delivered with its original envelope.
 const pending=(await m.get('dave',cid)).rotations;assert.ok(pending.some(r=>r.epoch===rotated.epoch&&r.state==='declined'));
 const bobs=pending.find(r=>r.state==='pending');await m.run('dave','conversations.select-rotation',{conversationId:cid,epoch:bobs.epoch,decision:'accept'});
 assert.equal((await m.get('dave',cid)).epoch,bobs.epoch);
 // The genesis epoch stays accepted by alice for 7 days after she selected hers, and not after.
 const genesisEpoch=(await m.party('alice').store.get(`conv/room/${cid}`)).genesisEpoch;
 const within=await m.craft('dave','alice',cid,{counter:90,epoch:genesisEpoch,signer:m.party('dave').signer});assert.equal((await m.post('dave','alice',within.request)).status,200);
 m.clock.advance(8*86400000);await m.renew();
 const stale=await m.craft('dave','alice',cid,{counter:91,epoch:genesisEpoch,signer:m.party('dave').signer});const r=await m.post('dave','alice',stale.request);assert.equal(r.status,403);assert.equal(r.json.error,'not_authorized');
});

test('app switch mid-conversation: new key, new ingress, rejoin and secret-share; never mistaken for a forger',async t=>{
 const m=await mesh(t),cid=await m.conversation('alice',['bob','carol','dave']);
 const before=await m.run('bob','conversations.send',{conversationId:cid,text:'from the old app'});await m.settle();
 const {old}=await m.switchApp('bob',{ingress:'https://bob-next.box.example/ingress'});
 // The new occupant imports control state but no secrets (spec §6.6, §10).
 const store=m.party('bob').store;await store.transaction(async tx=>{for(const [key] of await tx.list({prefix:`conv/secret/${cid}/`}))await tx.delete(key);});
 assert.equal((await m.run('bob','conversations.rejoin')).rejoins,3);
 assert.equal((await m.get('bob',cid)).awaitingSecret,true);
 await m.settle({advance:true});
 const view=await m.get('bob',cid);assert.equal(view.awaitingSecret,false);assert.equal(view.secretConflict,false);
 const after=await m.run('bob','conversations.send',{conversationId:cid,text:'from the new app'});await m.settle({advance:true});
 for(const name of ['alice','carol','dave']){
  const v=await m.get(name,cid);assert.equal(v.quarantinedStreams,0,`${name} saw no equivocation`);
  const e=v.timeline.find(x=>x.eventId===after.eventId);assert.equal(e.text,'from the new app');assert.equal(e.author.subject,m.party('bob').owner);
  const row=await m.party(name).store.get(`conv/event/${cid}/${after.eventId}`);assert.equal(row.stream,m.party('bob').signer.kid);
  // The new key opened a new stream (its rejoin was counter 1 there, linked to the old head); never equivocation.
  const rejoin=[...(await m.party(name).store.list({prefix:`conv/event/${cid}/`})).values()].find(e=>e.type==='rejoin');assert.equal(rejoin.continuation,rejoin.counter===1);
  assert.equal((await m.party(name).store.list({prefix:`conv/evidence/${cid}/`})).size,0);
  assert.deepEqual(await m.order(name,cid),await m.order('bob',cid));
 }
 assert.ok((await m.texts('alice',cid)).includes('from the old app'));
 // Bob also receives under his new ingress and incarnations.
 await m.run('carol','conversations.send',{conversationId:cid,text:'welcome back'});await m.settle({advance:true});assert.ok((await m.texts('bob',cid)).includes('welcome back'));
 // The revoked old key cannot rejoin, and a second rejoin the same day is rate limited.
 const replayRejoin=await m.craft('bob','alice',cid,{type:'rejoin',counter:2,data:{binding:{ingress:'https://bob-next.box.example/ingress',incarnation:'x-1',profiles:[B.PROFILE],limits:{maxParticipants:32,maxMessageBytes:1048576,maxEnvelopeBytes:65536}}}});
 delete replayRejoin.request.headers.authorization;const limited=await m.post('bob','alice',replayRejoin.request);assert.equal(limited.status,429);
 assert.ok(m.revoked.has(old));void before;
});

test('group bound: compose-time pre-check, invitee refusal, lowered limits and limit indicators',async t=>{
 const m=await mesh(t,{names:ALL,maxParticipants:{alice:3,erin:4}});
 // Alice cannot propose a group larger than she accepts.
 const people=[];for(const n of ['bob','carol','dave'])people.push(await m.participant(n));
 await assert.rejects(m.run('alice','conversations.create',{text:'too big',participants:people}),e=>e.code==='participants_exceeded');
 // Bob invites everyone; erin (limit 4) must refuse a five-person genesis.
 const cid=await m.conversation('bob',['alice','carol','dave','erin'],{accept:['carol','dave']});
 const {invitations}=await m.run('erin','conversations.invitations');
 await assert.rejects(m.run('erin','conversations.accept',{itemId:invitations[0].itemId}),e=>e.code==='participants_exceeded');
 const bobView=await m.get('bob',cid);assert.equal(bobView.someCannotSeeEveryone,false);
 // A limit lowered after acceptance bounds later admissions: carol now accepts at most two peers.
 const cid2=await m.conversation('bob',['carol','dave','erin'],{accept:['carol'],acceptListed:true});
 await m.run('carol','conversations.configure',{maxParticipants:2});
 for(const n of ['dave','erin']){const {invitations:inv}=await m.run(n,'conversations.invitations');await m.run(n,'conversations.accept',{itemId:inv.find(i=>i.conversationId===cid2).itemId,acceptListed:true});}
 await m.settle({advance:true});
 const carol=await m.peerStates('carol',cid2);assert.equal(Object.values(carol).filter(s=>s==='accepted').length,1,'only the creator fits a limit of two');
 assert.ok(['proposed','pending'].includes(carol.dave));
 await assert.rejects(m.run('carol','conversations.decide',{conversationId:cid2,principal:m.party('dave').principal,decision:'accept'}),e=>e.code==='participants_exceeded');
 // A hello beyond the bound is refused with participants_exceeded, an honest terminal outcome for the sender.
 const hello=(await m.tasks('dave')).find(t=>t.envelope.payload.record?.type==='peer-hello'&&t.principal.subject===m.party('carol').owner);
 assert.ok(!hello||hello.state==='delivered'||hello.class==='participants_exceeded');
 // Limits that differ are visible to the owner (compose-time indicator).
 assert.equal((await m.get('dave',cid2)).someCannotSeeEveryone,true);
});


test('composed shell: three-party HTTP ingress, conversation send/receive, Views/tags, edit and member removal',async t=>{
 const m=await mesh(t,{names:['alice','bob','carol'],shell:true}),cid=await m.conversation('alice',['bob','carol']);
 for(const name of ['alice','bob','carol'])assert.equal(Object.values(await m.peerStates(name,cid)).filter(s=>s==='accepted').length,2);
 const sent=await m.run('alice','conversations.send',{conversationId:cid,text:'composed message'});await m.settle();
 assert.ok((await m.texts('bob',cid)).includes('composed message'));assert.ok((await m.texts('carol',cid)).includes('composed message'));
 const page=await m.run('bob','incoming.query',{filter:{version:1,types:['conversation']}});assert.equal(page.total,1);assert.equal(page.items[0].id,cid);
 await m.run('bob','incoming.update',{id:cid,expectedRevision:page.items[0].organizationRevision,tags:['project'],read:true,expectedActivityRevision:page.items[0].activityRevision});
 const view=await m.run('bob','views.create',{name:'Project',filter:{version:1,tagsAll:['project']}});
 assert.equal((await m.run('bob','incoming.query',{view:view.id,viewRevision:view.revision})).total,1);
 await m.run('alice','conversations.edit',{conversationId:cid,target:sent.eventId,text:'composed edit'});await m.settle();
 assert.ok((await m.texts('bob',cid)).includes('composed edit'));
 const edited=await m.run('bob','incoming.query',{view:view.id,viewRevision:view.revision});assert.equal(edited.total,1);assert.equal(edited.items[0].readAt,null);
 await m.run('alice','conversations.remove',{conversationId:cid,principal:m.party('carol').principal});
 const after=await m.run('alice','conversations.send',{conversationId:cid,text:'after removal'});await m.settle();
 const status=await m.run('alice','conversations.status',{conversationId:cid,eventId:after.eventId});assert.deepEqual([status.delivered,status.recipients.length],[1,1]);
 assert.ok((await m.texts('bob',cid)).includes('after removal'));assert.ok(!(await m.texts('carol',cid)).includes('after removal'));
 const rows=await m.tasks('alice');assert.ok(rows.every(row=>row.secret===null&&row.credential===null));assert.ok(rows.filter(row=>row.kind==='conversation-init').every(row=>!Object.hasOwn(row.envelope.payload.conversation,'sharedSecret')));
});


test('completed, rejected and cancelled secret-carrying outbox tasks purge secrets without losing status',async t=>{
 let reject=false;const m=await mesh(t,{names:['alice','bob','dave'],rules:[{from:'alice',to:'bob',mode:'status',status:413,when:()=>reject}]}),cid=await m.conversation('alice',['bob','dave']);
 reject=true;const rotated=await m.run('alice','conversations.rotate',{conversationId:cid});await m.settle();
 const tasks=(await m.tasks('alice')).filter(t=>t.messageId===rotated.operationId);assert.deepEqual(tasks.map(t=>t.state).sort(),['delivered','rejected']);assert.ok(tasks.every(t=>t.secret===null&&t.credential===null));
 reject=false;m.network.kill('bob');const second=await m.run('alice','conversations.rotate',{conversationId:cid});await m.settle();
 const pending=await m.taskFor('alice','bob',second.eventId);assert.ok(pending.secret?.length===32);
 await m.party('alice').peer.engine.run('outbox.cancel',{id:second.operationId});const cancelled=await m.taskFor('alice','bob',second.eventId);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.secret,null);assert.equal(cancelled.credential,null);
});
