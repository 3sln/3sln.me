// ACT-2 engine-level activity push policy with a fake clock: per-app opt-in, rules overriding app priority, quiet
// hours across time-zone changes, digest windows, collapse, budgets, lock-screen privacy, multi-account destinations
// and the read/dispatch race at the leased outbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestEngine,OWNER,OTHER,ownerActor} from './helpers/app-engine.mjs';
import {fakeClock} from '../packages/app/memory-providers.mjs';
import {canonical} from '../packages/core/primitives.mjs';
import {base64url,key,digest} from '../packages/core/records.mjs';
import {ACCOUNT_OPERATIONS} from '../packages/app/operations.mjs';
import {CreateActivity,ReplaceActivity,MarkActivity,ArchiveActivity} from '../packages/app/domains/activity.mjs';
import {ACTIVITY_PUSH_OWNER_OPERATIONS,ACTIVITY_PUSH_LIMITS,ClaimActivityPush,AuthorizeActivityPush,FinishActivityPush,dispatchActivityPush,activityDestinationHint,activityQuiet,nextDigestAt,defaultNotificationPreferences} from '../packages/messaging/notifications.mjs';

const ISSUER='https://provider.example',HOUR=3600000,MINUTE=60000;
async function signer(){
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 return {kid:'k1',sign:async payload=>base64url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(canonical(payload)))))};
}
const connectionId=n=>`${String(n).padStart(8,'0')}-0000-8000-a000-000000000000`;
const policy=(extra={})=>({enabled:true,paused:false,preview:false,quiet:{enabled:false,startHour:22,endHour:7,timeZone:null,utcOffsetMinutes:0},digest:{cadence:'daily',hour:8},mutes:[],rules:[],...extra});

async function setup({owner=OWNER,start=Date.UTC(2026,9,14,12),devices=1,endpoint=n=>`https://fcm.googleapis.com/fcm/send/device-${n}`,channel=true}={}){
 const clock=fakeClock(start),f=await createTestEngine({clock}),keys=await signer();await f.metadata.put('owner',owner);
 if(channel){const prefs=defaultNotificationPreferences();prefs.push.enabled=true;await f.metadata.put(key('notification-preferences',owner),prefs);}
 const actor=ownerActor(owner),subs=[];
 for(let i=1;i<=devices;i++){const url=endpoint(i),id=await digest(crypto,url);await f.metadata.put(key('push-subscription',owner,id),{id,owner,endpoint:url,keys:{p256dh:base64url(new Uint8Array(65).fill(4)),auth:base64url(new Uint8Array(16).fill(2))},label:`Device ${i}`,createdAt:f.clock.now()});subs.push(id);}
 const op=async(name,params={})=>{const r=await f.perform(new ACTIVITY_PUSH_OWNER_OPERATIONS[name]({actor,...params}));clock.advance(1);return r;};
 const query=(name,params={})=>f.read(new ACTIVITY_PUSH_OWNER_OPERATIONS[name]({actor,...params}));
 let n=owner===OWNER?0:50;
 const connect=async({app='cal',generation=1}={})=>{
  const id=connectionId(++n),clientId=`https://${app}.example/client`,origin=`https://${app}.example`,name=`${app} app`;
  const record=g=>({id,owner,clientId,name,status:'active',generation:g,kind:'app-connection',provider:'app',transport:'bindle',appOrigin:origin,notifications:{enabled:true,generation:2}});
  await f.metadata.put('resource/'+id,record(generation));
  const make=g=>{const appActor={kind:'app',owner,issuer:ISSUER,app:{clientId,origin,name},connection:{id,generation:g,admissionGeneration:2}};
   const input=extra=>({operationId:crypto.randomUUID(),createdAt:f.clock.now(),...extra});
   return {id,name,
    create:async(extra={})=>{clock.advance(1);return f.perform(new CreateActivity({actor:appActor,input:input({subject:'Build finished',body:'All checks passed.',...extra}),keys}));},
    replace:(item,expectedRevision,extra={})=>f.perform(new ReplaceActivity({actor:appActor,input:input({item,expectedRevision,subject:'Build updated',body:'New result.',...extra}),keys})),
    optIn:(input={mode:'all'})=>op('app',{id,input}),
    reconnect:async()=>{await f.metadata.put('resource/'+id,record(g+1));return make(g+1);},
   };};
  return make(generation);
 };
 const sent=[];let fault=null;
 const transport={async send(subscription,payload,options){if(fault){const e=fault;fault=null;throw e;}sent.push({subscription,payload,options});return {accepted:true};}};
 const dispatch=(extra={})=>dispatchActivityPush({perform:action=>f.perform(action),owner,transport,...extra});
 const enroll=async(preview=false)=>{for(const id of subs)await op('device',{id,input:{enrolled:true,preview}});};
 return {...f,owner,actor,subs,op,query,connect,sent,transport,dispatch,enroll,failNext:e=>{fault=e;},
  configure:input=>op('configure',{input:policy(input)}),
  explain:id=>query('explain',{id}),
  mark:(id,revision,read=true)=>f.perform(new MarkActivity({actor,id,input:{revision,read}})),
  archive:id=>f.perform(new ArchiveActivity({actor,id,input:{archived:true}})),
  claim:(input={})=>f.perform(new ClaimActivityPush({actor,input})),
  authorize:lease=>f.perform(new AuthorizeActivityPush({actor,input:lease})),
  finish:input=>f.perform(new FinishActivityPush({actor,input})),
 };
}
const rejects=(promise,code)=>assert.rejects(promise,error=>{assert.equal(error.code,code,`expected ${code}, got ${error.code}: ${error.message}`);return true;});
async function ready(options){const f=await setup(options);await f.configure();await f.enroll();return f;}

test('push is opt-in per app and prospective: admission, channel, policy and devices alone never ring', async t=>{
 const f=await setup();t.after(()=>f.dispose());const cal=await f.connect();
 assert.ok(!Object.keys(ACCOUNT_OPERATIONS).some(n=>n.startsWith('activity.push')),'push operations are not owner-dispatchable by wire name');
 const settings=await f.query('settings');assert.equal(settings.policy.enabled,false);assert.equal(settings.policy.preview,false);assert.deepEqual(settings.apps,[]);
 const first=await cal.create();await f.dispatch();assert.equal(f.sent.length,0,'policy off by default');
 await f.configure();await f.dispatch();assert.equal(f.sent.length,0,'no enrolled device');
 await f.enroll();const second=await cal.create();await f.dispatch();assert.equal(f.sent.length,0);
 assert.equal((await f.explain(second.item)).reason,'app_off','an admitted app still needs its own push opt-in');
 await cal.optIn();await f.dispatch();assert.equal(f.sent.length,0,'enabling push never releases the backlog');
 assert.equal((await f.explain(first.item)).reason,'before_opt_in');
 const third=await cal.create({priority:'urgent'});await f.dispatch();assert.equal(f.sent.length,1);
 const [{payload,options}]=f.sent;assert.equal(options.urgency,'normal','an app urgency claim is capped at normal');
 assert.deepEqual(payload.destination,{account:await activityDestinationHint(OWNER,f.subs[0]),item:third.item,revision:1});
 assert.equal(payload.title,'New activity');assert.deepEqual(payload.actions,[]);
 for(const leak of ['cal','Build',OWNER,'urgent','http'])assert.ok(!JSON.stringify(payload).includes(leak),`generic payload leaks ${leak}`);
 // The global channel switch and "pause all push" stop it again immediately.
 await f.configure({paused:true});await cal.create();await f.dispatch();assert.equal(f.sent.length,1);
});

test('an opted-out app, a replaced incarnation, mutes and selected-tag scope stay feed-only', async t=>{
 const f=await ready();t.after(()=>f.dispose());let cal=await f.connect({app:'cal'});const bank=await f.connect({app:'bank'});
 await cal.optIn({mode:'selected',tags:['deploy']});
 const other=await bank.create({priority:'urgent',tags:['deploy']});
 const unselected=await cal.create({tags:['marketing'],priority:'urgent'});
 const untagged=await cal.create({priority:'urgent'});
 await f.dispatch();assert.equal(f.sent.length,0);
 assert.equal((await f.explain(other.item)).reason,'app_off','another app\'s opt-in never allows this app');
 assert.equal((await f.explain(unselected.item)).reason,'tag_not_selected','rotating tags or urgency cannot escape selected-tag mode');
 assert.equal((await f.explain(untagged.item)).reason,'tag_not_selected');
 // A rule for another app does not leak: rules are scoped to one app connection.
 await f.configure({rules:[{id:'r1',app:cal.id,route:'immediate'}]});
 const afterRule=await bank.create({tags:['deploy']});await f.dispatch();assert.equal(f.sent.length,0);assert.equal((await f.explain(afterRule.item)).reason,'app_off');
 await f.configure({mutes:[{app:cal.id,tag:'deploy'}],rules:[{id:'r1',app:cal.id,route:'immediate',priority:'urgent'}]});
 const muted=await cal.create({tags:['deploy']});await f.dispatch();assert.equal(f.sent.length,0);assert.equal((await f.explain(muted.item)).reason,'muted','a hard mute wins over an allow rule');
 await f.configure();const ok=await cal.create({tags:['deploy']});await f.dispatch();assert.equal(f.sent.length,1);
 cal=await cal.reconnect();const fresh=await cal.create({tags:['deploy']});await f.dispatch();assert.equal(f.sent.length,1);
 assert.equal((await f.explain(fresh.item)).reason,'app_off','reconnecting requires a fresh opt-in');
 assert.equal((await f.explain(ok.item)).reason,'disconnected','the previous incarnation\'s items lose push eligibility');
});

test('a priority-spoofing app cannot bypass quiet hours, budgets or owner demotion; only an owner rule escalates', async t=>{
 const f=await ready({start:Date.UTC(2026,9,14,23)});const at=f.clock;t.after(()=>f.dispose());const spam=await f.connect({app:'spam'}),pager=await f.connect({app:'pager'});
 await spam.optIn();await pager.optIn();
 await f.configure({quiet:{enabled:true,startHour:22,endHour:7,timeZone:null,utcOffsetMinutes:0}});
 for(let i=0;i<3;i++)await spam.create({priority:'urgent',subject:`URGENT ${i}`});
 await f.dispatch();assert.equal(f.sent.length,0,'urgent claims are held through quiet hours');
 // The owner's explicit app-scoped bypass rule rings during quiet hours with high urgency.
 await f.configure({quiet:{enabled:true,startHour:22,endHour:7,timeZone:null,utcOffsetMinutes:0},rules:[{id:'page',app:pager.id,minPriority:'urgent',route:'immediate',priority:'urgent',quietBypass:true},{id:'calm',app:spam.id,route:'immediate',priority:'low'}]});
 const paged=await pager.create({priority:'urgent'});await f.dispatch();assert.equal(f.sent.length,1);assert.equal(f.sent[0].options.urgency,'high');assert.equal(f.sent[0].payload.destination.item,paged.item);
 const routine=await pager.create({priority:'normal'});await f.dispatch();assert.equal(f.sent.length,1,'the bypass rule needs the urgent minimum');assert.equal((await f.explain(routine.item)).route,'immediate');
 // Morning: one digest for everything held, then the per-app hourly cap applies to the spoofed urgency.
 at.set(Date.UTC(2026,9,15,7));await f.dispatch();assert.equal(f.sent.length,2);assert.equal(f.sent[1].payload.destination.item,undefined,'held activity arrives as one digest');assert.equal(f.sent[1].options.urgency,'low');
 at.advance(HOUR);for(let i=0;i<5;i++)await spam.create({priority:'urgent'});await f.dispatch();
 const immediate=f.sent.slice(2);assert.equal(immediate.length,ACTIVITY_PUSH_LIMITS.app.hour,'per-app hourly cap');
 assert.ok(immediate.every(s=>s.options.urgency==='low'),'the owner demoted this app');
 at.advance(HOUR);await f.dispatch();assert.equal(f.sent.length,2+ACTIVITY_PUSH_LIMITS.app.hour,'budget overflow never becomes an extra unscheduled notice');
 at.set(Date.UTC(2026,9,16,8));await f.dispatch();assert.equal(f.sent.length,2+ACTIVITY_PUSH_LIMITS.app.hour+1,'overflow is coalesced into the owner\'s scheduled digest');
 assert.equal(f.sent.at(-1).payload.destination.item,undefined);
});

test('quiet hours follow the named time zone across a DST change and an owner time-zone change', async t=>{
 // 2026-11-01 06:30 America/New_York (EST, after the DST change); a fixed EDT offset would think it is 07:30.
 const start=Date.UTC(2026,10,1,11,30);
 const quiet={enabled:true,startHour:22,endHour:7,timeZone:'America/New_York',utcOffsetMinutes:0};
 assert.equal(activityQuiet(quiet,start),true);assert.equal(activityQuiet({...quiet,timeZone:null,utcOffsetMinutes:-240},start),false);
 const f=await ready({start});t.after(()=>f.dispose());const at=f.clock;const cal=await f.connect();await cal.optIn();
 await rejects(f.configure({quiet:{...quiet,timeZone:'Mars/Olympus'}}),'invalid_preferences');
 await f.configure({quiet});const held=await cal.create();await f.dispatch();assert.equal(f.sent.length,0);
 at.set(Date.UTC(2026,10,1,11,59));await f.dispatch();assert.equal(f.sent.length,0);
 at.set(Date.UTC(2026,10,1,12));await f.dispatch();assert.equal(f.sent.length,1,'released at 07:00 EST');
 assert.equal(f.sent[0].payload.destination.item,undefined);
 // 23:00 EST: quiet in New York; the owner moves to Tokyo (12:00 JST), and the held item is released at once.
 at.set(Date.UTC(2026,10,2,4));await f.dispatch();await cal.create();await f.dispatch();assert.equal(f.sent.length,1);
 const settings=await f.query('settings');assert.equal(settings.policy.quiet.timeZone,'America/New_York');
 await f.configure({quiet:{...quiet,timeZone:'Asia/Tokyo'}});await f.dispatch();assert.equal(f.sent.length,2,'quiet is evaluated at dispatch in the current zone');
 // Equal endpoints: quiet all day, no automatic release.
 await f.configure({quiet:{...quiet,startHour:9,endHour:9}});await cal.create();for(let h=0;h<30;h++){at.advance(HOUR);await f.dispatch();}assert.equal(f.sent.length,2);
 assert.equal(held.revision,1);
});

test('digest windows batch, collapse and re-check membership at send time', async t=>{
 const at0=Date.UTC(2026,9,14,12);
 assert.equal(nextDigestAt({cadence:'daily',hour:8},{timeZone:null,utcOffsetMinutes:0},at0),Date.UTC(2026,9,15,8));
 assert.equal(nextDigestAt({cadence:'hourly',hour:0},{timeZone:'Asia/Kolkata',utcOffsetMinutes:0},Date.UTC(2026,9,14,12,10)),Date.UTC(2026,9,14,12,30),'local :00 in a half-hour zone');
 assert.equal(nextDigestAt({cadence:'daily',hour:8},{timeZone:'America/New_York',utcOffsetMinutes:0},Date.UTC(2026,9,31,13)),Date.UTC(2026,10,1,13),'08:00 EST after the DST change');
 const f=await setup();t.after(()=>f.dispose());const at=f.clock;await f.configure({preview:true});await f.enroll(true);
 const cal=await f.connect(),ci=await f.connect({app:'ci'});await cal.optIn({mode:'all',route:'digest'});await ci.optIn({mode:'all',route:'digest'});
 await cal.create({subject:'Standup moved',collapseKey:'standup'});at.advance(MINUTE);
 await cal.create({subject:'Standup moved again',collapseKey:'standup'});
 const gone=await ci.create({subject:'Nightly failed'});const kept=await ci.create({subject:'Release ready'});
 await f.dispatch();at.set(Date.UTC(2026,9,15,7,59));await f.dispatch();assert.equal(f.sent.length,0,'nothing before the window');
 await f.mark(gone.item,1);
 at.set(Date.UTC(2026,9,15,8));await f.dispatch({accountLabel:'ray'});assert.equal(f.sent.length,1,'one account-scoped summary per window and device');
 const [{payload}]=f.sent;assert.equal(payload.title,'2 new activity items');
 assert.match(payload.body,/^For ray\n/);assert.match(payload.body,/cal app: Standup moved again/);assert.match(payload.body,/ci app: Release ready/);
 assert.ok(!payload.body.includes('Nightly'),'a read item never contributes');assert.ok(!payload.body.includes('Standup moved\n'),'collapse keeps the latest member');
 await f.dispatch();at.advance(HOUR);await f.dispatch();assert.equal(f.sent.length,1,'a digest is sent once');
 assert.equal(kept.revision,1);
});

test('collapse keys coalesce pending notices, share a push Topic and are cooled down after a delivery', async t=>{
 const f=await ready();const at=f.clock;t.after(()=>f.dispose());const cal=await f.connect();await cal.optIn();
 const a1=await cal.create({collapseKey:'build'}),a2=await cal.create({collapseKey:'build'});
 await f.dispatch();assert.equal(f.sent.length,1);assert.equal(f.sent[0].payload.destination.item,a2.item,'the latest eligible member of the group');
 // Push-side collapse: an unattempted notice for the group is replaced, not duplicated.
 at.advance(ACTIVITY_PUSH_LIMITS.groupCooldown);const other=await cal.create();
 assert.equal((await f.claim({limit:1})).length,1);at.advance(61000);
 // The expired lease of the older notice takes the only slot, so the new group's notice stays unattempted.
 const b1=await cal.create({collapseKey:'deploy'});const first=await f.claim({limit:1});assert.equal(first[0].payload.destination.item,other.item);
 at.advance(1000);const b2=await cal.create({collapseKey:'deploy'});
 const leased=await f.claim({limit:10});const deploy=leased.find(l=>l.payload.destination.item!==other.item);
 assert.equal(deploy.payload.destination.item,b2.item,'the queued notice now names the newer member');
 assert.equal(leased.filter(l=>l.job===deploy.job).length,1);
 for(const l of [...first,...leased]){assert.equal(await f.authorize({job:l.job,device:l.device,lease:l.lease}),true);await f.finish({job:l.job,device:l.device,lease:l.lease,delivered:true});}
 // A later member inside the group's cooldown does not ring again; it is released as a digest afterwards.
 at.advance(1000);await cal.create({collapseKey:'deploy'});await f.dispatch();assert.equal(f.sent.length,1);
 at.advance(ACTIVITY_PUSH_LIMITS.groupCooldown);await f.dispatch();assert.equal(f.sent.length,2);assert.equal(f.sent[1].payload.destination.item,undefined);
 // Next hour (fresh app budget): the same collapse group uses the same push Topic, so the service replaces it.
 at.set(Date.UTC(2026,9,14,13,1));const a3=await cal.create({collapseKey:'build'});await f.dispatch();assert.equal(f.sent.length,3);
 assert.equal(f.sent[2].options.topic,f.sent[0].options.topic,'one Topic per collapse group and device');
 assert.notEqual(f.sent[2].options.topic,deploy.options.topic);
 assert.equal(a1.revision+b1.revision+a3.revision,3);
});

test('multi-account: one shared device subscription routes each account to its own destination, privately', async t=>{
 const endpoint=()=>'https://fcm.googleapis.com/fcm/send/shared-device';
 const a=await setup({owner:OWNER,endpoint}),b=await setup({owner:OTHER,endpoint});t.after(async()=>{await a.dispose();await b.dispose();});
 await a.configure({preview:true});await a.enroll(true);await b.configure({preview:true});await b.enroll(false);
 const ca=await a.connect(),cb=await b.connect();await ca.optIn();await cb.optIn();
 assert.equal(a.subs[0],b.subs[0],'the same browser subscription is enrolled in both accounts');
 const ia=await ca.create({subject:'Invoice due'}),ib=await cb.create({subject:'Secret diagnosis'});
 await a.dispatch({accountLabel:'ray'});await b.dispatch({accountLabel:'ray-work'});
 const [pa]=a.sent.map(s=>s.payload),[pb]=b.sent.map(s=>s.payload);
 assert.equal(pa.destination.item,ia.item);assert.equal(pb.destination.item,ib.item);
 assert.notEqual(pa.destination.account,pb.destination.account,'distinct, unlinkable per-account destination hints');
 assert.equal(pa.destination.account,await activityDestinationHint(OWNER,a.subs[0]));assert.equal(pb.destination.account,await activityDestinationHint(OTHER,b.subs[0]));
 assert.equal(pa.title,'cal app (https://cal.example)');assert.equal(pa.accountLabel,'ray');assert.match(pa.body,/^For ray\nInvoice due$/);
 // The device withheld preview consent in account B: the stricter setting wins, so no app, subject or label.
 assert.equal(pb.title,'New activity');assert.ok(!JSON.stringify(pb).includes('Secret')&&!JSON.stringify(pb).includes('ray-work')&&!JSON.stringify(pb).includes('cal'));
 assert.ok(!JSON.stringify(pa).includes(OWNER)&&!JSON.stringify(pb).includes(OTHER),'no owner ID in payloads');
 // Account state never crosses: B's mute does not silence A.
 await b.configure({preview:true,mutes:[{app:cb.id}]});await ca.create();await a.dispatch();assert.equal(a.sent.length,2);
});

test('the race between read and dispatch: state is checked again immediately before transport', async t=>{
 const f=await setup({devices:2});const at=f.clock;t.after(()=>f.dispose());await f.configure({preview:true});await f.enroll(true);const cal=await f.connect();await cal.optIn();
 const read=await cal.create();let leased=await f.claim();assert.equal(leased.length,2,'one leased delivery per enrolled device');
 await f.mark(read.item,1);
 for(const l of leased)assert.equal(await f.authorize({job:l.job,device:l.device,lease:l.lease}),false,'read after claim cancels the send');
 await rejects(f.finish({job:leased[0].job,device:leased[0].device,lease:leased[0].lease,delivered:true}),'stale_lease');
 at.advance(HOUR);assert.deepEqual(await f.claim(),[],'no retry and no unread reminder');
 // Archive before claim, replacement after claim, and preview withdrawal after claim.
 const archived=await cal.create();await f.archive(archived.item);assert.deepEqual(await f.claim(),[]);
 at.advance(ACTIVITY_PUSH_LIMITS.groupCooldown);const replaced=await cal.create();leased=await f.claim();await cal.replace(replaced.item,1);
 assert.equal(await f.authorize({job:leased[0].job,device:leased[0].device,lease:leased[0].lease}),false,'a frozen payload never goes out for a superseded revision');
 const previewed=await cal.create({subject:'Private'});leased=await f.claim();assert.equal(leased[0].payload.body,'Private');
 await f.op('device',{id:leased[0].device,input:{enrolled:true,preview:false}});
 assert.equal(await f.authorize({job:leased[0].job,device:leased[0].device,lease:leased[0].lease}),false,'preview withdrawal fences the claimed rich payload');
 assert.equal(await f.authorize({job:leased[1].job,device:leased[1].device,lease:leased[1].lease}),true,'the other device kept its consent');
 // An expired lease is not authorized either.
 at.advance(2*MINUTE);assert.equal(await f.authorize({job:leased[1].job,device:leased[1].device,lease:leased[1].lease}),false);
 assert.equal(previewed.revision,1);
});

test('transport retries keep the notice identity; gone subscriptions are removed; flag-off RPC is absent', async t=>{
 const f=await ready();const at=f.clock;t.after(()=>f.dispose());const cal=await f.connect();await cal.optIn();await cal.create();
 f.failNext(Object.assign(new Error('x'),{code:'push_delivery_unavailable'}));const [first]=await f.dispatch();assert.equal(first.state,'pending');assert.equal(f.sent.length,0);
 await f.dispatch();assert.equal(f.sent.length,0,'backoff');
 at.advance(2*MINUTE);await f.dispatch();assert.equal(f.sent.length,1);
 at.advance(ACTIVITY_PUSH_LIMITS.groupCooldown);await cal.create();f.failNext(Object.assign(new Error('x'),{code:'push_subscription_gone'}));await f.dispatch();
 assert.equal(await f.metadata.get(key('push-subscription',OWNER,f.subs[0])),undefined);assert.equal(await f.metadata.get(key('activity-push-device',OWNER,f.subs[0])),undefined);
 // Owner settings validation.
 for(const input of [{...policy(),extra:true},{...policy(),rules:[{id:'x',app:cal.id,route:'digest',quietBypass:true}]},{...policy(),rules:[{id:'x',app:'nope',route:'immediate'}]},{...policy(),digest:{cadence:'weekly',hour:8}}])await rejects(f.op('configure',{input}),'invalid_preferences');
 await rejects(cal.optIn({mode:'selected',tags:[]}),'invalid_args');await rejects(f.op('app',{id:'00000099-0000-8000-a000-000000000000',input:{mode:'all'}}),'not_found');
 // The account RPC is the only entry point, and answers not_found with ACTIVITY_V2_ENABLED off.
 const {methods}=await import('../packages/runtime/account/notifications.mjs');
 await rejects(methods.activityPush.call({config:{},engine:f.engine},OWNER,'settings'),'not_found');
 await rejects(methods.activityPush.call({config:{ACTIVITY_V2_ENABLED:'true'},engine:f.engine},OWNER,'claim'),'not_found');
 assert.equal((await methods.activityPush.call({config:{ACTIVITY_V2_ENABLED:'true'},engine:f.engine},OWNER,'settings')).policy.enabled,true);
});

// Regressions for the ACT-2 independent review (docs/release/activity-design-review.md "ACT-2 implementation").
test('review R1/R4: one app cannot delay or evict another app\'s held activity; one merged summary per pass', async t=>{
 const f=await ready({start:Date.UTC(2026,9,14,23)});t.after(()=>f.dispose());const at=f.clock;const spam=await f.connect({app:'spam'}),bank=await f.connect({app:'bank'});
 await spam.optIn();await bank.optIn();await f.enroll(true);await f.configure({preview:true,quiet:{enabled:true,startHour:22,endHour:7,timeZone:null,utcOffsetMinutes:0},digest:{cadence:'hourly',hour:0},rules:[{id:'d',app:spam.id,route:'digest'}]});
 const alert=await bank.create({subject:'Fraud alert'});
 for(let i=0;i<40;i++){await spam.create();if(i%10===9){at.advance(61000);await f.dispatch();}}
 for(let h=0;h<8;h++){at.advance(HOUR);await f.dispatch();}
 assert.equal(f.sent.length,1,'quiet-hour and hourly digest buckets merge into one summary at quiet end');
 assert.match(f.sent[0].payload.body,/bank app: Fraud alert/,'round-robin selection keeps the quiet app visible in the summary');
 const buckets=[...(await f.metadata.list({prefix:key('activity-push-bucket',OWNER)})).values()];
 assert.ok(!buckets.some(b=>b.members.some(m=>m.item===alert.item)),'the other app\'s member was released, not held behind the spam');
 assert.ok(buckets.every(b=>b.members.length<=ACTIVITY_PUSH_LIMITS.bucketMembers));
});

test('review R2/R5/R6/R7/R10: no re-notify on replacement, channel boundary, quiet after claim, DST gap, lease extension', async t=>{
 const f=await ready();t.after(()=>f.dispose());const at=f.clock;const cal=await f.connect();await cal.optIn();
 const first=await cal.create({collapseKey:'a'});await f.dispatch();assert.equal(f.sent.length,1);
 at.advance(ACTIVITY_PUSH_LIMITS.groupCooldown);await cal.replace(first.item,1,{collapseKey:'b'});await f.dispatch();assert.equal(f.sent.length,1,'a replacement never re-notifies by default');
 // R5: the account push channel turned off then on again does not release activity admitted meanwhile.
 const {NotificationService}=await import('../packages/messaging/notifications.mjs'),{metadataStore}=await import('./helpers/app-engine.mjs');
 const legacy=new NotificationService({store:metadataStore(f.metadata),clock:()=>at.now()}),prefs=defaultNotificationPreferences();
 await legacy.setPreferences(OWNER,prefs);at.advance(1);const meanwhile=await cal.create();prefs.push.enabled=true;await legacy.setPreferences(OWNER,structuredClone(prefs));at.advance(1);
 await f.dispatch();assert.equal(f.sent.length,1);assert.equal((await f.explain(meanwhile.item)).reason,'before_opt_in');
 // R10: an authorized delivery keeps its lease through the transport timeout.
 at.advance(HOUR);const next=await cal.create();const [leased]=await f.claim();assert.equal(leased.payload.destination.item,next.item);
 at.advance(59000);assert.equal(await f.authorize({job:leased.job,device:leased.device,lease:leased.lease}),true);at.advance(5000);assert.deepEqual(await f.claim(),[],'not claimed again while in flight');
 await f.finish({job:leased.job,device:leased.device,lease:leased.lease,delivered:true});
 // R6: quiet hours beginning between claim and authorize hold the notice for the post-quiet summary.
 await f.configure({quiet:{enabled:true,startHour:22,endHour:7,timeZone:null,utcOffsetMinutes:0}});
 at.set(Date.UTC(2026,9,14,21,59,30));const late=await cal.create();const [l2]=await f.claim();assert.equal(l2.payload.destination.item,late.item);
 at.set(Date.UTC(2026,9,14,22,0,10));assert.equal(await f.authorize({job:l2.job,device:l2.device,lease:l2.lease}),false);
 at.set(Date.UTC(2026,9,15,7));await f.dispatch();assert.equal(f.sent.length,2,'held, then summarized after quiet');assert.equal(f.sent[1].payload.destination.item,undefined);
 // R7: offsets in 15-minute steps; a DST gap does not skip the day's digest.
 await rejects(f.configure({quiet:{enabled:false,startHour:22,endHour:7,timeZone:null,utcOffsetMinutes:7}}),'invalid_preferences');
 assert.equal(nextDigestAt({cadence:'daily',hour:2},{timeZone:'America/New_York',utcOffsetMinutes:0},Date.UTC(2027,2,14,5)),Date.UTC(2027,2,14,7));
 assert.equal(activityQuiet({enabled:true,startHour:22,endHour:7,timeZone:'Not/AZone',utcOffsetMinutes:0},Date.UTC(2026,9,14,23)),true,'an unknown stored zone falls back to the fixed offset');
});
